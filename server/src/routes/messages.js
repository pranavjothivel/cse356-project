const { Router } = require('express');
const { Op } = require('sequelize');
const { Channel, ChannelMember, User } = require('../models');
const Conversation = require('../models/Conversation');
const ConversationParticipant = require('../models/ConversationParticipant');
const Message = require('../models/Message');
const { broadcastToUsers } = require('../ws');
const { buildMessageCursor } = require('../util/messageCursor');
const { minioClient, BUCKET } = require('../upload');
const redisClient = require('../redis');

const router = Router();

function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

router.use(requireAuth);

function serializeChannelMessage(m) {
  return {
    id: m.id,
    channelId: m.channel_id,
    authorId: m.author_id,
    author: m.author ? {
      id: m.author.id,
      username: m.author.username,
      display_name: m.author.display_name,
    } : null,
    content: m.content,
    createdAt: m.created_at || m.createdAt,
    editedAt: m.edited_at,
    attachments: m.attachments
  };
}

function serializeConversationMessage(m) {
  return {
    id: m.id,
    conversationId: m.conversation_id,
    authorId: m.author_id,
    content: m.content,
    createdAt: m.createdAt,
    editedAt: m.edited_at,
    attachments: m.attachments
  };
}

const MEMBER_CACHE_TTL = 60; // seconds

async function getChannelMemberIds(channelId) {
  const cacheKey = `channel:${channelId}:members`;
  const cached = await redisClient.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const members = await ChannelMember.findAll({
    where: { channel_id: channelId },
    attributes: ['user_id'],
  });
  const ids = members.map(m => m.user_id);
  await redisClient.set(cacheKey, JSON.stringify(ids), { EX: MEMBER_CACHE_TTL });
  return ids;
}

async function invalidateChannelMemberCache(channelId) {
  await redisClient.del(`channel:${channelId}:members`);
}

async function getConversationParticipantIds(conversationId) {
  const cacheKey = `conv:${conversationId}:members`;
  const cached = await redisClient.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const parts = await ConversationParticipant.findAll({
    where: { conversation_id: conversationId },
    attributes: ['user_id'],
  });
  const ids = parts.map(p => p.user_id);
  await redisClient.set(cacheKey, JSON.stringify(ids), { EX: MEMBER_CACHE_TTL });
  return ids;
}

async function invalidateConversationMemberCache(conversationId) {
  await redisClient.del(`conv:${conversationId}:members`);
}

// GET /api/messages?channelId=X[&before=Y&around=Y&limit=N]
// GET /api/messages?conversationId=X[&before=Y&around=Y&limit=N]
router.get('/', async (req, res, next) => {
  try {
    const { channelId, conversationId } = req.query;
    if ((channelId && conversationId) || (!channelId && !conversationId)) {
      return res.status(400).json({ error: 'Provide exactly one of channelId or conversationId' });
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);

    // Helper: load messages around a target message (for jump-to-message)
    const loadAround = async (scopeWhere, includeOpts) => {
      const half = Math.floor(limit / 2);
      const cursor = await Message.findByPk(req.query.around, { attributes: ['id', 'created_at'] });
      if (!cursor) {
        // Target not found — fall back to latest messages
        const messages = await Message.findAll({
          where: scopeWhere,
          include: includeOpts,
          order: [['created_at', 'DESC'], ['id', 'DESC']],
          limit,
        });
        return messages;
      }
      // Messages before the target (older), newest-first
      const beforeWhere = { ...scopeWhere, ...await buildMessageCursor(req.query.around, 'before') };
      const beforeMsgs = await Message.findAll({
        where: beforeWhere,
        include: includeOpts,
        order: [['created_at', 'DESC'], ['id', 'DESC']],
        limit: half,
      });
      // Messages after the target (newer) + target itself, oldest-first then reverse
      const afterCursor = await buildMessageCursor(req.query.around, 'after');
      const afterWhere = afterCursor ? { ...scopeWhere, ...afterCursor } : scopeWhere;
      const afterMsgs = await Message.findAll({
        where: afterWhere,
        include: includeOpts,
        order: [['created_at', 'ASC'], ['id', 'ASC']],
        limit: half,
      });
      // Fetch the target message itself
      const targetMsg = await Message.findOne({
        where: { ...scopeWhere, id: req.query.around },
        include: includeOpts,
      });
      // Combine: all in newest-first order
      const combined = [...afterMsgs.reverse(), ...(targetMsg ? [targetMsg] : []), ...beforeMsgs];
      return combined;
    };

    if (channelId) {
      // Verify membership
      const member = await ChannelMember.findOne({
        where: { channel_id: channelId, user_id: req.user.id },
      });
      if (!member) return res.status(403).json({ error: 'Not a channel member' });

      const includeOpts = [{ model: User, as: 'author', attributes: ['id', 'username', 'display_name'] }];

      if (req.query.around) {
        const messages = await loadAround({ channel_id: channelId }, includeOpts);
        return res.json({ messages: messages.map(serializeChannelMessage) });
      }

      const where = { channel_id: channelId };
      if (req.query.before) {
        const cursorWhere = await buildMessageCursor(req.query.before, 'before');
        if (cursorWhere) Object.assign(where, cursorWhere);
      }
      const messages = await Message.findAll({
        where,
        include: includeOpts,
        order: [['created_at', 'DESC'], ['id', 'DESC']],
        limit,
      });
      return res.json({ messages: messages.map(serializeChannelMessage) });
    } else {
      // conversation
      const participant = await ConversationParticipant.findOne({
        where: { conversation_id: conversationId, user_id: req.user.id },
      });
      if (!participant) return res.status(403).json({ error: 'Not a conversation participant' });

      if (req.query.around) {
        const messages = await loadAround({ conversation_id: conversationId }, []);
        return res.json({ messages: messages.map(serializeConversationMessage) });
      }

      const where = { conversation_id: conversationId };
      if (req.query.before) {
        const cursorWhere = await buildMessageCursor(req.query.before, 'before');
        if (cursorWhere) Object.assign(where, cursorWhere);
      }
      const messages = await Message.findAll({
        where,
        order: [['created_at', 'DESC'], ['id', 'DESC']],
        limit,
      });
      return res.json({ messages: messages.map(serializeConversationMessage) });
    }
  } catch (err) { next(err); }
});

// POST /api/messages { channelId|conversationId, content, attachments? }
router.post('/', async (req, res, next) => {
  try {
    const { channelId, conversationId, content, attachments } = req.body;
    if ((channelId && conversationId) || (!channelId && !conversationId)) {
      return res.status(400).json({ error: 'Provide exactly one of channelId or conversationId' });
    }
    if ((!content || (typeof content === 'string' && content.trim().length === 0)) && (!attachments || attachments.length === 0)) {
      return res.status(400).json({ error: 'content or attachments required' });
    }
    if (attachments && attachments.length > 4) {
      return res.status(400).json({ error: 'Too many attachments. Limit is 4' });
    }

    if (channelId) {
      const member = await ChannelMember.findOne({
        where: { channel_id: channelId, user_id: req.user.id },
      });
      if (!member) return res.status(403).json({ error: 'Not a channel member' });

      const msg = await Message.create({
        channel_id: channelId,
        author_id: req.user.id,
        content,
        ...(attachments ? { attachments } : {}),
      });
      // Attach author from session instead of re-fetching from DB
      msg.author = { id: req.user.id, username: req.user.username, display_name: req.user.display_name };
      const serialized = serializeChannelMessage(msg);

      // Respond immediately, then broadcast asynchronously
      res.status(201).json(serialized);

      // Fire-and-forget: broadcast to other users via WebSocket
      getChannelMemberIds(channelId).then(memberIds => {
        broadcastToUsers(memberIds, {
          type: 'channel.message.created',
          channelId,
          message: serialized,
        });
        const otherMemberIds = memberIds.filter(id => id !== req.user.id);
        if (otherMemberIds.length > 0) {
          broadcastToUsers(otherMemberIds, { type: 'channel.unread', channelId });
        }
      }).catch(err => console.error('Broadcast error (channel):', err));
      return;
    } else {
      const participant = await ConversationParticipant.findOne({
        where: { conversation_id: conversationId, user_id: req.user.id },
      });
      if (!participant) return res.status(403).json({ error: 'Not a conversation participant' });

      const msg = await Message.create({
        conversation_id: conversationId,
        author_id: req.user.id,
        content,
        ...(attachments ? { attachments } : {}),
      });
      const serialized = serializeConversationMessage(msg);

      // Respond immediately, then broadcast asynchronously
      res.status(201).json(serialized);

      // Fire-and-forget: un-hide + broadcast
      (async () => {
        await ConversationParticipant.update(
          { hidden_at: null },
          { where: { conversation_id: conversationId, hidden_at: { [Op.ne]: null } } }
        );
        const participantIds = await getConversationParticipantIds(conversationId);
        broadcastToUsers(participantIds, {
          type: 'message.created',
          conversationId,
          message: serialized,
        });
      })().catch(err => console.error('Broadcast error (conversation):', err));
      return;
    }
  } catch (err) { next(err); }
});

// PATCH /api/messages/:messageId { content }
router.patch('/:messageId', async (req, res, next) => {
  try {
    const { content, attachments } = req.body;
    if ((!content || (typeof content === 'string' && content.trim().length === 0)) && (!attachments || attachments.length === 0)) {
      return res.status(400).json({ error: 'content or attachments required' });
    }
    if (attachments && attachments.length > 4) {
      return res.status(400).json({ error: 'Too many attachments. Limit is 4' });
    }
    
    const msg = await Message.findByPk(req.params.messageId);
    if (!msg) return res.status(404).json({ error: 'Not found' });
    if (msg.author_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    // Auth: verify caller still belongs to the owning channel/conversation
    if (msg.channel_id) {
      const member = await ChannelMember.findOne({
        where: { channel_id: msg.channel_id, user_id: req.user.id },
      });
      if (!member) return res.status(403).json({ error: 'Not a channel member' });
    } else if (msg.conversation_id) {
      const participant = await ConversationParticipant.findOne({
        where: { conversation_id: msg.conversation_id, user_id: req.user.id },
      });
      if (!participant) return res.status(403).json({ error: 'Not a conversation participant' });
    }

    // Delete images not in the new attachments list
    // Since there is no easy "undoing" of MinIO removal, just accept failures
    try {
      if (attachments) {
        for (let i = 0; i < msg.attachments.length; i++) {
          let keepAttachment = false;
          for (let j = 0; j < attachments.length; j++) {
            if (msg.attachments[i] === attachments[j]) {
              keepAttachment = true;
              break;
            }
          }

          if (!keepAttachment) {
            await minioClient.removeObject(BUCKET, msg.attachments[i]);
          }
        }
      }
    }
    catch (err) {}

    msg.content = content;
    if (attachments !== undefined && attachments !== null) msg.attachments = attachments;
    msg.edited_at = new Date();
    await msg.save();

    if (msg.channel_id) {
      const full = await Message.findByPk(msg.id, {
        include: [{ model: User, as: 'author', attributes: ['id', 'username', 'display_name'] }],
      });
      const memberIds = await getChannelMemberIds(msg.channel_id);
      broadcastToUsers(memberIds, {
        type: 'channel.message.edited',
        channelId: msg.channel_id,
        message: serializeChannelMessage(full),
      });
      return res.json(serializeChannelMessage(full));
    } else {
      const participantIds = await getConversationParticipantIds(msg.conversation_id);
      broadcastToUsers(participantIds, {
        type: 'message.edited',
        conversationId: msg.conversation_id,
        message: serializeConversationMessage(msg),
      });
      return res.json(serializeConversationMessage(msg));
    }
  } catch (err) { next(err); }
});

// DELETE /api/messages/:messageId
router.delete('/:messageId', async (req, res, next) => {
  try {
    const msg = await Message.findByPk(req.params.messageId);
    if (!msg) return res.status(404).json({ error: 'Not found' });
    if (msg.author_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    // Capture IDs before destroy so broadcasts can still fire
    const { channel_id: channelId, conversation_id: conversationId, id: messageId } = msg;

    // Delete images
    // Since there is no easy "undoing" of MinIO removal, just accept failures
    try {
      for (let i = 0; i < msg.attachments.length; i++) {
          await minioClient.removeObject(BUCKET, msg.attachments[i]);
      }
    }
    catch (err) {}

    if (channelId) {
      const member = await ChannelMember.findOne({
        where: { channel_id: channelId, user_id: req.user.id },
      });
      if (!member) return res.status(403).json({ error: 'Not a channel member' });
    } else if (conversationId) {
      const participant = await ConversationParticipant.findOne({
        where: { conversation_id: conversationId, user_id: req.user.id },
      });
      if (!participant) return res.status(403).json({ error: 'Not a conversation participant' });
    }

    await msg.destroy();

    if (channelId) {
      const memberIds = await getChannelMemberIds(channelId);
      broadcastToUsers(memberIds, {
        type: 'channel.message.deleted',
        channelId,
        messageId,
      });
    } else {
      const participantIds = await getConversationParticipantIds(conversationId);
      broadcastToUsers(participantIds, {
        type: 'message.deleted',
        conversationId,
        messageId,
      });
    }
    return res.json({ message: 'Deleted' });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.invalidateChannelMemberCache = invalidateChannelMemberCache;
module.exports.invalidateConversationMemberCache = invalidateConversationMemberCache;

const express = require('express');
const router = express.Router();
const { Op } = require('sequelize');

const sequelize = require('../db');
const Conversation = require('../models/Conversation');
const ConversationParticipant = require('../models/ConversationParticipant');
const Message = require('../models/Message');
const User = require('../models/User');
const { broadcastToUsers } = require('../ws');
const { buildMessageCursor } = require('../util/messageCursor');
const { isForwardRead } = require('../util/readReceipts');

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

// Membership check. Returns 404 (not 403) for non-members so existence isn't leaked.
async function requireMember(req, res, next) {
  try {
    const conv = await Conversation.findByPk(req.params.id);
    if (!conv) return res.status(404).json({ error: 'Not found' });
    const part = await ConversationParticipant.findOne({
      where: { conversation_id: conv.id, user_id: req.user.id },
    });
    if (!part) return res.status(404).json({ error: 'Not found' });
    req.conversation = conv;
    req.participant = part;
    next();
  } catch (err) { next(err); }
}

async function listParticipants(conversationId) {
  const rows = await ConversationParticipant.findAll({
    where: { conversation_id: conversationId },
    attributes: ['user_id', 'joined_at'],
  });
  if (rows.length === 0) return [];
  const userIds = rows.map(r => r.user_id);
  const users = await User.findAll({
    where: { id: userIds },
    attributes: ['id', 'username', 'display_name'],
  });
  const userMap = new Map(users.map(u => [u.id, u]));
  return rows.map(r => {
    const u = userMap.get(r.user_id);
    return {
      userId: r.user_id,
      joinedAt: r.joined_at,
      username: u?.username || null,
      displayName: u?.display_name || null,
    };
  });
}

function serializeMessage(m) {
  return {
    id: m.id,
    conversationId: m.conversation_id,
    authorId: m.author_id,
    content: m.deleted_at ? null : m.content,
    createdAt: m.createdAt,
    editedAt: m.edited_at,
    deletedAt: m.deleted_at,
  };
}

function serializeConversation(c, participants, hiddenAt) {
  return {
    id: c.id,
    kind: c.kind,
    createdAt: c.createdAt,
    participantIds: participants.map(p => p.userId),
    participants: participants.map(p => ({
      id: p.userId,
      username: p.username,
      displayName: p.displayName,
    })),
    hidden: !!hiddenAt,
  };
}

// ──────────────────────────────────────────────
// Create / list / get
// ──────────────────────────────────────────────

// POST /api/conversations  { kind: 'dm' | 'group', participantIds: [...] }
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { kind, participantIds, usernames } = req.body;
    if (kind !== 'dm' && kind !== 'group') {
      return res.status(400).json({ error: "kind must be 'dm' or 'group'" });
    }

    // Accept ids, usernames, or a mix. Resolve usernames to ids first.
    const idsFromBody = Array.isArray(participantIds) ? participantIds : [];
    const namesFromBody = Array.isArray(usernames) ? usernames.filter(n => typeof n === 'string' && n.length > 0) : [];
    if (idsFromBody.length === 0 && namesFromBody.length === 0) {
      return res.status(400).json({ error: 'participantIds or usernames is required' });
    }

    let resolvedFromNames = [];
    if (namesFromBody.length > 0) {
      const usersByName = await User.findAll({
        where: { username: namesFromBody },
        attributes: ['id', 'username'],
      });
      if (usersByName.length !== namesFromBody.length) {
        const found = new Set(usersByName.map(u => u.username));
        const missing = namesFromBody.filter(n => !found.has(n));
        return res.status(400).json({ error: `Unknown username(s): ${missing.join(', ')}` });
      }
      resolvedFromNames = usersByName.map(u => u.id);
    }

    // Strip self and dedupe
    const others = [...new Set([...idsFromBody, ...resolvedFromNames].filter(id => id && id !== req.user.id))];
    if (others.length === 0) {
      return res.status(400).json({ error: 'Cannot create a conversation with only yourself' });
    }

    // Verify all id-based participants exist (username-based ones already verified above)
    const found = await User.findAll({ where: { id: others }, attributes: ['id'] });
    if (found.length !== others.length) {
      return res.status(400).json({ error: 'One or more participants do not exist' });
    }

    if (kind === 'dm') {
      if (others.length !== 1) {
        return res.status(400).json({ error: 'A direct message must have exactly one other participant' });
      }
      const key = Conversation.dmKey(req.user.id, others[0]);
      // 1:1 DMs are reused — they're permanent and pair-unique
      const existing = await Conversation.findOne({ where: { kind: 'dm', dm_key: key } });
      if (existing) {
        // Un-hide for the caller if they had previously hidden it
        await ConversationParticipant.update(
          { hidden_at: null },
          { where: { conversation_id: existing.id, user_id: req.user.id } }
        );
        const parts = await listParticipants(existing.id);
        return res.json(serializeConversation(existing, parts, null));
      }
      const conv = await sequelize.transaction(async (t) => {
        const c = await Conversation.create({ kind: 'dm', dm_key: key }, { transaction: t });
        await ConversationParticipant.bulkCreate([
          { conversation_id: c.id, user_id: req.user.id },
          { conversation_id: c.id, user_id: others[0] },
        ], { transaction: t });
        return c;
      });
      const parts = await listParticipants(conv.id);
      broadcastToUsers(parts.map(p => p.userId), {
        type: 'conversation.created',
        conversation: serializeConversation(conv, parts, null),
      });
      return res.status(201).json(serializeConversation(conv, parts, null));
    }

    // Group: always create new (re-creating with same set yields a fresh conversation)
    const allIds = [req.user.id, ...others];
    const conv = await sequelize.transaction(async (t) => {
      const c = await Conversation.create({ kind: 'group', dm_key: null }, { transaction: t });
      await ConversationParticipant.bulkCreate(
        allIds.map(uid => ({ conversation_id: c.id, user_id: uid })),
        { transaction: t }
      );
      return c;
    });
    const parts = await listParticipants(conv.id);
    broadcastToUsers(parts.map(p => p.userId), {
      type: 'conversation.created',
      conversation: serializeConversation(conv, parts, null),
    });
    return res.status(201).json(serializeConversation(conv, parts, null));
  } catch (err) { next(err); }
});

// GET /api/conversations
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const myParts = await ConversationParticipant.findAll({
      where: { user_id: req.user.id },
    });
    const ids = myParts.map(p => p.conversation_id);
    if (ids.length === 0) return res.json({ conversations: [] });

    const convs = await Conversation.findAll({ where: { id: ids } });
    const allParts = await ConversationParticipant.findAll({
      where: { conversation_id: ids },
      attributes: ['conversation_id', 'user_id', 'joined_at'],
    });
    // Bulk-fetch the user rows in one query so we don't N+1 per conversation
    const allUserIds = [...new Set(allParts.map(p => p.user_id))];
    const userRows = await User.findAll({
      where: { id: allUserIds },
      attributes: ['id', 'username', 'display_name'],
    });
    const userMap = new Map(userRows.map(u => [u.id, u]));
    const partsByConv = new Map();
    for (const p of allParts) {
      if (!partsByConv.has(p.conversation_id)) partsByConv.set(p.conversation_id, []);
      const u = userMap.get(p.user_id);
      partsByConv.get(p.conversation_id).push({
        userId: p.user_id,
        joinedAt: p.joined_at,
        username: u?.username || null,
        displayName: u?.display_name || null,
      });
    }
    const hiddenByConv = new Map(myParts.map(p => [p.conversation_id, p.hidden_at]));
    const result = convs.map(c =>
      serializeConversation(c, partsByConv.get(c.id) || [], hiddenByConv.get(c.id))
    );
    res.json({ conversations: result });
  } catch (err) { next(err); }
});

// GET /api/conversations/:id
router.get('/:id', requireAuth, requireMember, async (req, res, next) => {
  try {
    const parts = await listParticipants(req.conversation.id);
    res.json(serializeConversation(req.conversation, parts, req.participant.hidden_at));
  } catch (err) { next(err); }
});

// ──────────────────────────────────────────────
// Messages
// ──────────────────────────────────────────────

// GET /api/conversations/:id/messages?before=<msgId>&limit=50
// Cursor-based infinite scroll. Newest-first.
router.get('/:id/messages', requireAuth, requireMember, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const where = { conversation_id: req.conversation.id };
    if (req.query.before) {
      const cursorWhere = await buildMessageCursor(req.query.before, 'before');
      if (cursorWhere) Object.assign(where, cursorWhere);
    }
    const messages = await Message.findAll({
      where,
      order: [['created_at', 'DESC'], ['id', 'DESC']],
      limit,
    });
    res.json({ messages: messages.map(serializeMessage) });
  } catch (err) { next(err); }
});

// POST /api/conversations/:id/messages  { content }
router.post('/:id/messages', requireAuth, requireMember, async (req, res, next) => {
  try {
    const { content } = req.body;
    if (typeof content !== 'string' || content.length === 0) {
      return res.status(400).json({ error: 'content is required' });
    }
    const msg = await Message.create({
      conversation_id: req.conversation.id,
      author_id: req.user.id,
      content,
    });

    // A new message un-hides the conversation for any participant who had hidden it
    await ConversationParticipant.update(
      { hidden_at: null },
      { where: { conversation_id: req.conversation.id, hidden_at: { [Op.ne]: null } } }
    );

    const parts = await listParticipants(req.conversation.id);
    broadcastToUsers(parts.map(p => p.userId), {
      type: 'message.created',
      conversationId: req.conversation.id,
      message: serializeMessage(msg),
    });
    res.status(201).json(serializeMessage(msg));
  } catch (err) { next(err); }
});

// PATCH /api/conversations/:id/messages/:msgId  { content }
router.patch('/:id/messages/:msgId', requireAuth, requireMember, async (req, res, next) => {
  try {
    const { content } = req.body;
    if (typeof content !== 'string' || content.length === 0) {
      return res.status(400).json({ error: 'content is required' });
    }
    const msg = await Message.findOne({
      where: { id: req.params.msgId, conversation_id: req.conversation.id },
    });
    if (!msg) return res.status(404).json({ error: 'Not found' });
    if (msg.author_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    if (msg.deleted_at) return res.status(400).json({ error: 'Cannot edit a deleted message' });

    msg.content = content;
    msg.edited_at = new Date();
    await msg.save();

    const parts = await listParticipants(req.conversation.id);
    broadcastToUsers(parts.map(p => p.userId), {
      type: 'message.edited',
      conversationId: req.conversation.id,
      message: serializeMessage(msg),
    });
    res.json(serializeMessage(msg));
  } catch (err) { next(err); }
});

// DELETE /api/conversations/:id/messages/:msgId
router.delete('/:id/messages/:msgId', requireAuth, requireMember, async (req, res, next) => {
  try {
    const msg = await Message.findOne({
      where: { id: req.params.msgId, conversation_id: req.conversation.id },
    });
    if (!msg) return res.status(404).json({ error: 'Not found' });
    if (msg.author_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    if (msg.deleted_at) return res.json({ message: 'Already deleted' });

    msg.deleted_at = new Date();
    await msg.save();

    const parts = await listParticipants(req.conversation.id);
    broadcastToUsers(parts.map(p => p.userId), {
      type: 'message.deleted',
      conversationId: req.conversation.id,
      messageId: msg.id,
    });
    res.json({ message: 'Deleted' });
  } catch (err) { next(err); }
});

// ──────────────────────────────────────────────
// Participants (group only)
// ──────────────────────────────────────────────

// POST /api/conversations/:id/participants  { userId }
router.post('/:id/participants', requireAuth, requireMember, async (req, res, next) => {
  try {
    if (req.conversation.kind !== 'group') {
      return res.status(400).json({ error: 'Cannot invite into a direct message' });
    }
    const { userId, username } = req.body;
    if (!userId && !username) return res.status(400).json({ error: 'userId or username is required' });

    const target = userId
      ? await User.findByPk(userId)
      : await User.findOne({ where: { username } });
    if (!target) return res.status(404).json({ error: 'User not found' });

    const existing = await ConversationParticipant.findOne({
      where: { conversation_id: req.conversation.id, user_id: target.id },
    });
    if (existing) return res.json({ message: 'Already a participant' });

    await ConversationParticipant.create({
      conversation_id: req.conversation.id,
      user_id: target.id,
    });

    const parts = await listParticipants(req.conversation.id);
    broadcastToUsers(parts.map(p => p.userId), {
      type: 'conversation.participants_changed',
      conversationId: req.conversation.id,
      participantIds: parts.map(p => p.userId),
    });
    res.status(201).json({ message: 'Participant added' });
  } catch (err) { next(err); }
});

// DELETE /api/conversations/:id/participants/me
// Leaving a group; if it was the last participant the conversation is destroyed.
router.delete('/:id/participants/me', requireAuth, requireMember, async (req, res, next) => {
  try {
    if (req.conversation.kind === 'dm') {
      return res.status(400).json({ error: 'Cannot leave a direct message' });
    }
    let destroyed = false;
    await sequelize.transaction(async (t) => {
      await ConversationParticipant.destroy({
        where: { conversation_id: req.conversation.id, user_id: req.user.id },
        transaction: t,
      });
      const remaining = await ConversationParticipant.count({
        where: { conversation_id: req.conversation.id },
        transaction: t,
      });
      if (remaining === 0) {
        // Last one out: erase history per spec
        await Message.destroy({
          where: { conversation_id: req.conversation.id },
          transaction: t,
        });
        await Conversation.destroy({
          where: { id: req.conversation.id },
          transaction: t,
        });
        destroyed = true;
      }
    });

    if (!destroyed) {
      const remainingParts = await listParticipants(req.conversation.id);
      broadcastToUsers(remainingParts.map(p => p.userId), {
        type: 'conversation.participants_changed',
        conversationId: req.conversation.id,
        participantIds: remainingParts.map(p => p.userId),
      });
    }
    // Tell other sessions of the leaver to drop the conversation from their sidebar
    broadcastToUsers([req.user.id], {
      type: 'conversation.left',
      conversationId: req.conversation.id,
    });
    res.json({ message: 'Left' });
  } catch (err) { next(err); }
});

// ──────────────────────────────────────────────
// Read receipts
// ──────────────────────────────────────────────

// POST /api/conversations/:id/read  { messageId }
router.post('/:id/read', requireAuth, requireMember, async (req, res, next) => {
  try {
    const { messageId } = req.body;
    if (!messageId) return res.status(400).json({ error: 'messageId is required' });

    const msg = await Message.findOne({
      where: { id: messageId, conversation_id: req.conversation.id },
    });
    if (!msg) return res.status(404).json({ error: 'Message not found in this conversation' });

    // Only advance forward — don't allow marking an older message as last-read
    if (!await isForwardRead(req.participant.last_read_message_id, msg)) {
      return res.json({ lastReadMessageId: req.participant.last_read_message_id });
    }

    req.participant.last_read_message_id = messageId;
    await req.participant.save();

    const parts = await listParticipants(req.conversation.id);
    broadcastToUsers(parts.map(p => p.userId), {
      type: 'conversation.read',
      conversationId: req.conversation.id,
      userId: req.user.id,
      lastReadMessageId: messageId,
    });

    res.json({ lastReadMessageId: messageId });
  } catch (err) { next(err); }
});

// GET /api/conversations/:id/read-state
router.get('/:id/read-state', requireAuth, requireMember, async (req, res, next) => {
  try {
    const rows = await ConversationParticipant.findAll({
      where: { conversation_id: req.conversation.id },
      attributes: ['user_id', 'last_read_message_id'],
    });
    res.json({
      readState: rows.map(r => ({
        userId: r.user_id,
        lastReadMessageId: r.last_read_message_id,
      })),
    });
  } catch (err) { next(err); }
});

// POST /api/conversations/:id/hide
router.post('/:id/hide', requireAuth, requireMember, async (req, res, next) => {
  try {
    if (req.conversation.kind !== 'dm') {
      return res.status(400).json({ error: 'Only direct messages can be hidden' });
    }
    req.participant.hidden_at = new Date();
    await req.participant.save();
    res.json({ message: 'Hidden' });
  } catch (err) { next(err); }
});

// POST /api/conversations/:id/unhide
router.post('/:id/unhide', requireAuth, requireMember, async (req, res, next) => {
  try {
    req.participant.hidden_at = null;
    await req.participant.save();
    res.json({ message: 'Unhidden' });
  } catch (err) { next(err); }
});

module.exports = router;
const { Router } = require('express');
const { Op } = require('sequelize');
const { Channel, ChannelMember, CommunityMember, Community, User } = require('../models');
const Message = require('../models/Message');
const { broadcastToUsers } = require('../ws');

const router = Router();

function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

router.use(requireAuth);

// Helper: load channel and verify community admin
async function loadChannelAndCheckAdmin(req, res) {
  const channel = await Channel.findByPk(req.params.channelId);
  if (!channel) { res.status(404).json({ error: 'Channel not found' }); return null; }

  const membership = await CommunityMember.findOne({
    where: { community_id: channel.community_id, user_id: req.user.id },
  });
  if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
    res.status(403).json({ error: 'Only community admins can perform this action' });
    return null;
  }
  return { channel, membership };
}

// Middleware: require channel membership
async function requireChannelMember(req, res, next) {
  try {
    const channel = await Channel.findByPk(req.params.channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    const member = await ChannelMember.findOne({
      where: { channel_id: channel.id, user_id: req.user.id },
    });
    if (!member) return res.status(403).json({ error: 'Not a channel member' });
    req.channel = channel;
    next();
  } catch (err) { next(err); }
}

async function getChannelMemberIds(channelId) {
  const members = await ChannelMember.findAll({
    where: { channel_id: channelId },
    attributes: ['user_id'],
  });
  return members.map(m => m.user_id);
}

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
    content: m.deleted_at ? null : m.content,
    createdAt: m.created_at || m.createdAt,
    editedAt: m.edited_at,
    deletedAt: m.deleted_at,
  };
}

// PATCH /:channelId — Update channel
router.patch('/:channelId', async (req, res, next) => {
  try {
    const result = await loadChannelAndCheckAdmin(req, res);
    if (!result) return;
    const { channel } = result;

    const { name, is_private } = req.body;
    if (name !== undefined) channel.name = name.trim();

    // Handle private→public transition: add all community members
    if (is_private !== undefined && channel.is_private && !is_private) {
      const members = await CommunityMember.findAll({
        where: { community_id: channel.community_id },
        attributes: ['user_id'],
      });
      await ChannelMember.bulkCreate(
        members.map(m => ({ channel_id: channel.id, user_id: m.user_id })),
        { ignoreDuplicates: true }
      );
    }

    if (is_private !== undefined) channel.is_private = is_private;
    await channel.save();

    res.json({ channel: { id: channel.id, name: channel.name, is_private: channel.is_private } });
  } catch (err) { next(err); }
});

// DELETE /:channelId — Delete channel
router.delete('/:channelId', async (req, res, next) => {
  try {
    const result = await loadChannelAndCheckAdmin(req, res);
    if (!result) return;

    await result.channel.destroy();
    res.json({ message: 'Channel deleted' });
  } catch (err) { next(err); }
});

// POST /:channelId/join — Join channel
router.post('/:channelId/join', async (req, res, next) => {
  try {
    const channel = await Channel.findByPk(req.params.channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    // Must be a community member
    const communityMember = await CommunityMember.findOne({
      where: { community_id: channel.community_id, user_id: req.user.id },
    });
    if (!communityMember) return res.status(403).json({ error: 'Must be a community member' });

    const existing = await ChannelMember.findOne({
      where: { channel_id: channel.id, user_id: req.user.id },
    });
    if (existing) return res.status(400).json({ error: 'Already a channel member' });

    await ChannelMember.create({ channel_id: channel.id, user_id: req.user.id });
    res.json({ message: 'Joined channel' });
  } catch (err) { next(err); }
});

// POST /:channelId/leave — Leave channel
router.post('/:channelId/leave', async (req, res, next) => {
  try {
    const member = await ChannelMember.findOne({
      where: { channel_id: req.params.channelId, user_id: req.user.id },
    });
    if (!member) return res.status(400).json({ error: 'Not a channel member' });

    await member.destroy();
    res.json({ message: 'Left channel' });
  } catch (err) { next(err); }
});

// GET /:channelId/messages — Fetch messages (cursor-based)
router.get('/:channelId/messages', requireChannelMember, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const where = { channel_id: req.channel.id };
    if (req.query.before) {
      const cursor = await Message.findByPk(req.query.before);
      if (cursor) {
        where[Op.or] = [
          { created_at: { [Op.lt]: cursor.created_at } },
          { created_at: cursor.created_at, id: { [Op.lt]: cursor.id } },
        ];
      }
    }
    const messages = await Message.findAll({
      where,
      include: [{ model: User, as: 'author', attributes: ['id', 'username', 'display_name'] }],
      order: [['created_at', 'DESC'], ['id', 'DESC']],
      limit,
    });
    res.json({ messages: messages.map(serializeChannelMessage) });
  } catch (err) { next(err); }
});

// POST /:channelId/messages — Send a message
router.post('/:channelId/messages', requireChannelMember, async (req, res, next) => {
  try {
    const { content } = req.body;
    if (typeof content !== 'string' || content.length === 0) {
      return res.status(400).json({ error: 'content is required' });
    }
    const msg = await Message.create({
      channel_id: req.channel.id,
      author_id: req.user.id,
      content,
    });
    // Reload with author
    const full = await Message.findByPk(msg.id, {
      include: [{ model: User, as: 'author', attributes: ['id', 'username', 'display_name'] }],
    });
    const memberIds = await getChannelMemberIds(req.channel.id);
    broadcastToUsers(memberIds, {
      type: 'channel.message.created',
      channelId: req.channel.id,
      message: serializeChannelMessage(full),
    });

    // Notify all other members they have unread messages in this channel
    const otherMemberIds = memberIds.filter(id => id !== req.user.id);
    if (otherMemberIds.length > 0) {
      broadcastToUsers(otherMemberIds, {
        type: 'channel.unread',
        channelId: req.channel.id,
      });
    }

    res.status(201).json(serializeChannelMessage(full));
  } catch (err) { next(err); }
});

// POST /:channelId/read — Mark channel as read up to a message
router.post('/:channelId/read', requireChannelMember, async (req, res, next) => {
  try {
    const { messageId } = req.body;
    if (!messageId) return res.status(400).json({ error: 'messageId is required' });

    const msg = await Message.findOne({
      where: { id: messageId, channel_id: req.channel.id },
    });
    if (!msg) return res.status(404).json({ error: 'Message not found in this channel' });

    const member = await ChannelMember.findOne({
      where: { channel_id: req.channel.id, user_id: req.user.id },
    });
    if (!member) return res.status(403).json({ error: 'Not a channel member' });

    // Only advance forward
    if (member.last_read_message_id) {
      const current = await Message.findByPk(member.last_read_message_id);
      if (current) {
        const currentTs = current.createdAt.getTime();
        const newTs = msg.createdAt.getTime();
        if (currentTs > newTs || (currentTs === newTs && current.id >= msg.id)) {
          return res.json({ lastReadMessageId: member.last_read_message_id });
        }
      }
    }

    member.last_read_message_id = messageId;
    await member.save();

    // Tell only this user's sessions that this channel is now read
    broadcastToUsers([req.user.id], {
      type: 'channel.read',
      channelId: req.channel.id,
      lastReadMessageId: messageId,
    });

    res.json({ lastReadMessageId: messageId });
  } catch (err) { next(err); }
});

// PATCH /:channelId/messages/:msgId — Edit a message
router.patch('/:channelId/messages/:msgId', requireChannelMember, async (req, res, next) => {
  try {
    const { content } = req.body;
    if (typeof content !== 'string' || content.length === 0) {
      return res.status(400).json({ error: 'content is required' });
    }
    const msg = await Message.findOne({
      where: { id: req.params.msgId, channel_id: req.channel.id },
      include: [{ model: User, as: 'author', attributes: ['id', 'username', 'display_name'] }],
    });
    if (!msg) return res.status(404).json({ error: 'Not found' });
    if (msg.author_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    if (msg.deleted_at) return res.status(400).json({ error: 'Cannot edit a deleted message' });

    msg.content = content;
    msg.edited_at = new Date();
    await msg.save();

    const memberIds = await getChannelMemberIds(req.channel.id);
    broadcastToUsers(memberIds, {
      type: 'channel.message.edited',
      channelId: req.channel.id,
      message: serializeChannelMessage(msg),
    });
    res.json(serializeChannelMessage(msg));
  } catch (err) { next(err); }
});

// DELETE /:channelId/messages/:msgId — Soft delete a message
router.delete('/:channelId/messages/:msgId', requireChannelMember, async (req, res, next) => {
  try {
    const msg = await Message.findOne({
      where: { id: req.params.msgId, channel_id: req.channel.id },
    });
    if (!msg) return res.status(404).json({ error: 'Not found' });
    if (msg.author_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    if (msg.deleted_at) return res.json({ message: 'Already deleted' });

    msg.deleted_at = new Date();
    await msg.save();

    const memberIds = await getChannelMemberIds(req.channel.id);
    broadcastToUsers(memberIds, {
      type: 'channel.message.deleted',
      channelId: req.channel.id,
      messageId: msg.id,
    });
    res.json({ message: 'Deleted' });
  } catch (err) { next(err); }
});

module.exports = router;

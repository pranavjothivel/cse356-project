const { Router } = require('express');
const { Op, UniqueConstraintError } = require('sequelize');
const sequelize = require('../db');
const { Community, CommunityMember, Channel, ChannelMember, User } = require('../models');
const redisClient = require('../redis');
const { broadcastToUsers } = require('../ws');

const router = Router();

function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

router.use(requireAuth);

// POST / — Create community
router.post('/', async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });

    const ownedCount = await Community.count({ where: { owner_id: req.user.id } });
    if (ownedCount >= 100) return res.status(403).json({ error: 'Cannot create more than 100 communities' });

    const existing = await Community.findOne({ where: { name: name.trim() } });
    if (existing) return res.status(409).json({ error: 'A community with this name already exists', community: { id: existing.id, name: existing.name } });

    let community;
    try {
      community = await Community.create({ name: name.trim(), owner_id: req.user.id });
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        const dup = await Community.findOne({ where: { name: name.trim() } });
        return res.status(409).json({ error: 'A community with this name already exists', community: dup ? { id: dup.id, name: dup.name } : null });
      }
      throw err;
    }
    await CommunityMember.create({ community_id: community.id, user_id: req.user.id, role: 'owner' });

    res.status(201).json({ community: { id: community.id, name: community.name, owner_id: community.owner_id, created_at: community.created_at } });
  } catch (err) { next(err); }
});

// GET / — List user's communities
router.get('/', async (req, res, next) => {
  try {
    const memberships = await CommunityMember.findAll({
      where: { user_id: req.user.id },
      include: [{
        model: Community,
        as: 'community',
        include: [{ model: User, as: 'owner', attributes: ['id', 'display_name', 'username'] }],
      }],
    });

    const communities = memberships.map(m => ({
      id: m.community.id,
      name: m.community.name,
      owner: m.community.owner,
      role: m.role,
      joined_at: m.joined_at,
    }));

    res.json({ communities });
  } catch (err) { next(err); }
});

// GET /discover — List communities the user is not a member of
router.get('/discover', async (req, res, next) => {
  try {
    const memberships = await CommunityMember.findAll({
      where: { user_id: req.user.id },
      attributes: ['community_id'],
    });
    const memberIds = memberships.map(m => m.community_id);

    const where = memberIds.length > 0 ? { id: { [Op.notIn]: memberIds } } : {};
    if (req.query.search) {
      where.name = { [Op.iLike]: `%${req.query.search}%` };
    }

    const communities = await Community.findAll({
      where,
      include: [{ model: User, as: 'owner', attributes: ['id', 'display_name', 'username'] }],
      order: [['name', 'ASC']],
    });

    res.json({ communities: communities.map(c => ({
      id: c.id,
      name: c.name,
      owner: c.owner,
      created_at: c.created_at,
    })) });
  } catch (err) { next(err); }
});

// GET /:communityId — Get community details
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/:communityId', async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.communityId)) {
      return res.status(404).json({ error: 'Not found' });
    }
    const membership = await CommunityMember.findOne({
      where: { community_id: req.params.communityId, user_id: req.user.id },
    });
    if (!membership) return res.status(403).json({ error: 'Not a member of this community' });

    const community = await Community.findByPk(req.params.communityId, {
      include: [
        { model: User, as: 'owner', attributes: ['id', 'display_name', 'username'] },
        { model: Channel, as: 'channels', attributes: ['id', 'name', 'is_private', 'created_at'] },
      ],
    });
    if (!community) return res.status(404).json({ error: 'Community not found' });

    // Add is_joined and hasUnread flags to each channel
    const channelIds = community.channels.map(c => c.id);
    const joinedChannels = channelIds.length > 0
      ? await ChannelMember.findAll({ where: { channel_id: channelIds, user_id: req.user.id }, attributes: ['channel_id', 'last_read_message_id'] })
      : [];
    const joinedMap = new Map(joinedChannels.map(cm => [cm.channel_id, cm.last_read_message_id]));

    // Check all joined channels for unread messages in a single query.
    // Uses LEFT JOIN to resolve last_read_message_id so that deleted
    // last-read messages (lr.id IS NULL) are treated as "never read".
    const unreadSet = new Set();
    if (joinedChannels.length > 0) {
      const unreadRows = await sequelize.query(`
        SELECT cm.channel_id
        FROM channel_members cm
        LEFT JOIN messages lr ON lr.id = cm.last_read_message_id
        WHERE cm.channel_id IN (:channelIds)
          AND cm.user_id = :userId
          AND EXISTS (
            SELECT 1 FROM messages m
            WHERE m.channel_id = cm.channel_id
              AND (
                lr.id IS NULL
                OR (m.created_at, m.id) > (lr.created_at, lr.id)
              )
          )
      `, {
        replacements: {
          channelIds: [...joinedMap.keys()],
          userId: req.user.id,
        },
        type: sequelize.QueryTypes.SELECT,
      });
      for (const row of unreadRows) unreadSet.add(row.channel_id);
    }

    const channels = community.channels.map(c => ({
      id: c.id,
      name: c.name,
      is_private: c.is_private,
      created_at: c.created_at,
      is_joined: joinedMap.has(c.id),
      hasUnread: unreadSet.has(c.id),
    }));

    res.json({
      community: { id: community.id, name: community.name, owner_id: community.owner_id, created_at: community.created_at, owner: community.owner },
      role: membership.role,
      channels,
    });
  } catch (err) { next(err); }
});

// POST /:communityId/join — Join community
router.post('/:communityId/join', async (req, res, next) => {
  try {
    const community = await Community.findByPk(req.params.communityId);
    if (!community) return res.status(404).json({ error: 'Community not found' });

    let alreadyMember = false;
    await sequelize.transaction(async (t) => {
      const [, created] = await CommunityMember.findOrCreate({
        where: { community_id: community.id, user_id: req.user.id },
        defaults: { role: 'member' },
        transaction: t,
      });
      if (!created) { alreadyMember = true; return; }

      // Auto-join all public channels (atomic with community membership)
      const publicChannels = await Channel.findAll({
        where: { community_id: community.id, is_private: false },
        attributes: ['id'],
        transaction: t,
      });
      if (publicChannels.length > 0) {
        await ChannelMember.bulkCreate(
          publicChannels.map(c => ({ channel_id: c.id, user_id: req.user.id })),
          { ignoreDuplicates: true, transaction: t }
        );
      }
    });

    if (alreadyMember) return res.status(400).json({ error: 'Already a member' });
    res.json({ message: 'Joined community' });
  } catch (err) { next(err); }
});

// POST /:communityId/leave — Leave community
router.post('/:communityId/leave', async (req, res, next) => {
  try {
    const membership = await CommunityMember.findOne({
      where: { community_id: req.params.communityId, user_id: req.user.id },
    });
    if (!membership) return res.status(400).json({ error: 'Not a member' });
    if (membership.role === 'owner') return res.status(403).json({ error: 'Owner cannot leave. Delete the community or transfer ownership.' });

    // Remove from all channels in this community
    const channels = await Channel.findAll({
      where: { community_id: req.params.communityId },
      attributes: ['id'],
    });
    if (channels.length > 0) {
      await ChannelMember.destroy({
        where: { channel_id: channels.map(c => c.id), user_id: req.user.id },
      });
    }

    await membership.destroy();
    broadcastToUsers([req.user.id], { type: 'community.left', communityId: req.params.communityId });
    res.json({ message: 'Left community' });
  } catch (err) { next(err); }
});

// DELETE /:communityId — Delete community
router.delete('/:communityId', async (req, res, next) => {
  try {
    const community = await Community.findByPk(req.params.communityId);
    if (!community) return res.status(404).json({ error: 'Community not found' });
    if (community.owner_id !== req.user.id) return res.status(403).json({ error: 'Only the owner can delete the community' });

    const members = await CommunityMember.findAll({
      where: { community_id: community.id },
      attributes: ['user_id'],
    });
    const memberIds = members.map(m => m.user_id);

    await community.destroy();
    broadcastToUsers(memberIds, { type: 'community.deleted', communityId: community.id });
    res.json({ message: 'Community deleted' });
  } catch (err) { next(err); }
});

// GET /:communityId/members — List members with presence
router.get('/:communityId/members', async (req, res, next) => {
  try {
    const membership = await CommunityMember.findOne({
      where: { community_id: req.params.communityId, user_id: req.user.id },
    });
    if (!membership) return res.status(403).json({ error: 'Not a member' });

    const memberships = await CommunityMember.findAll({
      where: { community_id: req.params.communityId },
      include: [{ model: User, as: 'user', attributes: ['id', 'username', 'display_name', 'avatar'] }],
    });

    // Fetch presence from Redis for each member
    const members = await Promise.all(memberships.map(async (m) => {
      let presence = 'offline';
      try {
        const redisBody = await redisClient.hGet(`users:${m.user.id}`, 'body');
        if (redisBody) {
          presence = JSON.parse(redisBody).presence || 'offline';
        }
      } catch (_) {}

      return {
        user: { id: m.user.id, username: m.user.username, display_name: m.user.display_name, avatar: m.user.avatar },
        role: m.role,
        presence,
        joined_at: m.joined_at,
      };
    }));

    res.json({ members });
  } catch (err) { next(err); }
});

// POST /:communityId/channels — Create channel
router.post('/:communityId/channels', async (req, res, next) => {
  try {
    const { name, is_private } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });

    const membership = await CommunityMember.findOne({
      where: { community_id: req.params.communityId, user_id: req.user.id },
    });
    if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
      return res.status(403).json({ error: 'Only admins can create channels' });
    }

    const channel = await Channel.create({
      community_id: req.params.communityId,
      name: name.trim(),
      is_private: !!is_private,
    });

    if (is_private) {
      // Only add the creator
      await ChannelMember.create({ channel_id: channel.id, user_id: req.user.id });
    } else {
      // Add all community members
      const members = await CommunityMember.findAll({
        where: { community_id: req.params.communityId },
        attributes: ['user_id'],
      });
      await ChannelMember.bulkCreate(
        members.map(m => ({ channel_id: channel.id, user_id: m.user_id })),
        { ignoreDuplicates: true }
      );
    }

    res.status(201).json({ channel: { id: channel.id, name: channel.name, is_private: channel.is_private, community_id: channel.community_id } });
  } catch (err) { next(err); }
});

// GET /:communityId/channels — List channels
router.get('/:communityId/channels', async (req, res, next) => {
  try {
    const membership = await CommunityMember.findOne({
      where: { community_id: req.params.communityId, user_id: req.user.id },
    });
    if (!membership) return res.status(403).json({ error: 'Not a member' });

    const channels = await Channel.findAll({
      where: { community_id: req.params.communityId },
      attributes: ['id', 'name', 'is_private', 'created_at'],
    });

    const channelIds = channels.map(c => c.id);
    const joinedChannels = channelIds.length > 0
      ? await ChannelMember.findAll({ where: { channel_id: channelIds, user_id: req.user.id }, attributes: ['channel_id'] })
      : [];
    const joinedSet = new Set(joinedChannels.map(cm => cm.channel_id));

    res.json({
      channels: channels.map(c => ({
        id: c.id,
        name: c.name,
        is_private: c.is_private,
        created_at: c.created_at,
        is_joined: joinedSet.has(c.id),
      })),
    });
  } catch (err) { next(err); }
});

// PATCH /:communityId/members/:userId — Update member role
router.patch('/:communityId/members/:userId', async (req, res, next) => {
  try {
    const { role } = req.body;
    if (!role || !['admin', 'member'].includes(role)) {
      return res.status(400).json({ error: 'Role must be "admin" or "member"' });
    }

    // Only owner can change roles
    const requesterMembership = await CommunityMember.findOne({
      where: { community_id: req.params.communityId, user_id: req.user.id },
    });
    if (!requesterMembership || requesterMembership.role !== 'owner') {
      return res.status(403).json({ error: 'Only the owner can change member roles' });
    }

    if (req.params.userId === req.user.id) {
      return res.status(400).json({ error: 'Cannot change your own role' });
    }

    const targetMembership = await CommunityMember.findOne({
      where: { community_id: req.params.communityId, user_id: req.params.userId },
    });
    if (!targetMembership) return res.status(404).json({ error: 'User is not a member' });

    targetMembership.role = role;
    await targetMembership.save();
    res.json({ message: 'Role updated' });
  } catch (err) { next(err); }
});

module.exports = router;

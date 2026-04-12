const express = require('express');
const router = express.Router();
const { Op } = require('sequelize');
const User = require('../models/User');

function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

// GET /api/users/search?q=alice
// Partial-match search on username and display_name. Used to find users to DM.
router.get('/search', requireAuth, async (req, res, next) => {
  try {
    const { q } = req.query;
    if (!q || typeof q !== 'string' || q.trim().length === 0) {
      return res.status(400).json({ error: 'q is required' });
    }
    const users = await User.findAll({
      where: {
        [Op.or]: [
          { username: { [Op.iLike]: `%${q.trim()}%` } },
          { display_name: { [Op.iLike]: `%${q.trim()}%` } },
        ],
      },
      attributes: ['id', 'username', 'display_name', 'avatar'],
      limit: 20,
    });
    res.json({ users: users.map(u => ({
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      avatar: u.avatar,
    })) });
  } catch (err) { next(err); }
});

// GET /api/users/lookup?username=alice
// Returns minimal public info for a user. Used by the conversations UI to
// resolve a typed username into a user id before creating/inviting.
router.get('/lookup', requireAuth, async (req, res, next) => {
  try {
    const { username } = req.query;
    if (!username || typeof username !== 'string') {
      return res.status(400).json({ error: 'username is required' });
    }
    const user = await User.findOne({
      where: { username },
      attributes: ['id', 'username', 'display_name', 'avatar'],
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      avatar: user.avatar,
    });
  } catch (err) { next(err); }
});

module.exports = router;
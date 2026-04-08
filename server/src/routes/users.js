const express = require('express');
const router = express.Router();
const User = require('../models/User');

function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

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
const express = require('express');
const router = express.Router();
const { QueryTypes } = require('sequelize');
const sequelize = require('../db');

// Must match the expression in server/scripts/migrations/0002-messages-fts-index.sql
// exactly, or the planner will fall back to a seq-scan.
const FTS_CONFIG = 'english';

function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

// GET /api/search
// Query params:
//   q           - search text (required)
//   scope       - 'community' | 'conversation' (required)
//   communityId - required when scope=community
//   conversationId - required when scope=conversation
//   authorId    - optional filter by author UUID
//   after       - optional ISO timestamp lower bound
//   before      - optional ISO timestamp upper bound
//   limit       - max results (default 50, max 100)
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { q, scope, communityId, conversationId, authorId, after, before } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const userId = req.user.id;

    if (!q || !q.trim()) {
      return res.status(400).json({ error: 'q is required' });
    }
    if (scope !== 'community' && scope !== 'conversation') {
      return res.status(400).json({ error: "scope must be 'community' or 'conversation'" });
    }

    // Build the plainto_tsquery expression — plainto_tsquery handles plain text
    // without requiring the caller to know tsquery syntax.
    const bindings = [q.trim()];
    let scopeClause;

    if (scope === 'community') {
      if (!communityId) {
        return res.status(400).json({ error: 'communityId is required for community scope' });
      }

      // Verify the caller is a member of the community
      const membership = await sequelize.query(
        `SELECT 1 FROM community_members WHERE community_id = $1 AND user_id = $2 LIMIT 1`,
        { bind: [communityId, userId], type: QueryTypes.SELECT }
      );
      if (membership.length === 0) {
        return res.status(403).json({ error: 'Not a member of this community' });
      }

      // Accessible channels: public ones + private ones the user has joined
      bindings.push(communityId, userId);
      scopeClause = `
        m.channel_id IN (
          SELECT c.id FROM channels c
          WHERE c.community_id = $2
            AND (
              c.is_private = false
              OR EXISTS (
                SELECT 1 FROM channel_members cm
                WHERE cm.channel_id = c.id AND cm.user_id = $3
              )
            )
        )
      `;
    } else {
      // scope = conversation
      if (!conversationId) {
        return res.status(400).json({ error: 'conversationId is required for conversation scope' });
      }

      // Verify the caller is a participant
      const participation = await sequelize.query(
        `SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2 LIMIT 1`,
        { bind: [conversationId, userId], type: QueryTypes.SELECT }
      );
      if (participation.length === 0) {
        return res.status(403).json({ error: 'Not a participant of this conversation' });
      }

      bindings.push(conversationId);
      scopeClause = `m.conversation_id = $2`;
    }

    // Optional filters
    const extraClauses = [];
    if (authorId) {
      bindings.push(authorId);
      extraClauses.push(`m.author_id = $${bindings.length}`);
    }
    if (after) {
      bindings.push(after);
      extraClauses.push(`m.created_at >= $${bindings.length}`);
    }
    if (before) {
      bindings.push(before);
      extraClauses.push(`m.created_at <= $${bindings.length}`);
    }

    bindings.push(limit);
    const limitClause = `$${bindings.length}`;

    const extraWhere = extraClauses.length > 0 ? `AND ${extraClauses.join(' AND ')}` : '';

    const rows = await sequelize.query(
      `SELECT
         m.id,
         m.channel_id,
         m.conversation_id,
         m.author_id,
         u.username,
         u.display_name,
         m.content,
         m.created_at,
         m.edited_at
       FROM messages m
       JOIN users u ON u.id = m.author_id
       WHERE m.deleted_at IS NULL
         AND ${scopeClause}
         AND to_tsvector('${FTS_CONFIG}', m.content) @@ plainto_tsquery('${FTS_CONFIG}', $1)
         ${extraWhere}
       ORDER BY m.created_at DESC
       LIMIT ${limitClause}`,
      { bind: bindings, type: QueryTypes.SELECT }
    );

    const results = rows.map(r => ({
      id: r.id,
      content: r.content,
      author: {
        id: r.author_id,
        username: r.username,
        displayName: r.display_name,
      },
      createdAt: r.created_at,
      editedAt: r.edited_at,
      // Location info for jumping to the message
      channelId: r.channel_id || null,
      conversationId: r.conversation_id || null,
    }));

    res.json({ results });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

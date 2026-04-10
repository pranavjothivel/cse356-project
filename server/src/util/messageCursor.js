const { Op } = require('sequelize');
const Message = require('../models/Message');

/**
 * Build a Sequelize WHERE fragment for cursor-based message pagination.
 *
 *   direction='before' → messages strictly older than the cursor (scroll-up history)
 *   direction='after'  → messages strictly newer than the cursor (unread diff)
 *
 * Uses a (createdAt, id) tuple comparison so messages sharing the same
 * millisecond still have a stable, deterministic order.
 *
 * Returns null if the cursor message doesn't exist — callers should treat
 * that as "no cursor filter".
 */
async function buildMessageCursor(cursorId, direction = 'before') {
  if (!cursorId) return null;
  const cursor = await Message.findByPk(cursorId, { attributes: ['id', 'createdAt'] });
  if (!cursor || !cursor.createdAt) return null;

  const cmp = direction === 'before' ? Op.lt : Op.gt;
  return {
    [Op.or]: [
      { createdAt: { [cmp]: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { [cmp]: cursor.id } },
    ],
  };
}

module.exports = { buildMessageCursor };

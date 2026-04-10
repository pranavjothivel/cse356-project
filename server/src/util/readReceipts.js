const Message = require('../models/Message');

/**
 * Decide whether advancing a user's last-read pointer from `currentId` to
 * `newMsg` is a forward move.
 *
 * Returns true if:
 *   - there is no current pointer (any message is forward), or
 *   - the current message can't be found or lacks a timestamp (allow advance), or
 *   - newMsg is strictly newer than the current message by (createdAt, id).
 *
 * The defensive null/undefined guards on createdAt handle rows that were
 * written without timestamps (e.g. during a failed mid-sync migration).
 */
async function isForwardRead(currentId, newMsg) {
  if (!currentId) return true;
  const current = await Message.findByPk(currentId, { attributes: ['id', 'createdAt'] });
  if (!current || !current.createdAt || !newMsg.createdAt) return true;

  const curTs = current.createdAt.getTime();
  const newTs = newMsg.createdAt.getTime();
  if (newTs > curTs) return true;
  if (newTs === curTs && newMsg.id > current.id) return true;
  return false;
}

module.exports = { isForwardRead };

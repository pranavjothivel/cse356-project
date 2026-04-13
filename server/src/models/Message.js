const { DataTypes, Model } = require('sequelize');
const sequelize = require('../db');

class Message extends Model {}

Message.init({
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  // Exactly one of conversation_id / channel_id is set. Channel support is added later;
  // the column exists now so the same table backs both DMs and channels.
  conversation_id: { type: DataTypes.UUID, allowNull: true },
  channel_id: { type: DataTypes.UUID, allowNull: true },
  author_id: { type: DataTypes.UUID, allowNull: false },
  content: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
  edited_at: { type: DataTypes.DATE, allowNull: true },
  // Up to 4 image URLs (uploaded via POST /api/upload)
  attachments: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: false, defaultValue: [] },
}, {
  sequelize,
  tableName: 'messages',
  underscored: true,
  indexes: [
    { fields: ['conversation_id', 'created_at'] },
    { fields: ['channel_id', 'created_at'] },
    { fields: ['author_id'] },
    // FTS GIN index is managed via server/scripts/migrations/0002-messages-fts-index.sql.
    // Expression-based GIN indexes don't belong here — sequelize.sync() handles them
    // poorly and any syntax error would crash startup.
  ],
});

module.exports = Message;
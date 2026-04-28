const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../db');

class ConversationParticipant extends Model {}

ConversationParticipant.init({
  conversation_id: { type: DataTypes.UUID, primaryKey: true },
  user_id: { type: DataTypes.UUID, primaryKey: true },
  joined_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW, allowNull: false },
  // Per-user "hide from sidebar" flag — used for 1:1 DMs the user wants to dismiss
  // without deleting history. Cleared on next message in the conversation.
  hidden_at: { type: DataTypes.DATE, allowNull: true },
  // Tracks the furthest message this user has read in the conversation
  last_read_message_id: { type: DataTypes.UUID, allowNull: true, defaultValue: null },
}, {
  sequelize,
  tableName: 'conversation_participants',
  underscored: true,
  timestamps: false,
  indexes: [
    { fields: ['user_id'] },
  ],
});

module.exports = ConversationParticipant;
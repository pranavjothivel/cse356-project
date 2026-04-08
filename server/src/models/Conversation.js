const { DataTypes, Model } = require('sequelize');
const sequelize = require('../db');

class Conversation extends Model {}

Conversation.init({
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  kind: { type: DataTypes.ENUM('dm', 'group'), allowNull: false },
  // For kind='dm', this is the canonical sorted "userA:userB" key.
  // Null for kind='group' so groups never collide with each other or with DMs.
  dm_key: { type: DataTypes.STRING, allowNull: true },
}, {
  sequelize,
  tableName: 'conversations',
  underscored: true,
  indexes: [
    { unique: true, fields: ['dm_key'], where: { kind: 'dm' } },
  ],
});

// Canonical dm_key for a pair of user ids.
Conversation.dmKey = function dmKey(a, b) {
  return [a, b].sort().join(':');
};

module.exports = Conversation;
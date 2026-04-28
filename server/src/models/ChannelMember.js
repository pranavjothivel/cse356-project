const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../db');

class ChannelMember extends Model {}

ChannelMember.init({
  channel_id: {
    type: DataTypes.UUID,
    primaryKey: true,
    references: { model: 'channels', key: 'id' },
    onDelete: 'CASCADE',
  },
  user_id: {
    type: DataTypes.UUID,
    primaryKey: true,
    references: { model: 'users', key: 'id' },
    onDelete: 'CASCADE',
  },
  joined_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
  // Tracks the furthest message this user has read in this channel
  last_read_message_id: { type: DataTypes.UUID, allowNull: true, defaultValue: null },
}, {
  sequelize,
  tableName: 'channel_members',
  underscored: true,
  timestamps: false,
});

module.exports = ChannelMember;

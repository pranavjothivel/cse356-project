const { DataTypes, Model } = require('sequelize');
const sequelize = require('../db');

class ChannelMember extends Model {}

ChannelMember.removeAttribute('id');

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
}, {
  sequelize,
  tableName: 'channel_members',
  underscored: true,
  timestamps: false,
});

module.exports = ChannelMember;

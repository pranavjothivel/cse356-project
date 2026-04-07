const { DataTypes, Model } = require('sequelize');
const sequelize = require('../db');

class CommunityMember extends Model {}

CommunityMember.removeAttribute('id');

CommunityMember.init({
  community_id: {
    type: DataTypes.UUID,
    primaryKey: true,
    references: { model: 'communities', key: 'id' },
    onDelete: 'CASCADE',
  },
  user_id: {
    type: DataTypes.UUID,
    primaryKey: true,
    references: { model: 'users', key: 'id' },
    onDelete: 'CASCADE',
  },
  role: {
    type: DataTypes.ENUM('owner', 'admin', 'member'),
    defaultValue: 'member',
    allowNull: false,
  },
  joined_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  sequelize,
  tableName: 'community_members',
  underscored: true,
  timestamps: false,
});

module.exports = CommunityMember;

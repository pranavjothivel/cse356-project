const { DataTypes, Model } = require('sequelize');
const sequelize = require('../db');

class Channel extends Model {}

Channel.init({
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  community_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'communities', key: 'id' },
    onDelete: 'CASCADE',
  },
  name: { type: DataTypes.STRING, allowNull: false },
  is_private: { type: DataTypes.BOOLEAN, defaultValue: false },
}, {
  sequelize,
  tableName: 'channels',
  underscored: true,
});

module.exports = Channel;

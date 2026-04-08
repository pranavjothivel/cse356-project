const { DataTypes, Model } = require('sequelize');
const sequelize = require('../db');

class Community extends Model {}

Community.init({
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING, allowNull: false, unique: true },
  owner_id: { type: DataTypes.UUID, allowNull: false },
}, {
  sequelize,
  tableName: 'communities',
  underscored: true,
});

module.exports = Community;

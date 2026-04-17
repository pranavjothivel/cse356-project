const { Sequelize } = require('sequelize');

const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  logging: false,
  pool: {
    max: 20,
    min: 2,
    idle: 10000,
    acquire: 30000,
  },
  dialectOptions: {
    ...(process.env.NODE_ENV === 'production'
      ? { ssl: { require: true, rejectUnauthorized: false } }
      : {}),
    prepareThreshold: 0,
  },
});

module.exports = sequelize;

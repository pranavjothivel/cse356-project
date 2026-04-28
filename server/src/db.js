const { Sequelize } = require('sequelize');

const dialectOptions = {
  ...(process.env.NODE_ENV === 'production'
    ? { ssl: { require: true, rejectUnauthorized: false } }
    : {}),
  prepareThreshold: 0,
};

const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  logging: false,
  pool: { max: 14, min: 2, acquire: 30000, idle: 10000 },
  dialectOptions,
});

const searchSequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  logging: false,
  pool: { max: 6, min: 0, acquire: 30000, idle: 10000 },
  dialectOptions,
});

module.exports = { sequelize, searchSequelize };
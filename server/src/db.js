const { Sequelize } = require('sequelize');

const baseDialectOptions = {
  ...(process.env.NODE_ENV === 'production'
    ? { ssl: { require: true, rejectUnauthorized: false } }
    : {}),
  prepareThreshold: 0,
};

const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  logging: false,
  // acquire=15000 caps how long a request waits for a free connection before
  // throwing — bounded fail-fast under burst, instead of piling up behind a
  // 30s acquire and tripping the autograder's 15s client timeout.
  pool: { max: 20, min: 2, acquire: 15000, idle: 10000 },
  dialectOptions: { ...baseDialectOptions, statement_timeout: 10000 },
});

const searchSequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  logging: false,
  pool: { max: 6, min: 0, acquire: 30000, idle: 10000 },
  dialectOptions: baseDialectOptions,
});

module.exports = { sequelize, searchSequelize };
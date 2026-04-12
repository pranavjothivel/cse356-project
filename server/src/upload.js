const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

const BUCKET = 'images';
const Minio = require('minio');
const minioClient = new Minio.Client({
  endPoint: process.env.MINIO_HOST,
  port: 9000,
  useSSL: false,
  accessKey: process.env.MINIO_ACCESS_KEY,
  secretKey: process.env.MINIO_SECRET_KEY
});

module.exports = { upload, minioClient, BUCKET };
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

const Minio = require('minio');
const minioClient = new Minio.Client({
  endPoint: process.env.MINIO_HOST,
  port: 9000,
  useSSL: process.env.NODE_ENV === 'production',
  accessKey: process.env.MINIO_ACCESS_KEY,
  secretKey: process.env.MINIO_SECRET_KEY
});

module.exports = { upload, minioClient };
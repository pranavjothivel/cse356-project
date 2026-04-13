const multer = require('multer');

const upload = multer({ 
  storage: multer.memoryStorage(), 
  limits: { 
    fileSize: 5*1024*1024, // 5 MB limit
    files: 1, // 1 file

    // I don't think the client sends fields, but just in case allow 2
    fieldSize: 1*1024*1024, 
    fields: 2,

    parts: 3,
  } 
});

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
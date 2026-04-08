const express = require('express');
const router = express.Router();
const path = require('path');
const crypto = require('crypto');
const { upload, minioClient } = require('../upload');

function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

const BUCKET = 'images';

// POST /api/upload
// Accepts a single image file, uploads to MinIO, returns { url }.
router.post('/', requireAuth, upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image provided or invalid file type' });
  }
  const objectName = `${req.user.id}/${crypto.randomUUID()}${path.extname(req.file.originalname)}`;
  const exists = await minioClient.bucketExists(BUCKET);
  if (!exists) {
    return res.status(500).json({ error: 'Storage bucket not found' });
  }
  await minioClient.putObject(BUCKET, objectName, req.file.buffer, req.file.size, { 'Content-Type': req.file.mimetype });
  res.json({ url: objectName });
});

module.exports = router;

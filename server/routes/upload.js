const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { requireAuth } = require('../middleware/auth');
const { hit } = require('../middleware/rate-limit');
const store = require('../media-store');

// Avatar / general single-image upload, reachable by EVERY signed-in role including
// a self-registered 'readonly' one - a reader needs a profile picture.
//
// Deliberately kept separate from routes/media.js, which is the post-image library
// and requires `editor` or `admin`. The two differ in exactly one way that matters:
// this route is capped for everybody, because the account that can reach it is the
// account anyone on the internet can create. Nothing uploaded here is unlimited,
// even for an admin - an admin wanting the unlimited path uses the library.
//
// The validation itself (magic bytes, generated filename, extension from content)
// lives in server/media-store.js and is shared, so the two routes cannot drift apart
// on what counts as an acceptable image.
const router = express.Router();

const upload = multer({
  // To data/tmp-uploads/, outside public/ - a file that turns out not to be an image
  // is never reachable over HTTP even for the instant before it is deleted.
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, store.TMP_UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}.part`),
  }),
  limits: { fileSize: store.EDITOR_MAX_FILE_BYTES, files: 1, fields: 10, parts: 12 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!store.ALLOWED_EXT.includes(ext)) {
      return cb(new Error('Chỉ chấp nhận ảnh định dạng JPG, PNG, WEBP hoặc GIF.'));
    }
    cb(null, true);
  },
});

function multerErrorMessage(err) {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return `Ảnh quá lớn. Kích thước tối đa là ${Math.round(store.EDITOR_MAX_FILE_BYTES / (1024 * 1024))} MB.`;
  }
  if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
    return 'Chỉ tải lên được một ảnh mỗi lần.';
  }
  return err.message;
}

// POST /api/upload  (multipart/form-data, field name "image")
router.post('/', requireAuth, (req, res) => {
  // Checked before the body is read, so a rate-limited caller cannot make the
  // server write 8 MB just to be told no.
  const quota = hit('upload', String(req.user.id), 60 * 60_000, store.EDITOR_MAX_UPLOADS_PER_HOUR);
  if (quota.limited) {
    res.set('Retry-After', String(quota.retryAfter));
    return res.status(429).json({
      error: 'Bạn đã tải lên quá nhiều ảnh trong một giờ. Vui lòng thử lại sau.',
      retryAfter: quota.retryAfter,
    });
  }
  const diskError = store.diskHeadroomError(Number(req.headers['content-length']) || 0);
  if (diskError) return res.status(507).json({ error: diskError });

  upload.single('image')(req, res, (err) => {
    if (err) {
      if (req.file && req.file.path) {
        try {
          fs.unlinkSync(req.file.path);
        } catch {
          /* already gone */
        }
      }
      return res.status(400).json({ error: multerErrorMessage(err) });
    }
    if (!req.file) return res.status(400).json({ error: 'Không có file nào được tải lên.' });

    const result = store.commitUpload({
      tmpPath: req.file.path,
      originalName: req.file.originalname,
      uploaderId: req.user.id,
      isAdmin: false,
    });
    if (result.error) return res.status(400).json({ error: result.error });
    // Recorded in the media table like any other upload, so an avatar shows up in
    // the library rather than being an untracked file on disk.
    res.json({ url: result.url, media: result.media });
  });
});

module.exports = router;

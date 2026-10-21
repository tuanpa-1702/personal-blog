const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db');
const { requireAuth, requireWriter, requireAdmin } = require('../middleware/auth');
const { hit } = require('../middleware/rate-limit');
const store = require('../media-store');
const thumbs = require('../thumbs');
// Deleting an image moves it to the recycle bin (file included); the irreversible
// unlink is store.deleteMedia() via trash-store.purgeMedia(), from the bin.
const trashStore = require('../trash-store');

// Media library (Admin > Thư viện, and the picker in the post editor).
//
// Every route here needs `requireWriter` at least: a 'readonly' account has no
// business browsing or adding to the library. The avatar uploader that every role
// can reach is a separate route (routes/upload.js) with its own 8 MB ceiling.
//
// WHO IS HELD TO WHAT
//   admin  - no per-file size limit, no hourly count limit. The one thing that
//            still stops them is free disk space (see media-store.js): SQLite's
//            WAL lives on this filesystem, so a full disk stops the site saving
//            posts and logins, not merely uploads.
//   editor - 8 MB per file, 40 files per hour. Unchanged from before.
const router = express.Router();
router.use(requireAuth, requireWriter);

function isAdmin(req) {
  return req.user.role === 'admin';
}

// multer writes to `data/tmp-uploads/`, OUTSIDE public/, and media-store only moves
// a file into the served directory after its bytes have been checked. Disk rather
// than memory because an admin upload has no size cap - buffering a 2 GB file would
// take the process down.
//
// Two multer instances rather than one with a dynamic limit: multer resolves
// `limits` when it is constructed, not per request, so the editor ceiling has to be
// a separate uploader. `pickUploader` chooses between them by role.
function diskStorage() {
  return multer.diskStorage({
    destination: (req, file, cb) => cb(null, store.TMP_UPLOAD_DIR),
    // A temporary name, never derived from what the client sent: the permanent name
    // is generated in media-store after the content has been sniffed.
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.part`),
  });
}

const COMMON_LIMITS = { files: 1, fields: 10, parts: 12 };

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!store.ALLOWED_EXT.includes(ext)) {
    return cb(new Error('Chỉ chấp nhận ảnh định dạng JPG, PNG, WEBP hoặc GIF.'));
  }
  cb(null, true);
}

// No fileSize entry at all: multer's default is no limit, which is exactly what an
// admin gets. The disk-headroom check in media-store.js is what bounds it.
const adminUpload = multer({ storage: diskStorage(), limits: COMMON_LIMITS, fileFilter });

const editorUpload = multer({
  storage: diskStorage(),
  limits: { ...COMMON_LIMITS, fileSize: store.EDITOR_MAX_FILE_BYTES },
  fileFilter,
});

function multerErrorMessage(err) {
  if (err.code === 'LIMIT_FILE_SIZE') {
    const mb = Math.round(store.EDITOR_MAX_FILE_BYTES / (1024 * 1024));
    return `Ảnh quá lớn. Tài khoản của bạn được tải lên tối đa ${mb} MB mỗi ảnh.`;
  }
  if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
    return 'Chỉ tải lên được một ảnh mỗi lần.';
  }
  return err.message;
}

// POST /api/media  (multipart/form-data, field name "image")
router.post('/', (req, res) => {
  const admin = isAdmin(req);

  // Both checks run BEFORE the body is read, so a caller who is going to be refused
  // does not first make the server write the file.
  if (!admin) {
    const quota = hit('media-upload', String(req.user.id), 60 * 60_000, store.EDITOR_MAX_UPLOADS_PER_HOUR);
    if (quota.limited) {
      res.set('Retry-After', String(quota.retryAfter));
      return res.status(429).json({
        error: 'Bạn đã tải lên quá nhiều ảnh trong một giờ. Vui lòng thử lại sau.',
        retryAfter: quota.retryAfter,
      });
    }
  }
  // Declared size, when the client sent one. A dishonest value only delays the
  // refusal to the post-write check in commitUpload().
  const declared = Number(req.headers['content-length']) || 0;
  const diskError = store.diskHeadroomError(declared);
  if (diskError) return res.status(507).json({ error: diskError });

  const uploader = admin ? adminUpload : editorUpload;
  uploader.single('image')(req, res, (err) => {
    if (err) {
      // multer may already have written part of the file before hitting the limit.
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
      isAdmin: admin,
      // Whichever folder the uploader had open. A multipart field, so it arrives as
      // a string; commitUpload verifies the folder exists before writing it.
      folderId: req.body && req.body.folder_id ? Number(req.body.folder_id) : null,
    });
    if (result.error) return res.status(400).json({ error: result.error });
    res.status(201).json({ media: result.media, url: result.url });
  });
});

// GET /api/media?page=&limit=&q=&mine=
//
// Newest first, paginated - the grid loads more as the reader scrolls. `q` matches
// the original filename, which is the only thing a person can recognise a file by
// (the stored name is a timestamp and random bytes).
router.get('/', (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 40, 1), 100);
  const offset = (page - 1) * limit;

  const clauses = [];
  const params = {};
  // The bin is not part of the library: trashed images are gone from the grid,
  // the folder counts and the totals alike.
  clauses.push('m.deleted_at IS NULL');
  if (req.query.mine === 'true') {
    clauses.push('m.uploader_id = @uploader');
    params.uploader = req.user.id;
  }
  const q = String(req.query.q || '').trim();
  if (q) {
    clauses.push('m.original_name LIKE @q');
    params.q = `%${q}%`;
  }

  // Folder filter. Three cases, and the third is why this is not one line:
  //   folder=<id>   images filed directly in that folder
  //   folder=none   unfiled images
  //   (absent)      every image, whatever its folder - the "Tất cả ảnh" view
  //
  // A SEARCH deliberately ignores the folder: someone typing a filename wants to
  // find it, not to be told it is not in the folder they happen to have open.
  const rawFolder = req.query.folder;
  let folder = null;
  if (!q && rawFolder !== undefined && rawFolder !== '') {
    if (rawFolder === 'none') {
      clauses.push('m.folder_id IS NULL');
    } else {
      folder = store.getFolder(rawFolder);
      if (!folder) return res.status(404).json({ error: 'Không tìm thấy thư mục.' });
      clauses.push('m.folder_id = @folder');
      params.folder = folder.id;
    }
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS c FROM media m ${where}`).get(params).c;
  const items = db
    .prepare(
      `${store.MEDIA_SELECT} ${where} ORDER BY m.created_at DESC, m.id DESC
        LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit, offset });

  res.json({
    media: items.map((m) => ({
      ...m,
      url: `/uploads/${m.filename}`,
      // The grid renders this, not the original: a 480px JPEG instead of an
      // 8-14 MB photo. Falls back to the original's own URL when ImageMagick
      // is not installed (see server/thumbs.js), so the client needs no branch.
      thumb_url: thumbs.thumbUrlFor(m.filename),
    })),
    total,
    page,
    limit,
    totals: store.mediaTotals(),
    // The whole tree comes with every listing. It is a handful of rows and the
    // sidebar needs all of it to render, so a second request would only add a
    // moment where the grid and the tree disagree.
    folders: store.listFolders(),
    folderPath: folder ? store.folderPath(folder.id) : [],
    unfiledCount: db.prepare('SELECT COUNT(*) AS c FROM media WHERE folder_id IS NULL AND deleted_at IS NULL').get().c,
    // The client uses this to word its own limits and to show or hide the delete
    // button, rather than duplicating the role rules.
    canDeleteAny: isAdmin(req),
    maxFileBytes: isAdmin(req) ? null : store.EDITOR_MAX_FILE_BYTES,
    // Admin-only, and the CACHED verdict rather than a fresh probe: a listing runs
    // on every scroll of the grid and must not write a scratch file each time. A
    // bin this process cannot write into is why every delete fails at once, so the
    // one person who can run the chown is the one person shown this.
    trashDir: isAdmin(req) ? store.trashDirStatus() : undefined,
  });
});

// ---------------------------------------------------------------- folders
//
// Creating and organising folders is an EDITOR-level action, same as uploading:
// somebody who can add images to the library can tidy them. Deleting a folder is
// admin-only, because it affects every image filed under it - including other
// people's - even though it never deletes an image.
//
// Every route lives above '/sync' and below '/:id' concerns: Express matches in
// order, and '/folders' would otherwise be caught by the '/:id/usage' pattern.

// GET /api/media/folders - the whole tree, with per-folder counts.
router.get('/folders', (req, res) => {
  res.json({
    folders: store.listFolders(),
    unfiledCount: db.prepare('SELECT COUNT(*) AS c FROM media WHERE folder_id IS NULL AND deleted_at IS NULL').get().c,
  });
});

// POST /api/media/folders { name, parent_id }
router.post('/folders', (req, res) => {
  const { name, parent_id } = req.body || {};
  const result = store.createFolder(name, parent_id ? Number(parent_id) : null);
  if (result.error) return res.status(400).json({ error: result.error });
  res.status(201).json({ folder: result.folder, folders: store.listFolders() });
});

// PUT /api/media/folders/:id { name?, parent_id? }
// Rename, re-parent, or both. `parent_id: null` moves a folder back to the top level,
// which is why the key's PRESENCE is what decides whether to move it - `null` is a
// meaningful value here and cannot be used to mean "unchanged".
router.put('/folders/:id', (req, res) => {
  const body = req.body || {};
  const id = Number(req.params.id);

  if (body.name !== undefined) {
    const renamed = store.renameFolder(id, body.name);
    if (renamed.error) return res.status(400).json({ error: renamed.error });
  }
  if (Object.prototype.hasOwnProperty.call(body, 'parent_id')) {
    const moved = store.moveFolder(id, body.parent_id);
    if (moved.error) return res.status(400).json({ error: moved.error });
  }

  const folder = store.getFolder(id);
  if (!folder) return res.status(404).json({ error: 'Không tìm thấy thư mục.' });
  res.json({ folder, folders: store.listFolders() });
});

// DELETE /api/media/folders/:id  (admin only)
// Deletes the folder and its whole subtree. The images inside become UNFILED - they
// stay on disk and stay in the library. Deleting images is a separate, explicit action.
router.delete('/folders/:id', requireAdmin, (req, res) => {
  const result = store.deleteFolder(Number(req.params.id));
  if (result.error) return res.status(404).json({ error: result.error });
  res.json({ ...result, folders: store.listFolders() });
});

// PUT /api/media/move { media_ids: [], folder_id: <id>|null }
// Files images into a folder, or unfiles them with folder_id: null.
router.put('/move', (req, res) => {
  const { media_ids, folder_id } = req.body || {};
  const target = folder_id === null || folder_id === undefined || folder_id === '' ? null : Number(folder_id);
  const result = store.moveMedia(media_ids, target);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

// GET /api/media/:id/usage - which posts reference this file.
router.get('/:id/usage', (req, res) => {
  const row = store.getMedia(req.params.id);
  if (!row) return res.status(404).json({ error: 'Không tìm thấy ảnh.' });
  res.json({ usage: store.findUsage(row.filename) });
});

// DELETE /api/media/:id
//
// An admin may delete anything. An editor may delete only what they uploaded -
// otherwise one editor could remove the images another author's published post is
// displaying. A file adopted at boot has uploader_id NULL and belongs to nobody, so
// only an admin can remove it.
//
// A file still referenced by a post is trashed only with ?force=true. The client
// asks /usage first and puts the count in front of the person before they confirm;
// this is the server half of that, so a caller that skips the dialog still gets
// stopped once. Trashing moves the file out of public/uploads into
// data/media-trash/, so every <img> pointing at it 404s from this request on -
// which is exactly what the confirmation is warning about.
router.delete('/:id', (req, res) => {
  const row = store.getMedia(req.params.id);
  if (!row || row.deleted_at) return res.status(404).json({ error: 'Không tìm thấy ảnh.' });

  if (!isAdmin(req) && row.uploader_id !== req.user.id) {
    return res.status(403).json({
      error: 'Bạn chỉ có thể xoá ảnh do chính mình tải lên. Nhờ quản trị viên xoá ảnh này.',
    });
  }

  const usage = store.findUsage(row.filename);
  if (usage.length && req.query.force !== 'true') {
    return res.status(409).json({
      error: `Ảnh này đang được dùng trong ${usage.length} bài viết.`,
      usage,
      // The client re-sends with ?force=true after the person confirms.
      requiresConfirmation: true,
    });
  }

  const result = trashStore.trash('media', row.id, req.user);
  if (result.error) return res.status(500).json({ error: result.error });
  res.json({ ok: true, trashed: true, filename: row.filename, usage });
});

// POST /api/media/sync (admin only)
// Re-runs the filesystem reconciliation by hand. The same pass runs at boot; this
// is for after files have been added or removed over SSH without a restart.
router.post('/sync', requireAdmin, (req, res) => {
  const adopted = store.adoptOrphanFiles();
  const pruned = store.pruneMissingFiles();
  // The active check, unlike the listing's: syncing is an explicit admin action,
  // so this is the place to re-probe the bin and rebuild it if it can. Hitting
  // "Đồng bộ" is therefore also how an admin clears a broken bin without a
  // restart, once the permissions underneath it have been fixed.
  const trashDir = store.checkTrashDir();
  res.json({ ok: true, adopted, pruned, totals: store.mediaTotals(), trashDir });
});

module.exports = router;

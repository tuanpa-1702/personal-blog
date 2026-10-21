// Admin > Thùng rác. The bin's own surface: what is in it, per folder, and the
// two things an admin can do to an entry - put it back, or make its deletion the
// irreversible kind.
//
// Trashing itself is NOT here: the four DELETE routes (posts, comments, users,
// media) move their row into the bin through server/trash-store.js, so a delete
// from anywhere in the app lands in the same place with the same grouping rule.
// This router only reads the bin and reverses or completes a deletion.

const express = require('express');
const trash = require('../trash-store');
// Not inherited from routes/admin.js: this router is mounted at
// /api/admin/trash BEFORE /api/admin in server.js (the more specific prefix has
// to win), so the admin router's router.use() guard never runs for these paths.
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireAdmin);

// Every route below is admin-only by the router.use() guard at the top.
const kindOf = (req, res, next) => {
  if (!trash.KINDS.includes(req.params.kind)) {
    return res.status(404).json({ error: 'Không tìm thấy thư mục thùng rác.' });
  }
  next();
};

// GET /api/admin/trash/counts - the four folder badges. Cheap enough to refetch
// after every restore/purge, which is how the badges stay honest.
router.get('/counts', (req, res) => {
  res.json({ counts: trash.counts() });
});

// GET /api/admin/trash/:kind?page=&limit= - one folder, newest deletion first.
router.get('/:kind', kindOf, (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const result = trash.list(req.params.kind, page, limit);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ ...result, page, limit, counts: trash.counts() });
});

// POST /api/admin/trash/:kind/:id/restore
router.post('/:kind/:id/restore', kindOf, (req, res) => {
  const result = trash.restore(req.params.kind, Number(req.params.id));
  if (result.error) return res.status(409).json({ error: result.error });
  res.json({ ...result, counts: trash.counts() });
});

// POST /api/admin/trash/:kind/:id/purge - the point of no return. Cascades
// exactly as the old hard delete did (a purged post takes its comments, a purged
// user takes their posts), and writes the activity-log row the old delete wrote.
router.post('/:kind/:id/purge', kindOf, (req, res) => {
  const result = trash.purge(req.params.kind, Number(req.params.id), req.user);
  if (result.error) return res.status(409).json({ error: result.error });
  res.json({ ok: true, counts: trash.counts() });
});

module.exports = router;

const express = require('express');
const db = require('../db');

const router = express.Router();

// GET /api/settings - public, used by the homepage to render editable site copy
router.get('/', (req, res) => {
  // Never cache this at the CDN/browser level - admin edits must reflect
  // immediately on the homepage without needing a manual cache purge.
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  rows.forEach((r) => (settings[r.key] = r.value));
  res.json({ settings });
});

module.exports = router;

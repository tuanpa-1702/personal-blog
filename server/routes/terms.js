const express = require('express');
const terms = require('../terms');

const router = express.Router();

// GET /api/terms - the saved terms document as JSON: the clauses in the order an
// admin last saved them, plus the save timestamp. Public like the page itself:
// the document holds no secrets, only the wording the page shows. The editor on
// /terms.html reads this to fill its textareas; when it answers "never saved"
// the editor converts the page's own sections into the same shape instead.
router.get('/', (req, res) => {
  // The document changes on save and on nothing else, and a save must be visible
  // on the next load: never let a cache sit between the two.
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  const saved = terms.getTerms();
  res.json(saved ? { updatedAt: saved.updatedAt, clauses: saved.clauses } : { updatedAt: null, clauses: [] });
});

module.exports = router;

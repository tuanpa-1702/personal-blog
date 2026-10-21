const db = require('./db');

// The terms-of-service document (public/terms.html), editable by an admin from
// the page itself, with the same rich-text editor the post writer uses
// (public/js/write.js is loaded on the terms page for exactly that).
//
// The page ships with the ten clauses written into the markup, and that copy is
// what everybody sees until an admin saves for the first time: the table below
// stays EMPTY until then, and server/render-html.js only replaces the article's
// body when it finds a row. So a fresh deployment reads exactly like the static
// page, and the markup remains the fallback if the database cannot answer.
//
// One row holds the whole document (id is CHECKed to 1): the clauses are an
// ordered JSON array rather than child rows because the only things anyone does
// with them are "read all, in order" and "replace all, in order" - a reorder or
// a delete is then a plain array edit inside one atomic write, with no orphan
// rows to clean up and no ordering column to renumber.
//
// A clause body is the SAME thing a post paragraph is: rich HTML, sanitised by
// server/sanitize-html.js on the way in (routes/admin.js), rendered as-is here.
// Two plain-text tokens survive inside it, because they stand for markup no
// editor toolbar can produce and no sanitizer should be asked to keep:
//
//   [brand]    the site-name slot (a data-brand-name span), so renaming the blog
//              in the admin panel renames it inside clause 1 too
//   [contact]  a paragraph of its own: the contact block of clause 10 - the
//              address as its label and the mailto href built from the
//              contact_email setting, with no icon and no underline: a line of
//              the clause rather than a control
//
// Both are expanded below, BEFORE render-html.js runs its substitution passes,
// which is what fills the brand span, builds the mailto href and hides the
// contact paragraph when the setting is empty.
//
// updated_at is the "Cập nhật lần cuối" date at the top of the page. It is
// written ONLY by saveTerms(), at the moment the admin presses save - never on
// boot, never on read - so it means what the page claims it means.

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const CONTACT_TOKEN = '[contact]';
const BRAND_TOKEN = '[brand]';

// Byte-identical to the paragraph clause 10 of public/terms.html carries, so a
// saved document and the shipped one render the same contact block - markers
// included: render-html.js runs the terms injection BEFORE its substitution
// passes, which is what fills the mailto href and hides the paragraph when the
// setting is empty.
const CONTACT_HTML =
  '<p data-hide-if-empty="contact_email"><a data-setting-mailto="contact_email" class="footer-link">' +
  '<span class="footer-link-label" data-setting="contact_email"></span></a></p>';

// The tokens an admin types in the editor become the markup they stand for.
// [contact] only counts as a paragraph of its own - mid-sentence it stays the
// literal text the author typed, which is what an author who wrote it by
// accident gets to see and delete.
function expandTokens(html) {
  return String(html || '')
    .split(BRAND_TOKEN).join('<span data-brand-name></span>')
    .replace(/<p([^>]*)>\s*\[contact\]\s*<\/p>/g, () => CONTACT_HTML);
}

// The ten (or however many) <section>s that replace the article's shipped body.
// Numbering is positional, so reordering clauses in the editor renumbers the
// headings on the page without anyone editing a digit.
function termsSectionsHtml(clauses) {
  return clauses
    .map((c, i) => `<section>\n<h2>${i + 1}. ${escapeHtml(c.heading)}</h2>\n${expandTokens(c.html)}\n</section>`)
    .join('\n\n');
}

// 'YYYY-MM-DD HH:MM:SS' -> 'dd/mm/yyyy', the form the page's date line uses.
function formatTermsDate(updatedAt) {
  const m = String(updatedAt || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

function getTerms() {
  const row = db.prepare('SELECT updated_at, clauses_json FROM terms WHERE id = 1').get();
  if (!row) return null;
  let clauses;
  try {
    clauses = JSON.parse(row.clauses_json);
  } catch {
    return null; // an unparseable row reads as "never saved", never as a crash
  }
  if (!Array.isArray(clauses)) return null;
  return { updatedAt: row.updated_at, clauses };
}

// The rendered HTML's cache key in render-html.js: it changes on every save and
// on nothing else, which is exactly when the terms page needs re-rendering.
function termsVersion() {
  const row = getTerms();
  return row ? row.updatedAt : '';
}

function saveTerms(clauses) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const updatedAt =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  db.prepare(
    `INSERT INTO terms (id, updated_at, clauses_json) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, clauses_json = excluded.clauses_json`
  ).run(updatedAt, JSON.stringify(clauses));
  return { updatedAt, clauses };
}

module.exports = {
  getTerms,
  saveTerms,
  termsVersion,
  expandTokens,
  termsSectionsHtml,
  formatTermsDate,
  CONTACT_HTML,
  CONTACT_TOKEN,
  BRAND_TOKEN,
};

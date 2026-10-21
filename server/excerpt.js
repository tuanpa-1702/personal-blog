// The preview line a card falls back to when a post was published with no
// excerpt of its own.
//
// The list endpoints deliberately carry no `content` - that is the whole block
// JSON of every post, and a card needs none of it - so the client drawing a card
// cannot reach into the body when the excerpt is empty: viewall.html drew an
// empty paragraph under the title, and the profile page drew nothing at all.
// The fallback is therefore computed HERE, server-side, for exactly the rows
// whose excerpt is empty: one extra query for exactly those ids, never for the
// list as a whole, and never for a post that already says what it is.
//
// What a card gets is the first sentences of the first paragraph that has text -
// the opening of the body, cut at a sentence end where one falls inside the
// budget and at a word boundary where none does - so the preview reads as prose
// the author wrote rather than as a buffer dump. Headings, pictures and embeds
// are skipped: a preview that opens with a heading or an image caption describes
// the layout, not the post.
//
// Only the PUBLIC read routes attach it (the posts list, a user's published
// posts, the homepage lead in render-html.js). The admin lists keep showing the
// excerpt exactly as stored, because an admin reading a table of their own posts
// needs to see which ones have none.

const db = require('./db');

// The "Bố cục ảnh" kinds that show their text (server/routes/posts.js LAYOUT_TEXT).
const LAYOUT_TEXT_KINDS = new Set(['side', 'side-right', 'split', 'split-reverse']);

// The ceiling is a line-clamp-3 card and a little more; the target is where a
// sentence end is worth taking before the ceiling.
const PREVIEW_MAX = 220;
const PREVIEW_TARGET = 140;

const ENTITIES = {
  '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ', '&amp;': '&',
};

function decodeEntities(text) {
  return String(text).replace(/&(lt|gt|quot|#39|nbsp|amp);/g, (m) => ENTITIES[m]);
}

// Tag-stripping for text that is ALREADY sanitised on the way in: <br> and block
// closes become a space so two lines do not glue together, everything else
// disappears without one, so <strong>word</strong> stays one word.
function plainText(html) {
  return decodeEntities(
    String(html)
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/(p|div|li|h[1-6])>/gi, ' ')
      .replace(/<[^>]*>/g, '')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function cutAtWord(text) {
  const cut = text.slice(0, PREVIEW_MAX);
  const at = cut.lastIndexOf(' ');
  return `${(at > 60 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

// Whole sentences while they fit, an ellipsis where the cut lands mid-thought.
// A text inside the ceiling is returned as it is: adding "…" to a paragraph that
// ended before the budget would claim a truncation the card never makes.
// The cut is a SLICE of the original rather than a re-join of the sentences the
// regex found: re-joining with a space of its own would put one inside an IP
// address or a version number, where the author deliberately put none.
function firstSentences(text) {
  if (text.length <= PREVIEW_MAX) return text;
  const re = /[^.!?…]+[.!?…]+/g;
  let end = 0;
  let m;
  while ((m = re.exec(text))) {
    const len = m[0].trim().length;
    if (!end) {
      // One sentence longer than the whole budget: a word-boundary cut is the
      // best prose available.
      if (len > PREVIEW_MAX) return cutAtWord(text);
      end = m.index + m[0].length;
      continue;
    }
    if (end >= PREVIEW_TARGET || end + len > PREVIEW_MAX) {
      return `${text.slice(0, end).trimEnd()}…`;
    }
    end = m.index + m[0].length;
  }
  if (!end) return cutAtWord(text); // no sentence end at all inside the budget
  return end < text.length ? `${text.slice(0, end).trimEnd()}…` : text;
}

// The first paragraph block that carries text, as preview prose. Legacy posts
// keep their paragraph text in `text` rather than `html`; both are read.
function bodyPreview(contentJson) {
  let blocks;
  try {
    blocks = JSON.parse(contentJson);
  } catch {
    return '';
  }
  if (!Array.isArray(blocks)) return '';
  for (const b of blocks) {
    // A "Bố cục ảnh" block beside prose (img-side/split) carries paragraph html too.
    // Only the kinds that show it: a picture-only layout may still hold text kept
    // from an earlier kind (server/routes/posts.js sanitizeLayoutBlock()).
    if (!b || (b.type !== 'paragraph' && !(b.type === 'layout' && b.html && LAYOUT_TEXT_KINDS.has(b.layout)))) continue;
    const text = plainText(b.html !== undefined ? b.html : b.text);
    if (text) return firstSentences(text);
  }
  return '';
}

// Fills `excerpt` on the rows that have none, in place, and returns them. Every
// other column stays as the route selected it; a post whose body is only
// pictures keeps the empty excerpt it had, and its card draws what it drew
// before. A database that refuses the extra query leaves the list exactly as
// the route built it - a missing preview is not a reason to fail a list.
//
// Every row's OWN excerpt is flattened to plain text here too, not only the
// ones with none: a card's line-clamp-3 only truncates reliably across plain
// inline text, and an excerpt built by pasting into the excerpt field's own
// rich-text toolbar (write.html) can carry nested block markup of its own -
// a paste from Word/Docs brings whole <h2>/<p>/<div> wrappers, not just
// bold/italic/link runs - which -webkit-line-clamp does not truncate across.
// A card built from one of those ran for as many lines as the paste had
// paragraphs instead of the 3 every other card kept to. Length is NOT
// re-bounded here the way the generated fallback below is (PREVIEW_MAX): an
// author's own excerpt, however long, is still one paragraph of plain text
// once flattened, which line-clamp truncates the way it already does for
// every other card - only a preview reaching into the article body needs a
// budget of its own, because that one has a whole post to draw from rather
// than the one line the author wrote for exactly this purpose.
function attachExcerptFallback(rows) {
  if (!Array.isArray(rows)) return rows;
  for (const row of rows) {
    if (row && row.excerpt) row.excerpt = plainText(row.excerpt);
  }
  const missing = rows.filter((r) => r && Number.isFinite(r.id) && !r.excerpt);
  if (!missing.length) return rows;
  let contentRows;
  try {
    const marks = missing.map(() => '?').join(', ');
    contentRows = db
      .prepare(`SELECT id, content FROM posts WHERE id IN (${marks})`)
      .all(...missing.map((r) => r.id));
  } catch {
    return rows;
  }
  const contentById = new Map(contentRows.map((r) => [r.id, r.content]));
  for (const row of missing) {
    const preview = bodyPreview(contentById.get(row.id));
    if (preview) row.excerpt = preview;
  }
  return rows;
}

module.exports = { bodyPreview, firstSentences, plainText, attachExcerptFallback };

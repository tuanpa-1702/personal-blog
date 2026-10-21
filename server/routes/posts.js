const express = require('express');
const slugify = require('slugify');
const db = require('../db');
const { getSiteName } = require('../site');
const { requireAuth, optionalAuth, requireAdmin, requireWriter } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');
const { sendNewPostNotifications } = require('../mailer');
// Deletion is a move to the recycle bin now; the irreversible delete and its
// activity-log entry live in trash-store.purgePost(), reached from the bin.
const trashStore = require('../trash-store');
// Moderation: the admin notification inbox plus its fire-and-forget mail, and the
// hide/unhide store that is the recycle bin's lighter sibling.
const notifications = require('../notifications');
const commentHidden = require('../comment-hidden');
// A card whose post has no excerpt shows the opening of the body instead; see
// the module for why that is computed here and not in the browser.
const { attachExcerptFallback } = require('../excerpt');

const router = express.Router();

// The two public read paths are the only endpoints an anonymous visitor can hit
// in a loop, and both do real work per call: the list runs a LIKE over every
// post's full content blob when `q` is present, and the single-post route writes
// a view count. The ceilings are far above any human reading pace (a page turn
// is one list call; an article is one read call) and far below a scraper.
const listLimit = rateLimit({ name: 'posts-list', windowMs: 60_000, max: 60 });
const readLimit = rateLimit({ name: 'posts-read', windowMs: 60_000, max: 120 });
// A comment and a report are no longer write-only-to-database: each one can put
// an email in the site owner's inbox (see notifyNewComment / notifyCommentReported),
// so an account that can read is otherwise a mail pump. Keyed on the account
// rather than the IP - both routes sit behind requireAuth, so req.user is always
// there, and one person on several addresses is still one person. Being keyed on
// req.user is also why these two MUST be mounted after requireAuth.
const commentLimit = rateLimit({
  name: 'comment-create',
  windowMs: 60_000,
  max: 10,
  keyFn: (req) => `u${req.user?.id || 'anon'}`,
});
const reportLimit = rateLimit({
  name: 'comment-report',
  windowMs: 60_000,
  max: 10,
  keyFn: (req) => `u${req.user?.id || 'anon'}`,
});

// ---- View counting ----
//
// A view used to be one UPDATE per GET: a crawler or a reader hammering reload
// turned a read endpoint into a write endpoint, each hit a WAL append and a
// dirty page. Counts are now accumulated in memory and flushed as one
// transaction, at most every 30s or every 200 distinct posts, whichever comes
// first. A restart loses at most that window's counts - a view total is a
// courtesy to the author, not an invoice.
const pendingViews = new Map(); // post id -> views since last flush
let flushTimer = null;

function flushViews() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!pendingViews.size) return;
  const entries = [...pendingViews.entries()];
  pendingViews.clear();
  const stmt = db.prepare('UPDATE posts SET views = views + ? WHERE id = ?');
  try {
    db.transaction((rows) => {
      for (const [id, n] of rows) stmt.run(n, id);
    })(entries);
  } catch (e) {
    console.error('[posts] Không cộng được lượt xem:', e.message);
  }
}

function noteView(postId) {
  pendingViews.set(postId, (pendingViews.get(postId) || 0) + 1);
  if (pendingViews.size >= 200) return flushViews();
  if (!flushTimer) flushTimer = setTimeout(flushViews, 30_000).unref();
}

// A clean shutdown banks what is pending; a crash loses at most 30s of counts.
process.on('exit', flushViews);

function makeUniqueSlug(title) {
  let base = slugify(title, { lower: true, strict: true, locale: 'vi' }) || 'bai-viet';
  let slug = base;
  let i = 1;
  while (db.prepare('SELECT id FROM posts WHERE slug = ?').get(slug)) {
    i += 1;
    slug = `${base}-${i}`;
  }
  return slug;
}

function withAuthor(post, authorRow) {
  // A caller that already joined the author (the list route) passes it in;
  // anything else pays one lookup by id.
  const author =
    authorRow !== undefined ? authorRow : db.prepare('SELECT id, name, avatar_url FROM users WHERE id = ?').get(post.author_id);
  let hashtags = [];
  try {
    hashtags = JSON.parse(post.hashtags || '[]');
  } catch {
    hashtags = [];
  }
  return { ...post, hashtags, author };
}

// Normalizes a hashtags input (array of strings from the client) into a
// clean JSON string for storage: trims whitespace, strips a leading '#' if
// the user typed one, drops empties/duplicates, caps at 10 tags.
function normalizeHashtags(input) {
  if (!Array.isArray(input)) return '[]';
  const seen = new Set();
  const clean = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const tag = raw.trim().replace(/^#/, '');
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    // A hashtag reaches the DOM through escapeHtml() and through
    // encodeURIComponent() in the tag link, so markup here is already inert.
    // Stripped anyway: a tag is a word, and the chip row on post.html builds an
    // element per tag - one less place a future renderer can be the bug.
    clean.push(stripTags(tag).slice(0, 50));
    if (clean.length >= 10) break;
  }
  return JSON.stringify(clean);
}

// Rich-text paragraph blocks store HTML straight from a contenteditable editor.
//
// This is NOT defence in depth - it is the control that stops an `editor` account
// from taking an admin's session. The token lives in localStorage and there is no
// CSP yet, so script running inside a rendered post reads it. The previous version
// here was four regexes and let `<img/onerror=alert(1) src=x>` through untouched,
// among others; see the header of server/sanitize-html.js.
const { sanitizeRichHtml } = require('../sanitize-html');
// The embed resolver's own allowlist, reused here so a stored iframe src is checked
// against exactly the set of URLs the resolver can produce.
const { resolveEmbed, isAllowedEmbedSrc } = require('../embeds');

// Plain-text fields. These are rendered with escapeHtml() on the client
// (renderContentBlocksHtml in public/js/api.js), so markup in them is already
// inert - but a heading or caption is never meant to contain any, and storing it
// stripped means a future renderer that forgets to escape cannot be the bug.
function stripTags(value) {
  return sanitizeRichHtml(value).replace(/<[^>]*>/g, '');
}

function sanitizeContent(contentJson) {
  try {
    const blocks = JSON.parse(contentJson);
    if (!Array.isArray(blocks)) return contentJson;
    const cleaned = blocks.map((b) => {
      if (!b || typeof b !== 'object') return b;
      if (b.type === 'paragraph' && b.html !== undefined) {
        return { ...b, html: sanitizeRichHtml(b.html) };
      }
      // A heading's text, an image's caption, and the url an <img src> is built
      // from all reach the DOM through the same renderer; the url especially, since
      // `escapeHtml` cannot make `javascript:` safe inside a src attribute.
      if (b.type === 'heading') return { ...b, text: stripTags(b.text) };
      if (b.type === 'image') {
        return { ...b, url: safeImageUrl(b.url), caption: stripTags(b.caption) };
      }
      if (b.type === 'layout') return sanitizeLayoutBlock(b);
      // An embed block holds an iframe src, which is a page loaded into ours - so the
      // stored value is re-checked here rather than trusted from the client. The
      // resolver in server/embeds.js is what produced it; a value that is not one of
      // its possible outputs is dropped entirely, which renders as nothing.
      if (b.type === 'embed') {
        return {
          ...b,
          src: isAllowedEmbedSrc(b.src) ? String(b.src) : '',
          provider: /^[a-z]{1,20}$/.test(String(b.provider || '')) ? b.provider : '',
          caption: stripTags(b.caption),
          // Presentation only, and both are written into a style attribute, so they
          // are constrained to the shapes the renderer emits.
          ratio: /^[0-9]{1,3} \/ [0-9]{1,3}$/.test(String(b.ratio || '')) ? b.ratio : '',
          height: Number.isInteger(Number(b.height)) && Number(b.height) > 0 && Number(b.height) <= 1200
            ? Number(b.height)
            : null,
        };
      }
      return b;
    });
    return JSON.stringify(cleaned);
  } catch {
    return contentJson; // not JSON (legacy plain-text content) - nothing to sanitize
  }
}

// "Bố cục ảnh" (public/js/api.js IMAGE_LAYOUTS is the definition this mirrors).
// The layout id is whitelisted - it becomes a class name - and every picture is
// reduced to the four fields the renderer reads. width/height are looked up
// HERE from the media library rather than trusted from the client, so a
// picture uploaded to this site always carries its real size (no layout shift
// on load); an external URL simply has none.
const LAYOUT_IDS = new Set(['side', 'side-right', 'wide', 'split', 'split-reverse', 'feature', 'pair', 'masonry', 'strip']);
const LAYOUT_TEXT = new Set(['side', 'side-right', 'split', 'split-reverse']);
const LAYOUT_MAX_IMAGES = 12;
const mediaDimsStmt = db.prepare('SELECT width, height FROM media WHERE filename = ?');

function mediaDims(url) {
  const m = /^\/uploads\/([^/?#]+)$/.exec(url);
  if (!m) return null;
  try {
    const row = mediaDimsStmt.get(m[1]);
    return row && row.width > 0 && row.height > 0 ? { width: row.width, height: row.height } : null;
  } catch {
    return null;
  }
}

function sanitizeLayoutBlock(b) {
  const layout = LAYOUT_IDS.has(b.layout) ? b.layout : 'wide';
  const images = (Array.isArray(b.images) ? b.images : [])
    .slice(0, LAYOUT_MAX_IMAGES)
    .map((im) => {
      const url = safeImageUrl(im && im.url);
      if (!url) return null;
      return { url, alt: stripTags(im.alt).slice(0, 300), ...(mediaDims(url) || {}) };
    })
    .filter(Boolean);
  return {
    type: 'layout',
    layout,
    images,
    caption: stripTags(b.caption),
    // The text is kept even for a kind that does not show it: switching a block
    // to a picture-only kind and back must not lose what the author wrote.
    // The renderers show it only for LAYOUT_TEXT kinds.
    ...(LAYOUT_TEXT.has(layout) || b.html ? { html: sanitizeRichHtml(String(b.html || '')) } : {}),
  };
}

// An image url is written into `src`, where escaping does nothing about the scheme.
// Only the two shapes this app produces are accepted: an /uploads/ path from
// POST /api/upload, or an http(s) URL for an externally hosted image.
function safeImageUrl(value) {
  const url = String(value ?? '').trim();
  if (!url) return '';
  if (/^\//.test(url) && !url.startsWith('//')) return url;
  return /^https?:\/\//i.test(url) ? url : '';
}

// ---- Like / dislike ----
//
// Both reaction tables have the same shape - (target_id, user_id) primary key
// plus a value of 1 or -1 - so posts and comments share these two helpers.
// `table`/`column` are literals from the call sites below, never request data.

// Totals for one target, plus what the caller themselves voted (0 = nothing).
function reactionSummary(table, column, targetId, userId) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(value = 1), 0) AS likes, COALESCE(SUM(value = -1), 0) AS dislikes
         FROM ${table} WHERE ${column} = ?`
    )
    .get(targetId);
  const mine = userId
    ? db.prepare(`SELECT value FROM ${table} WHERE ${column} = ? AND user_id = ?`).get(targetId, userId)
    : null;
  return { likes: row.likes, dislikes: row.dislikes, my_reaction: mine ? mine.value : 0 };
}

// Writes one vote. Pressing the button that is already active clears it, so the
// same endpoint both sets and un-sets; switching sides overwrites the row rather
// than adding a second one, which is what keeps the totals honest.
const writeReaction = db.transaction((table, column, targetId, userId, value) => {
  const existing = db
    .prepare(`SELECT value FROM ${table} WHERE ${column} = ? AND user_id = ?`)
    .get(targetId, userId);
  if (value === 0 || (existing && existing.value === value)) {
    db.prepare(`DELETE FROM ${table} WHERE ${column} = ? AND user_id = ?`).run(targetId, userId);
  } else if (existing) {
    db.prepare(
      `UPDATE ${table} SET value = ?, created_at = datetime('now') WHERE ${column} = ? AND user_id = ?`
    ).run(value, targetId, userId);
  } else {
    db.prepare(`INSERT INTO ${table} (${column}, user_id, value) VALUES (?, ?, ?)`).run(
      targetId,
      userId,
      value
    );
  }
});

// Accepts 1 (like), -1 (dislike) or 0 (clear). Anything else is a bad request:
// the CHECK constraint would reject it anyway, but as a 500 instead of a 400.
function parseReactionValue(raw) {
  const value = Number(raw);
  return [1, -1, 0].includes(value) ? value : null;
}

// GET /api/posts?tag=&q=&status=&page=&limit=&mine=&sort=
router.get('/', listLimit, optionalAuth, (req, res) => {
  const { tag, q, status, page = 1, limit = 12, mine, sort } = req.query;
  const clauses = [];
  const params = {};

  // The bin is not a status: a trashed post is invisible here even to its own
  // author's "bài của tôi" view, and stays reserved by its slug so a restore
  // cannot collide.
  //
  // Qualified as `p.` even though the COUNT below is over a bare `posts`, because
  // the SELECT joins `users` - and users carries a deleted_at of its own now, so
  // an unqualified one is an ambiguous-column error rather than a filter. The
  // COUNT therefore aliases its table too, so one WHERE serves both.
  clauses.push('p.deleted_at IS NULL');

  if (mine === 'true' && req.user) {
    clauses.push('author_id = @author_id');
    params.author_id = req.user.id;
    if (status) {
      clauses.push('status = @status');
      params.status = status;
    }
  } else {
    clauses.push("status = 'published'");
  }

  if (tag) {
    // Match either the legacy single "tag" field OR any hashtag in the
    // hashtags array (stored as a JSON string, so a LIKE on the quoted
    // value is a reliable "array contains" check without a join table).
    // Both, deliberately: the chip row offers `tag` values only (GET /tags
    // below), but a `#hashtag` on a card and the chips on post.html arrive
    // through this same parameter and have to keep finding their posts.
    clauses.push('(tag = @tag OR hashtags LIKE @tagLike)');
    params.tag = tag;
    params.tagLike = `%"${tag}"%`;
  }
  if (q) {
    // Hashtags are included so the search box on viewall.html can find a post
    // by a tag the reader saw on its card. They live in a JSON string, so a
    // plain LIKE is enough - no join table to search.
    clauses.push('(title LIKE @q OR excerpt LIKE @q OR content LIKE @q OR tag LIKE @q OR hashtags LIKE @q)');
    params.q = `%${q}%`;
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const limitNum = Math.min(Math.max(parseInt(limit, 10) || 12, 1), 50);
  const offset = (pageNum - 1) * limitNum;
  // Whitelisted, never interpolated raw: `sort` reaches this string as-is from
  // the query, and ORDER BY cannot be parameterised with `?`/`@name` the way a
  // value can - so the only safe way to let the caller choose is to pick the
  // whole clause from a fixed set rather than build it out of their input.
  // `views DESC` is what the homepage's "Đọc nhiều nhất" rail asks for; every
  // other caller (viewall.html, the default) keeps the original newest-first.
  const orderBy = sort === 'views' ? 'p.views DESC, p.id DESC' : 'p.created_at DESC, p.id DESC';

  const total = db.prepare(`SELECT COUNT(*) AS c FROM posts p ${where}`).get(params).c;
  // The list never carries `content`: that is the whole block JSON of every post
  // (hundreds of KB once an article has a dozen screenshots), and a card needs
  // none of it - the homepage and viewall were downloading full articles to read
  // their titles. The single-post route below still returns everything.
  // The author comes from one LEFT JOIN instead of one query per row.
  const rows = db
    .prepare(
      `SELECT p.id, p.title, p.slug, p.excerpt, p.cover_image, p.tag, p.hashtags,
              p.status, p.views, p.author_id, p.created_at, p.updated_at,
              u.id AS a_id, u.name AS a_name, u.avatar_url AS a_avatar
       FROM posts p LEFT JOIN users u ON u.id = p.author_id
       ${where} ORDER BY ${orderBy} LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit: limitNum, offset });
  attachExcerptFallback(rows);

  res.json({
    posts: rows.map((r) => {
      const { a_id, a_name, a_avatar, ...post } = r;
      return withAuthor(post, a_id ? { id: a_id, name: a_name, avatar_url: a_avatar } : null);
    }),
    total,
    page: pageNum,
    limit: limitNum,
  });
});

// POST /api/posts/embed { url }
//
// Resolves a pasted URL to an embeddable frame, for the editor's embed block. A
// writer-only endpoint, and one that touches nothing: it parses a string and answers.
// It is on the server rather than in the browser for one reason - the resolver is the
// same code that re-checks a stored src on save, so the editor and the sanitiser can
// never disagree about what a valid embed is.
//
// It deliberately does NOT fetch the URL. Following a short link server-side on a
// caller's behalf is an SSRF primitive; the cost of not doing it is that an author
// pastes the canonical link instead of a vm.tiktok.com one.
router.post('/embed', requireAuth, requireWriter, (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string' || url.length > 2000) {
    return res.status(400).json({ error: 'Vui lòng dán một đường dẫn hợp lệ.' });
  }
  const result = resolveEmbed(url);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ embed: result.embed });
});

// GET /api/posts/tags
//
// Every "Thẻ (tag)" with at least one published post, plus how many - drives the
// chip row on viewall.html. Must stay ABOVE the '/:slug' route below, which
// would otherwise match "tags" as a post slug.
//
// The `tag` column ONLY. This used to be the union of `tag` and the per-post
// `hashtags` JSON array, which mixed hashtag names into the chip row beside the
// tags; the chips are the post's Thẻ and nothing else. Hashtags stay filterable
// where a reader can actually see one - the `#name` on a card, the chips on
// post.html, the search box - because the '?tag=' filter above still matches
// either column, and because `q` searches hashtags too.
// Ordered by post count, then alphabetically.
router.get('/tags', (req, res) => {
  const rows = db.prepare("SELECT tag FROM posts WHERE status = 'published' AND deleted_at IS NULL").all();

  // One post carries one tag, so there is no per-row dedupe to do - just fold
  // case variants together and keep the first spelling seen for display.
  const counts = new Map(); // lowercased key -> { tag (first spelling seen), count }
  for (const row of rows) {
    const tag = String(row.tag ?? '').trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    const hit = counts.get(key);
    if (hit) hit.count += 1;
    else counts.set(key, { tag, count: 1 });
  }

  const tags = [...counts.values()].sort(
    (a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'vi')
  );
  res.json({ tags });
});

// GET /api/posts/:slug
router.get('/:slug', readLimit, optionalAuth, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get(req.params.slug);
  // A trashed post reads as absent to everyone, owner and admin included: the
  // bin is the only place it is visible, and the editor reaches it there.
  if (!post || post.deleted_at) return res.status(404).json({ error: 'Không tìm thấy bài viết.' });

  const isOwnerOrAdmin = req.user && (req.user.id === post.author_id || req.user.role === 'admin');
  if (post.status !== 'published' && !isOwnerOrAdmin) {
    return res.status(404).json({ error: 'Không tìm thấy bài viết.' });
  }

  // A view is a READER opening the article. The author re-reading their own
  // post, an admin moderating it, and the editor re-fetching the body to load
  // it for editing are management traffic, not audience - and the editor's
  // fetch arrives on every edit session, so counting it would inflate a post by
  // one view per save. The check is server-side (the token, not a query flag),
  // so a reader cannot opt themselves out.
  if (post.status === 'published' && !isOwnerOrAdmin) {
    noteView(post.id);
    post.views += 1;
  }

  // Prev/next navigation + position among all published posts, newest first
  // (matches homepage order). "navigation" is only meaningful for published
  // posts; drafts/preview views omit it.
  let navigation = null;
  if (post.status === 'published') {
    const ids = db
      .prepare(
        "SELECT id, slug, title FROM posts WHERE status = 'published' AND deleted_at IS NULL ORDER BY created_at DESC, id DESC"
      )
      .all();
    const idx = ids.findIndex((p) => p.id === post.id);
    navigation = {
      position: idx + 1,
      total: ids.length,
      prev: idx >= 0 && idx < ids.length - 1 ? ids[idx + 1] : null, // older post
      next: idx > 0 ? ids[idx - 1] : null, // newer post
    };
  }

  const reactions = reactionSummary('post_reactions', 'post_id', post.id, req.user?.id);
  res.json({ post: withAuthor(post), navigation, reactions });
});

// POST /api/posts  (only 'editor' and 'admin' roles can write; 'readonly' cannot)
router.post('/', requireAuth, requireWriter, (req, res) => {
  const { title, excerpt, content, cover_image, tag, status, hashtags } = req.body || {};
  const finalStatus = status === 'draft' ? 'draft' : 'published';
  // A draft is what autosave writes before the author has settled on a title -
  // that's the whole reason it exists, to catch a post being lost to a closed
  // tab before it has one - so only a published post is required to have one.
  if (!content || (finalStatus === 'published' && !title)) {
    return res.status(400).json({
      error: finalStatus === 'draft' ? 'Vui lòng nhập nội dung bài viết.' : 'Vui lòng nhập tiêu đề và nội dung bài viết.',
    });
  }
  const slug = makeUniqueSlug(title || '');
  const info = db
    .prepare(
      `INSERT INTO posts (title, slug, excerpt, content, cover_image, tag, hashtags, status, author_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      stripTags(title),
      slug,
      sanitizeRichHtml(excerpt || ''),
      sanitizeContent(content),
      safeImageUrl(cover_image),
      stripTags(tag || 'Chung'),
      normalizeHashtags(hashtags),
      finalStatus,
      req.user.id
    );
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ post: withAuthor(post) });

  // Notify opted-in readers in the background - never blocks or fails the
  // response above, since this is best-effort and the author shouldn't wait
  // on (or be blocked by) email delivery.
  if (finalStatus === 'published') {
    // id as well as email: the mailer signs a per-reader one-click unsubscribe
    // token into each notification, and that needs to know who the reader is.
    const recipients = db
      .prepare('SELECT id, email FROM users WHERE email_notifications = 1 AND deleted_at IS NULL AND id != ?')
      .all(req.user.id);
    if (recipients.length) {
      sendNewPostNotifications(recipients, post, getSiteName()).catch((e) =>
        console.error('Lỗi gửi thông báo bài viết mới:', e.message)
      );
    }
  }
});

// PUT /api/posts/:id  (owner or admin)
router.put('/:id', requireAuth, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  // A trashed post is edited from nowhere: restore it first. Editing it in place
  // would let a save resurrect content the bin is holding.
  if (!post || post.deleted_at) return res.status(404).json({ error: 'Không tìm thấy bài viết.' });
  if (post.author_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Bạn không có quyền sửa bài viết này.' });
  }
  const { title, excerpt, content, cover_image, tag, status, hashtags, author_id } = req.body || {};
  const newSlug = title && title !== post.title ? makeUniqueSlug(title) : post.slug;

  // Reassigning the author is an admin-only capability, distinct from the
  // owner-or-admin check above that gates this whole route: an editor saving
  // their own post must never be able to hand it to someone else, so a
  // non-admin's author_id is silently ignored rather than accepted.
  let newAuthorId = post.author_id;
  if (author_id !== undefined && req.user.role === 'admin') {
    const targetId = Number(author_id);
    const target = db.prepare('SELECT id FROM users WHERE id = ? AND deleted_at IS NULL').get(targetId);
    if (!target) return res.status(400).json({ error: 'Không tìm thấy người dùng để gán làm tác giả.' });
    newAuthorId = targetId;
  }

  db.prepare(
    `UPDATE posts SET title=?, slug=?, excerpt=?, content=?, cover_image=?, tag=?, hashtags=?, status=?, author_id=?, updated_at=datetime('now')
     WHERE id = ?`
  ).run(
    title !== undefined ? stripTags(title) : post.title,
    newSlug,
    excerpt !== undefined ? sanitizeRichHtml(excerpt) : post.excerpt,
    content !== undefined ? sanitizeContent(content) : post.content,
    cover_image !== undefined ? safeImageUrl(cover_image) : post.cover_image,
    tag !== undefined ? stripTags(tag) : post.tag,
    hashtags !== undefined ? normalizeHashtags(hashtags) : post.hashtags,
    status === 'draft' || status === 'published' ? status : post.status,
    newAuthorId,
    post.id
  );
  const updated = db.prepare('SELECT * FROM posts WHERE id = ?').get(post.id);
  res.json({ post: withAuthor(updated) });
});

// DELETE /api/posts/:id (owner or admin)
//
// Moves the post into the recycle bin instead of deleting it: the post and every
// live comment under it take one shared deleted_at, and Admin > Thùng rác can put
// the whole group back. Nothing is removed here - the irreversible delete,
// cascade and activity-log entry included, is trash-store.purgePost(), reached
// from the bin's "xoá vĩnh viễn". trash-store.trash() records who did this in
// audit_log (security.md item 20).
router.delete('/:id', requireAuth, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post || post.deleted_at) return res.status(404).json({ error: 'Không tìm thấy bài viết.' });
  if (post.author_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Bạn không có quyền xoá bài viết này.' });
  }
  const result = trashStore.trash('posts', post.id, req.user);
  if (result.error) return res.status(409).json({ error: result.error });
  res.json({ ok: true, trashed: true });
});

// POST /api/posts/:id/reactions  { value: 1 | -1 | 0 }
//
// Login required: an anonymous vote could not be toggled off again, and would be
// countable any number of times from the same browser.
router.post('/:id/reactions', requireAuth, (req, res) => {
  const value = parseReactionValue((req.body || {}).value);
  if (value === null) return res.status(400).json({ error: 'value phải là 1, -1 hoặc 0.' });

  const post = db.prepare('SELECT id, status, author_id, deleted_at FROM posts WHERE id = ?').get(req.params.id);
  if (!post || post.deleted_at) return res.status(404).json({ error: 'Không tìm thấy bài viết.' });
  // A draft is only visible to its author and to admins, so nobody else may
  // react to it either.
  if (post.status !== 'published' && post.author_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(404).json({ error: 'Không tìm thấy bài viết.' });
  }

  writeReaction('post_reactions', 'post_id', post.id, req.user.id, value);
  res.json({ reactions: reactionSummary('post_reactions', 'post_id', post.id, req.user.id) });
});

// ---- Comments ----

// Every comment is read through this one projection so the list, the create
// response and a vote response all return the same fields. The three reaction
// columns are correlated subqueries rather than a GROUP BY join: a comment with
// no votes still has to come back (as 0/0), and the caller's own vote has to be
// per-row. @user_id is null for a guest, which makes my_reaction 0.
const COMMENT_SELECT = `
  SELECT c.*, u.name AS user_name, u.avatar_url AS user_avatar,
         (SELECT COUNT(*) FROM comment_reactions r WHERE r.comment_id = c.id AND r.value = 1) AS likes,
         (SELECT COUNT(*) FROM comment_reactions r WHERE r.comment_id = c.id AND r.value = -1) AS dislikes,
         COALESCE(
           (SELECT r.value FROM comment_reactions r WHERE r.comment_id = c.id AND r.user_id = @user_id),
           0
         ) AS my_reaction,
         (SELECT rp.reason FROM comment_reports rp
           WHERE rp.comment_id = c.id AND rp.user_id = @user_id) AS my_report_reason
    FROM comments c JOIN users u ON u.id = c.user_id`;

function getComment(commentId, userId) {
  return db.prepare(`${COMMENT_SELECT} WHERE c.id = @id`).get({ id: commentId, user_id: userId ?? null });
}

// GET /api/posts/:id/comments
// optionalAuth so a signed-in reader gets their own my_reaction on each row and
// the buttons render in the right state on first paint.
//
// Hidden comments: a reader receives NO row at all - filtered in SQL rather than
// in the client, because a row that was sent is a row readable in devtools. Two
// exceptions, both deliberate: the comment's own author (they see a notice where
// their comment was, instead of wondering whether it vanished) and admins (they
// have to be able to unhide). @user_id is null for a guest and `c.user_id = NULL`
// is NULL rather than true, so that branch switches itself off.
//
// The report REASONS ride along in the same response so the client never
// hardcodes the list and the two cannot drift apart.
router.get('/:id/comments', optionalAuth, (req, res) => {
  // A draft is only visible to its author and to admins (GET /:slug above), so
  // its comments cannot be either - without this, a post that 404s for anyone
  // else on the detail page still handed out its commenters' names/avatars/text
  // to an unauthenticated GET by numeric id.
  const post = db.prepare('SELECT id, status, author_id, deleted_at FROM posts WHERE id = ?').get(req.params.id);
  if (!post || post.deleted_at) return res.status(404).json({ error: 'Không tìm thấy bài viết.' });
  if (post.status !== 'published' && post.author_id !== req.user?.id && req.user?.role !== 'admin') {
    return res.status(404).json({ error: 'Không tìm thấy bài viết.' });
  }

  const isAdmin = req.user?.role === 'admin';
  const rows = db
    .prepare(
      `${COMMENT_SELECT}
        WHERE c.post_id = @post_id AND c.deleted_at IS NULL
          AND (c.hidden_at IS NULL OR c.user_id = @user_id OR @is_admin = 1)
        ORDER BY c.created_at ASC`
    )
    .all({ post_id: req.params.id, user_id: req.user?.id ?? null, is_admin: isAdmin ? 1 : 0 });

  // The per-comment report TOTAL is admin-only: telling every reader how many
  // people flagged a comment they can still see would be a voting booth. Fetched
  // with one extra statement over the ids just returned, rather than as another
  // correlated column in COMMENT_SELECT that every viewer would pay for.
  let byCount = new Map();
  if (isAdmin && rows.length) {
    const counts = db
      .prepare(
        `SELECT comment_id, COUNT(*) AS c FROM comment_reports
          WHERE comment_id IN (${rows.map(() => '?').join(', ')}) GROUP BY comment_id`
      )
      .all(rows.map((r) => r.id));
    byCount = new Map(counts.map((r) => [r.comment_id, r.c]));
  }

  res.json({
    comments: rows.map((r) => (isAdmin ? { ...r, report_count: byCount.get(r.id) || 0 } : r)),
    report_reasons: REPORT_REASONS,
  });
});

// POST /api/posts/:id/comments (auth) - optionally reply to another comment via parent_comment_id
//
// A comment is the only content a 'readonly' account can write, so it is the one
// place where untrusted text reaches a page every reader loads. It is stored as
// PLAIN TEXT and rendered with escapeHtml() in public/js/post.js, so markup in it
// is inert - the length cap below is about the other risk: nothing here limited
// size, so a single request could store a multi-megabyte comment that every reader
// of that post then downloads.
const MAX_COMMENT_CHARS = 5000;

// The report reasons a reader can choose. Lives HERE rather than in the
// notifications table because this is the file that validates a report, and the
// list rides out to the client inside GET /:id/comments (above) so the form and
// the whitelist are one thing, not two that drift. The labels are what gets
// stored in comment_reports.reason - a snapshot, readable after a rewording.
const REPORT_REASONS = [
  'Spam hoặc quảng cáo',
  'Xúc phạm, quấy rối',
  'Nội dung khiêu dâm hoặc phản cảm',
  'Bạo lực hoặc hành vi nguy hiểm',
  'Thông tin sai lệch, lừa đảo',
  'Xâm phạm quyền riêng tư',
  'Lý do khác',
];
const MAX_REPORT_NOTE_CHARS = 1000;

router.post('/:id/comments', requireAuth, commentLimit, (req, res) => {
  const { content, parent_comment_id } = req.body || {};
  if (!content || typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'Nội dung bình luận không được để trống.' });
  }
  const text = content.trim();
  if (text.length > MAX_COMMENT_CHARS) {
    return res
      .status(400)
      .json({ error: `Bình luận quá dài (tối đa ${MAX_COMMENT_CHARS} ký tự).` });
  }
  // title and slug are read now because the notification below snapshots them: a
  // comment's row must still name its post after the post is renamed or gone.
  const post = db.prepare('SELECT id, title, slug, status, author_id, deleted_at FROM posts WHERE id = ?').get(req.params.id);
  if (!post || post.deleted_at) return res.status(404).json({ error: 'Không tìm thấy bài viết.' });
  // Same visibility rule as GET above and as the reaction endpoint: a draft is
  // only visible to its author and to admins, so nobody else may comment on
  // (and thereby confirm the existence of) one either.
  if (post.status !== 'published' && post.author_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(404).json({ error: 'Không tìm thấy bài viết.' });
  }

  let parentId = null;
  if (parent_comment_id) {
    // A hidden comment is not a thread anybody can reply into: the same gate the
    // list applies, minus the admin exception being useless here (an admin
    // replying under a comment they hid would un-hide nobody).
    const parent = db
      .prepare(
        `SELECT id FROM comments
          WHERE id = ? AND post_id = ? AND deleted_at IS NULL
            AND (hidden_at IS NULL OR user_id = ?)`
      )
      .get(parent_comment_id, post.id, req.user.id);
    if (!parent) return res.status(400).json({ error: 'Bình luận muốn trả lời không tồn tại.' });
    parentId = parent.id;
  }

  const info = db
    .prepare('INSERT INTO comments (post_id, user_id, parent_comment_id, content) VALUES (?, ?, ?, ?)')
    .run(post.id, req.user.id, parentId, text);
  // The row is written before the response so a reload of the Thông báo tab right
  // afterwards already shows it; the mail goes after, so the commenter never
  // waits on SMTP. An admin commenting is their own action - no inbox spam for it.
  const event =
    req.user.role === 'admin'
      ? null
      : { kind: 'new_comment', actor: req.user, commentId: Number(info.lastInsertRowid), post, excerpt: text };
  if (event) notifications.record(event);
  res.status(201).json({ comment: getComment(info.lastInsertRowid, req.user.id) });
  if (event) notifications.mailAsync(event);
});

// POST /api/posts/comments/:commentId/reactions  { value: 1 | -1 | 0 }
//
// Not nested under a post id: a comment id is already unique, and the client only
// ever has the comment it is rendering. The path segment "comments" cannot
// collide with the '/:slug' route above because that one is a GET.
router.post('/comments/:commentId/reactions', requireAuth, (req, res) => {
  const value = parseReactionValue((req.body || {}).value);
  if (value === null) return res.status(400).json({ error: 'value phải là 1, -1 hoặc 0.' });

  // A hidden comment takes its vote buttons with it. A reader cannot see the row
  // to click it, but the author can, and a stale page is enough to hold an id -
  // so the gate lives here too, with the same two exceptions as the list.
  const comment = db
    .prepare('SELECT id, user_id, deleted_at, hidden_at FROM comments WHERE id = ?')
    .get(req.params.commentId);
  if (!comment || comment.deleted_at) return res.status(404).json({ error: 'Không tìm thấy bình luận.' });
  if (comment.hidden_at && comment.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(404).json({ error: 'Không tìm thấy bình luận.' });
  }

  writeReaction('comment_reactions', 'comment_id', comment.id, req.user.id, value);
  res.json({ comment: getComment(comment.id, req.user.id) });
});

// POST /api/posts/comments/:commentId/report  { reason, note? }
//
// A signed-in reader's report of a comment, with a reason from REPORT_REASONS and
// an optional free-text note. Toggle, exactly like a reaction (see writeReaction
// above): sending the reason you ALREADY have withdraws the report (the row is
// deleted), sending a different one overwrites it - one person, one report, which
// the PRIMARY KEY (comment_id, user_id) enforces rather than this code promising.
//
// Signed-in only: an anonymous report could not be withdrawn, could not be
// attributed, and could be filed unlimited times from one browser.
router.post('/comments/:commentId/report', requireAuth, reportLimit, (req, res) => {
  const { reason, note } = req.body || {};
  if (!REPORT_REASONS.includes(reason)) {
    return res.status(400).json({ error: `reason phải là một trong: ${REPORT_REASONS.join(' | ')}.` });
  }
  // stripTags() rather than sanitizeRichHtml(): the note is rendered with
  // escapeHtml() in the admin panel so markup in it is already inert, but
  // stripping here means a future renderer that forgets to escape cannot become
  // a hole. Same precedent as post headings and captions.
  const text = stripTags(String(note ?? '')).slice(0, MAX_REPORT_NOTE_CHARS);

  const comment = db
    .prepare('SELECT id, user_id, post_id, deleted_at, hidden_at FROM comments WHERE id = ?')
    .get(req.params.commentId);
  if (!comment || comment.deleted_at) return res.status(404).json({ error: 'Không tìm thấy bình luận.' });
  // Reporting a comment that is already hidden is reporting a thing that has been
  // dealt with; it would only fill the owner's inbox.
  if (comment.hidden_at) {
    return res.status(409).json({ error: 'Bình luận này đã bị ẩn nên không cần báo cáo nữa.' });
  }
  // Reporting your own comment is a button with no meaning.
  if (comment.user_id === req.user.id) {
    return res.status(400).json({ error: 'Bạn không thể báo cáo bình luận của chính mình.' });
  }

  const existing = db
    .prepare('SELECT reason FROM comment_reports WHERE comment_id = ? AND user_id = ?')
    .get(comment.id, req.user.id);

  let report = null;
  if (existing && existing.reason === reason) {
    db.prepare('DELETE FROM comment_reports WHERE comment_id = ? AND user_id = ?').run(comment.id, req.user.id);
  } else {
    db.prepare(
      `INSERT INTO comment_reports (comment_id, user_id, reason, note)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(comment_id, user_id)
       DO UPDATE SET reason = excluded.reason, note = excluded.note, updated_at = datetime('now')`
    ).run(comment.id, req.user.id, reason, text);
    report = { reason, note: text };
  }

  const count = db.prepare('SELECT COUNT(*) AS c FROM comment_reports WHERE comment_id = ?').get(comment.id).c;

  // Only a NEW report (or a changed reason) is an event; withdrawing one is not -
  // and the same person re-reporting the same comment with the same reason must
  // not mail the owner twice. The row is written BEFORE the response, so an admin
  // panel open on the inbox sees it on the reload the reporter's own click
  // triggers; the mail goes after, so the reporter never waits on SMTP.
  let event = null;
  if (report) {
    const post = db.prepare('SELECT id, title, slug FROM posts WHERE id = ?').get(comment.post_id);
    event = { kind: 'comment_reported', actor: req.user, commentId: comment.id, post, reason, excerpt: text };
    notifications.record(event);
  }
  res.json({ report, reported: Boolean(report), report_count: count });
  if (event) notifications.mailAsync(event);
});

// PATCH /api/posts/comments/:commentId/hidden  { hidden: true | false }
//
// Hide, NOT delete. The recycle bin (deleted_at) is a different thing and this
// route never touches it: a hidden comment is still whole in the database, still
// visible to its own author behind a notice, and an admin can unhide it. A trashed
// one is nowhere but the bin.
//
// PATCH plus a boolean, the same shape as PATCH /api/admin/users/:id/status
// (routes/admin.js): flipping a state, not editing content.
//
// The whole reply subtree is hidden under ONE identical hidden_at, so unhiding
// returns exactly that group and never resurrects a comment an admin hid
// separately before - the timestamp-grouping mechanism is trash-store.js's
// (stamp() + commentSubtree()), borrowed whole because it is the same problem.
router.patch('/comments/:commentId/hidden', requireAuth, requireAdmin, (req, res) => {
  const { hidden } = req.body || {};
  if (typeof hidden !== 'boolean') {
    return res.status(400).json({ error: 'hidden phải là true hoặc false.' });
  }
  const comment = db.prepare('SELECT id, deleted_at, hidden_at FROM comments WHERE id = ?').get(req.params.commentId);
  if (!comment || comment.deleted_at) return res.status(404).json({ error: 'Không tìm thấy bình luận.' });

  const result = hidden ? commentHidden.hide(comment.id) : commentHidden.unhide(comment.id);
  if (result.error) return res.status(409).json({ error: result.error });

  const post = db.prepare('SELECT id, title, slug FROM posts WHERE id = ?').get(
    db.prepare('SELECT post_id FROM comments WHERE id = ?').get(comment.id).post_id
  );

  // Audit entry - one kind for both directions, told apart by `action`. Written
  // before the response: the admin panel reloads the inbox the moment this call
  // returns, and the row for the action just taken has to be in it. The mail goes
  // after, exactly like every other write point - an admin does not wait on SMTP.
  const event = {
    kind: 'comment_hidden',
    actor: req.user,
    commentId: comment.id,
    post,
    action: hidden ? 'hide' : 'unhide',
  };
  notifications.record(event);
  res.json({
    ok: true,
    hidden,
    hiddenAt: result.hiddenAt,
    affected: result.affected,
    comment: getComment(comment.id, req.user.id),
  });
  notifications.mailAsync(event);
});

// DELETE /api/posts/comments/:commentId  (admin only - moderation)
//
// Moves the comment AND every reply under it into the recycle bin, all wearing
// one deleted_at so the whole subtree restores together. The irreversible
// version - where the self-referencing ON DELETE CASCADE and both reaction
// tables cascade for real - is trash-store.purgeComment(), from the bin.
router.delete('/comments/:commentId', requireAuth, requireAdmin, (req, res) => {
  const comment = db.prepare('SELECT id, deleted_at FROM comments WHERE id = ?').get(req.params.commentId);
  if (!comment || comment.deleted_at) return res.status(404).json({ error: 'Không tìm thấy bình luận.' });
  const result = trashStore.trash('comments', comment.id, req.user);
  if (result.error) return res.status(409).json({ error: result.error });
  res.json({ ok: true, trashed: result.trashed });
});

module.exports = router;

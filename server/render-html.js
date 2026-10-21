const fs = require('fs');
const path = require('path');
const db = require('./db');
const { siteNamesFrom } = require('./site');
const thumbs = require('./thumbs');
const terms = require('./terms');
const { attachExcerptFallback } = require('./excerpt');
const { stripHtml } = require('./sanitize-html');
const { fillHomeLinks, fillViewallList, fillPostBody } = require('./ssr-content');

// The origin every absolute URL below (canonical, og:url, og:image, JSON-LD)
// is built against. Same env var, same precedence, same production fallback
// as server/sitemap.js's own publicOrigin() (see its comment for why:
// SITE_URL is what server.js's CORS origin and mailer.js's email links also
// agree on, and the admin-editable site_url in email_settings is deliberately
// NOT consulted here for the same reason sitemap.js gives). Kept as its own
// small copy rather than an import from sitemap.js - the two modules have no
// other reason to depend on each other, and the fallback is one line to keep
// in sync if it ever changes.
const DEFAULT_ORIGIN = 'https://blog.tuanpa.tech';
function publicOrigin() {
  return String(process.env.SITE_URL || DEFAULT_ORIGIN).trim().replace(/\/+$/, '');
}

// Cache-busting query string appended to every /js/*.js and /css/*.css
// reference below (cacheBustAssets()) - one value for the whole process,
// computed once here at require() time, i.e. at server boot/every restart.
//
// Why this exists: server.js already answers these files with
// `Cache-Control: no-cache, must-revalidate` - correct for a BROWSER, which
// then re-checks with the origin on every load. Cloudflare's edge sits in
// front of that and, verified directly (curl the public domain and the
// origin side by side), REWRITES it to `max-age=14400` regardless - the
// proxy's own default for these extensions, not something either the origin
// header or the code here can override from this side. A deploy could
// therefore sit on the edge, unpurged, for up to 4 hours: a fixed JS bug
// stays reproducible from a visitor's phone long after `pm2 restart` (the fs
// is not lying), even though the origin itself already has the fix - exactly
// the shape of report that cost real time to track down here as "still
// broken" when it was already fixed at the source.
//
// A version in the URL itself sidesteps that layer entirely rather than
// depending on it to behave: Cloudflare caches by full URL, so
// /js/api.js?v=OLD and /js/api.js?v=NEW are two different cache entries to
// it - no purge required, the same reason the self-hosted fonts (css/
// fetch-fonts.py) are named by content hash instead of relying on a cache
// header alone. Date.now() rather than a content hash: it changes on every
// restart, which is already this project's deploy step (see the many
// `pm2 restart` calls throughout its own history) - simpler than hashing
// fourteen files for a value that is thrown away at the next restart anyway.
const ASSET_VERSION = Date.now();

// Appends ?v=ASSET_VERSION to every same-origin /js/*.js or /css/*.css
// src/href - not /uploads/, /fonts/ (already content-hashed and immutable)
// or an external URL, none of which this is for.
function cacheBustAssets(html) {
  return html.replace(
    /(src|href)="(\/(?:js|css)\/[A-Za-z0-9_-]+\.(?:js|css))"/g,
    (match, attr, url) => `${attr}="${url}?v=${ASSET_VERSION}"`
  );
}

// Server-side substitution of the editable site copy into the static HTML.
//
// The hero copy is admin-editable, so filling it in here means the first paint
// is already correct instead of being rewritten once /api/settings resolves.
// The client-side pass in api.js/home.js is kept as a fallback for HTML served
// from a stale cache.
//
// The site name is admin-editable too: `brand_name` is the logo text and
// `site_title` the browser-tab name, both resolved through siteNamesFrom() in
// server/site.js so the server and public/js/api.js agree on the precedence.
//
// The markup contract (same attribute names the client-side code reads):
//   <title data-page-name="Viết bài">   -> "Viết bài - <site title>"; "" -> "<site title>"
//   <x data-brand-name>                 -> settings.brand_name (server/site.js)
//   <x data-footer-text>                -> settings.footer_text
//   <x data-setting="hero_title">       -> settings.hero_title
//   <a data-setting-mailto="contact_email"> -> href=mailto:settings.contact_email
//   <img data-setting-src="hero_image"> -> src=settings.hero_image
//   <x data-hide-if-empty="hero_image">  -> gains class "hidden" when that value is empty
// A key present in the settings table always wins, even when its value is ''
// (the admin cleared that field on purpose). data-fallback is used only for a
// key the table has never heard of. Markers are matched as text, so an HTML
// comment is parked before any pass runs - see parkComments() below.

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function readSettings() {
  const settings = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    settings[row.key] = row.value;
  }
  return settings;
}

function attrValue(openTag, name) {
  const m = openTag.match(new RegExp(name + '="([^"]*)"'));
  return m ? m[1] : null;
}

// Every substitution below finds its marker TEXTUALLY, so a marker spelled out
// inside an HTML comment - which is how these very pages document the contract,
// and how the terms page ended up printing the site name as stray text between a
// comment and its card - would be filled in as though it were markup. Comments
// are parked in a private-use placeholder for the duration of the passes and put
// back verbatim at the end. U+E000 is a private-use code point: nothing the
// pages contain, nothing a browser renders.
const COMMENT_SLOT = '\uE000';

function parkComments(html) {
  const parked = [];
  const body = html.replace(/<!--[\s\S]*?-->/g, (comment) => {
    parked.push(comment);
    return COMMENT_SLOT + (parked.length - 1) + COMMENT_SLOT;
  });
  return {
    body,
    restore: (out) =>
      out.replace(new RegExp(COMMENT_SLOT + '(\\d+)' + COMMENT_SLOT, 'g'), (_, i) => parked[Number(i)]),
  };
}

// Replaces the ten <section>s shipped inside public/terms.html's article with
// the clauses an admin last saved - and leaves the shipped copy untouched when
// nobody has saved yet, so a fresh deployment reads exactly like the static
// page. The article is found by its id (the only stable handle on it), and the
// note paragraph that follows the sections is kept: it belongs to the page, not
// to the document. The "Cập nhật lần cuối" line above the article is rewritten
// from updated_at, which saveTerms() stamps at save time and at no other time.
function fillTerms(html) {
  const saved = terms.getTerms();
  if (!saved) return html;
  const openTag = html.match(/<article[^>]*id="terms-body"[^>]*>/);
  if (!openTag) return html;
  const start = html.indexOf(openTag[0]);
  const contentStart = start + openTag[0].length;
  const end = html.indexOf('</article>', contentStart);
  if (end === -1) return html;
  const shipped = html.slice(contentStart, end);
  const note = shipped.match(/\n\s*<p class="terms-note"[\s\S]*?<\/p>/);

  const dateLine = 'Cập nhật lần cuối: ' + terms.formatTermsDate(saved.updatedAt);
  const out = html
    .slice(0, contentStart) + '\n' + terms.termsSectionsHtml(saved.clauses) +
    (note ? '\n' + note[0].trim() : '') + '\n' + html.slice(end);
  return out.replace(
    /(<p[^>]*id="terms-updated"[^>]*>)[\s\S]*?(<\/p>)/,
    (m, open, close) => open + dateLine + close
  );
}

// Walks every element whose opening tag contains `marker`, handing the open tag
// to `pickText`. Returning null leaves that element untouched; returning a
// string replaces its text content. Index-based rather than a regex with a
// backreference, so nested-looking markup and odd attribute order can't trip it.
function fillSlots(html, marker, pickText) {
  let out = '';
  let cursor = 0;
  let searchFrom = 0;

  for (;;) {
    const at = html.indexOf(marker, searchFrom);
    if (at === -1) break;

    const tagStart = html.lastIndexOf('<', at);
    const tagEnd = html.indexOf('>', at);
    if (tagStart === -1 || tagEnd === -1) break;
    searchFrom = tagEnd + 1;

    // Text content runs from the end of the open tag to the next '<'. Only a
    // plain-text body is substituted; anything else is left alone.
    const textEnd = html.indexOf('<', tagEnd + 1);
    if (textEnd === -1) break;

    const text = pickText(html.slice(tagStart, tagEnd + 1));
    if (text === null) continue;

    out += html.slice(cursor, tagEnd + 1) + text;
    cursor = textEnd;
  }

  return out + html.slice(cursor);
}

function renderHtml(filePath, settings) {
  const comments = parkComments(fs.readFileSync(filePath, 'utf8'));
  let html = comments.body;
  const { brand, title: siteTitle } = siteNamesFrom(settings);

  // FIRST of the passes, because what it injects is markup carrying markers of
  // its own: the saved clauses of /terms.html contain the [brand] slot and the
  // [contact] paragraph, whose data-brand-name / data-setting-mailto attributes
  // only get filled by the passes below. Running it later would leave a saved
  // document with an empty site name and a dead contact link.
  html = fillTerms(html);

  // Page title: "<page name> - <site title>", or on the homepage (the only
  // page with an empty data-page-name - see the pages themselves) the site
  // title alone. The homepage used to append the hero_subtitle tagline; that
  // field was removed from Quản lí trang chủ (2026-10-04) along with the rest
  // of the hero copy, so it is no longer read here either.
  html = fillSlots(html, 'data-page-name=', (open) => {
    if (!open.startsWith('<title')) return null;
    const page = attrValue(open, 'data-page-name') || '';
    return page ? escapeHtml(page) + ' - ' + escapeHtml(siteTitle) : escapeHtml(siteTitle);
  });

  html = fillSlots(html, 'data-brand-name', () => escapeHtml(brand));

  html = fillSlots(html, 'data-footer-text', (open) => {
    if ('footer_text' in settings) return escapeHtml(settings.footer_text);
    const fallback = attrValue(open, 'data-fallback');
    return fallback === null ? null : fallback;
  });

  html = fillSlots(html, 'data-setting=', (open) => {
    const key = attrValue(open, 'data-setting');
    if (!key) return null;
    if (key in settings) return escapeHtml(settings[key]);
    const fallback = attrValue(open, 'data-fallback');
    return fallback === null ? null : fallback;
  });

  // <img data-setting-src="hero_image" data-fallback="..."> - fill the src so
  // the hero illustration is in the first paint too.
  html = html.replace(/<img[^>]*data-setting-src="[a-z_]+"[^>]*>/g, (tag) => {
    const key = attrValue(tag, 'data-setting-src');
    const fallback = attrValue(tag, 'data-fallback') || '';
    const url = key in settings ? escapeHtml(settings[key]) : fallback;
    // An empty value means the admin removed the image. Leave src off entirely -
    // src="" makes the browser re-request the page itself as an image. The
    // client then hides the whole panel (loadSiteSettings in home.js).
    const stripped = tag.replace(/ src="[^"]*"/, '');
    return url ? stripped.replace('<img', '<img src="' + url + '"') : stripped;
  });

  // <link rel="icon" data-setting-href="favicon" data-fallback="..."> - the
  // admin-set favicon, so the browser tab carries it from the very first request.
  // An empty value means the admin cleared it: the tag is removed entirely
  // rather than left with href="", which would fetch the page itself as an icon.
  html = html.replace(/<link[^>]*data-setting-href="[a-z_]+"[^>]*>/g, (tag) => {
    const key = attrValue(tag, 'data-setting-href');
    const fallback = attrValue(tag, 'data-fallback') || '';
    const url = key in settings ? escapeHtml(settings[key]) : fallback;
    const stripped = tag.replace(/ href="[^"]*"/, '');
    return url ? stripped.replace('<link', '<link href="' + url + '"') : '';
  });

  // <a data-setting-mailto="contact_email"> - the contact link in every footer
  // and in clause 10 of /terms.html. Only the href is built here: what the reader
  // sees is markup, not the setting - the word "Liên hệ" in the footer, and a
  // nested <span data-setting="contact_email"> on the terms page, which the
  // generic text pass above fills. An empty value leaves the href off entirely
  // rather than emitting href="mailto:", which would open the visitor's mail
  // client with no address in it; the data-hide-if-empty pass below then hides
  // whichever element carries it - the link in the footer, its paragraph on the
  // terms page.
  html = html.replace(/<a[^>]*data-setting-mailto="[a-z_]+"[^>]*>/g, (tag) => {
    const key = attrValue(tag, 'data-setting-mailto');
    const raw = key in settings ? settings[key] : attrValue(tag, 'data-fallback');
    const value = String(raw ?? '').trim();
    const stripped = tag.replace(/ href="[^"]*"/, '');
    return value ? stripped.replace('<a', '<a href="mailto:' + escapeHtml(value) + '"') : stripped;
  });

  // <meta name="description" data-meta-content="hero_subtitle" data-fallback="...">
  // Same family as data-setting-src/data-setting-href above, for the one
  // attribute a description/OG/Twitter meta tag actually varies by -
  // `content` - regardless of which `name`/`property` the tag itself carries.
  // Static pages (index.html, viewall.html) use this for SEO tags that would
  // otherwise never change with the admin's own site copy; post.html's own
  // per-post OG/description/JSON-LD block is injected separately below by
  // fillPostMeta(), which knows the one post the URL is asking for.
  html = html.replace(/<meta[^>]*data-meta-content="[a-z_]+"[^>]*>/g, (tag) => {
    const key = attrValue(tag, 'data-meta-content');
    const fallback = attrValue(tag, 'data-fallback') || '';
    const value = key in settings && String(settings[key]).trim() ? escapeHtml(settings[key]) : fallback;
    const stripped = tag.replace(/ content="[^"]*"/, '');
    return stripped.replace('<meta', `<meta content="${value}"`);
  });

  // Collapse containers whose only content is a setting the admin emptied, so
  // the page never paints an empty hero panel or a bare badge pill outline and
  // then removes it a moment later. Mirrors the class toggling home.js does.
  html = html.replace(/<[a-zA-Z][a-zA-Z0-9]*[^>]*data-hide-if-empty="[a-z_]+"[^>]*>/g, (tag) => {
    const key = attrValue(tag, 'data-hide-if-empty');
    const value = key in settings ? settings[key] : attrValue(tag, 'data-fallback');
    if (value && String(value).trim()) return tag;
    if (/ class="/.test(tag)) return tag.replace(' class="', ' class="hidden ');
    return tag.replace(/^<([a-zA-Z][a-zA-Z0-9]*)/, '<$1 class="hidden"');
  });

  html = fillLeadCard(html);
  html = cacheBustAssets(html);

  return comments.restore(html);
}

// ---- The homepage lead card, in the first paint ----
//
// The lead article's cover is the largest thing the homepage downloads, and its
// URL used to be unknowable until /api/posts answered: the browser spent one
// round-trip fetching the API before it could even START the image, so the LCP
// element was always last in line. Filling the card here - text, author, and a
// <link rel=preload> for the 1280px derivative - puts the cover on the wire in
// parallel with the scripts, and the card reads as content instead of as
// "Đang tải bài viết..." for the first few hundred milliseconds.
//
// home.js still fetches and re-renders the whole grid exactly as before; this
// only pre-fills what the server already knows, with the same values the client
// would compute (same derivative URL, same time-ago wording), so the two passes
// agree and the re-render is invisible. Side cards stay client-side: they are
// below the fold and not worth a second server template to keep in sync.
const LEAD_SQL = `
  SELECT p.id, p.title, p.slug, p.excerpt, p.cover_image, p.tag, p.created_at,
         u.name AS author_name, u.avatar_url AS author_avatar
    FROM posts p LEFT JOIN users u ON u.id = p.author_id
   WHERE p.status = 'published' AND p.deleted_at IS NULL
   ORDER BY p.created_at DESC, p.id DESC
   LIMIT 1`;

// The client's timeAgoVi (public/js/api.js), mirrored for the first paint. Kept
// to the same branches and the same vi-VN fallback so a card rendered here and
// re-rendered by home.js a moment later says the same thing.
function timeAgoVi(dateStr) {
  const d = new Date(String(dateStr).replace(' ', 'T') + 'Z');
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'vừa xong';
  if (mins < 60) return `${mins} phút trước`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} giờ trước`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} ngày trước`;
  return d.toLocaleDateString('vi-VN', { day: '2-digit', month: 'long', year: 'numeric' });
}

// Same rule as derivUrl() in public/js/api.js: a bare same-origin upload path
// becomes its 1280px derivative; anything else (external cover, admin default,
// empty) is used as it stands.
function leadCoverUrl(coverImage) {
  const m = String(coverImage || '').match(/^\/uploads\/([^/]+)$/);
  return m ? `/uploads/w1280/${m[1]}` : String(coverImage || '');
}

function fillTextSlot(html, id, text) {
  return html.replace(new RegExp(`(id="${id}">)`), (m0, open) => open + escapeHtml(text));
}

// Same slot-filling shape as fillTextSlot, but for a value that is ALREADY
// safe markup rather than plain text - only ever the post excerpt, which
// sanitizeRichHtml() (server/routes/posts.js) constrains on the way into the
// database. escapeHtml()ing it here the way fillTextSlot does every other
// slot would print the author's own bold/italic/link markup as literal
// "&lt;b&gt;" on the homepage hero instead of rendering it.
function fillHtmlSlot(html, id, safeHtml) {
  return html.replace(new RegExp(`(id="${id}">)`), (m0, open) => open + String(safeHtml || ''));
}

function fillLeadCard(html) {
  if (!html.includes('id="latest-main"')) return html;
  let lead;
  try {
    lead = db.prepare(LEAD_SQL).get();
  } catch {
    return html; // a database that cannot answer is not a reason to fail the page
  }
  if (!lead) return html; // no published post yet: the client shows "chưa có bài"
  // Same fallback the cards get from the API: a lead post with no excerpt of its
  // own opens with the first sentences of its body, so the first paint and
  // home.js's re-render a moment later say the same thing.
  attachExcerptFallback([lead]);

  const cover = leadCoverUrl(lead.cover_image);

  // No cover of its own: no picture block at all (there is no default cover).
  if (!cover) html = html.replace('<div class="ed-lead-media w-full">', '<div class="ed-lead-media w-full hidden">');
  if (cover) {
    // Start the cover alongside the scripts rather than after them.
    html = html.replace('</head>', `  <link rel="preload" as="image" href="${escapeHtml(cover)}">\n</head>`);
    html = html.replace(/<img\b[^>]*id="latest-image"[^>]*>/, (tag) =>
      tag.includes('src=') ? tag : tag.replace('<img', `<img src="${escapeHtml(cover)}"`)
    );
  }
  if (lead.author_avatar) {
    html = html.replace(/<img\b[^>]*id="latest-author-avatar"[^>]*>/, (tag) =>
      // The 480px thumb, not the original: a byline avatar is ~24px, and an
      // uploaded original competes with the LCP cover for bandwidth on a phone.
      tag.includes('src=') ? tag : tag.replace('<img', `<img src="${escapeHtml(leadCoverUrl(lead.author_avatar).replace('/uploads/w1280/', '/uploads/thumb/'))}"`)
    );
  }

  html = fillTextSlot(html, 'latest-tag', lead.tag || '');
  html = fillTextSlot(html, 'latest-title', lead.title || '');
  html = fillHtmlSlot(html, 'latest-excerpt', lead.excerpt || '');
  html = fillTextSlot(html, 'latest-author-name', lead.author_name || 'Ẩn danh');
  html = fillTextSlot(html, 'latest-date', timeAgoVi(lead.created_at));

  // The card is real content now: show the grid and drop the loading line, both
  // of which home.js would otherwise toggle once its fetch lands.
  html = html.replace('class="hidden grid grid-cols-1', 'class="grid grid-cols-1');
  html = html.replace('<p class="text-on-surface-variant" id="latest-loading">', '<p class="hidden text-on-surface-variant" id="latest-loading">');
  return html;
}

// ---- Per-post SEO: title, description, canonical, Open Graph, Twitter Card,
// JSON-LD (post.html?slug=...) ----
//
// Before this, every post answered with the SAME generic <title> ("Chi tiết
// bài viết - AnonyHT") and no description/OG/Twitter/structured-data at all:
// a search result could not tell one post from another, and a link shared to
// Facebook/Zalo/Twitter carried no image, title or description - just a bare
// URL. post.js never wrote any of this client-side either (checked: no
// document.title, no meta tag touched anywhere in it), so a crawler that does
// not run JavaScript - which is every Open Graph consumer, and was the actual
// audience this was missing - saw nothing post-specific, ever.
//
// This has to be a SEPARATE pass from renderHtml() above, not folded into it:
// renderHtml()'s own cache is keyed by FILE (post.html is one file for every
// post), while what this fills in depends on the ?slug= query string - a
// per-REQUEST value renderHtml() never sees. Folding it in would cache the
// FIRST post's meta and serve it for every other post's URL after.
const POST_META_SQL = `
  SELECT p.id, p.title, p.slug, p.excerpt, p.cover_image, p.tag,
         p.created_at, p.updated_at, u.name AS author_name
    FROM posts p LEFT JOIN users u ON u.id = p.author_id
   WHERE p.slug = ? AND p.status = 'published' AND p.deleted_at IS NULL`;

// DB rows are "YYYY-MM-DD HH:MM:SS" UTC with no zone marker (SQLite's own
// datetime('now')) - the same shape timeAgoVi() above parses with the same
// 'T'-splice-plus-'Z' trick. JSON-LD and article:*_time both want real ISO
// 8601, which is what a bare toISOString() already is once the Date is
// built correctly.
function toIsoDate(dateStr) {
  const d = new Date(String(dateStr).replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Same rule as leadCoverUrl() above, exported in spirit rather than in code:
// a bare same-origin upload becomes its 1280px derivative (the one size this
// module's job is to reuse, not invent a second image pipeline for), an
// external cover or the admin default is used exactly as stored. What differs
// from leadCoverUrl() is that OG/Twitter both require an ABSOLUTE url - a
// crawler fetching the tag never resolves a relative one against the page it
// came from the way a browser <img> would - so the site origin is prefixed
// onto the same-origin case only; an already-absolute external cover is left
// alone.
function ogImageUrl(coverImage, origin) {
  const rel = leadCoverUrl(coverImage);
  if (!rel) return '';
  return /^https?:\/\//i.test(rel) ? rel : origin + rel;
}

// JSON embedded in a <script> tag is HTML content, not just JSON: a post
// title containing the literal text "</script>" would otherwise close the
// tag early and let whatever followed it run as markup (or, on this
// specific page, as script - the one thing a post's OWN title must never be
// able to inject). Escaping '<' to its unicode escape is valid inside a JSON
// string per spec and is invisible to any JSON parser, so nothing about the
// data changes - only its ability to be mistaken for the tag around it.
function jsonLdScript(data) {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

const postMetaCache = new Map(); // slug -> { key, html }

// `baseKey` is mtimeMs+settingsKey from the caller, already computed for its
// own cache - passed in rather than recomputed so this cache's key can be
// composed from it plus the one thing it alone depends on, the post's own
// updated_at (an edit in Admin/write.html must invalidate exactly its own
// slug's entry, nothing else).
// Cut to at most `max` characters on a word boundary, with an ellipsis when
// anything was dropped - a search snippet ending mid-word reads as broken.
function clipAtWord(text, max) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:–-]+$/, '')}…`;
}

function fillPostMeta(baseHtml, slug, settings, baseKey) {
  let post;
  try {
    post = db.prepare(POST_META_SQL).get(slug);
  } catch {
    return baseHtml; // a database that cannot answer is not a reason to fail the page
  }
  // No such post, or not published: client-side post.js already renders a
  // "not found" state for this - see #post-error there. Nothing to inject.
  if (!post) return baseHtml;

  const key = `${baseKey}|${post.updated_at}`;
  const cached = postMetaCache.get(slug);
  if (cached && cached.key === key) return cached.html;

  attachExcerptFallback([post]); // same fallback every card/list gets - see excerpt.js
  const { brand, title: siteTitle } = siteNamesFrom(settings);
  const origin = publicOrigin();
  const canonicalUrl = `${origin}/post.html?slug=${encodeURIComponent(post.slug)}`;
  const pageTitle = `${post.title} - ${siteTitle}`;
  // Meta descriptions are conventionally read to about 160 characters before
  // a search result truncates them; the excerpt/fallback above is tuned for
  // a card (up to 220), so it is cut again here rather than re-tuning a
  // budget three other call sites already share. stripHtml because the
  // author's own excerpt can carry the same inline formatting (bold/italic/
  // link) the standfirst on the page itself renders - a <meta> tag has no
  // markup of its own to show it in.
  const description = clipAtWord(stripHtml(post.excerpt || ''), 160);
  const image = ogImageUrl(post.cover_image, origin);
  const published = toIsoDate(post.created_at);
  const modified = toIsoDate(post.updated_at) || published;

  let html = baseHtml.replace(/<title[^>]*>[^<]*<\/title>/, `<title>${escapeHtml(pageTitle)}</title>`);

  const metaTags = [
    `<meta name="description" content="${escapeHtml(description)}">`,
    `<link rel="canonical" href="${escapeHtml(canonicalUrl)}">`,
    `<meta property="og:type" content="article">`,
    `<meta property="og:site_name" content="${escapeHtml(brand)}">`,
    `<meta property="og:title" content="${escapeHtml(post.title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta property="og:url" content="${escapeHtml(canonicalUrl)}">`,
    image ? `<meta property="og:image" content="${escapeHtml(image)}">` : '',
    published ? `<meta property="article:published_time" content="${published}">` : '',
    `<meta property="article:modified_time" content="${modified}">`,
    post.author_name ? `<meta property="article:author" content="${escapeHtml(post.author_name)}">` : '',
    `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:title" content="${escapeHtml(post.title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(description)}">`,
    image ? `<meta name="twitter:image" content="${escapeHtml(image)}">` : '',
    `<script type="application/ld+json">${jsonLdScript({
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: post.title,
      description,
      ...(image ? { image: [image] } : {}),
      ...(published ? { datePublished: published } : {}),
      dateModified: modified,
      // One-author blog: the person behind every post is the "Về tác giả" page.
      author: { '@type': 'Person', name: post.author_name || brand, url: `${origin}/about.html` },
      publisher: { '@type': 'Organization', name: brand },
      mainEntityOfPage: { '@type': 'WebPage', '@id': canonicalUrl },
    })}</script>`,
  ]
    .filter(Boolean)
    .join('\n  ');

  html = html.replace('</head>', `  ${metaTags}\n</head>`);

  postMetaCache.set(slug, { key, html });
  return html;
}

// Express middleware: serves .html from public/ with the settings already
// substituted. Anything else (or a missing file) falls through to
// express.static behind it.
//
// The rendered string is cached per file, invalidated by whichever of its two
// inputs moved: the file's mtime (a deploy over Samba) or the settings table's
// contents (an admin edit). A hit skips both the readFileSync of a 15-128 KB
// page and the substitution passes over it - the whole cost of serving HTML
// becomes the settings SELECT, which is what keeps an admin edit live without
// any TTL to expire.
const htmlCache = new Map(); // filePath -> { mtimeMs, settingsKey, html }

function htmlRenderer(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();

  let urlPath;
  try {
    urlPath = decodeURIComponent(req.path);
  } catch {
    return next(); // malformed percent-encoding - let static handle/reject it
  }

  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  if (!relative.toLowerCase().endsWith('.html')) return next();

  // Resolve inside public/ only - never let '..' escape the served directory.
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return next();

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return next();
  }
  if (!stat.isFile()) return next();

  try {
    const settings = readSettings();
    const settingsKey = JSON.stringify(settings);
    const mtimeMs = stat.mtimeMs;
    // The terms page has a third input: the saved document. Its version is the
    // save timestamp, so a save invalidates exactly this page's entry and
    // nothing else costs the extra SELECT.
    const termsKey = relative.toLowerCase() === 'terms.html' ? terms.termsVersion() : '';

    let entry = htmlCache.get(filePath);
    if (!entry || entry.mtimeMs !== mtimeMs || entry.settingsKey !== settingsKey || entry.termsKey !== termsKey) {
      entry = { mtimeMs, settingsKey, termsKey, html: renderHtml(filePath, settings) };
      htmlCache.set(filePath, entry);
    }

    let html = entry.html;
    let status = 200;
    const page = relative.toLowerCase();
    // The one page whose SEO tags depend on something outside entry's own
    // cache key: which post. See fillPostMeta()'s own header comment for why
    // this cannot live inside renderHtml()/entry the way fillLeadCard() does.
    // The list/body passes are server/ssr-content.js (crawlable first paint).
    if (page === 'post.html') {
      const slug = typeof req.query.slug === 'string' ? req.query.slug : '';
      const filled = slug ? fillPostBody(html, slug, settings) : { html, found: false };
      if (filled.found) {
        html = fillPostMeta(filled.html, slug, settings, `${mtimeMs}|${settingsKey}`);
      } else {
        // No such (published) post: a real 404 rather than a 200 "not found"
        // page, which Google files as a soft 404 against the whole site. The
        // page itself is unchanged - post.js still shows its own message.
        status = 404;
        html = html.replace('</head>', '  <meta name="robots" content="noindex">\n</head>');
      }
    } else if (page === 'index.html') {
      html = fillHomeLinks(html, settings);
    } else if (page === 'viewall.html') {
      html = fillViewallList(html, req.query, settings);
    }

    // The output depends on the settings table, so it must never be held
    // stale - same revalidation policy express.static applies to HTML.
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    return res.status(status).send(html);
  } catch (e) {
    return next(e);
  }
}

module.exports = { htmlRenderer, renderHtml };

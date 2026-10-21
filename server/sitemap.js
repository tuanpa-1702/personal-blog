const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const terms = require('./terms');

// GET /sitemap.xml - built from the database on every cache miss.
//
// Generated rather than shipped as public/sitemap.xml on purpose. The thing a
// sitemap describes changes every time an editor publishes, and a static file
// would list the posts that existed on the day someone remembered to regenerate
// it: a sitemap pointing at a slug that has since been trashed sends a crawler
// to a 404, and a sitemap that omits yesterday's article tells Google the site
// has nothing new. Both are worse than no sitemap at all, because Google reads
// a file that is repeatedly wrong as a statement about the whole site rather
// than about one URL. A generated one cannot drift - it is the same SELECT the
// homepage and /api/posts answer from.
//
// What is in it, and what is deliberately not:
//
//   /                     the homepage
//   /viewall.html         the full post listing
//   /post.html?slug=...   every published, un-trashed post
//   (no author profiles: one-author blog, bylines go to /about.html)
//
//   /write.html, /admin.html   login-gated app screens. A crawler cannot render
//                              them and must not be invited to try.
//   /viewall.html?tag=..., ?q= one filtered view per tag and per search would be
//                              the same articles reachable at many URLs - the
//                              duplicate-content case a sitemap is supposed to
//                              avoid, not feed. /viewall.html is the canonical
//                              listing and is the only one listed.
//   /index.html                the same document as /. Listing both hands Google
//                              two URLs for one page and splits its signals
//                              between them; / is the canonical form.
//
// <changefreq> and <priority> are emitted because the sitemaps.org protocol
// defines them and some crawlers (Bing, Yandex, Seznam) still read them. Google
// has ignored both since 2019 and says so in its documentation - the values here
// are a hint to the crawlers that listen and cost nothing with the ones that do
// not. <lastmod> is the one field Google does use, and only when it has proved
// accurate, so it is omitted entirely wherever an honest value is not available
// rather than filled with a plausible-looking guess.

// The origin every <loc> is absolute against. A sitemap URL that is relative, or
// that points at a different host than the one being crawled, is rejected
// outright.
//
// Resolved from SITE_URL - the same variable server.js already uses for the CORS
// origin (line 66) and the mailer uses for links inside emails - so all three
// agree on what the site's public address is. The admin-editable site_url in the
// email_settings table is NOT consulted: that field is documented as the address
// email links use, it lives behind an admin-only route, and letting a typo there
// silently re-point every <loc> in the sitemap at another domain is a bad trade
// for the convenience.
//
// The literal fallback is the production domain, so a deployment that boots
// without SITE_URL still emits a correct, absolute sitemap instead of an empty
// or relative one.
const DEFAULT_ORIGIN = 'https://blog.tuanpa.tech';

// How long a shared cache (Cloudflare, in front of this app) may hold the file.
// An hour is far shorter than the interval any crawler re-fetches a sitemap at
// and far longer than the interval between two crawler visits, so the origin
// answers a crawler's repeated requests from cache while a newly published post
// still appears in the file within the hour.
const CACHE_MAX_AGE = 3600;

function publicOrigin() {
  return String(process.env.SITE_URL || DEFAULT_ORIGIN).trim().replace(/\/+$/, '');
}

// XML escaping. Slugs come from slugify(..., { strict: true, locale: 'vi' }) and
// are therefore [a-z0-9-], but a slug set by hand or imported from an older
// database is not guaranteed to be, and a raw '&' in a query string is the one
// character that makes an otherwise valid sitemap unparseable. Escaping every
// value costs nothing and removes the assumption.
function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]
  ));
}

// SQLite stores datetime('now') as 'YYYY-MM-DD HH:MM:SS' in UTC, with no offset
// and a space where the W3C format wants a 'T'. A sitemap's <lastmod> has to be
// a W3C datetime, so the separator is swapped and the offset made explicit -
// handed to `new Date()` as it stands, the string would be read as LOCAL time
// and every timestamp would shift by the server's UTC offset, claiming the post
// changed hours before or after it did.
//
// A value that already carries an offset (or a Z) is the one exception: there the
// engine's parse is correct and the result is converted to UTC, so every
// <lastmod> in the file is expressed in the same zone and stays comparable.
//
// Returns '' for anything unrecognisable. The caller then omits <lastmod>
// entirely: no date is honest, a wrong one is not.
function w3cDate(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';

  const toUtc = (d) => d.toISOString().replace(/\.\d{3}Z$/, '+00:00');

  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    const withZone = new Date(raw);
    return Number.isNaN(withZone.getTime()) ? '' : toUtc(withZone);
  }

  const full = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw);
  if (full) return `${full[1]}T${full[2]}:${full[3]}:${full[4]}+00:00`;

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? '' : toUtc(parsed);
}

// One <url> element. Optional children are left out rather than emitted empty:
// <priority></priority> is a protocol violation, and <lastmod></lastmod> reads as
// "last modified never".
function urlBlock(loc, { lastmod = '', changefreq = '', priority = '' } = {}) {
  const lines = [`    <loc>${escapeXml(loc)}</loc>`];
  if (lastmod) lines.push(`    <lastmod>${escapeXml(lastmod)}</lastmod>`);
  if (changefreq) lines.push(`    <changefreq>${escapeXml(changefreq)}</changefreq>`);
  if (priority) lines.push(`    <priority>${escapeXml(priority)}</priority>`);
  return `  <url>\n${lines.join('\n')}\n  </url>`;
}

// The fixed pages, in the order a reader meets them. The homepage and the
// listing change when the newest post does; "Về tác giả" is static markup, so
// its lastmod is the file's own mtime (see buildSitemapXml()).
const STATIC_PAGES = [
  { path: '/', changefreq: 'daily', priority: '1.0' },
  { path: '/viewall.html', changefreq: 'daily', priority: '0.9' },
  { path: '/about.html', changefreq: 'monthly', priority: '0.5', file: 'about.html' },
];

// Exactly the visibility rule the rest of the server applies (routes/posts.js,
// routes/users.js): published, and not in the recycle bin. A draft is reachable
// only by its author and an admin, so it must not appear here - a crawler
// fetching one gets a 403/404 and counts it against the file.
const POSTS_SQL = `
  SELECT slug, updated_at, created_at, author_id
    FROM posts
   WHERE status = 'published' AND deleted_at IS NULL
   ORDER BY created_at DESC, id DESC`;

// Aggregate over the same set, for two things: the cache fingerprint, and the
// <lastmod> of the homepage and the listing.
//
// Those two pages show every published post, so either of them changes when ANY
// post is published or edited - not only when the newest one is. Taking the date
// from the top of POSTS_SQL instead (which is ordered by created_at, matching the
// homepage's own lead card) gets that wrong in an ordinary case: an editor fixes
// a typo in last month's article, the listing re-renders with the corrected
// excerpt, and the sitemap keeps claiming the page has not changed since the
// newer article went up. MAX(updated_at) is the honest answer, and SQLite does
// the comparison rather than the code assuming a row order.
//
// COUNT catches a publish, an un-publish and a trip to or from the bin; MAX
// catches an edit to a post that is already listed. Together they move on every
// change that would change the file. Same invalidation shape as the HTML
// renderer's cache (render-html.js), which is keyed on mtime + settings +
// termsVersion for the same reason: no TTL to expire, so an admin edit is live
// on the next request.
const STATS_SQL = `
  SELECT COUNT(*)                   AS post_count,
         MAX(updated_at)            AS updated_max,
         MAX(created_at)            AS created_max,
         COUNT(DISTINCT author_id)  AS author_count
    FROM posts
   WHERE status = 'published' AND deleted_at IS NULL`;

// The moment the published set last moved. updated_at defaults to
// datetime('now') on insert, so it is at least as recent as created_at for every
// row; created_max is only the fallback for a row imported without one.
function listingLastmodFrom(stats) {
  return w3cDate(stats.updated_max || stats.created_max);
}

function readStats() {
  return db.prepare(STATS_SQL).get();
}

function fingerprintFrom(stats) {
  return [
    stats.post_count,
    stats.updated_max || '',
    stats.created_max || '',
    stats.author_count,
    terms.termsVersion(),
  ].join('|');
}

// `stats` is passed in by the handler, which has just read the same row to build
// the cache key; the default is what makes the function usable on its own.
function buildSitemapXml(stats = readStats()) {
  const origin = publicOrigin();
  const posts = db.prepare(POSTS_SQL).all();

  // POSTS_SQL is newest-first by created_at, so the document reads in the order
  // the homepage does. Its own <lastmod> comes from STATS_SQL instead: the page
  // changes when ANY published post is edited, not only when the newest one is.
  const listingLastmod = listingLastmodFrom(stats);

  const entries = [];
  for (const page of STATIC_PAGES) {
    let lastmod = listingLastmod;
    if (page.file) {
      try {
        lastmod = new Date(fs.statSync(path.join(__dirname, '..', 'public', page.file)).mtimeMs).toISOString().replace(/\.\d{3}Z$/, '+00:00');
      } catch {
        continue; // the page is not deployed on this box: do not list it
      }
    }
    entries.push(urlBlock(origin + page.path, {
      lastmod,
      changefreq: page.changefreq,
      priority: page.priority,
    }));
  }

  for (const post of posts) {
    const slug = String(post.slug || '').trim();
    if (!slug) continue; // no slug, no address to list
    entries.push(urlBlock(
      `${origin}/post.html?slug=${encodeURIComponent(slug)}`,
      {
        lastmod: w3cDate(post.updated_at || post.created_at),
        changefreq: 'weekly',
        priority: '0.8',
      }
    ));
  }

  // No per-author /profile.html?user= entries: this is a one-author blog and
  // every byline links to /about.html (already listed above) instead.

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    entries.join('\n'),
    '</urlset>',
    '', // trailing newline, so the file ends like a text file
  ].join('\n');
}

// The sitemaps.org protocol caps one file at 50,000 URLs and 50 MB uncompressed;
// past that a site has to serve a sitemap index that points at several files.
// This blog is orders of magnitude below the limit, so the split is not built -
// but it is not silent either, because the failure mode of hitting the cap is a
// file Google rejects wholesale rather than one it partially reads.
const URL_LIMIT = 50000;

// One cached copy, invalidated by the fingerprint above rather than by a timer.
// A single entry is enough: there is exactly one sitemap, and it is the same
// document for every caller (the origin comes from configuration, not from the
// request, so two hosts cannot need two versions).
let cache = null; // { key, xml, etag }

function sitemapHandler(req, res) {
  let xml;
  let etag;
  let degraded = false;

  try {
    const stats = readStats();
    const key = fingerprintFrom(stats);
    if (cache && cache.key === key) {
      xml = cache.xml;
      etag = cache.etag;
    } else {
      xml = buildSitemapXml(stats);
      etag = 'W/"sitemap-' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 16) + '"';
      cache = { key, xml, etag };
    }
  } catch (e) {
    // A database that cannot answer is not a reason to fail the request: the
    // handler is reached by crawlers, and a 500 on /sitemap.xml is reported in
    // Search Console as a broken sitemap long after the database is healthy
    // again. Serve the last good copy if there is one; otherwise the three fixed
    // pages, which need no query at all and are still a valid, useful file.
    console.error('[sitemap] Không đọc được CSDL, trả về bản dự phòng:', e.message);
    degraded = true;
    if (cache) {
      xml = cache.xml;
      etag = cache.etag;
    } else {
      const origin = publicOrigin();
      xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        STATIC_PAGES.map((p) => urlBlock(origin + p.path, {
          changefreq: p.changefreq,
          priority: p.priority,
        })).join('\n'),
        '</urlset>',
        '',
      ].join('\n');
      etag = 'W/"sitemap-fallback"';
    }
  }

  const urlCount = (xml.match(/<url>/g) || []).length;
  if (urlCount > URL_LIMIT) {
    // Logged, not acted on: the response is still served, and the fix (a
    // sitemap index) is a change to make deliberately rather than mid-request.
    console.warn(`[sitemap] ${urlCount} URL vượt giới hạn ${URL_LIMIT} của một file sitemap - cần tách thành sitemap index.`);
  }

  // nosniff is set globally (security-headers.js), so the browser will not guess
  // its way to XML from the bytes and this has to be exact. Stated in full rather
  // than through res.type('application/xml'): that helper runs mime.lookup only
  // when given a bare extension, and passes a string that already contains a '/'
  // through verbatim - so the charset, which the XML declaration on line 1
  // promises and which a slug carrying Vietnamese would need, would be missing.
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('ETag', etag);
  // Never cached while degraded. Cloudflare sits in front and would otherwise
  // hold the three-page fallback for a full hour after the database came back,
  // serving every crawler a sitemap that is missing the whole blog.
  res.setHeader(
    'Cache-Control',
    degraded ? 'no-store' : `public, max-age=${CACHE_MAX_AGE}`
  );
  // Express turns this into a 304 on its own when If-None-Match matches the ETag
  // above, which is what a returning crawler sends.
  res.send(xml);
}

module.exports = { sitemapHandler, buildSitemapXml, publicOrigin, w3cDate, escapeXml };

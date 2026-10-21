// Loads .env from the project root and refuses to boot without a real
// JWT_SECRET. Must be the first require: everything below reads secrets.
require('./env');

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const passport = require('passport');
const { compress } = require('./compress');
const { securityHeaders } = require('./security-headers');

const authRoutes = require('./routes/auth');
const postsRoutes = require('./routes/posts');
const adminRoutes = require('./routes/admin');
// Mounted before /api/admin on purpose: the bin lives at /api/admin/trash, and
// Express takes the first mount whose prefix matches, so the more specific path
// has to come first or the admin router would swallow it and 404.
const trashRoutes = require('./routes/trash');
const uploadRoutes = require('./routes/upload');
const mediaRoutes = require('./routes/media');
const settingsRoutes = require('./routes/settings');
const termsRoutes = require('./routes/terms');
const usersRoutes = require('./routes/users');
const { router: emailOauthRoutes } = require('./routes/email-oauth');
const { htmlRenderer } = require('./render-html');
const { sitemapHandler } = require('./sitemap');
const maintenance = require('./maintenance');
const thumbs = require('./thumbs');

const app = express();
const PORT = process.env.PORT || 3000;

// Loopback only. The site is published through a cloudflared tunnel, which
// connects outward from this machine and reaches the app over localhost - so
// binding 0.0.0.0 exposed port 3000 to anything that could route to the host
// while adding nothing. It also underpins the rate limiter: CF-Connecting-IP is
// only trustworthy while every request has come through Cloudflare's edge, and a
// caller able to hit port 3000 directly could forge that header freely.
const HOST = process.env.HOST || '127.0.0.1';

// Cloudflare terminates TLS and forwards the original address; without this
// req.ip is the tunnel's loopback address for every visitor on the internet.
// middleware/rate-limit.js prefers CF-Connecting-IP over req.ip, but express's own
// req.protocol / req.secure also depend on this being set.
app.set('trust proxy', 1);

// Express sets this on every response by default, naming the framework for free
// to anyone fingerprinting the server. Nothing here depends on it being present.
app.disable('x-powered-by');

// Security response headers (CSP, nosniff, frame-ancestors, HSTS...). First, so
// they are set on every response including the static files and the error handler.
// Hand-written rather than `helmet` - see the note in server/security-headers.js.
app.use(securityHeaders());

// gzip/brotli, ahead of every route so it covers the API responses and the
// rendered HTML as well as the static files. Measured on this project's own
// assets it removes ~75% of the bytes; the two render-blocking stylesheets go
// from 75 KB to about 15 KB, which is time the first paint spends waiting.
// Zero-dependency (Node's zlib) on purpose - see the note in server/compress.js.
app.use(compress());

// Same-origin only. This app serves its own frontend, so there is no
// cross-origin caller to allow - and `cors()` with no options answered
// `Access-Control-Allow-Origin: *` on every route including /api/admin/*, which
// let any page on the internet read this API with a visitor's browser (though not
// their token: it lives in localStorage, not a cookie, so it is not sent
// automatically). ORIGIN is the site's own address, used only to answer a
// preflight if one ever arrives.
const ORIGIN = process.env.SITE_URL || undefined;
app.use(cors({ origin: ORIGIN || false, credentials: false }));

// 10mb was chosen for image uploads that no longer come through here: multipart is
// handled by multer in routes/upload.js, which has its own 8 MB ceiling. A JSON
// body in this app is a post with its blocks - 1 MB is generous for that, and it
// bounds what an unauthenticated request can make the server parse.
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// Google OAuth strategy is registered as a side effect of requiring
// routes/auth.js above. We only need passport.initialize() here — the app is
// otherwise fully stateless (JWT in the Authorization header), so no
// express-session / passport.session() is used anywhere.
app.use(passport.initialize());

// Maintenance mode, ahead of every route and behind nothing: while
// data/maintenance-on exists, the whole site answers 503 with the notice page,
// except the assets that page itself needs. Registered before the /api mounts
// so an endpoint cannot answer from behind a closed sign. See maintenance.js.
app.use(maintenance.middleware);

// API routes. Responses are data, not documents: nothing here may sit in a
// shared cache or be held by a browser's heuristic caching, because a
// /api/posts answered from a stale copy is a homepage that quietly lies about
// what is published. /api/settings states the same policy for itself.
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use('/api/auth', authRoutes);
app.use('/api/posts', postsRoutes);
app.use('/api/admin/trash', trashRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/upload', uploadRoutes);
// Media library. Separate from /api/upload above: this one requires 'editor' or
// 'admin' and lifts the per-file size limit for admins, while /api/upload is the
// avatar path every role can reach and stays capped.
app.use('/api/media', mediaRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/terms', termsRoutes);
app.use('/api/users', usersRoutes);
// Microsoft redirects the browser back here after the delegated-SMTP consent, so
// it cannot sit under /api/admin (no Authorization header on a redirect). The
// route authorises itself with a signed state parameter instead.
app.use('/api/email-oauth', emailOauthRoutes);

// GET /sitemap.xml - generated from the database, so it always lists exactly
// what is published (see server/sitemap.js for what is in it and what is
// deliberately left out). Registered ahead of express.static: there is no
// public/sitemap.xml on disk and the handler answers regardless, so a stale file
// dropped into public/ later could never shadow the live one. Nothing else in
// this chain matches the path - htmlRenderer below only takes .html, the backup
// blocker only takes .bak/.orig/.save/.old/.swp/.tmp, and the min-twin rewrite
// only takes /js/ and /css/ - and no /api mount can reach it, so there is no
// existing route to collide with.
app.get('/sitemap.xml', sitemapHandler);

// HTML pages are rendered through the settings substitution first, so the
// configured site title / brand name / hero copy is present in the very first
// paint. Without it the browser painted the hardcoded fallback, then the client
// rewrote it once /api/settings resolved - a visible flash of the old name on
// every reload. Must sit ahead of express.static, which would otherwise serve
// the raw file.
app.use(htmlRenderer);

// Editor and deploy backups are never public files. public/js/ held two copies of
// admin.js as .bak.<timestamp>, which express.static served to anyone who guessed
// the name - the whole admin frontend, readable without logging in. Blocked here
// rather than only deleted, so the next stray backup cannot re-open it.
app.use((req, res, next) => {
  if (/\.(bak|orig|save|old|swp|tmp)(\.|$)/i.test(req.path)) {
    return res.status(404).type('text/plain').send('Not found');
  }
  next();
});

// Static frontend (the pages adapted from the Stitch HTML exports) + uploaded images.
//
// Three cache policies, because the files fall into three groups:
//
// HTML/JS/CSS -> no-cache, must-revalidate.
//   These must revalidate on every request. Without it a browser holding an
//   older index.html/admin.js keeps serving it after a deploy, so admin edits
//   appear to have no effect and newly added controls silently do nothing - the
//   page and the script it depends on can even come from different versions.
//   `no-cache` does NOT mean "do not store": the copy is kept and a conditional
//   request returns a 304 with no body, so the cost is one round-trip, not a
//   re-download.
//
// /fonts/ -> one year, immutable.
//   Every filename carries a hash of its contents (scripts/fetch-fonts.py), so a
//   changed font is a different URL and can never be served stale. `immutable`
//   is the part that matters on a RELOAD specifically: a browser revalidates
//   ordinary cached subresources when the reader presses F5, and this is what
//   tells it not to. Nineteen conditional requests per reload become zero, and
//   the icon font - the one thing that was making icon NAMES visible as text -
//   is already in memory before the first paint.
//
// /uploads/ -> one week.
//   Content-addressed by filename too (timestamp + 6 random bytes in
//   routes/upload.js) but not by content hash, so they get a long TTL rather
//   than `immutable`.
// Derivatives for anything that shows a photo: /uploads/thumb/<file> is the
// 480px JPEG the media-library grid tiles on, /uploads/w1280/<file> the 1280px
// copy the homepage lead card, the post hero and the pictures inside a post
// use instead of originals that run to tens of megabytes. Both are made from
// the original by server/thumbs.js. Registered BEFORE express.static because
// the paths live inside public/uploads, which the static middleware would
// otherwise serve literally - and the files are generated on first request, so
// there is nothing on disk for it to find anyway.
//
// Lazy generation is the backfill: the first page of tiles costs one resize per
// image (capped at two in flight), every later visit hits the file on disk. A
// failure of any kind - no ImageMagick on this server, an undecodable file -
// redirects to the ORIGINAL, so every page degrades to its old behaviour rather
// than showing broken images. scripts/gen-derivatives.js pre-generates both
// kinds for the whole library so first visits need not pay for a resize.
function derivativeRoute(kind) {
  return (req, res, next) => {
    const filename = String(req.params.filename || '');
    if (!thumbs.isUploadName(filename)) return next();
    const original = `/uploads/${filename}`;
    const derivPath = thumbs.pathFor(filename, kind);

    const serveDeriv = () => {
      res.setHeader('Cache-Control', 'public, max-age=604800');
      res.sendFile(derivPath, (err) => {
        if (err && !res.headersSent) next(err);
      });
    };

    if (fs.existsSync(derivPath)) return serveDeriv();
    if (!fs.existsSync(path.join(thumbs.PUBLIC_UPLOAD_DIR, filename))) return next();
    if (!thumbs.available()) return res.redirect(302, original);

    thumbs
      .ensure(filename, kind)
      .then((ok) => (ok ? serveDeriv() : res.redirect(302, original)))
      .catch(() => res.redirect(302, original));
  };
}
app.get('/uploads/thumb/:filename', derivativeRoute('thumb'));
app.get('/uploads/w1280/:filename', derivativeRoute('w1280'));

// Minified twins of the frontend. scripts/build-assets.js - run on the server,
// where esbuild is installed globally - writes public/js/*.min.js and
// public/css/*.min.css beside the readable originals the markup references.
// When a twin exists the request is re-pointed at it and express.static does
// the rest: same no-cache policy, same etag discipline, and the Content-Type
// comes from the .min extension exactly as from the original. A box with no
// twins (this Windows editing mount, where esbuild is not installed) serves the
// originals untouched, so generating the output is never a deploy prerequisite.
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const m = /^\/(js|css)\/([A-Za-z0-9._-]+)\.(js|css)$/.exec(req.path);
  if (!m || m[2].endsWith('.min')) return next();
  const twin = `${m[2]}.min.${m[3]}`;
  if (!fs.existsSync(path.join(__dirname, '..', 'public', m[1], twin))) return next();
  req.url = `/${m[1]}/${twin}`;
  next();
});

app.use(
  express.static(path.join(__dirname, '..', 'public'), {
    etag: true,
    setHeaders: (res, filePath) => {
      if (/\.(html|js|css)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      } else if (/[\\/]fonts[\\/]/i.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (/[\\/]uploads[\\/]/i.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=604800');
      }
    },
  })
);

// Fallback 404 for unknown API routes — must come AFTER every route above
app.use('/api', (req, res) => res.status(404).json({ error: 'Không tìm thấy endpoint.' }));

// Error handler.
//
// A client error is reported as one. Everything used to become a 500, which meant a
// body over the size limit - the very case the limit exists for - looked like a
// server fault to the caller and to any monitoring watching for 5xx. body-parser
// (and multer) set `status`/`statusCode` on their errors; anything in the 4xx range
// is the caller's fault and its message is safe to pass on, since these are
// generated by the framework rather than containing internal detail.
//
// A genuine 500 still returns a fixed message: an exception's text can carry file
// paths, SQL, or values from the request, none of which belong in a response.
app.use((err, req, res, next) => {
  const status = Number(err.status || err.statusCode) || 500;
  if (status >= 400 && status < 500) {
    if (status === 413) {
      return res.status(413).json({ error: 'Dữ liệu gửi lên quá lớn.' });
    }
    return res.status(status).json({ error: err.message || 'Yêu cầu không hợp lệ.' });
  }
  console.error(err);
  // A reader whose request died in the server gets the maintenance notice, not
  // a line of JSON: the browser would print that JSON as the whole page, which
  // is a worse answer than the card the site shows on purpose. API callers keep
  // JSON - they parse it - and so does anything that did not ask for HTML.
  if (!req.path.startsWith('/api') && req.accepts && req.accepts('html')) {
    return maintenance.sendPage(res, 503);
  }
  res.status(500).json({ error: 'Đã có lỗi xảy ra ở máy chủ.' });
});

// Reconcile the media table with what is actually in public/uploads before the
// first request arrives: adopt files that have no row (everything uploaded before
// the library existed, or copied in over SSH) and drop rows whose file has gone.
// Without this the library would either hide real files or show broken thumbnails.
const mediaStore = require('./media-store');
const db = require('./db');
{
  const adopted = mediaStore.adoptOrphanFiles();
  const pruned = mediaStore.pruneMissingFiles();
  if (adopted || pruned) {
    console.log(`[media] Đồng bộ thư viện: thêm ${adopted} file có sẵn, bỏ ${pruned} bản ghi thiếu file.`);
  }
}

// OTP rows are never deleted anywhere else (security.md item 17): a code is only
// ever marked `used`, so password_resets/email_verifications grow by one row per
// login/reset attempt forever. Neither table is sensitive the way a session
// table would be - a spent or expired code verifies nothing - but an unbounded
// table is still an unbounded table. `used` rows and anything expired more than
// a day ago are safe to drop; a still-live code (even one already flagged as
// over its attempt limit) is left alone so an in-progress flow cannot be cut off
// by a housekeeping tick landing mid-request.
function cleanupExpiredOtps() {
  const cutoff = "datetime('now', '-1 day')";
  const resets = db
    .prepare(`DELETE FROM password_resets WHERE used = 1 OR expires_at < ${cutoff}`)
    .run().changes;
  const verifications = db
    .prepare(`DELETE FROM email_verifications WHERE used = 1 OR expires_at < ${cutoff}`)
    .run().changes;
  return resets + verifications;
}
{
  const removed = cleanupExpiredOtps();
  if (removed) console.log(`[housekeeping] Dọn ${removed} mã OTP đã dùng/hết hạn.`);
}

// The same reconcile on a six-hour timer, plus a WAL checkpoint. Without it both
// only happened at boot: a file copied into public/uploads over SSH waited for
// the next deploy to appear in the library, and the WAL grew until a checkpoint
// happened to run. Both calls are idempotent and near-free when nothing changed.
setInterval(() => {
  try {
    db.pragma('wal_checkpoint(PASSIVE)');
    const adopted = mediaStore.adoptOrphanFiles();
    const pruned = mediaStore.pruneMissingFiles();
    if (adopted || pruned) {
      console.log(`[media] Đồng bộ định kỳ: thêm ${adopted} file, bỏ ${pruned} bản ghi.`);
    }
    const removed = cleanupExpiredOtps();
    if (removed) console.log(`[housekeeping] Dọn ${removed} mã OTP đã dùng/hết hạn.`);
  } catch (e) {
    console.error('[housekeeping] Dọn dẹp định kỳ thất bại:', e.message);
  }
}, 6 * 60 * 60 * 1000).unref();

// A minified twin older than its own source means every browser is being served
// code the source no longer contains - exactly the trap that once hid a write.js
// fix behind a stale write.min.js, because express.static's twin rewrite prefers
// the .min file whenever one exists. Cheap to detect and miserable to debug by
// eye, so every boot names the stale pairs instead of staying quiet.
function warnStaleMinTwins() {
  const stale = [];
  for (const dir of ['js', 'css']) {
    const base = path.join(__dirname, '..', 'public', dir);
    let names = [];
    try {
      names = fs.readdirSync(base);
    } catch {
      continue;
    }
    for (const name of names) {
      const m = /^([A-Za-z0-9._-]+)\.(js|css)$/.exec(name);
      if (!m || m[1].endsWith('.min')) continue;
      const src = path.join(base, name);
      const twin = path.join(base, `${m[1]}.min.${m[2]}`);
      try {
        if (fs.statSync(twin).mtimeMs < fs.statSync(src).mtimeMs) stale.push(`${dir}/${name}`);
      } catch {
        /* no twin, or it vanished mid-check: nothing to warn about */
      }
    }
  }
  if (stale.length) {
    console.warn(`[assets] Bản .min ĐÃ CŨ hơn nguồn - chạy lại "node scripts/build-assets.js": ${stale.join(', ')}`);
  }
}
warnStaleMinTwins();

app.listen(PORT, HOST, () => {
  console.log(`TuanPA Blog server đang chạy tại http://${HOST}:${PORT}`);
});

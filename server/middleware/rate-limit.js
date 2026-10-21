// In-memory rate limiting, sliding window.
//
// Zero-dependency (no express-rate-limit) for the same reason compress.js has no
// `compression`: node_modules on this project is installed ON THE UBUNTU SERVER
// and the tree is edited over a Samba mount from Windows. An npm install from the
// Windows side re-resolves better-sqlite3 and swaps its ELF .node for a win32
// prebuild, which takes the server down.
//
// Single process only (pm2 without cluster mode), which is what this deployment
// runs. Counters are lost on restart - acceptable: a restart is not something an
// attacker can trigger, and the OTP/password limits that matter most are ALSO
// enforced in the database (see the per-email checks in routes/auth.js).

// ---- Client IP ----
//
// The site is published through a cloudflared tunnel, so every request reaches
// Node from localhost. req.socket.remoteAddress is therefore 127.0.0.1 for the
// whole internet - one shared bucket, which is the same as no limit at all.
//
// CF-Connecting-IP is the header to use: Cloudflare's edge always SETS it and
// overwrites whatever the client sent, so it cannot be spoofed by a caller coming
// through the tunnel. It is only trustworthy while the tunnel is the only way in,
// which is why the app binds to 127.0.0.1 (see server.js) - a request that could
// reach port 3000 directly would be free to invent this header.
//
// X-Forwarded-For is the fallback for a plain nginx deployment. Its leftmost
// entry is client-controlled, so it is taken only when CF-Connecting-IP is absent.
function clientIp(req) {
  const cf = String(req.headers['cf-connecting-ip'] || '').trim();
  if (cf) return cf;
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (fwd) return fwd;
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

// ---- Sliding-window counters ----
//
// One Map per named bucket, holding key -> array of hit timestamps. Entries are
// swept lazily: a key is pruned when it is next touched, and the whole bucket is
// swept once it grows past SWEEP_AT, so a long-running process cannot accumulate
// an entry per visitor IP forever.
const buckets = new Map();
const SWEEP_AT = 5000;

function bucketFor(name) {
  let b = buckets.get(name);
  if (!b) {
    b = new Map();
    buckets.set(name, b);
  }
  return b;
}

function sweep(bucket, windowMs, now) {
  for (const [k, hits] of bucket) {
    if (!hits.some((t) => now - t < windowMs)) bucket.delete(k);
  }
}

// Records one hit and reports whether the caller is now over the limit.
// `count: false` inspects the window without adding to it - used to reject a
// caller that is already locked out without extending their own lockout.
function hit(name, key, windowMs, max, count = true) {
  const bucket = bucketFor(name);
  const now = Date.now();
  const recent = (bucket.get(key) || []).filter((t) => now - t < windowMs);

  if (count) recent.push(now);
  bucket.set(key, recent);
  if (bucket.size > SWEEP_AT) sweep(bucket, windowMs, now);

  const limited = recent.length > max;
  // Seconds until the oldest hit in the window falls out of it, which is when
  // the caller gets their next allowance back.
  const retryAfter = limited ? Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1000)) : 0;
  return { limited, retryAfter, hits: recent.length };
}

// Clears a key. Called after a SUCCESSFUL login so one person fumbling their
// password does not spend the allowance they need moments later.
function reset(name, key) {
  bucketFor(name).delete(key);
}

// Express middleware. `keyFn` defaults to the client IP; pass one that reads the
// body to limit per account instead.
function rateLimit({ name, windowMs, max, keyFn = clientIp, message }) {
  return function rateLimitMiddleware(req, res, next) {
    const key = String(keyFn(req) || 'unknown');
    const { limited, retryAfter } = hit(name, key, windowMs, max);
    if (!limited) return next();
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({
      error: message || `Bạn thao tác quá nhanh. Vui lòng thử lại sau ${retryAfter} giây.`,
      retryAfter,
    });
  };
}

module.exports = { clientIp, rateLimit, hit, reset };

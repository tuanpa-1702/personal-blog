const jwt = require('jsonwebtoken');
const db = require('../db');
// Validated at boot: the process refuses to start without a real secret, so
// there is no `|| 'dev_secret'` fallback anywhere in this file any more. That
// fallback was published in this repository, which meant a deployment whose .env
// failed to load accepted admin tokens signed by anybody.
const { JWT_SECRET } = require('../env');

// The Authorization header is the ONLY place a token is accepted.
//
// There used to be a `req.cookies.token` fallback here. No endpoint ever set that
// cookie, so it was dead code - but dead code with teeth: a cookie is attached by
// the browser automatically, so had anything ever set it (a future change, or a
// script on a sibling subdomain, which can write a cookie for the parent domain),
// every state-changing route would have become CSRF-able overnight, and this app has
// no CSRF tokens anywhere. A header has to be set deliberately by same-origin
// script, which is what makes the current design CSRF-proof by construction.
//
// The one cookie the app does use - `oauth_handoff`, from the Google callback - is
// deliberately NOT read here. It is redeemed once by POST /api/auth/session and
// never authenticates a request on its own.
function getTokenFromReq(req) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice(7);
  return null;
}

// The token is stateless, so a role change or a disable done by an admin would
// otherwise keep working until the JWT expired (7 days by default). Re-reading
// the row on every authenticated request is what makes "Vô hiệu hoá" take effect
// immediately, and it also keeps req.user.role honest after a role change.
//
// token_version is the same idea applied to passwords: it is bumped by every
// password change, so a token minted before the change no longer matches the row
// and is refused. A token issued before this column existed carries no claim at
// all, which reads as 0 and matches the column's default - so the upgrade does
// not sign everybody out.
function loadActiveUser(payload) {
  const row = db
    .prepare(
      'SELECT id, name, email, role, avatar_url, is_active, token_version, deleted_at FROM users WHERE id = ?'
    )
    .get(payload.id);
  // A trashed account is refused exactly like a disabled one: the bin holds the
  // login, so every session it had stops working on the next request rather than
  // at JWT expiry.
  if (!row || !row.is_active || row.deleted_at) return null;
  if (Number(payload.tv || 0) !== Number(row.token_version || 0)) return null;
  return { id: row.id, name: row.name, email: row.email, role: row.role, avatar_url: row.avatar_url };
}

function requireAuth(req, res, next) {
  const token = getTokenFromReq(req);
  if (!token) return res.status(401).json({ error: 'Bạn cần đăng nhập.' });
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return res.status(401).json({ error: 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.' });
  }
  const user = loadActiveUser(payload);
  if (!user) {
    return res.status(401).json({
      error:
        'Phiên đăng nhập không còn hiệu lực (mật khẩu đã đổi, hoặc tài khoản đã bị vô hiệu hoá). Vui lòng đăng nhập lại.',
    });
  }
  req.user = user;
  next();
}

// Attaches req.user if a valid token is present, but does not block the request
function optionalAuth(req, res, next) {
  const token = getTokenFromReq(req);
  if (!token) return next();
  try {
    const user = loadActiveUser(jwt.verify(token, JWT_SECRET));
    if (user) req.user = user;
  } catch (e) {
    // ignore invalid token for optional auth
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Chỉ quản trị viên mới có quyền thực hiện thao tác này.' });
  }
  next();
}

// Only 'admin' and 'editor' can write/edit/delete posts. Self-registered or
// Google-login accounts default to 'readonly' (can read + comment only).
function requireWriter(req, res, next) {
  if (!req.user || !['admin', 'editor'].includes(req.user.role)) {
    return res
      .status(403)
      .json({ error: 'Tài khoản của bạn chỉ có quyền đọc và bình luận. Liên hệ quản trị viên để được cấp quyền viết bài.' });
  }
  next();
}

module.exports = { requireAuth, optionalAuth, requireAdmin, requireWriter };

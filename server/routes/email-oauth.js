const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { getEmailConfig, saveEmailSettings } = require('../email-config');
const { exchangeCodeForRefreshToken, resetTransporter } = require('../mailer');
const { JWT_SECRET } = require('../env');

// Delegated Office 365 OAuth2: the one-time sign-in that produces a refresh
// token for the sending mailbox.
//
// This router is mounted OUTSIDE the admin router on purpose. Microsoft returns
// the user here by a browser redirect, which carries no Authorization header, so
// requireAuth would reject it. Authorisation instead rides in the `state`
// parameter: a short-lived JWT that only /api/admin/email-settings/oauth-url can
// mint, and that only an authenticated admin can request. That doubles as CSRF
// protection - a callback nobody started has no valid state.
const router = express.Router();

const STATE_TTL = '10m';

// A key derived from, but distinct from, JWT_SECRET (security.md item 19).
// Signing the OAuth state with the same key as login tokens meant a bug in
// either verifier could accept the other's token; today that is prevented only
// by `state` carrying `adminId` (not `id`) so loadActiveUser() finds nobody, and
// by `purpose` - both accidental, not structural. HMAC-deriving a second key
// from JWT_SECRET makes the separation real without adding a second secret to
// .env: an attacker who does not already have JWT_SECRET gains nothing, and one
// who does already owns every login token this derivation could protect.
const OAUTH_STATE_SECRET = crypto.createHmac('sha256', JWT_SECRET).update('oauth-state-v1').digest('hex');

function signState(adminId) {
  return jwt.sign({ purpose: 'o365-smtp-oauth', adminId }, OAUTH_STATE_SECRET, {
    expiresIn: STATE_TTL,
  });
}

function verifyState(state) {
  const payload = jwt.verify(String(state || ''), OAUTH_STATE_SECRET);
  if (payload.purpose !== 'o365-smtp-oauth') throw new Error('state không đúng mục đích');
  return payload;
}

// The redirect URI must match the app registration byte for byte. It is derived
// from the configured site address so the value shown in the admin panel and the
// value sent to Microsoft can never drift apart.
//
// No request-host fallback (security.md item 18): `req.get('host')` reflects
// whatever Host header the caller sent, which Cloudflare forwards from the
// client unmodified - a caller could otherwise steer Microsoft's redirect_uri,
// and thus where the OAuth code lands, just by sending a different Host.
// SITE_URL/site_url is required instead; a deployment that has not set either
// gets a clear 400 rather than a redirect URI nobody chose.
function redirectUriFor(req) {
  const cfg = getEmailConfig();
  if (!cfg.siteUrl) {
    const err = new Error('Chưa cấu hình địa chỉ trang (SITE_URL hoặc site_url) - cần thiết để đăng nhập Microsoft.');
    err.status = 400;
    throw err;
  }
  return `${cfg.siteUrl.replace(/\/$/, '')}/api/email-oauth/callback`;
}

function authorizeUrl(req, adminId) {
  const cfg = getEmailConfig();
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: 'code',
    redirect_uri: redirectUriFor(req),
    response_mode: 'query',
    // offline_access is what makes Microsoft return a refresh token; without it
    // the flow yields a one-hour access token and nothing reusable.
    scope: 'https://outlook.office.com/SMTP.Send offline_access',
    state: signState(adminId),
    // Force the account picker so an admin signed in as themselves can still
    // consent as the shared sending mailbox.
    prompt: 'select_account',
    login_hint: cfg.user || '',
  });
  return `https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/authorize?${params}`;
}

// GET /api/email-oauth/callback?code=...&state=...
// Public by necessity (see the note above); every request is still gated on a
// valid signed state.
router.get('/callback', async (req, res) => {
  const done = (status, detail) => {
    const qs = new URLSearchParams({ email_oauth: status });
    if (detail) qs.set('email_oauth_detail', detail);
    res.redirect(`/admin.html?${qs}#email`);
  };

  // Microsoft reports a refused consent here rather than at the token endpoint.
  if (req.query.error) {
    return done('error', String(req.query.error_description || req.query.error).slice(0, 300));
  }

  try {
    verifyState(req.query.state);
  } catch (e) {
    return done('error', 'Liên kết đăng nhập không hợp lệ hoặc đã hết hạn. Hãy bấm lại nút cấp quyền.');
  }

  const code = String(req.query.code || '');
  if (!code) return done('error', 'Microsoft không trả về mã xác thực.');

  const cfg = getEmailConfig();
  if (!cfg.tenantId || !cfg.clientId || !cfg.clientSecret) {
    return done('error', 'Thiếu Tenant ID / Client ID / Client Secret. Lưu cài đặt trước khi cấp quyền.');
  }

  try {
    const refreshToken = await exchangeCodeForRefreshToken({
      tenantId: cfg.tenantId,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      code,
      redirectUri: redirectUriFor(req),
    });
    saveEmailSettings({ refresh_token: refreshToken });
    resetTransporter();
    done('ok');
  } catch (e) {
    // The code itself is never echoed back - only the service's explanation.
    done('error', e.message.slice(0, 300));
  }
});

module.exports = { router, authorizeUrl, redirectUriFor };

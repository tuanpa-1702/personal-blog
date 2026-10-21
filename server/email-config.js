const db = require('./db');
const { getContactEmail } = require('./site');

// Single source of truth for the outgoing-mail configuration.
//
// The values live in their OWN table (`email_settings`), deliberately not in
// `settings`: that one is served by the public, unauthenticated
// GET /api/settings, which would publish the SMTP password to the internet.
// Everything here is reachable only through the admin-only routes in
// routes/admin.js.
//
// Precedence for every field: the admin-editable database value wins; an empty
// value falls back to the matching .env variable, so an existing deployment
// configured purely through .env keeps working untouched after this upgrade.

const PROVIDERS = ['gmail', 'office365', 'office365-oauth', 'office365-oauth-delegated', 'custom'];

// Providers that authenticate with an OAuth2 token instead of a password.
// Microsoft is retiring basic auth for SMTP client submission, and work/school
// tenants usually cannot issue app passwords at all (they are disabled by
// default and are incompatible with accounts required to use modern auth), so
// OAuth2 is the supported path for those tenants.
const OAUTH_PROVIDERS = ['office365-oauth', 'office365-oauth-delegated'];

// Delegated (authorization code) mode sends as the signed-in mailbox owner using
// a stored refresh token. It exists because app-only mode requires a tenant admin
// to run New-ServicePrincipal and Add-MailboxPermission in Exchange Online
// PowerShell; delegated mode needs neither cmdlet, so it works where that access
// is unavailable. The trade-off: a one-time interactive sign-in by the mailbox
// owner, and a refresh token that expires if unused for ~90 days.
const DELEGATED_PROVIDERS = ['office365-oauth-delegated'];

// Host/port/TLS are fixed by the provider for the hosted options, so the admin
// only has to supply credentials. 'custom' exposes them.
const PROVIDER_PRESETS = {
  gmail: { host: 'smtp.gmail.com', port: 465, secure: true },
  office365: { host: 'smtp.office365.com', port: 587, secure: false },
  'office365-oauth': { host: 'smtp.office365.com', port: 587, secure: false },
  'office365-oauth-delegated': { host: 'smtp.office365.com', port: 587, secure: false },
};

const DEFAULTS = {
  provider: 'gmail',
  host: '',
  port: '',
  secure: '1',
  user: '',
  pass: '',
  from_name: '', // blank = the site brand name
  from_email: '', // blank = the login account above
  site_url: '', // blank = SITE_URL from .env; used for links inside emails
  notify_new_post: '1',
  otp_enabled: '1',
  // Sign-up email verification. Separate from otp_enabled so an admin can turn
  // the registration OTP off (falling back to instant sign-up) without also
  // disabling the forgot-password OTP, and vice versa.
  otp_register_enabled: '1',
  // ---- Admin event email (Admin > Thông báo) ----
  // One mail per event, to the `contact_email` setting (Bảng quản trị > Quản lí
  // trang chủ > Email liên hệ) - NOT to from_email: that is the OUTGOING mailbox,
  // and for Gmail/O365 it must match the signing-in account (see
  // deliverabilityWarnings() in mailer.js), so it is usually not the site owner's
  // inbox. Missing contact_email means no send, silently.
  //
  // All four default OFF. Every other toggle here defaults to '1', but those
  // existed before the database did; an upgrade must not start mailing the owner
  // about the first comment nobody opted in to.
  notify_comment_reported: '0',
  notify_new_comment: '0',
  notify_new_user: '0',
  notify_comment_hidden: '0',
  // Office 365 OAuth2. Only read when the provider is one of OAUTH_PROVIDERS;
  // `pass` is unused in those modes.
  tenant_id: '',
  client_id: '',
  client_secret: '',
  // Delegated mode only: obtained once through the admin panel's sign-in link and
  // then exchanged for access tokens. Write-only, like the other secrets.
  refresh_token: '',
};

function ensureEmailSettings() {
  const insert = db.prepare('INSERT OR IGNORE INTO email_settings (key, value) VALUES (?, ?)');
  const tx = db.transaction((entries) => {
    for (const [key, value] of entries) insert.run(key, value);
  });
  tx(Object.entries(DEFAULTS));
}

function readRaw() {
  const out = { ...DEFAULTS };
  for (const row of db.prepare('SELECT key, value FROM email_settings').all()) {
    if (row.key in DEFAULTS) out[row.key] = row.value;
  }
  return out;
}

// The effective configuration: presets applied, .env used as the fallback, and
// booleans/numbers already coerced. This is what the mailer consumes.
// Seeded once at require time (db.js has already created the table by then)
// rather than on every read - getEmailConfig() runs on each outgoing email.
ensureEmailSettings();

function getEmailConfig() {
  const raw = readRaw();
  const provider = PROVIDERS.includes(raw.provider) ? raw.provider : 'gmail';
  const preset = PROVIDER_PRESETS[provider];

  const user = raw.user.trim() || process.env.SMTP_USER || '';
  const pass = raw.pass || process.env.SMTP_APP_PASSWORD || '';

  let host, port, secure;
  if (preset) {
    ({ host, port, secure } = preset);
  } else {
    host = raw.host.trim();
    port = Number(raw.port) || 587;
    secure = raw.secure === '1';
  }

  // OAuth2 replaces the password with a token fetched from Entra, so the
  // app-registration values take the place of `pass` in the readiness check.
  const oauth = OAUTH_PROVIDERS.includes(provider);
  const delegated = DELEGATED_PROVIDERS.includes(provider);
  const tenantId = raw.tenant_id.trim() || process.env.O365_TENANT_ID || '';
  const clientId = raw.client_id.trim() || process.env.O365_CLIENT_ID || '';
  const clientSecret = raw.client_secret || process.env.O365_CLIENT_SECRET || '';
  const refreshToken = raw.refresh_token || process.env.O365_REFRESH_TOKEN || '';

  // A From address on a different domain than the account that signs in fails
  // DMARC at every receiver, whatever relay carries the mail - see
  // deliverabilityWarnings() in mailer.js. Computed here so both the mailer and
  // the admin panel read the same answer.
  const fromEmail = raw.from_email.trim() || user;
  const fromDomainMismatch =
    Boolean(raw.from_email.trim()) &&
    user.includes('@') &&
    fromEmail.toLowerCase().includes('@') &&
    fromEmail.toLowerCase().split('@')[1] !== user.toLowerCase().split('@')[1];

  return {
    provider,
    oauth,
    delegated,
    host,
    port,
    secure,
    user,
    pass,
    tenantId,
    clientId,
    clientSecret,
    refreshToken,
    fromName: raw.from_name.trim(),
    fromEmail,
    fromDomainMismatch,
    siteUrl: (raw.site_url.trim() || process.env.SITE_URL || '').replace(/\/$/, ''),
    notifyNewPost: raw.notify_new_post === '1',
    otpEnabled: raw.otp_enabled === '1',
    otpRegisterEnabled: raw.otp_register_enabled === '1',
    notifyCommentReported: raw.notify_comment_reported === '1',
    notifyNewComment: raw.notify_new_comment === '1',
    notifyNewUser: raw.notify_new_user === '1',
    notifyCommentHidden: raw.notify_comment_hidden === '1',
    // Nothing can be sent without a host and credentials, whatever the toggles
    // say. In OAuth2 mode the credential is the app registration; delegated mode
    // additionally needs the refresh token from the one-time sign-in.
    configured: Boolean(
      host &&
        user &&
        (oauth
          ? tenantId && clientId && clientSecret && (delegated ? refreshToken : true)
          : pass)
    ),
  };
}

// Admin-facing view. The password is NEVER sent back to the browser - only
// whether one is stored, so the form can show "đã lưu" instead of round-tripping
// the secret through the client on every save.
function getEmailSettingsForAdmin() {
  const raw = readRaw();
  const effective = getEmailConfig();
  // Every secret is write-only: stripped here so they never reach the browser.
  const { pass, client_secret, refresh_token, ...safe } = raw;
  return {
    settings: safe,
    passwordSet: Boolean(effective.pass),
    clientSecretSet: Boolean(effective.clientSecret),
    refreshTokenSet: Boolean(effective.refreshToken),
    // contact_email lives in the PUBLIC `settings` table, not in this one, but the
    // banner needs to know whether it is set: an admin who ticks the four event
    // toggles with no recipient address would otherwise wonder why nothing
    // arrives. Boolean only, never the address itself - GET /api/settings already
    // publishes it, but repeating it here would be one more place to keep secret
    // later.
    contactEmailSet: Boolean(getContactEmail()),
    // Where each effective value came from, so the panel can tell the admin that
    // .env is still supplying the account.
    fromEnv: {
      user: !raw.user.trim() && Boolean(process.env.SMTP_USER),
      pass: !raw.pass && Boolean(process.env.SMTP_APP_PASSWORD),
      site_url: !raw.site_url.trim() && Boolean(process.env.SITE_URL),
      tenant_id: !raw.tenant_id.trim() && Boolean(process.env.O365_TENANT_ID),
      client_id: !raw.client_id.trim() && Boolean(process.env.O365_CLIENT_ID),
      client_secret: !raw.client_secret && Boolean(process.env.O365_CLIENT_SECRET),
      refresh_token: !raw.refresh_token && Boolean(process.env.O365_REFRESH_TOKEN),
    },
    effective: {
      host: effective.host,
      port: effective.port,
      secure: effective.secure,
      user: effective.user,
      from: effective.fromEmail,
      fromDomainMismatch: effective.fromDomainMismatch,
      site_url: effective.siteUrl,
      configured: effective.configured,
      oauth: effective.oauth,
      delegated: effective.delegated,
    },
  };
}

function saveEmailSettings(updates) {
  const upsert = db.prepare(
    'INSERT INTO email_settings (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value = @value'
  );
  const tx = db.transaction((entries) => {
    for (const [key, value] of entries) {
      if (!(key in DEFAULTS)) continue; // ignore unknown keys instead of storing junk
      upsert.run({ key, value: String(value ?? '') });
    }
  });
  tx(Object.entries(updates || {}));
}

module.exports = {
  PROVIDERS,
  OAUTH_PROVIDERS,
  DELEGATED_PROVIDERS,
  PROVIDER_PRESETS,
  EMAIL_SETTING_KEYS: Object.keys(DEFAULTS),
  ensureEmailSettings,
  getEmailConfig,
  getEmailSettingsForAdmin,
  saveEmailSettings,
};

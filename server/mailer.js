const nodemailer = require('nodemailer');
const { DEFAULT_SITE_NAME, getContactEmail } = require('./site');
const { getEmailConfig, saveEmailSettings } = require('./email-config');
const crypto = require('node:crypto');
const { signUnsubscribeToken } = require('./unsubscribe-token');
const { stripHtml } = require('./sanitize-html');

// The transporter is cached per configuration rather than forever: the admin can
// change the account or provider at runtime in Admin > Cài đặt email, and the
// old connection pool would keep sending from the previous account. The cache
// key is the part of the config that affects the connection.
let cached = { key: null, transporter: null };

function configKey(cfg) {
  return [cfg.host, cfg.port, cfg.secure, cfg.user, cfg.pass, cfg.tenantId, cfg.clientId, cfg.clientSecret, cfg.refreshToken].join('|');
}

// ---- Office 365 OAuth2 ----
// Exchange Online is retiring basic auth for SMTP client submission, and
// work/school tenants generally cannot issue app passwords, so this is the
// supported way to send through a Microsoft 365 mailbox. Two modes:
//
//   app-only (client_credentials)  - no user interaction, but a tenant admin must
//     run New-ServicePrincipal + Add-MailboxPermission in Exchange Online
//     PowerShell to grant the app access to the mailbox.
//   delegated (refresh_token)      - needs neither cmdlet, so it works without
//     Exchange PowerShell access. Costs one interactive sign-in by the mailbox
//     owner; the resulting refresh token is stored and reused.
//
// The scope differs by mode and is easy to get wrong: app-only uses the
// .default form against outlook.office365.com, while delegated requests the
// named SMTP.Send scope on outlook.office.com. A wrong resource yields an opaque
// 535 at AUTH time rather than an error from the token endpoint.
const OAUTH_SCOPE_APP = 'https://outlook.office365.com/.default';
const OAUTH_SCOPE_DELEGATED = 'https://outlook.office.com/SMTP.Send offline_access';

// Tokens last ~1h. Cached with a 5-minute safety margin so a send that starts
// just before expiry cannot fail mid-connection.
let tokenCache = { key: null, token: null, expiresAt: 0 };

// Posts to the Entra token endpoint and returns the parsed body, throwing with
// the service's own error text - each failure (wrong secret, unknown tenant,
// consent not granted, expired refresh token) needs a different fix, so the
// detail is what makes the admin "Kiểm tra" button useful.
async function postToken(tenantId, params) {
  const url = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const data = await res.json().catch(() => null);

  if (!res.ok || !data || !data.access_token) {
    const detail = (data && (data.error_description || data.error)) || `HTTP ${res.status}`;
    throw new Error(`Không lấy được access token từ Microsoft: ${detail}`);
  }
  return data;
}

async function fetchO365Token(cfg) {
  const key = [cfg.tenantId, cfg.clientId, cfg.clientSecret, cfg.refreshToken].join('|');
  if (tokenCache.key === key && tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  const data = cfg.delegated
    ? await postToken(cfg.tenantId, {
        grant_type: 'refresh_token',
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        refresh_token: cfg.refreshToken,
        scope: OAUTH_SCOPE_DELEGATED,
      })
    : await postToken(cfg.tenantId, {
        grant_type: 'client_credentials',
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        scope: OAUTH_SCOPE_APP,
      });

  // Entra rotates the refresh token on each use. Persisting the new one is what
  // keeps delegated mode working past the old token's lifetime - without this the
  // stored token eventually stops being accepted and email silently dies.
  if (cfg.delegated && data.refresh_token && data.refresh_token !== cfg.refreshToken) {
    try {
      saveEmailSettings({ refresh_token: data.refresh_token });
      cfg.refreshToken = data.refresh_token;
    } catch (e) {
      console.error('[mailer] Không lưu được refresh token mới:', e.message);
    }
  }

  tokenCache = {
    key: [cfg.tenantId, cfg.clientId, cfg.clientSecret, cfg.refreshToken].join('|'),
    token: data.access_token,
    expiresAt: Date.now() + Math.max(0, (Number(data.expires_in) || 3600) - 300) * 1000,
  };
  return tokenCache.token;
}

// Exchanges an authorization code for the initial refresh token. Called by the
// admin panel's OAuth callback after the mailbox owner signs in once.
async function exchangeCodeForRefreshToken({ tenantId, clientId, clientSecret, code, redirectUri }) {
  const data = await postToken(tenantId, {
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    scope: OAUTH_SCOPE_DELEGATED,
  });
  if (!data.refresh_token) {
    throw new Error(
      'Microsoft không trả về refresh token. Kiểm tra app registration đã yêu cầu quyền offline_access chưa.'
    );
  }
  return data.refresh_token;
}

function buildTransporter(cfg) {
  const ehlo = ehloName(cfg);
  const base = {
    host: cfg.host,
    port: cfg.port,
    // The hostname announced in EHLO. nodemailer's default is os.hostname(),
    // which on a server is usually a bare label with no dot in it - and a
    // greeting from a host that is not a name in DNS is one of the first things
    // a receiving MTA notes down about you.
    ...(ehlo ? { name: ehlo } : {}),
    // Gmail on 465 is implicit TLS; Office 365 on 587 starts plaintext and
    // upgrades via STARTTLS, which nodemailer does automatically when
    // secure:false. requireTLS makes that upgrade mandatory instead of optional,
    // so credentials are never sent over a plaintext connection.
    secure: cfg.secure,
    requireTLS: !cfg.secure,
  };

  if (cfg.oauth) {
    // provisionCallback - not accessToken - is the hook for supplying our own
    // token: nodemailer treats `accessToken` strictly as a static string, and
    // its built-in token generator only speaks Google's endpoint. This is called
    // whenever a token is needed, including on retry after a 535, so an expired
    // token repairs itself without restarting the server.
    return nodemailer.createTransport({
      ...base,
      auth: {
        type: 'OAuth2',
        user: cfg.user,
        provisionCallback: (user, renew, callback) => {
          if (renew) tokenCache = { key: null, token: null, expiresAt: 0 };
          fetchO365Token(cfg).then(
            (token) => callback(null, token, tokenCache.expiresAt),
            (err) => callback(err)
          );
        },
      },
    });
  }

  return nodemailer.createTransport({
    ...base,
    auth: { user: cfg.user, pass: cfg.pass },
  });
}

function getTransporter() {
  const cfg = getEmailConfig();
  if (!cfg.configured) return null;

  const key = configKey(cfg);
  if (cached.key !== key) {
    cached = { key, transporter: buildTransporter(cfg) };
  }
  return cached.transporter;
}

// Called after the admin saves new settings so the very next send uses them even
// if the connection details happen to hash the same way.
function resetTransporter() {
  cached = { key: null, transporter: null };
  // Drop the token too: the admin may have switched tenant or rotated the
  // secret, and a cached token from the old app registration would still be
  // valid for up to an hour.
  tokenCache = { key: null, token: null, expiresAt: 0 };
}

function fromHeader(cfg, brandName) {
  const brand = cfg.fromName || brandName || DEFAULT_SITE_NAME;
  return `"${brand}" <${cfg.fromEmail}>`;
}

// The domain the message claims to be from.
function mailDomain(cfg) {
  const at = String(cfg.fromEmail || '').lastIndexOf('@');
  return at > -1 ? cfg.fromEmail.slice(at + 1).toLowerCase() : '';
}

// nodemailer's default Message-ID is `<random@os.hostname()>` - on a server
// whose hostname is a bare label that is a Message-ID whose domain is not a
// domain, one of the oldest and cheapest spam heuristics there is, and it fires
// on every message no matter which relay carried it. So every send gets an
// explicit id under the From address's own domain.
function messageIdFor(cfg) {
  return `<${crypto.randomUUID()}@${mailDomain(cfg) || 'localhost'}>`;
}

// What we announce in EHLO: the site's own host when we know it - a name that
// resolves in public DNS, which is the whole point - otherwise mail.<domain>.
function ehloName(cfg) {
  try {
    if (cfg.siteUrl) return new URL(cfg.siteUrl).hostname;
  } catch {
    // an unparseable site_url is not worth failing a send over
  }
  const domain = mailDomain(cfg);
  return domain ? `mail.${domain}` : '';
}

// One door for every send, so the Message-ID fix cannot be missed by a future
// caller that reaches for the transporter directly.
function deliver(t, cfg, msg) {
  return t.sendMail({ ...msg, messageId: messageIdFor(cfg) });
}

// The configuration mistakes that get system mail spam-folded on every relay at
// once, named in the test-email result rather than in a log nobody reads:
//
//   From on another domain than the account that signed in. The receiver runs
//   DMARC against the FROM domain, while SPF and DKIM align to the relay's
//   domain - the check fails, and a From domain carrying a p=quarantine DMARC
//   policy (as many corporate domains do) then quarantines its own mail.
//   Through Gmail or O365 the From has to be the authenticated account, or an
//   alias verified on that same provider.
//   No site URL: not a spam signal, but every link in the notification then
//   points nowhere, and a mail whose links die is a mail people report.
function deliverabilityWarnings(cfg) {
  const warnings = [];
  if (cfg.fromDomainMismatch) {
    warnings.push(
      `Địa chỉ người gửi (${cfg.fromEmail}) khác domain của tài khoản SMTP (${cfg.user}). Máy chủ nhận đối chiếu DMARC theo domain người gửi trong khi SPF/DKIM căn theo domain máy chủ gửi - lệch nhau là thư vào spam. Khi gửi qua Gmail hoặc O365, người gửi phải đúng tài khoản đăng nhập (hoặc alias đã xác nhận trên chính nhà cung cấp đó).`
    );
  }
  if (!cfg.siteUrl) {
    warnings.push(
      'Chưa cấu hình địa chỉ trang (site_url): link bài viết và link tắt thông báo trong email thông báo sẽ hỏng.'
    );
  }
  return warnings;
}

// Verifies the SMTP connection and credentials without sending anything, then
// optionally sends a test message. Used by the "Gửi email thử" button in the
// admin panel so a misconfiguration is caught there instead of silently at the
// moment a user asks for an OTP.
async function verifyAndTest(toEmail, brandName) {
  const cfg = getEmailConfig();
  if (!cfg.configured) {
    let reason;
    if (!cfg.oauth) reason = 'cần máy chủ SMTP, tài khoản và mật khẩu ứng dụng.';
    else if (cfg.delegated && cfg.tenantId && cfg.clientId && cfg.clientSecret && !cfg.refreshToken) {
      reason = 'còn thiếu bước đăng nhập Microsoft. Nhấn "Đăng nhập Microsoft để cấp quyền" ở trên.';
    } else if (cfg.delegated) {
      reason = 'cần hộp thư gửi, Tenant ID, Client ID, Client Secret và một lần đăng nhập Microsoft.';
    } else reason = 'cần hộp thư gửi, Tenant ID, Client ID và Client Secret.';
    throw new Error(`Chưa cấu hình đủ thông tin: ${reason}`);
  }
  const t = getTransporter();
  await t.verify();
  const warnings = deliverabilityWarnings(cfg);
  if (!toEmail) return { verified: true, sent: false, warnings };

  const brand = cfg.fromName || brandName || DEFAULT_SITE_NAME;
  await deliver(t, cfg, {
    from: fromHeader(cfg, brandName),
    to: toEmail,
    subject: `Email thử từ ${brand}`,
    text: `Cấu hình email của ${brand} đang hoạt động bình thường.\n\nMáy chủ: ${cfg.host}:${cfg.port}\nTài khoản: ${cfg.user}`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color:#00236f;">${brand}</h2>
        <p>Cấu hình email đang hoạt động bình thường. Đây là email thử được gửi từ Bảng quản trị.</p>
        <p style="font-size:14px;color:#666;">Máy chủ: <b>${cfg.host}:${cfg.port}</b><br>Tài khoản: <b>${cfg.user}</b></p>
      </div>
    `,
  });
  return { verified: true, sent: true, warnings };
}

// Sends the OTP code to the user's email. Throws if email isn't configured or
// the send fails - the caller decides how to surface that to the client.
async function sendOtpEmail(toEmail, otpCode, brandName) {
  const cfg = getEmailConfig();
  if (!cfg.otpEnabled) {
    throw new Error('Chức năng gửi OTP qua email đang bị tắt trong Bảng quản trị > Cài đặt email.');
  }
  const t = getTransporter();
  if (!t) throw new Error('Chức năng gửi email chưa được cấu hình. Vào Bảng quản trị > Cài đặt email để thiết lập.');

  const brand = cfg.fromName || brandName || DEFAULT_SITE_NAME;

  await deliver(t, cfg, {
    from: fromHeader(cfg, brandName),
    to: toEmail,
    subject: `Mã OTP đặt lại mật khẩu - ${brand}`,
    text: `Mã OTP của bạn là: ${otpCode}\n\nMã có hiệu lực trong 10 phút. Nếu bạn không yêu cầu đặt lại mật khẩu, vui lòng bỏ qua email này.`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color:#00236f;">${brand}</h2>
        <p>Bạn (hoặc ai đó) đã yêu cầu đặt lại mật khẩu cho tài khoản gắn với email này.</p>
        <p style="font-size:14px;color:#666;">Mã OTP của bạn:</p>
        <p style="font-size:32px;font-weight:bold;letter-spacing:6px;color:#00236f;">${otpCode}</p>
        <p style="font-size:14px;color:#666;">Mã có hiệu lực trong <b>10 phút</b>. Nếu bạn không yêu cầu việc này, vui lòng bỏ qua email.</p>
      </div>
    `,
  });
}

// Sends the sign-up verification code. Separate from sendOtpEmail() because the
// body has to say what the code is FOR: someone who just registered and receives
// a "reset your password" email reasonably concludes their account was breached.
// Gated on its own toggle so registration verification and forgot-password can
// be switched independently.
async function sendVerificationEmail(toEmail, otpCode, brandName) {
  const cfg = getEmailConfig();
  if (!cfg.otpRegisterEnabled) {
    throw new Error('Chức năng xác thực email khi đăng ký đang bị tắt trong Bảng quản trị > Cài đặt email.');
  }
  const t = getTransporter();
  if (!t) throw new Error('Chức năng gửi email chưa được cấu hình. Vào Bảng quản trị > Cài đặt email để thiết lập.');

  const brand = cfg.fromName || brandName || DEFAULT_SITE_NAME;

  await deliver(t, cfg, {
    from: fromHeader(cfg, brandName),
    to: toEmail,
    subject: `Mã xác thực email đăng ký - ${brand}`,
    text: `Mã xác thực của bạn là: ${otpCode}\n\nNhập mã này để hoàn tất đăng ký tài khoản tại ${brand}. Mã có hiệu lực trong 10 phút.\n\nNếu bạn không đăng ký tài khoản nào, vui lòng bỏ qua email này - sẽ không có tài khoản nào được tạo.`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color:#00236f;">${brand}</h2>
        <p>Cảm ơn bạn đã đăng ký tài khoản. Nhập mã bên dưới để xác thực địa chỉ email này và hoàn tất đăng ký.</p>
        <p style="font-size:14px;color:#666;">Mã xác thực của bạn:</p>
        <p style="font-size:32px;font-weight:bold;letter-spacing:6px;color:#00236f;">${otpCode}</p>
        <p style="font-size:14px;color:#666;">Mã có hiệu lực trong <b>10 phút</b>. Nếu bạn không đăng ký tài khoản nào, vui lòng bỏ qua email này - sẽ không có tài khoản nào được tạo.</p>
      </div>
    `,
  });
}

// Notifies every user who opted in (email_notifications = 1) that a new post
// was published. Sends are best-effort and run in the background - failures
// are logged but never block the post-creation response to the author.
async function sendNewPostNotifications(recipients, post, brandName) {
  const cfg = getEmailConfig();
  if (!cfg.notifyNewPost) return; // turned off by the admin
  const t = getTransporter();
  if (!t) return; // not configured - silently skip, nothing to notify with

  const brand = cfg.fromName || brandName || DEFAULT_SITE_NAME;
  if (!cfg.siteUrl) {
    console.warn('[mailer] Chưa cấu hình địa chỉ trang (Bảng quản trị > Cài đặt email, hoặc SITE_URL trong .env) - link trong email thông báo sẽ bị hỏng.');
  }
  const postUrl = `${cfg.siteUrl}/post.html?slug=${post.slug}`;

  for (const recipient of recipients) {
    // A plain address still works for any caller that has no id at hand; the
    // post route passes {id, email} so each reader gets THEIR OWN one-click
    // unsubscribe token.
    const email = typeof recipient === 'string' ? recipient : recipient.email;
    const uid = typeof recipient === 'string' ? null : recipient.id;
    const unsubUrl =
      uid && cfg.siteUrl ? `${cfg.siteUrl}/api/users/unsubscribe/${signUnsubscribeToken(uid)}` : '';
    try {
      await deliver(t, cfg, {
        from: fromHeader(cfg, brandName),
        to: email,
        subject: `Bài viết mới trên ${brand}: ${post.title}`,
        // Bulk mail with no one-click way out is mail whose readers press
        // "spam" because they could not find the door - and Gmail and Yahoo
        // require the headers below of bulk senders in the first place. The
        // https form is what Gmail's one-click button POSTs; the mailto form is
        // the fallback for clients that only offer the older kind.
        headers: unsubUrl
          ? {
              'List-Unsubscribe': `<${unsubUrl}>, <mailto:${cfg.fromEmail}?subject=Unsubscribe>`,
              'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
            }
          : undefined,
        // stripHtml for the plain-text part only: the excerpt is sanitized rich
        // HTML (sanitizeRichHtml, server/routes/posts.js) and may carry the
        // author's own bold/italic/link markup, which an email client's
        // plain-text view has no way to render - the html part just below
        // inserts the same value raw, since THAT part can.
        text: `${brand} vừa đăng bài viết mới:\n\n${post.title}\n${stripHtml(post.excerpt || '')}\n\nXem tại: ${postUrl}${unsubUrl ? `\n\nTắt thông báo bài viết mới: ${unsubUrl}` : ''}`,
        html: `
          <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
            <h2 style="color:#00236f;">${brand}</h2>
            <p>Vừa có bài viết mới:</p>
            <h3><a href="${postUrl}" style="color:#00236f;">${post.title}</a></h3>
            ${post.excerpt ? `<p style="color:#666;">${post.excerpt}</p>` : ''}
            <p><a href="${postUrl}" style="display:inline-block;padding:10px 20px;background:#00236f;color:#fff;text-decoration:none;border-radius:6px;">Đọc bài viết</a></p>
            <p style="font-size:12px;color:#999;margin-top:24px;">Bạn nhận được email này vì đã bật thông báo bài viết mới trong trang cá nhân.${unsubUrl ? ` <a href="${unsubUrl}" style="color:#999;">Tắt thông báo</a>` : ''}</p>
          </div>
        `,
      });
    } catch (e) {
      console.error(`Gửi email thông báo tới ${email} thất bại:`, e.message);
    }
  }
}

// ---- Admin event mail (Admin > Thông báo) ------------------------------------
// ONE mail per event, to the site's contact address. The reader-facing templates
// above interpolate post fields RAW because an author writes those; everything
// this one carries was typed by a COMMENTER or a REPORTER, so it all goes through
// escapeHtml() first - a comment body is plain text by design (routes/posts.js)
// and would otherwise arrive as markup in the owner's inbox.
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

// Subject line and the toggle that gates each kind. The toggle names mirror
// getEmailConfig(); server/notifications.js checks the same one before calling,
// and this checks it again so a direct caller cannot bypass the admin's choice.
const ADMIN_EVENT_COPY = {
  comment_reported: {
    toggle: 'notifyCommentReported',
    subject: (brand) => `Bình luận bị báo cáo trên ${brand}`,
    line: () => 'Một người đọc đã đăng nhập báo cáo một bình luận.',
  },
  new_comment: {
    toggle: 'notifyNewComment',
    subject: (brand) => `Bình luận mới trên ${brand}`,
    line: () => 'Vừa có một bình luận mới.',
  },
  new_user: {
    toggle: 'notifyNewUser',
    subject: (brand) => `Người dùng mới đăng ký trên ${brand}`,
    line: () => 'Vừa có một tài khoản mới đăng ký xong.',
  },
  comment_hidden: {
    toggle: 'notifyCommentHidden',
    subject: (brand, event) => `${event.action === 'unhide' ? 'Bỏ ẩn' : 'Ẩn'} bình luận trên ${brand}`,
    line: (event) =>
      event.action === 'unhide'
        ? 'Một quản trị viên vừa bỏ ẩn một bình luận.'
        : 'Một quản trị viên vừa ẩn một bình luận khỏi độc giả.',
  },
};

// Three silent exits, all `return` rather than throw: every caller is a floating
// promise after the response has gone out, so a throw here would be an unhandled
// rejection, not an error anybody reads.
//
// NO List-Unsubscribe here, unlike the reader mail above: this is transactional
// mail to a single address the owner configured, and a one-click button would
// promise a door that does not exist.
async function sendAdminEventEmail(event, brandName) {
  const copy = ADMIN_EVENT_COPY[event && event.kind];
  if (!copy) return;
  const cfg = getEmailConfig();
  if (!cfg[copy.toggle]) return; // the admin left this kind off
  const t = getTransporter();
  if (!t) return; // SMTP not configured - nothing to send with
  const to = getContactEmail();
  if (!to) return; // no recipient configured - skip, never fall back to from_email

  const brand = cfg.fromName || brandName || DEFAULT_SITE_NAME;
  const actor = escapeHtml(event.actor && event.actor.name ? event.actor.name : 'Ai đó');
  const postTitle = escapeHtml(event.post && event.post.title ? event.post.title : '');
  const excerpt = escapeHtml(event.excerpt || '');
  const reason = escapeHtml(event.reason || '');
  const adminUrl = cfg.siteUrl ? `${cfg.siteUrl}/admin.html#notifications` : '';
  const postUrl =
    cfg.siteUrl && event.post && event.post.slug ? `${cfg.siteUrl}/post.html?slug=${event.post.slug}` : '';

  const rows = [
    `<p>${copy.line(event)}</p>`,
    `<p style="font-size:14px;color:#666;">Người thực hiện: <b>${actor}</b></p>`,
    reason ? `<p style="font-size:14px;color:#666;">Lý do: <b>${reason}</b></p>` : '',
    postTitle
      ? `<p style="font-size:14px;color:#666;">Trong bài: <b>${postTitle}</b>${postUrl ? ` - <a href="${postUrl}" style="color:#00236f;">xem</a>` : ''}</p>`
      : '',
    excerpt
      ? `<blockquote style="margin:12px 0;padding:10px 14px;border-left:3px solid #00236f;background:#f4f6fb;color:#333;font-size:14px;">${excerpt}</blockquote>`
      : '',
    adminUrl
      ? `<p><a href="${adminUrl}" style="display:inline-block;padding:10px 20px;background:#00236f;color:#fff;text-decoration:none;border-radius:6px;">Mở Bảng thông báo</a></p>`
      : '',
  ].join('');

  const plain = [
    copy.line(event),
    `Người thực hiện: ${event.actor && event.actor.name ? event.actor.name : 'Ai đó'}`,
    event.reason ? `Lý do: ${event.reason}` : '',
    event.post && event.post.title ? `Trong bài: ${event.post.title}${postUrl ? ` (${postUrl})` : ''}` : '',
    event.excerpt ? `> ${event.excerpt}` : '',
    adminUrl ? `Mở bảng thông báo: ${adminUrl}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  await deliver(t, cfg, {
    from: fromHeader(cfg, brandName),
    to,
    subject: copy.subject(brand, event),
    text: plain,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color:#00236f;">${escapeHtml(brand)}</h2>
        ${rows}
      </div>
    `,
  });
}

module.exports = {
  sendOtpEmail,
  sendVerificationEmail,
  sendNewPostNotifications,
  sendAdminEventEmail,
  verifyAndTest,
  resetTransporter,
  exchangeCodeForRefreshToken,
  OAUTH_SCOPE_DELEGATED,
};

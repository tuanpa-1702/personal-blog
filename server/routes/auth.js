const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const db = require('../db');
const { getSiteName } = require('../site');
const { requireAuth } = require('../middleware/auth');
const { sendOtpEmail, sendVerificationEmail } = require('../mailer');
const { getEmailConfig } = require('../email-config');
const { JWT_SECRET } = require('../env');
const { BCRYPT_ROUNDS, validatePassword } = require('../password');
const { clientIp, rateLimit, hit, reset } = require('../middleware/rate-limit');
// The admin notification inbox: a finished sign-up is one of its four events.
const notifications = require('../notifications');

const router = express.Router();

// One door for "somebody just became a user", because it happens at three places
// and none of them may forget the mail: registration with verification OFF,
// POST /verify-email with it ON, and a first Google sign-in (which also completes
// an abandoned local registration). The row write is synchronous and safe inside
// a caller's transaction; the mail is fire-and-forget and gated on the admin's
// toggle inside notifications.mailAsync().
function notifyNewUser(user) {
  if (!user) return;
  const event = {
    kind: 'new_user',
    actor: { id: user.id, name: user.name },
    excerpt: user.email || '',
  };
  notifications.record(event);
  notifications.mailAsync(event);
}

// `tv` is the token_version of the row at signing time. middleware/auth.js
// compares it against the current column value on every request, so bumping the
// column (which every password change does) invalidates each token minted before
// it - the stolen-token and "log me out everywhere" cases the 7-day expiry alone
// could not handle.
function signToken(user) {
  return jwt.sign(
    {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      avatar_url: user.avatar_url,
      tv: Number(user.token_version || 0),
    },
    JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

// Every password write goes through here, so none of them can forget to bump the
// version and leave old sessions alive. Returns the fresh row.
//
// Deliberately NOT wrapped in db.transaction(): both statements are called from
// inside a caller's transaction (see /reset-password), and while better-sqlite3
// nests those as savepoints, relying on that makes this helper unusable anywhere a
// plain transaction is already open. The two statements are always run together by
// every caller, which is where the atomicity belongs.
function setPassword(userId, plaintext) {
  const hash = bcrypt.hashSync(plaintext, BCRYPT_ROUNDS);
  db.prepare(
    'UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?'
  ).run(hash, userId);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    avatar_url: u.avatar_url,
    cover_image: u.cover_image,
    bio: u.bio,
    status_text: u.status_text,
    location: u.location,
    phone: u.phone,
    role: u.role,
    auth_provider: u.auth_provider,
    email_notifications: !!u.email_notifications,
    is_active: u.is_active === undefined ? true : !!u.is_active,
    email_verified: u.email_verified === undefined ? true : !!u.email_verified,
    created_at: u.created_at,
  };
}

// ---------------- Rate limits ----------------
//
// Every limit here is per client IP, resolved through CF-Connecting-IP because
// the site is published over a cloudflared tunnel (see middleware/rate-limit.js).
// The OTP endpoints ALSO carry per-email limits enforced in the database, which
// is what survives a restart and what stops one address being mail-bombed from
// many IPs; these IP limits are the layer that stops one host hammering the site.

// Password guessing. 10 tries a minute is far beyond a person mistyping and far
// below anything useful for a dictionary attack. A successful login clears the
// counter, so a fumbled password never eats into the next legitimate attempt.
const loginLimit = rateLimit({
  name: 'login',
  windowMs: 60_000,
  max: 10,
  message: 'Bạn đã thử đăng nhập quá nhiều lần. Vui lòng đợi một phút rồi thử lại.',
});

// Account creation. Every call can cost an outgoing email, so this is deliberately
// tight; the per-email hourly cap below is what protects a specific inbox.
const registerLimit = rateLimit({
  name: 'register',
  windowMs: 60 * 60_000,
  max: 10,
  message: 'Đã có quá nhiều lượt đăng ký từ thiết bị này. Vui lòng thử lại sau một giờ.',
});

// Asking for an OTP (either kind).
const otpRequestLimit = rateLimit({
  name: 'otp-request',
  windowMs: 60 * 60_000,
  max: 10,
  message: 'Bạn đã yêu cầu mã xác thực quá nhiều lần. Vui lòng thử lại sau một giờ.',
});

// Redeeming an OTP. This is the brute-force surface: 6 digits is only a million
// possibilities, so the per-code attempt counter in the database is the real
// control and this caps how fast codes can be tried across many addresses at once.
const otpVerifyLimit = rateLimit({
  name: 'otp-verify',
  windowMs: 10 * 60_000,
  max: 20,
  message: 'Bạn đã nhập mã sai quá nhiều lần. Vui lòng đợi vài phút rồi thử lại.',
});

// ---------------- Sign-up email verification (OTP) ----------------

const OTP_TTL_MINUTES = 10;
// Resending faster than this is never the user waiting for a slow mailbox, it is
// a page being hammered - and every resend costs an outgoing email.
const OTP_RESEND_COOLDOWN_SECONDS = 60;
// A hard ceiling per address per hour, so a script cannot use registration as a
// way to mail-bomb somebody else's inbox.
const OTP_MAX_PER_HOUR = 5;
// Wrong guesses allowed against one code before it is burned.
const OTP_MAX_ATTEMPTS = 5;

function sixDigitOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

function otpExpiry() {
  return new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

// Shared by BOTH OTP flows (sign-up verification and password reset): two
// redemption paths comparing the same kind of code two different ways is how
// one of them ends up weaker. timingSafeEqual needs equal lengths, so the
// digests are compared instead of the digits - a wrong-length guess must not
// be distinguishable by response time.
function otpMatches(code, guess) {
  const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();
  return crypto.timingSafeEqual(sha(code), sha(String(guess).trim()));
}

// Seconds still to wait before another code may be sent to this address, or 0.
// Measured from the newest row whether or not it was used, so verifying a code
// and immediately re-registering cannot bypass the cooldown either.
function verificationCooldownLeft(email) {
  const row = db
    .prepare(
      `SELECT CAST((julianday('now') - julianday(created_at)) * 86400 AS INTEGER) AS age
         FROM email_verifications WHERE email = ? ORDER BY id DESC LIMIT 1`
    )
    .get(email);
  if (!row || row.age === null) return 0;
  return Math.max(0, OTP_RESEND_COOLDOWN_SECONDS - row.age);
}

function verificationSentLastHour(email) {
  return db
    .prepare(
      `SELECT COUNT(*) AS c FROM email_verifications
        WHERE email = ? AND datetime(created_at) >= datetime('now', '-1 hour')`
    )
    .get(email).c;
}

// Generates a code, mails it, and only then records it. Mailing first is what
// makes "no account is created when email fails" true without needing to roll
// back: better-sqlite3 transactions are synchronous, so an await cannot sit
// inside one. Returns the row id, or throws with the mailer's own message.
async function issueVerificationCode(email) {
  const otpCode = sixDigitOtp();
  await sendVerificationEmail(email, otpCode, getSiteName());
  return db
    .prepare('INSERT INTO email_verifications (email, otp_code, expires_at) VALUES (?, ?, ?)')
    .run(email, otpCode, otpExpiry()).lastInsertRowid;
}

// ---------------- Local email/password auth ----------------

// POST /api/auth/register
// With verification on (the default), this creates the account with
// email_verified = 0 and mails a 6-digit code; the caller gets no token until
// POST /verify-email succeeds. With the admin toggle off it behaves exactly as
// it did before: account created, token returned immediately.
router.post('/register', registerLimit, async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Vui lòng nhập đầy đủ họ tên, email và mật khẩu.' });
  }
  const passwordError = validatePassword(password);
  if (passwordError) return res.status(400).json({ error: passwordError });
  const normalizedEmail = email.toLowerCase();
  const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  const avatar = `https://api.dicebear.com/7.x/thumbs/svg?seed=${encodeURIComponent(normalizedEmail)}`;
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);

  if (!getEmailConfig().otpRegisterEnabled) {
    // Verification disabled: the pre-OTP behaviour, kept intact so an admin whose
    // mail server is broken can still let people sign up.
    if (existing) return res.status(409).json({ error: 'Email này đã được đăng ký.' });
    const info = db
      .prepare(
        `INSERT INTO users (name, email, password_hash, avatar_url, role, auth_provider, email_verified)
         VALUES (?, ?, ?, ?, 'readonly', 'local', 1)`
      )
      .run(name, normalizedEmail, hash, avatar);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    // The account is live right here - a token goes out with this response - so
    // this is a signup, and the owner's notification is recorded before the reply
    // and mailed after it. notifyNewUser() is a no-op when the toggle is off.
    notifyNewUser(user);
    return res.status(201).json({ token: signToken(user), user: publicUser(user) });
  }

  // An account that finished verification, or a Google one (Google already
  // proved the address), is taken. A row still sitting at email_verified = 0 is
  // NOT: without this, one abandoned sign-up would hold that address forever
  // because of UNIQUE(email). Overwriting it cannot hijack anything - whoever
  // continues still has to read the code mailed to that same inbox.
  if (existing && (existing.email_verified || existing.auth_provider === 'google')) {
    return res.status(409).json({ error: 'Email này đã được đăng ký.' });
  }

  const pendingBody = {
    pending: true,
    email: normalizedEmail,
    message: `Mã xác thực gồm 6 chữ số đã được gửi tới ${normalizedEmail}. Mã có hiệu lực trong ${OTP_TTL_MINUTES} phút.`,
  };

  // Already holding a fresh code: re-send nothing, but still accept the details
  // so a double-submitted form lands on the OTP step instead of an error.
  const cooldown = verificationCooldownLeft(normalizedEmail);
  if (cooldown > 0) {
    if (existing) {
      db.prepare('UPDATE users SET name = ?, password_hash = ?, avatar_url = ? WHERE id = ?').run(
        name,
        hash,
        existing.avatar_url || avatar,
        existing.id
      );
    }
    return res.json({ ...pendingBody, message: `Mã xác thực vừa được gửi tới ${normalizedEmail}. Vui lòng kiểm tra hộp thư (kể cả mục spam).` });
  }
  if (verificationSentLastHour(normalizedEmail) >= OTP_MAX_PER_HOUR) {
    return res
      .status(429)
      .json({ error: 'Đã gửi quá nhiều mã xác thực tới email này. Vui lòng thử lại sau một giờ.' });
  }

  let otpRowId;
  try {
    otpRowId = await issueVerificationCode(normalizedEmail);
  } catch (e) {
    console.error('Gửi email xác thực đăng ký thất bại:', e.message);
    // Nothing was written, so there is no half-made account to clean up.
    return res.status(503).json({
      error:
        'Không gửi được mã xác thực tới email này nên chưa thể tạo tài khoản. Vui lòng kiểm tra lại địa chỉ email hoặc thử lại sau.',
    });
  }

  // The code is out; record the account so it can be verified. Wrapped in a
  // transaction so a failure here cannot leave a user row without its code row
  // (or the reverse), which would strand the address in an unverifiable state.
  try {
    db.transaction(() => {
      if (existing) {
        // token_version is bumped along with the password here too: the row being
        // overwritten is an abandoned, never-verified sign-up, and this guarantees
        // nothing minted against the old password stays usable.
        db.prepare(
          `UPDATE users SET name = ?, password_hash = ?, avatar_url = ?, email_verified = 0,
                            token_version = token_version + 1
             WHERE id = ?`
        ).run(name, hash, existing.avatar_url || avatar, existing.id);
      } else {
        // Self-registered accounts default to 'readonly': can read + comment only.
        // An admin can promote them to 'editor' or 'admin' from the admin panel.
        db.prepare(
          `INSERT INTO users (name, email, password_hash, avatar_url, role, auth_provider, email_verified)
           VALUES (?, ?, ?, ?, 'readonly', 'local', 0)`
        ).run(name, normalizedEmail, hash, avatar);
      }
    })();
  } catch (e) {
    // The mailed code can never be redeemed now, so retire it rather than leave
    // a live code pointing at no account.
    db.prepare('UPDATE email_verifications SET used = 1 WHERE id = ?').run(otpRowId);
    throw e;
  }

  res.json(pendingBody);
});

// POST /api/auth/verify-email { email, otp }
// Completes registration: flips email_verified and signs the user straight in,
// so "register -> you are logged in" still holds, just with a step in between.
router.post('/verify-email', otpVerifyLimit, (req, res) => {
  const { email, otp } = req.body || {};
  if (!email || !otp) {
    return res.status(400).json({ error: 'Vui lòng nhập email và mã xác thực.' });
  }
  const normalizedEmail = String(email).toLowerCase();

  const latest = db
    .prepare(
      `SELECT * FROM email_verifications
        WHERE email = ? AND used = 0 AND datetime(expires_at) >= datetime('now')
        ORDER BY id DESC LIMIT 1`
    )
    .get(normalizedEmail);

  if (!latest) {
    return res.status(400).json({ error: 'Mã xác thực không đúng hoặc đã hết hạn. Vui lòng bấm "Gửi lại mã".' });
  }
  if (latest.attempts >= OTP_MAX_ATTEMPTS) {
    return res
      .status(400)
      .json({ error: 'Bạn đã nhập sai quá nhiều lần. Mã này đã bị vô hiệu, vui lòng bấm "Gửi lại mã".' });
  }
  if (!otpMatches(latest.otp_code, otp)) {
    const attempts = latest.attempts + 1;
    db.prepare('UPDATE email_verifications SET attempts = ? WHERE id = ?').run(attempts, latest.id);
    const left = OTP_MAX_ATTEMPTS - attempts;
    return res.status(400).json({
      error:
        left > 0
          ? `Mã xác thực không đúng. Bạn còn ${left} lần thử.`
          : 'Mã xác thực không đúng. Mã này đã bị vô hiệu, vui lòng bấm "Gửi lại mã".',
    });
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);
  if (!user) {
    return res.status(404).json({ error: 'Không tìm thấy tài khoản cần xác thực. Vui lòng đăng ký lại.' });
  }
  if (!user.is_active) {
    return res.status(403).json({ error: 'Tài khoản này đã bị vô hiệu hoá. Vui lòng liên hệ quản trị viên.' });
  }
  // This route hands out a token, so it is a way IN and has to refuse the bin the
  // same way /login does: an OTP sent before an admin deleted the account must not
  // complete the sign-in afterwards.
  if (user.deleted_at) {
    return res.status(403).json({ error: 'Tài khoản này đã bị xoá. Vui lòng liên hệ quản trị viên.' });
  }

  // Every outstanding code for the address is spent, not just the one matched:
  // an older code left live would still be redeemable after this.
  const wasUnverified = !user.email_verified;
  db.transaction(() => {
    db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(user.id);
    db.prepare('UPDATE email_verifications SET used = 1 WHERE email = ? AND used = 0').run(normalizedEmail);
  })();

  const verified = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  // THIS is the signup when verification is on: the row above was created
  // unverified and could not log in. Guarded on the flip so a re-submitted code
  // for an already-verified account does not announce a second new user.
  if (wasUnverified) notifyNewUser(verified);
  res.json({ token: signToken(verified), user: publicUser(verified), message: 'Xác thực email thành công.' });
});

// POST /api/auth/resend-verification { email }
router.post('/resend-verification', otpRequestLimit, async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Vui lòng nhập email.' });
  const normalizedEmail = String(email).toLowerCase();

  // Same reasoning as /forgot-password: the response must not reveal whether the
  // address has an account, nor whether that account is still unverified.
  const genericOk = {
    ok: true,
    message: 'Nếu email này đang chờ xác thực, mã mới đã được gửi tới hộp thư.',
  };

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);
  // A trashed account is treated like a verified or disabled one: the generic reply
  // goes out and no mail does, so the bin cannot be used to keep mailing an address
  // the site has already deleted.
  if (!user || user.email_verified || !user.is_active || user.deleted_at || user.auth_provider !== 'local') {
    return res.json(genericOk);
  }
  const cooldown = verificationCooldownLeft(normalizedEmail);
  if (cooldown > 0) {
    return res.status(429).json({ error: `Vui lòng đợi ${cooldown} giây trước khi yêu cầu mã mới.` });
  }
  if (verificationSentLastHour(normalizedEmail) >= OTP_MAX_PER_HOUR) {
    return res
      .status(429)
      .json({ error: 'Đã gửi quá nhiều mã xác thực tới email này. Vui lòng thử lại sau một giờ.' });
  }

  try {
    await issueVerificationCode(normalizedEmail);
  } catch (e) {
    console.error('Gửi lại email xác thực thất bại:', e.message);
    return res.status(503).json({ error: 'Không gửi được mã xác thực lúc này. Vui lòng thử lại sau.' });
  }
  res.json(genericOk);
});


// ---------------- Email-first sign-in: which step does this address need? ----------------

// The client asks this before showing any password field, so the modal can send
// the visitor to the password step, the sign-up step, the OTP step, or Google.
// It necessarily confirms whether an address is registered - unavoidable in an
// email-first flow, and the same is true of Google's and Slack's - so the cost
// of asking is capped per IP rather than pretended away.
//
// This used to carry its own hand-rolled counter and its own clientIp() that read
// only X-Forwarded-For. Both now come from middleware/rate-limit.js, which reads
// CF-Connecting-IP first - the header Cloudflare sets and overwrites, so it cannot
// be forged by a caller arriving through the tunnel. The old version could be
// bypassed by sending any X-Forwarded-For value.
const checkEmailLimit = rateLimit({
  name: 'check-email',
  windowMs: 60_000,
  max: 20,
  message: 'Bạn thao tác quá nhanh. Vui lòng thử lại sau một phút.',
});

// POST /api/auth/check-email { email }
// -> { email, exists, provider, pendingVerification }
router.post('/check-email', checkEmailLimit, (req, res) => {
  const { email } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
    return res.status(400).json({ error: 'Vui lòng nhập một địa chỉ email hợp lệ.' });
  }
  const normalizedEmail = String(email).trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);

  // A row still at email_verified = 0 is not a usable account: /register treats
  // that address as free, so this must report it the same way - as needing the
  // OTP, which is what the client shows next.
  if (!user || (!user.email_verified && user.auth_provider === 'local')) {
    return res.json({
      email: normalizedEmail,
      exists: !!user,
      provider: user ? user.auth_provider : null,
      // A never-verified local row can still be finished with a code, so the
      // client offers the OTP step rather than a fresh sign-up form.
      pendingVerification: !!user,
    });
  }
  // A disabled account reports as existing: the password step then returns the
  // real "đã bị vô hiệu hoá" message, which is more useful than sending someone
  // to a sign-up form that would refuse them at 409.
  res.json({
    email: normalizedEmail,
    exists: true,
    provider: user.auth_provider,
    pendingVerification: false,
  });
});

// POST /api/auth/login
//
// Two counters, both required. The IP limit (loginLimit, applied as middleware)
// stops one host walking a dictionary; the per-email counter below stops a
// distributed attempt at ONE account, which the IP limit alone cannot see. A
// successful login clears both, so somebody who mistypes twice and then gets it
// right keeps their full allowance.
//
// The per-email counter is checked and incremented ONLY after a wrong password
// (or an unknown account), and never blocks a CORRECT one. It used to be
// checked first, before the password was even read - which meant knowing
// someone's email was enough to lock them out of their own account: ten wrong
// guesses from anywhere (this counter is not per-IP) bought 15 minutes during
// which even the real owner's correct password was refused, and repeating that
// roughly once every 15 minutes kept the account locked indefinitely, with no
// need to ever guess right. Ordering the check after a successful compare closes
// that: a demonstrated-correct password always gets in, so this counter can only
// ever slow down someone who does NOT know the password, exactly the case it was
// meant for.
const LOGIN_MAX_PER_EMAIL = 10;
const LOGIN_EMAIL_WINDOW_MS = 15 * 60_000;

router.post('/login', loginLimit, (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Vui lòng nhập email và mật khẩu.' });
  }
  const normalizedEmail = String(email).toLowerCase();
  const ip = clientIp(req);

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);
  const passwordOk = !!user && bcrypt.compareSync(password, user.password_hash);
  if (!passwordOk) {
    // Checked with count:false so a caller who is already locked out cannot
    // extend their own lockout by continuing to hammer it.
    const locked = hit('login-email', normalizedEmail, LOGIN_EMAIL_WINDOW_MS, LOGIN_MAX_PER_EMAIL, false);
    if (locked.limited) {
      res.set('Retry-After', String(locked.retryAfter));
      return res.status(429).json({
        error: `Có quá nhiều lượt đăng nhập sai cho email này. Vui lòng thử lại sau ${Math.ceil(
          locked.retryAfter / 60
        )} phút, hoặc dùng "Quên mật khẩu".`,
        retryAfter: locked.retryAfter,
      });
    }
    hit('login-email', normalizedEmail, LOGIN_EMAIL_WINDOW_MS, LOGIN_MAX_PER_EMAIL);
    return res.status(401).json({ error: 'Email hoặc mật khẩu không đúng.' });
  }
  // Checked after the password so a wrong password on a disabled account still
  // reads as "wrong password" - it does not confirm the account exists.
  if (!user.is_active) {
    return res.status(403).json({ error: 'Tài khoản này đã bị vô hiệu hoá. Vui lòng liên hệ quản trị viên.' });
  }
  // Same placement, same reason. A trashed account is gone as far as signing in
  // is concerned; loadActiveUser() would refuse its token on the next request
  // anyway, so refusing it here just says so one round-trip sooner.
  if (user.deleted_at) {
    return res.status(403).json({ error: 'Tài khoản này đã bị xoá. Vui lòng liên hệ quản trị viên.' });
  }
  // Same placement, same reason: only someone who already knows the password
  // learns that this address is registered but unverified. The code lets the
  // client jump straight to the OTP step instead of making them register again.
  if (!user.email_verified && user.auth_provider === 'local') {
    return res.status(403).json({
      error: 'Email của bạn chưa được xác thực. Vui lòng nhập mã xác thực đã được gửi tới hộp thư của bạn.',
      code: 'EMAIL_NOT_VERIFIED',
      email: user.email,
    });
  }
  reset('login-email', normalizedEmail);
  reset('login', ip);
  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Không tìm thấy người dùng.' });
  res.json({ user: publicUser(user) });
});

// PUT /api/auth/me  (update name, bio, avatar_url)
//
// Every field here is written by any signed-in account, including a
// self-registered 'readonly' one, and every field is then rendered on a page other
// people load - the name and avatar beside each comment, the name in the admin
// user list. Nothing validated them before: no length ceiling (a bio was capped
// only by express.json's 10 MB) and no check on the avatar URL, which is written
// straight into an <img src> where escaping does nothing about the scheme.
const MAX_NAME_CHARS = 100;
const MAX_BIO_CHARS = 1000;
const MAX_URL_CHARS = 2000;
const MAX_LOCATION_CHARS = 100;
const MAX_PHONE_CHARS = 30;
// A "thanh trạng thái" line, not a paragraph - the bio already covers that.
// Newlines are flattened rather than rejected: pasting a couple of lines
// here is a mistake worth tolerating silently, the way a <input> would have
// truncated them to one line by construction if this were rendered through
// one (which it is, on the profile card - see profile.js).
const MAX_STATUS_CHARS = 200;
function cleanStatusText(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_STATUS_CHARS);
}

// Location and phone: same single-line convention as the status line above
// (a paste with a stray newline is flattened rather than rejected), just a
// shared shape since neither is a distinct enough rule to need its own
// function the way the status line's own comment above justifies.
function cleanOneLine(value, maxChars) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, maxChars);
}

// Only the two shapes this app produces: a path from POST /api/upload, or an
// https URL for an externally hosted image (dicebear supplies the defaults).
function safeAvatarUrl(value, fallback) {
  const url = String(value ?? '').trim();
  if (!url) return '';
  if (url.length > MAX_URL_CHARS) return fallback;
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  return /^https?:\/\//i.test(url) ? url : fallback;
}

router.put('/me', requireAuth, (req, res) => {
  const { name, bio, avatar_url, cover_image, status_text, location, phone, email_notifications } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Không tìm thấy người dùng.' });

  if (name !== undefined) {
    const trimmed = String(name).trim();
    if (!trimmed) return res.status(400).json({ error: 'Họ tên không được để trống.' });
    if (trimmed.length > MAX_NAME_CHARS) {
      return res.status(400).json({ error: `Họ tên quá dài (tối đa ${MAX_NAME_CHARS} ký tự).` });
    }
  }
  if (bio !== undefined && String(bio).length > MAX_BIO_CHARS) {
    return res.status(400).json({ error: `Giới thiệu quá dài (tối đa ${MAX_BIO_CHARS} ký tự).` });
  }

  db.prepare(
    'UPDATE users SET name = ?, bio = ?, avatar_url = ?, cover_image = ?, status_text = ?, location = ?, phone = ?, email_notifications = ? WHERE id = ?'
  ).run(
    name !== undefined ? String(name).trim() : user.name,
    bio !== undefined ? String(bio) : user.bio,
    avatar_url !== undefined ? safeAvatarUrl(avatar_url, user.avatar_url) : user.avatar_url,
    // Same allowlist as the avatar - a path from POST /api/upload or an https
    // URL - the cover reaches an <img src> exactly the same way.
    cover_image !== undefined ? safeAvatarUrl(cover_image, user.cover_image) : user.cover_image,
    status_text !== undefined ? cleanStatusText(status_text) : user.status_text,
    location !== undefined ? cleanOneLine(location, MAX_LOCATION_CHARS) : user.location,
    phone !== undefined ? cleanOneLine(phone, MAX_PHONE_CHARS) : user.phone,
    email_notifications !== undefined ? (email_notifications ? 1 : 0) : user.email_notifications,
    user.id
  );
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  const token = signToken(updated);
  res.json({ token, user: publicUser(updated) });
});

// GET /api/auth/me/activity - the caller's own recent likes and comments,
// newest first, for the "Hoạt động gần đây" panel on profile.html.
//
// Self only, and deliberately: this reads as a private activity log (which
// posts you liked, what you wrote where), not a public one, so it hangs off
// /api/auth/me rather than /api/users/:id - there is no route that answers
// this for anyone else's id. Three UNION ALL branches (post likes, comment
// likes, comments written) rather than three separate requests, so the
// panel gets one already-merged, already-sorted list instead of merging
// three arrays itself; each branch is a plain indexed lookup on the
// caller's own user_id, so none of the three costs more than the id column
// already accounts for at this site's scale.
const ACTIVITY_SQL = `
  SELECT 'liked_post' AS kind, pr.created_at AS at,
         p.slug AS post_slug, p.title AS post_title, NULL AS excerpt
    FROM post_reactions pr
    JOIN posts p ON p.id = pr.post_id
   WHERE pr.user_id = ? AND pr.value = 1 AND p.deleted_at IS NULL AND p.status = 'published'
  UNION ALL
  SELECT 'liked_comment' AS kind, cr.created_at AS at,
         p.slug AS post_slug, p.title AS post_title, c.content AS excerpt
    FROM comment_reactions cr
    JOIN comments c ON c.id = cr.comment_id
    JOIN posts p ON p.id = c.post_id
   WHERE cr.user_id = ? AND cr.value = 1
     AND c.deleted_at IS NULL AND c.hidden_at IS NULL AND p.deleted_at IS NULL
  UNION ALL
  SELECT 'commented' AS kind, c.created_at AS at,
         p.slug AS post_slug, p.title AS post_title, c.content AS excerpt
    FROM comments c
    JOIN posts p ON p.id = c.post_id
   WHERE c.user_id = ? AND c.deleted_at IS NULL AND p.deleted_at IS NULL
   ORDER BY at DESC
   LIMIT 30`;

router.get('/me/activity', requireAuth, (req, res) => {
  const activity = db.prepare(ACTIVITY_SQL).all(req.user.id, req.user.id, req.user.id);
  res.json({ activity });
});

// PUT /api/auth/password
//
// The CURRENT password is required. It used to be enough to hold a valid token,
// which meant a token lifted from localStorage - by an XSS, a shared machine, a
// borrowed laptop - could be turned into permanent ownership of the account in one
// request. Asking for the existing password makes the theft of a token recoverable.
//
// A Google account has no local password to prove (its password_hash is random
// filler), so setting one is allowed with just the session; that is what gives
// those accounts a way to add email/password sign-in.
router.put('/password', requireAuth, (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body || {};
  if (!newPassword || !confirmPassword) {
    return res.status(400).json({ error: 'Vui lòng nhập mật khẩu mới hai lần.' });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ error: 'Hai mật khẩu không khớp nhau.' });
  }
  const passwordError = validatePassword(newPassword);
  if (passwordError) return res.status(400).json({ error: passwordError });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) {
    return res.status(404).json({ error: 'Không tìm thấy người dùng.' });
  }

  if (user.auth_provider === 'local') {
    if (!currentPassword) {
      return res.status(400).json({ error: 'Vui lòng nhập mật khẩu hiện tại.' });
    }
    // Rate-limited per account: this endpoint is otherwise an oracle for guessing
    // the current password of whoever's token you hold.
    const guard = hit('password-change', String(user.id), 15 * 60_000, 10, false);
    if (guard.limited) {
      res.set('Retry-After', String(guard.retryAfter));
      return res
        .status(429)
        .json({ error: 'Bạn đã nhập sai mật khẩu hiện tại quá nhiều lần. Vui lòng thử lại sau.' });
    }
    if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
      hit('password-change', String(user.id), 15 * 60_000, 10);
      return res.status(401).json({ error: 'Mật khẩu hiện tại không đúng.' });
    }
    if (currentPassword === newPassword) {
      return res.status(400).json({ error: 'Mật khẩu mới phải khác mật khẩu hiện tại.' });
    }
  }

  // Bumps token_version, so every other session - including one an attacker is
  // holding - stops working the moment this returns.
  const updated = setPassword(user.id, newPassword);
  reset('password-change', String(user.id));
  // The caller's own token was just invalidated too, so hand back a fresh one or
  // they would be signed out by the very act of changing their password.
  res.json({ ok: true, token: signToken(updated), user: publicUser(updated) });
});

// ---------------- Forgot password (OTP via email) ----------------
//
// This flow was the weakest point in the app. It had NO resend cooldown, NO
// per-address hourly cap, it never retired the previous code, and
// /reset-password counted nothing - so an attacker could ask for a hundred codes,
// leave all hundred valid for ten minutes, and then guess freely against the pool.
// Roughly 10,000 guesses gave better than even odds of hitting one of them.
//
// Four changes close it, and all four are needed:
//   * one live code at a time (the new one retires the old),
//   * a 60-second resend cooldown and a 5-per-hour cap per address,
//   * a wrong-guess counter on the code itself (password_resets.attempts),
//   * an IP limit on both endpoints.
// The numbers mirror the sign-up OTP deliberately: two OTP flows with different
// hardening is how one of them ends up forgotten.

const RESET_TTL_MINUTES = 10;
const RESET_RESEND_COOLDOWN_SECONDS = 60;
const RESET_MAX_PER_HOUR = 5;
const RESET_MAX_ATTEMPTS = 5;

function resetCooldownLeft(email) {
  const row = db
    .prepare(
      `SELECT CAST((julianday('now') - julianday(created_at)) * 86400 AS INTEGER) AS age
         FROM password_resets WHERE email = ? ORDER BY id DESC LIMIT 1`
    )
    .get(email);
  if (!row || row.age === null) return 0;
  return Math.max(0, RESET_RESEND_COOLDOWN_SECONDS - row.age);
}

function resetSentLastHour(email) {
  return db
    .prepare(
      `SELECT COUNT(*) AS c FROM password_resets
        WHERE email = ? AND datetime(created_at) >= datetime('now', '-1 hour')`
    )
    .get(email).c;
}

// POST /api/auth/forgot-password { email }
router.post('/forgot-password', otpRequestLimit, async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Vui lòng nhập email.' });
  const normalizedEmail = String(email).toLowerCase();

  const genericOk = { ok: true, message: 'Nếu email này đã đăng ký, mã OTP đã được gửi tới hộp thư.' };

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);
  if (!user || !user.is_active || user.deleted_at) {
    // Don't reveal whether the email exists (or was disabled, or is in the bin) -
    // respond the same either way. None of the three can log in, so none gets an
    // OTP that would be a way back in.
    return res.json(genericOk);
  }

  // The 429s below do distinguish a registered address from an unregistered one.
  // That is not a new leak: POST /check-email answers the same question outright,
  // by design, because the sign-in flow is email-first.
  const cooldown = resetCooldownLeft(normalizedEmail);
  if (cooldown > 0) {
    return res
      .status(429)
      .json({ error: `Vui lòng đợi ${cooldown} giây trước khi yêu cầu mã mới.`, retryAfter: cooldown });
  }
  if (resetSentLastHour(normalizedEmail) >= RESET_MAX_PER_HOUR) {
    return res
      .status(429)
      .json({ error: 'Đã gửi quá nhiều mã OTP tới email này. Vui lòng thử lại sau một giờ.' });
  }

  const otpCode = String(crypto.randomInt(100000, 1000000)); // 6 digits
  const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');

  // Mailed BEFORE the row is written, same as issueVerificationCode(): a send that
  // fails then leaves no live code behind, and better-sqlite3 transactions are
  // synchronous so an await cannot sit inside one anyway.
  try {
    await sendOtpEmail(user.email, otpCode, getSiteName());
  } catch (e) {
    console.error('Gửi email OTP thất bại:', e.message);
    return res.status(500).json({ error: 'Không thể gửi email OTP lúc này. Vui lòng thử lại sau.' });
  }

  // Retiring every earlier code in the same transaction is what keeps exactly one
  // guessable code alive per address.
  db.transaction(() => {
    db.prepare('UPDATE password_resets SET used = 1 WHERE email = ? AND used = 0').run(user.email);
    db.prepare('INSERT INTO password_resets (email, otp_code, expires_at) VALUES (?, ?, ?)').run(
      user.email,
      otpCode,
      expiresAt
    );
  })();

  res.json(genericOk);
});

// POST /api/auth/reset-password { email, otp, newPassword }
router.post('/reset-password', otpVerifyLimit, (req, res) => {
  const { email, otp, newPassword } = req.body || {};
  if (!email || !otp || !newPassword) {
    return res.status(400).json({ error: 'Vui lòng nhập đầy đủ email, mã OTP và mật khẩu mới.' });
  }
  const passwordError = validatePassword(newPassword);
  if (passwordError) return res.status(400).json({ error: passwordError });
  const normalizedEmail = String(email).toLowerCase();

  // The newest unused, unexpired code for this address - NOT one matched by the
  // submitted digits. Selecting by otp_code (as this did before) meant a wrong
  // guess found no row and so could never be counted, which is what made the
  // attempt counter impossible to add.
  const pending = db
    .prepare(
      `SELECT * FROM password_resets
        WHERE email = ? AND used = 0 AND datetime(expires_at) >= datetime('now')
        ORDER BY id DESC LIMIT 1`
    )
    .get(normalizedEmail);

  if (!pending) {
    return res.status(400).json({ error: 'Mã OTP không đúng hoặc đã hết hạn.' });
  }
  if (pending.attempts >= RESET_MAX_ATTEMPTS) {
    return res.status(400).json({
      error: 'Bạn đã nhập sai quá nhiều lần. Mã này đã bị vô hiệu, vui lòng yêu cầu mã mới.',
    });
  }
  // Same constant-time comparison as /verify-email - both flows redeem a 6-digit
  // code, and two flows with different hardening is how one gets forgotten.
  if (!otpMatches(pending.otp_code, otp)) {
    const attempts = pending.attempts + 1;
    db.prepare('UPDATE password_resets SET attempts = ? WHERE id = ?').run(attempts, pending.id);
    const left = RESET_MAX_ATTEMPTS - attempts;
    return res.status(400).json({
      error:
        left > 0
          ? `Mã OTP không đúng. Bạn còn ${left} lần thử.`
          : 'Mã OTP không đúng. Mã này đã bị vô hiệu, vui lòng yêu cầu mã mới.',
    });
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);
  if (!user) return res.status(404).json({ error: 'Không tìm thấy tài khoản.' });
  // A code requested before an admin deleted the account must not be redeemable
  // afterwards: without this the reset succeeds, the reply says "đăng nhập ngay",
  // and the login that follows is refused with nothing to explain why.
  if (user.deleted_at) {
    return res.status(403).json({ error: 'Tài khoản này đã bị xoá. Vui lòng liên hệ quản trị viên.' });
  }

  db.transaction(() => {
    // setPassword() bumps token_version, so a session opened by whoever had the
    // old password - the reason most people reset in the first place - dies here.
    setPassword(user.id, newPassword);
    // Redeeming a code that was mailed to this address proves the same thing the
    // sign-up OTP proves, so an account still stuck at email_verified = 0 is
    // verified here too. Without this the reset would succeed and the login that
    // follows it would still be refused, with nothing to explain why.
    db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(user.id);
    // Every outstanding code is spent, not just the one matched.
    db.prepare('UPDATE password_resets SET used = 1 WHERE email = ? AND used = 0').run(normalizedEmail);
  })();

  // The lockout is lifted: whoever just proved control of the mailbox should not
  // inherit a lockout caused by the attacker who prompted the reset.
  reset('login-email', normalizedEmail);
  res.json({ ok: true, message: 'Đặt lại mật khẩu thành công. Bạn có thể đăng nhập ngay.' });
});

// ---------------- Google OAuth ----------------
// Stateless: no express-session/passport session. The callback parks the JWT in a
// single-use HttpOnly cookie and redirects to a clean URL; POST /api/auth/session
// redeems it (see below). Nothing secret is ever put in a URL.

// The redirect URI must byte-match the one registered in Google Cloud Console, so
// it comes from explicit configuration only - GOOGLE_CALLBACK_URL, or SITE_URL as
// the base. There is deliberately no hardcoded domain fallback any more: one
// silently pointed this flow at a domain that only happened to be the current one.
// Missing both means Google sign-in reports itself unconfigured rather than
// guessing an origin.
const googleCallbackUrl =
  process.env.GOOGLE_CALLBACK_URL ||
  (process.env.SITE_URL ? `${process.env.SITE_URL.replace(/\/+$/, '')}/api/auth/google/callback` : '');

const googleConfigured = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && googleCallbackUrl);

if (googleConfigured) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: googleCallbackUrl,
        proxy: true,
      },
      (accessToken, refreshToken, profile, done) => {
        try {
          const email = profile.emails && profile.emails[0] && profile.emails[0].value;
          if (!email) return done(null, false, { message: 'Không lấy được email từ tài khoản Google.' });

          const name = profile.displayName || email.split('@')[0];
          // Through the same gate as PUT /me: an avatar_url lands in <img src>,
          // where escaping cannot fix a hostile scheme. Google's URLs are https,
          // so this only bites if the profile picture source ever changes shape.
          const avatar = safeAvatarUrl(profile.photos && profile.photos[0] && profile.photos[0].value, '');

          let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
          if (!user) {
            // Google accounts don't have a local password; store a random,
            // unusable hash so the column's NOT NULL constraint is satisfied
            // and the hash can never match a real login attempt.
            const randomHash = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), BCRYPT_ROUNDS);
            const info = db
              .prepare(
                `INSERT INTO users (name, email, password_hash, avatar_url, role, auth_provider, email_verified)
                 VALUES (?, ?, ?, ?, 'readonly', 'google', 1)`
              )
              .run(
                name,
                email.toLowerCase(),
                randomHash,
                avatar || `https://api.dicebear.com/7.x/thumbs/svg?seed=${encodeURIComponent(email)}`
              );
            user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
            // A first Google sign-in IS a completed signup (the row is created
            // verified). This callback is SYNCHRONOUS, so the notification row is
            // written inside its own try/catch - a throw here would fail the
            // sign-in itself - and the mail is fire-and-forget either way.
            try {
              notifyNewUser(user);
            } catch (e) {
              console.error('[auth] Không ghi được thông báo người dùng mới:', e.message);
            }
          } else if (!user.email_verified) {
            // Google has verified this address itself, so signing in with it
            // clears a pending local registration for the same email - which
            // also makes Google a way out if the OTP mail never arrived. That
            // makes this branch a signup completing, by a third door.
            //
            // The pending row's password_hash cannot be trusted: POST /register
            // lets ANYONE create an email_verified=0 row for someone else's
            // address (they just never redeem the mailed OTP), so an attacker
            // could park a password on this row before the real owner ever
            // signs in. Flipping email_verified alone would leave that
            // attacker-chosen password valid forever. So this replaces it with
            // the same random, unusable hash a fresh Google signup gets (the
            // branch above), moves auth_provider to 'google', and bumps
            // token_version to invalidate anything issued against the old hash.
            const randomHash = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), BCRYPT_ROUNDS);
            db.prepare(
              `UPDATE users SET email_verified = 1, password_hash = ?, auth_provider = 'google',
                                token_version = token_version + 1
                 WHERE id = ?`
            ).run(randomHash, user.id);
            user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
            try {
              notifyNewUser(user);
            } catch (e) {
              console.error('[auth] Không ghi được thông báo người dùng mới:', e.message);
            }
          }
          if (!user.is_active) {
            return done(null, false, { message: 'Tài khoản này đã bị vô hiệu hoá.' });
          }
          // Refused rather than treated as absent: the trashed row still holds the
          // email's UNIQUE constraint, so falling into the INSERT branch above
          // would crash the callback instead of signing nobody in.
          if (user.deleted_at) {
            return done(null, false, { message: 'Tài khoản này đã bị xoá.' });
          }
          return done(null, user);
        } catch (e) {
          return done(e);
        }
      }
    )
  );

  router.get('/google', passport.authenticate('google', { session: false, scope: ['profile', 'email'] }));

  // The token used to be handed back as `/index.html?token=<jwt>`. A URL is the
  // worst place for a credential: it lands in the reverse proxy's access log, in
  // browser history, in the Referer sent to every external image on the page, and
  // in anything the reader pastes. Cloudflare logs the query string too.
  //
  // Instead the token goes into a single-use, HttpOnly cookie scoped to /api/auth,
  // and the browser is redirected to a clean URL carrying only a marker. The page
  // then POSTs to /session below, which returns the token in a response body and
  // clears the cookie. Nothing secret is ever in a URL.
  //
  // SameSite=Lax is required, not merely prudent: the request arriving here is a
  // cross-site redirect from Google, and a Strict cookie would not be sent on the
  // navigation that follows.
  router.get(
    '/google/callback',
    passport.authenticate('google', { session: false, failureRedirect: '/index.html?auth_error=google' }),
    (req, res) => {
      res.cookie('oauth_handoff', signToken(req.user), {
        httpOnly: true,
        sameSite: 'lax',
        secure: req.secure,
        path: '/api/auth',
        maxAge: 60_000, // one page load; the client redeems it immediately
      });
      res.redirect('/index.html?oauth=google');
    }
  );
} else {
  // Google isn't configured (missing env vars) - fail clearly instead of a 404
  router.get('/google', (req, res) =>
    res.status(503).json({ error: 'Đăng nhập Google chưa được cấu hình trên máy chủ.' })
  );
}

// POST /api/auth/session
// Redeems the handoff cookie set by the Google callback. Single use: the cookie is
// cleared whether or not the token in it turns out to be valid, so a replay from
// the browser history finds nothing.
router.post('/session', (req, res) => {
  const handoff = req.cookies && req.cookies.oauth_handoff;
  res.clearCookie('oauth_handoff', { path: '/api/auth' });
  if (!handoff) return res.status(401).json({ error: 'Không có phiên đăng nhập nào đang chờ.' });

  let payload;
  try {
    payload = jwt.verify(handoff, JWT_SECRET);
  } catch (e) {
    return res.status(401).json({ error: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.' });
  }
  // Re-read the row rather than trusting the cookie's copy of it: the account could
  // have been disabled, put in the bin, or had its password changed between the
  // redirect and this call.
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id);
  if (!user || !user.is_active || user.deleted_at || Number(payload.tv || 0) !== Number(user.token_version || 0)) {
    return res.status(401).json({ error: 'Phiên đăng nhập không còn hiệu lực.' });
  }
  res.json({ token: handoff, user: publicUser(user) });
});

module.exports = router;

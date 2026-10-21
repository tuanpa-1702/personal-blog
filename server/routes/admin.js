const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { sanitizeRichHtml } = require('../sanitize-html');
const terms = require('../terms');
const { getSiteName } = require('../site');
const { PROVIDERS, getEmailConfig, getEmailSettingsForAdmin, saveEmailSettings } = require('../email-config');
const { verifyAndTest, resetTransporter } = require('../mailer');
const { authorizeUrl, redirectUriFor } = require('./email-oauth');
const { BCRYPT_ROUNDS, validatePassword } = require('../password');
// User deletion is a move to the recycle bin now; the cascade-and-log purge
// lives in trash-store.purgeUser(), reached from the bin.
const trashStore = require('../trash-store');
// The admin notification inbox (Admin > Thông báo) and its unread badge.
const notifications = require('../notifications');
// Admin audit trail (security.md item 20): role changes and password resets are
// logged directly here; user/post/comment trashing is logged inside
// trashStore.trash() itself, since every DELETE route in this app already funnels
// through that one function.
const auditLog = require('../audit-log');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const VALID_ROLES = ['admin', 'editor', 'readonly'];

// Demoting the last usable admin would lock everyone out of this panel. The
// disable and delete routes need no equivalent check: requireAuth only admits an
// active admin, so the caller is always one, and both refuse to act on the
// caller's own row - the target therefore can never be the last active admin.
function countOtherActiveAdmins(excludeId) {
  return db
    .prepare(
      "SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND is_active = 1 AND deleted_at IS NULL AND id != ?"
    )
    .get(excludeId).c;
}

// GET /api/admin/stats
router.get('/stats', (req, res) => {
  // Every number here describes the LIVE site, so the bin is excluded from all of
  // them: a trashed post still holds its views in the row, and counting it would
  // make the dashboard disagree with what the homepage shows.
  const totalViews = db.prepare('SELECT COALESCE(SUM(views), 0) AS v FROM posts WHERE deleted_at IS NULL').get().v;
  const totalPublished = db
    .prepare("SELECT COUNT(*) AS c FROM posts WHERE status = 'published' AND deleted_at IS NULL")
    .get().c;
  const totalDraft = db
    .prepare("SELECT COUNT(*) AS c FROM posts WHERE status = 'draft' AND deleted_at IS NULL")
    .get().c;
  const totalNotifyEnabled = db
    .prepare('SELECT COUNT(*) AS c FROM users WHERE email_notifications = 1 AND deleted_at IS NULL')
    .get().c;
  const totalUsers = db.prepare('SELECT COUNT(*) AS c FROM users WHERE deleted_at IS NULL').get().c;
  // 10, matching the page the card sits on: Tổng quan shows one page of the ten
  // newest posts and no pager, so fetching more would only be discarded. The full
  // list is the "Quản lý bài viết" tab.
  const recentPosts = db
    .prepare(
      `SELECT p.id, p.title, p.slug, p.excerpt, p.cover_image, p.tag, p.hashtags,
              p.status, p.views, p.author_id, p.created_at, p.updated_at,
              u.name AS author_name
       FROM posts p JOIN users u ON u.id = p.author_id
       WHERE p.deleted_at IS NULL
       ORDER BY p.created_at DESC LIMIT 10`
    )
    .all();
  res.json({ totalViews, totalPublished, totalDraft, totalNotifyEnabled, totalUsers, recentPosts });
});

// The four sources of the activity feed, as one UNION ALL. Defined once because two
// queries need it: the page of rows, and the count of everything behind them.
//
// Why a UNION ALL rather than three requests: the ordering has to be global (newest
// first across all four kinds), and only the database can do that without shipping
// every row to the client first.
//
// The reaction tables hold one row per (target, user) and refresh created_at when a
// vote is changed, so a reaction row here is the reader's CURRENT vote with the time
// they last changed it - never a duplicate of a vote they have since undone.
//
// The fourth branch is activity_log, the deletion record. It is the one source whose
// subject no longer exists, which is why it carries no user_avatar of its own and
// LEFT JOINs users instead: the account that deleted the post may have been deleted
// after it. The join also picks up a name change; COALESCE falls back to the snapshot
// the log took at the time, so the row always says who it was.
//
// Excerpts are cut to 160 chars server-side: this feed only needs a preview, and a
// long comment thread should not inflate the dashboard payload. The log's detail is
// one line by construction, so it is passed through as it is.
// Trashed content drops out of the three live branches: the feed describes what is
// happening on the site right now, and a comment sitting in the bin is not
// happening. The activity_log branch keeps every row - it is the record of things
// that stopped existing, which is the opposite case.
const ACTIVITY_FEED_SQL = `
     SELECT 'comment' AS kind, 0 AS value, c.created_at AS created_at,
            u.id AS user_id, u.name AS user_name, u.avatar_url AS user_avatar,
            p.title AS post_title, p.slug AS post_slug,
            substr(c.content, 1, 160) AS excerpt
       FROM comments c
       JOIN users u ON u.id = c.user_id
       JOIN posts p ON p.id = c.post_id
      WHERE c.deleted_at IS NULL AND p.deleted_at IS NULL
     UNION ALL
     SELECT 'post_reaction', r.value, r.created_at,
            u.id, u.name, u.avatar_url, p.title, p.slug, NULL
       FROM post_reactions r
       JOIN users u ON u.id = r.user_id
       JOIN posts p ON p.id = r.post_id
      WHERE p.deleted_at IS NULL
     UNION ALL
     SELECT 'comment_reaction', r.value, r.created_at,
            u.id, u.name, u.avatar_url, p.title, p.slug,
            substr(c.content, 1, 160)
       FROM comment_reactions r
       JOIN users u ON u.id = r.user_id
       JOIN comments c ON c.id = r.comment_id
       JOIN posts p ON p.id = c.post_id
      WHERE c.deleted_at IS NULL AND p.deleted_at IS NULL
     UNION ALL
     SELECT l.kind, 0, l.created_at,
            l.actor_id, COALESCE(u.name, l.actor_name), u.avatar_url,
            l.post_title, l.post_slug, l.detail
       FROM activity_log l
       LEFT JOIN users u ON u.id = l.actor_id`;

// Counting the four tables separately rather than wrapping the union in
// SELECT COUNT(*) FROM (...): that would materialise every row of every source - the
// full comment text, every vote - only to throw it away and keep a number. Four
// COUNT(*)s read the same rows the union would, but never build them. The filters
// mirror the union's, or the pager would promise pages the feed cannot show.
const ACTIVITY_TOTAL_SQL = `
  SELECT (SELECT COUNT(*) FROM comments c JOIN posts p ON p.id = c.post_id
           WHERE c.deleted_at IS NULL AND p.deleted_at IS NULL)
       + (SELECT COUNT(*) FROM post_reactions r JOIN posts p ON p.id = r.post_id
           WHERE p.deleted_at IS NULL)
       + (SELECT COUNT(*) FROM comment_reactions r
            JOIN comments c ON c.id = r.comment_id
            JOIN posts p ON p.id = c.post_id
           WHERE c.deleted_at IS NULL AND p.deleted_at IS NULL)
       + (SELECT COUNT(*) FROM activity_log) AS total`;

// GET /api/admin/activity?page=&limit=
//
// Paged, newest-first. The dashboard shows ten rows and turns the page rather than
// scrolling, so `total` is what lets the client draw the page numbers - without it
// the pager cannot know whether a short page is the last one or a failure.
//
// `page` past the end returns an empty list rather than an error: rows are added and
// removed under a live feed, so a page number that existed when the pager was drawn
// can legitimately stop existing by the time it is clicked. The client steps back a
// page on an empty result, the same way the media grid does.
router.get('/activity', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
  const page = Math.max(Math.floor(Number(req.query.page)) || 1, 1);
  const rows = db
    .prepare(
      `SELECT * FROM (${ACTIVITY_FEED_SQL})
       ORDER BY created_at DESC, kind
       LIMIT ? OFFSET ?`
    )
    .all(limit, (page - 1) * limit);
  const total = db.prepare(ACTIVITY_TOTAL_SQL).get().total;
  res.json({ activity: rows, total, page, limit });
});

// ---------------- Admin notifications (Admin > Thông báo) ----------------
//
// Read here rather than in a routes/notifications.js of its own: this router
// already carries router.use(requireAuth, requireAdmin) at the top, while a new
// router would have to repeat that guard AND be mounted ahead of /api/admin in
// server.js - the exact trap routes/trash.js documents at its head.
//
// Literal paths are declared BEFORE the :id one, the same reason GET /tags has to
// sit above GET /:slug in routes/posts.js.

// GET /api/admin/notifications/unread-count
// Split off the list because it is called the moment the panel opens, before any
// tab is clicked - the same reason GET /api/admin/trash/counts exists on its own.
router.get('/notifications/unread-count', (req, res) => {
  res.json({ unread: notifications.unreadCount() });
});

// GET /api/admin/notifications?page=&limit=&filter=
// filter is 'unread' or one of the four kinds; anything else means "all". The
// whitelist lives in notifications.list(), which builds its WHERE from literals.
//
// `unread` rides along on EVERY response so the rail badge stays honest after a
// mark-read without a second request - the trick GET /api/admin/trash/:kind uses
// for its counts.
//
// The reported comment's CURRENT text is joined here, live, rather than stored:
// a notification snapshots the report, not the comment, and an admin reading a
// report wants the words as they stand (or to see that the comment is gone).
router.get('/notifications', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
  const page = Math.max(Math.floor(Number(req.query.page)) || 1, 1);
  const data = notifications.list(page, limit, String(req.query.filter || ''));
  const ids = data.notifications.map((n) => n.comment_id).filter((v) => v != null);
  let live = new Map();
  if (ids.length) {
    live = new Map(
      db
        .prepare(
          `SELECT id, substr(content, 1, 160) AS excerpt, hidden_at FROM comments
            WHERE id IN (${ids.map(() => '?').join(', ')})`
        )
        .all(ids)
        .map((r) => [r.id, r])
    );
  }
  // A report row also carries where the report stands now, so the tab can show
  // "đã xử lí" without a second fetch per row. Keyed on (comment, reporter): the
  // reporter is the notification's actor, and that pair is the report's UNIQUE key.
  const reportKeys = data.notifications
    .filter((n) => n.kind === 'comment_reported' && n.comment_id != null && n.actor_id != null)
    .map((n) => [n.comment_id, n.actor_id]);
  let reports = new Map();
  if (reportKeys.length) {
    const pairs = reportKeys.map(() => '(comment_id = ? AND user_id = ?)').join(' OR ');
    reports = new Map(
      db
        .prepare(`SELECT id, comment_id, user_id, status FROM comment_reports WHERE ${pairs}`)
        .all(reportKeys.flat())
        .map((r) => [`${r.comment_id}:${r.user_id}`, r])
    );
  }
  // Whether the post still exists, and its slug as it stands now. A notification
  // snapshots the post, so without this the row would link a title whose post has
  // since been trashed or renamed - a 404 or a stale slug wearing the name of the
  // thing just clicked, which is why activityRowHtml() refuses to link a deletion.
  const postIds = [...new Set(data.notifications.map((n) => n.post_id).filter((v) => v != null))];
  let posts = new Map();
  if (postIds.length) {
    posts = new Map(
      db
        .prepare(
          `SELECT id, slug, deleted_at FROM posts WHERE id IN (${postIds.map(() => '?').join(', ')})`
        )
        .all(postIds)
        .map((r) => [r.id, r])
    );
  }
  res.json({
    ...data,
    notifications: data.notifications.map((n) => {
      const c = n.comment_id != null ? live.get(n.comment_id) : undefined;
      const p = n.post_id != null ? posts.get(n.post_id) : undefined;
      const rp =
        n.kind === 'comment_reported' ? reports.get(`${n.comment_id}:${n.actor_id}`) : undefined;
      return {
        ...n,
        ...(c ? { comment_excerpt: c.excerpt, comment_hidden: Boolean(c.hidden_at) } : {}),
        ...(p ? { post_slug: p.slug, post_live: !p.deleted_at } : n.post_id != null ? { post_live: false } : {}),
        ...(rp ? { report_id: rp.id, report_status: rp.status } : {}),
      };
    }),
  });
});

// POST /api/admin/notifications/read-all
router.post('/notifications/read-all', (req, res) => {
  res.json({ ok: true, changed: notifications.markAllRead(), unread: notifications.unreadCount() });
});

// POST /api/admin/notifications/:id/read
router.post('/notifications/:id/read', (req, res) => {
  const changed = notifications.markRead(Number(req.params.id));
  if (!changed) return res.status(404).json({ error: 'Không tìm thấy thông báo.' });
  res.json({ ok: true, unread: notifications.unreadCount() });
});

// PATCH /api/admin/comment-reports/:id  { status: 'open' | 'resolved' | 'dismissed' }
//
// The moderation outcome of a report. Hiding the comment is a separate action
// (PATCH /api/posts/comments/:id/hidden) and does not touch this row: an admin may
// resolve a report by deciding the comment is fine, and the report stays as the
// record of having looked.
const REPORT_STATUSES = ['open', 'resolved', 'dismissed'];
router.patch('/comment-reports/:id', (req, res) => {
  const status = (req.body || {}).status;
  if (!REPORT_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status phải là một trong: ${REPORT_STATUSES.join(' | ')}.` });
  }
  const changed = db
    .prepare("UPDATE comment_reports SET status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, Number(req.params.id)).changes;
  if (!changed) return res.status(404).json({ error: 'Không tìm thấy báo cáo.' });
  res.json({ ok: true, status });
});

// GET /api/admin/users - returns every LIVE user regardless of how they signed up
// (local registration or Google), same list, so no account is hidden here. Trashed
// accounts are not in this list: the bin is where an admin goes to see them, and
// offering role/status controls on a row that is already in the bin would be a
// second, contradictory way to manage the same account.
// Every users column is exposed except password_hash - the card UI reflects all
// of them, and an admin editing accounts needs to see the real state.
router.get('/users', (req, res) => {
  const users = db
    .prepare(
      `SELECT u.id, u.name, u.email, u.avatar_url, u.bio, u.role, u.auth_provider,
              u.email_notifications, u.is_active, u.email_verified, u.created_at,
              (SELECT COUNT(*) FROM posts p WHERE p.author_id = u.id AND p.deleted_at IS NULL) AS post_count
         FROM users u WHERE u.deleted_at IS NULL ORDER BY u.created_at DESC`
    )
    .all();
  res.json({ users });
});

// POST /api/admin/users - admin creates a new local account directly, choosing its role
router.post('/users', (req, res) => {
  const { name, email, password, role } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Vui lòng nhập đầy đủ họ tên, email và mật khẩu.' });
  }
  const passwordError = validatePassword(password);
  if (passwordError) return res.status(400).json({ error: passwordError });
  const finalRole = VALID_ROLES.includes(role) ? role : 'readonly';
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: 'Email này đã được đăng ký.' });

  const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  const avatar = `https://api.dicebear.com/7.x/thumbs/svg?seed=${encodeURIComponent(email)}`;
  const info = db
    .prepare(
      `INSERT INTO users (name, email, password_hash, avatar_url, role, auth_provider, email_verified)
       VALUES (?, ?, ?, ?, ?, 'local', 1)`
    )
    .run(name, email.toLowerCase(), hash, avatar, finalRole);
  const user = db
    .prepare(
      `SELECT id, name, email, avatar_url, bio, role, auth_provider, email_notifications, is_active,
              email_verified, created_at, 0 AS post_count
         FROM users WHERE id = ?`
    )
    .get(info.lastInsertRowid);
  res.status(201).json({ user });
});

// PUT /api/admin/users/:id  (change role: 'admin' | 'editor' | 'readonly')
router.put('/users/:id', (req, res) => {
  const { role } = req.body || {};
  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: `role phải là một trong: ${VALID_ROLES.join(', ')}.` });
  }
  const user = db.prepare('SELECT id, name, role, deleted_at FROM users WHERE id = ?').get(req.params.id);
  if (!user || user.deleted_at) return res.status(404).json({ error: 'Không tìm thấy người dùng.' });
  if (user.role === 'admin' && role !== 'admin' && countOtherActiveAdmins(user.id) === 0) {
    return res.status(400).json({ error: 'Đây là quản trị viên đang hoạt động duy nhất - không thể hạ quyền.' });
  }
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, user.id);
  if (role !== user.role) {
    auditLog.log({
      actor: req.user,
      action: 'role_change',
      targetType: 'user',
      targetId: user.id,
      targetLabel: user.name,
      detail: `${user.role} → ${role}`,
    });
  }
  res.json({ ok: true });
});

// PATCH /api/admin/users/:id/status { is_active }
// Disabling is the reversible alternative to deleting: the account and its posts
// stay, but requireAuth stops honouring its token and login is refused, so the
// user is signed out everywhere on their next request.
router.patch('/users/:id/status', (req, res) => {
  const { is_active } = req.body || {};
  if (typeof is_active !== 'boolean') {
    return res.status(400).json({ error: 'is_active phải là true hoặc false.' });
  }
  const user = db.prepare('SELECT id, is_active, role, deleted_at FROM users WHERE id = ?').get(req.params.id);
  if (!user || user.deleted_at) return res.status(404).json({ error: 'Không tìm thấy người dùng.' });
  if (!is_active && user.id === req.user.id) {
    return res.status(400).json({ error: 'Không thể tự vô hiệu hoá tài khoản của chính mình.' });
  }
  db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(is_active ? 1 : 0, user.id);
  res.json({ ok: true, is_active });
});

// POST /api/admin/users/:id/reset-password { password }
// An admin-set password: no OTP and no old password, because the admin is
// already trusted. The plaintext is never stored or returned - the admin has it
// from the form they just typed it into.
router.post('/users/:id/reset-password', (req, res) => {
  const password = String((req.body || {}).password || '');
  const passwordError = validatePassword(password);
  if (passwordError) return res.status(400).json({ error: passwordError });
  const user = db.prepare('SELECT id, name, auth_provider, deleted_at FROM users WHERE id = ?').get(req.params.id);
  if (!user || user.deleted_at) return res.status(404).json({ error: 'Không tìm thấy người dùng.' });
  if (user.auth_provider === 'google') {
    return res
      .status(400)
      .json({ error: 'Tài khoản này đăng nhập bằng Google nên không có mật khẩu để đặt lại.' });
  }
  auditLog.log({ actor: req.user, action: 'password_reset', targetType: 'user', targetId: user.id, targetLabel: user.name });
  db.transaction(() => {
    // token_version is bumped too, so an admin resetting the password of a
    // compromised account actually signs the intruder out. Without it the reset
    // changed nothing for whoever was already holding a token.
    db.prepare(
      `UPDATE users SET password_hash = ?, email_verified = 1, token_version = token_version + 1
         WHERE id = ?`
    ).run(bcrypt.hashSync(password, BCRYPT_ROUNDS), user.id);
    // Any OTP already in flight for this address is now stale.
    db.prepare(
      'UPDATE password_resets SET used = 1 WHERE email = (SELECT email FROM users WHERE id = ?) AND used = 0'
    ).run(user.id);
    // Same for a pending sign-up code: the admin has just set this password by
    // hand, which both vouches for the address and makes that code pointless.
    // Without email_verified above, the account would take the new password and
    // still be refused at login.
    db.prepare(
      'UPDATE email_verifications SET used = 1 WHERE email = (SELECT email FROM users WHERE id = ?) AND used = 0'
    ).run(user.id);
  })();
  res.json({ ok: true });
});

// DELETE /api/admin/users/:id
//
// Moves the ACCOUNT into the recycle bin and nothing else: their posts and
// comments stay exactly where they are, still attributed to them, because the
// bin holds the login rather than the body of work. Sessions die immediately -
// loadActiveUser() in middleware/auth.js refuses a row with deleted_at set, the
// same way it refuses is_active = 0.
// The irreversible variant, where posts.author_id's ON DELETE CASCADE takes
// everything and logPostsDeletedWith records it, is trash-store.purgeUser().
router.delete('/users/:id', (req, res) => {
  if (Number(req.params.id) === req.user.id) {
    return res.status(400).json({ error: 'Không thể tự xoá tài khoản của chính mình.' });
  }
  const user = db.prepare('SELECT id, name, deleted_at FROM users WHERE id = ?').get(req.params.id);
  if (!user || user.deleted_at) return res.status(404).json({ error: 'Không tìm thấy người dùng.' });
  const result = trashStore.trash('users', user.id, req.user);
  if (result.error) return res.status(409).json({ error: result.error });
  res.json({ ok: true, trashed: true });
});

// GET /api/admin/posts (all posts incl. drafts, but not the trashed ones - those
// have their own tab, and listing them here would offer an edit link to a post
// the editor refuses to open)
router.get('/posts', (req, res) => {
  const posts = db
    .prepare(
      `SELECT p.id, p.title, p.slug, p.excerpt, p.cover_image, p.tag, p.hashtags,
              p.status, p.views, p.author_id, p.created_at, p.updated_at,
              u.name AS author_name
       FROM posts p JOIN users u ON u.id = p.author_id
       WHERE p.deleted_at IS NULL
       ORDER BY p.created_at DESC`
    )
    .all();
  res.json({ posts });
});

// GET /api/admin/settings - admin view of all site settings (same data as public endpoint)
router.get('/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  rows.forEach((r) => (settings[r.key] = r.value));
  res.json({ settings });
});

// PUT /api/admin/settings - bulk update site copy (title, hero text, footer, etc.)
router.put('/settings', (req, res) => {
  const updates = req.body || {};
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value = @value'
  );
  const tx = db.transaction((entries) => {
    for (const [key, value] of entries) upsert.run({ key, value: String(value ?? '') });
  });
  tx(Object.entries(updates));

  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  rows.forEach((r) => (settings[r.key] = r.value));
  res.json({ settings });
});

// PUT /api/admin/terms - the whole terms document, edited on the page it shows:
// the editor on /terms.html sends every clause in the order its textareas are
// in, and the handler replaces the saved document with exactly that. Replacing
// the array is the only write shape there is (see server/terms.js), so a reorder
// or a delete is just a different array - one atomic write, no orphan rows.
// updated_at is stamped here and nowhere else: it is the "Cập nhật lần cuối"
// date, and it must mean "the moment an admin pressed save".
router.put('/terms', (req, res) => {
  const clauses = (req.body || {}).clauses;
  if (!Array.isArray(clauses) || !clauses.length || clauses.length > 60) {
    return res.status(400).json({ error: 'Cần ít nhất một điều khoản và không quá 60.' });
  }
  const clean = [];
  for (const clause of clauses) {
    const heading = String((clause && clause.heading) || '').trim();
    // A clause body is rich HTML from the same contenteditable the post writer
    // uses, so it gets the same treatment a post body gets: normalised on the
    // client, sanitised here - nothing an author pastes reaches the page raw.
    const html = sanitizeRichHtml(String((clause && clause.html) || ''));
    if (!heading) return res.status(400).json({ error: 'Mỗi điều khoản cần có tiêu đề.' });
    if (heading.length > 200) return res.status(400).json({ error: 'Tiêu đề điều khoản quá dài.' });
    if (html.length > 60000) return res.status(400).json({ error: 'Nội dung điều khoản quá dài.' });
    clean.push({ heading, html });
  }
  const saved = terms.saveTerms(clean);
  res.json({
    ok: true,
    updatedAt: saved.updatedAt,
    clauses: saved.clauses,
    html: terms.termsSectionsHtml(saved.clauses),
    dateLine: 'Cập nhật lần cuối: ' + terms.formatTermsDate(saved.updatedAt),
  });
});

// ---------------- Email settings (Cài đặt email) ----------------
// Kept on the admin router so it inherits requireAuth + requireAdmin above.
// The SMTP password is write-only: it is accepted here but never returned by the
// GET, so it cannot leak through the browser or a shared screenshot.

// GET /api/admin/email-settings
router.get('/email-settings', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  // The redirect URI is derived from the request, so it is added here rather than
  // in getEmailSettingsForAdmin(). The panel needs it on load: it has to be
  // pasted into the app registration BEFORE the sign-in can work at all.
  res.json({ ...getEmailSettingsForAdmin(), oauthRedirectUri: redirectUriFor(req) });
});

// PUT /api/admin/email-settings
router.put('/email-settings', (req, res) => {
  const body = req.body || {};

  if (body.provider !== undefined && !PROVIDERS.includes(body.provider)) {
    return res.status(400).json({ error: `provider phải là một trong: ${PROVIDERS.join(', ')}.` });
  }
  if (body.provider === 'custom' && !String(body.host || '').trim()) {
    return res.status(400).json({ error: 'Máy chủ SMTP tuỳ chỉnh cần có địa chỉ host.' });
  }
  // A GUID-shaped check only: whether the values are correct is answered by the
  // "Kiểm tra" button, which asks Entra for a real token.
  for (const key of ['tenant_id', 'client_id']) {
    const value = String(body[key] || '').trim();
    if (value && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      return res.status(400).json({ error: 'Tenant ID và Client ID phải có dạng GUID.' });
    }
  }
  if (body.port !== undefined && String(body.port).trim()) {
    const port = Number(body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return res.status(400).json({ error: 'Cổng SMTP phải là số nguyên từ 1 đến 65535.' });
    }
  }
  for (const key of ['from_email', 'user']) {
    const value = String(body[key] || '').trim();
    if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      return res.status(400).json({ error: 'Địa chỉ email không hợp lệ.' });
    }
  }
  const siteUrl = String(body.site_url || '').trim();
  if (siteUrl && !/^https?:\/\//i.test(siteUrl)) {
    return res.status(400).json({ error: 'Địa chỉ trang phải bắt đầu bằng http:// hoặc https://.' });
  }
  // The four admin-event toggles are stored as the same '0'/'1' strings as every
  // other checkbox here; the form sends exactly that, so anything else is a
  // hand-rolled request and is refused rather than coerced.
  for (const key of ['notify_comment_reported', 'notify_new_comment', 'notify_new_user', 'notify_comment_hidden']) {
    if (body[key] !== undefined && !['0', '1'].includes(String(body[key]))) {
      return res.status(400).json({ error: `${key} phải là '0' hoặc '1'.` });
    }
  }

  // An empty password field means "keep the stored one" rather than "erase it",
  // since the form never receives the current value to send back. Clearing is
  // done explicitly with clear_password.
  const updates = { ...body };
  delete updates.clear_password;
  if (body.clear_password) updates.pass = '';
  else if (!String(body.pass || '')) delete updates.pass;

  // The client secret follows the same write-only rule as the password: an empty
  // field means "keep the stored one", since the GET never returns it.
  delete updates.clear_client_secret;
  if (body.clear_client_secret) updates.client_secret = '';
  else if (!String(body.client_secret || '')) delete updates.client_secret;

  // The refresh token is never set through this form - it comes from the sign-in
  // callback. Dropping it here stops a stray field in the payload from wiping a
  // working delegated grant, while clear_refresh_token still allows a deliberate
  // reset (e.g. to re-consent as a different mailbox).
  delete updates.refresh_token;
  delete updates.clear_refresh_token;
  if (body.clear_refresh_token) updates.refresh_token = '';

  // Switching the sending mailbox or the app registration invalidates a grant
  // obtained for the previous one, so drop it rather than leave a token that
  // authenticates as somebody else.
  const before = getEmailConfig();
  const changedIdentity =
    (updates.user !== undefined && String(updates.user).trim() !== before.user) ||
    (updates.tenant_id !== undefined && String(updates.tenant_id).trim() !== before.tenantId) ||
    (updates.client_id !== undefined && String(updates.client_id).trim() !== before.clientId);
  if (changedIdentity) updates.refresh_token = '';

  saveEmailSettings(updates);
  resetTransporter();
  res.json({ ...getEmailSettingsForAdmin(), oauthRedirectUri: redirectUriFor(req) });
});

// GET /api/admin/email-settings/oauth-url
// Mints the Microsoft sign-in link for delegated mode. Kept on the admin router
// so only an authenticated admin can start the flow; the callback itself lives in
// routes/email-oauth.js because a browser redirect carries no auth header.
router.get('/email-settings/oauth-url', (req, res) => {
  const cfg = getEmailConfig();
  if (!cfg.tenantId || !cfg.clientId || !cfg.clientSecret) {
    return res
      .status(400)
      .json({ error: 'Hãy nhập và lưu Tenant ID, Client ID, Client Secret trước khi cấp quyền.' });
  }
  res.json({ url: authorizeUrl(req, req.user.id), redirectUri: redirectUriFor(req) });
});

// POST /api/admin/email-settings/test { to }
// Verifies the SMTP connection, then sends a test message if `to` is given.
router.post('/email-settings/test', async (req, res) => {
  const to = String((req.body || {}).to || '').trim();
  if (to && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return res.status(400).json({ error: 'Địa chỉ email nhận thử không hợp lệ.' });
  }
  try {
    const result = await verifyAndTest(to, getSiteName());
    res.json({
      ok: true,
      ...result,
      // The warnings ride along in the same string the panel already shows, so
      // a configuration that will spam-fold every mail says so at the moment the
      // admin tests it, not when a user complains.
      message: [
        result.sent ? `Đã gửi email thử tới ${to}.` : 'Kết nối SMTP thành công.',
        ...(result.warnings || []).map((w) => `Cảnh báo: ${w}`),
      ].join(' '),
    });
  } catch (e) {
    // Surfacing the SMTP error verbatim is what makes this button useful -
    // "Invalid login", "Missing credentials", a TLS failure and a blocked port
    // all need different fixes.
    res.status(400).json({ error: `Kiểm tra thất bại: ${e.message}` });
  }
});

module.exports = router;

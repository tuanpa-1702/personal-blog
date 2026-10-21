// The admin's notification inbox (see the `notifications` table in db.js).
//
// One door for both halves of the feature, so no call site can write the row and
// forget the mail, or the other way round:
//
//   record(event)     the synchronous INSERT. Safe to call from inside the
//                     caller's own transaction (better-sqlite3 turns a nested
//                     transaction into a SAVEPOINT, the same property
//                     activity-log.js relies on), and it NEVER throws for an
//                     unknown kind - a notification is never worth failing the
//                     request that triggered it.
//   mailAsync(event)  the fire-and-forget email. Reads the per-kind toggle, the
//                     SMTP readiness gate and contact_email, and swallows its own
//                     rejection, so a floating promise here can never become an
//                     unhandled one. Callers invoke it AFTER res.json(): the
//                     transporter can block on a Microsoft token fetch and the
//                     deliver() round trip on SMTP, and the commenter should not
//                     wait on either.
//
// The four kinds and what writes them:
//   comment_reported  POST /api/posts/comments/:id/report   (routes/posts.js)
//   new_comment       POST /api/posts/:id/comments          (routes/posts.js)
//   new_user          register / verify-email / Google      (routes/auth.js)
//   comment_hidden    PATCH /api/posts/comments/:id/hidden  (routes/posts.js)

const db = require('./db');
const { getSiteName, getContactEmail } = require('./site');
const { getEmailConfig } = require('./email-config');
const { sendAdminEventEmail } = require('./mailer');

const KINDS = ['comment_reported', 'new_comment', 'new_user', 'comment_hidden'];

// Which email toggle gates which kind. The names mirror getEmailConfig()'s
// booleans so a new kind is one entry in each place.
const TOGGLE_FOR = {
  comment_reported: 'notifyCommentReported',
  new_comment: 'notifyNewComment',
  new_user: 'notifyNewUser',
  comment_hidden: 'notifyCommentHidden',
};

const insert = db.prepare(
  `INSERT INTO notifications (kind, actor_id, actor_name, comment_id, post_id,
                              post_title, post_slug, excerpt, reason, action)
   VALUES (@kind, @actor_id, @actor_name, @comment_id, @post_id,
           @post_title, @post_slug, @excerpt, @reason, @action)`
);

// The same cut the activity feed uses for a comment body (routes/admin.js), so a
// notification and a feed row about the same comment show the same words.
const EXCERPT_CHARS = 160;

// `event` carries: kind, actor (req.user, optional), commentId, post (a row with
// id/title/slug, optional), excerpt, reason, action. Everything textual is
// SNAPSHOTTED here - the row must stay readable after the post, the comment or
// the account is gone.
//
// `excerpt` is the one line the row shows, and what it holds depends on the kind:
// the comment's own text for new_comment, the REPORTER'S note for
// comment_reported (the reported text itself is read live through comment_id by
// the admin list, so it is never stale), and empty for the other two kinds.
function record(event) {
  if (!event || !KINDS.includes(event.kind)) return null;
  const post = event.post || {};
  const info = insert.run({
    kind: event.kind,
    actor_id: event.actor && event.actor.id ? Number(event.actor.id) : null,
    actor_name: (event.actor && event.actor.name) || '',
    comment_id: event.commentId != null ? Number(event.commentId) : null,
    post_id: post.id != null ? Number(post.id) : null,
    post_title: post.title || '',
    post_slug: post.slug || '',
    excerpt: String(event.excerpt ?? '').slice(0, EXCERPT_CHARS),
    reason: String(event.reason ?? ''),
    action: String(event.action ?? ''),
  });
  return { id: Number(info.lastInsertRowid), kind: event.kind };
}

// Never awaited by a caller, never throws: three silent exits and a caught
// rejection, because every call site runs after the response has gone out.
function mailAsync(event) {
  if (!event || !KINDS.includes(event.kind)) return;
  const cfg = getEmailConfig();
  const toggle = TOGGLE_FOR[event.kind];
  if (!toggle || !cfg[toggle]) return;
  if (!cfg.configured) return;
  if (!getContactEmail()) return;
  sendAdminEventEmail(event, getSiteName()).catch((e) =>
    console.error('[notifications] Gửi email sự kiện thất bại:', e.message)
  );
}

function unreadCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE read_at IS NULL').get().c;
}

// `filter` is request data, so it is matched against a whitelist and the WHERE is
// assembled from literals - never interpolated (the house rule writeReaction()
// in routes/posts.js states for table and column names).
function list(page, limit, filter) {
  const where = filter === 'unread' ? 'WHERE read_at IS NULL' : filter && KINDS.includes(filter) ? 'WHERE kind = ?' : '';
  const args = where === 'WHERE kind = ?' ? [filter] : [];
  const total = db.prepare(`SELECT COUNT(*) AS c FROM notifications ${where}`).get(...args).c;
  const rows = db
    .prepare(`SELECT * FROM notifications ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...args, limit, (page - 1) * limit);
  return { notifications: rows, total, page, limit, unread: unreadCount() };
}

function markRead(id) {
  return db.prepare('UPDATE notifications SET read_at = datetime(\'now\') WHERE id = ? AND read_at IS NULL').run(id)
    .changes;
}

function markAllRead() {
  return db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE read_at IS NULL").run().changes;
}

module.exports = { KINDS, record, mailAsync, unreadCount, list, markRead, markAllRead };

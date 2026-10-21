// The recycle bin: every soft-delete, restore and purge in one place.
//
// routes/posts.js, routes/admin.js and routes/media.js call into here from their
// DELETE handlers (a delete is now a move to the bin), and routes/trash.js calls
// in for the bin's own listing, restore and purge. Keeping the four kinds behind
// one module is what makes the grouping rule hold everywhere: a post and the
// comments trashed with it carry the SAME deleted_at, so "restore this post"
// means exactly "clear that timestamp on the post and on the comments wearing
// it" - and a comment a moderator trashed on its own earlier keeps its own,
// different timestamp and is left alone.
//
// Nothing here removes a row except purge(), which is the only irreversible
// path and the only one that writes to activity_log - the feed's promise is
// about things that are really gone, and a trashed post is not gone yet.

const db = require('./db');
const store = require('./media-store');
const { logPostDeletion, logPostsDeletedWith } = require('./activity-log');
const auditLog = require('./audit-log');

const KINDS = ['posts', 'comments', 'users', 'media'];

// The group key. Two rows stamped by ONE operation get an identical string, and
// that identity is the whole mechanism: restore clears exactly the rows wearing the
// stamp of the row it was asked about.
//
// Which makes uniqueness ACROSS operations load-bearing, and a plain clock read was
// not enough. At the second precision SQLite's own datetime('now') writes, a comment
// trashed on its own and its post trashed a moment later landed in the SAME second
// and therefore in the same group, so restoring the post quietly resurrected a
// comment an admin had deleted separately. Milliseconds put a thousand times more air
// between two operations but still only make a collision unlikely; remembering the
// last stamp and stepping forward makes it impossible inside this process, which is
// the only place two operations can be that close together.
//
// The value stays a readable UTC timestamp because it is shown as one: the bin lists
// it, and ORDER BY on it is what puts the newest deletion first. TEXT ordering is
// correct here only because the shape is fixed-width, which stepping a millisecond
// preserves (Date rolls 999+1 into the next second rather than writing ".1000").
let lastStamp = '';
function stamp() {
  let next = new Date().toISOString().slice(0, 23).replace('T', ' ');
  if (next <= lastStamp) {
    const [date, time] = lastStamp.split(' ');
    const [hms, ms] = time.split('.');
    const rolled = new Date(`${date}T${hms}Z`);
    rolled.setUTCMilliseconds(Number(ms) + 1);
    next = rolled.toISOString().slice(0, 23).replace('T', ' ');
  }
  lastStamp = next;
  return next;
}

// ---------------------------------------------------------------- trash

// A post takes its LIVE comments with it. Comments already in the bin keep their
// own timestamp and therefore their own restore, which is the point of stamping
// a group rather than setting a flag.
function trashPost(id, actor) {
  const post = db.prepare('SELECT id, title, deleted_at FROM posts WHERE id = ?').get(id);
  if (!post) return { error: 'Không tìm thấy bài viết.' };
  if (post.deleted_at) return { error: 'Bài viết đã nằm trong thùng rác.' };
  const now = stamp();
  db.transaction(() => {
    db.prepare('UPDATE posts SET deleted_at = ? WHERE id = ?').run(now, id);
    db.prepare('UPDATE comments SET deleted_at = ? WHERE post_id = ? AND deleted_at IS NULL').run(now, id);
  })();
  auditLog.log({ actor, action: 'post_trash', targetType: 'post', targetId: id, targetLabel: post.title });
  return { ok: true, deletedAt: now };
}

// Self plus every descendant through parent_comment_id. The array grows while it
// is walked, which is a BFS without a queue; comment trees are shallow enough
// that the recursion depth is never a concern.
function commentSubtree(id) {
  const ids = [id];
  const children = db.prepare('SELECT id FROM comments WHERE parent_comment_id = ?');
  for (let i = 0; i < ids.length; i += 1) {
    for (const row of children.all(ids[i])) ids.push(row.id);
  }
  return ids;
}

function trashComment(id, actor) {
  const comment = db.prepare('SELECT id, content, deleted_at FROM comments WHERE id = ?').get(id);
  if (!comment) return { error: 'Không tìm thấy bình luận.' };
  if (comment.deleted_at) return { error: 'Bình luận đã nằm trong thùng rác.' };
  const ids = commentSubtree(id);
  const now = stamp();
  const placeholders = ids.map(() => '?').join(', ');
  db.prepare(
    `UPDATE comments SET deleted_at = ? WHERE deleted_at IS NULL AND id IN (${placeholders})`
  ).run(now, ...ids);
  auditLog.log({
    actor,
    action: 'comment_trash',
    targetType: 'comment',
    targetId: id,
    targetLabel: String(comment.content || '').slice(0, 160),
    detail: ids.length > 1 ? `kèm ${ids.length - 1} phản hồi` : '',
  });
  return { ok: true, deletedAt: now, trashed: ids.length };
}

// Only the account. Their posts and comments stay exactly where they are, still
// attributed to them - the bin holds the login, not the body of work.
function trashUser(id, actor) {
  const user = db.prepare('SELECT id, name, deleted_at FROM users WHERE id = ?').get(id);
  if (!user) return { error: 'Không tìm thấy người dùng.' };
  if (user.deleted_at) return { error: 'Người dùng đã nằm trong thùng rác.' };
  db.prepare('UPDATE users SET deleted_at = ? WHERE id = ?').run(stamp(), id);
  auditLog.log({ actor, action: 'user_trash', targetType: 'user', targetId: id, targetLabel: user.name });
  return { ok: true };
}

// The file leaves the served directory in the same breath as the row gets its
// timestamp, so a trashed image 404s immediately. Move first, then stamp: if the
// rename fails there is no row to roll back, and an unstamped row with its file
// still in place is simply an untouched image.
function trashMedia(id, actor) {
  const row = db.prepare('SELECT id, filename, deleted_at FROM media WHERE id = ?').get(id);
  if (!row) return { error: 'Không tìm thấy ảnh.' };
  if (row.deleted_at) return { error: 'Ảnh đã nằm trong thùng rác.' };
  const moved = store.moveToTrash(row.filename);
  if (moved.error) return moved;
  db.prepare('UPDATE media SET deleted_at = ? WHERE id = ?').run(stamp(), id);
  auditLog.log({ actor, action: 'media_trash', targetType: 'media', targetId: id, targetLabel: row.filename });
  return { ok: true };
}

// `actor` is req.user from the calling route (id + name); optional so the small
// number of non-HTTP callers (scripts, tests) still work without one, in which
// case the audit row records a null actor rather than throwing.
function trash(kind, id, actor) {
  if (kind === 'posts') return trashPost(id, actor);
  if (kind === 'comments') return trashComment(id, actor);
  if (kind === 'users') return trashUser(id, actor);
  if (kind === 'media') return trashMedia(id, actor);
  return { error: 'Loại không hợp lệ.' };
}

// ---------------------------------------------------------------- restore

function restorePost(id) {
  const post = db.prepare('SELECT id, deleted_at FROM posts WHERE id = ?').get(id);
  if (!post || !post.deleted_at) return { error: 'Bài viết không nằm trong thùng rác.' };
  db.transaction(() => {
    db.prepare('UPDATE posts SET deleted_at = NULL WHERE id = ?').run(id);
    db.prepare('UPDATE comments SET deleted_at = NULL WHERE post_id = ? AND deleted_at = ?').run(
      id,
      post.deleted_at
    );
  })();
  return { ok: true };
}

function restoreComment(id) {
  const comment = db.prepare('SELECT id, deleted_at FROM comments WHERE id = ?').get(id);
  if (!comment || !comment.deleted_at) return { error: 'Bình luận không nằm trong thùng rác.' };
  const ids = commentSubtree(id);
  const placeholders = ids.map(() => '?').join(', ');
  db.prepare(
    `UPDATE comments SET deleted_at = NULL WHERE deleted_at = ? AND id IN (${placeholders})`
  ).run(comment.deleted_at, ...ids);
  return { ok: true };
}

function restoreUser(id) {
  const user = db.prepare('SELECT id, deleted_at FROM users WHERE id = ?').get(id);
  if (!user || !user.deleted_at) return { error: 'Người dùng không nằm trong thùng rác.' };
  db.prepare('UPDATE users SET deleted_at = NULL WHERE id = ?').run(id);
  return { ok: true };
}

function restoreMedia(id) {
  const row = db.prepare('SELECT id, filename, deleted_at FROM media WHERE id = ?').get(id);
  if (!row || !row.deleted_at) return { error: 'Ảnh không nằm trong thùng rác.' };
  const back = store.restoreFromTrash(row.filename);
  if (back.error) return back;
  db.prepare('UPDATE media SET deleted_at = NULL WHERE id = ?').run(id);
  return { ok: true };
}

function restore(kind, id) {
  if (kind === 'posts') return restorePost(id);
  if (kind === 'comments') return restoreComment(id);
  if (kind === 'users') return restoreUser(id);
  if (kind === 'media') return restoreMedia(id);
  return { error: 'Loại không hợp lệ.' };
}

// ---------------------------------------------------------------- purge

// The irreversible half. Each branch is the hard delete the matching DELETE route
// used to do, loggers included, so the activity feed's record of a deletion now
// means a deletion that cannot be undone.
function purgePost(id, actor) {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
  if (!post || !post.deleted_at) return { error: 'Bài viết không nằm trong thùng rác.' };
  db.transaction(() => {
    db.prepare('DELETE FROM posts WHERE id = ?').run(post.id);
    logPostDeletion(post, actor, 'xoá vĩnh viễn khỏi thùng rác');
  })();
  return { ok: true };
}

function purgeComment(id) {
  const comment = db.prepare('SELECT id, deleted_at FROM comments WHERE id = ?').get(id);
  if (!comment || !comment.deleted_at) return { error: 'Bình luận không nằm trong thùng rác.' };
  db.prepare('DELETE FROM comments WHERE id = ?').run(id);
  return { ok: true };
}

function purgeUser(id, actor) {
  const user = db.prepare('SELECT id, name, deleted_at FROM users WHERE id = ?').get(id);
  if (!user || !user.deleted_at) return { error: 'Người dùng không nằm trong thùng rác.' };
  // Their posts go with the account through posts.author_id's ON DELETE CASCADE,
  // exactly as a hard delete always did - trashing the account did not touch
  // them, but purging it is the old irreversible delete, log included.
  const posts = db.prepare('SELECT * FROM posts WHERE author_id = ?').all(user.id);
  db.transaction(() => {
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    logPostsDeletedWith(posts, actor, 'bị xoá cùng tài khoản');
  })();
  return { ok: true };
}

function purgeMedia(id) {
  const row = db.prepare('SELECT id, deleted_at FROM media WHERE id = ?').get(id);
  if (!row || !row.deleted_at) return { error: 'Ảnh không nằm trong thùng rác.' };
  return store.deleteMedia(id);
}

function purge(kind, id, actor) {
  if (kind === 'posts') return purgePost(id, actor);
  if (kind === 'comments') return purgeComment(id);
  if (kind === 'users') return purgeUser(id, actor);
  if (kind === 'media') return purgeMedia(id);
  return { error: 'Loại không hợp lệ.' };
}

// ---------------------------------------------------------------- listing

// Which comments the Bình luận folder lists. Two exclusions, both about not
// offering a second control for one group:
//
//   1. Comments that travelled with their post are NOT listed here: they appear on
//      the post's row in the Bài viết folder ("+N bình luận"), and the post's own
//      restore already brings them back. The join tells the two apart by timestamp -
//      same stamp means same group.
//   2. Replies inside an independently-trashed subtree are not listed either, only
//      the subtree's root. Trashing a parent stamps the whole subtree with one
//      value, and both restore and purge act on the whole of it, so a row per reply
//      would be a row per thing you cannot do separately - and the one action it
//      WOULD allow, restoring a reply on its own, is the incoherent one: it leaves
//      a visible answer under a parent that is still in the bin.
const INDEPENDENT_COMMENT =
  'c.deleted_at IS NOT NULL' +
  ' AND (p.deleted_at IS NULL OR p.deleted_at <> c.deleted_at)' +
  ' AND NOT EXISTS (SELECT 1 FROM comments pc' +
  '                  WHERE pc.id = c.parent_comment_id AND pc.deleted_at = c.deleted_at)';

function counts() {
  return {
    posts: db.prepare('SELECT COUNT(*) AS c FROM posts WHERE deleted_at IS NOT NULL').get().c,
    comments: db
      .prepare(
        `SELECT COUNT(*) AS c FROM comments c LEFT JOIN posts p ON p.id = c.post_id
          WHERE ${INDEPENDENT_COMMENT}`
      )
      .get().c,
    users: db.prepare('SELECT COUNT(*) AS c FROM users WHERE deleted_at IS NOT NULL').get().c,
    media: db.prepare('SELECT COUNT(*) AS c FROM media WHERE deleted_at IS NOT NULL').get().c,
  };
}

// Each folder's own query, and the order it is read in. The ORDER BY lives beside
// the SELECT rather than being appended by list() because three of the four join
// `users` - and users has a deleted_at and an id of its own now, so an unqualified
// `ORDER BY deleted_at` is an ambiguous-column error, not a tie-break. (It is also
// why the count wraps only `select`: an ORDER BY inside a scalar subquery is legal
// but says nothing.)
const LIST_SQL = {
  posts: {
    select: `
    SELECT p.id, p.title, p.slug, p.status, p.views, p.deleted_at,
           u.name AS author_name,
           (SELECT COUNT(*) FROM comments c
             WHERE c.post_id = p.id AND c.deleted_at = p.deleted_at) AS trashed_comments
      FROM posts p LEFT JOIN users u ON u.id = p.author_id
     WHERE p.deleted_at IS NOT NULL`,
    order: 'p.deleted_at DESC, p.id DESC',
  },
  comments: {
    select: `
    SELECT c.id, c.content, c.created_at, c.deleted_at,
           p.id AS post_id, p.title AS post_title, p.slug AS post_slug,
           p.deleted_at AS post_deleted_at,
           u.name AS author_name
      FROM comments c
      LEFT JOIN posts p ON p.id = c.post_id
      LEFT JOIN users u ON u.id = c.user_id
     WHERE ${INDEPENDENT_COMMENT}`,
    order: 'c.deleted_at DESC, c.id DESC',
  },
  users: {
    select: `
    SELECT u.id, u.name, u.email, u.role, u.created_at, u.deleted_at,
           (SELECT COUNT(*) FROM posts p WHERE p.author_id = u.id AND p.deleted_at IS NULL) AS live_posts,
           (SELECT COUNT(*) FROM comments c WHERE c.user_id = u.id AND c.deleted_at IS NULL) AS live_comments
      FROM users u
     WHERE u.deleted_at IS NOT NULL`,
    order: 'u.deleted_at DESC, u.id DESC',
  },
  media: {
    select: `
    SELECT m.id, m.filename, m.original_name, m.mime_type, m.bytes, m.width, m.height,
           m.created_at, m.deleted_at, u.name AS uploader_name
      FROM media m LEFT JOIN users u ON u.id = m.uploader_id
     WHERE m.deleted_at IS NOT NULL`,
    order: 'm.deleted_at DESC, m.id DESC',
  },
};

function list(kind, page = 1, limit = 20) {
  const q = LIST_SQL[kind];
  if (!q) return { error: 'Loại không hợp lệ.' };
  const total = db.prepare(`SELECT COUNT(*) AS c FROM (${q.select})`).get().c;
  const items = db
    .prepare(`${q.select} ORDER BY ${q.order} LIMIT ? OFFSET ?`)
    .all(limit, (page - 1) * limit);
  return { items, total };
}

module.exports = {
  KINDS,
  stamp,
  commentSubtree,
  trash,
  restore,
  purge,
  counts,
  list,
};

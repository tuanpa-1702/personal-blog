// The deletion log behind activity_log (see the table's comment in db.js).
//
// One function, because a post can leave the database from two places and both have
// to be recorded the same way:
//
//   - DELETE /api/posts/:id        its author, or an admin (routes/posts.js)
//   - DELETE /api/admin/users/:id  every post they wrote goes with the account,
//                                  through the foreign key's ON DELETE CASCADE
//                                  (routes/admin.js)
//
// The second is the one that would otherwise leave no trace at all: an admin deletes
// an editor, a dozen published posts disappear with them, and nothing anywhere says
// what they were called. The cascade cannot be intercepted, so the caller reads the
// posts first and hands them here - logPostsDeletedWith() exists for exactly that.

const db = require('./db');

const insert = db.prepare(
  `INSERT INTO activity_log (kind, actor_id, actor_name, post_id, post_title, post_slug, detail)
   VALUES ('post_deleted', @actor_id, @actor_name, @post_id, @post_title, @post_slug, @detail)`
);

// What the post was at the moment it went. Views are only worth recording once there
// are any: "Bài đã đăng · 0 lượt xem" is a fact nobody is looking for.
function describePost(post) {
  const parts = [post.status === 'draft' ? 'Bản nháp' : 'Bài đã đăng'];
  const views = Number(post.views) || 0;
  if (views > 0) parts.push(`${views} lượt xem`);
  return parts.join(' · ');
}

// `post` MUST be the row as it was before the delete - the log records what was lost,
// so it is read first and passed in. `actor` is whoever pressed the button (req.user,
// which carries id and name); `reason` is appended to the description when the post
// did not go on its own, e.g. 'xoá cùng tài khoản'.
function logPostDeletion(post, actor, reason) {
  if (!post) return;
  const detail = reason ? `${describePost(post)} · ${reason}` : describePost(post);
  insert.run({
    // A null actor_id keeps the row rather than dropping it: an audit entry that says
    // "a post called X was deleted" is still worth more than no entry.
    actor_id: actor && actor.id ? Number(actor.id) : null,
    actor_name: (actor && actor.name) || '',
    post_id: Number(post.id),
    post_title: post.title || '',
    post_slug: post.slug || '',
    detail,
  });
}

// The cascade case. Wrapped in one transaction, so either every post the account took
// with it is recorded or none is. better-sqlite3 turns a transaction inside a
// transaction into a SAVEPOINT, so this stays correct when the caller has already
// opened one around the DELETE itself (routes/admin.js does).
function logPostsDeletedWith(posts, actor, reason) {
  const list = Array.isArray(posts) ? posts : [];
  if (!list.length) return list.length;
  const tx = db.transaction((rows) => {
    for (const post of rows) logPostDeletion(post, actor, reason);
  });
  tx(list);
  return list.length;
}

module.exports = { logPostDeletion, logPostsDeletedWith };

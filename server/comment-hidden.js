// Hiding a comment subtree (moderation), the lighter sibling of the recycle bin.
//
// The bin (trash-store.js) and this module solve the same problem - "one operation
// touches a comment and its whole reply subtree, and undoing it must touch exactly
// that group" - so both borrow the same two tools rather than growing a second
// copy: stamp() for a group key that cannot collide, and commentSubtree() for the
// BFS over parent_comment_id. A second millisecond-stepping stamp here would
// reintroduce the very collision bug stamp()'s comment (trash-store.js:22-38) was
// written to fix.
//
// How it differs from the bin, and why it is not the bin:
//   - A trashed comment is gone from every route and lives only in Admin > Thùng
//     rác. A HIDDEN comment is still live: readers get no row at all, the comment's
//     own author sees a notice in its place, and an admin sees it with an unhide
//     button. Moderation that a reader can watch happen is moderation that teaches
//     nothing; a comment that silently vanishes teaches the wrong lesson to its
//     author.
//   - Hiding never moves or deletes anything, so it needs no file handling and no
//     purge path.
//
// hidden_at is the group key, exactly as deleted_at is for the bin: one identical
// value on every row of the hidden group, and unhide clears precisely the rows
// wearing the stamp it was handed - so unhiding a parent does not resurrect a
// reply an admin hid separately earlier.

const db = require('./db');
const { stamp, commentSubtree } = require('./trash-store');

function hide(id) {
  const comment = db.prepare('SELECT id, hidden_at FROM comments WHERE id = ?').get(id);
  if (!comment) return { error: 'Không tìm thấy bình luận.' };
  if (comment.hidden_at) return { error: 'Bình luận đã bị ẩn rồi.' };
  const ids = commentSubtree(id);
  const now = stamp();
  const placeholders = ids.map(() => '?').join(', ');
  // `affected` is the rows the UPDATE actually touched, not ids.length: a reply
  // that was already hidden separately keeps its own stamp (see unhide()), and
  // counting it here would tell the admin this hide took a row it did not take.
  const changes = db
    .prepare(`UPDATE comments SET hidden_at = ? WHERE hidden_at IS NULL AND id IN (${placeholders})`)
    .run(now, ...ids).changes;
  return { ok: true, hiddenAt: now, affected: changes };
}

function unhide(id) {
  const comment = db.prepare('SELECT id, hidden_at FROM comments WHERE id = ?').get(id);
  if (!comment) return { error: 'Không tìm thấy bình luận.' };
  if (!comment.hidden_at) return { error: 'Bình luận không ở trạng thái ẩn.' };
  const ids = commentSubtree(id);
  const placeholders = ids.map(() => '?').join(', ');
  // `hidden_at = ?`, not `hidden_at IS NOT NULL`: clear exactly the group this row
  // was hidden with, the same way restoreComment() (trash-store.js) restores only
  // the rows sharing one stamp.
  const changes = db
    .prepare(`UPDATE comments SET hidden_at = NULL WHERE hidden_at = ? AND id IN (${placeholders})`)
    .run(comment.hidden_at, ...ids).changes;
  return { ok: true, hiddenAt: null, affected: changes };
}

module.exports = { hide, unhide };

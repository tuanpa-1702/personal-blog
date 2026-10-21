// Admin audit trail (security.md item 20).
//
// Distinct from server/activity-log.js, which is the PUBLIC "hoạt động gần đây"
// feed and only ever records an irreversible post purge. This one is admin-only,
// never rendered to a reader, and covers the actions security.md flagged as
// unaccountable: role change, password reset, and the trash of a user/post/
// comment (media rides along for free - it goes through the same trashStore.trash()
// chokepoint).
//
// Insert-only, like activity_log - nothing here is ever read back by the app
// today. It exists so a "who did this and when" question has an answer instead
// of only a guess from who currently holds which role. actor_id/actor_name and
// target_label are denormalized so a row still reads correctly after the
// actor's own account, or the row it names, is later deleted or purged.

const db = require('./db');

const insert = db.prepare(
  `INSERT INTO audit_log (actor_id, actor_name, action, target_type, target_id, target_label, detail)
   VALUES (@actor_id, @actor_name, @action, @target_type, @target_id, @target_label, @detail)`
);

// `actor` is req.user (carries id + name); a missing actor is recorded as a null
// actor_id rather than dropped, the same trade activity-log.js makes - a row
// that says "someone reset this password" is still worth more than no row.
function log({ actor, action, targetType, targetId, targetLabel = '', detail = '' }) {
  insert.run({
    actor_id: actor && actor.id ? Number(actor.id) : null,
    actor_name: (actor && actor.name) || '',
    action: String(action),
    target_type: String(targetType),
    target_id: targetId != null ? Number(targetId) : null,
    target_label: String(targetLabel || ''),
    detail: String(detail || ''),
  });
}

module.exports = { log };

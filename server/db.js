const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

// Loads .env from the project root (not the CWD) and refuses to start without a
// real JWT_SECRET. Required here as well as in server.js because seeding below
// reads ADMIN_PASSWORD, and because `node server/seed.js` enters through this
// file rather than through server.js.
require('./env');

const { BCRYPT_ROUNDS, MIN_ADMIN_SEED_PASSWORD_LENGTH } = require('./password');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'blog.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  avatar_url TEXT DEFAULT 'https://api.dicebear.com/7.x/thumbs/svg?seed=default',
  bio TEXT DEFAULT '',
  -- Facebook-style cover banner on profile.html, above the avatar. Empty means
  -- no cover has been set - profile.js then shows a plain surface tint rather
  -- than a placeholder image nobody chose.
  cover_image TEXT NOT NULL DEFAULT '',
  -- One-line status under the bio ("Bạn đang nghĩ gì?"), edited inline on the
  -- profile card itself rather than on the bio's own form - see profile.js.
  status_text TEXT NOT NULL DEFAULT '',
  -- Both shown on the public profile alongside name/bio - the edit form says
  -- so directly (see profile.html), rather than the site silently deciding
  -- that for the account holder. Optional; an empty string is "not given",
  -- not "given as blank", the same convention bio/status_text already use.
  location TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'readonly', -- 'admin' | 'editor' | 'readonly'
  auth_provider TEXT NOT NULL DEFAULT 'local', -- 'local' | 'google'
  email_notifications INTEGER NOT NULL DEFAULT 0, -- 1 = notify by email when a new post is published
  is_active INTEGER NOT NULL DEFAULT 1, -- 0 = disabled by an admin: cannot log in, existing sessions stop working
  -- 0 = registered but has not entered the OTP sent to this address yet, so
  -- cannot log in. Only POST /api/auth/register writes 0; Google accounts and
  -- admin-created ones are verified by definition. Defaults to 1 so accounts
  -- that predate this column keep working.
  email_verified INTEGER NOT NULL DEFAULT 1,
  -- Bumped whenever the password changes (self-service, admin reset, or OTP
  -- reset). The value is copied into every JWT and re-checked on each request,
  -- so changing a password immediately invalidates tokens issued before it.
  -- Without this a stolen 7-day token survived the password change that was
  -- meant to revoke it, which made account recovery impossible.
  token_version INTEGER NOT NULL DEFAULT 0,
  -- THE RECYCLE BIN. Shared by users, posts, comments and media. NULL means the
  -- row is live; a timestamp means it sits in Admin > Thùng rác - skipped by
  -- every public and admin listing, refused by every mutate route, and gone
  -- from sign-in - until it is restored (back to NULL) or purged (the row is
  -- really deleted, which is the only path that removes it). The value doubles
  -- as the grouping key: a post and the comments trashed with it carry the SAME
  -- timestamp, so restoring the post restores exactly that group and nothing a
  -- moderator had trashed on its own earlier. Defaults to NULL so an upgraded
  -- database reads as entirely live.
  deleted_at TEXT DEFAULT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- The terms-of-service document (public/terms.html), as an admin last saved it.
-- EMPTY until the first save: until then the page serves the clauses written
-- into its own markup, which stays the fallback if this row cannot be read.
-- One row for the whole document (see server/terms.js for why): the clauses are
-- an ordered JSON array of { heading, body }, the body in the small plain-text
-- markup server/terms.js renders, and updated_at is the "Cập nhật lần cuối"
-- date, written only at save time.
CREATE TABLE IF NOT EXISTS terms (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  updated_at TEXT NOT NULL,
  clauses_json TEXT NOT NULL
);

-- Outgoing-mail configuration (Admin > Cài đặt email). Deliberately a separate
-- table from the "settings" one: that is exposed by the PUBLIC GET /api/settings,
-- which would leak the SMTP password. Only the admin-only routes read this one.
-- See server/email-config.js for the keys and their defaults.
CREATE TABLE IF NOT EXISTS email_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS password_resets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  otp_code TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  -- Wrong guesses against this row. Mirrors email_verifications.attempts, and for
  -- the same reason: without it a 6-digit code could be brute-forced over HTTP.
  -- This table went without it for a while, which combined with the missing
  -- resend cooldown meant an attacker could hold ~100 live codes at once and
  -- guess freely against all of them.
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Sign-up email verification OTPs. Deliberately NOT the password_resets table:
-- sharing one would make a code mailed to verify a new address also work at
-- POST /api/auth/reset-password, and the other way round.
-- The attempts column counts wrong guesses against the newest unused row, so a
-- 6-digit code that lives for 10 minutes cannot be brute-forced over HTTP.
-- (No backticks anywhere in this comment: the whole schema is one JS template
-- literal, so a backtick here closes it early and db.exec fails to parse.)
CREATE TABLE IF NOT EXISTS email_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  otp_code TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  excerpt TEXT DEFAULT '',
  content TEXT NOT NULL,
  cover_image TEXT DEFAULT '',
  tag TEXT DEFAULT 'Chung',
  hashtags TEXT DEFAULT '[]', -- JSON array of strings, e.g. ["Javascript","DevLife"]
  status TEXT NOT NULL DEFAULT 'published', -- 'draft' | 'published'
  views INTEGER NOT NULL DEFAULT 0,
  author_id INTEGER NOT NULL,
  deleted_at TEXT DEFAULT NULL, -- recycle bin, see the users table; comments of a trashed post share its timestamp
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  parent_comment_id INTEGER DEFAULT NULL,
  content TEXT NOT NULL,
  deleted_at TEXT DEFAULT NULL, -- recycle bin, see the users table; a trashed subtree shares one timestamp
  -- Hidden by an admin (moderation), NOT the recycle bin: readers get no row at
  -- all, the comment's own author sees a notice instead of wondering where their
  -- comment went, and an admin sees it and can unhide. A hidden SUBTREE shares one
  -- timestamp exactly like a trashed one does, so unhiding returns precisely the
  -- group that was hidden - see server/comment-hidden.js.
  hidden_at TEXT DEFAULT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_comment_id) REFERENCES comments(id) ON DELETE CASCADE
);

-- Like / dislike on a post and on a comment. One row per (target, user), so the
-- pair is the primary key: pressing the button that is already active deletes
-- the row (toggle off) and pressing the opposite one overwrites value in place,
-- which is why no vote can ever be counted twice.
--   value: 1 = like, -1 = dislike
-- Totals are summed on read rather than cached on posts/comments: both sides
-- cascade, so a deleted post, comment or user can never leave a stale count.
CREATE TABLE IF NOT EXISTS post_reactions (
  post_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  value INTEGER NOT NULL CHECK (value IN (-1, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (post_id, user_id),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS comment_reactions (
  comment_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  value INTEGER NOT NULL CHECK (value IN (-1, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (comment_id, user_id),
  FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- A signed-in reader's report of a comment (Admin > Thông báo). One row per
-- (comment, reporter), so the pair is UNIQUE - the same shape as
-- comment_reactions right above, and for the same reason: sending the reason you
-- already have WITHDRAWS the report (the row is deleted), sending a different one
-- overwrites it in place, so nobody reports twice and the count never lies.
--
-- reason stores the Vietnamese LABEL, not a code: the record has to stay readable
-- after the reason list is reworded, the same argument activity_log.actor_name
-- makes for snapshotting instead of joining (see that table's comment). The valid
-- list lives in REPORT_REASONS in routes/posts.js - no CHECK here, because SQLite
-- cannot drop a CHECK with ALTER TABLE and rewording the list would mean
-- rebuilding the table.
-- note is the reporter's own optional account, length-capped in the route.
-- status is the admin's outcome ('open' until they look at it); hiding the
-- comment is a separate action and never touches this row.
CREATE TABLE IF NOT EXISTS comment_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open', -- open | resolved | dismissed
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (comment_id, user_id),
  FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_comment_reports_comment ON comment_reports (comment_id);
CREATE INDEX IF NOT EXISTS idx_comment_reports_status ON comment_reports (status, created_at DESC);

-- Deletion log, shown in the "Hoạt động gần đây" feed on Admin > Tổng quan.
--
-- One row per post that was deleted, and the row is meant to OUTLIVE the post. That
-- is why nothing here carries a REFERENCES clause. A foreign key to posts(id) would
-- have to be either ON DELETE CASCADE - which removes the log row in the very
-- statement that removes the post, so the log is always empty exactly when somebody
-- wants to read it - or ON DELETE SET NULL, which blanks the only surviving copy of
-- the title. So post_id is a plain INTEGER: useful for correlating two entries about
-- the same id, never for joining.
--
-- The same reasoning from the other side for the actor. The account that deleted a
-- post can itself be deleted later, so actor_id is nullable and actor_name is a
-- SNAPSHOT rather than something read through a join. routes/admin.js still LEFT
-- JOINs users to pick up the live avatar and the current spelling of the name, and
-- falls back to the snapshot when the row is gone.
--
-- detail holds the one line the feed shows under the title - what the post was when
-- it went ("Bài đã đăng · 1.204 lượt xem"), which is otherwise lost with it.
--
-- kind is a TEXT rather than a boolean so this table can carry the next thing an
-- admin needs a record of (a settings change, a media delete) without a new table;
-- 'post_deleted' is the only value written today.
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'post_deleted',
  actor_id INTEGER,
  actor_name TEXT NOT NULL DEFAULT '',
  post_id INTEGER,
  post_title TEXT NOT NULL DEFAULT '',
  post_slug TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The feed reads this newest-first and one page at a time, which is the whole of
-- what this table is asked to do.
CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log (created_at DESC);

-- Admin audit trail (security.md item 20): who changed a role, deleted or reset
-- a user, or deleted a post/comment. Separate from activity_log above on
-- purpose - that one is the PUBLIC "hoạt động gần đây" feed and only ever
-- records an irreversible post purge; this one is admin-only, never rendered to
-- a reader, and covers a wider set of actions (server/audit-log.js writes it).
-- actor_id/actor_name and target_label are denormalized the same way
-- activity_log's are: a row must still make sense after the actor's account, or
-- the row it names, is itself deleted or purged.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER,
  actor_name TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL, -- 'role_change' | 'password_reset' | 'user_trash' | 'post_trash' | 'comment_trash' | 'media_trash'
  target_type TEXT NOT NULL, -- 'user' | 'post' | 'comment' | 'media'
  target_id INTEGER,
  target_label TEXT NOT NULL DEFAULT '', -- name/title/excerpt at the moment of the action
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log (created_at DESC);

-- The admin's notification inbox (Admin > Thông báo). Four kinds of event, one
-- table - kind is a TEXT rather than a boolean so a fifth kind needs no new table,
-- exactly the choice activity_log above made:
--   'comment_reported'  a signed-in reader reported a comment
--   'new_comment'       somebody commented
--   'new_user'          an account finished signing up (email verified)
--   'comment_hidden'    an admin hid or unhid a comment (audit trail)
--
-- NO REFERENCES anywhere, and that is deliberate rather than an omission - the
-- same argument activity_log records: a notification must OUTLIVE the thing it is
-- about. An FK to comments with ON DELETE CASCADE would delete the "this comment
-- was reported" row in the very statement that deletes the comment, exactly when
-- an admin needs to read it; ON DELETE SET NULL would blank the only surviving
-- copy of the post title. So comment_id / post_id / actor_id are plain INTEGERs:
-- for correlating rows and building links, never for joining.
-- actor_name, post_title, excerpt and reason are SNAPSHOTS taken at write time.
--
-- read_at NULL = unread. That is the entire state behind the rail badge; there is
-- no separate is_read column because two columns would eventually disagree.
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  actor_id INTEGER,
  actor_name TEXT NOT NULL DEFAULT '',
  comment_id INTEGER,
  post_id INTEGER,
  post_title TEXT NOT NULL DEFAULT '',
  post_slug TEXT NOT NULL DEFAULT '',
  excerpt TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  -- 'hide' | 'unhide' for kind 'comment_hidden'; empty for the other kinds.
  action TEXT NOT NULL DEFAULT '',
  read_at TEXT DEFAULT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- This table is asked exactly two questions: the newest page, and how many rows
-- are still unread. created_at is TEXT 'YYYY-MM-DD HH:MM:SS', so lexicographic
-- order IS chronological and the index serves ORDER BY created_at DESC directly -
-- the same reason the posts indexes above order by the bare column.
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications (read_at, created_at DESC);

-- The three reads every public page makes: the homepage/viewall list (status +
-- newest first), a post's comment thread, and an author's own list on profile.
-- created_at is TEXT in 'YYYY-MM-DD HH:MM:SS', so its lexicographic order IS
-- chronological and the index serves ORDER BY created_at DESC directly - which
-- is why the queries order by the bare column, not by datetime(created_at).
CREATE INDEX IF NOT EXISTS idx_posts_status_created ON posts (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_author ON posts (author_id);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments (post_id, created_at);

-- Media library folders (Admin > Thư viện). Nested to any depth.
--
-- parent_id NULL is a top-level folder. ON DELETE CASCADE on the self-reference is
-- what makes deleting a folder remove its whole subtree in one statement. The media
-- rows below are deliberately NOT cascaded - see media.folder_id, which is SET NULL:
-- deleting a folder must never delete the images inside it. They fall back to
-- "unfiled", which is recoverable; a deleted file is not.
--
-- UNIQUE(parent_id, name) stops two identical siblings. It relies on SQLite treating
-- NULLs as distinct, so it does NOT constrain TOP-LEVEL folders - those are checked
-- in the route instead (see routes/media.js).
CREATE TABLE IF NOT EXISTS media_folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (parent_id, name),
  FOREIGN KEY (parent_id) REFERENCES media_folders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_media_folders_parent ON media_folders (parent_id);

-- Media library (Admin > Thư viện). One row per file in public/uploads.
--
-- The FILES are the source of truth for what can be served; this table holds the
-- metadata the library UI needs and the filesystem cannot carry - who uploaded it,
-- what it was originally called, its pixel dimensions. server/media-store.js keeps
-- the two in step at boot: a file with no row is adopted, a row whose file has gone
-- is pruned, so the library never lists an image that cannot load.
--
-- filename is UNIQUE because it is the address the browser uses (/uploads/<name>).
-- uploader_id is nullable and ON DELETE SET NULL rather than CASCADE: deleting the
-- account that uploaded an image must not delete an image other people's posts are
-- still displaying.
CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT '',
  bytes INTEGER NOT NULL DEFAULT 0,
  width INTEGER,
  height INTEGER,
  uploader_id INTEGER,
  -- Which folder this image is filed under; NULL = unfiled. SET NULL rather than
  -- CASCADE: deleting a folder must not delete the images in it.
  folder_id INTEGER,
  -- Recycle bin, see the users table. For media the row is only half the story:
  -- trashing also MOVES the file (and its two derivatives) out of public/uploads
  -- into data/media-trash/, so a trashed image stops being servable, and
  -- restoring moves it back. pruneMissingFiles() skips rows with this set, or it
  -- would reap every trashed row within six hours for "missing" its file.
  deleted_at TEXT DEFAULT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (uploader_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (folder_id) REFERENCES media_folders(id) ON DELETE SET NULL
);

-- The library lists newest-first and filters by uploader; both are covered here.
-- NOTE: the index on folder_id is deliberately NOT here. This whole block runs BEFORE
-- migrate(), and on a database that already has a media table the CREATE TABLE above is
-- a no-op - so folder_id does not exist yet, and indexing a column that is not there
-- fails with "no such column: folder_id". migrate() adds the column and then the index,
-- which covers a fresh database and an upgraded one alike.
-- (No backticks in this comment: the whole schema is one JS template literal, so one
-- here closes it early - the same trap the email_verifications comment warns about.)
CREATE INDEX IF NOT EXISTS idx_media_created ON media (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_uploader ON media (uploader_id);

`);

// --- Migrations for databases created by earlier versions of this app ---
function migrate() {
  // Dead schema (security.md item 27): never read from or written to anywhere in
  // this app. IF EXISTS makes this a no-op once it is gone, so it is safe to
  // leave here rather than remembering to delete the line later.
  db.exec('DROP TABLE IF EXISTS subscribers');

  const userCols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (!userCols.includes('auth_provider')) {
    db.exec("ALTER TABLE users ADD COLUMN auth_provider TEXT NOT NULL DEFAULT 'local'");
  }
  if (!userCols.includes('email_notifications')) {
    db.exec('ALTER TABLE users ADD COLUMN email_notifications INTEGER NOT NULL DEFAULT 0');
  }
  // Accounts created before the admin enable/disable control existed are all
  // active - defaulting to 1 keeps every current user able to log in.
  if (!userCols.includes('is_active')) {
    db.exec('ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1');
  }
  // Same reasoning for sign-up email verification: every account that predates
  // it was created without an OTP step, so it must read as verified. Defaulting
  // to 0 here would lock out every existing user on the first deploy.
  if (!userCols.includes('email_verified')) {
    db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1');
  }
  // Existing sessions keep working across this upgrade: every current token was
  // signed without a token_version, and verifyTokenVersion() in
  // middleware/auth.js treats a missing claim as 0, which matches this default.
  if (!userCols.includes('token_version')) {
    db.exec('ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0');
  }
  // The recycle bin. NULL keeps every existing row live - the only reading that
  // does not empty the site on upgrade.
  if (!userCols.includes('deleted_at')) {
    db.exec('ALTER TABLE users ADD COLUMN deleted_at TEXT DEFAULT NULL');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_deleted ON users (deleted_at)');

  // The Facebook-style cover banner on profile.html, above the avatar. Empty
  // by default like avatar_url's own '' state before a dicebear seed is
  // generated for it - profile.js falls back to a plain surface tint when
  // this is blank, never to a placeholder image nobody chose.
  if (!userCols.includes('cover_image')) {
    db.exec("ALTER TABLE users ADD COLUMN cover_image TEXT NOT NULL DEFAULT ''");
  }

  // The Facebook-style one-line status under the bio on profile.html ("Bạn
  // đang nghĩ gì?"). Deliberately its own column rather than folded into
  // bio: bio is a multi-line paragraph edited on its own form (Chỉnh sửa hồ
  // sơ), while this is a single line, edited inline on the profile card
  // itself and saved on its own (see profile.js) - conflating the two would
  // mean every status change silently rewrote the paragraph beside it.
  if (!userCols.includes('status_text')) {
    db.exec("ALTER TABLE users ADD COLUMN status_text TEXT NOT NULL DEFAULT ''");
  }

  // Location and phone, added to the "Chỉnh sửa hồ sơ" form alongside name/
  // bio - both shown on the public profile, per the note the form itself
  // carries about that. Same empty-string-is-unset convention as bio/
  // status_text above.
  if (!userCols.includes('location')) {
    db.exec("ALTER TABLE users ADD COLUMN location TEXT NOT NULL DEFAULT ''");
  }
  if (!userCols.includes('phone')) {
    db.exec("ALTER TABLE users ADD COLUMN phone TEXT NOT NULL DEFAULT ''");
  }

  // Brute-force counter for the forgot-password OTP. Rows that predate the column
  // start at 0 wrong guesses, which is correct - nothing was counted for them.
  const resetCols = db.prepare('PRAGMA table_info(password_resets)').all().map((c) => c.name);
  if (!resetCols.includes('attempts')) {
    db.exec('ALTER TABLE password_resets ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
  }

  // Folders for the media library. Every existing image starts unfiled (NULL), which
  // is what the "Tất cả ảnh" view shows, so adding folders changes nothing until
  // somebody makes one.
  //
  // No REFERENCES clause here: SQLite cannot add a foreign key with ALTER TABLE, so
  // a database created before this column has the constraint enforced by the routes
  // rather than the schema. That is why routes/media.js checks the folder exists
  // before writing folder_id, and why deleteFolder() clears the column itself
  // instead of relying on ON DELETE SET NULL.
  const mediaCols = db.prepare('PRAGMA table_info(media)').all().map((c) => c.name);
  if (mediaCols.length && !mediaCols.includes('folder_id')) {
    db.exec('ALTER TABLE media ADD COLUMN folder_id INTEGER DEFAULT NULL');
  }
  if (mediaCols.length && !mediaCols.includes('deleted_at')) {
    db.exec('ALTER TABLE media ADD COLUMN deleted_at TEXT DEFAULT NULL');
  }
  // Created here rather than in the schema block above, and unconditionally: a fresh
  // database gets the column from CREATE TABLE, an upgraded one from the ALTER just
  // above, and either way the column exists by this line.
  if (mediaCols.length) {
    db.exec('CREATE INDEX IF NOT EXISTS idx_media_folder ON media (folder_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_media_deleted ON media (deleted_at)');
  }

  const commentCols = db.prepare("PRAGMA table_info(comments)").all().map((c) => c.name);
  if (!commentCols.includes('parent_comment_id')) {
    db.exec('ALTER TABLE comments ADD COLUMN parent_comment_id INTEGER DEFAULT NULL');
  }
  if (!commentCols.includes('deleted_at')) {
    db.exec('ALTER TABLE comments ADD COLUMN deleted_at TEXT DEFAULT NULL');
  }
  // Moderation hide. NULL = visible. Default NULL so an upgraded database changes
  // nothing: every existing comment stays exactly as visible as it was.
  if (!commentCols.includes('hidden_at')) {
    db.exec('ALTER TABLE comments ADD COLUMN hidden_at TEXT DEFAULT NULL');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_comments_deleted ON comments (deleted_at)');
  // Created here, not in the schema block: on an upgraded database hidden_at does
  // not exist until the ALTER above runs, and indexing a missing column fails with
  // "no such column" - the trap documented at idx_media_folder.
  db.exec('CREATE INDEX IF NOT EXISTS idx_comments_hidden ON comments (hidden_at)');

  const postCols = db.prepare("PRAGMA table_info(posts)").all().map((c) => c.name);
  if (!postCols.includes('hashtags')) {
    db.exec("ALTER TABLE posts ADD COLUMN hashtags TEXT DEFAULT '[]'");
  }
  if (!postCols.includes('deleted_at')) {
    db.exec('ALTER TABLE posts ADD COLUMN deleted_at TEXT DEFAULT NULL');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_posts_deleted ON posts (deleted_at)');
  // Older versions only had roles 'user' (could write posts) and 'admin'.
  // Map the old 'user' role to the new 'editor' role so nobody silently loses
  // the ability to write posts they already had.
  db.prepare("UPDATE users SET role = 'editor' WHERE role = 'user'").run();
}
migrate();

// Seed default site settings (only inserted the first time; safe to run every boot)
function ensureSettings() {
  const defaults = {
    // The site name shown in the header logo, and the browser-tab title. Seeded
    // with the current name so the admin form opens on the real value instead of
    // two blank fields; see DEFAULT_SITE_NAME in server/site.js for the fallback
    // used when either is cleared.
    brand_name: 'TuanPA',
    site_title: 'TuanPA',
    hero_badge: 'Chào mừng đến không gian của tôi',
    hero_title: 'Linh ta Linh tinh...',
    hero_subtitle:
      'Chào mừng đến với không gian của những suy nghĩ vẩn vơ, những câu chuyện đời thường và đôi khi là những điều chẳng đâu vào đâu.',
    hero_image: 'https://images.unsplash.com/photo-1499750310107-5fef28a66643?w=1200&q=80',
    footer_text: 'TuanPA.',
  };
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  const tx = db.transaction((entries) => {
    for (const [key, value] of entries) insert.run(key, value);
  });
  tx(Object.entries(defaults));
}
ensureSettings();

// Seeds the first admin account, once, on an empty database.
//
// There is deliberately NO default password any more. The old code fell back to
// 'Admin@123' - a value printed in .env.example and in the README - so every
// deployment that had not edited .env shipped with a publicly known admin login.
// Refusing to seed is the safe failure: the site still runs, it just has no admin
// until ADMIN_PASSWORD is set, whereas seeding a guessable one hands the panel to
// whoever reads the docs.
function ensureAdmin() {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  const name = process.env.ADMIN_NAME || 'Admin';

  // Nothing to do once any admin exists - this is first-run seeding only, so a
  // later .env edit never resurrects a deleted account or resets a live one.
  const anyAdmin = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  if (anyAdmin) return;

  if (!email || !password) {
    console.warn(
      '[seed] Chưa có tài khoản admin nào và ADMIN_EMAIL/ADMIN_PASSWORD chưa được đặt trong .env - bỏ qua bước tạo admin.'
    );
    return;
  }
  if (password.length < MIN_ADMIN_SEED_PASSWORD_LENGTH) {
    console.warn(
      `[seed] ADMIN_PASSWORD quá ngắn (cần tối thiểu ${MIN_ADMIN_SEED_PASSWORD_LENGTH} ký tự) - bỏ qua bước tạo admin.`
    );
    return;
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    // The address is taken by a non-admin account. Promoting it here would be a
    // privilege grant nobody asked for, so leave it and say so.
    console.warn(`[seed] ${email} đã tồn tại nhưng không phải admin - không thay đổi gì.`);
    return;
  }

  const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  db.prepare(
    `INSERT INTO users (name, email, password_hash, role, avatar_url)
     VALUES (?, ?, ?, 'admin', ?)`
  ).run(name, email, hash, `https://api.dicebear.com/7.x/thumbs/svg?seed=${encodeURIComponent(name)}`);
  // The password itself is never logged - it is in the .env the operator just
  // wrote, and a pm2 log is not the place for it.
  console.log(`[seed] Đã tạo tài khoản admin: ${email}`);
}
ensureAdmin();

module.exports = db;

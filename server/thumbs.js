// Thumbnails for the media library grid, and mid-size derivatives for the
// public pages.
//
// The grid used to serve the ORIGINALS: a phone photo is 8-14 MB and roughly
// 12 megapixels, and the library decodes each one down to a tile ~200px wide.
// With a page of 48 that is half a gigabyte of downloads and two-plus GB of
// decoded bitmaps, all while the person is trying to scroll - which is what made
// the tab lag and jolt. The tiles now ask for /uploads/thumb/<file>, a 480px
// JPEG (~30-60 KB) generated from the original.
//
// The public pages - homepage lead card, viewall cards, the post hero and the
// pictures inside a post - used to serve the originals too, and there the
// originals are worse: covers and in-post screenshots run to 12-28 MB each, so
// one article could cost more bytes than the rest of the site combined. They
// now ask for /uploads/w1280/<file>, a 1280px derivative (~100-300 KB) which is
// wider than any column on the site, so nothing visible loses detail. The
// originals stay exactly where they were for the detail panel's copy-URL, the
// picker's insert, and the editor.
//
// Resizing is done by ImageMagick when it is installed on the server
// (sudo apt install -y imagemagick - see the deploy section of README.md). When
// it is NOT, everything here degrades to a no-op: available() is false,
// urlFor() returns the original's own URL, ensure() resolves false, and the
// /uploads/thumb and /uploads/w1280 routes redirect to the original. Every page
// keeps working exactly as before, only slower.
//
// Deliberately NO npm image package for this: node_modules is installed on the
// Ubuntu server (the better-sqlite3 binary is an ELF .node) and the tree is
// edited over a Samba mount. Running npm install from the Windows side to add a
// dependency would re-resolve better-sqlite3 and swap that ELF for a win32
// prebuild, which takes the server down (same reason compress.js is zlib-only).
// ImageMagick is an apt package on the server instead, and it is optional.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// The same directory media-store.js writes uploads into. Duplicated here rather
// than imported because media-store REQUIRES this module: requiring it back
// would be a cycle. If the uploads dir ever moves, it moves in both files.
const PUBLIC_UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads');
const THUMB_DIR = path.join(PUBLIC_UPLOAD_DIR, 'thumbs');
const W1280_DIR = path.join(PUBLIC_UPLOAD_DIR, 'w1280');

for (const dir of [THUMB_DIR, W1280_DIR]) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* the uploads dir is created by media-store; a failure here only means
       derivatives stay off until the next boot */
  }
}

// The names this app writes are <13-digit timestamp>-<16 hex><ext>; adopted
// files keep whatever sane name they arrived with. Either way a valid filename
// is one path segment with a known image extension - which is also the guard
// against /uploads/thumb/../../etc/passwd reaching anything.
const UPLOAD_NAME = /^[\w][\w.-]*\.(jpe?g|png|webp|gif)$/i;

function isUploadName(filename) {
  return typeof filename === 'string' && UPLOAD_NAME.test(filename);
}

// ImageMagick 7 ships `magick`, 6 ships `convert`. Detected once at boot; the
// probe is cheap and a boot-time answer keeps every request out of the question.
function detectTool() {
  for (const bin of ['magick', 'convert']) {
    try {
      const r = spawnSync(bin, ['-version'], { encoding: 'utf8', timeout: 5000 });
      if (r.status === 0 && /ImageMagick/i.test(`${r.stdout || ''}${r.stderr || ''}`)) {
        return bin;
      }
    } catch {
      /* not on PATH */
    }
  }
  return null;
}

const TOOL = detectTool();

function available() {
  return TOOL !== null;
}

// WebP keeps alpha, which the 1280px derivative needs: a transparent diagram on
// a dark-theme page must stay transparent, where the 480px tile flattens onto
// white because a tile never sits on the page background alone. Probed once at
// boot from ImageMagick's own format table - a build without the webp delegate
// (rare but real on minimal installs) gets JPEG everywhere instead of a
// derivative that fails to generate.
function detectWebp() {
  if (!TOOL) return false;
  try {
    const r = spawnSync(TOOL, ['-list', 'format'], { encoding: 'utf8', timeout: 5000 });
    return /\bWEBP\b[^\n]*\brw\b/i.test(`${r.stdout || ''}${r.stderr || ''}`);
  } catch {
    return false;
  }
}

const WEBP = detectWebp();

// The two derivatives, keyed by the path segment the route and the client use.
// `ext` is the OUTPUT extension and part of the on-disk name; the URL always
// carries the ORIGINAL filename, so the client never has to know it.
const VARIANTS = {
  thumb: { dir: THUMB_DIR, ext: '.jpg', resize: '480x480>', quality: '82', flattenAlpha: true },
  w1280: {
    dir: W1280_DIR,
    ext: WEBP ? '.webp' : '.jpg',
    resize: '1280x1280>',
    quality: '72',
    flattenAlpha: !WEBP,
  },
};

// Where a derivative lives: the same basename, in the variant's own directory.
function pathFor(filename, kind = 'thumb') {
  const v = VARIANTS[kind] || VARIANTS.thumb;
  return path.join(v.dir, `${path.basename(filename, path.extname(filename))}${v.ext}`);
}

// The URL form the listing API and the pages hand to the browser. Without
// ImageMagick the original's own URL is returned, so callers need no branch.
function urlFor(filename, kind = 'thumb') {
  return TOOL ? `/uploads/${kind}/${filename}` : `/uploads/${filename}`;
}

// Deletes EVERY derivative of a file. Called when the original goes: a stale
// tile or mid-size copy of a deleted image must not outlive it.
function deleteDerivatives(filename) {
  if (!isUploadName(filename)) return;
  for (const kind of Object.keys(VARIANTS)) {
    try {
      fs.unlinkSync(pathFor(filename, kind));
    } catch {
      /* no derivative is not an error */
    }
  }
}

// ---------------------------------------------------------------- generation
//
// At most two ImageMagick processes at once: a first visit to a big library
// requests one derivative per visible tile, and forty-eight parallel decodes of
// 10 MB originals would pin every core on the server for nothing. Anything
// over the cap queues; each job also dedupes, because two tiles never need the
// same file twice.
const MAX_CONCURRENT = 2;
const inflight = new Map(); // `${kind}:${filename}` -> Promise<boolean>
const queue = [];
let running = 0;

function pump() {
  while (running < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    running += 1;
    runResize(job.filename, job.kind, job.resolve);
  }
}

function runResize(filename, kind, resolve) {
  const v = VARIANTS[kind] || VARIANTS.thumb;
  const src = path.join(PUBLIC_UPLOAD_DIR, filename);
  const dst = pathFor(filename, kind);
  const finish = (ok) => {
    running -= 1;
    resolve(ok);
    pump();
  };

  const args = [
    `${src}[0]`, // a GIF's later frames are animation, not the tile
    '-auto-orient', // phone JPEGs carry their orientation in EXIF
    '-resize',
    v.resize, // shrink to fit; never enlarge
    '-strip', // EXIF out: derivatives are public and GPS tags are nobody's
  ];
  if (v.flattenAlpha) {
    // a JPEG cannot hold alpha; flatten instead of going black
    args.push('-background', 'white', '-alpha', 'remove');
  }
  args.push('-quality', v.quality, dst);

  let child;
  try {
    child = spawn(TOOL, args, { stdio: 'ignore' });
  } catch {
    return finish(false);
  }
  const timer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }, 60_000);
  child.on('error', () => {
    clearTimeout(timer);
    finish(false);
  });
  child.on('exit', (code) => {
    clearTimeout(timer);
    // Existence re-checked: a zero exit with no file would otherwise be served.
    finish(code === 0 && fs.existsSync(dst));
  });
}

// Resolves true once the derivative exists, false if it cannot be made. Safe to
// call for a file that already has one - that is a fast-path `true`.
function ensure(filename, kind = 'thumb') {
  if (!TOOL || !isUploadName(filename) || !VARIANTS[kind]) return Promise.resolve(false);
  const dst = pathFor(filename, kind);
  try {
    if (fs.existsSync(dst)) return Promise.resolve(true);
  } catch {
    return Promise.resolve(false);
  }
  const key = `${kind}:${filename}`;
  if (inflight.has(key)) return inflight.get(key);

  const p = new Promise((resolve) => {
    queue.push({ filename, kind, resolve });
    pump();
  }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

module.exports = {
  PUBLIC_UPLOAD_DIR,
  THUMB_DIR,
  W1280_DIR,
  VARIANTS,
  available,
  isUploadName,
  pathFor,
  urlFor,
  ensure,
  deleteDerivatives,
  // The pre-variant names, kept because media-store.js and server.js speak them.
  thumbPathFor: (filename) => pathFor(filename, 'thumb'),
  thumbUrlFor: (filename) => urlFor(filename, 'thumb'),
  deleteThumb: deleteDerivatives,
  ensureThumb: (filename) => ensure(filename, 'thumb'),
};

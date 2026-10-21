// Minifies the frontend into public/js/*.min.js and public/css/*.min.css.
// Run ON THE SERVER, once esbuild is reachable - any ONE of these, none of
// which touches the project's node_modules:
//
//   sudo npm install -g esbuild                 # global, needs root
//   sudo apt install -y esbuild                 # distro package, on PATH
//   npm install --prefix ~/esbuild-tool esbuild # no root, own directory
//   ESBUILD_BIN=~/esbuild-tool/node_modules/.bin/esbuild node scripts/build-assets.js
//
// The script looks for the binary in $ESBUILD_BIN, then in its first argument,
// then on PATH and in the usual places, so the --prefix route needs no PATH
// edit: pass the binary or export ESBUILD_BIN once.
//
// Keeping esbuild OUT of the project tree is the point: this project's
// node_modules lives on the Ubuntu server and is edited over a Samba mount, and
// an `npm install` inside the tree re-resolves better-sqlite3 and swaps its ELF
// .node for a win32 prebuild, which takes the site down (the same reason
// compress.js is zlib-only and security-headers.js is hand-written).
//
// The pages keep referencing the UNminified names (/js/api.js, /css/common.css).
// server.js rewrites such a request to the sibling .min file whenever one
// exists, so deploying the minified output is a copy + this script, with no
// markup change and no window in which a page points at a file that is not
// there yet. Delete the .min files (or never create them) and the site serves
// the readable originals - which is also what this Windows editing box does,
// since esbuild is not installed here.
//
// tailwind.css is skipped: `npm run build:css` already emits it minified.
// Sources are never overwritten; the .min files are derived output and are
// listed in .gitignore-style fashion by being regenerable at any time.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');

const JS_SOURCES = ['api.js', 'theme.js', 'home.js', 'viewall.js', 'post.js', 'profile.js', 'write.js', 'admin.js', 'media.js', 'terms.js', 'about.js'];
const CSS_SOURCES = ['common.css', 'media.css', 'fonts.css', 'write.css'];

// A candidate answers `--version` with a bare semver; that is the whole probe,
// and it doubles as proof the binary can actually run on this architecture.
function findEsbuild() {
  const candidates = [
    process.env.ESBUILD_BIN,
    process.argv[2],
    'esbuild',
    path.join(os.homedir(), '.local', 'bin', 'esbuild'),
    path.join(os.homedir(), 'esbuild-tool', 'node_modules', '.bin', 'esbuild'),
    '/usr/local/bin/esbuild',
    '/usr/bin/esbuild',
  ].filter(Boolean);
  for (const bin of candidates) {
    try {
      const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000 });
      if (r.status === 0 && /^\d+\.\d+\.\d+/.test(String(r.stdout || '').trim())) return bin;
    } catch {
      /* not on this path */
    }
  }
  return null;
}

function minify(bin, src, dst) {
  // No --loader flag: esbuild picks the loader from the input's own extension,
  // and the extensionless form of the flag is only valid when reading stdin.
  const r = spawnSync(bin, [src, '--minify', `--outfile=${dst}`], {
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    console.error(`[build] LỖI ${path.basename(src)}: ${(r.stderr || r.stdout || '').trim()}`);
    return null;
  }
  return fs.statSync(dst).size;
}

const bin = findEsbuild();
if (!bin) {
  console.error(
    'Không tìm thấy esbuild. Cài MỘT trong ba cách (đừng npm install trong cây dự án):\n' +
      '  sudo npm install -g esbuild\n' +
      '  sudo apt install -y esbuild\n' +
      '  npm install --prefix ~/esbuild-tool esbuild\n' +
      '    rồi:  ESBUILD_BIN=~/esbuild-tool/node_modules/.bin/esbuild node scripts/build-assets.js'
  );
  process.exit(1);
}
console.log(`[build] dùng esbuild tại: ${bin}`);

let saved = 0;
for (const [dir, names] of [
  ['js', JS_SOURCES],
  ['css', CSS_SOURCES],
]) {
  for (const name of names) {
    const src = path.join(PUBLIC, dir, name);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(PUBLIC, dir, name.replace(/\.(js|css)$/, '.min.$1'));
    const out = minify(bin, src, dst);
    if (out === null) continue;
    const before = fs.statSync(src).size;
    saved += before - out;
    console.log(
      `[build] ${dir}/${name}  ${(before / 1024).toFixed(0)} KB -> ${(out / 1024).toFixed(0)} KB`
    );
  }
}
console.log(`[build] Xong. Tiết kiệm ${(saved / 1024).toFixed(0)} KB trước khi gzip.`);

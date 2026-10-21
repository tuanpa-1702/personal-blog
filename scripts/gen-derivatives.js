// Pre-generates both image derivatives (480px thumb + 1280px mid) for every
// file already in public/uploads, so the first visitor after a deploy does not
// pay for a resize mid-page-view. Run ON THE SERVER, where ImageMagick lives:
//
//   node scripts/gen-derivatives.js
//
// Safe to re-run at any time: a derivative that already exists is a fast-path
// skip, and the resize queue in server/thumbs.js caps ImageMagick at two
// processes so this never competes with live traffic for every core. Files it
// cannot decode are reported and left alone - the routes fall back to the
// original for those, exactly as they do when ImageMagick is absent.
//
// Exits non-zero only if ImageMagick is not installed at all, so a cron line
// or a deploy step can rely on it.

const fs = require('fs');
const path = require('path');
const thumbs = require('../server/thumbs');

if (!thumbs.available()) {
  console.error('ImageMagick không khả dụng trên máy này - không có derivative nào được sinh.');
  process.exit(1);
}

const names = fs
  .readdirSync(thumbs.PUBLIC_UPLOAD_DIR)
  .filter((n) => thumbs.isUploadName(n) && fs.statSync(path.join(thumbs.PUBLIC_UPLOAD_DIR, n)).isFile());

const kinds = Object.keys(thumbs.VARIANTS);
console.log(`[deriv] ${names.length} file gốc, ${kinds.length} biến thể (${kinds.join(', ')}).`);

let made = 0;
let skipped = 0;
let failed = 0;

(async () => {
  for (const name of names) {
    for (const kind of kinds) {
      const dst = thumbs.pathFor(name, kind);
      if (fs.existsSync(dst)) {
        skipped += 1;
        continue;
      }
      const ok = await thumbs.ensure(name, kind);
      if (ok) made += 1;
      else {
        failed += 1;
        console.error(`[deriv] KHÔNG sinh được ${kind}/${name}`);
      }
    }
  }
  console.log(`[deriv] Xong: sinh mới ${made}, đã có sẵn ${skipped}, lỗi ${failed}.`);
})();

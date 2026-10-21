// Environment loading + fail-fast validation.
//
// Required by EVERY entry point (server.js, db.js, the auth modules) before any
// secret is read, for two reasons:
//
//  1. The .env path is resolved from __dirname, not from the current working
//     directory. `require('dotenv').config()` looks for ./.env relative to CWD,
//     so starting the app from anywhere other than the project root - which is
//     exactly what `pm2 start server/server.js` does after a `pm2 resurrect` -
//     silently loaded NOTHING. Every secret then fell back to its default.
//
//  2. Those defaults were the real problem. JWT_SECRET fell back to the string
//     'dev_secret', which is published in this repository: anybody could sign
//     themselves an admin token. A missing secret must stop the process, not be
//     papered over with a guessable constant.
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Long enough that it cannot be brute-forced offline from a captured token.
// `openssl rand -hex 32` produces 64.
const MIN_JWT_SECRET_LENGTH = 32;

function fail(message) {
  console.error('\n[config] KHÔNG THỂ KHỞI ĐỘNG:', message, '\n');
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET || '';

if (!JWT_SECRET) {
  fail(
    'Thiếu JWT_SECRET.\n' +
      `  Tạo một giá trị mới:  openssl rand -hex 32\n` +
      `  Rồi thêm vào ${path.join(__dirname, '..', '.env')}:  JWT_SECRET=<giá trị vừa tạo>`
  );
}
if (JWT_SECRET.length < MIN_JWT_SECRET_LENGTH) {
  fail(`JWT_SECRET quá ngắn (${JWT_SECRET.length} ký tự, cần tối thiểu ${MIN_JWT_SECRET_LENGTH}).`);
}
// The old fallback, and the placeholder shipped in .env.example. Either one in a
// real .env means the file was copied but never edited.
if (JWT_SECRET === 'dev_secret' || JWT_SECRET === 'change_this_to_a_long_random_string') {
  fail('JWT_SECRET vẫn là giá trị mẫu. Đặt một giá trị ngẫu nhiên: openssl rand -hex 32');
}

module.exports = { JWT_SECRET };

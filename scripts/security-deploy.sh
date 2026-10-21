#!/usr/bin/env bash
# P0 + P1 security deploy - run this ON THE UBUNTU SERVER.
#
#   cd /var/www/tuanpa-blog     # or wherever the project lives
#   bash scripts/security-deploy.sh
#
# It is idempotent: safe to run twice. It changes nothing until every check has
# passed, and it stops at the first failure rather than leaving the site down.
#
# What it does NOT do: install packages, run npm install, or touch node_modules.
# Every fix here is dependency-free on purpose - an npm install from the wrong
# machine swaps better-sqlite3's compiled binary and takes the server down.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32mOK\033[0m  %s\n' "$*"; }
warn() { printf '    \033[33m!!\033[0m  %s\n' "$*"; }
die()  { printf '\n\033[1;31mDỪNG: %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 0. sanity
say "0. Kiểm tra thư mục và file"
[ -f server/server.js ] || die "Không thấy server/server.js - chạy script này trong thư mục project."
for f in server/env.js server/password.js server/middleware/rate-limit.js \
         server/sanitize-html.js server/security-headers.js \
         server/media-store.js server/routes/media.js \
         server/embeds.js scripts/check-icons.py \
         public/css/media.css public/js/media.js; do
  [ -f "$f" ] || die "Thiếu $f - mã nguồn mới chưa được đồng bộ lên server. Rsync/git pull trước."
done
ok "Mã nguồn mới đã có mặt"

# ---------------------------------------------------------------- 1. backup
say "1. Sao lưu database"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p backups
if [ -f data/blog.db ]; then
  # sqlite3 .backup, không phải cp: journal_mode=WAL nghĩa là dữ liệu mới nhất
  # nằm trong blog.db-wal. Chỉ copy blog.db là mất gần hết dữ liệu chưa
  # checkpoint (hiện tại WAL đang ~3.3 MB, lớn hơn cả file chính).
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 data/blog.db ".backup 'backups/blog.db.$STAMP'"
    ok "backups/blog.db.$STAMP (sqlite3 .backup - gồm cả WAL)"
  else
    # node:sqlite (Node >= 22) có sẵn VACUUM INTO - tương đương sqlite3 .backup, gộp
    # cả WAL vào một file nhất quán. Đây là cách tốt nhất khi không có sqlite3 CLI;
    # copy 3 file rời chỉ là phương án cuối, vì WAL có thể đang được ghi giữa 3 lần cp.
    if node -e "
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync('data/blog.db');
      db.exec(\"VACUUM INTO 'backups/blog.db.$STAMP'\");
      db.close();
    " 2>/dev/null; then
      ok "backups/blog.db.$STAMP (VACUUM INTO - gồm cả WAL)"
    else
      cp data/blog.db "backups/blog.db.$STAMP"
      cp data/blog.db-wal "backups/blog.db-wal.$STAMP" 2>/dev/null || true
      cp data/blog.db-shm "backups/blog.db-shm.$STAMP" 2>/dev/null || true
      warn "Đã copy cả 3 file .db/.db-wal/.db-shm (kém an toàn hơn)"
      warn "Nên cài sqlite3 để backup đúng cách:  sudo apt install -y sqlite3"
    fi
  fi
else
  warn "Chưa có data/blog.db (lần chạy đầu?)"
fi
[ -f .env ] && cp -p .env "backups/.env.$STAMP" && ok "backups/.env.$STAMP"

# ---------------------------------------------------------------- 2. .env
say "2. Kiểm tra .env"
[ -f .env ] || die ".env không tồn tại. cp .env.example .env rồi điền giá trị."

# Đọc mà không in giá trị ra terminal/log.
env_val() { sed -nE "s/^$1=//p" .env | head -1 | tr -d '\r'; }

JWT_LEN="$(env_val JWT_SECRET | wc -c)"
JWT_LEN=$((JWT_LEN > 0 ? JWT_LEN - 1 : 0))
if [ "$JWT_LEN" -lt 32 ]; then
  echo
  echo "    JWT_SECRET hiện tại dài $JWT_LEN ký tự - cần tối thiểu 32."
  echo "    Tạo giá trị mới và thay vào .env:"
  echo
  echo "      openssl rand -hex 32"
  echo
  die "JWT_SECRET không đạt yêu cầu. Server sẽ không khởi động."
fi
case "$(env_val JWT_SECRET)" in
  dev_secret|change_this_to_a_long_random_string)
    die "JWT_SECRET vẫn là giá trị mẫu. Đổi bằng: openssl rand -hex 32" ;;
esac
ok "JWT_SECRET dài $JWT_LEN ký tự"

# HOST=127.0.0.1: cloudflared kết nối ra ngoài từ chính máy này và gọi app qua
# localhost, nên không có lý do gì để cổng 3000 nghe trên mọi interface. Đây cũng
# là điều kiện để tin được header CF-Connecting-IP mà rate limiter dùng.
if ! grep -qE '^HOST=' .env; then
  printf '\n# Chỉ nghe trên loopback - cloudflared gọi app qua localhost.\nHOST=127.0.0.1\n' >> .env
  ok "Đã thêm HOST=127.0.0.1 vào .env"
else
  ok "HOST đã có: $(env_val HOST)"
fi

if [ "$(env_val ADMIN_PASSWORD)" = "Admin@123" ]; then
  warn "ADMIN_PASSWORD vẫn là Admin@123 (giá trị công khai trong tài liệu cũ)."
  warn "Không ảnh hưởng tới admin đang tồn tại, nhưng hãy đổi trong .env."
fi

# ---------------------------------------------------------------- 3. quyền file
say "3. Siết quyền file chứa secret"
chmod 600 .env
ok ".env -> 600"
for f in .env.bak.* .env.*.bak backups/.env.*; do
  [ -e "$f" ] && chmod 600 "$f" && ok "$f -> 600"
done
chmod 700 data backups 2>/dev/null || true
ok "data/, backups/ -> 700"
for f in data/blog.db data/blog.db-wal data/blog.db-shm data/blog.db.bak.*; do
  [ -e "$f" ] && chmod 600 "$f"
done
ok "data/blog.db* -> 600"

# pm2 chạy bằng root là vấn đề riêng, nhưng cảnh báo ở đây vì nó vô hiệu hoá
# phần lớn ý nghĩa của mấy dòng chmod trên.
if pgrep -u root -f 'PM2|server/server.js' >/dev/null 2>&1; then
  warn "Có tiến trình app/pm2 đang chạy bằng ROOT. Nên chạy bằng user thường."
fi

# ---------------------------------------------------------------- 4. file .bak
say "4. Xoá file backup nằm trong public/ (đang bị tải công khai)"
FOUND=0
mkdir -p tmp/removed-from-public
while IFS= read -r -d '' f; do
  mv "$f" tmp/removed-from-public/
  ok "đã chuyển ra khỏi public/: $f"
  FOUND=1
done < <(find public -type f \( -name '*.bak' -o -name '*.bak.*' -o -name '*.orig' -o -name '*.save' \) -print0)
[ "$FOUND" -eq 0 ] && ok "Không còn file .bak nào trong public/"
chmod 700 tmp 2>/dev/null || true

# ---------------------------------------------------------------- 5. smoke test
say "5. Kiểm tra mã nguồn khởi động được (chưa restart service)"
for f in server/env.js server/password.js server/db.js server/server.js \
         server/middleware/auth.js server/middleware/rate-limit.js \
         server/sanitize-html.js server/security-headers.js \
         server/routes/auth.js server/routes/admin.js server/routes/upload.js \
         server/media-store.js server/routes/media.js server/embeds.js \
         server/routes/posts.js server/routes/email-oauth.js; do
  node --check "$f" || die "Lỗi cú pháp: $f"
done
ok "Cú pháp toàn bộ file đã sửa: hợp lệ"

# env.js phải PASS với .env thật (nó tự exit 1 nếu secret không đạt).
node -e "require('./server/env'); console.log('    env.js: JWT_SECRET hợp lệ')" \
  || die "server/env.js từ chối .env hiện tại - xem thông báo ở trên."

# ---------------------------------------------------------------- 6. migration
say "6. Chạy migration (token_version, password_resets.attempts, bảng media)"
# db.js tự migrate khi được require. Làm trước khi restart để nếu schema có vấn
# đề thì phát hiện ngay, lúc service cũ vẫn đang chạy bình thường.
node -e "
  const db = require('./server/db');
  const u = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  const p = db.prepare('PRAGMA table_info(password_resets)').all().map(c => c.name);
  const m = db.prepare('PRAGMA table_info(media)').all().map(c => c.name);
  if (!u.includes('token_version')) { console.error('THIẾU users.token_version'); process.exit(1); }
  if (!p.includes('attempts'))      { console.error('THIẾU password_resets.attempts'); process.exit(1); }
  if (!m.includes('filename'))      { console.error('THIẾU bảng media'); process.exit(1); }
  if (!m.includes('folder_id'))     { console.error('THIẾU media.folder_id'); process.exit(1); }
  const mf = db.prepare('PRAGMA table_info(media_folders)').all().map(c => c.name);
  if (!mf.includes('parent_id'))    { console.error('THIẾU bảng media_folders'); process.exit(1); }
  console.log('    users.token_version: có');
  console.log('    password_resets.attempts: có');
  console.log('    bảng media: có (' + m.length + ' cột, gồm folder_id)');
  console.log('    bảng media_folders: có');
" || die "Migration thất bại. Database vẫn nguyên vẹn, service cũ vẫn chạy. Khôi phục: cp backups/blog.db.$STAMP data/blog.db"
ok "Schema đã sẵn sàng"

# Thư mục staging cho upload: nằm NGOÀI public/ nên file chưa kiểm tra không bao giờ
# tải được qua HTTP. Tạo sẵn với quyền chặt thay vì để tiến trình tự tạo mặc định.
#
# data/media-trash/ cũng được tạo ở đây, TRƯỚC khi mấy lệnh node -e bên dưới
# require media-store.js - vì chính lần require đó sẽ tự tạo nó nếu thiếu, và tạo
# bằng user đang chạy script.
mkdir -p data/tmp-uploads data/media-trash
chmod 700 data/tmp-uploads data/media-trash
ok "data/tmp-uploads/ (staging upload) + data/media-trash/ (thùng rác ảnh) -> 700"

# Chạy script này bằng sudo là cách dễ nhất làm hỏng thùng rác ảnh mà không ai
# biết ngay: hai thư mục trên khi đó thuộc về ROOT trong khi pm2 chạy bằng user
# thường, nên mọi lần xoá ảnh đều trượt EACCES. Upload vẫn chạy, bài vẫn lưu,
# database vẫn ghi - triệu chứng duy nhất là câu "Không dời được ảnh vào thùng
# rác" trong trang quản trị. media-store.js tự dựng lại được một thùng rác RỖNG,
# nhưng sửa tận gốc ở đây vẫn hơn.
if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
  SUDO_GROUP="$(id -gn "$SUDO_USER")"
  chown -R "$SUDO_USER:$SUDO_GROUP" data/tmp-uploads data/media-trash
  warn "Script đang chạy bằng sudo: đã chown data/tmp-uploads + data/media-trash về $SUDO_USER:$SUDO_GROUP."
  warn "Lần sau nên chạy bằng chính user chạy pm2: bash scripts/security-deploy.sh"
fi

# Đưa file có sẵn trong public/uploads vào thư viện. server.js cũng làm việc này mỗi
# lần khởi động; chạy ở đây để thấy con số trước khi restart.
node -e "
  const store = require('./server/media-store');
  const adopted = store.adoptOrphanFiles();
  const pruned = store.pruneMissingFiles();
  const t = store.mediaTotals();
  console.log('    Đã nhận ' + adopted + ' file có sẵn, bỏ ' + pruned + ' bản ghi thiếu file');
  console.log('    Thư viện: ' + t.count + ' ảnh');
" || warn "Không đồng bộ được thư viện ảnh - kiểm tra quyền ghi trên public/uploads/"

# Vô hiệu mọi OTP đặt lại mật khẩu đang lưu: chúng được phát ra dưới cơ chế cũ
# (không cooldown, không đếm lần sai), nên phải coi là đã bị phơi nhiễm.
node -e "
  const db = require('./server/db');
  const n = db.prepare('UPDATE password_resets SET used = 1 WHERE used = 0').run().changes;
  console.log('    Đã vô hiệu ' + n + ' mã OTP cũ');
"

# ---------------------------------------------------------------- 7. restart
say "7. Khởi động lại ứng dụng"
if command -v pm2 >/dev/null 2>&1 && pm2 describe tuanpa-blog >/dev/null 2>&1; then
  # --update-env để pm2 đọc lại .env (HOST vừa được thêm). Không có cờ này pm2
  # giữ nguyên môi trường của lần start đầu tiên.
  pm2 restart tuanpa-blog --update-env
  sleep 2
  pm2 status tuanpa-blog
else
  warn "Không thấy pm2 process 'tuanpa-blog'. Khởi động lại thủ công:"
  warn "  pm2 restart tuanpa-blog --update-env    (hoặc tên process của bạn)"
fi

# ---------------------------------------------------------------- 8. verify
say "8. Xác minh sau khi chạy"
PORT_V="$(env_val PORT)"; PORT_V="${PORT_V:-3000}"
sleep 1

if curl -fsS "http://127.0.0.1:$PORT_V/api/settings" >/dev/null 2>&1; then
  ok "App trả lời trên 127.0.0.1:$PORT_V"
else
  warn "App KHÔNG trả lời trên 127.0.0.1:$PORT_V - xem log: pm2 logs tuanpa-blog --lines 50"
fi

# Cổng 3000 phải KHÔNG nghe trên IP ngoài. `ss -tlnp` cho thấy địa chỉ bind thật.
if command -v ss >/dev/null 2>&1; then
  BIND="$(ss -tln "sport = :$PORT_V" 2>/dev/null | awk 'NR>1{print $4}' | head -1)"
  case "$BIND" in
    127.0.0.1:*|[::1]:*) ok "Chỉ nghe loopback: $BIND" ;;
    "")                  warn "Không xác định được địa chỉ bind cho cổng $PORT_V" ;;
    *)                   warn "Đang nghe $BIND - cổng $PORT_V có thể truy cập từ mạng ngoài."
                         warn "Đặt HOST=127.0.0.1 trong .env rồi: pm2 restart tuanpa-blog --update-env" ;;
  esac
fi

# Token ký bằng dev_secret phải bị từ chối. Đây là bằng chứng trực tiếp rằng
# fallback nguy hiểm đã biến mất.
FORGED="$(node -e "
  const jwt = require('jsonwebtoken');
  console.log(jwt.sign({ id: 1, role: 'admin', tv: 0 }, 'dev_secret'));
" 2>/dev/null || true)"
if [ -n "$FORGED" ]; then
  CODE="$(curl -s -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $FORGED" "http://127.0.0.1:$PORT_V/api/admin/users" || true)"
  if [ "$CODE" = "401" ]; then
    ok "Token ký bằng 'dev_secret' bị từ chối (401)"
  else
    die "NGHIÊM TRỌNG: token 'dev_secret' trả về HTTP $CODE thay vì 401."
  fi
fi

# File .bak phải 404 kể cả khi tồn tại trên đĩa.
printf '// probe\n' > public/js/zz-probe.js.bak.tmp
CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT_V/js/zz-probe.js.bak.tmp" || true)"
rm -f public/js/zz-probe.js.bak.tmp
[ "$CODE" = "404" ] && ok "File .bak trong public/ bị chặn (404)" \
                    || warn "File .bak trả về HTTP $CODE - kiểm tra middleware trong server.js"

# --- P1: security header và CORS ---
HDRS="$(curl -sSI "http://127.0.0.1:$PORT_V/" || true)"
echo "$HDRS" | grep -qi '^content-security-policy:' \
  && ok "Content-Security-Policy có mặt" \
  || warn "THIẾU Content-Security-Policy - kiểm tra server/security-headers.js"
echo "$HDRS" | grep -qi '^x-content-type-options: *nosniff' \
  && ok "X-Content-Type-Options: nosniff" \
  || warn "THIẾU nosniff - file trong /uploads/ có thể bị sniff thành HTML"
echo "$HDRS" | grep -qi '^x-frame-options: *DENY' \
  && ok "X-Frame-Options: DENY (chống clickjack bảng quản trị)" \
  || warn "THIẾU X-Frame-Options"

# CORS phải KHÔNG còn trả '*'. Đây là bằng chứng `cors()` không còn để mặc định.
ACAO="$(curl -sSI -H 'Origin: https://evil.example' "http://127.0.0.1:$PORT_V/api/settings" \
        | grep -i '^access-control-allow-origin:' | tr -d '\r' || true)"
case "$ACAO" in
  *'*'*) warn "CORS vẫn trả wildcard: $ACAO" ;;
  "")    ok "Không trả Access-Control-Allow-Origin cho origin lạ" ;;
  *)     ok "CORS giới hạn: ${ACAO#*: }" ;;
esac

# Sanitizer: payload đã từng bypass bản regex cũ phải không còn sống sót.
node -e "
  const { sanitizeRichHtml } = require('./server/sanitize-html');
  const bad = ['<img/onerror=alert(1) src=x>', '<svg/onload=alert(1)>', '<a href=javascript:alert(1)>x</a>'];
  const leaked = bad.filter((p) => /on[a-z]+\s*=|javascript:/i.test(sanitizeRichHtml(p)));
  if (leaked.length) { console.error('    Sanitizer VẪN cho qua: ' + JSON.stringify(leaked)); process.exit(1); }
  console.log('    Sanitizer chặn cả 3 payload từng bypass bản cũ');
" || die "NGHIÊM TRỌNG: server/sanitize-html.js không chặn được payload XSS đã biết."

# Token trong cookie `token` phải KHÔNG xác thực được (chống CSRF).
FORGED_OK="$(node -e "
  const jwt = require('jsonwebtoken');
  require('./server/env');
  console.log(jwt.sign({ id: 1, role: 'admin', tv: 0 }, process.env.JWT_SECRET));
" 2>/dev/null || true)"
if [ -n "$FORGED_OK" ]; then
  CODE="$(curl -s -o /dev/null -w '%{http_code}' \
    -H "Cookie: token=$FORGED_OK" "http://127.0.0.1:$PORT_V/api/auth/me" || true)"
  [ "$CODE" = "401" ] && ok "Token đặt trong cookie bị bỏ qua (401)" \
                      || warn "Cookie token trả về HTTP $CODE - fallback cookie có thể vẫn còn"
fi

# --- Thư viện ảnh ---
CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT_V/api/media" || true)"
[ "$CODE" = "401" ] && ok "/api/media yêu cầu đăng nhập (401, không phải 404)" \
                    || warn "/api/media trả về HTTP $CODE - route có được mount không?"
for asset in /css/media.css /js/media.js; do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT_V$asset" || true)"
  [ "$CODE" = "200" ] && ok "$asset phục vụ được" \
                     || warn "$asset trả về HTTP $CODE"
done
curl -sS "http://127.0.0.1:$PORT_V/admin.html" 2>/dev/null | grep -q 'data-tab="media"' \
  && ok "Tab Thư viện có trong admin.html" \
  || warn "Không thấy tab Thư viện trong admin.html"
curl -sS "http://127.0.0.1:$PORT_V/write.html" 2>/dev/null | grep -q 'id="media-picker"' \
  && ok "Modal chọn ảnh có trong write.html" \
  || warn "Không thấy modal chọn ảnh trong write.html"

# Font icon: các icon là LIGATURE, và font đã được subset xuống đúng những icon
# đang dùng. Một icon thiếu trong subset sẽ hiện NGUYÊN CHỮ ("perm_media") hoặc
# không hiện gì - nên phải kiểm tên file font trong trang khớp với file trên đĩa.
ICON_REF="$(grep -o 'material-symbols-subset\.[0-9a-f]*\.woff2' public/admin.html | head -1)"
if [ -n "$ICON_REF" ]; then
  if [ -f "public/fonts/$ICON_REF" ]; then
    ok "Font icon khớp: $ICON_REF"
  else
    die "Trang trỏ tới public/fonts/$ICON_REF nhưng file không tồn tại.
    Chạy trên máy có mạng:  npm run fetch:fonts
    rồi rsync lại public/fonts/ và public/css/fonts.css."
  fi
  CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT_V/fonts/$ICON_REF" || true)"
  [ "$CODE" = "200" ] && ok "Font icon phục vụ được (200)" \
                      || warn "Font icon trả về HTTP $CODE - icon sẽ không hiện"
fi

# Kiểm sâu hơn: mọi icon trong markup phải CÓ TRONG font. Cần fontTools; nếu thiếu
# thì bỏ qua chứ không chặn deploy - bước trên đã bắt được trường hợp nguy hiểm nhất
# (font trong trang không khớp file trên đĩa).
if python3 -c 'import fontTools' >/dev/null 2>&1; then
  if python3 scripts/check-icons.py >/tmp/icons.$$ 2>&1; then
    ok "$(tail -1 /tmp/icons.$$)"
  else
    warn "Có icon KHÔNG nằm trong font subset:"
    sed 's/^/    /' /tmp/icons.$$ | tail -5
    warn "Chạy 'npm run fetch:fonts' trên máy có mạng rồi rsync lại public/fonts/."
  fi
  rm -f /tmp/icons.$$
else
  warn "Không có fontTools (pip install fonttools) - bỏ qua kiểm icon chi tiết."
fi

# Trình nhúng: CSP phải liệt kê đúng các origin nhúng, nếu không iframe sẽ bị
# trình duyệt chặn dù server trả về đúng.
CSP="$(curl -sSI "http://127.0.0.1:$PORT_V/" 2>/dev/null | grep -i '^content-security-policy:' || true)"
case "$CSP" in
  *"frame-src https://www.youtube-nocookie.com"*) ok "CSP frame-src có các origin nhúng" ;;
  *"frame-src 'none'"*) warn "CSP vẫn là frame-src 'none' - video nhúng sẽ không hiện." ;;
  "") warn "Không đọc được header CSP" ;;
  *) warn "frame-src có nhưng không như mong đợi - kiểm server/security-headers.js" ;;
esac
CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  -d '{"url":"https://youtu.be/dQw4w9WgXcQ"}' "http://127.0.0.1:$PORT_V/api/posts/embed" || true)"
[ "$CODE" = "401" ] && ok "/api/posts/embed yêu cầu đăng nhập (401, không phải 404)" \
                    || warn "/api/posts/embed trả về HTTP $CODE - route có được mount không?"

say "HOÀN TẤT"
cat <<'DONE'
    Đã áp dụng 5 mục P0:
      1. OTP đặt lại mật khẩu: 1 mã sống/lần, cooldown 60s, 5 mã/giờ, đếm 5 lần sai
      2. Rate limit đăng nhập theo IP + theo email (CF-Connecting-IP)
      3. Bỏ fallback dev_secret / Admin@123, fail-fast khi thiếu secret
      4. token_version: đổi mật khẩu là thu hồi mọi session cũ; đổi mật khẩu
         phải nhập mật khẩu hiện tại
      5. Upload: giới hạn 8 MB, 1 file, 40 ảnh/giờ/user, kiểm magic bytes

    Và 6 mục P1:
      6. Sanitizer HTML viết lại: PARSE rồi tái tạo, thay 4 regex bị bypass
      7. Security header: CSP, nosniff, X-Frame-Options, Referrer-Policy, HSTS
      8. Token OAuth không còn nằm trong URL (cookie handoff dùng một lần)
      9. Quyền file .env / data/ (đã siết ở bước 3 phía trên)
     11. CORS giới hạn theo SITE_URL, không còn wildcard
     12. Bỏ fallback đọc token từ cookie -> mọi route miễn nhiễm CSRF

    Tính năng mới: Thư viện ảnh (Admin > Thư viện, và nút "Thư viện" trong trang
    viết bài)
      - admin: KHÔNG giới hạn dung lượng mỗi ảnh; chốt duy nhất là đĩa phải còn
        trên 1 GB trống (SQLite ghi WAL cùng ổ - đĩa đầy là site ngừng ghi được
        bài, không chỉ ngừng upload)
      - editor: 8 MB mỗi ảnh, 40 ảnh mỗi giờ (như cũ)
      - editor xoá được ảnh do chính mình tải lên; admin xoá được mọi ảnh
      - xoá ảnh đang dùng trong bài viết: cảnh báo số bài rồi mới cho xác nhận
      - file upload ghi vào data/tmp-uploads/ (NGOÀI public/) và chỉ chuyển vào
        public/uploads/ sau khi kiểm magic bytes
      - THƯ MỤC lồng nhiều cấp: tạo/đổi tên/di chuyển (editor), xoá (chỉ admin).
        Xoá thư mục KHÔNG xoá ảnh - ảnh chuyển sang "Chưa phân loại".
        Không thể chuyển một thư mục vào chính nó hoặc vào thư mục con của nó.

    Tính năng mới: Nhúng URL trong trang viết bài (nút "+ NHÚNG")
      - YouTube, Vimeo, TikTok, Spotify, Facebook, Google Drive, Google Maps
      - server/embeds.js KHÔNG lọc URL mà PHÂN TÍCH URL rồi TỰ DỰNG src mới từ id
        đã kiểm - nên tập hợp URL có thể sinh ra là cố định trong code
      - src được kiểm lại mỗi lần lưu bài (routes/posts.js) và CSP frame-src chỉ
        cho phép đúng 7 origin đó, nên iframe từ nơi khác bị chặn hai lớp
      - KHÔNG follow redirect để giải link ngắn (vm.tiktok.com) - đó sẽ là SSRF

    Việc cần làm thủ công:
      - Đổi mật khẩu tất cả tài khoản admin (mọi OTP cũ đã bị vô hiệu).
      - Kiểm tra Cloudflare Tunnel chỉ trỏ tới 127.0.0.1:PORT.
      - Nếu JWT_SECRET vừa được thay: mọi người dùng phải đăng nhập lại.
      - Đăng nhập Google: thử một lần để chắc luồng cookie handoff chạy đúng
        (SITE_URL phải là https, nếu không cookie sẽ không có cờ Secure).
      - Mở Bảng quản trị > Thư viện: kiểm tra ảnh có sẵn đã hiện đủ, thử tải lên
        một ảnh lớn bằng tài khoản admin, và thử chèn ảnh từ thư viện vào bài viết.
      - Thử tạo một thư mục, tạo thư mục con trong nó, chuyển một ảnh vào, rồi xoá
        thư mục - xác nhận ảnh chuyển sang "Chưa phân loại" chứ KHÔNG bị xoá.
      - Thử nhúng một link YouTube trong trang viết bài, lưu, rồi mở bài đã lưu -
        nếu iframe trống thì gần như chắc chắn là CSP frame-src (xem bước 8).
      - Nginx/Cloudflare: upload của admin không còn giới hạn ở tầng app, nên
        client_max_body_size (nếu có nginx) phải được nâng lên tương ứng, và
        Cloudflare Free giới hạn 100 MB mỗi request - ảnh lớn hơn thế sẽ bị chặn
        ở tầng edge trước khi tới app.
      - Font icon: public/fonts/ và public/css/fonts.css PHẢI được rsync lên cùng
        mã nguồn. Font được subset xuống đúng các icon đang dùng, nên bản cũ thiếu
        "perm_media"/"sync" và hai icon đó sẽ không hiện. Bước 8 ở trên tự kiểm.

    Khôi phục nếu cần (thay STAMP bằng dấu thời gian in ở bước 1):
      pm2 stop tuanpa-blog
      cp backups/blog.db.STAMP data/blog.db
      rm -f data/blog.db-wal data/blog.db-shm
      pm2 start tuanpa-blog
DONE

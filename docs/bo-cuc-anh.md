# Bố cục ảnh khi viết bài

Trong trang **Viết bài**, cột "Thêm khối" bên trái có nút **+ BỐ CỤC ẢNH**. Mỗi khối là một cụm ảnh
xếp theo một trong 6 bố cục. Không cần gõ cú pháp nào: chọn kiểu, thêm ảnh, xong.

## Cách dùng

1. Bấm **+ BỐ CỤC ẢNH**. Khối mới hiện ra ở cuối bài; dùng mũi tên ↑ ↓ để đưa lên đúng chỗ.
2. Chọn kiểu ở ô chọn đầu khối (xem bảng dưới).
3. Mỗi ô ảnh: **Tải lên** (từ máy), **Thư viện** (ảnh đã có), hoặc dán URL.
   Ô **Mô tả ảnh** không bắt buộc — để trống thì ảnh dùng *chú thích* của khối làm mô tả.
4. Kiểu có chữ (ảnh cạnh chữ, chia đôi) có thêm một ô soạn chữ với đủ thanh định dạng như khối Văn bản.
5. Ô **Chú thích** (không bắt buộc) hiện dưới ảnh.
6. Phần **Xem trước** ở cuối khối cho thấy bố cục đúng như khi đăng.

Đổi kiểu bất cứ lúc nào: ảnh và chữ đã soạn đều được giữ lại, kể cả sau khi lưu. Kiểu cần ít ảnh
hơn số ảnh đang có thì chỉ dùng các ảnh đầu; kiểu không có chữ thì ẩn phần chữ (không hiện trên bài,
không tính vào số từ hay đoạn tóm tắt). Đổi lại kiểu khác thì ảnh/chữ đó hiện lại.

## 7 bố cục

| Kiểu trong ô chọn | Số ảnh | Nên dùng khi | Trên điện thoại |
|---|---|---|---|
| Ảnh dọc cạnh chữ (ảnh trái / ảnh phải) | 1 + chữ | 1 ảnh dọc minh hoạ một đoạn văn; ảnh 3:4 rộng 40%, chữ chảy quanh | Ảnh lên trên, chữ xuống dưới |
| Ảnh ngang rộng có chú thích | 1 | Ảnh ngang quan trọng; rộng bằng cột chữ, cao tối đa 70% màn hình | Giữ nguyên |
| Ảnh và chữ chia đôi (ảnh trái / ảnh phải) | 1 + chữ | Ảnh 3:2 và đoạn chữ ngang hàng hai cột; xen kẽ trái/phải cho nhịp đọc | Ảnh trên, chữ dưới |
| 1 ảnh ngang lớn + 2 ảnh dọc | 3 | Ảnh 1 = ảnh ngang lớn bên trái, ảnh 2–3 = hai ảnh dọc xếp chồng bên phải | Ảnh lớn trên, 2 ảnh dọc cạnh nhau dưới |
| 2 ảnh dọc cạnh nhau | 2 | Hai ảnh dọc 4:5 | Vẫn 2 cột |
| Lưới hỗn hợp | 3–12 | Album ảnh ngang/dọc lẫn lộn, giữ nguyên tỉ lệ từng ảnh; nút **Thêm nhiều ảnh** chọn nhiều file một lúc | 2 cột |
| Dải ảnh cuộn ngang | 3–12 | Nhiều ảnh cùng một khoảnh khắc mà không muốn bài dài ra: một hàng ảnh cao bằng nhau, giữ đúng tỉ lệ từng ảnh, vuốt/cuộn ngang; desktop có nút ‹ › (tự ẩn khi hết ảnh) | Hàng thấp hơn, vuốt ngang |

## Quy tắc chung (tự động)

- **Không ảnh nào trong bài cao quá 80% màn hình** — áp dụng cho cả bài cũ. Ảnh cao hơn được thu
  vừa khung, không bị cắt, không bị kéo méo.
  Trên màn hình thấp, các kiểu có tỉ lệ cố định (3:4, 3:2, 4:5) và ảnh ngang rộng sẽ hẹp lại để giữ
  đúng tỉ lệ thay vì bị cắt.
- Bấm vào bất kỳ ảnh nào để phóng to (lightbox có sẵn của blog: ← → chuyển ảnh, Esc để đóng,
  cuộn/chụm để zoom).
- Ảnh tải lên blog tự có `width`/`height` thật (tra từ Thư viện ảnh khi lưu) nên trang không giật khi
  tải; ảnh dán URL ngoài thì không có, nhưng các kiểu có tỉ lệ cố định (3:4, 3:2, 4:5, lưới 1+2) vẫn
  không giật.
- Mọi ảnh đều `loading="lazy"`, và chế độ Sáng / Tối tự đổi màu theo giao diện.

## Ghi chú kỹ thuật

- Dữ liệu một khối: `{"type":"layout","layout":"side|side-right|wide|split|split-reverse|feature|pair|masonry|strip","images":[{"url","alt","width","height"}],"caption","html"}`.
- Định nghĩa kiểu: `IMAGE_LAYOUTS` trong `public/js/api.js`; server kiểm tra lại khi lưu
  (`sanitizeLayoutBlock()` trong `server/routes/posts.js`) và render sẵn cho Google
  (`server/ssr-content.js`). Thêm/sửa một kiểu phải sửa cả ba chỗ và `public/css/image-layouts.css`.
- CSS: `public/css/image-layouts.css`, gắn vào `.prose-content` (lớp bọc thân bài `#post-body`).
- Bài nháp mẫu dùng đủ 6 kiểu: `/post.html?slug=nhap-thu-bo-cuc-anh` (chỉ admin xem được).

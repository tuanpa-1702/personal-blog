document.getElementById('footer-year').textContent = new Date().getFullYear();

// ---- Image cropper (avatar + cover) ----
// Same drag-to-move/drag-corner-to-resize/canvas-export mechanism as
// admin.html's hero-image cropper (openHeroCropper in js/admin.js) - ported
// rather than shared, because that one is ALSO locked to a second "phone
// band" ratio the homepage hero box needs (a preview of the narrower slice a
// phone keeps after its own object-cover), and neither the avatar (always
// square) nor the cover (always shown at one fixed ratio, see .profile-cover
// in editorial.css) has a second shape to preview. One ratio, one box.
//
// The crop always runs client-side and re-uploads a NEW file through the
// same POST /api/upload every straight upload already used - nothing server-
// side needed to change for this feature; the crop is just a different Blob
// arriving at the same route.
const COVER_CROP_RATIO = 2.4; // matches .profile-cover's aspect-ratio: 2.4 / 1

let cropState = null; // { pendingFile, ratio, rect, mode, pointerStart, rectStart, onDone }

function cropEls() {
  return {
    modal: document.getElementById('crop-modal'),
    title: document.getElementById('crop-modal-title'),
    img: document.getElementById('crop-img'),
    box: document.getElementById('crop-box'),
    error: document.getElementById('crop-error'),
    apply: document.getElementById('crop-apply'),
    cancel: document.getElementById('crop-cancel'),
    useOriginal: document.getElementById('crop-use-original'),
  };
}

function setCropError(text) {
  const { error } = cropEls();
  if (!error) return;
  error.textContent = text || '';
  error.classList.toggle('hidden', !text);
}

// `onDone(file)` is called once, with either the cropped image or - if
// "Dùng ảnh gốc" was pressed - the original `file` untouched; the caller
// uploads either one the same way, so callers never need to know which
// happened.
function openCropper({ file, ratio, title, onDone }) {
  const els = cropEls();
  if (!els.modal || !els.img || !els.box) {
    onDone(file); // older cached page with no modal markup: skip straight to upload
    return;
  }
  setCropError('');
  els.title.textContent = title;
  els.apply.disabled = true; // re-enabled once the picture is actually on screen
  els.useOriginal.classList.remove('hidden');
  cropState = { pendingFile: file, ratio, rect: null, mode: null, onDone };

  // The frame starts as the largest rectangle of the locked ratio, centred in
  // the picture - confirming immediately keeps everything when the image
  // already matches that shape, and crops symmetrically when it does not.
  const finishOpen = () => {
    if (!cropState) return;
    els.apply.disabled = false;
    const imgW = els.img.offsetWidth;
    const imgH = els.img.offsetHeight;
    const w = Math.min(imgH * ratio, imgW);
    const h = w / ratio;
    cropState.rect = { x: (imgW - w) / 2, y: (imgH - h) / 2, w, h };
    renderCropBox();
  };

  els.img.onload = finishOpen;
  els.img.onerror = () => setCropError('Không đọc được tệp ảnh này.');
  // data: URL rather than URL.createObjectURL(): the CSP is
  // img-src 'self' data: https: with no blob: scheme, so a blob URL never
  // paints, and data: draws onto the crop canvas untainted just the same.
  const reader = new FileReader();
  reader.onload = () => {
    els.img.src = reader.result;
  };
  reader.onerror = () => setCropError('Không đọc được tệp ảnh này.');
  reader.readAsDataURL(file);

  els.modal.classList.remove('hidden');
  els.modal.classList.add('flex');
}

function closeCropper() {
  const els = cropEls();
  cropState = null;
  if (els.modal) {
    els.modal.classList.add('hidden');
    els.modal.classList.remove('flex');
  }
  if (els.img) {
    els.img.onload = els.img.onerror = null;
    els.img.removeAttribute('src');
  }
}

function renderCropBox() {
  const els = cropEls();
  const rect = cropState?.rect;
  if (!els.box || !rect) return;
  els.box.style.left = `${rect.x}px`;
  els.box.style.top = `${rect.y}px`;
  els.box.style.width = `${rect.w}px`;
  els.box.style.height = `${rect.h}px`;
}

// Pointer events cover mouse and touch alike. Captured on the box so a fast
// drag keeps working even when the pointer runs ahead of the frame.
function initCropPointer() {
  const els = cropEls();
  if (!els.box || !els.img) return;
  const MIN = 32; // px of crop width - anything smaller is not worth keeping

  els.box.addEventListener('pointerdown', (e) => {
    if (!cropState?.rect) return;
    e.preventDefault();
    cropState.mode = e.target.dataset.cropHandle ? `resize-${e.target.dataset.cropHandle}` : 'move';
    cropState.pointerStart = { x: e.clientX, y: e.clientY };
    cropState.rectStart = { ...cropState.rect };
    els.box.setPointerCapture(e.pointerId);
  });

  els.box.addEventListener('pointermove', (e) => {
    const st = cropState;
    if (!st?.mode || !st.rectStart) return;
    const dx = e.clientX - st.pointerStart.x;
    const dy = e.clientY - st.pointerStart.y;
    const imgW = els.img.offsetWidth;
    const imgH = els.img.offsetHeight;
    const r = { ...st.rectStart };

    if (st.mode === 'move') {
      r.x = Math.min(Math.max(r.x + dx, 0), Math.max(imgW - r.w, 0));
      r.y = Math.min(Math.max(r.y + dy, 0), Math.max(imgH - r.h, 0));
    } else {
      // Locked ratio: derive the new width from whichever axis moved further
      // (so diagonal drags feel 1:1), re-derive the height, and keep the
      // corner OPPOSITE the drag pinned in place.
      const corner = st.mode.slice('resize-'.length); // nw | ne | sw | se
      const rs = st.rectStart;
      const anchorR = rs.x + rs.w; // fixed right edge when dragging a w corner
      const anchorB = rs.y + rs.h; // fixed bottom edge when dragging an n corner
      const wFromX = corner.includes('e') ? rs.w + dx : rs.w - dx;
      const wFromY = (corner.includes('s') ? rs.h + dy : rs.h - dy) * st.ratio;
      let w = Math.abs(dx) >= Math.abs(dy) ? wFromX : wFromY;
      const maxW = Math.min(
        corner.includes('w') ? anchorR : imgW - rs.x, // horizontal room
        (corner.includes('n') ? anchorB : imgH - rs.y) * st.ratio // vertical room
      );
      w = Math.min(Math.max(w, MIN), maxW);
      r.w = w;
      r.h = w / st.ratio;
      r.x = corner.includes('w') ? anchorR - w : rs.x;
      r.y = corner.includes('n') ? anchorB - r.h : rs.y;
    }
    st.rect = r;
    renderCropBox();
  });

  const endDrag = () => {
    if (cropState) cropState.mode = null;
  };
  els.box.addEventListener('pointerup', endDrag);
  els.box.addEventListener('pointercancel', endDrag);
}

async function applyCrop() {
  const els = cropEls();
  const st = cropState;
  if (!st?.rect) return;
  const img = els.img;
  setCropError('');
  els.apply.disabled = true;

  try {
    // Displayed px -> native px, then cap the export so a very large original
    // still sails under the upload route's 8 MB cap.
    const scale = img.naturalWidth / img.offsetWidth;
    const sx = Math.round(st.rect.x * scale);
    const sy = Math.round(st.rect.y * scale);
    const sw = Math.round(st.rect.w * scale);
    const sh = Math.round(st.rect.h * scale);
    const MAX_SIDE = 2000;
    const longest = Math.max(sw, sh);
    const k = longest > MAX_SIDE ? MAX_SIDE / longest : 1;
    const outW = Math.max(1, Math.round(sw * k));
    const outH = Math.max(1, Math.round(sh * k));

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH);

    // PNG (and GIF, which a canvas can only save as a still frame) keeps
    // transparency; photographs go out as high-quality JPEG.
    const keepPng = /png|gif/i.test(st.pendingFile?.type || '');
    const type = keepPng ? 'image/png' : 'image/jpeg';
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Trình duyệt không xuất được ảnh đã cắt.'))),
        type,
        0.92
      );
    });
    const file = new File([blob], keepPng ? 'crop.png' : 'crop.jpg', { type });
    const onDone = st.onDone;
    closeCropper();
    onDone(file);
  } catch (err) {
    els.apply.disabled = false;
    setCropError(err.message || 'Không cắt được ảnh này.');
  }
}

(function initCrop() {
  const els = cropEls();
  if (!els.modal) return;
  initCropPointer();
  els.apply.addEventListener('click', applyCrop);
  els.cancel.addEventListener('click', closeCropper);
  els.useOriginal.addEventListener('click', () => {
    const st = cropState;
    if (!st) return;
    const onDone = st.onDone;
    const file = st.pendingFile;
    closeCropper();
    onDone(file);
  });
})();

const publicUserId = new URLSearchParams(window.location.search).get('user');

// The rail's own "Đăng xuất" row (data-session-only) is for YOUR profile -
// on someone ELSE's, the header dropdown is the only logout affordance left
// once #profile-owner-actions is hidden below, so stripping the hook here
// (before renderNavAuthState() would otherwise reveal the row) keeps that at
// exactly one, never two and never zero.
if (publicUserId) {
  document.querySelectorAll('[data-session-only]').forEach((el) => el.removeAttribute('data-session-only'));
}

// Cover banner has no dicebear-style default the way avatar_url does, so an
// unset one is a REAL empty state, not a placeholder to fetch: the <img> is
// left with no src at all (never src="", which server/render-html.js's own
// comment on the same pattern warns re-requests the current page as an
// image) and .profile-cover's own background tint (editorial.css) shows
// through instead of a broken-image icon.
function setCoverImg(el, url) {
  if (url) el.src = url;
  else el.removeAttribute('src');
  // .has-image gates both the pointer cursor and the click-to-enlarge
  // handler below (wireProfileLightbox) - the cover's empty state has
  // nothing behind it worth a full-screen view of, unlike the avatar, which
  // always has a real image (a dicebear default when the account never set
  // one) and so never needs this check.
  el.classList.toggle('has-image', !!url);
}

// Vị trí/Số điện thoại: both optional, both PUBLIC (the profile-edit form's
// own placeholders say so). Shared between loadProfile() and
// loadPublicProfile() rather than duplicated, since an owner sees their own
// the same way a visitor sees anyone else's - just hidden entirely when the
// account has not set one, the same convention #profile-status-view uses.
function setOptionalMeta(rowId, textId, value) {
  const has = !!value;
  document.getElementById(rowId).classList.toggle('hidden', !has);
  if (has) document.getElementById(textId).textContent = value;
}

// Read-only view shown when clicking a commenter's name/avatar - works
// whether or not the viewer themselves is logged in.
async function loadPublicProfile(userId) {
  document.getElementById('profile-main').classList.remove('hidden');
  document.getElementById('profile-main').classList.add('flex');

  try {
    const { user } = await API.getPublicUser(userId);

    document.getElementById('profile-avatar').src = user.avatar_url;
    setCoverImg(document.getElementById('profile-cover'), user.cover_image);
    document.getElementById('profile-name').textContent = user.name;
    document.getElementById('profile-email').classList.add('hidden'); // don't expose other users' emails
    setOptionalMeta('profile-location', 'profile-location-text', user.location);
    setOptionalMeta('profile-phone', 'profile-phone-text', user.phone);
    document.getElementById('profile-bio').textContent = user.bio || 'Người này chưa có giới thiệu.';
    // #profile-status-edit stays hidden (its default class) - a visitor never
    // gets the input, only the plain-text view, and only when there is
    // something in it to show.
    if (user.status_text) {
      document.getElementById('profile-status-view').textContent = user.status_text;
      document.getElementById('profile-status-view').classList.remove('hidden');
    }
    document.getElementById('profile-owner-actions').classList.add('hidden');
    document.getElementById('profile-notif-box').classList.add('hidden');
    document.getElementById('avatar-photo-btn').classList.add('hidden');
    document.getElementById('cover-photo-btn').classList.add('hidden');
    // The published/draft split is only meaningful for your OWN posts - a
    // stranger's drafts are not this viewer's to browse, and
    // getPublicUserPosts() below only ever returns published ones anyway.
    document.getElementById('my-posts-tabs').classList.add('hidden');
    document.querySelectorAll('[data-writer-only]').forEach((el) => el.classList.add('hidden'));
    document.getElementById('my-posts-heading').textContent = `Bài viết của ${user.name}`;

    const { posts } = await API.getPublicUserPosts(userId);
    renderPublicPostsList(posts);
  } catch (e) {
    document.getElementById('profile-name').textContent = 'Không tìm thấy người dùng';
    document.getElementById('profile-bio').textContent = '';
    document.getElementById('profile-owner-actions').classList.add('hidden');
    document.getElementById('profile-notif-box').classList.add('hidden');
    document.getElementById('avatar-photo-btn').classList.add('hidden');
    document.getElementById('cover-photo-btn').classList.add('hidden');
    document.getElementById('my-posts-list').innerHTML = '';
  }
}

// Both profile views (your own and someone else's via ?user=) call this with
// their own published-posts array so the two numbers in the hero panel never
// disagree with the list rendered under them.
function updateProfileStats(publishedPosts) {
  document.getElementById('profile-stat-posts').textContent = publishedPosts.length;
  const totalViews = publishedPosts.reduce((sum, p) => sum + (p.views || 0), 0);
  document.getElementById('profile-stat-views').textContent = totalViews.toLocaleString('vi-VN');
}

// p.excerpt IS escapeHtml()'d below, unlike an earlier version of this card:
// the server now always hands back PLAIN text for a list-shaped response
// (attachExcerptFallback, server/excerpt.js), including a literal "<" or "&"
// decoded back from an entity, which must be escaped again before it can be
// safely inserted as markup.
function renderPublicPostsList(posts) {
  updateProfileStats(posts); // getPublicUserPosts() already returns published-only
  const list = document.getElementById('my-posts-list');
  if (!posts.length) {
    list.innerHTML = '<p class="ed-icon-soft">Người này chưa đăng bài viết nào.</p>';
    return;
  }
  list.innerHTML = posts
    .map(
      (p) => `
    <div class="ed-panel rounded p-6 cursor-pointer" data-goto="/post.html?slug=${encodeURIComponent(p.slug)}">
      <span class="ed-chip mb-2 inline-block">${escapeHtml(p.tag)}</span>
      <h4 class="ed-story-title--sm ed-hoverable transition-colors">${escapeHtml(p.title)}</h4>
      ${p.excerpt ? `<p class="ed-excerpt mt-1 line-clamp-3">${escapeHtml(p.excerpt)}</p>` : ''}
      <p class="ed-icon-faint text-sm mt-2">${timeAgoVi(p.created_at)} · ${p.views} lượt xem</p>
    </div>`
    )
    .join('');
}

async function loadProfile() {
  if (publicUserId) return loadPublicProfile(publicUserId);

  if (!Auth.isLoggedIn()) {
    document.getElementById('not-logged-in').classList.remove('hidden');
    document.getElementById('not-logged-in').classList.add('flex');
    return;
  }
  document.getElementById('profile-main').classList.remove('hidden');
  document.getElementById('profile-main').classList.add('flex');

  try {
    const { user } = await API.me();
    Auth.setSession(Auth.getToken(), user);
    renderNavAuthState();

    document.getElementById('profile-avatar').src = user.avatar_url;
    setCoverImg(document.getElementById('profile-cover'), user.cover_image);
    document.getElementById('profile-name').textContent = user.name;
    document.getElementById('profile-email').textContent = user.email;
    setOptionalMeta('profile-location', 'profile-location-text', user.location);
    setOptionalMeta('profile-phone', 'profile-phone-text', user.phone);
    document.getElementById('profile-bio').textContent = user.bio || 'Chưa có giới thiệu.';
    document.getElementById('profile-status-edit').classList.remove('hidden');
    document.getElementById('profile-status-input').value = user.status_text || '';
    lastSavedStatus = user.status_text || '';

    const form = document.getElementById('edit-profile-form');
    form.name.value = user.name;
    form.bio.value = user.bio || '';
    form.location.value = user.location || '';
    form.phone.value = user.phone || '';

    // A Google account has no local password to prove, so the server accepts a
    // change without one - asking for it here would be unanswerable.
    const currentRow = document.getElementById('current-password-row');
    const currentInput = currentRow && currentRow.querySelector('input');
    const isLocal = user.auth_provider !== 'google';
    if (currentRow) currentRow.classList.toggle('hidden', !isLocal);
    if (currentInput) currentInput.required = isLocal;

    const notifToggle = document.getElementById('notif-toggle');
    notifToggle.checked = !!user.email_notifications;
    notifToggle.onchange = async () => {
      const newValue = notifToggle.checked;
      try {
        const { token, user: updated } = await API.updateProfile({ email_notifications: newValue });
        Auth.setSession(token, updated);
      } catch (err) {
        notifToggle.checked = !newValue; // revert on failure
        alert(err.message);
      }
    };

    loadMyPosts();
    loadActivity();
  } catch (e) {
    if (e.message.includes('hết hạn') || e.message.includes('đăng nhập')) {
      Auth.clearSession();
      window.location.reload();
    }
  }
}

// Both post-status tabs read from this one fetch (loadMyPosts below) rather
// than each issuing their own request - the counts and the lists can then
// never disagree about how many posts are in each state.
let myPostsByStatus = { published: [], draft: [] };
let myPostsTab = 'published';

function postCardHtml(p) {
  return `
      <div class="ed-panel rounded p-5 sm:p-6 flex items-center justify-between gap-3 sm:gap-4">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 mb-1">
            <span class="ed-chip">${escapeHtml(p.tag)}</span>
          </div>
          <h4 class="ed-story-title--sm ed-hoverable line-clamp-2 cursor-pointer" data-goto="/post.html?slug=${encodeURIComponent(p.slug)}">${escapeHtml(p.title)}</h4>
          <p class="ed-icon-faint text-sm mt-1">${timeAgoVi(p.created_at)} · ${p.views} lượt xem</p>
        </div>
        <div class="flex items-center gap-2 flex-shrink-0">
          <a class="ed-icon-btn p-2.5 rounded" href="/write.html?id=${p.id}" title="Sửa"><span class="material-symbols-outlined">edit</span></a>
          <button class="ed-icon-btn p-2.5 rounded" title="Xoá" data-action="delete-my-post" data-id="${p.id}"><span class="material-symbols-outlined">delete</span></button>
        </div>
      </div>`;
}

function renderMyPostsTab() {
  const list = document.getElementById('my-posts-list');
  const posts = myPostsByStatus[myPostsTab] || [];
  document.getElementById('published-count').textContent = myPostsByStatus.published.length;
  document.getElementById('draft-count').textContent = myPostsByStatus.draft.length;
  document.querySelectorAll('[data-post-tab]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.postTab === myPostsTab);
  });
  if (!posts.length) {
    list.innerHTML = `<p class="ed-icon-soft col-span-full">${
      myPostsTab === 'draft' ? 'Bạn chưa có bản nháp nào.' : 'Bạn chưa có bài viết đã xuất bản nào.'
    }</p>`;
    return;
  }
  list.innerHTML = posts.map(postCardHtml).join('');
}

document.getElementById('my-posts-tabs')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-post-tab]');
  if (!btn) return;
  myPostsTab = btn.dataset.postTab;
  renderMyPostsTab();
});

async function loadMyPosts() {
  const list = document.getElementById('my-posts-list');
  try {
    const { posts } = await API.listPosts({ mine: 'true', limit: 50 });
    myPostsByStatus = {
      published: posts.filter((p) => p.status === 'published'),
      draft: posts.filter((p) => p.status !== 'published'),
    };
    updateProfileStats(myPostsByStatus.published);
    renderMyPostsTab();
  } catch (e) {
    list.innerHTML = `<p class="text-error col-span-full">Không thể tải bài viết: ${escapeHtml(e.message)}</p>`;
  }
}

// "Hoạt động gần đây" (owner only): what GET /api/auth/me/activity's three
// kinds each read as, and what they link to. A comment's own content is
// stored as plain text (see server/sanitize-html.js's note on why - comments
// never carry rich HTML the way a post body does), so escapeHtml() is the
// whole sanitisation step, the same as every comment already rendered on
// post.html.
const ACTIVITY_EXCERPT_MAX = 120;
function activityLine(item) {
  const excerpt =
    item.excerpt && item.excerpt.length > ACTIVITY_EXCERPT_MAX
      ? `${item.excerpt.slice(0, ACTIVITY_EXCERPT_MAX).trimEnd()}…`
      : item.excerpt;
  if (item.kind === 'liked_post') {
    return `Bạn đã thích bài viết <strong>${escapeHtml(item.post_title)}</strong>`;
  }
  if (item.kind === 'liked_comment') {
    return `Bạn đã thích một bình luận trong bài <strong>${escapeHtml(item.post_title)}</strong>${
      excerpt ? `: “${escapeHtml(excerpt)}”` : ''
    }`;
  }
  // 'commented'
  return `Bạn đã bình luận trong bài <strong>${escapeHtml(item.post_title)}</strong>${
    excerpt ? `: “${escapeHtml(excerpt)}”` : ''
  }`;
}

function activityItemHtml(item) {
  return `
    <a class="activity-item flex flex-col gap-0.5" href="/post.html?slug=${encodeURIComponent(item.post_slug)}">
      <span class="font-body-sm text-body-sm text-on-surface">${activityLine(item)}</span>
      <span class="ed-icon-faint text-xs">${timeAgoVi(item.at)}</span>
    </a>`;
}

async function loadActivity() {
  const list = document.getElementById('activity-list');
  try {
    const { activity } = await API.getMyActivity();
    if (!activity.length) {
      list.innerHTML = '<p class="ed-icon-soft">Chưa có hoạt động nào - lượt thích và bình luận của bạn sẽ hiện ở đây.</p>';
      return;
    }
    list.innerHTML = activity.map(activityItemHtml).join('');
  } catch (e) {
    list.innerHTML = `<p class="text-error">Không thể tải hoạt động: ${escapeHtml(e.message)}</p>`;
  }
}

async function deleteMyPost(id) {
  // Says where the post goes rather than that it is gone: the DELETE route moves
  // the row into the bin. Nothing here offers to restore it, because the bin lives
  // in the admin panel and the author of this post may not be an admin.
  if (!confirm('Bạn có chắc muốn xoá bài viết này? Bài viết và các bình luận của nó sẽ được chuyển vào thùng rác.')) return;
  try {
    await API.deletePost(id);
    loadMyPosts();
  } catch (e) {
    alert(e.message);
  }
}
// The card's delete button says data-action="delete-my-post"; the verb itself
// lives here because only this page knows the function (see registerAction in
// js/api.js). The id rides on the button, not in a closure per row.
registerAction('delete-my-post', (e, el) => deleteMyPost(Number(el.dataset.id)));

// Thanh trạng thái: saved on its own, the moment the field is left, rather
// than folded into the "Chỉnh sửa hồ sơ" form's own Lưu button - the whole
// point of putting it directly on the profile card (Facebook's own "what's
// on your mind" box) is that it does not need a trip to a settings panel.
// Enter blurs the field rather than submitting anything of its own, which
// routes it through the SAME blur handler instead of a second save path.
//
// `lastSavedStatus` starts null and is set for real once loadProfile()'s
// own async API.me() resolves and fills the field - wiring the listener here
// happens synchronously, well before that - so a blur before the load
// finishes compares against null and is skipped rather than saving whatever
// placeholder-adjacent value the field held for that instant.
let lastSavedStatus = null;
(function initStatusInput() {
  const input = document.getElementById('profile-status-input');
  if (!input) return;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    }
  });
  input.addEventListener('blur', async () => {
    if (lastSavedStatus === null) return; // profile not loaded yet - nothing to compare or save
    const value = input.value.trim();
    if (value === lastSavedStatus) return;
    try {
      const { token, user } = await API.updateProfile({ status_text: value });
      Auth.setSession(token, user);
      input.value = user.status_text || '';
      lastSavedStatus = user.status_text || '';
    } catch (err) {
      alert(err.message);
    }
  });
})();

document.getElementById('edit-profile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    const { token, user } = await API.updateProfile({
      name: fd.get('name'),
      bio: fd.get('bio'),
      location: fd.get('location'),
      phone: fd.get('phone'),
    });
    Auth.setSession(token, user);
    loadProfile();
  } catch (err) {
    alert(err.message);
  }
});

// Both photo buttons now save the moment a crop is confirmed - there is no
// surrounding form to defer to any more (see the comment on their markup in
// profile.html), so "uploaded" and "saved" are the same step. `busy` just
// dims the button and blocks a second pick landing mid-upload; failure
// still needs a reader-facing message, and alert() is what the rest of this
// page's own save paths (edit-profile-form, password, notif toggle above)
// already use for that.
function setPhotoBtnBusy(btn, busy) {
  btn.style.pointerEvents = busy ? 'none' : '';
  btn.style.opacity = busy ? '0.5' : '';
}

async function uploadAvatarFile(file) {
  const btn = document.getElementById('avatar-photo-btn');
  setPhotoBtnBusy(btn, true);
  try {
    const { url } = await API.uploadImage(file);
    const { token, user } = await API.updateProfile({ avatar_url: url });
    Auth.setSession(token, user);
    document.getElementById('profile-avatar').src = url;
  } catch (err) {
    alert(err.message);
  } finally {
    setPhotoBtnBusy(btn, false);
  }
}

document.getElementById('avatar-file-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  // Cleared immediately (not after cropping) so picking the SAME filename
  // again later - e.g. after cancelling this crop - still fires 'change'.
  // openCropper() already holds its own reference to `file`, so this does
  // not affect the pick already in progress.
  e.target.value = '';
  if (!file) return;
  openCropper({ file, ratio: 1, title: 'Cắt ảnh đại diện', onDone: uploadAvatarFile });
});

async function uploadCoverFile(file) {
  const btn = document.getElementById('cover-photo-btn');
  setPhotoBtnBusy(btn, true);
  try {
    // Same avatar-upload endpoint (POST /api/upload) - it caps every role at
    // the same size limit and does not care what the picture is FOR, only
    // that it is a picture. See media-store.js's magic-byte check.
    const { url } = await API.uploadImage(file);
    const { token, user } = await API.updateProfile({ cover_image: url });
    Auth.setSession(token, user);
    setCoverImg(document.getElementById('profile-cover'), url);
  } catch (err) {
    alert(err.message);
  } finally {
    setPhotoBtnBusy(btn, false);
  }
}

document.getElementById('cover-file-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  openCropper({ file, ratio: COVER_CROP_RATIO, title: 'Cắt ảnh bìa', onDone: uploadCoverFile });
});

document.getElementById('password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const currentPassword = fd.get('currentPassword');
  const newPassword = fd.get('newPassword');
  const confirmPassword = fd.get('confirmPassword');
  const errorEl = document.getElementById('password-error');
  errorEl.classList.add('hidden');
  if (newPassword !== confirmPassword) {
    errorEl.textContent = 'Hai mật khẩu không khớp nhau.';
    errorEl.classList.remove('hidden');
    return;
  }
  try {
    // API.changePassword stores the fresh token it returns - the change bumps
    // token_version server-side, so the token this page was using is now dead.
    await API.changePassword(currentPassword, newPassword, confirmPassword);
    e.target.reset();
    alert('Đổi mật khẩu thành công! Các thiết bị khác đã được đăng xuất.');
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  }
});

// ---- Avatar/cover lightbox ----
// Click-to-enlarge for the two photos - a visitor viewing someone else's
// profile gets this too (nothing here is owner-only), since the avatar and
// cover are the one place on this page a visitor might actually want a
// closer look. See .profile-lightbox in editorial.css and the markup's own
// comment in profile.html for why this is a separate, single-image viewer
// rather than post.html's own multi-image #lightbox reused.
function wireProfileLightbox() {
  const box = document.getElementById('profile-lightbox');
  const img = document.getElementById('profile-lightbox-img');

  function open(src) {
    img.src = src;
    box.classList.remove('hidden');
  }
  function close() {
    box.classList.add('hidden');
    img.src = '';
  }

  document.getElementById('profile-avatar').addEventListener('click', (e) => {
    if (e.target.src) open(e.target.src);
  });
  const coverImg = document.getElementById('profile-cover');
  coverImg.addEventListener('click', () => {
    if (coverImg.classList.contains('has-image')) open(coverImg.src);
  });
  document.getElementById('profile-lightbox-close').addEventListener('click', close);
  // Backdrop click closes; a click landing on the photo itself never
  // reaches this listener with e.target === box, since the photo is a
  // different element the click already stopped bubbling AT (there is no
  // stopPropagation anywhere above - it is simply not the same node).
  box.addEventListener('click', (e) => {
    if (e.target === box) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !box.classList.contains('hidden')) close();
  });
}
wireProfileLightbox();

loadProfile();

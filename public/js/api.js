// Shared API client + auth helpers used across all pages.
const API_BASE = '/api';

// Handle the redirect back from /api/auth/google/callback.
//
// The token is NOT in the URL any more - it used to arrive as ?token=<jwt>, which
// put a credential into the proxy's access log, the browser history and the Referer
// header of every external image on the page. The callback now leaves it in a
// single-use HttpOnly cookie and redirects here with ?oauth=google; this exchanges
// that cookie for the token over POST.
//
// Runs immediately (before DOMContentLoaded) so the session is stored before any
// page-specific script reads Auth.getUser().
(function handleGoogleOAuthRedirect() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('oauth') !== 'google') return;

  const cleanUp = () => {
    params.delete('oauth');
    const qs = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''));
  };

  fetch(`${API_BASE}/auth/session`, { method: 'POST', credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('handoff failed'))))
    .then((data) => {
      if (data.token) {
        localStorage.setItem('tuanpa_token', data.token);
        if (data.user) localStorage.setItem('tuanpa_user', JSON.stringify(data.user));
      }
      cleanUp();
      window.location.reload();
    })
    .catch(() => {
      cleanUp();
    });
})();

const Auth = {
  getToken() {
    return localStorage.getItem('tuanpa_token');
  },
  setSession(token, user) {
    localStorage.setItem('tuanpa_token', token);
    localStorage.setItem('tuanpa_user', JSON.stringify(user));
  },
  clearSession() {
    localStorage.removeItem('tuanpa_token');
    localStorage.removeItem('tuanpa_user');
  },
  getUser() {
    try {
      return JSON.parse(localStorage.getItem('tuanpa_user') || 'null');
    } catch {
      return null;
    }
  },
  isLoggedIn() {
    return !!this.getToken();
  },
  isAdmin() {
    const u = this.getUser();
    return !!u && u.role === 'admin';
  },
  logout() {
    this.clearSession();
    window.location.href = '/index.html';
  },
};

// ---- Maintenance notice ----
// The server has two ways of saying it cannot help: it answers 5xx, or it does
// not answer at all (fetch throws). Either way the reader is left looking at a
// page whose every box is an error string, so this puts the site's own notice
// card over it - the same card public/maintenance.html is made of - once per
// page, with a way to ask again. 4xx stays out of it: those are the reader's
// own input, and each form already answers for itself.
let maintenanceNoticeShown = false;
function showMaintenanceNotice() {
  if (maintenanceNoticeShown || typeof document === 'undefined' || !document.body) return;
  maintenanceNoticeShown = true;
  const scrim = document.createElement('div');
  scrim.className = 'maintenance-scrim';
  scrim.setAttribute('role', 'alertdialog');
  scrim.setAttribute('aria-modal', 'true');
  scrim.setAttribute('aria-label', 'Website đang được bảo trì');
  scrim.innerHTML = `
    <div class="maintenance-card">
      <div class="maintenance-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91-6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>
      </div>
      <h2 class="maintenance-title">Website đang gặp sự cố</h2>
      <p class="maintenance-text">Mình đang thực hiện một vài cập nhật nhỏ để mang lại trải nghiệm tốt hơn.</p>
      <p class="maintenance-text">Rất xin lỗi vì sự bất tiện này — hẹn gặp lại bạn trong ít phút nữa nhé!</p>
      <div class="maintenance-pill">
        <span class="maintenance-dot" aria-hidden="true"></span>
        Dự kiến hoạt động trở lại sớm
      </div>
      <div><button class="maintenance-retry" type="button">Thử lại</button></div>
    </div>`;
  document.body.appendChild(scrim);
  scrim.querySelector('.maintenance-retry').addEventListener('click', () => window.location.reload());
}

async function apiFetch(pathname, options = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
  const token = Auth.getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`${API_BASE}${pathname}`, { ...options, headers });
  } catch (networkError) {
    // No response at all: the server is down, the network is gone, or a proxy
    // in between refused. Nothing else on the page can say any better.
    showMaintenanceNotice();
    throw networkError;
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    if (res.status >= 500) showMaintenanceNotice();
    const message = (data && data.error) || `Lỗi ${res.status}`;
    const err = new Error(message);
    // Callers occasionally need the code itself: a 404 on an endpoint the page
    // knows about means the running server is older than these static files, and
    // that deserves a different message than a genuine failure.
    err.status = res.status;
    // A machine-readable tag on top of the human message, so a caller can branch
    // on the reason (EMAIL_NOT_VERIFIED) instead of matching Vietnamese prose.
    if (data && data.code) err.code = data.code;
    if (data && data.email) err.email = data.email;
    throw err;
  }
  return data;
}

// ---- Convenience wrappers ----
const API = {
  // Email-first sign-in step 1: does this address have an account, and of what
  // kind. Drives which step the modal shows next.
  checkEmail: (email) => apiFetch('/auth/check-email', { method: 'POST', body: JSON.stringify({ email }) }),
  register: (name, email, password) =>
    apiFetch('/auth/register', { method: 'POST', body: JSON.stringify({ name, email, password }) }),
  login: (email, password) =>
    apiFetch('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  // Sign-up email verification. register() returns { pending: true } instead of a
  // token when the admin has verification enabled; verifyEmail() is what returns
  // the session.
  verifyEmail: (email, otp) =>
    apiFetch('/auth/verify-email', { method: 'POST', body: JSON.stringify({ email, otp }) }),
  resendVerification: (email) =>
    apiFetch('/auth/resend-verification', { method: 'POST', body: JSON.stringify({ email }) }),
  me: () => apiFetch('/auth/me'),
  updateProfile: (payload) => apiFetch('/auth/me', { method: 'PUT', body: JSON.stringify(payload) }),
  getMyActivity: () => apiFetch('/auth/me/activity'),
  // The server requires the CURRENT password for a local account (a Google
  // account has none to prove), and returns a fresh token: changing the password
  // bumps token_version, which invalidates the token this request was made with.
  changePassword: async (currentPassword, newPassword, confirmPassword) => {
    const data = await apiFetch('/auth/password', {
      method: 'PUT',
      body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
    });
    if (data && data.token) Auth.setSession(data.token, data.user || Auth.getUser());
    return data;
  },
  forgotPassword: (email) => apiFetch('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) }),
  resetPassword: (email, otp, newPassword) =>
    apiFetch('/auth/reset-password', { method: 'POST', body: JSON.stringify({ email, otp, newPassword }) }),

  listPosts: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return apiFetch(`/posts${qs ? `?${qs}` : ''}`);
  },
  // Tag chips for viewall.html: every "Thẻ (tag)" with at least one published
  // post, plus its post count. The `tag` field only - a post's hashtags are not
  // chips (see GET /api/posts/tags), though they still filter through ?tag=.
  listTags: () => apiFetch('/posts/tags'),
  getPost: (slug) => apiFetch(`/posts/${encodeURIComponent(slug)}`),
  createPost: (payload) => apiFetch('/posts', { method: 'POST', body: JSON.stringify(payload) }),
  updatePost: (id, payload) => apiFetch(`/posts/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deletePost: (id) => apiFetch(`/posts/${id}`, { method: 'DELETE' }),

  listComments: (postId) => apiFetch(`/posts/${postId}/comments`),
  addComment: (postId, content, parentCommentId = null) =>
    apiFetch(`/posts/${postId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ content, parent_comment_id: parentCommentId }),
    }),
  // Admin-only: removes a comment and (via ON DELETE CASCADE) its replies.
  deleteComment: (commentId) => apiFetch(`/posts/comments/${commentId}`, { method: 'DELETE' }),
  // A signed-in reader's report of a comment. Toggle, exactly like reactToComment
  // below: sending the reason that is already on the report withdraws it (the
  // server answers report: null, reported: false), a different reason overwrites.
  // `reason` must be one of the labels listComments returns as report_reasons.
  reportComment: (commentId, reason, note = '') =>
    apiFetch(`/posts/comments/${commentId}/report`, {
      method: 'POST',
      body: JSON.stringify({ reason, note }),
    }),
  // Admin-only: hide a comment (and every reply under it) from readers, or unhide
  // it again. NOT deleteComment above - that one moves the subtree to the recycle
  // bin, this one only takes it off the reading page and leaves the author a note.
  setCommentHidden: (commentId, hidden) =>
    apiFetch(`/posts/comments/${commentId}/hidden`, {
      method: 'PATCH',
      body: JSON.stringify({ hidden }),
    }),

  // Like / dislike. value: 1 = like, -1 = dislike, 0 = clear. Sending the value
  // that is already active also clears it, so a button can just send what it
  // means and let the server toggle.
  reactToPost: (postId, value) =>
    apiFetch(`/posts/${postId}/reactions`, { method: 'POST', body: JSON.stringify({ value }) }),
  reactToComment: (commentId, value) =>
    apiFetch(`/posts/comments/${commentId}/reactions`, {
      method: 'POST',
      body: JSON.stringify({ value }),
    }),

  adminStats: () => apiFetch('/admin/stats'),
  // Newest-first feed of new comments, like/dislike votes and recorded post
  // deletions, for the dashboard "Hoạt động gần đây" card. Paged: the card shows
  // ten rows and turns the page, and the `total` that comes back with them is what
  // lets it draw the page numbers.
  adminActivity: (page = 1, limit = 10) => apiFetch(`/admin/activity?page=${page}&limit=${limit}`),
  adminUsers: () => apiFetch('/admin/users'),
  adminCreateUser: (payload) => apiFetch('/admin/users', { method: 'POST', body: JSON.stringify(payload) }),
  adminSetRole: (id, role) => apiFetch(`/admin/users/${id}`, { method: 'PUT', body: JSON.stringify({ role }) }),
  // Enable / disable an account. Disabling keeps the user and their posts but
  // invalidates their session and blocks login until it is enabled again.
  adminSetUserActive: (id, isActive) =>
    apiFetch(`/admin/users/${id}/status`, { method: 'PATCH', body: JSON.stringify({ is_active: isActive }) }),
  adminResetUserPassword: (id, password) =>
    apiFetch(`/admin/users/${id}/reset-password`, { method: 'POST', body: JSON.stringify({ password }) }),
  adminDeleteUser: (id) => apiFetch(`/admin/users/${id}`, { method: 'DELETE' }),
  adminPosts: () => apiFetch('/admin/posts'),
  // The recycle bin. DELETE on posts/comments/users/media now MOVES things here;
  // these four are the bin's own surface - the folder badges, one folder's page,
  // and the two ways out (back to the site, or gone for good).
  trashCounts: () => apiFetch('/admin/trash/counts'),
  trashList: (kind, page = 1, limit = 20) => apiFetch(`/admin/trash/${kind}?page=${page}&limit=${limit}`),
  trashRestore: (kind, id) => apiFetch(`/admin/trash/${kind}/${id}/restore`, { method: 'POST' }),
  trashPurge: (kind, id) => apiFetch(`/admin/trash/${kind}/${id}/purge`, { method: 'POST' }),
  adminGetSettings: () => apiFetch('/admin/settings'),
  adminUpdateSettings: (payload) => apiFetch('/admin/settings', { method: 'PUT', body: JSON.stringify(payload) }),

  // Outgoing-mail configuration. Separate from the site settings above because
  // it holds a secret: the GET never returns the SMTP password, only whether one
  // is stored (see server/email-config.js).
  adminGetEmailSettings: () => apiFetch('/admin/email-settings'),
  adminUpdateEmailSettings: (payload) =>
    apiFetch('/admin/email-settings', { method: 'PUT', body: JSON.stringify(payload) }),
  adminTestEmail: (to) => apiFetch('/admin/email-settings/test', { method: 'POST', body: JSON.stringify({ to }) }),
  adminEmailOauthUrl: () => apiFetch('/admin/email-settings/oauth-url'),

  // ---- Admin notifications (Bảng quản trị > Thông báo) ----
  // Paged like adminActivity, and `unread` rides along on EVERY response so the
  // rail badge stays correct after a mark-read without a second request - the
  // same trick trashList() uses with its counts. `filter` is 'unread' or one of
  // the four event kinds; anything else means all.
  adminNotifications: (page = 1, limit = 10, filter = '') =>
    apiFetch(
      `/admin/notifications?page=${page}&limit=${limit}${filter ? `&filter=${encodeURIComponent(filter)}` : ''}`
    ),
  // The badge number. Called the moment the panel opens, before any tab is
  // clicked, which is why it is its own endpoint.
  adminNotificationCount: () => apiFetch('/admin/notifications/unread-count'),
  adminMarkNotificationRead: (id) => apiFetch(`/admin/notifications/${id}/read`, { method: 'POST' }),
  adminMarkAllNotificationsRead: () => apiFetch('/admin/notifications/read-all', { method: 'POST' }),
  // The moderation outcome of a report: 'open' | 'resolved' | 'dismissed'.
  adminSetReportStatus: (reportId, status) =>
    apiFetch(`/admin/comment-reports/${reportId}`, { method: 'PATCH', body: JSON.stringify({ status }) }),

  getSettings: () => apiFetch('/settings'),
  // The terms document. The GET is public (the page is); the PUT rides the admin
  // router, so only an admin token can save - terms.js asks /auth/me before it
  // even shows the editor.
  getTerms: () => apiFetch('/terms'),
  adminSaveTerms: (payload) => apiFetch('/admin/terms', { method: 'PUT', body: JSON.stringify(payload) }),

  getPublicUser: (id) => apiFetch(`/users/${id}`),
  getPublicUserPosts: (id) => apiFetch(`/users/${id}/posts`),

  // Uploads use multipart/form-data, so it can't go through apiFetch (which
  // always sets Content-Type: application/json).
  //
  // `endpoint` picks which upload route: '/upload' is the avatar path every role
  // can reach (capped at 8 MB), '/media' is the library, which requires editor or
  // admin and has no per-file limit for an admin. `onProgress` needs XHR - fetch
  // cannot report upload progress - and a library upload can be large enough that
  // a progress bar is the difference between "working" and "frozen".
  // `fields` carries extra multipart fields - the library uses it to send folder_id,
  // so an upload lands in the folder that was open rather than being uploaded and
  // then moved.
  uploadImage: async (file, { endpoint = '/upload', onProgress, fields } = {}) => {
    if (onProgress) return API._uploadWithProgress(file, endpoint, onProgress, fields);
    const token = Auth.getToken();
    const fd = new FormData();
    // Fields before the file: multer parses parts in stream order, and the route
    // reads req.body.folder_id in the callback that runs once the file is written.
    for (const [k, v] of Object.entries(fields || {})) {
      if (v !== null && v !== undefined && v !== '') fd.append(k, String(v));
    }
    fd.append('image', file);
    let res;
    try {
      res = await fetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
    } catch (networkErr) {
      // fetch() itself throws on network failures, CORS blocks, or the
      // request never reaching the server at all (e.g. blocked upstream).
      throw new Error(`Không thể kết nối tới máy chủ để tải ảnh (${networkErr.message}).`);
    }
    const raw = await res.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      // Response wasn't JSON - likely an intermediary (proxy/tunnel/CDN)
      // returned an HTML error/challenge page instead of reaching the app.
      throw new Error(`Máy chủ trả về phản hồi không hợp lệ (mã ${res.status}). Có thể do proxy/tunnel chặn request.`);
    }
    if (!res.ok) throw new Error((data && data.error) || `Tải ảnh lên thất bại (mã ${res.status}).`);
    if (!data || !data.url) throw new Error('Máy chủ không trả về đường dẫn ảnh.');
    return data; // { url, media? }
  },

  // XHR rather than fetch, purely for upload.onprogress. Same response handling as
  // above, including the non-JSON case: a tunnel returning an HTML error page is a
  // real failure mode here and must not surface as "undefined".
  _uploadWithProgress: (file, endpoint, onProgress, fields) =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_BASE}${endpoint}`);
      const token = Auth.getToken();
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total, e.loaded, e.total);
      });
      xhr.addEventListener('load', () => {
        let data = null;
        try {
          data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
        } catch {
          return reject(
            new Error(`Máy chủ trả về phản hồi không hợp lệ (mã ${xhr.status}). Có thể do proxy/tunnel chặn request.`)
          );
        }
        if (xhr.status < 200 || xhr.status >= 300) {
          return reject(new Error((data && data.error) || `Tải ảnh lên thất bại (mã ${xhr.status}).`));
        }
        if (!data || !data.url) return reject(new Error('Máy chủ không trả về đường dẫn ảnh.'));
        resolve(data);
      });
      xhr.addEventListener('error', () => reject(new Error('Không thể kết nối tới máy chủ để tải ảnh.')));
      xhr.addEventListener('abort', () => reject(new Error('Đã huỷ tải ảnh.')));

      const fd = new FormData();
      // The file goes LAST: multer streams the parts in order, and routes/media.js
      // reads req.body.folder_id in the handler that runs after the file is written,
      // so a field appended after the file would not be parsed in time.
      for (const [k, v] of Object.entries(fields || {})) {
        if (v !== null && v !== undefined && v !== '') fd.append(k, String(v));
      }
      fd.append('image', file);
      xhr.send(fd);
    }),

  // ---- Media library (editor + admin) ----
  listMedia: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return apiFetch(`/media${qs ? `?${qs}` : ''}`);
  },
  // Which posts reference an image. Asked before a delete so the person is told
  // "this is used in 3 posts" rather than finding out from a broken image later.
  mediaUsage: (id) => apiFetch(`/media/${id}/usage`),
  deleteMedia: (id, { force = false } = {}) =>
    apiFetch(`/media/${id}${force ? '?force=true' : ''}`, { method: 'DELETE' }),
  syncMedia: () => apiFetch('/media/sync', { method: 'POST' }),

  // ---- Media folders ----
  listMediaFolders: () => apiFetch('/media/folders'),
  createMediaFolder: (name, parentId = null) =>
    apiFetch('/media/folders', { method: 'POST', body: JSON.stringify({ name, parent_id: parentId }) }),
  // `parent_id` is sent only when the caller means to move the folder: null is a
  // meaningful value (back to the top level), so its ABSENCE is what means "unchanged".
  updateMediaFolder: (id, payload) =>
    apiFetch(`/media/folders/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteMediaFolder: (id) => apiFetch(`/media/folders/${id}`, { method: 'DELETE' }),
  moveMediaToFolder: (mediaIds, folderId) =>
    apiFetch('/media/move', {
      method: 'PUT',
      body: JSON.stringify({ media_ids: mediaIds, folder_id: folderId }),
    }),

  // ---- Embeds ----
  // Resolved on the server so the editor and the save-time sanitiser share one
  // allowlist; see server/embeds.js.
  resolveEmbed: (url) => apiFetch('/posts/embed', { method: 'POST', body: JSON.stringify({ url }) }),
};

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---- Image derivatives ----
// Uploads are stored as-is and can be tens of megabytes (phone photos, full-screen
// PNG screenshots), so no page may point an <img> at an original. server/thumbs.js
// generates two shrunk copies on demand and server.js serves them at
// /uploads/thumb/<name> (480px, for tiles) and /uploads/w1280/<name> (1280px, wider
// than any column on the site). The URL keeps the ORIGINAL filename, so the client
// needs nothing but the name to address either copy.
//
// Anything that is not a bare same-origin /uploads/<name> path is returned
// untouched: external covers (Google-hosted, unsplash), the default cover, and URLs
// that already name a derivative. When the server has no ImageMagick those routes
// 302 to the original, so the worst case is today's behaviour, not a broken image.
const UPLOAD_ORIGINAL = /^\/uploads\/([^/]+)$/;

function derivUrl(url, kind) {
  const u = String(url ?? '').trim();
  const m = u.match(UPLOAD_ORIGINAL);
  if (!m) return u;
  return `/uploads/${kind === 'thumb' ? 'thumb' : 'w1280'}/${m[1]}`;
}

// The pictures inside a post body. Two fixes at once, applied to the stored HTML
// string just before it is put on a reading page (never in the editor, which must
// keep seeing exactly what was saved):
//   - src /uploads/<name> -> the 1280px derivative, the single biggest byte saving
//     on a post page;
//   - loading="lazy" decoding="async", so the tenth screenshot in an article no
//     longer competes with the first paint. Images above the fold are lazy too but
//     the browser loads them immediately once it knows they are near the viewport,
//     which is the behaviour wanted here.
// width/height are NOT invented: the stored markup carries none, and a wrong pair
// would reserve the wrong box and shift the text once the real ratio arrives.
function rewriteProseImages(html) {
  return String(html ?? '').replace(/<img\b[^>]*>/gi, (tag) => {
    let out = tag.replace(/\ssrc\s*=\s*(["'])([^"']*)\1/i, (m0, q, src) => {
      const d = derivUrl(src, 'w1280');
      return d === src ? m0 : ` src=${q}${d}${q}`;
    });
    if (!/\sloading\s*=/i.test(out)) out = out.replace(/<img\b/i, '<img loading="lazy"');
    if (!/\sdecoding\s*=/i.test(out)) out = out.replace(/<img\b/i, '<img decoding="async"');
    return out;
  });
}

// ---- Numbered pagers ----
// Here rather than in any one page's script because four lists in this app turn
// pages - the media grid, the folder shelf, the dashboard's activity feed and the
// users table - and they should be the same control. The pills they render into
// (.media-pager / .media-pager-btn, css/media.css) are likewise one style reused by
// all four; viewall.html is the exception that has its own copy of both, and its own
// test (tmp/test-t15.mjs) holding that copy in place.

// Which page numbers to show. Everything once the list is short; otherwise the two
// ends, the current page's neighbours, and 'gap' markers where pages are skipped -
// the windowing a search engine uses, because "jump to roughly where I was" matters
// more than seeing every number.
function pagerWindow(current, total) {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const wanted = new Set([1, 2, total - 1, total, current - 1, current, current + 1]);
  const pages = [...wanted].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < pages.length; i += 1) {
    if (i && pages[i] - pages[i - 1] > 1) out.push('gap');
    out.push(pages[i]);
  }
  return out;
}

// The pager's markup: a back arrow, the windowed numbers, a forward arrow.
// `attr` is the data-attribute the caller's click handler reads, and it is the ONLY
// thing that differs between the four pagers - which is why each one keeps its own
// attribute name rather than sharing `data-page`: media.js listens for clicks on the
// whole document, so a common name would make the grid's handler answer for the
// folder shelf and the users table too.
function pagerHtml(current, totalPages, attr) {
  const arrow = (target, label, icon, disabled) =>
    `<button type="button" class="media-pager-btn" ${attr}="${target}"` +
    `${disabled ? ' disabled' : ''} aria-label="${label}">` +
    `<span class="material-symbols-outlined" aria-hidden="true">${icon}</span></button>`;
  return (
    arrow(current - 1, 'Trang trước', 'arrow_back', current <= 1) +
    pagerWindow(current, totalPages)
      .map((p) =>
        p === 'gap'
          ? '<span class="media-pager-gap" aria-hidden="true">…</span>'
          : `<button type="button" class="media-pager-btn${p === current ? ' is-current' : ''}"` +
            ` ${attr}="${p}"${p === current ? ' aria-current="page"' : ''}>${p}</button>`
      )
      .join('') +
    arrow(current + 1, 'Trang sau', 'arrow_forward', current >= totalPages)
  );
}

// ---- Block-based post content (paragraph / heading / image) ----
// Content is stored as a JSON array of blocks, e.g.
//   [{type:'paragraph', text:'...'}, {type:'image', url:'/uploads/x.jpg', caption:'...'}]
// Older posts saved before this feature existed have plain text content
// (one paragraph per line) - parseContentBlocks() upgrades those on the fly.
function parseContentBlocks(content) {
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed) && parsed.every((b) => b && typeof b === 'object' && b.type)) return parsed;
  } catch {
    // not JSON - fall through to legacy plain-text handling
  }
  return String(content ?? '')
    .split('\n')
    .filter((line) => line.trim().length)
    .map((text) => ({ type: 'paragraph', text }));
}

// ---- Rich-text indentation: <blockquote> in the editor, <div class="rt-indent"> out ----
//
// The editor's "lùi dòng" button is document.execCommand('indent'), and every
// engine implements that by wrapping the selection in
//   <blockquote style="margin: 0 0 0 40px; border: none; padding: 0px;">
// - the QUOTE element, used for nothing but shifting text to the right. The
// reading page styles `.prose-content blockquote` as a QUOTATION - italic, a
// half-step down in size, and a pair of marks hanging off its first and last
// child - so an indented paragraph arrived set in somebody else's voice,
// quoted and emphasised with nobody behind the words, an indent the author left
// empty still announced itself as one, and a screen reader read out a quotation
// that was never written.
//
// The two representations are therefore deliberately NOT the same:
//   in the editor    -> <blockquote>, because the native indent/outdent commands
//                       only understand that element - they cannot un-indent a div
//   stored/rendered  -> <div class="rt-indent">, a plain indent with no quote
//                       semantics and no marks (styles in public/css/common.css)
// A blockquote that indent did NOT produce (pasted in from elsewhere) is left
// alone and keeps the quotation treatment - it really is a quote.
const RT_INDENT_CLASS = 'rt-indent';
const RT_INDENT_STYLE = 'margin: 0 0 0 40px; border: none; padding: 0px;';
// The mark that says a <blockquote> is a QUOTATION and not an indent. Set by the
// toolbar's "Trích dẫn" button in js/write.js, which is the only thing that
// writes one; declared here because this file loads first on every page that
// reads a post back, and because the test below is the one that has to honour
// it. Stored and editor spelling are the SAME element for a quote - unlike the
// indent, which is a <blockquote> only while it is being edited - so there is
// nothing for richTextToEditorHtml() to translate and nothing for
// normalizeRichTextHtml() to retag. The class exists to keep those two passes
// from eating it, and to let the stylesheets tell the two apart.
const RT_QUOTE_CLASS = 'rt-quote';

// An indent blockquote always zeroes the quote styling it would otherwise get.
// A blockquote written as a quote never resets its own border.
function isIndentBlockquote(el) {
  // First, and unconditionally: the author's own quotation is never an indent,
  // whatever inline style ends up on it. Pressing "lùi cả đoạn" inside a quote
  // can hand the wrapper the very border:none + margin-left the test below
  // reads, and retagging it to <div class="rt-indent"> would throw away the
  // quotation the class was put there to keep.
  if (el.classList.contains(RT_QUOTE_CLASS)) return false;
  if (el.classList.contains('webkit-indent-blockquote')) return true; // older WebKit
  const borderCleared =
    /^(none|hidden)$/i.test(el.style.borderStyle || '') || /^(none|0(px)?)$/i.test((el.style.border || '').trim());
  return borderCleared && parseFloat(el.style.marginLeft || '0') > 0;
}

// Parses the block's HTML, hands the fragment to `transform`, serialises it back.
// <template> is used rather than a live div so nothing loads (no image request,
// no script) while the markup is being rewritten.
function rewriteRichText(html, transform) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html ?? '');
  transform(tpl.content);
  return tpl.innerHTML;
}

function retagElement(el, tagName, decorate) {
  const replacement = document.createElement(tagName);
  while (el.firstChild) replacement.appendChild(el.firstChild);
  decorate(replacement);
  el.replaceWith(replacement);
}

function normalizeIndentWrappers(root) {
  // Deepest first, so a two-level indent keeps both of its levels.
  for (const bq of [...root.querySelectorAll('blockquote')].reverse()) {
    if (!isIndentBlockquote(bq)) continue;
    // An indent with nothing inside it is not a paragraph anyone can read -
    // it only ever painted an empty box.
    if (!bq.textContent.trim() && !bq.querySelector('img, br, figure, video, iframe')) {
      bq.remove();
      continue;
    }
    // The class list comes across, which is not housekeeping: an indented
    // paragraph typed with no <p> of its own IS this blockquote, so an alignment
    // or a leading chosen for it lives here - retagElement() builds a fresh
    // element and would otherwise drop every one of them.
    retagElement(bq, 'div', (div) => {
      if (bq.className) div.className = bq.className;
      // WebKit's own marker for an indent wrapper. It has served its purpose by
      // now (isIndentBlockquote() read it) and means nothing on a div.
      div.classList.remove('webkit-indent-blockquote');
      div.classList.add(RT_INDENT_CLASS);
    });
  }
}

// Stored markup -> what the contenteditable editor needs. Two things are put
// back into the spelling execCommand understands: the indent wrapper becomes the
// <blockquote> that 'indent'/'outdent' can still move, and the size/font classes
// become <font> again so a second press of "Lớn" REPLACES the size instead of
// nesting a second one inside it. Both are undone on the way out by
// normalizeRichTextHtml(). The constants used below are declared further down
// the file; nothing here runs at parse time.
//
// One thing is removed rather than translated: a literal colour, by the same
// stripLiteralColours() the publish direction runs. A post stored before that
// pass existed still has one, and the editor is a themed surface too - the
// author editing it in the dark theme would be staring at the same black-on-black
// the reader was, and would store the colour straight back on save.
function richTextToEditorHtml(html) {
  const source = String(html ?? '');
  const hasIndent = source.includes(RT_INDENT_CLASS);
  const hasMarks = /class\s*=\s*["'][^"']*\brt-(size|font)-/i.test(source);
  const hasColour = /style\s*=|<font[\s>]|bgcolor\s*=/i.test(source);
  if (!hasIndent && !hasMarks && !hasColour) return source;
  return rewriteRichText(source, (root) => {
    if (hasIndent) {
      for (const div of [...root.querySelectorAll('div.' + RT_INDENT_CLASS)].reverse()) {
        retagElement(div, 'blockquote', (bq) => {
          // Same reason as the outbound pass: the paragraph's own alignment and
          // leading classes are on this element and have to reach the editor.
          if (div.className) bq.className = div.className;
          bq.classList.remove(RT_INDENT_CLASS);
          if (!bq.className) bq.removeAttribute('class');
          bq.setAttribute('style', RT_INDENT_STYLE);
        });
      }
    }
    if (hasMarks) downgradeRichTextMarks(root);
    // Last, because the downgrade copies a span's style across to the <font> it
    // becomes and this pass has to see the result of that. The unwrap is here for
    // the same reason it is in the publish direction: a <span> whose only content
    // was the colour just taken off it is a wrapper around nothing, and leaving it
    // would make what the author sees a different shape from what the reader gets.
    if (hasColour) {
      stripLiteralColours(root);
      unwrapBareSpans(root);
    }
  });
}

// ---- Typography: an article is set in the site's type, not in the paste's ----
//
// Paragraph blocks are contenteditable HTML, and most of a long post arrives by
// pasting from somewhere else - Google Docs, a vendor advisory, another blog. A
// paste carries the SOURCE's typography inline: font-family "Google Sans Text"
// or Arial, body sizes in absolute pt/px, and Docs' own
// `line-height: 1.15 !important`. An inline style beats every stylesheet, so
// those passages kept rendering in a foreign face at a fixed size while the rest
// of the article used the body family at the article scale - two or three fonts
// down one page, and copy set 1.15 tight against the article's 1.7.
//
// Stripped from inline styles here is exactly what the page already decides:
//   font-family     unless it is a face the editor's own "Font..." picker can
//                   set - a pasted family is noise, a chosen one is a decision
//   font-size       ABSOLUTE units only (px/pt/...). A relative size rides the
//                   article's responsive scale, which steps down a notch on a
//                   phone; 12pt stays 16px on a 350px measure. Keeping relative
//                   sizes is also what preserves a pasted heading hierarchy,
//                   since Tailwind's preflight resets h1-h6 to font-size:inherit.
//   line-height     always: the article sets its own leading (1.7) and any
//                   inline value fights it
//   letter-spacing  always, same reason
// font-weight and font-style are left alone - those carry the author's emphasis,
// not its typeface. Colour is NOT left alone, and never was a typeface question:
// see stripLiteralColours() below, which is the pass that takes it.
//
// The editor's own font/size pickers do not use inline styles at all: with
// styleWithCSS off (the default in every engine) execCommand('fontName') and
// ('fontSize') emit <font face> / <font size>, so a deliberate choice survives
// this pass untouched. A <font face> can also arrive with a paste, which is why
// the face is checked against the same whitelist.
const RT_EDITOR_FONT_FACES = ['inter', 'newsreader', 'jetbrains mono'];

// Only the first family is compared: "Georgia, serif" and
// "Georgia,'Times New Roman',serif" are the same choice.
function firstFontFamily(value) {
  return String(value)
    .split(',')[0]
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .toLowerCase();
}

function isEditorFontFace(value) {
  return RT_EDITOR_FONT_FACES.includes(firstFontFamily(value));
}

// px/pt/pc/in/cm/mm/Q - a fixed size, blind to the measure it ends up on.
function isAbsoluteFontSize(value) {
  return /\d\s*(px|pt|pc|in|cm|mm|q)$/i.test(String(value).trim());
}

// Removes the declarations through CSSStyleDeclaration rather than by rewriting
// the attribute text, so `!important` and entity-encoded quotes are handled by
// the parser instead of by a regex.
function normalizeInheritedTypography(root) {
  for (const el of root.querySelectorAll('[style]')) {
    const style = el.style;
    if (style.fontFamily && !isEditorFontFace(style.fontFamily)) style.removeProperty('font-family');
    if (style.fontSize && isAbsoluteFontSize(style.fontSize)) style.removeProperty('font-size');
    if (style.lineHeight) style.removeProperty('line-height');
    if (style.letterSpacing) style.removeProperty('letter-spacing');
    // A wrapper whose only job was the font it no longer sets.
    if (!style.length) el.removeAttribute('style');
  }
  // The element and its size attribute stay; only a foreign face goes. A colour
  // attribute goes too, but that is stripLiteralColours()'s decision below, not
  // this pass's - this one is about type.
  for (const el of root.querySelectorAll('font[face]')) {
    if (!isEditorFontFace(el.getAttribute('face'))) el.removeAttribute('face');
  }
}

// ---- Ink: no literal colour reaches a page that has two themes ----
//
// The dark theme is ONE class re-pointing the --c-* variables (see the theme
// block at the top of public/css/common.css). An inline `color` cannot be
// re-pointed: it beats every stylesheet rule, including the token that .dark
// just moved. So a paragraph pasted in from Google Docs - which wraps its runs
// in `style="color:#000000"` - stayed black when the reader switched themes, on
// a surface that is itself nearly black. The words were on the page and nobody
// could read them, and nothing in the stylesheet was allowed to override it.
//
// An inline ink colour is therefore dropped, exactly as markInlineHighlights()
// above already drops an inline background. Unlike a highlight there is nothing
// to convert it TO, because it was never a choice made here: the toolbar has no
// colour picker - execCommand('foreColor') appears nowhere in this codebase -
// so every literal ink colour in a block arrived from a source document that had
// one theme and no idea this page has two.
//
// Whatever background is LEFT after markInlineHighlights() has claimed the
// inline ones goes too, from the other side of the same contrast problem: it
// only ever ran on SPAN/FONT/MARK/B/..., so a pasted panel -
// `background-color:#ffffff` on a <p> or a <td> - survived it, and the dark
// theme paints near-white ink, which on a white panel is white on white.
//
// Runs in BOTH directions, published and editor, so a post already stored with a
// literal colour reads correctly from the moment this ships and is stored clean
// on its next save - no migration over the rows in the database.
function stripLiteralColours(root) {
  for (const el of root.querySelectorAll('[style]')) {
    const style = el.style;
    if (style.color) style.removeProperty('color');
    // Both spellings of the background, because a shorthand is not expanded into
    // its longhands by every CSS implementation the tests run against - the same
    // reason markInlineHighlights() checks both.
    if (style.backgroundColor) style.removeProperty('background-color');
    if (style.background) style.removeProperty('background');
    // A wrapper whose only job was the colour it no longer sets. Without this
    // the <span> would survive unwrapBareSpans() - an attribute is an attribute
    // - and the pass would not be idempotent.
    if (!style.length) el.removeAttribute('style');
  }
  // The attribute spellings. <font color> is what a paste from Word carries and
  // what upgradeRichTextMarks() used to promote into a declaration; bgcolor is
  // the same idea on a table cell, and neither is in the server's allowlist any
  // more, so both are only here for content stored before that changed.
  for (const el of root.querySelectorAll('font[color]')) el.removeAttribute('color');
  for (const el of root.querySelectorAll('[bgcolor]')) el.removeAttribute('bgcolor');
}

// ---- The toolbar's marks: <font> in the editor, design classes out ----------
//
// execCommand has no vocabulary of its own. 'fontSize' writes <font size="5">
// and 'fontName' writes <font face="Georgia, serif"> - a deprecated element
// carrying an ABSOLUTE step off the browser's default (2=13px, 3=16px, 5=24px,
// 7=48px), which answers to nothing in this design system: a run marked
// "Rất lớn" stayed 48px on a 350px phone, ignoring both the article's 1.2rem
// base and its step down to 1.0625rem below sm. Stored and rendered, those
// become the .rt-size-* / .rt-font-* classes in public/css/common.css, whose
// sizes are `em` - one ratio, correct at either base.
//
// The two representations are deliberately NOT the same, for exactly the reason
// indentation keeps its <blockquote> in the editor: execCommand only understands
// its own markup. Handed <span class="rt-size-lg">, a second press of "Lớn" sees
// no font size to replace and NESTS another one inside it - 1.35 x 1.35. Handed
// <font size="5"> the engine replaces it, and splits or merges runs correctly
// when a selection covers only part of one. So the editor holds <font>, and the
// editor's own stylesheet (public/write.html) restyles <font size> to the same
// `em` ratios these classes use, so the size the author sees while typing is the
// size the reading page paints.
//   in the editor    -> <font size="5">, <font face="Georgia, serif">
//   stored/rendered  -> <span class="rt-size-lg">, <span class="rt-font-serif">
// Highlighting is the exception: it is applied as .rt-mark the moment the button
// is pressed (js/write.js), because a highlight cannot compound - marking marked
// text twice is the same mark - so it needs no editor-only spelling.
const RT_MARK_CLASS = 'rt-mark';
// <font size> is 1-7. sm and xl each absorb two steps so a pasted 1 or 6 lands
// somewhere sensible rather than being dropped.
const RT_SIZE_CLASS_BY_STEP = {
  1: 'rt-size-sm', 2: 'rt-size-sm', 3: 'rt-size-md',
  4: 'rt-size-md', 5: 'rt-size-lg', 6: 'rt-size-xl', 7: 'rt-size-xl',
};
// The step each class goes back out as. Not the inverse of the map above: the
// four classes are the four the toolbar offers, one <font size> each.
const RT_SIZE_STEP_BY_CLASS = { 'rt-size-sm': '2', 'rt-size-md': '3', 'rt-size-lg': '5', 'rt-size-xl': '7' };
const RT_SIZE_CLASSES = Object.keys(RT_SIZE_STEP_BY_CLASS);
// Keyed by first family only, like isEditorFontFace() - "Newsreader, Georgia,
// serif" and "Newsreader,'Times New Roman',serif" are one choice.
const RT_FONT_CLASS_BY_FACE = { inter: 'rt-font-sans', newsreader: 'rt-font-serif', 'jetbrains mono': 'rt-font-mono' };
const RT_FONT_FACE_BY_CLASS = {
  'rt-font-sans': 'Inter, sans-serif',
  'rt-font-serif': 'Newsreader, Georgia, serif',
  'rt-font-mono': "'JetBrains Mono', monospace",
};
const RT_FONT_CLASSES = Object.keys(RT_FONT_FACE_BY_CLASS);
// Where a highlight can legitimately sit. A background on a <p> or a <table> is
// a layout decision from whatever the text was pasted out of, not a marked
// phrase, and turning that into the site's highlighter would repaint a whole
// pasted panel.
const RT_MARK_TAGS = new Set(['SPAN', 'FONT', 'MARK', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'SUB', 'SUP']);

// Copies over what a <font> carried besides the attributes being translated: a
// paste can bring one in with a class and a style of its own.
function copyPresentation(from, to) {
  if (from.className) to.className = from.className;
  const style = from.getAttribute('style');
  if (style) to.setAttribute('style', style);
}

// A <span> with nothing left on it is a wrapper for a decision that has moved
// elsewhere - the <font size> whose step this design has no class for, or an
// element whose only style was a pasted font-family. Called by
// normalizeRichTextHtml() after BOTH passes have run, because either one can be
// what empties a wrapper out.
function unwrapBareSpans(root) {
  for (const el of [...root.querySelectorAll('span')]) {
    if (el.attributes.length) continue;
    el.replaceWith(...el.childNodes);
  }
}

// Two overlapping applications of the SAME size would multiply (1.35 x 1.35), so
// a descendant repeating its ancestor's class loses it. A DIFFERENT size nested
// inside one is left alone: that is a narrower, later choice by the author, and
// the editor cannot produce the shape anyway - it holds <font size> while the
// text is being edited, and the engine replaces those rather than nesting them.
function dedupeNestedMarks(root, classes) {
  for (const cls of classes) {
    for (const el of root.querySelectorAll('.' + cls + ' .' + cls)) {
      el.classList.remove(cls);
      // classList.remove leaves class="" behind, which is still an attribute -
      // enough for unwrapBareSpans() to keep a <span> that now says nothing, and
      // enough to make this pass non-idempotent: the wrapper would only
      // disappear the NEXT time the block was saved.
      if (!el.className) el.removeAttribute('class');
    }
  }
}

// Any inline background - the raw colour execCommand('hiliteColor') just wrote,
// or a highlight carried in by a paste - becomes the themed one. This was the
// first case where a pasted COLOUR was overridden rather than kept, and the
// reason is legibility rather than house style: a highlight is a background, the
// dark theme paints near-white ink, and every pale highlight ever pasted in put
// one on top of the other. stripLiteralColours() below now argues the same way
// about ink, and about the block-level backgrounds this pass deliberately skips.
// Its own function because it runs in TWO places: here, on save and on render,
// and straight after the toolbar press in js/write.js - the editor is a dark
// surface too, so a highlight has to be readable while it is being typed and not
// only once the post is saved. Deliberately narrower than upgradeRichTextMarks(),
// which must not run against the live editor: that pass also rewrites <font>,
// and the editor keeps <font size>/<font face> so the size and font pickers go on
// REPLACING a run instead of nesting inside it.
function markInlineHighlights(root) {
  for (const el of root.querySelectorAll('[style]')) {
    if (!RT_MARK_TAGS.has(el.tagName)) continue;
    if (!el.style.backgroundColor && !el.style.background) continue;
    el.style.removeProperty('background-color');
    el.style.removeProperty('background');
    if (!el.style.length) el.removeAttribute('style');
    el.classList.add(RT_MARK_CLASS);
  }
}

// Editor markup -> stored markup. Called from normalizeRichTextHtml(), so it
// runs on save AND on render: a post written before this existed gets the new
// behaviour with no migration step.
function upgradeRichTextMarks(root) {
  for (const el of [...root.querySelectorAll('font')]) {
    const size = RT_SIZE_CLASS_BY_STEP[parseInt(el.getAttribute('size'), 10)];
    const face = el.getAttribute('face');
    const font = face ? RT_FONT_CLASS_BY_FACE[firstFontFamily(face)] : null;
    retagElement(el, 'span', (span) => {
      copyPresentation(el, span);
      // A <font color> is NOT carried over. This used to promote it into
      // `style.color` so the run would keep "the colour the author picked" - but
      // there is no colour picker in this editor, so the only <font color> that
      // ever arrived came from a paste, and the declaration it became is the one
      // thing a themed page cannot override: an inline style beats the token the
      // .dark class moves. It dies with the <font>, and stripLiteralColours()
      // catches the ones already stored as declarations.
      if (size) span.classList.add(size);
      if (font) span.classList.add(font);
    });
  }
  for (const el of [...root.querySelectorAll('mark')]) {
    retagElement(el, 'span', (span) => {
      copyPresentation(el, span);
      span.classList.add(RT_MARK_CLASS);
    });
  }
  markInlineHighlights(root);
  dedupeNestedMarks(root, RT_SIZE_CLASSES);
  dedupeNestedMarks(root, [RT_MARK_CLASS]);
}

// Stored markup -> editor markup: the inverse, so "Cỡ chữ" and "Font" keep
// replacing a run set in an earlier session instead of nesting inside it.
// Only a plain <span> is turned back into a <font>. A class sitting on a <p> or
// an <li> is left where it is: it still renders correctly (the stylesheet is
// shared with the reading page) and retagging a block element would take the
// paragraph apart.
function downgradeRichTextMarks(root) {
  const carriers = [...RT_SIZE_CLASSES, ...RT_FONT_CLASSES].map((c) => 'span.' + c).join(', ');
  for (const el of [...root.querySelectorAll(carriers)]) {
    const size = RT_SIZE_CLASSES.find((c) => el.classList.contains(c));
    const font = RT_FONT_CLASSES.find((c) => el.classList.contains(c));
    retagElement(el, 'font', (fontEl) => {
      copyPresentation(el, fontEl);
      // The classes become attributes; anything else the span carried (rt-mark,
      // an alignment class on the same element) stays a class.
      if (size) fontEl.classList.remove(size);
      if (font) fontEl.classList.remove(font);
      if (!fontEl.className) fontEl.removeAttribute('class');
      if (size) fontEl.setAttribute('size', RT_SIZE_STEP_BY_CLASS[size]);
      if (font) fontEl.setAttribute('face', RT_FONT_FACE_BY_CLASS[font]);
    });
  }
}

// Editor markup -> the markup that is stored and rendered. The three guards keep
// a block that needs none of the passes byte-for-byte identical rather than
// putting it through a parse and re-serialise for nothing.
// Order matters: the marks are translated FIRST, because upgradeRichTextMarks()
// turns a pasted background into .rt-mark and the typography pass has to see the
// result - it is the pass that decides which inline declarations survive.
// stripLiteralColours() comes after the marks for the same reason, and would
// break the highlight if it came before: a pasted
// `background:#fef08a; color:#000` has to reach markInlineHighlights() with its
// background still on it, or there is nothing left to recognise as a highlight
// and the run loses the mark instead of gaining the themed one.
// unwrapBareSpans() runs last, over whatever the passes before it emptied out.
function normalizeRichTextHtml(html) {
  const source = String(html ?? '');
  const hasIndent = /<blockquote/i.test(source);
  const hasMarks = /<font[\s>]|<mark[\s>]|style\s*=/i.test(source);
  const hasTypography = /style\s*=|<font[\s>]/i.test(source);
  // bgcolor is the one literal colour that arrives as an attribute rather than a
  // declaration, so the colour pass needs it in a guard of its own.
  const hasColour = hasTypography || /bgcolor\s*=/i.test(source);
  if (!hasIndent && !hasMarks && !hasColour) return source;
  return rewriteRichText(source, (root) => {
    if (hasIndent) normalizeIndentWrappers(root);
    if (hasMarks) upgradeRichTextMarks(root);
    if (hasTypography) normalizeInheritedTypography(root);
    if (hasColour) stripLiteralColours(root);
    if (hasMarks || hasColour) unwrapBareSpans(root);
  });
}

// Origins an embed iframe may load from. The same list as EMBED_ORIGINS in
// server/embeds.js and as `frame-src` in the CSP - three copies of one fact, which is
// not ideal, but the alternative is shipping the server module to the browser. If this
// list and the server's ever disagree, the CSP is the one that decides, and the frame
// simply does not load.
const EMBED_ORIGINS = [
  'https://www.youtube-nocookie.com',
  'https://player.vimeo.com',
  'https://www.tiktok.com',
  'https://open.spotify.com',
  'https://www.facebook.com',
  'https://drive.google.com',
  'https://www.google.com',
];

function isAllowedEmbedSrcClient(value) {
  const src = String(value || '');
  return EMBED_ORIGINS.some((o) => src.startsWith(o + '/'));
}

// One image block on its own, exactly as before this file grouped runs of
// them - a lone picture inside an otherwise text-led article is illustrating
// a paragraph, not forming an album, so it stays the original full-width
// figure with its own caption underneath.
function imageFigureHtml(b) {
  const caption = b.caption ? `<figcaption class="text-sm text-on-surface-variant mt-2">${escapeHtml(b.caption)}</figcaption>` : '';
  // Inline article images: lazy, because an article can carry many of them
  // and only the first is ever near the fold - the cover above it is the
  // one that must load eagerly.
  return `<figure class="my-8"><img src="${escapeHtml(b.url)}" alt="${escapeHtml(b.caption || '')}" class="w-full rounded-xl" loading="lazy" decoding="async">${caption}</figure>`;
}

// A RUN of 2+ consecutive image blocks - an album added photo-by-photo via
// "+ Ảnh" (write.js), the shape this blog's own posts actually take. Grouped
// into one .ed-gallery (editorial.css - same column-count masonry technique
// as the homepage/list feed, so a portrait phone shot is not force-cropped
// into a landscape tile) instead of each block staying the full-width figure
// above: twenty of those stacked one after another was a very long scroll to
// browse, not an album. Captions fold into the <img>'s own alt/title rather
// than a <figcaption> per tile - one under every photo in a dense grid reads
// as clutter the single-figure case above does not have. Every <img> here is
// still a lightbox target with no gallery-specific code of its own:
// prepareArticleImages() (post.js) already walks every #post-body img.
function imageGalleryHtml(run) {
  const tiles = run
    .map((b) => `<img src="${escapeHtml(b.url)}" alt="${escapeHtml(b.caption || '')}" title="${escapeHtml(b.caption || '')}" loading="lazy" decoding="async">`)
    .join('');
  return `<div class="ed-gallery my-8">${tiles}</div>`;
}

function renderContentBlocksHtml(blocks) {
  const out = [];
  for (let i = 0; i < blocks.length; ) {
    const b = blocks[i];
    if (b.type === 'image' && b.url) {
      const run = [];
      while (i < blocks.length && blocks[i].type === 'image' && blocks[i].url) {
        run.push(blocks[i]);
        i++;
      }
      out.push(run.length > 1 ? imageGalleryHtml(run) : imageFigureHtml(run[0]));
      continue;
    }
    out.push(renderOneContentBlockHtml(b));
    i++;
  }
  return out.join('');
}

// ---- "Bố cục ảnh": the six image layouts (css/image-layouts.css) ----
// One block = one layout: which arrangement, its pictures (each with an
// optional alt text and, for an upload, the width/height the server looked up on save),
// an optional caption, and - for the two layouts that sit beside prose - the
// rich text that goes with them. The table is the single definition the editor
// (write.js) builds its picker and its slots from, and the server
// (server/ssr-content.js, routes/posts.js) mirrors it.
//   count: how many pictures the layout uses; masonry takes min..max.
const IMAGE_LAYOUTS = [
  { id: 'side', label: 'Ảnh dọc cạnh chữ (ảnh trái)', count: 1, text: true },
  { id: 'side-right', label: 'Ảnh dọc cạnh chữ (ảnh phải)', count: 1, text: true },
  { id: 'wide', label: 'Ảnh ngang rộng có chú thích', count: 1, text: false },
  { id: 'split', label: 'Ảnh và chữ chia đôi (ảnh trái)', count: 1, text: true },
  { id: 'split-reverse', label: 'Ảnh và chữ chia đôi (ảnh phải)', count: 1, text: true },
  { id: 'feature', label: '1 ảnh ngang lớn + 2 ảnh dọc', count: 3, text: false },
  { id: 'pair', label: '2 ảnh dọc cạnh nhau', count: 2, text: false },
  { id: 'masonry', label: 'Lưới hỗn hợp', count: 3, max: 12, text: false },
  { id: 'strip', label: 'Dải ảnh cuộn ngang', count: 3, max: 12, text: false },
];
function imageLayoutDef(id) {
  return IMAGE_LAYOUTS.find((l) => l.id === id) || IMAGE_LAYOUTS[0];
}
// The pictures a layout actually shows: fixed-count layouts take the first N
// that have a url, masonry up to its max.
function imageLayoutImages(b) {
  const def = imageLayoutDef(b.layout);
  const imgs = (Array.isArray(b.images) ? b.images : []).filter((im) => im && im.url);
  return imgs.slice(0, def.max || def.count);
}

// alt is optional for the author: an empty one falls back to the block's
// caption, so a captioned layout still describes its pictures.
// The arrows of a "Dải ảnh cuộn ngang" strip. Markup, not stored content: the
// renderer adds them around the scrolling row, and post.js wires them.
const STRIP_ARROWS =
  '<button type="button" class="ilay-strip-btn ilay-strip-btn--prev" data-strip-dir="-1" aria-label="Ảnh trước"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></button>' +
  '<button type="button" class="ilay-strip-btn ilay-strip-btn--next" data-strip-dir="1" aria-label="Ảnh sau"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg></button>';

function layoutImgHtml(im, fallbackAlt = '') {
  const w = Number(im.width);
  const h = Number(im.height);
  const dims = Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 ? ` width="${w}" height="${h}"` : '';
  return `<img src="${escapeHtml(im.url)}" alt="${escapeHtml(String(im.alt || '').trim() || fallbackAlt)}"${dims} loading="lazy" decoding="async">`;
}

function renderLayoutBlockHtml(b) {
  const def = imageLayoutDef(b.layout);
  const imgs = imageLayoutImages(b);
  if (!imgs.length) return '';
  const caption = b.caption ? `<figcaption class="ilay-caption">${escapeHtml(b.caption)}</figcaption>` : '';
  const text = def.text ? `<div class="ilay-text rich-text-block">${normalizeRichTextHtml(b.html || '')}</div>` : '';
  const img = (im) => layoutImgHtml(im, b.caption || '');
  const one = `<figure>${img(imgs[0])}${caption}</figure>`;
  switch (def.id) {
    case 'side':
    case 'side-right':
      return `<div class="ilay img-side${def.id === 'side-right' ? ' img-side--right' : ''}">${one}${text}</div>`;
    case 'split':
    case 'split-reverse':
      return `<div class="ilay split${def.id === 'split-reverse' ? ' split--reverse' : ''}">${one}${text}</div>`;
    case 'wide':
      return `<figure class="ilay img-wide">${img(imgs[0])}${caption}</figure>`;
    case 'strip':
      // tabindex: the row is keyboard-scrollable (arrow keys) once focused.
      return `<figure class="ilay gallery-strip"><div class="ilay-strip"><div class="ilay-grid" tabindex="0" aria-label="Dải ảnh, cuộn ngang">${imgs.map(img).join('')}</div>${STRIP_ARROWS}</div>${caption}</figure>`;
    default:
      return `<figure class="ilay gallery-${def.id}"><div class="ilay-grid">${imgs.map(img).join('')}</div>${caption}</figure>`;
  }
}

function renderOneContentBlockHtml(b) {
  if (b.type === 'layout') return renderLayoutBlockHtml(b);
  if (b.type === 'heading') {
    const tag = b.level === 1 ? 'h1' : b.level === 3 ? 'h3' : 'h2';
    const sizeClass = b.level === 1 ? 'text-3xl sm:text-4xl md:text-5xl' : b.level === 3 ? 'text-lg sm:text-xl' : 'text-xl sm:text-2xl md:text-3xl';
    return `<${tag} class="font-headline-md ${sizeClass} text-on-background mt-10 mb-4">${escapeHtml(b.text || '')}</${tag}>`;
  }

  // Embedded video / map / player.
  //
  // The src is NOT parsed here - it was resolved and re-checked on the server
  // (server/embeds.js, and again in routes/posts.js on every save). This checks it
  // against the same origin list before writing it into an iframe, because a
  // renderer that trusts its input is how a hand-edited row becomes a frame from
  // an attacker's origin. A src that fails renders nothing at all.
  if (b.type === 'embed') {
    if (!isAllowedEmbedSrcClient(b.src)) return '';
    const caption = b.caption
      ? `<figcaption class="text-sm text-on-surface-variant mt-2">${escapeHtml(b.caption)}</figcaption>`
      : '';
    // A ratio for video and maps, a fixed height for the players that have a
    // designed one (a Spotify track is 152px, not 16:9).
    const sizing = b.height
      ? `height: ${Number(b.height)}px`
      : `aspect-ratio: ${/^[0-9]{1,3} \/ [0-9]{1,3}$/.test(String(b.ratio || '')) ? b.ratio : '16 / 9'}`;
    // sandbox is deliberately absent: every provider here needs scripts and
    // same-origin storage to play at all, so a sandbox that permitted both would
    // be theatre. The control that matters is the origin allowlist above plus
    // `frame-src` in the CSP. referrerpolicy keeps our reader's path off the
    // provider's logs; `loading=lazy` stops a post with five videos from opening
    // five connections before anything is read.
    return `<figure class="my-8 rich-embed"><div class="rich-embed-frame" style="${sizing}">` +
      `<iframe src="${escapeHtml(b.src)}" title="${escapeHtml(b.title || 'Nội dung nhúng')}" ` +
      `loading="lazy" referrerpolicy="strict-origin-when-cross-origin" ` +
      `allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" ` +
      `allowfullscreen></iframe></div>${caption}</figure>`;
  }

  // New rich-text paragraph blocks store already-formatted HTML (from the
  // contenteditable editor) - render as-is. Only admin/editor roles can
  // write posts, so this is trusted-author content, not public user input.
  if (b.type === 'paragraph' && b.html !== undefined) {
    return `<div class="rich-text-block">${normalizeRichTextHtml(b.html)}</div>`;
  }

  const sizeStyle = b.size === 'sm' ? 'font-size:1rem;' : b.size === 'lg' ? 'font-size:1.5rem;' : '';
  const fontFamily =
    b.font === 'serif' ? "font-family:Georgia,'Times New Roman',serif;" : b.font === 'mono' ? "font-family:'Courier New',monospace;" : '';
  const indentPart = b.indent ? 'margin-left:2rem;' : '';
  const style = `${sizeStyle}${fontFamily}${indentPart}`;
  const classes = [b.bold ? 'font-bold' : '', b.italic ? 'italic' : ''].filter(Boolean).join(' ');
  const classAttr = classes ? ` class="${classes}"` : '';
  const styleAttr = style ? ` style="${style}"` : '';

  if (b.numbered) {
    const items = String(b.text || '')
      .split('\n')
      .filter((line) => line.trim().length)
      .map((line) => `<li${classAttr}${styleAttr}>${escapeHtml(line)}</li>`)
      .join('');
    return `<ol class="list-decimal pl-8 mb-6 space-y-2">${items}</ol>`;
  }

  return `<p${classAttr}${styleAttr}>${escapeHtml(b.text || '')}</p>`;
}

function timeAgoVi(dateStr) {
  const d = new Date(dateStr.replace(' ', 'T') + 'Z');
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'vừa xong';
  if (mins < 60) return `${mins} phút trước`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} giờ trước`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} ngày trước`;
  return d.toLocaleDateString('vi-VN', { day: '2-digit', month: 'long', year: 'numeric' });
}

// Renders the shared sign-in modal and wires up its behaviour.
//
// Email-first: the modal asks for one address, then shows the step that address
// actually needs - password, sign-up, or an OTP - instead of making people pick
// "Đăng nhập" vs "Đăng ký" before the server has said which one they are.
// Call injectAuthModal() once per page, then openAuthModal() to show it.
let authFlow = null; // set by injectAuthModal(): { reset(email) }

function injectAuthModal() {
  if (document.getElementById('auth-modal')) return;
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
  <div id="auth-modal" class="fixed inset-0 z-[200] hidden items-center justify-center bg-black/40 p-4 overflow-y-auto">
    <div class="auth-card max-w-md w-full my-auto overflow-hidden">
      <div class="relative p-5 sm:p-8">
        <div class="flex items-start justify-between gap-4 mb-6">
          <div>
            <span class="font-label-md text-[11px] tracking-wider uppercase text-electric-indigo" data-brand-name>${escapeHtml(currentSiteNames().brand)}</span>
            <h2 id="auth-heading" class="font-headline-md text-headline-md text-on-background mt-1">Đăng nhập/Đăng kí</h2>
            <p id="auth-subheading" class="font-body-sm text-body-sm text-on-surface-variant mt-1">Nhập email của bạn để tiếp tục.</p>
          </div>
          <button type="button" aria-label="Đóng" data-action="auth-close"
            class="flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-on-surface-variant hover:text-primary hover:bg-primary-container/10 transition-colors">
            <span class="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        <p id="auth-error" class="hidden px-3 py-2.5 mb-4 rounded-lg bg-error-container text-on-error-container font-body-sm text-body-sm"></p>

        <!-- The address from step 1, echoed on every later step with a way out,
             so a typo is one click to fix rather than a dead end. -->
        <div id="auth-identity" class="hidden items-center gap-2 mb-4 px-3 py-2 rounded-lg bg-surface-container border border-glass-border">
          <!-- 'mail', not 'account_circle': the icon font is a SUBSET (see
               scripts/icon-names.py) and only carries ligatures the pages
               already used, so account_circle would paint its own name as text
               until the font is rebuilt. This chip shows an email address, so
               mail reads correctly anyway. -->
          <span class="material-symbols-outlined text-[18px] text-on-surface-variant">mail</span>
          <span id="auth-identity-email" class="flex-1 min-w-0 truncate font-body-sm text-body-sm text-on-background"></span>
          <button type="button" id="auth-change-email" class="flex-shrink-0 font-label-md text-[12px] uppercase tracking-wider text-primary hover:underline">Đổi</button>
        </div>

        <form id="auth-step-email" class="flex flex-col gap-4">
          <div class="auth-field">
            <label for="auth-email" class="font-label-caps text-label-caps text-on-surface-variant uppercase">Email</label>
            <span class="material-symbols-outlined">mail</span>
            <input id="auth-email" required type="email" name="email" autocomplete="email" class="auth-input" placeholder="member@email.com">
          </div>
          <button type="submit" class="auth-submit mt-1">Tiếp tục</button>
        </form>

        <form id="auth-step-password" class="hidden flex-col gap-4">
          <div class="auth-field">
            <label for="auth-password" class="font-label-caps text-label-caps text-on-surface-variant uppercase">Mật khẩu</label>
            <span class="material-symbols-outlined">lock</span>
            <input id="auth-password" required type="password" name="password" autocomplete="current-password" class="auth-input" placeholder="••••••••">
          </div>
          <button type="submit" class="auth-submit mt-1">Đăng nhập</button>
          <button type="button" id="auth-forgot-link" class="tap-target justify-center font-body-sm text-body-sm text-on-surface-variant hover:text-primary transition-colors text-center">Quên mật khẩu?</button>
        </form>

        <form id="auth-step-register" class="hidden flex-col gap-4">
          <p class="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-secondary-fixed text-on-secondary-fixed-variant font-body-sm text-body-sm">
            <span class="material-symbols-outlined text-[18px] flex-shrink-0">person_add</span>
            <span>Email này chưa có tài khoản. Hãy điền thông tin dưới đây để tạo mới tài khoản nhé!.</span>
          </p>
          <div class="auth-field">
            <label for="auth-reg-name" class="font-label-caps text-label-caps text-on-surface-variant uppercase">Họ và tên</label>
            <span class="material-symbols-outlined">person</span>
            <input id="auth-reg-name" required type="text" name="name" autocomplete="name" class="auth-input" placeholder="Member Cute">
          </div>
          <div class="auth-field">
            <label for="auth-reg-password" class="font-label-caps text-label-caps text-on-surface-variant uppercase">Mật khẩu</label>
            <span class="material-symbols-outlined">lock</span>
            <input id="auth-reg-password" required type="password" name="password" minlength="6" autocomplete="new-password" class="auth-input" placeholder="Ít nhất 6 ký tự">
          </div>
          <button type="submit" class="auth-submit mt-1">Tạo tài khoản</button>
        </form>

        <!-- Sign-up verification: after /register returns pending, and also when
             a correct password is refused with EMAIL_NOT_VERIFIED. -->
        <div id="auth-step-verify" class="hidden flex-col gap-4">
          <p class="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-secondary-fixed text-on-secondary-fixed-variant font-body-sm text-body-sm">
            <span class="material-symbols-outlined text-[18px] flex-shrink-0">mark_email_unread</span>
            <span id="auth-verify-hint">Mã xác thực đã được gửi tới email của bạn.</span>
          </p>
          <form id="auth-verify-form" class="flex flex-col gap-4">
            <div class="auth-field auth-field--centered">
              <label for="auth-verify-otp" class="font-label-caps text-label-caps text-on-surface-variant uppercase">Mã xác thực (6 số)</label>
              <span class="material-symbols-outlined">pin</span>
              <input id="auth-verify-otp" required type="text" name="otp" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" class="auth-input tracking-[0.4em] text-center text-lg" placeholder="123456">
            </div>
            <button type="submit" class="auth-submit">Xác thực email</button>
          </form>
          <button type="button" id="auth-verify-resend" class="tap-target justify-center font-body-sm text-body-sm text-on-surface-variant hover:text-primary transition-colors text-center">Gửi lại mã</button>
        </div>

        <div id="auth-step-reset" class="hidden flex-col gap-4">
          <p class="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-secondary-fixed text-on-secondary-fixed-variant font-body-sm text-body-sm">
            <span class="material-symbols-outlined text-[18px] flex-shrink-0">mark_email_read</span>
            <span>Mã OTP đã được gửi tới email của bạn (mã có hiệu lực trong 10 phút).</span>
          </p>
          <form id="auth-reset-form" class="flex flex-col gap-4">
            <div class="auth-field auth-field--centered">
              <label for="auth-otp" class="font-label-caps text-label-caps text-on-surface-variant uppercase">Mã OTP (6 số)</label>
              <span class="material-symbols-outlined">pin</span>
              <input id="auth-otp" required type="text" name="otp" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" class="auth-input tracking-[0.4em] text-center text-lg" placeholder="123456">
            </div>
            <div class="auth-field">
              <label for="auth-new-password" class="font-label-caps text-label-caps text-on-surface-variant uppercase">Mật khẩu mới</label>
              <span class="material-symbols-outlined">lock_reset</span>
              <input id="auth-new-password" required type="password" name="newPassword" minlength="6" autocomplete="new-password" class="auth-input" placeholder="Ít nhất 6 ký tự">
            </div>
            <button type="submit" class="auth-submit">Đặt lại mật khẩu</button>
          </form>
        </div>

        <!-- A Google-registered address has no local password to ask for, so the
             password step is replaced by a pointer at the button below. -->
        <div id="auth-step-google" class="hidden flex-col gap-4">
          <p class="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-secondary-fixed text-on-secondary-fixed-variant font-body-sm text-body-sm">
            <span class="material-symbols-outlined text-[18px] flex-shrink-0">info</span>
            <span>Email này đã đăng ký bằng Google. Hãy bấm <strong>Tiếp tục với Google</strong> bên dưới.</span>
          </p>
          <button type="button" id="auth-google-use-password" class="tap-target justify-center font-body-sm text-body-sm text-on-surface-variant hover:text-primary transition-colors text-center">Tôi đã đặt mật khẩu, đăng nhập bằng mật khẩu</button>
        </div>

        <div id="auth-google-block">
          <div class="relative flex py-5 items-center">
            <div class="flex-grow border-t border-outline-variant"></div>
            <span class="flex-shrink mx-4 font-label-caps text-label-caps text-on-surface-variant uppercase">Hoặc</span>
            <div class="flex-grow border-t border-outline-variant"></div>
          </div>
          <a href="/api/auth/google" class="w-full flex items-center justify-center gap-3 px-4 py-3 bg-surface-container-lowest border border-outline-variant rounded hover:border-electric-indigo transition-all font-label-md text-body-sm text-on-surface">
            <svg class="w-5 h-5 flex-shrink-0" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="#4285F4" d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.66-5.17 3.66-9.17z"/>
              <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.13 0-5.78-2.11-6.73-4.96H1.18v3.14C3.15 21.32 7.23 24 12 24z"/>
              <path fill="#FBBC05" d="M5.27 14.24c-.25-.72-.39-1.49-.39-2.24s.14-1.52.39-2.24V6.62H1.18C.43 8.14 0 9.87 0 12s.43 3.86 1.18 5.38l4.09-3.14z"/>
              <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.23 0 3.15 2.68 1.18 6.62l4.09 3.14c.95-2.85 3.6-4.96 6.73-4.96z"/>
            </svg>
            <span>Tiếp tục với Google</span>
          </a>
        </div>
      </div>
    </div>
  </div>`;
  document.body.appendChild(wrapper.firstElementChild);

  const el = (id) => document.getElementById(id);
  const heading = el('auth-heading');
  const subheading = el('auth-subheading');
  const errorEl = el('auth-error');
  const identity = el('auth-identity');
  const identityEmail = el('auth-identity-email');
  const googleBlock = el('auth-google-block');
  const emailForm = el('auth-step-email');
  const passwordForm = el('auth-step-password');
  const registerForm = el('auth-step-register');
  const verifyStep = el('auth-step-verify');
  const resetStep = el('auth-step-reset');
  const googleStep = el('auth-step-google');
  const verifyForm = el('auth-verify-form');
  const resetForm = el('auth-reset-form');
  const resendBtn = el('auth-verify-resend');
  const forgotLink = el('auth-forgot-link');

  // Every step is one of these, so showStep() can hide the others without each
  // caller having to remember the full list.
  const STEPS = {
    email: { node: emailForm, heading: 'Đăng nhập/Đăng ký', sub: 'Nhập email của bạn để tiếp tục.', google: true },
    password: { node: passwordForm, heading: 'Nhập mật khẩu', sub: 'Chào mừng bạn đã trở lại!', google: false },
    register: { node: registerForm, heading: 'Tạo tài khoản mới', sub: 'Chỉ mất một chút xíu thời gian để tham gia.', google: false },
    verify: { node: verifyStep, heading: 'Xác thực email', sub: 'Nhập mã 6 số vừa gửi tới hộp thư của bạn.', google: false },
    reset: { node: resetStep, heading: 'Đặt lại mật khẩu', sub: 'Nhập mã OTP và mật khẩu mới.', google: false },
    google: { node: googleStep, heading: 'Đăng nhập bằng Google', sub: 'Tài khoản này dùng Google để đăng nhập.', google: true },
  };

  let currentEmail = '';

  function showError(msg) {
    errorEl.innerHTML = `<span class="material-symbols-outlined text-[18px] flex-shrink-0">error</span><span></span>`;
    errorEl.lastElementChild.textContent = msg;
    errorEl.classList.remove('hidden');
  }
  function clearError() {
    errorEl.classList.add('hidden');
  }

  function showStep(name) {
    clearError();
    for (const [key, step] of Object.entries(STEPS)) {
      const on = key === name;
      step.node.classList.toggle('hidden', !on);
      step.node.classList.toggle('flex', on);
    }
    const step = STEPS[name];
    heading.textContent = step.heading;
    subheading.textContent = step.sub;
    // Google stays available on the entry step and is the only way in on the
    // google step; on the others it would sign the visitor in as a different
    // identity than the one on screen.
    googleBlock.classList.toggle('hidden', !step.google);
    // The identity chip is the "which email am I working on" anchor, so it is on
    // for every step past the first.
    const showIdentity = name !== 'email' && !!currentEmail;
    identity.classList.toggle('hidden', !showIdentity);
    identity.classList.toggle('flex', showIdentity);
    identityEmail.textContent = currentEmail;
    step.node.querySelector('input:not([type="hidden"])')?.focus();
  }

  // Back to a blank first step. Also the reset openAuthModal() uses, so a modal
  // reopened after an abandoned sign-up does not resume mid-flow.
  function resetToEmail(email = '') {
    currentEmail = '';
    emailForm.reset();
    passwordForm.reset();
    registerForm.reset();
    verifyForm.reset();
    resetForm.reset();
    if (email) el('auth-email').value = email;
    showStep('email');
  }
  authFlow = { reset: resetToEmail };
  el('auth-change-email').addEventListener('click', () => resetToEmail(currentEmail));
  // A Google account that later set a local password (via "Quên mật khẩu?") can
  // still sign in that way, so the Google step is a default, not a dead end.
  el('auth-google-use-password').addEventListener('click', () => showStep('password'));

  // Shared submit-button bookkeeping: disabled + a "working" label, restored
  // whichever way the request ends.
  async function withBusy(form, label, fn) {
    const btn = form.querySelector('button[type="submit"]');
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = label;
    try {
      return await fn();
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  function signIn(token, user) {
    Auth.setSession(token, user);
    window.location.reload();
  }

  // ---- Step 1: which email is this? ----
  emailForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();
    const email = String(new FormData(emailForm).get('email') || '').trim();
    await withBusy(emailForm, 'Đang kiểm tra...', async () => {
      try {
        const res = await API.checkEmail(email);
        currentEmail = res.email || email.toLowerCase();
        if (!res.exists) return showStep('register');
        if (res.provider === 'google') return showStep('google');
        // Registered but never verified: mail a code and go straight to it,
        // rather than asking for a password that cannot be used yet.
        if (res.pendingVerification) {
          showStep('verify');
          return requestVerificationCode({ silent: true });
        }
        showStep('password');
      } catch (err) {
        showError(err.message);
      }
    });
  });

  // ---- Step 2a: existing account, ask for the password ----
  passwordForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();
    const password = new FormData(passwordForm).get('password');
    await withBusy(passwordForm, 'Đang đăng nhập...', async () => {
      try {
        const { token, user } = await API.login(currentEmail, password);
        signIn(token, user);
      } catch (err) {
        // The address was verified when we checked it but is not now (an admin
        // reset it, or a second tab): same handling as the check above.
        if (err.code === 'EMAIL_NOT_VERIFIED') {
          showStep('verify');
          requestVerificationCode({ silent: true });
          return;
        }
        showError(err.message);
      }
    });
  });

  // ---- Step 2b: no account yet, register it ----
  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();
    const fd = new FormData(registerForm);
    await withBusy(registerForm, 'Đang gửi mã...', async () => {
      try {
        const res = await API.register(fd.get('name'), currentEmail, fd.get('password'));
        // With sign-up verification switched off in the admin panel, the server
        // hands back a session here instead of a pending flag.
        if (res.token && res.user) return signIn(res.token, res.user);
        el('auth-verify-hint').textContent = res.message || `Mã xác thực đã được gửi tới ${currentEmail}.`;
        showStep('verify');
        startResendCooldown();
      } catch (err) {
        showError(err.message);
      }
    });
  });

  // ---- OTP step ----
  let resendTimer = null;
  function startResendCooldown(seconds = 60) {
    clearInterval(resendTimer);
    let left = seconds;
    resendBtn.disabled = true;
    const tick = () => {
      resendBtn.textContent = left > 0 ? `Gửi lại mã sau ${left}s` : 'Gửi lại mã';
      if (left <= 0) {
        clearInterval(resendTimer);
        resendBtn.disabled = false;
        return;
      }
      left -= 1;
    };
    tick();
    resendTimer = setInterval(tick, 1000);
  }

  // `silent` is for the automatic send when the flow lands on the OTP step by
  // itself. It suppresses only the cooldown 429, which there means a live code is
  // already sitting in the inbox - not something to report as a failure. A real
  // failure (503 from the mailer) is always shown: otherwise the step would claim
  // a code was sent when none was.
  async function requestVerificationCode({ silent = false } = {}) {
    try {
      await API.resendVerification(currentEmail);
      // Not the server's own text: /resend-verification answers with a
      // deliberately vague "if this email is pending..." so it does not confirm
      // an address to a stranger. The client already knows which address it is
      // working on, so it can say so plainly.
      el('auth-verify-hint').textContent = `Mã xác thực gồm 6 chữ số đã được gửi tới ${currentEmail}. Mã có hiệu lực trong 10 phút.`;
      startResendCooldown();
    } catch (err) {
      // A 429 carries the seconds left in its own text; keep the button locked
      // for a full minute rather than parsing it back out.
      if (err.status === 429) {
        startResendCooldown();
        if (!silent) showError(err.message);
        return;
      }
      showError(err.message);
    }
  }

  resendBtn.addEventListener('click', () => requestVerificationCode());

  verifyForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();
    const otp = new FormData(verifyForm).get('otp');
    await withBusy(verifyForm, 'Đang xác thực...', async () => {
      try {
        const { token, user } = await API.verifyEmail(currentEmail, otp);
        signIn(token, user);
      } catch (err) {
        showError(err.message);
      }
    });
  });

  // ---- Forgot password, from the password step ----
  forgotLink.addEventListener('click', async () => {
    clearError();
    forgotLink.disabled = true;
    forgotLink.textContent = 'Đang gửi mã...';
    try {
      await API.forgotPassword(currentEmail);
      showStep('reset');
    } catch (err) {
      showError(err.message);
    } finally {
      forgotLink.disabled = false;
      forgotLink.textContent = 'Quên mật khẩu?';
    }
  });

  resetForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();
    const fd = new FormData(resetForm);
    await withBusy(resetForm, 'Đang đặt lại...', async () => {
      try {
        await API.resetPassword(currentEmail, fd.get('otp'), fd.get('newPassword'));
        alert('Đặt lại mật khẩu thành công! Vui lòng đăng nhập lại.');
        resetToEmail(currentEmail);
      } catch (err) {
        showError(err.message);
      }
    });
  });

  showStep('email');
}

// Kept accepting a `mode` argument so the old openAuthModal('register') callers
// keep working; there are no tabs any more, so both modes open on the email step
// and the server decides which one it actually is.
function openAuthModal(mode = 'login') {
  injectAuthModal();
  document.getElementById('user-dropdown-menu')?.classList.add('hidden');
  authFlow?.reset();
  const modal = document.getElementById('auth-modal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  document.getElementById('auth-email')?.focus();
}
function closeAuthModal() {
  const el = document.getElementById('auth-modal');
  if (el) {
    el.classList.add('hidden');
    el.classList.remove('flex');
  }
}

// Clicking the dimmed backdrop (but not the card) closes the modal, and so does
// Escape - both are what people expect of a dialog like this.
document.addEventListener('click', (e) => {
  if (e.target.id === 'auth-modal') closeAuthModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !document.getElementById('auth-modal')?.classList.contains('hidden')) {
    closeAuthModal();
  }
});

// Top-nav account menu, following the design template: a single avatar button
// that opens a dropdown, both when signed in and when signed out. Signed out it
// offers the ways in (email/password modal, register, Google) instead of a
// separate "Đăng nhập" pill next to the avatar.
//
// Markup contract, same on index/post/profile/write:
//   #nav-avatar-btn > #nav-avatar-img + #nav-avatar-placeholder
//   #user-dropdown-menu (empty; its contents are built here)
function toggleNavDropdown() {
  // profile.html and admin.html each carry a side rail (renderNavAuthState()
  // below fills it with these exact same destinations) that is already on
  // screen at desktop widths - opening the dropdown there would just be a
  // second way to reach something already visible one column over. Below
  // 1024px (the same breakpoint .side-rail-aside itself collapses at, in
  // editorial.css - it pairs with .side-rail-content side by side only from
  // 1024px up, per that rule in common.css) that rail is gone and the
  // dropdown is the only way to any of it, so it still has to open there.
  //
  // Since the theme picker moved into this menu (it is the ONLY place the
  // theme can be changed now), the menu opens on those pages too: the rows
  // that duplicate the rail are wrapped in .ed-dropdown-rail-dup and hidden
  // from 1024px up by editorial.css, so what is left there is the header and
  // the "Giao diện" picker - nothing the rail already shows.
  document.getElementById('user-dropdown-menu')?.classList.toggle('hidden');
}

// Any click outside the avatar button closes the menu. The button itself used to
// call event.stopPropagation() from an inline onclick, which kept this listener
// from ever seeing the opening click; now that the button speaks data-action and
// is handled by the SAME delegated document listener as everything else, both
// listeners see every click - so the exclusion is stated here instead: clicks on
// the button, and on the menu it opened (the theme row must not shut the menu on
// the tap that flips it), are not "outside".
document.addEventListener('click', (e) => {
  if (e.target.closest('#nav-avatar-btn') || e.target.closest('#user-dropdown-menu')) return;
  document.getElementById('user-dropdown-menu')?.classList.add('hidden');
});
// A #hash link (profile.html's/admin.html's own panel/tab switches, added in
// renderNavAuthState() above) is a same-page jump when clicked from that
// page itself - no navigation happens, so nothing closes the dropdown the
// way an ordinary link's page-unload used to for free. This used to be
// "fixed" by hiding the dropdown INSIDE its own click handler - which
// broke every link in it on a phone instead: hiding an <a> (or an ancestor
// of one, which .add('hidden') here is) before the browser has resolved
// that same click's default action makes mobile Safari (and some Android
// WebViews) drop the pending navigation entirely, taps and all. Closing
// from 'hashchange' instead runs AFTER the browser has already committed to
// the jump, so it can never race the very click it is trying to react to -
// see showPanelFromHash() in profile.html and the listener added to
// initAdmin() in admin.js, both of which now also close this menu.
// Same idea for the mobile nav dropdown: a click outside it (or its own
// hamburger button) closes it. Not "outside the links themselves" only,
// because the links are <a href>s that navigate away anyway - this is for
// someone who opened it and tapped elsewhere instead.
document.addEventListener('click', (e) => {
  if (e.target.closest('.ed-hamburger-btn') || e.target.closest('.ed-nav-links')) return;
  document.querySelector('.ed-nav-links')?.classList.remove('mobile-open');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.getElementById('user-dropdown-menu')?.classList.add('hidden');
});

// py-2.5 over a 20px line box already clears 40px, so these rows do not need
// .tap-target - and adding it would centre the labels away from the icons.
const NAV_ITEM_CLASS =
  'ed-dropdown-item flex items-center gap-3 w-full px-4 py-3 text-left font-body-sm text-body-sm transition-colors';

const GOOGLE_MARK_SVG = `<svg class="w-[18px] h-[18px] flex-shrink-0" viewBox="0 0 24 24" aria-hidden="true">
  <path fill="#4285F4" d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.66-5.17 3.66-9.17z"/>
  <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.13 0-5.78-2.11-6.73-4.96H1.18v3.14C3.15 21.32 7.23 24 12 24z"/>
  <path fill="#FBBC05" d="M5.27 14.24c-.25-.72-.39-1.49-.39-2.24s.14-1.52.39-2.24V6.62H1.18C.43 8.14 0 9.87 0 12s.43 3.86 1.18 5.38l4.09-3.14z"/>
  <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.23 0 3.15 2.68 1.18 6.62l4.09 3.14c.95-2.85 3.6-4.96 6.73-4.96z"/>
</svg>`;


// ---- One delegated click listener instead of inline handlers ----
//
// Every public page and every template this file renders now says WHAT it wants
// (data-action / data-goto / data-goto-tag) instead of carrying JavaScript in an
// onclick attribute, and this single listener is the only place that translates
// those into calls. That is the migration script-src 'unsafe-inline' is waiting
// on in server/security-headers.js: admin.html and write.html still carry their
// own inline handlers, so the directive stays loose until they are converted
// too - but nothing on the reader-facing pages depends on inline script any more.
//
// Page scripts add their own verbs with registerAction() rather than reaching
// into this table: profile.js owns deleteMyPost, and a global table that named
// it would make this file depend on a page.
const GLOBAL_ACTIONS = {
  'search-toggle': () => document.getElementById('search-overlay')?.classList.toggle('hidden'),
  'search-close': () => document.getElementById('search-overlay')?.classList.add('hidden'),
  // stopPropagation: the document-level handler that closes the menu runs on the
  // same click, and without this the menu would shut on the tap that opened it.
  'nav-dropdown': (e) => {
    e.stopPropagation();
    toggleNavDropdown();
  },
  'auth-open': () => openAuthModal(),
  'auth-close': () => closeAuthModal(),
  'theme-toggle': (e) => {
    e.stopPropagation();
    if (window.Theme) window.Theme.toggle();
  },
  // The three-way picker in the account menu. stopPropagation keeps the menu
  // open, so the reader sees the page change under it and can try another.
  'theme-set': (e, el) => {
    e.stopPropagation();
    if (window.Theme) window.Theme.set(el.dataset.themeMode);
  },

  logout: () => Auth.logout(),
  // Mobile nav: toggles the SAME .ed-nav-links the desktop row already has
  // (editorial.css repositions it into a dropdown below 768px via
  // .mobile-open) rather than a second copy of the links. stopPropagation
  // for the same reason nav-dropdown needs it - the outside-click closer
  // a few lines down runs on this same click otherwise.
  'mobile-nav-toggle': (e) => {
    e.stopPropagation();
    document.querySelector('.ed-nav-links')?.classList.toggle('mobile-open');
  },
  // The dropdown's profile.html/admin.html rows (renderNavAuthState() below),
  // dispatched here as data-action buttons rather than left as plain
  // <a href="/profile.html#password">/#hash links. Those looked right and
  // even updated the URL bar on click, but the reaction to it - the actual
  // panel/tab switch AND closing this menu, both wired to 'hashchange' - did
  // not fire reliably for every visitor tested, cause unconfirmed. Calling
  // showPanel()/switchTab() straight from here needs no event to arrive
  // correctly at all: they are the exact same page-global functions the
  // (still fully working) desktop side rail's own buttons already call.
  // window.showPanel/window.switchTab are only defined on the one page each
  // belongs to - the other is always undefined there, which is why both are
  // guarded rather than picking one by the current path. The hash is set
  // afterwards only so the URL still reflects the open panel/tab for a
  // bookmark or a shared link - never the thing this actually depends on.
  'profile-panel': (e, el) => {
    if (typeof window.showPanel === 'function') window.showPanel(el.dataset.panel);
    document.getElementById('user-dropdown-menu')?.classList.add('hidden');
    // el.dataset.hash is the SAME fragment HASH_PANELS in profile.html maps
    // back to this panel id (not a mechanical transform of the id itself -
    // 'panel-edit' is reached at #avatar, not #edit), kept in sync by being
    // written from the one navMenuItem() call that builds this button below.
    history.replaceState(null, '', `/profile.html#${el.dataset.hash}`);
  },
  'admin-tab': (e, el) => {
    const target = el.dataset.tab;
    if (typeof window.switchTab === 'function') window.switchTab(target);
    document.getElementById('user-dropdown-menu')?.classList.add('hidden');
    history.replaceState(null, '', `/admin.html#${target}`);
  },
};

function registerAction(name, fn) {
  GLOBAL_ACTIONS[name] = fn;
}

function wireGlobalHandlers() {
  document.addEventListener('click', (e) => {
    // "Liên hệ" - the one mailto: link every page's nav carries (server/
    // render-html.js fills its href from contact_email; data-setting-mailto
    // itself is left on the element, same as every other data-setting-* the
    // renderer does not strip). A mailto: normally hands off to the OS mail
    // client with no warning, which for a reader who has no mail app
    // configured - or was not expecting to leave the page at all - is a
    // jarring, unexplained context switch. confirm() rather than a custom
    // modal: the same pattern every destructive action in admin.js already
    // uses, and this is the one non-admin page asking anything first.
    const mailLink = e.target.closest('[data-setting-mailto]');
    if (mailLink && /^mailto:/i.test(mailLink.getAttribute('href') || '')) {
      e.preventDefault();
      if (confirm('Mở ứng dụng email để liên hệ?')) window.location.href = mailLink.href;
      return;
    }
    const act = e.target.closest('[data-action]');
    if (act && GLOBAL_ACTIONS[act.dataset.action]) {
      GLOBAL_ACTIONS[act.dataset.action](e, act);
      return;
    }
    // A tag chip wins over the card around it: closest() from the click target
    // meets the chip first, so one listener replaces the old stopPropagation.
    const tagEl = e.target.closest('[data-goto-tag]');
    if (tagEl) {
      e.preventDefault();
      window.location.href = `/viewall.html?tag=${encodeURIComponent(tagEl.getAttribute('data-goto-tag'))}`;
      return;
    }
    // A real link inside a data-goto card (a card title) navigates by itself,
    // so ctrl/middle-click still opens a new tab without moving this one.
    if (e.target.closest('a[href]')) return;
    const go = e.target.closest('[data-goto]');
    if (go) window.location.href = go.getAttribute('data-goto');
  });

  // Enter submits from either search field: the pill in the header (>=sm) or
  // the overlay one that replaces it on narrow screens. Wired here, once for
  // every page, instead of per page script and per inline onkeydown.
  for (const id of ['search-input', 'search-input-mobile']) {
    document.getElementById(id)?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const q = e.target.value.trim();
      if (q) window.location.href = `/viewall.html?q=${encodeURIComponent(q)}`;
    });
  }
}
document.addEventListener('DOMContentLoaded', wireGlobalHandlers);

function navMenuItem({ href, action, icon, iconHtml, label, extraClass = '', attrs = '' }) {
  const cls = `${NAV_ITEM_CLASS} ${extraClass}`.trim();
  const glyph = iconHtml || `<span class="material-symbols-outlined text-[18px]">${icon}</span>`;
  const inner = `${glyph}<span>${label}</span>`;
  return href
    ? `<a ${attrs} class="${cls}" href="${href}">${inner}</a>`
    : `<button ${attrs} type="button" class="${cls}" data-action="${action}">${inner}</button>`;
}

// ---- "Giao diện" picker: Sáng > Tối > Tự động ----
// "Tự động" stores no choice (Theme.set(null)) and follows the OS live.
// The one place the theme is chosen (the header icon and the mobile-menu
// switch were removed in favour of it). Inline SVG rather than Material
// Symbols: the icon font is subsetted, and a glyph the subset lacks renders
// as nothing at all. Drawn in currentColor so all three themes tint them.
// All three are OUTLINES at rest; the picked one is filled by editorial.css
// (.ed-theme-opt.is-active svg), which is the whole "selected" signal.
const THEME_OPTIONS = [
  {
    mode: 'light',
    label: 'Sáng',
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6"/></svg>',
  },
  {
    mode: 'dark',
    label: 'Tối',
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" aria-hidden="true"><path d="M20.2 14.6A8.6 8.6 0 0 1 9.4 3.8a8.6 8.6 0 1 0 10.8 10.8z"/></svg>',
  },
  {
    mode: 'auto',
    label: 'Tự động',
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><circle cx="12" cy="12" r="8.4"/><path d="M12 3.6a8.4 8.4 0 0 1 0 16.8z" fill="currentColor" stroke="none"/></svg>',
  },
];

function themePickerHtml() {
  const current = themePickerMode();
  const buttons = THEME_OPTIONS.map((o) => {
    const on = o.mode === current;
    return `<button type="button" role="radio" aria-checked="${on}" class="ed-theme-opt${on ? ' is-active' : ''}" data-action="theme-set" data-theme-mode="${o.mode}">${o.svg}<span>${o.label}</span></button>`;
  }).join('');
  return `<div class="ed-theme-picker px-3 pt-3 pb-2">
          <p class="ed-theme-picker-label">Giao diện</p>
          <div class="ed-theme-seg" role="radiogroup" aria-label="Giao diện">${buttons}</div>
        </div>`;
}

// Keeps the picker in step with what is on screen - a pick in another tab, or
// the OS flipping while no explicit choice is stored - without re-rendering
// the whole menu.
// The picked option is the STORED choice, not what is on screen: "Tự động"
// shows light or dark depending on the OS but stays the selected option.
function themePickerMode() {
  return (window.Theme && window.Theme.stored()) || 'auto';
}
function syncThemePicker() {
  const mode = themePickerMode();
  document.querySelectorAll('.ed-theme-opt').forEach((btn) => {
    const on = btn.dataset.themeMode === mode;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-checked', String(on));
  });
}
if (window.Theme) window.Theme.onChange(syncThemePicker);

function renderNavAuthState() {
  const user = Auth.getUser();
  // The token, not the cached user object: the Google callback stores the token
  // first and only writes the user once /auth/me answers, so a real session can
  // briefly have no `user` - exactly when being able to sign out matters most.
  const signedIn = Auth.isLoggedIn();
  const dropdown = document.getElementById('user-dropdown-menu');
  const avatarImg = document.getElementById('nav-avatar-img');
  const avatarPlaceholder = document.getElementById('nav-avatar-placeholder');

  // Signed in: show the real avatar. Signed out: keep the generic person icon,
  // so the button is still there to click (that's what opens the login menu).
  if (avatarImg) {
    // The 480px thumb: the header avatar is ~32px, and an original upload can
    // be a large (even animated) image fetched on every page.
    const url = user && user.avatar_url ? derivUrl(user.avatar_url, 'thumb') : '';
    if (url) avatarImg.src = url;
    avatarImg.classList.toggle('hidden', !url);
  }
  if (avatarPlaceholder) avatarPlaceholder.classList.toggle('hidden', !!(user && user.avatar_url));

  if (dropdown) {
    const divider = '<div class="ed-dropdown-divider my-1"></div>';
    if (user) {
      const canWrite = user.role === 'editor' || user.role === 'admin';
      const avatar = user.avatar_url
        ? `<img src="${escapeHtml(derivUrl(user.avatar_url, 'thumb'))}" alt="" class="ed-dropdown-avatar w-9 h-9 object-cover flex-shrink-0">`
        : `<span class="ed-dropdown-avatar w-9 h-9 flex-shrink-0 flex items-center justify-center material-symbols-outlined text-[20px]">person</span>`;
      // profile.html's own side rail carries a second row of panel switches
      // (Đổi mật khẩu, Thông báo, Hoạt động gần đây) that make sense nowhere
      // else - added here, not to every page's dropdown, and
      // gated on the PATH alone (not on ?user=, i.e. even a visitor reading
      // someone else's profile gets a quick way back to their OWN settings).
      // This is also the mobile fix for the side rail eating the whole first
      // screen on profile.html: those panel switches are now reachable from
      // the header without scrolling past the rail at all.
      //
      // data-action="profile-panel" buttons, not plain #hash links: a link's
      // href updated the URL bar correctly on click but the REACTION to it -
      // profile.html's own 'hashchange' listener, which is what actually
      // switches the panel and closes this menu - did not fire reliably for
      // every visitor tested (root cause unconfirmed: same-document
      // navigation is supposed to fire it unconditionally). Calling
      // window.showPanel() straight from the click handler (GLOBAL_ACTIONS
      // 'profile-panel' above) needs no event to arrive at all - it is the
      // exact function the still-reliable desktop side rail's own buttons
      // already call. The hash is still set afterward (history.replaceState),
      // only so the URL keeps reflecting the open panel for a bookmark or a
      // shared link - never something this depends on to work.
      const onProfilePage = window.location.pathname === '/profile.html';
      // Narrower than onProfilePage above (path only): this is specifically
      // "viewing YOUR OWN profile right now", so the "Trang cá nhân" link
      // itself - which only ever points at your own, query-less /profile.html -
      // can be dropped from the menu instead of sitting there as a link back
      // to the exact page already on screen. Someone else's profile
      // (?user=id) keeps it, since then it is a real way back to your own.
      const onOwnProfilePage = onProfilePage && !new URLSearchParams(window.location.search).get('user');
      // Same fix as profile.html's, for admin.html's own side rail (its seven
      // tabs, not panels, but the identical "eats the whole first screen on
      // mobile" problem - see the #admin-app media query in editorial.css).
      // Gated on the admin role too, not just the path: a non-admin cannot
      // reach /admin.html at all (requireAuth+requireAdmin server-side), so
      // canWrite alone would offer these to an editor who somehow landed on
      // the URL and got its own "not an admin" notice instead of a panel.
      const onAdminPage = window.location.pathname === '/admin.html' && user.role === 'admin';
      // The pages whose side rail already lists every account row: from 1024px
      // up only the header and the theme picker are shown (see toggleNavDropdown).
      const onSideRailPage = onProfilePage || onAdminPage;
      dropdown.innerHTML = `
        <div class="ed-dropdown-header flex items-center gap-3 px-4 py-3">
          ${avatar}
          <div class="min-w-0">
            <p class="ed-dropdown-name font-body-sm text-body-sm truncate" data-nav-username>${escapeHtml(user.name || '')}</p>
            <p class="ed-dropdown-email font-body-sm text-[11px] truncate">${escapeHtml(user.email || '')}</p>
          </div>
        </div>
        ${themePickerHtml()}
        <div class="ed-dropdown-divider${onSideRailPage ? ' ed-dropdown-rail-dup' : ''}"></div>
        <div class="py-2 flex flex-col${onSideRailPage ? ' ed-dropdown-rail-dup' : ''}">
          ${onOwnProfilePage ? '' : navMenuItem({ href: '/profile.html', icon: 'person', label: 'Trang cá nhân' })}
          ${canWrite ? navMenuItem({ href: '/write.html', icon: 'post_add', label: 'Viết bài mới' }) : ''}
          ${user.role === 'admin' && !onAdminPage ? navMenuItem({ href: '/admin.html', icon: 'dashboard', label: 'Bảng quản trị' }) : ''}
          ${
            user.role === 'admin' && !onAdminPage
              ? navMenuItem({ href: '/admin.html#posts', icon: 'edit_document', label: 'Quản lý bài viết' })
              : ''
          }
          ${
            onProfilePage
              ? `<div class="ed-dropdown-mobile-only">${divider}
          ${navMenuItem({ action: 'profile-panel', icon: 'lock_reset', label: 'Đổi mật khẩu', attrs: 'data-panel="panel-password" data-hash="password"' })}
          ${navMenuItem({ action: 'profile-panel', icon: 'notifications', label: 'Thông báo', attrs: 'data-panel="panel-notif" data-hash="notif"' })}
          ${navMenuItem({ action: 'profile-panel', icon: 'schedule', label: 'Hoạt động gần đây', attrs: 'data-panel="panel-activity" data-hash="activity"' })}</div>`
              : ''
          }
          ${
            onAdminPage
              ? `<div class="ed-dropdown-mobile-only">${divider}
          ${navMenuItem({ action: 'admin-tab', icon: 'dashboard', label: 'Tổng quan', attrs: 'data-tab="overview"' })}
          ${navMenuItem({ action: 'admin-tab', icon: 'notifications', label: 'Thông báo', attrs: 'data-tab="notifications"' })}
          ${navMenuItem({ action: 'admin-tab', icon: 'edit_document', label: 'Quản lý bài viết', attrs: 'data-tab="posts"' })}
          ${navMenuItem({ action: 'admin-tab', icon: 'perm_media', label: 'Thư viện ảnh', attrs: 'data-tab="media"' })}
          ${navMenuItem({ action: 'admin-tab', icon: 'group', label: 'Người dùng', attrs: 'data-tab="users"' })}
          ${navMenuItem({ action: 'admin-tab', icon: 'home_work', label: 'Quản lí trang chủ', attrs: 'data-tab="settings"' })}
          ${navMenuItem({ action: 'admin-tab', icon: 'mail', label: 'Cài đặt email', attrs: 'data-tab="email"' })}
          ${navMenuItem({ action: 'admin-tab', icon: 'delete', label: 'Thùng rác', attrs: 'data-tab="trash"' })}</div>`
              : ''
          }
          ${divider}
          ${navMenuItem({ action: 'logout', icon: 'logout', label: 'Đăng xuất' })}
        </div>`;
    } else {
      dropdown.innerHTML = `
        <div class="ed-dropdown-header px-4 py-3">
          <p class="ed-dropdown-name font-body-sm text-body-sm">Chưa đăng nhập</p>
          <p class="ed-dropdown-email font-body-sm text-[11px]">Đăng nhập để bình luận và theo dõi bài mới</p>
        </div>
        ${themePickerHtml()}
        <div class="ed-dropdown-divider"></div>
        <div class="py-2 flex flex-col">
          ${navMenuItem({ action: 'auth-open', icon: 'login', label: 'Đăng nhập / Đăng ký' })}
          ${divider}
          ${navMenuItem({ href: '/api/auth/google', iconHtml: GOOGLE_MARK_SVG, label: 'Đăng nhập với Google', extraClass: 'ed-dropdown-item--accent font-semibold' })}
        </div>`;
    }
    dropdown.classList.add('hidden');
  }

  // "Viết bài" links must be hidden both when logged out entirely AND when
  // logged in with the 'readonly' role - only 'editor'/'admin' can write.
  const canWrite = !!user && (user.role === 'editor' || user.role === 'admin');
  document.querySelectorAll('[data-writer-only]').forEach((el) => el.classList.toggle('hidden', !canWrite));
  document
    .querySelectorAll('[data-admin-link]')
    .forEach((el) => el.classList.toggle('hidden', !user || user.role !== 'admin'));

  // Rows that need nothing but a session - profile.html's "Đăng xuất" row in the
  // side rail. Separate from the two role hooks above because it asks a
  // different question: whether SOMEONE is signed in, which stays true while
  // reading another person's profile (/profile.html?user=<id>), where profile.js
  // switches the owner-only rows off.
  document.querySelectorAll('[data-session-only]').forEach((el) => el.classList.toggle('hidden', !signedIn));
}

document.addEventListener('DOMContentLoaded', renderNavAuthState);

/* The left rail on profile.html and admin.html is one card in one place - see
   .side-rail-aside in common.css. From lg up it caps its own height and scrolls
   INSIDE itself, so a row the reader scrolled down to (admin's "Cài đặt email",
   profile's "Đăng xuất") stays scrolled to.
   Switching panel or tab is not a scroll, though, and leaving that offset in
   place reads as the card jumping: measured on admin.html at 1440x560, the rail
   holds 265px of scroll, and switching tab with it scrolled 120px down left the
   reference row 120px above the position it occupies on every fresh load. On a
   laptop viewport that is most of the rail's height.
   So each switch puts the rail back to scrollTop 0, which IS the reference
   position of the row the page is named for - "Trang cá nhân" on profile.html,
   "Tổng quan" on admin.html - and both are far enough up the rail to be visible
   there at every height the rail can take.
   Set directly rather than scrollTo({behavior:'smooth'}): an animated scroll
   back is the row visibly travelling, which is the exact thing being removed.
   Scoped by the .side-rail-aside class, so write.html's .rt-rail - a different
   card, with its own scroll the reader is entitled to keep - is never touched. */
function resetSideRailScroll() {
  const rail = document.querySelector('.side-rail-aside');
  if (rail) rail.scrollTop = 0;
}

// Fetches /api/settings exactly once per page load and caches the result so
// every part of the page (nav branding, page title, footer...) reads from
// the SAME single source instead of each doing its own fetch or, worse,
// hardcoding "TuanPA" as a fallback that never gets corrected later.
let _siteSettingsPromise = null;
function getSiteSettings() {
  if (!_siteSettingsPromise) {
    _siteSettingsPromise = API.getSettings()
      .then((r) => r.settings || {})
      .catch(() => ({}));
  }
  return _siteSettingsPromise;
}

// Drops the cached /api/settings response and re-applies the branding, so an
// admin who just saved new settings sees them on the page they are standing on
// instead of only after a reload.
async function refreshSiteSettings() {
  _siteSettingsPromise = null;
  await applySiteBranding();
}

// Fallback site name - the same constant as DEFAULT_SITE_NAME in server/site.js.
// The real name is admin-editable: `brand_name` (logo text) and `site_title`
// (browser-tab name) in Admin > Quản lí trang chủ. This is only what shows when
// neither has been set, or when /api/settings cannot be read at all.
const DEFAULT_SITE_NAME = 'AnonyHT';

// Same precedence as siteNamesFrom() in server/site.js - an empty site_title
// follows the brand name, so renaming the logo renames the tab too.
function resolveSiteNames(settings) {
  const brand = String(settings?.brand_name ?? '').trim() || DEFAULT_SITE_NAME;
  const title = String(settings?.site_title ?? '').trim() || brand;
  return { brand, title };
}

// The names currently on the page. Seeded from the server-rendered HTML rather
// than from the constant above: server/render-html.js already substituted the
// admin's values before sending, so reading them back means no code path here
// ever paints the fallback name over a correct one.
let _siteNames = null;

function siteNamesFromDom() {
  const brandEl = document.querySelector('[data-brand-name]');
  const brand = (brandEl?.textContent || '').trim() || DEFAULT_SITE_NAME;

  // <title data-page-name="Viết bài">Viết bài - Tên trang</title> - strip the
  // page-name prefix the server added back off to recover the site title alone.
  const titleEl = document.querySelector('title[data-page-name]');
  const page = titleEl ? titleEl.dataset.pageName || '' : '';
  const full = (document.title || '').trim();
  let title = full;
  if (page && full.startsWith(page + ' - ')) title = full.slice(page.length + 3).trim();
  return { brand, title: title || brand };
}

function currentSiteNames() {
  if (!_siteNames) _siteNames = siteNamesFromDom();
  return _siteNames;
}

// "<page name> - <site title>", or just the site title where the <title> carries
// an empty data-page-name (the homepage). Same shape the server builds.
function siteTitleFor(pageName) {
  const { title } = currentSiteNames();
  return pageName ? `${pageName} - ${title}` : title;
}

// A page whose tab name is not the static one in its <title> (the post page
// titles the tab after the article) records it here, so re-applying the branding
// after /api/settings resolves rebuilds THAT name instead of reverting to the
// page's generic one.
let _pageTitleOverride = null;
function setSiteTitle(pageName) {
  _pageTitleOverride = pageName;
  document.title = siteTitleFor(pageName);
}

// Keeps the site name (nav logo, page title, footer) identical on every page.
// Runs everywhere since api.js is loaded on every page.
//
// The server already substitutes the same values into the HTML before sending
// it (see server/render-html.js), so this pass is normally a no-op. It stays as
// a safety net for HTML that came from a cache, and to re-apply the branding
// after an admin saves new settings without a full reload.
async function applySiteBranding() {
  let settings;
  try {
    settings = await getSiteSettings();
  } catch (e) {
    return; // Non-critical - keep whatever the server already rendered.
  }
  // getSiteSettings() resolves to {} when the request failed. Applying that
  // would stamp the fallback name over the correct one the server rendered,
  // so treat "no keys at all" as "nothing to say" and leave the page as-is.
  if (!settings || !Object.keys(settings).length) return;

  _siteNames = resolveSiteNames(settings);

  document.querySelectorAll('[data-brand-name]').forEach((el) => {
    el.textContent = _siteNames.brand;
  });

  const titleEl = document.querySelector('title[data-page-name]');
  if (_pageTitleOverride !== null) {
    document.title = siteTitleFor(_pageTitleOverride);
  } else if (titleEl) {
    document.title = siteTitleFor(titleEl.dataset.pageName);
  }

  // A key present in the table wins even when empty (admin cleared the field
  // deliberately); data-fallback covers a table that never had the key.
  document.querySelectorAll('[data-footer-text]').forEach((el) => {
    el.textContent = 'footer_text' in settings ? settings.footer_text : el.dataset.fallback || el.textContent;
  });

  // The contact address the admin sets (Admin > Quản lí trang chủ > Email liên
  // hệ), shown in every footer and in clause 10 of /terms.html. Mirrors the two
  // server passes in render-html.js: href="mailto:..." so a click opens the
  // visitor's mail client, and the visibility of whichever element carries
  // data-hide-if-empty. Empty means the admin cleared it - the href goes away
  // and the item hides, which is what data-hide-if-empty already did on the
  // server; the class is toggled here too so a page served from a stale cache,
  // and the admin's own footer right after a save, end up in the same state
  // without a reload. The visible LABEL is markup ("Liên hệ" in the footer) and
  // is deliberately left alone here.
  document.querySelectorAll('[data-setting-mailto]').forEach((el) => {
    const key = el.dataset.settingMailto;
    const value = String(key in settings ? settings[key] : el.dataset.fallback || '').trim();
    if (value) el.setAttribute('href', 'mailto:' + value);
    else el.removeAttribute('href');
    // The label is markup ("Liên hệ" in the footer, the address itself in clause
    // 10 of /terms.html), so only the href and the visibility are mirrored here.
    // The hide goes on whichever element carries the hide-if-empty contract - the
    // link itself in the footer, the paragraph wrapping it on the terms page - so
    // no bare icon or empty paragraph is left behind on a stale cached copy.
    (el.closest('[data-hide-if-empty]') || el).classList.toggle('hidden', !value);
  });

  // The plain text slots - the hero copy on index.html, and the contact address
  // as the label of clause 10's link on /terms.html. The server fills them in
  // the first paint; this pass covers a stale cached copy and, on the terms
  // page, the markup terms.js injects right after a save (that markup arrives
  // with the slot empty, exactly as it sits in the database). Same precedence
  // as the server: a key present in the table wins even when empty, and
  // data-fallback only covers a table that never had the key.
  document.querySelectorAll('[data-setting]').forEach((el) => {
    const key = el.getAttribute('data-setting');
    const value = key in settings ? settings[key] : el.getAttribute('data-fallback');
    if (value !== null && value !== undefined) el.textContent = value;
  });

  // The admin-configured favicon (Admin > Quản lí trang chủ). The server already
  // filled the href before sending (server/render-html.js); this pass covers a
  // stale cached copy of the page, and applies a just-saved icon without a
  // reload - refreshSiteSettings() lands here after the settings form saves.
  // Present-but-empty means the admin cleared it: the tag goes away entirely,
  // same as what the server renders.
  const favicon = String(settings.favicon ?? '').trim();
  const faviconLink = document.querySelector('link[rel="icon"]');
  if (favicon) {
    const link = faviconLink || document.head.appendChild(document.createElement('link'));
    link.rel = 'icon';
    link.href = favicon;
  } else if (faviconLink) {
    faviconLink.remove();
  }
}
document.addEventListener('DOMContentLoaded', applySiteBranding);

// Media library: the grid, the uploader, and the picker modal.
//
// ONE implementation, two hosts. The admin panel's "Thư viện" tab and the picker
// that opens from the post editor render the same grid from the same state, because
// they are the same thing seen twice - a library you browse, and a library you pick
// from. Keeping them as one module is what stops the two drifting into different
// ideas of what an image is (different date formats, one showing the uploader and
// the other not, a delete that works in one place and silently fails in the other).
//
// Loaded on admin.html and write.html, after api.js. It touches no globals beyond
// the two entry points at the bottom.

// ---------------------------------------------------------------- state

// View modes: how the grid lays images out. One object rather than four scattered
// ifs; `pageSize` is how many images one page fetches, since a screenful of small
// tiles is a much shorter scroll than a screenful of large ones. The names double
// as the `is-view-*` class the CSS keys off ('medium' has no class - it is the
// default).
const MEDIA_VIEWS = {
  small: { pageSize: 96 },
  medium: { pageSize: 48 },
  large: { pageSize: 24 },
  list: { pageSize: 60 },
};
const MEDIA_VIEW_KEY = 'mediaViewMode';

// The choice is a preference, not a session state: it should survive a reload.
// localStorage can throw (private mode, disabled) and the grid must still work,
// so a failure just means "medium".
function readMediaViewPref() {
  try {
    const saved = localStorage.getItem(MEDIA_VIEW_KEY);
    return saved && MEDIA_VIEWS[saved] ? saved : 'medium';
  } catch {
    return 'medium';
  }
}

// One object rather than a class: there is at most one grid on screen at a time
// (the admin tab, or the picker modal), so a second instance would have nothing to
// be. `host` is whichever container is currently showing it.
const mediaState = {
  items: [],
  page: 1,
  limit: MEDIA_VIEWS.medium.pageSize,
  total: 0,
  viewMode: readMediaViewPref(),
  totals: { count: 0, bytes: 0, freeDisk: null },
  query: '',
  mineOnly: false,
  canDeleteAny: false,
  maxFileBytes: null,
  loading: false,
  // Folder tree, and which folder is open. `folder` is a numeric id, the string
  // 'none' for unfiled images, or null for "every image" - three states rather than
  // two, because "unfiled" is a real place a person navigates to.
  folders: [],
  folder: null,
  folderPath: [],
  // Which page of the folder shelf is drawn. The shelf is paged rather than left to
  // scroll (see FOLDER_PAGE_SIZE below), so this is a state of the visit like `page`
  // is for the grid - not a preference, so it is not in localStorage.
  folderPage: 1,
  unfiledCount: 0,
  // Picker mode: the callback that receives the chosen image, or null in the admin
  // tab where clicking a card opens the detail panel instead.
  onPick: null,
};

// ---------------------------------------------------------------- formatting

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDimensions(m) {
  return m.width && m.height ? `${m.width}×${m.height}` : '—';
}

// The stored name is a timestamp plus random bytes, so it tells a person nothing.
// The original name is what they recognise; fall back to the stored one only when
// a file was adopted from disk and never had another name.
function displayName(m) {
  return m.original_name || m.filename;
}

// ---------------------------------------------------------------- rendering

// One card. The whole card is the click target: in the picker that means "use this
// image", in the admin tab it opens the detail panel. Rendered as markup rather than
// elements because the grid is one innerHTML assignment - same approach as the
// comment tree in post.js.
function mediaCardHtml(m) {
  const name = displayName(m);
  // The tile renders the THUMBNAIL, not the original: the originals are phone
  // photos of 8-14 MB and decoding a page of them is what made scrolling this
  // grid jank. thumb_url falls back to url when the server has no ImageMagick
  // (see server/thumbs.js), so there is no branch here.
  return `
  <button type="button" class="media-card" data-media-id="${m.id}" title="${escapeHtml(name)}">
    <span class="media-card-thumb">
      <img src="${escapeHtml(m.thumb_url || m.url)}" alt="" loading="lazy" decoding="async">
    </span>
    <span class="media-card-meta">
      <span class="media-card-name">${escapeHtml(name)}</span>
      <span class="media-card-facts">${formatDimensions(m)} · ${formatBytes(m.bytes)}</span>
    </span>
  </button>`;
}

function renderMediaGrid() {
  const grid = document.getElementById('media-grid');
  if (!grid) return;

  if (mediaState.loading && !mediaState.items.length) {
    grid.innerHTML = '<p class="media-empty">Đang tải thư viện...</p>';
    return;
  }
  if (!mediaState.items.length) {
    grid.innerHTML = mediaState.query
      ? `<p class="media-empty">Không có ảnh nào khớp với "${escapeHtml(mediaState.query)}".</p>`
      : '<p class="media-empty">Thư viện chưa có ảnh nào. Kéo ảnh vào khung phía trên để bắt đầu.</p>';
    return;
  }
  grid.innerHTML = mediaState.items.map(mediaCardHtml).join('');
}

// ---------------------------------------------------------------- pager

// pagerWindow() and pagerHtml() are api.js's, shared with the folder shelf below and
// with the two pagers on the dashboard: one control, one implementation, one style.

function renderMediaPager() {
  const pager = document.getElementById('media-pager');
  if (!pager) return;

  const totalPages = Math.max(1, Math.ceil(mediaState.total / mediaState.limit));
  // A single page is not a choice, so the numbers stay hidden rather than offering a
  // control that cannot do anything. `.hidden` outranks `.media-pager`'s
  // display:flex only because tailwind.css loads after media.css on both hosts -
  // which it does, and which is worth knowing before either file is reordered.
  if (totalPages <= 1 || !mediaState.items.length) {
    pager.classList.add('hidden');
    pager.innerHTML = '';
    return;
  }
  pager.classList.remove('hidden');
  pager.innerHTML = pagerHtml(mediaState.page, totalPages, 'data-media-page');
}

function setMediaPage(page) {
  const totalPages = Math.max(1, Math.ceil(mediaState.total / mediaState.limit));
  const target = Math.min(Math.max(1, page), totalPages);
  if (target === mediaState.page && mediaState.items.length) return;
  loadMedia({ keepPage: true, page: target });
  // The new page's first row should be on screen: a click on page 9 that left the
  // viewport where page 1's bottom was would read as a broken button.
  const grid = document.getElementById('media-grid');
  if (grid) grid.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------------------------------------------------------- view modes

// Switches the grid's layout. The mode survives reloads (localStorage) because it
// is a preference about how a person likes to look at images, not a state of this
// visit. `reload` re-fetches when the page size changes; a view that shows 96
// images per screenful should not be fed by one that fetched 24.
function applyMediaView(mode, { reload = false } = {}) {
  if (!MEDIA_VIEWS[mode]) return;
  const changed = mediaState.viewMode !== mode;
  mediaState.viewMode = mode;
  try {
    localStorage.setItem(MEDIA_VIEW_KEY, mode);
  } catch {
    // Private mode or storage disabled: the mode still applies for this visit.
  }

  const grid = document.getElementById('media-grid');
  if (grid) {
    grid.classList.remove('is-view-small', 'is-view-large', 'is-view-list');
    if (mode !== 'medium') grid.classList.add(`is-view-${mode}`);
  }
  for (const btn of document.querySelectorAll('.media-view-btn')) {
    const active = btn.dataset.mediaView === mode;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', String(active));
  }

  if (changed && reload) loadMedia();
}

function renderMediaTotals() {
  const el = document.getElementById('media-totals');
  if (!el) return;
  const t = mediaState.totals;
  const parts = [`${t.count} ảnh`, formatBytes(t.bytes)];
  // Free disk is the one limit an admin is still held to, so it is worth showing
  // rather than only surfacing as an error at the moment an upload is refused.
  if (t.freeDisk !== null && t.freeDisk !== undefined) {
    parts.push(`còn trống ${formatBytes(t.freeDisk)}`);
  }
  el.textContent = parts.join(' · ');
}

// ---------------------------------------------------------------- loading

async function loadMedia({ append = false, keepPage = false, page = null } = {}) {
  mediaState.loading = true;
  // The page size belongs to the view mode: small tiles mean more of them per
  // fetch, large ones fewer. (The server caps limit at 100; every mode is under.)
  mediaState.limit = (MEDIA_VIEWS[mediaState.viewMode] || MEDIA_VIEWS.medium).pageSize;
  if (!append && !keepPage) {
    mediaState.page = 1;
    mediaState.items = [];
    renderMediaGrid();
  }
  if (page !== null) mediaState.page = page;
  try {
    const data = await API.listMedia({
      page: mediaState.page,
      limit: mediaState.limit,
      ...(mediaState.query ? { q: mediaState.query } : {}),
      ...(mediaState.mineOnly ? { mine: 'true' } : {}),
      // Absent means "every image". 'none' is the unfiled view.
      ...(mediaState.folder !== null && !mediaState.query ? { folder: mediaState.folder } : {}),
    });
    mediaState.items = append ? [...mediaState.items, ...data.media] : data.media;
    mediaState.total = data.total;
    mediaState.page = data.page || mediaState.page;
    // The server serves an out-of-range page as-is rather than clamping it: after
    // deletes the page a person was on can stop existing. A non-empty library with
    // an empty result means we walked past the end, so step back onto the last page
    // that does.
    if (!append && !data.media.length && data.total > 0) {
      const last = Math.max(1, Math.ceil(data.total / mediaState.limit));
      if (mediaState.page > last) {
        mediaState.loading = false;
        return loadMedia({ keepPage: true, page: last });
      }
    }
    mediaState.totals = data.totals;
    mediaState.canDeleteAny = data.canDeleteAny;
    mediaState.maxFileBytes = data.maxFileBytes;
    mediaState.folders = data.folders || [];
    mediaState.folderPath = data.folderPath || [];
    mediaState.unfiledCount = data.unfiledCount || 0;
    renderMediaGrid();
    renderMediaPager();
    renderMediaTotals();
    renderUploadHint();
    renderFolderShelf();
    renderFolderBreadcrumb();
  } catch (e) {
    const grid = document.getElementById('media-grid');
    if (grid) grid.innerHTML = `<p class="media-empty text-error">${escapeHtml(e.message)}</p>`;
  } finally {
    mediaState.loading = false;
  }
}

// The uploader's own caption depends on the role, which only the server knows, so it
// is written after the first load rather than hardcoded in the markup.
function renderUploadHint() {
  const el = document.getElementById('media-upload-hint');
  if (!el) return;
  el.textContent =
    mediaState.maxFileBytes === null
      ? 'JPG, PNG, WEBP, GIF · không giới hạn dung lượng mỗi ảnh'
      : `JPG, PNG, WEBP, GIF · tối đa ${formatBytes(mediaState.maxFileBytes)} mỗi ảnh`;
}

// ---------------------------------------------------------------- folder shelf
//
// The server sends a flat list of folders and the shelf draws a flat list: one card
// per folder, sideways, paged. It was a tree here until the folders moved out of the
// 13rem column beside the grid and into a full-width card above it, and a tree is the
// one shape a horizontal rail cannot be - a tree says depth by indentation, and
// indentation across a row means nothing (see .media-folder-rail in css/media.css).
//
// Depth is still reachable, and by the same route the picker modal has always used:
// the breadcrumb over the grid (#media-breadcrumb) names the open folder and every
// folder above it, and a crumb goes back up. The card that is open is FILLED, so the
// one place you are is never ambiguous even though its parents are not drawn.
//
// The list the shelf pages is EVERY folder at every depth, in the order the server
// sends it, not one level of it. Two folders at different depths can share a name,
// which is why a card's `title` carries the whole path rather than the last of it.

// Cards on one page, COUNTING the two view cards below: six cards and the five gaps
// between them come to 904px against the 918px the content column has at the page
// cap, so a full page fills the rail without making it scroll - and a last page
// holding two folders does not stretch them into two slabs across the whole tab.
const FOLDER_PAGE_SIZE = 6;

// "Tất cả ảnh" and "Chưa phân loại" are views, not rows in media_folders, so they
// never page away: "every image" has to stay one click from anywhere in the library.
// They take the first two slots on every page, which leaves four for real folders.
const FOLDER_VIEW_CARDS = 2;
const FOLDERS_PER_PAGE = FOLDER_PAGE_SIZE - FOLDER_VIEW_CARDS;

function childFolders(parentId) {
  return mediaState.folders.filter((f) =>
    parentId === null ? f.parent_id === null : Number(f.parent_id) === Number(parentId)
  );
}

// Which page a folder's card is on. Used whenever the open folder changes - a click,
// a create, a delete that left you somewhere else - so the card you just acted on is
// the card you are looking at instead of one that is paged off the end of the rail.
function folderPageOf(id) {
  const i = mediaState.folders.findIndex((f) => Number(f.id) === Number(id));
  return i < 0 ? 1 : Math.floor(i / FOLDERS_PER_PAGE) + 1;
}

// One card. `data-folder` is what the delegated click handler reads; the picker's
// chips and the breadcrumb's crumbs carry the same attribute, so one branch serves
// all three.
//
// The actions row is a SIBLING of the button and never inside it. Two reasons, and
// the second is load-bearing: a button inside a button is not permitted, and the
// click handler tests [data-folder] BEFORE the action attributes, so a nested action
// would open the folder instead of renaming it.
function folderCardHtml(folder) {
  const active = String(mediaState.folder) === String(folder.id);
  const kids = childFolders(folder.id);
  return `
  <div class="media-folder-card${active ? ' is-active' : ''}">
    <button type="button" class="media-folder-btn" data-folder="${folder.id}" title="${escapeHtml(folderLabelPath(folder.id))}">
      <span class="material-symbols-outlined" aria-hidden="true">${kids.length ? 'folder_open' : 'folder'}</span>
      <span class="media-folder-text">
        <span class="media-folder-name">${escapeHtml(folder.name)}</span>
        <span class="media-folder-count">${folder.media_count}</span>
      </span>
    </button>
    <span class="media-folder-actions">
      <button type="button" class="media-folder-action" data-folder-new="${folder.id}" title="Thêm thư mục con" aria-label="Thêm thư mục con trong ${escapeHtml(folder.name)}">
        <span class="material-symbols-outlined" aria-hidden="true">create_new_folder</span>
      </button>
      <button type="button" class="media-folder-action" data-folder-rename="${folder.id}" title="Đổi tên" aria-label="Đổi tên ${escapeHtml(folder.name)}">
        <span class="material-symbols-outlined" aria-hidden="true">edit</span>
      </button>
      ${
        mediaState.canDeleteAny
          ? `<button type="button" class="media-folder-action media-folder-action--danger" data-folder-delete="${folder.id}" title="Xoá thư mục" aria-label="Xoá thư mục ${escapeHtml(folder.name)}">
               <span class="material-symbols-outlined" aria-hidden="true">delete</span>
             </button>`
          : ''
      }
    </span>
  </div>`;
}

// One of the two view cards. No actions row: there is nothing to rename or delete
// about "every image", and .media-folder-card's justify-content centres the button in
// the shorter card so the two still line up with the folder cards beside them.
function folderViewCardHtml(value, icon, label, count, active) {
  return `
  <div class="media-folder-card${active ? ' is-active' : ''}">
    <button type="button" class="media-folder-btn" data-folder="${value}" title="${escapeHtml(label)}">
      <span class="material-symbols-outlined" aria-hidden="true">${icon}</span>
      <span class="media-folder-text">
        <span class="media-folder-name">${escapeHtml(label)}</span>
        <span class="media-folder-count">${count}</span>
      </span>
    </button>
  </div>`;
}

function renderFolderShelf() {
  const host = document.getElementById('media-folders');
  if (!host) return;

  // Two hosts, two shapes. The admin tab gets the paged shelf, with rename/delete
  // controls on each card; the picker gets chips for the CURRENT level only, because
  // a modal has no room for a shelf and picking an image is a shallower task than
  // organising.
  if (host.classList.contains('media-folder-chips')) {
    // Inside a folder, offer its children and a way back up. At the top level, the
    // root folders.
    const openId = typeof mediaState.folder === 'number' ? mediaState.folder : null;
    const siblings = childFolders(openId);
    const parentOf = openId === null ? null : (mediaState.folders.find((f) => Number(f.id) === openId) || {}).parent_id;

    const chip = (value, label, count, active) =>
      `<button type="button" class="media-chip${active ? ' is-active' : ''}" data-folder="${value}">
         ${escapeHtml(label)}${count === null ? '' : ` <span class="media-chip-count">${count}</span>`}
       </button>`;

    host.innerHTML =
      chip('all', 'Tất cả', mediaState.totals.count, mediaState.folder === null) +
      chip('none', 'Chưa phân loại', mediaState.unfiledCount, mediaState.folder === 'none') +
      (openId !== null
        ? chip(parentOf === null || parentOf === undefined ? 'all' : parentOf, '↑ Lên một cấp', null, false)
        : '') +
      siblings.map((f) => chip(f.id, f.name, f.media_count, false)).join('');
    return;
  }

  // ---- the admin shelf ----

  const all = mediaState.folders;
  const totalPages = Math.max(1, Math.ceil(all.length / FOLDERS_PER_PAGE));
  // Deleting a folder can take the last page with it, and arriving on a page that no
  // longer exists would draw an empty rail with a number under it. Clamped here rather
  // than at every call site, because every call site is "the list just changed".
  const page = Math.min(Math.max(1, mediaState.folderPage), totalPages);
  mediaState.folderPage = page;
  const start = (page - 1) * FOLDERS_PER_PAGE;
  const slice = all.slice(start, start + FOLDERS_PER_PAGE);

  host.innerHTML =
    folderViewCardHtml('all', 'photo_library', 'Tất cả ảnh', mediaState.totals.count, mediaState.folder === null) +
    folderViewCardHtml('none', 'folder_off', 'Chưa phân loại', mediaState.unfiledCount, mediaState.folder === 'none') +
    // Only the FIRST page says "no folders": on page 3 an empty note would be a claim
    // about the whole library, and the two view cards above it would be contradicting
    // it on the same shelf.
    slice.map(folderCardHtml).join('') +
    (all.length ? '' : '<p class="media-folder-empty">Chưa có thư mục nào.</p>');

  renderFolderSummary(all.length, page, totalPages);
  renderFolderPager(page, totalPages);
}

// The line under "Thư mục": how much the shelf is holding, and which page of it is
// drawn. It is the only place the shelf says how many folders exist past the end of
// the rail - the page numbers say there ARE more, but not how many.
function renderFolderSummary(total, page, totalPages) {
  const el = document.getElementById('media-folder-summary');
  if (!el) return;
  el.textContent = !total
    ? 'Chưa có thư mục nào'
    : `${total} thư mục${totalPages > 1 ? ` · trang ${page}/${totalPages}` : ''}`;
}

// The shelf's page numbers. The grid's pager is the same control with a different
// data-attribute, for the reason given at pagerHtml() in api.js: media.js listens for
// clicks on the whole document, so a shared attribute would make one handler answer
// for both.
function renderFolderPager(page, totalPages) {
  const pager = document.getElementById('media-folder-pager');
  if (!pager) return;
  // One page is not a choice. `.hidden` outranks `.media-pager`'s display:flex only
  // because tailwind.css loads after media.css - true on both hosts.
  if (totalPages <= 1) {
    pager.classList.add('hidden');
    pager.innerHTML = '';
    return;
  }
  pager.classList.remove('hidden');
  pager.innerHTML = pagerHtml(page, totalPages, 'data-folder-page');
}

// Turning the shelf's page. No scrollIntoView, unlike setMediaPage(): the shelf sits
// at the top of the tab and stays in view while you click it, so moving the page would
// be the only thing a page number did.
function setFolderPage(n) {
  const totalPages = Math.max(1, Math.ceil(mediaState.folders.length / FOLDERS_PER_PAGE));
  const target = Math.min(Math.max(1, n), totalPages);
  if (target === mediaState.folderPage) return;
  mediaState.folderPage = target;
  renderFolderShelf();
}

// Breadcrumb above the grid. Only rendered inside a folder: at the top level the
// sidebar already says where you are, and an "Tất cả ảnh >" crumb on its own is noise.
function renderFolderBreadcrumb() {
  const el = document.getElementById('media-breadcrumb');
  if (!el) return;
  const path = mediaState.folderPath;
  if (!path.length) {
    el.innerHTML = '';
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  el.innerHTML =
    `<button type="button" class="media-crumb" data-folder="all">Tất cả ảnh</button>` +
    path
      .map(
        (f, i) =>
          `<span class="media-crumb-sep" aria-hidden="true">/</span>` +
          (i === path.length - 1
            ? `<span class="media-crumb is-current">${escapeHtml(f.name)}</span>`
            : `<button type="button" class="media-crumb" data-folder="${f.id}">${escapeHtml(f.name)}</button>`)
      )
      .join('');
}

// A folder's full path as one line ("Ảnh bài viết / 2026 / Tháng 9"), for the move
// dropdown. Two folders can share a name at different depths, so the bare name is not
// enough to tell them apart in a flat <select>.
function folderLabelPath(id) {
  const names = [];
  let current = mediaState.folders.find((f) => Number(f.id) === Number(id));
  let guard = 0;
  while (current && guard++ < 64) {
    names.unshift(current.name);
    current = mediaState.folders.find((f) => Number(f.id) === Number(current.parent_id));
  }
  return names.join(' / ');
}

// Switching folders resets paging and clears the search: a search deliberately spans
// every folder (see routes/media.js), so leaving the query in place would make the
// folder click appear to do nothing.
function openFolder(value) {
  mediaState.folder = value === 'all' ? null : value === 'none' ? 'none' : Number(value);
  // Turning to the page the folder's card is on matters when the click came from the
  // BREADCRUMB rather than the shelf - a crumb can name a folder whose card sits three
  // pages along the rail - and it is a no-op when the click was on a card already in
  // view. Without it the filled card is off the end of the rail and the shelf looks
  // like it has nothing selected.
  if (typeof mediaState.folder === 'number') mediaState.folderPage = folderPageOf(mediaState.folder);
  mediaState.query = '';
  const search = document.getElementById('media-search');
  if (search) search.value = '';
  closeMediaDetail();
  loadMedia();
}

// ---------------------------------------------------------------- folder actions

async function promptCreateFolder(parentId) {
  const name = window.prompt(parentId ? 'Tên thư mục con:' : 'Tên thư mục mới:');
  if (name === null) return;
  try {
    const { folder } = await API.createMediaFolder(name, parentId);
    mediaState.folder = folder.id;
    await loadMedia();
    // loadMedia() drew the shelf from the list as it was before the create landed, so
    // the page the new card is on was not knowable yet. Turn to it now: the folder just
    // created should be the folder on screen, not one somewhere past the last page.
    const created = folderPageOf(folder.id);
    if (created !== mediaState.folderPage) {
      mediaState.folderPage = created;
      renderFolderShelf();
    }
  } catch (e) {
    window.alert(e.message);
  }
}

async function promptRenameFolder(id) {
  const current = mediaState.folders.find((f) => Number(f.id) === Number(id));
  const name = window.prompt('Tên mới:', current ? current.name : '');
  if (name === null) return;
  try {
    await API.updateMediaFolder(id, { name });
    await loadMedia();
  } catch (e) {
    window.alert(e.message);
  }
}

// Says what will happen before it happens: the subtree goes, the images do not.
// Without that sentence "xoá thư mục" reasonably reads as "xoá ảnh trong thư mục".
async function confirmDeleteFolder(id) {
  const folder = mediaState.folders.find((f) => Number(f.id) === Number(id));
  if (!folder) return;
  const kids = mediaState.folders.filter((f) => Number(f.parent_id) === Number(id)).length;
  const message =
    `Xoá thư mục "${folder.name}"?\n\n` +
    (kids ? `· ${kids} thư mục con bên trong cũng bị xoá.\n` : '') +
    `· ${folder.media_count} ảnh trong thư mục này KHÔNG bị xoá - chúng chuyển sang "Chưa phân loại".`;
  if (!window.confirm(message)) return;
  try {
    await API.deleteMediaFolder(id);
    // The open folder may have just been deleted, so fall back to "every image"
    // rather than showing an empty grid for a folder that no longer exists.
    if (String(mediaState.folder) === String(id)) mediaState.folder = null;
    await loadMedia();
  } catch (e) {
    window.alert(e.message);
  }
}

// Moves the image shown in the detail panel. A <select> of every folder rather than
// drag-and-drop: with nesting, a drop target several levels deep is hard to hit and
// impossible on a phone.
async function moveSelectedMedia(value) {
  const m = selectedMedia();
  if (!m) return;
  const target = value === 'none' ? null : Number(value);
  try {
    await API.moveMediaToFolder([m.id], target);
    await loadMedia();
    // Keep the panel open on the same image so its new folder is visible.
    renderMediaDetail();
  } catch (e) {
    window.alert(e.message);
  }
}

// ---------------------------------------------------------------- uploading

// Uploads are sequential, not parallel: an admin dropping twenty photos at once
// would otherwise open twenty simultaneous requests, and with no size limit that is
// a lot of concurrent disk writes. One at a time also makes the progress bar mean
// something - it shows the file being uploaded rather than an average of twenty.
async function uploadMediaFiles(files) {
  const list = [...files].filter((f) => f && f.size >= 0);
  if (!list.length) return;

  const bar = document.getElementById('media-progress');
  const barFill = document.getElementById('media-progress-fill');
  const barLabel = document.getElementById('media-progress-label');
  const errorEl = document.getElementById('media-upload-error');

  const failures = [];
  if (bar) bar.classList.remove('hidden');
  if (errorEl) errorEl.classList.add('hidden');

  for (let i = 0; i < list.length; i++) {
    const file = list[i];
    const position = list.length > 1 ? `(${i + 1}/${list.length}) ` : '';
    try {
      await API.uploadImage(file, {
        // The library endpoint, not the avatar one: this is where an admin's
        // per-file limit is lifted.
        endpoint: '/media',
        // Uploads land in the folder that is open. 'none' and null both mean unfiled.
        fields: typeof mediaState.folder === 'number' ? { folder_id: mediaState.folder } : undefined,
        onProgress: (ratio, loaded, total) => {
          if (barFill) barFill.style.width = `${Math.round(ratio * 100)}%`;
          if (barLabel) {
            barLabel.textContent = `${position}${file.name} — ${formatBytes(loaded)} / ${formatBytes(total)}`;
          }
        },
      });
    } catch (e) {
      failures.push(`${file.name}: ${e.message}`);
    }
  }

  if (bar) bar.classList.add('hidden');
  if (barFill) barFill.style.width = '0%';
  if (failures.length && errorEl) {
    errorEl.innerHTML = failures.map((f) => escapeHtml(f)).join('<br>');
    errorEl.classList.remove('hidden');
  }
  // Reload even when some failed: the ones that succeeded are in the library now.
  await loadMedia();
}

// ---------------------------------------------------------------- detail panel

let selectedMediaId = null;

function selectedMedia() {
  return mediaState.items.find((m) => m.id === selectedMediaId) || null;
}

// Shown in the admin tab when a card is clicked. Not a modal: the grid stays visible
// beside it, so clicking through several images to find the right one does not mean
// opening and closing a dialog each time.
function renderMediaDetail() {
  const panel = document.getElementById('media-detail');
  if (!panel) return;
  const m = selectedMedia();
  // The panel's grid column only exists while the panel does (see .detail-open in
  // media.css): a shut panel must hand its width back to the thumbnails.
  const layout = panel.closest('.media-layout');
  if (layout) layout.classList.toggle('detail-open', !!m);
  if (!m) {
    closeMoveMenu();
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');

  // The preview is 14rem tall, so it gets the thumbnail like the grid; the
  // copy-URL field below is what carries the full original to a post.
  document.getElementById('media-detail-img').src = m.thumb_url || m.url;
  document.getElementById('media-detail-name').textContent = displayName(m);
  document.getElementById('media-detail-facts').textContent =
    `${formatDimensions(m)} · ${formatBytes(m.bytes)} · ${m.mime_type || '—'}`;
  document.getElementById('media-detail-uploader').textContent =
    m.uploader_name || 'Không rõ (file có sẵn trên đĩa)';
  document.getElementById('media-detail-date').textContent = timeAgoVi(m.created_at);

  const urlField = document.getElementById('media-detail-url');
  if (urlField) urlField.value = m.url;

  // Which folder this image is in. The move picker is a floating menu that rebuilds
  // itself from the tree every time it opens (see moveMenu()), because the tree may
  // have changed while the panel sat open - so there is nothing to refresh here.
  const folderLabel = document.getElementById('media-detail-folder');
  if (folderLabel) folderLabel.textContent = m.folder_name || 'Chưa phân loại';

  // An editor may delete only their own uploads; the server enforces it, and hiding
  // the button here means they are not offered an action that would be refused.
  const canDelete = mediaState.canDeleteAny || m.uploader_id === (Auth.getUser() || {}).id;
  const delBtn = document.getElementById('media-delete-btn');
  if (delBtn) {
    delBtn.classList.toggle('hidden', !canDelete);
    delBtn.disabled = false;
    delBtn.textContent = 'Xoá ảnh';
  }
  const usageEl = document.getElementById('media-detail-usage');
  if (usageEl) usageEl.textContent = '';
}

function closeMediaDetail() {
  selectedMediaId = null;
  renderMediaDetail();
}

// ---------------------------------------------------------------- move-to-folder menu

// The <select> this replaced could be styled on its face, but the popup the OS
// drew for it could never carry the site's glass - the same reason the Users
// tab's role picker became a custom listbox. This is that listbox for the
// library: ONE menu for the one trigger, built on first use and parented to
// <body>, because the sticky detail panel is the wrong place to hang a surface
// that has to float over the page. Focus MOVES into the menu, so the focused
// option IS the active one and there is no aria-activedescendant to keep in
// sync - the role menu's model throughout.
let moveMenuEl = null;
let moveMenuOpen = false;

// The destinations, rebuilt from the tree on every open (see renderMoveMenu).
// Each entry knows whether it is where the image already is: that row is marked
// and excluded, since moving a file into its own folder is not a move.
function moveMenuTargets() {
  const m = selectedMedia();
  const targets = [
    { value: 'none', label: 'Chưa phân loại', current: !!m && m.folder_id === null },
  ];
  for (const f of mediaState.folders) {
    targets.push({
      value: String(f.id),
      label: folderLabelPath(f.id),
      current: !!m && Number(f.id) === Number(m.folder_id),
    });
  }
  return targets;
}

function moveMenu() {
  if (moveMenuEl) return moveMenuEl;
  moveMenuEl = document.createElement('div');
  moveMenuEl.id = 'media-move-menu';
  moveMenuEl.className = 'media-move-menu';
  moveMenuEl.setAttribute('role', 'listbox');
  moveMenuEl.setAttribute('aria-label', 'Chọn thư mục để chuyển ảnh vào');
  moveMenuEl.hidden = true;

  moveMenuEl.addEventListener('click', (e) => {
    const opt = e.target.closest('.media-move-option');
    if (!opt || opt.getAttribute('aria-disabled') === 'true') return;
    const value = opt.dataset.moveTarget;
    closeMoveMenu({ focusTrigger: true });
    moveSelectedMedia(value);
  });

  // Arrow keys walk the ENABLED stops only - the folder the image is already in
  // sits in the list marked but unreachable - and the walk wraps, so a
  // destination is always one more press away however the list is shaped.
  moveMenuEl.addEventListener('keydown', (e) => {
    const opts = Array.from(moveMenuEl.querySelectorAll('.media-move-option'));
    const enabled = opts.filter((o) => o.getAttribute('aria-disabled') !== 'true');
    if (!enabled.length) return;
    const here = enabled.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      enabled[(here + step + enabled.length) % enabled.length].focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      (e.key === 'Home' ? enabled[0] : enabled[enabled.length - 1]).focus();
    } else if (e.key === 'Tab') {
      // Closes rather than moving on, for the same reason the options are
      // tabindex="-1": the menu sits at the end of <body>, so the next tab stop
      // from here would be the end of the document.
      e.preventDefault();
      closeMoveMenu({ focusTrigger: true });
    }
  });

  document.body.appendChild(moveMenuEl);
  return moveMenuEl;
}

function renderMoveMenu() {
  const menu = moveMenu();
  menu.innerHTML = moveMenuTargets()
    .map(
      (t) => `
    <button type="button" role="option" tabindex="-1"
      class="media-move-option${t.current ? ' is-current' : ''}"
      data-move-target="${escapeHtml(t.value)}"
      aria-selected="${t.current}"
      ${t.current ? 'aria-disabled="true"' : ''}>
      <span class="material-symbols-outlined media-move-option-icon" aria-hidden="true">${t.value === 'none' ? 'folder_off' : 'folder'}</span>
      <span class="media-move-option-text">${escapeHtml(t.label)}</span>
      <span class="material-symbols-outlined media-move-option-check" aria-hidden="true">check</span>
    </button>`
    )
    .join('');
}

// Placed by hand because the menu is fixed-position in <body>: under the trigger
// by default, flipped above it when the viewport has no room below, and pulled
// back inside the edges on a narrow screen. Measuring needs the menu visible, so
// openMoveMenu() unhides it before calling this.
function placeMoveMenu() {
  if (!moveMenuOpen || !moveMenuEl) return;
  const trigger = document.getElementById('media-move-folder');
  if (!trigger) return;
  const GAP = 6;
  const EDGE = 8;
  const t = trigger.getBoundingClientRect();
  const m = moveMenuEl.getBoundingClientRect();
  let top = t.bottom + GAP;
  if (top + m.height > window.innerHeight - EDGE && t.top - GAP - m.height > EDGE) {
    top = t.top - GAP - m.height;
  }
  const left = Math.max(EDGE, Math.min(t.left, window.innerWidth - m.width - EDGE));
  moveMenuEl.style.top = `${Math.round(top)}px`;
  moveMenuEl.style.left = `${Math.round(left)}px`;
}

function openMoveMenu() {
  if (moveMenuOpen || !selectedMedia()) return;
  renderMoveMenu();
  moveMenuOpen = true;
  moveMenuEl.hidden = false;
  const trigger = document.getElementById('media-move-folder');
  if (trigger) trigger.setAttribute('aria-expanded', 'true');
  placeMoveMenu();
  // Opens on the first reachable destination rather than the top of the list,
  // which may be the marked-but-disabled current folder.
  const first =
    moveMenuEl.querySelector('.media-move-option:not([aria-disabled="true"])') ||
    moveMenuEl.querySelector('.media-move-option');
  if (first) first.focus();
}

function closeMoveMenu({ focusTrigger = false } = {}) {
  if (!moveMenuOpen) return;
  moveMenuOpen = false;
  if (moveMenuEl) moveMenuEl.hidden = true;
  const trigger = document.getElementById('media-move-folder');
  if (trigger) {
    trigger.setAttribute('aria-expanded', 'false');
    // Focus goes back to the trigger rather than being dropped on <body>, so a
    // keyboard user who closes the menu keeps their place in the panel.
    if (focusTrigger && document.contains(trigger)) trigger.focus();
  }
}

// The menu is fixed while the panel underneath it scrolls, so it is re-placed on
// every scroll - and let go of once its trigger has left the screen, rather than
// left floating over unrelated content. Capture phase, because scroll events do
// not bubble; rAF-throttled, so a fast scroll costs one placement per frame.
let moveMenuPlacePending = false;
function repositionMoveMenu() {
  if (!moveMenuOpen || moveMenuPlacePending) return;
  moveMenuPlacePending = true;
  requestAnimationFrame(() => {
    moveMenuPlacePending = false;
    if (!moveMenuOpen) return;
    const trigger = document.getElementById('media-move-folder');
    const r = trigger && trigger.getBoundingClientRect();
    if (!r || r.bottom < 0 || r.top > window.innerHeight) {
      closeMoveMenu();
      return;
    }
    placeMoveMenu();
  });
}

// ---------------------------------------------------------------- deleting

// Two-step by design. The first click asks the server which posts use the file; if
// any do, the person is told the number and has to click again. That is the
// difference between "deleted an unused file" and "silently broke three published
// posts", and the count is something only the server can know.
async function deleteSelectedMedia() {
  const m = selectedMedia();
  if (!m) return;
  const btn = document.getElementById('media-delete-btn');
  const usageEl = document.getElementById('media-detail-usage');

  const armed = btn && btn.dataset.armed === 'true';
  if (!armed) {
    let usage = [];
    try {
      usage = (await API.mediaUsage(m.id)).usage || [];
    } catch {
      // A failed usage lookup must not block the delete - the server checks again
      // and refuses on its own if the file is in use.
    }
    if (usageEl) {
      usageEl.innerHTML = usage.length
        ? `<strong>Ảnh này đang được dùng trong ${usage.length} bài viết:</strong><br>` +
          usage
            .slice(0, 5)
            .map((p) => `· ${escapeHtml(p.title)}${p.status === 'draft' ? ' (bản nháp)' : ''}`)
            .join('<br>') +
          (usage.length > 5 ? `<br>· …và ${usage.length - 5} bài nữa` : '') +
          '<br>Xoá sẽ làm những bài đó mất ảnh. Ảnh được chuyển vào thùng rác và khôi phục được.' +
          ' Bấm "Xác nhận xoá" để tiếp tục.'
        : 'Ảnh này không được dùng trong bài viết nào. Ảnh sẽ được chuyển vào thùng rác và khôi phục được.' +
          ' Bấm "Xác nhận xoá" để tiếp tục.';
    }
    if (btn) {
      btn.dataset.armed = 'true';
      btn.textContent = 'Xác nhận xoá';
    }
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Đang xoá...';
  }
  try {
    // force: the person has now seen the usage count and confirmed.
    await API.deleteMedia(m.id, { force: true });
    if (btn) delete btn.dataset.armed;
    closeMediaDetail();
    await loadMedia();
  } catch (e) {
    if (usageEl) usageEl.innerHTML = `<span class="text-error">${escapeHtml(e.message)}</span>`;
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Xoá ảnh';
      delete btn.dataset.armed;
    }
  }
}

// ---------------------------------------------------------------- picker modal

// Opened from the post editor. Resolves with the chosen image, or null if the person
// closed it - so the caller can `await` it and read like a prompt.
function openMediaPicker() {
  return new Promise((resolve) => {
    const modal = document.getElementById('media-picker');
    if (!modal) return resolve(null);
    mediaState.onPick = resolve;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    document.getElementById('media-search')?.focus();
    loadMedia();
  });
}

// `chosen` is the image, or null when the modal was dismissed. Resolving either way
// is what lets the caller distinguish "picked nothing" from "still open".
function closeMediaPicker(chosen = null) {
  const modal = document.getElementById('media-picker');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
  const resolve = mediaState.onPick;
  mediaState.onPick = null;
  if (resolve) resolve(chosen);
}

// ---------------------------------------------------------------- wiring

// One delegated listener per event, on the document. No inline handlers anywhere in
// the markup this module renders: the security review's item 28 is about removing the
// ones that already exist, and adding more would be working against that.
function initMediaControls() {
  document.addEventListener('click', (e) => {
    const card = e.target.closest('.media-card');
    if (card) {
      const id = Number(card.dataset.mediaId);
      const item = mediaState.items.find((m) => m.id === id);
      if (!item) return;
      // In the picker, a card IS the choice. In the admin tab it opens the detail.
      if (mediaState.onPick) {
        closeMediaPicker(item);
      } else {
        selectedMediaId = id;
        const btn = document.getElementById('media-delete-btn');
        if (btn) delete btn.dataset.armed;
        renderMediaDetail();
      }
      return;
    }

    // ---- Folder navigation and management ----
    // `data-folder` is on the shelf's cards, the breadcrumb's crumbs and the picker's
    // chips, so one branch serves all three. The shelf's page numbers carry
    // `data-folder-page` instead - a different attribute name, so this branch does not
    // catch them, which is exactly why the pager has its own (see pagerHtml in api.js).
    const navBtn = e.target.closest('[data-folder]');
    if (navBtn) return openFolder(navBtn.dataset.folder);

    const newSub = e.target.closest('[data-folder-new]');
    if (newSub) return promptCreateFolder(Number(newSub.dataset.folderNew));
    const rename = e.target.closest('[data-folder-rename]');
    if (rename) return promptRenameFolder(Number(rename.dataset.folderRename));
    const del = e.target.closest('[data-folder-delete]');
    if (del) return confirmDeleteFolder(Number(del.dataset.folderDelete));
    if (e.target.closest('#media-new-folder')) {
      // A new top-level folder, unless a folder is open - then a child of it, which is
      // what "new folder" means while you are standing inside one.
      return promptCreateFolder(typeof mediaState.folder === 'number' ? mediaState.folder : null);
    }

    // ---- View mode and paging ----
    const viewBtn = e.target.closest('[data-media-view]');
    if (viewBtn) return applyMediaView(viewBtn.dataset.mediaView, { reload: true });

    const pageBtn = e.target.closest('[data-media-page]');
    if (pageBtn && !pageBtn.disabled) return setMediaPage(Number(pageBtn.dataset.mediaPage));

    // The shelf's own pager. Handled before nothing in particular - `data-folder-page`
    // shares no attribute name with the folder branches above - but kept next to the
    // grid's so both pagers are read in one place.
    const folderPageBtn = e.target.closest('[data-folder-page]');
    if (folderPageBtn && !folderPageBtn.disabled) return setFolderPage(Number(folderPageBtn.dataset.folderPage));

    // The move-to-folder trigger toggles its floating menu (menu clicks are
    // handled by the menu itself; clicking anywhere else closes it below).
    if (e.target.closest('#media-move-folder')) {
      return moveMenuOpen ? closeMoveMenu({ focusTrigger: true }) : openMoveMenu();
    }

    if (e.target.closest('#media-delete-btn')) return deleteSelectedMedia();
    if (e.target.closest('#media-detail-close')) return closeMediaDetail();
    if (e.target.closest('#media-picker-close')) return closeMediaPicker(null);
    // Clicking the dimmed backdrop, but not the card inside it.
    if (e.target.id === 'media-picker') return closeMediaPicker(null);

    const syncBtn = e.target.closest('#media-sync-btn');
    if (syncBtn) {
      syncBtn.disabled = true;
      API.syncMedia()
        .then(() => loadMedia())
        .catch(() => {})
        .finally(() => {
          syncBtn.disabled = false;
        });
      return;
    }

    const copyBtn = e.target.closest('#media-copy-url');
    if (copyBtn) {
      const field = document.getElementById('media-detail-url');
      if (!field || !navigator.clipboard) return;
      navigator.clipboard.writeText(field.value).then(() => {
        // The text lives in a span so this swap cannot clobber the button's
        // structure; is-copied tints the pill green for as long as the text
        // reads "Đã copy!" (see .media-copy-btn in media.css).
        const label = copyBtn.querySelector('.media-copy-label') || copyBtn;
        const original = label.textContent;
        label.textContent = 'Đã copy!';
        copyBtn.classList.add('is-copied');
        setTimeout(() => {
          label.textContent = original;
          copyBtn.classList.remove('is-copied');
        }, 1500);
      });
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // The move menu claims Escape before the panel does: closing the panel while
    // the menu is up would drop the floating list onto whatever screen comes next.
    if (moveMenuOpen) return closeMoveMenu({ focusTrigger: true });
    if (mediaState.onPick) closeMediaPicker(null);
    else if (selectedMediaId) closeMediaDetail();
  });

  // Search is debounced: every keystroke would otherwise be a request, and the
  // grid would flicker through partial results.
  const search = document.getElementById('media-search');
  if (search) {
    let timer = null;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        mediaState.query = search.value.trim();
        loadMedia();
      }, 250);
    });
  }

  const mine = document.getElementById('media-mine-only');
  if (mine) {
    mine.addEventListener('change', () => {
      mediaState.mineOnly = mine.checked;
      loadMedia();
    });
  }

  // Moving the selected image into a folder. The <select> this used to be is now
  // a trigger button plus a floating glass menu (see the move-to-folder section
  // above): click toggles, a click that is neither on the trigger nor inside the
  // menu closes it, and the menu is re-placed as the page scrolls under it.
  document.addEventListener('click', (e) => {
    if (!moveMenuOpen) return;
    if (e.target.closest('#media-move-folder') || e.target.closest('#media-move-menu')) return;
    closeMoveMenu();
  });
  window.addEventListener('scroll', repositionMoveMenu, true);
  window.addEventListener('resize', repositionMoveMenu);

  const fileInput = document.getElementById('media-file-input');
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      if (fileInput.files.length) uploadMediaFiles(fileInput.files);
      // Cleared so choosing the same file twice in a row still fires a change.
      fileInput.value = '';
    });
  }

  initMediaDropzone();
}

// Drag-and-drop onto the uploader. The document-level handlers are what stop the
// browser NAVIGATING to a file dropped anywhere else on the page - which would lose
// whatever the author had typed.
const MEDIA_DRAG_CLASS = 'is-dragover';

function initMediaDropzone() {
  const zone = document.getElementById('media-dropzone');
  if (!zone) return;

  for (const evt of ['dragenter', 'dragover']) {
    zone.addEventListener(evt, (e) => {
      e.preventDefault();
      zone.classList.add(MEDIA_DRAG_CLASS);
    });
  }
  for (const evt of ['dragleave', 'dragend']) {
    zone.addEventListener(evt, (e) => {
      e.preventDefault();
      zone.classList.remove(MEDIA_DRAG_CLASS);
    });
  }
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove(MEDIA_DRAG_CLASS);
    if (e.dataTransfer && e.dataTransfer.files.length) uploadMediaFiles(e.dataTransfer.files);
  });

  for (const evt of ['dragover', 'drop']) {
    document.addEventListener(evt, (e) => {
      if (!zone.contains(e.target)) e.preventDefault();
    });
  }
}

// The remembered view mode applied up front, so the first fetch already uses its
// page size and the toggle shows the right button lit.
applyMediaView(mediaState.viewMode);

// Wired once per page. Both hosts call it: admin.js when the Thư viện tab is first
// opened, write.js at startup so the picker is ready before it is needed.
initMediaControls();

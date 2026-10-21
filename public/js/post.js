document.getElementById('footer-year').textContent = new Date().getFullYear();

// Reading progress bar - tracks how far through the article you've scrolled.
window.addEventListener('scroll', () => {
  const total = document.documentElement.scrollHeight - document.documentElement.clientHeight;
  const scrolled = document.documentElement.scrollTop || document.body.scrollTop;
  const progress = total > 0 ? Math.min(100, Math.max(0, (scrolled / total) * 100)) : 0;
  document.getElementById('reading-progress').style.width = `${progress}%`;
});

const params = new URLSearchParams(window.location.search);
const slug = params.get('slug');

let currentPost = null;
// Post-level like/dislike totals, kept here so a failed vote can be rolled back
// to the last state the server confirmed.
let postReactions = { likes: 0, dislikes: 0, my_reaction: 0 };

async function loadPost() {
  if (!slug) {
    document.getElementById('loading-msg').textContent = 'Thiếu tham số bài viết.';
    return;
  }
  try {
    const { post, reactions } = await API.getPost(slug);
    currentPost = post;
    renderPost(post);
    // A server that predates this feature sends no "reactions" - the zeroed
    // default then keeps the buttons rendering instead of throwing.
    postReactions = reactions || postReactions;
    renderPostReactions();
    loadComments(post.id);
  } catch (e) {
    document.getElementById('loading-msg').textContent = `Không thể tải bài viết: ${e.message}`;
  }
}

// Rough reading time, matching the "5 min read" line in the design: strip the
// markup out of the rendered blocks, then assume ~200 words per minute.
function estimateReadMinutes(html) {
  const text = html.replace(/<[^>]*>/g, ' ');
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

function formatPostDate(dateStr) {
  const d = new Date(String(dateStr).replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('vi-VN', { day: '2-digit', month: 'long', year: 'numeric' });
}

async function renderPost(post) {
  setSiteTitle(post.title);
  document.getElementById('loading-msg').classList.add('hidden');
  document.getElementById('post-content').classList.remove('hidden');

  const tagEl = document.getElementById('post-tag');
  tagEl.textContent = post.tag;
  tagEl.onclick = () => {
    window.location.href = `/viewall.html?tag=${encodeURIComponent(post.tag)}`;
  };
  document.getElementById('post-title').textContent = post.title;

  // The author's badge is a person glyph in the markup, not a photo, so there is
  // nothing to set here: it does not depend on the post. (It used to be
  // `post-author-avatar.src = post.author?.avatar_url`, and every author without an
  // upload got a 32px broken-image box next to their name.)
  document.getElementById('post-author-name').textContent = post.author?.name || 'Ẩn danh';
  // One-author blog: the byline always leads to "Về tác giả", whoever the
  // account behind the post is (feedback 2026-10-05). The href is already in
  // post.html's markup; set again here so a cached page agrees.
  document.getElementById('post-author-link').href = '/about.html';

  document.getElementById('post-date').textContent = formatPostDate(post.created_at);
  document.getElementById('post-views').textContent = `${post.views} lượt xem`;
  // The short summary, as a standfirst above the cover. Emptied AND hidden, not
  // just emptied: it is a flex item in a gap-lg column, so an empty <p> left in
  // the flow would still push the cover 40px down the page on every post that
  // has no summary.
  const excerptEl = document.getElementById('post-excerpt');
  const excerpt = String(post.excerpt || '').trim();
  // innerHTML, not textContent: the excerpt is sanitized server-side
  // (sanitizeRichHtml, server/routes/posts.js) and may carry the author's
  // own inline formatting (bold/italic/link) from write.html's excerpt
  // field, which textContent would print as literal "<b>" tags.
  excerptEl.innerHTML = excerpt;
  excerptEl.classList.toggle('hidden', !excerpt);

  // The post's own cover, or no cover block at all - there is no default cover.
  const coverImg = document.getElementById('post-cover');
  if (post.cover_image) {
    coverImg.src = derivUrl(post.cover_image, 'w1280');
    coverImg.alt = post.title || '';
  } else {
    coverImg.removeAttribute('src');
  }
  coverImg.parentElement.classList.toggle('hidden', !post.cover_image);

  // content is a JSON array of blocks (paragraph/heading/image); older posts
  // saved as plain text are auto-upgraded to paragraph blocks on the fly.
  const body = document.getElementById('post-body');
  body.innerHTML = rewriteProseImages(renderContentBlocksHtml(parseContentBlocks(post.content)));
  document.getElementById('post-readtime').textContent = `${estimateReadMinutes(body.innerHTML)} phút đọc`;
  buildToc(body);

  const hashtagsEl = document.getElementById('post-hashtags');
  const hashtags = Array.isArray(post.hashtags) ? post.hashtags : [];
  hashtagsEl.innerHTML = hashtags
    .map(
      (t) =>
        `<span class="inline-flex items-center bg-surface-container text-on-surface-variant px-3 py-1.5 rounded-full text-label-md font-label-md cursor-pointer hover:bg-surface-container-high transition-colors" data-goto-tag="${escapeHtml(t)}">#${escapeHtml(t)}</span>`
    )
    .join('');

  const user = Auth.getUser();
  // Quick edit/delete on the post detail page is admin-only. Regular authors
  // (editor role) still manage their own posts from Trang cá nhân → Bài viết
  // của tôi, which has its own edit/delete controls.
  const canEdit = user && user.role === 'admin';
  const ownerActions = document.getElementById('post-owner-actions');
  if (canEdit) {
    ownerActions.classList.remove('hidden');
    ownerActions.classList.add('flex');
    document.getElementById('edit-post-link').href = `/write.html?id=${post.id}`;
    document.getElementById('delete-post-btn').addEventListener('click', async () => {
      if (!confirm('Bạn có chắc muốn xoá bài viết này? Bài viết và các bình luận của nó sẽ được chuyển vào thùng rác.')) return;
      try {
        await API.deletePost(post.id);
        window.location.href = '/index.html';
      } catch (e) {
        alert(e.message);
      }
    });
  }

  if (user) {
    // The comment box shows your own avatar next to it, like the design mock.
    const wrap = document.getElementById('comment-avatar-wrap');
    wrap.classList.remove('hidden');
    document.getElementById('comment-avatar').src = user.avatar_url || '';
  } else {
    document.getElementById('comment-input').classList.add('hidden');
    document.getElementById('comment-submit').classList.add('hidden');
    document.getElementById('comment-login-hint').classList.remove('hidden');
  }

  // The article is on the page now, so its pictures can be made clickable, its
  // code blocks can get a working "Sao chép" button, and the "read next" row
  // can be asked for. The last is not awaited: a suggestion that is slow, or
  // that fails outright, must not hold up the article it sits under.
  prepareArticleImages();
  prepareStrips();
  wireCodeBlocks();
  loadRelated(post);
}

// ---- Table of contents: built from the article's own headings -------------
//
// Every entry is a real h1/h2/h3 already in #post-body - not a fixed list of
// section names like the reference mockup's. Two headings or fewer is nothing
// to navigate between (a one-entry TOC only restates the title), so the whole
// block stays hidden rather than showing something with no real use.
function slugifyHeading(text, seen) {
  let base = String(text)
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip Vietnamese diacritics for a plain-ASCII #anchor
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!base) base = 'section';
  let id = base;
  let n = 2;
  // A post can repeat a heading's exact wording ("Kết luận" twice); the anchor
  // has to be unique even when the text is not.
  while (seen.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  seen.add(id);
  return id;
}

// A link's text is capped well short of anything a real section title would
// ever reach. Belt-and-braces alongside server/sanitize-html.js's own fix for
// the malformed markup this was written to guard against (a heading that had
// swallowed a whole paragraph and table as its textContent, turning one TOC
// entry into an unreadable run-on block of text) - this stays even though
// that specific shape can no longer be saved, because it is cheap and it
// protects the ONE thing this sidebar promises: every entry is a short title
// a reader can scan in one glance.
const TOC_LABEL_MAX = 120;

function buildToc(body) {
  const section = document.getElementById('toc-section');
  const list = document.getElementById('toc-list');
  // Empty or whitespace-only headings are excluded before anything below
  // reads them - not just cosmetic. An empty <h2></h2> is what
  // server/sanitize-html.js's own heading fix leaves behind when it splits a
  // heading that had wrongly swallowed a paragraph/table (see the file's
  // comment on the same bug); without this filter it became a blank,
  // unclickable-looking entry in the list instead of simply not existing.
  const headings = [...body.querySelectorAll('h1, h2, h3')].filter((h) => h.textContent.trim());
  if (headings.length < 3) return; // section stays hidden - see comment above

  const seen = new Set();
  list.innerHTML = headings
    .map((h) => {
      const text = h.textContent.trim();
      const id = slugifyHeading(text, seen);
      h.id = id;
      const level = Number(h.tagName[1]) >= 3 ? 3 : 2;
      const label = text.length > TOC_LABEL_MAX ? `${text.slice(0, TOC_LABEL_MAX).trimEnd()}…` : text;
      return `<a href="#${id}" class="ed-toc-link${level === 3 ? ' ed-toc-link--h3' : ''}" data-toc-target="${id}">${escapeHtml(label)}</a>`;
    })
    .join('');
  section.classList.remove('hidden');
  initTocScrollSpy(headings);
}

// Highlights whichever heading is currently under the reading line, the same
// way the reference mockup's TOC shows "1. Mở đầu" active while scrolled to
// it - except this one tracks the real headings instead of never moving.
function initTocScrollSpy(headings) {
  if (!('IntersectionObserver' in window)) return;
  const setActive = (id) => {
    document.querySelectorAll('.ed-toc-link').forEach((a) => a.classList.toggle('is-active', a.dataset.tocTarget === id));
  };
  // The band a heading is considered "current" in: from just under the fixed
  // nav to a third of the way down the viewport, so the active entry changes
  // as a heading crosses the top of the reading area rather than only once it
  // reaches the very top of the window.
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries.filter((e) => e.isIntersecting);
      if (!visible.length) return;
      const top = visible.reduce((a, b) => (a.boundingClientRect.top < b.boundingClientRect.top ? a : b));
      setActive(top.target.id);
    },
    { rootMargin: '-100px 0px -70% 0px', threshold: 0 }
  );
  headings.forEach((h) => observer.observe(h));
}

// ---- Article pictures: click to open full screen ----
//
// Every picture the article owns - the featured cover, an image block, and an
// image inside a paragraph - opens in an overlay that zooms and pans. The zoom is
// one CSS transform on one <img>: nothing behind the overlay reflows, and there
// is no second copy of the picture to keep in step with the first.
//
// Avatars (the author's, the commenters', the account menu's) are deliberately
// not handles: they are links or decoration already, and an overlay full of
// somebody's 32px face is not what anybody clicked for.

const LB_MIN = 1; // 1 = fitting the screen, which is how every picture opens
const LB_MAX = 6;
const LB_STEP = 1.35; // what one press of -/+ multiplies the scale by
const LB_WHEEL = 1.12; // and one wheel notch, which should feel finer than a press
const LB_SWIPE = 48; // pixels of drag that turn the page instead of snapping back

const lbRoot = document.getElementById('lightbox');
const lbStage = document.getElementById('lightbox-stage');
const lbImg = document.getElementById('lightbox-img');
const lbCounter = document.getElementById('lightbox-counter');
const lbCaption = document.getElementById('lightbox-caption');
const lbPrev = document.getElementById('lightbox-prev');
const lbNext = document.getElementById('lightbox-next');
const lbZoomOut = document.getElementById('lightbox-zoom-out');
const lbZoomIn = document.getElementById('lightbox-zoom-in');
const lbZoomLevel = document.getElementById('lightbox-zoom-level');
const lbClose = document.getElementById('lightbox-close');

const lbState = {
  list: [],
  index: 0,
  scale: 1,
  x: 0,
  y: 0,
  open: false,
  moved: false, // a drag that travelled: its click must not close the overlay
  swipe: 0, // how far a not-yet-zoomed picture has been dragged sideways
  lastFocus: null,
  pointers: new Map(),
  pinch: null,
  drag: null,
};

// The article's pictures, in reading order. Recomputed on every open rather than
// cached, so nothing that arrived late is missing from the list.
function articleImages() {
  const out = [];
  const cover = document.getElementById('post-cover');
  if (cover && cover.getAttribute('src')) out.push(cover);
  for (const img of document.querySelectorAll('#post-body img')) {
    if (!img.getAttribute('src')) continue;
    // A picture the author wrapped in a link stays a link: it should go where the
    // author meant, not into an overlay.
    if (img.closest('a[href]')) continue;
    out.push(img);
  }
  return out;
}

// The author's caption, when the image block had one. It is the only context a
// picture keeps once it is lifted out of the article and onto the scrim.
function captionFor(img) {
  const fig = img.closest('figure');
  const cap = fig && fig.querySelector('figcaption');
  return cap ? cap.textContent.trim() : '';
}

// Reachable without a mouse as well. role="button" replaces the image role, so
// the caption (or the alt text) is folded into the label and a screen reader
// loses nothing by the swap.
function prepareArticleImages() {
  for (const img of articleImages()) {
    const what = captionFor(img) || img.getAttribute('alt') || 'ảnh';
    img.setAttribute('tabindex', '0');
    img.setAttribute('role', 'button');
    img.setAttribute('aria-label', `Phóng to ${what}`);
  }
}

// The "Sao chép" button on a terminal/code block (write.js's "Chèn khối
// lệnh") - built here, at render time, rather than stored: the block itself
// is just a plain .rt-code-lang/.rt-code-body pair (see rtInsertCodeBlock()'s
// own comment for why a stored <button onclick=...> was never on the table),
// so nothing on the reading page can copy anything until this runs.
// Idempotent by construction rather than by a guard: loadPost() calls this
// once per #post-body render, and each render starts from a fresh
// body.innerHTML write, so there is never a second pass over the same button
// to double up.
function wireCodeBlocks() {
  for (const block of document.querySelectorAll('#post-body .rt-code')) {
    const lang = block.querySelector('.rt-code-lang');
    const code = block.querySelector('.rt-code-body');
    if (!lang || !code) continue;
    // A terminal glyph ahead of the author's own label text ("bash", "bash -
    // AWS CLI", ...) - moved into a fresh wrapper together with it, rather
    // than just prepended loose into .rt-code-lang, so the header row still
    // has exactly the two flex children (this wrapper, the copy button
    // appended below) that justify-content: space-between on .rt-code-lang
    // already assumes; a bare icon+text-node+button mix would give it three
    // items to split space between instead of two. material-symbols-OUTLINED,
    // the same face and class every other icon on the site already uses - a
    // line-drawn glyph by construction, so "not filled" needs no extra CSS of
    // its own.
    const labelWrap = document.createElement('span');
    labelWrap.className = 'rt-code-lang-label';
    while (lang.firstChild) labelWrap.appendChild(lang.firstChild);
    const icon = document.createElement('span');
    icon.className = 'material-symbols-outlined';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = 'terminal';
    labelWrap.insertBefore(icon, labelWrap.firstChild);
    lang.appendChild(labelWrap);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rt-code-copy-btn';
    btn.title = 'Sao chép';
    btn.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">content_copy</span><span>Sao chép</span>';
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(code.innerText);
        const original = btn.innerHTML;
        btn.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">check</span><span>Đã chép</span>';
        setTimeout(() => (btn.innerHTML = original), 1500);
      } catch (e) {
        alert('Không thể sao chép tự động. Vui lòng bôi đen và copy thủ công.');
      }
    });
    lang.appendChild(btn);
  }
}

function openLightbox(img) {
  const list = articleImages();
  const index = list.indexOf(img);
  if (index < 0) return; // not one of ours (or it has no src to show)
  lbState.list = list;
  lbState.lastFocus = document.activeElement;
  lbState.open = true;
  lbRoot.classList.remove('hidden');
  // The page behind must not scroll while the reader looks at a picture. The
  // inline style is removed on close, so the classes on <body> are restored.
  document.body.style.overflow = 'hidden';
  showImage(index);
  lbClose.focus(); // a modal that does not take focus is a modal nobody can drive
}

function closeLightbox() {
  if (!lbState.open) return;
  lbState.open = false;
  lbRoot.classList.add('hidden');
  document.body.style.overflow = '';
  lbState.pointers.clear();
  lbState.pinch = null;
  lbState.drag = null;
  lbState.swipe = 0;
  lbStage.classList.remove('is-dragging', 'is-zoomed');
  // Back to where the reader was, which is the picture they opened.
  const back = lbState.lastFocus;
  if (back && document.contains(back)) back.focus();
}

function showImage(index) {
  const total = lbState.list.length;
  if (!total) return;
  // Wraps, so the arrows never dead-end: past the last picture comes the first.
  lbState.index = ((index % total) + total) % total;
  const el = lbState.list[lbState.index];
  lbImg.src = el.currentSrc || el.getAttribute('src');
  lbImg.alt = el.getAttribute('alt') || '';

  const caption = captionFor(el);
  lbCaption.textContent = caption;
  lbCaption.classList.toggle('hidden', !caption);

  // One picture: nothing to count and nothing to walk, so both go away rather
  // than showing "1 / 1" beside two dead arrows.
  const several = total > 1;
  lbCounter.textContent = `${lbState.index + 1} / ${total}`;
  lbCounter.classList.toggle('hidden', !several);
  lbPrev.classList.toggle('hidden', !several);
  lbNext.classList.toggle('hidden', !several);

  resetZoom();
}

function applyTransform() {
  lbImg.style.transform = `translate(${lbState.x}px, ${lbState.y}px) scale(${lbState.scale})`;
  // The read-out doubles as the "back to fitting the screen" button.
  lbZoomLevel.textContent = `${Math.round(lbState.scale * 100)}%`;
  lbStage.classList.toggle('is-zoomed', lbState.scale > 1.01);
  lbZoomOut.disabled = lbState.scale <= LB_MIN;
  lbZoomIn.disabled = lbState.scale >= LB_MAX;
}

function resetZoom() {
  lbState.scale = 1;
  lbState.x = 0;
  lbState.y = 0;
  applyTransform();
}

// Zoom about a point instead of about the middle. (cx, cy) are viewport pixels
// measured from the centre of the stage - the origin the transform hangs off -
// and the pan is corrected so whatever was under the cursor stays under it.
// Without that a wheel zoom always grows out of the middle and the detail the
// reader pointed at slides out from under them.
function setZoom(next, cx = 0, cy = 0) {
  const scale = Math.min(LB_MAX, Math.max(LB_MIN, next));
  if (scale !== lbState.scale) {
    const k = scale / lbState.scale;
    lbState.x = cx - (cx - lbState.x) * k;
    lbState.y = cy - (cy - lbState.y) * k;
    lbState.scale = scale;
  }
  clampPan();
  applyTransform();
}

function zoomBy(factor, cx = 0, cy = 0) {
  setZoom(lbState.scale * factor, cx, cy);
}

// Keep the picture from being dragged off its own edges: past that the stage
// would be showing scrim, with nothing left to grab back.
function clampPan() {
  if (lbState.scale <= 1.001) {
    lbState.x = 0;
    lbState.y = 0;
    return;
  }
  // offsetWidth/offsetHeight are the LAYOUT size, so unlike
  // getBoundingClientRect() they carry neither the transform nor the 0.18s
  // transition animating through it - which is what keeps this stable mid-drag.
  const wide = lbImg.offsetWidth * lbState.scale;
  const high = lbImg.offsetHeight * lbState.scale;
  const maxX = Math.max(0, (wide - lbStage.clientWidth) / 2);
  const maxY = Math.max(0, (high - lbStage.clientHeight) / 2);
  lbState.x = Math.min(maxX, Math.max(-maxX, lbState.x));
  lbState.y = Math.min(maxY, Math.max(-maxY, lbState.y));
}

// A point on screen as an offset from the centre of the stage.
function pointFromCentre(clientX, clientY) {
  const r = lbStage.getBoundingClientRect();
  return { x: clientX - (r.left + r.width / 2), y: clientY - (r.top + r.height / 2) };
}

function pinchPoints() {
  return [...lbState.pointers.values()];
}

function pinchDistance() {
  const [a, b] = pinchPoints();
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
}

function pinchMidpoint() {
  const [a, b] = pinchPoints();
  return a && b ? pointFromCentre((a.x + b.x) / 2, (a.y + b.y) / 2) : { x: 0, y: 0 };
}

// ---- "Dải ảnh cuộn ngang" strips ----
// The arrows scroll the row by most of its visible width, and each arrow goes
// inert at its own end. Re-synced on scroll and resize; the strip itself is
// plain overflow-x with scroll-snap, so touch and trackpad need none of this.
function syncStrip(row) {
  const wrap = row.parentElement;
  const max = row.scrollWidth - row.clientWidth;
  wrap.classList.toggle('is-scrollable', max > 2);
  const prev = wrap.querySelector('.ilay-strip-btn--prev');
  const next = wrap.querySelector('.ilay-strip-btn--next');
  if (prev) prev.disabled = row.scrollLeft <= 2;
  if (next) next.disabled = row.scrollLeft >= max - 2;
}
function prepareStrips() {
  for (const row of document.querySelectorAll('#post-body .ilay-strip > .ilay-grid')) {
    if (row.dataset.stripReady) continue;
    row.dataset.stripReady = '1';
    row.addEventListener('scroll', () => syncStrip(row), { passive: true });
    // Pictures arriving late change scrollWidth: re-check as each one lands.
    for (const img of row.querySelectorAll('img')) img.addEventListener('load', () => syncStrip(row), { once: true });
    syncStrip(row);
  }
}
window.addEventListener('resize', () => {
  for (const row of document.querySelectorAll('#post-body .ilay-strip > .ilay-grid')) syncStrip(row);
});
document.addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('.ilay-strip-btn');
  if (!btn) return;
  const row = btn.parentElement.querySelector('.ilay-grid');
  row.scrollBy({ left: Number(btn.dataset.stripDir) * row.clientWidth * 0.8, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
});

// ---- lightbox wiring ----

// One delegated click, on the document: the body is re-rendered per article and
// the cover lives outside it, so there is no single container to hang this on.
document.addEventListener('click', (e) => {
  const img = e.target.closest && e.target.closest('img');
  if (!img || img.closest('a[href]')) return;
  if (img.id !== 'post-cover' && !img.closest('#post-body')) return;
  openLightbox(img);
});

document.addEventListener('keydown', (e) => {
  if (lbState.open) {
    lbKeydown(e);
    return;
  }
  // Enter/Space on a focused picture - which is what role="button" promises.
  if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
    const img = e.target.closest && e.target.closest('img');
    if (img && img.getAttribute('role') === 'button') {
      e.preventDefault();
      openLightbox(img);
    }
  }
});

function lbKeydown(e) {
  switch (e.key) {
    case 'Escape':
      closeLightbox();
      break;
    case 'ArrowLeft':
      showImage(lbState.index - 1);
      break;
    case 'ArrowRight':
      showImage(lbState.index + 1);
      break;
    case '+':
    case '=':
      zoomBy(LB_STEP);
      break;
    case '-':
    case '_':
      zoomBy(1 / LB_STEP);
      break;
    case '0':
      resetZoom();
      break;
    case 'Tab':
      lbTrapFocus(e); // does its own preventDefault, only when it moves focus
      return;
    default:
      return; // any other key belongs to the page behind
  }
  e.preventDefault();
}

// A modal that lets Tab escape into the article behind it is a modal a keyboard
// reader can get lost in, so focus cycles inside the overlay's own live buttons.
function lbTrapFocus(e) {
  const items = [...lbRoot.querySelectorAll('button')].filter(
    (b) => !b.disabled && !b.classList.contains('hidden')
  );
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (!lbRoot.contains(active)) first.focus();
  else if (e.shiftKey && active === first) last.focus();
  else if (!e.shiftKey && active === last) first.focus();
  else return;
  e.preventDefault();
}

lbClose.addEventListener('click', closeLightbox);
lbPrev.addEventListener('click', () => showImage(lbState.index - 1));
lbNext.addEventListener('click', () => showImage(lbState.index + 1));
lbZoomIn.addEventListener('click', () => zoomBy(LB_STEP));
lbZoomOut.addEventListener('click', () => zoomBy(1 / LB_STEP));
lbZoomLevel.addEventListener('click', resetZoom);

// Empty stage space closes it. A click ON the picture does not - that is the
// picture's own business - and neither does the click a drag ends with.
lbStage.addEventListener('click', (e) => {
  if (e.target !== lbStage || lbState.moved) return;
  closeLightbox();
});

lbStage.addEventListener(
  'wheel',
  (e) => {
    if (!lbState.open) return;
    e.preventDefault(); // the page behind must not scroll while the picture does
    const p = pointFromCentre(e.clientX, e.clientY);
    zoomBy(e.deltaY < 0 ? LB_WHEEL : 1 / LB_WHEEL, p.x, p.y);
  },
  { passive: false }
);

// One finger pans, two pinch. Pointer events rather than mouse+touch listeners so
// a pen and a phone go through the same code.
lbStage.addEventListener('pointerdown', (e) => {
  if (!lbState.open) return;
  lbState.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (lbState.pointers.size === 1) {
    lbState.moved = false;
    lbState.swipe = 0;
    lbState.drag = { x: e.clientX, y: e.clientY, ox: lbState.x, oy: lbState.y };
    lbStage.classList.add('is-dragging');
    // Capture, so a fast drag that leaves the stage keeps reporting.
    if (lbStage.setPointerCapture) lbStage.setPointerCapture(e.pointerId);
  } else if (lbState.pointers.size === 2) {
    // A second finger means pinch: drop the pan and measure the spread instead.
    lbState.drag = null;
    const mid = pinchMidpoint();
    lbState.pinch = { dist: pinchDistance(), scale: lbState.scale, cx: mid.x, cy: mid.y };
  }
});

lbStage.addEventListener('pointermove', (e) => {
  if (!lbState.open || !lbState.pointers.has(e.pointerId)) return;
  lbState.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (lbState.pinch && lbState.pointers.size >= 2) {
    const dist = pinchDistance();
    if (dist > 0 && lbState.pinch.dist > 0) {
      setZoom(lbState.pinch.scale * (dist / lbState.pinch.dist), lbState.pinch.cx, lbState.pinch.cy);
    }
    return;
  }
  if (!lbState.drag) return;

  const dx = e.clientX - lbState.drag.x;
  const dy = e.clientY - lbState.drag.y;
  // A click that travels two pixels is still a click, not a pan.
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) lbState.moved = true;

  // Fitting the screen leaves nothing to pan, so the drag turns into a page turn
  // instead: the picture follows the finger and, on release, either turns or
  // snaps back. clampPan() would pin this to zero - it exists to stop a ZOOMED
  // picture being dragged off its own edges - which is why this branch goes
  // straight to the transform.
  if (lbState.scale <= 1.001) {
    lbState.swipe = dx;
    lbState.x = dx;
    lbState.y = 0;
    applyTransform();
    return;
  }

  lbState.x = lbState.drag.ox + dx;
  lbState.y = lbState.drag.oy + dy;
  clampPan();
  applyTransform();
});

function endPointer(e) {
  lbState.pointers.delete(e.pointerId);
  if (lbState.pointers.size < 2) lbState.pinch = null;
  if (lbState.pointers.size === 0) {
    lbState.drag = null;
    lbStage.classList.remove('is-dragging');
    // Settle the swipe: far enough and the page turns (showImage recentres the
    // picture), not far enough and it goes back to where it was.
    const swipe = lbState.swipe;
    lbState.swipe = 0;
    if (Math.abs(swipe) > LB_SWIPE) showImage(lbState.index + (swipe < 0 ? 1 : -1));
    else if (swipe) resetZoom();
  }
}
lbStage.addEventListener('pointerup', endPointer);
lbStage.addEventListener('pointercancel', endPointer);

// Double-click (and double-tap) flips between fitting the screen and a useful
// level of detail, centred on where the reader pointed.
lbStage.addEventListener('dblclick', (e) => {
  if (!lbState.open) return;
  if (lbState.scale > 1.01) {
    resetZoom();
    return;
  }
  const p = pointFromCentre(e.clientX, e.clientY);
  setZoom(2.2, p.x, p.y);
});

// ---- Read next ----
//
// The sidebar beside the article: the posts carrying the same "Thẻ (tag)" as
// this one, and - when not enough of them share it to fill the list - the
// newest posts to top it up. Both come from the list endpoint "Tất cả bài
// viết" uses, so ?tag= means the same thing here as it does there: the tag
// column OR a matching hashtag. Six, because the list reads down a narrow
// column now and three never filled it.
const RELATED_WANT = 6;

function relatedCard(p) {
  const facts = [formatPostDate(p.created_at), `${Number(p.views) || 0} lượt xem`]
    .filter(Boolean)
    .join(' · ');
  // <span> rather than <div> inside the <a>: a link is allowed to contain flow
  // content, but a span styled as a flex column cannot be mistaken for one, and
  // nothing inside it can be read as a second interactive thing.
  return `<a class="related-card glass-card" href="/post.html?slug=${encodeURIComponent(p.slug)}">
    ${p.cover_image ? `<span class="related-thumb"><img src="${escapeHtml(derivUrl(p.cover_image, 'thumb'))}" alt="" loading="lazy" decoding="async"></span>` : ''}
    <span class="related-body">
      ${p.tag ? `<span class="related-tag">${escapeHtml(p.tag)}</span>` : ''}
      <span class="related-title">${escapeHtml(p.title)}</span>
      <span class="related-facts">${escapeHtml(facts)}</span>
    </span>
  </a>`;
}

function relatedHeading(picks) {
  const same = picks.filter((p) => p.same).length;
  if (same === picks.length) return 'Bài viết cùng chủ đề';
  return same ? 'Bài viết liên quan' : 'Đọc tiếp';
}

async function loadRelated(post) {
  const section = document.getElementById('related-section');
  const grid = document.getElementById('related-grid');
  try {
    // +1 and +2 because the article being read is itself in both answers.
    const [sameTopic, newest] = await Promise.all([
      post.tag
        ? API.listPosts({ tag: post.tag, limit: RELATED_WANT + 1 })
        : Promise.resolve({ posts: [] }),
      API.listPosts({ limit: RELATED_WANT + 2 }),
    ]);

    const picks = [];
    const seen = new Set([post.id]); // never suggest the article being read
    const take = (rows, same) => {
      for (const p of rows || []) {
        if (picks.length >= RELATED_WANT) return;
        if (!p || seen.has(p.id)) continue;
        seen.add(p.id);
        picks.push({ post: p, same });
      }
    };
    take(sameTopic.posts, true);
    take(newest.posts, false);

    // The only published post there is. An empty row of nothing is worse than no
    // row at all, so the section stays hidden.
    if (!picks.length) {
      grid.innerHTML = '';
      section.classList.add('hidden');
      return;
    }
    grid.innerHTML = picks.map((pick) => relatedCard(pick.post)).join('');
    document.getElementById('related-title').textContent = relatedHeading(picks);
    section.classList.remove('hidden');
  } catch (e) {
    // Suggestions are the convenience; the article above them is the point.
    section.classList.add('hidden');
  }
}

// ---- Like / dislike ----
//
// One helper paints any pair of buttons, so the post-level pair in the share bar
// and the small pair on every comment cannot drift apart. aria-pressed carries
// the active state: the CSS keys off it, so what a screen reader announces and
// what a sighted reader sees can never disagree.
function paintReactionPair({ likeBtn, dislikeBtn, likeCountEl, dislikeCountEl, data, canVote }) {
  if (!likeBtn || !dislikeBtn) return;
  likeCountEl.textContent = data.likes ?? 0;
  dislikeCountEl.textContent = data.dislikes ?? 0;
  likeBtn.setAttribute('aria-pressed', String(data.my_reaction === 1));
  dislikeBtn.setAttribute('aria-pressed', String(data.my_reaction === -1));
  // A guest sees the real totals and the buttons stay clickable - pressing one
  // opens the login modal. Disabling them instead would swallow the click, so
  // the reader would get a dead control with no explanation.
  for (const btn of [likeBtn, dislikeBtn]) {
    btn.disabled = false;
    btn.title = canVote ? (btn === likeBtn ? 'Thích' : 'Không thích') : 'Đăng nhập để bình chọn';
  }
}

function renderPostReactions() {
  paintReactionPair({
    likeBtn: document.getElementById('post-like-btn'),
    dislikeBtn: document.getElementById('post-dislike-btn'),
    likeCountEl: document.getElementById('post-like-count'),
    dislikeCountEl: document.getElementById('post-dislike-count'),
    data: postReactions,
    canVote: Auth.isLoggedIn(),
  });
}

// Sends the value the pressed button stands for; the server toggles it off when
// it is already the caller's vote, so one endpoint covers like, un-like and
// switching sides. The buttons are locked for the round trip so a double click
// cannot race two writes, and the previous totals are restored on failure.
async function voteOnPost(value) {
  if (!currentPost) return;
  if (!Auth.isLoggedIn()) return openAuthModal();
  const buttons = [document.getElementById('post-like-btn'), document.getElementById('post-dislike-btn')];
  buttons.forEach((b) => (b.disabled = true));
  try {
    const { reactions } = await API.reactToPost(currentPost.id, value);
    postReactions = reactions;
  } catch (e) {
    alert(actionError(e));
  } finally {
    renderPostReactions();
  }
}

// A 404 here means the running Node process is older than these static files -
// requiring a route file only reads it at startup - so the generic "endpoint not
// found" would send the reader looking in the wrong place.
function actionError(e) {
  if (e.status === 404) {
    return 'Máy chủ đang chạy phiên bản cũ chưa có chức năng này. Hãy khởi động lại máy chủ (npm start) rồi tải lại trang.';
  }
  return e.message;
}

document.getElementById('post-like-btn')?.addEventListener('click', () => voteOnPost(1));
document.getElementById('post-dislike-btn')?.addEventListener('click', () => voteOnPost(-1));

async function loadComments(postId) {
  const list = document.getElementById('comments-list');
  try {
    const { comments, report_reasons } = await API.listComments(postId);
    // The server owns the report-reason list and sends it with the thread, so the
    // form and the route's whitelist are one thing. Kept as a fallback for a
    // server OLDER than these static files - the same way the reaction columns
    // are defaulted further down.
    if (Array.isArray(report_reasons) && report_reasons.length) REPORT_REASONS = report_reasons;
    // Counts whatever the server returned, which for a reader already excludes
    // hidden comments. For an author it includes their own hidden one - intended:
    // they can see it, behind a notice.
    document.getElementById('comment-count').textContent = comments.length;

    // Build a reply tree from the flat list (parent_comment_id may be null)
    const byId = new Map(comments.map((c) => [c.id, { ...c, replies: [] }]));
    const roots = [];
    byId.forEach((c) => {
      if (c.parent_comment_id && byId.has(c.parent_comment_id)) {
        byId.get(c.parent_comment_id).replies.push(c);
      } else {
        roots.push(c);
      }
    });

    list.innerHTML = roots.map((c) => renderCommentHtml(c)).join('');
  } catch (e) {
    list.innerHTML = `<p class="text-error">Không thể tải bình luận.</p>`;
  }
}

// The report reasons, as the server sent them with the thread (see loadComments).
// Starts empty so a page served by an older backend renders no form at all rather
// than a form whose every submission the server refuses.
let REPORT_REASONS = [];

// A root comment sits in its own glass card; every reply below it is indented
// once inside that same card behind a left rule (the nesting treatment from
// the design mock). Replies-to-replies are flattened onto that single indent
// level so deep threads stay readable - and, unlike a one-level render, never
// silently disappear.
function flattenReplies(c, out = []) {
  for (const r of c.replies || []) {
    out.push(r);
    flattenReplies(r, out);
  }
  return out;
}

function renderCommentHtml(c) {
  const repliesHtml = flattenReplies(c)
    .map(
      (r) =>
        `<div class="mt-6 pl-6 md:pl-10 border-l-2 border-outline-variant/30">${renderCommentBodyHtml(r, true)}</div>`
    )
    .join('');
  return `<div class="ed-comment-item p-sm sm:p-md" data-comment-id="${c.id}">${renderCommentBodyHtml(c, false)}${repliesHtml}</div>`;
}

// The like/dislike pair for one comment. Rendered as markup (rather than built
// as elements) because the whole comment tree is one innerHTML assignment; the
// active state is carried by aria-pressed exactly as on the post-level pair, so
// both are styled by the same CSS.
function commentReactionsHtml(c, isLoggedIn) {
  const pill = (value, icon, count, active) => {
    const cls = ['reaction-btn', 'reaction-btn--sm', 'tap-target', 'comment-reaction-btn'];
    if (value === -1) cls.push('reaction-btn--down');
    const label = value === 1 ? 'Thích' : 'Không thích';
    return `<button class="${cls.join(' ')}" data-comment-id="${c.id}" data-value="${value}"
      aria-pressed="${active}" title="${isLoggedIn ? label : 'Đăng nhập để bình chọn'}">
      <span class="material-symbols-outlined">${icon}</span><span class="reaction-count">${count}</span>
    </button>`;
  };
  return (
    pill(1, 'thumb_up', c.likes ?? 0, c.my_reaction === 1) +
    pill(-1, 'thumb_down', c.dislikes ?? 0, c.my_reaction === -1)
  );
}

function renderCommentBodyHtml(c, isReply) {
  const isLoggedIn = Auth.isLoggedIn();
  const isAdmin = Auth.isAdmin();
  const me = Auth.getUser();
  const isMine = Boolean(me && me.id === c.user_id);
  const isHidden = Boolean(c.hidden_at);
  // A hidden row reaches exactly two viewers - its own author, and an admin -
  // because the list route filters it out for everybody else. The third case is
  // defence in depth for a stale payload or a route that regressed: a reader who
  // is NOT the author gets the notice and nothing else, since rendering the words
  // would undo the hide on the client.
  const hiddenFromStranger = isHidden && !isAdmin && !isMine;
  const hiddenNote = isAdmin
    ? 'Đã ẩn — độc giả không thấy bình luận này.'
    : isMine
      ? 'Bình luận của bạn đã bị ẩn bởi quản trị viên.'
      : 'Bình luận này đã bị ẩn bởi quản trị viên.';
  const avatarSize = isReply ? 'w-8 h-8' : 'w-10 h-10';
  return `
  <div class="flex gap-3 sm:gap-4" data-comment-id="${c.id}">
    <a href="/profile.html?user=${c.user_id}" class="${avatarSize} rounded-full overflow-hidden flex-shrink-0 border border-glass-border">
      <img class="w-full h-full object-cover hover:opacity-80 transition-opacity" alt="" src="${escapeHtml(c.user_avatar)}" loading="lazy" decoding="async">
    </a>
    <div class="flex-grow min-w-0">
      <div class="flex items-center gap-2 mb-1">
        <a href="/profile.html?user=${c.user_id}" class="font-bold text-on-surface hover:text-primary transition-colors break-words">${escapeHtml(c.user_name)}</a>
        <span class="text-body-sm font-body-sm text-on-surface-variant opacity-60">• ${timeAgoVi(c.created_at)}</span>
        ${
          isAdmin && c.report_count > 0
            ? `<span class="comment-report-count text-body-sm font-body-sm" title="${c.report_count} báo cáo">${c.report_count} báo cáo</span>`
            : ''
        }
      </div>
      ${
        isHidden
          ? `<p class="comment-hidden-note flex items-start gap-2 mb-3" role="status">
               <span class="material-symbols-outlined text-[18px]">visibility_off</span>
               <span>${hiddenNote}</span>
             </p>`
          : ''
      }
      ${
        hiddenFromStranger
          ? ''
          : `<p class="text-body-md font-body-md text-on-surface-variant mb-4 whitespace-pre-wrap break-words${
              isHidden && !isAdmin ? ' opacity-60' : ''
            }">${escapeHtml(c.content)}</p>`
      }
      ${
        // A hidden comment's author gets NO action row at all: react, reply and
        // report on something the public cannot see are buttons that lie.
        isHidden && !isAdmin
          ? ''
          : `<div class="flex items-center gap-2 sm:gap-3 flex-wrap">
        ${commentReactionsHtml(c, isLoggedIn)}
        ${
          isLoggedIn && !isHidden
            ? `<button class="reply-toggle-btn tap-target px-1 text-label-md font-label-md uppercase tracking-wider text-electric-indigo hover:underline" data-comment-id="${c.id}">Trả lời</button>`
            : ''
        }
        ${
          // Report: signed-in, not your own comment, not one that is already
          // hidden (the server refuses both), and not an admin - an admin has Ẩn
          // and Xoá on this very row, and reporting a comment to yourself would
          // only file a row in your own inbox. `flag` is a literal in this template
          // string, so scripts/icon-names.py scrapes it from public/js/*.js; it is
          // ALSO in that file's DYNAMIC list because admin.js reaches the same
          // glyph through a variable.
          isLoggedIn && !isAdmin && !isMine && !isHidden && REPORT_REASONS.length
            ? `<button class="comment-report-btn tap-target px-1" data-comment-id="${c.id}" title="Báo cáo bình luận này"${
                c.my_report_reason ? ' data-reported="1"' : ''
              }><span class="material-symbols-outlined">flag</span>${
                c.my_report_reason ? 'Đã báo cáo' : 'Báo cáo'
              }</button>`
            : ''
        }
        ${
          isAdmin
            ? `<button class="comment-hide-btn tap-target px-1" data-comment-id="${c.id}" data-hidden="${isHidden}" title="${
                isHidden ? 'Hiện lại bình luận này' : 'Ẩn bình luận này khỏi độc giả'
              }"><span class="material-symbols-outlined">${isHidden ? 'visibility' : 'visibility_off'}</span>${
                isHidden ? 'Bỏ ẩn' : 'Ẩn'
              }</button>
              <button class="comment-delete-btn tap-target px-1" data-comment-id="${c.id}" title="Xoá bình luận này"><span class="material-symbols-outlined">delete</span>Xoá</button>`
            : ''
        }
      </div>`
      }
      ${
        // The form is rendered for exactly the viewers the button is rendered for,
        // so a button can never open a form that is not there.
        isLoggedIn && !isAdmin && !isMine && !isHidden && REPORT_REASONS.length
          ? `<div class="report-form hidden mt-3 flex flex-col gap-2" data-comment-id="${c.id}">
               <fieldset class="flex flex-col gap-1.5">
                 <legend class="font-label-md text-label-md text-on-surface-variant uppercase mb-1">Lý do báo cáo</legend>
                 ${(() => {
                   // ONE pre-checked reason: the one already on file if it is still
                   // on the list, otherwise the first. Marking both the first and
                   // the recorded one leaves two radios checked in one group.
                   const preselect = REPORT_REASONS.includes(c.my_report_reason)
                     ? c.my_report_reason
                     : REPORT_REASONS[0];
                   return REPORT_REASONS.map(
                     (r) =>
                       `<label class="report-reason flex items-center gap-2 cursor-pointer font-body-sm text-body-sm text-on-surface-variant">
                        <input type="radio" name="report-reason-${c.id}" value="${escapeHtml(r)}"${
                          r === preselect ? ' checked' : ''
                        } class="w-4 h-4 shrink-0 border-outline-variant text-electric-indigo focus:ring-electric-indigo">
                        <span>${escapeHtml(r)}</span>
                      </label>`
                   ).join('');
                 })()}
               </fieldset>
               <textarea class="report-note w-full p-3 bg-surface-container/50 border border-glass-border rounded-xl text-body-md font-body-md focus:outline-none focus:border-electric-indigo focus:ring-1 focus:ring-electric-indigo transition-all" rows="2" maxlength="1000" placeholder="Mô tả thêm (không bắt buộc)..."></textarea>
               <div class="flex gap-2">
                 <button class="report-submit-btn tap-target bg-electric-indigo text-on-primary px-5 py-1.5 rounded-full font-label-md text-label-md uppercase tracking-wider hover:opacity-90 transition-opacity active:scale-95" data-comment-id="${c.id}">Gửi báo cáo</button>
                 <button class="report-cancel-btn tap-target px-5 py-1.5 border border-glass-border rounded-full font-label-md text-label-md uppercase tracking-wider text-on-surface-variant hover:text-primary transition-colors" data-comment-id="${c.id}">Huỷ</button>
               </div>
             </div>`
          : ''
      }
      ${
        isLoggedIn && !isHidden
          ? `<div class="reply-form hidden mt-3 flex flex-col gap-2" data-comment-id="${c.id}">
               <textarea class="reply-input w-full p-3 bg-surface-container/50 border border-glass-border rounded-xl text-body-md font-body-md focus:outline-none focus:border-electric-indigo focus:ring-1 focus:ring-electric-indigo transition-all" rows="2" placeholder="Viết trả lời..."></textarea>
               <div class="flex gap-2">
                 <button class="reply-submit-btn tap-target bg-electric-indigo text-on-primary px-5 py-1.5 rounded-full font-label-md text-label-md uppercase tracking-wider hover:opacity-90 transition-opacity active:scale-95" data-comment-id="${c.id}">Gửi</button>
                 <button class="reply-cancel-btn tap-target px-5 py-1.5 border border-glass-border rounded-full font-label-md text-label-md uppercase tracking-wider text-on-surface-variant hover:text-primary transition-colors" data-comment-id="${c.id}">Huỷ</button>
               </div>
             </div>`
          : ''
      }
    </div>
  </div>`;
}

document.getElementById('comments-list').addEventListener('click', async (e) => {
  const toggleBtn = e.target.closest('.reply-toggle-btn');
  const cancelBtn = e.target.closest('.reply-cancel-btn');
  const submitBtn = e.target.closest('.reply-submit-btn');
  const reactionBtn = e.target.closest('.comment-reaction-btn');
  const deleteBtn = e.target.closest('.comment-delete-btn');
  const reportBtn = e.target.closest('.comment-report-btn');
  const reportSubmit = e.target.closest('.report-submit-btn');
  const reportCancel = e.target.closest('.report-cancel-btn');
  const hideBtn = e.target.closest('.comment-hide-btn');

  if (reactionBtn) {
    voteOnComment(reactionBtn);
  } else if (deleteBtn) {
    deleteCommentAsAdmin(Number(deleteBtn.dataset.commentId));
  } else if (hideBtn) {
    toggleHideCommentAsAdmin(Number(hideBtn.dataset.commentId), hideBtn.dataset.hidden !== 'true');
  } else if (reportBtn) {
    const form = document.querySelector(`.report-form[data-comment-id="${reportBtn.dataset.commentId}"]`);
    if (form) {
      form.classList.toggle('hidden');
      if (!form.classList.contains('hidden')) form.querySelector('.report-note').focus();
    }
  } else if (reportCancel) {
    const form = document.querySelector(`.report-form[data-comment-id="${reportCancel.dataset.commentId}"]`);
    if (form) {
      form.classList.add('hidden');
      form.querySelector('.report-note').value = '';
    }
  } else if (reportSubmit) {
    submitCommentReport(reportSubmit.dataset.commentId);
  } else if (toggleBtn) {
    const form = document.querySelector(`.reply-form[data-comment-id="${toggleBtn.dataset.commentId}"]`);
    form.classList.toggle('hidden');
    if (!form.classList.contains('hidden')) form.querySelector('.reply-input').focus();
  } else if (cancelBtn) {
    const form = document.querySelector(`.reply-form[data-comment-id="${cancelBtn.dataset.commentId}"]`);
    form.classList.add('hidden');
    form.querySelector('.reply-input').value = '';
  } else if (submitBtn) {
    const commentId = submitBtn.dataset.commentId;
    const form = document.querySelector(`.reply-form[data-comment-id="${commentId}"]`);
    const text = form.querySelector('.reply-input').value.trim();
    if (!text) return;
    try {
      await API.addComment(currentPost.id, text, Number(commentId));
      loadComments(currentPost.id);
    } catch (err) {
      alert(err.message);
    }
  }
});

// A comment vote repaints only that comment's two pills. Reloading the whole
// tree would work too, but it would also collapse any reply box the reader had
// open and scroll the thread back to the top.
async function voteOnComment(btn) {
  if (!Auth.isLoggedIn()) return openAuthModal();
  const commentId = Number(btn.dataset.commentId);
  const pills = [...document.querySelectorAll(`.comment-reaction-btn[data-comment-id="${commentId}"]`)];
  pills.forEach((p) => (p.disabled = true));
  try {
    const { comment } = await API.reactToComment(commentId, Number(btn.dataset.value));
    paintCommentReactions(comment);
  } catch (e) {
    alert(actionError(e));
  } finally {
    pills.forEach((p) => (p.disabled = false));
  }
}

function paintCommentReactions(comment) {
  const likeBtn = document.querySelector(
    `.comment-reaction-btn[data-comment-id="${comment.id}"][data-value="1"]`
  );
  const dislikeBtn = document.querySelector(
    `.comment-reaction-btn[data-comment-id="${comment.id}"][data-value="-1"]`
  );
  if (!likeBtn || !dislikeBtn) return;
  paintReactionPair({
    likeBtn,
    dislikeBtn,
    likeCountEl: likeBtn.querySelector('.reaction-count'),
    dislikeCountEl: dislikeBtn.querySelector('.reaction-count'),
    data: comment,
    canVote: Auth.isLoggedIn(),
  });
}

// Moderation: admin-only, and the button is only rendered for an admin. The
// replies go into the bin with it (the server trashes the whole subtree under one
// timestamp), so the confirm has to say so - and has to say where they went, since
// a delete here is no longer the end of them.
async function deleteCommentAsAdmin(commentId) {
  if (
    !confirm(
      'Xoá bình luận này? Bình luận và mọi trả lời bên dưới nó sẽ chuyển vào Thùng rác của bảng quản trị; có thể khôi phục hoặc xoá vĩnh viễn ở đó.'
    )
  ) {
    return;
  }
  try {
    await API.deleteComment(commentId);
    loadComments(currentPost.id);
  } catch (e) {
    alert(actionError(e));
  }
}

// Sends the checked reason plus the trimmed note. Reloading the whole tree rather
// than patching the button: the row changes label ("Đã báo cáo"), the radios change
// state, and if an admin hid the comment in the meantime the row has to disappear
// for everyone but its author - a server decision, not this page's.
// ---- Toast ----
// The page's one transient answer, in the site's own glass (see .toast-stack in
// common.css). A native alert() was what a report used to get: the browser's
// grey box, the single element on the page no theme token reaches. The message
// goes in through textContent, never into the HTML string - everything a toast
// says is data this page just received.
let toastStack = null;
function showToast(message, kind = 'ok', icon = 'check_circle') {
  if (typeof document === 'undefined' || !document.body) return null;
  if (!toastStack || !document.body.contains(toastStack)) {
    toastStack = document.createElement('div');
    toastStack.className = 'toast-stack';
    toastStack.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastStack);
  }
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  el.setAttribute('role', 'status');
  el.title = 'Bấm để đóng';
  el.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true"></span><span></span>';
  el.firstElementChild.textContent = icon;
  el.lastElementChild.textContent = message;
  toastStack.appendChild(el);
  const dismiss = () => {
    el.classList.add('toast--out');
    // A timeout rather than animationend: under prefers-reduced-motion the
    // animation is none, so animationend would never fire and the card would
    // stay forever.
    setTimeout(() => el.remove(), 300);
  };
  el.addEventListener('click', dismiss);
  setTimeout(dismiss, 4500);
  return el;
}

async function submitCommentReport(commentId) {
  const form = document.querySelector(`.report-form[data-comment-id="${commentId}"]`);
  if (!form) return;
  const reason = form.querySelector('input[type="radio"]:checked')?.value;
  if (!reason) return alert('Vui lòng chọn một lý do báo cáo.');
  const note = form.querySelector('.report-note').value.trim();
  const submit = form.querySelector('.report-submit-btn');
  submit.disabled = true;
  try {
    const { reported } = await API.reportComment(Number(commentId), reason, note);
    await loadComments(currentPost.id);
    // Three outcomes, three bars: a thank you, a withdrawal, a refusal. The
    // tree has already been re-read, so the button under the toast already
    // says ĐÃ BÁO CÁO or BÁO CÁO by the time the reader looks down.
    if (reported) showToast('Cảm ơn bạn đã báo cáo. Quản trị viên sẽ xem xét bình luận này.', 'ok', 'check_circle');
    else showToast('Đã rút báo cáo của bạn.', 'info', 'flag');
  } catch (e) {
    showToast(actionError(e), 'error', 'warning');
  } finally {
    submit.disabled = false;
  }
}

// Hide / unhide, admin-only, and the button is only rendered for an admin.
// Unlike deleteCommentAsAdmin above there is no confirm on the UNHIDE direction
// (it restores exactly what hiding took, nothing more), and hiding asks once
// because it carries the whole reply subtree with it - the same fact the delete
// confirm has to state.
async function toggleHideCommentAsAdmin(commentId, hidden) {
  if (
    hidden &&
    !confirm(
      'Ẩn bình luận này? Độc giả sẽ không thấy nó và mọi trả lời bên dưới cũng vậy; chính tác giả sẽ thấy lời nhắn "đã bị ẩn". Có thể bỏ ẩn lại bất cứ lúc nào.'
    )
  ) {
    return;
  }
  try {
    await API.setCommentHidden(commentId, hidden);
    loadComments(currentPost.id);
  } catch (e) {
    alert(actionError(e));
  }
}

document.getElementById('comment-submit')?.addEventListener('click', async () => {
  const input = document.getElementById('comment-input');
  const content = input.value.trim();
  if (!content) return;
  try {
    await API.addComment(currentPost.id, content);
    input.value = '';
    loadComments(currentPost.id);
  } catch (e) {
    alert(e.message);
  }
});

document.getElementById('share-btn')?.addEventListener('click', async () => {
  const shareData = { title: currentPost?.title || document.title, url: window.location.href };
  if (navigator.share) {
    try {
      await navigator.share(shareData);
    } catch (e) {
      // user cancelled the native share sheet - not an error
    }
  } else {
    // No native Web Share API (most desktop browsers) - fall back to copying the link
    try {
      await navigator.clipboard.writeText(window.location.href);
      alert('Đã sao chép liên kết bài viết!');
    } catch (e) {
      alert('Không thể chia sẻ hoặc sao chép liên kết tự động. Vui lòng copy URL thủ công.');
    }
  }
});

document.getElementById('copy-link-btn')?.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(window.location.href);
    const btn = document.getElementById('copy-link-btn');
    const original = btn.innerHTML;
    btn.innerHTML = '<span class="material-symbols-outlined">check</span>';
    setTimeout(() => (btn.innerHTML = original), 1500);
  } catch (e) {
    alert('Không thể sao chép liên kết. Vui lòng copy URL thủ công từ thanh địa chỉ.');
  }
});

// ---- Back to top ----
//
// The button's permanent home is the action row at the END of the article - a
// reader who reaches it has just finished the piece and wants the title, the
// author or the first paragraph back. Below one viewport of scroll and above
// that row, though, it has nothing to sit against, so it floats instead: fixed
// to the corner, on a frosted .to-top-btn--floating surface (see post.html),
// until the action row itself scrolls into view - at which point it drops the
// floating class and settles back into the exact spot in that row it already
// occupies, rather than appearing as a second, competing control.
{
  const toTopBtn = document.getElementById('to-top-btn');
  const actionRow = document.querySelector('.ed-action-bar');
  if (toTopBtn && actionRow) {
    let rowInView = false;
    let pastFirstPage = false;
    // Lines the floating pill's own right edge up with the row's - the
    // reading column is left-aligned with a sidebar beside it above 1024px
    // (see .post-layout in this page's own <style>), so the row's right edge
    // is not a fixed distance from the viewport edge the way a plain
    // `right: 1.25rem` assumes. Measured fresh each time rather than cached:
    // the row's width can change (a narrower viewport, the sidebar
    // appearing/disappearing at 1024px) between one float and the next.
    // document.documentElement.clientWidth, not window.innerWidth - the
    // latter includes the scrollbar, which getBoundingClientRect() already
    // excludes, and the mismatch would push the pill a scrollbar's width
    // short of true alignment.
    const placeFloatingRight = () => {
      const rowRight = actionRow.getBoundingClientRect().right;
      toTopBtn.style.right = `${Math.max(0, document.documentElement.clientWidth - rowRight)}px`;
    };
    const applyFloatState = () => {
      const floating = pastFirstPage && !rowInView;
      if (floating) placeFloatingRight();
      toTopBtn.classList.toggle('to-top-btn--floating', floating);
    };
    window.addEventListener('resize', () => {
      if (toTopBtn.classList.contains('to-top-btn--floating')) placeFloatingRight();
    });
    // The row's OWN visibility, not the button's: once floating, the button is
    // position:fixed and no longer where the row's layout would put it, so
    // asking the button itself "am I on screen" would just answer with the
    // fixed corner it already occupies. The row still sits in normal flow
    // regardless of what its floating child is doing - only its remaining
    // in-flow siblings (the like/dislike pair) hold its layout box, which is
    // exactly the "has the reader scrolled down to here" signal wanted.
    new IntersectionObserver(
      (entries) => {
        rowInView = entries[entries.length - 1].isIntersecting;
        applyFloatState();
      },
      { threshold: 0 }
    ).observe(actionRow);

    let scrollTicking = false;
    window.addEventListener('scroll', () => {
      if (scrollTicking) return;
      scrollTicking = true;
      requestAnimationFrame(() => {
        scrollTicking = false;
        pastFirstPage = window.scrollY > window.innerHeight;
        applyFloatState();
      });
    });
  }
}
document.getElementById('to-top-btn')?.addEventListener('click', () => {
  // The same preference the CSS transitions honour: a reader who asked for less
  // motion gets the jump instead of the animation.
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  // The pill has no frame to press against any more, so the click answers with a
  // zoom: the class runs the keyframes in post.html and animationend below takes
  // it off again. Removed and re-added (with a reflow between) so a second click
  // while the first pulse is still running restarts it rather than doing nothing.
  const btn = document.getElementById('to-top-btn');
  if (btn && !reduceMotion) {
    btn.classList.remove('to-top-btn--pulse');
    void btn.offsetWidth;
    btn.classList.add('to-top-btn--pulse');
  }
  window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
});
document.getElementById('to-top-btn')?.addEventListener('animationend', (e) => {
  if (e.animationName === 'to-top-pulse') e.target.classList.remove('to-top-btn--pulse');
});

loadPost();

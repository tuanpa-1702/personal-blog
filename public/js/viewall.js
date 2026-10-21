// "Tất cả bài viết" page (public/viewall.html).
//
// Reached from the "Xem tất cả" link on the homepage. Shows every published
// post as a card grid in the design-template style - cover image, coloured tag
// badge, date, excerpt, hashtags - with a chip row that arranges the list by
// tag, a search field, and a row of page numbers under the grid.
//
// Six posts a page, the same count whatever the list is filtered by: the whole
// blog, one tag, or a search. Past six there are numbered pages instead of a
// "load more" button, so the size of the list is visible and any page can be
// jumped to directly.
//
// The view lives in the URL (?tag=&q=&page=) so a filtered list - including
// which page of it - is linkable and the Back button behaves the way a reader
// expects.
//
// Cards, chips and page numbers carry their target in data-* attributes and are
// handled by a single delegated click listener (wireDelegatedClicks below)
// rather than inline onclick handlers, so a tag or slug containing a quote can
// never break out into the attribute.

document.getElementById('footer-year').textContent = new Date().getFullYear();

// Cards per page. Small on purpose: the grid is 3 across from lg, so six is two
// full rows - a page that fits without scrolling on most screens.
const PAGE_SIZE = 6;

function formatDateVi(dateStr) {
  const d = new Date(String(dateStr).replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('vi-VN', { day: '2-digit', month: 'long', year: 'numeric' });
}

// Current view, seeded from the query string so /viewall.html?tag=Tech and
// /viewall.html?page=3 both open on the page they name.
const boot = new URLSearchParams(location.search);
const state = {
  tag: boot.get('tag') || '',
  q: (boot.get('q') || '').trim().replace(/^#+/, ''),
  page: Math.max(parseInt(boot.get('page'), 10) || 1, 1),
  // Whitelisted against what server/routes/posts.js's `sort` param actually
  // understands (posts.js:259ish) - anything else falls back to the default
  // newest-first rather than being sent through as-is.
  sort: boot.get('sort') === 'views' ? 'views' : 'newest',
  total: 0,
};

const grid = document.getElementById('viewall-grid');
const emptyEl = document.getElementById('viewall-empty');
const summaryEl = document.getElementById('result-summary');
const pagerEl = document.getElementById('viewall-pager');
const searchInput = document.getElementById('viewall-search');

// Custom sort dropdown (button + listbox), replacing a native <select> whose
// OS-drawn popup can't be made to match the black/white selected-row fill
// used everywhere else on the page - see the HTML comment above it.
const sortBtn = document.getElementById('viewall-sort-btn');
const sortLabel = document.getElementById('viewall-sort-label');
const sortMenu = document.getElementById('viewall-sort-menu');
const sortOptions = [...sortMenu.querySelectorAll('.ed-inline-dd-option')];

function closeSortMenu() {
  sortMenu.classList.add('hidden');
  sortBtn.setAttribute('aria-expanded', 'false');
}

function selectSort(value, { reload = true } = {}) {
  const opt = sortOptions.find((o) => o.dataset.value === value) || sortOptions[0];
  state.sort = opt.dataset.value === 'views' ? 'views' : 'newest';
  sortLabel.textContent = opt.dataset.label;
  sortOptions.forEach((o) => {
    const selected = o === opt;
    o.classList.toggle('is-selected', selected);
    o.setAttribute('aria-selected', String(selected));
  });
  if (reload) {
    state.page = 1;
    syncUrl();
    load();
  }
}

sortBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = sortMenu.classList.toggle('hidden') === false;
  sortBtn.setAttribute('aria-expanded', String(open));
});
sortMenu.addEventListener('click', (e) => {
  const opt = e.target.closest('.ed-inline-dd-option');
  if (!opt) return;
  selectSort(opt.dataset.value);
  closeSortMenu();
});
document.addEventListener('click', (e) => {
  if (e.target.closest('#sort-dropdown')) return;
  closeSortMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSortMenu();
});
selectSort(state.sort, { reload: false });


// One card in the grid. The cover image is lazy + async-decoded: only the first
// row of a page is above the fold, and eagerly fetching the rest competes with
// the fonts and the CSS the first paint is actually waiting on.
// `decoding="async"` keeps the decode off the main thread as well, so a wide
// cover cannot stall a scroll.
// p.excerpt IS escapeHtml()'d below, unlike an earlier version of this card:
// the server now always hands back PLAIN text for a list-shaped response
// (attachExcerptFallback, server/excerpt.js), including a literal "<" or "&"
// decoded back from an entity, which must be escaped again before it can be
// safely inserted as markup.
function postCard(p) {
  // w1280, not the 480px thumb: .ed-photo (editorial.css) renders at the
  // grid column's own width, which runs wider than a thumb was meant to cover.
  // No cover of its own -> no picture (there is no default cover any more):
  // the tag chip moves from the photo's corner to the top of the text.
  const media = p.cover_image
    ? `<div class="overflow-hidden relative flex-shrink-0">
      <img alt="" class="ed-photo group-hover:scale-105 transition-transform duration-500" src="${escapeHtml(derivUrl(p.cover_image, 'w1280'))}" loading="lazy" decoding="async">
      <div class="absolute top-sm left-sm ed-chip ed-chip--on-media cursor-pointer" data-tag="${escapeHtml(p.tag)}">${escapeHtml(p.tag)}</div>
    </div>`
    : '';
  const chip = p.cover_image ? '' : `<div class="ed-chip self-start cursor-pointer mb-xs" data-tag="${escapeHtml(p.tag)}">${escapeHtml(p.tag)}</div>`;
  const hashtags = (p.hashtags || [])
    .slice(0, 3)
    .map(
      (h) =>
        `<span class="inline-flex items-center py-1 ed-hashtag font-body-sm text-body-sm hover:underline cursor-pointer" data-tag="${escapeHtml(h)}">#${escapeHtml(h)}</span>`
    )
    .join('');

  return `
  <article class="reveal-on-scroll ed-panel rounded overflow-hidden group cursor-pointer flex flex-col${p.cover_image ? '' : ' ed-card--text'}" data-slug="${escapeHtml(p.slug)}">
    ${media}
    <div class="p-sm sm:p-md flex flex-col flex-grow">
      ${chip}
      <div class="ed-icon-faint font-label-md text-label-md mb-xs">${formatDateVi(p.created_at)} · ${p.views} lượt xem</div>
      <h2 class="ed-story-title--sm mb-sm line-clamp-2"><a class="ed-card-link" href="/post.html?slug=${encodeURIComponent(p.slug)}">${escapeHtml(p.title)}</a></h2>
      <p class="ed-excerpt line-clamp-3">${escapeHtml(p.excerpt || '')}</p>
      ${hashtags ? `<div class="mt-md flex flex-wrap gap-2">${hashtags}</div>` : ''}
    </div>
  </article>`;
}

// "Danh mục" dropdown: "Tất cả" plus an option for each of the three "Thẻ
// (tag)" values with the most published posts, in the order /api/posts/tags
// returns them (most posts first). That endpoint counts the post's `tag`
// field only - hashtags are deliberately NOT options here, because a post
// has exactly one tag but up to ten hashtags, so a union of the two filled
// the list with hashtag names and left the tags - the thing it's for -
// crowded out. Hashtags are still filters: the `#name` on a card and the
// search box both work, they just do not get an option. The dropdown is a
// shortcut to the busiest corners of the blog, not a full index.
// Below three tags there is nothing worth choosing between, so the whole
// control goes away and the card is just the search field.
// A dropdown (same button+listbox pattern as "Sắp xếp" beside it), not a
// chip row: the chip row wrapped to several lines with no way to lay that
// out cleanly once there were more than a couple of tags on a narrow
// screen, which is exactly what the fade/scroll/resize-observer machinery
// this replaced existed to paper over. A compact control has no such
// problem at any width, so all of that went with it.
const TAG_CHIP_LIMIT = 3;
const tagGroup = document.getElementById('tag-filters-group');
const tagBtn = document.getElementById('viewall-tag-btn');
const tagLabel = document.getElementById('viewall-tag-label');
const tagMenu = document.getElementById('viewall-tag-menu');

function closeTagMenu() {
  tagMenu.classList.add('hidden');
  tagBtn.setAttribute('aria-expanded', 'false');
}

function tagOptionHtml(label, value) {
  const active = value === state.tag;
  return `<button type="button" class="ed-dropdown-item ed-inline-dd-option flex items-center w-full px-3 py-2 text-left${active ? ' is-selected' : ''}" data-value="${escapeHtml(value)}" role="option" aria-selected="${active}">${escapeHtml(label)}</button>`;
}

async function renderTagFilters() {
  let tags = [];
  try {
    ({ tags } = await API.listTags());
  } catch (e) {
    // Non-critical: the grid and the search box still work without it.
    tagGroup.classList.add('hidden');
    return;
  }

  // A tag filter can still be active with fewer than three tags to choose
  // from - a `#hashtag` on a card filters by a name that never gets an
  // option - and the way back to the full list is then clicking that same
  // hashtag again, or reloading /viewall.html without the query string.
  if (tags.length < TAG_CHIP_LIMIT) {
    tagGroup.classList.add('hidden');
    return;
  }
  tagGroup.classList.remove('hidden');

  tagMenu.innerHTML =
    tagOptionHtml('Tất cả', '') +
    tags
      .slice(0, TAG_CHIP_LIMIT)
      .map((t) => tagOptionHtml(`${t.tag} (${t.count})`, t.tag))
      .join('');
  const current = tags.find((t) => t.tag === state.tag);
  tagLabel.textContent = state.tag ? current?.tag || state.tag : 'Tất cả';
}

tagBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = tagMenu.classList.toggle('hidden') === false;
  tagBtn.setAttribute('aria-expanded', String(open));
});
tagMenu.addEventListener('click', (e) => {
  const opt = e.target.closest('.ed-inline-dd-option');
  if (!opt) return;
  selectTag(opt.dataset.value);
  closeTagMenu();
});
document.addEventListener('click', (e) => {
  if (e.target.closest('#tag-dropdown')) return;
  closeTagMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeTagMenu();
});

// One listener for the whole page. A click on a page number turns that page; a
// click on anything carrying data-tag filters by that tag (clicking the active
// one clears the filter); a click anywhere else inside a card opens the post.
function wireDelegatedClicks() {
  document.addEventListener('click', (e) => {
    const pageEl = e.target.closest('[data-page]');
    if (pageEl) {
      // The server-rendered pager is <a href> links (for crawlers); once this
      // script runs, paging stays in-page like the button version.
      e.preventDefault();
      // A disabled arrow is the end of the list. Most browsers swallow the click
      // for us, but the icon inside the button is a separate element and not all
      // of them agree, so the check stays here.
      if (!pageEl.disabled) gotoPage(Number(pageEl.dataset.page));
      return;
    }
    const tagEl = e.target.closest('[data-tag]');
    if (tagEl) {
      e.stopPropagation();
      selectTag(tagEl.dataset.tag);
      return;
    }
    // A real link inside the card (its title) navigates by itself - and keeps
    // ctrl/middle-click opening a new tab instead of also moving this one.
    if (e.target.closest('a[href]')) return;
    const card = e.target.closest('[data-slug]');
    if (card) window.location.href = `/post.html?slug=${encodeURIComponent(card.dataset.slug)}`;
  });
}

// Switching tag resets to page 1 and rewrites the URL. Re-clicking the active
// tag (or the "Tất cả" chip, whose value is '') clears the filter.
function selectTag(tag) {
  state.tag = tag === state.tag ? '' : tag;
  state.page = 1;
  syncUrl();
  renderTagFilters();
  load();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function syncUrl() {
  const params = new URLSearchParams();
  if (state.tag) params.set('tag', state.tag);
  if (state.q) params.set('q', state.q);
  if (state.sort === 'views') params.set('sort', state.sort);
  // Page 1 is the default and stays out of the URL, so the common case keeps
  // the short /viewall.html?tag=Tech a shared link already has.
  if (state.page > 1) params.set('page', String(state.page));
  const qs = params.toString();
  history.replaceState({}, '', location.pathname + (qs ? `?${qs}` : ''));
}

// The <h1> is the only header text - it names whichever view is on screen. The
// standing description line under it was dropped, so nothing else to update.
function updateHeader() {
  const title = document.getElementById('page-title');
  if (state.q) title.textContent = `Kết quả cho "${state.q}"`;
  else if (state.tag) title.textContent = `Thẻ: ${state.tag}`;
  else title.textContent = 'Tất cả bài viết';
}

// ---------------------------------------------------------------- pager

// How many pages the current filter has. Never 0: an empty list is still
// "page 1 of 1", which is what keeps the pager hidden rather than rendering a
// row of nothing under an empty grid.
function pageCount() {
  return Math.max(1, Math.ceil(state.total / PAGE_SIZE));
}

// Which page numbers to show. All of them while the list is short; otherwise the
// two ends, the current page's neighbours, and 'gap' markers where pages are
// skipped - the same windowing the media library's pager uses (media.js),
// because "jump to roughly where I was" matters more than seeing every number.
function pagerWindow(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const wanted = new Set([1, 2, total - 1, total, current - 1, current, current + 1]);
  const pages = [...wanted].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < pages.length; i += 1) {
    if (i && pages[i] - pages[i - 1] > 1) out.push('gap');
    out.push(pages[i]);
  }
  return out;
}

function renderPager() {
  const pages = pageCount();
  // Six posts or fewer: one page holds the whole list, so there is nothing to
  // choose between and the row goes away.
  if (pages <= 1) {
    pagerEl.classList.add('hidden');
    pagerEl.innerHTML = '';
    return;
  }
  pagerEl.classList.remove('hidden');

  const cur = state.page;
  const arrow = (target, label, icon, disabled) =>
    `<button type="button" class="pager-btn" data-page="${target}"` +
    `${disabled ? ' disabled' : ''} aria-label="${label}">` +
    `<span class="material-symbols-outlined" aria-hidden="true">${icon}</span></button>`;

  pagerEl.innerHTML =
    arrow(cur - 1, 'Trang trước', 'arrow_back', cur <= 1) +
    pagerWindow(cur, pages)
      .map((p) =>
        p === 'gap'
          ? '<span class="pager-gap" aria-hidden="true">…</span>'
          : `<button type="button" class="pager-btn${p === cur ? ' is-current' : ''}"` +
            ` data-page="${p}"${p === cur ? ' aria-current="page"' : ''}>${p}</button>`
      )
      .join('') +
    arrow(cur + 1, 'Trang sau', 'arrow_forward', cur >= pages);
}

function gotoPage(page) {
  // Clamped, not trusted: the number comes out of the DOM, and a stale row left
  // over from a longer list must not be able to ask for a page that is not there.
  // `|| 1` is for a data-page that is not a number at all: Math.max(1, NaN) is
  // NaN, and NaN would go straight into the URL.
  const target = Math.min(Math.max(1, Number(page)) || 1, pageCount());
  if (target === state.page) return;
  state.page = target;
  syncUrl();
  load();
  // The pager sits under the grid, so without this a click on page 4 leaves the
  // reader looking at the space page 3's cards used to fill.
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// "Đang xem 7–12 / 25 bài viết" - the range says where in the list the reader
// is, which a page number on its own does not.
function summaryText() {
  const from = (state.page - 1) * PAGE_SIZE + 1;
  const to = Math.min(state.total, state.page * PAGE_SIZE);
  return `Đang xem ${from}–${to} / ${state.total} bài viết`;
}

async function load() {
  // server/ssr-content.js already put this page's cards in the HTML (data-ssr):
  // keep them on screen through the first fetch instead of blanking to the
  // loading line and back. Every later load() is a real change of view.
  if (grid.dataset.ssr) delete grid.dataset.ssr;
  else grid.innerHTML = '<p class="text-on-surface-variant">Đang tải bài viết...</p>';
  // The numbers stay where they are but go grey and inert: hiding the row would
  // drop it out of the layout and jerk the scroll, and leaving it live would let
  // a second click start a second fetch for a page nobody asked for.
  pagerEl.classList.add('is-loading');
  updateHeader();

  const params = { page: state.page, limit: PAGE_SIZE };
  if (state.tag) params.tag = state.tag;
  if (state.q) params.q = state.q;
  if (state.sort === 'views') params.sort = state.sort;

  try {
    const [{ posts, total }, settings] = await Promise.all([
      API.listPosts(params),
      getSiteSettings(),
    ]);
    state.total = total;

    // A ?page= link can outlive the list it pointed into - posts get unpublished,
    // a tag gets retyped - and the server answers that with an empty page rather
    // than an error. Step back to the last page that exists instead of telling
    // the reader there is nothing to see in a blog that plainly has posts.
    // Terminates: pageCount() is at least 1, so the retry runs on page 1.
    if (!posts.length && state.page > pageCount()) {
      state.page = pageCount();
      syncUrl();
      return load();
    }

    pagerEl.classList.remove('is-loading');
    grid.innerHTML = posts.map(postCard).join('');
    emptyEl.classList.toggle('hidden', posts.length > 0);
    summaryEl.textContent = total ? summaryText() : '';
    renderPager();

    initScrollReveal();
  } catch (e) {
    // No pager next to an error: there is no list to page through, and a row of
    // numbers that all fail the same way is just a second error message.
    pagerEl.classList.remove('is-loading');
    pagerEl.classList.add('hidden');
    pagerEl.innerHTML = '';
    grid.innerHTML = `<p class="text-error">Không thể tải bài viết: ${escapeHtml(e.message)}</p>`;
  }
}

// A leading '#' is how hashtags are shown on the cards, but they are stored
// without it - drop it so typing "#coding" finds the same posts as "coding".
function normalizeQuery(raw) {
  return raw.trim().replace(/^#+/, '');
}

// Debounced search - typing narrows the grid without a page reload.
let searchTimer = null;
searchInput.value = state.q;
searchInput.addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const value = normalizeQuery(e.target.value);
  searchTimer = setTimeout(() => {
    if (value === state.q) return;
    state.q = value;
    state.page = 1;
    syncUrl();
    load();
  }, 300);
});

// Same one-shot fade-in the homepage cards use.
function initScrollReveal() {
  const targets = document.querySelectorAll('.reveal-on-scroll:not(.revealed)');
  if (!('IntersectionObserver' in window)) {
    targets.forEach((el) => el.classList.add('revealed'));
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('revealed');
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.1, rootMargin: '0px 0px -40px 0px' }
  );
  targets.forEach((el) => observer.observe(el));
}

wireDelegatedClicks();
renderTagFilters();
load();

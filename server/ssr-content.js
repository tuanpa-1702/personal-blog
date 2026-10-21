// Server-side first paint of the CONTENT a search engine indexes.
//
// Every list and every article on this site used to be drawn by JavaScript
// after load: the raw HTML of index.html and viewall.html carried zero links to
// a post, and post.html carried "Đang tải bài viết..." instead of the article.
// Google does run JavaScript, but in a separate, much later rendering queue, so
// for a young site the posts were reachable only through sitemap.xml - orphan
// URLs with nothing linking to them - and sat in Search Console as "Discovered -
// currently not indexed" with no crawl at all.
//
// This module writes the same content into the HTML before it leaves the
// server, in the SAME markup the page scripts render (home.js moreCard(),
// viewall.js postCard(), api.js renderContentBlocksHtml()), so the scripts'
// own re-render a moment later lands on an identical page:
//   - index.html   the newest posts in #more-grid (section left hidden - home.js
//                  decides which of them it shows) and the lead title as a link
//   - viewall.html the requested page of the list in #viewall-grid, plus the
//                  pager as real <a href="?page=N"> links, so every post is two
//                  plain links away from the homepage
//   - post.html    title, tag, author, date, standfirst, cover and the body
//
// Every value is escaped here; the only markup passed through is rich-text
// paragraph HTML, re-run through sanitizeRichHtml() on the way out even though
// routes/posts.js already sanitized it on save.
const db = require('./db');
const { attachExcerptFallback } = require('./excerpt');
const { sanitizeRichHtml } = require('./sanitize-html');

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const postUrl = (slug) => `/post.html?slug=${encodeURIComponent(slug)}`;

// api.js derivUrl(): an original upload maps to its thumb/w1280 derivative,
// anything else (an external cover) passes through.
function derivUrl(url, kind) {
  const u = String(url ?? '').trim();
  const m = u.match(/^\/uploads\/([^/?#]+)$/);
  if (!m) return u;
  return `/uploads/${kind === 'thumb' ? 'thumb' : 'w1280'}/${m[1]}`;
}

// DB rows are "YYYY-MM-DD HH:MM:SS" UTC without a zone marker.
function parseDbDate(s) {
  const d = new Date(String(s || '').replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? null : d;
}
// viewall.js formatDateVi() / post.js formatPostDate(): "08 tháng 9, 2026".
function dateVi(s) {
  const d = parseDbDate(s);
  return d ? d.toLocaleDateString('vi-VN', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Asia/Ho_Chi_Minh' }) : '';
}
// api.js timeAgoVi().
function timeAgoVi(s) {
  const d = parseDbDate(s);
  if (!d) return '';
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'vừa xong';
  if (mins < 60) return `${mins} phút trước`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} giờ trước`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} ngày trước`;
  return dateVi(s);
}

function parseHashtags(raw) {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v.filter((h) => typeof h === 'string') : [];
  } catch {
    return [];
  }
}

const LIST_COLUMNS = `p.id, p.title, p.slug, p.excerpt, p.cover_image, p.tag, p.hashtags,
         p.views, p.created_at, u.name AS author_name, u.avatar_url AS author_avatar`;

// ---- index.html ----------------------------------------------------------

// home.js moreCard(), with the title as a real link. No cover of its own ->
// no picture (there is no default cover); the chip moves into the text.
function homeCard(p) {
  const media = p.cover_image
    ? `<div class="overflow-hidden relative flex-shrink-0">
      <img alt="" class="ed-photo group-hover:scale-105 transition-transform duration-500" src="${escapeHtml(derivUrl(p.cover_image, 'w1280'))}" loading="lazy" decoding="async">
      <span class="absolute top-sm left-sm ed-chip ed-chip--on-media">${escapeHtml(p.tag)}</span>
    </div>`
    : '';
  const chip = p.cover_image ? '' : `<span class="ed-chip self-start">${escapeHtml(p.tag)}</span>`;
  return `
  <article class="ed-panel rounded overflow-hidden group cursor-pointer flex flex-col${p.cover_image ? '' : ' ed-card--text'}" data-goto="${escapeHtml(postUrl(p.slug))}">
    ${media}
    <div class="p-sm sm:p-md flex flex-col flex-grow gap-2">
      ${chip}
      <h3 class="ed-story-title--sm line-clamp-2"><a class="ed-card-link" href="${escapeHtml(postUrl(p.slug))}">${escapeHtml(p.title)}</a></h3>
      <p class="ed-excerpt line-clamp-3">${escapeHtml(p.excerpt || '')}</p>
      <div class="ed-byline pt-1 mt-auto">
        <img class="ed-byline-avatar" src="${escapeHtml(derivUrl(p.author_avatar || '', 'thumb'))}" alt="" loading="lazy" decoding="async">
        <span>${escapeHtml(p.author_name || 'Ẩn danh')}</span>
        <span class="ed-byline-dot">·</span>
        <span>${escapeHtml(timeAgoVi(p.created_at))}</span>
      </div>
    </div>
  </article>`;
}

function fillHomeLinks(html, settings) {
  if (!html.includes('id="more-grid"')) return html;
  let rows;
  try {
    rows = db
      .prepare(
        `SELECT ${LIST_COLUMNS} FROM posts p LEFT JOIN users u ON u.id = p.author_id
          WHERE p.status = 'published' AND p.deleted_at IS NULL
          ORDER BY p.created_at DESC, p.id DESC LIMIT 7`
      )
      .all();
  } catch {
    return html;
  }
  if (!rows.length) return html;
  attachExcerptFallback(rows);
  const [lead, ...rest] = rows;

  // The lead's title (already filled by render-html.js fillLeadCard()) becomes a link.
  html = html.replace(/(<h1 class="ed-hero-title" id="latest-title">)([^<]*)(<\/h1>)/, (m, open, text, close) =>
    text ? `${open}<a class="ed-card-link" href="${escapeHtml(postUrl(lead.slug))}">${text}</a>${close}` : m
  );

  // #more-section stays hidden: home.js decides which of these it shows (it
  // de-duplicates against the "đọc nhiều nhất" rail), and a section appearing
  // and then changing would be a visible jump. The links are in the HTML either
  // way, which is all a crawler reading the raw page needs.
  const cards = rest.map(homeCard).join('');
  return html.replace('id="more-grid"></div>', `id="more-grid">${cards}</div>`);
}

// ---- viewall.html --------------------------------------------------------

const VIEWALL_PAGE_SIZE = 6; // viewall.js PAGE_SIZE
// viewall.js postCard(), with the title as a real link. No cover of its own ->
// no picture (there is no default cover); the chip moves into the text.
function viewallCard(p) {
  const media = p.cover_image
    ? `<div class="overflow-hidden relative flex-shrink-0">
      <img alt="" class="ed-photo group-hover:scale-105 transition-transform duration-500" src="${escapeHtml(derivUrl(p.cover_image, 'w1280'))}" loading="lazy" decoding="async">
      <div class="absolute top-sm left-sm ed-chip ed-chip--on-media cursor-pointer" data-tag="${escapeHtml(p.tag)}">${escapeHtml(p.tag)}</div>
    </div>`
    : '';
  const chip = p.cover_image ? '' : `<div class="ed-chip self-start cursor-pointer mb-xs" data-tag="${escapeHtml(p.tag)}">${escapeHtml(p.tag)}</div>`;
  const hashtags = parseHashtags(p.hashtags)
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
      <div class="ed-icon-faint font-label-md text-label-md mb-xs">${escapeHtml(dateVi(p.created_at))} · ${Number(p.views) || 0} lượt xem</div>
      <h2 class="ed-story-title--sm mb-sm line-clamp-2"><a class="ed-card-link" href="${escapeHtml(postUrl(p.slug))}">${escapeHtml(p.title)}</a></h2>
      <p class="ed-excerpt line-clamp-3">${escapeHtml(p.excerpt || '')}</p>
      ${hashtags ? `<div class="mt-md flex flex-wrap gap-2">${hashtags}</div>` : ''}
    </div>
  </article>`;
}

// viewall.js pagerWindow().
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

// viewall.js renderPager(), as links: the same classes and data-page (so the
// script's click handler still takes over once it runs), plus an href a
// crawler can follow to reach page 2, 3, ... and every post on them.
function pagerLinks(cur, pages, tag, sort) {
  const href = (n) => {
    const qs = new URLSearchParams();
    if (tag) qs.set('tag', tag);
    if (sort === 'views') qs.set('sort', 'views');
    if (n > 1) qs.set('page', String(n));
    const s = qs.toString();
    return `/viewall.html${s ? `?${s}` : ''}`;
  };
  const arrow = (target, label, icon, disabled) =>
    disabled
      ? `<button type="button" class="pager-btn" data-page="${target}" disabled aria-label="${label}"><span class="material-symbols-outlined" aria-hidden="true">${icon}</span></button>`
      : `<a class="pager-btn" href="${escapeHtml(href(target))}" data-page="${target}" aria-label="${label}"><span class="material-symbols-outlined" aria-hidden="true">${icon}</span></a>`;
  return (
    arrow(cur - 1, 'Trang trước', 'arrow_back', cur <= 1) +
    pagerWindow(cur, pages)
      .map((p) =>
        p === 'gap'
          ? '<span class="pager-gap" aria-hidden="true">…</span>'
          : p === cur
            ? `<a class="pager-btn is-current" href="${escapeHtml(href(p))}" data-page="${p}" aria-current="page">${p}</a>`
            : `<a class="pager-btn" href="${escapeHtml(href(p))}" data-page="${p}">${p}</a>`
      )
      .join('') +
    arrow(cur + 1, 'Trang sau', 'arrow_forward', cur >= pages)
  );
}

function fillViewallList(html, query, settings) {
  if (!html.includes('id="viewall-grid"')) return html;
  // A search result page is not something to index; leave it to the script.
  if (typeof query.q === 'string' && query.q.trim()) return html;
  const tag = typeof query.tag === 'string' ? query.tag : '';
  const sort = query.sort === 'views' ? 'views' : 'newest';
  const page = Math.max(parseInt(query.page, 10) || 1, 1);

  const where = [`p.status = 'published'`, 'p.deleted_at IS NULL'];
  const params = {};
  if (tag) {
    where.push('(p.tag = @tag OR p.hashtags LIKE @tagLike)');
    params.tag = tag;
    params.tagLike = `%"${tag}"%`;
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const orderBy = sort === 'views' ? 'p.views DESC, p.id DESC' : 'p.created_at DESC, p.id DESC';

  let total;
  let rows;
  try {
    total = db.prepare(`SELECT COUNT(*) AS n FROM posts p ${whereSql}`).get(params).n;
    const pages = Math.max(1, Math.ceil(total / VIEWALL_PAGE_SIZE));
    if (page > pages) return html; // stale ?page=: viewall.js steps back itself
    rows = db
      .prepare(
        `SELECT ${LIST_COLUMNS} FROM posts p LEFT JOIN users u ON u.id = p.author_id
          ${whereSql} ORDER BY ${orderBy} LIMIT @limit OFFSET @offset`
      )
      .all({ ...params, limit: VIEWALL_PAGE_SIZE, offset: (page - 1) * VIEWALL_PAGE_SIZE });
  } catch {
    return html;
  }
  if (!rows.length) return html;
  attachExcerptFallback(rows);

  const cards = rows.map(viewallCard).join('');
  // data-ssr tells viewall.js the first page is already on screen, so its first
  // load() does not blank it to "Đang tải bài viết..." and back.
  html = html.replace(
    /(<div class="[^"]*" id="viewall-grid")>[\s\S]*?<\/div>/,
    (m, open) => `${open} data-ssr="1">${cards}\n</div>`
  );

  const pages = Math.ceil(total / VIEWALL_PAGE_SIZE);
  if (pages > 1) {
    html = html.replace(
      '<nav aria-label="Chuyển trang" class="mt-lg hidden" id="viewall-pager"></nav>',
      `<nav aria-label="Chuyển trang" class="mt-lg" id="viewall-pager">${pagerLinks(page, pages, tag, sort)}</nav>`
    );
  }
  return html;
}

// ---- post.html -----------------------------------------------------------

// api.js renderContentBlocksHtml(), for the first paint. post.js replaces the
// body with its own full render (indent/quote normalisation, derivative image
// URLs) as soon as it runs; what matters here is that the TEXT, headings and
// images are in the HTML a crawler receives.
function renderBodyHtml(content) {
  let blocks;
  try {
    const parsed = JSON.parse(content);
    blocks = Array.isArray(parsed) && parsed.every((b) => b && typeof b === 'object' && b.type) ? parsed : null;
  } catch {
    blocks = null;
  }
  if (!blocks) {
    blocks = String(content ?? '')
      .split('\n')
      .filter((line) => line.trim().length)
      .map((text) => ({ type: 'paragraph', text }));
  }
  // Runs of consecutive images become one .ed-gallery album, a lone image a
  // full-width figure - api.js renderContentBlocksHtml() on this site.
  const out = [];
  for (let i = 0; i < blocks.length; ) {
    if (blocks[i].type === 'image' && blocks[i].url) {
      const run = [];
      while (i < blocks.length && blocks[i].type === 'image' && blocks[i].url) run.push(blocks[i++]);
      if (run.length > 1) {
        const tiles = run
          .map((b) => `<img src="${escapeHtml(b.url)}" alt="${escapeHtml(b.caption || '')}" title="${escapeHtml(b.caption || '')}" loading="lazy" decoding="async">`)
          .join('');
        out.push(`<div class="ed-gallery my-8">${tiles}</div>`);
        continue;
      }
      out.push(renderOneBlock(run[0]));
      continue;
    }
    out.push(renderOneBlock(blocks[i++]));
  }
  return out.join('');
}

function renderOneBlock(b) {
  return [b]
    .map((b) => {
      if (b.type === 'heading') {
        const tag = b.level === 1 ? 'h1' : b.level === 3 ? 'h3' : 'h2';
        const sizeClass =
          b.level === 1 ? 'text-3xl sm:text-4xl md:text-5xl' : b.level === 3 ? 'text-lg sm:text-xl' : 'text-xl sm:text-2xl md:text-3xl';
        return `<${tag} class="font-headline-md ${sizeClass} text-on-background mt-10 mb-4">${escapeHtml(b.text || '')}</${tag}>`;
      }
      if (b.type === 'image' && b.url) {
        const caption = b.caption ? `<figcaption class="text-sm text-on-surface-variant mt-2">${escapeHtml(b.caption)}</figcaption>` : '';
        return `<figure class="my-8"><img src="${escapeHtml(b.url)}" alt="${escapeHtml(b.caption || '')}" class="w-full rounded-xl" loading="lazy" decoding="async">${caption}</figure>`;
      }
      if (b.type === 'embed') return ''; // an iframe adds nothing to index; post.js draws it
      if (b.type === 'layout') return renderLayoutBlock(b);
      if (b.type === 'paragraph' && b.html !== undefined) {
        return `<div class="rich-text-block">${sanitizeRichHtml(String(b.html || ''))}</div>`;
      }
      if (b.numbered) {
        const items = String(b.text || '')
          .split('\n')
          .filter((line) => line.trim().length)
          .map((line) => `<li>${escapeHtml(line)}</li>`)
          .join('');
        return `<ol class="list-decimal pl-8 mb-6 space-y-2">${items}</ol>`;
      }
      return `<p>${escapeHtml(b.text || '')}</p>`;
    })
    .join('');
}

// "Bố cục ảnh" - public/js/api.js renderLayoutBlockHtml(), same markup.
const LAYOUTS = {
  side: { count: 1, text: true },
  'side-right': { count: 1, text: true },
  wide: { count: 1, text: false },
  split: { count: 1, text: true },
  'split-reverse': { count: 1, text: true },
  feature: { count: 3, text: false },
  pair: { count: 2, text: false },
  masonry: { count: 12, text: false },
  strip: { count: 12, text: false },
};
function layoutImg(im, fallbackAlt = '') {
  const w = Number(im.width);
  const h = Number(im.height);
  const dims = Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 ? ` width="${w}" height="${h}"` : '';
  return `<img src="${escapeHtml(im.url)}" alt="${escapeHtml(String(im.alt || '').trim() || fallbackAlt)}"${dims} loading="lazy" decoding="async">`;
}
function renderLayoutBlock(b) {
  const id = Object.prototype.hasOwnProperty.call(LAYOUTS, b.layout) ? b.layout : 'wide';
  const def = LAYOUTS[id];
  const imgs = (Array.isArray(b.images) ? b.images : []).filter((im) => im && im.url).slice(0, def.count);
  if (!imgs.length) return '';
  const caption = b.caption ? `<figcaption class="ilay-caption">${escapeHtml(b.caption)}</figcaption>` : '';
  const text = def.text ? `<div class="ilay-text rich-text-block">${sanitizeRichHtml(String(b.html || ''))}</div>` : '';
  const img = (im) => layoutImg(im, b.caption || '');
  const one = `<figure>${img(imgs[0])}${caption}</figure>`;
  if (id === 'side' || id === 'side-right') return `<div class="ilay img-side${id === 'side-right' ? ' img-side--right' : ''}">${one}${text}</div>`;
  if (id === 'split' || id === 'split-reverse') return `<div class="ilay split${id === 'split-reverse' ? ' split--reverse' : ''}">${one}${text}</div>`;
  if (id === 'wide') return `<figure class="ilay img-wide">${img(imgs[0])}${caption}</figure>`;
  if (id === 'strip') {
    const arrows =
      '<button type="button" class="ilay-strip-btn ilay-strip-btn--prev" data-strip-dir="-1" aria-label="Ảnh trước"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></button>' +
      '<button type="button" class="ilay-strip-btn ilay-strip-btn--next" data-strip-dir="1" aria-label="Ảnh sau"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg></button>';
    return `<figure class="ilay gallery-strip"><div class="ilay-strip"><div class="ilay-grid" tabindex="0" aria-label="Dải ảnh, cuộn ngang">${imgs.map(img).join('')}</div>${arrows}</div>${caption}</figure>`;
  }
  return `<figure class="ilay gallery-${id}"><div class="ilay-grid">${imgs.map(img).join('')}</div>${caption}</figure>`;
}

const POST_BODY_SQL = `
  SELECT p.title, p.slug, p.excerpt, p.content, p.cover_image, p.tag, p.created_at,
         u.name AS author_name
    FROM posts p LEFT JOIN users u ON u.id = p.author_id
   WHERE p.slug = ? AND p.status = 'published' AND p.deleted_at IS NULL`;

// Returns { html, found }. found === false is the caller's cue to answer 404.
function fillPostBody(html, slug, settings) {
  let post;
  try {
    post = db.prepare(POST_BODY_SQL).get(slug);
  } catch {
    return { html, found: true }; // a database hiccup is not a "not found"
  }
  if (!post) return { html, found: false };

  const fillText = (id, text) =>
    (html = html.replace(new RegExp(`(id="${id}"[^>]*>)(</)`), (m, open, close) => `${open}${escapeHtml(text)}${close}`));

  fillText('post-title', post.title || '');
  fillText('post-tag', post.tag || '');
  fillText('post-author-name', post.author_name || 'Ẩn danh');
  fillText('post-date', dateVi(post.created_at));

  // Standfirst: the author's own excerpt only (post.js shows nothing otherwise).
  const excerpt = sanitizeRichHtml(String(post.excerpt || '')).trim();
  if (excerpt) {
    html = html.replace(
      '<p class="hidden ed-standfirst" id="post-excerpt"></p>',
      `<p class="ed-standfirst" id="post-excerpt">${excerpt}</p>`
    );
  }

  // The post's own cover, or no cover block at all - there is no default cover.
  if (post.cover_image) {
    const cover = derivUrl(post.cover_image, 'w1280');
    html = html.replace(/<img\b([^>]*)id="post-cover"([^>]*)>/, (tag) =>
      tag.includes('src=') ? tag : tag.replace('<img', `<img src="${escapeHtml(cover)}"`).replace('alt=""', `alt="${escapeHtml(post.title || '')}"`)
    );
  } else {
    html = html.replace('<div class="ed-cover w-full">', '<div class="ed-cover w-full hidden">');
  }

  html = html.replace(
    /(<div class="prose-content[^"]*" id="post-body">)(<\/div>)/,
    (m, open, close) => `${open}${renderBodyHtml(post.content)}${close}`
  );

  // The article is real content now: show it and drop the loading line, the
  // same two toggles post.js makes once its fetch lands.
  html = html.replace('<p id="loading-msg" class="text-on-surface-variant text-center">', '<p id="loading-msg" class="hidden text-on-surface-variant text-center">');
  html = html.replace('<div id="post-content" class="hidden flex flex-col gap-lg">', '<div id="post-content" class="flex flex-col gap-lg">');
  return { html, found: true };
}

module.exports = { fillHomeLinks, fillViewallList, fillPostBody };

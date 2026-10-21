document.getElementById('footer-year').textContent = new Date().getFullYear();

// Surface a clear message if the Google OAuth callback failed
(function showAuthErrorIfAny() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('auth_error') === 'google') {
    alert('Đăng nhập bằng Google thất bại. Vui lòng thử lại hoặc dùng email/mật khẩu.');
    params.delete('auth_error');
    const cleanUrl = window.location.pathname + (params.toString() ? `?${params}` : '');
    window.history.replaceState({}, '', cleanUrl);
  }
})();

// The homepage shows a lead article, a "Đọc nhiều nhất" rail beside it, and a
// mosaic grid of further posts below - see loadHome(). Browsing, filtering by
// tag and searching all live on /viewall.html, so a ?tag= / ?q= link that
// still points here (older bookmarks, tag chips on post pages) is forwarded
// there instead of being rendered on the homepage.
(function forwardFiltersToViewAll() {
  const params = new URLSearchParams(window.location.search);
  const tag = params.get('tag');
  const q = params.get('q');
  if (!tag && !q) return;
  const target = new URLSearchParams();
  if (tag) target.set('tag', tag);
  if (q) target.set('q', q);
  window.location.replace(`/viewall.html?${target}`);
})();

// A card for the mosaic grid below the lead/rail - same shape as
// viewall.js's postCard(), kept as its own (short) copy rather than shared:
// the homepage card carries no hashtag row, viewall's carries no author line,
// and a shared helper parameterised for both differences would be harder to
// read than the two cards it replaces.
// p.excerpt IS escapeHtml()'d below, unlike an earlier version of this card:
// the server now always hands back PLAIN text for a list-shaped response
// (attachExcerptFallback, server/excerpt.js) - even an excerpt the author
// wrote with the excerpt field's own bold/italic/link toolbar is flattened
// there, because a paste into that field could carry whole <h2>/<p>/<div>
// wrappers of its own that -webkit-line-clamp does not truncate across, the
// bug that could make one card run several paragraphs long instead of 3
// lines. Escaping is therefore no longer optional here: plain text can still
// contain a literal "<" or "&" (decoded back from an entity on the way out
// of that same helper), and rendering it unescaped would parse a stray "<"
// as the start of a tag instead of showing it.
function moreCard(p) {
  // No cover of its own -> no picture at all (there is no default cover any
  // more): the tag chip moves from the photo's corner to the top of the text.
  const media = p.cover_image
    ? `<div class="overflow-hidden relative flex-shrink-0">
      <img alt="" class="ed-photo group-hover:scale-105 transition-transform duration-500" src="${escapeHtml(derivUrl(p.cover_image, 'w1280'))}" loading="lazy" decoding="async">
      <span class="absolute top-sm left-sm ed-chip ed-chip--on-media">${escapeHtml(p.tag)}</span>
    </div>`
    : '';
  const chip = p.cover_image ? '' : `<span class="ed-chip self-start">${escapeHtml(p.tag)}</span>`;
  return `
  <article class="ed-panel rounded overflow-hidden group cursor-pointer flex flex-col${p.cover_image ? '' : ' ed-card--text'}" data-goto="/post.html?slug=${encodeURIComponent(p.slug)}">
    ${media}
    <div class="p-sm sm:p-md flex flex-col flex-grow gap-2">
      ${chip}
      <h3 class="ed-story-title--sm line-clamp-2"><a class="ed-card-link" href="/post.html?slug=${encodeURIComponent(p.slug)}">${escapeHtml(p.title)}</a></h3>
      <p class="ed-excerpt line-clamp-3">${escapeHtml(p.excerpt || '')}</p>
      <div class="ed-byline pt-1 mt-auto">
        <img class="ed-byline-avatar" src="${escapeHtml(derivUrl(p.author?.avatar_url || '', 'thumb'))}" alt="" loading="lazy" decoding="async">
        <span>${escapeHtml(p.author?.name || 'Ẩn danh')}</span>
        <span class="ed-byline-dot">·</span>
        <span>${timeAgoVi(p.created_at)}</span>
      </div>
    </div>
  </article>`;
}

async function loadHome() {
  const loading = document.getElementById('latest-loading');
  const errorEl = document.getElementById('latest-error');
  const gridEl = document.getElementById('latest-grid');
  const emptyEl = document.getElementById('posts-empty');
  const moreSection = document.getElementById('more-section');
  const moreGrid = document.getElementById('more-grid');

  try {
    // getSiteSettings() shares api.js's cached fetch - no extra round-trip even
    // though loadSiteSettings() awaits the same promise above the fold.
    // Two independent lists, not one: "mới nhất" and "đọc nhiều nhất" answer
    // different questions (server/routes/posts.js's `sort` param, ORDER BY
    // created_at vs views), so there is no single query that produces both -
    // fetched together rather than one after the other, since neither depends
    // on the other's result.
    const [{ posts: newest }, { posts: mostReadRaw }, siteSettings] = await Promise.all([
      API.listPosts({ limit: 7 }),
      API.listPosts({ limit: 8, sort: 'views' }),
      getSiteSettings(),
    ]);
    loading.classList.add('hidden');

    if (!newest.length) {
      emptyEl.classList.remove('hidden');
      return;
    }

    const [lead, ...rest] = newest;
    gridEl.classList.remove('hidden');
    // The post's own cover, or no picture at all - there is no default cover.
    const leadImg = document.getElementById('latest-image');
    if (lead.cover_image) leadImg.src = derivUrl(lead.cover_image, 'w1280');
    leadImg.parentElement.classList.toggle('hidden', !lead.cover_image);
    const tagEl = document.getElementById('latest-tag');
    tagEl.textContent = lead.tag;
    tagEl.onclick = (e) => {
      e.stopPropagation();
      window.location.href = `/viewall.html?tag=${encodeURIComponent(lead.tag)}`;
    };
    // A real link, not just the card's onclick: crawlers follow <a href> only.
    const leadTitle = document.getElementById('latest-title');
    leadTitle.innerHTML = `<a class="ed-card-link" href="/post.html?slug=${encodeURIComponent(lead.slug)}">${escapeHtml(lead.title)}</a>`;
    // textContent, like every sibling here: the server (attachExcerptFallback,
    // server/excerpt.js) now always hands back plain text for this list-shaped
    // response, so there is no rich formatting left to preserve, and no risk
    // of a paste-derived <h2>/<p> wrapper escaping the line-clamp box the way
    // an innerHTML assignment could.
    document.getElementById('latest-excerpt').textContent = lead.excerpt || '';
    // thumb, not the original upload - same reason as render-html.js fillLeadCard().
    document.getElementById('latest-author-avatar').src = derivUrl(lead.author?.avatar_url || '', 'thumb');
    document.getElementById('latest-author-name').textContent = lead.author?.name || 'Ẩn danh';
    document.getElementById('latest-date').textContent = timeAgoVi(lead.created_at);
    document.getElementById('latest-main').onclick = (e) => {
      if (e.target.closest('a[href]')) return; // the title link navigates itself
      window.location.href = `/post.html?slug=${encodeURIComponent(lead.slug)}`;
    };

    // Nothing shown twice: the lead is removed from contention first, then
    // "đọc nhiều nhất" gets first pick of what is left (it is the more
    // deliberate ranking), and the mosaic grid below fills in from whatever
    // neither of those claimed.
    const usedIds = new Set([lead.id]);
    const mostRead = mostReadRaw.filter((p) => !usedIds.has(p.id)).slice(0, 4);
    mostRead.forEach((p) => usedIds.add(p.id));

    const mostReadBlock = document.getElementById('most-read-block');
    // Under ~4 total posts on the whole site, "đọc nhiều nhất" would just be
    // "mới nhất" read back a second time - the rail earns its place only once
    // there is a real second ranking to show.
    if (mostRead.length < 2) {
      mostReadBlock.classList.add('hidden');
      document.getElementById('latest-grid').classList.add('ed-grid--single');
    } else {
      mostReadBlock.classList.remove('hidden');
      document.getElementById('latest-secondary').innerHTML = mostRead
        .map(
          (p, i) => `
        <article class="ed-story-item group cursor-pointer flex gap-3" data-goto="/post.html?slug=${encodeURIComponent(p.slug)}">
          <span class="ed-mono ed-icon-faint" style="font-size: 1.25rem; line-height: 1">${String(i + 1).padStart(2, '0')}</span>
          <div class="min-w-0">
            <span class="ed-chip" data-goto-tag="${escapeHtml(p.tag)}">${escapeHtml(p.tag)}</span>
            <h3 class="ed-story-title--sm mt-1.5 mb-1.5 line-clamp-2"><a class="ed-card-link" href="/post.html?slug=${encodeURIComponent(p.slug)}">${escapeHtml(p.title)}</a></h3>
            <div class="ed-byline pt-1"><span>${Number(p.views) || 0} lượt xem</span></div>
          </div>
        </article>`
        )
        .join('');
    }

    // The mosaic grid: whatever is left of the newest-first list once the
    // lead and the rail have taken theirs, so a reader who has seen those two
    // does not see them a third time scrolling further down. On a small
    // catalogue the rail can legitimately claim every post that isn't the
    // lead (as here, with 4 posts total: 1 lead + 3 in "đọc nhiều nhất"),
    // which left NOTHING for this section - not "no more posts", just none
    // left un-shown - and the "Bài viết mới nhất" heading + "Xem tất cả" link
    // vanished with it. Falling back to `rest` itself (accepting the small
    // overlap with the rail) keeps the section - and that link - present
    // whenever there is more than just the lead post, which is the point of
    // it: a reader who scrolls into the archive is going to see all of them
    // on /viewall.html two clicks later either way.
    let more = rest.filter((p) => !usedIds.has(p.id));
    if (!more.length && rest.length) more = rest;
    if (more.length) {
      moreGrid.innerHTML = more.map(moreCard).join('');
      moreSection.classList.remove('hidden');
    }

    initScrollReveal();
  } catch (e) {
    loading.classList.add('hidden');
    errorEl.textContent = `Không thể tải bài viết: ${e.message}`;
    errorEl.classList.remove('hidden');
  }
}

// Fades + slides the latest-posts section into view as it enters the viewport.
// Uses IntersectionObserver (no extra library) and unobserves the section
// once revealed so the animation only plays once per page load.
// threshold is 0 on purpose: on phones the stacked hero can be taller than the
// viewport, leaving only a sliver (or nothing) of this section on screen at
// load. The old threshold: 0.1 + -40px bottom margin then kept the whole
// section invisible until the user scrolled - the homepage looked broken with
// a blank gap under the hero. With 0, anything already touching the viewport
// reveals immediately on load.
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
    { threshold: 0 }
  );
  targets.forEach((el) => observer.observe(el));
}
loadHome();

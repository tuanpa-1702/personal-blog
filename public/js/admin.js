// UI-only: the footer year (all API/auth logic stays in /js/api.js + /js/admin.js).
document.getElementById('footer-year').textContent = new Date().getFullYear();

async function initAdmin() {
  if (!Auth.isAdmin()) {
    document.getElementById('not-admin').classList.remove('hidden');
    document.getElementById('not-admin').classList.add('flex');
    return;
  }
  document.getElementById('admin-app').classList.remove('hidden');

  const user = Auth.getUser();
  document.getElementById('admin-avatar').src = user.avatar_url;
  document.getElementById('admin-name').textContent = user.name;

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  // These five used to be inline onclick="" attributes - a legacy of the Stitch
  // HTML export - which is what kept the CSP's script-src stuck on
  // 'unsafe-inline' (see server/security-headers.js). Wired here instead, the
  // same way every other button on this page already is.
  document.getElementById('activity-refresh-btn')?.addEventListener('click', () => loadActivity());
  document.getElementById('recent-posts-view-all-btn')?.addEventListener('click', () => switchTab('posts'));
  document.getElementById('add-user-open-btn')?.addEventListener('click', () => openAddUserModal());
  document.getElementById('add-user-cancel-btn')?.addEventListener('click', () => closeAddUserModal());
  document.getElementById('reset-password-cancel-btn')?.addEventListener('click', () => closeResetPasswordModal());
  document.getElementById('change-author-cancel-btn')?.addEventListener('click', () => closeChangeAuthorModal());
  initAuthorPhotoControl();
  initFaviconControl();
  initActivityControls();
  initUsersControls();
  initChangeAuthorControls();
  initAddUserRoleField();
  initEmailSettingsControls();
  initTrashControls();
  initNotificationControls();
  // Fill the rail's two badges without opening either tab. Not awaited: the tab's
  // own load is what the first paint of this page waits on, and a count is not.
  loadTrashCounts();
  loadNotificationCount();
  // Returning from the Microsoft consent redirect lands on #email, so open that
  // tab instead of the default - otherwise the result message is on a hidden panel.
  // #media is here so the editor's "quản lí thư viện" link can deep-link into it.
  // #trash is here for the same reason: a delete elsewhere can link an admin
  // straight to the bin.
  // #notifications is the CTA in the admin event mail (mailer.js), which has to
  // land on the inbox rather than on Tổng quan for the mail to be worth sending.
  // #overview/#posts/#users/#settings added alongside the four above so every
  // tab has a real hash to deep-link to - the header's avatar dropdown links
  // to all seven now on mobile, where the rail itself is hidden (see
  // renderNavAuthState() in js/api.js and the #admin-app media query in
  // editorial.css). '#overview' was already the fallback for an unrecognised
  // hash, so listing it here is for symmetry with the dropdown's own href,
  // not a behaviour change.
  const HASH_TABS = {
    '#overview': 'overview',
    '#email': 'email',
    '#media': 'media',
    '#trash': 'trash',
    '#notifications': 'notifications',
    '#posts': 'posts',
    '#users': 'users',
    '#settings': 'settings',
  };
  switchTab(HASH_TABS[window.location.hash] || 'overview');
  // Without this, a #hash link clicked from INSIDE admin.html (the header
  // dropdown's tab links, now the only way to reach a tab on mobile - see
  // renderNavAuthState() in js/api.js) changed the URL and nothing else: the
  // line above only runs once, at load, so it never saw a hash that arrived
  // after. Navigating IN from elsewhere still worked regardless - that is a
  // fresh load, and this same line runs again - which is exactly the gap
  // profile.html's own showPanelFromHash()/hashchange pair closes for its
  // panels.
  window.addEventListener('hashchange', () => {
    switchTab(HASH_TABS[window.location.hash] || 'overview');
    // Closes the header's avatar dropdown after a #hash jump from one of its
    // own tab links - see the comment on this same fix in js/api.js for why
    // it happens here (after the jump) rather than inside the link's own
    // click handler.
    document.getElementById('user-dropdown-menu')?.classList.add('hidden');
  });
}

function switchTab(tab) {
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
  document.getElementById(`tab-${tab}`).classList.remove('hidden');
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  // Back to the reference row's position - "Tổng quan" - so the rail is in the
  // same place on every tab. See resetSideRailScroll() in js/api.js.
  resetSideRailScroll();

  if (tab === 'overview') loadOverview();
  if (tab === 'posts') loadAllPosts();
  // The library is in js/media.js, shared with write.html's picker. Loaded on first
  // open rather than at startup: an admin who never opens this tab should not pay
  // for a listing request, and the grid re-reads anyway on every open so a file
  // uploaded from the editor shows up here without a reload.
  if (tab === 'media') loadMedia();
  if (tab === 'users') loadUsers();
  if (tab === 'settings') loadSettings();
  if (tab === 'email') loadEmailSettings();
  // Re-read on every open, at the page it was left on: a delete made from the
  // Posts tab or from a post page has to be visible here without a reload, and the
  // render clamps the page if the folder has since shrunk. The message about the
  // last action goes, because coming back to the tab is a fresh look at it.
  if (tab === 'trash') {
    trashMsg('');
    loadTrash(trashPage);
  }
  // Also re-read at the page and the filter it was left on: this is the tab an
  // admin returns to after following a row's link to the post, and coming back to
  // page 1 of "Tất cả" would lose both the place and the question.
  if (tab === 'notifications') {
    notifMsg('');
    loadNotifications(notifPage);
  }
}

async function loadOverview() {
  // Kicked off outside the try below: the two fetches are independent, so a
  // failing stats call must not leave the activity card stuck on "Đang tải...".
  // Page 1 because opening the tab is arriving at the feed, not returning to a page
  // of it you had turned to earlier - the refresh button inside the card is what keeps
  // its place.
  loadActivity(1);
  try {
    const stats = await API.adminStats();
    document.getElementById('stat-views').textContent = stats.totalViews.toLocaleString('vi-VN');
    document.getElementById('stat-published').textContent = stats.totalPublished;
    document.getElementById('stat-draft').textContent = `${stats.totalDraft} bản nháp`;
    document.getElementById('stat-subs').textContent = stats.totalNotifyEnabled;
    document.getElementById('stat-users').textContent = `${stats.totalUsers} người dùng`;

    const recent = stats.recentPosts;
    document.getElementById('recent-posts-list').innerHTML = recent
      .map(
        (p) => `
      <div class="recent-row p-4 sm:p-6 flex flex-wrap sm:flex-nowrap items-start sm:items-center gap-3 justify-between group" data-goto="/post.html?slug=${encodeURIComponent(p.slug)}">
        <div class="min-w-0 flex-1">
          <h4 class="font-headline-sm text-headline-sm text-on-background group-hover:text-primary transition-colors line-clamp-2">${escapeHtml(p.title)}</h4>
          <div class="flex flex-wrap gap-x-3 gap-y-1 mt-1 items-center font-body-sm text-body-sm text-on-surface-variant">
            <span>${escapeHtml(p.author_name)}</span><span>·</span><span>${timeAgoVi(p.created_at)}</span><span>·</span>
            <span class="flex items-center gap-1"><span class="material-symbols-outlined text-[16px]">visibility</span>${p.views}</span>
          </div>
        </div>
        <span class="chip font-label-caps text-[10px] px-2 py-1 rounded-full flex-shrink-0">${escapeHtml(p.tag)}</span>
      </div>`
      )
      .join('') || '<p class="p-6 text-on-surface-variant">Chưa có bài viết nào.</p>';

    // The card's footer: how much of the library those ten posts are. Without it there
    // is no way to tell ten of twelve from ten of four hundred, and this list has no
    // pager to imply it - "Xem tất cả" in the heading is the way to the rest.
    const recentFoot = document.getElementById('recent-posts-foot');
    const recentRange = document.getElementById('recent-posts-range');
    if (recentFoot && recentRange) {
      const totalPosts = (stats.totalPublished || 0) + (stats.totalDraft || 0);
      recentFoot.classList.toggle('hidden', !recent.length);
      recentRange.textContent =
        recent.length < totalPosts
          ? `${recent.length} bài mới nhất trong tổng số ${totalPosts}`
          : `${recent.length} bài viết`;
    }
  } catch (e) {
    alert(e.message);
  }
}

// ---- Overview: "Hoạt động gần đây" ----

// Describes one feed row: which icon and tint the badge gets, plus the sentence
// beside it. Kept in one place so the three can never disagree - a dislike must
// not render with the indigo "like" badge. The colours match the reaction pills
// on a post (indigo = like, red = dislike) so both surfaces read the same way.
function activityKind(row) {
  // A recorded deletion, and it is tested FIRST: the log row carries value 0, and 0 is
  // not 1, so the reaction branches below would read it as somebody disliking a
  // comment. The one row in this feed that is not a vote must not be described as one.
  if (row.kind === 'post_deleted') {
    return { icon: 'delete', badge: 'activity-badge--deleted', verb: 'đã xoá bài viết' };
  }
  const isLike = row.value === 1;
  if (row.kind === 'comment') {
    return { icon: 'chat_bubble', badge: 'activity-badge--comment', verb: 'đã bình luận trong' };
  }
  const reaction = {
    icon: isLike ? 'thumb_up' : 'thumb_down',
    badge: isLike ? '' : 'activity-badge--dislike',
  };
  if (row.kind === 'post_reaction') {
    return { ...reaction, verb: isLike ? 'đã thích bài viết' : 'không thích bài viết' };
  }
  return {
    ...reaction,
    verb: isLike ? 'đã thích một bình luận trong' : 'không thích một bình luận trong',
  };
}

function activityRowHtml(row) {
  const { icon, badge, verb } = activityKind(row);
  const avatar = row.user_avatar
    ? `<img class="activity-avatar" alt="" src="${escapeHtml(row.user_avatar)}">`
    : `<span class="activity-avatar flex items-center justify-center text-primary material-symbols-outlined text-[20px]">person</span>`;
  // A deletion's second line is facts about the post that was lost - "Bài đã đăng ·
  // 1.204 lượt xem", written by describePost() in server/activity-log.js - not words
  // somebody wrote, so it takes .activity-note: no quote bar and no italic, both of
  // which would read as somebody's voice. Only the two comment kinds carry a quote.
  const deleted = row.kind === 'post_deleted';
  const second = row.excerpt
    ? `<span class="${deleted ? 'activity-note' : 'activity-quote'} font-body-sm text-body-sm">${escapeHtml(row.excerpt)}</span>`
    : '';
  // Spans throughout: the row itself is the <a>, and an <a> may not hold a block.
  const inner = `
      <span class="activity-figure">
        ${avatar}
        <span class="activity-badge ${badge}"><span class="material-symbols-outlined">${icon}</span></span>
      </span>
      <span class="min-w-0 flex-1">
        <span class="block font-body-sm text-body-sm text-on-surface">
          <b class="font-semibold">${escapeHtml(row.user_name || 'Không rõ')}</b> ${verb}
          <b class="font-semibold text-primary">${escapeHtml(row.post_title)}</b>
        </span>
        ${second}
        <span class="block font-body-sm text-[12px] text-on-surface-variant mt-1">${timeAgoVi(row.created_at)}</span>
      </span>`;
  // A deletion gets a <div>, NOT an <a>: the post it names no longer exists, so the
  // link would be a 404 wearing the title of the thing just clicked. .activity-row--static
  // takes the affordances back off - no pointer, no hover tint - so the two kinds of row
  // still line up in the feed and only the clickable one says it is clickable.
  return deleted
    ? `<div class="activity-row activity-row--static">${inner}
    </div>`
    : `<a class="activity-row" href="/post.html?slug=${encodeURIComponent(row.post_slug)}">${inner}
    </a>`;
}

// Ten rows a page, matching the server's own default and the ten posts in the card
// beside it. The feed is a glance surface: an unbounded list pushed the recent-posts
// card off the first screen once anybody had commented a few times.
const ACTIVITY_PAGE_SIZE = 10;
let activityPage = 1;

// Loaded separately from the stats so a failure in one does not blank the other,
// and so the card's refresh button can re-fetch just this list.
//
// `page` defaults to the page already on screen, which is what makes the refresh
// button honest - it re-reads where you are - while loadOverview() passes 1 to open
// the tab at the top of the feed.
async function loadActivity(page = activityPage) {
  const list = document.getElementById('activity-list');
  activityPage = page;
  try {
    const { activity, total } = await API.adminActivity(page, ACTIVITY_PAGE_SIZE);
    const totalPages = Math.max(1, Math.ceil(total / ACTIVITY_PAGE_SIZE));
    // The feed moves under its own pager: comments arrive and posts are deleted between
    // the numbers being drawn and one being clicked, so the page you asked for can have
    // stopped existing. The server answers that with an empty list rather than an error,
    // and stepping back is what the media grid does in the same situation - an empty card
    // with page numbers under it reads as a broken one. Strictly decreasing, so it ends.
    if (!activity.length && page > 1) return loadActivity(Math.min(page - 1, totalPages));
    list.innerHTML =
      activity.map(activityRowHtml).join('') ||
      '<p class="p-3 font-body-sm text-body-sm text-on-surface-variant">Chưa có hoạt động nào.</p>';
    renderActivityFoot(total, page, totalPages);
  } catch (e) {
    list.innerHTML = `<p class="p-3 font-body-sm text-body-sm text-error">${escapeHtml(e.message)}</p>`;
    // Nothing to count and no page to turn, so the footer goes too: leaving it would
    // show a stale "11–20 / 42" under an error message that contradicts it.
    renderActivityFoot(0, 1, 1);
  }
}

// What the card is showing, and the numbers under it. The whole footer is hidden when
// there is nothing to say - a hairline under an empty card, with "0 / 0" beside a
// control that cannot do anything, is furniture.
function renderActivityFoot(total, page, totalPages) {
  const foot = document.getElementById('activity-foot');
  const range = document.getElementById('activity-range');
  const pager = document.getElementById('activity-pager');
  if (!foot || !range || !pager) return;

  if (!total) {
    foot.classList.add('hidden');
    range.textContent = '';
    pager.classList.add('hidden');
    pager.innerHTML = '';
    return;
  }

  foot.classList.remove('hidden');
  const from = (page - 1) * ACTIVITY_PAGE_SIZE + 1;
  const to = Math.min(page * ACTIVITY_PAGE_SIZE, total);
  range.textContent = `${from}–${to} / ${total} hoạt động`;

  // One page is not a choice, so the numbers stay hidden rather than offering a control
  // that cannot do anything - the same rule the library's pager applies.
  if (totalPages <= 1) {
    pager.classList.add('hidden');
    pager.innerHTML = '';
    return;
  }
  pager.classList.remove('hidden');
  pager.innerHTML = pagerHtml(page, totalPages, 'data-activity-page');
}

// The activity pager's clicks. Delegated on the <nav> rather than on each pill:
// loadActivity() replaces the pills every time it draws a page, and the <nav> itself
// is part of the page, so one listener outlives all of them.
//
// Wired from initAdmin() rather than at the top level, for the reason given at
// initUsersControls(): a throw up there would stop the initAdmin() call at the end of
// this file from ever being reached, blanking every tab of the panel.
function initActivityControls() {
  const pager = document.getElementById('activity-pager');
  if (!pager) return;
  pager.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-activity-page]');
    if (!btn || btn.disabled) return;
    const target = Number(btn.dataset.activityPage);
    if (target === activityPage) return;
    loadActivity(target);
    // On a narrow screen the pager sits below the ten rows it just replaced, so without
    // this a click on "3" leaves the reader looking at numbers instead of at the rows
    // that changed. 'nearest' rather than 'start': on a wide screen the card is already
    // in view and the page must not jump for a click that changed ten rows in place.
    const list = document.getElementById('activity-list');
    if (list) list.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

// ---------------- Admin notifications (Admin > Thông báo) ----------------
//
// The inbox, as against the feed above it. Both talk about comments and neither
// can stand in for the other: the feed is unioned out of four tables on every
// read and knows nothing about unread, while these are real rows with a read
// state, four kinds of event, and - on a report - the buttons to act on it.

// Icon, badge tint and the verb that goes between the actor's name and the post
// title, per kind. `takesPost` says whether the sentence ends in a post at all:
// a new account has nothing to do with one, and "vừa đăng ký tài khoản trong
// <b>Bài viết</b>" would be a sentence about nothing.
const NOTIF_KINDS = {
  comment_reported: {
    icon: 'flag',
    badge: 'notification-badge--reported',
    verb: 'báo cáo một bình luận trong',
    takesPost: true,
  },
  new_comment: {
    icon: 'chat_bubble',
    badge: 'notification-badge--comment',
    verb: 'để lại bình luận trong',
    takesPost: true,
  },
  new_user: { icon: 'person_add', badge: 'notification-badge--user', verb: 'vừa đăng ký tài khoản', takesPost: false },
  comment_hidden: {
    icon: 'visibility_off',
    badge: 'notification-badge--hidden',
    verb: 'đã ẩn một bình luận trong',
    takesPost: true,
  },
};

function notificationKind(row) {
  // Both directions of the audit entry are ONE kind, told apart by `action`, so
  // the icon and the verb are decided here rather than read off the table: a
  // "bỏ ẩn" wearing the eye-with-a-slash would say the opposite of what happened.
  if (row.kind === 'comment_hidden') {
    const unhide = row.action === 'unhide';
    return {
      ...NOTIF_KINDS.comment_hidden,
      icon: unhide ? 'visibility' : 'visibility_off',
      verb: unhide ? 'đã bỏ ẩn một bình luận trong' : 'đã ẩn một bình luận trong',
    };
  }
  // notifications.record() drops a kind it does not know, so this is the row that
  // can only appear if the server is newer than this file - which is exactly when
  // a blank badge and an `undefined` in the sentence would be least forgivable.
  return NOTIF_KINDS[row.kind] || { icon: 'notifications', badge: '', verb: row.kind || '—', takesPost: false };
}

function notificationSentenceHtml(row, linkable) {
  const { verb, takesPost } = notificationKind(row);
  const who = `<b class="font-semibold">${escapeHtml(row.actor_name || 'Không rõ')}</b>`;
  if (!takesPost) return `${who} ${escapeHtml(verb)}`;
  // The post is a real link only while the post exists: a notification snapshots
  // it, and linking a title whose post has since been trashed sends the admin to a
  // 404 wearing that title - the reason activityRowHtml() refuses to link a
  // deletion. And it is a link only when the ROW is not one: an <a> inside an <a>
  // is invalid, and the browser's parser repairs it by closing the row early and
  // hoisting the title out of the flex layout - which is what a nested anchor
  // looked like on screen before this check existed. A linked row therefore
  // carries the title as coloured text, exactly as the activity feed does.
  const title = escapeHtml(row.post_title || 'bài viết');
  const post =
    row.post_slug && row.post_live !== false
      ? linkable
        ? `<b class="font-semibold text-primary">${title}</b>`
        : `<a class="font-semibold text-primary hover:underline" href="/post.html?slug=${encodeURIComponent(
            row.post_slug
          )}">${title}</a>`
      : `<b class="font-semibold">${title}</b>`;
  return `${who} ${escapeHtml(verb)} ${post}`;
}

// The second line: the words at the centre of the event. What `excerpt` holds
// differs per kind - see notifications.record() - and for the two kinds that name
// a comment the CURRENT text is joined live by the list endpoint as
// `comment_excerpt`, so a report shows the words as they stand rather than as a
// snapshot taken when somebody complained about them.
function notificationDetailHtml(row) {
  const quote = (text) =>
    `<span class="activity-quote font-body-sm text-body-sm">${escapeHtml(
      String(text || '').trim() || '(Bình luận không còn nội dung để hiển thị.)'
    )}</span>`;

  if (row.kind === 'comment_reported') {
    // row.excerpt on a report is the REPORTER'S note, not the comment.
    const note = String(row.excerpt || '').trim();
    return (
      quote(row.comment_excerpt) +
      `<span class="block font-body-sm text-[12px] text-on-surface-variant mt-1">Lý do: <b class="font-semibold text-error">${escapeHtml(
        row.reason || '—'
      )}</b>${note ? ` · Ghi chú: “${escapeHtml(note)}”` : ''}</span>`
    );
  }
  if (row.kind === 'new_comment') return quote(row.comment_excerpt || row.excerpt);
  if (row.kind === 'comment_hidden') return quote(row.comment_excerpt);
  // A new account's second line is its address - a fact about the row, not
  // somebody's words, so no quote bar and no italic (see .activity-note).
  if (row.excerpt) {
    return `<span class="block font-body-sm text-[12px] text-on-surface-variant mt-1">${escapeHtml(row.excerpt)}</span>`;
  }
  return '';
}

// The moderation buttons, on a report row only: it is the one kind that is asking
// for a decision. A hide and a resolve are two different answers and stay two
// separate rows of state - hiding does not mark the report resolved, because an
// admin may resolve one by deciding the comment is fine.
function notificationActionsHtml(row) {
  if (row.kind !== 'comment_reported' || row.comment_id == null) return '';
  const btn = (action, icon, label, danger) =>
    `<button type="button" class="notif-action-btn${
      danger ? ' notif-action-btn--danger' : ''
    }" data-notif-action="${action}"><span class="material-symbols-outlined" aria-hidden="true">${icon}</span>${label}</button>`;
  const parts = [
    row.comment_hidden
      ? btn('unhide', 'visibility', 'Bỏ ẩn', false)
      : btn('hide', 'visibility_off', 'Ẩn bình luận', true),
  ];
  if (row.report_id != null) {
    parts.push(
      row.report_status === 'resolved'
        ? // Already answered: a span in the button's clothes, not a disabled button,
          // because "this needs nothing" is a state of the report and not of the UI.
          `<span class="notif-action-btn text-tertiary-container"><span class="material-symbols-outlined" aria-hidden="true">check_circle</span>Đã xử lý</span>`
        : btn('resolve', 'check_circle', 'Đã xử lý', false)
    );
  }
  return `<span class="flex items-center gap-1 flex-wrap mt-1.5">${parts.join('')}</span>`;
}

function notificationRowHtml(row) {
  const { icon, badge } = notificationKind(row);
  // Built once and tested for emptiness below: whether the row has buttons decides
  // whether the row may be a link, so it cannot be computed twice and hope.
  const actions = notificationActionsHtml(row);
  // A report row holds buttons, and a <button> inside an <a> is both invalid and a
  // click that navigates instead of acting - so that row is a <div> and the post
  // title inside it carries the link. Same for a row with nowhere to go.
  // Computed BEFORE the markup, because the sentence has to know which it is: an
  // <a> for the title inside a linked row is a nested anchor, which the browser
  // silently repairs by closing the row early.
  const linkable = !actions && row.post_slug && row.post_live !== false;
  // Notifications carry no avatar: the row is about an event, and the badge on the
  // figure says which. The generic person is the same one activityRowHtml() falls
  // back to when a commenter has no picture.
  const inner = `
      <span class="activity-figure">
        <span class="activity-avatar flex items-center justify-center text-primary material-symbols-outlined text-[20px]">person</span>
        <span class="notification-badge ${badge}"><span class="material-symbols-outlined">${icon}</span></span>
      </span>
      <span class="min-w-0 flex-1">
        <span class="block font-body-sm text-body-sm text-on-surface">${notificationSentenceHtml(row, linkable)}</span>
        ${notificationDetailHtml(row)}
        <span class="block font-body-sm text-[12px] text-on-surface-variant mt-1">${timeAgoVi(row.created_at)}</span>
        ${actions}
      </span>`;
  // Spans throughout, and the unread bar is box-shadow rather than a background:
  // see the .notification-row--unread rule in admin.html for both reasons.
  const cls = `notification-row${row.read_at ? '' : ' notification-row--unread'}`;
  const data =
    `data-notif-id="${Number(row.id)}" data-read="${row.read_at ? 1 : 0}"` +
    `${row.comment_id != null ? ` data-comment-id="${Number(row.comment_id)}"` : ''}` +
    `${row.report_id != null ? ` data-report-id="${Number(row.report_id)}"` : ''}`;
  return linkable
    ? `<a class="${cls}" ${data} href="/post.html?slug=${encodeURIComponent(row.post_slug)}">${inner}
    </a>`
    : `<div class="${cls} notification-row--static" ${data}>${inner}
    </div>`;
}

const NOTIF_PAGE_SIZE = 10;
let notifPage = 1;
let notifFilter = '';
let notifUnread = 0;
let notifBusy = false;

// Called once at startup, apart from the tab, for the reason loadTrashCounts()
// gives: the badge is the whole use of the count, and it should say something
// before anybody clicks anything.
async function loadNotificationCount() {
  try {
    const { unread } = await API.adminNotificationCount();
    applyNotificationCount(unread);
  } catch (e) {
    // A badge that failed to load is not worth an alert on page open; the tab
    // itself reports the real error when it is opened.
  }
}

function applyNotificationCount(unread) {
  notifUnread = Math.max(0, Number(unread) || 0);
  const badge = document.getElementById('notif-rail-badge');
  if (!badge) return;
  badge.textContent = notifUnread > 99 ? '99+' : String(notifUnread);
  // .hidden is emitted AFTER .flex in tailwind.css, so it wins while it is on the
  // element; dropping it leaves the `flex` already in the class list to shape it.
  badge.classList.toggle('hidden', notifUnread === 0);
}

async function loadNotifications(page = notifPage) {
  const list = document.getElementById('notification-list');
  if (!list) return;
  notifPage = Math.max(1, Number(page) || 1);
  // Does NOT clear #notif-msg, exactly as loadTrash() does not: the callers that
  // have something to say say it after the reload, and switching back to the tab
  // is the one navigation that clears it.
  list.innerHTML = '<p class="p-6 font-body-md text-body-md text-on-surface-variant">Đang tải...</p>';
  try {
    const data = await API.adminNotifications(notifPage, NOTIF_PAGE_SIZE, notifFilter);
    applyNotificationCount(data.unread);
    // Taking the server's page is what keeps the pager and the rows agreeing when
    // a page past the end was asked for - marking everything read under a filter
    // can empty the page you were on.
    notifPage = Math.max(1, Number(data.page) || notifPage);
    renderNotifications(data);
  } catch (e) {
    const pager = document.getElementById('notification-pager');
    const count = document.getElementById('notification-count');
    if (count) count.textContent = '';
    if (pager) {
      pager.classList.add('hidden');
      pager.innerHTML = '';
    }
    list.innerHTML = `<p class="p-6 font-body-md text-body-md text-error">${escapeHtml(userActionError(e))}</p>`;
  }
}

function renderNotifications(data) {
  const list = document.getElementById('notification-list');
  const count = document.getElementById('notification-count');
  const pager = document.getElementById('notification-pager');
  const items = Array.isArray(data.notifications) ? data.notifications : [];
  const total = Number(data.total) || 0;

  // Clamped on EVERY render, as renderTrash() clamps: "Chưa đọc" under a filter
  // shrinks every time a row is read, and staying on a page that no longer exists
  // would draw an empty list with its own number still marked current.
  const totalPages = Math.max(1, Math.ceil(total / NOTIF_PAGE_SIZE));
  notifPage = Math.min(Math.max(1, notifPage), totalPages);
  const start = (notifPage - 1) * NOTIF_PAGE_SIZE;

  const emptyByFilter = {
    '': 'Chưa có thông báo nào.',
    unread: 'Không có thông báo chưa đọc.',
    comment_reported: 'Chưa có bình luận nào bị báo cáo.',
    new_comment: 'Chưa có bình luận mới nào.',
    new_user: 'Chưa có tài khoản mới nào.',
    comment_hidden: 'Chưa ẩn hay bỏ ẩn bình luận nào.',
  };
  list.innerHTML =
    items.map(notificationRowHtml).join('') ||
    `<p class="p-8 text-center font-body-md text-body-md text-on-surface-variant">${
      emptyByFilter[notifFilter] || 'Chưa có thông báo nào.'
    }</p>`;

  if (count) {
    count.textContent = !total
      ? emptyByFilter[notifFilter] || 'Chưa có thông báo nào'
      : `Hiển thị ${start + 1}–${start + items.length} trong ${total} thông báo${
          notifUnread ? ` · ${notifUnread} chưa đọc` : ''
        }`;
  }

  // One page is not a choice, so the numbers stay hidden rather than offering a
  // control that cannot do anything - the rule every pager here follows.
  if (pager) {
    if (totalPages <= 1) {
      pager.classList.add('hidden');
      pager.innerHTML = '';
    } else {
      pager.classList.remove('hidden');
      pager.innerHTML = pagerHtml(notifPage, totalPages, 'data-notif-page');
    }
  }
}

function notifMsg(text, isError) {
  const el = document.getElementById('notif-msg');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('hidden', !text);
  el.classList.toggle('text-error', Boolean(isError));
  el.classList.toggle('text-on-surface-variant', !isError);
}

function notifSetBusy(busy) {
  notifBusy = busy;
  document.querySelectorAll('#notification-list [data-notif-action]').forEach((btn) => {
    btn.disabled = busy;
  });
  // The header button sits outside the list, so it is not covered by the selector
  // above - and "đánh dấu tất cả đã đọc" mid-hide is two writes racing.
  const all = document.getElementById('notif-read-all');
  if (all) all.disabled = busy;
}

// Reading a row is what marks it read; there is no separate "unread" toggle, so a
// row that is already read is left alone rather than sent again.
async function markNotificationRead(el, id) {
  try {
    const res = await API.adminMarkNotificationRead(id);
    el.dataset.read = '1';
    el.classList.remove('notification-row--unread');
    applyNotificationCount(res.unread);
  } catch (e) {
    // Quietly: the row is open and readable either way, and the badge catches up
    // on the next load. An alert for a failed read-marker would be the alert that
    // teaches an admin to dismiss alerts.
  }
}

async function markAllNotificationsRead() {
  if (notifBusy) return;
  notifSetBusy(true);
  try {
    const res = await API.adminMarkAllNotificationsRead();
    applyNotificationCount(res.unread);
    await loadNotifications(notifPage);
    notifMsg(
      Number(res.changed) ? `Đã đánh dấu ${res.changed} thông báo là đã đọc.` : 'Không có thông báo chưa đọc nào.'
    );
  } catch (e) {
    notifMsg(userActionError(e), true);
  } finally {
    notifSetBusy(false);
  }
}

// Hiding from the inbox is the same action as hiding from the reading page, and
// carries the same warning: it takes the whole reply subtree with it.
async function notifHideComment(commentId, hidden) {
  if (notifBusy) return;
  if (
    hidden &&
    !confirm(
      'Ẩn bình luận này? Độc giả sẽ không thấy nó nữa và mọi trả lời bên dưới cũng bị ẩn theo. ' +
        'Tác giả vẫn thấy bình luận của mình kèm ghi chú đã bị ẩn, và bạn có thể bỏ ẩn bất cứ lúc nào.'
    )
  ) {
    return;
  }
  notifSetBusy(true);
  try {
    const res = await API.setCommentHidden(commentId, hidden);
    await loadNotifications(notifPage);
    const n = Number(res.affected) || 0;
    notifMsg(
      hidden
        ? `Đã ẩn bình luận cùng ${n} mục trong cả cây trả lời. Độc giả không thấy chúng nữa.`
        : `Đã bỏ ẩn ${n} bình luận. Chúng đã hiển thị trở lại.`
    );
  } catch (e) {
    // Reload as well as report: the usual cause is that another admin got there
    // first, and a row offering a button that no longer works is worse than a
    // refresh.
    await loadNotifications(notifPage);
    notifMsg(userActionError(e), true);
  } finally {
    notifSetBusy(false);
  }
}

async function notifResolveReport(reportId) {
  if (notifBusy) return;
  notifSetBusy(true);
  try {
    await API.adminSetReportStatus(reportId, 'resolved');
    await loadNotifications(notifPage);
    notifMsg('Đã đánh dấu báo cáo này là đã xử lý.');
  } catch (e) {
    await loadNotifications(notifPage);
    notifMsg(userActionError(e), true);
  } finally {
    notifSetBusy(false);
  }
}

function initNotificationControls() {
  const chips = document.getElementById('notif-filter-chips');
  const list = document.getElementById('notification-list');
  const pager = document.getElementById('notification-pager');
  const readAll = document.getElementById('notif-read-all');
  if (!chips || !list || !pager || !readAll) return;

  readAll.addEventListener('click', markAllNotificationsRead);

  // Delegated on the row that holds the chips, as the Users and Trash tabs do: one
  // listener outlives every re-render.
  chips.addEventListener('click', (e) => {
    const btn = e.target.closest('.user-chip');
    if (!btn) return;
    const filter = btn.dataset.filter || '';
    // A click on the filter already applied is not a request. The icon inside the
    // chip is a child of the button, so closest() still lands on the chip.
    if (filter === notifFilter) return;
    notifFilter = filter;
    notifPage = 1;
    chips.querySelectorAll('.user-chip').forEach((b) => b.classList.toggle('active', b === btn));
    // A different filter is a different question, so the answer to the last one -
    // "đã ẩn bình luận" - would be about a list that is no longer on screen.
    notifMsg('');
    loadNotifications(1);
  });

  list.addEventListener('click', async (e) => {
    const row = e.target.closest('[data-notif-id]');
    if (!row) return;
    const action = e.target.closest('[data-notif-action]');
    if (action) {
      if (action.disabled) return;
      // Both, because on a linked row the browser would otherwise navigate away
      // from the action it was asked to perform.
      e.preventDefault();
      e.stopPropagation();
      const commentId = Number(row.dataset.commentId);
      const reportId = Number(row.dataset.reportId);
      if (action.dataset.notifAction === 'resolve') {
        if (reportId) notifResolveReport(reportId);
      } else if (commentId) {
        notifHideComment(commentId, action.dataset.notifAction === 'hide');
      }
      return;
    }

    const id = Number(row.dataset.notifId);
    if (!id || row.dataset.read === '1') return;
    // A linked row navigates, and the mark-read has to be FINISHED before it does:
    // a fetch still in flight when the document unloads is dropped, and the admin
    // would come back to a row they had already read. Middle-click and the
    // modifier-clicks are left to the browser, which is why they are checked
    // rather than assumed.
    const href = row.tagName === 'A' ? row.getAttribute('href') : '';
    const plainClick = e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
    if (href && plainClick) e.preventDefault();
    await markNotificationRead(row, id);
    if (href && plainClick) window.location.assign(href);
  });

  pager.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-notif-page]');
    if (!btn || btn.disabled) return;
    const target = Number(btn.dataset.notifPage);
    if (!target || target === notifPage) return;
    notifMsg('');
    loadNotifications(target);
    // 'nearest' moves the page only if it must: on a wide screen the card is
    // already in view and must not jump for a click that replaced ten rows in place.
    list.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

async function loadAllPosts() {
  const list = document.getElementById('all-posts-list');
  try {
    const { posts } = await API.adminPosts();
    // Surfaces live in admin.html's <style>, so only the names appear here.
    // .post-row gives the row the hover its counterpart .user-row already has -
    // this row is the thing you click to open the post, and it had no hover at
    // all. .status-pill--draft replaces a solid bg-surface-container-high chip
    // sitting on a glass card; the reason is in the comment on that rule.
    list.innerHTML =
      posts
        .map(
          (p) => `
      <div class="post-row p-4 sm:p-6 flex items-center justify-between gap-3 sm:gap-4">
        <div class="min-w-0 flex-grow cursor-pointer" data-goto="/post.html?slug=${encodeURIComponent(p.slug)}">
          <div class="flex items-center gap-2 mb-1">
            <span class="chip px-2 py-0.5 rounded-full text-[10px] font-label-caps uppercase">${escapeHtml(p.tag)}</span>
            <span class="text-xs px-2 py-0.5 rounded-full ${p.status === 'published' ? 'bg-tertiary-fixed-dim/20 text-tertiary-container' : 'status-pill--draft'}">${p.status === 'published' ? 'Đã đăng' : 'Bản nháp'}</span>
          </div>
          <h4 class="font-headline-sm text-headline-sm text-on-background line-clamp-2 hover:text-primary">${escapeHtml(p.title)}</h4>
          <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">bởi ${escapeHtml(p.author_name)} · ${timeAgoVi(p.created_at)} · ${p.views} lượt xem</p>
        </div>
        <div class="flex items-center gap-2 flex-shrink-0">
          <a class="p-2.5 rounded-lg text-on-surface-variant hover:text-primary hover:bg-primary-container/10 transition-colors" href="/write.html?id=${p.id}" title="Sửa"><span class="material-symbols-outlined">edit</span></a>
          <button type="button" class="p-2.5 rounded-lg text-on-surface-variant hover:text-primary hover:bg-primary-container/10 transition-colors" title="Đổi tác giả" data-action="admin-change-author" data-id="${p.id}" data-title="${escapeHtml(p.title)}" data-author-id="${p.author_id}" data-author-name="${escapeHtml(p.author_name)}"><span class="material-symbols-outlined">manage_accounts</span></button>
          <button type="button" class="p-2.5 rounded-lg text-on-surface-variant hover:text-error hover:bg-error-container/40 transition-colors" title="Xoá" data-action="admin-delete-post" data-id="${p.id}"><span class="material-symbols-outlined">delete</span></button>
        </div>
      </div>`
        )
        .join('') || '<p class="p-6 text-on-surface-variant">Chưa có bài viết nào.</p>';
  } catch (e) {
    list.innerHTML = `<p class="p-6 text-error">${escapeHtml(e.message)}</p>`;
  }
}

async function adminDeletePost(id) {
  // Says where the post goes, because it no longer goes away: the DELETE route
  // moves the row (and its comments) into the bin. A confirm that promised an
  // irreversible delete would be the one thing here that misdescribes itself.
  if (!confirm('Xoá bài viết này? Bài viết và các bình luận của nó sẽ chuyển vào Thùng rác; có thể khôi phục lại từ đó.')) return;
  try {
    await API.deletePost(id);
    // Keeps the rail badge honest without making the delete depend on it:
    // loadTrashCounts() swallows its own failure, so a badge that cannot refresh
    // never turns a delete that worked into an error dialog.
    loadTrashCounts();
    loadAllPosts();
  } catch (e) {
    alert(e.message);
  }
}

// ---- Users tab ----
// The full list is kept in memory so the search box and the filter chips can
// re-render instantly without another round trip. Paging is therefore done here
// rather than on the server: slicing a list that is already in hand costs nothing, and
// a search that had to go back to the server would stop being instant.
let allUsers = [];
let userFilter = 'all';
let userSearch = '';
// Ten accounts a page, like the two lists on Tổng quan. A table of forty rows inside a
// card with its own scrollbar is forty rows of hunting, and the row you wanted is never
// where you left it.
const USER_PAGE_SIZE = 10;
let userPage = 1;

async function loadUsers() {
  const list = document.getElementById('users-list');
  document.getElementById('users-empty').classList.add('hidden');
  list.innerHTML = '<tr><td class="text-on-surface-variant" colspan="6">Đang tải...</td></tr>';
  try {
    const { users } = await API.adminUsers();
    allUsers = users.map(normalizeUser);
    renderUsers();
  } catch (e) {
    document.getElementById('users-empty').classList.add('hidden');
    document.getElementById('users-count').textContent = '';
    list.innerHTML = `<tr><td class="text-error" colspan="6">${escapeHtml(e.message)}</td></tr>`;
  }
}

// A server that predates the enable/disable feature returns no is_active at all,
// and `undefined` is falsy - which rendered every account as disabled and offered
// a "Bật lại" button calling an endpoint that server does not have. Absent means
// "no such concept here", so it has to read as active. Same idea for the rest:
// a missing optional column must not change how the row behaves.
function normalizeUser(u) {
  return {
    ...u,
    name: u.name ?? '',
    email: u.email ?? '',
    avatar_url: u.avatar_url ?? '',
    bio: u.bio ?? '',
    role: u.role ?? 'readonly',
    auth_provider: u.auth_provider ?? 'local',
    is_active: u.is_active === undefined ? true : !!u.is_active,
    email_notifications: !!u.email_notifications,
    post_count: Number(u.post_count) || 0,
  };
}

function renderUsers() {
  const list = document.getElementById('users-list');
  const empty = document.getElementById('users-empty');
  const count = document.getElementById('users-count');
  const pager = document.getElementById('users-pager');
  const me = Auth.getUser();
  const q = userSearch.trim().toLowerCase();

  const visible = allUsers.filter((u) => {
    // 'disabled' filters on state; the other named chips filter on role.
    if (userFilter === 'disabled' && u.is_active) return false;
    if (userFilter !== 'all' && userFilter !== 'disabled' && u.role !== userFilter) return false;
    if (!q) return true;
    return u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q);
  });

  // Clamped on EVERY render, not only when a page is clicked: the chips and the search
  // box both shrink `visible`, and a search that leaves three matches while you were on
  // page four would otherwise draw an empty table with "4" still marked as current.
  const totalPages = Math.max(1, Math.ceil(visible.length / USER_PAGE_SIZE));
  userPage = Math.min(Math.max(1, userPage), totalPages);
  const start = (userPage - 1) * USER_PAGE_SIZE;
  const rows = visible.slice(start, start + USER_PAGE_SIZE);

  empty.classList.toggle('hidden', visible.length > 0);
  // Every row is about to be replaced, so an open role menu would be pointing at a
  // detached trigger - close it first rather than leave it floating.
  closeRoleMenu();
  list.innerHTML = rows.map((u) => userRowHtml(u, me)).join('');

  // Which slice is on screen, and of what. Naming the filter's own total apart from the
  // library's is the point: "12 người dùng" under a chip reads as everybody.
  count.textContent = !visible.length
    ? `Tổng ${allUsers.length} người dùng`
    : visible.length === allUsers.length
      ? `Hiển thị ${start + 1}–${start + rows.length} trong ${allUsers.length} người dùng`
      : `Hiển thị ${start + 1}–${start + rows.length} trong ${visible.length} người dùng khớp bộ lọc · tổng ${allUsers.length}`;

  // One page of accounts is not a choice, so the numbers stay hidden rather than
  // offering a control that cannot do anything - the rule every pager here follows.
  if (pager) {
    if (totalPages <= 1) {
      pager.classList.add('hidden');
      pager.innerHTML = '';
    } else {
      pager.classList.remove('hidden');
      pager.innerHTML = pagerHtml(userPage, totalPages, 'data-user-page');
    }
  }
}

// The initials stand in for a missing avatar, as in the design template: first
// letters of the first two words, so "Nguyễn Văn A" reads "NV". A name with no
// letters at all falls back to a person glyph.
function userInitials(name) {
  return String(name)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => [...w][0])
    .join('')
    .toLocaleUpperCase('vi-VN');
}

// ---- Role picker ----
// The three roles, in the order the menu lists them. One list, and both pickers -
// the table's per-row chip and the add-user modal's field - are drawn from it, so a
// role cannot be described one way in the table and another way in the dialog.
// `hint` is the second line the menu shows, and `icon` the glyph that goes with it.
const USER_ROLES = [
  { value: 'readonly', label: 'Readonly', hint: 'chỉ đọc & bình luận', icon: 'visibility' },
  { value: 'editor', label: 'Editor', hint: 'được viết bài', icon: 'edit_note' },
  { value: 'admin', label: 'Admin', hint: 'toàn quyền', icon: 'shield_person' },
];
const USER_ROLE_BY_VALUE = Object.fromEntries(USER_ROLES.map((r) => [r.value, r]));

// One row's role control, and the trigger for the shared menu below.
//
// It replaces a native <select>, for two reasons. The popup of a <select> is
// drawn by the OS, so it can never carry the site's own surface, blur and
// hairline - and on the dark theme this one did not even render dark: the old
// `.user-role-select option { background-color: #ffffff }` overrode what
// `color-scheme: dark` would otherwise have given it, so the menu opened as a
// white sheet over a navy page. The replacement is ordinary DOM on
// --menu-surface, the same panel the account menu in the nav uses.
// A <button> is what a listbox trigger has to be: it carries the state a screen
// reader needs (aria-haspopup, aria-expanded, aria-controls, and the current
// value inside its label) and it is where focus returns when the menu closes.
function userRoleTriggerHtml(u, isMe) {
  const role = USER_ROLE_BY_VALUE[u.role] || USER_ROLE_BY_VALUE.readonly;
  return `<button type="button" id="role-${u.id}" class="user-role user-role--${escapeHtml(u.role)}"
              aria-haspopup="listbox" aria-expanded="false" aria-controls="role-menu"
              aria-label="Vai trò của ${escapeHtml(u.name)}: ${escapeHtml(role.label)}"
              data-user-id="${u.id}" data-role="${escapeHtml(u.role)}"
              ${isMe ? 'disabled title="Không thể tự đổi vai trò của chính mình."' : ''}>
        <span class="material-symbols-outlined" aria-hidden="true">${role.icon}</span>
        <span>${escapeHtml(role.label)}</span>
      </button>`;
}

// One table row per account, in the template's column order: identity, role,
// status, then the account's own facts, and the row's actions. Six cells, not
// eight: post count and join date share "Bài viết", and the sign-in method and
// the notification state share "Tài khoản" as two glyphs - eight separate columns
// needed 1182px against a ~916px content column, so the panel clipped the
// actions. Every cell carries data-label so the same markup can collapse into a
// labelled card on a narrow screen (see the .user-table rules in admin.html).
// No cell carries an alignment class: the table is left-aligned throughout, so
// each heading sits over its own values. `isMe` disables everything that would
// lock the signed-in admin out of this very page.
function userRowHtml(u, me) {
  const isMe = u.id === me.id;
  const isGoogle = u.auth_provider === 'google';
  const active = !!u.is_active;
  const initials = userInitials(u.name);

  const avatar = u.avatar_url
    ? `<img class="user-avatar" alt="Ảnh đại diện của ${escapeHtml(u.name)}" src="${escapeHtml(u.avatar_url)}">`
    : `<span class="user-avatar user-avatar--initials" aria-hidden="true">${
        initials ? escapeHtml(initials) : '<span class="material-symbols-outlined text-[20px]">person</span>'
      }</span>`;

  return `
  <tr class="user-row${active ? '' : ' is-disabled'}" data-user-id="${u.id}">
    <td class="user-cell-identity" data-label="Người dùng">
      <div class="user-identity flex items-center gap-3 min-w-0">
        ${avatar}
        <div class="user-identity-text min-w-0">
          <p class="font-body-md text-body-md font-semibold text-on-surface truncate" title="${escapeHtml(u.name)}">${escapeHtml(u.name)}${
            isMe ? ' <span class="chip px-1.5 py-0.5 rounded font-label-md text-label-md uppercase align-middle">Bạn</span>' : ''
          }</p>
          <p class="text-on-surface-variant text-xs truncate" title="${escapeHtml(u.email)}">${escapeHtml(u.email)}</p>
        </div>
      </div>
    </td>
    <td data-label="Vai trò">
      ${userRoleTriggerHtml(u, isMe)}
    </td>
    <td data-label="Trạng thái">
      <span class="user-state${active ? '' : ' user-state--off'}">${active ? 'Hoạt động' : 'Đã vô hiệu'}</span>
    </td>
    <td data-label="Bài viết">
      <span class="user-facts">
        <span class="font-body-md text-body-md text-on-surface">${u.post_count} bài</span>
        <span class="text-on-surface-variant text-xs">Tham gia ${timeAgoVi(u.created_at)}</span>
      </span>
    </td>
    <td data-label="Tài khoản">
      <span class="user-marks">
        <span class="material-symbols-outlined text-[20px] text-on-surface-variant" title="${isGoogle ? 'Đăng nhập bằng Google.' : 'Đăng nhập bằng email và mật khẩu.'}">${isGoogle ? 'public' : 'mail'}</span>
        <span class="material-symbols-outlined text-[20px] ${u.email_notifications ? 'text-electric-indigo' : 'text-outline'}" title="${u.email_notifications ? 'Đang nhận email bài viết mới.' : 'Không nhận email bài viết mới.'}">${u.email_notifications ? 'notifications_active' : 'notifications_off'}</span>
      </span>
    </td>
    <td data-label="Thao tác">
      <div class="user-actions" role="group" aria-label="Hành động cho ${escapeHtml(u.name)}">
        ${
          active
            ? `<button type="button" class="user-action user-action--danger" ${isMe ? 'disabled title="Không thể tự vô hiệu hoá tài khoản của chính mình."' : 'title="Vô hiệu hoá"'} aria-label="Vô hiệu hoá ${escapeHtml(u.name)}" data-action="admin-set-user-active" data-id="${u.id}" data-active="false">
                 <span class="material-symbols-outlined">block</span>
               </button>`
            : `<button type="button" class="user-action user-action--enable" title="Bật lại" aria-label="Bật lại ${escapeHtml(u.name)}" data-action="admin-set-user-active" data-id="${u.id}" data-active="true">
                 <span class="material-symbols-outlined">check_circle</span>
               </button>`
        }
        <button type="button" class="user-action" ${isGoogle ? 'disabled title="Tài khoản Google không có mật khẩu tại chỗ để đặt lại."' : 'title="Đặt lại mật khẩu"'} aria-label="Đặt lại mật khẩu cho ${escapeHtml(u.name)}" data-action="admin-reset-password" data-id="${u.id}">
          <span class="material-symbols-outlined">key</span>
        </button>
        <button type="button" class="user-action user-action--danger" ${isMe ? 'disabled title="Không thể tự xoá tài khoản của chính mình."' : 'title="Xoá"'} aria-label="Xoá ${escapeHtml(u.name)}" data-action="admin-delete-user" data-id="${u.id}">
          <span class="material-symbols-outlined">delete</span>
        </button>
      </div>
    </td>
  </tr>`;
}

async function adminSetRole(id, role) {
  try {
    await API.adminSetRole(id, role);
    const user = allUsers.find((u) => u.id === id);
    if (user) user.role = role;
    // Re-render so the role chips keep filtering correctly after the change.
    renderUsers();
  } catch (e) {
    alert(e.message);
    loadUsers();
  }
}

// ---- The role menu ----
// ONE menu for the whole table, built on first use and parented to <body>.
// Not one per row, and not inside the cell: the list panel is `overflow-hidden`
// (it clips its own rounded corners) and the table sits in an `overflow-x:auto`
// scroller, so a menu rendered in the row would be cut off at the panel's edge
// instead of overlapping it. Living outside both is also why it is
// `position: fixed` and has to be placed by hand - see placeRoleMenu().
//
// Focus MOVES into the menu, which is what keeps the keyboard side small: the
// focused option IS the active one, so there is no aria-activedescendant to keep
// in sync and the highlight is plain :focus in the CSS.
let roleMenuEl = null;
let roleMenuTrigger = null; // the .user-role whose menu is open, or null

function roleMenu() {
  if (roleMenuEl) return roleMenuEl;
  roleMenuEl = document.createElement('div');
  roleMenuEl.id = 'role-menu';
  roleMenuEl.className = 'user-role-menu';
  roleMenuEl.setAttribute('role', 'listbox');
  roleMenuEl.setAttribute('aria-label', 'Chọn vai trò');
  roleMenuEl.hidden = true;
  // tabindex="-1" on every option: they are reachable by script and by the arrow
  // keys but never by Tab, because the menu sits at the end of <body>, nowhere
  // near the row it belongs to - leaving it in the tab order would strand a
  // keyboard user at the bottom of the document.
  roleMenuEl.innerHTML = USER_ROLES.map(
    (r) => `
    <button type="button" role="option" tabindex="-1" aria-selected="false" data-role="${r.value}" class="user-role-option">
      <span class="material-symbols-outlined" aria-hidden="true">${r.icon}</span>
      <span class="user-role-option-text">
        <span>${r.label}</span>
        <span class="user-role-option-hint">${escapeHtml(r.hint)}</span>
      </span>
      <span class="user-role-option-check material-symbols-outlined" aria-hidden="true">check</span>
    </button>`
  ).join('');

  roleMenuEl.addEventListener('click', async (e) => {
    const opt = e.target.closest('.user-role-option');
    if (!opt || !roleMenuTrigger) return;
    const trigger = roleMenuTrigger;
    const next = opt.dataset.role;
    const changed = next !== trigger.dataset.role;
    closeRoleMenu({ focusTrigger: true });
    if (!changed) return;
    // Two kinds of trigger open this one menu, and `data-user-id` is what tells them
    // apart: a row's chip belongs to an account that already exists, so its choice
    // is saved the moment it is made, while the add-user modal's field belongs to a
    // form that has not been submitted yet, so its choice only has to be KEPT. Same
    // menu, same options, same glass - the difference is entirely what a pick means.
    if (trigger.dataset.userId) {
      const id = Number(trigger.dataset.userId);
      await adminSetRole(id, next);
      // adminSetRole re-renders the list, so the trigger focus() just restored has
      // been replaced - move focus onto the rebuilt control rather than losing it.
      document.getElementById(`role-${id}`)?.focus();
    } else {
      setAddUserRole(next);
    }
  });

  roleMenuEl.addEventListener('keydown', (e) => {
    const opts = Array.from(roleMenuEl.querySelectorAll('.user-role-option'));
    const i = opts.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      opts[(i + step + opts.length) % opts.length].focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      (e.key === 'Home' ? opts[0] : opts[opts.length - 1]).focus();
    } else if (e.key === 'Tab') {
      // Closes rather than moving on, for the same reason the options are
      // tabindex="-1": the next tab stop from here is the end of the document.
      e.preventDefault();
      closeRoleMenu({ focusTrigger: true });
    }
  });

  document.body.appendChild(roleMenuEl);
  return roleMenuEl;
}

// Placed by hand because the menu is fixed-position in <body>: under the trigger
// by default, flipped above it when the viewport has no room below, and pulled
// back inside the right edge on a narrow screen. Measuring needs the menu
// visible, so openRoleMenu() unhides it before calling this.
function placeRoleMenu() {
  if (!roleMenuTrigger || !roleMenuEl) return;
  const GAP = 6;
  const EDGE = 8;
  const t = roleMenuTrigger.getBoundingClientRect();
  // A field-wide trigger gets a field-wide menu. The table's chips keep the CSS
  // min-width, which is as wide as the column they sit in; the modal's field is
  // ~380px against that 184px, and a popup narrower than the control it came out of
  // reads as belonging to something else. Set before measuring, since it is what
  // changes the measurement. Cleared rather than left behind, or the next chip to
  // open would inherit the field's width.
  roleMenuEl.style.minWidth = roleMenuTrigger.classList.contains('user-role--field')
    ? `${Math.round(t.width)}px`
    : '';
  // offset*, not the menu's own bounding rect. openRoleMenu() unhides the menu and
  // calls this in the same task, so `dropdown-in` is at its first frame - and its
  // `translateY(-6px) scale(0.97)` is inside a bounding rect, which measures the
  // painted box. Whether the animation has started yet decides whether the numbers
  // below describe the menu that will be on screen or one 3% smaller and 6px higher,
  // which is a coin toss on the flip-up decision and on how far the right edge may
  // be pulled in. offset* is the layout box and excludes transforms.
  const mw = roleMenuEl.offsetWidth;
  const mh = roleMenuEl.offsetHeight;
  let top = t.bottom + GAP;
  if (top + mh > window.innerHeight - EDGE && t.top - GAP - mh > EDGE) {
    top = t.top - GAP - mh;
  }
  const left = Math.max(EDGE, Math.min(t.left, window.innerWidth - mw - EDGE));
  roleMenuEl.style.top = `${Math.round(top)}px`;
  roleMenuEl.style.left = `${Math.round(left)}px`;
}

function openRoleMenu(trigger) {
  const menu = roleMenu();
  roleMenuTrigger = trigger;
  // The dialogs are z-[100] and this menu is 90, so one opened from inside a dialog
  // has to be lifted over it or the scrim covers the very thing the click summoned.
  menu.classList.toggle('user-role-menu--in-modal', !!trigger.closest('#add-user-modal'));
  const current = trigger.dataset.role;
  const opts = Array.from(menu.querySelectorAll('.user-role-option'));
  opts.forEach((opt) => opt.setAttribute('aria-selected', String(opt.dataset.role === current)));
  menu.hidden = false;
  trigger.setAttribute('aria-expanded', 'true');
  placeRoleMenu();
  // Opens on the role already in force, so the arrow keys start from where the
  // account actually is rather than from the top of the list.
  (menu.querySelector('[aria-selected="true"]') || opts[0]).focus();
}

function closeRoleMenu({ focusTrigger = false } = {}) {
  if (!roleMenuTrigger) return;
  const trigger = roleMenuTrigger;
  roleMenuTrigger = null;
  roleMenuEl.hidden = true;
  trigger.setAttribute('aria-expanded', 'false');
  // Focus goes back to the trigger rather than being dropped on <body>, so a
  // keyboard user who closes the menu keeps their place in the table instead of
  // starting the next Tab from the top of the document.
  if (focusTrigger && document.contains(trigger)) trigger.focus();
}

// A click that is neither on a role trigger nor inside the menu closes it. The
// trigger's own click is handled by the delegated listener in
// initUsersControls(), which toggles instead of closing.
document.addEventListener('click', (e) => {
  if (!roleMenuTrigger) return;
  if (e.target.closest('.user-role') || e.target.closest('.user-role-menu')) return;
  closeRoleMenu();
});
// Escape from anywhere: the menu's own handler only sees the key while focus is
// inside it, and a click elsewhere can move focus out without closing.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeRoleMenu({ focusTrigger: true });
});

// The menu is fixed while the row underneath it scrolls, so it is re-placed on
// every scroll - and let go of once that row has left the screen, rather than
// left floating over unrelated content. Capture phase, because the scroll may
// come from the table's own overflow container and scroll events do not bubble.
// rAF-throttled, so a fast scroll costs one placement per frame.
let roleMenuPlacePending = false;
function repositionRoleMenu() {
  if (!roleMenuTrigger || roleMenuPlacePending) return;
  roleMenuPlacePending = true;
  requestAnimationFrame(() => {
    roleMenuPlacePending = false;
    if (!roleMenuTrigger) return;
    const r = roleMenuTrigger.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) {
      closeRoleMenu();
      return;
    }
    placeRoleMenu();
  });
}
window.addEventListener('scroll', repositionRoleMenu, true);
window.addEventListener('resize', repositionRoleMenu);

// A 404 from one of these endpoints does not mean the URL is wrong - it means the
// Node process is still running code from before this feature existed, because
// requiring a route file only reads it at startup. The generic "Không tìm thấy
// endpoint." tells the admin nothing actionable, so say what to actually do.
function userActionError(e) {
  if (e.status === 404) {
    return 'Máy chủ đang chạy phiên bản cũ chưa có chức năng này. Hãy khởi động lại máy chủ (npm start) rồi tải lại trang.';
  }
  return e.message;
}

async function adminSetUserActive(id, isActive) {
  const user = allUsers.find((u) => u.id === id);
  const name = user ? user.name : 'người dùng này';
  if (
    !isActive &&
    !confirm(`Vô hiệu hoá "${name}"? Họ sẽ bị đăng xuất ngay và không thể đăng nhập lại cho tới khi được bật lại. Bài viết của họ vẫn được giữ.`)
  ) {
    return;
  }
  try {
    await API.adminSetUserActive(id, isActive);
    if (user) user.is_active = isActive;
    renderUsers();
  } catch (e) {
    alert(userActionError(e));
    loadUsers();
  }
}

async function adminDeleteUser(id) {
  const user = allUsers.find((u) => u.id === id);
  const name = user ? user.name : 'người dùng này';
  // Both halves of this sentence changed when the bin arrived. The account is no
  // longer gone for good - it is in Thùng rác, restorable - and it never takes
  // their writing with it any more, so promising a cascade described a delete the
  // server no longer performs.
  if (
    !confirm(
      `Xoá "${name}"? Tài khoản sẽ chuyển vào Thùng rác và bị đăng xuất ngay; bài viết và bình luận của họ vẫn ở lại trên trang. Có thể khôi phục tài khoản từ Thùng rác. Nếu chỉ muốn chặn truy cập tạm thời, hãy dùng "Vô hiệu hoá".`
    )
  ) {
    return;
  }
  try {
    await API.adminDeleteUser(id);
    loadTrashCounts();
    loadUsers();
  } catch (e) {
    alert(e.message);
  }
}

// The buttons above (plus admin-delete-post near renderRecentPosts/renderPosts,
// and the post-row/recent-row data-goto) used to carry their id/args directly in
// an inline onclick="" built into the row's template string. CSP script-src has
// no 'unsafe-inline' any more (see server/security-headers.js), so a
// dynamically-built inline handler like that is silently blocked by the browser
// rather than failing loudly - which is exactly what had quietly broken "Xoá"
// (post and user), "Vô hiệu hoá"/"Bật lại", and "Đặt lại mật khẩu" before this
// fix. data-action + registerAction is the same delegated-listener pattern every
// other page already uses (see wireGlobalHandlers in js/api.js); functions are
// hoisted, so it does not matter that openResetPasswordModal is declared below.
registerAction('admin-delete-post', (e, el) => adminDeletePost(Number(el.dataset.id)));
registerAction('admin-set-user-active', (e, el) => adminSetUserActive(Number(el.dataset.id), el.dataset.active === 'true'));
registerAction('admin-reset-password', (e, el) => openResetPasswordModal(Number(el.dataset.id)));
registerAction('admin-change-author', (e, el) =>
  openChangeAuthorModal(Number(el.dataset.id), el.dataset.title, Number(el.dataset.authorId), el.dataset.authorName)
);
registerAction('admin-delete-user', (e, el) => adminDeleteUser(Number(el.dataset.id)));

// ---- Add user modal ----
// The container is `hidden items-center justify-center`, so it needs `flex`
// added as well - dropping only `hidden` leaves it display:block and the card
// lands at the top of the screen instead of centred. Two call sites open it
// (the Users tab button and the Lối tắt shortcut), hence a shared pair here
// rather than an inline classList call in each onclick.
function openAddUserModal() {
  const modal = document.getElementById('add-user-modal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  document.getElementById('add-user-error')?.classList.add('hidden');
  modal.querySelector('input[name="name"]')?.focus();
}

function closeAddUserModal() {
  const modal = document.getElementById('add-user-modal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

// The modal's "Vai trò" field: the table's listbox wearing a field's clothes. See
// .user-role--field in admin.html for why it is not a <select> - the short version
// is that a <select>'s popup belongs to the OS and could never be glass.
//
// The form still submits a plain `role`, because a hidden input of that name sits
// beside the button: FormData keeps working on the form exactly as it did before,
// and nothing downstream had to learn that the control changed. One function owns
// the input and the trigger together, so the value the admin sees and the value the
// server gets cannot disagree.
//
// The default is written down here rather than read back from the markup, and that
// is not redundancy - it is the only way to have one. A hidden input is the one
// input type whose `value` IDL attribute REFLECTS its `value` content attribute, so
// every assignment below rewrites the attribute that `defaultValue` - and therefore
// form.reset() - is taken from. After one pick, the "default" the form would reset
// to is the role just submitted, and the next account inherits it. The
// `value="readonly"` in admin.html is the same string, and it is there for the first
// paint, before this file has run.
const ADD_USER_ROLE_DEFAULT = 'readonly';

function setAddUserRole(value) {
  const role = USER_ROLE_BY_VALUE[value] || USER_ROLE_BY_VALUE[ADD_USER_ROLE_DEFAULT];
  const input = document.getElementById('add-user-form')?.elements.role;
  if (input) input.value = role.value;
  const trigger = document.getElementById('add-user-role');
  if (!trigger) return;
  trigger.dataset.role = role.value;
  // className, not classList: the tint is a swap between three modifiers, and
  // removing the old one and adding the new one in two steps is one more chance to
  // leave a chip wearing two roles' colours.
  trigger.className = `user-role user-role--field user-role--${role.value}`;
  trigger.innerHTML = `
    <span class="material-symbols-outlined" aria-hidden="true">${role.icon}</span>
    <span>${escapeHtml(role.label)} <span class="user-role-field-hint">${escapeHtml(role.hint)}</span></span>`;
}

// Click, plus the two arrow keys - the same three ways in the table's chips have,
// and what makes this behave like the <select> it replaced rather than like a
// button that happens to open something. Enter and Space need no handler: the
// options are real <button>s, so the menu's own focus handles them.
// Wired from initAdmin() rather than at the top level, for the reason given above
// initUsersControls(): a cached admin.html without the field would throw here while
// the script was still being evaluated and never reach initAdmin() at all.
function initAddUserRoleField() {
  const trigger = document.getElementById('add-user-role');
  if (!trigger) return;
  trigger.addEventListener('click', () => {
    if (roleMenuTrigger === trigger) closeRoleMenu({ focusTrigger: true });
    else openRoleMenu(trigger);
  });
  trigger.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    if (roleMenuTrigger !== trigger) openRoleMenu(trigger);
  });
}

// ---- Reset password modal ----
function openResetPasswordModal(id) {
  const user = allUsers.find((u) => u.id === id);
  if (!user) return;
  const modal = document.getElementById('reset-password-modal');
  const form = document.getElementById('reset-password-form');
  form.reset();
  form.userId.value = id;
  document.getElementById('reset-password-target').textContent = user.name;
  document.getElementById('reset-password-error').classList.add('hidden');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  document.getElementById('reset-password-input').focus();
}

function closeResetPasswordModal() {
  const modal = document.getElementById('reset-password-modal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

// ---- Change author modal ----
// Reachable only from the post row's own action (registerAction above), which
// is only ever rendered inside admin.html - loadAllPosts() itself is the
// authorization boundary here, same as the delete button beside it; the
// server still re-checks role==='admin' on PUT /api/posts/:id regardless (see
// server/routes/posts.js), so a request forged past this UI is refused there.
async function openChangeAuthorModal(postId, title, currentAuthorId, currentAuthorName) {
  const modal = document.getElementById('change-author-modal');
  const form = document.getElementById('change-author-form');
  const trigger = document.getElementById('change-author-trigger');
  const errorEl = document.getElementById('change-author-error');
  form.reset();
  form.postId.value = postId;
  document.getElementById('change-author-target').textContent = title;
  document.getElementById('change-author-current').textContent = currentAuthorName;
  errorEl.classList.add('hidden');
  trigger.disabled = true;
  trigger.dataset.userId = String(currentAuthorId);
  trigger.innerHTML = `<span>Đang tải danh sách người dùng...</span>`;
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  try {
    const { users } = await API.adminUsers();
    // The list is fetched fresh per post rather than kept from the Users tab
    // (allUsers there may never have loaded), and it excludes soft-deleted
    // accounts - so a post whose author was since trashed would not find
    // itself in it. Spliced back in as a synthetic entry rather than left out:
    // the field must still show WHO the post is by when the modal opens, and
    // "leave it as is" (closing the modal without picking anyone) has to stay
    // a real option.
    authorMenuUsers = users.some((u) => u.id === currentAuthorId)
      ? users
      : [{ id: currentAuthorId, name: currentAuthorName, email: '(không còn trong danh sách người dùng)' }, ...users];
    const current = authorMenuUsers.find((u) => u.id === currentAuthorId);
    setChangeAuthorTrigger(current);
    trigger.disabled = false;
  } catch (e) {
    errorEl.textContent = e.message;
    errorEl.classList.remove('hidden');
  }
}

function closeChangeAuthorModal() {
  closeAuthorMenu();
  const modal = document.getElementById('change-author-modal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

function initChangeAuthorControls() {
  const form = document.getElementById('change-author-form');
  const trigger = document.getElementById('change-author-trigger');
  if (!form || !trigger) return;

  trigger.addEventListener('click', () => {
    if (authorMenuTrigger === trigger) closeAuthorMenu({ focusTrigger: true });
    else openAuthorMenu(trigger);
  });
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (authorMenuTrigger !== trigger) openAuthorMenu(trigger);
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('change-author-error');
    errorEl.classList.add('hidden');
    const postId = Number(e.target.postId.value);
    const authorId = Number(e.target.authorId.value);
    try {
      await API.updatePost(postId, { author_id: authorId });
      closeChangeAuthorModal();
      loadAllPosts();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    }
  });
}

// ---- The change-author picker (Quản lý bài viết → "Đổi tác giả") ----
// A second, independent custom listbox rather than a generalisation of
// roleMenu() above: that one is built around a FIXED three-item ROLE list
// (options created once, at module load, for a table's worth of chip
// triggers) - this one's list is however many accounts the site has, fetched
// fresh each time the modal opens, for the one field inside
// #change-author-modal. Same visual language (.user-role--field/
// .user-role-menu/.user-role-option, so this picker reads as the same kind of
// control as "Vai trò" beside it) with its own small state machine instead of
// threading a second, unrelated shape through the role menu's.
let authorMenuEl = null;
let authorMenuTrigger = null; // #change-author-trigger while its menu is open, or null
let authorMenuUsers = [];

function authorMenu() {
  if (authorMenuEl) return authorMenuEl;
  authorMenuEl = document.createElement('div');
  authorMenuEl.id = 'change-author-menu';
  // In-modal (this trigger has only ever been inside a dialog, unlike the role
  // chip) and --tall: the role menu's three rows always fit unscrolled, this
  // one's row count is "however many accounts exist".
  authorMenuEl.className = 'user-role-menu user-role-menu--in-modal user-role-menu--tall';
  authorMenuEl.setAttribute('role', 'listbox');
  authorMenuEl.setAttribute('aria-label', 'Chọn tác giả');
  authorMenuEl.hidden = true;

  authorMenuEl.addEventListener('click', (e) => {
    const opt = e.target.closest('.user-role-option');
    if (!opt || !authorMenuTrigger) return;
    const user = authorMenuUsers.find((u) => u.id === Number(opt.dataset.userId));
    closeAuthorMenu({ focusTrigger: true });
    if (user) setChangeAuthorTrigger(user);
  });

  authorMenuEl.addEventListener('keydown', (e) => {
    const opts = Array.from(authorMenuEl.querySelectorAll('.user-role-option'));
    const i = opts.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      opts[(i + step + opts.length) % opts.length]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      (e.key === 'Home' ? opts[0] : opts[opts.length - 1])?.focus();
    } else if (e.key === 'Tab') {
      // Same reason as roleMenu(): the options are tabindex="-1", so the next
      // tab stop from here is the end of the document, not anything useful.
      e.preventDefault();
      closeAuthorMenu({ focusTrigger: true });
    }
  });

  document.body.appendChild(authorMenuEl);
  return authorMenuEl;
}

// Sets the hidden form value AND the trigger's own label together, so what the
// admin sees and what the form will submit can never disagree - the same
// contract setAddUserRole() keeps for the role field.
function setChangeAuthorTrigger(user) {
  const form = document.getElementById('change-author-form');
  if (form) form.authorId.value = user.id;
  const trigger = document.getElementById('change-author-trigger');
  if (!trigger) return;
  trigger.dataset.userId = String(user.id);
  trigger.innerHTML = `<span>${escapeHtml(user.name)} <span class="user-role-field-hint">${escapeHtml(user.email)}</span></span>`;
}

// Placed by hand for the same reason as placeRoleMenu(): fixed-position in
// <body>, so the browser cannot place it relative to the trigger on its own.
function placeAuthorMenu() {
  if (!authorMenuTrigger || !authorMenuEl) return;
  const GAP = 6;
  const EDGE = 8;
  const t = authorMenuTrigger.getBoundingClientRect();
  authorMenuEl.style.minWidth = `${Math.round(t.width)}px`;
  const mw = authorMenuEl.offsetWidth;
  const mh = authorMenuEl.offsetHeight;
  let top = t.bottom + GAP;
  if (top + mh > window.innerHeight - EDGE && t.top - GAP - mh > EDGE) {
    top = t.top - GAP - mh;
  }
  const left = Math.max(EDGE, Math.min(t.left, window.innerWidth - mw - EDGE));
  authorMenuEl.style.top = `${Math.round(top)}px`;
  authorMenuEl.style.left = `${Math.round(left)}px`;
}

function openAuthorMenu(trigger) {
  const menu = authorMenu();
  authorMenuTrigger = trigger;
  const currentId = Number(trigger.dataset.userId);
  menu.innerHTML = authorMenuUsers
    .map(
      (u) => `
    <button type="button" role="option" tabindex="-1" aria-selected="${u.id === currentId}" data-user-id="${u.id}" class="user-role-option">
      <span class="user-role-option-text">
        <span>${escapeHtml(u.name)}</span>
        <span class="user-role-option-hint">${escapeHtml(u.email)}</span>
      </span>
      <span class="user-role-option-check material-symbols-outlined" aria-hidden="true">check</span>
    </button>`
    )
    .join('');
  menu.hidden = false;
  trigger.setAttribute('aria-expanded', 'true');
  placeAuthorMenu();
  (menu.querySelector('[aria-selected="true"]') || menu.querySelector('.user-role-option'))?.focus();
}

function closeAuthorMenu({ focusTrigger = false } = {}) {
  if (!authorMenuTrigger) return;
  const trigger = authorMenuTrigger;
  authorMenuTrigger = null;
  if (authorMenuEl) authorMenuEl.hidden = true;
  trigger.setAttribute('aria-expanded', 'false');
  if (focusTrigger && document.contains(trigger)) trigger.focus();
}

document.addEventListener('click', (e) => {
  if (!authorMenuTrigger) return;
  if (e.target.closest('#change-author-trigger') || e.target.closest('#change-author-menu')) return;
  closeAuthorMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeAuthorMenu({ focusTrigger: true });
});

let authorMenuPlacePending = false;
function repositionAuthorMenu() {
  if (!authorMenuTrigger || authorMenuPlacePending) return;
  authorMenuPlacePending = true;
  requestAnimationFrame(() => {
    authorMenuPlacePending = false;
    if (authorMenuTrigger) placeAuthorMenu();
  });
}
window.addEventListener('scroll', repositionAuthorMenu, true);
window.addEventListener('resize', repositionAuthorMenu);

// Type=text on purpose: the admin has to read this value back out to hand it to
// the user, so hiding it behind dots would only invite typos.
function generatePassword() {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint32Array(14);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

// Wired from initAdmin() rather than at the top level, for the same reason as
// the other settings controls: a browser on a cached admin.html without these
// elements would throw here while the script was still being evaluated and never
// reach initAdmin(), blanking every tab of the panel.
function initUsersControls() {
  const generate = document.getElementById('reset-password-generate');
  const form = document.getElementById('reset-password-form');
  const search = document.getElementById('user-search');
  const chips = document.getElementById('user-filter-chips');
  const list = document.getElementById('users-list');
  if (!generate || !form || !search || !chips || !list) return;

  generate.addEventListener('click', () => {
    document.getElementById('reset-password-input').value = generatePassword();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('reset-password-error');
    errorEl.classList.add('hidden');
    const id = Number(e.target.userId.value);
    const password = e.target.password.value;
    try {
      await API.adminResetUserPassword(id, password);
      closeResetPasswordModal();
      alert(
        `Đã đặt lại mật khẩu. Mật khẩu mới:

${password}

` +
          'Hãy gửi cho người dùng qua một kênh an toàn - nó sẽ không hiển thị lại.'
      );
    } catch (err) {
      errorEl.textContent = userActionError(err);
      errorEl.classList.remove('hidden');
    }
  });

  // Search and the chips both just re-render the list already held in memory. Each one
  // also goes back to page 1: a new question starts at the first page of its answer, and
  // staying on page 4 of a filter that has three matches shows an empty table.
  search.addEventListener('input', (e) => {
    userSearch = e.target.value;
    userPage = 1;
    renderUsers();
  });

  chips.addEventListener('click', (e) => {
    const btn = e.target.closest('.user-chip');
    if (!btn) return;
    userFilter = btn.dataset.filter;
    userPage = 1;
    chips.querySelectorAll('.user-chip').forEach((b) => b.classList.toggle('active', b === btn));
    renderUsers();
  });

  // The page numbers. Delegated on the <nav> rather than on each pill, because
  // renderUsers() replaces the pills on every keystroke of the search box and the <nav>
  // itself is part of the page - one listener outlives all of them.
  const pager = document.getElementById('users-pager');
  if (pager) {
    pager.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-user-page]');
      if (!btn || btn.disabled) return;
      const target = Number(btn.dataset.userPage);
      if (target === userPage) return;
      userPage = target;
      renderUsers();
      // Ten rows is shorter than a screen, but on a narrow one the table's own scroll
      // can leave the header out of view; 'nearest' moves the page only if it must.
      list.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }

  // Role triggers, delegated on <tbody>: renderUsers() replaces every row on each
  // filter keystroke and after each change, so per-button listeners would have to
  // be re-attached each time. Keydown as well as click, because a <button> only
  // gets Enter and Space for free - ArrowDown/Up opening the menu is what makes
  // it behave like the <select> it replaced.
  list.addEventListener('click', (e) => {
    const trigger = e.target.closest('.user-role');
    if (!trigger || trigger.disabled) return;
    if (roleMenuTrigger === trigger) closeRoleMenu({ focusTrigger: true });
    else openRoleMenu(trigger);
  });

  list.addEventListener('keydown', (e) => {
    const trigger = e.target.closest('.user-role');
    if (!trigger || trigger.disabled) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (roleMenuTrigger !== trigger) openRoleMenu(trigger);
    }
  });
}


// ---- Add user modal ----
document.getElementById('add-user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const errorEl = document.getElementById('add-user-error');
  errorEl.classList.add('hidden');
  try {
    await API.adminCreateUser({
      name: fd.get('name'),
      email: fd.get('email'),
      password: fd.get('password'),
      role: fd.get('role'),
    });
    closeAddUserModal();
    e.target.reset();
    // Set explicitly, because reset() cannot put this one back: see
    // ADD_USER_ROLE_DEFAULT. Without it the next account created here opens with the
    // role of the one just made already chosen.
    setAddUserRole(ADD_USER_ROLE_DEFAULT);
    loadUsers();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  }
});

// ---- Trash tab ----
// Four folders over one list, and the opposite of the Users tab in one respect:
// nothing is held in memory to filter or slice. A bin has no natural size - it
// holds whatever has ever been deleted, for as long as nobody empties it - so the
// folder and the page are both part of the question asked of the server, and only
// the page on screen is fetched.
//
// The counts are the exception: every response in this feature carries all four,
// so the folder badges and the rail's own badge stay honest after each
// restore/purge without a request of their own.
const TRASH_FOLDERS = {
  posts: { label: 'Bài viết', icon: 'article', noun: 'bài viết' },
  comments: { label: 'Bình luận', icon: 'chat_bubble', noun: 'bình luận' },
  users: { label: 'Người dùng', icon: 'person', noun: 'người dùng' },
  media: { label: 'Media', icon: 'image', noun: 'ảnh' },
};
const TRASH_FOLDER_KEYS = Object.keys(TRASH_FOLDERS);
// Ten a page, the same as every other list on this page.
const TRASH_PAGE_SIZE = 10;
let trashFolder = 'posts';
let trashPage = 1;
// The page on screen, kept so the two confirms can name the thing they are about
// to act on ("Xoá vĩnh viễn <tiêu đề>?") instead of asking about an id.
let trashItems = [];
let trashCounts = { posts: 0, comments: 0, users: 0, media: 0 };
let trashBusy = false;

// Called once at startup, apart from the tab: the rail badge should say what is in
// the bin before anybody opens it, which is the whole of its use.
async function loadTrashCounts() {
  try {
    const { counts } = await API.trashCounts();
    applyTrashCounts(counts);
  } catch (e) {
    // A badge that failed to load is not worth an alert on page open; the tab
    // itself reports the real error when it is opened.
  }
}

function applyTrashCounts(counts) {
  if (!counts) return;
  trashCounts = { ...trashCounts, ...counts };
  TRASH_FOLDER_KEYS.forEach((key) => {
    const el = document.querySelector(`[data-trash-count="${key}"]`);
    // Written as '' rather than hidden: .trash-chip-count:empty is what removes an
    // empty badge, because a display rule in admin.html's own <style> would beat
    // Tailwind's .hidden and leave a zero on show. See that rule's comment.
    if (el) el.textContent = Number(trashCounts[key]) > 0 ? String(trashCounts[key]) : '';
  });
  const badge = document.getElementById('trash-rail-badge');
  if (badge) {
    const total = TRASH_FOLDER_KEYS.reduce((n, key) => n + (Number(trashCounts[key]) || 0), 0);
    badge.textContent = total > 99 ? '99+' : String(total);
    // .hidden is emitted AFTER .flex in tailwind.css, so it wins while it is on the
    // element; dropping it leaves the `flex` already in the class list to shape it.
    badge.classList.toggle('hidden', total === 0);
  }
}

async function loadTrash(page = trashPage) {
  const list = document.getElementById('trash-list');
  if (!list) return;
  trashPage = Math.max(1, Number(page) || 1);
  // Deliberately does NOT clear #trash-msg: the callers that have something to say
  // say it after the reload, and a message written before loadTrash() would be wiped
  // by it. Clearing belongs to the two navigations that change the question being
  // asked - a different folder, a different page - and they do it themselves.
  list.innerHTML = '<p class="p-6 font-body-md text-body-md text-on-surface-variant">Đang tải...</p>';
  try {
    const data = await API.trashList(trashFolder, trashPage, TRASH_PAGE_SIZE);
    applyTrashCounts(data.counts);
    // The server clamps too; taking its answer is what keeps the pager and the
    // rows agreeing when a page past the end was asked for.
    trashPage = Math.max(1, Number(data.page) || trashPage);
    renderTrash(data);
  } catch (e) {
    trashItems = [];
    const pager = document.getElementById('trash-pager');
    const count = document.getElementById('trash-count');
    if (count) count.textContent = '';
    if (pager) {
      pager.classList.add('hidden');
      pager.innerHTML = '';
    }
    list.innerHTML = `<p class="p-6 font-body-md text-body-md text-error">${escapeHtml(e.message)}</p>`;
  }
}

function renderTrash(data) {
  const list = document.getElementById('trash-list');
  const count = document.getElementById('trash-count');
  const pager = document.getElementById('trash-pager');
  const folder = TRASH_FOLDERS[trashFolder];
  const items = Array.isArray(data.items) ? data.items : [];
  const total = Number(data.total) || 0;

  // Clamped on EVERY render, not only on a page click: a restore or a purge shrinks
  // `total`, and staying on page 3 of a folder that now has two pages would draw an
  // empty list with "3" still marked as current.
  const totalPages = Math.max(1, Math.ceil(total / TRASH_PAGE_SIZE));
  trashPage = Math.min(Math.max(1, trashPage), totalPages);
  const start = (trashPage - 1) * TRASH_PAGE_SIZE;
  trashItems = items;

  list.innerHTML =
    items.map(trashRowHtml).join('') ||
    `<p class="p-8 text-center font-body-md text-body-md text-on-surface-variant">Không có ${folder.noun} nào trong thùng rác.</p>`;

  count.textContent = !total
    ? `Không có ${folder.noun} nào trong thùng rác`
    : `Hiển thị ${start + 1}–${start + items.length} trong ${total} ${folder.noun}`;

  // One page is not a choice, so the numbers stay hidden rather than offering a
  // control that cannot do anything - the rule every pager here follows.
  if (pager) {
    if (totalPages <= 1) {
      pager.classList.add('hidden');
      pager.innerHTML = '';
    } else {
      pager.classList.remove('hidden');
      pager.innerHTML = pagerHtml(trashPage, totalPages, 'data-trash-page');
    }
  }
}

// deleted_at is written the way SQLite writes every other timestamp on these rows -
// "YYYY-MM-DD HH:MM:SS" in UTC - so it takes the same '+Z' reading timeAgoVi()
// gives created_at, and the absolute form in the tooltip is the reader's own zone
// rather than the server's.
function trashAbsoluteVi(stamp) {
  if (!stamp) return '';
  const d = new Date(String(stamp).replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function trashWhenHtml(stamp) {
  if (!stamp) return '';
  const abs = trashAbsoluteVi(stamp);
  return `<span${abs ? ` title="Xoá lúc ${abs}"` : ''}>xoá ${escapeHtml(timeAgoVi(String(stamp)))}</span>`;
}

function trashChipHtml(text) {
  return `<span class="chip px-2 py-0.5 rounded-full text-[10px] font-label-caps uppercase">${escapeHtml(text)}</span>`;
}

// What each row says, per folder. The four folders hold four different kinds of
// thing, so the head and the second line are built here rather than shared: a
// comment leads with its own text and names the post it was on, an account names
// what it still has published, a file names its size and dimensions.
//
// No row links anywhere. A trashed post's slug returns 404 by design (the row is
// deleted as far as the site is concerned), and a trashed file has been moved out
// of /uploads, so there is no thumbnail to show either - the media row carries its
// stored name and size instead of a picture.
function trashBodyHtml(item) {
  const when = trashWhenHtml(item.deleted_at);

  if (trashFolder === 'posts') {
    const withComments = Number(item.trashed_comments) || 0;
    return {
      chips:
        trashChipHtml(item.status === 'published' ? 'Đã đăng' : 'Bản nháp') +
        // A post takes its comments with it, and they come back together - so the
        // row says how many are in the box, otherwise restoring one thing that is
        // really N+1 things looks like it restored one.
        (withComments ? trashChipHtml(`+${withComments} bình luận`) : ''),
      title: escapeHtml(item.title || '(không có tiêu đề)'),
      meta: `bởi ${escapeHtml(item.author_name || '—')} · ${Number(item.views) || 0} lượt xem · ${when}`,
    };
  }

  if (trashFolder === 'comments') {
    // Only the comments that were deleted on their own are listed here; the ones
    // that went into the bin with their post are counted on that post's row.
    return {
      chips: trashChipHtml(item.post_deleted_at ? 'Bài viết cũng trong thùng rác' : 'Bình luận riêng'),
      title: `<span class="line-clamp-2">${escapeHtml(String(item.content || '').trim() || '(bình luận trống)')}</span>`,
      meta: `trên bài ${escapeHtml(item.post_title || '—')} · bởi ${escapeHtml(item.author_name || '—')} · ${when}`,
    };
  }

  if (trashFolder === 'users') {
    const role = USER_ROLE_BY_VALUE[item.role] || USER_ROLE_BY_VALUE.readonly;
    const posts = Number(item.live_posts) || 0;
    const comments = Number(item.live_comments) || 0;
    return {
      chips: trashChipHtml(role.label),
      title: escapeHtml(item.name || '(không tên)'),
      meta:
        `${escapeHtml(item.email || '')} · ` +
        // Deleting an account does not delete what it wrote, so the row says what
        // is still on the site under this name - and what purging would take with it.
        `còn ${posts} bài viết, ${comments} bình luận đang hiển thị · ${when}`,
    };
  }

  // media
  return {
    chips: trashChipHtml(String(item.mime_type || 'tệp').replace(/^image\//, '')),
    title: escapeHtml(displayName(item) || item.filename || '—'),
    meta: `${escapeHtml(formatBytes(item.bytes))} · ${escapeHtml(formatDimensions(item))} · tải lên bởi ${escapeHtml(
      item.uploader_name || '—'
    )} · ${when}`,
  };
}

function trashRowHtml(item) {
  const body = trashBodyHtml(item);
  // The two actions are the only controls in the row, and they are found by
  // delegation on #trash-list (data-trash-action) rather than by an inline onclick:
  // every row is replaced on each load, so a per-button listener would have to be
  // re-attached each time.
  return `
      <div class="trash-row p-4 sm:p-6 flex items-start justify-between gap-3 sm:gap-4" data-trash-id="${item.id}">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 flex-wrap mb-1">${body.chips}</div>
          <h4 class="font-headline-sm text-headline-sm text-on-background break-words">${body.title}</h4>
          <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">${body.meta}</p>
        </div>
        <div class="flex items-center gap-2 flex-shrink-0">
          <button type="button" data-trash-action="restore" class="glass-btn tap-target px-4 py-2.5 rounded-lg font-label-md text-label-md uppercase text-on-surface-variant flex items-center gap-2"><span class="material-symbols-outlined" style="font-size:18px" aria-hidden="true">restore</span>Khôi phục</button>
          <button type="button" data-trash-action="purge" class="glass-btn glass-btn--danger tap-target px-4 py-2.5 rounded-lg font-label-md text-label-md uppercase flex items-center gap-2"><span class="material-symbols-outlined" style="font-size:18px" aria-hidden="true">delete_forever</span>Xoá vĩnh viễn</button>
        </div>
      </div>`;
}

// In place rather than a toast: the message is about the list, and it sits directly
// above the list that just changed.
function trashMsg(text, isError) {
  const el = document.getElementById('trash-msg');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('hidden', !text);
  el.classList.toggle('text-error', Boolean(isError));
  el.classList.toggle('text-on-surface-variant', !isError);
}

function trashSetBusy(busy) {
  trashBusy = busy;
  document.querySelectorAll('#trash-list [data-trash-action]').forEach((btn) => {
    btn.disabled = busy;
  });
}

async function trashRestore(id) {
  if (trashBusy) return;
  const folder = TRASH_FOLDERS[trashFolder];
  trashSetBusy(true);
  try {
    const res = await API.trashRestore(trashFolder, id);
    applyTrashCounts(res.counts);
    // The row just left this page, so the page count may have shrunk with it -
    // step back rather than redraw an empty list.
    const left = Number(trashCounts[trashFolder]) || 0;
    await loadTrash(Math.min(trashPage, Math.max(1, Math.ceil(left / TRASH_PAGE_SIZE))));
    // After the reload, not before: loadTrash() rewrites the list, and a message
    // written first would be describing a list that is no longer on screen.
    trashMsg(`Đã khôi phục ${folder.noun}. Nó đã trở lại trang như trước khi bị xoá.`);
  } catch (e) {
    // Reload as well as report: the usual cause is that the row is no longer in
    // the bin (another admin got there first), and a stale row that cannot be
    // acted on is worse than a refresh.
    await loadTrash(trashPage);
    trashMsg(e.message, true);
  } finally {
    trashSetBusy(false);
  }
}

// The one irreversible thing left in the app, so it is the one that has to say
// exactly what goes with it. Each folder names its own cascade: a post takes the
// comments that came in with it, an account takes everything it ever wrote, a
// comment takes its replies, a file takes its two shrunk copies.
function trashPurgeQuestion(item) {
  if (!item) return 'Xoá vĩnh viễn mục này? Thao tác này không thể hoàn tác.';
  if (trashFolder === 'posts') {
    const n = Number(item.trashed_comments) || 0;
    return (
      `Xoá vĩnh viễn "${item.title || '(không có tiêu đề)'}"?` +
      (n ? ` Bài viết và ${n} bình luận đi theo nó` : ' Bài viết') +
      ' sẽ bị xoá hẳn khỏi cơ sở dữ liệu. Không thể khôi phục.'
    );
  }
  if (trashFolder === 'comments') {
    return 'Xoá vĩnh viễn bình luận này? Bình luận và mọi trả lời bên dưới nó sẽ bị xoá hẳn. Không thể khôi phục.';
  }
  if (trashFolder === 'users') {
    const posts = Number(item.live_posts) || 0;
    const comments = Number(item.live_comments) || 0;
    return (
      `Xoá vĩnh viễn "${item.name || '(không tên)'}"?` +
      ` Tài khoản cùng ${posts} bài viết và ${comments} bình luận của họ sẽ bị xoá hẳn. Không thể khôi phục.`
    );
  }
  return `Xoá vĩnh viễn "${displayName(item) || item.filename || 'tệp này'}"? Tệp và hai bản thu nhỏ của nó sẽ bị xoá khỏi máy chủ. Không thể khôi phục.`;
}

async function trashPurge(id) {
  if (trashBusy) return;
  const item = trashItems.find((i) => Number(i.id) === Number(id));
  if (!confirm(trashPurgeQuestion(item))) return;
  const folder = TRASH_FOLDERS[trashFolder];
  trashSetBusy(true);
  try {
    const res = await API.trashPurge(trashFolder, id);
    applyTrashCounts(res.counts);
    const left = Number(trashCounts[trashFolder]) || 0;
    await loadTrash(Math.min(trashPage, Math.max(1, Math.ceil(left / TRASH_PAGE_SIZE))));
    trashMsg(`Đã xoá vĩnh viễn ${folder.noun}.`, false);
  } catch (e) {
    await loadTrash(trashPage);
    trashMsg(e.message, true);
  } finally {
    trashSetBusy(false);
  }
}

function initTrashControls() {
  const chips = document.getElementById('trash-folder-chips');
  const list = document.getElementById('trash-list');
  const pager = document.getElementById('trash-pager');
  if (!chips || !list || !pager) return;

  // Delegated on the row that holds the chips, exactly as the Users tab's filter
  // row is: one listener outlives every re-render.
  chips.addEventListener('click', (e) => {
    const btn = e.target.closest('.user-chip');
    if (!btn) return;
    const folder = btn.dataset.folder;
    // A click on the folder already open is not a request. The count inside the
    // pill is a child of the button, so closest() still lands on the chip.
    if (!folder || !TRASH_FOLDERS[folder] || folder === trashFolder) return;
    trashFolder = folder;
    trashPage = 1;
    chips.querySelectorAll('.user-chip').forEach((b) => b.classList.toggle('active', b === btn));
    // A different folder is a different question, so the answer to the last one -
    // "đã khôi phục bài viết" - would be about a list that is no longer on screen.
    trashMsg('');
    loadTrash(1);
  });

  list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-trash-action]');
    if (!btn || btn.disabled) return;
    const row = btn.closest('.trash-row');
    const id = Number(row && row.dataset.trashId);
    if (!id) return;
    if (btn.dataset.trashAction === 'restore') trashRestore(id);
    else trashPurge(id);
  });

  pager.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-trash-page]');
    if (!btn || btn.disabled) return;
    const target = Number(btn.dataset.trashPage);
    if (!target || target === trashPage) return;
    trashMsg('');
    loadTrash(target);
    // 'nearest' moves the page only if it must, as the Users tab's pager does.
    list.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

// ---- Settings tab ----
async function loadSettings() {
  try {
    const { settings } = await API.adminGetSettings();
    const form = document.getElementById('settings-form');
    Object.keys(settings).forEach((key) => {
      if (form[key]) form[key].value = settings[key];
    });
    renderAuthorPhotoPreview();
    renderFaviconPreview();
  } catch (e) {
    alert(e.message);
  }
}

// ---- Author photo (Về tác giả > Ảnh tác giả) ----
// URL + preview + clear, no upload path of
// its own - an /uploads/... link from the Thư viện tab can still be pasted
// in. Stored as the `author_photo` setting, read by /about.html through the
// same data-setting-src mechanism favicon already uses (see
// render-html.js) - no new server code for this page at all.
function authorPhotoEls() {
  return {
    url: document.getElementById('settings-author_photo'),
    preview: document.getElementById('author-photo-preview'),
    clear: document.getElementById('author-photo-clear'),
  };
}

function renderAuthorPhotoPreview() {
  const { url, preview } = authorPhotoEls();
  if (!url || !preview) return;
  const value = url.value.trim();
  if (value) {
    preview.src = value;
    preview.classList.remove('hidden');
  } else {
    preview.removeAttribute('src');
    preview.classList.add('hidden');
  }
}

function initAuthorPhotoControl() {
  const { url, clear } = authorPhotoEls();
  if (!url || !clear) {
    // Older cached admin.html - skip quietly instead of breaking the whole panel.
    return;
  }
  url.addEventListener('input', renderAuthorPhotoPreview);
  clear.addEventListener('click', () => {
    url.value = '';
    renderAuthorPhotoPreview();
  });
}

// ---- Favicon (icon trên tab trình duyệt) ----
// Same shape as the author-photo control plus an upload button: the value is
// stored as the `favicon` setting, filled into <link rel="icon"> on every page
// by server/render-html.js before first paint, and kept in step without a
// reload by applySiteBranding() in api.js.
function faviconEls() {
  return {
    url: document.getElementById('settings-favicon'),
    preview: document.getElementById('favicon-preview'),
    status: document.getElementById('favicon-status'),
    file: document.getElementById('favicon-file'),
    upload: document.getElementById('favicon-upload-btn'),
    clear: document.getElementById('favicon-clear'),
  };
}

function renderFaviconPreview() {
  const { url, preview } = faviconEls();
  if (!url || !preview) return;
  const value = url.value.trim();
  if (value) {
    preview.src = value;
    preview.classList.remove('hidden');
  } else {
    preview.removeAttribute('src');
    preview.classList.add('hidden');
  }
}

function setFaviconStatus(text, isError) {
  const { status } = faviconEls();
  if (!status) return;
  status.textContent = text;
  status.classList.remove('hidden');
  status.classList.toggle('text-error', Boolean(isError));
  status.classList.toggle('text-on-surface-variant', !isError);
}

const FAVICON_ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

async function uploadFavicon(file) {
  const { url } = faviconEls();
  if (!url) return;
  // Same whitelist the server enforces in routes/upload.js - checked here too for
  // instant feedback. Empty file.type on some browsers falls back to the extension.
  const extOk = /\.(jpe?g|png|webp|gif)$/i.test(file.name || '');
  if (!FAVICON_ALLOWED_TYPES.includes(file.type) && !extOk) {
    setFaviconStatus('Chỉ chấp nhận ảnh JPG, PNG, WEBP hoặc GIF.', true);
    return;
  }
  setFaviconStatus('Đang tải icon lên...');
  try {
    const { url: uploadedUrl } = await API.uploadImage(file);
    url.value = uploadedUrl;
    renderFaviconPreview();
    setFaviconStatus('Tải icon thành công! Nhấn "Lưu cài đặt" để áp dụng.');
  } catch (err) {
    setFaviconStatus(err.message, true);
  }
}

function initFaviconControl() {
  const { url, file, upload, clear } = faviconEls();
  if (!url || !file || !upload || !clear) {
    // Older cached admin.html - skip quietly instead of breaking the whole panel.
    return;
  }
  upload.addEventListener('click', () => file.click());
  file.addEventListener('change', (e) => {
    const picked = e.target.files[0];
    if (picked) uploadFavicon(picked);
    // Reset so picking the same file twice in a row still fires 'change'.
    e.target.value = '';
  });
  url.addEventListener('input', renderFaviconPreview);
  clear.addEventListener('click', () => {
    url.value = '';
    renderFaviconPreview();
    setFaviconStatus('Đã xoá icon. Nhấn "Lưu cài đặt" để áp dụng.');
  });
}

document.getElementById('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const payload = Object.fromEntries(fd.entries());
  const msg = document.getElementById('settings-message');
  try {
    await API.adminUpdateSettings(payload);
    // The admin page carries the brand name too, so refresh it in place -
    // otherwise the header here keeps showing the old name until a reload.
    await refreshSiteSettings();
    msg.innerHTML =
      'Đã lưu cài đặt! <a href="/index.html" target="_blank" class="underline font-semibold">Mở trang chủ</a> để xem thay đổi.';
    msg.classList.remove('hidden', 'text-error');
    msg.classList.add('text-tertiary-container');
  } catch (err) {
    msg.textContent = err.message;
    msg.classList.remove('hidden');
    msg.classList.add('text-error');
  }
});

// ---- Email settings tab (Cài đặt email) ----
// Configures the mailbox used for new-post notifications and forgot-password
// OTP codes. The SMTP password is write-only: the GET never returns it, so an
// empty password field on save means "keep the stored one".
//
// Wired from initEmailSettingsControls(), called by initAdmin(), for the same
// reason as the other settings controls: a browser holding a cached admin.html
// without these elements would otherwise throw while this file is still being
// evaluated and take down every tab.

const EMAIL_PROVIDER_PRESETS = {
  gmail: {
    host: 'smtp.gmail.com',
    port: 465,
    help: 'Gmail yêu cầu <b>App Password</b> 16 ký tự (không phải mật khẩu đăng nhập thường) và phải bật Xác minh 2 bước trước.',
  },
  office365: {
    host: 'smtp.office365.com',
    port: 587,
    help: 'Office 365 yêu cầu App Password và hộp thư phải được bật <b>Authenticated SMTP</b> trong Exchange admin center.',
  },
  'office365-oauth': {
    host: 'smtp.office365.com',
    port: 587,
    help:
      'Xác thực bằng <b>OAuth2 app-only</b> thay cho mật khẩu. Chỉ dùng được nếu quản trị viên có quyền chạy Exchange Online PowerShell. Không cần Redirect URI.',
  },
  'office365-oauth-delegated': {
    host: 'smtp.office365.com',
    port: 587,
    help:
      'Xác thực bằng <b>OAuth2 uỷ quyền</b>: chủ hộp thư đăng nhập <b>một lần</b>, máy chủ giữ refresh token và tự làm mới. <b>Không cần Exchange Online PowerShell</b> &mdash; chọn cách này nếu bạn không có quyền đó.',
  },
  custom: { help: 'Nhập máy chủ, cổng và chế độ bảo mật do nhà cung cấp SMTP của bạn công bố.' },
};

// Step-by-step prerequisites differ per mode: app-only needs two Exchange
// PowerShell cmdlets that delegated mode does without, and that difference is the
// whole reason the delegated option exists.
const EMAIL_OAUTH_STEPS = {
  'office365-oauth':
    '1. Tạo App registration trong Microsoft Entra (không cần Redirect URI).<br>' +
    '2. Cấp quyền <b>Application</b>: Office 365 Exchange Online &rsaquo; <b>SMTP.SendAsApp</b>, rồi bấm <b>Grant admin consent</b>.<br>' +
    '3. Chạy Exchange Online PowerShell: <b>New-ServicePrincipal</b> (dùng Object ID lấy từ <b>Enterprise applications</b>, không phải App registrations) và <b>Add-MailboxPermission</b> cho hộp thư gửi.<br>' +
    '4. Bật SMTP AUTH cho hộp thư đó: <b>Set-CASMailbox -SmtpClientAuthenticationDisabled $false</b> &mdash; OAuth2 vẫn bị chặn nếu cờ này đang tắt.',
  'office365-oauth-delegated':
    '1. Tạo App registration trong Microsoft Entra, thêm <b>Redirect URI (Web)</b> đúng như giá trị hiển thị bên dưới.<br>' +
    '2. Cấp quyền <b>Delegated</b>: Office 365 Exchange Online &rsaquo; <b>SMTP.Send</b>, và Microsoft Graph &rsaquo; <b>offline_access</b>.<br>' +
    '3. Tạo <b>Client secret</b> và lưu lại giá trị (chỉ hiện một lần).<br>' +
    '4. Bấm nút đăng nhập bên dưới và đăng nhập bằng chính hộp thư gửi.<br>' +
    '<b>Không cần</b> New-ServicePrincipal / Add-MailboxPermission. Nếu tenant chưa cho phép người dùng tự đồng ý, quản trị viên chỉ cần bấm <b>Grant admin consent</b> một lần trên trang app &mdash; vẫn không cần Exchange PowerShell. ' +
    'Riêng <b>Set-CASMailbox -SmtpClientAuthenticationDisabled $false</b> thì vẫn bắt buộc nếu SMTP AUTH đang tắt cho hộp thư.',
};

const EMAIL_PROVIDER_VALUES = ['gmail', 'office365', 'office365-oauth', 'office365-oauth-delegated', 'custom'];
const EMAIL_OAUTH_PROVIDERS = ['office365-oauth', 'office365-oauth-delegated'];
const EMAIL_DELEGATED_PROVIDERS = ['office365-oauth-delegated'];

const EMAIL_TEXT_FIELDS = ['host', 'port', 'user', 'from_name', 'from_email', 'site_url', 'tenant_id', 'client_id'];
// Every checkbox on the email form, and the only list of them: renderEmailSettings()
// ticks what the server sent from it, and submitEmailSettings() builds the payload
// from it. The four admin-event toggles are in here with the two reader-facing ones
// because they ride the same form and the same PUT - a second list would be a second
// place to forget one, and a forgotten checkbox is silently un-saveable.
const EMAIL_CHECKBOXES = [
  'notify_new_post',
  'otp_enabled',
  'notify_comment_reported',
  'notify_new_comment',
  'notify_new_user',
  'notify_comment_hidden',
];

// What each admin-event toggle says in the status banner, in the order the
// checkboxes appear on the form.
const EMAIL_ADMIN_TOGGLE_LABELS = {
  notify_comment_reported: 'bình luận bị báo cáo',
  notify_new_comment: 'bình luận mới',
  notify_new_user: 'người dùng mới',
  notify_comment_hidden: 'ẩn / bỏ ẩn bình luận',
};

// "a, b và c" - the list joiner Vietnamese uses, written out because the banner
// reads as a sentence and a comma before "và" would not.
function joinVi(list) {
  if (list.length <= 1) return list[0] || '';
  return `${list.slice(0, -1).join(', ')} và ${list[list.length - 1]}`;
}

function emailEls() {
  return {
    form: document.getElementById('email-settings-form'),
    provider: document.getElementById('email-provider'),
    customFields: document.getElementById('email-custom-fields'),
    secure: document.getElementById('email-secure'),
    pass: document.getElementById('email-pass'),
    passHint: document.getElementById('email-pass-hint'),
    passToggle: document.getElementById('email-pass-toggle'),
    passClear: document.getElementById('email-pass-clear'),
    passwordField: document.getElementById('email-password-field'),
    oauthFields: document.getElementById('email-oauth-fields'),
    secret: document.getElementById('email-client_secret'),
    secretHint: document.getElementById('email-secret-hint'),
    secretToggle: document.getElementById('email-secret-toggle'),
    secretClear: document.getElementById('email-secret-clear'),
    oauthSteps: document.getElementById('email-oauth-steps'),
    consentBlock: document.getElementById('email-consent-block'),
    consentBtn: document.getElementById('email-consent-btn'),
    consentStatus: document.getElementById('email-consent-status'),
    redirectUri: document.getElementById('email-redirect-uri'),
    userHint: document.getElementById('email-user-hint'),
    providerHelp: document.getElementById('email-provider-help'),
    banner: document.getElementById('email-status-banner'),
    bannerIcon: document.getElementById('email-status-icon'),
    bannerText: document.getElementById('email-status-text'),
    message: document.getElementById('email-settings-message'),
    testBtn: document.getElementById('email-test-btn'),
    testTo: document.getElementById('email-test-to'),
    testMessage: document.getElementById('email-test-message'),
  };
}

// Tracks whether a password is already stored server-side, so an untouched form
// doesn't wipe it and the hint text stays accurate after a save.
let emailPasswordSet = false;
// Set when the admin presses "Xoá" on the password, so the save sends an
// explicit clear instead of being read as "leave it alone".
let emailPasswordCleared = false;
// The OAuth2 client secret follows the same write-only pattern as the password.
let emailSecretSet = false;
let emailSecretCleared = false;
// Delegated mode: whether a refresh token from the one-time sign-in is stored.
let emailRefreshTokenSet = false;

function applyEmailProviderUI() {
  const { provider, customFields, providerHelp, oauthFields, passwordField, oauthSteps, consentBlock } = emailEls();
  if (!provider) return;
  const preset = EMAIL_PROVIDER_PRESETS[provider.value] || EMAIL_PROVIDER_PRESETS.custom;
  const isCustom = provider.value === 'custom';
  const isOauth = EMAIL_OAUTH_PROVIDERS.includes(provider.value);
  const isDelegated = EMAIL_DELEGATED_PROVIDERS.includes(provider.value);

  customFields.classList.toggle('hidden', !isCustom);
  customFields.classList.toggle('flex', isCustom);

  // In OAuth2 mode the password is unused, so hiding it keeps an admin from
  // filling it in and concluding the config is complete when it isn't.
  if (oauthFields) {
    oauthFields.classList.toggle('hidden', !isOauth);
    oauthFields.classList.toggle('flex', isOauth);
  }
  if (passwordField) passwordField.classList.toggle('hidden', isOauth);

  if (oauthSteps) oauthSteps.innerHTML = EMAIL_OAUTH_STEPS[provider.value] || '';
  if (consentBlock) {
    consentBlock.classList.toggle('hidden', !isDelegated);
    consentBlock.classList.toggle('flex', isDelegated);
  }
  renderConsentStatus();

  providerHelp.innerHTML = preset.help;
}

// Shows whether the delegated grant is in place. Kept separate from the provider
// toggle so it can be refreshed after a save or after returning from the sign-in
// without rebuilding the whole panel.
function renderConsentStatus() {
  const { consentStatus, provider } = emailEls();
  if (!consentStatus || !provider) return;
  if (!EMAIL_DELEGATED_PROVIDERS.includes(provider.value)) {
    consentStatus.textContent = '';
    return;
  }
  consentStatus.innerHTML = emailRefreshTokenSet
    ? '<span class="text-tertiary-container">Đã cấp quyền. Chỉ cần đăng nhập lại nếu đổi hộp thư gửi.</span>'
    : '<span class="text-error">Chưa cấp quyền &mdash; email sẽ không gửi được.</span>';
}

function setEmailBanner(state, html) {
  const { banner, bannerIcon, bannerText } = emailEls();
  if (!banner) return;
  const styles = {
    ok: ['border-tertiary-container/40', 'bg-tertiary-container/10', 'text-tertiary-container', 'check_circle'],
    warn: ['border-error/40', 'bg-error/10', 'text-error', 'warning'],
  };
  const [border, bg, text, icon] = styles[state] || styles.warn;
  banner.className = `mb-6 rounded-xl border p-4 flex items-start gap-3 ${border} ${bg} ${text}`;
  bannerIcon.textContent = icon;
  bannerText.innerHTML = html;
}

function renderEmailSettings(data) {
  const { form, provider, secure, pass, passHint, userHint, secret, secretHint } = emailEls();
  const s = data.settings || {};

  provider.value = EMAIL_PROVIDER_VALUES.includes(s.provider) ? s.provider : 'gmail';
  EMAIL_TEXT_FIELDS.forEach((key) => {
    if (form[key]) form[key].value = s[key] ?? '';
  });
  secure.value = s.secure === '0' ? '0' : '1';
  EMAIL_CHECKBOXES.forEach((key) => {
    if (form[key]) form[key].checked = s[key] === '1';
  });

  emailPasswordSet = Boolean(data.passwordSet);
  emailPasswordCleared = false;
  pass.value = '';
  pass.placeholder = emailPasswordSet ? '•••••••• (đã lưu - để trống nếu không đổi)' : 'Chưa cấu hình';
  passHint.innerHTML = emailPasswordSet
    ? 'Đã có mật khẩu được lưu. Để trống ô này nếu không muốn thay đổi.'
    : 'Chưa có mật khẩu nào được lưu.';

  emailSecretSet = Boolean(data.clientSecretSet);
  emailSecretCleared = false;
  if (secret) {
    secret.value = '';
    secret.placeholder = emailSecretSet ? '•••••••• (đã lưu - để trống nếu không đổi)' : 'Chưa cấu hình';
  }
  if (secretHint) {
    secretHint.innerHTML = emailSecretSet
      ? 'Đã có client secret được lưu. Để trống ô này nếu không muốn thay đổi.'
      : 'Chưa có client secret nào được lưu.';
  }

  emailRefreshTokenSet = Boolean(data.refreshTokenSet);

  // The redirect URI has to be pasted into the app registration before the
  // sign-in can succeed, so it is filled in on load rather than when the button
  // is pressed - by then it is too late to be useful.
  const { redirectUri } = emailEls();
  if (redirectUri && data.oauthRedirectUri) redirectUri.textContent = data.oauthRedirectUri;

  // Point out when .env is still the one supplying a value, so an admin who
  // sees a blank field doesn't conclude email is unconfigured.
  const env = data.fromEnv || {};
  userHint.innerHTML = env.user
    ? `Đang dùng <b>${escapeHtml(data.effective?.user || '')}</b> từ tệp <code>.env</code>. Nhập giá trị ở đây để ghi đè.`
    : 'Với Gmail/Office 365 đây chính là địa chỉ hộp thư dùng để gửi.';

  applyEmailProviderUI();

  const eff = data.effective || {};
  // The admin-event mail has a prerequisite the two reader-facing kinds do not: it
  // goes to the site's contact address, which is set on another tab. Ticking a box
  // here and receiving nothing is the one failure this form cannot demonstrate by
  // itself, so the banner says it out loud.
  const adminKinds = Object.keys(EMAIL_ADMIN_TOGGLE_LABELS)
    .filter((key) => s[key] === '1')
    .map((key) => EMAIL_ADMIN_TOGGLE_LABELS[key]);
  const adminText = adminKinds.length ? ` Đang gửi cho quản trị viên email về ${joinVi(adminKinds)}.` : '';
  const contactWarn =
    adminKinds.length && !data.contactEmailSet
      ? ' <b>Chưa đặt Email liên hệ</b> (Quản lí trang chủ), nên những email đó chưa gửi được.'
      : '';
  if (eff.configured) {
    const kinds = [];
    if (s.notify_new_post === '1') kinds.push('thông báo bài viết mới');
    if (s.otp_enabled === '1') kinds.push('OTP quên mật khẩu');
    const kindText = kinds.length
      ? joinVi(kinds)
      : // "cho độc giả" is what makes this honest once the admin-event toggles can
        // be on: the two switches named here are the reader-facing ones, and the
        // next sentence reports the owner's separately.
        '<b>không loại email nào cho độc giả</b> (cả hai công tắc đang tắt)';
    const siteWarn = eff.site_url
      ? ''
      : ' <b>Chưa có địa chỉ trang</b>, link trong email thông báo sẽ bị hỏng.';
    setEmailBanner(
      'ok',
      `Email đã được cấu hình: <b>${escapeHtml(eff.user || '')}</b> qua <b>${escapeHtml(eff.host || '')}:${eff.port}</b>${
        eff.oauth ? ` bằng <b>OAuth2${eff.delegated ? ' uỷ quyền' : ' app-only'}</b>` : ''
      }. Đang gửi ${kindText}.${adminText}${siteWarn}${contactWarn}`
    );
  } else {
    // A delegated setup that is only missing the sign-in is the common case, and
    // the generic warning would send the admin looking for a missing field.
    const needConsent = eff.delegated && !data.refreshTokenSet && data.clientSecretSet;
    setEmailBanner(
      'warn',
      needConsent
        ? `Đã có app registration nhưng <b>chưa đăng nhập Microsoft để cấp quyền</b>. Bấm nút "Đăng nhập Microsoft để cấp quyền" bên dưới để hoàn tất.${contactWarn}`
        : `Chưa cấu hình đủ để gửi email. Thiếu thông tin thì <b>thông báo bài viết mới sẽ bị bỏ qua</b> và người dùng <b>không nhận được OTP</b> khi quên mật khẩu.${contactWarn}`
    );
  }
  emailEls().banner.classList.remove('hidden');
}

async function loadEmailSettings() {
  const { message } = emailEls();
  try {
    renderEmailSettings(await API.adminGetEmailSettings());
    showEmailOauthResult();
  } catch (e) {
    if (message) {
      message.textContent = userActionError(e);
      message.classList.remove('hidden', 'text-tertiary-container');
      message.classList.add('text-error');
    }
  }
}

function setEmailMessage(el, text, isError, asHtml) {
  if (!el) return;
  if (asHtml) el.innerHTML = text;
  else el.textContent = text;
  el.classList.remove('hidden');
  el.classList.toggle('text-error', Boolean(isError));
  el.classList.toggle('text-tertiary-container', !isError);
}

async function submitEmailSettings(e) {
  e.preventDefault();
  const { form, message } = emailEls();
  const payload = {
    provider: form.provider.value,
    secure: form.secure.value,
  };
  // Checkboxes are absent from FormData when unchecked, so they are read directly -
  // otherwise turning one off would leave the old value in place. One loop over the
  // same list that renders them, so the payload and the form cannot disagree about
  // which switches exist.
  EMAIL_CHECKBOXES.forEach((key) => {
    if (form[key]) payload[key] = form[key].checked ? '1' : '0';
  });
  EMAIL_TEXT_FIELDS.forEach((key) => {
    if (form[key]) payload[key] = form[key].value.trim();
  });

  if (emailPasswordCleared) payload.clear_password = true;
  else if (form.pass.value) payload.pass = form.pass.value;

  if (emailSecretCleared) payload.clear_client_secret = true;
  else if (form.client_secret && form.client_secret.value) payload.client_secret = form.client_secret.value;

  try {
    renderEmailSettings(await API.adminUpdateEmailSettings(payload));
    setEmailMessage(message, 'Đã lưu cài đặt email. Dùng nút "Kiểm tra" bên dưới để xác nhận đăng nhập thành công.', false);
  } catch (err) {
    setEmailMessage(message, userActionError(err), true);
  }
}

async function runEmailTest() {
  const { testBtn, testTo, testMessage } = emailEls();
  const to = testTo.value.trim();
  testBtn.disabled = true;
  testBtn.classList.add('opacity-60');
  setEmailMessage(testMessage, to ? `Đang kết nối và gửi thử tới ${to}...` : 'Đang kiểm tra kết nối...', false);
  try {
    const res = await API.adminTestEmail(to);
    setEmailMessage(testMessage, res.message || 'Kết nối SMTP thành công.', false);
  } catch (err) {
    setEmailMessage(testMessage, userActionError(err), true);
  } finally {
    testBtn.disabled = false;
    testBtn.classList.remove('opacity-60');
  }
}

function initEmailSettingsControls() {
  const { form, provider, pass, passHint, passToggle, passClear, testBtn } = emailEls();
  if (!form || !provider || !pass || !passToggle || !passClear || !testBtn) {
    // Older cached admin.html - skip quietly instead of breaking the whole panel.
    return;
  }

  provider.addEventListener('change', applyEmailProviderUI);
  form.addEventListener('submit', submitEmailSettings);
  testBtn.addEventListener('click', runEmailTest);

  passToggle.addEventListener('click', () => {
    const showing = pass.type === 'text';
    pass.type = showing ? 'password' : 'text';
    passToggle.querySelector('span').textContent = showing ? 'visibility' : 'visibility_off';
  });

  pass.addEventListener('input', () => {
    // Typing again cancels a pending clear.
    if (pass.value) emailPasswordCleared = false;
  });

  passClear.addEventListener('click', () => {
    pass.value = '';
    emailPasswordCleared = true;
    passHint.innerHTML = 'Sẽ xoá mật khẩu đã lưu khi bạn nhấn "Lưu cài đặt".';
  });

  // The OAuth2 secret controls only exist on an admin.html that has the OAuth
  // block, so they are wired separately and guarded - an older cached page must
  // still get a working password-based form rather than an early return.
  const { secret, secretHint, secretToggle, secretClear } = emailEls();
  if (!secret || !secretToggle || !secretClear) return;

  secretToggle.addEventListener('click', () => {
    const showing = secret.type === 'text';
    secret.type = showing ? 'password' : 'text';
    secretToggle.querySelector('span').textContent = showing ? 'visibility' : 'visibility_off';
  });

  secret.addEventListener('input', () => {
    if (secret.value) emailSecretCleared = false;
  });

  secretClear.addEventListener('click', () => {
    secret.value = '';
    emailSecretCleared = true;
    if (secretHint) secretHint.innerHTML = 'Sẽ xoá client secret đã lưu khi bạn nhấn "Lưu cài đặt".';
  });

  const { consentBtn } = emailEls();
  if (consentBtn) consentBtn.addEventListener('click', startEmailOauthConsent);
}

// Asks the server for the Microsoft sign-in URL, then navigates to it. The URL is
// built server-side so the client never has to know the tenant, scope or state -
// and the state it returns is what authorises the callback.
async function startEmailOauthConsent() {
  const { consentBtn, consentStatus, redirectUri } = emailEls();
  consentBtn.disabled = true;
  consentBtn.classList.add('opacity-60');
  if (consentStatus) consentStatus.textContent = 'Đang tạo liên kết đăng nhập...';
  try {
    const { url, redirectUri: uri } = await API.adminEmailOauthUrl();
    if (redirectUri && uri) redirectUri.textContent = uri;
    window.location.href = url;
  } catch (e) {
    if (consentStatus) consentStatus.innerHTML = `<span class="text-error">${escapeHtml(userActionError(e))}</span>`;
    consentBtn.disabled = false;
    consentBtn.classList.remove('opacity-60');
  }
}

// Reports the result of the Microsoft round-trip. The callback redirects back with
// these query params because it has no way to talk to this page directly.
function showEmailOauthResult() {
  const params = new URLSearchParams(window.location.search);
  const status = params.get('email_oauth');
  if (!status) return;

  const { testMessage } = emailEls();
  const detail = params.get('email_oauth_detail') || '';
  if (testMessage) {
    setEmailMessage(
      testMessage,
      status === 'ok'
        ? 'Đã cấp quyền Microsoft thành công. Bấm "Kiểm tra" để gửi thử.'
        : `Cấp quyền thất bại: ${escapeHtml(detail)}`,
      status !== 'ok',
      true
    );
  }

  // Strip the params so a reload doesn't replay a stale result.
  params.delete('email_oauth');
  params.delete('email_oauth_detail');
  const qs = params.toString();
  window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash);
}

initAdmin();

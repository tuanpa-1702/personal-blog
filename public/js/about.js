document.getElementById('footer-year').textContent = new Date().getFullYear();

// Everything on this page comes from the author_* settings (Bảng quản trị >
// Quản lí trang chủ > "Về tác giả") - one fetch, then plain show/hide and
// textContent/src assignment. No admin has set these up yet on a fresh
// install, so an empty author_name (the one field that must be set for the
// page to mean anything) shows the "chưa thiết lập" note instead of a card
// with a blank heading and no photo.
const SOCIAL_KEYS = ['facebook', 'instagram', 'youtube', 'tiktok', 'website'];

(async function loadAuthorPage() {
  const settings = await getSiteSettings();
  const card = document.getElementById('author-card');
  const empty = document.getElementById('author-empty');
  const name = String(settings.author_name || '').trim();

  if (!name) {
    empty.classList.remove('hidden');
    return;
  }

  card.classList.remove('hidden');
  document.getElementById('author-name').textContent = name;

  // The photo COLUMN, not just the <img> - the column is 2/3 of the row
  // (see #author-card's own CSS), so leaving it in the layout empty would
  // hold that much blank space open next to the text. Hiding the column
  // lets the text column's flex:1 fill the freed width instead.
  const photoUrl = String(settings.author_photo || '').trim();
  if (photoUrl) {
    const photo = document.getElementById('author-photo');
    photo.src = photoUrl;
    photo.alt = name;
    photo.classList.remove('hidden');
  } else {
    document.getElementById('author-photo-col').classList.add('hidden');
  }

  // Paragraphs break onto the next line with no blank line between them
  // (feedback 2026-10-04): any run of empty lines in the saved text collapses
  // to a single line break. The stored setting itself is left as typed.
  const bio = String(settings.author_bio || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n[ \t]*(?:\n[ \t]*)+/g, '\n')
    .trim();
  if (bio) {
    const bioEl = document.getElementById('author-bio');
    bioEl.textContent = bio;
    bioEl.classList.remove('hidden');
  }

  let hasAnySocial = false;
  for (const key of SOCIAL_KEYS) {
    const url = String(settings[`author_${key}`] || '').trim();
    if (!url) continue;
    const link = document.getElementById(`author-link-${key}`);
    if (!link) continue;
    link.href = url;
    link.classList.remove('hidden');
    hasAnySocial = true;
  }
  if (hasAnySocial) document.getElementById('author-social').classList.remove('hidden');
})();

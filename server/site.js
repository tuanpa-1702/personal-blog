const db = require('./db');

// Fallback site name, used when the admin has not set one (Admin > Quản lí
// trang chủ > "Tên thương hiệu" / "Tiêu đề trang"), or when the settings row
// is missing entirely - an older database, or a failed read.
//
// The editable values live in the `settings` table under `brand_name` (the logo
// text) and `site_title` (the browser-tab title). An EMPTY value falls back to
// this constant on purpose: unlike footer_text, a blank site name is never
// something an admin actually wants - it would leave the header with no logo
// and the tab with no name at all.
const DEFAULT_SITE_NAME = 'TuanPA';

// Resolves both names out of an already-read settings object, so the HTML
// renderer does not re-query per page. Kept in one place because the client
// (public/js/api.js) has to apply exactly the same precedence.
function siteNamesFrom(settings) {
  const brand = String(settings?.brand_name ?? '').trim() || DEFAULT_SITE_NAME;
  // The tab title defaults to the logo text, so setting just the brand name
  // renames both instead of leaving the tab on the old name.
  const title = String(settings?.site_title ?? '').trim() || brand;
  return { brand, title };
}

// Same values, read straight from the database. For code paths with no settings
// object at hand (outgoing email, for instance).
function getSiteName() {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('brand_name');
    return String(row?.value ?? '').trim() || DEFAULT_SITE_NAME;
  } catch (e) {
    return DEFAULT_SITE_NAME;
  }
}

// The address admin event emails go to (a reported comment, a new signup...).
// Same `settings` table as brand_name and read here for the same reason: the
// mailer has no settings object at hand.
//
// Returns '' when unset or not shaped like an address, and the CALLER must skip
// the send - never fall back to from_email: that is the OUTGOING mailbox, and for
// Gmail/O365 it has to match the account that signs in (see deliverabilityWarnings()
// in mailer.js), so it is usually not the site owner's inbox at all.
function getContactEmail() {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('contact_email');
    const value = String(row?.value ?? '').trim();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : '';
  } catch (e) {
    return '';
  }
}

module.exports = { DEFAULT_SITE_NAME, siteNamesFrom, getSiteName, getContactEmail };

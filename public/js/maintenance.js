// UI-only: the footer year on the maintenance notice page (see server/maintenance.js).
// Moved out of an inline <script> so this page's CSP does not need
// script-src 'unsafe-inline' either - see server/security-headers.js.
document.getElementById('maintenance-year').textContent = new Date().getFullYear();

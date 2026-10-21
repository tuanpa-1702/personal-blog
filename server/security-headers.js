// Security response headers.
//
// Hand-written rather than `helmet` for the reason given in server/compress.js and
// server/middleware/rate-limit.js: node_modules is installed ON THE UBUNTU SERVER
// (better-sqlite3's .node is an ELF binary) and the tree is edited over a Samba
// mount from Windows, so an `npm install helmet` from the Windows side re-resolves
// better-sqlite3, swaps that binary for a win32 prebuild, and takes the site down.
//
// Cloudflare sits in front of this app, but none of these can be left to it: the
// tunnel forwards whatever the origin sends, and a header the origin omits is a
// header the browser never sees.

// Content-Security-Policy.
//
// script-src no longer carries 'unsafe-inline'. It used to, because admin.html
// and write.html carried inline onclick="" attributes - a legacy of the Stitch
// HTML export they were adapted from - and every other page's topbar had
// already been migrated to the data-action delegated-listener dispatch table
// in public/js/api.js (see wireGlobalHandlers() there). That migration is what
// let this directive tighten: the last two pages' inline handlers were moved
// onto the same table, and their page-specific ones (loadActivity,
// openAddUserModal, ...) were wired with addEventListener in admin.js instead.
//
// Two genuinely static inline <script> blocks remain (public/profile.html and,
// implicitly, none any more in write.html/admin.html/maintenance.html - those
// were moved into their per-page .js files the same way). A static block that
// never varies per request can be allowed by its exact SHA-256 hash instead of
// by 'unsafe-inline': an attacker's injected <script> is a DIFFERENT string
// with a different hash, so it still will not execute. If profile.html's inline
// block is ever edited, its hash below must be recomputed
// (crypto.createHash('sha256').update(<script's exact text content>, 'utf8').digest('base64'))
// or the browser will silently refuse to run it.
//
// Without 'unsafe-inline', a bypass in the hand-written sanitizer
// (server/sanitize-html.js) that smuggles a <script> or an on*= handler into a
// post/comment can no longer execute - this is the directive that matters most
// for XSS, and it is now a real control rather than a documented gap.
//
// Every other directive here was already a real control that cost nothing to
// enable:
//
//   object-src 'none'      - no <object>/<embed>/<applet>, a classic script vector.
//   base-uri 'none'        - an injected <base href> cannot re-point every relative
//                            URL on the page at an attacker's origin.
//   frame-ancestors 'none' - the admin panel cannot be framed, which is what
//                            clickjacking needs.
//   form-action 'self'     - an injected <form> cannot post credentials off-origin.
//   connect-src 'self'     - script that does run cannot exfiltrate to another
//                            origin over fetch/XHR/WebSocket. This is the one that
//                            blunts a stolen-token attack even while script-src
//                            stays loose.
//   img-src                - https: and data: are needed (dicebear avatars,
//                            unsplash hero images, uploaded files).
//   frame-src              - exactly the embed providers, taken from
//                            server/embeds.js so the CSP and the resolver cannot
//                            disagree about what is embeddable. This is the second
//                            half of the embed control: even if a crafted src got
//                            past the resolver, the browser would refuse to load a
//                            frame from anywhere else.
const { EMBED_ORIGINS } = require('./embeds');

// SHA-256 of the exact text content of the one inline <script> left in
// public/profile.html (the multi-panel / deep-link wiring, kept inline rather
// than moved to profile.js because it deliberately runs before /js/api.js
// parses - see the comment on that block). Recompute and replace this if that
// block's content ever changes even by one character.
const PROFILE_INLINE_SCRIPT_HASH = "'sha256-i6Oc8pD1KylifT+2kxOLR9LzdOhqU+dRB6Ls5yYCyPs='";

const CSP_DIRECTIVES = [
  "default-src 'self'",
  `script-src 'self' ${PROFILE_INLINE_SCRIPT_HASH}`,
  // Tailwind's output and the hand-written common.css are files, but the pages also
  // set style="" inline in places the renderer fills in, and the rich-text content
  // legitimately carries inline colour declarations. Every stylesheet this app
  // loads is one of those files now - the body family moved off the Google Fonts
  // CDN and is self-hosted in /css/fonts.css, so no third origin remains here.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  // The woff2 faces fonts.css points at, all on this origin (hashed filenames
  // under /fonts/, served immutable). Self-hosting is what let font-src drop
  // fonts.gstatic.com: a CSP that allows a font origin allows any font from it.
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  // Video and map embeds in posts. Listed per-origin rather than as https: - the
  // point of a frame allowlist is that it is a list.
  `frame-src ${EMBED_ORIGINS.join(' ')}`,
  "worker-src 'none'",
  "manifest-src 'self'",
];

const CSP = CSP_DIRECTIVES.join('; ');

// HSTS is only meaningful over TLS, and only safe once HTTPS definitely works for
// every path - a browser that has seen it will refuse plain HTTP for the whole
// max-age. Cloudflare terminates TLS here, so the origin is reached over HTTP and
// req.secure is false unless 'trust proxy' says otherwise; the header is therefore
// emitted only when the request really arrived over HTTPS.
//
// includeSubDomains is deliberately omitted: this deployment is one hostname on a
// domain whose other subdomains are not necessarily HTTPS-only, and asserting it
// for them would break them.
const HSTS = 'max-age=31536000';

function securityHeaders() {
  return function securityHeadersMiddleware(req, res, next) {
    res.setHeader('Content-Security-Policy', CSP);

    // Stops a browser from guessing a response's type from its bytes. Matters most
    // for /uploads/: a file that sniffs as HTML would run as HTML from this origin.
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // frame-ancestors above supersedes this for modern browsers; kept for the ones
    // that only understand the old header.
    res.setHeader('X-Frame-Options', 'DENY');

    // Send the full URL only to this origin. Without it the path a reader came
    // from - including a token that ended up in a URL - travels to every external
    // image and link target.
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    // None of these are used, and an injected iframe cannot ask for them either.
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');

    // Cross-origin isolation for the document itself: a page opened from this one
    // gets no window.opener reference back, and another origin cannot embed this
    // document as a subresource.
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

    // `req.secure` reads X-Forwarded-Proto, which requires app.set('trust proxy').
    if (req.secure) res.setHeader('Strict-Transport-Security', HSTS);

    next();
  };
}

module.exports = { securityHeaders, CSP, CSP_DIRECTIVES };

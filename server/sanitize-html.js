// Allowlist HTML sanitizer for the rich-text paragraph blocks.
//
// WHY THIS EXISTS
// The previous version was four regexes over the source string. Regexes cannot
// sanitize HTML, and these did not: `\son\w+\s*=` only matches when whitespace
// precedes the handler, so every one of these got through untouched -
//
//   <img/onerror=alert(1) src=x>
//   <svg/onload=alert(1)>
//   <a href=javascript:alert(1)>x</a>      (the href regex needed quotes)
//   <details/ontoggle=alert(1) open>
//
// - while the token lives in localStorage and there is no CSP. An `editor`
// account writing a post was therefore one step from an admin's session.
//
// WHY IT IS WRITTEN BY HAND
// Same constraint as server/compress.js and server/middleware/rate-limit.js:
// node_modules is installed ON THE UBUNTU SERVER (better-sqlite3's .node is an
// ELF binary) and the tree is edited over a Samba mount from Windows. An
// `npm install sanitize-html` from the Windows side re-resolves better-sqlite3
// and swaps that binary for a win32 prebuild, which takes the site down. So the
// choice was a hand-written sanitizer or a broken deployment.
//
// WHAT MAKES IT SOUND ANYWAY
// It does not filter the input - it PARSES the input and re-serialises from the
// parse result. Nothing reaches the output that was not recognised as an
// allowlisted tag, an allowlisted attribute, or text. That is the property the
// regex version lacked: there, anything the patterns failed to recognise was
// passed through verbatim, so every unanticipated spelling was a bypass. Here an
// unrecognised construct produces nothing at all, so an unanticipated spelling
// is at worst lost formatting.
//
// Three further consequences of re-serialising, each closing its own class of
// attack:
//   * Tags are balanced against a stack. A stray </div> in the content cannot
//     close the wrapper the post body is rendered into.
//   * Raw-text elements (script/style/textarea/iframe/...) are skipped whole,
//     content included, so nothing inside one can be mis-attributed.
//   * Elements that switch the parser into another namespace (svg, math) are
//     dropped, which is what most mutation-XSS (mXSS) vectors need.

// ---------------------------------------------------------------- allowlists

// Tag -> attributes permitted on it. The set is what the contenteditable editor
// in public/js/write.js can actually produce (see the RT_* tables in
// public/js/api.js), plus what a paste from a document realistically brings.
// `class` and `style` are validated per value further down, not merely allowed.
const GLOBAL_ATTRS = ['class', 'style'];

const TAGS = {
  // Inline marks. <font> is here because execCommand writes it and the stored
  // form keeps it until upgradeRichTextMarks() rewrites it on render. Its
  // `color` is not: that is the attribute spelling of an inline ink colour, and
  // it is refused for the same reason `color` is absent from STYLE_PROPS below.
  b: [], strong: [], i: [], em: [], u: [], s: [], strike: [], del: [], ins: [],
  sub: [], sup: [], mark: [], small: [], code: [], kbd: [], samp: [], var: [],
  abbr: ['title'], span: [], font: ['size', 'face'], br: [], wbr: [],

  // Blocks.
  p: [], div: [], blockquote: ['cite'], pre: [], hr: [],
  h1: [], h2: [], h3: [], h4: [], h5: [], h6: [],
  ul: [], ol: ['start', 'type', 'reversed'], li: ['value'], dl: [], dt: [], dd: [],
  figure: [], figcaption: [],

  // Links and images. rel/target are normalised rather than trusted (see below).
  a: ['href', 'title', 'name', 'target', 'rel'],
  img: ['src', 'alt', 'title', 'width', 'height', 'loading', 'decoding'],

  // Tables, because a paste from a spreadsheet or Word brings them.
  table: [], thead: [], tbody: [], tfoot: [], caption: [],
  tr: [], th: ['colspan', 'rowspan', 'scope', 'abbr'], td: ['colspan', 'rowspan'],
  col: ['span'], colgroup: ['span'],
};

// Emitted without a closing tag.
const VOID = new Set(['br', 'wbr', 'hr', 'img', 'col']);

// A heading is auto-closed the moment one of these starts inside it - see the
// call site in sanitizeRichHtml() below for why. Every block tag a heading
// could plausibly end up wrapping (including another heading, so headings
// cannot nest inside each other either) plus the two most likely from a
// pasted document, table and figure.
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const CLOSES_HEADING = new Set([
  'p', 'div', 'blockquote', 'pre', 'hr', 'ul', 'ol', 'dl',
  'table', 'figure', ...HEADING_TAGS,
]);

// Dropped along with everything up to the matching close tag.
//
// The browser parses the contents of these as raw text, so a tokeniser that
// treated them as markup would disagree with it about where tags begin - which is
// the seam mXSS lives in. Skipping the element whole means there is nothing to
// disagree about. `svg` and `math` are here for the same reason: they switch the
// parser into a foreign namespace where the ordinary rules do not hold.
const SKIP_CONTENT = new Set([
  'script', 'style', 'textarea', 'title', 'xmp', 'plaintext', 'noembed',
  'noframes', 'noscript', 'iframe', 'object', 'embed', 'applet', 'template',
  'svg', 'math', 'frame', 'frameset', 'base', 'link', 'meta', 'form',
  'input', 'button', 'select', 'option', 'audio', 'video', 'source', 'track',
  'canvas', 'map', 'area', 'portal',
]);

// ---------------------------------------------------------------- values

// Class names the rendered post may carry. Everything the editor writes is one of
// the rt-* families in public/js/api.js; anything else is a paste artefact and is
// dropped rather than let into a page whose own stylesheet it could reach.
// An unknown class cannot execute anything, but it can borrow layout from the
// site's own CSS - `class="hidden"` on the wrapper hides the whole post body.
const CLASS_RE = /^(?:rt-[a-z0-9-]+|webkit-indent-blockquote)$/;

// CSS declarations kept. What a paste carries and the render pass already reasons
// about (indent detection reads margin-left and border), plus the weight/style/
// alignment that are the author's own emphasis.
//
// No colour PROPERTY is in this list, ink or background, and that is a contrast
// decision rather than a house-style one: the site's dark theme is a single
// `.dark` class re-pointing the `--c-*` variables, and an inline declaration
// beats every stylesheet rule including the token that class just moved. A
// paragraph pasted from Google Docs arrives wrapped in `style="color:#000000"`
// and stayed black on a near-black surface, unreadable, with nothing allowed to
// override it. So the ink comes from the theme and the only background a run may
// have is `.rt-mark`, which is two tokens - see stripLiteralColours() and
// markInlineHighlights() in public/js/api.js, which strip the same things at
// render time for the content stored before this list changed. `border` stays,
// and a border may name a colour; a line that disappears against a dark surface
// is a lost rule, not unreadable text.
const STYLE_PROPS = new Set([
  'font-weight', 'font-style', 'text-decoration', 'text-decoration-line',
  'text-align', 'margin-left', 'margin', 'padding', 'border', 'border-style',
  'vertical-align', 'white-space', 'font-variant',
]);

// A declaration value must be plain: no url(), no expression(), no escapes that
// could reconstitute either, and no comment that could hide a second declaration.
// Sanitizing CSS properly is its own problem; refusing anything exotic is the
// defensible move, and cost here is only lost formatting.
const STYLE_VALUE_RE = /^[a-zA-Z0-9\s,.#%()/'"-]+$/;
const STYLE_VALUE_BANNED = /url\(|expression|javascript:|@import|\\|\/\*|\*\//i;

function filterStyle(value) {
  const kept = [];
  for (const part of String(value).split(';')) {
    const at = part.indexOf(':');
    if (at === -1) continue;
    const prop = part.slice(0, at).trim().toLowerCase();
    const val = part.slice(at + 1).trim();
    if (!STYLE_PROPS.has(prop) || !val) continue;
    if (!STYLE_VALUE_RE.test(val) || STYLE_VALUE_BANNED.test(val)) continue;
    kept.push(`${prop}: ${val}`);
  }
  return kept.join('; ');
}

function filterClass(value) {
  return String(value)
    .split(/\s+/)
    .filter((c) => c && CLASS_RE.test(c))
    .join(' ');
}

// Decides whether a URL may appear in href/src.
//
// The scheme is read after stripping the characters a browser ignores when it
// resolves one: leading control characters and whitespace, and any TAB/LF/CR
// inside the scheme itself. `java\tscript:alert(1)` and `  javascript:alert(1)`
// are both live URLs in a browser, and both would pass a naive startsWith check.
// HTML entity decoding has already happened by the time a value reaches here -
// the tokeniser below decodes attribute values - so `&#106;avascript:` is seen in
// its decoded form too.
// Characters a browser discards while resolving a URL: C0 controls (TAB/LF/CR
// included) and whitespace. `java&#9;script:` and a leading-space
// ` javascript:` are both live URLs, so the scheme is read after removing them.
const RE_URL_IGNORABLE = /[\u0000-\u0020\s]/g;
const SAFE_SCHEME = /^(?:https?|mailto|tel|ftp):/;

function safeUrl(value) {
  const raw = String(value);
  const probe = raw.replace(RE_URL_IGNORABLE, '').toLowerCase();
  // Relative, absolute-path, anchor and query URLs carry no scheme at all: these
  // are the common case here (/uploads/… for an uploaded image).
  if (!/^[a-z][a-z0-9+.-]*:/.test(probe)) {
    // Protocol-relative (//evil.com) is a scheme-less absolute URL to another
    // origin. Nothing in this app needs one.
    return probe.startsWith('//') ? null : raw;
  }
  if (!SAFE_SCHEME.test(probe)) return null;
  return raw;
}

// data: URLs are refused wholesale, including data:image/*. A data: image cannot
// itself run script, but data:image/svg+xml can, and distinguishing the two means
// parsing the payload - not worth it when every image in this app is either an
// /uploads/ path or an https URL.

// ---------------------------------------------------------------- text escaping

// Text nodes. `<` and `&` are what can start markup; the quotes are escaped too so
// one routine is safe for both text and attribute values.
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeText(str) {
  return String(str).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

// Attribute values are decoded before validation - a browser decodes them, so
// `href="&#106;avascript:alert(1)"` must be seen as `javascript:` here - then
// re-escaped on output. Only the named entities a real paste produces plus numeric
// forms; an unrecognised entity is left as literal text, exactly as a browser
// treats it.
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(str) {
  return String(str).replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (match, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = NAMED[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}


// ---------------------------------------------------------------- tokenizer

// Reads one attribute list, starting just after the tag name. Returns the
// attributes plus where the open tag ended.
//
// Attribute names are matched as [^\s/>=]+, which is what the HTML spec allows and
// crucially is NOT anchored to whitespace: `<img/onerror=x>` tokenises as tag `img`
// with attribute `onerror`, so the allowlist sees it and drops it. The regex
// sanitizer missed exactly this shape because it required whitespace first.
const ATTR_RE = /([^\s/>=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?/g;

function readAttrs(html, from) {
  ATTR_RE.lastIndex = from;
  const attrs = [];
  for (;;) {
    // Skip separators, including the '/' of a self-closing tag.
    while (from < html.length && /[\s/]/.test(html[from])) from++;
    if (from >= html.length || html[from] === '>') break;

    ATTR_RE.lastIndex = from;
    const m = ATTR_RE.exec(html);
    if (!m || m.index !== from) break;

    const name = m[1].toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    // An unquoted value stops at whitespace or '>', so it cannot smuggle either.
    attrs.push([name, decodeEntities(value)]);
    from = ATTR_RE.lastIndex;
  }
  // Past the '>' if there is one; a truncated tag ends the input.
  const close = html.indexOf('>', from);
  return { attrs, end: close === -1 ? html.length : close + 1 };
}

// Which attributes survive on one element, in a fixed order so the output is
// deterministic (worth having: the render pass and the tests both compare strings).
function filterAttrs(tag, attrs) {
  const allowed = TAGS[tag];
  const out = [];
  for (const [name, rawValue] of attrs) {
    // Every on* handler dies here, whatever its spelling, because nothing in any
    // allowlist starts with "on". This is the check the regex version was trying
    // to be.
    if (!allowed.includes(name) && !GLOBAL_ATTRS.includes(name)) continue;

    let value = rawValue;
    if (name === 'href' || name === 'src') {
      const safe = safeUrl(value);
      if (safe === null) continue;
      value = safe;
    } else if (name === 'class') {
      value = filterClass(value);
      if (!value) continue;
    } else if (name === 'style') {
      value = filterStyle(value);
      if (!value) continue;
    } else if (name === 'target') {
      // A pasted target could be anything; only _blank is meaningful and it is
      // paired with rel below.
      if (value !== '_blank') continue;
    } else if (name === 'rel') {
      continue; // recomputed below, never taken from the input
    }
    out.push([name, value]);
  }

  // target="_blank" without noopener hands window.opener to the opened page.
  // Added rather than trusted from the input, so it cannot be turned off.
  if (out.some(([n, v]) => n === 'target' && v === '_blank')) {
    out.push(['rel', 'noopener noreferrer']);
  }
  return out;
}

function serializeOpen(tag, attrs) {
  const rendered = attrs.map(([n, v]) => ` ${n}="${escapeText(v)}"`).join('');
  return `<${tag}${rendered}>`;
}

// ---------------------------------------------------------------- main

// Parses `html` and re-serialises only what is allowlisted.
//
// The output is built from the parse result, never by editing the input, so an
// unrecognised construct contributes nothing instead of passing through.
function sanitizeRichHtml(html) {
  const input = String(html ?? '');
  let out = '';
  const open = []; // tags awaiting a close, innermost last
  let i = 0;

  while (i < input.length) {
    const lt = input.indexOf('<', i);
    if (lt === -1) {
      out += escapeText(decodeEntities(input.slice(i)));
      break;
    }
    if (lt > i) out += escapeText(decodeEntities(input.slice(i, lt)));

    // Comments and CDATA: dropped whole. `<!--` can hide markup from a naive
    // scanner, and conditional comments used to execute in old IE.
    if (input.startsWith('<!--', lt)) {
      const close = input.indexOf('-->', lt + 4);
      i = close === -1 ? input.length : close + 3;
      continue;
    }
    // Doctype, processing instructions, and anything else starting `<!` or `<?`.
    if (input[lt + 1] === '!' || input[lt + 1] === '?') {
      const close = input.indexOf('>', lt);
      i = close === -1 ? input.length : close + 1;
      continue;
    }

    // Closing tag. No whitespace allowed after `</`: per spec `</ div>` is a bogus
    // comment, not a close tag, and it is dropped by the !m branch below.
    if (input[lt + 1] === '/') {
      const m = /^<\/([a-zA-Z][a-zA-Z0-9-]*)/.exec(input.slice(lt));
      const close = input.indexOf('>', lt);
      i = close === -1 ? input.length : close + 1;
      if (!m) continue;
      const tag = m[1].toLowerCase();
      // Only closes a tag this sanitizer actually opened, and only by unwinding to
      // it. A stray </div> in the content therefore cannot close the wrapper the
      // post body is rendered into - it matches nothing on the stack and is
      // discarded.
      const at = open.lastIndexOf(tag);
      if (at === -1) continue;
      while (open.length > at) out += `</${open.pop()}>`;
      continue;
    }

    // Opening tag. A tag name must follow `<` IMMEDIATELY - `a < b` is text, and
    // allowing whitespace here would turn the `<` of a comparison into a tag,
    // swallowing the words after it. This is what a browser does too.
    const m = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(input.slice(lt));
    if (!m) {
      // A bare '<' that starts no tag is literal text - and must be escaped, or it
      // would reach the page as markup.
      out += '&lt;';
      i = lt + 1;
      continue;
    }
    const tag = m[1].toLowerCase();
    const { attrs, end } = readAttrs(input, lt + m[0].length);

    if (SKIP_CONTENT.has(tag)) {
      // Skip to the matching close tag, content included. Nothing inside is
      // examined, so nothing inside can be mis-tokenised. String.raw because in
      // an ordinary template literal `\s` collapses to the letter "s", which
      // quietly turns the pattern into `</s*tags*>`.
      const closeRe = new RegExp(String.raw`</\s*${tag}\s*>`, 'i');
      const rest = input.slice(end);
      const found = rest.search(closeRe);
      i = found === -1 ? input.length : end + found + rest.match(closeRe)[0].length;
      continue;
    }

    if (!Object.prototype.hasOwnProperty.call(TAGS, tag)) {
      // Unknown tag: drop the tag, keep its children. That is what preserves the
      // text of a pasted <section> or <article> instead of deleting a paragraph.
      i = end;
      continue;
    }

    // A heading is closed the instant a block element starts inside it. This
    // parser has no content model otherwise - any allowlisted tag can nest
    // inside any other - so nothing stopped the editor's own formatBlock bug
    // (a Heading command applied to a selection spanning several paragraphs
    // and a pasted table) from storing one <h2> that wrapped a paragraph, a
    // whole table, and another paragraph as its children. post.js's
    // buildToc() takes an h1/h2/h3's ENTIRE textContent as one TOC entry, so
    // that post's sidebar showed a table's cells run together with no
    // separators in place of a short section title. Closing the heading here
    // is cheap insurance against that regardless of what the editor produces
    // upstream: a heading becomes what every reasonable reader of "heading"
    // already assumes it can only be - a single line of inline text.
    if (open.length && HEADING_TAGS.has(open[open.length - 1]) && CLOSES_HEADING.has(tag)) {
      out += `</${open.pop()}>`;
    }

    out += serializeOpen(tag, filterAttrs(tag, attrs));
    if (!VOID.has(tag)) {
      const selfClosed = /\/\s*>$/.test(input.slice(lt, end));
      if (selfClosed) out += `</${tag}>`;
      else open.push(tag);
    }
    i = end;
  }

  // Anything still open is closed here, so the fragment cannot leak structure into
  // the page around it.
  while (open.length) out += `</${open.pop()}>`;
  return out;
}

// Plain text from already-sanitized rich HTML (an excerpt's own stored value,
// for the contexts that cannot render markup at all - a <meta description>,
// a plain-text email body, a JSON-LD summary). Re-runs sanitizeRichHtml first
// rather than trusting the input is already safe, so a caller reaching for
// "just give me text" can point this at anything, not only a value that has
// already been through this module once.
function stripHtml(html) {
  return sanitizeRichHtml(html).replace(/<[^>]*>/g, '');
}

module.exports = { sanitizeRichHtml, stripHtml, TAGS, VOID, SKIP_CONTENT };

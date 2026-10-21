// URL -> embeddable iframe source, for the embed block in the post editor.
//
// THE SECURITY SHAPE OF THIS FILE
// An <iframe src> is a page loaded into ours. A caller-supplied URL must therefore
// never reach one: `javascript:` runs in our origin, `data:text/html` does too, and
// an arbitrary https page gets a frame it can use for clickjacking or a fake login.
//
// So this module does NOT sanitize a URL - it PARSES a recognised one and BUILDS a
// new URL from an extracted id and a hardcoded template. The id is checked against
// its own charset, and nothing from the input is ever interpolated into the output
// except that validated id (or, for the two cases that need it, a percent-encoded
// parameter). The consequence is the property that matters: the set of URLs this can
// ever produce is fixed by the code, not by the input.
//
// Every origin here also has to be listed in `frame-src` in server/security-headers.js,
// which is the second half of the control: even if something got past this, the
// browser would refuse to load a frame from anywhere else.
//
// Blocks store the RESOLVED url (see routes/posts.js), so the reader-side renderer in
// public/js/api.js never parses anything - it checks the stored value against a short
// prefix list and uses it. There is one parser, on the server.

// A YouTube id is exactly 11 characters of an unreserved alphabet.
const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const NUMERIC = /^[0-9]{1,20}$/;
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
const DRIVE_ID = /^[A-Za-z0-9_-]{10,64}$/;
// Google's own "embed a map" URL carries an opaque `pb` blob. It is passed through
// rather than rebuilt - nothing else can express that map - so its charset is pinned.
const MAPS_PB = /^[A-Za-z0-9_!.,%$*+~-]{10,2000}$/;

// How each provider's frame should be proportioned. Consumed as a CSS aspect-ratio,
// except the two that are a fixed height by nature (a Spotify player has a designed
// height, not a ratio).
const RATIO = {
  video: '16 / 9',
  vertical: '9 / 16',
  map: '4 / 3',
  square: '1 / 1',
};

function parse(raw) {
  // WHATWG URL parsing, not a regex: it normalises case, resolves escapes, and
  // rejects the malformed input a regex would happily match part of.
  try {
    const u = new URL(String(raw).trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    // Leading "www." is noise for matching; the host is compared lowercase.
    return { u, host: u.hostname.toLowerCase().replace(/^www\./, '') };
  } catch {
    return null;
  }
}


// ---------------------------------------------------------------- providers
//
// One entry per platform. `match` returns the embed descriptor or null; it is handed
// an already-parsed URL so no entry does its own string surgery.
//
// Each `src` is a template literal with exactly one interpolation - the validated id.
// That is deliberate and worth preserving: it makes the whole output auditable by
// reading this table.
const PROVIDERS = [
  {
    name: 'youtube',
    label: 'YouTube',
    // Five spellings, all in the wild: watch?v=, youtu.be/, /embed/, /shorts/, /live/.
    match({ host, u }) {
      let id = null;
      if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
        if (u.pathname === '/watch') id = u.searchParams.get('v');
        else {
          const m = /^\/(?:embed|shorts|live|v)\/([^/?#]+)/.exec(u.pathname);
          if (m) id = m[1];
        }
      } else if (host === 'youtu.be') {
        id = u.pathname.slice(1).split('/')[0];
      } else if (host === 'youtube-nocookie.com') {
        const m = /^\/embed\/([^/?#]+)/.exec(u.pathname);
        if (m) id = m[1];
      }
      if (!id || !YT_ID.test(id)) return null;

      // A start time is the one parameter worth keeping - a link into the middle of a
      // talk is usually the point of sharing it. Digits only, so it cannot carry
      // anything else into the query string.
      const t = u.searchParams.get('t') || u.searchParams.get('start') || '';
      const start = /^[0-9]{1,6}$/.test(t) ? `?start=${t}` : '';

      // youtube-nocookie.com is Youtube's own no-tracking-until-play host. Same
      // player, no cookie set on load - a better default for a reader who has not
      // asked to watch anything.
      return {
        provider: 'youtube',
        src: `https://www.youtube-nocookie.com/embed/${id}${start}`,
        ratio: RATIO.video,
        title: 'Video YouTube',
      };
    },
  },
  {
    name: 'vimeo',
    label: 'Vimeo',
    match({ host, u }) {
      if (host !== 'vimeo.com' && host !== 'player.vimeo.com') return null;
      // vimeo.com/123456789, and player.vimeo.com/video/123456789
      const m = /^\/(?:video\/)?([0-9]+)/.exec(u.pathname);
      if (!m || !NUMERIC.test(m[1])) return null;
      return {
        provider: 'vimeo',
        src: `https://player.vimeo.com/video/${m[1]}`,
        ratio: RATIO.video,
        title: 'Video Vimeo',
      };
    },
  },
  {
    name: 'tiktok',
    label: 'TikTok',
    match({ host, u }) {
      if (!host.endsWith('tiktok.com')) return null;
      // The canonical form carries the id in the path: /@user/video/1234567890.
      // A vm.tiktok.com short link resolves only by following a redirect, which this
      // deliberately does not do - see the note in resolveEmbed().
      const m = /\/video\/([0-9]+)/.exec(u.pathname);
      if (!m || !NUMERIC.test(m[1])) return null;
      return {
        provider: 'tiktok',
        src: `https://www.tiktok.com/embed/v2/${m[1]}`,
        ratio: RATIO.vertical,
        title: 'Video TikTok',
      };
    },
  },
  {
    name: 'spotify',
    label: 'Spotify',
    match({ host, u }) {
      if (host !== 'open.spotify.com') return null;
      // /track/<id>, /album/<id>, /playlist/<id>, /episode/<id>, /show/<id>, and the
      // /intl-vi/ prefixed variants Spotify now emits.
      const m = /^(?:\/intl-[a-z]{2})?\/(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]+)/.exec(u.pathname);
      if (!m || !SPOTIFY_ID.test(m[2])) return null;
      return {
        provider: 'spotify',
        src: `https://open.spotify.com/embed/${m[1]}/${m[2]}`,
        // A Spotify player is a fixed-height widget, not a ratio: a compact one for a
        // single track, taller for a list that scrolls inside the frame.
        height: m[1] === 'track' || m[1] === 'episode' ? 152 : 352,
        title: 'Spotify',
      };
    },
  },
  {
    name: 'facebook',
    label: 'Facebook',
    match({ host, u }) {
      if (!host.endsWith('facebook.com') && host !== 'fb.watch') return null;
      // Facebook's plugin takes the original URL as a parameter rather than an id, so
      // this is the one provider whose output embeds part of the input. It is
      // percent-encoded into a single query parameter of a hardcoded origin, so it
      // cannot change which page is framed - only what that page is asked to show.
      const isVideo = /\/videos?\//.test(u.pathname) || host === 'fb.watch' || u.pathname.startsWith('/watch');
      const href = encodeURIComponent(u.toString());
      return {
        provider: 'facebook',
        src: isVideo
          ? `https://www.facebook.com/plugins/video.php?href=${href}&show_text=false`
          : `https://www.facebook.com/plugins/post.php?href=${href}`,
        ratio: isVideo ? RATIO.video : undefined,
        height: isVideo ? undefined : 500,
        title: isVideo ? 'Video Facebook' : 'Bài viết Facebook',
      };
    },
  },
  {
    name: 'drive',
    label: 'Google Drive',
    match({ host, u }) {
      if (host !== 'drive.google.com' && host !== 'docs.google.com') return null;
      // /file/d/<id>/view, or ?id=<id>
      const m = /\/file\/d\/([^/?#]+)/.exec(u.pathname);
      const id = m ? m[1] : u.searchParams.get('id');
      if (!id || !DRIVE_ID.test(id)) return null;
      return {
        provider: 'drive',
        src: `https://drive.google.com/file/d/${id}/preview`,
        ratio: RATIO.video,
        title: 'Google Drive',
      };
    },
  },
  {
    name: 'maps',
    label: 'Google Maps',
    match({ host, u }) {
      if (host !== 'google.com' && !host.startsWith('google.') && host !== 'maps.google.com') return null;
      // Only the /maps/embed form, which is what "Chia sẻ > Nhúng bản đồ" produces.
      // A plain maps link cannot be framed at all (Google sends X-Frame-Options), so
      // accepting one would render an empty box - better to refuse and say why.
      if (!u.pathname.startsWith('/maps/embed')) return null;
      const pb = u.searchParams.get('pb') || '';
      if (!MAPS_PB.test(pb)) return null;
      return {
        provider: 'maps',
        src: `https://www.google.com/maps/embed?pb=${encodeURIComponent(pb)}`,
        ratio: RATIO.map,
        title: 'Google Maps',
      };
    },
  },
];

// Resolves a pasted URL to an embed, or returns why it cannot.
//
// It deliberately does NOT follow redirects to resolve a short link (youtu.be is
// handled above because its id is in the path; vm.tiktok.com and fb.watch are not).
// Doing so would make the server fetch an arbitrary URL on a caller's behalf - an
// SSRF primitive - to save the author one paste of the canonical link.
function resolveEmbed(rawUrl) {
  const parsed = parse(rawUrl);
  if (!parsed) {
    return { error: 'Đường dẫn không hợp lệ. Hãy dán một URL https đầy đủ.' };
  }
  for (const provider of PROVIDERS) {
    const hit = provider.match(parsed);
    if (hit) return { embed: hit };
  }
  return {
    error:
      'Chưa hỗ trợ nhúng từ trang này. Hiện hỗ trợ: YouTube, Vimeo, TikTok, Spotify, Facebook, Google Drive và Google Maps (dùng link "Nhúng bản đồ").',
  };
}

// The origins an embed src may have. Used by routes/posts.js to re-check a stored
// value, and by server/security-headers.js to build `frame-src` - one list, so the
// CSP and the sanitiser cannot disagree about what is embeddable.
const EMBED_ORIGINS = [
  'https://www.youtube-nocookie.com',
  'https://player.vimeo.com',
  'https://www.tiktok.com',
  'https://open.spotify.com',
  'https://www.facebook.com',
  'https://drive.google.com',
  'https://www.google.com',
];

// Is this a value resolveEmbed() could have produced? Cheap prefix check, run on
// save and again on render, so a row edited in the database by hand - or a block
// crafted by a client that skipped the resolve step - cannot introduce a frame from
// an origin the CSP does not even allow.
function isAllowedEmbedSrc(value) {
  const src = String(value || '');
  return EMBED_ORIGINS.some((o) => src.startsWith(o + '/'));
}

module.exports = {
  RATIO,
  PROVIDERS,
  EMBED_ORIGINS,
  resolveEmbed,
  isAllowedEmbedSrc,
};

// Light / dark / night-reading (sepia) theme switch.
//
// Loaded as a BLOCKING <script> in every page's <head>, ahead of the Tailwind
// CDN and common.css. That placement is the whole point: the .dark class has to
// be on <html> before the first paint, otherwise the browser paints the light
// theme and then repaints dark a frame later - a white flash on every single
// navigation, worst on the pages a dark-theme reader looks at in a dark room.
// It is deliberately NOT deferred, NOT async and NOT bundled into api.js (which
// loads at the end of <body>, far too late).
//
// Four states:
//   'dark'  - forced dark
//   'light' - forced light
//   'sepia' - "Đọc ban đêm": a warm coffee-brown night palette for long reads.
//             It is a VARIANT of dark, not a fourth independent theme: <html>
//             carries BOTH .dark and .sepia, so every .dark rule on the site
//             (colour-scheme, the dark shadow set, the .dark .theme-* swaps)
//             still applies, and editorial.css's html.dark.sepia block only
//             re-points the --ed-* palette on top. Nothing that already works
//             in dark has to learn about a third theme.
//   null    - follow the OS (prefers-color-scheme), and keep following it
// A fresh visitor gets the OS preference; only an explicit tap writes the key.
// The picker (the "Giao diện" row in the account menu, js/api.js) offers the
// three explicit choices; null stays as the untouched-visitor default.
// The stored value is the SAME key across the site (one device-wide choice, not
// per page), and it lives in localStorage rather than on the account: it is a
// property of the screen you are reading on, so it must not follow you onto a
// different device, and it must work before you sign in.
(function () {
  const KEY = 'tuanpa_theme';
  const DARK = 'dark';
  const LIGHT = 'light';
  const SEPIA = 'sepia';
  // Only light and dark can be picked now (the picker is Sáng / Tối / Tự động).
  // SEPIA stays for apply() and the html.dark.sepia CSS, but a stored 'sepia'
  // from the old "Đọc ban đêm" option is migrated to dark in read().
  const valid = (v) => v === DARK || v === LIGHT;

  // Safari in private mode throws on localStorage access rather than returning
  // null, so every read and write is guarded. A failure just means the choice
  // does not survive a reload - the toggle itself still works for the session.
  function read() {
    try {
      const v = localStorage.getItem(KEY);
      if (v === SEPIA) {
        localStorage.setItem(KEY, DARK);
        return DARK;
      }
      return valid(v) ? v : null;
    } catch {
      return null;
    }
  }
  function write(value) {
    try {
      if (value === null) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, value);
    } catch {
      /* ignore - see above */
    }
  }

  const query = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const systemPrefersDark = () => !!(query && query.matches);

  // What is actually on screen: the stored choice, or the OS when there is none.
  function effective() {
    const stored = read();
    if (stored) return stored;
    return systemPrefersDark() ? DARK : LIGHT;
  }

  // The single place the classes are set. Tailwind's darkMode: 'class' and the
  // .dark block in common.css both hang off .dark; sepia adds .sepia beside it.
  function apply(mode) {
    const root = document.documentElement;
    root.classList.toggle(DARK, mode === DARK || mode === SEPIA);
    root.classList.toggle(SEPIA, mode === SEPIA);
    // The browser UI (address bar on Android, form controls, scrollbars) follows
    // the meta tag and color-scheme, not the class - without this the scrollbar
    // stays light-grey against a dark page.
    //
    // Light comes from the tag's OWN static content rather than a value
    // hardcoded here, so a page carrying a different theme (index.html's
    // editorial redesign, css/home-editorial.css) gets its own tint instead of
    // every page being forced back to the site-wide one. Every page but that
    // one already has content="#faf8ff" in its markup, so this is a no-op
    // everywhere else. Dark has no such per-page value to read (the class does
    // that work instead), so it stays an explicit attribute the page can opt
    // into - data-theme-color-dark - with the site-wide dark tint as the
    // default for every page that does not set one.
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      if (!meta.dataset.themeColorLight) meta.dataset.themeColorLight = meta.getAttribute('content') || '#faf8ff';
      const dark = meta.dataset.themeColorDark || '#0b1020';
      const sepia = meta.dataset.themeColorSepia || '#24201d';
      meta.setAttribute(
        'content',
        mode === SEPIA ? sepia : mode === DARK ? dark : meta.dataset.themeColorLight
      );
    }
    return mode;
  }

  // Runs NOW, while <head> is still parsing - see the note at the top.
  apply(effective());

  // While in auto mode, a change to the OS setting is followed live. Once the
  // reader has made an explicit choice we stop listening to the OS, because the
  // explicit choice is meant to win.
  if (query) {
    const onSystemChange = () => {
      if (read()) return;
      notify(apply(effective()));
    };
    if (query.addEventListener) query.addEventListener('change', onSystemChange);
    else if (query.addListener) query.addListener(onSystemChange); // Safari < 14
  }

  // Another tab on the same origin changed the choice: follow it, so a reader
  // with the site open twice does not end up with two different themes.
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    notify(apply(effective()));
  });

  // Subscribers (the switch in the account menu) re-render from this, so the
  // control can never disagree with what is on screen.
  const listeners = new Set();
  function notify(mode) {
    listeners.forEach((fn) => {
      try {
        fn(mode);
      } catch {
        /* a broken listener must not break the switch */
      }
    });
  }

  window.Theme = {
    // 'dark' | 'light' | 'sepia' - what is on screen right now.
    current: effective,
    // 'dark' | 'light' | 'sepia' | null - the stored choice; null = follow the OS.
    stored: read,
    // Sepia is a dark theme too (dark ground, light ink).
    isDark: () => effective() !== LIGHT,
    // Explicit choice. Passing null clears it and hands control back to the OS.
    set(mode) {
      const value = valid(mode) ? mode : null;
      write(value);
      const applied = apply(effective());
      notify(applied);
      return applied;
    },
    toggle() {
      return window.Theme.set(effective() === LIGHT ? DARK : LIGHT);
    },
    // Returns an unsubscribe function, and fires once immediately so a caller
    // does not have to separately read the initial state.
    onChange(fn) {
      listeners.add(fn);
      fn(effective());
      return () => listeners.delete(fn);
    },
  };
})();

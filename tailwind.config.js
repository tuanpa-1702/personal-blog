// Tailwind design tokens - BUILD-TIME config.
//
// This file used to be public/js/tailwind-config.js, loaded in the browser next
// to the Tailwind Play CDN. That pairing was the single biggest cause of the
// flash on every reload: the Play CDN is a 450 KB compiler that GENERATES the
// stylesheet from the DOM after parsing, so for the first few hundred
// milliseconds not one utility existed - including `.hidden`, which
// public/css/common.css never defines. Every element the markup had marked
// hidden (nav dropdown, search overlay, error placeholders) was painted, and
// the whole page was an unstyled vertical stack of text.
//
// Now the same tokens are compiled ahead of time by the Tailwind CLI into
// public/css/tailwind.css, which the pages load as a plain blocking
// <link> - so the utilities are in the very first paint and there is nothing
// left to flash. Rebuild after touching this file or adding a class:
//
//   npm run build:css
//
// The `content` globs below are what makes the build safe: EVERY class name has
// to appear as a literal string somewhere in public/*.html or public/js/*.js.
// The pages build class lists inside template literals, but always by splicing
// in whole literal strings (TAG_STYLES in viewall.js, the size/weight ternaries
// in api.js, USER_ROLE_ICON in admin.js), never by concatenating a prefix with a
// variable - so the scanner sees all of them. Keep it that way: a class built as
// `'bg-' + colour` would compile to nothing and silently lose its styling.

// Shared Tailwind design tokens - "Electric Silicon" glassmorphism theme,
// extracted from the new Stitch design reference (index/post/profile/admin
// mockups) so every page looks consistent.

// ---------------------------------------------------------------------------
// Typography: one Vietnamese-first sans for the whole site.
//
// Geist (headings/labels) and Inter (body) were first replaced by Be Vietnam
// Pro, and that in turn by Inter - a sans Google Fonts ships with a
// vietnamese subset, so the stacked marks the language needs (ế ộ ữ ằ ỗ) are drawn by the family
// rather than covered incidentally. One family instead of two also means one
// font request and no headline/body mismatch.
//
// Google Fonts serves it as static faces, not a variable font, so the <link> in
// every page enumerates the exact weights used here: 400/500/600/700 plus 400
// and 700 italic. Adding a font-weight utility that is not in that list will
// silently fall back to a synthesised weight - update the six page <link> tags
// together with any change here.
//
// The fallbacks are the OS UI sans fonts, all of which cover Vietnamese, so the
// swap period and any load where Google Fonts is unreachable still show correct
// diacritics. Multi-word names carry their own quotes because Tailwind emits
// this list into `font-family` verbatim; `system-ui` and `-apple-system` must
// stay unquoted to keep working.
//
// NOTE: this list is only the INPUT to `npm run build:css`, which cannot run on
// this mount - node_modules/.bin/tailwindcss exists but is broken (Cannot find
// module './cli/index'). public/css/tailwind.css is the compiled output and
// carries this same stack baked into Preflight and every font-* utility, so a
// change here has to be mirrored there by hand.
// ---------------------------------------------------------------------------
const VI_SANS = [
  "'Inter'",
  'system-ui',
  '-apple-system',
  "'Segoe UI'",
  'Roboto',
  "'Noto Sans'",
  "'Helvetica Neue'",
  'Arial',
  'sans-serif',
];

module.exports = {
  // Negative patterns exclude the *.bak.* dev leftovers sitting next to the real
  // pages: including them would compile classes nothing serves any more, and
  // worse, could hide the fact that a class went missing from the live markup.
  content: ['./public/*.html', './public/js/*.js', '!./public/**/*.bak.*'],
  // The Play CDN was loaded as `?plugins=forms,container-queries`; both stay
  // so the static build is a byte-for-byte behavioural match. @tailwindcss/forms
  // is doing real work even though no `form-*` class is used anywhere: in its
  // default 'base' strategy it restyles bare <input>/<textarea>/<select>, which
  // is what the search field, the auth fields and the role picker rely on.
  // container-queries adds nothing to the output while unused - it is kept so
  // an `@container` utility does not silently no-op the day someone reaches for it.
  plugins: [require('@tailwindcss/forms'), require('@tailwindcss/container-queries')],

  darkMode: 'class',
  theme: {
    extend: {
      // ---------------------------------------------------------------------
      // Colour: every token resolves through a CSS custom property, never a
      // literal hex. public/css/common.css declares the light values on :root
      // and the dark ones on .dark, so adding/removing that one class on <html>
      // reskins the whole site - `bg-surface`, `text-on-surface`,
      // `border-outline-variant` and friends keep working untouched, which is
      // why there is not a single `dark:` variant anywhere in the markup.
      //
      // The variables hold SPACE-SEPARATED RGB CHANNELS ("53 37 205"), not
      // `rgb()` strings, because that is what keeps Tailwind's opacity
      // modifiers working: `bg-primary/10` compiles to
      // `rgb(var(--c-primary) / 0.1)`. Storing a whole colour in the variable
      // instead would silently break every `/NN` usage in the pages.
      //
      // The exceptions - glass-surface, glass-border, field and scrim - carry
      // their alpha INSIDE the variable, because the alpha itself differs per
      // theme (a 70%-white pane in light, a 72%-navy pane in dark). Those four
      // must be used WITHOUT an opacity modifier.
      // ---------------------------------------------------------------------
      colors: {
        // Brand / primary
        primary: 'rgb(var(--c-primary) / <alpha-value>)',
        'on-primary': 'rgb(var(--c-on-primary) / <alpha-value>)',
        'primary-container': 'rgb(var(--c-primary-container) / <alpha-value>)',
        'on-primary-container': 'rgb(var(--c-on-primary-container) / <alpha-value>)',
        'electric-indigo': 'rgb(var(--c-electric-indigo) / <alpha-value>)',
        'surface-tint': 'rgb(var(--c-surface-tint) / <alpha-value>)',

        // Secondary (the sky blue that ends every brand gradient)
        secondary: 'rgb(var(--c-secondary) / <alpha-value>)',
        'on-secondary': 'rgb(var(--c-on-secondary) / <alpha-value>)',
        'secondary-container': 'rgb(var(--c-secondary-container) / <alpha-value>)',
        'on-secondary-container': 'rgb(var(--c-on-secondary-container) / <alpha-value>)',

        // Tertiary (the magenta accents: admin stat tiles, "đã đăng" badges)
        tertiary: 'rgb(var(--c-tertiary) / <alpha-value>)',
        'on-tertiary': 'rgb(var(--c-on-tertiary) / <alpha-value>)',
        'tertiary-container': 'rgb(var(--c-tertiary-container) / <alpha-value>)',
        'on-tertiary-container': 'rgb(var(--c-on-tertiary-container) / <alpha-value>)',

        // Error
        error: 'rgb(var(--c-error) / <alpha-value>)',
        'on-error': 'rgb(var(--c-on-error) / <alpha-value>)',
        'error-container': 'rgb(var(--c-error-container) / <alpha-value>)',
        'on-error-container': 'rgb(var(--c-on-error-container) / <alpha-value>)',

        // Surfaces, from the page backdrop up to the highest raised container
        background: 'rgb(var(--c-background) / <alpha-value>)',
        'on-background': 'rgb(var(--c-on-background) / <alpha-value>)',
        surface: 'rgb(var(--c-surface) / <alpha-value>)',
        'on-surface': 'rgb(var(--c-on-surface) / <alpha-value>)',
        'surface-variant': 'rgb(var(--c-surface-variant) / <alpha-value>)',
        'on-surface-variant': 'rgb(var(--c-on-surface-variant) / <alpha-value>)',
        'surface-dim': 'rgb(var(--c-surface-dim) / <alpha-value>)',
        'surface-bright': 'rgb(var(--c-surface-bright) / <alpha-value>)',
        'surface-container-lowest': 'rgb(var(--c-surface-container-lowest) / <alpha-value>)',
        'surface-container-low': 'rgb(var(--c-surface-container-low) / <alpha-value>)',
        'surface-container': 'rgb(var(--c-surface-container) / <alpha-value>)',
        'surface-container-high': 'rgb(var(--c-surface-container-high) / <alpha-value>)',
        'surface-container-highest': 'rgb(var(--c-surface-container-highest) / <alpha-value>)',

        // Outlines
        outline: 'rgb(var(--c-outline) / <alpha-value>)',
        'outline-variant': 'rgb(var(--c-outline-variant) / <alpha-value>)',

        // Inverse pair (M3 completeness)
        'inverse-surface': 'rgb(var(--c-inverse-surface) / <alpha-value>)',
        'inverse-on-surface': 'rgb(var(--c-inverse-on-surface) / <alpha-value>)',
        'inverse-primary': 'rgb(var(--c-inverse-primary) / <alpha-value>)',

        // Hero backdrop gradient
        'bg-gradient-start': 'rgb(var(--c-bg-gradient-start) / <alpha-value>)',
        'bg-gradient-end': 'rgb(var(--c-bg-gradient-end) / <alpha-value>)',

        // M3 "fixed" roles keep the SAME value in both themes by definition -
        // they exist for content sitting on a surface that does not flip, e.g.
        // the headline over a post's cover photo (text-secondary-fixed).
        'primary-fixed': 'rgb(var(--c-primary-fixed) / <alpha-value>)',
        'primary-fixed-dim': 'rgb(var(--c-primary-fixed-dim) / <alpha-value>)',
        'on-primary-fixed': 'rgb(var(--c-on-primary-fixed) / <alpha-value>)',
        'on-primary-fixed-variant': 'rgb(var(--c-on-primary-fixed-variant) / <alpha-value>)',
        'secondary-fixed': 'rgb(var(--c-secondary-fixed) / <alpha-value>)',
        'secondary-fixed-dim': 'rgb(var(--c-secondary-fixed-dim) / <alpha-value>)',
        'on-secondary-fixed': 'rgb(var(--c-on-secondary-fixed) / <alpha-value>)',
        'on-secondary-fixed-variant': 'rgb(var(--c-on-secondary-fixed-variant) / <alpha-value>)',
        'tertiary-fixed': 'rgb(var(--c-tertiary-fixed) / <alpha-value>)',
        'tertiary-fixed-dim': 'rgb(var(--c-tertiary-fixed-dim) / <alpha-value>)',
        'on-tertiary-fixed': 'rgb(var(--c-on-tertiary-fixed) / <alpha-value>)',
        'on-tertiary-fixed-variant': 'rgb(var(--c-on-tertiary-fixed-variant) / <alpha-value>)',

        // Alpha baked in (see the note above): no /NN modifier on these four.
        'glass-surface': 'var(--c-glass-surface)',
        'glass-border': 'var(--c-glass-border)',
        // Recessed input well: a wash of ink on light, of light on ink.
        field: 'var(--c-field)',
        // Full-screen dim behind a modal.
        scrim: 'var(--c-scrim)',
      },
      // The site's ambient indigo glow, plus the same shadow thrown upwards for
      // the footer. Variables, so the dark theme can trade the indigo bloom for
      // a real black drop shadow - which is what separates a raised pane from
      // the page once the page itself is nearly black.
      // `google` is the login button's hover lift in the auth modal (js/api.js);
      // it was an arbitrary `shadow-[0_8px_20px_rgba(79,70,229,0.12)]`, so it was
      // one of only three surfaces still carrying the light theme's indigo bloom
      // on a dark page.
      boxShadow: {
        ambient: 'var(--shadow-ambient)',
        'ambient-t': 'var(--shadow-ambient-t)',
        google: 'var(--shadow-google)',
      },
      borderRadius: { DEFAULT: '0.25rem', lg: '0.5rem', xl: '0.75rem', full: '9999px' },
      spacing: {
        lg: '40px',
        md: '24px',
        base: '4px',
        sm: '16px',
        gutter: '24px',
        xl: '64px',
        'margin-page': '32px',
        xs: '8px',
        // Kept for backward compatibility with a couple of older utility
        // names still referenced in a few places.
        'margin-mobile': '20px',
        'margin-desktop': '32px',
        'container-max': '1280px',
        'section-gap': '64px',
        unit: '8px',
      },
      fontFamily: {
        // Overriding `sans` also redirects Tailwind's Preflight, which sets the
        // font on <html> - so anything without an explicit font-* utility
        // inherits the Vietnamese stack too.
        sans: VI_SANS,
        'display-lg': VI_SANS,
        'label-md': VI_SANS,
        'body-md': VI_SANS,
        'headline-sm': VI_SANS,
        'display-lg-mobile': VI_SANS,
        'headline-md': VI_SANS,
        'body-lg': VI_SANS,
        'body-sm': VI_SANS,
        // Backward-compat aliases for a few older utility names
        'label-caps': VI_SANS,
      },
      fontSize: {
        'display-lg': ['48px', { lineHeight: '56px', letterSpacing: '-0.04em', fontWeight: '700' }],
        'label-md': ['12px', { lineHeight: '16px', letterSpacing: '0.05em', fontWeight: '600' }],
        'body-md': ['16px', { lineHeight: '24px', fontWeight: '400' }],
        'headline-sm': ['20px', { lineHeight: '28px', fontWeight: '600' }],
        'display-lg-mobile': ['32px', { lineHeight: '40px', letterSpacing: '-0.02em', fontWeight: '700' }],
        'headline-md': ['24px', { lineHeight: '32px', letterSpacing: '-0.02em', fontWeight: '600' }],
        'body-lg': ['18px', { lineHeight: '28px', fontWeight: '400' }],
        'body-sm': ['14px', { lineHeight: '20px', fontWeight: '400' }],
        'label-caps': ['12px', { lineHeight: '16px', letterSpacing: '0.1em', fontWeight: '700' }],
      },
    },
  },
};

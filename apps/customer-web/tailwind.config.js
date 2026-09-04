/** @type {import('tailwindcss').Config} */

/*
 * The storefront half of the shared UBOSS theme.
 *
 * Everything below the `colors` block is kept byte-identical to
 * apps/admin-web/tailwind.config.js apart from the two clearly-marked
 * storefront-only entries at the end. The palette, radii, type steps, shadows
 * and motion are one system; only the *density* of the two apps differs, and
 * that is expressed in the primitives, not here.
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Semantic names, not raw hues. A price colour that has to change
        // should change once, not in ninety class attributes.

        // --- Surfaces ---------------------------------------------------
        surface: 'rgb(var(--surface) / <alpha-value>)',
        'surface-raised': 'rgb(var(--surface-raised) / <alpha-value>)',
        'surface-sunken': 'rgb(var(--surface-sunken) / <alpha-value>)',
        'surface-hover': 'rgb(var(--surface-hover) / <alpha-value>)',
        'surface-inverse': 'rgb(var(--surface-inverse) / <alpha-value>)',
        'surface-inverse-hover': 'rgb(var(--surface-inverse-hover) / <alpha-value>)',

        // --- Borders ----------------------------------------------------
        border: 'rgb(var(--border) / <alpha-value>)',
        'border-subtle': 'rgb(var(--border-subtle) / <alpha-value>)',
        'border-strong': 'rgb(var(--border-strong) / <alpha-value>)',
        'border-hover': 'rgb(var(--border-hover) / <alpha-value>)',

        // --- Text -------------------------------------------------------
        ink: 'rgb(var(--ink) / <alpha-value>)',
        'ink-muted': 'rgb(var(--ink-muted) / <alpha-value>)',
        'ink-subtle': 'rgb(var(--ink-subtle) / <alpha-value>)',
        'ink-inverse': 'rgb(var(--ink-inverse) / <alpha-value>)',

        // --- Navy -------------------------------------------------------
        // The same value as `surface-inverse`, under the name the brand uses
        // for it. `surface-inverse` says where it goes; `navy` says what it is.
        navy: 'rgb(var(--navy) / <alpha-value>)',
        'navy-hover': 'rgb(var(--navy-hover) / <alpha-value>)',

        // --- Primary blue -----------------------------------------------
        brand: 'rgb(var(--brand) / <alpha-value>)',
        'brand-hover': 'rgb(var(--brand-hover) / <alpha-value>)',
        'brand-soft': 'rgb(var(--brand-soft) / <alpha-value>)',
        'brand-soft-hover': 'rgb(var(--brand-soft-hover) / <alpha-value>)',
        // The admin panel calls this same blue `accent`. Both names resolve
        // here too, so a component can be lifted between the apps unchanged.
        accent: 'rgb(var(--brand) / <alpha-value>)',
        'accent-hover': 'rgb(var(--brand-hover) / <alpha-value>)',
        'accent-soft': 'rgb(var(--brand-soft) / <alpha-value>)',

        // --- Action orange ----------------------------------------------
        // Deliberately distinct from `brand`: a call to action must not look
        // like a navigation link, or people stop noticing either. `action` is
        // the accent; `action-strong` is the fill that carries white text at
        // 5.14:1 — see the token comments in index.css.
        action: 'rgb(var(--action) / <alpha-value>)',
        'action-strong': 'rgb(var(--action-strong) / <alpha-value>)',
        'action-strong-hover': 'rgb(var(--action-strong-hover) / <alpha-value>)',
        'action-soft': 'rgb(var(--action-soft) / <alpha-value>)',
        'action-soft-hover': 'rgb(var(--action-soft-hover) / <alpha-value>)',

        // --- Teal -------------------------------------------------------
        // Repeat purchases and positive process cues. A third hue, so a
        // recurring capability never has to borrow the buy path's orange or
        // the navigation blue.
        operational: 'rgb(var(--operational) / <alpha-value>)',
        'operational-hover': 'rgb(var(--operational-hover) / <alpha-value>)',
        'operational-soft': 'rgb(var(--operational-soft) / <alpha-value>)',

        // --- Status -----------------------------------------------------
        danger: 'rgb(var(--danger) / <alpha-value>)',
        'danger-hover': 'rgb(var(--danger-hover) / <alpha-value>)',
        'danger-soft': 'rgb(var(--danger-soft) / <alpha-value>)',
        success: 'rgb(var(--success) / <alpha-value>)',
        'success-hover': 'rgb(var(--success-hover) / <alpha-value>)',
        'success-soft': 'rgb(var(--success-soft) / <alpha-value>)',
        warning: 'rgb(var(--warning) / <alpha-value>)',
        'warning-hover': 'rgb(var(--warning-hover) / <alpha-value>)',
        'warning-soft': 'rgb(var(--warning-soft) / <alpha-value>)',

        // --- Focus ------------------------------------------------------
        ring: 'rgb(var(--ring) / <alpha-value>)',
      },

      // The radius scale, named by what it wraps rather than by size, so the
      // steps stay distinguishable across the app: controls, cards, and large
      // media. Overriding Tailwind's defaults here rather than rewriting every
      // class attribute keeps the existing `rounded-md` / `rounded-lg` usage
      // correct by construction.
      borderRadius: {
        DEFAULT: '0.375rem', //  6px — chips, menu rows, inline pills
        md: '0.5rem', //  8px — buttons, inputs, selects
        lg: '0.75rem', // 12px — cards, panels, dialogs
        xl: '1rem', // 16px — hero and large media panels
        '2xl': '1.25rem', // 20px — full-bleed feature panels
      },

      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },

      fontSize: {
        // Below Tailwind's `xs`: badge text, table column headers, the metadata
        // line under a price.
        xxs: ['0.6875rem', { lineHeight: '1rem' }],

        // The heading scale. Line height, tracking and weight travel *with*
        // the size, so a heading cannot be set at the right size and the wrong
        // rhythm — which is what `text-2xl font-semibold tracking-tight`
        // repeated across forty files was always one omission away from.
        //
        // Both apps carry all four steps; they differ in which they reach for.
        // The storefront starts a page at `title-xl`, the panel at `title-lg`.
        'title-xs': ['0.875rem', { lineHeight: '1.25rem', letterSpacing: '-0.006em', fontWeight: '600' }],
        'title-sm': ['1rem', { lineHeight: '1.5rem', letterSpacing: '-0.011em', fontWeight: '600' }],
        title: ['1.25rem', { lineHeight: '1.75rem', letterSpacing: '-0.016em', fontWeight: '600' }],
        'title-lg': ['1.5rem', { lineHeight: '2rem', letterSpacing: '-0.019em', fontWeight: '600' }],
        'title-xl': ['1.875rem', { lineHeight: '2.25rem', letterSpacing: '-0.022em', fontWeight: '600' }],
      },

      // Elevation is a four-step ladder, and the step says how far off the
      // page the thing is meant to sit: a card rests on it, a hovered card
      // lifts, a popover floats, a dialog is in front of everything. Shadows
      // are tinted with the ink colour rather than pure black — a neutral-grey
      // shadow over a slate-tinted page ground reads as dirt.
      boxShadow: {
        card: '0 1px 2px 0 rgb(15 23 42 / 0.04), 0 1px 3px 0 rgb(15 23 42 / 0.05)',
        'card-hover':
          '0 2px 4px -1px rgb(15 23 42 / 0.06), 0 8px 20px -6px rgb(15 23 42 / 0.10)',
        lift: '0 4px 12px -2px rgb(15 23 42 / 0.10), 0 2px 6px -2px rgb(15 23 42 / 0.06)',
        popover: '0 4px 6px -1px rgb(15 23 42 / 0.08), 0 10px 24px -4px rgb(15 23 42 / 0.12)',
        overlay: '0 10px 15px -3px rgb(15 23 42 / 0.10), 0 24px 48px -12px rgb(15 23 42 / 0.28)',
      },

      // One curve and one duration for the whole UI, set as the *defaults*.
      // Every `transition-colors` already in the app inherits them, so hover
      // timing became consistent without touching a class attribute. Anything
      // that genuinely needs longer says so with `duration-200`.
      transitionTimingFunction: {
        DEFAULT: 'var(--ease-ui)',
        ui: 'var(--ease-ui)',
      },
      transitionDuration: {
        DEFAULT: 'var(--dur-fast)',
      },

      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        // A dialog rises a few pixels as it fades in. Small enough to read as
        // the panel arriving rather than as an animation being performed, and
        // switched off entirely by the reduced-motion block in index.css.
        'dialog-in': {
          from: { opacity: '0', transform: 'translateY(4px) scale(0.99)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
      },
      animation: {
        'fade-in': 'fade-in var(--dur-base) var(--ease-ui)',
        'dialog-in': 'dialog-in var(--dur-base) var(--ease-ui)',
      },

      // --- Storefront only ------------------------------------------------
      // The catalogue's reading measure. The admin panel has no equivalent:
      // its pages are as wide as the viewport by design.
      maxWidth: {
        content: '80rem',
      },
    },
  },
  plugins: [],
};

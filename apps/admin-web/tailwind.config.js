/** @type {import('tailwindcss').Config} */

/*
 * The admin half of the shared UBOSS theme.
 *
 * Everything below the `colors` block is kept byte-identical to
 * apps/customer-web/tailwind.config.js apart from the clearly-marked
 * storefront-only entry it omits. The palette, radii, type steps, shadows and
 * motion are one system; only the *density* of the two apps differs, and that
 * is expressed in the primitives, not here.
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Semantic names, not raw hues: a status colour that has to change
        // should change in one place, not in ninety class attributes.

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
        // `accent` is this app's original name for it and is still what most
        // of the panel says; `brand` is the shared name and the one to use in
        // new code. Both resolve to `--brand`, so there is one value.
        accent: 'rgb(var(--brand) / <alpha-value>)',
        'accent-hover': 'rgb(var(--brand-hover) / <alpha-value>)',
        'accent-soft': 'rgb(var(--brand-soft) / <alpha-value>)',
        brand: 'rgb(var(--brand) / <alpha-value>)',
        'brand-hover': 'rgb(var(--brand-hover) / <alpha-value>)',
        'brand-soft': 'rgb(var(--brand-soft) / <alpha-value>)',
        'brand-soft-hover': 'rgb(var(--brand-soft-hover) / <alpha-value>)',

        // --- Action orange ----------------------------------------------
        // Present so the two apps are one palette. Spent sparingly here — see
        // the token comment in index.css.
        action: 'rgb(var(--action) / <alpha-value>)',
        'action-strong': 'rgb(var(--action-strong) / <alpha-value>)',
        'action-strong-hover': 'rgb(var(--action-strong-hover) / <alpha-value>)',
        'action-soft': 'rgb(var(--action-soft) / <alpha-value>)',
        'action-soft-hover': 'rgb(var(--action-soft-hover) / <alpha-value>)',

        // --- Teal -------------------------------------------------------
        // Recurring schedules and positive process cues.
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
      // steps stay distinguishable across the panel: controls, cards, and large
      // media. Overriding Tailwind's defaults here rather than rewriting every
      // class attribute keeps the existing `rounded-md` / `rounded-lg` usage
      // correct by construction.
      borderRadius: {
        DEFAULT: '0.375rem', //  6px — chips, menu rows, inline pills
        md: '0.5rem', //  8px — buttons, inputs, selects
        lg: '0.75rem', // 12px — cards, panels, dialogs
        xl: '1rem', // 16px — large media panels
        '2xl': '1.25rem', // 20px — full-bleed feature panels
      },

      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },

      fontSize: {
        // Below Tailwind's `xs`: badge text, table column headers, the metadata
        // line under a price. A dense admin table needs a smaller step than
        // Tailwind ships.
        xxs: ['0.6875rem', { lineHeight: '1rem' }],

        // The heading scale. Line height, tracking and weight travel *with*
        // the size, so a heading cannot be set at the right size and the wrong
        // rhythm — which is what `text-xl font-semibold tracking-tight`
        // repeated across forty files was always one omission away from.
        //
        // Both apps carry all four steps; they differ in which they reach for.
        // The panel starts a page at `title-lg`, the storefront at `title-xl`.
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
      // Every `transition-colors` already in the panel inherits them, so hover
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
        // The mobile navigation drawer comes in from the edge it is anchored
        // to, which is the one piece of motion in the panel that carries
        // meaning: it says where the thing came from and therefore where it
        // goes back to. Switched off by the reduced-motion block in index.css.
        'drawer-in': {
          from: { transform: 'translateX(-100%)' },
          to: { transform: 'translateX(0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in var(--dur-base) var(--ease-ui)',
        'dialog-in': 'dialog-in var(--dur-base) var(--ease-ui)',
        'drawer-in': 'drawer-in var(--dur-base) var(--ease-ui)',
      },
    },
  },
  plugins: [],
};

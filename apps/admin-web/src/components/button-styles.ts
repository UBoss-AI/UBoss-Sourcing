/**
 * The button skin, as data.
 *
 * Split out of `ui.tsx` for one reason: a `<Link>` that has to look like a
 * button needs these class strings, and a file that exports components cannot
 * also export a helper function without losing Fast Refresh
 * (`react-refresh/only-export-components`). The same split the app already
 * makes for `toast-context` and `session-context`.
 *
 * Nothing here decides *when* a variant is used — that judgement lives in the
 * hierarchy comment below and in the pages. This file only holds what each
 * one looks like, so `<Button>`, `<LinkButton>` and the pager's own buttons
 * cannot drift apart.
 */

export type ButtonVariant =
  | 'action'
  | 'primary'
  | 'operational'
  | 'secondary'
  | 'ghost'
  | 'danger'
  | 'inverse'
  | 'inverse-outline';

export type ButtonSize = 'sm' | 'md' | 'lg';

/*
 * The hierarchy, loudest first:
 *
 *   action       Orange, and near-silent in this app. Reach for it only where
 *                a screen has exactly one irreversible forward step and
 *                `primary` is already spoken for. The storefront spends this
 *                colour on the buy path; an admin panel has nothing to convert.
 *   primary      The main action of a panel or form. Blue.
 *   operational  Acting on a standing arrangement. Teal.
 *   danger       Destructive. Red, and always paired with a quiet Cancel.
 *   secondary    The default. Bordered, on the page ground.
 *   ghost        Tertiary. No ground until hovered — the row action.
 *
 * Every filled variant names its own `focus-visible:ring-*`. The global ring
 * is brand blue, which on a red Delete button read as a blue halo around a red
 * control — the ring should belong to the thing it is on.
 *
 * Hovers go *darker*, never `brightness-110`. Lightening a filled button walks
 * its white label toward failing AA at the exact moment the pointer is on it,
 * which is the worst possible moment for it to become hard to read.
 */
export const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  // The fill is `action-strong` (#C2410C) rather than `action` (#EA580C):
  // white on #EA580C is 3.56:1 and fails AA for a label, white on #C2410C is
  // 5.14:1 and passes. See the token comment in index.css.
  action:
    'bg-action-strong text-white shadow-card hover:bg-action-strong-hover ' +
    'focus-visible:ring-action-strong disabled:bg-ink-subtle disabled:shadow-none',
  primary:
    'bg-accent text-white shadow-card hover:bg-accent-hover ' +
    'focus-visible:ring-accent disabled:bg-ink-subtle disabled:shadow-none',
  // Recurring schedules. Teal, so acting on a standing arrangement is
  // visibly not the same as acting on a one-off order.
  operational:
    'bg-operational text-white shadow-card hover:bg-operational-hover ' +
    'focus-visible:ring-operational disabled:bg-ink-subtle disabled:shadow-none',
  secondary:
    'bg-surface text-ink border border-border-strong shadow-card ' +
    'hover:border-border-hover hover:bg-surface-hover ' +
    'disabled:border-border disabled:bg-surface disabled:text-ink-subtle disabled:shadow-none',
  ghost:
    'text-ink-muted hover:bg-surface-hover hover:text-ink ' +
    'disabled:bg-transparent disabled:text-ink-subtle',
  danger:
    'bg-danger text-white shadow-card hover:bg-danger-hover ' +
    'focus-visible:ring-danger disabled:bg-ink-subtle disabled:shadow-none',
  // For a navy surface, where accent blue on navy is 1.57:1 and simply
  // vanishes. White carries navy text at 14.6:1. Present for parity with the
  // storefront, so a component can be lifted between the apps unchanged.
  inverse:
    'bg-surface text-surface-inverse shadow-card hover:bg-ink-inverse ' +
    'disabled:text-ink-subtle disabled:shadow-none',
  // The paired quiet option on a dark surface. `white/40` because a control
  // boundary needs 3:1 to be perceivable at all (WCAG 1.4.11).
  'inverse-outline':
    'border border-white/40 text-ink-inverse hover:border-white/60 hover:bg-white/10',
};

export const BUTTON_SIZES: Record<ButtonSize, string> = {
  // 32px for the action that lives inside a table row, 40px everywhere else -
  // both on the 8px step, and `md` matches the form controls in ui.tsx so a
  // filter row lines up.
  sm: 'h-8 gap-1.5 px-3 text-xs',
  md: 'h-10 px-4 text-sm',
  // 48px. Rare in a panel this dense — it exists so a full-width action on the
  // sign-in and password screens, which are the only touch-shaped pages here,
  // matches the storefront's.
  lg: 'h-12 px-6 text-base',
};

/*
 * `active:translate-y-px` is the whole of the press feedback: one pixel, so a
 * click registers as having landed on something. The reduced-motion block in
 * index.css strips the transition, and the displacement is then instant rather
 * than absent — which is correct, since it is feedback and not decoration.
 */
export const BUTTON_BASE =
  'inline-flex select-none items-center justify-center gap-2 rounded-md font-medium ' +
  'transition-[background-color,border-color,color,box-shadow,transform] ' +
  'active:translate-y-px disabled:active:translate-y-0';

/**
 * The finished class string for a button-shaped control.
 *
 * Exists so a `<Link>` that acts as a page action is pixel-identical to the
 * `<Button>` beside it. Before this, six pages hand-rolled their own
 * `inline-flex h-9 …` link — a 36px control next to a 40px button, which is
 * the kind of difference nobody can name and everybody can see.
 */
export function buttonClassName(
  variant: ButtonVariant = 'secondary',
  size: ButtonSize = 'md',
  extra?: string,
): string {
  return [BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size], extra]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(' ');
}

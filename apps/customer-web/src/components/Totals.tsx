/**
 * The money breakdown, in one place.
 *
 * Four screens show a subtotal, a discount, tax, delivery and a total: the
 * cart, checkout, the confirmation and the order page. They were four
 * hand-written `<dl>`s, which is how the same figure ends up in two weights
 * and the grand total picks up a different treatment on the way from the cart
 * to the order it became. The breakdown is one component now, so a customer
 * watching a number travel through the flow sees the same number.
 *
 * Nothing here computes anything. Every value is a server figure, already
 * formatted by the caller — a second pricing engine in the presentation layer
 * is the one bug this whole flow is built to avoid.
 */
import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';

/** One line of the breakdown. */
export function TotalRow({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: ReactNode;
  /** A quiet clarification under the label — "10 items", "at checkout". */
  hint?: string;
  tone?: 'default' | 'credit' | 'settled' | 'outstanding';
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-ink-muted">
        {label}
        {hint !== undefined && (
          <span className="ml-1.5 text-xxs text-ink-subtle">{hint}</span>
        )}
      </dt>
      <dd
        className={cx(
          'shrink-0 tabular',
          tone === 'credit' && 'text-success',
          tone === 'settled' && 'text-success',
          tone === 'outstanding' && 'text-warning',
          tone === 'default' && 'text-ink',
        )}
      >
        {value}
      </dd>
    </div>
  );
}

/**
 * The figure people came to the panel for.
 *
 * On the conversion tint, with `action` as the border and ground only — the
 * number itself stays ink, so it keeps full contrast rather than being set in
 * an orange that was chosen to be noticed rather than to be read.
 */
export function GrandTotalRow({
  label,
  value,
  note,
}: {
  label: string;
  value: ReactNode;
  note?: string;
}): React.JSX.Element {
  return (
    // `dt` and `dd` are direct children of this `div`, and the note is a
    // second `dd` rather than a `<p>` — a paragraph between them is invalid
    // inside a description list, however well it renders.
    <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-4 rounded-md border border-action/30 bg-action-soft px-3 py-2.5">
      <dt className="text-base font-semibold text-ink">{label}</dt>
      <dd className="shrink-0 tabular text-base font-semibold text-ink">{value}</dd>
      {note !== undefined && (
        <dd className="mt-1 w-full text-xxs font-normal leading-snug text-ink-muted">{note}</dd>
      )}
    </div>
  );
}

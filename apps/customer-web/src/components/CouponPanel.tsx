/**
 * The coupon box on the cart.
 *
 * Two halves, both driven entirely by the server's verdict:
 *
 *   - A code entry. The server decides whether it applies; this never guesses,
 *     because a client that predicts eligibility will eventually disagree with
 *     the price actually charged.
 *   - "We have coupons" — the advertised ones for this currency, each already
 *     evaluated against the cart as it stands, so a code that would be refused
 *     is shown as needing a bigger basket rather than offered as if it worked.
 *
 * A coupon that stopped qualifying while the cart sat open stays visible with
 * its reason attached, rather than disappearing without explanation.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import type { Cart } from '@/lib/types';
import { Button } from '@/components/ui';
import { AlertIcon, CheckIcon } from '@/components/icons';

export function CouponPanel({ cart }: { cart: Cart }): React.JSX.Element {
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const [showOffers, setShowOffers] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['cart'] });
  };

  const apply = useMutation({
    mutationFn: (value: string) => api.post<{ cart: Cart }>('/cart/coupon', { code: value }),
    onSuccess: async () => {
      setCode('');
      setError(null);
      await invalidate();
    },
    onError: (cause: unknown) => {
      // The server's own wording. It knows why - too small a basket, wrong
      // categories, expired - and inventing a client-side reason here would
      // eventually contradict it.
      setError(
        cause instanceof ApiError ? cause.message : 'That coupon could not be applied.',
      );
    },
  });

  const remove = useMutation({
    mutationFn: () => api.delete<{ cart: Cart }>('/cart/coupon'),
    onSuccess: async () => {
      setError(null);
      await invalidate();
    },
  });

  const applied = cart.coupon;
  const offers = cart.availableCoupons;

  return (
    <section aria-labelledby="coupon-heading" className="mt-5 border-t border-border-subtle pt-4">
      <h3 id="coupon-heading" className="text-title-xs text-ink">
        Coupons
      </h3>

      {applied !== null && applied.rejection === null && (
        // A working coupon is a small win, and it should look like one: a tick,
        // the saving in money rather than only in percent, and the code itself
        // in the monospace face it was typed in.
        <div className="mt-2.5 flex items-start gap-2.5 rounded-md border border-success/30 bg-success-soft p-3">
          <CheckIcon className="mt-px h-4 w-4 shrink-0 text-success" />

          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-success">
              <span className="font-mono">{applied.code}</span> applied —{' '}
              {applied.discountPercent}% off
            </p>
            <p className="mt-0.5 text-xs text-ink-muted">
              You save {formatMoney(applied.discount)}
              {applied.description === null ? '' : ` · ${applied.description}`}
            </p>
          </div>

          <button
            type="button"
            onClick={() => {
              remove.mutate();
            }}
            disabled={remove.isPending}
            className="shrink-0 rounded text-xs font-medium text-ink-muted underline underline-offset-2 hover:text-ink"
          >
            Remove<span className="sr-only"> coupon {applied.code}</span>
          </button>
        </div>
      )}

      {applied !== null && applied.rejection !== null && (
        <div
          role="status"
          className="mt-2.5 flex items-start gap-2.5 rounded-md border border-warning/30 bg-warning-soft p-3"
        >
          <AlertIcon className="mt-px h-4 w-4 shrink-0 text-warning" />
          {/* The server's own reason. A coupon that stopped qualifying stays
              visible with its explanation rather than vanishing. */}
          <p className="min-w-0 flex-1 text-xs text-warning">{applied.rejection.message}</p>
          <button
            type="button"
            onClick={() => {
              remove.mutate();
            }}
            disabled={remove.isPending}
            className="shrink-0 rounded text-xs font-medium text-ink-muted underline underline-offset-2 hover:text-ink"
          >
            Remove<span className="sr-only"> coupon {applied.code}</span>
          </button>
        </div>
      )}

      <form
        className="mt-3 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (code.trim() !== '') apply.mutate(code.trim());
        }}
      >
        <label className="min-w-0 flex-1">
          <span className="sr-only">Coupon code</span>
          <input
            value={code}
            onChange={(event) => {
              setCode(event.target.value);
              setError(null);
            }}
            placeholder="Enter coupon code"
            autoComplete="off"
            spellCheck={false}
            className="block h-10 w-full rounded-md border border-border-strong bg-surface px-3 font-mono text-sm uppercase text-ink placeholder:font-sans placeholder:normal-case placeholder:text-ink-subtle"
          />
        </label>
        <Button type="submit" variant="secondary" disabled={apply.isPending || code.trim() === ''}>
          {apply.isPending ? 'Applying…' : 'Apply'}
        </Button>
      </form>

      {error !== null && (
        <p role="alert" className="mt-2 text-xs font-medium text-danger">
          {error}
        </p>
      )}

      {offers.length > 0 && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => {
              setShowOffers((open) => !open);
            }}
            aria-expanded={showOffers}
            className="text-xs font-medium text-brand underline"
          >
            {showOffers
              ? 'Hide coupons'
              : `We have ${String(offers.length)} coupon${offers.length === 1 ? '' : 's'} — view`}
          </button>

          {showOffers && (
            <ul className="mt-2.5 space-y-2">
              {offers.map((offer) => (
                <li
                  key={offer.code}
                  // A dashed edge, the way a paper voucher is perforated. It
                  // also keeps an offer visibly distinct from the applied
                  // coupon's solid panel above.
                  className={`rounded-md border border-dashed p-3 ${
                    offer.eligibleNow
                      ? 'border-border-strong bg-surface'
                      : 'border-border bg-surface-sunken'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-mono text-sm font-semibold text-ink">{offer.code}</p>
                      <p className="mt-0.5 text-xs text-ink-muted">
                        {offer.discountPercent}% off
                        {offer.minOrder.minor === '0'
                          ? ''
                          : ` on orders over ${formatMoney(offer.minOrder)}`}
                      </p>
                      {offer.description !== null && (
                        <p className="mt-0.5 text-xs text-ink-subtle">{offer.description}</p>
                      )}
                    </div>

                    {offer.eligibleNow ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        className="shrink-0"
                        onClick={() => {
                          apply.mutate(offer.code);
                        }}
                        disabled={apply.isPending}
                      >
                        Apply
                        <span className="sr-only"> coupon {offer.code}</span>
                      </Button>
                    ) : (
                      // Shown rather than hidden: knowing a coupon exists just
                      // above the threshold is the reason to add one more item.
                      // The server decided this, not the panel.
                      <span className="shrink-0 rounded-full bg-surface px-2 py-0.5 text-xxs font-semibold uppercase tracking-wide text-ink-subtle ring-1 ring-inset ring-border">
                        Not yet
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

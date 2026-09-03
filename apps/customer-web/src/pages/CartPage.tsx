/**
 * The cart.
 *
 * The rule this page is built around: **the server owns the cart.** Every
 * mutation returns the whole cart, and that response replaces what is on
 * screen. There is no local total, no local stock check and no optimistic line
 * edit that survives the answer — because the moment the two disagree, the one
 * the customer is looking at is the wrong one.
 *
 * What that buys, concretely:
 *
 *   - A product unpublished while it sat in the cart appears as a line with an
 *     issue, explained in the server's own words, with the correction offered.
 *   - A price that changed shows the new price, because the response carries
 *     it. Nothing here remembers the old one to "helpfully" keep showing.
 *   - `checkoutReady` decides whether checkout is offered. Not a count of
 *     issues computed here, which would drift the first time a new issue code
 *     appeared.
 *
 * Double-click protection is per line: an in-flight change disables that
 * line's controls, so a customer hammering "+" queues one change, not six.
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStorefront } from '@/app/storefront-context';
import { useToast } from '@/components/toast-context';
import { QuantityInput } from '@/components/QuantityInput';
import { CouponPanel } from '@/components/CouponPanel';
import { clampToRules } from '@/lib/quantity-rules';
import { Badge, Button, ErrorState, LoadingState } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { formatMoney, formatNumber } from '@/lib/format';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import type { Cart, CartIssue, CartLine, PurchaseRules } from '@/lib/types';

/** The cart's rules, widened back to what the quantity control expects. */
function toPurchaseRules(line: CartLine): PurchaseRules {
  return { ...line.purchaseRules, isRecurringEligible: line.isRecurringEligible };
}

/**
 * An issue, shown in the server's own words.
 *
 * The code decides the tone and whether a correction can be offered; the
 * message is never rewritten here. The server knows the rule — this page would
 * only paraphrase it, and eventually paraphrase it wrongly.
 */
function IssueNotice({
  issue,
  onCorrect,
  correctionLabel,
}: {
  issue: CartIssue;
  onCorrect?: () => void;
  correctionLabel?: string;
}): React.JSX.Element {
  // Three tones, because three different things are being said: this item
  // cannot be bought at all, this needs a correction, or this simply changed.
  const isFatal = issue.code === 'CART_ITEM_UNAVAILABLE';
  const isNotice = issue.code === 'CART_PRICE_CHANGED';

  return (
    <div
      role="alert"
      className={`mt-2 rounded-md border px-3 py-2 text-xs ${
        isFatal
          ? 'border-danger/30 bg-danger-soft text-danger'
          : isNotice
            ? 'border-brand/30 bg-brand-soft text-brand'
            : 'border-warning/30 bg-warning-soft text-warning'
      }`}
    >
      <p className="font-medium">{issue.message}</p>

      {onCorrect !== undefined && correctionLabel !== undefined && (
        <button
          type="button"
          onClick={onCorrect}
          className="mt-1.5 font-semibold text-ink underline underline-offset-2"
        >
          {correctionLabel}
        </button>
      )}
    </div>
  );
}

function LineRow({
  line,
  onQuantityChange,
  onRemove,
  isBusy,
}: {
  line: CartLine;
  onQuantityChange: (quantity: number) => void;
  onRemove: () => void;
  isBusy: boolean;
}): React.JSX.Element {
  const rules = toPurchaseRules(line);
  const available = typeof line.availableQty === 'number' ? line.availableQty : null;

  /**
   * The one-click correction for an issue, when there is an obvious one.
   *
   * The backend accepts an add that breaks a quantity rule and flags the line
   * rather than refusing it, so the customer keeps what they did. That is only
   * an improvement if fixing it is one click rather than arithmetic they have
   * to do themselves.
   *
   * Returns null when nothing sensible can be offered — an unavailable product
   * cannot be corrected by changing a number.
   */
  const correctionFor = (code: string): { label: string; quantity: number } | null => {
    if (code === 'INSUFFICIENT_STOCK') {
      // Only worth offering when the available amount is itself a legal
      // quantity; otherwise the "fix" produces a different violation.
      if (available === null || available < rules.minOrderQty) return null;
      const target = clampToRules(available, rules);
      if (target > available) return null;
      return { label: `Reduce to ${formatNumber(target)}`, quantity: target };
    }

    if (code === 'QUANTITY_BELOW_MINIMUM' || code === 'QUANTITY_INCREMENT_INVALID') {
      const target = clampToRules(line.quantity, rules);
      if (target === line.quantity) return null;
      return { label: `Change to ${formatNumber(target)}`, quantity: target };
    }

    if (code === 'QUANTITY_ABOVE_MAXIMUM' && rules.maxOrderQty !== null) {
      const target = clampToRules(rules.maxOrderQty, rules);
      return { label: `Reduce to ${formatNumber(target)}`, quantity: target };
    }

    return null;
  };

  return (
    <li className="flex gap-4 py-5">
      <Link to={`/product/${line.slug}`} className="shrink-0">
        {line.imageUrl === null ? (
          <span
            aria-hidden="true"
            className="block h-20 w-20 rounded-md border border-border bg-surface-sunken"
          />
        ) : (
          <img
            src={line.imageUrl}
            alt=""
            width={80}
            height={80}
            loading="lazy"
            className="h-20 w-20 rounded-md border border-border bg-surface object-contain p-1.5"
          />
        )}
      </Link>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-ink">
              <Link to={`/product/${line.slug}`} className="hover:text-brand hover:underline">
                {line.name}
              </Link>
            </h3>
            <p className="mt-0.5 font-mono text-xxs text-ink-subtle">{line.sku}</p>
          </div>

          <p className="shrink-0 text-right">
            <span className="block text-sm font-semibold tabular text-ink">
              {formatMoney(line.lineTotal)}
            </span>
            <span className="block text-xxs text-ink-muted">
              {formatMoney(line.unitPrice)} each
              {line.taxInclusive ? ' (tax included)' : ` + ${line.taxRatePercent}% tax`}
            </span>
          </p>
        </div>

        <div className="mt-3 flex flex-wrap items-end gap-4">
          <QuantityInput
            value={line.quantity}
            onChange={onQuantityChange}
            rules={rules}
            label="Quantity"
            disabled={isBusy}
          />

          <Button size="sm" variant="ghost" disabled={isBusy} onClick={onRemove}>
            Remove
          </Button>

          {line.isRecurringEligible && <Badge tone="brand">Repeat purchase available</Badge>}
        </div>

        {line.issues.map((issue) => {
          const correction = correctionFor(issue.code);

          return (
            <IssueNotice
              key={`${issue.code}:${issue.message}`}
              issue={issue}
              {...(correction === null
                ? {}
                : {
                    correctionLabel: correction.label,
                    onCorrect: () => {
                      onQuantityChange(correction.quantity);
                    },
                  })}
            />
          );
        })}
      </div>
    </li>
  );
}

export function CartPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const { business } = useStorefront();

  // Which line is mid-change. Scoped per line so editing one does not freeze
  // the whole cart.
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useDocumentMeta({ title: 'Your cart', noIndex: true }, business.displayName);

  const query = useQuery({
    queryKey: ['cart'],
    queryFn: () => api.get<{ cart: Cart }>('/cart'),
  });

  /** Every mutation returns the whole cart; that response becomes the truth. */
  const applyCart = (result: { cart: Cart }): void => {
    queryClient.setQueryData(['cart'], result);
    setActionError(null);
  };

  const updateQuantity = useMutation({
    mutationFn: ({ itemId, quantity }: { itemId: string; quantity: number }) =>
      api.patch<{ cart: Cart }>(`/cart/items/${itemId}`, { quantity }),
    onMutate: ({ itemId }) => {
      setBusyItemId(itemId);
    },
    onSuccess: applyCart,
    onError: (error) => {
      setActionError(
        error instanceof ApiError ? error.message : 'That change could not be saved.',
      );
      // The local view may now disagree with the server, so re-read rather
      // than leaving a quantity on screen that was never accepted.
      void queryClient.invalidateQueries({ queryKey: ['cart'] });
    },
    onSettled: () => {
      setBusyItemId(null);
    },
  });

  const removeItem = useMutation({
    mutationFn: (itemId: string) => api.delete<{ cart: Cart }>(`/cart/items/${itemId}`),
    onMutate: (itemId) => {
      setBusyItemId(itemId);
    },
    onSuccess: (result) => {
      applyCart(result);
      toast.success('Removed from your cart.');
    },
    onError: (error) => {
      setActionError(error instanceof ApiError ? error.message : 'That item could not be removed.');
      void queryClient.invalidateQueries({ queryKey: ['cart'] });
    },
    onSettled: () => {
      setBusyItemId(null);
    },
  });

  const clearCart = useMutation({
    mutationFn: () => api.delete<{ cart: Cart }>('/cart'),
    onSuccess: (result) => {
      applyCart(result);
      toast.success('Cart emptied.');
    },
    onError: () => {
      setActionError('The cart could not be emptied.');
    },
  });

  if (query.isPending) return <LoadingState label="Loading your cart" />;

  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  const cart = query.data.cart;

  if (cart.lines.length === 0) {
    return (
      <div className="mx-auto max-w-lg py-16 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Your cart is empty</h1>
        <p className="mt-3 text-sm text-ink-muted">
          Everything you add stays here until you check out.
        </p>
        <Link
          to="/products"
          className="mt-6 inline-flex h-12 items-center rounded-md bg-action px-6 text-base font-medium text-white hover:bg-action-hover"
        >
          Browse products
        </Link>
      </div>
    );
  }

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Your cart</h1>
          <p className="mt-1 text-sm text-ink-muted" aria-live="polite">
            {formatNumber(cart.itemCount)} item{cart.itemCount === 1 ? '' : 's'} across{' '}
            {cart.lines.length} product{cart.lines.length === 1 ? '' : 's'}
          </p>
        </div>

        <Button
          variant="ghost"
          isLoading={clearCart.isPending}
          onClick={() => {
            clearCart.mutate();
          }}
        >
          Empty the cart
        </Button>
      </div>

      {actionError !== null && (
        <div
          role="alert"
          className="mb-5 rounded-md border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger"
        >
          {actionError}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="rounded-lg border border-border bg-surface px-5">
          <ul className="divide-y divide-border">
            {cart.lines.map((line) => (
              <LineRow
                key={line.itemId}
                line={line}
                isBusy={busyItemId === line.itemId}
                onQuantityChange={(quantity) => {
                  updateQuantity.mutate({ itemId: line.itemId, quantity });
                }}
                onRemove={() => {
                  removeItem.mutate(line.itemId);
                }}
              />
            ))}
          </ul>
        </div>

        <aside aria-labelledby="summary-heading" className="lg:sticky lg:top-40 lg:self-start">
          <div className="rounded-lg border border-border bg-surface p-5">
            <h2 id="summary-heading" className="text-base font-semibold text-ink">
              Order summary
            </h2>

            <dl className="mt-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-ink-muted">Subtotal</dt>
                <dd className="tabular text-ink">{formatMoney(cart.totals.subtotal)}</dd>
              </div>

              {cart.totals.discount.minor !== '0' && (
                <div className="flex justify-between">
                  <dt className="text-ink-muted">Discount</dt>
                  <dd className="tabular text-success">−{formatMoney(cart.totals.discount)}</dd>
                </div>
              )}

              <div className="flex justify-between">
                <dt className="text-ink-muted">Tax</dt>
                <dd className="tabular text-ink">{formatMoney(cart.totals.tax)}</dd>
              </div>

              <div className="flex justify-between">
                <dt className="text-ink-muted">Delivery</dt>
                <dd className="tabular text-ink">
                  {cart.totals.shipping.minor === '0' ? (
                    <span className="text-ink-muted">Calculated at checkout</span>
                  ) : (
                    formatMoney(cart.totals.shipping)
                  )}
                </dd>
              </div>

              <div className="flex justify-between border-t border-border pt-2 text-base font-semibold">
                <dt>Estimated total</dt>
                <dd className="tabular">{formatMoney(cart.totals.grandTotal)}</dd>
              </div>
            </dl>

            {/* Every figure above comes from the server. Saying so sets the
                right expectation for the final breakdown at checkout. */}
            <p className="mt-2 text-xxs text-ink-subtle">
              Confirmed at checkout once delivery is chosen.
            </p>

            <CouponPanel cart={cart} />

            {cart.requiresApproval && (
              <div
                role="status"
                className="mt-4 rounded-md border border-warning/30 bg-warning-soft px-3 py-2.5 text-xs text-ink"
              >
                <p className="font-medium text-warning">This order will need approval</p>
                <p className="mt-0.5">
                  {cart.approvalReason ??
                    'It will go to your approver before it is confirmed. You can still place it now.'}
                </p>
              </div>
            )}

            {cart.blockingIssues.length > 0 && (
              <div
                role="alert"
                className="mt-4 rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-xs"
              >
                <p className="font-medium text-danger">Before you can check out</p>
                <ul className="mt-1 space-y-1 text-ink">
                  {cart.blockingIssues.map((issue) => (
                    <li key={`${issue.code}:${issue.message}`}>{issue.message}</li>
                  ))}
                </ul>
              </div>
            )}

            <Button
              variant="action"
              size="lg"
              fullWidth
              className="mt-5"
              // The server's verdict, not a count of issues computed here —
              // which would drift the first time a new issue code appeared.
              disabled={!cart.checkoutReady}
              onClick={() => {
                void navigate('/checkout');
              }}
            >
              Proceed to checkout
            </Button>

            {!cart.checkoutReady && cart.blockingIssues.length === 0 && (
              <p className="mt-2 text-center text-xs text-ink-muted">
                Fix the items flagged above to continue.
              </p>
            )}

            <Link
              to="/products"
              className="mt-2 inline-flex h-10 w-full items-center justify-center rounded-md border border-border-strong bg-surface text-sm font-medium text-ink hover:bg-surface-sunken"
            >
              Continue shopping
            </Link>
          </div>
        </aside>
      </div>
    </>
  );
}

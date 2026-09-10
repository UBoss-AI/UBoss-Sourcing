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
 *
 * The one number this file *derives* is whether the tax figure is already
 * inside the subtotal, and it derives it from `line.taxInclusive` — a flag the
 * server sends — purely to label the row. On an inclusive cart the column does
 * not add up unless somebody says so, and "somebody" was previously nobody.
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStorefront } from '@/app/storefront-context';
import { useToast } from '@/components/toast-context';
import { AutoPaySetupDialog } from '@/components/AutoPaySetupDialog';
import { QuantityInput } from '@/components/QuantityInput';
import { CouponPanel } from '@/components/CouponPanel';
import { CheckoutSteps } from '@/components/CheckoutSteps';
import { CART_STEPS } from '@/lib/checkout-steps';
import { StickyBottomBar } from '@/components/StickyBottomBar';
import { GrandTotalRow, TotalRow } from '@/components/Totals';
import { PageEmptyState } from '@/components/PageEmptyState';
import { AlertIcon, TrashIcon } from '@/components/icons';
import { clampToRules } from '@/lib/quantity-rules';
import { Badge, Button, ButtonLink, ErrorState, LoadingState } from '@/components/ui';
import { api } from '@/lib/api';
import { autoPayApi, autoPayKeys } from '@/lib/autopay';
import { formatMoney, formatNumber } from '@/lib/format';
import { useI18n } from '@/i18n/i18n-context';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import type { Cart, CartIssue, CartLine, PurchaseRules } from '@/lib/types';
import { errorMessage } from '@/lib/errors';

/** The cart's rules, widened back to what the quantity control expects. */
function toPurchaseRules(line: CartLine): PurchaseRules {
  return {
    ...line.purchaseRules,
    isRecurringEligible: line.isRecurringEligible,
  };
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
      className={`mt-3 flex gap-2.5 rounded-md border px-3 py-2.5 text-xs ${
        isFatal
          ? 'border-danger/30 bg-danger-soft text-danger'
          : isNotice
            ? 'border-brand/30 bg-brand-soft text-brand'
            : 'border-warning/30 bg-warning-soft text-warning'
      }`}
    >
      {/* The glyph is the second signal. A tinted panel alone is a colour, and
          a colour alone is not a message. */}
      <AlertIcon className="mt-px h-4 w-4 shrink-0" />

      <div className="min-w-0">
        <p className="font-medium">{issue.message}</p>

        {onCorrect !== undefined && correctionLabel !== undefined && (
          <button
            type="button"
            onClick={onCorrect}
            className="mt-1.5 font-semibold text-ink underline underline-offset-2 hover:no-underline"
          >
            {correctionLabel}
          </button>
        )}
      </div>
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
  const { t } = useI18n();

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
      return { label: t('cart.reduceTo', { quantity: formatNumber(target) }), quantity: target };
    }

    if (code === 'QUANTITY_BELOW_MINIMUM' || code === 'QUANTITY_INCREMENT_INVALID') {
      const target = clampToRules(line.quantity, rules);
      if (target === line.quantity) return null;
      return { label: t('cart.changeTo', { quantity: formatNumber(target) }), quantity: target };
    }

    if (code === 'QUANTITY_ABOVE_MAXIMUM' && rules.maxOrderQty !== null) {
      const target = clampToRules(rules.maxOrderQty, rules);
      return { label: t('cart.reduceTo', { quantity: formatNumber(target) }), quantity: target };
    }

    return null;
  };

  return (
    <li
      className={`flex gap-4 py-6 transition-opacity first:pt-5 last:pb-5 sm:gap-5 ${
        isBusy ? 'opacity-60' : ''
      }`}
    >
      {/*
       * The image is the line's anchor, so it is the largest thing in the row
       * and it is a link — a customer checking "is this the right bolt?" goes
       * back to the product, and the picture is what they reach for.
       */}
      <Link
        to={`/product/${line.slug}`}
        className="group shrink-0"
        aria-label={t('cart.viewProduct', { product: line.name })}
      >
        {line.imageUrl === null ? (
          <span
            aria-hidden="true"
            className="block h-14 w-14 rounded-lg border border-border bg-surface-sunken min-[380px]:h-20 min-[380px]:w-20 sm:h-24 sm:w-24"
          />
        ) : (
          <img
            src={line.imageUrl}
            alt=""
            width={96}
            height={96}
            loading="lazy"
            className="h-14 w-14 rounded-lg border border-border bg-surface object-contain p-2 transition-colors group-hover:border-border-hover min-[380px]:h-20 min-[380px]:w-20 sm:h-24 sm:w-24"
          />
        )}
      </Link>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
          <div className="min-w-0">
            {/* One step up from the body text around it. The product name is
                the thing being scanned down the column; at 14px regular it was
                the same weight as its own SKU. */}
            <h3 className="text-title-xs text-ink">
              <Link to={`/product/${line.slug}`} className="hover:text-brand hover:underline">
                {line.name}
              </Link>
            </h3>

            {/* The option, in the same weight as the price beside it rather
                than as another grey footnote. A cart can now hold the 3 ml and
                the 5 ml of one product as two lines, and those two lines carry
                the same name and the same photograph — this is the only thing
                on the row that says which is which, so it cannot be the
                quietest thing on it. */}
            {line.variantName !== null && (
              <p className="mt-1 text-sm font-medium text-ink-muted">{line.variantName}</p>
            )}

            <p className="mt-1 font-mono text-xxs text-ink-subtle">{line.sku}</p>
          </div>

          <p className="shrink-0 text-right">
            <span className="block text-title-sm tabular text-ink">
              {formatMoney(line.lineTotal)}
            </span>
            <span className="mt-0.5 block text-xxs text-ink-muted">
              {formatMoney(line.unitPrice)} each
              {line.taxInclusive
                ? ` ${t('cart.taxIncludedNote')}`
                : ` ${t('cart.plusTaxRate', { rate: line.taxRatePercent })}`}
            </span>
          </p>
        </div>

        {/*
         * No per-line "Repeat purchase available" badge.
         *
         * It carried information while an administrator opted products in one
         * at a time. Now that everything a customer can buy can also be
         * scheduled, it appeared on every line of every cart — and a badge on
         * everything is a badge that says nothing, competing for attention
         * with the issue notices below it, which do need to be seen.
         *
         * The capability is still offered, once, where it can be acted on: the
         * "Need this again?" panel beside the summary. `line.isRecurringEligible`
         * is still read — that panel counts it.
         */}
        <div className="mt-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
          <QuantityInput
            value={line.quantity}
            onChange={onQuantityChange}
            rules={rules}
            label={t('cart.quantity')}
            disabled={isBusy}
            // Two lines of one product mean two steppers a screen reader would
            // otherwise hear as "Increase quantity by 5" twice over.
            itemName={line.variantName ?? line.name}
          />

          {/*
           * Remove is deliberately visible rather than revealed on hover —
           * there is no hover on a phone, and a control that only exists for
           * mouse users is a control half the customers do not have. It stays
           * quiet until approached, and turns red then: destructive, but not
           * shouting from across the row.
           */}
          <Button
            size="sm"
            variant="ghost"
            disabled={isBusy}
            onClick={onRemove}
            className="hover:bg-danger-soft hover:text-danger"
          >
            <TrashIcon className="h-4 w-4" />
            {t('cart.remove')}
            <span className="sr-only">
              {' '}
              {line.variantName === null ? line.name : `${line.name} ${line.variantName}`} from
              your cart
            </span>
          </Button>
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

/**
 * The other thing that can be done with this cart.
 *
 * A customer who has just added a case of flush syringes is at the exact
 * moment they would think "I need these every week", and until now the only
 * place that thought could be acted on was a product badge and a page in the
 * account section. This puts the schedule next to Checkout, where the decision
 * is actually being made.
 *
 * The auto-pay half is here for the same reason. `/schedules/new` offers
 * "Autopay" as a radio button, but choosing it there is only
 * useful once a card is authorised — so the state of that authority is worth
 * knowing *before* the builder, not after.
 *
 * It is now actionable rather than only readable, and the button says which of
 * three things will happen, because they are genuinely different:
 *
 *   no card       — "Set up a card" — enrolment, then the consent step. This
 *                   is the order the two have to happen in: there is nothing
 *                   to consent about until a card exists.
 *   card, off     — "Turn on automatic payment" — the consent step alone.
 *   paused        — "Resume" — consent is already on record, so this is one
 *                   call and no new agreement.
 *
 * What it does NOT do is enable anything from this panel directly. Both the
 * card and the consent are collected in a dialog with the wording in front of
 * the customer; a cart button that quietly authorised off-session charges
 * would be the one thing this whole path must not be.
 *
 * Both halves fail quietly. `available: false` means the store does not offer
 * auto-pay at all, and a failed or still-loading read simply omits the block —
 * a cart must not lose its checkout button because an account endpoint
 * hiccoughed.
 */
function RepeatPurchasePanel({ eligibleCount }: { eligibleCount: number }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [isSettingUp, setIsSettingUp] = useState(false);

  const query = useQuery({
    queryKey: autoPayKeys.settings,
    queryFn: () => autoPayApi.get(),
    // Nothing on this page changes it except the dialog below, which
    // invalidates the key itself.
    staleTime: 60_000,
    retry: false,
  });

  const autoPay = query.data?.available === true ? query.data.autoPay : null;

  const resume = useMutation({
    mutationFn: () => autoPayApi.setPaused(false),
    onSuccess: () => {
      toast.success(t('autopay.resumed'));
      void queryClient.invalidateQueries({ queryKey: autoPayKeys.settings });
    },
    onError: (error) => {
      toast.error(errorMessage(t, error, t('autopay.couldNotBeSwitchedOn')));
    },
  });

  return (
    <div className="mt-4 rounded-lg border border-border bg-surface p-5 shadow-card">
      <h2 className="text-title-sm text-ink">{t('cart.repeatHeading')}</h2>

      <p className="mt-1.5 text-xs text-ink-muted">
        {t('cart.repeatEligibleCount', { count: eligibleCount })}
      </p>

      {autoPay !== null && (
        <div className="mt-4 rounded-md bg-surface-sunken px-3 py-2.5">
          <p className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-ink">{t('cart.autoPayLabel')}</span>
            <Badge
              tone={
                autoPay.status === 'ACTIVE'
                  ? 'success'
                  : autoPay.status === 'PAUSED'
                    ? 'warning'
                    : 'neutral'
              }
            >
              {t(`autopay.state.${autoPay.status}` as 'autopay.state.ACTIVE')}
            </Badge>
          </p>

          <p className="mt-1 text-xxs text-ink-muted">
            {autoPay.status === 'ACTIVE'
              ? autoPay.paymentMethodLabel === null
                ? t('cart.autoPayOnHintNoCard')
                : t('cart.autoPayOnHint', { card: autoPay.paymentMethodLabel })
              : autoPay.status === 'PAUSED'
                ? t('cart.autoPayPausedHint')
                : t('cart.autoPayOffHint')}
          </p>

          {/*
           * One control per state, and never two.
           *
           * ACTIVE has nothing to switch on, so it gets the management link it
           * always had — changing a limit or withdrawing consent belongs on
           * the page that explains both.
           */}
          {autoPay.status === 'ACTIVE' ? (
            <Link
              to="/account/autopay"
              className="mt-1.5 inline-block text-xxs font-semibold text-brand underline underline-offset-2 hover:no-underline"
            >
              {t('cart.autoPayManage')}
            </Link>
          ) : autoPay.status === 'PAUSED' ? (
            <Button
              size="sm"
              variant="primary"
              fullWidth
              className="mt-2.5"
              isLoading={resume.isPending}
              onClick={() => {
                resume.mutate();
              }}
            >
              {t('cart.autoPayResume')}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              fullWidth
              className="mt-2.5"
              onClick={() => {
                setIsSettingUp(true);
              }}
            >
              {/* The label names the FIRST step, not the destination. A
                  customer with no card who is promised "turn on automatic
                  payment" and handed a card form has been surprised; one
                  offered "set up a card for automatic payment" has not. */}
              {autoPay.paymentMethodUsable
                ? t('cart.autoPayTurnOn')
                : t('cart.autoPaySetUpCard')}
            </Button>
          )}
        </div>
      )}

      {/* Blue, not orange: the orange belongs to Add to Cart, Checkout and
          Place Order. This is a second road, not a louder version of the
          first one. */}
      <ButtonLink to="/schedules/new" variant="primary" fullWidth className="mt-4">
        {t('cart.repeatSetUp')}
      </ButtonLink>

      {isSettingUp && (
        <AutoPaySetupDialog
          onClose={() => {
            setIsSettingUp(false);
          }}
          onEnabled={() => {
            toast.success(t('autopay.enabled'));
          }}
        />
      )}
    </div>
  );
}

export function CartPage(): React.JSX.Element {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const { business } = useStorefront();

  // Which line is mid-change. Scoped per line so editing one does not freeze
  // the whole cart.
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useDocumentMeta({ title: t('cart.pageTitle'), noIndex: true }, business.displayName);

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
      setActionError(errorMessage(t, error, t('cart.changeNotSaved')));
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
      toast.success(t('cart.removedToast'));
    },
    onError: (error) => {
      setActionError(errorMessage(t, error, t('cart.itemNotRemoved')));
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
      toast.success(t('cart.emptiedToast'));
    },
    onError: () => {
      setActionError(t('cart.notEmptied'));
    },
  });

  if (query.isPending) return <LoadingState label={t('cart.loading')} />;

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
      <>
        <CheckoutSteps states={CART_STEPS} />
        <PageEmptyState
          title={t('cart.emptyTitle')}
          description={t('cart.emptyBody')}
          /* Blue, not orange. Browsing is navigation; the orange belongs to
             Add to Cart, Checkout and Place Order and nowhere else. */
          action={
            <ButtonLink to="/products" variant="primary" size="lg">
              {t('cart.browseProducts')}
            </ButtonLink>
          }
        />
      </>
    );
  }

  /*
   * Whether the tax figure is already inside the subtotal.
   *
   * Read off the lines the server sent, not computed from the money: an
   * inclusive cart's column reads Subtotal + Tax + Delivery and then a total
   * that is *less* than their sum, because the tax was extracted from the
   * prices rather than added to them. That is correct, and it looks like an
   * arithmetic bug until the row says so.
   */
  const inclusiveLines = cart.lines.filter((line) => line.taxInclusive).length;

  /*
   * How many of these products the builder would accept.
   *
   * The same flag the line badge reads, counted here so the panel can say a
   * number rather than "some of these". `/schedules/new` filters the cart by
   * exactly this, so a panel offered on a cart of nothing eligible would lead
   * straight to that page's empty state.
   */
  const recurringEligibleCount = cart.lines.filter((line) => line.isRecurringEligible).length;
  const taxHint =
    inclusiveLines === cart.lines.length
      ? '· already in the prices above'
      : inclusiveLines > 0
        ? '· partly in the prices above'
        : '· added to the subtotal';

  return (
    <>
      <CheckoutSteps states={CART_STEPS} />

      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-title-xl text-ink">{t('cart.pageTitle')}</h1>
          <p className="mt-2 text-sm text-ink-muted" aria-live="polite">
            {t('cart.itemsAcrossProducts', {
              items: t('cart.itemCount', { count: cart.itemCount }),
              products: t('cart.productCount', { count: cart.lines.length }),
            })}
          </p>
        </div>

        <Button
          variant="ghost"
          className="shrink-0"
          isLoading={clearCart.isPending}
          onClick={() => {
            clearCart.mutate();
          }}
        >
          {t('cart.emptyTheCart')}
        </Button>
      </header>

      {actionError !== null && (
        <div
          role="alert"
          className="mb-5 flex gap-2.5 rounded-md border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger"
        >
          <AlertIcon className="mt-px h-4 w-4 shrink-0" />
          {actionError}
        </div>
      )}

      {/* The bottom padding clears the sticky bar below `lg`, so the last
          line of the summary is never parked underneath it. */}
      <div className="grid grid-cols-1 gap-6 pb-24 lg:grid-cols-[minmax(0,1fr)_22rem] lg:pb-0">
        <div className="rounded-lg border border-border bg-surface px-4 shadow-card sm:px-5">
          <ul className="divide-y divide-border-subtle">
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

        {/*
         * Sticky from `lg`, offset to clear the sticky header. Below that it
         * is an ordinary block under the lines: a summary pinned to a short
         * phone viewport is a summary covering the thing it summarises.
         */}
        <aside aria-labelledby="summary-heading" className="lg:sticky lg:top-28 lg:self-start">
          <div className="rounded-lg border border-border bg-surface p-5 shadow-card">
            <h2 id="summary-heading" className="text-title-sm text-ink">
              {t('cart.summary')}
            </h2>

            <dl className="mt-4 space-y-2.5 text-sm">
              <TotalRow
                label={t('cart.subtotal')}
                hint={`· ${t('cart.itemCount', { count: cart.itemCount })}`}
                value={formatMoney(cart.totals.subtotal)}
              />

              {cart.totals.discount.minor !== '0' && (
                <TotalRow
                  label={t('cart.discount')}
                  tone="credit"
                  value={<>−{formatMoney(cart.totals.discount)}</>}
                />
              )}

              <TotalRow label={t('cart.tax')} hint={taxHint} value={formatMoney(cart.totals.tax)} />

              <TotalRow
                label={t('cart.delivery')}
                value={
                  cart.totals.shipping.minor === '0' ? (
                    <span className="text-xs font-normal text-ink-muted">
                      {t('cart.deliveryAtCheckout')}
                    </span>
                  ) : (
                    formatMoney(cart.totals.shipping)
                  )
                }
              />

              <GrandTotalRow
                label={t('cart.estimatedTotal')}
                value={formatMoney(cart.totals.grandTotal)}
                // Every figure above comes from the server. Saying so sets the
                // right expectation for the final breakdown at checkout.
                note="Confirmed at checkout once delivery is chosen."
              />
            </dl>

            <CouponPanel cart={cart} />

            {cart.requiresApproval && (
              <div
                role="status"
                className="mt-4 rounded-md border border-warning/30 bg-warning-soft px-3 py-2.5 text-xs text-ink"
              >
                <p className="font-medium text-warning">{t('cart.needsApproval')}</p>
                <p className="mt-0.5">{cart.approvalReason ?? t('cart.needsApprovalBody')}</p>
              </div>
            )}

            {cart.blockingIssues.length > 0 && (
              <div
                role="alert"
                className="mt-4 rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-xs"
              >
                <p className="font-medium text-danger">{t('cart.blockingHeading')}</p>
                <ul className="mt-1 list-inside list-disc space-y-1 text-ink">
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
              {t('cart.proceedToCheckout')}
            </Button>

            {!cart.checkoutReady && cart.blockingIssues.length === 0 && (
              <p className="mt-2 text-center text-xs text-ink-muted">{t('cart.fixFlagged')}</p>
            )}

            <ButtonLink to="/products" fullWidth className="mt-2">
              {t('cart.continueShopping')}
            </ButtonLink>
          </div>

          {recurringEligibleCount > 0 && (
            <RepeatPurchasePanel eligibleCount={recurringEligibleCount} />
          )}
        </aside>
      </div>

      {/*
       * The phone-sized checkout bar.
       *
       * Below `lg` the summary sits under a column of lines that can be a
       * screen and a half long, and the CTA goes with it. This keeps one
       * reachable, without repeating the total — the figure lives in exactly
       * one place on the page, so there is nothing to fall out of step.
       */}
      <StickyBottomBar>
        <p className="min-w-0 flex-1 text-xs text-ink-muted">
          {t('cart.itemsReady', { count: cart.itemCount })}
        </p>
        <Button
          variant="action"
          size="lg"
          className="shrink-0"
          disabled={!cart.checkoutReady}
          onClick={() => {
            void navigate('/checkout');
          }}
        >
          {t('cart.checkout')}
        </Button>
      </StickyBottomBar>
    </>
  );
}

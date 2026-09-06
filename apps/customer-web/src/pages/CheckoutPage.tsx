/**
 * Checkout.
 *
 * The whole page exists to get one thing right: **exactly one order is
 * created, whatever the customer or their network does.**
 *
 *   - The idempotency key is generated once, when the page mounts, and reused
 *     for every attempt. A new key per click is precisely the duplicate-order
 *     bug the header exists to prevent, so it is created outside the submit
 *     handler where nobody can accidentally regenerate it.
 *   - The submit button disables while in flight, but that is the weak guard.
 *     The strong one is the key: a customer who double-clicks, retries after a
 *     timeout, or refreshes and submits again still gets one order, and the
 *     server tells us with `replayed` which of those happened.
 *   - Nothing is inferred about payment. Checkout creates the order; payment
 *     happens on the next page and is only ever confirmed by the backend.
 *
 * The totals shown here are the server's, re-read with the chosen delivery
 * method. This page never adds tax or shipping itself — a second pricing
 * engine that eventually disagrees with the first is worse than no preview.
 *
 * The progress indicator at the top follows that same rule. It marks Address
 * complete only once an address is actually selected, and it never touches the
 * Payment step, because no money moves on this page.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStorefront } from '@/app/storefront-context';
import { AddressForm } from '@/components/AddressForm';
import { CheckoutSteps } from '@/components/CheckoutSteps';
import { checkoutSteps } from '@/lib/checkout-steps';
import { GrandTotalRow, TotalRow } from '@/components/Totals';
import { PageEmptyState } from '@/components/PageEmptyState';
import { AlertIcon, CardIcon, CheckIcon, LinkIcon, ShieldIcon } from '@/components/icons';
import { Button, ButtonLink, ErrorState, Field, LoadingState, Textarea } from '@/components/ui';
import { ApiError, NetworkError, api, newIdempotencyKey } from '@/lib/api';
import { cx } from '@/lib/cx';
import { formatMoney, formatNumber } from '@/lib/format';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import type {
  Address,
  Cart,
  CheckoutResult,
  PaymentGateways,
  PaymentMethodHint,
  PaymentProviderKind,
} from '@/lib/types';
import { useI18n } from '@/i18n/i18n-context';

type PaymentMode = 'ONLINE' | 'PAYMENT_LINK';

/**
 * Whether a gateway may be offered for the money in the cart.
 *
 * A gateway that cannot settle the cart's currency is worse than absent: the
 * customer picks it, reaches the sheet, and is declined for a reason nothing
 * on this page explained. `currencies: null` means the gateway itself imposes
 * no limit, which is Stripe.
 */
function gatewayHandles(currencies: string[] | null, currency: string): boolean {
  return currencies === null || currencies.includes(currency);
}

/**
 * The shared look of every choosable card on this page — an address, a way to
 * pay. Selection is carried by three signals at once, because one is never
 * enough: the ring, the radio, and the "Selected" tick in the corner. Someone
 * who cannot separate the blue ring from the grey border can still see which
 * card has the tick.
 */
function choiceCardClass(isSelected: boolean, size: 'md' | 'sm' = 'md'): string {
  return cx(
    'relative flex cursor-pointer gap-3 rounded-lg border transition-colors',
    size === 'md' ? 'p-4' : 'p-3',
    isSelected
      ? 'border-brand bg-brand-soft ring-2 ring-brand ring-offset-1 ring-offset-surface'
      : 'border-border bg-surface hover:border-brand/50 hover:bg-surface-hover',
  );
}

/** The corner tick. Text as well as a glyph, so it survives a greyscale print. */
function SelectedFlag(): React.JSX.Element {
  const { t } = useI18n();

  return (
    <span className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-full bg-brand px-2 py-0.5 text-xxs font-semibold text-white">
      <CheckIcon className="h-3 w-3" />
      {t('checkout.selected')}
    </span>
  );
}

function AddressCard({
  address,
  isSelected,
  onSelect,
}: {
  address: Address;
  isSelected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  return (
    <label className={choiceCardClass(isSelected)}>
      <input
        type="radio"
        name="shippingAddress"
        className="mt-1 h-4 w-4 shrink-0 border-border-strong text-brand"
        checked={isSelected}
        onChange={onSelect}
      />
      <span className="min-w-0 pr-20 text-sm">
        {address.label !== null && (
          <span className="block text-title-xs text-ink">{address.label}</span>
        )}
        <span className="block font-medium text-ink">{address.contactName}</span>
        <span className="mt-1 block leading-relaxed text-ink-muted">
          {address.line1}
          {address.line2 !== null && `, ${address.line2}`}, {address.city}, {address.state}{' '}
          {address.postalCode}, {address.country}
        </span>
        <span className="mt-1 block text-xs text-ink-subtle">{address.contactPhone}</span>
      </span>
      {isSelected && <SelectedFlag />}
    </label>
  );
}

/** One way to pay. Same card, an icon, and the same three selection signals. */
function PaymentChoice({
  isSelected,
  onSelect,
  icon,
  title,
  children,
}: {
  isSelected: boolean;
  onSelect: () => void;
  icon: React.JSX.Element;
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <label className={choiceCardClass(isSelected)}>
      <input
        type="radio"
        name="paymentMode"
        className="mt-1 h-4 w-4 shrink-0 border-border-strong text-brand"
        checked={isSelected}
        onChange={onSelect}
      />
      <span
        aria-hidden="true"
        className={cx(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-md',
          isSelected ? 'bg-brand text-white' : 'bg-surface-sunken text-ink-muted',
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 pr-20 text-sm">
        <span className="block text-title-xs text-ink">{title}</span>
        <span className="mt-1 block leading-relaxed text-ink-muted">{children}</span>
      </span>
      {isSelected && <SelectedFlag />}
    </label>
  );
}

/** A panel on this page. One shape, so the three sections stack evenly. */
function Section({
  id,
  title,
  step,
  children,
}: {
  id: string;
  title: string;
  /** The little numeral before the heading — the page's own running order. */
  step: number;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section
      aria-labelledby={id}
      className="rounded-lg border border-border bg-surface p-5 shadow-card"
    >
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-xxs font-semibold text-ink-muted"
        >
          {step}
        </span>
        <h2 id={id} className="text-title-sm text-ink">
          {title}
        </h2>
      </div>
      {children}
    </section>
  );
}

export function CheckoutPage(): React.JSX.Element {
  const { t } = useI18n();

  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { business } = useStorefront();

  const [shippingAddressId, setShippingAddressId] = useState<string | null>(null);
  const [billingSameAsShipping, setBillingSameAsShipping] = useState(true);
  const [billingAddressId, setBillingAddressId] = useState<string | null>(null);
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('ONLINE');
  /**
   * The gateway and instrument the customer picked, or null while the offer
   * list is still loading and the default is not yet known.
   */
  const [gateway, setGateway] = useState<PaymentProviderKind | null>(null);
  const [methodHint, setMethodHint] = useState<PaymentMethodHint>('ANY');
  const [customerNote, setCustomerNote] = useState('');
  const [isAddingAddress, setIsAddingAddress] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useDocumentMeta({ title: 'Checkout', noIndex: true }, business.displayName);

  /**
   * One key for this checkout attempt, for the life of the page.
   *
   * Created here rather than inside the submit handler so it cannot be
   * regenerated by a re-render or a retry. Every attempt from this page — a
   * double click, a retry after a timeout — carries the same key, and the
   * server answers with the same order.
   */
  const idempotencyKey = useMemo(() => newIdempotencyKey(), []);

  const addresses = useQuery({
    queryKey: ['addresses'],
    queryFn: () => api.get<{ addresses: Address[] }>('/account/addresses'),
  });

  const cart = useQuery({
    queryKey: ['cart'],
    queryFn: () => api.get<{ cart: Cart }>('/cart'),
  });

  const gateways = useQuery({
    queryKey: ['payment-gateways'],
    queryFn: () => api.get<PaymentGateways>('/payments/gateways'),
  });

  const usableAddresses = useMemo(
    () => (addresses.data?.addresses ?? []).filter((address) => address.archivedAt === null),
    [addresses.data],
  );

  const cartCurrency = cart.data?.cart.currency ?? null;

  /**
   * The gateways that can actually take this cart's money.
   *
   * Filtered here rather than on the server because the currency belongs to
   * the cart, and the gateway list is cached across carts.
   */
  const offeredGateways = useMemo(() => {
    if (cartCurrency === null) return [];

    return (gateways.data?.gateways ?? []).filter((entry) =>
      gatewayHandles(entry.currencies, cartCurrency),
    );
  }, [gateways.data, cartCurrency]);

  /**
   * Settle on a gateway once the offer is known, and re-settle if the cart's
   * currency later rules the chosen one out.
   *
   * The server's default wins when it is on offer; otherwise the first that
   * is. A single gateway is still "chosen" rather than special-cased, so what
   * gets sent to the payment page does not depend on how many there happen to
   * be.
   */
  useEffect(() => {
    if (offeredGateways.length === 0) return;
    if (gateway !== null && offeredGateways.some((entry) => entry.provider === gateway)) return;

    const preferred =
      offeredGateways.find((entry) => entry.provider === gateways.data?.defaultProvider) ??
      offeredGateways[0];

    setGateway(preferred?.provider ?? null);
    setMethodHint('ANY');
  }, [offeredGateways, gateway, gateways.data]);

  /** Instruments the chosen gateway can be asked for, beyond its own default. */
  const extraMethods = useMemo(
    () =>
      (offeredGateways.find((entry) => entry.provider === gateway)?.methods ?? []).filter(
        (method) => method !== 'ANY',
      ),
    [offeredGateways, gateway],
  );

  // Preselect the customer's default so the common case is zero clicks.
  useEffect(() => {
    if (shippingAddressId !== null || usableAddresses.length === 0) return;

    const preferred =
      usableAddresses.find((address) => address.isDefaultShipping) ?? usableAddresses[0];

    setShippingAddressId(preferred?.id ?? null);
  }, [usableAddresses, shippingAddressId]);

  const submit = useMutation({
    mutationFn: () =>
      api.post<CheckoutResult>(
        '/cart/checkout',
        {
          shippingAddressId,
          ...(billingSameAsShipping || billingAddressId === null ? {} : { billingAddressId }),
          paymentMode,
          // Recorded on the order, so a reload of the payment page — or coming
          // back to it later — offers the same gateway rather than the default.
          ...(paymentMode === 'ONLINE' && gateway !== null
            ? { preferredPaymentProvider: gateway, preferredPaymentMethod: methodHint }
            : {}),
          customerNote: customerNote.trim() === '' ? null : customerNote.trim(),
        },
        { idempotencyKey },
      ),
    onSuccess: async (result) => {
      setSubmitError(null);

      // The cart is now an order; anything cached about it is stale.
      await queryClient.invalidateQueries({ queryKey: ['cart'] });
      await queryClient.invalidateQueries({ queryKey: ['orders'] });

      // Payment happens on its own page, which owns the provider handshake and
      // the wait for a verified result. Nothing about payment is decided here:
      // the gateway pick went to the server with the order, so the payment
      // page reads it back from there rather than being handed it — which is
      // what makes a reload of that page keep the customer's choice.
      if (result.paymentMode === 'ONLINE' && !result.requiresApproval) {
        void navigate(`/checkout/payment/${result.orderId}`, {
          replace: true,
          state: { replayed: result.replayed === true },
        });
        return;
      }

      void navigate(`/order-confirmation/${result.orderId}`, {
        replace: true,
        state: { replayed: result.replayed === true },
      });
    },
    onError: (error) => {
      if (error instanceof NetworkError) {
        // The order may or may not have been created. The same key is still
        // held, so retrying is safe and will not produce a second one —
        // which is exactly what the message promises.
        setSubmitError(
          `${error.message} If your order did go through, trying again will not create a second one.`,
        );
        return;
      }

      setSubmitError(
        error instanceof ApiError
          ? error.message
          : 'Your order could not be placed. Please try again.',
      );

      // A rejection usually means the cart changed underneath — re-read it so
      // the customer sees what the server is objecting to.
      void queryClient.invalidateQueries({ queryKey: ['cart'] });
    },
  });

  if (cart.isPending || addresses.isPending)
    return <LoadingState label={t('checkout.preparingYourCheckout')} />;

  if (cart.isError) {
    return (
      <ErrorState
        error={cart.error}
        onRetry={() => {
          void cart.refetch();
        }}
      />
    );
  }

  const currentCart = cart.data.cart;

  if (currentCart.lines.length === 0) {
    return (
      <PageEmptyState
        title={t('checkout.yourCartIsEmpty')}
        description={t('checkout.thereIsNothingToCheck')}
        action={
          <ButtonLink to="/products" variant="primary" size="lg">
            {t('checkout.browseProducts')}
          </ButtonLink>
        }
      />
    );
  }

  const canSubmit = currentCart.checkoutReady && shippingAddressId !== null && !submit.isPending;

  return (
    <>
      <CheckoutSteps states={checkoutSteps(shippingAddressId !== null)} />

      <header className="mb-6">
        <h1 className="text-title-xl text-ink">{t('checkout.checkout')}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-muted">
          {t('checkout.confirmWhereThisIsGoing')}
        </p>
      </header>

      <div className="grid gap-6 pb-4 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-6">
          {/* --- Delivery address ------------------------------------------ */}
          <Section id="address-heading" step={1} title={t('checkout.deliveryAddress')}>
            {usableAddresses.length === 0 && !isAddingAddress && (
              <div className="mt-4">
                <p className="text-sm text-ink-muted">{t('checkout.youHaveNoSavedAddresses')}</p>
                <Button
                  variant="primary"
                  className="mt-3"
                  onClick={() => {
                    setIsAddingAddress(true);
                  }}
                >
                  {t('checkout.addAnAddress')}
                </Button>
              </div>
            )}

            {usableAddresses.length > 0 && (
              <fieldset className="mt-4">
                <legend className="sr-only">{t('checkout.chooseADeliveryAddress')}</legend>
                <div className="space-y-2.5">
                  {usableAddresses.map((address) => (
                    <AddressCard
                      key={address.id}
                      address={address}
                      isSelected={address.id === shippingAddressId}
                      onSelect={() => {
                        setShippingAddressId(address.id);
                      }}
                    />
                  ))}
                </div>
              </fieldset>
            )}

            {isAddingAddress ? (
              <div className="mt-4 border-t border-border-subtle pt-4">
                <h3 className="mb-3 text-title-xs text-ink">{t('checkout.newAddress')}</h3>
                <AddressForm
                  onSaved={(addressId) => {
                    setShippingAddressId(addressId);
                    setIsAddingAddress(false);
                  }}
                  onCancel={() => {
                    setIsAddingAddress(false);
                  }}
                />
              </div>
            ) : (
              usableAddresses.length > 0 && (
                <Button
                  size="sm"
                  className="mt-3"
                  onClick={() => {
                    setIsAddingAddress(true);
                  }}
                >
                  {t('checkout.addADifferentAddress')}
                </Button>
              )
            )}

            {usableAddresses.length > 0 && (
              <div className="mt-4 border-t border-border-subtle pt-4">
                <label className="flex items-center gap-2.5 text-sm text-ink">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-border-strong text-brand"
                    checked={billingSameAsShipping}
                    onChange={(event) => {
                      setBillingSameAsShipping(event.target.checked);
                      if (event.target.checked) setBillingAddressId(null);
                    }}
                  />
                  {t('checkout.billToTheSameAddress')}
                </label>

                {!billingSameAsShipping && (
                  <fieldset className="mt-3">
                    <legend className="mb-2 text-title-xs text-ink">
                      {t('checkout.billingAddress')}
                    </legend>
                    <div className="space-y-2">
                      {usableAddresses.map((address) => (
                        <label
                          key={address.id}
                          className={choiceCardClass(address.id === billingAddressId, 'sm')}
                        >
                          <input
                            type="radio"
                            name="billingAddress"
                            className="mt-0.5 h-4 w-4 shrink-0 border-border-strong text-brand"
                            checked={address.id === billingAddressId}
                            onChange={() => {
                              setBillingAddressId(address.id);
                            }}
                          />
                          <span className="min-w-0 text-sm text-ink">
                            <span className="font-medium">{address.contactName}</span> —{' '}
                            <span className="text-ink-muted">
                              {address.line1}, {address.city}
                            </span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                )}
              </div>
            )}
          </Section>

          {/* --- How to pay ------------------------------------------------- */}
          <Section id="payment-heading" step={2} title={t('checkout.howWouldYouLikeTo')}>
            <fieldset className="mt-4">
              <legend className="sr-only">{t('checkout.paymentMethod')}</legend>

              <div className="space-y-2.5">
                <PaymentChoice
                  isSelected={paymentMode === 'ONLINE'}
                  onSelect={() => {
                    setPaymentMode('ONLINE');
                  }}
                  icon={<CardIcon className="h-5 w-5" />}
                  title={t('checkout.payNow')}
                >
                  {t('checkout.youWillBeTakenTo')}
                </PaymentChoice>

                {/*
                  The gateway, and what it should open on.

                  Nested under "Pay now" because that is the only mode it
                  applies to — a payment link is sent, not opened, and the
                  gateway behind it is the operator's business. Hidden entirely
                  when there is nothing to choose between: one connected
                  gateway with no named instrument is not a decision, and a
                  radio group of one only asks the customer to confirm
                  something they were never given a say in.
                */}
                {paymentMode === 'ONLINE' &&
                  (offeredGateways.length > 1 || extraMethods.length > 0) && (
                    <fieldset className="ml-4 border-l border-border pl-4 sm:ml-6 sm:pl-5">
                      <legend className="text-xs font-medium text-ink-muted">
                        {t('checkout.payWith')}
                      </legend>

                      <div className="mt-2.5 space-y-2">
                        {offeredGateways.map((entry) => (
                          <label
                            key={entry.provider}
                            className={choiceCardClass(gateway === entry.provider, 'sm')}
                          >
                            <input
                              type="radio"
                              name="paymentGateway"
                              className="mt-0.5 h-4 w-4 shrink-0 border-border-strong text-brand"
                              checked={gateway === entry.provider}
                              onChange={() => {
                                setGateway(entry.provider);
                                // The instrument belonged to the gateway being
                                // left behind. Carrying "UPI" onto Stripe would
                                // promise something Stripe cannot settle.
                                setMethodHint('ANY');
                              }}
                            />
                            <span className="min-w-0 pr-16 text-sm">
                              <span className="block text-title-xs text-ink">{entry.label}</span>
                              <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">
                                {entry.provider === 'RAZORPAY'
                                  ? t('checkout.cardsUpiAndMore')
                                  : t('checkout.cardsAndWallets')}
                              </span>
                            </span>
                            {gateway === entry.provider && <SelectedFlag />}
                          </label>
                        ))}
                      </div>

                      {/*
                        Instruments the chosen gateway can be opened on. Only
                        UPI is named today, and only Razorpay offers it — so
                        this appears exactly when Razorpay is the pick.
                      */}
                      {extraMethods.length > 0 && (
                        <div className="mt-3">
                          <span className="text-xs font-medium text-ink-muted">
                            {t('checkout.openCheckoutOn')}
                          </span>

                          <div className="mt-2 flex flex-wrap gap-2">
                            {(['ANY', ...extraMethods] as PaymentMethodHint[]).map((method) => (
                              <label
                                key={method}
                                className={cx(
                                  'flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-xs transition-colors',
                                  methodHint === method
                                    ? 'border-brand bg-brand-soft text-ink ring-1 ring-brand'
                                    : 'border-border bg-surface text-ink-muted hover:border-brand/50',
                                )}
                              >
                                <input
                                  type="radio"
                                  name="paymentMethodHint"
                                  className="h-3.5 w-3.5 border-border-strong text-brand"
                                  checked={methodHint === method}
                                  onChange={() => {
                                    setMethodHint(method);
                                  }}
                                />
                                {method === 'ANY' ? t('checkout.allMethods') : t('checkout.upi')}
                              </label>
                            ))}
                          </div>

                          {methodHint === 'UPI' && (
                            <p className="mt-2 text-xs leading-relaxed text-ink-muted">
                              {t('checkout.upiOpensOnTheUpiTab')}
                            </p>
                          )}
                        </div>
                      )}
                    </fieldset>
                  )}

                <PaymentChoice
                  isSelected={paymentMode === 'PAYMENT_LINK'}
                  onSelect={() => {
                    setPaymentMode('PAYMENT_LINK');
                  }}
                  icon={<LinkIcon className="h-5 w-5" />}
                  title={t('checkout.sendAPaymentLink')}
                >
                  {t('checkout.placeTheOrderNowAnd')}
                </PaymentChoice>
              </div>
            </fieldset>
          </Section>

          {/* --- Note ------------------------------------------------------- */}
          <Section id="note-heading" step={3} title={t('checkout.anythingWeShouldKnow')}>
            <div className="mt-4">
              <Field
                label={t('checkout.noteForThisOrder')}
                hint={t('checkout.optionalDeliveryInstructionsAPo')}
              >
                {({ inputId, describedBy }) => (
                  <Textarea
                    id={inputId}
                    rows={3}
                    value={customerNote}
                    maxLength={2000}
                    aria-describedby={describedBy}
                    onChange={(event) => {
                      setCustomerNote(event.target.value);
                    }}
                  />
                )}
              </Field>
            </div>
          </Section>

          <p className="text-sm">
            <Link to="/cart" className="font-medium text-brand hover:underline">
              ← Back to the cart
            </Link>
          </p>
        </div>

        {/* --- Review and place ---------------------------------------------- */}
        <aside aria-labelledby="review-heading" className="lg:sticky lg:top-28 lg:self-start">
          <div className="rounded-lg border border-border bg-surface p-5 shadow-card">
            <div className="flex items-baseline justify-between gap-3">
              <h2 id="review-heading" className="text-title-sm text-ink">
                {t('checkout.yourOrder')}
              </h2>
              <Link to="/cart" className="text-xs font-medium text-brand hover:underline">
                {t('checkout.edit')}
              </Link>
            </div>

            {/* Compact on purpose: this is a check, not the cart again. The
                list scrolls past four or five lines rather than pushing the
                total — the one thing being reviewed — below the fold. */}
            <ul className="mt-3 max-h-52 space-y-2 overflow-y-auto pr-1 text-sm">
              {currentCart.lines.map((line) => (
                <li key={line.itemId} className="flex justify-between gap-3">
                  <span className="min-w-0 text-ink-muted">
                    <span className="block truncate text-ink">{line.name}</span>
                    <span className="text-xs">× {formatNumber(line.quantity)}</span>
                  </span>
                  <span className="shrink-0 tabular text-ink">{formatMoney(line.lineTotal)}</span>
                </li>
              ))}
            </ul>

            <dl className="mt-4 space-y-2.5 border-t border-border-subtle pt-4 text-sm">
              <TotalRow
                label={t('checkout.subtotal')}
                value={formatMoney(currentCart.totals.subtotal)}
              />
              {currentCart.totals.discount.minor !== '0' && (
                <TotalRow
                  label={t('checkout.discount')}
                  tone="credit"
                  value={<>−{formatMoney(currentCart.totals.discount)}</>}
                />
              )}
              <TotalRow label={t('checkout.tax')} value={formatMoney(currentCart.totals.tax)} />
              <TotalRow
                label={t('checkout.delivery')}
                value={formatMoney(currentCart.totals.shipping)}
              />
              {/* Matches the cart's summary: the same figure gets the same
                  treatment in both places, or the total looks like it changed
                  on the way here. */}
              <GrandTotalRow
                label={t('checkout.total')}
                value={formatMoney(currentCart.totals.grandTotal)}
              />
            </dl>

            {currentCart.requiresApproval && (
              <div
                role="status"
                className="mt-4 rounded-md border border-warning/30 bg-warning-soft px-3 py-2.5 text-xs text-ink"
              >
                <p className="font-medium text-warning">{t('checkout.thisOrderNeedsApproval')}</p>
                <p className="mt-0.5">
                  {currentCart.approvalReason ??
                    'It goes to your approver before it is confirmed. You will be told when it is.'}
                </p>
              </div>
            )}

            {currentCart.blockingIssues.length > 0 && (
              <div
                role="alert"
                className="mt-4 rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-xs"
              >
                <p className="font-medium text-danger">{t('checkout.fixTheseBeforePlacingThe')}</p>
                <ul className="mt-1 list-inside list-disc space-y-1 text-ink">
                  {currentCart.blockingIssues.map((issue) => (
                    <li key={`${issue.code}:${issue.message}`}>{issue.message}</li>
                  ))}
                </ul>
                <Link
                  to="/cart"
                  className="mt-2 inline-block font-semibold text-ink underline underline-offset-2"
                >
                  {t('checkout.backToTheCart')}
                </Link>
              </div>
            )}

            {submitError !== null && (
              <div
                role="alert"
                className="mt-4 flex gap-2.5 rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger"
              >
                <AlertIcon className="mt-px h-4 w-4 shrink-0" />
                <span>{submitError}</span>
              </div>
            )}

            <Button
              variant="action"
              size="lg"
              fullWidth
              className="mt-5"
              disabled={!canSubmit}
              isLoading={submit.isPending}
              onClick={() => {
                submit.mutate();
              }}
            >
              {paymentMode === 'ONLINE' ? 'Place order and pay' : 'Place order'}
            </Button>

            {shippingAddressId === null && (
              <p className="mt-2 text-center text-xs text-ink-muted">
                {t('checkout.chooseADeliveryAddressTo')}
              </p>
            )}

            {/*
             * Reassurance, limited to what this flow actually does.
             *
             * Two claims, both verifiable in the code above: nothing is
             * charged by this button, and the payment itself is handled by the
             * provider's own page. No trust badges, no "100% secure", no
             * guarantee this software cannot keep.
             */}
            <div className="mt-4 flex gap-2.5 border-t border-border-subtle pt-4 text-xxs leading-relaxed text-ink-subtle">
              <ShieldIcon className="mt-px h-4 w-4 shrink-0 text-ink-muted" />
              <p>
                Placing this order does not charge you yet. Payment is taken on the next step, on
                our payment provider&rsquo;s own secure page, and is only confirmed once they verify
                it.
              </p>
            </div>
          </div>
        </aside>
      </div>
    </>
  );
}

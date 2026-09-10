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
import { AlertIcon, CardIcon, LinkIcon, ShieldIcon, UpiIcon } from '@/components/icons';
import { SavedCardChoice, SelectedFlag } from '@/components/SavedCardList';
import { choiceCardClass } from '@/lib/cards';
import { Button, ButtonLink, ErrorState, Field, LoadingState, Textarea } from '@/components/ui';
import { NetworkError, api, newIdempotencyKey } from '@/lib/api';
import { cx } from '@/lib/cx';
import { formatMoney, formatNumber } from '@/lib/format';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import type {
  Address,
  Cart,
  CheckoutResult,
  PaymentInstrument,
  PaymentInstruments,
  SavedCard,
} from '@/lib/types';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';

type PaymentMode = 'ONLINE' | 'PAYMENT_LINK';

/**
 * The words for each instrument, and the line under each one.
 *
 * A table rather than a switch so the three read together: whether they are
 * parallel, whether any of them promises something the others do not. They are
 * the only names a customer ever sees for how they are paying - no gateway is
 * mentioned on this page at all.
 */
const INSTRUMENT_COPY: Record<
  PaymentInstrument,
  { title: TranslationKey; body: TranslationKey }
> = {
  CREDIT_CARD: { title: 'checkout.payWithCreditCard', body: 'checkout.creditCardHint' },
  DEBIT_CARD: { title: 'checkout.payWithDebitCard', body: 'checkout.debitCardHint' },
  UPI: { title: 'checkout.payWithUpi', body: 'checkout.upiHint' },
};

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
          isSelected ? 'bg-brand-fill text-white' : 'bg-surface-sunken text-ink-muted',
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
  const { business, features } = useStorefront();

  const [shippingAddressId, setShippingAddressId] = useState<string | null>(null);
  const [billingSameAsShipping, setBillingSameAsShipping] = useState(true);
  const [billingAddressId, setBillingAddressId] = useState<string | null>(null);
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('ONLINE');
  /**
   * What the customer is paying with, or null while the offer is still
   * loading and there is nothing honest to preselect.
   */
  const [instrument, setInstrument] = useState<PaymentInstrument | null>(null);
  /**
   * One of their own cards, or null for a card they have not entered yet.
   *
   * Held per instrument implicitly: changing the instrument clears it, because
   * a card filed under Debit is not an answer to "Pay with Credit Card".
   */
  const [savedCardId, setSavedCardId] = useState<string | null>(null);
  const [customerNote, setCustomerNote] = useState('');
  const [isAddingAddress, setIsAddingAddress] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useDocumentMeta({ title: t('checkout.checkout'), noIndex: true }, business.displayName);

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

  const cartCurrency = cart.data?.cart.currency ?? null;

  /**
   * How this cart may be paid for.
   *
   * Keyed on the currency and asked once the cart is known, because a gateway
   * that cannot settle this cart's money must not contribute an option to it.
   * The answer names instruments only - which gateway serves each is decided
   * on the server and never reaches this page.
   */
  const instruments = useQuery({
    queryKey: ['payment-instruments', cartCurrency],
    queryFn: () =>
      api.get<PaymentInstruments>(
        `/payments/instruments?currency=${encodeURIComponent(cartCurrency ?? '')}`,
      ),
    enabled: cartCurrency !== null,
  });

  /**
   * Cards this customer has already stored.
   *
   * Not fatal if it fails, and deliberately not blocking: somebody who has
   * never saved a card must not be held at a spinner for a list that will be
   * empty, and somebody whose list cannot be loaded can still pay by typing
   * their card as they always could.
   */
  const savedCards = useQuery({
    queryKey: ['payment-methods'],
    queryFn: () =>
      api
        .get<{ paymentMethods: SavedCard[] }>('/account/payment-methods')
        .then((response) => response.paymentMethods),
    retry: false,
  });

  const usableAddresses = useMemo(
    () => (addresses.data?.addresses ?? []).filter((address) => address.archivedAt === null),
    [addresses.data],
  );

  const offeredInstruments = useMemo(
    () => instruments.data?.instruments ?? [],
    [instruments.data],
  );

  /**
   * Settle on an instrument once the offer is known, and re-settle if what is
   * on offer later changes under the customer.
   *
   * The first offered is chosen, which is Credit Card wherever cards can be
   * taken at all. There is no server-side "default instrument" to honour and
   * there should not be: which gateway an operator prefers says nothing about
   * how a particular customer wants to pay.
   */
  useEffect(() => {
    if (offeredInstruments.length === 0) return;
    if (instrument !== null && offeredInstruments.some((o) => o.instrument === instrument)) return;

    setInstrument(offeredInstruments[0]?.instrument ?? null);
    setSavedCardId(null);
  }, [offeredInstruments, instrument]);

  /** What the chosen instrument allows. Undefined only while it is loading. */
  const chosenOffer = useMemo(
    () => offeredInstruments.find((offer) => offer.instrument === instrument) ?? null,
    [offeredInstruments, instrument],
  );

  /**
   * The customer's stored cards that suit the instrument they picked.
   *
   * A card of unknown funding - prepaid, or one the gateway would not describe
   * - carries `instrument: null` and appears under both card headings. That is
   * deliberate: it is a perfectly usable card, and filing it wrongly under one
   * heading would be worse than showing it under both.
   */
  const cardsForInstrument = useMemo(() => {
    if (instrument === null || instrument === 'UPI') return [];

    return (savedCards.data ?? []).filter(
      (card) =>
        card.status === 'ACTIVE' &&
        (card.instrument === null || card.instrument === instrument),
    );
  }, [savedCards.data, instrument]);

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
          // back to it from an email hours later — offers what the customer
          // chose rather than starting the decision again. No gateway is sent:
          // the server resolves one from the instrument, which is the only
          // half of it this page ever knew about.
          ...(paymentMode === 'ONLINE' && instrument !== null
            ? { preferredPaymentInstrument: instrument }
            : {}),
          ...(paymentMode === 'ONLINE' && savedCardId !== null
            ? { preferredPaymentMethodId: savedCardId }
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
          t('checkout.ifYourOrderDidGoThrough', { message: errorMessage(t, error) }),
        );
        return;
      }

      setSubmitError(
        errorMessage(t, error, t('checkout.orderCouldNotBePlaced')),
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

  /**
   * How many of these lines the schedule builder would accept.
   *
   * The same flag the cart's badge and panel read, counted here so the
   * schedule offer beside Place Order never leads to `/schedules/new` and its
   * empty state. The server decides eligibility; this only counts.
   */
  const recurringEligibleCount = currentCart.lines.filter((line) => line.isRecurringEligible).length;

  return (
    <>
      <CheckoutSteps states={checkoutSteps(shippingAddressId !== null)} />

      <header className="mb-6">
        <h1 className="text-title-xl text-ink">{t('checkout.checkout')}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-muted">
          {t('checkout.confirmWhereThisIsGoing')}
        </p>
      </header>

      <div className="grid grid-cols-1 gap-6 pb-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
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
                  What the customer is actually paying with.

                  Nested under "Pay now" because that is the only mode it
                  applies to — a payment link is sent, not opened.

                  This used to be a choice between "Razorpay" and "Stripe",
                  which is the operator's plumbing on the customer's screen.
                  Nobody buying consumables knows which acquirer they would
                  rather settle through, and asking put a decision in front of
                  them that they had no basis for making. Now the question is
                  the one they can answer — which instrument? — and the gateway
                  is resolved from the answer on the server.

                  Always shown, even with one option. Unlike a gateway list,
                  where a group of one asked the customer to confirm something
                  they were never given a say in, "Credit card or debit card?"
                  is a real question with a real consequence: it decides which
                  of their saved cards they are offered.
                */}
                {paymentMode === 'ONLINE' && (
                  <fieldset className="ml-4 border-l border-border pl-4 sm:ml-6 sm:pl-5">
                    <legend className="text-xs font-medium text-ink-muted">
                      {t('checkout.payWith')}
                    </legend>

                    {instruments.isPending ? (
                      <p className="mt-2.5 text-xs text-ink-muted">
                        {t('checkout.loadingWaysToPay')}
                      </p>
                    ) : offeredInstruments.length === 0 ? (
                      /*
                        Nothing connected, or nothing that settles this cart's
                        currency. Said plainly rather than shown as an empty
                        radio group: the customer can still place the order and
                        pay by link, and that is the useful thing to tell them.
                      */
                      <p
                        role="status"
                        className="mt-2.5 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-ink"
                      >
                        {t('checkout.noWayToPayOnline')}
                      </p>
                    ) : (
                      <div className="mt-2.5 space-y-2">
                        {offeredInstruments.map((offer) => {
                          const copy = INSTRUMENT_COPY[offer.instrument];
                          const isSelected = instrument === offer.instrument;

                          return (
                            <div key={offer.instrument}>
                              <label className={choiceCardClass(isSelected, 'sm')}>
                                <input
                                  type="radio"
                                  name="paymentInstrument"
                                  className="mt-0.5 h-4 w-4 shrink-0 border-border-strong text-brand"
                                  checked={isSelected}
                                  onChange={() => {
                                    setInstrument(offer.instrument);
                                    // The card belonged to the instrument being
                                    // left behind. Carrying a debit card onto
                                    // "Pay with Credit Card" would offer
                                    // something the server then refuses.
                                    setSavedCardId(null);
                                  }}
                                />
                                <span
                                  aria-hidden="true"
                                  className={cx(
                                    'flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
                                    isSelected
                                      ? 'bg-brand-fill text-white'
                                      : 'bg-surface-sunken text-ink-muted',
                                  )}
                                >
                                  {offer.instrument === 'UPI' ? (
                                    <UpiIcon className="h-4 w-4" />
                                  ) : (
                                    <CardIcon className="h-4 w-4" />
                                  )}
                                </span>
                                <span className="min-w-0 pr-16 text-sm">
                                  <span className="block text-title-xs text-ink">
                                    {t(copy.title)}
                                  </span>
                                  <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">
                                    {t(copy.body)}
                                  </span>
                                </span>
                                {isSelected && <SelectedFlag />}
                              </label>

                              {/*
                                The customer's own cards, under the instrument
                                they belong to.

                                Only under the selected one — a list of cards
                                under an option nobody has chosen is noise, and
                                it would make the three options look unequal.
                                Absent entirely for somebody who has never
                                saved a card, which is everybody's first order.
                              */}
                              {isSelected && cardsForInstrument.length > 0 && (
                                <div className="ml-7 mt-2 space-y-2 border-l border-border-subtle pl-3">
                                  {cardsForInstrument.map((card) => (
                                    <SavedCardChoice
                                      key={card.id}
                                      card={card}
                                      name="savedCard"
                                      isSelected={savedCardId === card.id}
                                      onSelect={() => {
                                        setSavedCardId(card.id);
                                      }}
                                    />
                                  ))}

                                  {/*
                                    Not a card, and deliberately styled as one
                                    of the choices rather than as a button: it
                                    is the same decision as picking a saved
                                    card, and it is what a customer who does
                                    not recognise any of the cards listed needs
                                    to find without hunting.
                                  */}
                                  <label className={choiceCardClass(savedCardId === null, 'sm')}>
                                    <input
                                      type="radio"
                                      name="savedCard"
                                      className="mt-0.5 h-4 w-4 shrink-0 border-border-strong text-brand"
                                      checked={savedCardId === null}
                                      onChange={() => {
                                        setSavedCardId(null);
                                      }}
                                    />
                                    <span className="min-w-0 pr-16 text-sm">
                                      <span className="block font-medium text-ink">
                                        {t('checkout.useANewCard')}
                                      </span>
                                      <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">
                                        {chosenOffer?.canSaveCard === true
                                          ? t('checkout.useANewCardHintSavable')
                                          : t('checkout.useANewCardHint')}
                                      </span>
                                    </span>
                                    {savedCardId === null && <SelectedFlag />}
                                  </label>
                                </div>
                              )}
                            </div>
                          );
                        })}
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
                    t('checkout.itGoesToYourApprover')}
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
              {paymentMode === 'ONLINE' ? t('checkout.placeOrderAndPay') : t('checkout.placeOrder')}
            </Button>

            {shippingAddressId === null && (
              <p className="mt-2 text-center text-xs text-ink-muted">
                {t('checkout.chooseADeliveryAddressTo')}
              </p>
            )}

            {/*
             * The other thing that can be done with this basket, offered where
             * the decision is actually made.
             *
             * A customer buying the same consumables every month is standing
             * at this button when the thought "I will be doing this again in
             * four weeks" occurs to them. Until now the only place to act on
             * it was the cart page they have already left, so the repeat was
             * set up on the *next* order or not at all.
             *
             * Deliberately not a second orange button and deliberately below
             * the first. Place Order is what this page is for; this is an
             * alternative to it, and two equally loud calls to action is how a
             * customer ends up on a subscription they meant to buy once.
             *
             * Shown only when the store offers repeat purchases AND this
             * basket has something that can go on one, so it never leads to
             * the builder's empty state.
             */}
            {features.recurringOrders && recurringEligibleCount > 0 && (
              <div className="mt-3 border-t border-border-subtle pt-3">
                <ButtonLink to="/schedules/new" fullWidth>
                  {t('checkout.scheduleThisInstead')}
                </ButtonLink>
                <p className="mt-1.5 text-center text-xxs leading-relaxed text-ink-subtle">
                  {t('checkout.scheduleThisInsteadHint')}
                </p>
              </div>
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
              <p>{t('checkout.placingThisOrderDoesNot')}</p>
            </div>
          </div>
        </aside>
      </div>
    </>
  );
}

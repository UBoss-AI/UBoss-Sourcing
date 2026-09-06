/**
 * Set up a repeat purchase.
 *
 * Two ways in, and they differ in what can honestly be shown:
 *
 *   - **From the cart** (`/schedules/new`): the whole cart becomes the
 *     schedule, and the cart's own server-calculated totals are the estimate.
 *     Authoritative, because the server produced them.
 *   - **From a product** (`?productId=…&quantity=…`): one item. The unit price
 *     is shown as the server states it, and the total is not — multiplying
 *     here would be a second pricing engine, and it would eventually disagree
 *     with the one that actually charges.
 *
 * Either way the estimate is labelled as an estimate, because it is: every
 * occurrence is repriced against the catalogue, tax, stock and the customer's
 * limits at the moment it runs. A schedule created today at one price does not
 * lock that price in, and saying so up front is the difference between a
 * pleasant surprise and a dispute.
 *
 * Consent is explicit and required — the server refuses without it, and this
 * form does not pre-tick it.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useStorefront } from '@/app/storefront-context';
import { AddressForm } from '@/components/AddressForm';
import { QuantityInput } from '@/components/QuantityInput';
import {
  Badge,
  Button,
  ButtonLink,
  ErrorState,
  Field,
  Input,
  LoadingState,
  Select,
} from '@/components/ui';
import { PageEmptyState } from '@/components/PageEmptyState';
import { ApiError, NetworkError, api } from '@/lib/api';
import { formatMoney, formatNumber } from '@/lib/format';
import { clampToRules } from '@/lib/quantity-rules';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import type { AccountResponse, Address, Cart, Product, ScheduleCreated } from '@/lib/types';
import { useI18n } from '@/i18n/i18n-context';

type Frequency = 'EVERY_N_DAYS' | 'WEEKLY' | 'MONTHLY';
type PaymentMode = 'AUTO_PAY' | 'PAYMENT_LINK';

const WEEKDAYS = [
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
  { value: 7, label: 'Sunday' },
] as const;

/** Times of day offered, as minutes past midnight in the schedule's zone. */
const RUN_TIMES = [
  { value: 360, label: '06:00' },
  { value: 480, label: '08:00' },
  { value: 600, label: '10:00' },
  { value: 840, label: '14:00' },
  { value: 1080, label: '18:00' },
] as const;

/** Today in the schedule's timezone, as YYYY-MM-DD. */
function todayIn(timezone: string): string {
  // `en-CA` formats as YYYY-MM-DD, which is what the API expects — and doing
  // it through Intl means "today" is the customer's today, not the server's.
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
}

interface ScheduleItemDraft {
  productId: string;
  variantId: string | null;
  quantity: number;
  name: string;
  sku: string;
  unitPrice: { minor: string; formatted: string; currency: string } | null;
  minOrderQty: number;
  maxOrderQty: number | null;
  qtyIncrement: number;
}

export function ScheduleBuilderPage(): React.JSX.Element {
  const { t } = useI18n();

  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { business, features } = useStorefront();

  const productId = searchParams.get('productId');
  const variantId = searchParams.get('variantId');
  const requestedQuantity = Number(searchParams.get('quantity') ?? '0');

  const fromCart = productId === null;

  useDocumentMeta({ title: 'Set up a repeat purchase', noIndex: true }, business.displayName);

  // --- Sources -------------------------------------------------------------

  const cart = useQuery({
    queryKey: ['cart'],
    queryFn: () => api.get<{ cart: Cart }>('/cart'),
    enabled: fromCart,
  });

  const product = useQuery({
    queryKey: ['product-by-id', productId],
    queryFn: async () => {
      // The public detail route is keyed by slug, so the id is resolved
      // through a search rather than guessing a slug.
      const found = await api.get<{ products: Product[] }>('/catalog/products', {
        query: { limit: 60 },
      });

      const match = found.products.find((candidate) => candidate.id === productId);

      if (match === undefined) {
        throw new ApiError(404, {
          code: 'NOT_FOUND',
          message: 'That product is no longer available for repeat purchase.',
        });
      }

      return match;
    },
    enabled: !fromCart,
    retry: false,
  });

  const addresses = useQuery({
    queryKey: ['addresses'],
    queryFn: () => api.get<{ addresses: Address[] }>('/account/addresses'),
  });

  // Only needed to prefill the payer address, which the server requires for a
  // payment-link schedule.
  const account = useQuery({
    queryKey: ['account-profile'],
    queryFn: () => api.get<AccountResponse>('/account/profile'),
  });

  // --- Form state -----------------------------------------------------------

  const [name, setName] = useState('');
  const [frequency, setFrequency] = useState<Frequency>('EVERY_N_DAYS');
  const [intervalDays, setIntervalDays] = useState(7);
  const [weekday, setWeekday] = useState(1);
  const [monthDay, setMonthDay] = useState(1);
  const [runAtMinute, setRunAtMinute] = useState(360);
  const [startDate, setStartDate] = useState(() => todayIn(business.timezone));
  const [endMode, setEndMode] = useState<'never' | 'date' | 'count'>('never');
  const [endDate, setEndDate] = useState('');
  const [maxOccurrences, setMaxOccurrences] = useState(12);
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('PAYMENT_LINK');
  const [payerEmail, setPayerEmail] = useState('');
  const [shippingAddressId, setShippingAddressId] = useState<string | null>(null);
  const [items, setItems] = useState<ScheduleItemDraft[]>([]);
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [isAddingAddress, setIsAddingAddress] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const usableAddresses = useMemo(
    () => (addresses.data?.addresses ?? []).filter((address) => address.archivedAt === null),
    [addresses.data],
  );

  // The customer's own address, unless they have already typed another.
  useEffect(() => {
    const email = account.data?.profile.email;
    if (email === undefined) return;
    setPayerEmail((current) => (current === '' ? email : current));
  }, [account.data]);

  useEffect(() => {
    if (shippingAddressId !== null || usableAddresses.length === 0) return;
    const preferred =
      usableAddresses.find((address) => address.isDefaultShipping) ?? usableAddresses[0];
    setShippingAddressId(preferred?.id ?? null);
  }, [usableAddresses, shippingAddressId]);

  // Fill the draft from whichever source the customer arrived through.
  useEffect(() => {
    if (fromCart) {
      const lines = cart.data?.cart.lines ?? [];

      // Only eligible lines can go on a schedule; the rest stay in the cart.
      setItems(
        lines
          .filter((line) => line.isRecurringEligible)
          .map((line) => ({
            productId: line.productId,
            variantId: line.variantId,
            quantity: line.quantity,
            name: line.name,
            sku: line.sku,
            unitPrice: line.unitPrice,
            minOrderQty: line.purchaseRules.minOrderQty,
            maxOrderQty: line.purchaseRules.maxOrderQty,
            qtyIncrement: line.purchaseRules.qtyIncrement,
          })),
      );

      // Only names an untouched field, so it cannot overwrite what the
      // customer typed — and the functional form keeps `name` out of the
      // dependency list, so this does not re-run on every keystroke.
      if (lines.length > 0) {
        const suggested = lines.length === 1 ? `Repeat: ${lines[0]?.name ?? ''}` : 'Repeat order';
        setName((current) => (current === '' ? suggested : current));
      }
      return;
    }

    const found = product.data;
    if (found === undefined) return;

    const rules = found.purchaseRules;
    const quantity = clampToRules(
      requestedQuantity > 0 ? requestedQuantity : rules.minOrderQty,
      rules,
    );

    const variant = found.variants.find((candidate) => candidate.id === variantId);

    setItems([
      {
        productId: found.id,
        variantId,
        quantity,
        name: found.name,
        sku: variant?.sku ?? found.sku,
        unitPrice: variant?.price ?? found.price,
        minOrderQty: rules.minOrderQty,
        maxOrderQty: rules.maxOrderQty,
        qtyIncrement: rules.qtyIncrement,
      },
    ]);

    setName((current) => (current === '' ? `Repeat: ${found.name}` : current));
  }, [fromCart, cart.data, product.data, requestedQuantity, variantId]);

  const create = useMutation({
    mutationFn: () =>
      api.post<ScheduleCreated>('/recurring-schedules', {
        name: name.trim(),
        frequency,
        ...(frequency === 'EVERY_N_DAYS' ? { intervalDays } : {}),
        ...(frequency === 'WEEKLY' ? { weekday } : {}),
        ...(frequency === 'MONTHLY' ? { monthDay } : {}),
        timezone: business.timezone,
        runAtMinute,
        startDate,
        ...(endMode === 'date' && endDate !== '' ? { endDate } : {}),
        ...(endMode === 'count' ? { maxOccurrences } : {}),
        paymentMode,
        // Required by the server for PAYMENT_LINK: somebody has to receive the
        // link, and guessing would send money requests to the wrong inbox.
        ...(paymentMode === 'PAYMENT_LINK' ? { payerEmail: payerEmail.trim() } : {}),
        shippingAddressId,
        items: items.map((item) => ({
          productId: item.productId,
          variantId: item.variantId,
          quantity: item.quantity,
        })),
        consentAccepted,
      }),
    onSuccess: (result) => {
      // Straight to the schedule itself, where the full record is read back
      // from the server rather than assembled from what was just submitted.
      void navigate(`/account/schedules/${result.scheduleId}`, {
        replace: true,
      });
    },
    onError: (error) => {
      if (error instanceof NetworkError) {
        setSubmitError(error.message);
        return;
      }

      setSubmitError(
        error instanceof ApiError
          ? error.message
          : 'The repeat purchase could not be set up. Please try again.',
      );
    },
  });

  // --- Guard rails ----------------------------------------------------------

  if (!features.recurringOrders) {
    return (
      <PageEmptyState
        title={t('scheduleBuilder.repeatPurchasesAreNotAvailable')}
        description={t('scheduleBuilder.thisOptionIsSwitchedOff')}
        action={
          <ButtonLink to="/products" variant="primary" size="lg">
            {t('scheduleBuilder.browseProducts')}
          </ButtonLink>
        }
      />
    );
  }

  if ((fromCart && cart.isPending) || (!fromCart && product.isPending) || addresses.isPending) {
    return <LoadingState label={t('scheduleBuilder.preparingYourRepeatPurchase')} />;
  }

  if (!fromCart && product.isError) {
    return (
      <ErrorState
        error={product.error}
        onRetry={() => {
          void product.refetch();
        }}
      />
    );
  }

  if (items.length === 0) {
    return (
      <PageEmptyState
        title={t('scheduleBuilder.nothingToRepeatYet')}
        description={
          fromCart
            ? 'None of the items in your cart can be set up as a repeat purchase. Look for the “Repeat purchase” label on a product.'
            : 'This product cannot be set up as a repeat purchase.'
        }
        action={
          <ButtonLink to="/products" variant="primary" size="lg">
            {t('scheduleBuilder.browseProducts')}
          </ButtonLink>
        }
      />
    );
  }

  const cartTotals = fromCart ? cart.data?.cart.totals : undefined;

  const payerEmailValid =
    paymentMode !== 'PAYMENT_LINK' || /^\S+@\S+\.\S+$/.test(payerEmail.trim());

  const canSubmit =
    name.trim() !== '' &&
    shippingAddressId !== null &&
    items.length > 0 &&
    payerEmailValid &&
    consentAccepted &&
    !create.isPending;

  /** A plain-language description of what was chosen, for the summary. */
  const cadence =
    frequency === 'EVERY_N_DAYS'
      ? `Every ${formatNumber(intervalDays)} day${intervalDays === 1 ? '' : 's'}`
      : frequency === 'WEEKLY'
        ? `Every ${WEEKDAYS.find((day) => day.value === weekday)?.label ?? 'week'}`
        : `On day ${formatNumber(monthDay)} of each month`;

  const timeLabel = RUN_TIMES.find((time) => time.value === runAtMinute)?.label ?? '06:00';

  return (
    <>
      <header className="mb-6">
        <h1 className="text-title-xl text-ink">{t('scheduleBuilder.setUpARepeatPurchase')}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-muted">
          {t('scheduleBuilder.weWillPlaceTheOrder')}
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-6">
          {/* --- What ------------------------------------------------------- */}
          <section
            aria-labelledby="items-heading"
            className="rounded-lg border border-border bg-surface p-5 shadow-card"
          >
            <h2 id="items-heading" className="text-title-sm text-ink">
              {t('scheduleBuilder.whatToSend')}
            </h2>

            <ul className="mt-3 divide-y divide-border">
              {items.map((item, index) => (
                <li key={`${item.productId}:${item.variantId ?? ''}`} className="py-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-ink">{item.name}</p>
                      <p className="font-mono text-xxs text-ink-subtle">{item.sku}</p>
                    </div>
                    {item.unitPrice !== null && (
                      <p className="text-sm tabular text-ink">
                        {formatMoney(item.unitPrice)}
                        <span className="text-xs text-ink-muted"> each</span>
                      </p>
                    )}
                  </div>

                  <div className="mt-2">
                    <QuantityInput
                      value={item.quantity}
                      label={t('scheduleBuilder.quantityPerDelivery')}
                      rules={{
                        minOrderQty: item.minOrderQty,
                        maxOrderQty: item.maxOrderQty,
                        qtyIncrement: item.qtyIncrement,
                        isRecurringEligible: true,
                      }}
                      onChange={(quantity) => {
                        setItems((current) =>
                          current.map((candidate, position) =>
                            position === index ? { ...candidate, quantity } : candidate,
                          ),
                        );
                      }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </section>

          {/* --- How often --------------------------------------------------- */}
          <section
            aria-labelledby="cadence-heading"
            className="rounded-lg border border-border bg-surface p-5 shadow-card"
          >
            <h2 id="cadence-heading" className="text-title-sm text-ink">
              {t('scheduleBuilder.howOften')}
            </h2>

            <div className="mt-3 space-y-4">
              <Field label={t('scheduleBuilder.repeat')}>
                {({ inputId }) => (
                  <Select
                    id={inputId}
                    value={frequency}
                    onChange={(event) => {
                      setFrequency(event.target.value as Frequency);
                    }}
                  >
                    <option value="EVERY_N_DAYS">{t('scheduleBuilder.everySoManyDays')}</option>
                    <option value="WEEKLY">{t('scheduleBuilder.weeklyOnAChosenDay')}</option>
                    <option value="MONTHLY">{t('scheduleBuilder.monthlyOnAChosenDate')}</option>
                  </Select>
                )}
              </Field>

              {frequency === 'EVERY_N_DAYS' && (
                <Field
                  label={t('scheduleBuilder.numberOfDaysBetweenDeliveries')}
                  hint={t('scheduleBuilder.7GivesYouAWeekly')}
                >
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      type="number"
                      min={1}
                      max={365}
                      className="tabular sm:w-32"
                      value={intervalDays}
                      aria-describedby={describedBy}
                      onChange={(event) => {
                        const parsed = Number(event.target.value);
                        if (Number.isFinite(parsed)) setIntervalDays(parsed);
                      }}
                      onBlur={() => {
                        setIntervalDays((current) => Math.min(365, Math.max(1, current)));
                      }}
                    />
                  )}
                </Field>
              )}

              {frequency === 'WEEKLY' && (
                <Field label={t('scheduleBuilder.dayOfTheWeek')}>
                  {({ inputId }) => (
                    <Select
                      id={inputId}
                      value={weekday}
                      onChange={(event) => {
                        setWeekday(Number(event.target.value));
                      }}
                    >
                      {WEEKDAYS.map((day) => (
                        <option key={day.value} value={day.value}>
                          {day.label}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              )}

              {frequency === 'MONTHLY' && (
                <Field
                  label={t('scheduleBuilder.dayOfTheMonth')}
                  hint={t('scheduleBuilder.aMonthShorterThanThe')}
                >
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      type="number"
                      min={1}
                      max={31}
                      className="tabular sm:w-32"
                      value={monthDay}
                      aria-describedby={describedBy}
                      onChange={(event) => {
                        const parsed = Number(event.target.value);
                        if (Number.isFinite(parsed)) setMonthDay(parsed);
                      }}
                      onBlur={() => {
                        setMonthDay((current) => Math.min(31, Math.max(1, current)));
                      }}
                    />
                  )}
                </Field>
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label={t('scheduleBuilder.timeOfDay')}
                  hint={`Your local time (${business.timezone}).`}
                >
                  {({ inputId, describedBy }) => (
                    <Select
                      id={inputId}
                      value={runAtMinute}
                      aria-describedby={describedBy}
                      onChange={(event) => {
                        setRunAtMinute(Number(event.target.value));
                      }}
                    >
                      {RUN_TIMES.map((time) => (
                        <option key={time.value} value={time.value}>
                          {time.label}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>

                <Field label={t('scheduleBuilder.firstDeliveryOn')}>
                  {({ inputId }) => (
                    <Input
                      id={inputId}
                      type="date"
                      value={startDate}
                      min={todayIn(business.timezone)}
                      onChange={(event) => {
                        setStartDate(event.target.value);
                      }}
                    />
                  )}
                </Field>
              </div>

              <fieldset>
                <legend className="text-sm font-medium text-ink">
                  {t('scheduleBuilder.whenShouldItStop')}
                </legend>

                <div className="mt-2 space-y-2">
                  <label className="flex items-center gap-2 text-sm text-ink">
                    <input
                      type="radio"
                      name="endMode"
                      className="h-4 w-4 border-border-strong text-brand"
                      checked={endMode === 'never'}
                      onChange={() => {
                        setEndMode('never');
                      }}
                    />
                    {t('scheduleBuilder.keepGoingUntilICancel')}
                  </label>

                  <label className="flex flex-wrap items-center gap-2 text-sm text-ink">
                    <input
                      type="radio"
                      name="endMode"
                      className="h-4 w-4 border-border-strong text-brand"
                      checked={endMode === 'date'}
                      onChange={() => {
                        setEndMode('date');
                      }}
                    />
                    {t('scheduleBuilder.stopAfter')}
                    <Input
                      type="date"
                      className="w-44"
                      value={endDate}
                      min={startDate}
                      aria-label={t('scheduleBuilder.stopAfterThisDate')}
                      disabled={endMode !== 'date'}
                      onChange={(event) => {
                        setEndDate(event.target.value);
                      }}
                    />
                  </label>

                  <label className="flex flex-wrap items-center gap-2 text-sm text-ink">
                    <input
                      type="radio"
                      name="endMode"
                      className="h-4 w-4 border-border-strong text-brand"
                      checked={endMode === 'count'}
                      onChange={() => {
                        setEndMode('count');
                      }}
                    />
                    {t('scheduleBuilder.stopAfter')}
                    <Input
                      type="number"
                      min={1}
                      max={10000}
                      className="w-24 tabular"
                      value={maxOccurrences}
                      aria-label={t('scheduleBuilder.numberOfDeliveries')}
                      disabled={endMode !== 'count'}
                      onChange={(event) => {
                        const parsed = Number(event.target.value);
                        if (Number.isFinite(parsed)) setMaxOccurrences(parsed);
                      }}
                    />
                    deliveries
                  </label>
                </div>
              </fieldset>
            </div>
          </section>

          {/* --- Where -------------------------------------------------------- */}
          <section
            aria-labelledby="delivery-heading"
            className="rounded-lg border border-border bg-surface p-5 shadow-card"
          >
            <h2 id="delivery-heading" className="text-title-sm text-ink">
              {t('scheduleBuilder.whereToDeliver')}
            </h2>

            {usableAddresses.length > 0 && (
              <fieldset className="mt-3">
                <legend className="sr-only">{t('scheduleBuilder.chooseADeliveryAddress')}</legend>
                <div className="space-y-2">
                  {usableAddresses.map((address) => (
                    <label
                      key={address.id}
                      className={`flex cursor-pointer gap-3 rounded-lg border p-3.5 text-sm ${
                        address.id === shippingAddressId
                          ? 'border-brand bg-brand-soft'
                          : 'border-border bg-surface hover:border-brand/40'
                      }`}
                    >
                      <input
                        type="radio"
                        name="scheduleAddress"
                        className="mt-0.5 h-4 w-4 border-border-strong text-brand"
                        checked={address.id === shippingAddressId}
                        onChange={() => {
                          setShippingAddressId(address.id);
                        }}
                      />
                      <span>
                        <span className="block font-medium text-ink">{address.contactName}</span>
                        <span className="mt-0.5 block text-ink-muted">
                          {address.line1}, {address.city}, {address.state} {address.postalCode}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}

            {isAddingAddress ? (
              <div className="mt-4 border-t border-border pt-4">
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
              <Button
                size="sm"
                className="mt-3"
                onClick={() => {
                  setIsAddingAddress(true);
                }}
              >
                {usableAddresses.length === 0 ? 'Add an address' : 'Add a different address'}
              </Button>
            )}
          </section>

          {/* --- How to pay ---------------------------------------------------- */}
          <section
            aria-labelledby="pay-heading"
            className="rounded-lg border border-border bg-surface p-5 shadow-card"
          >
            <h2 id="pay-heading" className="text-title-sm text-ink">
              {t('scheduleBuilder.howEachDeliveryIsPaid')}
            </h2>

            <fieldset className="mt-3">
              <legend className="sr-only">
                {t('scheduleBuilder.paymentMethodForEachOccurrence')}
              </legend>

              <div className="space-y-2">
                <label
                  className={`flex cursor-pointer gap-3 rounded-lg border p-4 ${
                    paymentMode === 'PAYMENT_LINK'
                      ? 'border-brand bg-brand-soft'
                      : 'border-border bg-surface hover:border-brand/40'
                  }`}
                >
                  <input
                    type="radio"
                    name="schedulePayment"
                    className="mt-1 h-4 w-4 border-border-strong text-brand"
                    checked={paymentMode === 'PAYMENT_LINK'}
                    onChange={() => {
                      setPaymentMode('PAYMENT_LINK');
                    }}
                  />
                  <span className="text-sm">
                    <span className="block font-medium text-ink">
                      {t('scheduleBuilder.sendAPaymentLinkEach')}
                    </span>
                    <span className="mt-0.5 block text-ink-muted">
                      {t('scheduleBuilder.eachDeliveryCreatesAnOrder')}
                    </span>
                  </span>
                </label>

                <label
                  className={`flex cursor-pointer gap-3 rounded-lg border p-4 ${
                    paymentMode === 'AUTO_PAY'
                      ? 'border-brand bg-brand-soft'
                      : 'border-border bg-surface hover:border-brand/40'
                  }`}
                >
                  <input
                    type="radio"
                    name="schedulePayment"
                    className="mt-1 h-4 w-4 border-border-strong text-brand"
                    checked={paymentMode === 'AUTO_PAY'}
                    onChange={() => {
                      setPaymentMode('AUTO_PAY');
                    }}
                  />
                  <span className="text-sm">
                    <span className="block font-medium text-ink">
                      {t('scheduleBuilder.chargeAutomatically')}
                    </span>
                    <span className="mt-0.5 block text-ink-muted">
                      {t('scheduleBuilder.eachDeliveryIsChargedTo')}
                    </span>
                  </span>
                </label>
              </div>
            </fieldset>

            {paymentMode === 'PAYMENT_LINK' && (
              <div className="mt-4">
                <Field
                  label={t('scheduleBuilder.sendThePaymentLinkTo')}
                  hint={t('scheduleBuilder.yourOwnAddressIsFilled')}
                  error={
                    payerEmail.trim() !== '' && !/^\S+@\S+\.\S+$/.test(payerEmail.trim())
                      ? 'Enter a valid email address.'
                      : undefined
                  }
                  required
                >
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      type="email"
                      placeholder={t('scheduleBuilder.financeYourcompanyCom')}
                      value={payerEmail}
                      aria-describedby={describedBy}
                      invalid={
                        payerEmail.trim() !== '' && !/^\S+@\S+\.\S+$/.test(payerEmail.trim())
                      }
                      onChange={(event) => {
                        setPayerEmail(event.target.value);
                      }}
                    />
                  )}
                </Field>
              </div>
            )}

            {paymentMode === 'AUTO_PAY' && (
              <div
                role="status"
                className="mt-4 rounded-md border border-warning/30 bg-warning-soft px-3 py-2.5 text-xs text-ink"
              >
                <p className="font-medium text-warning">
                  {t('scheduleBuilder.aMandateIsNeededBefore')}
                </p>
                <p className="mt-0.5">{t('scheduleBuilder.weWillSetTheSchedule')}</p>
              </div>
            )}
          </section>
        </div>

        {/* --- Summary and consent --------------------------------------------- */}
        <aside aria-labelledby="summary-heading" className="lg:sticky lg:top-28 lg:self-start">
          <div className="rounded-lg border border-border bg-surface p-5 shadow-card">
            <h2 id="summary-heading" className="text-title-sm text-ink">
              {t('scheduleBuilder.yourSchedule')}
            </h2>

            <Field label={t('scheduleBuilder.nameThisSchedule')}>
              {({ inputId }) => (
                <div className="mt-1.5">
                  <Input
                    id={inputId}
                    value={name}
                    maxLength={128}
                    onChange={(event) => {
                      setName(event.target.value);
                    }}
                  />
                </div>
              )}
            </Field>

            <dl className="mt-4 space-y-2 border-t border-border pt-4 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-ink-muted">{t('scheduleBuilder.repeats')}</dt>
                <dd className="text-right text-ink">{cadence}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-muted">At</dt>
                <dd className="text-right text-ink">
                  {timeLabel}
                  <span className="block text-xxs text-ink-subtle">{business.timezone}</span>
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-muted">{t('scheduleBuilder.starting')}</dt>
                <dd className="text-right text-ink">{startDate}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-muted">{t('scheduleBuilder.ends')}</dt>
                <dd className="text-right text-ink">
                  {endMode === 'never'
                    ? 'When you cancel'
                    : endMode === 'date'
                      ? endDate === ''
                        ? 'Choose a date'
                        : endDate
                      : `After ${formatNumber(maxOccurrences)} deliveries`}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-muted">{t('scheduleBuilder.items')}</dt>
                <dd className="text-right text-ink">
                  {formatNumber(items.length)} product
                  {items.length === 1 ? '' : 's'}
                </dd>
              </div>
            </dl>

            {/* The estimate is the server's number when there is one, and is
                never assembled here. See the note at the top of this file. */}
            <div className="mt-4 rounded-md border border-border bg-surface-sunken p-3.5">
              <p className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                {t('scheduleBuilder.estimatedPerDelivery')}
              </p>

              {cartTotals === undefined ? (
                <p className="mt-1 text-sm text-ink">
                  {items[0]?.unitPrice === null || items[0]?.unitPrice === undefined
                    ? 'Calculated at each delivery'
                    : `${formatMoney(items[0].unitPrice)} per unit`}
                </p>
              ) : (
                <p className="mt-1 text-lg font-semibold tabular text-ink">
                  {formatMoney(cartTotals.grandTotal)}
                </p>
              )}

              <p className="mt-1.5 text-xs text-ink-muted">
                {t('scheduleBuilder.anEstimateOnlyEveryDelivery')}
              </p>
            </div>

            {submitError !== null && (
              <div
                role="alert"
                className="mt-4 rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger"
              >
                {submitError}
              </div>
            )}

            <label className="mt-4 flex items-start gap-2.5 text-sm text-ink">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 rounded border-border-strong text-brand"
                checked={consentAccepted}
                onChange={(event) => {
                  setConsentAccepted(event.target.checked);
                }}
              />
              <span>
                I authorise {business.displayName} to place this order on the schedule above, and I
                understand the amount is recalculated for each delivery.
              </span>
            </label>

            <Button
              variant="action"
              size="lg"
              fullWidth
              className="mt-4"
              disabled={!canSubmit}
              isLoading={create.isPending}
              onClick={() => {
                create.mutate();
              }}
            >
              {t('scheduleBuilder.startThisRepeatPurchase')}
            </Button>

            {!payerEmailValid && (
              <p className="mt-2 text-center text-xs text-ink-muted">
                {t('scheduleBuilder.enterWhoShouldReceiveThe')}
              </p>
            )}

            {payerEmailValid && !consentAccepted && (
              <p className="mt-2 text-center text-xs text-ink-muted">
                {t('scheduleBuilder.tickTheBoxAboveTo')}
              </p>
            )}

            <p className="mt-3 text-center text-xxs text-ink-subtle">
              {t('scheduleBuilder.youCanPauseOrCancel')}
            </p>

            {fromCart && (
              <p className="mt-3 text-center">
                <Badge tone="brand">{t('scheduleBuilder.builtFromYourCart')}</Badge>
              </p>
            )}
          </div>
        </aside>
      </div>
    </>
  );
}

/**
 * Schedule your Cart.
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
import { useLocale } from '@/app/locale-context';
import { useStorefront } from '@/app/storefront-context';
import { AddressForm } from '@/components/AddressForm';
import { DatePicker } from '@/components/DatePicker';
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
import { formatIsoDate } from '@/lib/calendar-date';
import { useDeliveryWindow } from '@/lib/delivery-window';
import { formatMoney, formatNumber } from '@/lib/format';
import { clampToRules } from '@/lib/quantity-rules';
/*
 * The interval mapping, shared with the schedule workspace.
 *
 * It used to live in this file. It moved the day a second screen had to make
 * the same conversion: the workspace changes a plan's cadence, and two copies
 * of "every three months means EVERY_N_MONTHS with 3" is how a standing order
 * created on one calendar gets saved back onto another.
 */
import {
  CUSTOM_CADENCES,
  PRESET_CADENCES,
  WEEKDAYS,
  earliestDeliveryDate,
  noticeDaysFrom,
  recurrenceFor,
} from '@/lib/schedule-cadence';
import type { Cadence } from '@/lib/schedule-cadence';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import type { AccountResponse, Address, Cart, Product, ScheduleCreated } from '@/lib/types';
import { translateKey, useI18n } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';

type PaymentMode = 'AUTO_PAY' | 'PAYMENT_LINK';

/**
 * The hour a schedule's occurrence is raised, in the schedule's own zone.
 *
 * Not asked, and deliberately so — the same call `CadenceFields` made for the
 * workspace. The control offered five fixed times, every one of them the
 * middle of somebody's night somewhere, and the hour a warehouse picks an
 * order is the operator's decision rather than a buyer's. The API still
 * requires the field, so it is sent with the value the form always opened on;
 * nothing about the recurrence changed, only a question nobody could answer.
 */
const DEFAULT_RUN_AT_MINUTE = 360;

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
  const { t, intlLocale } = useI18n();

  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { business, features, fulfilment } = useStorefront();

  /*
   * The soonest first delivery this store will take, on the store's clock.
   *
   * The same floor `CadenceFields` draws on the workspace and the same one
   * `assertDeliveryNotice` enforces on the server - read from the deployment's
   * own setting rather than from a number in this bundle. Greying out what
   * will be refused is the difference between a rule and a rejection, and
   * this screen used to offer today.
   */
  const noticeDays = noticeDaysFrom(fulfilment);
  const localEarliest = earliestDeliveryDate(business.timezone, noticeDays);

  const productId = searchParams.get('productId');
  const variantId = searchParams.get('variantId');
  const requestedQuantity = Number(searchParams.get('quantity') ?? '0');

  const fromCart = productId === null;

  useDocumentMeta({ title: t('scheduleBuilder.setUpARepeatPurchase'), noIndex: true }, business.displayName);

  const { currency, country } = useLocale();

  // --- Sources -------------------------------------------------------------

  const cart = useQuery({
    queryKey: ['cart'],
    queryFn: () => api.get<{ cart: Cart }>('/cart'),
    enabled: fromCart,
  });

  const product = useQuery({
    queryKey: ['product-by-id', productId, currency, country],
    queryFn: async () => {
      // The public detail route is keyed by slug, so the id is resolved
      // through a search rather than guessing a slug.
      //
      // Priced for the shopper's own market, like every other catalogue read:
      // the figure below is shown as the unit price of the schedule they are
      // about to set up, and quoting it from the base market would show one
      // number here and charge another on the first occurrence.
      const found = await api.get<{ products: Product[] }>('/catalog/products', {
        query: { limit: 60, currency, country: country ?? undefined },
      });

      const match = found.products.find((candidate) => candidate.id === productId);

      if (match === undefined) {
        throw new ApiError(404, {
          code: 'NOT_FOUND',
          message: t('scheduleBuilder.productNoLongerAvailable'),
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
  // A month is the interval most repeat purchases actually run at, so it is
  // what the form opens on. The old default — "every so many days", with 7 in
  // a number box — made a weekly delivery the path of least resistance for
  // consumables that are ordered monthly.
  const [cadence, setCadence] = useState<Cadence>('MONTHS_1');
  const [intervalDays, setIntervalDays] = useState(7);
  const [weekday, setWeekday] = useState(1);
  const [monthDay, setMonthDay] = useState(1);
  /*
   * Opens on the earliest date the store can actually take, not on today.
   *
   * Today is a day the calendar below greys out and the server refuses, so
   * pre-filling it meant every schedule started life invalid and the buyer's
   * first act on the screen was correcting a value they had not typed.
   */
  const [startDate, setStartDate] = useState(() =>
    earliestDeliveryDate(business.timezone, noticeDaysFrom(fulfilment)),
  );
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

  /*
   * And the floor the API will actually enforce, once an address is chosen.
   *
   * Measured on the delivery address's own zone, and raised further by a
   * pinned warehouse's lane where a plan has one. Falls back to the local
   * figure until the answer arrives and if the ask fails — see
   * `lib/delivery-window.ts`.
   */
  const deliveryWindow = useDeliveryWindow({
    shippingAddressId,
    timezone: business.timezone,
  });

  const earliestStart = deliveryWindow?.earliest ?? localEarliest;

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

  /*
   * Lift a start date that has fallen below the floor.
   *
   * Two ways it can, and neither is the buyer typing something silly. The
   * form mounts before `GET /config` has answered, so it opens on the
   * fallback notice period and the real one may be longer. And a tab left
   * open overnight is a tab whose "today" moved while nobody touched it.
   *
   * Only ever forwards. A date the buyer chose further out is their choice
   * and this must not drag it back to the floor.
   */
  useEffect(() => {
    setStartDate((current) => (current < earliestStart ? earliestStart : current));
  }, [earliestStart]);

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
        const suggested =
          lines.length === 1
            ? t('scheduleBuilder.repeatName', { product: lines[0]?.name ?? '' })
            : t('scheduleBuilder.repeatOrder');
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

    setName((current) =>
      current === '' ? t('scheduleBuilder.repeatName', { product: found.name }) : current,
    );
  }, [fromCart, cart.data, product.data, requestedQuantity, variantId, t]);

  const create = useMutation({
    mutationFn: () =>
      api.post<ScheduleCreated>('/recurring-schedules', {
        name: name.trim(),
        // The frequency and its one dependent field, together, from the single
        // choice the customer made. Never assembled inline: the server's CHECK
        // constraint refuses a frequency whose own column is absent, and
        // spreading three conditionals at the call site is how one of them
        // eventually goes missing.
        ...recurrenceFor(cadence, startDate, { intervalDays, weekday, monthDay }),
        timezone: business.timezone,
        runAtMinute: DEFAULT_RUN_AT_MINUTE,
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
        setSubmitError(errorMessage(t, error));
        return;
      }

      setSubmitError(
        errorMessage(t, error, t('scheduleBuilder.couldNotBeSetUp')),
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
            ? t('scheduleBuilder.noneOfTheItems')
            : t('scheduleBuilder.thisProductCannot')
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
  const weekdayKey = WEEKDAYS.find((day) => day.value === weekday)?.labelKey;

  /**
   * The cadence in words, for the summary panel.
   *
   * A preset reads back the label the customer chose from the dropdown rather
   * than a translation of what it became — somebody who picked "Every 3
   * months" should not have it summarised as "on day 9 of every third month".
   * The custom modes still describe themselves, because there the follow-up
   * field is the answer and the label alone would not say what was set.
   */
  const presetLabelKey = PRESET_CADENCES.find((option) => option.value === cadence)?.labelKey;

  const cadenceSummary =
    presetLabelKey !== undefined
      ? translateKey(t, presetLabelKey)
      : cadence === 'CUSTOM_DAYS'
        ? t('scheduleBuilder.everyNDays', {
            count: intervalDays,
            days: formatNumber(intervalDays),
          })
        : cadence === 'CUSTOM_WEEKLY'
          ? t('scheduleBuilder.everyWeekday', {
              weekday:
                weekdayKey === undefined ? t('scheduleBuilder.week') : translateKey(t, weekdayKey),
            })
          : t('scheduleBuilder.onDayOfEachMonth', { day: formatNumber(monthDay) });

  return (
    <>
      <header className="mb-6">
        <h1 className="text-title-xl text-ink">{t('scheduleBuilder.setUpARepeatPurchase')}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-muted">
          {t('scheduleBuilder.weWillPlaceTheOrder')}
        </p>
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
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
              <Field
                label={t('scheduleBuilder.repeat')}
                hint={t('scheduleBuilder.theFirstDeliveryDateSets')}
              >
                {({ inputId, describedBy }) => (
                  <Select
                    id={inputId}
                    value={cadence}
                    aria-describedby={describedBy}
                    onChange={(event) => {
                      setCadence(event.target.value as Cadence);
                    }}
                  >
                    {/*
                     * Two groups, and the split is doing work rather than
                     * decorating. The six presets answer "how often" on their
                     * own; each custom entry is a promise of a second question,
                     * and mixing the two in one flat list made a nine-item
                     * dropdown where the sixth and seventh looked alike and
                     * behaved differently.
                     */}
                    <optgroup label={t('scheduleBuilder.commonIntervals')}>
                      {PRESET_CADENCES.map((option) => (
                        <option key={option.value} value={option.value}>
                          {translateKey(t, option.labelKey)}
                        </option>
                      ))}
                    </optgroup>

                    <optgroup label={t('scheduleBuilder.somethingElse')}>
                      {CUSTOM_CADENCES.map((option) => (
                        <option key={option.value} value={option.value}>
                          {translateKey(t, option.labelKey)}
                        </option>
                      ))}
                    </optgroup>
                  </Select>
                )}
              </Field>

              {cadence === 'CUSTOM_DAYS' && (
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

              {cadence === 'CUSTOM_WEEKLY' && (
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
                          {translateKey(t, day.labelKey)}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              )}

              {cadence === 'CUSTOM_MONTHLY' && (
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

              {/*
               * The first delivery date, and no time of day beside it.
               *
               * The time control that used to share this row is gone, for the
               * reason `DEFAULT_RUN_AT_MINUTE` gives. The grid stays so the
               * calendar keeps the half-width it has always had rather than
               * stretching across the form the day its neighbour left.
               */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field
                  label={t('scheduleBuilder.firstDeliveryOn')}
                  hint={t('scheduleBuilder.firstDeliveryNotice', {
                    date: formatIsoDate(earliestStart, intlLocale),
                  })}
                >
                  {({ inputId, describedBy }) => (
                    <DatePicker
                      id={inputId}
                      label={t('scheduleBuilder.firstDeliveryOn')}
                      value={startDate}
                      /*
                       * The notice period, greyed out rather than merely
                       * refused. A `type="date"` box with a `min` shows the
                       * same rule only to a buyer who tries to break it; the
                       * calendar shows it before they click.
                       */
                      min={earliestStart}
                      describedBy={describedBy}
                      onChange={(next) => {
                        setStartDate(next);
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
                    {/* The same calendar as the field above, so the two dates
                        on this form are chosen the same way. Its floor is the
                        first delivery rather than the notice period: a plan
                        that ends before it starts is the only wrong answer
                        here. */}
                    {/* The width lives on a wrapper, not on the picker: its
                        trigger is `w-full` and would win over anything passed
                        down. */}
                    <div className="w-44">
                      <DatePicker
                        label={t('scheduleBuilder.stopAfterThisDate')}
                        value={endDate}
                        min={startDate}
                        disabled={endMode !== 'date'}
                        onChange={(next) => {
                          setEndDate(next);
                        }}
                      />
                    </div>
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
                    {/* The width goes on a wrapper, like the date picker above
                        and for the same reason: `Input` carries `w-full` in its
                        base classes, and `w-full` sorts after a numeric width in
                        Tailwind's own stylesheet — so `w-24` here lost, the box
                        took the whole row, and "deliveries" landed on a line of
                        its own below it. */}
                    <span className="w-24 shrink-0">
                      <Input
                        type="number"
                        min={1}
                        max={10000}
                        className="tabular"
                        value={maxOccurrences}
                        aria-label={t('scheduleBuilder.numberOfDeliveries')}
                        disabled={endMode !== 'count'}
                        onChange={(event) => {
                          const parsed = Number(event.target.value);
                          if (Number.isFinite(parsed)) setMaxOccurrences(parsed);
                        }}
                      />
                    </span>
                    {t('scheduleCart.deliveries', {
                      count: maxOccurrences,
                      quantity: formatNumber(maxOccurrences),
                    })}
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
                {usableAddresses.length === 0 ? t('scheduleBuilder.addAnAddress') : t('scheduleBuilder.addADifferentAddress')}
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
                      ? t('validation.emailInvalid')
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
                <dd className="text-right text-ink">{cadenceSummary}</dd>
              </div>
              {/* The zone rides on the start date now that the hour is not
                  asked: it is still what "starting" is counted on, and it was
                  only ever shown here because the time row carried it. */}
              <div className="flex justify-between gap-3">
                <dt className="text-ink-muted">{t('scheduleBuilder.starting')}</dt>
                <dd className="text-right text-ink">
                  {startDate}
                  <span className="block text-xxs text-ink-subtle">{business.timezone}</span>
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-muted">{t('scheduleBuilder.ends')}</dt>
                <dd className="text-right text-ink">
                  {endMode === 'never'
                    ? t('scheduleBuilder.whenYouCancel')
                    : endMode === 'date'
                      ? endDate === ''
                        ? t('scheduleBuilder.chooseADate')
                        : endDate
                      : t('scheduleDetail.afterNDeliveries', {
                          count: maxOccurrences,
                          deliveries: formatNumber(maxOccurrences),
                        })}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-muted">{t('scheduleBuilder.items')}</dt>
                <dd className="text-right text-ink">
                  {t('catalog.productCount', {
                    count: items.length,
                    products: formatNumber(items.length),
                  })}
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
                    ? t('scheduleBuilder.calculatedAtEachDelivery')
                    : t('scheduleBuilder.perUnit', { amount: formatMoney(items[0].unitPrice) })}
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
              <span>{t('scheduleBuilder.consentAuthorise', { store: business.displayName })}</span>
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

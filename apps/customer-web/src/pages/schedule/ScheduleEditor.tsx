/**
 * Changing one schedule.
 *
 * The distinction this screen exists to keep, and the one it must never blur:
 * **editing a schedule changes what happens next, never what already
 * happened.** Orders it has produced are ordinary orders and stay exactly as
 * they are. A buyer who removes a product has not amended last month's
 * delivery note, and the panel says so beside the button rather than in a
 * dialog after the fact.
 *
 * Three rules shape the code:
 *
 *   1. **The save is absolute, not incremental.** Apply Changes sends the
 *      whole arrangement — every item with its quantity, the whole recurrence,
 *      the address — so the same request applied twice lands on the same
 *      state. That is what makes a retry, a double-click or a flaky connection
 *      safe: there is no "add one more of this" for a second attempt to apply
 *      again. The server replaces the basket rather than merging into it.
 *   2. **The screen refuses what the server would refuse, and says why
 *      first.** A plan inside its edit cutoff, one with a delivery being
 *      processed, and one that is cancelled or finished are all read-only
 *      here. Controls that look editable and then fail on save are worse than
 *      controls that say they are locked and name the reason.
 *   3. **The money comes from the server.** The estimate is
 *      `quoteSchedule`'s answer, the same function that prices the occurrence
 *      the customer is eventually charged for. Nothing here multiplies a unit
 *      price by a quantity — a second implementation of "what does this basket
 *      cost" is how somebody ends up disputing a total nobody can explain.
 *
 * Apply Changes stays disabled while nothing has changed. Not for tidiness: a
 * PATCH that changes the recurrence re-materialises every upcoming delivery,
 * so an accidental no-op save is a real write against a live standing order.
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import { Modal } from '@/components/Modal';
import { QuantityInput } from '@/components/QuantityInput';
import {
  Badge,
  Button,
  ErrorState,
  Field,
  Input,
  LoadingState,
  Select,
  Textarea,
} from '@/components/ui';
import { GrandTotalRow, TotalRow } from '@/components/Totals';
import { AlertIcon, PlusIcon, TrashIcon } from '@/components/icons';
import { api } from '@/lib/api';
import { cx } from '@/lib/cx';
import { errorMessage } from '@/lib/errors';
import { formatDateTime, formatMoney, formatNumber } from '@/lib/format';
import { clampToRules } from '@/lib/quantity-rules';
import { scheduleStatusLabel, scheduleStatusTone } from '@/lib/order-status';
import { cadenceDraftFrom, isSameCadence, recurrencePayload } from '@/lib/schedule-cadence';
import type { CadenceDraft } from '@/lib/schedule-cadence';
import { useI18n } from '@/i18n/i18n-context';
import type {
  Address,
  PurchaseRules,
  Schedule,
  ScheduleEstimate,
  ScheduleItem,
} from '@/lib/types';
import { useDeliveryWindow } from '@/lib/delivery-window';
import { CadenceFields } from './CadenceFields';
import { ScheduleProductPicker } from './ScheduleProductPicker';
import type { PickedProduct } from './ScheduleProductPicker';

/** One line of the basket being edited. */
interface ItemDraft {
  productId: string;
  variantId: string | null;
  quantity: number;
  name: string;
  sku: string;
  slug: string | null;
  rules: PurchaseRules;
}

/**
 * A schedule line's rules, widened to what the quantity control expects.
 *
 * `isRecurringEligible` is true by construction: the product is already on a
 * schedule, which is the only way it can have got here.
 */
function rulesOf(item: ScheduleItem): PurchaseRules {
  return {
    minOrderQty: item.purchaseRules?.minOrderQty ?? 1,
    maxOrderQty: item.purchaseRules?.maxOrderQty ?? null,
    qtyIncrement: item.purchaseRules?.qtyIncrement ?? 1,
    isRecurringEligible: true,
  };
}

function draftItemsFrom(schedule: Schedule): ItemDraft[] {
  return (schedule.items ?? []).map((item) => ({
    productId: item.productId,
    variantId: item.variantId,
    quantity: item.quantity,
    name: item.name ?? item.sku ?? item.productId,
    sku: item.sku ?? '',
    slug: item.slug ?? null,
    rules: rulesOf(item),
  }));
}

/** Whether two baskets are the same basket. */
function isSameItems(a: readonly ItemDraft[], b: readonly ItemDraft[]): boolean {
  if (a.length !== b.length) return false;

  const key = (item: ItemDraft): string =>
    `${item.productId}:${item.variantId ?? ''}:${String(item.quantity)}`;

  // Order is not part of the arrangement — the server replaces the whole set —
  // so the comparison sorts. Without that, moving a line would read as a
  // change and enable a save that writes nothing.
  return [...a].map(key).sort().join('|') === [...b].map(key).sort().join('|');
}

/**
 * Why this plan cannot be edited, if it cannot.
 *
 * Returns a translation key rather than a sentence, so the reason is one thing
 * decided in one place and rendered wherever it is needed — the notice at the
 * top and the hint under the disabled button say the same words because they
 * read the same key.
 */
function lockReason(schedule: Schedule): 'cancelled' | 'completed' | 'cutoff' | null {
  if (schedule.status === 'CANCELLED') return 'cancelled';
  if (schedule.status === 'COMPLETED') return 'completed';

  // The cutoff. Past it the engine may already be pricing the next delivery,
  // and an edit would race the charge: the customer would see one basket and
  // be charged for another. The server refuses it too - this is so the screen
  // does not offer a button that then errors.
  if (schedule.editableUntil !== undefined && schedule.editableUntil !== null) {
    if (Date.now() >= new Date(schedule.editableUntil).getTime()) return 'cutoff';
  }

  return null;
}

export function ScheduleEditor({ scheduleId }: { scheduleId: string }): React.JSX.Element {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();

  const detail = useQuery({
    queryKey: ['schedule', scheduleId],
    queryFn: () => api.get<{ schedule: Schedule }>(`/recurring-schedules/${scheduleId}`),
  });

  const estimate = useQuery({
    queryKey: ['schedule-estimate', scheduleId],
    queryFn: () =>
      api.get<{ estimate: ScheduleEstimate }>(`/recurring-schedules/${scheduleId}/estimate`),
    // Prices and stock move under a screen somebody leaves open, and this is
    // the figure they are about to agree to.
    staleTime: 30_000,
  });

  const addresses = useQuery({
    queryKey: ['addresses'],
    queryFn: () => api.get<{ addresses: Address[] }>('/account/addresses'),
  });

  const schedule = detail.data?.schedule ?? null;

  // --- The form -------------------------------------------------------------
  //
  // Initialised from the loaded plan the first time it arrives, and never
  // again: re-syncing on every refetch would throw away what somebody had
  // typed the moment a background refresh landed. The page above remounts this
  // component when the selected schedule changes, so there is nothing to
  // reset.
  const [name, setName] = useState<string | null>(null);
  const [cadence, setCadence] = useState<CadenceDraft | null>(null);
  const [items, setItems] = useState<ItemDraft[] | null>(null);
  const [addressId, setAddressId] = useState<string | null>(null);

  const [isPicking, setIsPicking] = useState(false);
  const [isConfirmingCancel, setIsConfirmingCancel] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);

  /** What the plan looked like when it was loaded, for the change check. */
  const loaded = useMemo(
    () =>
      schedule === null
        ? null
        : {
            name: schedule.name,
            cadence: cadenceDraftFrom({
              frequency: schedule.frequency,
              intervalDays: schedule.intervalDays,
              intervalMonths: schedule.intervalMonths,
              weekday: schedule.weekday,
              monthDay: schedule.monthDay,
              timezone: schedule.timezone,
              runAtMinute: schedule.runAtMinute,
              startDate: schedule.startDate,
              endDate: schedule.endDate,
              maxOccurrences: schedule.maxOccurrences,
            }),
            items: draftItemsFrom(schedule),
          },
    [schedule],
  );

  /*
   * The earliest first delivery this plan's address will take.
   *
   * Asked up here with the raw state rather than below with `currentAddress`,
   * because a hook cannot live after the loading returns. Same answer: the
   * edited address if one has been picked, otherwise the plan's own.
   *
   * The rule applies to an edit exactly as it does to a new plan — moving an
   * upcoming delivery into next week is the same ask as booking one — and the
   * server refuses either way.
   */
  const deliveryWindow = useDeliveryWindow({
    shippingAddressId: addressId ?? schedule?.shippingAddress?.id ?? null,
    ...(cadence === null ? {} : { timezone: cadence.timezone }),
  });

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.patch<{ updated: boolean; nextRunAt: string | null }>(
        `/recurring-schedules/${scheduleId}`,
        body,
      ),
    onSuccess: async () => {
      setSaveError(null);
      toast.success(t('scheduleCart.changesApplied'));

      // Read the plan back rather than trusting what was sent: the server
      // decides the next delivery date, and it is the number this screen then
      // shows.
      await queryClient.invalidateQueries({ queryKey: ['schedule', scheduleId] });
      await queryClient.invalidateQueries({ queryKey: ['schedule-estimate', scheduleId] });
      await queryClient.invalidateQueries({ queryKey: ['schedules'] });
    },
    onError: (error) => {
      // The server's own message names the rule that was broken — a cutoff, a
      // date in the past, a product that can no longer be scheduled. Replacing
      // it with "could not save" throws away the only part the customer can
      // act on.
      setSaveError(errorMessage(t, error, t('scheduleCart.changesNotApplied')));
    },
  });

  const cancel = useMutation({
    mutationFn: () => {
      const reason = cancelReason.trim();
      // A DELETE body is not reliably forwarded by every proxy, so the reason
      // travels as a query parameter — the same call the detail page makes.
      return api.delete(
        `/recurring-schedules/${scheduleId}`,
        reason === '' ? {} : { query: { reason } },
      );
    },
    onSuccess: async () => {
      setIsConfirmingCancel(false);
      setCancelReason('');
      toast.success(t('scheduleCart.cancelledFutureOnly'));

      await queryClient.invalidateQueries({ queryKey: ['schedules'] });
      await queryClient.invalidateQueries({ queryKey: ['schedule', scheduleId] });
      // Back to the list with nothing selected: the plan that was open is no
      // longer editable, and leaving it on screen with every control dead
      // reads as a broken page.
      void navigate('/accounts/schedule', { replace: true });
    },
    onError: (error) => {
      setSaveError(errorMessage(t, error, t('scheduleCart.couldNotCancel')));
    },
  });

  if (detail.isPending) return <LoadingState label={t('scheduleCart.loadingSchedule')} />;

  if (detail.isError) {
    return (
      <ErrorState
        error={detail.error}
        onRetry={() => {
          void detail.refetch();
        }}
      />
    );
  }

  if (schedule === null || loaded === null) {
    return <LoadingState label={t('scheduleCart.loadingSchedule')} />;
  }

  // The edited values, falling back to what was loaded until somebody touches
  // a control. One expression rather than an effect that copies the plan into
  // state, which is the version that fights every background refetch.
  const currentName = name ?? loaded.name;
  const currentCadence = cadence ?? loaded.cadence;
  const currentItems = items ?? loaded.items;
  const currentAddress = addressId ?? schedule.shippingAddress?.id ?? null;

  const lock = lockReason(schedule);
  const isReadOnly = lock !== null;

  const hasChanges =
    currentName.trim() !== loaded.name ||
    !isSameCadence(currentCadence, loaded.cadence) ||
    !isSameItems(currentItems, loaded.items) ||
    (currentAddress !== null && currentAddress !== (schedule.shippingAddress?.id ?? null));

  const estimateData = estimate.data?.estimate ?? null;

  /** The estimate's line for a product, for its picture and unit price. */
  const pricedLine = (productId: string): ScheduleEstimate['lines'][number] | undefined =>
    estimateData?.lines.find((line) => line.productId === productId);

  const usableAddresses = (addresses.data?.addresses ?? []).filter(
    (address) => address.archivedAt === null,
  );

  const setItem = (index: number, quantity: number): void => {
    setItems(currentItems.map((item, at) => (at === index ? { ...item, quantity } : item)));
    setSaveError(null);
  };

  const removeItem = (index: number): void => {
    setItems(currentItems.filter((_item, at) => at !== index));
    setSaveError(null);
  };

  const addItem = (picked: PickedProduct): void => {
    const rules: PurchaseRules = {
      minOrderQty: picked.minOrderQty,
      maxOrderQty: picked.maxOrderQty,
      qtyIncrement: picked.qtyIncrement,
      isRecurringEligible: true,
    };

    setItems([
      ...currentItems,
      {
        productId: picked.productId,
        variantId: null,
        // The smallest legal quantity, not one: a product sold in tens starts
        // at ten, and clamping to the increment is what stops a minimum of 10
        // with a step of 4 producing a number the server would only flag.
        quantity: clampToRules(picked.minOrderQty, rules),
        name: picked.name,
        sku: picked.sku,
        slug: picked.slug,
        rules,
      },
    ]);
    setSaveError(null);
    setIsPicking(false);
  };

  const applyChanges = (): void => {
    setSaveError(null);

    save.mutate({
      name: currentName.trim(),
      ...recurrencePayload(currentCadence, { forUpdate: true }),
      // The whole basket, every time. See rule 1 in the header: this is what
      // makes a retried save land on the same state rather than applying the
      // change twice.
      items: currentItems.map((item) => ({
        productId: item.productId,
        variantId: item.variantId,
        quantity: item.quantity,
      })),
      ...(currentAddress !== null ? { shippingAddressId: currentAddress } : {}),
    });
  };

  return (
    <div className="space-y-5">
      {/* --- Who this plan is ------------------------------------------------ */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-title-lg text-ink">{schedule.name}</h2>
          <p className="mt-1 text-sm text-ink-muted">{schedule.summary}</p>
          <p className="mt-1 font-mono text-xxs uppercase tracking-wide text-ink-subtle">
            {schedule.id}
          </p>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <Badge tone={scheduleStatusTone(schedule.status)}>
            {scheduleStatusLabel(t, schedule.status)}
          </Badge>
          {/* Pausing, the delivery history and the payment arrangement live on
              the plan's own page. This screen edits; that one explains. */}
          <Link
            to={`/account/schedules/${schedule.id}`}
            className="text-xs font-medium text-brand underline underline-offset-2 hover:no-underline"
          >
            {t('scheduleCart.fullDetails')}
          </Link>
        </div>
      </header>

      {/* --- What this screen will and will not change ----------------------- */}
      {isReadOnly ? (
        <div
          role="status"
          className="flex gap-2.5 rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-sm"
        >
          <AlertIcon aria-hidden="true" className="mt-px h-4 w-4 shrink-0 text-warning" />
          <div className="min-w-0">
            <p className="font-medium text-warning">{t('scheduleCart.lockedTitle')}</p>
            <p className="mt-0.5 text-ink">
              {lock === 'cancelled'
                ? t('scheduleCart.lockedCancelled')
                : lock === 'completed'
                  ? t('scheduleCart.lockedCompleted')
                  : t('scheduleCart.lockedCutoff', {
                      when:
                        schedule.nextRunAt === null
                          ? t('scheduleCart.theNextDelivery')
                          : formatDateTime(schedule.nextRunAt),
                    })}
            </p>
          </div>
        </div>
      ) : (
        <p className="rounded-lg border border-border bg-surface-sunken px-4 py-3 text-xs text-ink-muted">
          {t('scheduleCart.appliesToFutureOnly')}
        </p>
      )}

      {/* --- The basket ------------------------------------------------------ */}
      <section
        aria-labelledby={`items-${schedule.id}`}
        className="rounded-lg border border-border bg-surface p-5 shadow-card"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 id={`items-${schedule.id}`} className="text-title-sm text-ink">
            {t('scheduleCart.whatIsDelivered')}
          </h3>

          {!isReadOnly && (
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                setIsPicking(true);
              }}
            >
              <PlusIcon aria-hidden="true" className="h-4 w-4" />
              {t('scheduleCart.addAProduct')}
            </Button>
          )}
        </div>

        {currentItems.length === 0 ? (
          // A schedule with nothing on it cannot be saved — the server refuses
          // an empty basket — so this says what to do rather than presenting an
          // empty list as a finished state.
          <p role="status" className="mt-4 text-sm text-ink-muted">
            {t('scheduleCart.noItemsYet')}
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-border-subtle">
            {currentItems.map((item, index) => {
              const priced = pricedLine(item.productId);

              /*
               * What the steppers call this line.
               *
               * Product plus option, because either alone is ambiguous: two
               * options of one product share the product's name, and two
               * products can share an option's name ("1 ml"). A screen reader
               * hearing "Increase the quantity of 1 ml by 10" twice on one
               * page has been told nothing.
               */
              const lineName =
                priced?.variantName === null || priced?.variantName === undefined
                  ? item.name
                  : `${item.name} (${priced.variantName})`;
              const short =
                priced?.availableQty !== null &&
                priced?.availableQty !== undefined &&
                priced.availableQty < item.quantity;

              return (
                <li
                  key={`${item.productId}:${item.variantId ?? ''}`}
                  className="flex flex-wrap items-start gap-4 py-4 first:pt-2 sm:flex-nowrap"
                >
                  {priced?.imageUrl === null || priced?.imageUrl === undefined ? (
                    <span
                      aria-hidden="true"
                      className="h-14 w-14 shrink-0 rounded-md border border-border bg-surface-sunken"
                    />
                  ) : (
                    <img
                      src={priced.imageUrl}
                      alt=""
                      width={56}
                      height={56}
                      loading="lazy"
                      className="h-14 w-14 shrink-0 rounded-md border border-border bg-surface object-contain p-1"
                    />
                  )}

                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-ink">
                      {item.slug === null ? (
                        item.name
                      ) : (
                        <Link
                          to={`/product/${item.slug}`}
                          className="hover:text-brand hover:underline"
                        >
                          {item.name}
                        </Link>
                      )}
                    </p>
                    {/* The option, where this line is one. Without it two
                        variants of one product are two identical rows — the
                        schedule read carries the product's code, not the
                        variant's, so the estimate is what knows the
                        difference. */}
                    {priced?.variantName !== null && priced?.variantName !== undefined && (
                      <p className="mt-0.5 text-xs text-ink-muted">{priced.variantName}</p>
                    )}

                    <p className="mt-0.5 font-mono text-xxs uppercase tracking-wide text-ink-subtle">
                      {item.sku}
                    </p>

                    {priced !== undefined && (
                      <p className="mt-1 text-xs text-ink-muted">
                        {t('scheduleCart.unitPrice', {
                          price: formatMoney(priced.unitPrice),
                        })}
                        <span className="mx-1.5 text-ink-subtle">·</span>
                        <span className="tabular text-ink">{formatMoney(priced.lineTotal)}</span>
                      </p>
                    )}

                    {short && (
                      <p className="mt-1.5 text-xs text-warning">
                        {t('scheduleCart.onlySoManyAvailable', {
                          count: priced.availableQty ?? 0,
                          quantity: formatNumber(priced.availableQty ?? 0),
                        })}
                      </p>
                    )}
                  </div>

                  <div className="flex shrink-0 items-end gap-2">
                    <QuantityInput
                      value={item.quantity}
                      rules={item.rules}
                      disabled={isReadOnly}
                      ruleHint={false}
                      /*
                       * A short visible label, and the product name only in
                       * the steppers' accessible names — exactly as the cart
                       * does it. The label is rendered, so passing the product
                       * name into it put a 400px heading inside a `shrink-0`
                       * block and squeezed the product's own column to one
                       * word per line.
                       */
                      label={t('cart.quantity')}
                      itemName={lineName}
                      onChange={(quantity) => {
                        setItem(index, quantity);
                      }}
                    />

                    {!isReadOnly && (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t('scheduleCart.removeFromSchedule', { product: lineName })}
                        onClick={() => {
                          removeItem(index);
                        }}
                      >
                        <TrashIcon aria-hidden="true" className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* --- When ------------------------------------------------------------ */}
      <section
        aria-labelledby={`cadence-${schedule.id}`}
        className="rounded-lg border border-border bg-surface p-5 shadow-card"
      >
        <h3 id={`cadence-${schedule.id}`} className="text-title-sm text-ink">
          {t('scheduleCart.howOftenAndWhen')}
        </h3>

        <div className="mt-3">
          <CadenceFields
            draft={currentCadence}
            disabled={isReadOnly}
            earliest={deliveryWindow?.earliest}
            onChange={(next) => {
              setCadence(next);
              setSaveError(null);
            }}
          />
        </div>

        {usableAddresses.length > 0 && (
          <div className="mt-4 border-t border-border-subtle pt-4">
            <Field label={t('scheduleCart.deliverTo')}>
              {({ inputId }) => (
                <Select
                  id={inputId}
                  value={currentAddress ?? ''}
                  disabled={isReadOnly}
                  onChange={(event) => {
                    setAddressId(event.target.value);
                    setSaveError(null);
                  }}
                >
                  {usableAddresses.map((address) => (
                    <option key={address.id} value={address.id}>
                      {[address.line1, address.city, address.postalCode, address.country]
                        .filter((part) => part.length > 0)
                        .join(', ')}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        )}

        <div className="mt-4 border-t border-border-subtle pt-4">
          <Field label={t('scheduleCart.scheduleName')} hint={t('scheduleCart.scheduleNameHint')}>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                value={currentName}
                maxLength={128}
                disabled={isReadOnly}
                aria-describedby={describedBy}
                onChange={(event) => {
                  setName(event.target.value);
                  setSaveError(null);
                }}
              />
            )}
          </Field>
        </div>
      </section>

      {/* --- What it would cost ---------------------------------------------- */}
      <section
        aria-labelledby={`estimate-${schedule.id}`}
        className="rounded-lg border border-border bg-surface p-5 shadow-card"
      >
        <h3 id={`estimate-${schedule.id}`} className="text-title-sm text-ink">
          {t('scheduleCart.estimatedAmount')}
        </h3>

        {estimate.isPending && (
          <div aria-hidden="true" className="mt-3 space-y-2">
            <div className="skeleton h-4 w-2/3" />
            <div className="skeleton h-4 w-1/2" />
            <div className="skeleton h-6 w-1/3" />
          </div>
        )}

        {estimate.isError && (
          <div role="alert" className="mt-3 flex flex-wrap items-center gap-2.5">
            <p className="min-w-0 flex-1 text-sm text-ink-muted">
              {t('scheduleCart.estimateFailed')}
            </p>
            <Button
              size="sm"
              onClick={() => {
                void estimate.refetch();
              }}
            >
              {t('aiMode.retry')}
            </Button>
          </div>
        )}

        {/*
         * Whose basket this figure is.
         *
         * The estimate prices the schedule as it is SAVED - it is a read of
         * the plan, not a quote of the form. So the moment there are unsaved
         * edits the number below is about something other than what is on
         * screen, and saying so is the difference between an honest estimate
         * and a misleading one. Applying the changes re-reads it.
         */}
        {hasChanges && !isReadOnly && (
          <p role="status" className="mt-2 text-xs text-warning">
            {t('scheduleCart.estimateIsOfSaved')}
          </p>
        )}

        {estimateData !== null && (
          <>
            <dl className="mt-3 space-y-2.5 text-sm">
              <TotalRow
                label={t('cart.subtotal')}
                value={formatMoney(estimateData.totals.subtotal)}
              />
              {estimateData.totals.discount.minor !== '0' && (
                <TotalRow
                  label={t('cart.discount')}
                  tone="credit"
                  value={<>−{formatMoney(estimateData.totals.discount)}</>}
                />
              )}
              <TotalRow label={t('cart.tax')} value={formatMoney(estimateData.totals.tax)} />
              <TotalRow
                label={t('cart.delivery')}
                value={formatMoney(estimateData.totals.shipping)}
              />
              <GrandTotalRow
                label={t('scheduleCart.perDelivery')}
                value={formatMoney(estimateData.estimatedTotal)}
                note={t('scheduleCart.repricedEveryTime')}
              />
            </dl>

            {/*
             * Problems, in the server's own words and by severity.
             *
             * BLOCK and HOLD stop a delivery; WARN does not. Rendering all
             * three the same way would tell a customer their standing order is
             * broken because a price moved by two rupees.
             */}
            {estimateData.problems.length > 0 && (
              <ul className="mt-4 space-y-2 border-t border-border-subtle pt-4">
                {estimateData.problems.map((problem) => (
                  <li
                    key={`${problem.code}:${problem.message}`}
                    className={cx(
                      'flex gap-2 rounded-md border px-3 py-2 text-xs',
                      problem.severity === 'WARN'
                        ? 'border-border bg-surface-sunken text-ink-muted'
                        : 'border-warning/30 bg-warning-soft text-ink',
                    )}
                  >
                    <AlertIcon
                      aria-hidden="true"
                      className={cx(
                        'mt-px h-3.5 w-3.5 shrink-0',
                        problem.severity === 'WARN' ? 'text-ink-subtle' : 'text-warning',
                      )}
                    />
                    {problem.message}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      {/* --- Apply, or stop it altogether ------------------------------------ */}
      {saveError !== null && (
        <p
          role="alert"
          className="rounded-md border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger"
        >
          {saveError}
        </p>
      )}

      <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-5 shadow-card sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <Button
            variant="action"
            size="lg"
            disabled={isReadOnly || !hasChanges || currentItems.length === 0}
            isLoading={save.isPending}
            onClick={applyChanges}
          >
            {t('scheduleCart.applyChanges')}
          </Button>

          <p className="mt-2 text-xs text-ink-muted">
            {isReadOnly
              ? t('scheduleCart.lockedNoSave')
              : currentItems.length === 0
                ? t('scheduleCart.addSomethingFirst')
                : hasChanges
                  ? t('scheduleCart.changesWillRedate')
                  : t('scheduleCart.nothingChangedYet')}
          </p>
        </div>

        {schedule.status !== 'CANCELLED' && (
          <Button
            variant="ghost"
            className="shrink-0"
            onClick={() => {
              setSaveError(null);
              setCancelReason('');
              setIsConfirmingCancel(true);
            }}
          >
            {t('scheduleCart.cancelThisSchedule')}
          </Button>
        )}
      </div>

      <ScheduleProductPicker
        isOpen={isPicking}
        onClose={() => {
          setIsPicking(false);
        }}
        onPick={addItem}
        alreadyOn={currentItems.map((item) => item.productId)}
      />

      {/*
       * Cancelling asks first, and the question says what it does and what it
       * does not: no further deliveries and no further charges, and last
       * month's order untouched. A reason is required, as it is on the plan's
       * own page — the same action, so the same bar.
       */}
      <Modal
        isOpen={isConfirmingCancel}
        onClose={() => {
          setIsConfirmingCancel(false);
        }}
        title={t('scheduleCart.cancelQuestion', { name: schedule.name })}
        footer={
          <>
            <Button
              disabled={cancel.isPending}
              onClick={() => {
                setIsConfirmingCancel(false);
              }}
            >
              {t('scheduleCart.leaveItRunning')}
            </Button>
            <Button
              variant="danger"
              disabled={cancelReason.trim() === ''}
              isLoading={cancel.isPending}
              onClick={() => {
                cancel.mutate();
              }}
            >
              {t('scheduleCart.cancelItNow')}
            </Button>
          </>
        }
      >
        <div className="space-y-4 text-sm">
          <p className="text-ink-muted">{t('scheduleCart.cancelExplain')}</p>

          <Field
            label={t('scheduleCart.cancelReason')}
            hint={t('scheduleCart.cancelReasonHint')}
            required
          >
            {({ inputId, describedBy }) => (
              <Textarea
                id={inputId}
                rows={2}
                value={cancelReason}
                aria-describedby={describedBy}
                onChange={(event) => {
                  setCancelReason(event.target.value);
                }}
              />
            )}
          </Field>
        </div>
      </Modal>
    </div>
  );
}

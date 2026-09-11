/**
 * Starting a schedule from nothing.
 *
 * The workspace's second job. A buyer can have as many independent standing
 * arrangements as they need — gloves monthly, feeding sets quarterly, saline
 * every fortnight — and each is its own plan with its own basket, cadence and
 * ending. Nothing here is shared between them.
 *
 * It posts to the same `POST /recurring-schedules` the builder does, with the
 * same fields, and lets the server apply the same rules. In particular
 * **consent is explicit and the form does not pre-tick it**: the schedule is a
 * standing authority to take money, the server refuses without consent, and a
 * box that is already ticked is not consent.
 *
 * The two payment modes are the builder's two, worded the same way. Automatic
 * payment needs a saved card, and rather than hiding the option behind a
 * payment-methods read this screen offers it and shows the server's own
 * refusal if there is no card — which names the fix ("add one, or choose to
 * pay by link") better than a greyed-out radio with a tooltip.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStorefront } from '@/app/storefront-context';
import { useToast } from '@/components/toast-context';
import { QuantityInput } from '@/components/QuantityInput';
import {
  Button,
  ButtonLink,
  Field,
  Input,
  LoadingState,
  Select,
} from '@/components/ui';
import { PlusIcon, TrashIcon } from '@/components/icons';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { clampToRules } from '@/lib/quantity-rules';
import { emptyCadenceDraft, noticeDaysFrom, recurrencePayload } from '@/lib/schedule-cadence';
import type { CadenceDraft } from '@/lib/schedule-cadence';
import { useI18n } from '@/i18n/i18n-context';
import type { AccountResponse, Address, PurchaseRules, ScheduleCreated } from '@/lib/types';
import { useDeliveryWindow } from '@/lib/delivery-window';
import { CadenceFields } from './CadenceFields';
import { ScheduleProductPicker } from './ScheduleProductPicker';
import type { PickedProduct } from './ScheduleProductPicker';

type PaymentMode = 'AUTO_PAY' | 'PAYMENT_LINK';

interface NewItem extends PickedProduct {
  quantity: number;
}

function rulesOf(item: NewItem): PurchaseRules {
  return {
    minOrderQty: item.minOrderQty,
    maxOrderQty: item.maxOrderQty,
    qtyIncrement: item.qtyIncrement,
    isRecurringEligible: true,
  };
}

export function NewSchedulePanel({
  onCreated,
  onDismiss,
}: {
  /** Called with the new plan's id, so the workspace can open it. */
  onCreated: (scheduleId: string) => void;
  onDismiss: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const { business, fulfilment } = useStorefront();
  const queryClient = useQueryClient();
  const toast = useToast();

  const addresses = useQuery({
    queryKey: ['addresses'],
    queryFn: () => api.get<{ addresses: Address[] }>('/account/addresses'),
  });

  const account = useQuery({
    queryKey: ['account-profile'],
    queryFn: () => api.get<AccountResponse>('/account/profile'),
  });

  const [name, setName] = useState('');
  const [cadence, setCadence] = useState<CadenceDraft>(() =>
    emptyCadenceDraft(business.timezone, noticeDaysFrom(fulfilment)),
  );
  const [items, setItems] = useState<NewItem[]>([]);
  const [addressId, setAddressId] = useState<string | null>(null);

  /*
   * The earliest first delivery this address will take.
   *
   * Asked of the server rather than counted here: the floor is measured on
   * the delivery address's own zone, which this screen does not know. See
   * `lib/delivery-window.ts`.
   */
  const deliveryWindow = useDeliveryWindow({
    shippingAddressId: addressId,
    timezone: cadence.timezone,
  });
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('PAYMENT_LINK');
  const [payerEmail, setPayerEmail] = useState('');
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [isPicking, setIsPicking] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Memoised, because it is a dependency of the effect below: a fresh array
  // every render would re-run that effect on every keystroke in this form.
  const usableAddresses = useMemo(
    () => (addresses.data?.addresses ?? []).filter((address) => address.archivedAt === null),
    [addresses.data],
  );

  // The customer's default delivery address, unless they have already picked
  // another. Only names an untouched field.
  useEffect(() => {
    if (addressId !== null || usableAddresses.length === 0) return;

    const preferred =
      usableAddresses.find((address) => address.isDefaultShipping) ?? usableAddresses[0];
    setAddressId(preferred?.id ?? null);
  }, [usableAddresses, addressId]);

  // Their own address for the payment link, unless they have typed another.
  useEffect(() => {
    const email = account.data?.profile.email;
    if (email === undefined) return;
    setPayerEmail((current) => (current === '' ? email : current));
  }, [account.data]);

  const create = useMutation({
    mutationFn: () =>
      api.post<ScheduleCreated>('/recurring-schedules', {
        name: name.trim(),
        ...recurrencePayload(cadence, { forUpdate: false }),
        paymentMode,
        // Required by the server for PAYMENT_LINK: somebody has to receive the
        // link, and guessing would send money requests to the wrong inbox.
        ...(paymentMode === 'PAYMENT_LINK' ? { payerEmail: payerEmail.trim() } : {}),
        shippingAddressId: addressId,
        items: items.map((item) => ({
          productId: item.productId,
          variantId: null,
          quantity: item.quantity,
        })),
        consentAccepted,
      }),
    onSuccess: async (result) => {
      setSubmitError(null);
      toast.success(t('scheduleCart.scheduleCreated'));
      await queryClient.invalidateQueries({ queryKey: ['schedules'] });
      onCreated(result.scheduleId);
    },
    onError: (error) => {
      setSubmitError(errorMessage(t, error, t('scheduleCart.couldNotCreate')));
    },
  });

  const addItem = (picked: PickedProduct): void => {
    const rules: PurchaseRules = {
      minOrderQty: picked.minOrderQty,
      maxOrderQty: picked.maxOrderQty,
      qtyIncrement: picked.qtyIncrement,
      isRecurringEligible: true,
    };

    setItems((current) =>
      current.some((item) => item.productId === picked.productId)
        ? current
        : [...current, { ...picked, quantity: clampToRules(picked.minOrderQty, rules) }],
    );
    setSubmitError(null);
    setIsPicking(false);

    // A name nobody typed, from the first product, so the plan is identifiable
    // in a list without asking for a label somebody would rather skip.
    setName((current) =>
      current === '' ? t('scheduleBuilder.repeatName', { product: picked.name }) : current,
    );
  };

  if (addresses.isPending) return <LoadingState label={t('scheduleCart.preparing')} />;

  // A schedule needs somewhere to deliver, and the server refuses one without
  // an address. Said here rather than at the end of a filled-in form.
  if (usableAddresses.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface p-6 shadow-card">
        <h2 className="text-title-sm text-ink">{t('scheduleCart.needAnAddressTitle')}</h2>
        <p className="mt-2 text-sm text-ink-muted">{t('scheduleCart.needAnAddressBody')}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <ButtonLink to="/account/addresses" variant="primary">
            {t('scheduleCart.addAnAddress')}
          </ButtonLink>
          <Button onClick={onDismiss}>{t('scheduleCart.notNow')}</Button>
        </div>
      </div>
    );
  }

  const canSubmit =
    name.trim().length > 0 &&
    items.length > 0 &&
    addressId !== null &&
    consentAccepted &&
    (paymentMode !== 'PAYMENT_LINK' || payerEmail.trim().length > 0);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-title-lg text-ink">{t('scheduleCart.newScheduleTitle')}</h2>
          <p className="mt-1 text-sm text-ink-muted">{t('scheduleCart.newScheduleBody')}</p>
        </div>
        <Button className="shrink-0" onClick={onDismiss}>
          {t('scheduleCart.discard')}
        </Button>
      </header>

      {/* --- What ------------------------------------------------------------ */}
      <section
        aria-labelledby="new-items-heading"
        className="rounded-lg border border-border bg-surface p-5 shadow-card"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 id="new-items-heading" className="text-title-sm text-ink">
            {t('scheduleCart.whatIsDelivered')}
          </h3>
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
        </div>

        {items.length === 0 ? (
          <p role="status" className="mt-4 text-sm text-ink-muted">
            {t('scheduleCart.noItemsYet')}
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-border-subtle">
            {items.map((item, index) => (
              <li
                key={item.productId}
                className="flex flex-wrap items-end gap-4 py-3.5 first:pt-1.5 sm:flex-nowrap"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-ink">{item.name}</p>
                  <p className="mt-0.5 font-mono text-xxs uppercase tracking-wide text-ink-subtle">
                    {item.sku}
                  </p>
                </div>

                <QuantityInput
                  value={item.quantity}
                  rules={rulesOf(item)}
                  ruleHint={false}
                  // Short label, product name in the steppers. See the note on
                  // the same control in `ScheduleEditor`.
                  label={t('cart.quantity')}
                  itemName={item.name}
                  onChange={(quantity) => {
                    setItems((current) =>
                      current.map((entry, at) =>
                        at === index ? { ...entry, quantity } : entry,
                      ),
                    );
                  }}
                />

                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t('scheduleCart.removeFromSchedule', { product: item.name })}
                  onClick={() => {
                    setItems((current) => current.filter((_entry, at) => at !== index));
                  }}
                >
                  <TrashIcon aria-hidden="true" className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* --- When ------------------------------------------------------------ */}
      <section
        aria-labelledby="new-cadence-heading"
        className="rounded-lg border border-border bg-surface p-5 shadow-card"
      >
        <h3 id="new-cadence-heading" className="text-title-sm text-ink">
          {t('scheduleCart.howOftenAndWhen')}
        </h3>

        <div className="mt-3">
          {/* The floor the API enforces, not the one this bundle can guess.
              Re-asked whenever the address or the plan's zone changes, which
              is exactly the recalculation the rule requires. */}
          <CadenceFields
            draft={cadence}
            onChange={setCadence}
            earliest={deliveryWindow?.earliest}
          />
        </div>
      </section>

      {/* --- Where and how it is paid for ------------------------------------ */}
      <section
        aria-labelledby="new-delivery-heading"
        className="rounded-lg border border-border bg-surface p-5 shadow-card"
      >
        <h3 id="new-delivery-heading" className="text-title-sm text-ink">
          {t('scheduleCart.deliveryAndPayment')}
        </h3>

        <div className="mt-3 space-y-4">
          <Field label={t('scheduleCart.deliverTo')}>
            {({ inputId }) => (
              <Select
                id={inputId}
                value={addressId ?? ''}
                onChange={(event) => {
                  setAddressId(event.target.value);
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

          <fieldset>
            <legend className="text-sm font-medium text-ink">
              {t('scheduleCart.howEachDeliveryIsPaid')}
            </legend>

            <div className="mt-2 space-y-2">
              <label className="flex items-start gap-2 text-sm text-ink">
                <input
                  type="radio"
                  name="newPaymentMode"
                  className="mt-0.5 h-4 w-4 border-border-strong text-brand"
                  checked={paymentMode === 'PAYMENT_LINK'}
                  onChange={() => {
                    setPaymentMode('PAYMENT_LINK');
                    setSubmitError(null);
                  }}
                />
                <span className="min-w-0">
                  {t('scheduleCart.payByLink')}
                  <span className="block text-xs text-ink-muted">
                    {t('scheduleCart.payByLinkHint')}
                  </span>
                </span>
              </label>

              <label className="flex items-start gap-2 text-sm text-ink">
                <input
                  type="radio"
                  name="newPaymentMode"
                  className="mt-0.5 h-4 w-4 border-border-strong text-brand"
                  checked={paymentMode === 'AUTO_PAY'}
                  onChange={() => {
                    setPaymentMode('AUTO_PAY');
                    setSubmitError(null);
                  }}
                />
                <span className="min-w-0">
                  {t('scheduleCart.payAutomatically')}
                  <span className="block text-xs text-ink-muted">
                    {t('scheduleCart.payAutomaticallyHint')}
                  </span>
                </span>
              </label>
            </div>
          </fieldset>

          {paymentMode === 'PAYMENT_LINK' && (
            <Field
              label={t('scheduleCart.sendTheLinkTo')}
              hint={t('scheduleCart.sendTheLinkToHint')}
            >
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  type="email"
                  value={payerEmail}
                  aria-describedby={describedBy}
                  onChange={(event) => {
                    setPayerEmail(event.target.value);
                    setSubmitError(null);
                  }}
                />
              )}
            </Field>
          )}

          <Field label={t('scheduleCart.scheduleName')} hint={t('scheduleCart.scheduleNameHint')}>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                value={name}
                maxLength={128}
                aria-describedby={describedBy}
                onChange={(event) => {
                  setName(event.target.value);
                  setSubmitError(null);
                }}
              />
            )}
          </Field>
        </div>
      </section>

      {/* --- Consent, and then the commitment -------------------------------- */}
      <div className="rounded-lg border border-border bg-surface p-5 shadow-card">
        {/* Never pre-ticked. The server refuses a schedule without consent,
            and a box that arrives already ticked is not consent. */}
        <label className="flex items-start gap-2.5 text-sm text-ink">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-border-strong text-brand"
            checked={consentAccepted}
            onChange={(event) => {
              setConsentAccepted(event.target.checked);
              setSubmitError(null);
            }}
          />
          <span className="min-w-0">{t('scheduleCart.consent')}</span>
        </label>

        {submitError !== null && (
          <p
            role="alert"
            className="mt-4 rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger"
          >
            {submitError}
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            variant="action"
            size="lg"
            disabled={!canSubmit}
            isLoading={create.isPending}
            onClick={() => {
              create.mutate();
            }}
          >
            {t('scheduleCart.createSchedule')}
          </Button>

          <p className="text-xs text-ink-muted">{t('scheduleCart.repricedEveryTime')}</p>
        </div>
      </div>

      <ScheduleProductPicker
        isOpen={isPicking}
        onClose={() => {
          setIsPicking(false);
        }}
        onPick={addItem}
        alreadyOn={items.map((item) => item.productId)}
      />
    </div>
  );
}

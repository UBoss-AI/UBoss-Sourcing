/**
 * The preorder request form.
 *
 * A modal rather than a page, because the buyer is looking at the product and
 * the decision is about the product - but every figure in it comes from the
 * server:
 *
 *   - the units, the minimum and the step come from the eligibility answer;
 *   - the earliest date is recomputed by the server for the chosen address
 *     (the route to Pune and the route to Rotterdam are different lead times);
 *   - the per-piece price, the band, the saving and the total come from
 *     `POST /preorders/preview`, re-asked whenever the request changes;
 *   - a 20-ft or 40-ft container holds the seller's VERIFIED number of pieces
 *     for this exact option, from the same answer. A size the seller has not
 *     configured is shown, disabled, with the reason - never as 0 pieces and
 *     never as an estimate - and Pieces always remains.
 *
 * So nothing here can promise what the submission will refuse. A refusal from
 * the preview is shown under the summary in the buyer's language, with its
 * figure - "Minimum preorder quantity is 1,000 pieces" - and the submit button
 * stays off until the preview is clean.
 *
 * Submitting charges nothing, and the form says so beside the button.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Modal } from '@/components/Modal';
import { DatePicker } from '@/components/DatePicker';
import {
  Badge,
  Button,
  ButtonLink,
  Field,
  Input,
  Select,
  Spinner,
  Textarea,
} from '@/components/ui';
import { useLocale } from '@/app/locale-context';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { api, newIdempotencyKey } from '@/lib/api';
import { formatIsoDate } from '@/lib/calendar-date';
import { errorMessage } from '@/lib/errors';
import { formatMoney, formatMoneyMinor, formatNumber } from '@/lib/format';
import {
  CONTAINER_SIZES,
  fetchEligibility,
  isContainerSize,
  openingQuantity,
  previewPreorder,
  submitPreorder,
  type ContainerOption,
  type Eligibility,
  type Preorder,
  type PreorderFormInput,
  type PreorderUnit,
} from '@/lib/preorders';
import type { Address } from '@/lib/types';

type Available = Extract<Eligibility, { available: true }>;

export interface PreorderDialogProps {
  productId: string;
  productName: string;
  imageUrl: string | null;
  variantId: string | null;
  variantName: string | null;
  eligibility: Available;
  defaultAddressId: string | null;
  /**
   * The pieces the buyer had typed on the product page, so the form opens on
   * the quantity they were looking at rather than the seller's minimum.
   */
  initialPieces?: number | undefined;
  /**
   * Figures from a UBOSS preorder proposal sent in a chat. They only fill the
   * form in: the buyer still reviews every field, accepts the preorder terms
   * and sends the request, and the supplier's answer is what binds anybody.
   */
  prefill?: { orderingUnit: PreorderUnit; unitQuantity: number; requestedDeliveryDate: string } | undefined;
  /** Told the request that was created, so a chat proposal can be linked to it. */
  onSubmitted?: ((preorder: Preorder) => void) | undefined;
  onClose: () => void;
}

const TRANSPORT = ['ANY', 'ROAD', 'SEA', 'AIR', 'RAIL'] as const;

/** Wait this long after the last keystroke before asking for a new preview. */
const PREVIEW_DELAY_MS = 350;

function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSettled(value);
    }, delay);
    return () => {
      window.clearTimeout(timer);
    };
  }, [value, delay]);
  return settled;
}

export function PreorderDialog({
  productId,
  productName,
  imageUrl,
  variantId,
  variantName,
  eligibility: initial,
  defaultAddressId,
  initialPieces,
  prefill,
  onSubmitted,
  onClose,
}: PreorderDialogProps): React.JSX.Element {
  const { t, intlLocale } = useI18n();
  const { currency: displayCurrency } = useLocale();

  const minimumUnit =
    initial.units.find((entry) => entry.unit === initial.moq.unit) ?? initial.units[0];

  const [unit, setUnit] = useState<PreorderUnit>(
    prefill?.orderingUnit ?? minimumUnit?.unit ?? 'PIECE',
  );
  const [quantityText, setQuantityText] = useState(() =>
    prefill === undefined
      ? String(openingQuantity(initial.moq, minimumUnit?.baseUnits ?? 1, initialPieces))
      : String(prefill.unitQuantity),
  );
  const [addressId, setAddressId] = useState<string>(defaultAddressId ?? '');
  const [date, setDate] = useState(prefill?.requestedDeliveryDate ?? '');
  const [warehouse, setWarehouse] = useState('');
  const [packaging, setPackaging] = useState<PreorderUnit | ''>('');
  const [transport, setTransport] = useState<(typeof TRANSPORT)[number]>('ANY');
  const [partial, setPartial] = useState(false);
  const [poReference, setPoReference] = useState('');
  const [notes, setNotes] = useState('');
  const [handling, setHandling] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [idempotencyKey] = useState(() => newIdempotencyKey());
  const [submitted, setSubmitted] = useState<Preorder | null>(null);

  const addresses = useQuery({
    queryKey: ['addresses'],
    queryFn: () => api.get<{ addresses: Address[] }>('/account/addresses'),
  });

  const shippingAddresses = useMemo(
    () =>
      (addresses.data?.addresses ?? []).filter(
        (address) => address.kind !== 'BILLING' && address.archivedAt === null,
      ),
    [addresses.data],
  );

  useEffect(() => {
    if (addressId === '' && shippingAddresses.length > 0) {
      setAddressId(
        (shippingAddresses.find((address) => address.isDefaultShipping) ?? shippingAddresses[0])
          ?.id ?? '',
      );
    }
  }, [addressId, shippingAddresses]);

  /*
   * The terms again, for the chosen address. The earliest date depends on
   * where it is going, and only the server knows the seller's transit times.
   */
  const forAddress = useQuery({
    queryKey: ['preorder', 'eligibility', productId, variantId ?? '', 'address', addressId],
    queryFn: () => fetchEligibility(productId, variantId, addressId),
    enabled: addressId !== '',
  });

  const terms: Available =
    forAddress.data?.eligibility.available === true ? forAddress.data.eligibility : initial;

  // Both container sizes, always - each available or not, with the reason.
  const containerOptions: ContainerOption[] = CONTAINER_SIZES.map(
    (size) =>
      terms.containerOptions?.find((option) => option.unit === size) ?? {
        unit: size,
        available: false,
        piecesPerContainer: null,
        cartonsPerContainer: null,
        piecesPerCarton: null,
        reason: 'NOT_CONFIGURED',
      },
  );
  const packageUnits = terms.units.filter(
    (entry) => entry.unit !== 'PIECE' && !isContainerSize(entry.unit),
  );
  const isContainer = isContainerSize(unit);
  const chosenContainer = isContainer
    ? (containerOptions.find((option) => option.unit === unit) ?? null)
    : null;

  /*
   * A unit that stops being available - the address changed the terms, or
   * the seller re-specified the loading - is never kept silently. The form
   * falls back to Pieces and says why, so another option's container size can
   * never ride along.
   */
  const [unitNotice, setUnitNotice] = useState(false);
  const unitStillOffered =
    unit === 'PIECE' ||
    (isContainer
      ? chosenContainer?.available === true
      : terms.units.some((entry) => entry.unit === unit));
  useEffect(() => {
    if (unitStillOffered) return;
    setUnit('PIECE');
    setQuantityText(String(openingQuantity(terms.moq, 1, initialPieces)));
    setUnitNotice(true);
  }, [unitStillOffered, terms.moq, initialPieces]);

  const chooseUnit = (next: PreorderUnit): void => {
    setUnitNotice(false);
    setUnit(next);
    // A count of pieces is not a count of containers: start each unit from a
    // quantity that means something in it rather than carrying the digits.
    if (isContainerSize(next)) setQuantityText('1');
    else {
      const size = terms.units.find((entry) => entry.unit === next)?.baseUnits ?? 1;
      setQuantityText(String(openingQuantity(terms.moq, size, initialPieces)));
    }
  };

  const unitSize = isContainer
    ? (chosenContainer?.piecesPerContainer ?? 0)
    : (terms.units.find((entry) => entry.unit === unit)?.baseUnits ?? 1);
  const unitQuantity = /^\d+$/.test(quantityText.trim()) ? Number(quantityText.trim()) : null;
  const baseUnits = unitQuantity === null || unitSize <= 0 ? null : unitQuantity * unitSize;
  const containersUnavailable = containerOptions.filter((option) => !option.available);
  const unitLabel = (value: PreorderUnit): string => t(`preorder.unit.${value}` as TranslationKey);

  const input: PreorderFormInput | null =
    unitQuantity === null ||
    unitQuantity <= 0 ||
    addressId === '' ||
    date === '' ||
    (isContainer && chosenContainer?.available !== true)
      ? null
      : {
          productId,
          variantId,
          offerId: terms.offerId,
          orderingUnit: unit,
          unitQuantity,
          requestedDeliveryDate: date,
          shippingAddressId: addressId,
          destinationWarehouseLabel: warehouse.trim() === '' ? null : warehouse.trim(),
          packagingPreference: packaging === '' ? null : packaging,
          transportPreference: transport,
          allowPartialDelivery: partial,
          purchaseOrderReference: poReference.trim() === '' ? null : poReference.trim(),
          customerNotes: notes.trim() === '' ? null : notes.trim(),
          handlingInstructions: handling.trim() === '' ? null : handling.trim(),
          acceptTerms: accepted,
          displayCurrency: displayCurrency === terms.currency ? null : displayCurrency,
        };

  const settled = useDebounced(input, PREVIEW_DELAY_MS);
  // The preview does not care whether the terms box is ticked.
  const previewKey = settled === null ? null : JSON.stringify({ ...settled, acceptTerms: false });

  const preview = useQuery({
    queryKey: ['preorder', 'preview', previewKey],
    queryFn: () => previewPreorder({ ...(settled as PreorderFormInput), acceptTerms: false }),
    enabled: settled !== null,
    retry: false,
    staleTime: 30_000,
  });

  const submit = useMutation({
    mutationFn: (payload: PreorderFormInput) => submitPreorder(payload, idempotencyKey),
    onSuccess: (preorder) => {
      setSubmitted(preorder);
      onSubmitted?.(preorder);
    },
  });

  // The refusal is written at the foot of a long, scrolling form. A buyer who
  // pressed Send from higher up would otherwise see nothing happen - so the
  // sentence is brought into view the moment it appears.
  const submitErrorRef = useRef<HTMLParagraphElement | null>(null);
  useEffect(() => {
    if (submit.isError) submitErrorRef.current?.scrollIntoView({ block: 'nearest' });
  }, [submit.isError]);

  const previewIsCurrent =
    settled !== null &&
    input !== null &&
    previewKey === JSON.stringify({ ...input, acceptTerms: false });
  const canSubmit =
    input !== null && accepted && previewIsCurrent && preview.isSuccess && !submit.isPending;

  const fmtDate = (iso: string): string => formatIsoDate(iso, intlLocale, { dateStyle: 'long' });

  if (submitted !== null) {
    return (
      <Modal
        isOpen
        onClose={onClose}
        title={t('preorder.sentTitle')}
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              {t('common.close')}
            </Button>
            <ButtonLink to={`/account/preorders/${submitted.id}`} variant="primary">
              {t('preorder.viewRequest')}
            </ButtonLink>
          </div>
        }
      >
        <div role="status" className="space-y-2 text-sm text-ink">
          <p>
            {t('preorder.sentBody', {
              number: submitted.requestNumber,
              seller: submitted.seller.name,
            })}
          </p>
          <p className="text-ink-muted">{t('preorder.nothingCharged')}</p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      size="lg"
      title={t('preorder.formTitle')}
      description={t('preorder.formDescription')}
      footer={
        <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-ink-muted">{t('preorder.nothingCharged')}</p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="action"
              disabled={!canSubmit}
              isLoading={submit.isPending}
              onClick={() => {
                if (input !== null) submit.mutate({ ...input, acceptTerms: true });
              }}
            >
              {t('preorder.send')}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-5">
        {prefill !== undefined && (
          <p
            role="note"
            className="rounded-md border border-brand/30 bg-brand-soft px-3 py-2 text-sm text-ink"
          >
            {t('preorderChat.proposal.prefilledNotice')}
          </p>
        )}
        {/* What is being asked about. */}
        <div className="flex items-start gap-3 rounded-md border border-border-subtle bg-surface-sunken p-3">
          {imageUrl !== null && (
            <img
              src={imageUrl}
              alt=""
              className="size-16 shrink-0 rounded object-cover"
              loading="lazy"
            />
          )}
          <div className="min-w-0 text-sm">
            <p className="font-semibold text-ink">{productName}</p>
            {variantName !== null && <p className="text-ink-muted">{variantName}</p>}
            <p className="mt-1 text-ink-muted">
              {t('preorder.soldBy', { seller: terms.sellerName })}
            </p>
          </div>
        </div>

        {/* Quantity */}
        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="sr-only">{t('preorder.quantityLegend')}</legend>
          <Field
            label={t('preorder.orderIn')}
            {...(containersUnavailable.length > 0
              ? {
                  hint:
                    containersUnavailable.length === CONTAINER_SIZES.length
                      ? containersUnavailable.every((option) => option.reason === 'NOT_OFFERED')
                        ? t('preorder.containerNotOffered')
                        : t('preorder.containerUnavailable')
                      : t('preorder.containerSizeUnavailable', {
                          unit: unitLabel(containersUnavailable[0]?.unit ?? 'CONTAINER_20_FT'),
                        }),
                }
              : {})}
          >
            {({ inputId, describedBy }) => (
              <Select
                id={inputId}
                aria-describedby={describedBy}
                value={unit}
                onChange={(event) => {
                  chooseUnit(event.currentTarget.value as PreorderUnit);
                }}
              >
                <option value="PIECE">{t('preorder.unit.PIECE')}</option>
                {containerOptions.map((option) => (
                  <option key={option.unit} value={option.unit} disabled={!option.available}>
                    {option.available
                      ? unitLabel(option.unit)
                      : t('preorder.unitNotAvailable', { unit: unitLabel(option.unit) })}
                  </option>
                ))}
                {packageUnits.map((entry) => (
                  <option key={entry.unit} value={entry.unit}>
                    {t('preorder.unitOf', {
                      unit: unitLabel(entry.unit),
                      pieces: formatNumber(entry.baseUnits),
                    })}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field
            label={isContainer ? t('preorder.numberOfContainers') : t('preorder.quantity')}
            {...(isContainer
              ? { hint: t('preorder.containersWholeOnly') }
              : baseUnits !== null && unit !== 'PIECE'
                ? { hint: t('preorder.equalsPieces', { pieces: formatNumber(baseUnits) }) }
                : {})}
          >
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                inputMode="numeric"
                pattern="[0-9]*"
                value={quantityText}
                onChange={(event) => {
                  // Whole numbers only - a container count has no fraction.
                  setQuantityText(event.currentTarget.value.replace(/[^\d]/g, ''));
                }}
              />
            )}
          </Field>

          {unitNotice && (
            <p role="status" className="text-xs text-warning sm:col-span-2">
              {t('preorder.unitSwitchedToPieces')}
            </p>
          )}

          {isContainer && chosenContainer?.available === true && chosenContainer.piecesPerContainer !== null && (
            <div
              role="status"
              aria-live="polite"
              className="space-y-0.5 rounded-md border border-brand/30 bg-brand-soft px-3 py-2 text-sm text-ink sm:col-span-2"
            >
              <p>
                {t('preorder.onePerContainer', {
                  unit: unitLabel(chosenContainer.unit),
                  pieces: formatNumber(chosenContainer.piecesPerContainer),
                })}
              </p>
              {/* The total only once there is more than one: at one container
                  it would repeat the line above word for word. */}
              {unitQuantity !== null && unitQuantity > 1 && baseUnits !== null && (
                <p className="font-semibold">
                  {t('preorder.containersTotal', {
                    containers: formatNumber(unitQuantity),
                    unit: unitLabel(chosenContainer.unit),
                    pieces: formatNumber(baseUnits),
                  })}
                </p>
              )}
              {chosenContainer.cartonsPerContainer !== null && chosenContainer.piecesPerCarton !== null && (
                <p className="text-xs text-ink-muted">
                  {t('preorder.cartonsPerContainerLine', {
                    cartons: formatNumber(chosenContainer.cartonsPerContainer),
                    pieces: formatNumber(chosenContainer.piecesPerCarton),
                  })}
                </p>
              )}
            </div>
          )}

          <p className="text-xs text-ink-muted sm:col-span-2">
            {t('preorder.minimumRule', {
              minimum: formatNumber(terms.moq.minimumBaseUnits),
              increment: formatNumber(terms.moq.incrementBaseUnits),
            })}
            {terms.moq.maximumBaseUnits !== null &&
              ` ${t('preorder.maximumRule', { maximum: formatNumber(terms.moq.maximumBaseUnits) })}`}
          </p>
        </fieldset>

        {/* Where and when */}
        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="sr-only">{t('preorder.deliveryLegend')}</legend>
          <Field label={t('preorder.deliveryAddress')}>
            {({ inputId }) =>
              addresses.isPending ? (
                <Spinner />
              ) : shippingAddresses.length === 0 ? (
                <p className="text-sm text-ink-muted">
                  {t('preorder.noAddress')}{' '}
                  <Link to="/account/addresses" className="font-medium text-brand underline">
                    {t('preorder.addAddress')}
                  </Link>
                </p>
              ) : (
                <Select
                  id={inputId}
                  value={addressId}
                  onChange={(event) => {
                    setAddressId(event.currentTarget.value);
                  }}
                >
                  {shippingAddresses.map((address) => (
                    <option key={address.id} value={address.id}>
                      {[address.label, address.line1, address.city, address.country]
                        .filter(Boolean)
                        .join(', ')}
                    </option>
                  ))}
                </Select>
              )
            }
          </Field>

          <Field
            label={t('preorder.deliveryDate')}
            hint={t('preorder.earliestHint', { date: fmtDate(terms.window.earliest) })}
          >
            {({ inputId, describedBy }) => (
              <DatePicker
                id={inputId}
                describedBy={describedBy}
                label={t('preorder.deliveryDate')}
                value={date}
                min={terms.window.earliest}
                {...(terms.window.latest === null ? {} : { max: terms.window.latest })}
                onChange={setDate}
              />
            )}
          </Field>

          <p className="text-xs text-ink-muted sm:col-span-2">
            {t(`preorder.earliestBecause.${terms.window.decidedBy}` as TranslationKey)}
            {!terms.window.hasPublishedTransit && ` ${t('preorder.transitNotPublished')}`}
          </p>

          <Field label={t('preorder.destinationWarehouse')} hint={t('preorder.optional')}>
            {({ inputId }) => (
              <Input
                id={inputId}
                maxLength={160}
                value={warehouse}
                onChange={(event) => {
                  setWarehouse(event.currentTarget.value);
                }}
              />
            )}
          </Field>

          <Field label={t('preorder.transport')}>
            {({ inputId }) => (
              <Select
                id={inputId}
                value={transport}
                onChange={(event) => {
                  setTransport(event.currentTarget.value as (typeof TRANSPORT)[number]);
                }}
              >
                {TRANSPORT.map((mode) => (
                  <option key={mode} value={mode}>
                    {t(`preorder.transportMode.${mode}` as TranslationKey)}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field label={t('preorder.packagingPreference')} hint={t('preorder.optional')}>
            {({ inputId }) => (
              <Select
                id={inputId}
                value={packaging}
                onChange={(event) => {
                  setPackaging(event.currentTarget.value as PreorderUnit | '');
                }}
              >
                <option value="">{t('preorder.noPreference')}</option>
                {terms.units.map((entry) => (
                  <option key={entry.unit} value={entry.unit}>
                    {t(`preorder.unit.${entry.unit}` as TranslationKey)}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <label className="flex items-start gap-2 self-end text-sm text-ink sm:pb-2">
            <input
              type="checkbox"
              className="mt-0.5 size-4 rounded border-border"
              checked={partial}
              onChange={(event) => {
                setPartial(event.currentTarget.checked);
              }}
            />
            <span>{t('preorder.allowPartial')}</span>
          </label>
        </fieldset>

        {/* Paperwork */}
        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="sr-only">{t('preorder.referencesLegend')}</legend>
          <Field label={t('preorder.poReference')} hint={t('preorder.optional')}>
            {({ inputId }) => (
              <Input
                id={inputId}
                maxLength={64}
                value={poReference}
                onChange={(event) => {
                  setPoReference(event.currentTarget.value);
                }}
              />
            )}
          </Field>
          <Field label={t('preorder.handling')} hint={t('preorder.optional')}>
            {({ inputId }) => (
              <Input
                id={inputId}
                maxLength={1000}
                value={handling}
                onChange={(event) => {
                  setHandling(event.currentTarget.value);
                }}
              />
            )}
          </Field>
          <div className="sm:col-span-2">
            <Field label={t('preorder.notes')} hint={t('preorder.optional')}>
              {({ inputId }) => (
                <Textarea
                  id={inputId}
                  rows={3}
                  maxLength={2000}
                  value={notes}
                  onChange={(event) => {
                    setNotes(event.currentTarget.value);
                  }}
                />
              )}
            </Field>
          </div>
        </fieldset>

        {/* The server's figures */}
        <section
          aria-live="polite"
          aria-busy={preview.isFetching}
          className="rounded-md border border-border bg-surface p-4"
        >
          <h3 className="text-sm font-semibold text-ink">{t('preorder.summary')}</h3>

          {input === null ? (
            <p className="mt-2 text-sm text-ink-muted">{t('preorder.fillToSeePrice')}</p>
          ) : preview.isError ? (
            <p role="alert" className="mt-2 text-sm text-danger">
              {errorMessage(t, preview.error)}
            </p>
          ) : preview.data === undefined || !previewIsCurrent ? (
            <div className="mt-2 flex items-center gap-2 text-sm text-ink-muted">
              <Spinner />
              {t('preorder.checking')}
            </div>
          ) : (
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              {preview.data.container !== null && (
                <>
                  <dt className="text-ink-muted">{t('preorder.order')}</dt>
                  <dd className="text-right font-medium tabular-nums text-ink">
                    {t('preorder.containerCountLine', {
                      containers: formatNumber(preview.data.container.containers),
                      unit: unitLabel(preview.data.container.unit),
                    })}
                  </dd>
                  <dt className="text-ink-muted">{t('preorder.piecesPerContainer')}</dt>
                  <dd className="text-right font-medium tabular-nums text-ink">
                    {formatNumber(preview.data.container.piecesPerContainer)}
                  </dd>
                </>
              )}
              <dt className="text-ink-muted">
                {preview.data.container !== null ? t('preorder.totalPieces') : t('preorder.pieces')}
              </dt>
              <dd className="text-right font-medium tabular-nums text-ink">
                {formatNumber(preview.data.baseUnits)}
              </dd>

              {preview.data.unitPrice === null ? (
                <>
                  <dt className="text-ink-muted">{t('preorder.perPiece')}</dt>
                  <dd className="text-right text-ink">{t('preorder.sellerWillQuote')}</dd>
                </>
              ) : (
                <>
                  <dt className="text-ink-muted">{t('preorder.perPiece')}</dt>
                  <dd className="text-right font-medium tabular-nums text-ink">
                    {formatMoney(preview.data.unitPrice)}
                    {preview.data.appliedTierMinBaseUnits !== null && (
                      <Badge tone="success">
                        {t('preorder.bandFrom', {
                          pieces: formatNumber(preview.data.appliedTierMinBaseUnits),
                        })}
                      </Badge>
                    )}
                  </dd>

                  {preview.data.savingPerPiece !== null && (
                    <>
                      <dt className="text-ink-muted">{t('preorder.savingPerPiece')}</dt>
                      <dd className="text-right tabular-nums text-success">
                        {t('preorder.savingAgainstList', {
                          saving: formatMoney(preview.data.savingPerPiece),
                          list: formatMoney(preview.data.listUnitPrice),
                        })}
                      </dd>
                    </>
                  )}

                  <dt className="text-ink-muted">{t('preorder.productSubtotal')}</dt>
                  <dd className="text-right font-medium tabular-nums text-ink">
                    {formatMoney(preview.data.goodsTotal)}
                  </dd>

                  <dt className="text-ink-muted">{t('preorder.estimatedLogistics')}</dt>
                  <dd className="text-right text-ink">{t('preorder.toBeConfirmed')}</dd>

                  <dt className="font-semibold text-ink">{t('preorder.estimatedTotal')}</dt>
                  <dd className="text-right text-base font-semibold tabular-nums text-ink">
                    {t('preorder.plusLogistics', { amount: formatMoney(preview.data.goodsTotal) })}
                  </dd>

                  {preview.data.approximate !== null && (
                    <dd className="col-span-2 text-right text-xs text-ink-muted">
                      {t('preorder.approximately', {
                        amount: formatMoney(preview.data.approximate.goodsTotal),
                        rate: preview.data.approximate.rate,
                        date: formatIsoDate(
                          preview.data.approximate.rateAsOf.slice(0, 10),
                          intlLocale,
                        ),
                      })}
                    </dd>
                  )}
                </>
              )}
            </dl>
          )}

          {preview.data !== undefined && previewIsCurrent && !preview.data.availability.sufficient && (
            <div
              role="status"
              className="mt-3 rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-ink"
            >
              <p className="font-semibold">{t('preorder.shortfallTitle')}</p>
              <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5">
                <dt className="text-ink-muted">{t('preorder.requestedQuantity')}</dt>
                <dd className="text-right tabular-nums">
                  {t('preorder.piecesCount', { pieces: formatNumber(preview.data.availability.requested) })}
                </dd>
                <dt className="text-ink-muted">{t('preorder.availableQuantity')}</dt>
                <dd className="text-right tabular-nums">
                  {t('preorder.piecesCount', { pieces: formatNumber(preview.data.availability.availableNow) })}
                </dd>
                <dt className="text-ink-muted">{t('preorder.remainingQuantity')}</dt>
                <dd className="text-right tabular-nums">
                  {t('preorder.piecesCount', { pieces: formatNumber(preview.data.availability.remaining) })}
                </dd>
              </dl>
              <p className="mt-1 text-xs text-ink-muted">{t('preorder.shortfallBody')}</p>
            </div>
          )}

          <p className="mt-3 text-xs text-ink-muted">{t('preorder.estimateNote')}</p>
          {preview.data !== undefined && preview.data.instantStockBaseUnits > 0 && (
            <p className="mt-1 text-xs text-ink-muted">
              {t('preorder.instantStock', {
                pieces: formatNumber(preview.data.instantStockBaseUnits),
              })}
            </p>
          )}
          {terms.pricingMode === 'FIXED' && terms.tiers.length > 0 && (
            <details className="mt-2 text-xs text-ink-muted">
              <summary className="cursor-pointer select-none">{t('preorder.seeBands')}</summary>
              <ul className="mt-1 space-y-0.5">
                {terms.tiers.map((tier) => (
                  <li key={tier.minBaseUnits}>
                    {t('preorder.bandLine', {
                      pieces: formatNumber(tier.minBaseUnits),
                      price: formatMoneyMinor(tier.unitPriceMinor, terms.currency),
                    })}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>

        {(terms.cancellationTerms !== null || terms.specialInstructions !== null) && (
          <div className="space-y-1 rounded-md bg-surface-sunken p-3 text-xs text-ink-muted">
            {terms.specialInstructions !== null && <p>{terms.specialInstructions}</p>}
            {terms.cancellationTerms !== null && (
              <p>
                <span className="font-medium text-ink">{t('preorder.cancellationTerms')}</span>{' '}
                {terms.cancellationTerms}
              </p>
            )}
          </div>
        )}

        <label className="flex items-start gap-2 text-sm text-ink">
          <input
            type="checkbox"
            className="mt-0.5 size-4 rounded border-border"
            checked={accepted}
            onChange={(event) => {
              setAccepted(event.currentTarget.checked);
            }}
          />
          <span>{t('preorder.acceptTerms', { seller: terms.sellerName })}</span>
        </label>

        {submit.isError && (
          <p
            ref={submitErrorRef}
            role="alert"
            className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger"
          >
            {errorMessage(t, submit.error)}
          </p>
        )}
      </div>
    </Modal>
  );
}

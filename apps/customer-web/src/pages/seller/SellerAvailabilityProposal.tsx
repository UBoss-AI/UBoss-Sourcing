/**
 * Seller Hub: answering a preorder for more than is available.
 *
 * Two answers, the seller's choice:
 *
 *   - the COMPLETE quantity on one revised, committed date; or
 *   - a SPLIT delivery: the stock available now first, the rest on later dates.
 *
 * Nothing here decides whether a proposal is valid or what it costs. Every
 * change is sent to the server's preview, which checks it against LIVE stock
 * with the same rules the send is held to, and returns the schedule with its
 * container equivalents, the stock it would hold and the full price with tax
 * and delivery. The Send button stays off until that preview is clean and
 * current, so a seller cannot send what the server would refuse.
 *
 * The buyer's quantity is never editable here: a proposal answers the request,
 * it does not change it. Closing a form with changes in it asks first.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { DatePicker } from '@/components/DatePicker';
import { Modal } from '@/components/Modal';
import { ContainerEquivalent } from '@/components/preorder/PreorderParts';
import { Badge, Button, Field, Input, Select, Spinner, Textarea } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { addDays, formatIsoDate, todayIso } from '@/lib/calendar-date';
import { errorMessage } from '@/lib/errors';
import {
  currencyExponent,
  formatMoney,
  formatNumber,
  majorToMinor,
  minorToMajor,
} from '@/lib/format';
import {
  previewAvailabilityProposal,
  sendAvailabilityProposal,
  type AvailabilityProposalBody,
  type Preorder,
  type ProposalProblem,
} from '@/lib/preorders';

type Kind = AvailabilityProposalBody['kind'];

interface Shipment {
  date: string;
  pieces: string;
}

/** Wait this long after the last keystroke before asking the server. */
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

function problemText(
  t: ReturnType<typeof useI18n>['t'],
  intlLocale: string,
  problem: ProposalProblem,
): string {
  const meta = problem.meta ?? {};
  const count = (key: string): string =>
    typeof meta[key] === 'number' ? formatNumber(meta[key]) : '';
  const earliest =
    typeof meta['earliest'] === 'string'
      ? formatIsoDate(meta['earliest'], intlLocale, { dateStyle: 'long' })
      : '';
  const key = `sellerPreorders.problem.${problem.code}` as TranslationKey;
  const text = t(key, {
    earliest,
    sum: count('sum'),
    total: count('total'),
    available: count('availableToPromise'),
    hours: count('maxHours'),
  });
  // A code this build has no sentence for falls back to the server's own.
  return text === key ? problem.message : text;
}

export function AvailabilityProposalDialog({
  preorder,
  locations,
  onClose,
  onDone,
}: {
  preorder: Preorder;
  locations: { id: string; name: string; code: string }[];
  onClose: () => void;
  onDone: (preorder: Preorder) => void;
}): React.JSX.Element {
  const { t, intlLocale } = useI18n();
  const exponent = currencyExponent(preorder.currency);
  const total = preorder.quantity.baseUnits;
  const available = preorder.availability?.live?.availableToPromise ?? 0;
  const firstDate = preorder.requestedDeliveryDate;
  const laterDate = addDays(firstDate, 14);

  const initialPrice =
    preorder.indicative.unitPrice !== null
      ? minorToMajor(preorder.indicative.unitPrice.minor, exponent)
      : preorder.currentOffer !== null
        ? minorToMajor(preorder.currentOffer.unitPrice.minor, exponent)
        : '';
  const defaultExpiry = new Date(Date.now() + 72 * 3_600_000);

  const initial = useMemo(
    (): {
      kind: Kind;
      price: string;
      freight: string;
      revisedDate: string;
      reserve: boolean;
      shipments: Shipment[];
      expiryDate: string;
      expiryTime: string;
      location: string;
      note: string;
    } => ({
      kind: available > 0 && available < total ? 'SPLIT_DELIVERY' : 'FULL_ON_REVISED_DATE',
      price: initialPrice,
      freight: '0',
      revisedDate: laterDate,
      reserve: true,
      shipments: [
        { date: firstDate, pieces: String(Math.min(available, total)) },
        { date: laterDate, pieces: String(Math.max(0, total - available)) },
      ] as Shipment[],
      expiryDate: defaultExpiry.toISOString().slice(0, 10),
      expiryTime: defaultExpiry.toTimeString().slice(0, 5),
      location: '',
      note: '',
    }),
    // The starting point is fixed when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const [form, setForm] = useState(initial);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  const update = <K extends keyof typeof form>(key: K, value: (typeof form)[K]): void => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const priceMinor = majorToMinor(form.price, exponent);
  const freightMinor = majorToMinor(form.freight, exponent);
  const expiresAt = new Date(`${form.expiryDate}T${form.expiryTime || '00:00'}`);

  const body: AvailabilityProposalBody | null =
    priceMinor === null || freightMinor === null || Number.isNaN(expiresAt.getTime())
      ? null
      : {
          kind: form.kind,
          unitPriceMinor: priceMinor,
          freightMinor,
          revisedDate: form.kind === 'FULL_ON_REVISED_DATE' ? form.revisedDate : null,
          reserveAvailableStock: form.reserve,
          installments:
            form.kind === 'SPLIT_DELIVERY'
              ? form.shipments.map((row) => ({
                  date: row.date,
                  baseUnits: /^\d+$/.test(row.pieces) ? Number(row.pieces) : 0,
                }))
              : null,
          expiresAt: expiresAt.toISOString(),
          originLocationId: form.location === '' ? null : form.location,
          note: form.note.trim() === '' ? null : form.note.trim(),
          expectedVersion: preorder.version,
        };

  const settled = useDebounced(body, PREVIEW_DELAY_MS);
  const settledKey = settled === null ? null : JSON.stringify(settled);
  const preview = useQuery({
    queryKey: ['seller', 'preorder', preorder.id, 'proposal-preview', settledKey],
    queryFn: () => previewAvailabilityProposal(preorder.id, settled as AvailabilityProposalBody),
    enabled: settled !== null,
    retry: false,
  });
  const current = body !== null && settledKey === JSON.stringify(body);

  const send = useMutation({
    mutationFn: () => sendAvailabilityProposal(preorder.id, body as AvailabilityProposalBody),
    onSuccess: onDone,
  });

  const tryClose = (): void => {
    if (dirty && !send.isSuccess) setConfirmDiscard(true);
    else onClose();
  };

  const problemsFor = (prefix: string): ProposalProblem[] =>
    preview.data?.problems.filter((problem) => problem.field.startsWith(prefix)) ?? [];
  const earliest = preview.data?.earliestCommitDate ?? addDays(todayIso(preorder.timezone), 1);
  const shipmentSum = form.shipments.reduce(
    (sum, row) => sum + (/^\d+$/.test(row.pieces) ? Number(row.pieces) : 0),
    0,
  );
  const canSend = body !== null && current && preview.data?.ok === true && !send.isPending;

  return (
    <>
      <Modal
        isOpen
        onClose={tryClose}
        size="lg"
        title={t('sellerPreorders.proposeSchedule')}
        description={t('sellerPreorders.proposeBody')}
        footer={
          <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-ink-muted">{t('sellerPreorders.noCharge')}</p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={tryClose}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="action"
                disabled={!canSend}
                isLoading={send.isPending}
                onClick={() => {
                  send.mutate();
                }}
              >
                {t('sellerPreorders.sendProposal')}
              </Button>
            </div>
          </div>
        }
      >
        <div className="space-y-5">
          {/* The two answers, as a radio group a keyboard can reach. */}
          <fieldset>
            <legend className="text-sm font-medium text-ink">
              {t('sellerPreorders.yourAnswer')}
            </legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {(['FULL_ON_REVISED_DATE', 'SPLIT_DELIVERY'] as const).map((kind) => (
                <label
                  key={kind}
                  className={
                    form.kind === kind
                      ? 'flex cursor-pointer gap-2 rounded-md border-2 border-brand bg-brand-soft p-3'
                      : 'flex cursor-pointer gap-2 rounded-md border border-border bg-surface p-3'
                  }
                >
                  <input
                    type="radio"
                    name="proposal-kind"
                    className="mt-1"
                    checked={form.kind === kind}
                    onChange={() => {
                      update('kind', kind);
                    }}
                  />
                  <span>
                    <span className="block text-sm font-semibold text-ink">
                      {t(
                        kind === 'SPLIT_DELIVERY'
                          ? 'sellerPreorders.optionSplit'
                          : 'sellerPreorders.optionFull',
                      )}
                    </span>
                    <span className="block text-xs text-ink-muted">
                      {t(
                        kind === 'SPLIT_DELIVERY'
                          ? 'sellerPreorders.optionSplitHint'
                          : 'sellerPreorders.optionFullHint',
                      )}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <p className="text-sm text-ink">
            {available >= total
              ? t('sellerPreorders.sufficientLine', { requested: formatNumber(total) })
              : t('sellerPreorders.shortfallLine', {
                  available: formatNumber(available),
                  requested: formatNumber(total),
                  remaining: formatNumber(total - available),
                })}
          </p>

          {form.kind === 'FULL_ON_REVISED_DATE' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('sellerPreorders.revisedDate', { pieces: formatNumber(total) })}>
                {({ inputId }) => (
                  <DatePicker
                    id={inputId}
                    label={t('sellerPreorders.revisedDate', { pieces: formatNumber(total) })}
                    value={form.revisedDate}
                    min={earliest}
                    onChange={(value) => {
                      update('revisedDate', value);
                    }}
                  />
                )}
              </Field>
              <label className="flex items-start gap-2 self-end text-sm text-ink sm:pb-2">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 rounded border-border"
                  checked={form.reserve}
                  disabled={available <= 0}
                  onChange={(event) => {
                    update('reserve', event.currentTarget.checked);
                  }}
                />
                <span>{t('sellerPreorders.reserveNow')}</span>
              </label>
              {problemsFor('revisedDate').map((problem) => (
                <p key={problem.code} role="alert" className="text-xs text-danger sm:col-span-2">
                  {problemText(t, intlLocale, problem)}
                </p>
              ))}
            </div>
          ) : (
            <fieldset className="space-y-2">
              <legend className="sr-only">{t('preorder.schedule')}</legend>
              {form.shipments.map((row, index) => {
                const problems = problemsFor(`installments.${String(index)}`);
                return (
                  <div
                    key={index}
                    className={
                      problems.length > 0
                        ? 'rounded-md border border-danger/40 p-3'
                        : 'rounded-md border border-border-subtle p-3'
                    }
                  >
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-ink">
                        {t('sellerPreorders.shipment', { n: String(index + 1) })}
                      </span>
                      <Badge tone={index === 0 ? 'success' : 'operational'}>
                        {t(
                          index === 0
                            ? 'preorder.source.AVAILABLE_STOCK'
                            : 'preorder.source.FUTURE_SUPPLY',
                        )}
                      </Badge>
                    </div>
                    <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
                      <Field label={t('sellerPreorders.splitPieces')}>
                        {({ inputId }) => (
                          <Input
                            id={inputId}
                            inputMode="numeric"
                            value={row.pieces}
                            onChange={(event) => {
                              const value = event.currentTarget.value.replace(/[^\d]/g, '');
                              update(
                                'shipments',
                                form.shipments.map((entry, at) =>
                                  at === index ? { ...entry, pieces: value } : entry,
                                ),
                              );
                            }}
                          />
                        )}
                      </Field>
                      <Field label={t('sellerPreorders.shipmentDate')}>
                        {({ inputId }) => (
                          <DatePicker
                            id={inputId}
                            label={t('sellerPreorders.shipmentDate')}
                            value={row.date}
                            min={earliest}
                            onChange={(value) => {
                              update(
                                'shipments',
                                form.shipments.map((entry, at) =>
                                  at === index ? { ...entry, date: value } : entry,
                                ),
                              );
                            }}
                          />
                        )}
                      </Field>
                      {form.shipments.length > 2 && (
                        <Button
                          variant="ghost"
                          onClick={() => {
                            update(
                              'shipments',
                              form.shipments.filter((_, at) => at !== index),
                            );
                          }}
                        >
                          {t('sellerPreorders.remove')}
                        </Button>
                      )}
                    </div>
                    {problems.map((problem) => (
                      <p
                        key={`${problem.field}-${problem.code}`}
                        role="alert"
                        className="mt-1 text-xs text-danger"
                      >
                        {problemText(t, intlLocale, problem)}
                      </p>
                    ))}
                  </div>
                );
              })}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const last = form.shipments.at(-1)?.date ?? laterDate;
                    update('shipments', [
                      ...form.shipments,
                      { date: addDays(last, 7), pieces: '' },
                    ]);
                  }}
                >
                  {t('sellerPreorders.addShipment')}
                </Button>
                <p
                  className={
                    shipmentSum === total
                      ? 'text-xs text-ink-muted'
                      : 'text-xs font-medium text-danger'
                  }
                >
                  {t('sellerPreorders.splitSum', {
                    sum: formatNumber(shipmentSum),
                    total: formatNumber(total),
                  })}
                </p>
              </div>
            </fieldset>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('sellerPreorders.pricePerPiece', { currency: preorder.currency })}>
              {({ inputId }) => (
                <Input
                  id={inputId}
                  inputMode="decimal"
                  value={form.price}
                  onChange={(event) => {
                    update('price', event.currentTarget.value);
                  }}
                />
              )}
            </Field>
            <Field
              label={t('sellerPreorders.freight', { currency: preorder.currency })}
              hint={t('sellerPreorders.freightHint')}
            >
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  inputMode="decimal"
                  value={form.freight}
                  onChange={(event) => {
                    update('freight', event.currentTarget.value);
                  }}
                />
              )}
            </Field>
            <Field label={t('sellerPreorders.expiryDate')}>
              {({ inputId }) => (
                <DatePicker
                  id={inputId}
                  label={t('sellerPreorders.expiryDate')}
                  value={form.expiryDate}
                  min={todayIso(Intl.DateTimeFormat().resolvedOptions().timeZone)}
                  onChange={(value) => {
                    update('expiryDate', value);
                  }}
                />
              )}
            </Field>
            <Field label={t('sellerPreorders.expiryTime')}>
              {({ inputId }) => (
                <Input
                  id={inputId}
                  type="time"
                  value={form.expiryTime}
                  onChange={(event) => {
                    update('expiryTime', event.currentTarget.value);
                  }}
                />
              )}
            </Field>
            {problemsFor('expiresAt').map((problem) => (
              <p key={problem.code} role="alert" className="text-xs text-danger sm:col-span-2">
                {problemText(t, intlLocale, problem)}
              </p>
            ))}
            {problemsFor('unitPriceMinor').map((problem) => (
              <p key={problem.code} role="alert" className="text-xs text-danger sm:col-span-2">
                {problemText(t, intlLocale, problem)}
              </p>
            ))}
            <Field label={t('sellerPreorders.madeAt')}>
              {({ inputId }) => (
                <Select
                  id={inputId}
                  value={form.location}
                  onChange={(event) => {
                    update('location', event.currentTarget.value);
                  }}
                >
                  <option value="">{t('sellerPreorders.decideLater')}</option>
                  {locations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name} ({location.code})
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <div className="sm:col-span-2">
              <Field label={t('sellerPreorders.noteToBuyer')}>
                {({ inputId }) => (
                  <Textarea
                    id={inputId}
                    rows={2}
                    maxLength={2000}
                    value={form.note}
                    onChange={(event) => {
                      update('note', event.currentTarget.value);
                    }}
                  />
                )}
              </Field>
            </div>
          </div>

          {/* What the server says the buyer will be sent. */}
          <section
            aria-live="polite"
            aria-busy={preview.isFetching}
            className="rounded-md border border-border bg-surface-sunken p-4"
          >
            <h3 className="text-sm font-semibold text-ink">{t('sellerPreorders.previewTitle')}</h3>
            {preview.isError ? (
              <p role="alert" className="mt-2 text-sm text-danger">
                {errorMessage(t, preview.error)}
              </p>
            ) : preview.data === undefined || !current ? (
              <p className="mt-2 flex items-center gap-2 text-sm text-ink-muted">
                <Spinner />
                {t('sellerPreorders.checking')}
              </p>
            ) : (
              <div className="mt-2 space-y-3 text-sm">
                {preview.data.installments.length > 0 && (
                  <ol className="space-y-1">
                    {preview.data.installments.map((part) => (
                      <li
                        key={part.sequence}
                        className="flex flex-wrap items-baseline justify-between gap-2"
                      >
                        <span className="text-ink">
                          {t('preorder.shipmentN', { n: String(part.sequence) })}:{' '}
                          {t('preorder.shipmentLine', {
                            pieces: formatNumber(part.baseUnits),
                            date: formatIsoDate(part.date, intlLocale, { dateStyle: 'medium' }),
                          })}
                        </span>
                        <ContainerEquivalent equivalent={part.quantityInOrderedUnit} />
                      </li>
                    ))}
                  </ol>
                )}
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                  <dt className="text-ink-muted">{t('sellerPreorders.stockHeld')}</dt>
                  <dd className="text-right tabular-nums text-ink">
                    {preview.data.stockAllocationBaseUnits === null
                      ? '—'
                      : t('preorder.piecesCount', {
                          pieces: formatNumber(preview.data.stockAllocationBaseUnits),
                        })}
                  </dd>
                  {preview.data.quote !== null && 'grandTotal' in preview.data.quote ? (
                    <>
                      <dt className="text-ink-muted">{t('preorder.productSubtotal')}</dt>
                      <dd className="text-right tabular-nums text-ink">
                        {formatMoney(preview.data.quote.subtotal)}
                      </dd>
                      <dt className="text-ink-muted">{t('preorder.tax')}</dt>
                      <dd className="text-right tabular-nums text-ink">
                        {formatMoney(preview.data.quote.tax)}
                      </dd>
                      <dt className="text-ink-muted">{t('preorder.freight')}</dt>
                      <dd className="text-right tabular-nums text-ink">
                        {formatMoney(preview.data.quote.shipping)}
                      </dd>
                      <dt className="font-semibold text-ink">{t('preorder.grandTotal')}</dt>
                      <dd className="text-right font-semibold tabular-nums text-ink">
                        {formatMoney(preview.data.quote.grandTotal)}
                      </dd>
                    </>
                  ) : (
                    <>
                      <dt className="text-ink-muted">{t('preorder.goodsTotal')}</dt>
                      <dd className="text-right tabular-nums text-ink">
                        {formatMoney(preview.data.goodsTotal)}
                      </dd>
                    </>
                  )}
                </dl>
                {preview.data.problems
                  .filter(
                    (problem) =>
                      problem.field === 'installments' ||
                      (!problem.field.startsWith('installments.') &&
                        !['revisedDate', 'expiresAt', 'unitPriceMinor'].includes(problem.field)),
                  )
                  .map((problem) => (
                    <p
                      key={`${problem.field}-${problem.code}`}
                      role="alert"
                      className="text-xs text-danger"
                    >
                      {problemText(t, intlLocale, problem)}
                    </p>
                  ))}
              </div>
            )}
          </section>

          {send.isError && (
            <p
              role="alert"
              className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger"
            >
              {errorMessage(t, send.error)}
            </p>
          )}
        </div>
      </Modal>

      <Modal
        isOpen={confirmDiscard}
        onClose={() => {
          setConfirmDiscard(false);
        }}
        title={t('sellerPreorders.discardTitle')}
        description={t('sellerPreorders.discardBody')}
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setConfirmDiscard(false);
              }}
            >
              {t('sellerPreorders.keepEditing')}
            </Button>
            <Button variant="danger" onClick={onClose}>
              {t('sellerPreorders.discard')}
            </Button>
          </div>
        }
      >
        <span className="sr-only">{t('sellerPreorders.discardBody')}</span>
      </Modal>
    </>
  );
}

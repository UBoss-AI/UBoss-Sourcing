/**
 * One preorder, from the seller's side: the decision screen.
 *
 * Everything the seller needs to answer is on one page - the buyer's company,
 * the quantity in pieces and in the unit they asked in, the minimum it was
 * judged against, the date, the destination, what their own capacity for that
 * period looks like with this request in it, and every revision so far.
 *
 * Three answers, each its own form, because each commits to different things:
 *
 *   - Accept as requested: the buyer's quantity and date. The seller states
 *     the freight, and the price when their terms are quoted per request.
 *   - Counter: any quantity, price, committed date, and optionally a split
 *     into several deliveries.
 *   - Reject, with a reason the buyer is shown.
 *
 * None of them charges the buyer. Money moves only after the BUYER confirms
 * and pays, and the page says so beside the buttons.
 */
import { useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DatePicker } from '@/components/DatePicker';
import { Modal } from '@/components/Modal';
import { OfferTerms, PreorderHistory, PreorderStatusBadge, RequestSummary } from '@/components/preorder/PreorderParts';
import { useToast } from '@/components/toast-context';
import { Button, ButtonLink, Card, ErrorState, Field, Input, LoadingState, PageHeader, Select, Textarea } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { addDays, todayIso } from '@/lib/calendar-date';
import { errorMessage } from '@/lib/errors';
import { currencyExponent, formatMoney, formatMoneyMinor, formatNumber, majorToMinor, minorToMajor } from '@/lib/format';
import {
  fetchSellerPreorder,
  sellerAcceptPreorder,
  sellerAdvancePreorder,
  sellerCounterPreorder,
  sellerRejectPreorder,
  type Preorder,
} from '@/lib/preorders';
import { fetchLocations } from '@/lib/seller';
import { ApprovalRequiredNotice, type SellerOutletContext } from './SellerLayout';

type Mode = 'accept' | 'counter' | 'reject' | null;

export function SellerPreorderDetailPage(): React.JSX.Element {
  const seller = useOutletContext<SellerOutletContext>();
  const { id = '' } = useParams<{ id: string }>();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [mode, setMode] = useState<Mode>(null);

  const query = useQuery({
    queryKey: ['seller', 'preorder', id],
    queryFn: () => fetchSellerPreorder(id),
    enabled: seller.isTrading,
  });

  const locations = useQuery({ queryKey: ['seller', 'locations'], queryFn: fetchLocations, enabled: seller.isTrading });

  const settle = (preorder: Preorder): void => {
    queryClient.setQueryData(['seller', 'preorder', id], preorder);
    void queryClient.invalidateQueries({ queryKey: ['seller', 'preorders'] });
    setMode(null);
  };

  const advance = useMutation({
    mutationFn: (step: 'start-production' | 'ready') => sellerAdvancePreorder(id, step, null),
    onSuccess: settle,
    onError: (error) => { toast.error(errorMessage(t, error)); },
  });

  if (!seller.isTrading) return <ApprovalRequiredNotice seller={seller} />;
  if (query.isPending) return <LoadingState label={t('sellerPreorders.loading')} />;
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

  const preorder = query.data;
  const allowed = new Set(preorder.allowedActions);
  const locationOptions = locations.data?.locations ?? [];

  return (
    <>
      <p className="mb-3 text-sm">
        <Link to="/seller/preorders" className="text-brand hover:underline">
          ← {t('sellerPreorders.title')}
        </Link>
      </p>

      <PageHeader
        title={`${preorder.requestNumber} · ${preorder.product.name}`}
        description={t('sellerPreorders.from', {
          buyer: preorder.buyer?.organization ?? preorder.buyer?.name ?? '',
        })}
        actions={<PreorderStatusBadge status={preorder.status} />}
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-4">
          {(allowed.has('SELLER_ACCEPTED') || allowed.has('SELLER_COUNTERED') || allowed.has('REJECTED')) && (
            <Card title={t('sellerPreorders.yourAnswer')} description={t('sellerPreorders.noCharge')}>
              <div className="flex flex-wrap gap-2">
                {allowed.has('SELLER_ACCEPTED') && (
                  <Button
                    variant="action"
                    onClick={() => {
                      setMode('accept');
                    }}
                  >
                    {t('sellerPreorders.accept')}
                  </Button>
                )}
                {allowed.has('SELLER_COUNTERED') && (
                  <Button
                    variant="operational"
                    onClick={() => {
                      setMode('counter');
                    }}
                  >
                    {t('sellerPreorders.counter')}
                  </Button>
                )}
                {allowed.has('REJECTED') && (
                  <Button
                    variant="danger"
                    onClick={() => {
                      setMode('reject');
                    }}
                  >
                    {t('sellerPreorders.reject')}
                  </Button>
                )}
              </div>
            </Card>
          )}

          {(allowed.has('IN_PRODUCTION') || allowed.has('READY_FOR_FULFILLMENT')) && (
            <Card title={t('sellerPreorders.production')}>
              <div className="flex flex-wrap gap-2">
                {allowed.has('IN_PRODUCTION') && (
                  <Button
                    variant="operational"
                    isLoading={advance.isPending}
                    onClick={() => {
                      advance.mutate('start-production');
                    }}
                  >
                    {t('sellerPreorders.startProduction')}
                  </Button>
                )}
                {allowed.has('READY_FOR_FULFILLMENT') && (
                  <Button
                    variant="action"
                    isLoading={advance.isPending}
                    onClick={() => {
                      advance.mutate('ready');
                    }}
                  >
                    {t('sellerPreorders.markReady')}
                  </Button>
                )}
              </div>
              {preorder.sellerOrderGroupId !== null && (
                <p className="mt-3 text-sm text-ink-muted">
                  {t('sellerPreorders.acceptOrderToHandOver')}{' '}
                  <Link to={`/seller/orders/${preorder.sellerOrderGroupId}`} className="font-medium text-brand hover:underline">
                    {t('sellerPreorders.openOrder')}
                  </Link>
                </p>
              )}
            </Card>
          )}

          {preorder.currentOffer !== null && (
            <section className="space-y-2">
              <h2 className="text-title-xs text-ink">{t('sellerPreorders.onTheTable')}</h2>
              <OfferTerms offer={preorder.currentOffer} highlight />
            </section>
          )}

          <Card title={t('sellerPreorders.request')}>
            <RequestSummary preorder={preorder} />
          </Card>

          {preorder.offers.filter((offer) => offer.id !== preorder.currentOffer?.id).length > 0 && (
            <Card title={t('preorder.earlierTerms')}>
              <div className="space-y-3">
                {preorder.offers
                  .filter((offer) => offer.id !== preorder.currentOffer?.id)
                  .reverse()
                  .map((offer) => (
                    <OfferTerms key={offer.id} offer={offer} />
                  ))}
              </div>
            </Card>
          )}
        </div>

        <aside className="space-y-4">
          <Card title={t('sellerPreorders.buyer')}>
            <dl className="space-y-1 text-sm">
              <dt className="text-ink-muted">{t('sellerPreorders.company')}</dt>
              <dd className="font-medium text-ink">{preorder.buyer?.organization ?? '—'}</dd>
              <dt className="mt-2 text-ink-muted">{t('sellerPreorders.contact')}</dt>
              <dd className="text-ink">{preorder.buyer?.name ?? '—'}</dd>
              {preorder.buyer?.taxNumber !== null && preorder.buyer?.taxNumber !== undefined && (
                <>
                  <dt className="mt-2 text-ink-muted">{t('sellerPreorders.taxNumber')}</dt>
                  <dd className="font-mono text-ink">{preorder.buyer.taxNumber}</dd>
                </>
              )}
            </dl>
          </Card>

          <Card title={t('sellerPreorders.terms')}>
            <dl className="space-y-1 text-sm">
              <dt className="text-ink-muted">{t('sellerPreorders.minimum')}</dt>
              <dd className="text-ink">
                {t('sellerPreorders.minimumLine', {
                  quantity: formatNumber(Number(preorder.policy['moqQuantity'] ?? 0)),
                  unit: t(`preorder.unit.${typeof preorder.policy['moqUnit'] === 'string' ? preorder.policy['moqUnit'] : 'PIECE'}` as TranslationKey),
                })}
              </dd>
              <dt className="mt-2 text-ink-muted">{t('sellerPreorders.pricing')}</dt>
              <dd className="text-ink">
                {preorder.pricingMode === 'FIXED' ? t('sellerPreorders.fixed') : t('sellerPreorders.quoted')}
              </dd>
            </dl>
          </Card>

          {preorder.capacity !== null && (
            <Card title={t('sellerPreorders.capacity')}>
              <p className="text-sm text-ink">
                {t('sellerPreorders.capacityLine', {
                  period: preorder.capacity.periodKey,
                  reserved: formatNumber(preorder.capacity.reservedBaseUnits),
                  capacity: formatNumber(preorder.capacity.capacityBaseUnits),
                })}
              </p>
              <div
                className="mt-2 h-2 overflow-hidden rounded-full bg-surface-sunken"
                role="img"
                aria-label={t('sellerPreorders.capacityBar', {
                  percent: String(
                    Math.min(
                      100,
                      Math.round(
                        ((preorder.capacity.reservedBaseUnits + preorder.capacity.requestedBaseUnits) /
                          preorder.capacity.capacityBaseUnits) *
                          100,
                      ),
                    ),
                  ),
                })}
              >
                <div
                  className={preorder.capacity.fits ? 'h-full bg-operational' : 'h-full bg-danger'}
                  style={{
                    width: `${String(
                      Math.min(
                        100,
                        ((preorder.capacity.reservedBaseUnits + preorder.capacity.requestedBaseUnits) /
                          preorder.capacity.capacityBaseUnits) *
                          100,
                      ),
                    )}%`,
                  }}
                />
              </div>
              <p className={preorder.capacity.fits ? 'mt-2 text-xs text-ink-muted' : 'mt-2 text-xs font-medium text-danger'}>
                {preorder.capacity.fits
                  ? t('sellerPreorders.capacityFits', { pieces: formatNumber(preorder.capacity.requestedBaseUnits) })
                  : t('sellerPreorders.capacityShort', { available: formatNumber(preorder.capacity.availableBaseUnits) })}
              </p>
            </Card>
          )}

          <Card title={t('preorder.history')}>
            <PreorderHistory preorder={preorder} />
          </Card>

          {preorder.order !== null && (
            <ButtonLink
              to={preorder.sellerOrderGroupId === null ? '/seller/orders' : `/seller/orders/${preorder.sellerOrderGroupId}`}
              variant="secondary"
              fullWidth
            >
              {t('sellerPreorders.orderLink', { order: preorder.order.orderNumber })}
            </ButtonLink>
          )}
        </aside>
      </div>

      {mode === 'accept' && (
        <AcceptDialog preorder={preorder} locations={locationOptions} onClose={() => { setMode(null); }} onDone={settle} />
      )}
      {mode === 'counter' && (
        <CounterDialog preorder={preorder} locations={locationOptions} onClose={() => { setMode(null); }} onDone={settle} />
      )}
      {mode === 'reject' && (
        <RejectDialog preorder={preorder} onClose={() => { setMode(null); }} onDone={settle} />
      )}
    </>
  );
}

interface DialogProps {
  preorder: Preorder;
  onClose: () => void;
  onDone: (preorder: Preorder) => void;
}

function LocationField({
  locations,
  value,
  onChange,
}: {
  locations: { id: string; name: string; code: string }[];
  value: string;
  onChange: (value: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <Field label={t('sellerPreorders.madeAt')}>
      {({ inputId }) => (
        <Select
          id={inputId}
          value={value}
          onChange={(event) => {
            onChange(event.currentTarget.value);
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
  );
}

function AcceptDialog({
  preorder,
  locations,
  onClose,
  onDone,
}: DialogProps & { locations: { id: string; name: string; code: string }[] }): React.JSX.Element {
  const { t } = useI18n();
  const exponent = currencyExponent(preorder.currency);
  const quoted = preorder.indicative.unitPrice === null;
  const [price, setPrice] = useState('');
  const [freight, setFreight] = useState('0');
  const [location, setLocation] = useState('');
  const [note, setNote] = useState('');

  const priceMinor = quoted ? majorToMinor(price, exponent) : null;
  const freightMinor = majorToMinor(freight, exponent);

  const mutation = useMutation({
    mutationFn: () =>
      sellerAcceptPreorder(preorder.id, {
        unitPriceMinor: priceMinor,
        freightMinor: freightMinor ?? '0',
        originLocationId: location === '' ? null : location,
        note: note.trim() === '' ? null : note.trim(),
        expectedVersion: preorder.version,
      }),
    onSuccess: onDone,
  });

  const valid = freightMinor !== null && (!quoted || (priceMinor !== null && priceMinor !== '0'));

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t('sellerPreorders.accept')}
      description={t('sellerPreorders.acceptBody', {
        pieces: formatNumber(preorder.quantity.baseUnits),
        date: preorder.requestedDeliveryDate,
      })}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="action"
            disabled={!valid}
            isLoading={mutation.isPending}
            onClick={() => {
              mutation.mutate();
            }}
          >
            {t('sellerPreorders.sendAcceptance')}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {quoted ? (
          <Field label={t('sellerPreorders.pricePerPiece', { currency: preorder.currency })}>
            {({ inputId }) => (
              <Input
                id={inputId}
                inputMode="decimal"
                value={price}
                onChange={(event) => {
                  setPrice(event.currentTarget.value);
                }}
              />
            )}
          </Field>
        ) : (
          <p className="text-sm text-ink">
            {t('sellerPreorders.atIndicative', {
              price: formatMoney(preorder.indicative.unitPrice),
              total: formatMoney(preorder.indicative.goodsTotal),
            })}
          </p>
        )}
        <Field label={t('sellerPreorders.freight', { currency: preorder.currency })} hint={t('sellerPreorders.freightHint')}>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              inputMode="decimal"
              value={freight}
              onChange={(event) => {
                setFreight(event.currentTarget.value);
              }}
            />
          )}
        </Field>
        <LocationField locations={locations} value={location} onChange={setLocation} />
        <Field label={t('sellerPreorders.noteToBuyer')}>
          {({ inputId }) => (
            <Textarea
              id={inputId}
              rows={2}
              maxLength={2000}
              value={note}
              onChange={(event) => {
                setNote(event.currentTarget.value);
              }}
            />
          )}
        </Field>
        {mutation.isError && (
          <p role="alert" className="text-sm text-danger">
            {errorMessage(t, mutation.error)}
          </p>
        )}
      </div>
    </Modal>
  );
}

function CounterDialog({
  preorder,
  locations,
  onClose,
  onDone,
}: DialogProps & { locations: { id: string; name: string; code: string }[] }): React.JSX.Element {
  const { t } = useI18n();
  const exponent = currencyExponent(preorder.currency);
  const current = preorder.currentOffer;

  const [quantity, setQuantity] = useState(String(current?.quantityBaseUnits ?? preorder.quantity.baseUnits));
  const [price, setPrice] = useState(
    current === null
      ? preorder.indicative.unitPrice === null
        ? ''
        : minorToMajor(preorder.indicative.unitPrice.minor, exponent)
      : minorToMajor(current.unitPrice.minor, exponent),
  );
  const [freight, setFreight] = useState(current === null ? '0' : minorToMajor(current.freight.minor, exponent));
  const [date, setDate] = useState(current?.committedDeliveryDate ?? preorder.requestedDeliveryDate);
  const [splits, setSplits] = useState<{ date: string; pieces: string }[]>([]);
  const [location, setLocation] = useState('');
  const [note, setNote] = useState('');

  // The server's own floor, from the request: never a figure typed here. The
  // server re-checks whatever date is sent against the platform notice.
  const tomorrow = addDays(todayIso(preorder.timezone), 1);
  const earliest = preorder.earliestDeliveryDate > tomorrow ? preorder.earliestDeliveryDate : tomorrow;
  const quantityValue = /^\d+$/.test(quantity) ? Number(quantity) : null;
  const priceMinor = majorToMinor(price, exponent);
  const freightMinor = majorToMinor(freight, exponent);

  const splitTotal = splits.reduce((sum, split) => sum + (/^\d+$/.test(split.pieces) ? Number(split.pieces) : 0), 0);

  const mutation = useMutation({
    mutationFn: () =>
      sellerCounterPreorder(preorder.id, {
        quantityBaseUnits: quantityValue ?? 0,
        unitPriceMinor: priceMinor ?? '0',
        freightMinor: freightMinor ?? '0',
        committedDeliveryDate: date,
        deliverySplits:
          splits.length === 0
            ? null
            : [...splits]
                .sort((a, b) => a.date.localeCompare(b.date))
                .map((split) => ({ date: split.date, baseUnits: Number(split.pieces) })),
        originLocationId: location === '' ? null : location,
        note: note.trim() === '' ? null : note.trim(),
        expectedVersion: preorder.version,
      }),
    onSuccess: onDone,
  });

  const valid =
    quantityValue !== null &&
    quantityValue > 0 &&
    priceMinor !== null &&
    priceMinor !== '0' &&
    freightMinor !== null &&
    date !== '' &&
    (splits.length === 0 || (splits.length >= 2 && splitTotal === quantityValue));

  return (
    <Modal
      isOpen
      onClose={onClose}
      size="lg"
      title={t('sellerPreorders.counter')}
      description={t('sellerPreorders.counterBody')}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="operational"
            disabled={!valid}
            isLoading={mutation.isPending}
            onClick={() => {
              mutation.mutate();
            }}
          >
            {t('sellerPreorders.sendCounter')}
          </Button>
        </div>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('sellerPreorders.quantityPieces')}>
          {({ inputId }) => (
            <Input
              id={inputId}
              inputMode="numeric"
              value={quantity}
              onChange={(event) => {
                setQuantity(event.currentTarget.value.replace(/[^\d]/g, ''));
              }}
            />
          )}
        </Field>
        <Field label={t('sellerPreorders.pricePerPiece', { currency: preorder.currency })}>
          {({ inputId }) => (
            <Input
              id={inputId}
              inputMode="decimal"
              value={price}
              onChange={(event) => {
                setPrice(event.currentTarget.value);
              }}
            />
          )}
        </Field>
        <Field label={t('sellerPreorders.freight', { currency: preorder.currency })} hint={t('sellerPreorders.freightHint')}>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              inputMode="decimal"
              value={freight}
              onChange={(event) => {
                setFreight(event.currentTarget.value);
              }}
            />
          )}
        </Field>
        <Field label={t('sellerPreorders.committedDate')}>
          {({ inputId }) => (
            <DatePicker id={inputId} label={t('sellerPreorders.committedDate')} value={date} min={earliest} onChange={setDate} />
          )}
        </Field>

        {quantityValue !== null && priceMinor !== null && (
          <p className="text-sm text-ink sm:col-span-2">
            {t('sellerPreorders.counterTotal', {
              total: formatMoneyMinor((BigInt(priceMinor) * BigInt(quantityValue)).toString(), preorder.currency),
            })}
          </p>
        )}

        <div className="space-y-2 sm:col-span-2">
          <p className="text-sm font-medium text-ink">{t('preorder.splitDeliveries')}</p>
          {splits.map((split, index) => (
            <div key={index} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
              <Field label={t('sellerPreorders.splitDate', { n: String(index + 1) })}>
                {({ inputId }) => (
                  <DatePicker
                    id={inputId}
                    label={t('sellerPreorders.splitDate', { n: String(index + 1) })}
                    value={split.date}
                    min={earliest}
                    onChange={(value) => {
                      setSplits((rows) => rows.map((row, at) => (at === index ? { ...row, date: value } : row)));
                    }}
                  />
                )}
              </Field>
              <Field label={t('sellerPreorders.splitPieces')}>
                {({ inputId }) => (
                  <Input
                    id={inputId}
                    inputMode="numeric"
                    value={split.pieces}
                    onChange={(event) => {
                      const value = event.currentTarget.value.replace(/[^\d]/g, '');
                      setSplits((rows) => rows.map((row, at) => (at === index ? { ...row, pieces: value } : row)));
                    }}
                  />
                )}
              </Field>
              <Button
                variant="ghost"
                onClick={() => {
                  setSplits((rows) => rows.filter((_, at) => at !== index));
                }}
              >
                {t('sellerPreorders.remove')}
              </Button>
            </div>
          ))}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setSplits((rows) => [...rows, { date, pieces: '' }]);
            }}
          >
            {t('sellerPreorders.addSplit')}
          </Button>
          {splits.length > 0 && (
            <p className={splitTotal === quantityValue ? 'text-xs text-ink-muted' : 'text-xs text-danger'}>
              {t('sellerPreorders.splitSum', {
                sum: formatNumber(splitTotal),
                total: formatNumber(quantityValue ?? 0),
              })}
            </p>
          )}
        </div>

        <div className="sm:col-span-2">
          <LocationField locations={locations} value={location} onChange={setLocation} />
        </div>
        <div className="sm:col-span-2">
          <Field label={t('sellerPreorders.noteToBuyer')}>
            {({ inputId }) => (
              <Textarea
                id={inputId}
                rows={2}
                maxLength={2000}
                value={note}
                onChange={(event) => {
                  setNote(event.currentTarget.value);
                }}
              />
            )}
          </Field>
        </div>
        {mutation.isError && (
          <p role="alert" className="text-sm text-danger sm:col-span-2">
            {errorMessage(t, mutation.error)}
          </p>
        )}
      </div>
    </Modal>
  );
}

function RejectDialog({ preorder, onClose, onDone }: DialogProps): React.JSX.Element {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const mutation = useMutation({
    mutationFn: () => sellerRejectPreorder(preorder.id, reason.trim(), preorder.version),
    onSuccess: onDone,
  });

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t('sellerPreorders.reject')}
      description={t('sellerPreorders.rejectBody')}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={reason.trim().length < 3}
            isLoading={mutation.isPending}
            onClick={() => {
              mutation.mutate();
            }}
          >
            {t('sellerPreorders.reject')}
          </Button>
        </div>
      }
    >
      <Field label={t('sellerPreorders.reasonForBuyer')}>
        {({ inputId }) => (
          <Textarea
            id={inputId}
            rows={3}
            maxLength={1000}
            value={reason}
            onChange={(event) => {
              setReason(event.currentTarget.value);
            }}
          />
        )}
      </Field>
      {mutation.isError && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {errorMessage(t, mutation.error)}
        </p>
      )}
    </Modal>
  );
}

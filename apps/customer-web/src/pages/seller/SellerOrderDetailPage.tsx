/**
 * One order group: what was bought, what it earns, and what happens next.
 *
 * The list screen is for triage — how many, how late. This is where an order is
 * actually worked: accepted, picked, packed, and handed to a carrier. The three
 * things it has that the list cannot are the lines (what to pick), the money
 * breakdown (what the marketplace kept, line by line), and the shipments.
 *
 * **Recording a shipment is the only irreversible thing here**, which is why it
 * asks for a carrier and a tracking number before it will do anything: a
 * shipment with neither is a row that tells the buyer nothing and cannot be
 * chased. The contents are optional, because a seller sending one box of
 * everything should not have to enumerate it, but a partial dispatch has to be
 * itemised or the remaining quantity is a guess.
 *
 * What is deliberately NOT here, same as the list: no buyer email, no telephone
 * number, no payment reference. The delivery address is shown because somebody
 * has to write it on the box.
 */
import { useState } from 'react';
import { ConsignmentLogisticsPanel } from './ConsignmentLogisticsPanel';
import { SellerOrderLegsPanel } from './SellerOrderLegsPanel';
import { raiseConsignment } from '@/lib/consignment-logistics';
import { ConsignmentCarrierPurchasePanel } from './ConsignmentCarrierPurchasePanel';
import { ConsignmentDocumentsPanel } from './ConsignmentDocumentsPanel';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Card,
  ErrorState,
  Field,
  Input,
  LoadingState,
  PageHeader,
  Select,
} from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import {
  fetchLocations,
  fetchSellerOrder,
  formatMinor,
  nextActions,
  orderLabelKey,
  recordShipment,
  transitionOrder,
  type SellerOrderDetail,
  type SellerOrderStatus,
} from '@/lib/seller';

export function SellerOrderDetailPage(): React.JSX.Element {
  const { t } = useI18n();
  const { id = '' } = useParams<{ id: string }>();

  const query = useQuery({
    queryKey: ['seller', 'order', id],
    queryFn: () => fetchSellerOrder(id),
    enabled: id.length > 0,
  });

  const [transition, setTransition] = useState<SellerOrderStatus | null>(null);
  const [isShipping, setIsShipping] = useState(false);

  if (query.isPending) return <LoadingState label="Loading the order" />;

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

  const order = query.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title={order.sellerOrderNumber}
        description={t('seller.orderDetail.buyerOrder', {
          order: order.orderNumber,
          when:
            order.placedAt === null
              ? t('seller.orderDetail.dateUnknown')
              : new Date(order.placedAt).toLocaleString(),
        })}
        actions={
          <Link to="/seller/orders" className="text-sm text-brand hover:underline">
            {t('seller.orderDetail.allOrders')}
          </Link>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="brand">{t(orderLabelKey(order.status))}</Badge>
        {order.dispatchDueAt !== null && (
          <Badge tone={new Date(order.dispatchDueAt) < new Date() ? 'danger' : 'neutral'}>
            {new Date(order.dispatchDueAt) < new Date()
              ? t('seller.orderDetail.overdueSince', {
                  when: new Date(order.dispatchDueAt).toLocaleString(),
                })
              : t('seller.orders.dispatchBy', {
                  when: new Date(order.dispatchDueAt).toLocaleString(),
                })}
          </Badge>
        )}
      </div>

      {order.cancellationReason !== null && (
        <p className="rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-ink">
          {t('seller.orderDetail.cancelledWith', { reason: order.cancellationReason })}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-6">
          <Lines order={order} />
          {/* L1-L4, where this order was priced on four delivery levels. */}
          <SellerOrderLegsPanel sellerOrderId={order.id} canAct={order.status !== 'NEW' && order.status !== 'CANCELLED'} />
          <Consignments order={order} />
          {/* Invoice, packing list and Mark packed, per consignment. Open on a
              cancelled order too: that is when a credit note is owed. */}
          <ConsignmentDocumentsPanel
            sellerOrderId={order.id}
            canAct={order.status !== 'NEW'}
          />
          <Shipments order={order} />
          <Returns order={order} />
        </div>

        <div className="space-y-6">
          <Money order={order} />
          <DeliveryAddress order={order} />
          <WhatNext
            order={order}
            onTransition={(to) => {
              setTransition(to);
            }}
            onShip={() => {
              setIsShipping(true);
            }}
          />
        </div>
      </div>

      {transition !== null && (
        <TransitionDialog
          order={order}
          to={transition}
          onClose={() => {
            setTransition(null);
          }}
        />
      )}

      {isShipping && (
        <ShipmentDialog
          order={order}
          onClose={() => {
            setIsShipping(false);
          }}
        />
      )}
    </div>
  );
}

function Lines({ order }: { order: SellerOrderDetail }): React.JSX.Element {
  const { t } = useI18n();

  return (
    <Card
      title={t('seller.orderDetail.whatToSend')}
      description={t('seller.orderDetail.whatToSendIntro')}
    >
      <ul className="divide-y divide-border-subtle">
        {order.lines.map((line) => {
          const outstanding = line.quantity - line.fulfilledQuantity;

          return (
            <li key={line.id} className="px-6 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">{line.productName}</p>
                  <p className="mt-0.5 text-xxs text-ink-subtle">{line.sellerSku}</p>

                  {/* The buyer's own words about this line, on the panel
                      headed "what to send".

                      It is drawn as a warning rather than as quiet grey, and
                      that is deliberate: this is the one thing on the screen
                      that changes what goes in the box, and a seller who packs
                      an order without reading it has shipped the wrong thing.
                      Grey is for context; this is an instruction. */}
                  {line.note != null && line.note !== '' && (
                    <div className="mt-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2">
                      <p className="text-xxs font-semibold uppercase tracking-wide text-warning">
                        {t('seller.orderDetail.buyerInstructions')}
                      </p>
                      {/* Three lines typed are three lines meant, and an
                          instruction run together into one paragraph is one a
                          packer misreads. */}
                      <p className="mt-0.5 whitespace-pre-line text-xs leading-relaxed text-ink">
                        {line.note}
                      </p>
                    </div>
                  )}
                </div>
                <div className="text-right">
                  <p className="text-sm font-medium text-ink">
                    {t('seller.orderDetail.ordered', { count: line.quantity })}
                  </p>
                  <p className="text-xxs text-ink-subtle">
                    {t('seller.orderDetail.sent', { count: line.fulfilledQuantity })}
                    {line.returnedQuantity > 0
                      ? ` · ${t('seller.orderDetail.returned', { count: line.returnedQuantity })}`
                      : ''}
                  </p>
                </div>
              </div>

              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-muted">
                {/*
                  The line total carries the buyer's tax, so it is labelled as
                  such: printed bare beside a unit price it does not multiply
                  out to, it reads as an arithmetic mistake. What the seller
                  actually earns is in the panel beside this one, where the
                  tax is a line of its own.
                */}
                <span>
                  {t('seller.orderDetail.eachAndLine', {
                    unit: formatMinor(line.unitPriceMinor, order.currency),
                    line: formatMinor(line.lineTotalMinor, order.currency),
                  })}
                </span>
                {/*
                  Outstanding, not "remaining": a seller reading this is deciding
                  what to put in the next box, and a line already sent in full
                  should say nothing rather than "0 left" beside every other one.
                */}
                {outstanding > 0 && (
                  <Badge tone="warning">
                    {t('seller.orderDetail.stillToSend', { count: outstanding })}
                  </Badge>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/**
 * The carrier-grade consignments, and who is carrying each.
 *
 * Separate from `Shipments` below, which is the seller's own note of a parcel
 * they sent themselves — a carrier name and a tracking number they typed. This
 * is the record a haulage company actually works, and the only place a seller
 * chooses who collects.
 */
/** Seller-order statuses in which the seller has confirmed they will supply. */
const CONFIRMED: ReadonlySet<string> = new Set(['ACCEPTED', 'PROCESSING', 'READY_FOR_DISPATCH']);

function Consignments({ order }: { order: SellerOrderDetail }): React.JSX.Element | null {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();

  const consignments = order.consignments ?? [];

  /*
   * A confirmed order with no consignment. Normally impossible - payment and
   * confirmation both raise one - but an order confirmed before that existed,
   * or on a day the raise failed, would otherwise show nothing to assign and
   * no way to fix it.
   */
  const raise = useMutation({
    mutationFn: () => raiseConsignment(order.id),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['seller', 'order', order.id] });
      toast.success(t('logistics.consignmentRaised'));
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('logistics.actionFailed')));
    },
  });

  if (consignments.length === 0) {
    if (!CONFIRMED.has(order.status)) return null;

    return (
      <Card title={t('sellerConsignment.carrierHeading')}>
        <div className="space-y-3 px-6 py-5">
          <p className="text-sm text-ink-muted">{t('logistics.noConsignmentYet')}</p>
          <Button
            variant="primary"
            isLoading={raise.isPending}
            onClick={() => {
              raise.mutate();
            }}
          >
            {t('logistics.prepareConsignment')}
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card title={t('sellerConsignment.carrierHeading')} description={t('logistics.cardBody')}>
      <div className="space-y-3 px-6 py-4">
        {consignments.map((consignment) => (
          <div key={consignment.id} className="space-y-3">
            {consignment.logistics !== undefined && consignment.logistics !== null ? (
              <ConsignmentLogisticsPanel sellerOrderId={order.id} state={consignment.logistics} />
            ) : (
              <p className="text-sm text-ink-muted">{consignment.reference}</p>
            )}

            {/*
              The other route out of the warehouse.

              A seller with their own carrier account prices and buys the
              consignment here rather than offering it to a haulage company.
              Both are on the page because a seller can have both — one carrier
              for the north and their own vans for the city — and hiding one
              behind a mode toggle makes the choice feel like a setting rather
              than what it is, which is a decision about this parcel.
            */}
            {/*
              Not for a consignment booked BY HAND with DHL, FedEx or India
              Post: pricing and collection booking go through a carrier API or
              a partner's board, and a hand booking has neither. Offering a
              "book a pickup" form there would promise a van nobody sends.
            */}
            {consignment.logistics?.mode !== 'MANUAL_CARRIER' && (
              <ConsignmentCarrierPurchasePanel
                shipmentId={consignment.id}
                reference={consignment.reference}
              />
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

function Shipments({ order }: { order: SellerOrderDetail }): React.JSX.Element | null {
  const { t } = useI18n();

  if (order.shipments.length === 0) return null;

  return (
    <Card title={t('seller.orderDetail.shipments')}>
      <ul className="divide-y divide-border-subtle">
        {order.shipments.map((shipment) => (
          <li key={shipment.id} className="px-6 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">{shipment.carrierName}</p>
                <p className="mt-0.5 break-all text-xxs text-ink-subtle">
                  {shipment.trackingUrl === null ? (
                    shipment.trackingNumber
                  ) : (
                    <a
                      href={shipment.trackingUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-brand hover:underline"
                    >
                      {shipment.trackingNumber}
                    </a>
                  )}
                </p>
              </div>
              <Badge tone="neutral">{shipment.status.toLowerCase().replace(/_/g, ' ')}</Badge>
            </div>

            <p className="mt-2 text-xxs text-ink-subtle">
              {shipment.dispatchedAt === null
                ? t('seller.orderDetail.notDispatched')
                : t('seller.orderDetail.dispatchedAt', {
                    when: new Date(shipment.dispatchedAt).toLocaleString(),
                  })}
              {shipment.deliveredAt === null
                ? ''
                : ` · ${t('seller.orderDetail.deliveredAt', {
                    when: new Date(shipment.deliveredAt).toLocaleString(),
                  })}`}
            </p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Returns({ order }: { order: SellerOrderDetail }): React.JSX.Element | null {
  const { t } = useI18n();

  if (order.returns.length === 0) return null;

  return (
    <Card title={t('seller.orderDetail.returns')}>
      <ul className="divide-y divide-border-subtle">
        {order.returns.map((entry) => (
          <li key={entry.id} className="px-6 py-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-ink">
                {entry.reasonCode.toLowerCase().replace(/_/g, ' ')}
              </p>
              <Badge tone="warning">{entry.status.toLowerCase().replace(/_/g, ' ')}</Badge>
            </div>
            {entry.reasonText !== null && (
              <p className="mt-1 text-xs text-ink-muted">{entry.reasonText}</p>
            )}
            {entry.sellerResponse !== null && (
              <p className="mt-1 text-xs text-ink-muted">
                {t('seller.orderDetail.youSaid', { text: entry.sellerResponse })}
              </p>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * The money, in the order it is worked out.
 *
 * Gross, then what the marketplace kept, then what is left. A seller disputing
 * a settlement disputes one of these three lines, and a screen showing only the
 * last one gives them nothing to point at.
 */
function Money({ order }: { order: SellerOrderDetail }): React.JSX.Element {
  const { t } = useI18n();

  return (
    <Card title={t('seller.orderDetail.whatThisEarns')}>
      <dl className="space-y-2 px-6 py-5 text-sm">
        <Row
          label={t('seller.orderDetail.goods')}
          value={formatMinor(order.goodsTotalMinor, order.currency)}
        />
        <Row
          label={t('seller.orderDetail.shipping')}
          value={formatMinor(order.shippingTotalMinor, order.currency)}
        />
        <Row
          label={t('seller.orderDetail.tax')}
          value={formatMinor(order.taxTotalMinor, order.currency)}
        />
        <Row
          label={
            order.commissionBasisPointsApplied === null
              ? t('seller.orderDetail.commission')
              : t('seller.orderDetail.commissionAt', {
                  rate: (order.commissionBasisPointsApplied / 100).toFixed(2),
                })
          }
          value={`− ${formatMinor(order.commissionMinor, order.currency)}`}
        />
        <div className="border-t border-border-subtle pt-2">
          <Row
            label={t('seller.orderDetail.yours')}
            value={formatMinor(order.sellerNetMinor, order.currency)}
            isStrong
          />
        </div>
      </dl>
    </Card>
  );
}

function Row({
  label,
  value,
  isStrong = false,
}: {
  label: string;
  value: string;
  isStrong?: boolean;
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={isStrong ? 'font-medium text-ink' : 'text-ink-muted'}>{label}</dt>
      <dd className={isStrong ? 'font-semibold text-ink' : 'tabular-nums text-ink'}>{value}</dd>
    </div>
  );
}

function DeliveryAddress({ order }: { order: SellerOrderDetail }): React.JSX.Element | null {
  const { t } = useI18n();

  const address = order.deliveryAddress as {
    fullName?: string;
    line1?: string;
    line2?: string | null;
    city?: string;
    region?: string | null;
    postcode?: string;
    countryCode?: string;
  } | null;

  if (address === null || typeof address !== 'object') return null;

  const lines = [
    address.fullName,
    address.line1,
    address.line2,
    [address.city, address.region].filter(Boolean).join(', '),
    address.postcode,
    address.countryCode,
  ].filter((line): line is string => typeof line === 'string' && line.length > 0);

  return (
    <Card title={t('seller.orderDetail.deliverTo')}>
      <address className="space-y-0.5 px-6 py-5 text-sm not-italic text-ink">
        {lines.map((line, index) => (
          <p key={index}>{line}</p>
        ))}
      </address>
    </Card>
  );
}

/**
 * What this member may do next.
 *
 * Rendered from `allowedTransitions`, which the server computes from the state
 * machine and this member's permissions. Nothing is drawn that would be refused
 * — a button that exists only to produce an error is worse than no button.
 */
function WhatNext({
  order,
  onTransition,
  onShip,
}: {
  order: SellerOrderDetail;
  onTransition: (to: SellerOrderStatus) => void;
  onShip: () => void;
}): React.JSX.Element {
  const { t } = useI18n();

  const canShip =
    order.status === 'PROCESSING' ||
    order.status === 'READY_FOR_DISPATCH' ||
    order.status === 'ACCEPTED';

  /*
   * The moves worth offering, and only those this member may actually make.
   *
   * `nextActions` is the same short list the orders table draws, so one
   * screen cannot offer a step the other hides; the server's own
   * `allowedTransitions` then filters it, so a member without the permission
   * is not shown a button that would come back refused. The labels are verbs
   * for that reason too - a button reading "Accepted" names a state, and the
   * seller is being asked to do something.
   */
  const permitted = new Set(order.allowedTransitions.map((entry) => entry.to));
  const actions = nextActions(order.status).filter((action) => permitted.has(action.to));

  return (
    <Card title={t('seller.orderDetail.whatNext')}>
      <div className="space-y-2 px-6 py-5">
        {canShip && (
          <Button
            variant="primary"
            className="w-full"
            onClick={() => {
              onShip();
            }}
          >
            {t('seller.orderDetail.recordShipment')}
          </Button>
        )}

        {actions.map((action) => (
          <Button
            key={action.to}
            variant={action.to === 'CANCELLED' ? 'danger' : 'secondary'}
            className="w-full"
            onClick={() => {
              onTransition(action.to);
            }}
          >
            {t(action.labelKey)}
          </Button>
        ))}

        {actions.length === 0 && !canShip && (
          <p className="text-sm text-ink-muted">
            {t('seller.orderDetail.nothingToDo')}
          </p>
        )}
      </div>
    </Card>
  );
}

function TransitionDialog({
  order,
  to,
  onClose,
}: {
  order: SellerOrderDetail;
  to: SellerOrderStatus;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();

  const [reason, setReason] = useState('');
  const [locationId, setLocationId] = useState(order.locationId ?? '');

  const needsReason = to === 'CANCELLED' || to === 'DISPUTED';
  const needsLocation = to === 'ACCEPTED';

  const locations = useQuery({
    queryKey: ['seller', 'locations'],
    queryFn: fetchLocations,
    enabled: needsLocation,
  });

  const mutation = useMutation({
    mutationFn: () =>
      transitionOrder(order.id, {
        status: to,
        reason: reason.trim().length === 0 ? null : reason.trim(),
        locationId: locationId.length === 0 ? null : locationId,
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['seller', 'order', order.id] });
      await client.invalidateQueries({ queryKey: ['seller', 'orders'] });
      await client.invalidateQueries({ queryKey: ['seller', 'dashboard'] });
      toast.success(t('seller.orders.updated', { order: order.sellerOrderNumber }));
      onClose();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('seller.orders.updateFailed')));
    },
  });

  const operational = (locations.data?.locations ?? []).filter(
    (location) => location.isOperational && location.isPickupLocation,
  );

  const canSubmit =
    (!needsReason || reason.trim().length > 0) && (!needsLocation || locationId.length > 0);

  return (
    <Modal isOpen title={`${t(actionLabelKey(to))} — ${order.sellerOrderNumber}`} onClose={onClose}>
      <div className="space-y-4">
        {needsLocation && (
          <Field
            label={t('seller.orders.whichLocation')}
            hint={t('seller.orders.whichLocationHint')}
            required
          >
            {({ inputId, describedBy }) => (
              <Select
                id={inputId}
                aria-describedby={describedBy}
                value={locationId}
                onChange={(event) => {
                  setLocationId(event.currentTarget.value);
                }}
              >
                <option value="">{t('seller.orders.chooseLocation')}</option>
                {operational.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name} ({location.code})
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}

        {needsReason && (
          <Field label={t('seller.orders.why')} hint={t('seller.orders.whyHint')} required>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                value={reason}
                onChange={(event) => {
                  setReason(event.currentTarget.value);
                }}
              />
            )}
          </Field>
        )}

        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant={to === 'CANCELLED' ? 'danger' : 'primary'}
            isLoading={mutation.isPending}
            disabled={!canSubmit}
            onClick={() => {
              mutation.mutate();
            }}
          >
            {t(actionLabelKey(to))}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * The verb for a move, for the dialog that confirms it.
 *
 * `nextActions` labels a move from the status it starts at, which is what a
 * list of buttons needs; a dialog only knows where it is going. Same words,
 * so the button and the dialog it opens agree.
 */
function actionLabelKey(to: SellerOrderStatus): TranslationKey {
  switch (to) {
    case 'ACCEPTED':
      return 'seller.orderAction.accept';
    case 'PROCESSING':
      return 'seller.orderAction.startPicking';
    case 'READY_FOR_DISPATCH':
      return 'seller.orderAction.markReadyToGo';
    case 'SHIPPED':
      return 'seller.orderAction.markShipped';
    case 'DELIVERED':
      return 'seller.orderAction.markDelivered';
    case 'CANCELLED':
      return 'seller.orderAction.reject';
    case 'RETURNED':
      return 'seller.orderAction.acceptReturn';
    case 'DISPUTED':
      return 'seller.orderAction.dispute';
    default:
      return orderLabelKey(to);
  }
}

function ShipmentDialog({
  order,
  onClose,
}: {
  order: SellerOrderDetail;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();

  const [carrierName, setCarrierName] = useState('');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [trackingUrl, setTrackingUrl] = useState('');

  /**
   * How much of each line is in this box.
   *
   * Prefilled with everything still outstanding, because one box for the whole
   * order is the common case and making a seller type it every time is how they
   * stop recording shipments at all. Editing it down is what makes a partial
   * dispatch honest.
   */
  const [quantities, setQuantities] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      order.lines.map((line) => [line.id, String(Math.max(0, line.quantity - line.fulfilledQuantity))]),
    ),
  );

  const contents = order.lines
    .map((line) => ({
      orderItemId: line.orderItemId,
      quantity: Number(quantities[line.id] ?? '0'),
    }))
    .filter((entry) => Number.isFinite(entry.quantity) && entry.quantity > 0);

  const mutation = useMutation({
    mutationFn: () =>
      recordShipment(order.id, {
        carrierName: carrierName.trim(),
        trackingNumber: trackingNumber.trim(),
        trackingUrl: trackingUrl.trim().length === 0 ? null : trackingUrl.trim(),
        contents: contents.length === 0 ? null : contents,
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['seller', 'order', order.id] });
      await client.invalidateQueries({ queryKey: ['seller', 'orders'] });
      toast.success(t('seller.orderDetail.shipmentRecorded'));
      onClose();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('seller.orderDetail.shipmentFailed')));
    },
  });

  const canSubmit =
    carrierName.trim().length > 0 && trackingNumber.trim().length > 0 && contents.length > 0;

  return (
    <Modal
      isOpen
      title={`${t('seller.orderDetail.recordShipment')} — ${order.sellerOrderNumber}`}
      onClose={onClose}
    >
      <div className="space-y-4">
        <Field
          label={t('seller.orderDetail.carrier')}
          hint={t('seller.orderDetail.carrierHint')}
          required
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              value={carrierName}
              onChange={(event) => {
                setCarrierName(event.currentTarget.value);
              }}
            />
          )}
        </Field>

        <Field label={t('seller.orderDetail.trackingNumber')} required>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              value={trackingNumber}
              onChange={(event) => {
                setTrackingNumber(event.currentTarget.value);
              }}
            />
          )}
        </Field>

        <Field
          label={t('seller.orderDetail.trackingLink')}
          hint={t('seller.orderDetail.trackingLinkHint')}
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              type="url"
              placeholder="https://"
              value={trackingUrl}
              onChange={(event) => {
                setTrackingUrl(event.currentTarget.value);
              }}
            />
          )}
        </Field>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-ink">
            {t('seller.orderDetail.whatIsInBox')}
          </legend>
          <p className="text-xs text-ink-muted">{t('seller.orderDetail.whatIsInBoxHint')}</p>

          <ul className="space-y-2">
            {order.lines.map((line) => {
              const outstanding = Math.max(0, line.quantity - line.fulfilledQuantity);

              return (
                <li key={line.id} className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">
                    {line.productName}
                    <span className="ml-2 text-xxs text-ink-subtle">
                      {t('seller.orderDetail.left', { count: outstanding })}
                    </span>
                  </span>
                  <Input
                    type="number"
                    min={0}
                    max={outstanding}
                    className="w-24"
                    aria-label={t('seller.orderDetail.quantityOf', {
                      product: line.productName,
                    })}
                    value={quantities[line.id] ?? '0'}
                    onChange={(event) => {
                      const next = event.currentTarget.value;
                      setQuantities((current) => ({ ...current, [line.id]: next }));
                    }}
                  />
                </li>
              );
            })}
          </ul>
        </fieldset>

        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            isLoading={mutation.isPending}
            disabled={!canSubmit}
            onClick={() => {
              mutation.mutate();
            }}
          >
            {t('seller.orderDetail.recordIt')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

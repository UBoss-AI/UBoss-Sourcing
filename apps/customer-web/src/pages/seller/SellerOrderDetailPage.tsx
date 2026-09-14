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
import { errorMessage } from '@/lib/errors';
import {
  fetchLocations,
  fetchSellerOrder,
  formatMinor,
  orderLabel,
  recordShipment,
  transitionOrder,
  type SellerOrderDetail,
  type SellerOrderStatus,
} from '@/lib/seller';

export function SellerOrderDetailPage(): React.JSX.Element {
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
        description={`Buyer's order ${order.orderNumber} · placed ${
          order.placedAt === null ? 'date unknown' : new Date(order.placedAt).toLocaleString()
        }`}
        actions={
          <Link to="/seller/orders" className="text-sm text-brand hover:underline">
            ← All orders
          </Link>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="brand">{orderLabel(order.status as SellerOrderStatus)}</Badge>
        {order.dispatchDueAt !== null && (
          <Badge tone={new Date(order.dispatchDueAt) < new Date() ? 'danger' : 'neutral'}>
            {new Date(order.dispatchDueAt) < new Date() ? 'Overdue since ' : 'Dispatch by '}
            {new Date(order.dispatchDueAt).toLocaleString()}
          </Badge>
        )}
      </div>

      {order.cancellationReason !== null && (
        <p className="rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-ink">
          Cancelled: {order.cancellationReason}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-6">
          <Lines order={order} />
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
  return (
    <Card title="What to send" description="Quantities already sent and already returned are shown beside each line.">
      <ul className="divide-y divide-border-subtle">
        {order.lines.map((line) => {
          const outstanding = line.quantity - line.fulfilledQuantity;

          return (
            <li key={line.id} className="px-6 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">{line.productName}</p>
                  <p className="mt-0.5 text-xxs text-ink-subtle">{line.sellerSku}</p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-medium text-ink">
                    {line.quantity} ordered
                  </p>
                  <p className="text-xxs text-ink-subtle">
                    {line.fulfilledQuantity} sent
                    {line.returnedQuantity > 0 ? ` · ${String(line.returnedQuantity)} returned` : ''}
                  </p>
                </div>
              </div>

              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-muted">
                <span>
                  {formatMinor(line.unitPriceMinor, order.currency)} each ·{' '}
                  {formatMinor(line.lineTotalMinor, order.currency)} line
                </span>
                {/*
                  Outstanding, not "remaining": a seller reading this is deciding
                  what to put in the next box, and a line already sent in full
                  should say nothing rather than "0 left" beside every other one.
                */}
                {outstanding > 0 && <Badge tone="warning">{outstanding} still to send</Badge>}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function Shipments({ order }: { order: SellerOrderDetail }): React.JSX.Element | null {
  if (order.shipments.length === 0) return null;

  return (
    <Card title="Shipments">
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
                ? 'Not dispatched yet'
                : `Dispatched ${new Date(shipment.dispatchedAt).toLocaleString()}`}
              {shipment.deliveredAt === null
                ? ''
                : ` · delivered ${new Date(shipment.deliveredAt).toLocaleString()}`}
            </p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Returns({ order }: { order: SellerOrderDetail }): React.JSX.Element | null {
  if (order.returns.length === 0) return null;

  return (
    <Card title="Returns">
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
              <p className="mt-1 text-xs text-ink-muted">You said: {entry.sellerResponse}</p>
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
  return (
    <Card title="What this earns">
      <dl className="space-y-2 px-6 py-5 text-sm">
        <Row label="Goods" value={formatMinor(order.goodsTotalMinor, order.currency)} />
        <Row label="Shipping" value={formatMinor(order.shippingTotalMinor, order.currency)} />
        <Row label="Tax" value={formatMinor(order.taxTotalMinor, order.currency)} />
        <Row
          label={
            order.commissionBasisPointsApplied === null
              ? 'Marketplace commission'
              : `Marketplace commission (${(order.commissionBasisPointsApplied / 100).toFixed(2)}%)`
          }
          value={`− ${formatMinor(order.commissionMinor, order.currency)}`}
        />
        <div className="border-t border-border-subtle pt-2">
          <Row
            label="Yours"
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
    <Card title="Deliver to">
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
  const canShip =
    order.status === 'PROCESSING' ||
    order.status === 'READY_FOR_DISPATCH' ||
    order.status === 'ACCEPTED';

  return (
    <Card title="What happens next">
      <div className="space-y-2 px-6 py-5">
        {canShip && (
          <Button
            variant="primary"
            className="w-full"
            onClick={() => {
              onShip();
            }}
          >
            Record a shipment
          </Button>
        )}

        {order.allowedTransitions.map((to) => (
          <Button
            key={to}
            variant={to === 'CANCELLED' ? 'danger' : 'secondary'}
            className="w-full"
            onClick={() => {
              onTransition(to as SellerOrderStatus);
            }}
          >
            {orderLabel(to as SellerOrderStatus)}
          </Button>
        ))}

        {order.allowedTransitions.length === 0 && !canShip && (
          <p className="text-sm text-ink-muted">
            Nothing to do here. This order has reached a state you cannot move it out of.
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
      toast.success(`${order.sellerOrderNumber} updated.`);
      onClose();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, 'That order could not be updated.'));
    },
  });

  const operational = (locations.data?.locations ?? []).filter(
    (location) => location.isOperational && location.isPickupLocation,
  );

  const canSubmit =
    (!needsReason || reason.trim().length > 0) && (!needsLocation || locationId.length > 0);

  return (
    <Modal isOpen title={`${orderLabel(to)} — ${order.sellerOrderNumber}`} onClose={onClose}>
      <div className="space-y-4">
        {needsLocation && (
          <Field
            label="Which of your locations ships this?"
            hint="This sets the dispatch deadline from that location's cut-off and handling time."
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
                <option value="">Choose a location</option>
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
          <Field label="Why?" hint="The buyer and the marketplace both see this." required>
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
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant={to === 'CANCELLED' ? 'danger' : 'primary'}
            isLoading={mutation.isPending}
            disabled={!canSubmit}
            onClick={() => {
              mutation.mutate();
            }}
          >
            {orderLabel(to)}
          </Button>
        </div>
      </div>
    </Modal>
  );
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
    .map((line) => ({ orderItemId: line.id, quantity: Number(quantities[line.id] ?? '0') }))
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
      toast.success('Shipment recorded. The buyer can track it now.');
      onClose();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, 'That shipment could not be recorded.'));
    },
  });

  const canSubmit =
    carrierName.trim().length > 0 && trackingNumber.trim().length > 0 && contents.length > 0;

  return (
    <Modal isOpen title={`Record a shipment — ${order.sellerOrderNumber}`} onClose={onClose}>
      <div className="space-y-4">
        <Field label="Carrier" hint="Whoever is carrying it — DHL, Blue Dart, your own van." required>
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

        <Field label="Tracking number" required>
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
          label="Tracking link"
          hint="Optional. Without it the buyer has a number and nowhere to type it."
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
          <legend className="text-sm font-medium text-ink">What is in this box?</legend>
          <p className="text-xs text-ink-muted">
            Filled in with everything still outstanding. Change a figure if you are sending part of
            the order.
          </p>

          <ul className="space-y-2">
            {order.lines.map((line) => {
              const outstanding = Math.max(0, line.quantity - line.fulfilledQuantity);

              return (
                <li key={line.id} className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">
                    {line.productName}
                    <span className="ml-2 text-xxs text-ink-subtle">{outstanding} left</span>
                  </span>
                  <Input
                    type="number"
                    min={0}
                    max={outstanding}
                    className="w-24"
                    aria-label={`Quantity of ${line.productName} in this shipment`}
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
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            isLoading={mutation.isPending}
            disabled={!canSubmit}
            onClick={() => {
              mutation.mutate();
            }}
          >
            Record it
          </Button>
        </div>
      </div>
    </Modal>
  );
}

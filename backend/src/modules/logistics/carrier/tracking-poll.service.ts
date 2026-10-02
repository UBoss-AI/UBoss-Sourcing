import { createHash } from 'node:crypto';
import { env } from '../../../config/env.js';
import { TRACKING_COMPLETE_STATUSES, type ShipmentStatusName } from '../../../domain/logistics-shipment-state.js';
import { prisma } from '../../../infra/prisma.js';
import { logger } from '../../../infra/logger.js';
import { JobType, queue } from '../../../infra/queue/index.js';
import { adapterForSellerConnection } from '../../seller/carrier-connection.service.js';
import { recordConnectionFailure, recordConnectionSuccess } from '../../seller/carrier-purchase.service.js';
import { recordShipmentEvent } from '../shipment-event.service.js';
import { adapterForIntegration } from './registry.js';
import type { CarrierAdapter, TrackingResult } from './adapter.js';

/** Technical maintenance cadence; provider calls remain in individually retried jobs. */
export const TRACKING_POLL_INTERVAL_MS = 15 * 60_000;
const active = new Set<string>();
const progress: Partial<Record<ShipmentStatusName, number>> = {
  CREATED: 0, AWAITING_ASSIGNMENT: 0, ASSIGNED: 0, ACCEPTANCE_PENDING: 0, ACCEPTED: 1,
  PICKUP_SCHEDULED: 2, READY_FOR_PICKUP: 3, PICKED_UP: 4, DISPATCHED: 4.5, AT_ORIGIN_HUB: 5,
  IN_TRANSIT: 6, AT_DESTINATION_HUB: 7, OUT_FOR_DELIVERY: 8, DELIVERY_ATTEMPTED: 8,
  DELIVERY_FAILED: 8, DELIVERED: 9, RETURN_REQUESTED: 10, RETURN_IN_TRANSIT: 11, RETURNED: 12,
};

/** Never schedule another job while the shipment's original poll is pending/running. */
export async function scheduleCarrierTrackingPolls(now = new Date(), shipmentIds?: readonly string[]): Promise<number> {
  if (!env.FEATURE_LOGISTICS_PORTAL) return 0;
  let cursor: string | undefined;
  let scheduled = 0;
  for (;;) {
    const rows = await prisma.logisticsShipment.findMany({
      where: {
        ...(shipmentIds === undefined ? {} : { id: { in: [...shipmentIds] } }),
        status: { notIn: [...TRACKING_COMPLETE_STATUSES] }, carrierTrackingNumber: { not: null },
        OR: [
          { sellerCarrierConnection: { state: 'ACTIVE', disconnectedAt: null } },
          { carrierIntegration: { isActive: true, state: 'ACTIVE', provider: { notIn: ['MANUAL', 'INDIA_POST'] } } },
        ],
      },
      select: { id: true }, orderBy: { id: 'asc' }, take: 100,
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      const key = `carrier-track:${row.id}`;
      const id = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM logistics_shipments WHERE id = ${row.id} FOR UPDATE`;
        const previous = await tx.jobQueue.findUnique({ where: { dedupeKey: key }, select: { status: true, completedAt: true } });
        if (previous?.status === 'PENDING' || previous?.status === 'RUNNING') return null;
        if (previous?.status === 'DEAD' && (previous.completedAt === null || now.getTime() - previous.completedAt.getTime() < TRACKING_POLL_INTERVAL_MS)) return null;
        // Keep completed/dead job evidence, releasing only its scheduling key.
        await tx.jobQueue.updateMany({ where: { dedupeKey: key, status: { in: ['SUCCEEDED', 'DEAD'] } }, data: { dedupeKey: null } });
        return queue.enqueue(JobType.CARRIER_TRACKING_POLL, { shipmentId: row.id }, { dedupeKey: key, maxAttempts: 5 }, tx);
      });
      if (id !== null) scheduled += 1;
    }
    cursor = rows.at(-1)?.id;
  }
  return scheduled;
}

type PollShipment = { sellerCarrierConnectionId: string | null; carrierIntegrationId: string | null };
type AdapterLoader = (shipment: PollShipment) => Promise<CarrierAdapter>;
const loadAdapter: AdapterLoader = shipment => shipment.sellerCarrierConnectionId !== null
  ? adapterForSellerConnection(shipment.sellerCarrierConnectionId)
  : adapterForIntegration(shipment.carrierIntegrationId);

/** A timed-out read's eventual response is discarded, so it cannot mark progress later. */
export async function readCarrierTracking(adapter: CarrierAdapter, trackingNumber: string, timeoutMs = 30_000): Promise<TrackingResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      adapter.getTracking(trackingNumber),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error('Carrier tracking read timed out.')); }, timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Carrier reads cannot invent a transition or release inspection/compliance gates. */
export async function pollCarrierTracking(shipmentId: string, load: AdapterLoader = loadAdapter): Promise<{ applied: number; ignored: number }> {
  const result = { applied: 0, ignored: 0 };
  if (!env.FEATURE_LOGISTICS_PORTAL || active.has(shipmentId)) return result;
  active.add(shipmentId);
  let connectionId: string | null = null;
  try {
    const shipment = await prisma.logisticsShipment.findUnique({
      where: { id: shipmentId },
      select: { status: true, carrierTrackingNumber: true, sellerCarrierConnectionId: true, carrierIntegrationId: true, sellerCarrierConnection: { select: { state: true, disconnectedAt: true } }, carrierIntegration: { select: { isActive: true, state: true } } },
    });
    if (shipment === null || TRACKING_COMPLETE_STATUSES.includes(shipment.status) || shipment.carrierTrackingNumber === null) return result;
    if (shipment.sellerCarrierConnectionId !== null) {
      if (shipment.sellerCarrierConnection?.state !== 'ACTIVE' || shipment.sellerCarrierConnection.disconnectedAt !== null) return result;
    } else if (shipment.carrierIntegration?.isActive !== true || shipment.carrierIntegration.state !== 'ACTIVE') return result;
    connectionId = shipment.sellerCarrierConnectionId;
    const adapter = await load(shipment);
    if (!adapter.isConfigured) throw new Error('Carrier tracking provider is not configured.');
    const tracking = await readCarrierTracking(adapter, shipment.carrierTrackingNumber);
    if (tracking.carrierTrackingNumber !== shipment.carrierTrackingNumber) throw new Error('Carrier returned another tracking reference.');
    const scope = `${shipment.sellerCarrierConnectionId ?? shipment.carrierIntegrationId}:${shipmentId}`;
    for (const event of [...tracking.events].sort((a,b) => a.occurredAt.getTime() - b.occurredAt.getTime())) {
      const current = await prisma.logisticsShipment.findUniqueOrThrow({ where: { id: shipmentId }, select: { status: true, version: true } });
      if (TRACKING_COMPLETE_STATUSES.includes(current.status)) break;
      const history = await prisma.logisticsShipmentEvent.groupBy({ by: ['status'], where: { shipmentId }, _max: { occurredAt: true } });
      const latest = Math.max(0, ...history.map(row => row._max.occurredAt?.getTime() ?? 0));
      const highest = Math.max(progress[current.status] ?? 0, ...history.map(row => progress[row.status] ?? 0));
      if (event.status === null || !Number.isFinite(event.occurredAt.getTime()) || event.occurredAt.getTime() < latest || event.status === current.status || (progress[event.status] !== undefined && (progress[event.status] as number) < highest)) {
        result.ignored += 1;
        logger.info({ shipmentId, status: event.status, externalStatusCode: event.externalStatusCode }, 'Tracking poll ignored unchanged, stale or unmapped progress');
        continue;
      }
      const eventIdentity = event.externalEventId ?? `${event.occurredAt.toISOString()}:${event.externalStatusCode ?? ''}:${event.status}`;
      const key = createHash('sha256').update(`${scope}\0${eventIdentity}`).digest('hex');
      try {
        const applied = await recordShipmentEvent({
          shipmentId, expectedVersion: current.version, status: event.status, actor: 'CARRIER', source: 'CARRIER_API',
          reason: event.description, publicDescription: event.description, occurredAt: event.occurredAt,
          locationLabel: event.locationLabel, locationCountry: event.locationCountry,
          locationLatitude: event.latitude, locationLongitude: event.longitude,
          carrierIntegrationId: shipment.carrierIntegrationId, externalEventId: event.externalEventId ?? key,
          externalEventScope: scope, externalStatusCode: event.externalStatusCode, idempotencyKey: key,
          revisedEtaAt: tracking.estimatedDeliveryAt,
        });
        if (!applied.duplicate) result.applied += 1;
        else result.ignored += 1;
      } catch (error) {
        // Invalid domain edges (including backward scans) are evidence, never status writes.
        if ((error as { code?: string }).code === 'SHIPMENT_TRANSITION_NOT_ALLOWED') {
          result.ignored += 1;
          logger.warn({ shipmentId, status: event.status }, 'Tracking poll refused an invalid or concurrent transition');
        } else throw error;
      }
    }
    if (connectionId !== null) await recordConnectionSuccess(connectionId);
    return result;
  } catch (error) {
    if (connectionId !== null) await recordConnectionFailure(connectionId, error);
    logger.warn({ shipmentId }, 'Carrier tracking poll failed; queue will retry with backoff');
    // Never put provider response bodies, tokens or credentials into queue errors.
    // eslint-disable-next-line preserve-caught-error -- Provider causes may contain credentials; redacted connection evidence is recorded above.
    throw new Error('Carrier tracking poll failed; inspect carrier connection health and retry the original job.');
  } finally {
    active.delete(shipmentId);
  }
}

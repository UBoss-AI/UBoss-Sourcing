/** LIVE-017: real queue/domain writes with an injected provider; no external API or HTTP login.
 * Reserved HTTP network for this file, if needed later: 10.97.0.*.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../src/config/env.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { queue } from '../../src/infra/queue/index.js';
import { createShipment } from '../../src/modules/logistics/shipment-create.service.js';
import { recordShipmentEvent } from '../../src/modules/logistics/shipment-event.service.js';
import { pollCarrierTracking, scheduleCarrierTrackingPolls, readCarrierTracking } from '../../src/modules/logistics/carrier/tracking-poll.service.js';
import type { CarrierAdapter, TrackingEvent } from '../../src/modules/logistics/carrier/adapter.js';
import type { ShipmentStatusName } from '../../src/domain/logistics-shipment-state.js';

const mutable = env as unknown as { FEATURE_LOGISTICS_PORTAL: boolean };
const originalFlag = mutable.FEATURE_LOGISTICS_PORTAL;
const ids: string[] = [];
let integrationId = '';
beforeAll(async () => {
  integrationId = newId();
  await prisma.carrierIntegration.create({ data: { id: integrationId, provider: 'DHL', name: 'Tracking poll test carrier', state: 'ACTIVE', isActive: true, webhookPathToken: `poll-test-${integrationId}` } });
});
beforeEach(() => { mutable.FEATURE_LOGISTICS_PORTAL = true; });
afterAll(async () => {
  mutable.FEATURE_LOGISTICS_PORTAL = originalFlag;
  await prisma.jobQueue.deleteMany({ where: { dedupeKey: { in: ids.map(id => `carrier-track:${id}`) } } });
  await prisma.logisticsShipmentEvent.deleteMany({ where: { shipmentId: { in: ids } } });
  await prisma.logisticsShipmentException.deleteMany({ where: { shipmentId: { in: ids } } });
  await prisma.logisticsShipmentPackage.deleteMany({ where: { shipmentId: { in: ids } } });
  await prisma.adminNotification.deleteMany({ where: { relatedId: { in: ids } } });
  await prisma.notificationOutbox.deleteMany({ where: { relatedId: { in: ids } } });
  await prisma.logisticsShipment.deleteMany({ where: { id: { in: ids } } });
  await prisma.carrierIntegration.deleteMany({ where: { id: integrationId } });
});
async function shipment(status: ShipmentStatusName = 'PICKED_UP') {
  const address = { line1: '1 Dock Road', city: 'Antwerp', postalCode: '2000', countryCode: 'BE' };
  const row = await createShipment({ sellerCompanyName: 'Poll test seller', receivingCompanyName: 'Poll test clinic', pickupAddress: address, deliveryAddress: address, packageCount: 1 });
  ids.push(row.id);
  await prisma.logisticsShipment.update({ where: { id: row.id }, data: { status, carrierIntegrationId: integrationId, carrierTrackingNumber: `POLL-${row.id}` } });
  return row.id;
}
function event(status: ShipmentStatusName, suffix = '1'): TrackingEvent {
  return { status, externalEventId: `scan-${suffix}`, externalStatusCode: 'PROVIDER_SCAN', description: 'Carrier scan', occurredAt: new Date(Date.now() + Number(suffix) * 1_000) };
}
function provider(id: string, events: TrackingEvent[]) {
  const getTracking = vi.fn(() => Promise.resolve({ carrierTrackingNumber: `POLL-${id}`, events, currentStatusCode: null, estimatedDeliveryAt: null }));
  const adapter = { isConfigured: true, getTracking } as unknown as CarrierAdapter;
  return { adapter, getTracking, load: () => Promise.resolve(adapter) };
}
const statusOf = async (id: string) => (await prisma.logisticsShipment.findUniqueOrThrow({ where: { id } })).status;
const scansOf = (id: string) => prisma.logisticsShipmentEvent.findMany({ where: { shipmentId: id, source: 'CARRIER_API' } });

describe('scheduled carrier tracking', () => {
  it('bounds a silent carrier call and discards its late response', async () => {
    let finish!: (value: never) => void;
    const hanging = new Promise<never>(resolve => { finish = resolve; });
    const adapter = { getTracking: () => hanging } as unknown as CarrierAdapter;
    await expect(readCarrierTracking(adapter, 'timeout-test', 10)).rejects.toThrow('timed out');
    // Resolving after the deadline cannot return tracking progress to the caller.
    finish(undefined as never);
  });
  it('applies a provider scan through the domain, preserving timestamp and raw reference', async () => {
    const id = await shipment(); const scan = event('IN_TRANSIT'); const p = provider(id, [scan]);
    expect(await pollCarrierTracking(id, p.load)).toMatchObject({ applied: 1 });
    expect(await statusOf(id)).toBe('IN_TRANSIT');
    expect(await scansOf(id)).toEqual([expect.objectContaining({ occurredAt: scan.occurredAt, externalEventId: scan.externalEventId, externalStatusCode: scan.externalStatusCode })]);
  });
  it('changes nothing for an unchanged status', async () => {
    const id = await shipment(); const p = provider(id, [event('PICKED_UP')]);
    expect(await pollCarrierTracking(id, p.load)).toMatchObject({ applied: 0 });
    expect(await scansOf(id)).toHaveLength(0);
  });
  it('deduplicates repeated provider events and repeated polling', async () => {
    const id = await shipment(); const scan = event('IN_TRANSIT'); const p = provider(id, [scan, scan]);
    await pollCarrierTracking(id, p.load); await pollCarrierTracking(id, p.load);
    expect(await scansOf(id)).toHaveLength(1);
  });
  it('does not poll a terminal shipment', async () => {
    const id = await shipment('DELIVERED'); const p = provider(id, [event('IN_TRANSIT')]);
    await pollCarrierTracking(id, p.load);
    expect(p.getTracking).not.toHaveBeenCalled(); expect(await statusOf(id)).toBe('DELIVERED');
    await scheduleCarrierTrackingPolls(new Date(), [id]);
    expect(await prisma.jobQueue.findUnique({ where: { dedupeKey: `carrier-track:${id}` } })).toBeNull();
  });
  it('refuses backward progress and an invalid forward domain edge', async () => {
    const id = await shipment('IN_TRANSIT'); await pollCarrierTracking(id, provider(id, [event('AT_ORIGIN_HUB')]).load);
    expect(await statusOf(id)).toBe('IN_TRANSIT'); expect(await scansOf(id)).toHaveLength(0);
    const created = await shipment('CREATED'); await pollCarrierTracking(created, provider(created, [event('OUT_FOR_DELIVERY')]).load);
    expect(await statusOf(created)).toBe('CREATED'); expect(await scansOf(created)).toHaveLength(0);
  });
  it.each(['timeout', 'provider outage'])('records %s without marking progress', async failure => {
    const id = await shipment(); const p = provider(id, []); p.getTracking.mockRejectedValue(new Error(failure));
    await expect(pollCarrierTracking(id, p.load)).rejects.toThrow('Carrier tracking poll failed');
    expect(await statusOf(id)).toBe('PICKED_UP'); expect(await scansOf(id)).toHaveLength(0);
    // A failed read does not leave the in-process overlap guard stuck.
    expect(await pollCarrierTracking(id, provider(id, [event('IN_TRANSIT')]).load)).toMatchObject({ applied: 1 });
  });
  it('uses one durable poll job, skips pending/running work and backs off a failure', async () => {
    const id = await shipment();
    await Promise.all([scheduleCarrierTrackingPolls(new Date(), [id]), scheduleCarrierTrackingPolls(new Date(), [id])]);
    const jobs = await prisma.jobQueue.findMany({ where: { dedupeKey: `carrier-track:${id}` } });
    expect(jobs).toHaveLength(1);
    const job = jobs[0]; if (job === undefined) throw new Error('Missing poll job');
    await prisma.jobQueue.update({ where: { id: job.id }, data: { status: 'RUNNING', attemptCount: 1 } });
    expect(await scheduleCarrierTrackingPolls(new Date(), [id])).toBe(0);
    await queue.fail(job.id, 'Carrier tracking read failed');
    const retry = await prisma.jobQueue.findUniqueOrThrow({ where: { id: job.id } });
    expect(retry.status).toBe('PENDING'); expect(retry.runAt.getTime()).toBeGreaterThan(Date.now());
  });
  it('protects concurrent reads and respects the scheduler feature flag', async () => {
    const id = await shipment(); let finish!: () => void;
    const waiting = new Promise<void>(resolve => { finish = resolve; });
    const p = provider(id, []); p.getTracking.mockImplementation(async () => { await waiting; return { carrierTrackingNumber: `POLL-${id}`, events: [], currentStatusCode: null, estimatedDeliveryAt: null }; });
    const first = pollCarrierTracking(id, p.load);
    await vi.waitFor(() => expect(p.getTracking).toHaveBeenCalledTimes(1));
    await pollCarrierTracking(id, p.load); finish(); await first;
    expect(p.getTracking).toHaveBeenCalledTimes(1);
    mutable.FEATURE_LOGISTICS_PORTAL = false;
    expect(await scheduleCarrierTrackingPolls(new Date(), [id])).toBe(0);
    await pollCarrierTracking(id, p.load); expect(p.getTracking).toHaveBeenCalledTimes(1);
  });
  it('rejects a stale polling version inside the domain transaction', async () => {
    const id = await shipment(); const row = await prisma.logisticsShipment.findUniqueOrThrow({ where: { id } });
    await prisma.logisticsShipment.update({ where: { id }, data: { version: { increment: 1 } } });
    await expect(recordShipmentEvent({ shipmentId: id, expectedVersion: row.version, status: 'IN_TRANSIT', actor: 'CARRIER', source: 'CARRIER_API' })).rejects.toMatchObject({ code: 'SHIPMENT_TRANSITION_NOT_ALLOWED' });
    expect(await statusOf(id)).toBe('PICKED_UP');
  });
});

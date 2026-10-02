/**
 * The integration monitor (JOURNEY-065).
 *
 * One read that says whether each outside connection is working: the payment
 * gateway, the carriers, the operator's warehouse ERP, buyers' own ERP
 * connections and the inspection agencies. For each webhook source it gives
 * when the last delivery arrived and how many were accepted and rejected in
 * the last 24 hours.
 *
 * Inspection has no outside API in this product: agencies work in the
 * in-app agency portal. Its "health" is therefore the portal's own service
 * level - jobs nobody accepted in time and reports that are overdue.
 *
 * `outage` is what the admin layout banner shows. It is raised when a source
 * the caller can see is DOWN, or when payments are DEGRADED, because those are
 * the two states where staff should expect customers to be affected.
 *
 * The storefront gets `paymentsDegraded()` only: a yes or no, no detail.
 */
import { Permission } from '../../domain/permissions.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import type { StaffActor } from './pending-action.service.js';

export type HealthStatus = 'ok' | 'degraded' | 'down' | 'not_configured';

export interface WebhookHealth {
  lastReceivedAt: string | null;
  accepted24h: number;
  rejected24h: number;
}

export interface IntegrationSource {
  key: 'payments' | 'carriers' | 'warehouseErp' | 'customerErp' | 'inspection';
  status: HealthStatus;
  /** Plain facts about the source, for the screen to show beside it. */
  facts: Record<string, number | string | null>;
  webhooks: WebhookHealth | null;
  /** Where the source is managed in the Admin Panel. */
  href: string;
}

export interface IntegrationHealth {
  generatedAt: string;
  sources: IntegrationSource[];
  outage: { active: boolean; sources: string[] };
}

const DAY_MS = 86_400_000;
const PAYMENT_GRACE_MS = 3_600_000;
/** A carrier failing this many times in a row is degraded, even before ERROR. */
const CARRIER_FAILURE_RUN = 3;

async function paymentsSource(since: Date): Promise<IntegrationSource> {
  const [active, accepted, rejected, last, unreconciled] = await Promise.all([
    prisma.paymentProviderConnection.findMany({
      where: { isActive: true },
      select: { provider: true, mode: true, lastTestedAt: true, lastTestStatus: true },
    }),
    prisma.paymentEvent.count({ where: { receivedAt: { gte: since }, processingStatus: { in: ['PROCESSED', 'DUPLICATE'] } } }),
    prisma.paymentEvent.count({ where: { receivedAt: { gte: since }, processingStatus: { in: ['REJECTED', 'FAILED'] } } }),
    prisma.paymentEvent.findFirst({ orderBy: { receivedAt: 'desc' }, select: { receivedAt: true } }),
    prisma.paymentTransaction.count({
      where: {
        status: { in: ['CREATED', 'PENDING', 'AUTHORIZED'] },
        createdAt: { lt: new Date(Date.now() - PAYMENT_GRACE_MS) },
      },
    }),
  ]);
  const failingTest = active.some((connection) => connection.lastTestStatus !== null && connection.lastTestStatus !== 'OK');
  const status: HealthStatus =
    active.length === 0 ? 'down' : failingTest || rejected > 0 ? 'degraded' : 'ok';
  return {
    key: 'payments',
    status,
    facts: {
      activeConnections: active.length,
      provider: active[0]?.provider ?? null,
      mode: active[0]?.mode ?? null,
      lastTestStatus: active[0]?.lastTestStatus ?? null,
      lastTestedAt: active[0]?.lastTestedAt?.toISOString() ?? null,
      unreconciledPayments: unreconciled,
    },
    webhooks: { lastReceivedAt: last?.receivedAt.toISOString() ?? null, accepted24h: accepted, rejected24h: rejected },
    href: '/integrations',
  };
}

async function carriersSource(since: Date): Promise<IntegrationSource> {
  const [integrations, accepted, rejected, last, deadLetters] = await Promise.all([
    prisma.carrierIntegration.findMany({
      where: { isActive: true, state: { notIn: ['DISABLED', 'UNCONFIGURED'] } },
      select: { state: true, consecutiveFailures: true },
    }),
    prisma.carrierWebhookEvent.count({ where: { receivedAt: { gte: since }, state: { in: ['PROCESSED', 'IGNORED'] } } }),
    prisma.carrierWebhookEvent.count({ where: { receivedAt: { gte: since }, state: { in: ['FAILED', 'DEAD_LETTER'] } } }),
    prisma.carrierWebhookEvent.findFirst({ orderBy: { receivedAt: 'desc' }, select: { receivedAt: true } }),
    prisma.carrierWebhookEvent.count({ where: { state: 'DEAD_LETTER' } }),
  ]);
  const degraded = integrations.filter(
    (row) => row.state === 'ERROR' || row.consecutiveFailures >= CARRIER_FAILURE_RUN,
  ).length;
  const status: HealthStatus =
    integrations.length === 0
      ? 'not_configured'
      : degraded === integrations.length
        ? 'down'
        : degraded > 0 || deadLetters > 0
          ? 'degraded'
          : 'ok';
  return {
    key: 'carriers',
    status,
    facts: { integrations: integrations.length, degraded, deadLetters },
    webhooks: { lastReceivedAt: last?.receivedAt.toISOString() ?? null, accepted24h: accepted, rejected24h: rejected },
    href: '/logistics/integrations',
  };
}

async function warehouseErpSource(since: Date): Promise<IntegrationSource> {
  const [connections, received, last, failedPushes] = await Promise.all([
    prisma.erpConnection.findMany({
      where: { status: { in: ['CONNECTED', 'ACTIVE', 'ERROR'] } },
      select: { status: true, circuitOpenedAt: true },
    }),
    prisma.erpWebhookReceipt.count({ where: { receivedAt: { gte: since } } }),
    prisma.erpWebhookReceipt.findFirst({ orderBy: { receivedAt: 'desc' }, select: { receivedAt: true } }),
    prisma.erpOrderPush.count({ where: { status: { in: ['FAILED', 'ABANDONED'] }, updatedAt: { gte: since } } }),
  ]);
  const unhealthy = connections.filter((row) => row.status === 'ERROR' || row.circuitOpenedAt !== null).length;
  const status: HealthStatus =
    connections.length === 0 ? 'not_configured' : unhealthy === connections.length ? 'down' : unhealthy > 0 || failedPushes > 0 ? 'degraded' : 'ok';
  return {
    key: 'warehouseErp',
    status,
    facts: { connections: connections.length, unhealthy, failedPushes24h: failedPushes },
    // An ERP receipt is only written once accepted; refusals are not stored.
    webhooks: { lastReceivedAt: last?.receivedAt.toISOString() ?? null, accepted24h: received, rejected24h: 0 },
    href: '/integrations',
  };
}

async function customerErpSource(since: Date): Promise<IntegrationSource> {
  const [live, breakerOpen, failedEvents, accepted, rejected, last] = await Promise.all([
    prisma.customerErpConnection.count({ where: { state: { in: ['ACTIVE', 'ACTION_REQUIRED', 'FAILED'] } } }),
    prisma.customerErpConnection.count({
      where: { OR: [{ state: 'FAILED' }, { circuitOpenedAt: { not: null } }] },
    }),
    prisma.customerErpSyncEvent.count({ where: { state: 'FAILED', updatedAt: { gte: since } } }),
    prisma.customerErpWebhookEvent.count({ where: { receivedAt: { gte: since }, verified: true } }),
    prisma.customerErpWebhookEvent.count({ where: { receivedAt: { gte: since }, verified: false } }),
    prisma.customerErpWebhookEvent.findFirst({ orderBy: { receivedAt: 'desc' }, select: { receivedAt: true } }),
  ]);
  // Each buyer's ERP is theirs: one failing is degraded for that buyer, never
  // an outage of the marketplace.
  const status: HealthStatus = live === 0 ? 'not_configured' : breakerOpen > 0 || failedEvents > 0 ? 'degraded' : 'ok';
  return {
    key: 'customerErp',
    status,
    facts: { connections: live, unhealthy: breakerOpen, failedEvents24h: failedEvents },
    webhooks: { lastReceivedAt: last?.receivedAt.toISOString() ?? null, accepted24h: accepted, rejected24h: rejected },
    href: '/customer-erp',
  };
}

async function inspectionSource(now: Date): Promise<IntegrationSource> {
  const [agencies, acceptOverdue, reportOverdue] = await Promise.all([
    prisma.inspectionAgency.count({ where: { status: 'ACTIVE' } }),
    prisma.inspectionJob.count({ where: { status: 'REQUESTED', acceptDueAt: { lt: now } } }),
    prisma.inspectionJob.count({
      where: { status: { in: ['ACCEPTED', 'INSPECTOR_ASSIGNED', 'IN_PROGRESS'] }, reportDueAt: { lt: now } },
    }),
  ]);
  const status: HealthStatus = agencies === 0 ? 'not_configured' : acceptOverdue + reportOverdue > 0 ? 'degraded' : 'ok';
  return {
    key: 'inspection',
    status,
    facts: { activeAgencies: agencies, acceptOverdue, reportOverdue },
    webhooks: null,
    href: '/inspection',
  };
}

/** Every source the caller may see. A source that fails to read is reported DOWN. */
export async function readIntegrationHealth(viewer: { permissions: readonly string[] }): Promise<IntegrationHealth> {
  const granted = new Set(viewer.permissions);
  const now = new Date();
  const since = new Date(now.getTime() - DAY_MS);

  const readers: { key: IntegrationSource['key']; permission: string; href: string; read: () => Promise<IntegrationSource> }[] = [
    { key: 'payments', permission: Permission.PAYMENT_READ, href: '/integrations', read: () => paymentsSource(since) },
    { key: 'carriers', permission: Permission.LOGISTICS_READ, href: '/logistics/integrations', read: () => carriersSource(since) },
    { key: 'warehouseErp', permission: Permission.INTEGRATION_READ, href: '/integrations', read: () => warehouseErpSource(since) },
    { key: 'customerErp', permission: Permission.INTEGRATION_READ, href: '/customer-erp', read: () => customerErpSource(since) },
    { key: 'inspection', permission: Permission.INSPECTION_READ, href: '/inspection', read: () => inspectionSource(now) },
  ];

  const sources = await Promise.all(
    readers
      .filter((reader) => granted.has(reader.permission))
      .map(async (reader) => {
        try {
          return await reader.read();
        } catch {
          return { key: reader.key, status: 'down' as const, facts: { readFailed: 1 }, webhooks: null, href: reader.href };
        }
      }),
  );

  const outageSources = sources
    .filter((source) => source.status === 'down' || (source.key === 'payments' && source.status === 'degraded'))
    .map((source) => source.key);

  return { generatedAt: now.toISOString(), sources, outage: { active: outageSources.length > 0, sources: outageSources } };
}

/**
 * Whether shoppers should be warned that card payments may fail.
 *
 * No connection switched on, a failed connection test, or three or more
 * refused payment webhooks in the last hour. A yes or no only: the
 * storefront never learns which provider or why.
 */
export async function paymentsDegraded(): Promise<boolean> {
  const [active, refused] = await Promise.all([
    prisma.paymentProviderConnection.findMany({ where: { isActive: true }, select: { lastTestStatus: true } }),
    prisma.paymentEvent.count({
      where: { receivedAt: { gte: new Date(Date.now() - 3_600_000) }, processingStatus: { in: ['REJECTED', 'FAILED'] } },
    }),
  ]);
  if (active.length === 0) return true;
  if (active.every((row) => row.lastTestStatus !== null && row.lastTestStatus !== 'OK')) return true;
  return refused >= 3;
}

/**
 * Put dead-lettered carrier webhooks back on the retry queue.
 *
 * They become FAILED with a fresh attempt count and are due now, so the
 * worker's ordinary retry sweep processes them on its next run. A webhook that
 * fails again goes through the normal backoff and, eventually, the dead-letter
 * queue again.
 */
export async function requeueCarrierDeadLetters(
  carrierIntegrationId: string | null,
  actor: StaffActor,
): Promise<{ requeued: number }> {
  const result = await prisma.carrierWebhookEvent.updateMany({
    where: { state: 'DEAD_LETTER', ...(carrierIntegrationId === null ? {} : { carrierIntegrationId }) },
    data: { state: 'FAILED', attempts: 0, nextRetryAt: new Date(), deadLetteredAt: null },
  });
  await recordAudit({
    action: AuditAction.CARRIER_WEBHOOKS_REQUEUED,
    resourceType: 'carrier_integration',
    resourceId: carrierIntegrationId,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    before: null,
    after: { requeued: result.count, carrierIntegrationId },
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });
  return { requeued: result.count };
}

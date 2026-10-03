/**
 * The exception centre (ENH-019): one queue of the six kinds of thing that
 * went wrong - a failed payment, a missing document, a failed inspection, a
 * late shipment, a settlement that does not reconcile and an integration that
 * stopped. Built on the operations overview, so its counts and permission
 * gating are the dashboard's; it adds only the split of consignment
 * exceptions into missing documents and late shipments.
 *
 * A type the caller may not act on is absent, not zero - the overview's rule.
 */
import { Permission } from '../../domain/permissions.js';
import { prisma } from '../../infra/prisma.js';
import { readOperationsOverview, type OperationsQueue, type OperationsViewer } from './operations-overview.service.js';

export type ExceptionType = 'FAILED_PAYMENT' | 'MISSING_DOCUMENT' | 'INSPECTION_NCR' | 'LATE_SHIPMENT' | 'SETTLEMENT_MISMATCH' | 'INTEGRATION_FAILURE';

export interface ExceptionItem {
  type: ExceptionType;
  source: string;
  count: number;
  severity: OperationsQueue['severity'];
  href: string;
}

const FROM_OVERVIEW: Record<string, ExceptionType> = {
  paymentsUnreconciled: 'FAILED_PAYMENT',
  paymentWebhooksRejected: 'FAILED_PAYMENT',
  scheduleOccurrencesFailed: 'FAILED_PAYMENT',
  complianceExpiring: 'MISSING_DOCUMENT',
  inspectionsFailed: 'INSPECTION_NCR',
  settlementsOnHold: 'SETTLEMENT_MISMATCH',
  erpConnectionsUnhealthy: 'INTEGRATION_FAILURE',
  carrierIntegrationsDegraded: 'INTEGRATION_FAILURE',
  customerErpEventsFailed: 'INTEGRATION_FAILURE',
  jobsDead: 'INTEGRATION_FAILURE',
  notificationsFailed: 'INTEGRATION_FAILURE',
};

const LATE = ['PICKUP_MISSED', 'PACKAGE_NOT_READY', 'CUSTOMS_DELAY', 'WEATHER_DELAY', 'VEHICLE_BREAKDOWN', 'DELIVERY_ATTEMPT_FAILED', 'SLA_RISK', 'SLA_BREACH'] as const;
const RANK = { urgent: 0, attention: 1, info: 2 } as const;

export async function readExceptionCentre(viewer: OperationsViewer): Promise<{ generatedAt: string; total: number; items: ExceptionItem[]; types: { type: ExceptionType; count: number }[] }> {
  const overview = await readOperationsOverview(viewer);
  const items: ExceptionItem[] = overview.queues
    .filter((queue) => queue.key in FROM_OVERVIEW)
    .map((queue) => ({ type: FROM_OVERVIEW[queue.key] as ExceptionType, source: queue.key, count: queue.count, severity: queue.severity, href: queue.href }));
  if (viewer.permissions.includes(Permission.LOGISTICS_READ)) {
    const open = { state: { in: ['OPEN', 'ESCALATED'] as ('OPEN' | 'ESCALATED')[] } };
    const [documents, late] = await Promise.all([
      prisma.logisticsShipmentException.count({ where: { ...open, type: 'DOCUMENTATION_MISSING' } }),
      prisma.logisticsShipmentException.count({ where: { ...open, type: { in: [...LATE] } } }),
    ]);
    items.push(
      { type: 'MISSING_DOCUMENT', source: 'shipmentDocumentsMissing', count: documents, severity: 'urgent', href: '/logistics/shipments?exception=open' },
      { type: 'LATE_SHIPMENT', source: 'shipmentsLate', count: late, severity: 'urgent', href: '/logistics/shipments?exception=open' },
    );
  }
  const totals = new Map<ExceptionType, number>();
  for (const item of items) totals.set(item.type, (totals.get(item.type) ?? 0) + item.count);
  const ranked = items
    .filter((item) => item.count > 0)
    .sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.count - a.count || (a.source < b.source ? -1 : 1));
  return {
    generatedAt: overview.generatedAt,
    total: ranked.reduce((sum, item) => sum + item.count, 0),
    items: ranked,
    types: [...totals.entries()].map(([type, count]) => ({ type, count })),
  };
}

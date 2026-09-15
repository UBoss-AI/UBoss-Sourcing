/**
 * The numbers a dispatcher opens the portal for.
 *
 * EVERY FIGURE IS AGGREGATED SERVER-SIDE. Nothing here returns a list for the
 * browser to count, and nothing in the portal computes a total from rows it
 * was sent - the two together are how a dashboard ends up disagreeing with the
 * list it links to, and the disagreement is always discovered by a customer.
 *
 * The queries are grouped counts over indexed columns, run in parallel. On a
 * table of millions this is the difference between a dashboard and a timeout:
 * a single `groupBy` on `(assignedPartnerId, status)` answers fourteen of the
 * cards below, and the index it uses is the one the shipment list already
 * needs.
 *
 * SLA counts read the STORED `slaState` column rather than recomputing a
 * window over every open row. The list and the detail page recompute live -
 * see `shipment.service.ts` - and the two agree because both call
 * `assessSla`; the column is a projection the sweep maintains so that counting
 * does not cost a table scan.
 */
import type { LogisticsShipmentStatus } from '../../generated/prisma/enums.js';
import { LogisticsPermission } from '../../domain/logistics-permissions.js';
import { onTimePercentage } from '../../domain/logistics-sla.js';
import type { ShipmentStatusName } from '../../domain/logistics-shipment-state.js';
import { prisma } from '../../infra/prisma.js';
import { OPEN_EXCEPTION_STATES } from './exception.service.js';
import {
  assertLogisticsPermission,
  type LogisticsMembership,
} from './partner.service.js';

export interface DashboardFilters {
  from?: Date | null;
  to?: Date | null;
  originLocationId?: string | null;
  sellerCompany?: string | null;
  destinationCountry?: string | null;
  serviceType?: string | null;
}

export interface DashboardCounts {
  assignedToday: number;
  acceptancePending: number;
  pickupPending: number;
  pickedUp: number;
  dispatched: number;
  inTransit: number;
  outForDelivery: number;
  deliveredToday: number;
  delayed: number;
  exceptions: number;
  failedDeliveries: number;
  returns: number;
  slaAtRisk: number;
  slaBreached: number;
}

export interface DashboardMetrics {
  /** Null with no delivery history. Never 100 - see `onTimePercentage`. */
  onTimeDeliveryPercentage: number | null;
  /** Hours from collection to delivery, over the window. Null with no data. */
  averageTransitHours: number | null;
  /** Delivered on the first attempt, as a percentage. Null with no data. */
  firstAttemptSuccessPercentage: number | null;
  proofOfDeliveryPending: number;
}

export interface IntegrationHealth {
  /** Null where this carrier works entirely inside the portal. */
  provider: string | null;
  state: string | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  consecutiveFailures: number;
  /** When a carrier feed last told us anything about any consignment. */
  lastTrackingSyncAt: Date | null;
  deadLetteredEvents: number;
}

export interface DashboardActivity {
  shipmentId: string;
  shipmentReference: string;
  status: ShipmentStatusName;
  receivingCompanyName: string;
  occurredAt: Date;
  publicDescription: string | null;
}

export interface LogisticsDashboard {
  counts: DashboardCounts;
  metrics: DashboardMetrics;
  statusDistribution: { status: ShipmentStatusName; count: number }[];
  recentActivity: DashboardActivity[];
  urgentExceptions: {
    id: string;
    shipmentId: string;
    shipmentReference: string;
    type: string;
    severity: string;
    reason: string;
    createdAt: Date;
  }[];
  upcomingPickups: {
    id: string;
    shipmentReference: string | null;
    warehouseName: string | null;
    windowStartAt: Date;
    windowEndAt: Date;
  }[];
  deliveriesDueToday: {
    shipmentId: string;
    shipmentReference: string;
    receivingCompanyName: string;
    destinationCity: string | null;
    estimatedDeliveryAt: Date | null;
  }[];
  integration: IntegrationHealth;
}

/** Statuses that mean "collected but not yet moving". */
const PICKUP_PENDING: LogisticsShipmentStatus[] = [
  'ACCEPTED',
  'PICKUP_SCHEDULED',
  'READY_FOR_PICKUP',
];

const RETURN_STATUSES: LogisticsShipmentStatus[] = [
  'RETURN_REQUESTED',
  'RETURN_IN_TRANSIT',
  'RETURNED',
];

function startOfDay(now: Date): Date {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start;
}

function endOfDay(now: Date): Date {
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return end;
}

/**
 * The whole dashboard, in one call.
 *
 * One call rather than fourteen, because a screen that fires fourteen requests
 * on load is a screen whose cards populate at fourteen different moments - and
 * on a slow connection a dispatcher reads the third number before the first
 * has arrived and acts on a half-drawn page.
 */
export async function readDashboard(
  membership: LogisticsMembership,
  filters: DashboardFilters = {},
  now = new Date(),
): Promise<LogisticsDashboard> {
  assertLogisticsPermission(membership, LogisticsPermission.SHIPMENT_READ);

  const partnerId = membership.logisticsPartnerId;
  const dayStart = startOfDay(now);
  const dayEnd = endOfDay(now);

  const windowFrom = filters.from ?? new Date(now.getTime() - 30 * 86_400_000);
  const windowTo = filters.to ?? now;

  const scope = {
    assignedPartnerId: partnerId,
    ...((filters.originLocationId !== undefined && filters.originLocationId !== null) ? { originLocationId: filters.originLocationId } : {}),
    ...((filters.destinationCountry !== undefined && filters.destinationCountry !== null)
      ? { destinationCountry: filters.destinationCountry.toUpperCase() }
      : {}),
    ...((filters.sellerCompany !== undefined && filters.sellerCompany !== null)
      ? { sellerCompanyName: { contains: filters.sellerCompany } }
      : {}),
  };

  const [
    byStatus,
    assignedToday,
    deliveredToday,
    slaAtRisk,
    slaBreached,
    openExceptions,
    podPending,
    deliveredWindow,
    recentEvents,
    urgentExceptions,
    upcomingPickups,
    dueToday,
    integration,
  ] = await Promise.all([
    // One grouped count answers most of the cards.
    prisma.logisticsShipment.groupBy({
      by: ['status'],
      where: scope,
      _count: { _all: true },
    }),

    prisma.logisticsShipment.count({
      where: {
        ...scope,
        assignments: {
          some: { logisticsPartnerId: partnerId, offeredAt: { gte: dayStart, lte: dayEnd } },
        },
      },
    }),

    prisma.logisticsShipment.count({
      where: { ...scope, deliveredAt: { gte: dayStart, lte: dayEnd } },
    }),

    prisma.logisticsShipment.count({ where: { ...scope, slaState: 'AT_RISK' } }),
    prisma.logisticsShipment.count({ where: { ...scope, slaState: 'BREACHED' } }),

    prisma.logisticsShipmentException.count({
      where: { logisticsPartnerId: partnerId, state: { in: OPEN_EXCEPTION_STATES } },
    }),

    // Delivered with no proof attached. The number an operations manager
    // chases before a customer does.
    prisma.logisticsShipment.count({
      where: { ...scope, status: 'DELIVERED', proofOfDelivery: { is: null } },
    }),

    // The window the rate metrics are computed over.
    prisma.logisticsShipment.findMany({
      where: {
        ...scope,
        deliveredAt: { gte: windowFrom, lte: windowTo, not: null },
      },
      take: 5000,
      select: {
        deliveredAt: true,
        deliveryDueAt: true,
        pickedUpAt: true,
        deliveryAttemptCount: true,
      },
    }),

    prisma.logisticsShipmentEvent.findMany({
      where: { shipment: scope },
      orderBy: { recordedAt: 'desc' },
      take: 12,
      select: {
        shipmentId: true,
        status: true,
        occurredAt: true,
        publicDescription: true,
        shipment: { select: { shipmentReference: true, receivingCompanyName: true } },
      },
    }),

    prisma.logisticsShipmentException.findMany({
      where: {
        logisticsPartnerId: partnerId,
        state: { in: OPEN_EXCEPTION_STATES },
        severity: { in: ['HIGH', 'CRITICAL'] },
      },
      orderBy: [{ severity: 'desc' }, { createdAt: 'asc' }],
      take: 8,
      select: {
        id: true,
        shipmentId: true,
        type: true,
        severity: true,
        reason: true,
        createdAt: true,
        shipment: { select: { shipmentReference: true } },
      },
    }),

    prisma.logisticsPickupRequest.findMany({
      where: {
        logisticsPartnerId: partnerId,
        state: { in: ['REQUESTED', 'SCHEDULED', 'CONFIRMED'] },
        windowStartAt: { gte: dayStart, lte: new Date(dayEnd.getTime() + 86_400_000) },
      },
      orderBy: { windowStartAt: 'asc' },
      take: 10,
      select: {
        id: true,
        windowStartAt: true,
        windowEndAt: true,
        shipment: { select: { shipmentReference: true } },
        location: { select: { name: true } },
      },
    }),

    prisma.logisticsShipment.findMany({
      where: {
        ...scope,
        estimatedDeliveryAt: { gte: dayStart, lte: dayEnd },
        status: { notIn: ['DELIVERED', 'CANCELLED', 'RETURNED', 'LOST'] },
      },
      orderBy: { estimatedDeliveryAt: 'asc' },
      take: 12,
      select: {
        id: true,
        shipmentReference: true,
        receivingCompanyName: true,
        destinationCity: true,
        estimatedDeliveryAt: true,
      },
    }),

    readIntegrationHealth(partnerId),
  ]);

  const counts = new Map<string, number>(
    byStatus.map((row) => [row.status, row._count._all]),
  );

  const sumOf = (statuses: readonly LogisticsShipmentStatus[]): number =>
    statuses.reduce((total, status) => total + (counts.get(status) ?? 0), 0);

  return {
    counts: {
      assignedToday,
      acceptancePending: counts.get('ACCEPTANCE_PENDING') ?? 0,
      pickupPending: sumOf(PICKUP_PENDING),
      pickedUp: counts.get('PICKED_UP') ?? 0,
      dispatched: counts.get('DISPATCHED') ?? 0,
      inTransit: (counts.get('IN_TRANSIT') ?? 0) + (counts.get('AT_ORIGIN_HUB') ?? 0) + (counts.get('AT_DESTINATION_HUB') ?? 0),
      outForDelivery: counts.get('OUT_FOR_DELIVERY') ?? 0,
      deliveredToday,
      delayed: counts.get('DELAYED') ?? 0,
      exceptions: openExceptions,
      failedDeliveries: (counts.get('DELIVERY_FAILED') ?? 0) + (counts.get('DELIVERY_ATTEMPTED') ?? 0),
      returns: sumOf(RETURN_STATUSES),
      slaAtRisk,
      slaBreached,
    },

    metrics: computeMetrics(deliveredWindow, podPending),

    statusDistribution: byStatus
      .map((row) => ({ status: row.status, count: row._count._all }))
      .sort((a, b) => b.count - a.count),

    recentActivity: recentEvents.map((event) => ({
      shipmentId: event.shipmentId,
      shipmentReference: event.shipment.shipmentReference,
      status: event.status,
      receivingCompanyName: event.shipment.receivingCompanyName,
      occurredAt: event.occurredAt,
      publicDescription: event.publicDescription,
    })),

    urgentExceptions: urgentExceptions.map((row) => ({
      id: row.id,
      shipmentId: row.shipmentId,
      shipmentReference: row.shipment.shipmentReference,
      type: row.type,
      severity: row.severity,
      reason: row.reason,
      createdAt: row.createdAt,
    })),

    upcomingPickups: upcomingPickups.map((row) => ({
      id: row.id,
      shipmentReference: row.shipment?.shipmentReference ?? null,
      warehouseName: row.location?.name ?? null,
      windowStartAt: row.windowStartAt,
      windowEndAt: row.windowEndAt,
    })),

    deliveriesDueToday: dueToday.map((row) => ({
      shipmentId: row.id,
      shipmentReference: row.shipmentReference,
      receivingCompanyName: row.receivingCompanyName,
      destinationCity: row.destinationCity,
      estimatedDeliveryAt: row.estimatedDeliveryAt,
    })),

    integration,
  };
}

/**
 * The three rates, from one sample of delivered consignments.
 *
 * Each is null rather than a flattering default when there is nothing to
 * measure. A brand-new carrier showing 100% on-time is the single most
 * misleading number an operations dashboard can display, because it is exactly
 * the carrier somebody is deciding whether to trust.
 */
function computeMetrics(
  delivered: {
    deliveredAt: Date | null;
    deliveryDueAt: Date | null;
    pickedUpAt: Date | null;
    deliveryAttemptCount: number;
  }[],
  podPending: number,
): DashboardMetrics {
  const measurable = delivered.filter(
    (row): row is typeof row & { deliveredAt: Date; deliveryDueAt: Date } =>
      row.deliveredAt !== null && row.deliveryDueAt !== null,
  );

  const onTime = measurable.filter(
    (row) => row.deliveredAt.getTime() <= row.deliveryDueAt.getTime(),
  ).length;

  const withTransit = delivered.filter(
    (row): row is typeof row & { deliveredAt: Date; pickedUpAt: Date } =>
      row.deliveredAt !== null && row.pickedUpAt !== null,
  );

  const transitHours =
    withTransit.length === 0
      ? null
      : Math.round(
          (withTransit.reduce(
            (total, row) => total + (row.deliveredAt.getTime() - row.pickedUpAt.getTime()),
            0,
          ) /
            withTransit.length /
            3_600_000) *
            10,
        ) / 10;

  const firstAttempt =
    delivered.length === 0
      ? null
      : Math.round(
          (delivered.filter((row) => row.deliveryAttemptCount === 0).length / delivered.length) *
            1000,
        ) / 10;

  return {
    onTimeDeliveryPercentage: onTimePercentage(measurable.length, onTime),
    averageTransitHours: transitHours,
    firstAttemptSuccessPercentage: firstAttempt,
    proofOfDeliveryPending: podPending,
  };
}

/**
 * Is the carrier feed working, and when did it last say anything?
 *
 * Every field is null for a carrier that works entirely inside the portal,
 * which is the ordinary case and is not an error state. The portal renders it
 * as "Manual - no carrier API connected", never as a red light.
 */
async function readIntegrationHealth(partnerId: string): Promise<IntegrationHealth> {
  const partner = await prisma.logisticsPartner.findUnique({
    where: { id: partnerId },
    select: {
      carrierIntegrationId: true,
      carrierIntegration: {
        select: {
          provider: true,
          state: true,
          lastSuccessAt: true,
          lastFailureAt: true,
          consecutiveFailures: true,
        },
      },
    },
  });

  const [lastSync, deadLettered] = await Promise.all([
    prisma.logisticsShipment.aggregate({
      where: { assignedPartnerId: partnerId, lastCarrierSyncAt: { not: null } },
      _max: { lastCarrierSyncAt: true },
    }),
    (partner?.carrierIntegrationId === undefined || partner?.carrierIntegrationId === null)
      ? Promise.resolve(0)
      : prisma.carrierWebhookEvent.count({
          where: { carrierIntegrationId: partner.carrierIntegrationId, state: 'DEAD_LETTER' },
        }),
  ]);

  return {
    provider: partner?.carrierIntegration?.provider ?? null,
    state: partner?.carrierIntegration?.state ?? null,
    lastSuccessAt: partner?.carrierIntegration?.lastSuccessAt ?? null,
    lastFailureAt: partner?.carrierIntegration?.lastFailureAt ?? null,
    consecutiveFailures: partner?.carrierIntegration?.consecutiveFailures ?? 0,
    lastTrackingSyncAt: lastSync._max.lastCarrierSyncAt,
    deadLetteredEvents: deadLettered,
  };
}

// ---------------------------------------------------------------------------
// Company-wise view
// ---------------------------------------------------------------------------

export interface CompanyRow {
  name: string;
  type: 'SELLER' | 'RECEIVER';
  activeShipments: number;
  inTransitShipments: number;
  deliveredShipments: number;
  delayedShipments: number;
  lastShipmentAt: Date | null;
  mainRegions: string[];
  onTimePercentage: number | null;
}

/**
 * The companies this carrier ships for, and the counts beside each.
 *
 * Built from the carrier's OWN consignments and from nothing else. There is no
 * query here that touches the customer table, the seller table, an order line
 * or a payment - a carrier learns that it moves twelve consignments a month
 * for a named hospital, and nothing about what that hospital buys, from whom,
 * or for how much.
 *
 * Grouped in the database rather than in JavaScript, so a carrier with a
 * hundred thousand consignments does not page them all into memory to count
 * distinct names.
 */
export async function listCompanies(
  membership: LogisticsMembership,
  type: 'SELLER' | 'RECEIVER',
): Promise<CompanyRow[]> {
  assertLogisticsPermission(membership, LogisticsPermission.COMPANY_READ);

  const field = type === 'SELLER' ? 'sellerCompanyName' : 'receivingCompanyName';

  const grouped = await prisma.logisticsShipment.groupBy({
    by: [field, 'status'],
    where: {
      assignments: { some: { logisticsPartnerId: membership.logisticsPartnerId } },
    },
    _count: { _all: true },
    _max: { createdAt: true },
  });

  const byName = new Map<string, CompanyRow>();

  for (const row of grouped) {
    const name = (row as unknown as Record<string, string>)[field] ?? '';
    if (name.length === 0) continue;

    const entry = byName.get(name) ?? {
      name,
      type,
      activeShipments: 0,
      inTransitShipments: 0,
      deliveredShipments: 0,
      delayedShipments: 0,
      lastShipmentAt: null,
      mainRegions: [],
      onTimePercentage: null,
    };

    const count = row._count._all;
    const status = row.status;

    if (status === 'DELIVERED') entry.deliveredShipments += count;
    else if (status === 'DELAYED') {
      entry.delayedShipments += count;
      entry.activeShipments += count;
    } else if (status === 'CANCELLED' || status === 'RETURNED' || status === 'LOST') {
      // Closed, and not "active". Counted nowhere but the totals a person can
      // reach by filtering the list.
    } else {
      entry.activeShipments += count;
      if (
        status === 'IN_TRANSIT' ||
        status === 'AT_ORIGIN_HUB' ||
        status === 'AT_DESTINATION_HUB' ||
        status === 'OUT_FOR_DELIVERY' ||
        status === 'DISPATCHED'
      ) {
        entry.inTransitShipments += count;
      }
    }

    const last = row._max.createdAt;
    if (last !== null && (entry.lastShipmentAt === null || last > entry.lastShipmentAt)) {
      entry.lastShipmentAt = last;
    }

    byName.set(name, entry);
  }

  const rows = [...byName.values()].sort(
    (a, b) => b.activeShipments - a.activeShipments || a.name.localeCompare(b.name),
  );

  // The regions each company's work lands in. A second grouped query rather
  // than a join, because it is a different grouping and merging them would
  // multiply the row count by the number of countries.
  const regions = await prisma.logisticsShipment.groupBy({
    by: [field, 'destinationCountry'],
    where: {
      assignments: { some: { logisticsPartnerId: membership.logisticsPartnerId } },
    },
    _count: { _all: true },
  });

  const regionsByName = new Map<string, { country: string; count: number }[]>();

  for (const row of regions) {
    const name = (row as unknown as Record<string, string>)[field] ?? '';
    if (name.length === 0) continue;
    const list = regionsByName.get(name) ?? [];
    list.push({ country: row.destinationCountry, count: row._count._all });
    regionsByName.set(name, list);
  }

  for (const row of rows) {
    row.mainRegions = (regionsByName.get(row.name) ?? [])
      .sort((a, b) => b.count - a.count)
      .slice(0, 4)
      .map((entry) => entry.country);
  }

  return rows;
}

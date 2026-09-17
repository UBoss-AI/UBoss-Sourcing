/**
 * Guards on what the insights panel is allowed to say.
 *
 * These are the controls that make it safe to point a language model at real
 * operational data, so they are tested against the behaviour that matters
 * rather than against the shape of the output:
 *
 *   - a citation of a figure nobody measured never reaches the reader;
 *   - a link is never something the model wrote;
 *   - a deployment with no provider gets an honest answer rather than a
 *     fabricated one.
 *
 * `buildInsight` itself calls the provider, so it is not exercised here — the
 * unit under test is everything around that call. The deterministic path IS
 * exercised, because it is the path most deployments will actually run.
 */
import { describe, expect, it } from 'vitest';
import {
  deterministicInsight,
  type InsightMetric,
  type InsightRequest,
} from '../../src/modules/assistant/insights.service.js';
import {
  ATTENTION_PLACEMENT_KEYS,
  OperationsGroup,
} from '../../src/modules/notifications/operations-overview.service.js';
import { AttentionKey } from '../../src/modules/notifications/attention.service.js';
import { logisticsInsightMetrics } from '../../src/modules/logistics/dashboard.service.js';
import type { LogisticsDashboard } from '../../src/modules/logistics/dashboard.service.js';

const METRICS: InsightMetric[] = [
  {
    key: 'ops.listingReview',
    label: 'Product listings submitted for review',
    value: 12,
    unit: 'items',
    severity: 'attention',
    href: '/listing-review',
  },
  {
    key: 'ops.dataRequests',
    label: 'Data-subject requests inside their statutory clock',
    value: 2,
    unit: 'items',
    severity: 'urgent',
    href: '/data-requests',
  },
  {
    key: 'ops.total',
    label: 'Everything waiting',
    value: 14,
    unit: 'items',
    severity: 'info',
    href: '/dashboard',
  },
];

function request(overrides: Partial<InsightRequest> = {}): InsightRequest {
  return {
    audience: 'ADMIN',
    window: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-17T00:00:00.000Z' },
    filters: {},
    metrics: METRICS,
    ...overrides,
  };
}

describe('the deterministic insight', () => {
  it('says which path produced it, rather than posing as a model reply', () => {
    // The point of the whole fallback. A dashboard that invents an AI voice
    // when there is no AI behind it is lying about the one thing a reader
    // might act on.
    const insight = deterministicInsight(request(), 'not-configured');

    expect(insight.source).toBe('deterministic');
    expect(insight.model).toBeNull();
    expect(insight.fallbackReason).toBe('not-configured');
  });

  it('ranks urgent work above merely busy work', () => {
    const insight = deterministicInsight(request(), 'not-configured');

    // Two data-subject requests outrank twelve listings, because a statutory
    // clock is running on one of them and not the other. Size is not urgency.
    expect(insight.findings[0]?.evidence).toEqual(['ops.dataRequests']);
    expect(insight.findings[1]?.evidence).toEqual(['ops.listingReview']);
  });

  it('cites only metrics it was given', () => {
    const insight = deterministicInsight(request(), 'unavailable');

    const allowed = new Set(METRICS.map((metric) => metric.key));

    for (const finding of insight.findings) {
      for (const key of finding.evidence) expect(allowed.has(key)).toBe(true);
    }
    for (const action of insight.suggestedActions) {
      if (action.metricKey !== null) expect(allowed.has(action.metricKey)).toBe(true);
    }
  });

  it('takes every link from a metric, never from prose', () => {
    const insight = deterministicInsight(request(), 'unavailable');

    const hrefs = new Set(METRICS.map((metric) => metric.href));
    for (const action of insight.suggestedActions) {
      if (action.href !== null) expect(hrefs.has(action.href)).toBe(true);
    }
  });

  it('says nothing is wrong when nothing is wrong', () => {
    const quiet = request({
      metrics: [
        { key: 'ops.listingReview', label: 'Listings', value: 0, unit: 'items', severity: 'attention' },
        { key: 'ops.total', label: 'Everything waiting', value: 0, unit: 'items', severity: 'info' },
      ],
    });

    const insight = deterministicInsight(quiet, 'not-configured');

    // Rather than manufacturing a concern out of a queue holding zero, which
    // is what a panel that must always have something to say ends up doing.
    expect(insight.findings).toEqual([]);
    expect(insight.summary).toContain('Nothing');
  });

  it('carries the window and the metric keys, so the answer can be checked', () => {
    const insight = deterministicInsight(request(), 'not-configured');

    expect(insight.window).toEqual({
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-17T00:00:00.000Z',
    });
    expect(insight.metricKeys).toEqual(['ops.listingReview', 'ops.dataRequests', 'ops.total']);
    expect(insight.evidence.map((entry) => entry.metricKey)).toEqual(insight.metricKeys);
  });

  it('caps what it returns, whatever it is handed', () => {
    const many = request({
      metrics: Array.from({ length: 30 }, (_, index) => ({
        key: `ops.q${String(index)}`,
        label: `Queue ${String(index)}`,
        value: index + 1,
        unit: 'items',
        severity: 'attention' as const,
      })),
    });

    const insight = deterministicInsight(many, 'not-configured');

    expect(insight.findings.length).toBeLessThanOrEqual(4);
    expect(insight.suggestedActions.length).toBeLessThanOrEqual(3);
  });
});

describe('the operations chart and the navigation badges', () => {
  it('places every queue the rail counts', () => {
    /*
     * The failure this exists for: a queue added to `attention.service.ts` for
     * the sidebar badge, and not to the chart's placement table. It would
     * simply be missing from the ring — no error, no warning, and the total
     * would still reconcile because it is summed from what IS placed. The
     * operator would be looking at a chart of "everything waiting" with a
     * queue silently absent from it.
     */
    const railKeys = Object.values(AttentionKey).toSorted();
    const placed = [...ATTENTION_PLACEMENT_KEYS].toSorted();

    expect(placed).toEqual(railKeys);
  });

  it('places every queue in a group the chart knows how to draw', () => {
    const groups = new Set<string>(Object.values(OperationsGroup));
    expect(groups.size).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// What the AI is allowed to see about a consignment
// ---------------------------------------------------------------------------

describe('the carrier metric bundle', () => {
  /** A dashboard with a recipient's details all over it, as `readDashboard` returns. */
  function dashboard(): LogisticsDashboard {
    return {
      counts: {
        assignedToday: 3,
        acceptancePending: 2,
        pickupPending: 1,
        pickedUp: 4,
        dispatched: 4,
        inTransit: 6,
        outForDelivery: 2,
        deliveredToday: 9,
        delayed: 1,
        exceptions: 2,
        failedDeliveries: 1,
        returns: 0,
        slaAtRisk: 3,
        slaBreached: 1,
      },
      metrics: {
        onTimeDeliveryPercentage: null,
        averageTransitHours: null,
        firstAttemptSuccessPercentage: null,
        proofOfDeliveryPending: 5,
      },
      statusDistribution: [{ status: 'IN_TRANSIT', count: 6 }],
      recentActivity: [
        {
          shipmentId: '01JCONSIGNMENT0000000000001',
          shipmentReference: 'CN-2026-000455',
          status: 'IN_TRANSIT',
          receivingCompanyName: 'Sint-Jan Hospital Bruges',
          occurredAt: new Date(),
          publicDescription: 'Left the Antwerp hub',
        },
      ],
      urgentExceptions: [
        {
          id: '01JEXCEPTION00000000000001',
          shipmentId: '01JCONSIGNMENT0000000000001',
          shipmentReference: 'CN-2026-000455',
          type: 'TEMPERATURE_EXCURSION',
          severity: 'CRITICAL',
          reason: 'Cold chain broken outside Ghent',
          createdAt: new Date(),
        },
      ],
      upcomingPickups: [],
      deliveriesDueToday: [
        {
          shipmentId: '01JCONSIGNMENT0000000000001',
          shipmentReference: 'CN-2026-000455',
          receivingCompanyName: 'Sint-Jan Hospital Bruges',
          destinationCity: 'Bruges',
          estimatedDeliveryAt: new Date(),
        },
      ],
      integration: {
        provider: null,
        state: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        consecutiveFailures: 0,
        lastTrackingSyncAt: null,
        deadLetteredEvents: 0,
      },
    };
  }

  it('sends counts and nothing that names anybody', () => {
    /*
     * The masking rules that decide what a dispatcher may see of a recipient's
     * details are elaborate and are enforced on the read paths. The way to be
     * certain a third-party provider never circumvents them is for no row to
     * be in the bundle at all — so this asserts the ABSENCE of every
     * identifying string the dashboard object is carrying.
     */
    const bundle = logisticsInsightMetrics(dashboard());
    const rendered = JSON.stringify(bundle);

    for (const secret of [
      'CN-2026-000455',
      'Sint-Jan Hospital Bruges',
      'Bruges',
      'Cold chain broken outside Ghent',
      '01JCONSIGNMENT0000000000001',
      '01JEXCEPTION00000000000001',
    ]) {
      expect(rendered, secret).not.toContain(secret);
    }
  });

  it('carries the figures a dispatcher would act on', () => {
    const bundle = logisticsInsightMetrics(dashboard());
    const byKey = new Map(bundle.map((metric) => [metric.key, metric]));

    expect(byKey.get('shipments.exceptions')?.value).toBe(2);
    expect(byKey.get('sla.breached')?.value).toBe(1);
    expect(byKey.get('shipments.acceptancePending')?.value).toBe(2);
  });

  it('marks an exception urgent and a delivered count merely informative', () => {
    const bundle = logisticsInsightMetrics(dashboard());
    const byKey = new Map(bundle.map((metric) => [metric.key, metric]));

    expect(byKey.get('shipments.exceptions')?.severity).toBe('urgent');
    expect(byKey.get('shipments.deliveredToday')?.severity).toBe('info');
  });

  it('omits a performance figure with no history rather than reporting zero', () => {
    /*
     * "0% delivered on time" is a damning sentence about a carrier who has
     * simply not delivered anything yet. Omitting the metric is the only way
     * to be sure the model never says it: it cannot cite what it was not
     * given.
     */
    const bundle = logisticsInsightMetrics(dashboard());
    const keys = bundle.map((metric) => metric.key);

    expect(keys).not.toContain('performance.onTimePercentage');
    expect(keys).not.toContain('performance.firstAttemptPercentage');
    expect(keys).not.toContain('performance.averageTransitHours');
  });

  it('includes a performance figure once there is history behind it', () => {
    const withHistory = dashboard();
    withHistory.metrics.onTimeDeliveryPercentage = 94;
    withHistory.metrics.averageTransitHours = 31.4;

    const byKey = new Map(
      logisticsInsightMetrics(withHistory).map((metric) => [metric.key, metric]),
    );

    expect(byKey.get('performance.onTimePercentage')?.value).toBe(94);
    // Rounded, because an hour and a half is the resolution anybody acts on.
    expect(byKey.get('performance.averageTransitHours')?.value).toBe(31);
  });
});

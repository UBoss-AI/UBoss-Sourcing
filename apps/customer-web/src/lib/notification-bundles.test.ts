import { describe, expect, it } from 'vitest';
import { arrangeNotifications } from './notification-bundles';
import type { AccountNotification } from './types';

const n = (id: string, over: Partial<AccountNotification>): AccountNotification => ({ id, eventKey: 'order.confirmed', subject: id, sentAt: null, relatedType: 'order', relatedId: 'o1', readAt: null, priority: 'NORMAL', ...over });

describe('notification arrangement (ENH-020)', () => {
  it('escalates unread critical alerts once with a count, bundles low news by family, keeps the rest', () => {
    const out = arrangeNotifications([
      n('p2', { eventKey: 'payment.failed', priority: 'HIGH', escalation: 'PAYMENT_RISK' }),
      n('p1', { eventKey: 'payment.failed', priority: 'HIGH', escalation: 'PAYMENT_RISK' }),
      n('i1', { eventKey: 'inspection.failed', relatedId: 'o2', priority: 'HIGH', escalation: 'INSPECTION_FAIL' }),
      n('read', { eventKey: 'shipment.exception', priority: 'HIGH', escalation: 'SHIPPING_DELAY', readAt: '2026-10-01T00:00:00Z' }),
      n('s1', { eventKey: 'saved_search.match', priority: 'LOW', family: 'savedSearches' }),
      n('s2', { eventKey: 'saved_search.match', priority: 'LOW', family: 'savedSearches' }),
      n('o1', {}),
    ]);
    expect(out.urgent.map((u) => [u.entry.id, u.count])).toEqual([['p2', 2], ['i1', 1]]);
    expect(out.bundles).toEqual([{ family: 'savedSearches', entries: [expect.objectContaining({ id: 's1' }), expect.objectContaining({ id: 's2' })] }]);
    expect(out.rest.map((e) => e.id)).toEqual(['read', 'o1']);
  });
});

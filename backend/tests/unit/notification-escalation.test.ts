import { describe, expect, it } from 'vitest';
import { escalationOf, priorityOf } from '../../src/modules/notifications/notification-preferences.js';

describe('alert escalation (ENH-020)', () => {
  it.each([
    ['inspection.release_rejected', 'INSPECTION_FAIL'],
    ['inspection.failed', 'INSPECTION_FAIL'],
    ['payment.failed', 'PAYMENT_RISK'],
    ['autopay.failed', 'PAYMENT_RISK'],
    ['schedule.payment_action_required', 'PAYMENT_RISK'],
    ['shipment.exception', 'SHIPPING_DELAY'],
    ['preorder.delivery_risk', 'SHIPPING_DELAY'],
    ['logistics.delivery_failed', 'SHIPPING_DELAY'],
    ['rfq.deadline_soon', 'RFQ_EXPIRY'],
    ['rfq.expired', 'RFQ_EXPIRY'],
  ])('%s escalates as %s and is HIGH', (key, kind) => {
    expect(escalationOf(key)).toBe(kind);
    expect(priorityOf(key)).toBe('HIGH');
  });
  it.each(['inspection.booked', 'payment.received', 'shipmentXexception', 'rfq.invitation', 'saved_search.match', 'order.confirmed'])('%s does not escalate', (key) => {
    expect(escalationOf(key)).toBeNull();
  });
  it('keeps low-priority news low', () => {
    expect(priorityOf('saved_search.match')).toBe('LOW');
    expect(priorityOf('rfq.invitation')).toBe('LOW');
  });
});

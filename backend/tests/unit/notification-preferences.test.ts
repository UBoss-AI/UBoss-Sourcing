/**
 * Notification families, priority and deep links (JOURNEY-056).
 *
 * Pure functions, but the rules matter: a security or payment message must
 * never land in a family a person can mute, and a family must be found by the
 * longest prefix so `order.message` is a message, not an order confirmation.
 */
import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_FAMILIES,
  SELLER_NOTIFICATION_FAMILIES,
  buyerDeepLink,
  familyOf,
  isMandatoryEvent,
  priorityOf,
  sellerFamilyOf,
  sellerPriorityOf,
} from '../../src/modules/notifications/notification-preferences.js';
import { NotificationEvent } from '../../src/modules/notifications/notification.service.js';

describe('families', () => {
  it('finds the longest prefix', () => {
    expect(familyOf('order.message')?.key).toBe('messages');
    expect(familyOf('order.confirmed')?.key).toBe('orders');
    expect(familyOf('buyer_company.invitation')?.key).toBe('account');
    expect(familyOf('buyer_company.approved')?.key).toBe('company');
  });

  it('never lets security, order, payment or data-rights mail be muted', () => {
    for (const key of [
      NotificationEvent.USER_PASSWORD_RESET,
      NotificationEvent.USER_NEW_SIGN_IN,
      NotificationEvent.CUSTOMER_EMAIL_VERIFICATION,
      NotificationEvent.ORDER_CONFIRMED,
      NotificationEvent.PAYMENT_LINK,
      NotificationEvent.REFUND_PROCESSED,
      NotificationEvent.SHIPMENT_DELIVERY_CODE,
      NotificationEvent.SCHEDULE_PAYMENT_ACTION_REQUIRED,
      'data_request.erased',
    ]) {
      expect(isMandatoryEvent(key), key).toBe(true);
    }
    expect(isMandatoryEvent(NotificationEvent.SHIPMENT_DELIVERED)).toBe(false);
    expect(isMandatoryEvent(NotificationEvent.SAVED_SEARCH_MATCHES)).toBe(false);
  });

  it('treats an event no family knows as mandatory', () => {
    expect(familyOf('inventory.low_stock')).toBeNull();
    expect(isMandatoryEvent('inventory.low_stock')).toBe(true);
  });

  it('places every built-in event somewhere or treats it as mandatory', () => {
    for (const key of Object.values(NotificationEvent)) {
      const family = familyOf(key);
      expect(family === null ? isMandatoryEvent(key) : NOTIFICATION_FAMILIES.includes(family), key).toBe(true);
    }
  });
});

describe('priority', () => {
  it('raises what needs acting on and lowers news that was asked for', () => {
    expect(priorityOf(NotificationEvent.PAYMENT_FAILED)).toBe('HIGH');
    expect(priorityOf(NotificationEvent.USER_NEW_SIGN_IN)).toBe('HIGH');
    expect(priorityOf(NotificationEvent.SAVED_SEARCH_MATCHES)).toBe('LOW');
    expect(priorityOf(NotificationEvent.ORDER_CONFIRMED)).toBe('NORMAL');
    expect(sellerPriorityOf('CRITICAL')).toBe('HIGH');
    expect(sellerPriorityOf('INFO')).toBe('NORMAL');
  });
});

describe('deep links', () => {
  it('leads to the thing itself, and a claim by its reference', () => {
    expect(buyerDeepLink('order', '01ORDER')).toBe('/account/orders/01ORDER');
    expect(buyerDeepLink('dispute', '01DISPUTE', new Map([['01DISPUTE', 'DP-AAAA-BBBB']]))).toBe('/account/disputes/DP-AAAA-BBBB');
    expect(buyerDeepLink('dispute', '01UNKNOWN')).toBe('/account/disputes');
    expect(buyerDeepLink('rfq_request', '01RFQ')).toBe('/account/rfqs/01RFQ');
    expect(buyerDeepLink('session', '01X')).toBeNull();
    expect(buyerDeepLink(null, null)).toBeNull();
  });
});

describe('seller families', () => {
  it('keeps essential kinds unmutable and files order messages under messages', () => {
    expect(sellerFamilyOf('SECURITY_EVENT')?.mandatory).toBe(true);
    expect(sellerFamilyOf('NEW_ORDER')?.mandatory).toBe(true);
    expect(sellerFamilyOf('LOW_STOCK')?.mandatory).toBe(false);
    expect(sellerFamilyOf('ORDER_MESSAGE')?.key).toBe('seller.messages');
    const keys = SELLER_NOTIFICATION_FAMILIES.map((family) => family.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

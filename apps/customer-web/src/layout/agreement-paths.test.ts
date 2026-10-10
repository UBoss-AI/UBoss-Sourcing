/**
 * The pages that stay open while the agreement screen waits. A shopper's
 * existing orders, returns and claims are among them; shopping is not.
 */
import { describe, expect, it } from 'vitest';
import { isConsumerRemedyPath, isReachableBeforeAgreement } from './agreement-paths';

describe('agreement paths', () => {
  it('keeps a shopper’s orders, cancellations, returns and claims reachable', () => {
    for (const path of [
      '/account/orders',
      '/account/orders/01JORDER',
      '/account/orders/01JORDER/return',
      '/account/orders/01JORDER/claim',
      '/account/returns',
      '/account/returns/01JRETURN',
      '/account/disputes',
      '/account/disputes/DSP-1',
    ]) {
      expect(isConsumerRemedyPath(path), path).toBe(true);
    }
  });

  it('does not open shopping, the basket, checkout or the rest of the account', () => {
    for (const path of ['/', '/cart', '/checkout', '/account/addresses', '/account/schedules', '/account/orders/1/2/3']) {
      expect(isConsumerRemedyPath(path), path).toBe(false);
      expect(isReachableBeforeAgreement(path), path).toBe(false);
    }
  });

  it('keeps the public documents, support and privacy requests open to everybody', () => {
    for (const path of ['/legal', '/legal/documents/01JDOC', '/support', '/privacy-requests']) {
      expect(isReachableBeforeAgreement(path), path).toBe(true);
    }
  });
});

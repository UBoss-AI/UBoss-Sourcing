/**
 * The pure parts of the admin governance work (JOURNEY-060, 062, 067, LIVE-011).
 */
import { describe, expect, it } from 'vitest';
import { Role } from '../../src/domain/permissions.js';
import { allowedListingTransitions, assertListingTransition } from '../../src/domain/seller-state.js';
import { EXCEPTION_QUEUES } from '../../src/modules/governance/exception-queues.definitions.js';
import { couponConflicts } from '../../src/modules/settings/content-block.service.js';
import { matchProhibitedTerms } from '../../src/modules/seller/listing-moderation.service.js';
import { OperationsGroup } from '../../src/modules/notifications/operations-overview.service.js';

describe('prohibited listing terms', () => {
  const terms = [{ term: 'cure' }, { term: 'fda approved' }, { term: 'c++' }];

  it('matches whole words, ignoring case', () => {
    expect(matchProhibitedTerms('Will CURE your cold', terms).map((t) => t.term)).toEqual(['cure']);
    expect(matchProhibitedTerms('A secure, curated box', terms)).toEqual([]);
  });

  it('matches phrases and terms with punctuation literally', () => {
    expect(matchProhibitedTerms('Proudly FDA approved.', terms).map((t) => t.term)).toEqual(['fda approved']);
    expect(matchProhibitedTerms('Written in c++ code', terms).map((t) => t.term)).toEqual(['c++']);
  });
});

describe('listing appeals in the state machine', () => {
  it('lets only a seller appeal a refusal, with a reason', () => {
    expect(() => assertListingTransition({ from: 'REJECTED', to: 'APPEALED', actor: 'SELLER', reason: 'Please look again.' })).not.toThrow();
    expect(() => assertListingTransition({ from: 'REJECTED', to: 'APPEALED', actor: 'SELLER' })).toThrow();
    expect(() => assertListingTransition({ from: 'REJECTED', to: 'APPEALED', actor: 'OPERATOR', reason: 'x' })).toThrow();
  });

  it('decides an appeal back into review or refused, never straight to approved', () => {
    const targets = allowedListingTransitions('APPEALED', 'OPERATOR').map((rule) => rule.to).sort();
    expect(targets).toEqual(['PENDING_REVIEW', 'REJECTED']);
    expect(allowedListingTransitions('APPEALED', 'SELLER')).toEqual([]);
  });
});

describe('content block coupon checks', () => {
  const day = 86_400_000;
  const now = Date.now();
  const coupon = {
    id: 'c',
    code: 'SAVE10',
    status: 'ACTIVE',
    isPubliclyListed: true,
    validFrom: null,
    validUntil: null,
    archivedAt: null,
    minimums: [] as { currencyCode: string }[],
  };

  it('finds nothing for a usable coupon covering the whole schedule', () => {
    expect(couponConflicts({ startsAt: new Date(now), endsAt: new Date(now + day), countryCurrency: 'EUR' }, coupon)).toEqual([]);
  });

  it('refuses a coupon that ends before the block starts, and an archived one', () => {
    const ends = { ...coupon, validUntil: new Date(now + day), archivedAt: new Date() };
    const found = couponConflicts({ startsAt: new Date(now + 2 * day), endsAt: null, countryCurrency: null }, ends);
    expect(found.filter((item) => item.blocking).map((item) => item.code).sort()).toEqual(['COUPON_ARCHIVED', 'COUPON_ENDS_BEFORE_START']);
  });

  it('warns about a draft coupon, one ending early and one in another currency', () => {
    const draft = { ...coupon, status: 'DRAFT', validUntil: new Date(now + day), minimums: [{ currencyCode: 'INR' }] };
    const found = couponConflicts({ startsAt: new Date(now), endsAt: null, countryCurrency: 'EUR' }, draft);
    expect(found.map((item) => item.code).sort()).toEqual(['COUPON_CURRENCY_MISMATCH', 'COUPON_ENDS_BEFORE_BLOCK', 'COUPON_NOT_ACTIVE']);
    expect(found.every((item) => !item.blocking)).toBe(true);
  });
});

describe('exception queues (LIVE-011)', () => {
  const roles = new Set<string>(Object.values(Role));

  it('names every queue once, each with an SLA and a real owner and escalation role', () => {
    const keys = EXCEPTION_QUEUES.map((queue) => queue.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const queue of EXCEPTION_QUEUES) {
      expect(queue.defaultSlaHours).toBeGreaterThan(0);
      expect(roles.has(queue.defaultOwnerRole)).toBe(true);
      expect(roles.has(queue.defaultEscalationRole)).toBe(true);
      expect(queue.href.startsWith('/')).toBe(true);
    }
  });

  it('covers every queue the go-live checklist names', () => {
    const keys = new Set(EXCEPTION_QUEUES.map((queue) => queue.key));
    for (const key of [
      'disputes',
      'returns',
      'inspections',
      'deadLetters',
      'riskSignals',
      'purchaseOrderApprovals',
      'conditionalReleases',
      'feeApprovals',
      'ledgerDifferences',
      'paymentMismatches',
    ]) {
      expect(keys.has(key)).toBe(true);
    }
  });
});

describe('the Command Center groups (JOURNEY-060)', () => {
  it('has a group for risk and compliance and one for SLA breaches', () => {
    expect(Object.values(OperationsGroup)).toEqual(['approvals', 'payments', 'inventory', 'logistics', 'platform', 'risk', 'sla']);
  });
});

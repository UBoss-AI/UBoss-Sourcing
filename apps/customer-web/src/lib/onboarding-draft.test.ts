/**
 * The copy of a seller application that lives on the seller's own machine.
 *
 * The properties here are the ones that decide whether the promise this
 * feature makes is true. A type checker cannot see any of them: it cannot see
 * that two sellers sharing a laptop get separate drafts, that a browser
 * refusing to store anything is reported rather than swallowed, or that a
 * write which throws does not take the application screen down with it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllDrafts, clearDraft, readDraft, writeDraft } from './onboarding-draft';

interface Answers {
  gstin: string;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('keeping and finding a draft', () => {
  it('gives back exactly what was put in', () => {
    expect(writeDraft('seller-1', 'business_identity', { gstin: '27AAAPA1234A1Z5' })).toBe(true);

    const draft = readDraft<Answers>('seller-1', 'business_identity');

    expect(draft?.values.gstin).toBe('27AAAPA1234A1Z5');
    expect(draft?.savedAt).toBeTypeOf('number');
  });

  it('has nothing for a step nobody has typed into', () => {
    expect(readDraft('seller-1', 'business_identity')).toBeNull();
  });

  it('keeps one step apart from another', () => {
    writeDraft('seller-1', 'business_identity', { gstin: 'identity' });
    writeDraft('seller-1', 'kyb_kyc', { gstin: 'kyc' });

    expect(readDraft<Answers>('seller-1', 'business_identity')?.values.gstin).toBe('identity');
    expect(readDraft<Answers>('seller-1', 'kyb_kyc')?.values.gstin).toBe('kyc');
  });

  /*
   * The one that would be a disclosure rather than a bug.
   *
   * A shared office machine is the normal case for a small business, and two
   * sellers signing into the Hub on it must never be shown each other's
   * half-finished registration numbers.
   */
  it('never shows one seller another seller’s answers', () => {
    writeDraft('seller-1', 'business_identity', { gstin: 'first company' });

    expect(readDraft('seller-2', 'business_identity')).toBeNull();
  });

  it('forgets a step once the server has it', () => {
    writeDraft('seller-1', 'business_identity', { gstin: 'x' });
    clearDraft('seller-1', 'business_identity');

    expect(readDraft('seller-1', 'business_identity')).toBeNull();
  });
});

describe('clearing up after a submitted application', () => {
  it('drops every step this seller has, and nobody else’s', () => {
    writeDraft('seller-1', 'business_identity', { gstin: 'a' });
    writeDraft('seller-1', 'kyb_kyc', { gstin: 'b' });
    writeDraft('seller-1', 'store_profile', { gstin: 'c' });
    writeDraft('seller-2', 'business_identity', { gstin: 'theirs' });

    clearAllDrafts('seller-1');

    expect(readDraft('seller-1', 'business_identity')).toBeNull();
    expect(readDraft('seller-1', 'kyb_kyc')).toBeNull();
    expect(readDraft('seller-1', 'store_profile')).toBeNull();
    expect(readDraft<Answers>('seller-2', 'business_identity')?.values.gstin).toBe('theirs');
  });

  /*
   * Removing while walking `key(i)` shifts every index after it, which skips
   * every second match. Three keys is the smallest number that catches it.
   */
  it('does not skip a step while walking the keys', () => {
    writeDraft('seller-1', 'one', { gstin: '1' });
    writeDraft('seller-1', 'two', { gstin: '2' });
    writeDraft('seller-1', 'three', { gstin: '3' });

    clearAllDrafts('seller-1');

    expect(window.localStorage.length).toBe(0);
  });
});

describe('drafts that are no longer worth offering', () => {
  it('ignores one older than a fortnight, and clears it on the way past', () => {
    writeDraft('seller-1', 'business_identity', { gstin: 'x' });

    const fifteenDays = 15 * 24 * 60 * 60 * 1000;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + fifteenDays);

    expect(readDraft('seller-1', 'business_identity')).toBeNull();

    vi.restoreAllMocks();
    expect(window.localStorage.length).toBe(0);
  });

  it('ignores something that is no longer JSON', () => {
    window.localStorage.setItem('uboss.seller.onboarding.v1.seller-1.business_identity', '{oops');

    expect(readDraft('seller-1', 'business_identity')).toBeNull();
  });

  it('ignores something stored in a shape this build does not know', () => {
    window.localStorage.setItem(
      'uboss.seller.onboarding.v1.seller-1.business_identity',
      JSON.stringify({ values: { gstin: 'x' } }),
    );

    expect(readDraft('seller-1', 'business_identity')).toBeNull();
  });
});

describe('a browser that will not store anything', () => {
  /*
   * A full quota, a private window, site data blocked. The screen tells the
   * seller to press Save when this happens, so the false answer is the whole
   * point - a `true` here would be the application promising to keep work it
   * has not kept.
   */
  it('says so rather than throwing', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    expect(writeDraft('seller-1', 'business_identity', { gstin: 'x' })).toBe(false);
  });

  it('reads as nothing rather than throwing', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });

    expect(readDraft('seller-1', 'business_identity')).toBeNull();
  });

  it('survives a removal that throws', () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });

    expect(() => {
      clearDraft('seller-1', 'business_identity');
    }).not.toThrow();
  });
});

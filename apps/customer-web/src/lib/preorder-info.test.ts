import { beforeEach, describe, expect, it } from 'vitest';
import {
  crossedBulkThreshold,
  hasGuestAcknowledgement,
  isBulkPromptDismissed,
  rememberBulkPromptDismissed,
  rememberGuestAcknowledgement,
  takeGuestAcknowledgement,
} from './preorder-info';

describe('crossedBulkThreshold', () => {
  it('fires on the step that reaches the minimum from below', () => {
    expect(crossedBulkThreshold(999, 1000, 1000)).toBe(true);
    expect(crossedBulkThreshold(500, 5000, 1000)).toBe(true);
  });

  it('does not fire on later steps, or below the minimum', () => {
    expect(crossedBulkThreshold(1000, 1001, 1000)).toBe(false);
    expect(crossedBulkThreshold(998, 999, 1000)).toBe(false);
    expect(crossedBulkThreshold(1200, 999, 1000)).toBe(false);
  });

  it('does not fire without a minimum, or on the first render', () => {
    expect(crossedBulkThreshold(999, 1000, null)).toBe(false);
    expect(crossedBulkThreshold(undefined, 1000, 1000)).toBe(false);
  });
});

describe('session memory', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('remembers a dismissal per product, option, minimum and note version', () => {
    rememberBulkPromptDismissed('P', null, 1000, 'V1');
    expect(isBulkPromptDismissed('P', null, 1000, 'V1')).toBe(true);
    // A new minimum or a new version of the note brings it back.
    expect(isBulkPromptDismissed('P', null, 2000, 'V1')).toBe(false);
    expect(isBulkPromptDismissed('P', null, 1000, 'V2')).toBe(false);
    expect(isBulkPromptDismissed('P', 'VARIANT', 1000, 'V1')).toBe(false);
    expect(isBulkPromptDismissed('Q', null, 1000, 'V1')).toBe(false);
  });

  it('keeps a guest’s tick for one version, and hands it over once', () => {
    rememberGuestAcknowledgement('V1');
    expect(hasGuestAcknowledgement('V1')).toBe(true);
    expect(hasGuestAcknowledgement('V2')).toBe(false);
    expect(takeGuestAcknowledgement()).toBe('V1');
    expect(takeGuestAcknowledgement()).toBeNull();
  });
});

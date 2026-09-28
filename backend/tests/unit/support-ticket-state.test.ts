/**
 * The support request lifecycle, as a table. Every status write in the
 * service goes through these functions, so this is the whole rule.
 */
import { describe, expect, it } from 'vitest';
import {
  SupportTicketStatusValues,
  assertStaffTransition,
  canStaffTransition,
  onRequesterMessage,
  onStaffReply,
  timestampsFor,
} from '../../src/domain/support-ticket-state.js';

describe('staff transitions', () => {
  it('never targets OPEN - it is a fact, not a choice', () => {
    for (const from of SupportTicketStatusValues)
      expect(canStaffTransition(from, 'OPEN')).toBe(false);
  });

  it('lets nothing leave CLOSED, and says why', () => {
    for (const to of SupportTicketStatusValues) {
      expect(canStaffTransition('CLOSED', to)).toBe(false);
      expect(() => {
        assertStaffTransition('CLOSED', to);
      }).toThrow(/closed/i);
    }
  });

  it('reopens a resolved request to IN_PROGRESS', () => {
    expect(canStaffTransition('RESOLVED', 'IN_PROGRESS')).toBe(true);
    expect(canStaffTransition('RESOLVED', 'WAITING_FOR_CUSTOMER')).toBe(false);
  });

  it('refuses a move to the same status as a conflict', () => {
    expect(() => {
      assertStaffTransition('IN_PROGRESS', 'IN_PROGRESS');
    }).toThrow();
  });
});

describe('what messages imply', () => {
  it('puts a waiting or resolved request back in the queue when the sender writes', () => {
    expect(onRequesterMessage('WAITING_FOR_CUSTOMER')).toBe('IN_PROGRESS');
    expect(onRequesterMessage('RESOLVED')).toBe('IN_PROGRESS');
    expect(onRequesterMessage('OPEN')).toBeNull();
    expect(onRequesterMessage('IN_PROGRESS')).toBeNull();
    expect(() => onRequesterMessage('CLOSED')).toThrow();
  });

  it('picks up an OPEN request when staff answer it, and leaves the rest', () => {
    expect(onStaffReply('OPEN')).toBe('IN_PROGRESS');
    expect(onStaffReply('WAITING_FOR_CUSTOMER')).toBeNull();
    expect(() => onStaffReply('CLOSED')).toThrow();
  });
});

describe('timestamps', () => {
  const now = new Date('2026-09-28T10:00:00Z');

  it('stamps resolution and closure, and clears resolution on reopening', () => {
    expect(timestampsFor('RESOLVED', now)).toEqual({ resolvedAt: now });
    expect(timestampsFor('CLOSED', now)).toEqual({ closedAt: now });
    expect(timestampsFor('IN_PROGRESS', now)).toEqual({ resolvedAt: null });
  });
});

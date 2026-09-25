/**
 * The preorder chat's pure rules: its lifecycle, and what a message may hold.
 */
import { describe, expect, it } from 'vitest';
import {
  activeKeyFor,
  assertStaffTransition,
  canStaffTransition,
  customerFacingStatus,
  holdsActiveKey,
  onCustomerMessage,
  onStaffMessage,
  PreorderChatStatusValues,
} from '../../src/domain/preorder-chat-state.js';
import {
  characterCount,
  cleanChatText,
  normaliseChatBody,
  previewOf,
  safeFileName,
} from '../../src/domain/chat-text.js';

const REPLY = { canReply: true, canModerate: false };
const MODERATE = { canReply: true, canModerate: true };

describe('the conversation lifecycle', () => {
  it('never lets staff set NEW, or stay where they are', () => {
    for (const from of PreorderChatStatusValues) {
      expect(canStaffTransition(from, 'NEW')).toBe(false);
      expect(() => { assertStaffTransition(from, from, MODERATE); }).toThrow();
    }
  });

  it('needs the moderation permission to go into or out of spam and blocked', () => {
    expect(() => { assertStaffTransition('OPEN', 'SPAM', REPLY); }).toThrow(/permission/);
    expect(() => { assertStaffTransition('OPEN', 'SPAM', MODERATE); }).not.toThrow();
    expect(() => { assertStaffTransition('SPAM', 'OPEN', REPLY); }).toThrow(/permission/);
    expect(() => { assertStaffTransition('OPEN', 'RESOLVED', REPLY); }).not.toThrow();
  });

  it('reopens a closed conversation only to OPEN', () => {
    expect(canStaffTransition('CLOSED', 'OPEN')).toBe(true);
    expect(canStaffTransition('CLOSED', 'RESOLVED')).toBe(false);
  });

  it('reopens a resolved conversation when the customer writes, and counts it', () => {
    expect(onCustomerMessage('RESOLVED')).toEqual({ accepted: true, next: 'OPEN', reopened: true, notifyStaff: true });
    expect(onCustomerMessage('WAITING_FOR_CUSTOMER')).toMatchObject({ next: 'OPEN', reopened: false });
    expect(onCustomerMessage('WAITING_FOR_INTERNAL')).toMatchObject({ next: 'WAITING_FOR_INTERNAL' });
  });

  it('refuses a customer in a closed or blocked conversation, and keeps spam quiet', () => {
    expect(onCustomerMessage('CLOSED')).toEqual({ accepted: false, code: 'PREORDER_CHAT_CLOSED' });
    expect(onCustomerMessage('BLOCKED')).toEqual({ accepted: false, code: 'PREORDER_CHAT_BLOCKED' });
    expect(onCustomerMessage('SPAM')).toMatchObject({ accepted: true, notifyStaff: false });
  });

  it('opens a new conversation on the first staff reply, and refuses a closed one', () => {
    expect(onStaffMessage('NEW')).toEqual({ accepted: true, next: 'OPEN' });
    expect(onStaffMessage('WAITING_FOR_CUSTOMER')).toEqual({ accepted: true, next: 'WAITING_FOR_CUSTOMER' });
    expect(onStaffMessage('CLOSED').accepted).toBe(false);
  });

  it('never tells the customer their enquiry is spam or waiting internally', () => {
    expect(customerFacingStatus('SPAM')).toBe('OPEN');
    expect(customerFacingStatus('WAITING_FOR_INTERNAL')).toBe('OPEN');
    expect(customerFacingStatus('WAITING_FOR_CUSTOMER')).toBe('AWAITING_YOU');
  });

  it('releases the product only when closed', () => {
    for (const status of PreorderChatStatusValues) {
      expect(holdsActiveKey(status)).toBe(status !== 'CLOSED');
    }
    expect(activeKeyFor({ customerProfileId: 'C', productId: 'P', variantKey: '', preorderKey: '' })).toBe('C:P::');
  });
});

describe('message text', () => {
  it('keeps markup as written - it is rendered as text, never HTML', () => {
    expect(normaliseChatBody('<b>hi</b> <script>x()</script>', 100)).toBe('<b>hi</b> <script>x()</script>');
  });

  it('removes control characters and bidi overrides, keeps newlines and tabs', () => {
    expect(cleanChatText('a\u0000b\u0007c\td\r\ne')).toBe('abc\td\ne');
    expect(cleanChatText('invoice‮fdp.exe')).toBe('invoicefdp.exe');
    expect(cleanChatText('x⁦y⁩')).toBe('xy');
  });

  it('counts characters as people do', () => {
    expect(characterCount('👍👍')).toBe(2);
    expect(() => normaliseChatBody('👍'.repeat(5), 5)).not.toThrow();
    expect(() => normaliseChatBody('👍'.repeat(6), 5)).toThrow(/up to 5/);
  });

  it('refuses an empty message', () => {
    expect(() => normaliseChatBody(' \n\t ', 10)).toThrow();
  });

  it('cuts a preview on a character, not half an emoji', () => {
    expect(previewOf('a'.repeat(10) + '👍👍', 11)).toBe(`${'a'.repeat(10)}…`);
    expect(previewOf('one\n\ntwo', 20)).toBe('one two');
  });

  it('makes a file name safe to show', () => {
    expect(safeFileName('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(safeFileName('spec‮fdp.exe')).toBe('specfdp.exe');
    expect(safeFileName('   ')).toBe('attachment');
  });
});

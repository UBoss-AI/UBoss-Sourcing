/**
 * The Preorder Chats inbox's own rules, and its place in the sidebar.
 *
 *   - The sidebar row exists, is badged with the queue, and is gated on the
 *     view permission - never on "any admin".
 *   - Links are made only from http(s) addresses.
 *   - Messages from three sources become one list in the server's order.
 */
import { describe, expect, it } from 'vitest';
import { NAVIGATION } from '@/layout/navigation';
import { Permission } from './permissions';
import { QUEUE_LABELS } from './operations';
import { linkify, mergeMessages, waitLabel, type StaffMessage } from './preorder-chats';

function message(seq: number, body = `m${String(seq)}`): StaffMessage {
  return {
    id: `id-${String(seq)}`,
    seq,
    senderType: 'CUSTOMER',
    messageType: 'TEXT',
    body,
    systemEvent: null,
    systemMeta: {},
    proposal: null,
    attachment: null,
    createdAt: '2026-09-24T10:00:00.000Z',
    deliveredAt: null,
    redacted: false,
  };
}

describe('the sidebar row', () => {
  const row = NAVIGATION.flatMap((group) => group.items).find((item) => item.to === '/preorder-chats');

  it('is there, labelled, and badged with the chats waiting for an answer', () => {
    expect(row?.labelKey).toBe('nav.preorderChats');
    expect(row?.attentionKeys).toEqual(['preorderChats']);
    expect(row?.matchPrefix).toBe(true);
  });

  it('needs the view permission and nothing weaker', () => {
    expect(row?.permissions).toEqual([Permission.PREORDER_CHAT_VIEW]);
  });

  it('has a label on the operations chart', () => {
    expect(QUEUE_LABELS['preorderChats']).toBe('operations.queue.preorderChats');
  });
});

describe('linkify', () => {
  it('links only http and https', () => {
    expect(linkify('javascript:alert(1)').every((part) => part.kind === 'text')).toBe(true);
    const parts = linkify('Spec: https://example.com/a.pdf, thanks');
    expect(parts.find((part) => part.kind === 'link')).toMatchObject({ href: 'https://example.com/a.pdf' });
  });
});

describe('merging and waiting', () => {
  it('merges by sequence without duplicates', () => {
    const merged = mergeMessages([message(2), message(1)], [message(2, 'newer'), message(3)]);
    expect(merged.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(merged[1]?.body).toBe('newer');
  });

  it('says a wait in minutes, hours or days', () => {
    expect(waitLabel(12)).toEqual({ unit: 'm', value: 12 });
    expect(waitLabel(185)).toEqual({ unit: 'h', value: 3 });
    expect(waitLabel(60 * 72)).toEqual({ unit: 'd', value: 3 });
  });
});

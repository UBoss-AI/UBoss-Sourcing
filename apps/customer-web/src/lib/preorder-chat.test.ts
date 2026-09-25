/**
 * The preorder chat's browser-side rules: which text becomes a link, which
 * mark a message carries, how messages from three sources become one list,
 * and what survives the trip to sign-in.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  deliveryStateOf,
  linkify,
  mergeMessages,
  rememberChatIntent,
  takeChatIntent,
  type ChatMessage,
} from './preorder-chat';

function message(seq: number, body = `m${String(seq)}`): ChatMessage {
  return {
    id: `id-${String(seq)}`,
    seq,
    senderType: 'CUSTOMER',
    messageType: 'TEXT',
    body,
    systemEvent: null,
    systemMeta: {},
    replyToMessageId: null,
    proposal: null,
    attachment: null,
    createdAt: '2026-09-24T10:00:00.000Z',
    deliveredAt: null,
    redacted: false,
  };
}

describe('linkify', () => {
  it('links http and https addresses and leaves trailing punctuation out', () => {
    expect(linkify('See https://example.com/spec.pdf.')).toEqual([
      { kind: 'text', text: 'See ' },
      { kind: 'link', text: 'https://example.com/spec.pdf', href: 'https://example.com/spec.pdf' },
      { kind: 'text', text: '.' },
    ]);
  });

  it('never makes a link from javascript:, data: or anything else', () => {
    for (const body of ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'vbscript:msgbox', '<a href="x">y</a>']) {
      expect(linkify(body).every((part) => part.kind === 'text')).toBe(true);
    }
  });
});

describe('delivery marks', () => {
  it('read beats delivered beats sent, from the server’s positions', () => {
    const receipts = { deliveredSeq: 5, readSeq: 3 };
    expect(deliveryStateOf(2, receipts)).toBe('READ');
    expect(deliveryStateOf(4, receipts)).toBe('DELIVERED');
    expect(deliveryStateOf(6, receipts)).toBe('SENT');
  });
});

describe('merging messages', () => {
  it('keeps one copy per sequence, in the server’s order, newest version winning', () => {
    const merged = mergeMessages([message(3), message(1)], [message(2), message(3, 'edited'), message(1)]);
    expect(merged.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(merged[2]?.body).toBe('edited');
  });
});

describe('the intent carried across sign-in', () => {
  afterEach(() => {
    sessionStorage.clear();
  });

  it('comes back once, and only for the product it was about', () => {
    const intent = {
      productId: 'P1',
      variantId: null,
      orderingUnit: 'CONTAINER_40_FT' as const,
      unitQuantity: 2,
      desiredDeliveryDate: null,
    };
    rememberChatIntent(intent);
    expect(takeChatIntent('P2')).toBeNull();
    rememberChatIntent(intent);
    expect(takeChatIntent('P1')).toEqual(intent);
    expect(takeChatIntent('P1')).toBeNull();
  });
});

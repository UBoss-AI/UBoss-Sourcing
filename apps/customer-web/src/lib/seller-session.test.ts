/**
 * What counts as a person using the Seller Hub, and how tabs hear each other.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  INTERACTION_WINDOW_MS,
  laterExpiry,
  noteInteraction,
  noteSellerResponse,
  onSellerSession,
  sellerActivityHeaders,
  type SellerSessionEvent,
} from './seller-session';

afterEach(() => {
  noteInteraction(0);
});

describe('sellerActivityHeaders', () => {
  it('marks a Hub read made just after a click or key press', () => {
    noteInteraction();
    expect(sellerActivityHeaders('/seller/listings', 'GET')).toEqual({ 'x-seller-activity': '1' });
    expect(sellerActivityHeaders('/sellers/session', 'GET')).toEqual({ 'x-seller-activity': '1' });
  });

  it('does not mark a read nobody asked for: no recent click, or long ago', () => {
    expect(sellerActivityHeaders('/seller/notifications', 'GET')).toEqual({});
    noteInteraction(Date.now() - INTERACTION_WINDOW_MS - 1);
    expect(sellerActivityHeaders('/seller/notifications', 'GET')).toEqual({});
  });

  it('never marks a shop request, and leaves changes to count on their own', () => {
    noteInteraction();
    expect(sellerActivityHeaders('/cart', 'GET')).toEqual({});
    expect(sellerActivityHeaders('/catalog/products', 'GET')).toEqual({});
    expect(sellerActivityHeaders('/seller/listings', 'POST')).toEqual({});
  });

  it('does not mark a read from a tab in the background', () => {
    noteInteraction();
    const visibility = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    try {
      expect(sellerActivityHeaders('/seller/listings', 'GET')).toEqual({});
    } finally {
      if (visibility === undefined) delete (document as { visibilityState?: string }).visibilityState;
      else Object.defineProperty(document, 'visibilityState', visibility);
    }
  });
});

describe('what the server says', () => {
  it('passes on a new expiry from a Hub response, and ignores shop responses', () => {
    const seen: SellerSessionEvent[] = [];
    const stop = onSellerSession((event) => seen.push(event));
    noteSellerResponse('/seller/listings', new Headers({ 'x-seller-session-expires-at': '2026-09-25T12:00:00.000Z' }), null);
    noteSellerResponse('/cart', new Headers({ 'x-seller-session-expires-at': '2026-09-25T13:00:00.000Z' }), null);
    stop();
    expect(seen).toEqual([{ type: 'expiresAt', at: '2026-09-25T12:00:00.000Z' }]);
  });

  it('turns SELLER_SESSION_EXPIRED into an expiry event', () => {
    const seen: SellerSessionEvent[] = [];
    const stop = onSellerSession((event) => seen.push(event));
    noteSellerResponse('/seller/orders', new Headers(), 'SELLER_SESSION_EXPIRED');
    stop();
    expect(seen).toEqual([{ type: 'expired' }]);
  });

  it('reaches the other tabs', async () => {
    const other = new BroadcastChannel('uboss-seller-hub-session');
    const received = new Promise<SellerSessionEvent>((resolve) => {
      other.onmessage = (message: MessageEvent<SellerSessionEvent>) => {
        resolve(message.data);
      };
    });
    const stop = onSellerSession(() => undefined);
    noteSellerResponse('/seller/orders', new Headers(), 'SELLER_SESSION_EXPIRED');
    await expect(received).resolves.toEqual({ type: 'expired' });
    stop();
    other.close();
  });

  it('keeps the later of two expiry times, whatever order they arrive in', () => {
    expect(laterExpiry(null, '2026-09-25T12:00:00.000Z')).toBe('2026-09-25T12:00:00.000Z');
    expect(laterExpiry('2026-09-25T12:00:00.000Z', '2026-09-25T11:00:00.000Z')).toBe('2026-09-25T12:00:00.000Z');
    expect(laterExpiry('2026-09-25T12:00:00.000Z', '2026-09-25T13:00:00.000Z')).toBe('2026-09-25T13:00:00.000Z');
  });
});

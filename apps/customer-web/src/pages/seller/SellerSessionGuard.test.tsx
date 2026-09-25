/**
 * The Seller Hub's idle warning: when it shows, what its two buttons do, and
 * what happens when another tab or the server has the last word.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { errorResponse, jsonResponse, renderWithProviders } from '@/test/harness';
import { takeExpiredNotice, type SellerSessionEvent } from '@/lib/seller-session';
import { SellerSessionGuard } from './SellerSessionGuard';

const WARNING = 'Your Seller Hub session will expire soon due to inactivity.';

/** The Modal keeps a closed <dialog> in the page; what matters is whether it is open. */
function warningOpen(): boolean {
  return document.querySelector('dialog')?.open === true;
}

function inMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function stub(handlers: Record<string, () => Response>): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      const key = `${(init?.method ?? 'GET').toUpperCase()} ${new URL(url).pathname.replace('/api/v1', '')}`;
      calls.push(key);
      const handler = handlers[key];
      return Promise.resolve(handler === undefined ? jsonResponse({}) : handler());
    }),
  );
  return calls;
}

function render(expiresAt: string): void {
  renderWithProviders(
    <SellerSessionGuard session={{ expiresAt, idleTimeoutSeconds: 3_600, warningSeconds: 300 }} />,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

describe('SellerSessionGuard', () => {
  it('says nothing while more than five minutes are left', () => {
    stub({});
    render(inMinutes(30));
    expect(warningOpen()).toBe(false);
  });

  it('warns inside the last five minutes, with a countdown', () => {
    stub({});
    render(inMinutes(4));
    expect(screen.getByRole('dialog', { name: 'Are you still there?' })).toBeInTheDocument();
    expect(screen.getByText(WARNING)).toBeInTheDocument();
    expect(warningOpen()).toBe(true);
    expect(screen.getByLabelText(/^Time left: [34]:\d\d$/)).toBeInTheDocument();
  });

  it('renews on "Stay signed in", and only hides the warning once the server agreed', async () => {
    const calls = stub({
      'POST /sellers/session/renew': () =>
        jsonResponse({ session: { expiresAt: inMinutes(60), idleTimeoutSeconds: 3_600, warningSeconds: 300 } }),
    });
    render(inMinutes(4));
    fireEvent.click(screen.getByRole('button', { name: 'Stay signed in' }));
    await waitFor(() => {
      expect(warningOpen()).toBe(false);
    });
    expect(calls).toContain('POST /sellers/session/renew');
  });

  it('keeps the warning up and says so when renewing fails', async () => {
    stub({ 'POST /sellers/session/renew': () => errorResponse(500, 'INTERNAL_ERROR', 'boom') });
    render(inMinutes(4));
    fireEvent.click(screen.getByRole('button', { name: 'Stay signed in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('We could not keep you signed in. Try again.');
    expect(warningOpen()).toBe(true);
  });

  it('treats a refused renewal as the end, with the notice for the lock screen', async () => {
    stub({
      'POST /sellers/session/renew': () =>
        errorResponse(403, 'SELLER_SESSION_EXPIRED', 'Your Seller Hub session expired due to inactivity.'),
    });
    render(inMinutes(4));
    fireEvent.click(screen.getByRole('button', { name: 'Stay signed in' }));
    await waitFor(() => {
      expect(takeExpiredNotice()).toBe(true);
    });
  });

  it('signs out of the Hub from the warning, and tells the other tabs', async () => {
    const calls = stub({ 'POST /sellers/lock/close': () => jsonResponse({ lock: { isSet: true, isOpen: false } }) });
    const other = new BroadcastChannel('uboss-seller-hub-session');
    const heard = new Promise<SellerSessionEvent>((resolve) => {
      other.onmessage = (message: MessageEvent<SellerSessionEvent>) => {
        resolve(message.data);
      };
    });
    render(inMinutes(4));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await expect(heard).resolves.toEqual({ type: 'closed' });
    expect(calls).toContain('POST /sellers/lock/close');
    other.close();
  });

  it('drops the warning when another tab keeps the Hub open', async () => {
    stub({});
    render(inMinutes(4));
    expect(warningOpen()).toBe(true);
    const other = new BroadcastChannel('uboss-seller-hub-session');
    other.postMessage({ type: 'renewed', at: inMinutes(60) } satisfies SellerSessionEvent);
    await waitFor(() => {
      expect(warningOpen()).toBe(false);
    });
    other.close();
  });

  it('asks the server when its own clock runs out, and ends the Hub when the server agrees', async () => {
    const calls = stub({
      'GET /sellers/session': () =>
        errorResponse(403, 'SELLER_SESSION_EXPIRED', 'Your Seller Hub session expired due to inactivity.'),
    });
    render(new Date(Date.now() - 1_000).toISOString());
    await waitFor(() => {
      expect(calls).toContain('GET /sellers/session');
    });
    await waitFor(() => {
      expect(takeExpiredNotice()).toBe(true);
    });
  });

  it('keeps going when the server says another tab kept it open', async () => {
    const calls = stub({
      'GET /sellers/session': () =>
        jsonResponse({ session: { expiresAt: inMinutes(50), idleTimeoutSeconds: 3_600, warningSeconds: 300 } }),
    });
    render(new Date(Date.now() - 1_000).toISOString());
    await waitFor(() => {
      expect(calls).toContain('GET /sellers/session');
    });
    expect(takeExpiredNotice()).toBe(false);
    expect(warningOpen()).toBe(false);
  });
});

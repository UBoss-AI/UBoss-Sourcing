/**
 * Order threads between a buyer and a seller (JOURNEY-055).
 */
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, renderWithProviders } from '@/test/harness';
import { ORDER_MESSAGE_POLL_MS, OrderMessagesPanel } from './OrderMessagesPanel';

const fetchMock = vi.fn();
const ORDER = '01ORDER0000000000000000000';
const GROUP_A = '01GROUPA000000000000000000';
const GROUP_B = '01GROUPB000000000000000000';

const bodyOf = (init: unknown): Record<string, unknown> => {
  const body = (init as RequestInit | undefined)?.body;
  return JSON.parse(typeof body === 'string' ? body : '{}') as Record<string, unknown>;
};

function message(id: string, from: 'BUYER' | 'SELLER', body: string, mine: boolean) {
  return { id, from, body, mine, at: '2026-10-02T10:00:00.000Z' };
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('OrderMessagesPanel (buyer)', () => {
  it('shows one thread per seller and writes to the one chosen, with a client message id', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ message: message('01MSG0000000000000000000B2', 'BUYER', 'Is it packed?', true) }, 201));
      }
      return Promise.resolve(
        jsonResponse({
          threads: [
            { sellerOrderGroupId: GROUP_A, sellerName: 'Alpha Supplies', sellerOrderNumber: 'A-1', messages: [message('01MSG0000000000000000000A1', 'SELLER', 'Shipping Monday.', false)] },
            { sellerOrderGroupId: GROUP_B, sellerName: 'Beta Gloves', sellerOrderNumber: 'B-1', messages: [] },
          ],
        }),
      );
    });

    renderWithProviders(<OrderMessagesPanel audience="buyer" orderId={ORDER} />);

    expect(await screen.findByText('Shipping Monday.')).toBeInTheDocument();
    // Report sits under the seller's words, never under the buyer's own.
    expect(screen.getByRole('button', { name: 'Report' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Beta Gloves' }));
    expect(screen.getByText('No messages with Beta Gloves yet.')).toBeInTheDocument();
    // The warning is above the composer.
    expect(screen.getByText(/Never send bank details/)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Write to Beta Gloves'), 'Is it packed?');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url, init]) => (init as RequestInit | undefined)?.method === 'POST' && String(url).includes(`/orders/${ORDER}/messages/${GROUP_B}`));
      expect(call).toBeDefined();
      const sent = bodyOf(call?.[1]);
      expect(sent.body).toBe('Is it packed?');
      expect(String(sent.clientMessageId)).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    });
    expect(await screen.findByText('Is it packed?')).toBeInTheDocument();
  });

  it('renders nothing for an order with no seller parts', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ threads: [] })));
    const { container } = renderWithProviders(<OrderMessagesPanel audience="buyer" orderId={ORDER} />);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(container.textContent).toBe('');
    });
  });
});

describe('OrderMessagesPanel (seller)', () => {
  it('polls for messages after the newest it holds and adds them once', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let polls = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('after=')) {
        polls += 1;
        return Promise.resolve(
          jsonResponse({
            thread: { sellerOrderGroupId: GROUP_A, sellerName: 'Alpha Supplies', sellerOrderNumber: 'A-1', messages: [message('01MSG0000000000000000000A2', 'BUYER', 'Thanks!', false)] },
          }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          thread: { sellerOrderGroupId: GROUP_A, sellerName: 'Alpha Supplies', sellerOrderNumber: 'A-1', messages: [message('01MSG0000000000000000000A1', 'SELLER', 'Shipping Monday.', true)] },
        }),
      );
    });

    renderWithProviders(<OrderMessagesPanel audience="seller" groupId={GROUP_A} />);
    expect(await screen.findByText('Shipping Monday.')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ORDER_MESSAGE_POLL_MS + 50);
    });
    expect(await screen.findByText('Thanks!')).toBeInTheDocument();
    const pollCall = fetchMock.mock.calls.find(([url]) => String(url).includes('after='));
    expect(String(pollCall?.[0])).toContain(`/seller/orders/${GROUP_A}/messages`);
    expect(String(pollCall?.[0])).toContain('after=01MSG0000000000000000000A1');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ORDER_MESSAGE_POLL_MS + 50);
    });
    expect(polls).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Thanks!')).toHaveLength(1);
  });
});

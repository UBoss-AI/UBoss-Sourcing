/**
 * Account -> Messages, end to end against a stubbed API.
 *
 *   - The customer is talking to the marketplace's team; the seller is a fact
 *     about the product, never the other party.
 *   - Enter sends exactly one message; a failed send keeps the text with Retry,
 *     and the retry reuses the same client message id.
 *   - The first unread message is marked where it starts.
 *   - A structured page: one log, one composer, and the product strip labelled
 *     a snapshot with no price presented as a quote.
 *   - What anybody wrote stays text - a `javascript:` address is not a link.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { jsonResponse, renderWithProviders } from '@/test/harness';
import { MessagesPage } from './MessagesPage';

const ID = '01CHAT0000000000000000000A';

const CONTEXT = {
  product: { id: '01PRODUCT00000000000000000', name: 'Examination gloves', slug: 'gloves', sku: 'GLV-M', imageUrl: null },
  variant: null,
  sellerName: 'Gamma Manufacturing',
  preorder: { available: true, minimumBaseUnits: 1000, moqUnit: 'PIECE', moqQuantity: 1000 },
  request: { orderingUnit: 'PIECE', unitQuantity: 1500, baseUnits: 1500, desiredDeliveryDate: null },
  capturedAt: '2026-09-24T10:00:00.000Z',
};

const CONVERSATION = {
  id: ID,
  status: 'OPEN',
  canSend: true,
  context: CONTEXT,
  preorder: null,
  lastSequence: 3,
  unreadCount: 1,
  receipts: { deliveredSeq: 1, readSeq: 1 },
  lastMessagePreview: 'We can ship in October.',
  lastMessageFromMe: false,
  lastMessageAt: '2026-09-24T10:05:00.000Z',
  resolvedAt: null,
  closedAt: null,
  createdAt: '2026-09-24T10:00:00.000Z',
};

function message(seq: number, senderType: 'CUSTOMER' | 'ADMIN', body: string, minute: number) {
  return {
    id: `01MSG0000000000000000000${String(seq).padStart(2, '0')}`,
    seq,
    senderType,
    messageType: 'TEXT',
    body,
    systemEvent: null,
    systemMeta: {},
    replyToMessageId: null,
    proposal: null,
    attachment: null,
    createdAt: `2026-09-24T10:${String(minute).padStart(2, '0')}:00.000Z`,
    deliveredAt: null,
    redacted: false,
  };
}

const MESSAGES = [
  message(1, 'CUSTOMER', 'Can you do 1,500 pieces?', 0),
  message(2, 'CUSTOMER', 'Details: javascript:alert(1)', 1),
  message(3, 'ADMIN', 'We can ship in October.', 5),
];

class FakeSocket {
  static OPEN = 1;
  readonly OPEN = 1;
  readyState = 0;
  addEventListener(): void {}
  send(): void {}
  close(): void {}
}

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

function stubApi(options: { failSends?: number } = {}): Call[] {
  const calls: Call[] = [];
  let failures = options.failSends ?? 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      calls.push({ url, method, body });
      if (url.includes('/preorder-chats/availability')) {
        return Promise.resolve(
          jsonResponse({
            enabled: true,
            teamAvailable: true,
            typicalResponse: 'within 4 business hours',
            maxMessageChars: 4000,
            attachments: { available: false, reason: 'NO_SCANNER', maxBytes: 1024, types: [] },
          }),
        );
      }
      if (url.includes(`/preorder-chats/${ID}/messages`) && method === 'POST') {
        if (failures > 0) {
          failures -= 1;
          return Promise.resolve(
            jsonResponse({ error: { code: 'INTERNAL', message: 'down', requestId: 'r' } }, 500),
          );
        }
        return Promise.resolve(
          jsonResponse(
            {
              conversation: CONVERSATION,
              message: { ...message(4, 'CUSTOMER', String(body['body']), 6), clientMessageId: body['clientMessageId'] },
              created: true,
              duplicate: false,
            },
            201,
          ),
        );
      }
      if (url.includes(`/preorder-chats/${ID}/messages`)) {
        return Promise.resolve(jsonResponse({ messages: MESSAGES, hasMore: false }));
      }
      if (url.includes(`/preorder-chats/${ID}/read`)) {
        return Promise.resolve(jsonResponse({ readSeq: 3, unreadCount: 0 }));
      }
      if (url.includes(`/preorder-chats/${ID}`)) return Promise.resolve(jsonResponse({ conversation: CONVERSATION }));
      if (/\/preorder-chats(\?|$)/.test(url)) {
        return Promise.resolve(jsonResponse({ conversations: [CONVERSATION], nextCursor: null }));
      }
      return Promise.resolve(jsonResponse({ unreadCount: 0 }));
    }),
  );
  return calls;
}

function renderPage() {
  return renderWithProviders(
    <Routes>
      <Route path="/account/messages" element={<MessagesPage />} />
      <Route path="/account/messages/:id" element={<MessagesPage />} />
    </Routes>,
    { route: `/account/messages/${ID}` },
  );
}

const sends = (calls: Call[]): Call[] =>
  calls.filter((call) => call.method === 'POST' && call.url.endsWith(`/preorder-chats/${ID}/messages`));

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('Account -> Messages', () => {
  it('is a conversation with the team, about a seller’s product', async () => {
    stubApi();
    renderPage();
    const history = await screen.findByRole('log', { name: 'Conversation history' });
    expect(await within(history).findByText('We can ship in October.')).toBeInTheDocument();
    const header = screen.getByRole('heading', { name: 'Glovia Preorder Team' });
    expect(header).toBeInTheDocument();
    // The seller is named as a fact about the product, and nowhere as a sender.
    expect(screen.getAllByText(/Seller: Gamma Manufacturing/).length).toBeGreaterThan(0);
    expect(within(history).queryByText('Gamma Manufacturing')).not.toBeInTheDocument();
    expect(within(history).getByText('Glovia team')).toBeInTheDocument();
    // One history, one composer.
    expect(screen.getAllByRole('log')).toHaveLength(1);
    expect(screen.getAllByRole('textbox', { name: 'Your message' })).toHaveLength(1);
    expect(screen.getByText('Enter to send • Shift+Enter for a new line')).toBeInTheDocument();
  });

  it('marks where the unread messages start', async () => {
    stubApi();
    renderPage();
    const history = await screen.findByRole('log');
    await within(history).findByText('We can ship in October.');
    const separator = within(history).getByRole('separator', { name: 'Unread messages' });
    const items = [...history.querySelectorAll('li')];
    const at = items.findIndex((item) => item.contains(separator));
    expect(items[at + 1]?.textContent).toContain('We can ship in October.');
  });

  it('labels the product details a snapshot, and quotes no price', async () => {
    stubApi();
    renderPage();
    const strip = await screen.findByRole('region', { name: 'Product details' });
    fireEvent.click(within(strip).getByRole('button', { name: /details/i }));
    expect(within(strip).getByText(/Product details as they were on/)).toBeInTheDocument();
    expect(within(strip).getByText(/A chat message is never a price quote/)).toBeInTheDocument();
  });

  it('keeps an address that is not http or https as text', async () => {
    stubApi();
    renderPage();
    const history = await screen.findByRole('log');
    const text = await within(history).findByText(/javascript:alert\(1\)/);
    expect(text.closest('a')).toBeNull();
  });

  it('sends one message on Enter, and keeps a line break made with Shift+Enter', async () => {
    const calls = stubApi();
    renderPage();
    const box = await screen.findByRole('textbox', { name: 'Your message' });
    fireEvent.change(box, { target: { value: '  First line\nSecond line  ' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => {
      expect(sends(calls)).toHaveLength(1);
    });
    expect(sends(calls)[0]?.body['body']).toBe('First line\nSecond line');
    expect((box as HTMLTextAreaElement).value).toBe('');
    expect(document.activeElement).not.toBe(document.body);
  });

  it('keeps a message that failed to send, and retries it as the same message', async () => {
    const calls = stubApi({ failSends: 1 });
    renderPage();
    const box = await screen.findByRole('textbox', { name: 'Your message' });
    fireEvent.change(box, { target: { value: 'Please confirm the date' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    const retry = await screen.findByRole('button', { name: 'Retry' });
    const history = screen.getByRole('log');
    expect(within(history).getByText('Please confirm the date')).toBeInTheDocument();
    expect(within(history).getByText('Not sent')).toBeInTheDocument();

    fireEvent.click(retry);
    await waitFor(() => {
      expect(sends(calls)).toHaveLength(2);
    });
    const [first, second] = sends(calls);
    expect(second?.body['clientMessageId']).toBe(first?.body['clientMessageId']);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    });
  });
});

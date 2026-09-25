/**
 * One conversation in the Preorder Chats inbox.
 *
 *   - Enter sends a reply, once; Shift+Enter is a new line. (It used to take
 *     Ctrl+Enter, and plain Enter only ever added a line.)
 *   - An internal note is NOT saved by Enter - a note is saved on purpose, and
 *     it goes to the notes route, never the reply route.
 *   - The history is one log, the header names the customer, and the seller
 *     is shown as a fact about the product.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { i18n } from '@/i18n/config';
import { ConversationPane } from './ConversationPane';

const ID = '01CHAT0000000000000000000A';

const DETAIL = {
  id: ID,
  status: 'OPEN',
  priority: 'NORMAL',
  customer: { profileId: 'p1', name: 'John Doe', organization: 'Sikka Pvt Ltd', email: null, blocked: false },
  product: { id: 'pr1', name: 'Examination gloves', sku: 'GLV', imageUrl: null, variantName: null },
  seller: { id: 's1', name: 'Gamma Manufacturing' },
  preorder: null,
  assignedTo: { id: 'u1', email: 'owner@example.test' },
  tags: [],
  lastMessagePreview: 'Hello',
  lastMessageSender: 'CUSTOMER',
  lastMessageAt: '2026-09-24T10:00:00.000Z',
  unreadCount: 0,
  awaitingReplySince: null,
  waitingMinutes: null,
  reopenCount: 0,
  createdAt: '2026-09-24T10:00:00.000Z',
  customerLocale: 'en',
  context: null,
  currentProduct: null,
  pricingCurrency: 'EUR',
  receipts: { deliveredSeq: 0, readSeq: 0 },
  lastSequence: 1,
  firstResponseAt: null,
  resolvedAt: null,
  closedAt: null,
  assignedAt: null,
  block: null,
  preorderIsOperators: null,
  version: 1,
};

const MESSAGE = {
  id: '01MSG00000000000000000000A',
  seq: 1,
  senderType: 'CUSTOMER',
  messageType: 'TEXT',
  body: 'Hello, can you do 1,500 pieces?',
  systemEvent: null,
  systemMeta: {},
  proposal: null,
  attachment: null,
  createdAt: '2026-09-24T10:00:00.000Z',
  deliveredAt: null,
  redacted: false,
};

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

function stubApi(): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      calls.push({ url, method, body });
      const json = (value: unknown, status = 200): Promise<Response> =>
        Promise.resolve(new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }));
      if (url.includes('/messages') && method === 'POST') {
        return json({ message: { ...MESSAGE, id: 'M2', seq: 2, senderType: 'ADMIN', body: body['body'] }, conversation: DETAIL, duplicate: false }, 201);
      }
      if (url.includes('/messages')) return json({ messages: [MESSAGE], hasMore: false });
      if (url.includes('/notes') && method === 'POST') return json({ id: 'n1', body: body['body'], authorUserId: 'u1', authorEmail: null, createdAt: MESSAGE.createdAt }, 201);
      if (url.includes('/notes')) return json({ notes: [] });
      if (url.includes('/proposals')) return json({ proposals: [] });
      if (url.includes('/assignees')) return json({ assignees: [] });
      if (url.includes('/read')) return json({ readSeq: 1 });
      if (url.endsWith(`/admin/preorder-chats/${ID}`)) return json({ conversation: DETAIL });
      return json({});
    }),
  );
  return calls;
}

const session = {
  user: { id: 'u1', email: 'owner@example.test' },
  isLoading: false,
  login: vi.fn(),
  logout: vi.fn(),
  refreshUser: vi.fn(),
  can: () => true,
  canAny: () => true,
} as unknown as SessionState;

function renderPane(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <SessionContext.Provider value={session}>
          <MemoryRouter>
            <ConversationPane conversationId={ID} backTo="/preorder-chats" canReply />
          </MemoryRouter>
        </SessionContext.Provider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

const posts = (calls: Call[], part: string): Call[] =>
  calls.filter((call) => call.method === 'POST' && call.url.includes(part));

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('a Preorder Chats conversation', () => {
  it('names the customer, and the seller only as a fact about the product', async () => {
    stubApi();
    renderPane();
    expect(await screen.findByRole('heading', { name: 'Sikka Pvt Ltd' })).toBeDefined();
    expect(screen.getByText(/Seller: Gamma Manufacturing/)).toBeDefined();
    const history = screen.getByRole('log');
    expect(await within(history).findByText('Hello, can you do 1,500 pieces?')).toBeDefined();
    expect(screen.getAllByRole('log')).toHaveLength(1);
  });

  it('sends a reply on Enter, once, and keeps a Shift+Enter line break', async () => {
    const calls = stubApi();
    renderPane();
    const box = await screen.findByRole('textbox', { name: 'Reply to the customer' });
    fireEvent.change(box, { target: { value: 'Yes' } });
    expect(fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })).toBe(true);
    fireEvent.change(box, { target: { value: 'Yes\nIn October' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => {
      expect(posts(calls, '/messages')).toHaveLength(1);
    });
    expect(posts(calls, '/messages')[0]?.body['body']).toBe('Yes\nIn October');
    expect((box as HTMLTextAreaElement).value).toBe('');
  });

  it('does not save an internal note on Enter, and never sends one as a reply', async () => {
    const calls = stubApi();
    renderPane();
    fireEvent.click(await screen.findByRole('tab', { name: 'Internal notes' }));
    const note = await screen.findByRole('textbox', { name: 'Add an internal note' });
    fireEvent.change(note, { target: { value: 'Check stock with the warehouse' } });
    // Enter is a new line here, on purpose.
    expect(fireEvent.keyDown(note, { key: 'Enter' })).toBe(true);
    expect(posts(calls, '/notes')).toHaveLength(0);
    fireEvent.keyDown(note, { key: 'Enter', ctrlKey: true });
    await waitFor(() => {
      expect(posts(calls, '/notes')).toHaveLength(1);
    });
    expect(posts(calls, '/messages')).toHaveLength(0);
  });
});

/**
 * "Chat with UBOSS" on the product page.
 *
 *   - It sits in the preorder row, beside Preorder, with its own name.
 *   - A guest is sent to sign in and brought back with the chat to open; the
 *     product, option and quantity wait in this tab.
 *   - Opening the drawer shows the server's product card and creates nothing.
 *   - The first message is sent with a client id and the product context.
 *   - What anybody wrote is shown as text: markup is not markup.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { jsonResponse, makeSession, renderWithProviders } from '@/test/harness';
import { PreorderButton } from '@/components/preorder/PreorderButton';

const PRODUCT = '01PRODUCT00000000000000000';

const CONTEXT = {
  product: { id: PRODUCT, name: 'Examination gloves', slug: 'gloves', sku: 'GLV-M', imageUrl: null },
  variant: null,
  sellerName: 'Gamma Manufacturing',
  preorder: { available: true, minimumBaseUnits: 1000, moqUnit: 'PIECE', moqQuantity: 1000 },
  request: { orderingUnit: 'PIECE', unitQuantity: 1500, baseUnits: 1500, desiredDeliveryDate: null },
  capturedAt: '2026-09-24T10:00:00.000Z',
};

const CONVERSATION = {
  id: '01CHAT0000000000000000000A',
  status: 'OPEN',
  canSend: true,
  context: CONTEXT,
  preorder: null,
  lastSequence: 1,
  unreadCount: 0,
  receipts: { deliveredSeq: 0, readSeq: 0 },
  lastMessagePreview: null,
  lastMessageFromMe: true,
  lastMessageAt: '2026-09-24T10:00:00.000Z',
  resolvedAt: null,
  closedAt: null,
  createdAt: '2026-09-24T10:00:00.000Z',
};

class FakeSocket {
  static OPEN = 1;
  readonly OPEN = 1;
  readyState = 0;
  addEventListener(): void {
    /* never opens: the page must not depend on it */
  }
  send(): void {}
  close(): void {}
}

interface Captured {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

function stubApi(options: { existingMessages?: unknown[] } = {}): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      const body =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      calls.push({ url, method, body });

      if (url.includes('/preorders/eligibility')) {
        return Promise.resolve(
          jsonResponse({
            eligibility: { available: false, reason: 'NOT_CONFIGURED', message: '', offerId: null, sellerName: null },
            viewer: {
              signedIn: true,
              isBusinessBuyer: true,
              addressId: null,
              preorderInfo: { policyVersion: 'PREORDER_INFO_V1', acknowledged: false },
            },
          }),
        );
      }
      if (url.includes('/preorder-chats/availability')) {
        return Promise.resolve(
          jsonResponse({
            enabled: true,
            teamAvailable: false,
            typicalResponse: 'within 4 business hours',
            maxMessageChars: 4000,
            attachments: { available: false, reason: 'NO_SCANNER', maxBytes: 1024, types: [] },
          }),
        );
      }
      if (url.includes('/preorder-chats/context')) {
        return Promise.resolve(
          jsonResponse({
            context: CONTEXT,
            conversation: options.existingMessages === undefined ? null : CONVERSATION,
          }),
        );
      }
      if (url.includes(`/preorder-chats/${CONVERSATION.id}/messages`)) {
        return Promise.resolve(jsonResponse({ messages: options.existingMessages ?? [], hasMore: false }));
      }
      if (url.includes(`/preorder-chats/${CONVERSATION.id}/read`)) {
        return Promise.resolve(jsonResponse({ readSeq: 1, unreadCount: 0 }));
      }
      if (url.includes(`/preorder-chats/${CONVERSATION.id}`)) {
        return Promise.resolve(jsonResponse({ conversation: CONVERSATION }));
      }
      if (url.endsWith('/preorder-chats/messages') && method === 'POST') {
        return Promise.resolve(
          jsonResponse(
            {
              conversation: CONVERSATION,
              message: {
                id: '01MSG00000000000000000000A',
                seq: 1,
                senderType: 'CUSTOMER',
                messageType: 'TEXT',
                body: body['body'],
                systemEvent: null,
                systemMeta: {},
                replyToMessageId: null,
                proposal: null,
                attachment: null,
                createdAt: '2026-09-24T10:00:00.000Z',
                deliveredAt: null,
                redacted: false,
                clientMessageId: body['clientMessageId'],
              },
              created: true,
              duplicate: false,
            },
            201,
          ),
        );
      }
      return Promise.resolve(jsonResponse({}));
    }),
  );
  return calls;
}

function Where(): React.JSX.Element {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

function renderButton(options: { isCustomer?: boolean; route?: string } = {}) {
  return renderWithProviders(
    <Routes>
      <Route
        path="/product/:slug"
        element={
          <PreorderButton
            productId={PRODUCT}
            productName="Examination gloves"
            imageUrl={null}
            variantId={null}
            variantName={null}
            isReady
            pieces={1500}
          />
        }
      />
      <Route path="/login" element={<Where />} />
    </Routes>,
    {
      route: options.route ?? '/product/gloves?size=m',
      session: options.isCustomer === false ? makeSession({ isCustomer: false, user: null }) : makeSession(),
    },
  );
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('Chat with UBOSS', () => {
  it('sits beside Preorder, named and with a tooltip', async () => {
    stubApi();
    renderButton();
    const chat = await screen.findByRole('button', { name: 'Chat with the Glovia team about this product' });
    expect(chat).toHaveAttribute('title', 'Ask Glovia about this preorder');
    expect(chat).toHaveTextContent('Chat with Glovia');
    expect(screen.getByRole('button', { name: /^preorder$/i })).toBeInTheDocument();
    // Preorder is off for this product; the chat is still there to ask why.
    expect(chat).toBeEnabled();
  });

  it('sends a guest to sign in and keeps what they were asking about', async () => {
    const calls = stubApi();
    renderButton({ isCustomer: false });
    fireEvent.click(await screen.findByRole('button', { name: 'Chat with the Glovia team about this product' }));
    const where = await screen.findByTestId('where');
    const next = new URLSearchParams(where.textContent.split('?')[1] ?? '').get('next') ?? '';
    expect(next).toBe('/product/gloves?size=m&chat=1');
    expect(JSON.parse(sessionStorage.getItem('uboss.preorderChat.intent') ?? '{}')).toMatchObject({
      productId: PRODUCT,
      unitQuantity: 1500,
    });
    // A guest's click reached no chat route that writes.
    expect(calls.some((call) => call.url.includes('/preorder-chats') && call.method === 'POST')).toBe(false);
  });

  it('opens by itself after sign-in, shows the server’s product card, and creates nothing', async () => {
    const calls = stubApi();
    sessionStorage.setItem(
      'uboss.preorderChat.intent',
      JSON.stringify({ productId: PRODUCT, variantId: null, orderingUnit: 'PIECE', unitQuantity: 1500, desiredDeliveryDate: null }),
    );
    renderButton({ route: '/product/gloves?size=m&chat=1' });
    const dialog = await screen.findByRole('dialog', { name: 'Chat with Glovia' });
    expect(await within(dialog).findByText('Seller: Gamma Manufacturing')).toBeInTheDocument();
    expect(within(dialog).getByText('Glovia team is currently offline')).toBeInTheDocument();
    expect(within(dialog).getByText(/Never share passwords, OTPs, card details/)).toBeInTheDocument();
    expect(within(dialog).getByText(/You’re chatting with the Glovia preorder team about Examination gloves/)).toBeInTheDocument();
    const preview = calls.find((call) => call.url.includes('/preorder-chats/context'));
    expect(preview?.body).toMatchObject({ productId: PRODUCT, unitQuantity: 1500 });
    expect(calls.some((call) => call.url.endsWith('/preorder-chats/messages'))).toBe(false);
  });

  it('fills the composer from a quick question, and sends the first message with its context', async () => {
    const calls = stubApi();
    renderButton({ route: '/product/gloves?chat=1' });
    const dialog = await screen.findByRole('dialog', { name: 'Chat with Glovia' });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Ask about 40-ft container capacity' }));
    const composer = within(dialog).getByLabelText('Your message');
    expect(composer).toHaveValue('How many pieces fit in a 40-ft container?');
    // Not sent until the customer sends it.
    expect(calls.some((call) => call.url.endsWith('/preorder-chats/messages'))).toBe(false);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(calls.some((call) => call.url.endsWith('/preorder-chats/messages'))).toBe(true);
    });
    const sent = calls.find((call) => call.url.endsWith('/preorder-chats/messages'));
    expect(sent?.body['clientMessageId']).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(sent?.body['context']).toMatchObject({ productId: PRODUCT, orderingUnit: 'PIECE' });
    expect(await within(dialog).findByText('How many pieces fit in a 40-ft container?')).toBeInTheDocument();
    expect(await within(dialog).findByText(/Sent/)).toBeInTheDocument();
  });

  it('shows markup that somebody typed as the characters they typed', async () => {
    stubApi({
      existingMessages: [
        {
          id: '01MSG00000000000000000000B',
          seq: 1,
          senderType: 'ADMIN',
          messageType: 'TEXT',
          body: '<img src=x onerror="alert(1)"> javascript:alert(1) https://example.com/a',
          systemEvent: null,
          systemMeta: {},
          replyToMessageId: null,
          proposal: null,
          attachment: null,
          createdAt: '2026-09-24T10:00:00.000Z',
          deliveredAt: null,
          redacted: false,
        },
      ],
    });
    renderButton({ route: '/product/gloves?chat=1' });
    const dialog = await screen.findByRole('dialog', { name: 'Chat with Glovia' });
    expect(await within(dialog).findByText(/<img src=x onerror="alert\(1\)">/)).toBeInTheDocument();
    expect(dialog.querySelector('img[src="x"]')).toBeNull();
    const links = within(dialog).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toContain('https://example.com/a');
    expect(links.some((link) => (link.getAttribute('href') ?? '').startsWith('javascript:'))).toBe(false);
    const external = links.find((link) => link.getAttribute('href') === 'https://example.com/a');
    expect(external).toHaveAttribute('rel', 'noopener noreferrer nofollow ugc');
  });
});

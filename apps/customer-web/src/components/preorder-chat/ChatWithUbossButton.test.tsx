/**
 * "Chat with UBOSS" on the product page.
 *
 *   - It sits in the preorder row, beside Preorder, with its own name.
 *   - A guest can read the preorder assistant without signing in; asking for
 *     a person sends them to sign in, and the answers and the request wait in
 *     this tab and are finished when they are back.
 *   - Opening the drawer shows the server's product card and creates nothing.
 *   - The assistant is labelled automated, answers from the server, and says
 *     honestly when the team has to confirm something.
 *   - "Connect with a human agent" carries the signed answers into the
 *     conversation and says the request is queued - never that anybody is online.
 *   - Reopening does not start the greeting again.
 *   - The first message is sent with a client id, the product context and the
 *     answers read, from the round Send message button - once.
 *   - What anybody wrote is shown as text: markup is not markup.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { jsonResponse, makeSession, renderWithProviders } from '@/test/harness';
import { PreorderButton } from '@/components/preorder/PreorderButton';

const PRODUCT = '01PRODUCT00000000000000000';
const TRANSCRIPT_KEY = `uboss.preorderAssistant.transcript:${PRODUCT}:`;
const HANDOFF_KEY = 'uboss.preorderAssistant.handoff';

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
  humanRequested: false,
  resolvedAt: null,
  closedAt: null,
  createdAt: '2026-09-24T10:00:00.000Z',
};

const INTRO = {
  greeting: { firstName: 'Priya', productName: 'Examination gloves', variantName: null },
  questions: [
    { id: 'moq', category: 'ORDERING', questionKey: 'preorderChat.assistant.q.moq', version: 1, requiresHumanConfirmation: false },
    {
      id: 'container40',
      category: 'CONTAINERS',
      questionKey: 'preorderChat.assistant.q.container40',
      version: 1,
      requiresHumanConfirmation: false,
    },
  ],
  signedIn: true,
};

const ANSWERS: Record<string, unknown> = {
  moq: {
    faqId: 'moq',
    version: 1,
    outcome: 'ANSWERED',
    lines: [{ key: 'preorderChat.assistant.a.moq', values: { minimum: { kind: 'number', value: 1000 } } }],
  },
  container40: {
    faqId: 'container40',
    version: 1,
    outcome: 'NEEDS_CONFIRMATION',
    lines: [
      { key: 'preorderChat.assistant.a.containerUnverified', values: { size: { kind: 'text', value: '40' } } },
      { key: 'preorderChat.assistant.a.needsConfirmation', values: {} },
    ],
  },
};

function signed(faqId: string): Record<string, unknown> {
  return { answer: ANSWERS[faqId], askedAt: new Date().toISOString(), token: `signed-${faqId}-000000000000` };
}

function message(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: '01MSG00000000000000000000A',
    seq: 1,
    senderType: 'CUSTOMER',
    messageType: 'TEXT',
    body: '',
    systemEvent: null,
    systemMeta: {},
    replyToMessageId: null,
    proposal: null,
    automation: null,
    attachment: null,
    createdAt: '2026-09-24T10:00:00.000Z',
    deliveredAt: null,
    redacted: false,
    ...overrides,
  };
}

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

function stubApi(options: { existingMessages?: unknown[]; unread?: number } = {}): Captured[] {
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
      if (url.includes('/preorder-chats/unread')) {
        return Promise.resolve(jsonResponse({ unreadCount: options.unread ?? 0 }));
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
      if (url.endsWith('/preorder-chats/assistant/answer')) {
        return Promise.resolve(jsonResponse(signed(String(body['faqId']))));
      }
      if (url.endsWith('/preorder-chats/assistant')) {
        return Promise.resolve(jsonResponse(INTRO));
      }
      if (url.endsWith('/preorder-chats/handoff')) {
        return Promise.resolve(
          jsonResponse(
            {
              conversation: { ...CONVERSATION, humanRequested: true },
              messages: [
                message({
                  id: '01MSG0000000000000000000HQ',
                  messageType: 'HANDOFF_REQUEST',
                  systemEvent: 'handoff.requested',
                  systemMeta: { topic: (body['topic'] as string | null | undefined) ?? null },
                }),
              ],
              created: true,
              duplicate: false,
            },
            201,
          ),
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
              message: message({ body: body['body'], clientMessageId: body['clientMessageId'] }),
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

const writes = (calls: Captured[]): boolean =>
  calls.some((call) => /preorder-chats\/(messages|handoff)$/.test(call.url));

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('Chat with UBOSS', () => {
  it('sits beside Preorder as an icon, named and with an accessible tooltip', async () => {
    stubApi();
    renderButton();
    const chat = await screen.findByRole('button', { name: 'Chat with Glovia' });
    // An icon: no visible words, the name comes from its label.
    expect(chat).toHaveTextContent('');
    // The tooltip describes it, for hover and for keyboard focus alike.
    expect(chat).toHaveAccessibleDescription('Ask Glovia about this preorder');
    fireEvent.focus(chat);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Ask Glovia about this preorder');
    // A 48 px target, past the 44 px minimum.
    expect(chat).toHaveClass('size-12');
    expect(screen.getByRole('button', { name: /^preorder$/i })).toBeInTheDocument();
    // Preorder is off for this product; the chat is still there to ask why.
    expect(chat).toBeEnabled();
  });

  it('shows how many replies about this product are unread, counted by the server', async () => {
    const calls = stubApi({ unread: 3 });
    renderButton();
    const chat = await screen.findByRole('button', { name: 'Chat with Glovia. Unread replies: 3' });
    expect(within(chat).getByText('3')).toBeInTheDocument();
    expect(calls.some((call) => call.url.includes('/preorder-chats/unread?productId='))).toBe(true);
  });

  it('lets a guest read the assistant, and sends them to sign in to reach a person', async () => {
    const calls = stubApi();
    renderButton({ isCustomer: false });
    fireEvent.click(await screen.findByRole('button', { name: 'Chat with Glovia' }));
    const dialog = await screen.findByRole('dialog', { name: 'Chat with Glovia' });
    // No sign-in wall for the common answers.
    fireEvent.click(await within(dialog).findByRole('button', { name: 'What is the minimum preorder quantity?' }));
    expect(await within(dialog).findByText('The minimum preorder quantity is 1,000 pieces.')).toBeInTheDocument();
    expect(writes(calls)).toBe(false);

    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Connect with a human agent' })[0] as HTMLElement);
    const where = await screen.findByTestId('where');
    const next = new URLSearchParams(where.textContent.split('?')[1] ?? '').get('next') ?? '';
    expect(next).toBe('/product/gloves?size=m&chat=1');
    expect(JSON.parse(sessionStorage.getItem('uboss.preorderChat.intent') ?? '{}')).toMatchObject({
      productId: PRODUCT,
      unitQuantity: 1500,
    });
    // The request and the answers wait in this tab, to be finished after sign-in.
    expect(JSON.parse(sessionStorage.getItem(HANDOFF_KEY) ?? '{}')).toMatchObject({ productId: PRODUCT, topic: 'moq' });
    expect(sessionStorage.getItem(TRANSCRIPT_KEY)).toContain('signed-moq');
    expect(writes(calls)).toBe(false);
  });

  it('finishes a guest’s request for a person once they have signed in, with the answers they read', async () => {
    const calls = stubApi();
    sessionStorage.setItem(TRANSCRIPT_KEY, JSON.stringify([{ ...signed('moq'), feedback: null }]));
    sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({ productId: PRODUCT, variantId: null, topic: 'moq' }));
    renderButton({ route: '/product/gloves?chat=1' });
    const dialog = await screen.findByRole('dialog', { name: 'Chat with Glovia' });
    await waitFor(() => {
      expect(calls.some((call) => call.url.endsWith('/preorder-chats/handoff'))).toBe(true);
    });
    const handoff = calls.find((call) => call.url.endsWith('/preorder-chats/handoff'));
    expect(handoff?.body).toMatchObject({ topic: 'moq', context: { productId: PRODUCT } });
    expect((handoff?.body['transcript'] as { token: string }[])[0]?.token).toBe('signed-moq-000000000000');
    // Honest: queued, not "connected".
    expect(
      await within(dialog).findByText(
        'Your request has been sent to the Glovia preorder team. A human representative will reply here as soon as possible.',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('You asked to talk to a person from the Glovia team.')).toBeInTheDocument();
    expect(within(dialog).queryByText(/agent connected/i)).toBeNull();
    // Asked once, and the request no longer waits.
    expect(calls.filter((call) => call.url.endsWith('/preorder-chats/handoff'))).toHaveLength(1);
    expect(sessionStorage.getItem(HANDOFF_KEY)).toBeNull();
    expect(sessionStorage.getItem(TRANSCRIPT_KEY)).toBeNull();
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
    // The assistant greets by name, about this product, and says it is automated.
    expect(
      await within(dialog).findByText(
        'Hello, Priya! I can help you with common preorder questions for Examination gloves. What would you like to know?',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: /Glovia Preorder Assistant\s*Automated/ })).toBeInTheDocument();
    const preview = calls.find((call) => call.url.includes('/preorder-chats/context'));
    expect(preview?.body).toMatchObject({ productId: PRODUCT, unitQuantity: 1500 });
    expect(writes(calls)).toBe(false);
  });

  it('shows the common questions as tappable cards', async () => {
    stubApi();
    renderButton({ route: '/product/gloves?chat=1' });
    const dialog = await screen.findByRole('dialog', { name: 'Chat with Glovia' });
    const list = await within(dialog).findByRole('list', { name: 'Common preorder questions' });
    const rows = within(list).getAllByRole('button');
    expect(rows.map((row) => row.textContent)).toEqual([
      'What is the minimum preorder quantity?',
      'How many pieces fit in a 40-ft container?',
    ]);
    // Each row is a full-width target with an icon and a chevron, at least 44 px tall.
    expect(rows[0]).toHaveClass('w-full', 'min-h-11');
    expect(rows[0]?.querySelectorAll('svg')).toHaveLength(2);
  });

  it('says honestly when the team has to confirm, and offers a person', async () => {
    stubApi();
    renderButton({ route: '/product/gloves?chat=1' });
    const dialog = await screen.findByRole('dialog', { name: 'Chat with Glovia' });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'How many pieces fit in a 40-ft container?' }));
    expect(
      await within(dialog).findByText('The seller has not verified how many pieces fit in a 40-ft container.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('This information needs confirmation from the Glovia preorder team.')).toBeInTheDocument();
    expect(within(dialog).getByText('Needs confirmation')).toBeInTheDocument();
    // The answer is the assistant's, labelled so - not the team's.
    expect(within(dialog).getAllByText('Glovia Preorder Assistant').length).toBeGreaterThan(0);
    expect(within(dialog).getByRole('group', { name: 'Was this helpful?' })).toBeInTheDocument();
    expect(within(dialog).getByRole('group', { name: 'Would you like to connect with a human agent?' })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ask another question' }));
    expect(within(dialog).getByRole('list', { name: 'Common preorder questions' })).toBeInTheDocument();
  });

  it('does not start the greeting over when the chat is opened again', async () => {
    stubApi();
    sessionStorage.setItem(TRANSCRIPT_KEY, JSON.stringify([{ ...signed('moq'), feedback: 'helpful' }]));
    renderButton({ route: '/product/gloves?chat=1' });
    const dialog = await screen.findByRole('dialog', { name: 'Chat with Glovia' });
    expect(await within(dialog).findByText('The minimum preorder quantity is 1,000 pieces.')).toBeInTheDocument();
    expect(within(dialog).getAllByText(/^Hello, Priya!/)).toHaveLength(1);
    expect(within(dialog).queryByRole('group', { name: 'Was this helpful?' })).toBeNull();
  });

  it('sends the first message once from the round button, with its context and the answers read', async () => {
    const calls = stubApi();
    renderButton({ route: '/product/gloves?chat=1' });
    const dialog = await screen.findByRole('dialog', { name: 'Chat with Glovia' });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'What is the minimum preorder quantity?' }));
    await within(dialog).findByText('The minimum preorder quantity is 1,000 pieces.');

    const send = within(dialog).getByRole('button', { name: 'Send message' });
    expect(send).toHaveAttribute('title', 'Send message');
    expect(send).toHaveClass('rounded-full');
    expect(send).toBeDisabled();
    const composer = within(dialog).getByLabelText('Your message');
    fireEvent.change(composer, { target: { value: 'Can you do 40-ft containers?' } });
    expect(send).toBeEnabled();
    fireEvent.click(send);
    fireEvent.keyDown(composer, { key: 'Enter', code: 'Enter' });
    await waitFor(() => {
      expect(calls.some((call) => call.url.endsWith('/preorder-chats/messages'))).toBe(true);
    });
    const sent = calls.filter((call) => call.url.endsWith('/preorder-chats/messages'));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body['clientMessageId']).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(sent[0]?.body['context']).toMatchObject({ productId: PRODUCT, orderingUnit: 'PIECE' });
    expect((sent[0]?.body['transcript'] as { token: string }[])[0]?.token).toBe('signed-moq-000000000000');
    expect(await within(dialog).findByText('Can you do 40-ft containers?')).toBeInTheDocument();
    expect(await within(dialog).findByText(/Sent/)).toBeInTheDocument();
  });

  it('shows the assistant’s stored answers as automated, and a person joining', async () => {
    stubApi({
      existingMessages: [
        message({ seq: 1, messageType: 'FAQ_QUESTION', systemEvent: 'moq', systemMeta: { faqId: 'moq', version: 1 } }),
        message({
          id: '01MSG00000000000000000000C',
          seq: 2,
          senderType: 'AUTOMATION',
          messageType: 'AUTOMATED_REPLY',
          systemEvent: 'moq',
          automation: { ...(ANSWERS['moq'] as object), askedAt: '2026-09-24T10:00:00.000Z' },
        }),
        message({ id: '01MSG00000000000000000000D', seq: 3, senderType: 'SYSTEM', messageType: 'SYSTEM_EVENT', systemEvent: 'handoff.joined' }),
      ],
    });
    renderButton({ route: '/product/gloves?chat=1' });
    const dialog = await screen.findByRole('dialog', { name: 'Chat with Glovia' });
    expect(await within(dialog).findByText('What is the minimum preorder quantity?')).toBeInTheDocument();
    expect(within(dialog).getByText('The minimum preorder quantity is 1,000 pieces.')).toBeInTheDocument();
    expect(within(dialog).getByText('Automated')).toBeInTheDocument();
    expect(within(dialog).getByText('A member of the Glovia team has joined the conversation.')).toBeInTheDocument();
    // With a conversation open, the assistant's greeting does not come back.
    expect(within(dialog).queryByText(/^Hello, Priya!/)).toBeNull();
  });

  it('shows markup that somebody typed as the characters they typed', async () => {
    stubApi({
      existingMessages: [
        message({
          id: '01MSG00000000000000000000B',
          senderType: 'ADMIN',
          body: '<img src=x onerror="alert(1)"> javascript:alert(1) https://example.com/a',
        }),
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

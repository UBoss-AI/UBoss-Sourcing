/**
 * AI Mode — the page that replaced the corner chat widget.
 *
 * `fetch` is stubbed at the boundary, as everywhere else in this suite, so the
 * API client's own behaviour — the CSRF header, the error envelope, the shared
 * refresh — is exercised rather than bypassed. What is asserted is the four
 * things a customer would notice if they broke:
 *
 *   - the reply streams in, token by token, rather than appearing at the end;
 *   - a question typed on the landing page arrives here and is asked, which is
 *     the whole point of the hand-off;
 *   - a failed send keeps what was typed and offers to try again, because a
 *     paragraph describing a requirement is expensive to lose;
 *   - the history is a list of the customer's own threads that can be opened,
 *     renamed and deleted, and deleting asks first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeSession, renderWithProviders } from '@/test/harness';
import { jsonResponse } from '@/test/harness';
import { FALLBACK_CONFIG } from '@/app/storefront-context';
import { AiModePage } from './AiModePage';
import { setPendingQuestion } from '@/lib/ai-mode';
import type { StorefrontConfig } from '@/lib/types';

const CONFIG: StorefrontConfig = {
  ...FALLBACK_CONFIG,
  features: { ...FALLBACK_CONFIG.features, assistant: true, imageSearch: true },
};

interface Conversation {
  id: string;
  title: string | null;
  preview: string | null;
  messageCount: number;
  lastMessageAt: string | null;
  createdAt: string;
}

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-1',
    title: null,
    preview: 'Do you stock 22G safety cannulae?',
    messageCount: 2,
    lastMessageAt: '2026-09-08T10:00:00.000Z',
    createdAt: '2026-09-08T09:59:00.000Z',
    ...overrides,
  };
}

/**
 * An SSE body, delivered in pieces.
 *
 * Enqueued as separate chunks on purpose: a single-chunk stream would pass
 * even if the reader only ever read once, which is the bug streaming exists to
 * avoid.
 */
function sseResponse(deltas: string[]): Response {
  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const delta of deltas) {
        controller.enqueue(
          encoder.encode(`event: delta\ndata: ${JSON.stringify({ text: delta })}\n\n`),
        );
      }
      controller.enqueue(
        encoder.encode(`event: done\ndata: ${JSON.stringify({ finishReason: 'stop' })}\n\n`),
      );
      controller.close();
    },
  });

  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** What each endpoint should answer. Every test builds its own. */
interface Routes {
  conversations?: Conversation[];
  /** Returned by `/start`, as the API does for a caller with no session. */
  guestToken?: string;
  detail?: { messages: { id: string; role: 'user' | 'assistant'; content: string }[] };
  chat?: () => Response;
  onRequest?: (url: string, init: RequestInit | undefined) => void;
}

function stubFetch(routes: Routes = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      routes.onRequest?.(url, init);

      if (url.includes('/assistant/conversations/')) {
        if (init?.method === 'PATCH' || init?.method === 'DELETE') {
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        return Promise.resolve(
          jsonResponse({
            conversation: { ...conversation(), ...(routes.detail ?? { messages: [] }) },
          }),
        );
      }

      if (url.includes('/assistant/conversations')) {
        return Promise.resolve(jsonResponse({ conversations: routes.conversations ?? [] }));
      }

      if (url.includes('/assistant/start')) {
        return Promise.resolve(
          jsonResponse(
            {
              conversationId: 'conv-new',
              ...(routes.guestToken === undefined
                ? {}
                : { conversationToken: routes.guestToken }),
            },
            201,
          ),
        );
      }

      if (url.includes('/assistant/chat')) {
        return Promise.resolve(routes.chat?.() ?? sseResponse(['Yes — ', 'three sizes.']));
      }

      return Promise.resolve(jsonResponse({}, 404));
    }),
  );
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('the empty state', () => {
  it('offers starters that this system can actually answer from', () => {
    stubFetch();
    renderWithProviders(<AiModePage />, { config: CONFIG });

    expect(
      screen.getByRole('heading', { name: /what are you sourcing today/i }),
    ).toBeInTheDocument();

    // Every chip is about the catalogue, stock, orders or a schedule — a chip
    // opening a conversation the assistant has to decline is worse than none.
    expect(screen.getByRole('button', { name: 'Check warehouse availability' })).toBeInTheDocument();

    // AI Act Art. 50(1): said before they engage, not in a footnote afterwards.
    expect(screen.getByText(/chatting with an AI assistant/i)).toBeInTheDocument();
  });

  it('asks a suggested prompt when it is pressed', async () => {
    const user = userEvent.setup();
    const seen: string[] = [];
    stubFetch({
      onRequest: (url) => {
        seen.push(url);
      },
    });

    renderWithProviders(<AiModePage />, { config: CONFIG });
    await user.click(screen.getByRole('button', { name: 'Check warehouse availability' }));

    await waitFor(() => {
      expect(seen.some((url) => url.includes('/assistant/chat'))).toBe(true);
    });

    // The conversation is opened first: the chat endpoint needs an id, and
    // there is no thread until somebody asks something.
    expect(seen.filter((url) => url.includes('/assistant/start'))).toHaveLength(1);
  });
});

describe('asking a question', () => {
  it('streams the reply in rather than showing it all at the end', async () => {
    const user = userEvent.setup();
    stubFetch({ chat: () => sseResponse(['Yes — ', 'three sizes: 8, 10 and 12 Fr.']) });

    renderWithProviders(<AiModePage />, { config: CONFIG });

    await user.type(screen.getByRole('textbox'), 'Which feeding tubes do you list?');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    // The question appears immediately, before any reply arrives.
    expect(screen.getByText('Which feeding tubes do you list?')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText(/three sizes: 8, 10 and 12 Fr\./)).toBeInTheDocument();
    });

    // Only once it has finished: copying half an answer is worse than not
    // offering to copy it.
    expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /ask again/i })).toBeInTheDocument();
  });

  it('keeps the question and offers a retry when the send fails', async () => {
    const user = userEvent.setup();
    stubFetch({ chat: () => new Response(null, { status: 500 }) });

    renderWithProviders(<AiModePage />, { config: CONFIG });

    await user.type(screen.getByRole('textbox'), 'Do you deliver to Pune?');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/unavailable/i);
    });

    // The optimistic pair is dropped — an empty reply bubble reads as an
    // answer that said nothing — so the only thing still carrying the question
    // is the composer, which is exactly where it is useful.
    expect(screen.getByRole('textbox')).toHaveValue('Do you deliver to Pune?');
    expect(screen.queryAllByText('Do you deliver to Pune?')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('asks the question the landing page parked, exactly once', async () => {
    const asked: string[] = [];
    stubFetch({
      onRequest: (url, init) => {
        if (!url.includes('/assistant/chat')) return;
        const body = init?.body;
        if (typeof body !== 'string') return;
        asked.push((JSON.parse(body) as { message: string }).message);
      },
    });

    setPendingQuestion('Which suction catheters fit a 10 Fr port?', 'send');

    renderWithProviders(<AiModePage />, { config: CONFIG });

    await waitFor(() => {
      expect(asked).toEqual(['Which suction catheters fit a 10 Fr port?']);
    });

    // Collected as it is read, so a refresh does not re-ask what was asked.
    expect(sessionStorage.getItem('uboss_ai_pending_question')).toBeNull();
  });
});

describe('the conversation history', () => {
  it('lists the threads and opens the one that is chosen', async () => {
    const user = userEvent.setup();
    stubFetch({
      conversations: [conversation({ id: 'conv-1', preview: 'Do you stock 22G cannulae?' })],
      detail: {
        messages: [
          { id: 'm1', role: 'user', content: 'Do you stock 22G cannulae?' },
          { id: 'm2', role: 'assistant', content: 'Yes, in boxes of 50.' },
        ],
      },
    });

    renderWithProviders(<AiModePage />, { config: CONFIG });

    const row = await screen.findByRole('button', { name: 'Do you stock 22G cannulae?' });
    await user.click(row);

    await waitFor(() => {
      expect(screen.getByText('Yes, in boxes of 50.')).toBeInTheDocument();
    });
  });

  it('renames a thread through the API', async () => {
    const user = userEvent.setup();
    const patched: unknown[] = [];

    stubFetch({
      conversations: [conversation({ preview: 'Do you stock 22G cannulae?' })],
      onRequest: (_url, init) => {
        if (init?.method !== 'PATCH' || typeof init.body !== 'string') return;
        patched.push(JSON.parse(init.body));
      },
    });

    renderWithProviders(<AiModePage />, { config: CONFIG });

    await user.click(await screen.findByRole('button', { name: /^rename the conversation/i }));

    const input = screen.getByRole('textbox', { name: /conversation name/i });
    await user.clear(input);
    await user.type(input, 'Cannula sizes{Enter}');

    await waitFor(() => {
      expect(patched).toEqual([{ title: 'Cannula sizes' }]);
    });
  });

  it('asks before deleting, because from the customer side it is final', async () => {
    const user = userEvent.setup();
    let deleted = false;

    stubFetch({
      conversations: [conversation({ preview: 'Do you stock 22G cannulae?' })],
      onRequest: (_url, init) => {
        if (init?.method === 'DELETE') deleted = true;
      },
    });

    renderWithProviders(<AiModePage />, { config: CONFIG });

    await user.click(await screen.findByRole('button', { name: /^delete the conversation/i }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/will be removed from your history/i)).toBeInTheDocument();
    // Nothing has happened yet. A one-click "gone for good" next to a rename
    // button is a mis-click waiting to happen.
    expect(deleted).toBe(false);

    await user.click(within(dialog).getByRole('button', { name: 'Delete conversation' }));

    await waitFor(() => {
      expect(deleted).toBe(true);
    });
  });

  it('starts a new chat without carrying the last transcript into it', async () => {
    const user = userEvent.setup();
    stubFetch({ chat: () => sseResponse(['Yes, in boxes of 50.']) });

    renderWithProviders(<AiModePage />, { config: CONFIG });

    await user.type(screen.getByRole('textbox'), 'Do you stock 22G cannulae?');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(screen.getByText('Yes, in boxes of 50.')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /new chat/i }));

    expect(screen.queryByText('Yes, in boxes of 50.')).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /what are you sourcing today/i }),
    ).toBeInTheDocument();
  });
});

describe('a visitor with no account', () => {
  /** The signed-out session the harness would otherwise not give us. */
  const GUEST = { session: makeSession({ user: null, isCustomer: false }), config: CONFIG };

  it('gets a composer, not a sign-in wall', () => {
    stubFetch();
    renderWithProviders(<AiModePage />, GUEST);

    // The whole point: somebody deciding whether this catalogue has what they
    // need can ask before opening an account.
    expect(screen.getByRole('textbox')).toBeEnabled();
    expect(
      screen.getByRole('heading', { name: /what are you sourcing today/i }),
    ).toBeInTheDocument();
  });

  it('carries the token the API minted on every turn', async () => {
    const user = userEvent.setup();
    const sent: Record<string, unknown>[] = [];

    stubFetch({
      guestToken: 'guest-token-abc',
      onRequest: (url, init) => {
        if (!url.includes('/assistant/chat')) return;
        if (typeof init?.body !== 'string') return;
        sent.push(JSON.parse(init.body) as Record<string, unknown>);
      },
    });

    renderWithProviders(<AiModePage />, GUEST);

    await user.type(screen.getByRole('textbox'), 'Do you stock feeding tubes?');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });

    // A guest has no account to be recognised by, so the token is the only
    // thing that says the conversation is theirs.
    expect(sent[0]).toMatchObject({
      conversationId: 'conv-new',
      conversationToken: 'guest-token-abc',
    });
  });

  it('asks for no history, because there is no account to have one', async () => {
    const seen: string[] = [];
    stubFetch({
      onRequest: (url) => {
        seen.push(url);
      },
    });

    renderWithProviders(<AiModePage />, GUEST);

    await waitFor(() => {
      expect(screen.getByRole('textbox')).toBeInTheDocument();
    });

    // A 401 in the query cache is what the service banner reads to decide the
    // whole store is in trouble, so the request is not made at all.
    expect(seen.filter((url) => url.includes('/assistant/conversations'))).toEqual([]);
  });

  it('is invited to sign in rather than shown an empty list or a Sign out', () => {
    stubFetch();
    renderWithProviders(<AiModePage />, GUEST);

    expect(screen.getByText(/sign in to keep your conversations/i)).toBeInTheDocument();
    // To sign-in, carrying `/ai` in router state so they land back here.
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
    // Offering Sign out to somebody who is not signed in is the classic way an
    // interface announces it has not read the session.
    expect(screen.queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument();
  });

  it('sends no token once a customer is signed in', async () => {
    const user = userEvent.setup();
    const sent: Record<string, unknown>[] = [];

    stubFetch({
      onRequest: (url, init) => {
        if (!url.includes('/assistant/chat')) return;
        if (typeof init?.body !== 'string') return;
        sent.push(JSON.parse(init.body) as Record<string, unknown>);
      },
    });

    renderWithProviders(<AiModePage />, { config: CONFIG });

    await user.type(screen.getByRole('textbox'), 'Do you stock feeding tubes?');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });

    // The account is the proof. A token would be ignored, and sending one
    // anyway would be a bearer secret on the wire for no reason.
    expect(sent[0]).not.toHaveProperty('conversationToken');
  });
});

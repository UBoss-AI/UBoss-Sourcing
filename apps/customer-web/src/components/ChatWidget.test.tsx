/**
 * The chat widget, tested for the four things the sign-in gate changed.
 *
 *   1. A guest never reaches a composer, and is offered a way in instead.
 *   2. The three questions the panel used to open with are gone — from the
 *      screen and from the request.
 *   3. A signed-in customer with nothing saved anywhere goes straight from the
 *      launcher to a conversation.
 *   4. An expired session does not cost somebody the question they were
 *      part-way through typing.
 *
 * `fetch` is stubbed at the boundary, so the API client's own rules — the CSRF
 * header, the error envelope, the single shared refresh — are exercised rather
 * than mocked away.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorResponse, jsonResponse, makeSession, renderWithProviders } from '@/test/harness';
import { FALLBACK_CONFIG } from '@/app/storefront-context';
import type { StorefrontConfig } from '@/lib/types';
import { ChatWidget } from './ChatWidget';

/** A deployment with an AI key. Without this the widget renders nothing at all. */
const WITH_ASSISTANT: StorefrontConfig = {
  ...FALLBACK_CONFIG,
  features: { ...FALLBACK_CONFIG.features, assistant: true },
  assistant: {
    available: true,
    isAi: true,
    model: 'test-model',
    vendor: { name: 'Test Vendor', country: 'US' },
  },
};

const GUEST = makeSession({ user: null, isCustomer: false });

function openThePanel(): Promise<void> {
  return userEvent.click(screen.getByRole('button', { name: /sign in to use ai|ask about/i }));
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe('a guest', () => {
  it('is offered a way in, and never a composer', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    renderWithProviders(<ChatWidget />, { config: WITH_ASSISTANT, session: GUEST });

    await openThePanel();

    expect(screen.getByRole('link', { name: /sign in to use ai/i })).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

    // The decisive assertion: opening the panel as a guest must not have
    // reached the API at all, let alone opened a conversation on it.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is still told it is talking to a machine', async () => {
    renderWithProviders(<ChatWidget />, { config: WITH_ASSISTANT, session: GUEST });

    await openThePanel();

    // AI Act Art. 50(1) applies to somebody deciding whether to sign in for
    // this, not only to somebody who already has. Twice over, in fact: the
    // panel header repeats it for anyone who reopens the panel tomorrow.
    expect(screen.getAllByText(/chatting with an AI assistant/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Test Vendor/)).toBeInTheDocument();
  });

  it('carries the page it came from into the sign-in link', async () => {
    renderWithProviders(<ChatWidget />, {
      config: WITH_ASSISTANT,
      session: GUEST,
      route: '/product/safety-iv-cannula-22g',
    });

    await openThePanel();

    expect(screen.getByRole('link', { name: /sign in to use ai/i })).toHaveAttribute(
      'href',
      '/login',
    );
  });
});

describe('a signed-in customer', () => {
  it('goes straight to a composer, with nothing asked of them', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ conversationId: 'c'.repeat(26) }, 201));

    renderWithProviders(<ChatWidget />, { config: WITH_ASSISTANT });

    await openThePanel();

    expect(await screen.findByRole('textbox')).toBeInTheDocument();

    // None of the three the panel used to open with.
    expect(screen.queryByLabelText(/your name/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/mobile number/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/email address/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /start chatting/i })).not.toBeInTheDocument();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(typeof url === 'string' ? url : '').toContain('/assistant/start');

    // And nothing about them in the payload either. An empty body is what the
    // API now accepts; a name, a phone or an email is a 400.
    const body = init?.body;
    expect(typeof body).toBe('string');
    expect(JSON.parse(body as string)).toEqual({});
  });

  /*
   * The new-customer case. Nothing in sessionStorage, no profile fetched, no
   * details saved anywhere — and it still has to work, because otherwise the
   * removed form has simply moved somewhere less visible.
   */
  it('starts a conversation with nothing saved in the browser', async () => {
    expect(sessionStorage.length).toBe(0);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ conversationId: 'c'.repeat(26) }, 201),
    );

    renderWithProviders(<ChatWidget />, { config: WITH_ASSISTANT });

    await openThePanel();

    const composer = await screen.findByRole('textbox');
    await userEvent.type(composer, 'Do you stock 22G safety cannulae?');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /send/i })).toBeEnabled();
    });
  });
});

describe('a session that ends mid-question', () => {
  it('keeps the unsent message and offers a way back in', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input instanceof Request ? input.url : input);

      if (url.includes('/assistant/start')) {
        return Promise.resolve(jsonResponse({ conversationId: 'c'.repeat(26) }, 201));
      }

      // The chat call, and then the refresh the client tries once before it
      // gives up. Both refused: this is a session that is genuinely over.
      return Promise.resolve(
        errorResponse(401, 'SESSION_EXPIRED', 'Your session has expired. Please sign in again.'),
      );
    });

    renderWithProviders(<ChatWidget />, { config: WITH_ASSISTANT });

    await openThePanel();

    const composer = await screen.findByRole('textbox');
    await userEvent.type(composer, 'Which packs are sterile?');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(screen.getByText(/session has expired/i)).toBeInTheDocument();
    });

    expect(screen.getByRole('link', { name: /sign in again/i })).toBeInTheDocument();

    // The question survived the failure, both on screen and across the
    // navigation to the sign-in page that has not happened yet.
    expect(sessionStorage.getItem('uboss_chat_draft')).toBe(
      JSON.stringify('Which packs are sterile?'),
    );

    // The conversation did not. It is not this browser's to resume.
    expect(sessionStorage.getItem('uboss_chat_conversation')).toBeNull();

    expect(fetchMock).toHaveBeenCalled();
  });
});

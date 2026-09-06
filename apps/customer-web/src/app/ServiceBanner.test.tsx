/**
 * The site-wide banner, and the one thing it kept getting wrong.
 *
 * The api client announces a session ending on any 401 it cannot refresh away,
 * because it has no idea whether there was ever a session to end. A rejected
 * sign-in is a 401 like any other — so mistyping a password, or trying to sign
 * in before confirming a new account, used to put "Your session has ended.
 * Sign in again" across the top of the page, immediately above the real reason,
 * for somebody who had never been signed in.
 *
 * The banner's own comment already said a customer who was never signed in
 * should not be told their session ended. These tests are what makes that true.
 */
import { useState } from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceBanner } from './ServiceBanner';
import { errorResponse, makeSession, renderWithProviders } from '@/test/harness';
import { SessionContext } from '@/auth/session-context';
import { api } from '@/lib/api';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Every call 401s, including the refresh the client tries first. */
function serveUnauthorised(): void {
  fetchMock.mockResolvedValue(
    errorResponse(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.'),
  );
}

const SESSION_ENDED = /your session has ended/i;

/**
 * A session that can be dropped mid-test.
 *
 * The provider has to sit inside the rendered tree rather than around it: the
 * harness wraps what it is given once, so a `rerender` would lose every other
 * provider with it.
 */
function DroppableSession(): React.JSX.Element {
  const [signedIn, setSignedIn] = useState(true);

  return (
    <SessionContext.Provider
      value={signedIn ? makeSession() : makeSession({ user: null, isCustomer: false })}
    >
      <button
        onClick={() => {
          setSignedIn(false);
        }}
      >
        drop the session
      </button>
      <ServiceBanner />
    </SessionContext.Provider>
  );
}

describe('ServiceBanner', () => {
  it('stays quiet when a visitor who was never signed in is refused', async () => {
    serveUnauthorised();

    renderWithProviders(<ServiceBanner />, {
      session: makeSession({ user: null, isCustomer: false }),
    });

    // A failed sign-in, on a page where nobody has ever been signed in.
    await expect(api.post('/auth/login', {})).rejects.toThrow();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(screen.queryByText(SESSION_ENDED)).not.toBeInTheDocument();
  });

  it('announces a session that really did end', async () => {
    const user = userEvent.setup();
    serveUnauthorised();

    // Signed in first, so the banner has seen a session exist - which is the
    // case it is actually for: the refresh token lapsing mid-visit.
    renderWithProviders(<DroppableSession />);
    await user.click(screen.getByRole('button', { name: /drop the session/i }));

    await expect(api.get('/cart')).rejects.toThrow();

    await waitFor(() => {
      expect(screen.getByText(SESSION_ENDED)).toBeInTheDocument();
    });
  });
});

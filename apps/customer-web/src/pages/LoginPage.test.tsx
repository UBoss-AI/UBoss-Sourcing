/**
 * The sign-in form.
 *
 * There is no terms tick here any more, and these pin that: the Terms and the
 * Privacy Policy are accepted on the agreement screen after signing in, where
 * the acceptance is recorded against the account and asked for again only
 * when a new version requires it. A tick on every sign-in recorded nothing
 * and asked the same question again each time.
 *
 * The credentials half is deliberately not re-tested here: "one message for a
 * wrong email and a wrong password alike" is the backend's promise, and this
 * page only renders what it is handed.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LoginPage } from './LoginPage';
import { makeSession, renderWithProviders } from '@/test/harness';

/** Nobody signed in — the state this page exists for. */
function visitor(login = vi.fn()): ReturnType<typeof makeSession> {
  return makeSession({ user: null, isCustomer: false, login });
}

async function fillCredentials(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText(/email address/i), 'asha@example.test');
  await user.type(screen.getByLabelText(/password/i), 'CorrectHorseBattery1');
}

describe('LoginPage', () => {
  it('asks for no terms tick: the agreement screen after sign-in records that', () => {
    renderWithProviders(<LoginPage />, { session: visitor() });

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('signs in with the email and password alone', async () => {
    const user = userEvent.setup();
    const login = vi.fn().mockResolvedValue({ next: 'READY', mfaChallengeRequired: false });

    renderWithProviders(<LoginPage />, { session: visitor(login) });

    await fillCredentials(user);
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      // No CAPTCHA is configured here, so the token is null - sent explicitly, never omitted.
      expect(login).toHaveBeenCalledWith('asha@example.test', 'CorrectHorseBattery1', undefined, null);
    });
  });
});

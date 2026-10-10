/**
 * The sign-in form.
 *
 * The agreement boxes sit under the password (`SignInAgreements`, tested in
 * the agreement kit): Sign in waits for them, and what was ticked is handed
 * to the sign-in so the first agreement request afterwards records it.
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

vi.mock('@/components/agreement-kit/SignInAgreements', () => import('@/components/agreement-kit/sign-in-agreements-stub'));

/** Nobody signed in — the state this page exists for. */
function visitor(login = vi.fn()): ReturnType<typeof makeSession> {
  return makeSession({ user: null, isCustomer: false, login });
}

async function fillCredentials(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText(/email address/i), 'asha@example.test');
  await user.type(screen.getByLabelText(/password/i), 'CorrectHorseBattery1');
}

describe('LoginPage', () => {
  it('shows the buyer agreement boxes under the password, and waits for them', async () => {
    const flags = globalThis as { signInAgreementsIncomplete?: boolean };
    flags.signInAgreementsIncomplete = true;
    const user = userEvent.setup();
    const login = vi.fn();
    try {
      renderWithProviders(<LoginPage />, { session: visitor(login) });
      expect(screen.getByText('Agreement boxes for BUYER')).toBeInTheDocument();
      await fillCredentials(user);
      expect(screen.getByRole('button', { name: /sign in/i })).toBeDisabled();
      expect(login).not.toHaveBeenCalled();
    } finally {
      flags.signInAgreementsIncomplete = false;
    }
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

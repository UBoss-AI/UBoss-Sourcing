/**
 * The sign-in form.
 *
 * The terms tick is what these cover, because it is the one thing on this
 * screen that can silently stop working. It is a client-side gate — the
 * backend neither receives it nor cares — so if the resolver stops producing
 * an error for it, the form simply signs people in without it and nothing
 * anywhere complains. That is the regression worth a test.
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
import { FALLBACK_CONFIG } from '@/app/storefront-context';
import type { StorefrontConfig } from '@/lib/types';

/** Nobody signed in — the state this page exists for. */
function visitor(login = vi.fn()): ReturnType<typeof makeSession> {
  return makeSession({ user: null, isCustomer: false, login });
}

/** A deployment whose operator has published two policies. */
function configWithPolicies(): StorefrontConfig {
  return {
    ...FALLBACK_CONFIG,
    business: {
      ...FALLBACK_CONFIG.business,
      policyLinks: {
        'Terms of business': 'https://example.test/terms',
        'Privacy policy': 'https://example.test/privacy',
      },
    },
  };
}

async function fillCredentials(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText(/email address/i), 'asha@example.test');
  await user.type(screen.getByLabelText(/password/i), 'CorrectHorseBattery1');
}

describe('LoginPage - accepting the terms', () => {
  it('refuses valid credentials while the box is unticked', async () => {
    const user = userEvent.setup();
    const login = vi.fn();

    renderWithProviders(<LoginPage />, { session: visitor(login) });

    await fillCredentials(user);
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(
      await screen.findByText('You need to accept the terms to sign in.'),
    ).toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
  });

  it('signs in once the box is ticked', async () => {
    const user = userEvent.setup();
    const login = vi.fn().mockResolvedValue(undefined);

    renderWithProviders(<LoginPage />, { session: visitor(login) });

    await fillCredentials(user);
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(login).toHaveBeenCalledWith('asha@example.test', 'CorrectHorseBattery1');
    });
  });

  it('starts unticked, so the acceptance is given rather than assumed', () => {
    renderWithProviders(<LoginPage />, { session: visitor() });

    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('links to the policies the operator has published', () => {
    renderWithProviders(<LoginPage />, {
      session: visitor(),
      config: configWithPolicies(),
    });

    const terms = screen.getByRole('link', { name: 'Terms of business' });
    expect(terms).toHaveAttribute('href', 'https://example.test/terms');
    // A new tab: reading the terms must not cost somebody the email they have
    // already typed.
    expect(terms).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('link', { name: 'Privacy policy' })).toHaveAttribute(
      'href',
      'https://example.test/privacy',
    );
  });

  it('asks for the tick even where no policy has been published', () => {
    // The fallback config has none, which is where a fresh deployment starts.
    renderWithProviders(<LoginPage />, { session: visitor() });

    expect(screen.getByRole('checkbox')).toBeInTheDocument();
    expect(screen.getByText('I accept the terms of business')).toBeInTheDocument();
  });
});

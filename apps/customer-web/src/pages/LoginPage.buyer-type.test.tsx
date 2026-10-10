/**
 * The Individual and Company tabs on the sign-in page.
 *
 * The tab is a preference the server may ignore - it never grants anything -
 * so what matters here is that the page offers it properly: a real tablist a
 * keyboard can drive, a deep link that opens the right tab, the tab sent with
 * the credentials, and each tab's "create an account" link going to its own
 * sign-up. And where the deployment has switched company buyers off, none of
 * it appears and sign-in is exactly what it was.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LoginPage } from './LoginPage';
import { makeSession, renderWithProviders } from '@/test/harness';
import { FALLBACK_CONFIG } from '@/app/storefront-context';
import type { StorefrontConfig } from '@/lib/types';

// The boxes themselves are tested in the agreement kit; here they are ticked.
vi.mock('@/components/agreement-kit/SignInAgreements', () => import('@/components/agreement-kit/sign-in-agreements-stub'));

function config(buyerCompanies: boolean): StorefrontConfig {
  return {
    ...FALLBACK_CONFIG,
    features: { ...FALLBACK_CONFIG.features, buyerCompanies, selfRegistration: true },
  };
}

function visitor(login = vi.fn().mockResolvedValue({ next: 'READY' })): ReturnType<typeof makeSession> {
  return makeSession({ user: null, isCustomer: false, login });
}

async function signIn(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText(/email address/i), 'asha@example.test');
  await user.type(screen.getByLabelText(/password/i), 'CorrectHorseBattery1');
  await user.click(screen.getByRole('button', { name: /sign in/i }));
}

describe('LoginPage - Individual and Company tabs', () => {
  it('offers both tabs, with Individual selected by default', () => {
    renderWithProviders(<LoginPage />, { session: visitor(), config: config(true) });

    expect(screen.getByRole('tablist', { name: 'Who are you buying for?' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Individual' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Company' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tabpanel')).toBeInTheDocument();
  });

  it('opens the Company tab from a deep link', () => {
    renderWithProviders(<LoginPage />, { session: visitor(), config: config(true), route: '/login?buyerType=company' });

    expect(screen.getByRole('tab', { name: 'Company' })).toHaveAttribute('aria-selected', 'true');
  });

  it('treats an unknown buyerType as the Individual tab', () => {
    renderWithProviders(<LoginPage />, { session: visitor(), config: config(true), route: '/login?buyerType=admin' });

    expect(screen.getByRole('tab', { name: 'Individual' })).toHaveAttribute('aria-selected', 'true');
  });

  it('moves between the tabs with the arrow keys, keeping one tab in the tab order', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />, { session: visitor(), config: config(true) });

    const individual = screen.getByRole('tab', { name: 'Individual' });
    const company = screen.getByRole('tab', { name: 'Company' });
    expect(individual).toHaveAttribute('tabindex', '0');
    expect(company).toHaveAttribute('tabindex', '-1');

    await user.click(individual);
    await user.keyboard('{ArrowRight}');
    expect(company).toHaveFocus();
    expect(company).toHaveAttribute('aria-selected', 'true');
    expect(company).toHaveAttribute('tabindex', '0');

    await user.keyboard('{Home}');
    expect(individual).toHaveFocus();
    expect(individual).toHaveAttribute('aria-selected', 'true');
  });

  it('sends the chosen tab with the credentials', async () => {
    const user = userEvent.setup();
    const login = vi.fn().mockResolvedValue({ next: 'READY' });
    renderWithProviders(<LoginPage />, { session: visitor(login), config: config(true), route: '/login?buyerType=company' });

    await signIn(user);

    await waitFor(() => {
      expect(login).toHaveBeenCalledWith('asha@example.test', 'CorrectHorseBattery1', 'company', null);
    });
  });

  it("points each tab's create-an-account link at its own sign-up", async () => {
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />, { session: visitor(), config: config(true) });

    expect(screen.getByRole('link', { name: /create one|create an account/i })).toHaveAttribute('href', '/register');
    await user.click(screen.getByRole('tab', { name: 'Company' }));
    expect(screen.getByRole('link', { name: 'Register your company' })).toHaveAttribute('href', '/register/company');
  });

  it('shows no tabs, and signs in without a buyer type, where company buyers are switched off', async () => {
    const user = userEvent.setup();
    const login = vi.fn().mockResolvedValue({ next: 'READY' });
    renderWithProviders(<LoginPage />, { session: visitor(login), config: config(false), route: '/login?buyerType=company' });

    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    await signIn(user);
    await waitFor(() => {
      // No CAPTCHA is configured here, so the token is null - sent explicitly, never omitted.
      expect(login).toHaveBeenCalledWith('asha@example.test', 'CorrectHorseBattery1', undefined, null);
    });
  });
});

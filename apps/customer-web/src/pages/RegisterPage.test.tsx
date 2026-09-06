/**
 * The sign-up form.
 *
 * Four properties are worth pinning down, and only one of them is the happy
 * path:
 *
 *   - The page follows the backend's flag. A form rendered where
 *     self-registration is off would post into a 403.
 *   - Validation failures land on their fields. This is not a formality: with
 *     the resolver this app used to ship, an invalid submit threw instead of
 *     producing field errors, and the form silently did nothing.
 *   - The success screen never claims an account was created — the server
 *     answers a duplicate address identically, so this page genuinely does not
 *     know which happened.
 *   - A server-side field error is put on the field it names.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RegisterPage } from './RegisterPage';
import { errorResponse, jsonResponse, renderWithProviders } from '@/test/harness';
import { FALLBACK_CONFIG } from '@/app/storefront-context';
import type { StorefrontConfig } from '@/lib/types';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A deployment with sign-up switched on and one market to choose from. */
function openConfig(overrides: Partial<StorefrontConfig['features']> = {}): StorefrontConfig {
  return {
    ...FALLBACK_CONFIG,
    localisation: {
      ...FALLBACK_CONFIG.localisation,
      countries: [{ code: 'IN', name: 'India', currencyCode: 'INR', phonePrefix: '+91' }],
    },
    features: { ...FALLBACK_CONFIG.features, selfRegistration: true, ...overrides },
  };
}

/** Fill every required field with something valid. */
async function fillForm(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText(/your name/i), 'Asha Menon');
  await user.type(screen.getByLabelText(/email address/i), 'asha@example.test');
  await user.selectOptions(screen.getByLabelText(/country you order from/i), 'IN');
  await user.type(screen.getByLabelText(/mobile number/i), '+91 98765 43210');
  await user.type(screen.getByLabelText(/choose a password/i), 'CorrectHorseBattery1');
  await user.type(screen.getByLabelText(/confirm your password/i), 'CorrectHorseBattery1');
  await user.click(screen.getByRole('checkbox'));
}

describe('RegisterPage - the feature flag', () => {
  it('shows the invitation notice, and no form, where sign-up is off', () => {
    renderWithProviders(<RegisterPage />, { config: FALLBACK_CONFIG });

    expect(screen.getByText(/accounts are by invitation/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create account/i })).not.toBeInTheDocument();
  });

  it('renders the form where sign-up is on', () => {
    renderWithProviders(<RegisterPage />, { config: openConfig() });

    expect(screen.getByRole('button', { name: /create account/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/mobile number/i)).toBeInTheDocument();
  });
});

describe('RegisterPage - validation', () => {
  /**
   * The regression this file was written for. `@hookform/resolvers` 3.x reads
   * `error.errors` off a ZodError, which Zod 4 renamed to `issues` - so the
   * resolver threw instead of returning field errors and pressing the button
   * did nothing at all, with no message anywhere on screen.
   */
  it('reports field errors rather than silently doing nothing', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RegisterPage />, { config: openConfig() });

    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText('Enter your name.')).toBeInTheDocument();
    expect(screen.getByText('Enter your email address.')).toBeInTheDocument();
    expect(screen.getByText('Choose a country.')).toBeInTheDocument();
    // Nothing was posted: the form stopped at its own gate.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses two passwords that do not match', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RegisterPage />, { config: openConfig() });

    await fillForm(user);
    await user.clear(screen.getByLabelText(/confirm your password/i));
    await user.type(screen.getByLabelText(/confirm your password/i), 'SomethingElse12345');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText('The two passwords do not match.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('holds the same password floor the backend does', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RegisterPage />, { config: openConfig() });

    await user.type(screen.getByLabelText(/choose a password/i), 'short');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText('Use at least 12 characters.')).toBeInTheDocument();
  });
});

describe('RegisterPage - submitting', () => {
  it('posts the four asked-for fields and shows the check-your-email screen', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      jsonResponse({ registered: true, requiresApproval: true, message: 'Check your email.' }),
    );

    renderWithProviders(<RegisterPage />, { config: openConfig() });
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toContain('/auth/register');
    expect(JSON.parse(init.body)).toMatchObject({
      fullName: 'Asha Menon',
      email: 'asha@example.test',
      phone: '+91 98765 43210',
      country: 'IN',
      acceptedTerms: true,
    });

    expect(await screen.findByText('Check your email')).toBeInTheDocument();
    // The wording is conditional on purpose - the server answers a duplicate
    // address identically, so claiming an account was created would be a lie
    // half the time and an enumeration leak the other half.
    expect(screen.getByText(/if asha@example\.test can have an account/i)).toBeInTheDocument();
  });

  it('warns about review before the form is sent, not after', () => {
    renderWithProviders(<RegisterPage />, { config: openConfig() });

    expect(screen.getByText(/reviewed by our team before the first order/i)).toBeInTheDocument();
  });

  it('says nothing about review where the deployment does not review', () => {
    renderWithProviders(<RegisterPage />, {
      config: openConfig({ selfRegistrationRequiresApproval: false }),
    });

    expect(screen.queryByText(/reviewed by our team/i)).not.toBeInTheDocument();
  });

  it('puts a server-side field error on the field it names', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      errorResponse(400, 'VALIDATION_FAILED', 'Choose a country we ship to.', [
        { field: 'country', code: 'COUNTRY_NOT_SUPPORTED', message: 'We do not ship there yet.' },
      ]),
    );

    renderWithProviders(<RegisterPage />, { config: openConfig() });
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText('We do not ship there yet.')).toBeInTheDocument();
    // The form stays up with the typed answers intact - there is a field to fix.
    expect(screen.getByLabelText(/your name/i)).toHaveValue('Asha Menon');
  });

  it('shows a banner for a failure that names no field', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      errorResponse(403, 'SELF_REGISTRATION_DISABLED', 'Accounts are created by invitation.'),
    );

    renderWithProviders(<RegisterPage />, { config: openConfig() });
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText('Accounts are created by invitation.')).toBeInTheDocument();
  });
});

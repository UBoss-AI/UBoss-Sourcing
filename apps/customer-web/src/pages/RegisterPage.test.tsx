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
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes, useLocation } from 'react-router-dom';
import { CheckEmailPage, RegisterPage, RegistrationForm } from './RegisterPage';
import { CHECK_EMAIL_PATH } from '@/lib/sign-up';
import { errorResponse, jsonResponse, renderWithProviders } from '@/test/harness';
import { FALLBACK_CONFIG } from '@/app/storefront-context';
import type { StorefrontConfig } from '@/lib/types';

/** Every request the form sends, except the one for the current Terms. */
const fetchMock = vi.fn();

export const TERMS_ID = '01JTERMS0000000000000000AA';

/** What `GET /legal/current` answers: short text, so I agree is enabled at once. */
const CURRENT_TERMS = {
  document: {
    id: TERMS_ID,
    kind: 'PLATFORM_TERMS',
    version: '2026-10-01',
    locale: 'en',
    title: 'Terms and Conditions',
    body: '## Using the marketplace\nShort test text.',
    changeSummary: null,
    effectiveAt: '2026-10-01T00:00:00.000Z',
    publishedAt: '2026-09-30T00:00:00.000Z',
    contentSha256: 'a'.repeat(64),
  },
  requestedLocale: 'en',
  isFallback: false,
};

beforeEach(() => {
  fetchMock.mockReset();
  // The Terms are asked for on every render of the form. Answered here so the
  // assertions below count only what the person's actions send.
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: unknown) =>
      String(input).includes('/legal/current')
        ? Promise.resolve(jsonResponse(CURRENT_TERMS))
        : (fetchMock(input, init) as Promise<Response>),
    ),
  );
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
  // The box opens the Terms; only I agree ticks it.
  await user.click(await screen.findByRole('checkbox', { name: /terms and conditions/i }));
  const dialog = await screen.findByRole('dialog', { name: 'Terms and Conditions' });
  const agree = within(dialog).getByRole('button', { name: 'I agree' });
  await waitFor(() => {
    expect(agree).toBeEnabled();
  });
  await user.click(agree);
  await waitFor(() => {
    expect(screen.getByRole('checkbox', { name: /terms and conditions/i })).toBeChecked();
  });
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

    renderWithProviders(<SignUpRoutes />, { config: openConfig(), route: '/register' });
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
      // The document agreed to, as the server sent it. Never a version string.
      termsDocumentId: TERMS_ID,
    });
    expect(JSON.parse(init.body)).not.toHaveProperty('consentVersion');

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

describe('RegisterPage - company and individual sign-up', () => {
  it('shows a company sign-up where it sits in the six-step onboarding, on step 1', () => {
    renderWithProviders(<RegistrationForm variant="company" />, { config: openConfig() });

    const steps = screen.getByRole('navigation', { name: /steps/i });
    expect(within(steps).getAllByRole('listitem')).toHaveLength(6);
    expect(within(steps).getByText(/account and representative/i).closest('[aria-current]')).toHaveAttribute('aria-current', 'step');
    expect(screen.getAllByText(/step 1 of 6/i).length).toBeGreaterThan(0);
  });

  it('leaves the individual sign-up exactly as it was - no company steps, the same fields', () => {
    renderWithProviders(<RegisterPage />, { config: openConfig() });

    expect(screen.queryByRole('navigation', { name: /steps/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/step 1 of 6/i)).not.toBeInTheDocument();
    for (const label of [/your name/i, /email address/i, /country you order from/i, /mobile number/i, /choose a password/i, /confirm your password/i]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
  });
});

/**
 * The two pages of a sign-up as the router has them, plus a readout of where
 * the router is - so a test can tell "navigated" from "swapped in place".
 */
function SignUpRoutes(): React.JSX.Element {
  const location = useLocation();
  return (
    <>
      <output data-testid="path">{location.pathname}</output>
      <Routes>
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/register/company" element={<RegistrationForm variant="company" />} />
        <Route path={CHECK_EMAIL_PATH} element={<CheckEmailPage />} />
      </Routes>
    </>
  );
}

describe('RegisterPage - from Create account to the verification page', () => {
  it('moves to its own verification page only after the server confirms, with a focusable heading', async () => {
    const user = userEvent.setup();
    let answer: (response: Response) => void = () => undefined;
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        answer = resolve;
      }),
    );
    renderWithProviders(<SignUpRoutes />, { config: openConfig(), route: '/register/company' });
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: /create account/i }));

    // Waiting on the server: still the form, and the button says it is busy.
    expect(screen.getByTestId('path')).toHaveTextContent('/register/company');
    expect(screen.getByRole('button', { name: /create account/i })).toBeDisabled();

    answer(jsonResponse({ registered: true, requiresApproval: false, message: 'Check your email.' }));
    await waitFor(() => {
      expect(screen.getByTestId('path')).toHaveTextContent(CHECK_EMAIL_PATH);
    });

    const heading = screen.getByRole('heading', { level: 1, name: /check your email/i });
    // Marked for the layout to focus, and focusable for it to be able to.
    expect(heading).toHaveAttribute('data-route-focus');
    expect(heading).toHaveAttribute('tabindex', '-1');
    // The company wording and the Company sign-in tab carried across.
    expect(screen.getByText(/sign in on the company tab/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to sign in/i })).toHaveAttribute('href', '/login?buyerType=company');
  });

  it('sends one request for a double-click on Create account', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ registered: true, requiresApproval: false, message: 'ok' }));
    renderWithProviders(<SignUpRoutes />, { config: openConfig(), route: '/register' });
    await fillForm(user);

    await user.dblClick(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => {
      expect(screen.getByTestId('path')).toHaveTextContent(CHECK_EMAIL_PATH);
    });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/auth/register'))).toHaveLength(1);
  });

  it('stays on the form with everything typed when the request fails, and can be sent again', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(errorResponse(503, 'SERVICE_UNAVAILABLE', 'Try again shortly.'));
    renderWithProviders(<SignUpRoutes />, { config: openConfig(), route: '/register' });
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByTestId('path')).toHaveTextContent('/register');
    expect(screen.getByLabelText(/your name/i)).toHaveValue('Asha Menon');
    expect(screen.getByLabelText(/email address/i)).toHaveValue('asha@example.test');
    expect(screen.getByLabelText(/mobile number/i)).toHaveValue('+91 98765 43210');

    // The guard is released on failure, so the second press is sent.
    fetchMock.mockResolvedValueOnce(jsonResponse({ registered: true, requiresApproval: false, message: 'ok' }));
    await user.click(screen.getByRole('button', { name: /create account/i }));
    await waitFor(() => {
      expect(screen.getByTestId('path')).toHaveTextContent(CHECK_EMAIL_PATH);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('renders the verification page when opened directly or refreshed without the sign-up\'s state', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    renderWithProviders(<SignUpRoutes />, { config: openConfig(), route: CHECK_EMAIL_PATH });

    expect(screen.getByRole('heading', { level: 1, name: /check your email/i })).toBeInTheDocument();
    // No address to name, so it says so without inventing one...
    expect(screen.getByText(/if the address you signed up with/i)).toBeInTheDocument();
    // ...and asks for it before resending, rather than posting an empty one.
    await user.click(screen.getByRole('button', { name: /send it again/i }));
    expect(fetchMock).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText(/email address/i), 'asha@example.test');
    await user.click(screen.getByRole('button', { name: /send it again/i }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toContain('/auth/verify-email/resend');
    expect(JSON.parse(init.body)).toEqual({ email: 'asha@example.test' });
  });

  it('never puts the address in the URL', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ registered: true, requiresApproval: false, message: 'ok' }));
    renderWithProviders(<SignUpRoutes />, { config: openConfig(), route: '/register' });
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: /create account/i }));
    await waitFor(() => {
      expect(screen.getByTestId('path')).toHaveTextContent(CHECK_EMAIL_PATH);
    });
    expect(screen.getByTestId('path').textContent).not.toContain('asha');
  });
});

describe('RegisterPage - the Terms and Conditions', () => {
  it('will not send the form until the Terms are agreed to', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RegisterPage />, { config: openConfig() });

    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText('You need to accept the terms to create an account.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clears the agreement and asks again when the server says the Terms changed', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      errorResponse(409, 'TERMS_VERSION_OUTDATED', 'The Terms and Conditions have changed.', [
        { field: 'acceptedTerms', code: 'TERMS_VERSION_OUTDATED' },
      ]),
    );
    renderWithProviders(<RegisterPage />, { config: openConfig() });
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(/the terms and conditions have changed. open them/i)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /terms and conditions/i })).not.toBeChecked();
    // Everything else the person typed is still there.
    expect(screen.getByLabelText(/your name/i)).toHaveValue('Asha Menon');
  });
});

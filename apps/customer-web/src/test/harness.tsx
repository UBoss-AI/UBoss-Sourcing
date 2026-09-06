/**
 * Test harness.
 *
 * Renders a component inside the same providers the real app uses, with a
 * fresh QueryClient per test so one test's cache cannot leak into the next.
 *
 * `fetch` is stubbed at the boundary rather than mocking the API client —
 * which means the client's own behaviour (CSRF header, the error envelope,
 * the single shared refresh) is exercised by every test rather than bypassed.
 */
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import type { RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import { StorefrontContext, FALLBACK_CONFIG } from '@/app/storefront-context';
import { LocaleContext } from '@/app/locale-context';
import type { LocaleState } from '@/app/locale-context';
import { SessionContext } from '@/auth/session-context';
import type { SessionState } from '@/auth/session-context';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import type { StorefrontConfig } from '@/lib/types';

/** A signed-in customer, unless a test says otherwise. */
export function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    user: {
      id: 'user-1',
      email: 'buyer@example.test',
      type: 'CUSTOMER',
      roles: ['customer'],
      permissions: [],
      customerProfileId: 'profile-1',
      mfaEnabled: false,
    },
    isLoading: false,
    isCustomer: true,
    login: vi.fn(),
    logout: vi.fn(),
    refreshUser: vi.fn(),
    ...overrides,
  };
}

/**
 * A shopper already quoted in the base currency.
 *
 * Static rather than the real provider: a test asserting a cart should not
 * also be exercising geolocation and an account round-trip. Tests that care
 * about the market pass their own.
 */
export function makeLocale(overrides: Partial<LocaleState> = {}): LocaleState {
  return {
    currency: 'INR',
    country: 'IN',
    currencies: [],
    countries: [],
    needsChoice: false,
    detectedCountry: null,
    detectedMismatch: false,
    marketSuggestion: null,
    choose: vi.fn(),
    dismissChoice: vi.fn(),
    setCurrency: vi.fn(),
    acceptSuggestion: vi.fn(),
    dismissSuggestion: vi.fn(),
    ...overrides,
  };
}

export function renderWithProviders(
  ui: ReactElement,
  options: {
    session?: SessionState;
    config?: StorefrontConfig;
    locale?: LocaleState;
    route?: string;
  } = {},
): RenderResult {
  const queryClient = new QueryClient({
    defaultOptions: {
      // No retries in tests: a deliberate failure should fail once and fast,
      // not three times with backoff.
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });

  return render(
    <MemoryRouter initialEntries={[options.route ?? '/']}>
      {/* Real English copy, not raw keys. Without this a test asserting on
          "Your cart is empty" fails against the key name, which reads as a
          broken component rather than a missing provider. */}
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <StorefrontContext.Provider value={options.config ?? FALLBACK_CONFIG}>
            <ToastProvider>
              <SessionContext.Provider value={options.session ?? makeSession()}>
                <LocaleContext.Provider value={options.locale ?? makeLocale()}>
                  {ui}
                </LocaleContext.Provider>
              </SessionContext.Provider>
            </ToastProvider>
          </StorefrontContext.Provider>
        </QueryClientProvider>
      </I18nextProvider>
    </MemoryRouter>,
  );
}

/** A minimal JSON response, shaped the way the API actually replies. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The backend's error envelope, which the client parses into an ApiError. */
export function errorResponse(
  status: number,
  code: string,
  message: string,
  details: unknown[] = [],
): Response {
  return jsonResponse(
    { error: { code, message, details, correlationId: 'test-correlation-id' } },
    status,
  );
}

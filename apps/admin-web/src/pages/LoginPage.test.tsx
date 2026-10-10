/**
 * The console's sign-in.
 *
 * The staff terms and the Privacy Policy are ticked under the password
 * (`SignInAgreements`, tested in the agreement kit and stood in for here), and
 * recorded after sign-in. `login` is called with the email and the password
 * and nothing else.
 *
 * Plain assertions throughout: this app's test setup has no jest-dom matchers.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { i18n } from '@/i18n/config';
import { LoginPage } from './LoginPage';

// The boxes themselves are tested in the agreement kit; here they are ticked.
vi.mock('@/components/agreement-kit/SignInAgreements', () => import('@/components/agreement-kit/sign-in-agreements-stub'));

// The turning earth is decoration and needs WebGL; the frame alone will do.
vi.mock('@/components/ui/auth-split', () => ({
  AuthSplit: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

let login: ReturnType<typeof vi.fn>;

function renderLogin(): void {
  login = vi.fn(() => Promise.resolve());
  const session = {
    user: null,
    isLoading: false,
    login,
    logout: vi.fn(),
    refreshUser: vi.fn(),
    can: () => false,
    canAny: () => false,
  } as unknown as SessionState;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <SessionContext.Provider value={session}>
          <MemoryRouter initialEntries={['/login']}>
            <LoginPage />
          </MemoryRouter>
        </SessionContext.Provider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('LoginPage', () => {
  it('shows the staff agreement boxes under the password', () => {
    renderLogin();
    expect(screen.getByText('Agreement boxes for STAFF')).toBeTruthy();
  });

  it('signs in with the email and password and nothing else', async () => {
    renderLogin();
    fireEvent.input(screen.getByLabelText(/email address/i), { target: { value: 'staff@example.test' } });
    fireEvent.input(screen.getByLabelText(/^password/i), { target: { value: 'correct horse battery' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(login).toHaveBeenCalledTimes(1);
    });
    expect(login.mock.calls[0]).toEqual(['staff@example.test', 'correct horse battery']);
  });
});

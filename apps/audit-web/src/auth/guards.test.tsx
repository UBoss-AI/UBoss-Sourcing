/**
 * The route guards, against the real session provider.
 *
 *   - no session          -> the sign-in screen, remembering where they were going;
 *   - not yet enrolled    -> the two-step setup, IN PLACE of the screen asked for;
 *   - enrolled, unproven  -> the six-digit challenge, in place;
 *   - proven              -> the screen;
 *   - missing permission  -> the 403 page, which names neither the screen nor
 *                            the permission.
 *
 * Every audit role must pass the second factor, so the two MFA stages are the
 * ordinary path here, not an edge case.
 */
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@/app/ThemeProvider';
import { i18n } from '@/i18n/config';
import { ApiError } from '@/lib/api';
import { Permission } from '@/lib/permissions';
import type { ConsoleSession } from '@/lib/types';
import { agency, sessionFor } from '@/test/session-fixture';
import { RequirePermission, RequireSession } from './guards';
import { SessionProvider } from './session';

vi.mock('@/lib/audit', () => ({
  fetchSession: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  beginMfaSetup: vi.fn(),
  verifyMfa: vi.fn(),
}));

const { fetchSession } = vi.mocked(await import('@/lib/audit'));

function LoginProbe(): React.JSX.Element {
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '';
  return <p>sign-in screen, returning to {from}</p>;
}

function renderGuarded(screenUnderTest: React.JSX.Element, entry = '/jobs/job-7'): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={[entry]}>
            <SessionProvider>
              <Routes>
                <Route path="/login" element={<LoginProbe />} />
                <Route path="/jobs/:id" element={<RequireSession>{screenUnderTest}</RequireSession>} />
              </Routes>
            </SessionProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </ThemeProvider>
    </I18nextProvider>,
  );
}

const inspector = (mfa: Partial<ConsoleSession['mfa']>): ConsoleSession =>
  sessionFor({
    role: 'INSPECTOR',
    agency: agency('Northgate Inspection'),
    permissions: [Permission.JOB_READ, Permission.JOB_PERFORM],
    mfa: { required: true, ...mfa },
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RequireSession', () => {
  it('sends somebody with no session to sign in, remembering the address', async () => {
    fetchSession.mockRejectedValue(
      new ApiError(401, { code: 'UNAUTHENTICATED', message: 'Not signed in.' }),
    );

    renderGuarded(<p>the job</p>);

    expect(await screen.findByText('sign-in screen, returning to /jobs/job-7')).toBeDefined();
    expect(screen.queryByText('the job')).toBeNull();
  });

  it('shows two-step setup in place of the screen when the factor is not enrolled', async () => {
    fetchSession.mockResolvedValue(inspector({ enrolled: false }));

    renderGuarded(<p>the job</p>);

    expect(await screen.findByRole('heading', { name: 'Set up two-step sign-in' })).toBeDefined();
    expect(screen.queryByText('the job')).toBeNull();
    expect(screen.queryByText(/sign-in screen/)).toBeNull();
  });

  it('asks for the code in place of the screen when this session has not proved it', async () => {
    fetchSession.mockResolvedValue(inspector({ enrolled: true, sessionVerified: false }));

    renderGuarded(<p>the job</p>);

    expect(await screen.findByRole('heading', { name: 'Enter your code' })).toBeDefined();
    expect(screen.queryByText('the job')).toBeNull();
  });

  it('opens the screen once the second factor is proven', async () => {
    fetchSession.mockResolvedValue(inspector({ enrolled: true, sessionVerified: true }));

    renderGuarded(<p>the job</p>);

    expect(await screen.findByText('the job')).toBeDefined();
  });
});

describe('RequirePermission', () => {
  it('shows the 403 page to an inspector opening a staff-only screen', async () => {
    fetchSession.mockResolvedValue(inspector({ enrolled: true, sessionVerified: true }));

    renderGuarded(
      <RequirePermission anyOf={[Permission.RULE_APPROVE]}>
        <p>the rule approval queue</p>
      </RequirePermission>,
    );

    expect(await screen.findByRole('heading', { name: 'Access restricted' })).toBeDefined();
    expect(screen.queryByText('the rule approval queue')).toBeNull();
    expect(document.body.textContent).not.toContain('audit.rule.approve');
  });

  it('opens a screen when any one of its permissions is held', async () => {
    fetchSession.mockResolvedValue(inspector({ enrolled: true, sessionVerified: true }));

    renderGuarded(
      <RequirePermission anyOf={[Permission.JOB_OVERSEE, Permission.JOB_READ]}>
        <p>the job list</p>
      </RequirePermission>,
    );

    expect(await screen.findByText('the job list')).toBeDefined();
  });
});

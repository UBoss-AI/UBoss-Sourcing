/**
 * What the console shows the person who opens it.
 *
 *   - nobody is signed in            -> the sign-in form, and no organisation;
 *   - somebody already is            -> a panel naming their agency (or the
 *                                       marketplace audit team), with Continue
 *                                       and Sign out;
 *   - the boot request is in flight  -> a loading state.
 *
 * `fetchSession` is the only source of an agency name anywhere in this test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SessionProvider } from '@/auth/session';
import { ThemeProvider } from '@/app/ThemeProvider';
import { i18n } from '@/i18n/config';
import { HomeRedirect } from '@/app/HomeRedirect';
import { ApiError } from '@/lib/api';
import { Permission } from '@/lib/permissions';
import type { ConsoleSession } from '@/lib/types';
import { agency, sessionFor } from '@/test/session-fixture';
import { LoginPage } from './LoginPage';

// The boxes themselves are tested in the agreement kit; here they are ticked.
vi.mock('@/components/agreement-kit/SignInAgreements', () => import('@/components/agreement-kit/sign-in-agreements-stub'));

vi.mock('@/lib/audit', () => ({
  fetchSession: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

const audit = await import('@/lib/audit');

const fetchSession = vi.mocked(audit.fetchSession);
const signIn = vi.mocked(audit.signIn);
const signOut = vi.mocked(audit.signOut);

const signedOut = (): ApiError =>
  new ApiError(401, { code: 'UNAUTHENTICATED', message: 'Not signed in.' });

function renderConsole(entry = '/login'): void {
  render(
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[entry]}>
          <SessionProvider>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/" element={<HomeRedirect />} />
              <Route path="/dashboard" element={<p>the dashboard</p>} />
              <Route path="/jobs" element={<p>the job list</p>} />
              <Route path="/reports" element={<p>the report queue</p>} />
              <Route path="/forgot-password" element={<p>the reset request</p>} />
            </Routes>
          </SessionProvider>
        </MemoryRouter>
      </ThemeProvider>
    </I18nextProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('opening the console with a session already in the browser', () => {
  it('names the agency rather than walking into its dashboard', async () => {
    fetchSession.mockResolvedValue(
      sessionFor({ agency: agency('Northgate Inspection'), email: 'coord@northgate.example' }),
    );

    renderConsole();

    expect(await screen.findByText(/signed in for Northgate Inspection/i)).toBeDefined();
    expect(screen.getByText(/coord@northgate\.example/)).toBeDefined();
    expect(screen.getByRole('button', { name: /continue for Northgate Inspection/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /sign out and use another account/i })).toBeDefined();
    expect(screen.queryByText('the dashboard')).toBeNull();
  });

  it('names the marketplace audit team for staff, who belong to no agency', async () => {
    fetchSession.mockResolvedValue(sessionFor({ role: 'SUPERVISOR', agency: null }));

    renderConsole();

    expect(await screen.findByText(/signed in for Marketplace audit team/i)).toBeDefined();
  });

  it('does not switch agency because an agency is named in the address', async () => {
    fetchSession.mockResolvedValue(sessionFor({ agency: agency('Northgate Inspection') }));

    renderConsole('/login?agencyId=agency-b&agency=Other%20Lab');

    expect(await screen.findByText(/signed in for Northgate Inspection/i)).toBeDefined();
    expect(screen.queryByText(/Other Lab/)).toBeNull();
  });

  it('shows the sign-in form once the person signs out', async () => {
    fetchSession.mockResolvedValue(sessionFor({ agency: agency('Northgate Inspection') }));
    signOut.mockResolvedValue(undefined);

    renderConsole();

    const leave = await screen.findByRole('button', { name: /sign out and use another account/i });
    leave.click();

    await waitFor(() => {
      expect(screen.queryByText(/signed in for Northgate Inspection/i)).toBeNull();
    });

    expect(signOut).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: /^sign in$/i })).toBeDefined();
  });
});

describe('opening the console with nothing to go on', () => {
  it('offers a sign-in form, says there is no self sign-up, and names no agency', async () => {
    fetchSession.mockRejectedValue(signedOut());

    renderConsole();

    expect(await screen.findByRole('button', { name: /^sign in$/i })).toBeDefined();
    expect(screen.getByText(/there is no self sign-up/i)).toBeDefined();
    expect(screen.queryByText(/signed in for/i)).toBeNull();
    expect(screen.getByRole('link', { name: /forgotten your password/i })).toBeDefined();
  });

  it('says why when the boot request refuses a member without access', async () => {
    fetchSession.mockRejectedValue(
      new ApiError(403, {
        code: 'AUDIT_MEMBER_REQUIRED',
        message: 'This account has no active audit console membership.',
      }),
    );

    renderConsole();

    expect(await screen.findByText(/no active audit console membership/i)).toBeDefined();
    expect(screen.queryByText(/signed in for/i)).toBeNull();
  });

  it('shows a loading state while the answer is in flight', async () => {
    let release: (session: ConsoleSession) => void = () => {};

    fetchSession.mockReturnValue(
      new Promise<ConsoleSession>((resolve) => {
        release = resolve;
      }),
    );

    renderConsole();

    expect(screen.queryByRole('button', { name: /^sign in$/i })).toBeNull();
    expect(screen.queryByText(/signed in for/i)).toBeNull();
    expect(screen.getByRole('status')).toBeDefined();

    release(sessionFor({ agency: agency('Harbour Labs', 'agency-b') }));

    expect(await screen.findByText(/signed in for Harbour Labs/i)).toBeDefined();
  });
});

describe('a refused password', () => {
  it('shows the server’s own message and keeps the email typed', async () => {
    fetchSession.mockRejectedValue(signedOut());
    signIn.mockRejectedValue(
      new ApiError(401, {
        code: 'INVALID_CREDENTIALS',
        message: 'That email and password do not match.',
      }),
    );

    renderConsole();

    const email = await screen.findByLabelText('Work email');
    fireEvent.change(email, { target: { value: 'inspector@northgate.example' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong-one' } });
    // Sign in waits for the agreement boxes (stood in for here) to report ticked.
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: /^sign in$/i }).disabled).toBe(false);
    });
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    expect(await screen.findByText(/do not match/i)).toBeDefined();
    expect((email as HTMLInputElement).value).toBe('inspector@northgate.example');
  });
});

describe('where a sign-in lands', () => {
  async function signInAs(session: ConsoleSession): Promise<void> {
    fetchSession.mockRejectedValueOnce(signedOut()).mockResolvedValue(session);
    signIn.mockResolvedValue(undefined);

    renderConsole();

    fireEvent.change(await screen.findByLabelText('Work email'), {
      target: { value: session.user.email },
    });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a-password' } });
    // Sign in waits for the agreement boxes (stood in for here) to report ticked.
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: /^sign in$/i }).disabled).toBe(false);
    });
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
  }

  it('takes an inspector to their jobs, not the dashboard', async () => {
    await signInAs(
      sessionFor({
        role: 'INSPECTOR',
        agency: agency('Northgate Inspection'),
        permissions: [Permission.JOB_READ, Permission.JOB_PERFORM],
      }),
    );

    expect(await screen.findByText('the job list')).toBeDefined();
    expect(screen.queryByText('the dashboard')).toBeNull();
  });

  it('takes a quality reviewer to the reports', async () => {
    await signInAs(
      sessionFor({
        role: 'QA_REVIEWER',
        agency: agency('Northgate Inspection'),
        permissions: [Permission.JOB_READ, Permission.REPORT_SIGN],
      }),
    );

    expect(await screen.findByText('the report queue')).toBeDefined();
  });

  it('takes a supervisor to the dashboard', async () => {
    await signInAs(
      sessionFor({ role: 'SUPERVISOR', permissions: [Permission.DASHBOARD_READ] }),
    );

    expect(await screen.findByText('the dashboard')).toBeDefined();
  });
});

/**
 * What the portal shows the person who opens it.
 *
 * Three answers, and the whole reported bug is that two of them used to look
 * identical to the third:
 *
 *   - nobody is signed in            -> the sign-in form;
 *   - somebody already is            -> a panel naming their company, with
 *                                       Continue and Sign out;
 *   - the boot request is in flight  -> a loading state, and no company name
 *                                       of any kind.
 *
 * The middle one is why this file exists. An operator who had just created a
 * carrier opened the portal, was redirected silently into the dashboard of
 * whichever carrier the browser was still signed in as, and read that as the
 * portal having chosen a tenant by itself. Nothing about the company was
 * wrong; nothing said what it was.
 *
 * `fetchSession` is the only source of a company name anywhere in this test.
 * There is no fixture carrier and no fallback to assert against, because the
 * portal has neither - which is the other half of what is being pinned down
 * here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SessionProvider } from '@/auth/session';
import { ThemeProvider } from '@/app/ThemeProvider';
import { i18n } from '@/i18n/config';
import { ApiError } from '@/lib/api';
import type { PortalSession } from '@/lib/types';
import { LoginPage } from './LoginPage';

vi.mock('@/lib/logistics', () => ({
  fetchSession: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

const logistics = await import('@/lib/logistics');

const fetchSession = vi.mocked(logistics.fetchSession);
const signIn = vi.mocked(logistics.signIn);
const signOut = vi.mocked(logistics.signOut);

function sessionFor(company: string, id: string, email: string): PortalSession {
  return {
    user: {
      id: 'user-1',
      email,
      fullName: 'Signed-in Person',
      role: 'DISPATCHER',
      permissions: [],
      isDriver: false,
    },
    partner: {
      id,
      code: 'LP-00001',
      displayName: company,
      status: 'ACTIVE',
      canAcceptNewWork: true,
    },
    mfa: { required: false, enrolled: false, sessionVerified: false, recoveryCodesRemaining: 0 },
  };
}

/**
 * The portal's own frame, minus the parts a login screen does not reach.
 *
 * `AuthLayout` carries the theme toggle and the language picker, so both
 * providers have to be here - a test that left them out would fail on the
 * chrome rather than on anything this file is about.
 */
function renderPortal(entry = '/login'): void {
  render(
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[entry]}>
          <SessionProvider>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/dashboard" element={<p>the dashboard</p>} />
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

describe('opening the portal with a session already in the browser', () => {
  it('names the company rather than walking into its dashboard', async () => {
    fetchSession.mockResolvedValue(
      sessionFor('Sahyadri Express', 'partner-a', 'dispatch@sahyadri.example'),
    );

    renderPortal();

    // The company is stated, in the person's own words, before anything else.
    expect(await screen.findByText(/signed in as Sahyadri Express/i)).toBeDefined();
    expect(screen.getByText(/dispatch@sahyadri\.example/)).toBeDefined();

    // Both ways out are offered, and neither has been taken for them.
    expect(screen.getByRole('button', { name: /continue as Sahyadri Express/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /sign out and use another account/i })).toBeDefined();
    expect(screen.queryByText('the dashboard')).toBeNull();
  });

  it('does not switch company because a company id is in the address', async () => {
    fetchSession.mockResolvedValue(
      sessionFor('Sahyadri Express', 'partner-a', 'dispatch@sahyadri.example'),
    );

    renderPortal('/login?companyId=partner-b&company=XYZ%20Logistics');

    expect(await screen.findByText(/signed in as Sahyadri Express/i)).toBeDefined();
    expect(screen.queryByText(/XYZ Logistics/)).toBeNull();
  });

  it('shows the sign-in form once the person signs out', async () => {
    fetchSession.mockResolvedValue(
      sessionFor('Sahyadri Express', 'partner-a', 'dispatch@sahyadri.example'),
    );
    signOut.mockResolvedValue(undefined);

    renderPortal();

    const leave = await screen.findByRole('button', {
      name: /sign out and use another account/i,
    });

    leave.click();

    await waitFor(() => {
      expect(screen.queryByText(/signed in as Sahyadri Express/i)).toBeNull();
    });

    expect(signOut).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: /^sign in$/i })).toBeDefined();
  });
});

describe('opening the portal with nothing to go on', () => {
  it('offers a sign-in form and no company at all', async () => {
    fetchSession.mockRejectedValue(
      new ApiError(401, { code: 'UNAUTHENTICATED', message: 'Not signed in.' }),
    );

    renderPortal();

    expect(await screen.findByRole('button', { name: /^sign in$/i })).toBeDefined();

    // No fallback company anywhere - not the seed's, not anybody's.
    expect(screen.queryByText(/Meridian/i)).toBeNull();
    expect(screen.queryByText(/signed in as/i)).toBeNull();
  });

  it('says why when the boot request refuses rather than falling back', async () => {
    fetchSession.mockRejectedValue(
      new ApiError(403, {
        code: 'LOGISTICS_PARTNER_NOT_ACTIVE',
        message: 'This logistics account has not been activated by the marketplace yet.',
      }),
    );

    renderPortal();

    expect(await screen.findByText(/has not been activated by the marketplace/i)).toBeDefined();
    expect(screen.queryByText(/signed in as/i)).toBeNull();
  });

  it('shows a loading state instead of a company while the answer is in flight', async () => {
    let release: (session: PortalSession) => void = () => {};

    fetchSession.mockReturnValue(
      new Promise<PortalSession>((resolve) => {
        release = resolve;
      }),
    );

    renderPortal();

    // Neither a form to type a password into nor a company that has not been
    // confirmed yet.
    expect(screen.queryByRole('button', { name: /^sign in$/i })).toBeNull();
    expect(screen.queryByText(/signed in as/i)).toBeNull();
    expect(screen.getByRole('status')).toBeDefined();

    release(sessionFor('XYZ Logistics', 'partner-b', 'owner@xyz.example'));

    expect(await screen.findByText(/signed in as XYZ Logistics/i)).toBeDefined();
  });
});

describe('filling the form in again after the server refused the credentials', () => {
  beforeEach(() => {
    fetchSession.mockRejectedValue(
      new ApiError(401, { code: 'UNAUTHENTICATED', message: 'Not signed in.' }),
    );
    signIn.mockRejectedValue(
      new ApiError(401, {
        code: 'INVALID_CREDENTIALS',
        message: 'That email and password do not match.',
      }),
    );
  });

  /**
   * The reported bug, and the whole reason the fields are worth a test.
   *
   * Before the first submit, nothing on this screen re-renders while somebody
   * types. After it, every keystroke is re-validated, so the page renders
   * again on each one - and an inline callback ref is reattached by React on
   * every render. The email field's ref focused itself when it was attached,
   * which meant the second attempt threw the cursor out of whatever box the
   * person was typing in and back into the email box, mid-word.
   */
  async function refuseOneAttempt(): Promise<{
    email: HTMLElement;
    password: HTMLElement;
  }> {
    renderPortal();

    const email = await screen.findByLabelText('Work email');
    const password = screen.getByLabelText('Password');

    fireEvent.change(email, { target: { value: 'dispatch@sahyadri.example' } });
    fireEvent.change(password, { target: { value: 'not-the-password' } });
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    expect(await screen.findByText(/do not match/i)).toBeDefined();

    return { email, password };
  }

  it('leaves the cursor in the password box while it is being retyped', async () => {
    const { password } = await refuseOneAttempt();

    // The person clears the password to type it again. Emptying it is what
    // raises its own error, which is what renders the page a second time.
    password.focus();
    fireEvent.change(password, { target: { value: '' } });

    await waitFor(() => {
      expect(screen.getAllByRole('alert').length).toBeGreaterThan(1);
    });

    expect(document.activeElement).toBe(password);
  });

  it('keeps what is typed next in the box it was typed into', async () => {
    const { email, password } = await refuseOneAttempt();

    // Emptying the password raises its error; filling it in again clears it.
    // Both are renders, and it is the second one - the error going away - that
    // used to land the rest of the password in the email box.
    password.focus();
    fireEvent.change(password, { target: { value: '' } });

    await waitFor(() => {
      expect(screen.getAllByRole('alert').length).toBeGreaterThan(1);
    });

    password.focus();
    fireEvent.change(password, { target: { value: 'the-right-one' } });

    await waitFor(() => {
      expect(screen.getAllByRole('alert')).toHaveLength(1);
    });

    expect(document.activeElement).toBe(password);
    expect((email as HTMLInputElement).value).toBe('dispatch@sahyadri.example');
  });
});

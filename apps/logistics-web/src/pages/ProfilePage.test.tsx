/**
 * My Profile, rendered.
 *
 * What a person can see and do: the right company, the save bar only when
 * something changed, identity fields flagged as needing verification, a
 * read-only role seeing no controls, keyboard tabs, and a failed load that
 * can be retried. The server's own rules are covered by the backend suite;
 * this is about the screen telling the truth about them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import { profileFixture } from '@/lib/profile.fixture';
import type { LogisticsProfile } from '@/lib/profile';
import { ProfilePage } from './ProfilePage';

vi.mock('@/lib/profile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/profile')>();
  return {
    ...actual,
    fetchProfile: vi.fn(),
    saveProfile: vi.fn(),
    withdrawPendingChange: vi.fn(),
    uploadLogo: vi.fn(),
    removeLogo: vi.fn(),
    uploadComplianceDocument: vi.fn(),
    downloadComplianceDocument: vi.fn(),
  };
});

const profileApi = await import('@/lib/profile');
const fetchProfile = vi.mocked(profileApi.fetchProfile);
const saveProfile = vi.mocked(profileApi.saveProfile);

function session(): SessionState {
  return {
    stage: 'READY',
    session: {
      user: {
        id: 'u1',
        email: 'owner@alpha.test',
        fullName: 'Olive Owner',
        role: 'LOGISTICS_PARTNER_OWNER',
        permissions: ['logistics.organisation.read', 'logistics.organisation.write'],
        isDriver: false,
      },
      partner: {
        id: 'p1',
        code: 'LP-000123',
        displayName: 'Alpha Freight',
        status: 'ACTIVE',
        canAcceptNewWork: true,
      },
      mfa: { required: true, enrolled: true, sessionVerified: true, recoveryCodesRemaining: 8 },
    },
    notice: null,
    signIn: vi.fn(),
    signOut: vi.fn(),
    refresh: vi.fn(),
    can: () => true,
    canAny: () => true,
  };
}

function renderPage(entry = '/profile'): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: '/profile', element: <ProfilePage /> },
      { path: '/elsewhere', element: <p>Somewhere else</p> },
    ],
    { initialEntries: [entry] },
  );
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <SessionContext.Provider value={session()}>
          <ToastProvider>
            <RouterProvider router={router} />
          </ToastProvider>
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

describe('My Profile', () => {
  it('shows the signed-in company with its read-only partner ID', async () => {
    fetchProfile.mockResolvedValue(profileFixture());
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Alpha Freight' })).toBeTruthy();
    const hero = screen.getByRole('region', { name: 'Alpha Freight' });
    expect(within(hero).getByText('LP-000123')).toBeTruthy();
    expect(within(hero).getByRole('button', { name: 'Copy partner ID' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Profile 20% complete' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
  });

  it('moves between sections with the arrow keys, and deep-links to a tab', async () => {
    fetchProfile.mockResolvedValue(profileFixture());
    renderPage('/profile?tab=contacts');

    const contacts = await screen.findByRole('tab', { name: 'Authorised contacts' });
    expect(contacts.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(contacts, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Service coverage' }).getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Service coverage' }), { key: 'Home' });
    expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true');
  });

  it('shows the save bar only once something changed, and resets it', async () => {
    fetchProfile.mockResolvedValue(profileFixture());
    renderPage('/profile?tab=contacts');

    const support = await screen.findByLabelText('Support email');
    fireEvent.change(support, { target: { value: 'desk@alpha.test' } });

    const bar = screen.getByRole('region', { name: 'Unsaved changes' });
    expect(within(bar).getByText('Unsaved changes: 1')).toBeTruthy();

    fireEvent.click(within(bar).getByRole('button', { name: 'Discard changes' }));
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('Support email').value).toBe('');
  });

  it('refuses to send an invalid field and points at it', async () => {
    fetchProfile.mockResolvedValue(profileFixture());
    renderPage('/profile?tab=contacts');

    fireEvent.change(await screen.findByLabelText('Support email'), { target: { value: 'not-email' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Enter an email address, like name@company.com.')).toBeTruthy();
    expect(saveProfile).not.toHaveBeenCalled();
  });

  it('sends only the changed fields and says which go for verification', async () => {
    const profile = profileFixture();
    fetchProfile.mockResolvedValue(profile);
    saveProfile.mockResolvedValue({ profile, applied: [], submittedForReview: ['legalName'] });
    renderPage('/profile?tab=company');

    fireEvent.change(await screen.findByLabelText(/Legal company name/), {
      target: { value: 'Alpha Freight Group Ltd' },
    });
    expect(screen.getByText(/Checked before they change: Legal company name/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      expect(saveProfile).toHaveBeenCalledWith({ legalName: 'Alpha Freight Group Ltd' });
    });
  });

  it('gives a read-only role no way to edit', async () => {
    fetchProfile.mockResolvedValue(
      profileFixture({ editing: { canEdit: false, immediate: [], reverified: [] } }),
    );
    renderPage('/profile?tab=contacts');

    expect((await screen.findByLabelText<HTMLInputElement>('Support email')).disabled).toBe(true);
    expect(screen.getByText(/Only an owner or administrator/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add logo' })).toBeNull();
  });

  it('never calls an integration connected unless the server says so', async () => {
    fetchProfile.mockResolvedValue(profileFixture());
    renderPage('/profile?tab=integrations');

    expect(await screen.findByText('Credentials required')).toBeTruthy();
    expect(screen.getByText('Manual tracking')).toBeTruthy();
    expect(screen.queryByText('Connected')).toBeNull();
  });

  it('shows the pending change and what it would replace', async () => {
    const pending: LogisticsProfile['review'] = {
      pendingChange: {
        id: 'c1',
        state: 'PENDING',
        proposed: { taxNumber: 'IE999' },
        current: { taxNumber: null },
        requestedByLabel: 'Olive Owner',
        requestedAt: '2026-09-20T10:00:00.000Z',
        decidedAt: null,
        decisionNote: null,
      },
      lastDecision: null,
    };
    fetchProfile.mockResolvedValue(profileFixture({ review: pending }));
    renderPage();

    expect(await screen.findByText(/A change is waiting for/)).toBeTruthy();
    expect(screen.getByText('IE999')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Withdraw the request' })).toBeTruthy();
  });

  it('offers a retry when the profile cannot be loaded', async () => {
    // Twice: the page retries once by itself before it shows the error.
    fetchProfile
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(profileFixture());
    renderPage();

    const retry = await screen.findByRole('button', { name: /try again/i }, { timeout: 5000 });
    fireEvent.click(retry);
    expect(await screen.findByRole('heading', { name: 'Alpha Freight' })).toBeTruthy();
  });
});

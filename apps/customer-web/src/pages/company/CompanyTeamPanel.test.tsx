/**
 * A company's team and the join page (checklist Master rows 11 and 14).
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { CompanyTeamPanel } from './CompanyTeamPanel';
import { JoinCompanyPage } from './JoinCompanyPage';
import { jsonResponse, renderWithProviders } from '@/test/harness';

const fetchMock = vi.fn();
const COMPANY = '01COMPANY00000000000000001';

function team(overrides: Record<string, unknown> = {}) {
  return {
    companyStatus: 'APPROVED',
    yourRole: 'OWNER',
    manageBlocked: null,
    assignableRoles: ['COMPANY_ADMIN', 'BUYER', 'ORDER_APPROVER', 'FINANCE', 'VIEWER'],
    members: [
      { id: 'm1', name: 'Olga Owner', email: 'olga@acme.test', role: 'OWNER', joinedAt: '2026-09-01T00:00:00.000Z', isYou: true, canChange: false },
      { id: 'm2', name: 'Bea Buyer', email: 'bea@acme.test', role: 'BUYER', joinedAt: '2026-09-02T00:00:00.000Z', isYou: false, canChange: true },
    ],
    invitations: [
      { id: 'i1', email: 'carl@acme.test', role: 'FINANCE', expiresAt: '2026-10-09T00:00:00.000Z', expired: false, sendCount: 1, lastSentAt: '2026-10-02T00:00:00.000Z', canChange: true },
    ],
    ...overrides,
  };
}

function calls(fragment: string, method: string): [string, RequestInit][] {
  return fetchMock.mock.calls.filter(
    ([url, init]) => String(url).includes(fragment) && ((init as RequestInit | undefined)?.method ?? 'GET') === method,
  ) as [string, RequestInit][];
}
const bodyOf = (call: [string, RequestInit] | undefined): unknown => JSON.parse(typeof call?.[1].body === 'string' ? call[1].body : '{}');

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CompanyTeamPanel', () => {
  it('invites by email in a chosen role, and refuses an address that is not one before sending', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(team())));
    renderWithProviders(<CompanyTeamPanel companyId={COMPANY} />);

    const email = await screen.findByLabelText(/Email address/);
    await userEvent.type(email, 'not-an-email');
    await userEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByText(/Enter an email address/)).toBeInTheDocument();
    expect(calls('/invitations', 'POST')).toHaveLength(0);

    await userEvent.clear(email);
    await userEvent.type(email, 'dora@acme.test');
    await userEvent.selectOptions(screen.getByLabelText('Role'), 'ORDER_APPROVER');
    await userEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    await waitFor(() => {
      expect(bodyOf(calls(`/buyer-companies/${COMPANY}/invitations`, 'POST')[0])).toEqual({ email: 'dora@acme.test', role: 'ORDER_APPROVER' });
    });
  });

  it('changes a role, and removes only after the dialog is confirmed', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(team())));
    renderWithProviders(<CompanyTeamPanel companyId={COMPANY} />);

    await userEvent.selectOptions(await screen.findByLabelText('Role for Bea Buyer'), 'VIEWER');
    await waitFor(() => {
      expect(bodyOf(calls('/members/m2', 'PATCH')[0])).toEqual({ role: 'VIEWER' });
    });
    // The owner (and the caller) has no controls, only a badge.
    expect(screen.queryByLabelText('Role for Olga Owner')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Remove Bea Buyer' }));
    const dialog = await screen.findByRole('dialog');
    expect(calls('/members/m2', 'DELETE')).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => {
      expect(calls('/members/m2', 'DELETE')).toHaveLength(1);
    });
  });

  it('resends and withdraws an invitation, named for screen readers', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(team())));
    renderWithProviders(<CompanyTeamPanel companyId={COMPANY} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Resend the invitation to carl@acme.test' }));
    await waitFor(() => {
      expect(calls('/invitations/i1/resend', 'POST')).toHaveLength(1);
    });
    await userEvent.click(screen.getByRole('button', { name: 'Withdraw the invitation to carl@acme.test' }));
    await waitFor(() => {
      expect(calls('/invitations/i1', 'DELETE')).toHaveLength(1);
    });
  });

  it('shows a member without the right role the team only, and a pending company why it cannot be managed', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(team({ companyStatus: 'SUBMITTED', manageBlocked: 'NOT_APPROVED', assignableRoles: [], invitations: [], members: team().members.map((m) => ({ ...m, canChange: false })) }))),
    );
    renderWithProviders(<CompanyTeamPanel companyId={COMPANY} />);

    expect(await screen.findByText(/once the company is verified/)).toBeInTheDocument();
    expect(screen.getByText('Bea Buyer')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send invitation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument();
  });

  it('says which rule refused a change, and reloads the team', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        return Promise.resolve(
          jsonResponse({ error: { code: 'BUYER_COMPANY_MEMBER_PROTECTED', message: 'x', details: [{ code: 'ADMIN_NEEDS_OWNER' }] } }, 403),
        );
      }
      return Promise.resolve(jsonResponse(team()));
    });
    renderWithProviders(<CompanyTeamPanel companyId={COMPANY} />);

    await userEvent.selectOptions(await screen.findByLabelText('Role for Bea Buyer'), 'COMPANY_ADMIN');
    expect(await screen.findByText('Only the owner can give, change or remove the administrator role.')).toBeInTheDocument();
    await waitFor(() => {
      expect(calls('/team', 'GET').length).toBeGreaterThanOrEqual(2);
    });
  });
});

describe('JoinCompanyPage', () => {
  const TOKEN = 'a'.repeat(43);

  it('shows what the invitation is for, and joins only when Accept is pressed', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/invitations/preview')) {
        return Promise.resolve(jsonResponse({ companyName: 'Acme GmbH', role: 'FINANCE', expiresAt: '2026-10-09T00:00:00.000Z', inviterName: 'Olga Owner' }));
      }
      if (url.includes('/invitations/accept')) return Promise.resolve(jsonResponse({ companyId: COMPANY }));
      return Promise.resolve(jsonResponse({}));
    });
    renderWithProviders(
      <Routes>
        <Route path="/account/join-company" element={<JoinCompanyPage />} />
        <Route path="/account/companies/:id" element={<p>Company page</p>} />
      </Routes>,
      { route: `/account/join-company?token=${TOKEN}` },
    );

    expect(await screen.findByText(/Olga Owner has invited you to act for Acme GmbH/)).toBeInTheDocument();
    expect(screen.getByText(/Your role would be: Finance/)).toBeInTheDocument();
    expect(bodyOf(calls('/invitations/preview', 'POST')[0])).toEqual({ token: TOKEN });
    expect(calls('/invitations/accept', 'POST')).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: 'Accept and join' }));
    expect(await screen.findByText('Company page')).toBeInTheDocument();
    expect(calls('/invitations/accept', 'POST')).toHaveLength(1);
  });

  it('says plainly when the link cannot be used, and when there is no link at all', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse({ error: { code: 'BUYER_COMPANY_INVITATION_INVALID', message: 'x', details: [] } }, 400)),
    );
    const { unmount } = renderWithProviders(<JoinCompanyPage />, { route: `/account/join-company?token=${TOKEN}` });
    expect(await screen.findByText(/This invitation cannot be used. It may have expired/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept and join' })).not.toBeInTheDocument();
    unmount();

    renderWithProviders(<JoinCompanyPage />, { route: '/account/join-company' });
    expect(await screen.findByText(/opens from the link in an invitation email/)).toBeInTheDocument();
  });
});

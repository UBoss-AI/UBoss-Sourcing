/**
 * The Seller Hub's team page and the join page (checklist Master row 14).
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { SellerTeamPage } from './SellerTeamPage';
import { JoinSellerPage } from './JoinSellerPage';
import { jsonResponse, renderWithProviders } from '@/test/harness';

const fetchMock = vi.fn();

function team(overrides: Record<string, unknown> = {}) {
  return {
    yourRole: 'OWNER',
    canManage: true,
    assignableRoles: ['OWNER', 'ADMIN', 'CATALOGUE_MANAGER', 'INVENTORY_MANAGER', 'ORDER_MANAGER', 'FINANCE_VIEWER', 'SUPPORT_MEMBER'],
    invitableRoles: ['ADMIN', 'CATALOGUE_MANAGER', 'INVENTORY_MANAGER', 'ORDER_MANAGER', 'FINANCE_VIEWER', 'SUPPORT_MEMBER'],
    members: [
      {
        id: 'm1',
        name: 'Olive Owner',
        email: 'olive@acme.test',
        role: 'OWNER',
        joinedAt: '2026-09-01T00:00:00.000Z',
        isYou: true,
        canChange: false,
        invitedByName: null,
        lastSignInAt: '2026-09-28T00:00:00.000Z',
        lastActiveAt: '2026-09-28T00:00:00.000Z',
        lastHubActivityAt: '2026-09-28T00:00:00.000Z',
      },
      {
        id: 'm2',
        name: 'Sam Support',
        email: 'sam@acme.test',
        role: 'SUPPORT_MEMBER',
        joinedAt: '2026-09-02T00:00:00.000Z',
        isYou: false,
        canChange: true,
        invitedByName: 'Olive Owner',
        lastSignInAt: null,
        lastActiveAt: null,
        lastHubActivityAt: null,
      },
    ],
    invitations: [
      {
        id: 'i1',
        email: 'ivy@acme.test',
        role: 'ORDER_MANAGER',
        expiresAt: '2026-10-06T00:00:00.000Z',
        expired: false,
        sendCount: 2,
        lastSentAt: '2026-09-29T00:00:00.000Z',
        invitedByName: 'Olive Owner',
        canChange: true,
      },
    ],
    accessReview: {
      reviews: [{ id: 'r1', reviewedAt: '2026-06-01T00:00:00.000Z', reviewedByName: 'Olive Owner', memberCount: 2, invitationCount: 0 }],
      intervalDays: 90,
      dueAt: '2026-08-30T00:00:00.000Z',
      due: true,
    },
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

describe('SellerTeamPage', () => {
  it('shows each person’s role, who invited them and when they last used the account', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(team())));
    renderWithProviders(<SellerTeamPage />);

    expect(await screen.findByText('Sam Support')).toBeInTheDocument();
    expect(screen.getByText(/opened the account/)).toBeInTheDocument();
    expect(screen.getByText(/invited by Olive Owner/)).toBeInTheDocument();
    expect(screen.getByText(/Last signed in: never/)).toBeInTheDocument();
    expect(screen.getByText('Review due')).toBeInTheDocument();
    expect(screen.getByText(/Last reviewed on .* by Olive Owner/)).toBeInTheDocument();
    // The owner row is the caller's own: a badge, no controls.
    expect(screen.queryByLabelText('Role for Olive Owner')).not.toBeInTheDocument();
    // Invitation roles never include the owner.
    const inviteRole = screen.getByLabelText('Role');
    expect(within(inviteRole).queryByRole('option', { name: 'Owner' })).not.toBeInTheDocument();
  });

  it('invites by email, refusing an address that is not one before sending', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(team())));
    renderWithProviders(<SellerTeamPage />);

    const email = await screen.findByLabelText(/Email address/);
    await userEvent.type(email, 'nope');
    await userEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByText(/Enter an email address/)).toBeInTheDocument();
    expect(calls('/seller/invitations', 'POST')).toHaveLength(0);

    await userEvent.clear(email);
    await userEvent.type(email, 'fin@acme.test');
    await userEvent.selectOptions(screen.getByLabelText('Role'), 'FINANCE_VIEWER');
    await userEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    await waitFor(() => {
      expect(bodyOf(calls('/seller/invitations', 'POST')[0])).toEqual({ email: 'fin@acme.test', role: 'FINANCE_VIEWER' });
    });
  });

  it('changes a role, removes only after confirming, and resends, withdraws and records a review', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(init?.method === 'PATCH' || init?.method === 'DELETE' && _url.includes('/members/') ? new Response(null, { status: 204 }) : jsonResponse(team())),
    );
    renderWithProviders(<SellerTeamPage />);

    await userEvent.selectOptions(await screen.findByLabelText('Role for Sam Support'), 'ORDER_MANAGER');
    await waitFor(() => {
      expect(bodyOf(calls('/seller/members/m2', 'PATCH')[0])).toEqual({ role: 'ORDER_MANAGER' });
    });

    await userEvent.click(screen.getByRole('button', { name: 'Remove Sam Support' }));
    const dialog = await screen.findByRole('dialog');
    expect(calls('/seller/members/m2', 'DELETE')).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => {
      expect(calls('/seller/members/m2', 'DELETE')).toHaveLength(1);
    });

    await userEvent.click(screen.getByRole('button', { name: 'Resend the invitation to ivy@acme.test' }));
    await waitFor(() => {
      expect(calls('/seller/invitations/i1/resend', 'POST')).toHaveLength(1);
    });
    await userEvent.click(screen.getByRole('button', { name: 'Withdraw the invitation to ivy@acme.test' }));
    await waitFor(() => {
      expect(calls('/seller/invitations/i1', 'DELETE')).toHaveLength(1);
    });
    await userEvent.click(screen.getByRole('button', { name: 'I have reviewed this team' }));
    await waitFor(() => {
      expect(calls('/seller/access-reviews', 'POST')).toHaveLength(1);
    });
  });

  it('says which rule protects a member', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === 'PATCH'
          ? jsonResponse({ error: { code: 'SELLER_MEMBER_PROTECTED', message: 'x', details: [{ code: 'ROLE_ABOVE_YOURS' }] } }, 403)
          : jsonResponse(team()),
      ),
    );
    renderWithProviders(<SellerTeamPage />);

    await userEvent.selectOptions(await screen.findByLabelText('Role for Sam Support'), 'ADMIN');
    expect(await screen.findByText('That person holds permissions you do not, so you cannot change or remove them.')).toBeInTheDocument();
  });
});

describe('JoinSellerPage', () => {
  const TOKEN = 'b'.repeat(43);

  it('shows what the invitation is for, and joins only when Accept is pressed', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/sellers/invitations/preview')) {
        return Promise.resolve(jsonResponse({ sellerName: 'Acme Supplies', role: 'ORDER_MANAGER', expiresAt: '2026-10-06T00:00:00.000Z', inviterName: 'Olive Owner' }));
      }
      if (url.includes('/sellers/invitations/accept')) return Promise.resolve(jsonResponse({ sellerAccountId: '01SELLER000000000000000001' }));
      return Promise.resolve(jsonResponse({}));
    });
    renderWithProviders(
      <Routes>
        <Route path="/account/join-seller" element={<JoinSellerPage />} />
        <Route path="/seller/dashboard" element={<p>Seller Hub</p>} />
      </Routes>,
      { route: `/account/join-seller?token=${TOKEN}` },
    );

    expect(await screen.findByText(/Olive Owner has invited you to help run Acme Supplies/)).toBeInTheDocument();
    expect(screen.getByText(/Your role would be: Order manager/)).toBeInTheDocument();
    expect(bodyOf(calls('/sellers/invitations/preview', 'POST')[0])).toEqual({ token: TOKEN });
    expect(calls('/sellers/invitations/accept', 'POST')).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: 'Accept and join' }));
    expect(await screen.findByText('Seller Hub')).toBeInTheDocument();
    expect(calls('/sellers/invitations/accept', 'POST')).toHaveLength(1);
  });

  it('says plainly when the link cannot be used', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse({ error: { code: 'SELLER_INVITATION_INVALID', message: 'x', details: [] } }, 400)),
    );
    renderWithProviders(<JoinSellerPage />, { route: `/account/join-seller?token=${TOKEN}` });
    expect(await screen.findByText(/This invitation cannot be used. It may have expired/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept and join' })).not.toBeInTheDocument();
  });
});

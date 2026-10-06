/**
 * Audit Console access.
 *
 *   - who can sign in, and how: console account or an old storefront login,
 *     activated or not, two-step sign-in set up or not;
 *   - inviting sends the right target with an idempotency key;
 *   - an address that belongs to another account is explained on the field;
 *   - an agency member on an old storefront login is offered the move;
 *   - a rule the admin drafted is refused with a plain sentence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import { ApiError, api } from '@/lib/api';
import type { ConsolePerson } from '@/lib/audit-console';
import { AuditConsoleAccessPage } from './AuditConsoleAccessPage';

vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, get: vi.fn(), post: vi.fn(), patch: vi.fn() } };
});

const agencyMember: ConsolePerson = {
  memberId: 'M1', userId: 'U1', kind: 'AGENCY', fullName: 'Ines Inspector', email: 'ines@agency.test', role: 'INSPECTOR', status: 'ACTIVE',
  agency: { id: 'A1', name: 'QA Ltd' }, accountType: 'CUSTOMER', activated: true, mfaEnrolled: false, identityVerified: true, credentialExpiresAt: null, competenceCategoryIds: [],
};
const staff: ConsolePerson = {
  memberId: 'M2', userId: 'U2', kind: 'STAFF', fullName: 'Sam Supervisor', email: 'sam@market.test', role: 'SUPERVISOR', status: 'INVITED',
  agency: null, accountType: 'AUDIT', activated: false, mfaEnrolled: false, identityVerified: null, credentialExpiresAt: null, competenceCategoryIds: [],
};

function show(): void {
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
        <ToastProvider>
          <MemoryRouter>
            <AuditConsoleAccessPage />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  vi.clearAllMocks();
  vi.mocked(api.get).mockImplementation((path: string) => {
    if (path.endsWith('/agencies')) return Promise.resolve({ agencies: [{ id: 'A1', name: 'QA Ltd' }] });
    if (path.endsWith('/rules')) {
      return Promise.resolve({
        rules: [{ id: 'R1', code: 'CE-TOYS', ruleVersion: 2, status: 'IN_REVIEW', name: 'Toy safety', description: 'CE marking', obligation: 'LEGAL', level: 'PRODUCT', applicability: 'APPLIES', categoryIds: [], draftedByLabel: 'me@market.test', submittedAt: null, decidedByLabel: null, decidedAt: null, sourceTitle: null, sourceUrl: null }],
        coverage: [{ categoryId: 'C1', name: 'Toys', slug: 'toys', depth: 0, parentId: null, products: 3, approved: 0, approvedMandatory: 0, awaitingApproval: 1, unresolved: 0, conditional: 0, needsReview: true }],
      });
    }
    return Promise.resolve({ people: [agencyMember, staff] });
  });
  vi.mocked(api.post).mockResolvedValue({ userId: 'U9', memberId: 'M9', expiresAt: '2026-10-09T10:00:00Z' });
});
afterEach(() => {
  cleanup();
});

describe('Audit Console access', () => {
  it('shows how each person signs in', async () => {
    show();
    expect(await screen.findByText('Ines Inspector')).toBeInTheDocument();
    expect(screen.getByText(/old storefront login/)).toBeInTheDocument();
    expect(screen.getAllByText(/two-step sign-in not set up/)).toHaveLength(2);
    expect(screen.getByText(/not activated yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resend activation link' })).toBeInTheDocument();
  });

  it('invites an agency inspector with an idempotency key', async () => {
    show();
    await screen.findByText('Ines Inspector');
    fireEvent.change(screen.getByLabelText('Work email'), { target: { value: 'new@agency.test' } });
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Nina New' } });
    fireEvent.change(screen.getByLabelText('Agency'), { target: { value: 'A1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith(
        '/admin/audit-console/invitations',
        { email: 'new@agency.test', fullName: 'Nina New', target: { kind: 'AGENCY', agencyId: 'A1', role: 'INSPECTOR', jobTitle: null } },
        expect.objectContaining({ idempotencyKey: expect.any(String) as string }),
      );
    });
  });

  it('explains that console users need their own work address', async () => {
    vi.mocked(api.post).mockRejectedValue(new ApiError(409, { code: 'CONFLICT', message: 'x', details: [{ field: 'email', code: 'EMAIL_IN_USE' }] }));
    show();
    await screen.findByText('Ines Inspector');
    fireEvent.change(screen.getByLabelText('Works for'), { target: { value: 'STAFF' } });
    fireEvent.change(screen.getByLabelText('Work email'), { target: { value: 'shopper@example.test' } });
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Sara Staff' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Audit Console users need a work address of their own');
    expect(vi.mocked(api.post).mock.calls[0]?.[1]).toMatchObject({ target: { kind: 'STAFF', role: 'COMPLIANCE_REVIEWER' } });
  });

  it('moves an agency member off an old storefront login', async () => {
    show();
    await screen.findByText('Ines Inspector');
    fireEvent.change(screen.getByLabelText('New work email for Ines Inspector'), { target: { value: 'ines@qa-ltd.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move and send activation link' }));
    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/admin/inspection/members/M1/move-to-console', { email: 'ines@qa-ltd.test' }, expect.objectContaining({ idempotencyKey: expect.any(String) as string }));
    });
  });

  it('refuses a rule the admin drafted, in plain words', async () => {
    vi.mocked(api.post).mockRejectedValue(new ApiError(409, { code: 'COMPLIANCE_RULE_TRANSITION_NOT_ALLOWED', message: 'x', details: [{ code: 'SAME_PERSON' }] }));
    show();
    fireEvent.click(await screen.findByRole('tab', { name: 'Compliance rules' }));
    expect(await screen.findByText('Needs review')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Decision note for CE-TOYS'), { target: { value: 'Checked the directive text.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve rule' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('somebody else must approve or reject it');
  });
});

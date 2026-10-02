/**
 * Staff access review panel (LIVE-015).
 *
 *   - each account shows its roles, two-factor state, last sign-in and a
 *     dormant flag, with the latest decision;
 *   - the owner's own row has no button (the server refuses a self-review);
 *   - reducing or revoking needs a note, and the decision is posted;
 *   - a failed load shows the error state with a retry.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import { StaffAccessReviewPanel, type StaffAccessReviewData } from './StaffAccessReviewPanel';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, get: vi.fn(), post: vi.fn() } };
});

const { api, ApiError } = await import('@/lib/api');
const get = vi.mocked(api.get);
const post = vi.mocked(api.post);

const dialogProto = HTMLDialogElement.prototype as HTMLDialogElement & { showModal?: () => void; close?: () => void };
if (typeof dialogProto.showModal !== 'function') {
  dialogProto.showModal = function showModal(this: HTMLDialogElement): void {
    this.open = true;
  };
}
if (typeof dialogProto.close !== 'function') {
  dialogProto.close = function close(this: HTMLDialogElement): void {
    this.open = false;
  };
}

const DATA: StaffAccessReviewData = {
  dormantAfterDays: 90,
  generatedAt: '2026-10-02T10:00:00.000Z',
  summary: { accounts: 3, withoutMfa: 2, dormant: 1, neverReviewed: 2 },
  accounts: [
    {
      id: '01OWNER0000000000000000001',
      email: 'owner@example.test',
      status: 'ACTIVE',
      deactivated: false,
      roles: [{ key: 'business_owner', name: 'Business Owner / Super Admin' }],
      mfaEnabled: true,
      lastSignInAt: '2026-10-02T09:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      dormant: false,
      isSelf: true,
      latestDecision: null,
    },
    {
      id: '01DESK00000000000000000001',
      email: 'desk@example.test',
      status: 'ACTIVE',
      deactivated: false,
      roles: [{ key: 'order_manager', name: 'Order Manager' }],
      mfaEnabled: false,
      lastSignInAt: '2026-09-30T09:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      dormant: false,
      isSelf: false,
      latestDecision: {
        decision: 'KEEP',
        note: null,
        reviewedAt: '2026-09-01T00:00:00.000Z',
        reviewerEmail: 'owner@example.test',
      },
    },
    {
      id: '01SUPPORT00000000000000001',
      email: 'old.support@example.test',
      status: 'ACTIVE',
      deactivated: false,
      roles: [{ key: 'support_agent', name: 'Support Agent' }],
      mfaEnabled: false,
      lastSignInAt: '2026-01-15T09:00:00.000Z',
      createdAt: '2025-06-01T00:00:00.000Z',
      dormant: true,
      isSelf: false,
      latestDecision: null,
    },
  ],
};

function renderPanel(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <StaffAccessReviewPanel />
        </ToastProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

afterEach(() => {
  cleanup();
  get.mockReset();
  post.mockReset();
});

describe('StaffAccessReviewPanel', () => {
  it('lists accounts with two-factor, last sign-in, dormant flag and the latest decision', async () => {
    get.mockResolvedValue(DATA);
    renderPanel();

    const supportRow = (await screen.findByText('old.support@example.test', { selector: 'span.font-medium' })).closest('tr');
    expect(supportRow).not.toBeNull();
    expect(within(supportRow as HTMLElement).getAllByText('Dormant').length).toBeGreaterThan(0);
    expect(within(supportRow as HTMLElement).getByText('Not reviewed yet')).toBeInTheDocument();

    const deskRow = screen.getByText('desk@example.test', { selector: 'span.font-medium' }).closest('tr') as HTMLElement;
    expect(within(deskRow).getByText('Keep access')).toBeInTheDocument();

    // The owner's own row offers no decision.
    const ownRow = screen.getByText('owner@example.test', { selector: 'span.font-medium' }).closest('tr') as HTMLElement;
    expect(within(ownRow).queryByRole('button')).toBeNull();
    expect(within(ownRow).getByText('Your own account is reviewed by another owner')).toBeInTheDocument();

    expect(screen.getByText('An account counts as dormant once it has gone 90 days without signing in.')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/admin/staff/access-review');
  });

  it('needs a note to revoke, then posts the decision', async () => {
    get.mockResolvedValue(DATA);
    post.mockResolvedValue({ id: '01REVIEW000000000000000001', reviewedAt: '2026-10-02T10:01:00.000Z' });
    renderPanel();

    const supportRow = (await screen.findByText('old.support@example.test', { selector: 'span.font-medium' })).closest('tr') as HTMLElement;
    fireEvent.click(within(supportRow).getByRole('button', { name: /record decision/i }));

    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/decision/i), { target: { value: 'REVOKE' } });
    const save = within(dialog).getByRole('button', { name: 'Save decision' });
    expect(save).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText(/note/i), { target: { value: 'Left in January.' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith('/admin/staff/01SUPPORT00000000000000001/access-reviews', {
        decision: 'REVOKE',
        note: 'Left in January.',
      });
    });
  });

  it('shows an error with a retry when the review cannot be loaded', async () => {
    get.mockRejectedValue(new ApiError(403, { code: 'PERMISSION_DENIED', message: 'Only a Business Owner can review staff access.' }));
    renderPanel();
    expect(await screen.findByText('Only a Business Owner can review staff access.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again|retry/i })).toBeInTheDocument();
  });
});

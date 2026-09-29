/**
 * Blocking a seller's listing from the seller page (checklist SCREEN-067).
 *
 *   - staff who may only read see the listings but no Block or Lift button;
 *   - Block asks for a reason and sends nothing without one;
 *   - a reason is sent to the block route;
 *   - a blocked listing shows its reason and offers Lift block, not Block;
 *   - an archived listing offers neither;
 *   - a refusal from the server is shown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import { SellerOffersPanel, type AdminOfferRow } from './SellerOffersPanel';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, get: vi.fn(), post: vi.fn() } };
});

const { api, ApiError } = await import('@/lib/api');
const get = vi.mocked(api.get);
const post = vi.mocked(api.post);

// jsdom has no <dialog> methods. The smallest stand-in: toggle `open`, which
// is all the Modal observes.
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

const SELLER = '01SELLER000000000000000001';

function offer(overrides: Partial<AdminOfferRow> = {}): AdminOfferRow {
  return {
    id: '01OFFER0000000000000000001',
    sellerSku: 'VALVE-001',
    productName: 'Valve body',
    status: 'ACTIVE',
    statusReason: null,
    blockedReason: null,
    blockedAt: null,
    priceMinor: '12000',
    currency: 'INR',
    updatedAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  };
}

function renderPanel(permissions: string[]): void {
  const session = {
    user: { id: 'u1', email: 'reviewer@example.test' },
    isLoading: false,
    can: (permission: string) => permissions.includes(permission),
    canAny: (...wanted: string[]) => wanted.some((permission) => permissions.includes(permission)),
  } as unknown as SessionState;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <SessionContext.Provider value={session}>
            <SellerOffersPanel sellerId={SELLER} />
          </SessionContext.Provider>
        </ToastProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  get.mockReset();
  post.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('SellerOffersPanel', () => {
  it('shows staff who may only read the listings, with no moderation buttons', async () => {
    get.mockResolvedValue({ rows: [offer()], total: 1 });
    renderPanel(['product.read']);
    expect(await screen.findByText('Valve body')).toBeTruthy();
    expect(screen.getByText('On sale')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Block' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Lift block' })).toBeNull();
  });

  it('does not send a block without a reason', async () => {
    get.mockResolvedValue({ rows: [offer()], total: 1 });
    renderPanel(['product.read', 'product.publish']);
    fireEvent.click(await screen.findByRole('button', { name: 'Block' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Block this listing' }));
    expect(await screen.findByText(/Say why, in at least five characters/)).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it('sends the reason to the block route', async () => {
    get.mockResolvedValue({ rows: [offer()], total: 1 });
    post.mockResolvedValue({ id: '01OFFER0000000000000000001', status: 'BLOCKED' });
    renderPanel(['product.read', 'product.publish']);
    fireEvent.click(await screen.findByRole('button', { name: 'Block' }));
    fireEvent.change(await screen.findByLabelText(/Reason/), {
      target: { value: 'Safety alert: batch recalled.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Block this listing' }));
    await waitFor(() => {
      expect(post).toHaveBeenCalledWith('/admin/seller-offers/01OFFER0000000000000000001/block', {
        reason: 'Safety alert: batch recalled.',
      });
    });
  });

  it('shows a blocked listing with its reason and offers to lift the block', async () => {
    get.mockResolvedValue({
      rows: [offer({ status: 'BLOCKED', blockedReason: 'Counterfeit report.' })],
      total: 1,
    });
    post.mockResolvedValue({ id: '01OFFER0000000000000000001', status: 'PAUSED' });
    renderPanel(['product.read', 'product.publish']);
    expect(await screen.findByText(/Blocked: Counterfeit report\./)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Block' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Lift block' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Lift the block' }));
    await waitFor(() => {
      expect(post).toHaveBeenCalledWith('/admin/seller-offers/01OFFER0000000000000000001/unblock', {});
    });
  });

  it('offers no moderation on an archived listing', async () => {
    get.mockResolvedValue({ rows: [offer({ status: 'ARCHIVED' })], total: 1 });
    renderPanel(['product.read', 'product.publish']);
    expect(await screen.findByText('Archived')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Block' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Lift block' })).toBeNull();
  });

  it('shows the server refusal when the block is refused', async () => {
    get.mockResolvedValue({ rows: [offer()], total: 1 });
    post.mockRejectedValue(
      new ApiError(409, { code: 'LISTING_TRANSITION_NOT_ALLOWED', message: 'This listing is already blocked.', details: [] }),
    );
    renderPanel(['product.read', 'product.publish']);
    fireEvent.click(await screen.findByRole('button', { name: 'Block' }));
    fireEvent.change(await screen.findByLabelText(/Reason/), { target: { value: 'Recall notice.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Block this listing' }));
    expect(await screen.findByText('This listing is already blocked.')).toBeTruthy();
  });
});

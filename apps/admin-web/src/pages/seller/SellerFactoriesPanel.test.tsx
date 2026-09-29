/**
 * Factories and certificates on the seller page (checklist Master row 13).
 *
 *   - a reader sees the factory, its evidence and history, but no decisions;
 *   - a reviewer's verification names the check they were looking at;
 *   - a refusal without a reason is not sent;
 *   - a stale decision says so and reloads the panel;
 *   - a failed load offers a retry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import { SellerFactoriesPanel, type ReviewFactory } from './SellerFactoriesPanel';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, get: vi.fn(), post: vi.fn() } };
});

const { api, ApiError } = await import('@/lib/api');
const get = vi.mocked(api.get);
const post = vi.mocked(api.post);

const CHECK = '01CHECK0000000000000000001';

function factory(overrides: Partial<ReviewFactory> = {}): ReviewFactory {
  return {
    id: '01FACTORY00000000000000001',
    name: 'Pune plant',
    addressLine1: '12 MIDC Industrial Area',
    addressLine2: null,
    city: 'Pune',
    region: 'Maharashtra',
    postcode: '411019',
    countryCode: 'IN',
    latitude: 18.52,
    longitude: 73.85,
    establishedYear: 2008,
    floorAreaSqm: 4200,
    workforceCount: 140,
    qcStaffCount: 12,
    monthlyCapacity: 50000,
    capacityUnit: 'pieces',
    productsMade: 'Valves',
    qcProcess: 'Sampling',
    machines: [{ id: 'm1', name: 'CNC lathe', quantity: 6, capacityNote: null }],
    evidence: [
      {
        id: 'e1',
        documentId: '01DOCUMENT0000000000000001',
        caption: 'Front gate',
        capturedLatitude: null,
        capturedLongitude: null,
        document: { originalFileName: 'plant-photo.pdf', kind: 'OTHER', scanState: 'CLEAN', status: 'PENDING', isReplaced: false },
      },
    ],
    verification: { status: 'PENDING', checkId: CHECK, reason: null, validUntil: null },
    history: [
      { id: 'h1', state: 'PENDING', at: '2026-09-10T00:00:00.000Z', reason: null, validUntil: null, internalNote: null, decidedBy: null },
    ],
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
            <SellerFactoriesPanel sellerId="01SELLER000000000000000001" />
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

describe('SellerFactoriesPanel', () => {
  it('shows a reader the factory, evidence and history, with no decisions', async () => {
    get.mockResolvedValue({ factories: [factory()], certifications: [], reverificationDays: 365 });
    renderPanel(['customer.read']);
    expect(await screen.findByText('Pune plant')).toBeTruthy();
    expect(screen.getByText('plant-photo.pdf')).toBeTruthy();
    expect(screen.getByText('Waiting for review')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Verify' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Refuse' })).toBeNull();
  });

  it('verifies, naming the check the reviewer was looking at', async () => {
    get.mockResolvedValue({ factories: [factory()], certifications: [], reverificationDays: 365 });
    post.mockResolvedValue({ factory: factory() });
    renderPanel(['customer.read', 'customer.status.write']);
    fireEvent.click(await screen.findByRole('button', { name: 'Verify' }));
    await waitFor(() => {
      expect(post).toHaveBeenCalledWith('/admin/seller-factories/01FACTORY00000000000000001/decision', {
        decision: 'VERIFIED',
        reason: null,
        internalNote: null,
        validUntil: null,
        expectedCheckId: CHECK,
      });
    });
  });

  it('does not send a refusal without a reason', async () => {
    get.mockResolvedValue({ factories: [factory()], certifications: [], reverificationDays: 365 });
    renderPanel(['customer.read', 'customer.status.write']);
    fireEvent.click(await screen.findByRole('button', { name: 'Refuse' }));
    expect(await screen.findByText(/Say why, in at least a few words/)).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it('says so when a colleague decided first', async () => {
    get.mockResolvedValue({ factories: [factory()], certifications: [], reverificationDays: 365 });
    post.mockRejectedValue(
      new ApiError(409, { code: 'FACTORY_TRANSITION_INVALID', message: 'stale', details: [{ code: 'STALE' }] }),
    );
    renderPanel(['customer.read', 'customer.status.write']);
    fireEvent.click(await screen.findByRole('button', { name: 'Verify' }));
    expect(await screen.findByText(/Someone decided this/)).toBeTruthy();
    await waitFor(() => {
      expect(get.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('cannot verify a factory with no evidence', async () => {
    get.mockResolvedValue({ factories: [factory({ evidence: [] })], certifications: [], reverificationDays: 365 });
    renderPanel(['customer.read', 'customer.status.write']);
    expect(await screen.findByRole('button', { name: 'Verify' })).toHaveProperty('disabled', true);
    expect(screen.getByText(/can only be refused/)).toBeTruthy();
  });

  it('offers a retry when it cannot load', async () => {
    get.mockRejectedValueOnce(new Error('down'));
    get.mockResolvedValueOnce({ factories: [], certifications: [], reverificationDays: 365 });
    renderPanel(['customer.read']);
    fireEvent.click(await screen.findByRole('button', { name: /try again/i }));
    expect(await screen.findByText('This supplier has not recorded a factory.')).toBeTruthy();
  });
});

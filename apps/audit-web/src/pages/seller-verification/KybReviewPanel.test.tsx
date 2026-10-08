/**
 * Ownership and screening on the Audit Team's seller verification page
 * (checklist Master row 12). The Audit Team owns seller verification, so the
 * screening form lives here; the Admin Panel's copy is read-only.
 *
 *   - the panel lists what the approval gate is still waiting for;
 *   - a screening is always presented as a person's check, never automated;
 *   - a reader without audit.seller.verify sees results but cannot record;
 *   - recording sends the result, the lists checked and the subject;
 *   - a category blocked by a market rule says so, with the rule's reason.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import type { SellerKybReview } from '@/lib/seller-verification';
import { KybReviewPanel } from './KybReviewPanel';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, get: vi.fn(), post: vi.fn() } };
});

const { api } = await import('@/lib/api');
const post = vi.mocked(api.post);

const OWNER_ID = '01K6OWNER00000000000000001';

function review(overrides: Partial<SellerKybReview> = {}): SellerKybReview {
  return {
    isIndia: true,
    policy: { beneficialOwnersRequired: true },
    registrationNumberName: 'CIN',
    legalForm: 'PRIVATE_LIMITED_COMPANY',
    udyamNumber: 'UDYAM-MH-01-0000001',
    iecNumber: null,
    exportCapable: true,
    exportMarkets: ['DE', 'AE'],
    yearsExporting: 4,
    intendedCategories: [
      { id: 'cat1', name: 'Surgical gloves', blockedIn: [{ countryCode: 'DE', reason: 'Not sold into Germany.' }] },
    ],
    beneficialOwners: [
      {
        id: OWNER_ID,
        fullName: 'Asha Rao',
        nationality: 'IN',
        ownershipBasisPoints: 7550,
        role: 'Director',
        isControllingPerson: true,
        isPoliticallyExposed: true,
        screening: null,
      },
    ],
    ownershipTotalBasisPoints: 7550,
    outstanding: [],
    signals: ['GSTIN_PAN_MISMATCH'],
    screening: {
      required: true,
      provider: 'manual',
      automatedProviderConfigured: false,
      entity: {
        id: 's1',
        subjectType: 'ENTITY',
        beneficialOwnerId: null,
        subjectName: 'Rao Surgical Private Limited',
        provider: 'manual',
        automated: false,
        state: 'CLEAR',
        listsChecked: 'UN list; OFAC SDN',
        note: null,
        reviewedAt: '2026-09-29T10:00:00.000Z',
        reviewedBy: 'reviewer@example.test',
        isCurrent: true,
      },
      history: [],
    },
    readiness: {
      ready: false,
      missing: [
        { code: 'SCREENING_REQUIRED', field: OWNER_ID, meta: { name: 'Asha Rao' } },
        { code: 'DOCUMENT_NOT_APPROVED', field: 'gst_certificate', message: 'GST certificate has not been accepted.' },
      ],
    },
    ...overrides,
  };
}

function renderPanel(kyb: SellerKybReview, permissions: string[]): void {
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
            <KybReviewPanel sellerAccountId="01SELLER000000000000000001" legalName="Rao Surgical Private Limited" kyb={kyb} />
          </SessionContext.Provider>
        </ToastProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  post.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('SellerKybReviewPanel', () => {
  it('lists what approval is still waiting for', () => {
    renderPanel(review(), ['customer.read']);

    expect(screen.getByText('No current screening of Asha Rao')).toBeTruthy();
    expect(screen.getByText(/A required document has not been accepted/)).toBeTruthy();
    expect(screen.getByText(/GST certificate has not been accepted/)).toBeTruthy();
  });

  it('never presents a screening as automated', () => {
    renderPanel(review(), ['customer.read']);

    expect(screen.getByText('Screening here is done by a person')).toBeTruthy();
    expect(screen.getByText(/No automated screening provider is connected/)).toBeTruthy();
    expect(screen.getByText(/Manual check by reviewer@example.test/)).toBeTruthy();
    expect(screen.queryByText(/automatically screened|automated check/i)).toBeNull();
  });

  it('shows the seller’s declarations and the reviewer signals', () => {
    renderPanel(review(), ['customer.read']);

    expect(screen.getByText('Private limited company')).toBeTruthy();
    expect(screen.getByText('UDYAM-MH-01-0000001')).toBeTruthy();
    expect(screen.getByText('The GSTIN was issued to a different PAN than the one given.')).toBeTruthy();
    expect(screen.getByText('Blocked for DE by a market rule: Not sold into Germany.')).toBeTruthy();
    expect(screen.getByText('Declared by the seller as a politically exposed person')).toBeTruthy();
    expect(screen.getByText('Declared ownership adds up to 75.50%.')).toBeTruthy();
  });

  it('lets a reader see results but not record one', () => {
    renderPanel(review(), ['audit.seller.read']);
    expect(screen.queryByRole('button', { name: 'Record a screening' })).toBeNull();
  });

  it('records a screening of an owner, and insists on the lists checked', async () => {
    post.mockResolvedValue({});
    renderPanel(review(), ['audit.seller.read', 'audit.seller.verify']);

    const buttons = screen.getAllByRole('button', { name: 'Record a screening' });
    const ownerButton = buttons[1];
    if (ownerButton === undefined) throw new Error('no owner button');
    fireEvent.click(ownerButton);

    fireEvent.change(screen.getByLabelText(/Result/), { target: { value: 'POTENTIAL_MATCH' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save screening' }));
    expect(await screen.findByText('Say which lists you checked.')).toBeTruthy();
    expect(post).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/Lists checked/), { target: { value: 'UN list; EU list' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save screening' }));

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith(
        '/audit/seller-verification/01SELLER000000000000000001/screening',
        {
          subjectType: 'BENEFICIAL_OWNER',
          beneficialOwnerId: OWNER_ID,
          result: 'POTENTIAL_MATCH',
          listsChecked: 'UN list; EU list',
          note: null,
        },
        expect.objectContaining({ idempotencyKey: expect.any(String) as unknown }),
      );
    });
  });

  it('says so when the evidence is complete', () => {
    renderPanel(review({ readiness: { ready: true, missing: [] } }), ['customer.read']);
    expect(screen.getByText('The evidence approval needs is in place')).toBeTruthy();
  });
});

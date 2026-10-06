/**
 * A case's live evaluation is read requirement by requirement, and a refused
 * approval says which requirements stopped it - in words, not codes.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import { ApiError, api } from '@/lib/api';
import type { CaseDetail, RequirementOutcome, RequirementState } from '@/lib/console-types';
import { Permission, holdsAll, holdsAny } from '@/lib/permissions';
import { sessionFor } from '@/test/session-fixture';
import { CaseDetailView } from './CaseDetailView';

const STATES: RequirementState[] = [
  'SATISFIED',
  'MISSING',
  'EXPIRED',
  'WRONG_SCOPE',
  'PENDING_REVIEW',
  'NOT_APPLICABLE',
  'NEEDS_DETERMINATION',
  'UNRESOLVED',
  'OPTIONAL_NOT_HELD',
];

function outcome(state: RequirementState, index: number): RequirementOutcome {
  return {
    requirementId: `req-${String(index)}`,
    code: `RULE-${String(index)}`,
    ruleVersion: 1,
    name: `Requirement ${String(index)}`,
    obligation: state === 'OPTIONAL_NOT_HELD' ? 'OPTIONAL_QUALIFICATION' : 'LEGAL',
    applicability: state === 'NEEDS_DETERMINATION' ? 'CONDITIONAL' : 'APPLIES',
    state,
    blocking: ['MISSING', 'EXPIRED', 'WRONG_SCOPE', 'PENDING_REVIEW', 'NEEDS_DETERMINATION', 'UNRESOLVED'].includes(state),
    documentId: state === 'SATISFIED' ? 'doc-1' : null,
    validUntil: state === 'SATISFIED' ? '2027-03-31' : null,
  };
}

function detail(): CaseDetail {
  return {
    case: {
      id: 'case-1',
      caseNumber: 'QC-0001',
      level: 'SELLER_CATEGORY',
      sellerAccountId: 'seller-1',
      categoryId: 'cat-1',
      productId: null,
      supplyRole: 'MANUFACTURER',
      destinationMarket: 'EU',
      factoryId: null,
      status: 'UNDER_REVIEW',
      reviewerLabel: 'Reviewer One',
      decidedAt: null,
      expiresAt: null,
      sellerMessage: null,
      internalNote: null,
      determinations: {},
      lockVersion: 3,
      updatedAt: '2026-10-01T10:00:00.000Z',
    },
    seller: { id: 'seller-1', name: 'Northwind Medical', kind: 'MANUFACTURER', country: 'IN', status: 'APPROVED' },
    categoryName: 'Medical Devices',
    product: null,
    evaluation: {
      outcomes: STATES.map(outcome),
      ready: false,
      noApprovedRules: false,
      expiresAt: null,
    },
    enforcement: 'WARN',
    history: [],
  };
}

function renderCase(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const session = sessionFor({ role: 'COMPLIANCE_REVIEWER', permissions: [Permission.SELLER_READ, Permission.CASE_REVIEW] });
  const value: SessionState = {
    stage: 'READY',
    session,
    notice: null,
    signIn: vi.fn(),
    signOut: vi.fn(),
    refresh: vi.fn(),
    can: (...keys) => holdsAll(session.member.permissions, keys),
    canAny: (...keys) => holdsAny(session.member.permissions, keys),
  };

  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <SessionContext.Provider value={value}>
            <MemoryRouter>
              <CaseDetailView caseId="case-1" back={{ to: '/sellers', label: 'Back to sellers' }} />
            </MemoryRouter>
          </SessionContext.Provider>
        </ToastProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

beforeAll(() => {
  // The page scroll lock a dialog takes restores the scroll position; jsdom has no scrolling.
  window.scrollTo = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the case evaluation', () => {
  it('shows every requirement state in words', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(detail());

    renderCase();

    const table = await screen.findByRole('table');
    for (const label of [
      'Satisfied',
      'Missing',
      'Expired',
      'Document does not cover this scope',
      'Document awaiting review',
      'Does not apply',
      'Needs a decision',
      'Unresolved',
      'Optional, not held',
    ]) {
      expect(within(table).getByText(label)).toBeDefined();
    }
    expect(within(table).getAllByText('Blocks approval')).toHaveLength(6);
    expect(api.get).toHaveBeenCalledWith('/audit/cases/case-1');
  });

  it('offers a decision only on a line whose applicability is not settled', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(detail());

    renderCase();

    await screen.findByRole('table');
    const decide = screen.getAllByRole('button', { name: /Decide whether/ });
    expect(decide).toHaveLength(1);
    expect(decide[0]?.getAttribute('aria-label')).toBe('Decide whether RULE-6 applies');
  });

  it('lists the requirements that stopped an approval', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(detail());
    const post = vi.spyOn(api, 'post').mockRejectedValue(
      new ApiError(409, {
        code: 'COMPLIANCE_CASE_NOT_READY',
        message: 'This case cannot be approved yet.',
        details: [
          { code: 'MISSING', meta: { requirement: 'ISO-13485' } },
          { code: 'PENDING_REVIEW', meta: { requirement: 'CDSCO-MD5' } },
        ],
        correlationId: 'corr-42',
      }),
    );
    const user = userEvent.setup();

    renderCase();

    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    const buttons = screen.getAllByRole('button', { name: 'Approve' });
    await user.click(buttons[buttons.length - 1] as HTMLElement);

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('This case cannot be approved yet')).toBeDefined();
    expect(within(alert).getByText('ISO-13485: Missing')).toBeDefined();
    expect(within(alert).getByText('CDSCO-MD5: Document awaiting review')).toBeDefined();
    expect(within(alert).getByText('Reference: corr-42')).toBeDefined();
    expect(post).toHaveBeenCalledWith(
      '/audit/cases/case-1/approve',
      expect.objectContaining({ expectedLockVersion: 3 }),
      expect.objectContaining({ idempotencyKey: expect.any(String) as unknown }),
    );
  });
});

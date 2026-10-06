/**
 * The rules screen must never let a draft look like a rule in force.
 *
 * The banner saying drafts decide nothing and that a second person approves
 * every rule is always there, and a draft row says "Draft" in words.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import { api } from '@/lib/api';
import type { CoverageRow, RuleView } from '@/lib/console-types';
import { Permission, holdsAll, holdsAny } from '@/lib/permissions';
import { sessionFor } from '@/test/session-fixture';
import { RulesPage } from '../RulesPage';

const coverage: CoverageRow[] = [
  {
    categoryId: 'C'.repeat(26),
    name: 'Medical Devices',
    slug: 'medical-devices',
    depth: 0,
    parentId: null,
    products: 26,
    approved: 0,
    approvedMandatory: 0,
    awaitingApproval: 1,
    unresolved: 0,
    conditional: 0,
    needsReview: true,
  },
];

const draft: RuleView = {
  id: 'R'.repeat(26),
  code: 'EU-MDR-DOC',
  ruleVersion: 1,
  status: 'DRAFT',
  name: 'EU declaration of conformity',
  description: 'A declaration of conformity for each device.',
  requiredEvidence: 'The signed declaration.',
  obligation: 'LEGAL',
  level: 'SELLER_CATEGORY',
  categoryIds: ['C'.repeat(26)],
  includeDescendants: true,
  supplyRoles: [],
  originCountries: [],
  destinationMarkets: ['EU'],
  riskClasses: [],
  productTypeNote: null,
  intendedUseNote: null,
  applicability: 'APPLIES',
  applicabilityNote: null,
  expiryKind: 'DOCUMENT_EXPIRY',
  reviewMonths: null,
  sourceUrl: 'https://eur-lex.europa.eu/eli/reg/2017/745/oj',
  sourceTitle: 'Regulation (EU) 2017/745',
  sourcePublisher: 'EUR-Lex',
  lastReviewedOn: '2026-10-06',
  confidence: 'HIGH',
  importedFrom: null,
  effectiveFrom: null,
  effectiveTo: null,
  draftedByUserId: 'someone-else',
  draftedByLabel: 'Reviewer',
  submittedAt: null,
  decidedByLabel: null,
  decidedAt: null,
  decisionNote: null,
  supersedesId: null,
  lockVersion: 0,
};

function renderPage(entry = '/rules'): void {
  const session = sessionFor({
    role: 'SUPERVISOR',
    permissions: [Permission.RULE_READ, Permission.RULE_DRAFT, Permission.RULE_APPROVE],
  });
  const held = session.member.permissions;
  const value: SessionState = {
    stage: 'READY',
    session,
    notice: null,
    signIn: () => Promise.resolve(),
    signOut: () => Promise.resolve(),
    refresh: () => Promise.resolve(),
    can: (...keys) => holdsAll(held, keys),
    canAny: (...keys) => holdsAny(held, keys),
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <SessionContext.Provider value={value}>
            <MemoryRouter initialEntries={[entry]}>
              <RulesPage />
            </MemoryRouter>
          </SessionContext.Provider>
        </ToastProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

function mockApi(): void {
  vi.spyOn(api, 'get').mockImplementation((path: string) => {
    if (path === '/audit/rules/coverage') return Promise.resolve({ categories: coverage });
    if (path === '/audit/rules') return Promise.resolve({ rules: [draft] });
    return Promise.reject(new Error(`unexpected ${path}`));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the compliance rules screen', () => {
  it('says drafts decide nothing and that a second person approves every rule', async () => {
    mockApi();
    renderPage();

    expect(screen.getByText('Draft rules decide nothing')).toBeDefined();
    expect(screen.getByText(/a supervisor who did not draft it must approve it/)).toBeDefined();
    // The coverage tab names a category with nothing approved.
    expect(await screen.findByText('NEEDS REVIEW')).toBeDefined();
  });

  it('shows a draft rule as "Draft" in words', async () => {
    mockApi();
    renderPage();

    await userEvent.click(screen.getByRole('tab', { name: 'Rules' }));

    const table = await screen.findByRole('table');
    const row = within(table).getByText('EU-MDR-DOC').closest('tr');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('Draft')).toBeDefined();
    const source = within(row as HTMLElement).getByRole('link', { name: /EUR-Lex/ });
    expect(source.getAttribute('target')).toBe('_blank');
    expect(source.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('opens the Rules tab with the status from the address', async () => {
    mockApi();
    renderPage('/rules?status=DRAFT');

    expect(await screen.findByRole('table')).toBeDefined();
    expect(api.get).toHaveBeenCalledWith('/audit/rules', { query: { status: 'DRAFT' } });
  });
});

/**
 * The staff dashboard, drawn as charts: every ring's total is the server's
 * counts added up, closed statuses fold into one slice, the key figures add
 * the statuses they name, and a slice opens the list it counts.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { i18n } from '@/i18n/config';
import { api } from '@/lib/api';
import type { CoverageRow, DashboardResponse } from '@/lib/console-types';
import { holdsAll, holdsAny } from '@/lib/permissions';
import { sessionFor } from '@/test/session-fixture';
import { DashboardPage } from './DashboardPage';

const dashboard: DashboardResponse = {
  audience: 'STAFF',
  staff: {
    cases: { REQUESTED: 3, UNDER_REVIEW: 1, CHANGES_REQUESTED: 1, QUALIFIED: 2, REJECTED: 1, WITHDRAWN: 1 },
    documents: { SUBMITTED: 2, UNDER_REVIEW: 1, APPROVED: 4, EXPIRED: 1 },
    rules: { waitingForApproval: 2, approved: 5, drafts: 1 },
    inspections: { open: 3, overdue: 1, held: 0, subLotsWaiting: 0 },
    documentsExpiringIn30Days: 1,
  },
};

function coverageRow(overrides: Partial<CoverageRow>): CoverageRow {
  return {
    categoryId: 'cat',
    name: 'Category',
    slug: 'category',
    depth: 0,
    parentId: null,
    products: 0,
    approved: 0,
    approvedMandatory: 0,
    awaitingApproval: 0,
    unresolved: 0,
    conditional: 0,
    needsReview: true,
    ...overrides,
  };
}

const coverage = {
  categories: [
    coverageRow({ categoryId: 'a', name: 'Medical Devices', products: 12, approved: 9, needsReview: false }),
    coverageRow({ categoryId: 'b', name: 'Garden Tools', products: 4 }),
    // No products: no seller to qualify, so it counts for neither side.
    coverageRow({ categoryId: 'c', name: 'Empty Shelf', products: 0 }),
  ],
};

function Where(): React.JSX.Element {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const session = sessionFor({ role: 'SUPERVISOR', permissions: [] });
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
        <SessionContext.Provider value={value}>
          <MemoryRouter initialEntries={['/dashboard']}>
            <Routes>
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="*" element={<Where />} />
            </Routes>
          </MemoryRouter>
        </SessionContext.Provider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

beforeAll(() => {
  window.scrollTo = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockReads(): void {
  vi.spyOn(api, 'get').mockImplementation((path: string) =>
    Promise.resolve(path === '/audit/rules/coverage' ? coverage : dashboard),
  );
}

describe('the staff dashboard', () => {
  it('draws each queue as a ring whose total is every status the server sent', async () => {
    mockReads();
    renderPage();

    const totals = await screen.findAllByTestId('donut-total');
    // Cases 9, documents 8, rules 2 + 5 + 1.
    expect(totals.map((node) => node.textContent)).toEqual(['9', '8', '8']);

    // Rejected and withdrawn fold into one "Closed" slice of the cases ring.
    const cases = screen.getByRole('heading', { name: 'Qualification and product cases' }).closest('section');
    expect(cases).not.toBeNull();
    const closed = within(cases as HTMLElement).getByRole('button', { name: /Closed/ });
    expect(closed.textContent).toContain('2');
  });

  it('adds only the statuses a key figure names, and counts coverage over stocked categories', async () => {
    mockReads();
    renderPage();

    // Open cases: requested, under review and changes requested (3 + 1 + 1).
    const open = await screen.findByRole('link', { name: /Open cases/ });
    expect(open.textContent).toContain('5');

    // One of the two categories that hold products has an approved rule.
    const coverageTile = await screen.findByRole('link', { name: /Category coverage/ });
    expect(await within(coverageTile).findByText('50%')).toBeDefined();

    // The uncovered stocked category is listed; the empty one is not.
    expect(screen.getByRole('link', { name: /Garden Tools/ })).toBeDefined();
    expect(screen.queryByRole('link', { name: /Empty Shelf/ })).toBeNull();
  });

  it('opens the list a slice counts', async () => {
    mockReads();
    const user = userEvent.setup();
    renderPage();

    await screen.findAllByTestId('donut-total');
    await user.click(screen.getByRole('button', { name: /^Requested/ }));

    expect(screen.getByTestId('where').textContent).toBe('/sellers?status=REQUESTED');
  });
});

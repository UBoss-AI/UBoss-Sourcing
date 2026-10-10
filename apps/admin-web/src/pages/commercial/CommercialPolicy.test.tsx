/**
 * Commercial policy screens: a draft schedule says it is only a proposal and
 * lists what stops it being activated, and the safety case page says it is
 * read only here and offers no control that changes a case.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import { CommercialScheduleDetailPage } from './CommercialSchedulesPage';
import { SafetyCaseDetailPage, SafetyCasesPage } from './ReadOnlyEvidencePages';

const fetchMock = vi.fn();
const tr = (key: string): string => (i18n.t as unknown as (k: string) => string)(key);

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function renderAt(path: string, routePath: string, page: React.JSX.Element): void {
  const session = {
    user: { id: 'u1', email: 'owner@example.test' },
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
    refreshUser: vi.fn(),
    can: () => true,
    canAny: () => true,
  } as unknown as SessionState;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <SessionContext.Provider value={session}>
            <MemoryRouter initialEntries={[path]}>
              <Routes>
                <Route path={routePath} element={page} />
              </Routes>
            </MemoryRouter>
          </SessionContext.Provider>
        </ToastProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

const SCHEDULE = {
  id: 's1',
  kind: 'COMMISSION',
  version: 1,
  status: 'DRAFT',
  title: 'Commission 2027',
  sourceDocument: 'Doc 08',
  scopeJson: null,
  bodyJson: { rates: [] },
  effectiveFrom: null,
  effectiveUntil: null,
  scheduleReference: null,
  preparedById: 'u1',
  submittedAt: null,
  approvedById: null,
  approvedAt: null,
  approvalEvidence: null,
  providerConfirmationRef: null,
  providerConfirmedAt: null,
  activatedAt: null,
  retiredAt: null,
  note: null,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  events: [],
  activationProblems: ['NOT_APPROVED', 'APPROVER_MISSING'],
};

const CASE = {
  id: 'c1',
  reference: 'SC-0001',
  title: 'Seal failure',
  description: 'Seals found broken on arrival.',
  severity: 'HIGH',
  status: 'OPEN',
  sourceType: 'INSPECTION',
  rootCause: null,
  correctionEvidence: null,
  releasedAt: null,
  createdAt: '2026-10-01T10:00:00.000Z',
  scope: [],
  actions: [],
};

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/admin/commercial/schedules/s1')) return Promise.resolve(json(SCHEDULE));
    if (url.includes('/admin/commercial/safety-cases/c1')) return Promise.resolve(json(CASE));
    if (url.includes('/admin/commercial/safety-cases')) return Promise.resolve(json({ cases: [CASE] }));
    return Promise.resolve(json({}));
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('commercial schedule detail', () => {
  it('marks a draft as a proposal and lists every activation problem', async () => {
    renderAt('/commercial/schedules/s1', '/commercial/schedules/:id', <CommercialScheduleDetailPage />);
    expect(await screen.findByText(tr('commercial.proposalTitle'))).toBeTruthy();
    expect(screen.getByText(tr('commercial.code.NOT_APPROVED'))).toBeTruthy();
    expect(screen.getByText(tr('commercial.code.APPROVER_MISSING'))).toBeTruthy();
  });
});

describe('safety cases', () => {
  it('says the list is read only', async () => {
    renderAt('/commercial/safety-cases', '/commercial/safety-cases', <SafetyCasesPage />);
    expect(await screen.findByText(tr('commercial.readOnlyBody'))).toBeTruthy();
    expect(await screen.findByText('SC-0001')).toBeTruthy();
  });

  it('shows a case with the read-only notice and no buttons that change it', async () => {
    renderAt('/commercial/safety-cases/c1', '/commercial/safety-cases/:id', <SafetyCaseDetailPage />);
    expect(await screen.findByText('Seals found broken on arrival.')).toBeTruthy();
    expect(screen.getByText(tr('commercial.readOnlyBody'))).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});

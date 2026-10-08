/**
 * Seller health (Amazon's Account Health model), the verification report
 * (Alibaba's Verified Supplier assessment) and the quality insights screen
 * (QIMA's analytics): what each draws from the server's answer.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { healthPosition } from '@/lib/health';
import { i18n } from '@/i18n/config';
import { api } from '@/lib/api';
import type { InsightsResponse, SellerDetail, SellerHealth } from '@/lib/console-types';
import { holdsAll, holdsAny } from '@/lib/permissions';
import { verificationReport } from '@/lib/verification-report';
import { sessionFor } from '@/test/session-fixture';
import { InsightsPage } from '../InsightsPage';
import { SellerDetailPage } from '../SellersPage';

const cleanHealth: SellerHealth = {
  score: 1000,
  band: 'HEALTHY',
  bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
  issues: [],
  inspection: { reports: 0, passed: 0, notPassed: 0, passRatePercent: null, meetsTarget: null },
};

function seller(overrides: Partial<SellerDetail> = {}): SellerDetail {
  return {
    seller: { id: 's1', name: 'Acme Medical', kind: 'MANUFACTURER', applicationStatus: 'APPROVED', country: 'DE', statusReason: null },
    businessIdentity: {
      note: '',
      checks: [{ kind: 'LEGAL_ENTITY', state: 'VERIFIED', method: null, issuer: null, checkedAt: null, validUntil: null }],
      screening: [{ state: 'CLEAR', at: '2026-09-01T00:00:00.000Z' }],
    },
    factories: [{ id: 'f1', name: 'Plant 1', city: 'Berlin', countryCode: 'DE' }],
    health: cleanHealth,
    cases: [],
    documents: [
      {
        id: 'd1',
        standard: 'ISO 13485',
        documentType: 'CERTIFICATE',
        reviewStatus: 'APPROVED',
        expiresOn: '2027-12-31',
        issuer: 'TÜV SÜD',
        requirementCodes: [],
        categoryScopeIds: [],
        revision: 1,
        supersededAt: null,
      },
    ],
    ...overrides,
  };
}

describe('the verification report', () => {
  it('calls a seller verified when identity, screening and certificates all are', () => {
    expect(verificationReport(seller()).verified).toBe(true);
  });

  it('withholds the badge when any area needs attention', () => {
    const lapsed = seller({
      documents: [...seller().documents.map((row) => ({ ...row, id: 'd2', reviewStatus: 'EXPIRED' })), ...seller().documents],
    });
    const report = verificationReport(lapsed);
    expect(report.sections.find((section) => section.key === 'certifications')?.state).toBe('ATTENTION');
    expect(report.verified).toBe(false);
  });

  it('says a declared site is declared, never verified', () => {
    expect(verificationReport(seller()).sections.find((section) => section.key === 'sites')?.state).toBe('DECLARED');
  });

  it('does not judge quality on too few reports', () => {
    const few = seller({ health: { ...cleanHealth, inspection: { reports: 2, passed: 1, notPassed: 1, passRatePercent: 50, meetsTarget: null } } });
    expect(verificationReport(few).sections.find((section) => section.key === 'quality')?.state).toBe('PENDING');
  });
});

describe('the health meter', () => {
  it('places each band in its own zone, not to scale', () => {
    expect(healthPosition(0)).toBe(0);
    expect(healthPosition(99)).toBe(20);
    expect(healthPosition(100)).toBe(20);
    expect(healthPosition(200)).toBe(40);
    expect(healthPosition(1000)).toBe(100);
  });
});

// ---------------------------------------------------------------------------

function Where(): React.JSX.Element {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

function renderAt(path: string, routes: React.ReactNode): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const session = sessionFor({ role: 'SUPERVISOR', permissions: ['audit.seller.read', 'audit.job.oversee'] });
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
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              {routes}
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

describe('one seller’s page', () => {
  it('shows the rating, the open issues worst first, and where to fix each', async () => {
    const unhealthy = seller({
      health: {
        score: 99,
        band: 'UNHEALTHY',
        bySeverity: { CRITICAL: 1, HIGH: 0, MEDIUM: 1, LOW: 0 },
        issues: [
          { kind: 'CRITICAL_NCR_OPEN', severity: 'CRITICAL', count: 1 },
          { kind: 'DOCUMENT_EXPIRING', severity: 'MEDIUM', count: 1 },
        ],
        inspection: { reports: 4, passed: 2, notPassed: 2, passRatePercent: 50, meetsTarget: false },
      },
    });
    vi.spyOn(api, 'get').mockResolvedValue(unhealthy);
    renderAt('/sellers/s1', <Route path="/sellers/:id" element={<SellerDetailPage />} />);

    const meter = await screen.findByRole('meter', { name: 'Health rating' });
    expect(meter.getAttribute('aria-valuenow')).toBe('99');
    expect(screen.getAllByText('Unhealthy').length).toBeGreaterThan(0);
    expect(screen.getByText('Above target')).toBeDefined();

    const issues = screen.getByRole('heading', { name: 'Open issues' }).nextElementSibling as HTMLElement;
    const items = within(issues).getAllByRole('listitem');
    expect(items[0]?.textContent).toContain('Critical non-conformance open');
    expect(within(items[0] as HTMLElement).getByRole('link', { name: 'Go to fix' }).getAttribute('href')).toBe('/corrective-actions');
    expect(within(items[1] as HTMLElement).getByRole('link', { name: 'Go to fix' }).getAttribute('href')).toBe('#seller-documents');
  });

  it('shows the verification report and the approved certificates', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(seller());
    renderAt('/sellers/s1', <Route path="/sellers/:id" element={<SellerDetailPage />} />);

    expect(await screen.findByText('Verified seller')).toBeDefined();
    expect(screen.getByText('Nothing is open against this seller.')).toBeDefined();
    expect(screen.getAllByText('ISO 13485').length).toBeGreaterThan(0);
    expect(screen.getByText(/TÜV SÜD/)).toBeDefined();
  });
});

const insights: InsightsResponse = {
  from: '2025-11-01',
  reports: { pass: 7, fail: 2, inconclusive: 1, total: 10, passRatePercent: 70 },
  months: Array.from({ length: 12 }, (_, index) => ({
    month: `2026-${String(index + 1).padStart(2, '0')}`,
    pass: index === 11 ? 7 : 0,
    fail: index === 11 ? 2 : 0,
    inconclusive: index === 11 ? 1 : 0,
  })),
  defects: { bySeverity: { CRITICAL: 1, MAJOR: 2, MINOR: 3 }, byStatus: { OPEN: 4, CAPA_SUBMITTED: 1, VERIFIED_CLOSED: 1 }, total: 6 },
  topFindings: [{ requirementRef: 'EN 1041 §5', count: 3 }],
  suppliers: {
    best: [{ sellerAccountId: 's1', name: 'Acme Medical', pass: 5, reports: 5, passRatePercent: 100 }],
    worst: [{ sellerAccountId: 's2', name: 'Bad Widgets', pass: 2, reports: 5, passRatePercent: 40 }],
    ranked: 2,
  },
  agencies: [{ agencyId: 'a1', name: 'Inspect Co', kind: 'THIRD_PARTY', completed: 10, onTime: 8, onTimePercent: 80, reports: 10, passRatePercent: 70 }],
  health: { bands: { HEALTHY: 6, AT_RISK: 3, UNHEALTHY: 1 }, sellers: 10 },
};

describe('quality analytics', () => {
  it('draws the key figures, the rankings and the agencies from the server', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(insights);
    renderAt('/insights', <Route path="/insights" element={<InsightsPage />} />);

    const passRate = await screen.findByRole('link', { name: /Inspection pass rate/ });
    expect(within(passRate).getByText('70%')).toBeDefined();
    const healthy = screen.getByRole('link', { name: /Healthy sellers/ });
    expect(within(healthy).getByText('60%')).toBeDefined();
    expect(screen.getByRole('link', { name: /Bad Widgets/ }).getAttribute('href')).toBe('/sellers/s2');
    expect(screen.getByRole('link', { name: /EN 1041/ })).toBeDefined();
    expect(screen.getAllByText('Inspect Co').length).toBeGreaterThan(0);
  });

  it('opens a health band as the riskiest-first seller list', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(insights);
    const user = userEvent.setup();
    renderAt('/insights', <Route path="/insights" element={<InsightsPage />} />);

    await screen.findAllByTestId('donut-total');
    await user.click(screen.getByRole('button', { name: /^Unhealthy/ }));
    expect(screen.getByTestId('where').textContent).toBe('/sellers?health=UNHEALTHY&sort=risk');
  });

  it('gives the monthly chart a table view with the exact figures', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(insights);
    const user = userEvent.setup();
    renderAt('/insights', <Route path="/insights" element={<InsightsPage />} />);

    const card = (await screen.findByRole('heading', { name: 'Inspection results by month' })).closest('section') as HTMLElement;
    await user.click(within(card).getByRole('button', { name: 'View as a table' }));
    const table = within(card).getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(13);
  });
});

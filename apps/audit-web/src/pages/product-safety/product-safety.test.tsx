/**
 * Product evidence and safety cases: the evidence table never invents an
 * expiry and says what each kind of evidence does not prove; a reporting
 * decision has no AI option and needs the decider's qualified role; release
 * explains what it needs and who may do it.
 */
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SessionContext, type SessionState } from '@/auth/session-context';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import { api } from '@/lib/api';
import { holdsAll, holdsAny, Permission } from '@/lib/permissions';
import type { EvidenceRow, SafetyCaseDetail } from '@/lib/product-safety';
import { sessionFor } from '@/test/session-fixture';
import { ProductEvidencePage } from './ProductEvidencePage';
import { ActionsPanel, ReleasePanel } from './SafetyCaseDetailPage';

const LIMIT = 'Evidence for the tested version and conditions only; no generic annual validity.';

const evidenceRow: EvidenceRow = {
  id: 'ev1',
  sellerAccountId: '01SELLER0000000000000000AA',
  offerId: null,
  productKey: 'GLOVE-NITRILE',
  productVersion: '2',
  facilityRef: 'PLANT-1',
  countryCode: 'DE',
  departmentSlug: null,
  kind: 'TEST_REPORT',
  scheme: 'EN 455',
  issuer: 'Test Lab GmbH',
  accreditation: null,
  scope: 'Nitrile gloves size M',
  certificateNumber: null,
  issuedOn: null,
  expiresOn: null,
  changeConditions: null,
  surveillanceDueAt: null,
  requiredForTrading: true,
  existingAccepted: false,
  gapAssessment: null,
  verificationMethod: null,
  verificationEvidence: null,
  verifiedAt: null,
  status: 'UNVERIFIED',
  statusReason: null,
  recordedById: 'user-2',
  createdAt: '2026-10-01T00:00:00.000Z',
  blocksTrading: false,
  limit: LIMIT,
  daysToExpiry: null,
};

const safetyCase: SafetyCaseDetail = {
  id: 'sc1',
  reference: 'SC-0001-ABC',
  title: 'Gloves tear',
  description: 'Gloves tear on first use.',
  severity: 'HIGH',
  status: 'CONTAINED',
  sourceType: 'INCIDENT',
  sourceId: null,
  sellerAccountId: null,
  containmentJson: { stopListings: true },
  rootCause: null,
  correctionEvidence: null,
  verificationTests: null,
  currentCertificates: null,
  releaseApprovedById: null,
  releasedAt: null,
  openedById: 'user-2',
  createdAt: '2026-10-01T00:00:00.000Z',
  scope: [],
  actions: [],
};

function wrap(ui: React.ReactNode): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const session = sessionFor({ role: 'SUPERVISOR', permissions: [Permission.ASSESSMENT_READ, Permission.ASSESSMENT_WORK, Permission.SELLER_VERIFY, Permission.RELEASE_REQUEST] });
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
          <ToastProvider>
            <MemoryRouter>{ui}</MemoryRouter>
          </ToastProvider>
        </SessionContext.Provider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

beforeAll(async () => {
  window.scrollTo = vi.fn();
  await i18n.changeLanguage('en');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('product evidence', () => {
  it('shows "no issuer-set expiry" instead of inventing one, and what the evidence does not prove', async () => {
    vi.spyOn(api, 'get').mockImplementation((path: string) => Promise.resolve(path === '/audit/product-evidence/prompts' ? { row: null, notice: '', matrix: [] } : { evidence: [evidenceRow] }));
    wrap(<ProductEvidencePage />);
    expect((await screen.findAllByText('No issuer-set expiry')).length).toBeGreaterThan(0);
    expect(screen.getAllByText(LIMIT).length).toBeGreaterThan(0);
    expect(screen.getByText(/prompts for the reviewer, not a list of what every product legally needs/)).toBeTruthy();
  });
});

describe('safety case', () => {
  it('offers no AI option for a reporting decision and requires the qualified role', () => {
    wrap(<ActionsPanel c={safetyCase} />);
    const form = screen.getByRole('form', { name: 'Record an action' });
    const options = within(form)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(options.some((text) => /\bAI\b|artificial|automatic/i.test(text))).toBe(false);
    expect((within(form).getByRole('combobox', { name: /Decision/ })).hasAttribute('required')).toBe(true);
    expect((within(form).getByLabelText(/Qualified role of the person deciding/)).hasAttribute('required')).toBe(true);
    expect((within(form).getByLabelText(/Authority/)).hasAttribute('required')).toBe(true);
  });

  it('explains that release needs everything on file and a different person from the opener', () => {
    wrap(<ReleasePanel c={safetyCase} />);
    expect(screen.getByText(/different person from the one who opened the case/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Release case' })).toBeTruthy();
  });
});

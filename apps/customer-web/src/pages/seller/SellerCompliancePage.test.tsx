/**
 * Seller Hub -> Compliance: categories with their enforcement state, cases
 * with status words and the reviewer's message, the requirement checklist,
 * and the request form's own checks before anything is sent.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/harness';
import type { CaseDetail, ComplianceOverview } from '@/lib/compliance';
import { SellerCompliancePage } from './SellerCompliancePage';

vi.mock('@/lib/compliance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/compliance')>()),
  fetchComplianceOverview: vi.fn(),
  fetchComplianceCase: vi.fn(),
  requestComplianceCase: vi.fn(),
  fetchApprovedRequirements: vi.fn(() => Promise.resolve([])),
}));
vi.mock('@/lib/factories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/factories')>()),
  fetchFactories: vi.fn(() => Promise.resolve({ factories: [] })),
}));

const lib = await import('@/lib/compliance');

const CAT_A = '01CATEGORYA00000000000000A';
const CAT_B = '01CATEGORYB00000000000000B';

const overview: ComplianceOverview = {
  approvedRuleCount: 2,
  categories: [
    { categoryId: CAT_A, name: 'Surgical gloves', allowed: false, missing: true, mode: 'ENFORCE' },
    { categoryId: CAT_B, name: 'Office chairs', allowed: true, missing: false, mode: 'ENFORCE' },
  ],
  cases: [
    {
      id: '01CASE0000000000000000001', caseNumber: 'CQ-2026-000001', level: 'SELLER_CATEGORY', categoryId: CAT_A, categoryName: 'Surgical gloves',
      productId: null, supplyRole: 'MANUFACTURER', destinationMarket: 'EU', factoryId: null, status: 'CHANGES_REQUESTED',
      decidedAt: null, expiresAt: null, sellerMessage: 'Please add your ISO 13485 certificate.', updatedAt: '2026-10-01T00:00:00Z',
    },
  ],
  documents: [],
};

const detail: CaseDetail = {
  case: overview.cases[0]!,
  seller: { id: 'S', name: 'Acme' },
  categoryName: 'Surgical gloves',
  product: null,
  enforcement: 'ENFORCE',
  history: [],
  evaluation: {
    ready: false,
    noApprovedRules: false,
    expiresAt: null,
    outcomes: [
      { requirementId: 'R1', code: 'ISO-13485', ruleVersion: 1, name: 'Quality management', obligation: 'LEGAL', applicability: 'APPLIES', state: 'MISSING', blocking: true, documentId: null, validUntil: null },
      { requirementId: 'R2', code: 'EU-DOC', ruleVersion: 1, name: 'Declaration', obligation: 'LEGAL', applicability: 'CONDITIONAL', state: 'NEEDS_DETERMINATION', blocking: true, documentId: null, validUntil: null },
    ],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(lib.fetchComplianceOverview).mockResolvedValue(overview);
  vi.mocked(lib.fetchComplianceCase).mockResolvedValue(detail);
  vi.mocked(lib.requestComplianceCase).mockResolvedValue({ id: 'X', caseNumber: 'CQ-2026-000002', created: true });
});

describe('SellerCompliancePage', () => {
  it('shows each category with its enforcement state in words', async () => {
    renderWithProviders(<SellerCompliancePage />);
    expect(await screen.findByText('Qualification needed - new listings blocked')).toBeInTheDocument();
    expect(screen.getByText('No approved requirement')).toBeInTheDocument();
    expect(screen.getByText(/a new listing can only go live once you are qualified/)).toBeInTheDocument();
  });

  it('shows a case with its status, the reviewer message, and the checklist when opened', async () => {
    renderWithProviders(<SellerCompliancePage />);
    expect(await screen.findByText('CQ-2026-000001')).toBeInTheDocument();
    expect(screen.getAllByText('Changes requested').length).toBeGreaterThan(0);
    expect(screen.getByText('Please add your ISO 13485 certificate.')).toBeInTheDocument();
    expect(screen.getByText('Surgical gloves - Manufacturer - for the European Union')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show details' }));
    const list = await screen.findByRole('list', { name: 'Requirement checklist' });
    expect(within(list).getByText('Missing')).toBeInTheDocument();
    expect(within(list).getByText("Needs the reviewer's decision")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send back for review' })).toBeInTheDocument();
    // Nothing on the page approves a case.
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
  });

  it('says so when no approved rule applies, rather than qualifying by default', async () => {
    vi.mocked(lib.fetchComplianceCase).mockResolvedValue({ ...detail, evaluation: { ...detail.evaluation, outcomes: [], noApprovedRules: true } });
    renderWithProviders(<SellerCompliancePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show details' }));
    expect(await screen.findByText(/it is never approved by default/)).toBeInTheDocument();
  });

  it('checks the request form before sending, then sends it with an idempotency key', async () => {
    renderWithProviders(<SellerCompliancePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Request a qualification' }));
    const form = screen.getByRole('form', { name: 'Request a qualification' });
    fireEvent.click(within(form).getByRole('button', { name: 'Send request' }));
    expect(await within(form).findByText('Choose a category.')).toBeInTheDocument();
    expect(within(form).getByText('Choose your supply role.')).toBeInTheDocument();
    expect(lib.requestComplianceCase).not.toHaveBeenCalled();

    fireEvent.change(within(form).getByLabelText(/^Category/), { target: { value: CAT_A } });
    fireEvent.change(within(form).getByLabelText(/^Your supply role/), { target: { value: 'IMPORTER' } });
    fireEvent.change(within(form).getByLabelText(/^Market/), { target: { value: 'COUNTRY' } });
    fireEvent.change(within(form).getByLabelText(/^Country code/), { target: { value: 'Germany' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Send request' }));
    expect(await within(form).findByText('Enter a two-letter country code, such as DE.')).toBeInTheDocument();
    expect(lib.requestComplianceCase).not.toHaveBeenCalled();

    fireEvent.change(within(form).getByLabelText(/^Country code/), { target: { value: 'de' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Send request' }));
    await waitFor(() => {
      expect(lib.requestComplianceCase).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'SELLER_CATEGORY', categoryId: CAT_A, supplyRole: 'IMPORTER', destinationMarket: 'DE' }),
        expect.any(String),
      );
    });
  });
});

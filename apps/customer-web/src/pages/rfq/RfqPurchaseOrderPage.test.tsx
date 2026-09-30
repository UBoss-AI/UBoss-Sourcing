import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { RfqPurchaseOrderPage } from './RfqPurchaseOrderPage';
import type { RfqPoContract, RfqPurchaseOrder } from '@/lib/rfq-purchase-order';
import { jsonResponse, renderWithProviders } from '@/test/harness';

const fetchMock = vi.fn();
const RFQ_ID = '01RFQ00000000000000000000A';
const HASH = 'a'.repeat(64);
const money = (minor: string, formatted: string) => ({ minor, formatted, currency: 'INR' });
function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body.');
  return JSON.parse(init.body) as Record<string, unknown>;
}

const contract: RfqPoContract = {
  schemaVersion: 1,
  rfq: { id: RFQ_ID, reference: 'RFQ-2026-000042', requirementVersion: 1 },
  quote: { id: '01QUOTE000000000000000000', versionId: '01VERSION0000000000000000', versionNumber: 1, acceptedTermsHash: HASH, acceptedAt: '2026-09-30T10:00:00.000Z' },
  buyer: { kind: 'COMPANY', companyId: '01COMPANY0000000000000000' },
  supplier: { sellerAccountId: '01SELLER00000000000000000', name: 'Alpha Manufacturing' },
  item: {
    buyerSku: null,
    title: 'Nitrile examination gloves',
    specification: 'Powder free, 4 mil, EN 455.',
    specifications: [{ key: 'Material', value: 'Nitrile' }],
    quantity: '12000',
    unitOfMeasure: 'BOX',
  },
  delivery: {
    destinationCountry: 'IN',
    destinationAddress: 'Receiving dock 4, Pune',
    destinationPort: 'Nhava Sheva',
    targetDate: '2026-11-15',
    leadTimeDays: 30,
    incoterm: 'CIF',
    incotermPlace: 'Nhava Sheva',
  },
  commercial: {
    currency: 'INR',
    unitPriceMinor: '90000',
    applicableUnitPriceMinor: '90000',
    quantity: '12000',
    moq: '5000',
    leadTimeDays: 30,
    incoterm: 'CIF',
    incotermPlace: 'Nhava Sheva',
    paymentTerms: '30% advance',
    inspectionTerms: 'SGS pre-shipment',
    warranty: '12 months',
    sampleCostMinor: null,
    shippingEstimateMinor: '125000',
    taxesDisclosure: 'Tax is calculated separately.',
    goodsTotalMinor: '1080000000',
    toolingMinor: '250000',
    shippingMinor: '125000',
    grandTotalMinor: '1080375000',
  },
  quality: {
    certifications: ['EN 455', 'ISO 13485'],
    inspectionRequirement: 'THIRD_PARTY_PRE_SHIPMENT',
    inspectionTerms: 'SGS pre-shipment',
    sampleRequirement: 'WITH_QUOTE',
    warranty: '12 months',
  },
  documents: [{ id: '01FILE0000000000000000000', fileName: 'specification.pdf', contentHash: 'b'.repeat(64) }],
};

const amounts = {
  currency: 'INR',
  goods: money('1080000000', '₹10,800,000.00'),
  tooling: money('250000', '₹2,500.00'),
  shipping: money('125000', '₹1,250.00'),
  grand: money('1080375000', '₹10,803,750.00'),
};

function renderPage(): void {
  renderWithProviders(
    <Routes><Route path="/account/rfqs/:id/purchase-order" element={<RfqPurchaseOrderPage />} /></Routes>,
    { route: `/account/rfqs/${RFQ_ID}/purchase-order` },
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => vi.unstubAllGlobals());

describe('RfqPurchaseOrderPage', () => {
  it('shows every final contract section and only submits after explicit e-acceptance', async () => {
    let submitted: Record<string, unknown> | null = null;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') {
        submitted = requestBody(init);
        const purchaseOrder: RfqPurchaseOrder = {
          id: '01PO000000000000000000000', reference: 'PO-2026-0000000001', rfqId: RFQ_ID,
          quoteId: contract.quote.id, status: 'APPROVED', version: 0, acceptedTermsHash: HASH,
          contractHash: 'c'.repeat(64), contract: { ...contract, item: { ...contract.item, buyerSku: 'GLOVE-100' } },
          buyerSku: 'GLOVE-100', amounts,
          electronicAcceptance: { acceptedAt: '2026-09-30T11:00:00.000Z', signatureName: 'Asha Buyer', signatureTitle: 'Procurement manager' },
          approvals: [], approvedAt: '2026-09-30T11:00:00.000Z', rejectedAt: null, rejectionReason: null,
          createdAt: '2026-09-30T11:00:00.000Z', actions: { canSubmit: false, canApprove: false, canReject: false },
        };
        return Promise.resolve(jsonResponse({ purchaseOrder }, 201));
      }
      return Promise.resolve(jsonResponse({ kind: 'PREVIEW', preview: { acceptedTermsHash: HASH, contractHash: 'c'.repeat(64), contract, amounts, actions: { canSubmit: true, canApprove: false, canReject: false } } }));
    });
    renderPage();

    expect(await screen.findByText('Alpha Manufacturing')).toBeInTheDocument();
    expect(screen.getByText('Powder free, 4 mil, EN 455.')).toBeInTheDocument();
    expect(screen.getByText('30% advance')).toBeInTheDocument();
    expect(screen.getByText('SGS pre-shipment')).toBeInTheDocument();
    expect(screen.getByText('specification.pdf')).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Accept and raise purchase order' });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Your SKU / item code'), 'GLOVE-100');
    await userEvent.type(screen.getByLabelText('Signer name'), 'Asha Buyer');
    await userEvent.type(screen.getByLabelText('Job title (optional)'), 'Procurement manager');
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(submit);
    await waitFor(() => { expect(submitted).toMatchObject({ acceptedTermsHash: HASH, eAccepted: true, signatureName: 'Asha Buyer', buyerSku: 'GLOVE-100' }); });
    expect(await screen.findByText('Approved and binding')).toBeInTheDocument();
  });

  it('shows ordered approval stages and sends the current optimistic-lock version', async () => {
    const purchaseOrder: RfqPurchaseOrder = {
      id: '01PO000000000000000000000', reference: 'PO-2026-0000000001', rfqId: RFQ_ID,
      quoteId: contract.quote.id, status: 'PENDING_APPROVAL', version: 1, acceptedTermsHash: HASH,
      contractHash: 'c'.repeat(64), contract, buyerSku: null, amounts,
      electronicAcceptance: { acceptedAt: '2026-09-30T11:00:00.000Z', signatureName: 'Asha Buyer', signatureTitle: null },
      approvals: [
        { stage: 'APPROVER', decision: 'APPROVED', decidedAt: '2026-09-30T11:10:00.000Z', reason: 'Terms checked' },
        { stage: 'FINANCE', decision: 'PENDING', decidedAt: null, reason: null },
      ],
      approvedAt: null, rejectedAt: null, rejectionReason: null, createdAt: '2026-09-30T11:00:00.000Z',
      actions: { canSubmit: false, canApprove: true, canReject: true },
    };
    let decision: Record<string, unknown> | null = null;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') {
        decision = requestBody(init);
        return Promise.resolve(jsonResponse({ purchaseOrder: { ...purchaseOrder, status: 'APPROVED', version: 2, approvedAt: '2026-09-30T11:20:00.000Z', actions: { canSubmit: false, canApprove: false, canReject: false } } }));
      }
      return Promise.resolve(jsonResponse({ kind: 'PURCHASE_ORDER', purchaseOrder }));
    });
    renderPage();
    expect(await screen.findByText('Order approver')).toBeInTheDocument();
    expect(screen.getByText('Finance approval')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Decision note (required when rejecting)'), 'Budget checked');
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => { expect(decision).toMatchObject({ expectedVersion: 1, approved: true, reason: 'Budget checked' }); });
  });
});

import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { ProductPage } from '@/pages/ProductPage';
import { RfqEditPage } from './RfqEditPage';
import { jsonResponse, renderWithProviders } from '@/test/harness';
import { makeProduct } from '@/test/fixtures';
import { FALLBACK_CONFIG } from '@/app/storefront-context';
import { EMPTY_REQUIREMENT, type BuyerRfq, type RfqDraftInput } from '@/lib/rfq';
const fetchMock = vi.fn();
const OPTIONS = { unitsOfMeasure: ['BOX'], incoterms: ['CIF'], sampleRequirements: ['NONE'], inspectionRequirements: ['NONE'], maxResponseDays: 90, maxInvitedSuppliers: 50, attachments: { available: true, reason: null, maxBytes: 10_485_760, maxFiles: 40, types: ['application/pdf'] } };
function rfq(overrides: Partial<BuyerRfq> = {}): BuyerRfq {
  return {
    id: '01RFQ00000000000000000000A',
    reference: 'RFQ-2026-000042',
    status: 'OPEN',
    version: 1,
    isPastDeadline: false,
    requirement: { ...EMPTY_REQUIREMENT, title: 'Nitrile gloves', quantity: '12000', unitOfMeasure: 'BOX', responseDeadline: '2026-11-01T12:00:00.000Z' },
    targetPrice: null,
    category: { id: 'cat', name: 'Gloves' },
    owner: { kind: 'INDIVIDUAL' },
    currentRequirementVersion: 1,
    matchOutcome: 'NO_MATCH',
    matchedSupplierCount: 0,
    selection: { include: [], exclude: [] },
    invitations: [
      {
        id: 'inv1',
        source: 'BUYER_SELECTED',
        status: 'VIEWED',
        invitedAt: '2026-10-01T00:00:00.000Z',
        viewedAt: '2026-10-02T00:00:00.000Z',
        respondedAt: null,
        declineReason: null,
        supplier: {
          sellerAccountId: 's1',
          displayName: 'Gamma Supplies',
          slug: 'gamma',
          registrationCountry: 'IN',
          verifiedAt: '2026-01-01T00:00:00.000Z',
          matchesCategory: false,
        },
      },
    ],
    attachments: [],
    attachmentPolicy: OPTIONS.attachments,
    versions: [{ versionNumber: 1, changedFields: [], changeSummary: null, createdAt: '2026-10-01T00:00:00.000Z' }],
    timeline: [],
    submittedAt: '2026-10-01T00:00:00.000Z',
    closedAt: null,
    cancelledAt: null,
    statusReason: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    actions: { canEdit: false, canSubmit: false, canCancel: true, canClose: true, canInvite: true, canAmend: true },
    ...overrides,
  };
}

beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });
function flow(enabled = true): { drafts: RfqDraftInput[]; submitted: ReturnType<typeof vi.fn>; uploads: File[] } {
 const drafts: RfqDraftInput[] = [], submitted = vi.fn(), uploads: File[] = [];
 let current = rfq({ status: 'DRAFT', version: 0, submittedAt: null, requirement: { ...EMPTY_REQUIREMENT, title: 'Custom gloves', categoryId: 'cat' }, actions: { canEdit: true, canSubmit: true, canCancel: true, canClose: false, canInvite: false, canAmend: false } });
 fetchMock.mockImplementation((url: string, init?: RequestInit) => {
  if (url.includes('/catalog/products/')) return Promise.resolve(jsonResponse({ product: makeProduct({ name: 'Nitrile gloves', category: { id: 'cat', name: 'Gloves', slug: 'gloves' } }) }));
  if (url.includes('/form-options')) return Promise.resolve(jsonResponse(OPTIONS));
  if (url.includes('/catalog/categories')) return Promise.resolve(jsonResponse({ categories: [{ id: 'cat', name: 'Gloves', children: [] }] }));
  if (url.endsWith('/attachments') && init?.method === 'POST') {
   const file = (init.body as FormData).get('file'); if (!(file instanceof File)) throw new Error('Missing drawing'); uploads.push(file);
   const attachment = { id: 'drawing1', purpose: 'REQUIREMENT' as const, fileName: file.name, contentType: file.type, byteSize: file.size, requirementVersion: null, quoteVersionId: null, uploadedBy: 'BUYER' as const, createdAt: '2026-10-03T00:00:00Z' }; current = { ...current, attachments: [attachment] }; return Promise.resolve(jsonResponse({ attachment }, 201));
  }
  if (url.endsWith('/submit')) { submitted(); return Promise.resolve(jsonResponse({ rfq: { ...current, status: 'OPEN' } })); }
  if (init?.method === 'POST' || init?.method === 'PUT') {
   if (typeof init.body !== 'string') throw new Error('Missing draft body'); const body = JSON.parse(init.body) as RfqDraftInput; drafts.push(body); current = { ...current, version: current.version + 1, requirement: { ...current.requirement, ...body } }; return Promise.resolve(jsonResponse({ rfq: current }));
  }
  return Promise.resolve(jsonResponse({ rfq: current }));
 });
 renderWithProviders(<Routes><Route path="/product/:slug" element={<ProductPage />} /><Route path="/account/rfqs/new" element={<RfqEditPage />} /><Route path="/account/rfqs/:id/edit" element={<RfqEditPage />} /><Route path="/account/rfqs/:id" element={<p>OEM request sent</p>} /></Routes>, { route: '/product/nitrile-gloves', config: { ...FALLBACK_CONFIG, features: { ...FALLBACK_CONFIG.features, rfq: enabled } } }); return { drafts, submitted, uploads };
}
describe('private label and OEM request', () => {
 it('captures custom branding, packaging, drawing and volume from the product CTA and preserves them through save and send', async () => {
  const calls = flow(); await userEvent.click(await screen.findByRole('link', { name: 'Request private label / OEM' }));
  expect(await screen.findByRole('heading', { name: 'Private label / OEM request' })).toBeInTheDocument(); expect(screen.getByLabelText(/^Title/)).toHaveValue('Private label / OEM: Nitrile gloves');
  await userEvent.type(screen.getByRole('textbox', { name: 'Branding requirements' }), 'Acme logo in blue'); await userEvent.type(screen.getByRole('textbox', { name: 'Packaging requirements' }), 'Recycled cartons, 100 per box');
  await userEvent.type(screen.getByLabelText(/^Drawing \/ custom specification/), 'Drawing revision A: powder-free, 0.08 mm, blue'); await userEvent.type(screen.getByLabelText(/^Target volume/), '500'); await userEvent.selectOptions(screen.getByLabelText(/^Unit of measure/), 'BOX');
  expect(calls.drafts).toHaveLength(0); expect(calls.submitted).not.toHaveBeenCalled(); await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
  await waitFor(() => { expect(calls.drafts).toHaveLength(1); }); expect(calls.drafts[0]).toMatchObject({ title: 'Private label / OEM: Nitrile gloves', categoryId: 'cat', quantity: '500', unitOfMeasure: 'BOX', specification: 'Drawing revision A: powder-free, 0.08 mm, blue', specs: [{ key: 'Branding requirements', value: 'Acme logo in blue' }, { key: 'Packaging requirements', value: 'Recycled cartons, 100 per box' }] });
  const branding = await screen.findByRole('textbox', { name: 'Branding requirements' }); expect(branding).toHaveValue('Acme logo in blue'); expect(screen.getByLabelText(/^Target volume/)).toHaveValue('500');
  const input = await screen.findByLabelText('Add a file'); fireEvent.change(input, { target: { files: [new File(['%PDF-1.7 drawing fixture'], 'drawing-revision-A.pdf', { type: 'application/pdf' })] } }); expect(await screen.findByRole('link', { name: /drawing-revision-A.pdf/ })).toBeInTheDocument(); expect(calls.uploads).toHaveLength(1);
  await userEvent.click(screen.getByRole('button', { name: 'Send to suppliers' })); expect(await screen.findByText('OEM request sent')).toBeInTheDocument(); expect(calls.submitted).toHaveBeenCalledOnce(); expect(calls.drafts).toHaveLength(2); expect(calls.drafts[1]).toMatchObject({ quantity: '500', specification: 'Drawing revision A: powder-free, 0.08 mm, blue', specs: calls.drafts[0]?.specs });
 }, 20_000);
 it('refuses an invalid target-volume decimal before any draft or request is sent', async () => {
  const calls = flow(); await userEvent.click(await screen.findByRole('link', { name: 'Request private label / OEM' })); await userEvent.type(await screen.findByLabelText(/^Target volume/), '1.2345'); await userEvent.click(screen.getByRole('button', { name: 'Save draft' })); expect(await screen.findAllByText(/at most three decimal places/)).not.toHaveLength(0); expect(calls.drafts).toHaveLength(0); expect(calls.submitted).not.toHaveBeenCalled();
 });
 it('keeps the OEM action unavailable when requests for quotation are switched off', async () => {
  flow(false); await screen.findByRole('heading', { name: 'Nitrile gloves' }); expect(screen.queryByRole('link', { name: 'Request private label / OEM' })).not.toBeInTheDocument();
 });
});

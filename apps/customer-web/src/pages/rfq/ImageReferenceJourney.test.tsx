import { useState } from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { ImageSearchDialog } from '@/components/hero-search/ImageSearchDialog';
import { ProductPage } from '@/pages/ProductPage';
import { RfqEditPage } from './RfqEditPage';
import { jsonResponse, renderWithProviders } from '@/test/harness';
import { FALLBACK_CONFIG } from '@/app/storefront-context';
import { makeProduct } from '@/test/fixtures';
import { EMPTY_REQUIREMENT, type BuyerRfq } from '@/lib/rfq';
const fetchMock = vi.fn();
const OPTIONS = { unitsOfMeasure: ['BOX'], incoterms: ['CIF'], sampleRequirements: ['NONE'], inspectionRequirements: ['NONE'], maxResponseDays: 90, maxInvitedSuppliers: 50, attachments: { available: true, reason: null, maxBytes: 10_485_760, maxFiles: 40, types: ['image/png'] } };
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

const IMAGE = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'searched-original.png', { type: 'image/png' });
function Search(): React.JSX.Element { const [open, setOpen] = useState(true); return <ImageSearchDialog isOpen={open} onClose={() => { setOpen(false); }} />; }
function Seed(): React.JSX.Element { return <Link to="/account/rfqs/new?title=Nitrile%20gloves&categoryId=cat" state={{ rfqImageReference: IMAGE }}>Start reference draft</Link>; }
function Location(): React.JSX.Element { const location = useLocation(); return <output data-testid="location">{location.pathname}|{location.state === null ? 'cleared' : 'retained'}</output>; }
function renderFlow(start = '/search'): void { renderWithProviders(<><Location /><Routes><Route path="/search" element={<Search />} /><Route path="/seed" element={<Seed />} /><Route path="/product/:slug" element={<ProductPage />} /><Route path="/account/rfqs/new" element={<RfqEditPage />} /><Route path="/account/rfqs/:id/edit" element={<RfqEditPage />} /><Route path="/account/rfqs/:id" element={<p>Sent request</p>} /></Routes></>, { route: start, config: { ...FALLBACK_CONFIG, features: { ...FALLBACK_CONFIG.features, rfq: true } } }); }
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); window.scrollTo = vi.fn(); Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:reference') }); Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() }); });
afterEach(() => { vi.unstubAllGlobals(); Reflect.deleteProperty(URL, 'createObjectURL'); Reflect.deleteProperty(URL, 'revokeObjectURL'); });
function mockApi(failFirstUpload = false, available = true): { uploads: File[]; submit: ReturnType<typeof vi.fn> } {
 const uploads: File[] = [], submit = vi.fn(); const draft = rfq({ status: 'DRAFT', version: 0, actions: { canEdit: true, canSubmit: true, canCancel: true, canClose: false, canInvite: false, canAmend: false }, requirement: { ...EMPTY_REQUIREMENT, title: 'Nitrile gloves', categoryId: 'cat' } });
 fetchMock.mockImplementation((url: string, init?: RequestInit) => {
  if (url.includes('/image-search')) return Promise.resolve(jsonResponse({ description: 'Nitrile gloves', terms: ['gloves'], products: [makeProduct({ name: 'Nitrile gloves', slug: 'nitrile-gloves', category: { id: 'cat', name: 'Gloves', slug: 'gloves' } })], currency: 'INR', country: 'IN' }));
  if (url.includes('/form-options')) return Promise.resolve(jsonResponse({ ...OPTIONS, attachments: { ...OPTIONS.attachments, available } }));
  if (url.includes('/catalog/categories')) return Promise.resolve(jsonResponse({ categories: [{ id: 'cat', name: 'Gloves', children: [] }] }));
  if (url.includes('/catalog/products/')) return Promise.resolve(jsonResponse({ product: makeProduct({ name: 'Nitrile gloves', category: { id: 'cat', name: 'Gloves', slug: 'gloves' } }) }));
  if (url.endsWith('/attachments') && init?.method === 'POST') {
   const file = (init.body as FormData).get('file'); if (!(file instanceof File)) throw new Error('Original file was not posted'); uploads.push(file);
   if (failFirstUpload && uploads.length === 1) return Promise.resolve(jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Upload failed.' } }, 500));
   return Promise.resolve(jsonResponse({ attachment: { id: 'image1', purpose: 'REQUIREMENT', fileName: file.name, contentType: file.type, byteSize: file.size, requirementVersion: null, quoteVersionId: null, uploadedBy: 'BUYER', createdAt: '2026-10-03T00:00:00Z' } }));
  }
  if (url.endsWith('/submit')) { submit(); return Promise.resolve(jsonResponse({ rfq: { ...draft, status: 'OPEN' } })); }
  return Promise.resolve(jsonResponse({ rfq: draft }));
 }); return { uploads, submit };
}
describe('image search reference to RFQ', () => {
 it('retains the original through match, product and saved draft; retries a refused upload before allowing send', async () => {
  const calls = mockApi(true); renderFlow(); const input = document.querySelector<HTMLInputElement>('input[type="file"]:not([capture])'); if (input === null) throw new Error('Missing image input');
  fireEvent.change(input, { target: { files: [IMAGE] } }); await userEvent.click(screen.getByRole('button', { name: 'Search with this image' }));
  await userEvent.click(await screen.findByRole('link', { name: 'Nitrile gloves' })); await userEvent.click(await screen.findByRole('link', { name: 'Need a different quantity or terms? Request quotes' }));
  expect(await screen.findByText(/Image from your search: searched-original.png/)).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Send to suppliers' })).toBeDisabled(); expect(screen.getByRole('button', { name: 'Attach searched image' })).toBeDisabled(); expect(calls.uploads).toHaveLength(0);
  const title = screen.getByLabelText(/^Title/); expect(title).toHaveValue('Nitrile gloves'); const form = title.closest('form'); if (form === null) throw new Error('Missing form'); fireEvent.submit(form); expect(await screen.findByText('Attach or discard the searched image before sending this request.')).toBeInTheDocument(); expect(calls.submit).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Save draft' })); await waitFor(() => { expect(screen.getByTestId('location')).toHaveTextContent('/edit|retained'); });
  await userEvent.click(await screen.findByRole('button', { name: 'Attach searched image' })); await waitFor(() => { expect(calls.uploads).toHaveLength(1); }); await waitFor(() => { expect(screen.getByRole('button', { name: 'Attach searched image' })).toBeEnabled(); }); expect(screen.getByRole('button', { name: 'Send to suppliers' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: 'Attach searched image' })); expect(await screen.findByRole('link', { name: /searched-original.png/ })).toBeInTheDocument(); await waitFor(() => { expect(screen.getByTestId('location')).toHaveTextContent('/edit|cleared'); }); expect(calls.uploads).toHaveLength(2); expect(calls.uploads[1]).toBe(IMAGE); expect(screen.queryByRole('button', { name: 'Attach searched image' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Send to suppliers' })); expect(await screen.findByText('Sent request')).toBeInTheDocument(); expect(calls.submit).toHaveBeenCalledOnce();
 });
 it('allows explicit discard when scanning/storage is unavailable, without silently sending or uploading', async () => {
  const calls = mockApi(false, false); renderFlow('/seed'); await userEvent.click(screen.getByRole('link', { name: 'Start reference draft' })); expect(await screen.findByRole('button', { name: 'Send to suppliers' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: 'Save draft' })); await waitFor(() => { expect(screen.getByTestId('location')).toHaveTextContent('/edit|retained'); }); expect(await screen.findByRole('button', { name: 'Attach searched image' })).toBeDisabled(); await userEvent.click(screen.getByRole('button', { name: 'Discard image reference' })); expect(screen.getByRole('button', { name: 'Send to suppliers' })).toBeEnabled(); expect(screen.getByTestId('location')).toHaveTextContent('/edit|cleared'); expect(calls.uploads).toHaveLength(0); expect(calls.submit).not.toHaveBeenCalled();
 });
});

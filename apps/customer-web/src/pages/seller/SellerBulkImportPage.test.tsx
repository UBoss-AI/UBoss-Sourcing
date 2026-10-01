/**
 * Master row 37: Seller Hub bulk update.
 *
 *   - a file with problems lists each one by row and offers no "apply";
 *   - a clean preview lists the changes and applies the previewed job.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Outlet, Route, Routes } from 'react-router-dom';
import { renderWithProviders } from '@/test/harness';
import type { SellerImportView } from '@/lib/seller-workbench';
import { SellerBulkImportPage } from './SellerBulkImportPage';

vi.mock('@/lib/seller-workbench', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/seller-workbench')>();
  return {
    ...actual,
    fetchSellerImports: vi.fn(() => Promise.resolve([])),
    uploadSellerImport: vi.fn(),
    applySellerImport: vi.fn(),
  };
});

const workbench = await import('@/lib/seller-workbench');
const uploadSellerImport = vi.mocked(workbench.uploadSellerImport);
const applySellerImport = vi.mocked(workbench.applySellerImport);

function view(overrides: Partial<SellerImportView> = {}): SellerImportView {
  return {
    job: {
      id: '01JOB00000000000000000001',
      status: 'SUCCEEDED',
      isDryRun: true,
      fileName: 'prices.csv',
      fileFormat: 'CSV',
      totalRows: 2,
      validRows: 2,
      invalidRows: 0,
      updatedRows: 0,
      sourceJobId: null,
      createdAt: '2026-10-01T09:00:00.000Z',
      finishedAt: null,
    },
    appliedJobId: null,
    errors: [],
    preview: null,
    ...overrides,
  };
}

function renderPage(): void {
  renderWithProviders(
    <Routes>
      <Route element={<Outlet context={{ isTrading: true }} />}>
        <Route path="*" element={<SellerBulkImportPage />} />
      </Route>
    </Routes>,
  );
}

function choose(name: string): void {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['seller_sku\r\n'], name, { type: 'text/csv' })] } });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SellerBulkImportPage', () => {
  it('lists every problem by row and offers no apply', async () => {
    uploadSellerImport.mockResolvedValue(
      view({
        job: { ...view().job, invalidRows: 1 },
        errors: [{ rowNumber: 3, columnName: 'seller_sku', code: 'UNKNOWN_SKU', message: 'None of your listings has this SKU.', rawValue: 'X-1' }],
      }),
    );
    renderPage();
    choose('bad.csv');

    expect(await screen.findByText('None of your listings has this SKU.')).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '3' })).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows the changes and applies the previewed job', async () => {
    uploadSellerImport.mockResolvedValue(
      view({
        preview: {
          unchangedRows: 0,
          changes: [
            { rowNumber: 2, offerId: 'o1', sellerSku: 'SKU-1', currency: 'INR', price: { from: '100.00', to: '125.50' } },
          ],
        },
      }),
    );
    applySellerImport.mockResolvedValue(view({ job: { ...view().job, isDryRun: false, updatedRows: 1 } }));
    renderPage();
    choose('good.csv');

    expect(await screen.findByText('SKU-1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => {
      expect(applySellerImport).toHaveBeenCalled();
    });
    expect(applySellerImport.mock.calls[0]?.[0]).toBe('01JOB00000000000000000001');
  });
});

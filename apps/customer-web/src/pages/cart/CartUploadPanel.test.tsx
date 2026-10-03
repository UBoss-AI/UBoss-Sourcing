import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CartUploadPanel } from './CartUploadPanel';
import { jsonResponse, renderWithProviders } from '@/test/harness';

const fetchMock = vi.fn();
beforeEach(() => { vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); fetchMock.mockReset(); });

const bodyOf = (call: unknown[]) => JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>;

describe('cart SKU list upload (ENH-016)', () => {
  it('previews the file, lists problems, and adds only after confirmation in one bulk request', async () => {
    fetchMock.mockImplementation((url: string) => Promise.resolve(url.includes('upload/preview')
      ? jsonResponse({ lines: [{ row: 2, sku: 'GL-1', productId: 'P1', variantId: null, name: 'Gloves', quantity: 12 }], problems: [{ row: 3, sku: 'NOPE', code: 'SKU_UNKNOWN' }] })
      : jsonResponse({ cart: { lines: [] } })));
    renderWithProviders(<CartUploadPanel />);
    const file = new File(['sku,quantity\nGL-1,12\nNOPE,1\n'], 'order.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByLabelText('Choose a .csv or .xlsx file'), { target: { files: [file] } });
    expect(await screen.findByText('Gloves (GL-1) × 12')).toBeInTheDocument();
    expect(screen.getByText('Row 3: no product with this SKU')).toBeInTheDocument();
    const preview = fetchMock.mock.calls[0] as unknown[];
    expect(bodyOf(preview)).toMatchObject({ fileName: 'order.csv' });
    expect(atob(String(bodyOf(preview)['contentBase64']))).toContain('GL-1,12');
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/cart/items/bulk'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 lines to cart' }));
    await waitFor(() => { expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/cart/items/bulk'))).toBe(true); });
    const bulk = fetchMock.mock.calls.find((call) => String(call[0]).includes('/cart/items/bulk')) as unknown[];
    expect(bodyOf(bulk)).toEqual({ items: [{ productId: 'P1', variantId: null, quantity: 12 }] });
  });
  it('refuses a file over 1 MB without sending it', () => {
    renderWithProviders(<CartUploadPanel />);
    const big = new File([new Uint8Array(1_000_001)], 'big.csv');
    fireEvent.change(screen.getByLabelText('Choose a .csv or .xlsx file'), { target: { files: [big] } });
    expect(screen.getByRole('alert')).toHaveTextContent('The file is larger than 1 MB.');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

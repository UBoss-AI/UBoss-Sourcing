/**
 * The documents card on an admin shipment page (checklist SCREEN-057).
 *
 *   - every file is listed with its type, size, who may see it and its scan state;
 *   - a file only the marketplace can see says so;
 *   - a file that failed the malware scan is marked, not hidden;
 *   - an empty consignment says there is nothing yet;
 *   - a failed load offers a retry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { i18n } from '@/i18n/config';
import type { AdminShipmentDocument } from '@/lib/logistics';
import { ShipmentDocuments } from './ShipmentDetailPage';

vi.mock('@/lib/logistics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logistics')>();
  return { ...actual, fetchAdminShipmentDocuments: vi.fn() };
});

const api = await import('@/lib/logistics');
const fetchDocuments = vi.mocked(api.fetchAdminShipmentDocuments);

function document(overrides: Partial<AdminShipmentDocument> = {}): AdminShipmentDocument {
  return {
    id: '01DOC000000000000000000001',
    kind: 'SHIPPING_LABEL',
    audience: 'PARTNER',
    fileName: 'label.pdf',
    contentType: 'application/pdf',
    sizeBytes: 204800,
    scanState: 'CLEAN',
    isDownloadable: true,
    createdAt: '2026-09-28T10:00:00.000Z',
    ...overrides,
  };
}

function renderCard(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ShipmentDocuments shipmentId="01SHIP000000000000000000001" />
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  fetchDocuments.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('ShipmentDocuments', () => {
  it('lists each file with its type, size, audience and scan state', async () => {
    fetchDocuments.mockResolvedValue({
      documents: [
        document(),
        document({
          id: '02',
          kind: 'COMMERCIAL_INVOICE',
          audience: 'OPERATOR',
          fileName: 'invoice.pdf',
          sizeBytes: 3 * 1024 * 1024,
        }),
      ],
    });
    renderCard();

    expect(await screen.findByText('label.pdf')).toBeTruthy();
    expect(screen.getByText('invoice.pdf')).toBeTruthy();
    expect(screen.getByText('Carrier')).toBeTruthy();
    expect(screen.getByText('Marketplace only')).toBeTruthy();
    expect(screen.getAllByText('Scanned, clean').length).toBe(2);
    expect(screen.getByText(/Shipping label/i)).toBeTruthy();
    expect(screen.getByText(/200 KB/)).toBeTruthy();
    expect(screen.getByText(/3 MB/)).toBeTruthy();
    expect(fetchDocuments).toHaveBeenCalledWith('01SHIP000000000000000000001');
  });

  it('marks a file that failed the malware scan instead of hiding it', async () => {
    fetchDocuments.mockResolvedValue({
      documents: [document({ scanState: 'INFECTED', isDownloadable: false, fileName: 'bad.pdf' })],
    });
    renderCard();

    expect(await screen.findByText('bad.pdf')).toBeTruthy();
    expect(screen.getByText('Malware found')).toBeTruthy();
  });

  it('says so when there are no documents', async () => {
    fetchDocuments.mockResolvedValue({ documents: [] });
    renderCard();

    expect(await screen.findByText('No documents have been added to this consignment yet.')).toBeTruthy();
  });

  it('offers a retry when the list cannot be loaded', async () => {
    fetchDocuments.mockRejectedValueOnce(new Error('boom'));
    fetchDocuments.mockResolvedValue({ documents: [document()] });
    renderCard();

    fireEvent.click(await screen.findByRole('button', { name: /try again/i }));
    await waitFor(() => {
      expect(screen.getByText('label.pdf')).toBeTruthy();
    });
  });
});

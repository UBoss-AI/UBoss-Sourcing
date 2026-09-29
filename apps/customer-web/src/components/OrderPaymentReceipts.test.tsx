/**
 * The buyer's receipts box on the order page.
 *
 * Pinned: it lists a captured payment and a confirmed refund, each with its
 * own "Download receipt" button; pressing it fetches that receipt's PDF with
 * the session cookie in the language the page is read in; a refusal is said
 * in words; and an order with nothing paid shows no box at all.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderPaymentReceipts } from './OrderPaymentReceipts';
import { errorResponse, jsonResponse, renderWithProviders } from '@/test/harness';
import { money } from '@/test/fixtures';

const fetchMock = vi.fn();
let anchorClick: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  URL.createObjectURL = vi.fn(() => 'blob:receipt');
  URL.revokeObjectURL = vi.fn();
  // jsdom cannot navigate; the click that saves the file is the last step.
  anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const RECEIPTS = {
  receipts: [
    {
      kind: 'payment',
      sourceId: 'PAYMENT0000000000000000001',
      amount: money('53690'),
      occurredAt: '2026-09-01T10:05:00.000Z',
      receiptNumber: 'RCP-2026-000007',
      cardBrand: 'visa',
      cardLast4: '4242',
    },
    {
      kind: 'refund',
      sourceId: 'REFUND00000000000000000001',
      amount: money('1000'),
      occurredAt: '2026-09-03T10:05:00.000Z',
      receiptNumber: null,
      cardBrand: null,
      cardLast4: null,
    },
  ],
};

function urlOf(call: unknown[]): string {
  const target = call[0];
  return typeof target === 'string' ? target : target instanceof URL ? target.toString() : (target as Request).url;
}

describe('OrderPaymentReceipts', () => {
  it('lists each payment and refund with a download button, and downloads the chosen one', async () => {
    fetchMock.mockImplementation((input: unknown) => {
      const url = urlOf([input]);
      if (url.includes('/receipts/payment/')) {
        return Promise.resolve(
          new Response(new Blob(['%PDF-1.3']), {
            status: 200,
            headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="RCP-2026-000007.pdf"' },
          }),
        );
      }
      return Promise.resolve(jsonResponse(RECEIPTS));
    });

    renderWithProviders(<OrderPaymentReceipts orderId="ORDER00000000000000000001" />);

    expect(await screen.findByRole('heading', { name: 'Receipts' })).toBeInTheDocument();
    expect(screen.getByText(/Payment of/)).toBeInTheDocument();
    expect(screen.getByText(/Refund of/)).toBeInTheDocument();
    expect(screen.getByText('RCP-2026-000007')).toBeInTheDocument();

    const buttons = screen.getAllByRole('button', { name: 'Download receipt' });
    expect(buttons).toHaveLength(2);

    const first = buttons[0];
    if (first === undefined) throw new Error('no download button');
    fireEvent.click(first);

    await waitFor(() => {
      expect(fetchMock.mock.calls.some((call) => urlOf(call).includes('/orders/ORDER00000000000000000001/receipts/payment/PAYMENT0000000000000000001?lang=en'))).toBe(true);
    });
    const download = fetchMock.mock.calls.find((call) => urlOf(call).includes('/receipts/payment/'));
    expect((download?.[1] as RequestInit | undefined)?.credentials).toBe('include');
    await waitFor(() => {
      expect(anchorClick).toHaveBeenCalled();
    });
  });

  it('says why when the receipt is not available', async () => {
    fetchMock.mockImplementation((input: unknown) => {
      const url = urlOf([input]);
      if (url.includes('/receipts/refund/')) {
        return Promise.resolve(errorResponse(409, 'RECEIPT_NOT_AVAILABLE', 'not yet'));
      }
      return Promise.resolve(jsonResponse(RECEIPTS));
    });

    renderWithProviders(<OrderPaymentReceipts orderId="ORDER00000000000000000001" />);
    const buttons = await screen.findAllByRole('button', { name: 'Download receipt' });
    const second = buttons[1];
    if (second === undefined) throw new Error('no refund button');
    fireEvent.click(second);

    expect(await screen.findByText(/There is no receipt for this yet/)).toBeInTheDocument();
  });

  it('renders nothing for an order with no captured payment', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ receipts: [] })));
    const { container } = renderWithProviders(<OrderPaymentReceipts orderId="ORDER00000000000000000001" />);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(container.querySelector('section')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Download receipt' })).not.toBeInTheDocument();
  });
});

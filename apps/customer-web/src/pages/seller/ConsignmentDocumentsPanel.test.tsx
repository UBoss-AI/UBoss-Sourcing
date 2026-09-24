/**
 * The Seller Hub's invoices-and-packing-lists panel: it shows the server's
 * state and checklist, in the reader's language, and never offers to edit an
 * issued invoice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { errorResponse, jsonResponse, renderWithProviders } from '@/test/harness';
import { issueKey } from '@/lib/seller-documents';
import { ConsignmentDocumentsPanel } from './ConsignmentDocumentsPanel';

const money = (minor: string) => ({ minor, currency: 'INR', formatted: `₹${minor}` });
const TOTALS = {
  taxable: money('100000'),
  discount: money('0'),
  cgst: money('9000'),
  sgst: money('9000'),
  igst: money('0'),
  cess: money('0'),
  otherTax: money('0'),
  freight: money('5000'),
  totalTax: money('18000'),
  grandTotal: money('123000'),
};

function consignment(overrides: Record<string, unknown> = {}) {
  return {
    id: '01SHIP000000000000000000000'.slice(0, 26),
    shipmentReference: 'LS-2026-000123',
    status: 'CREATED',
    packedAt: null,
    splitFromShipmentId: null,
    packagesLocked: null,
    lines: [
      { orderItemId: 'item-1', quantity: 100, name: 'Nitrile gloves', sku: 'NG-M', hsn: null },
    ],
    packages: [
      {
        id: 'pkg-1',
        reference: 'PKG-1',
        packagingType: 'Carton',
        lengthMm: 400,
        widthMm: 300,
        heightMm: 250,
        grossWeightGrams: 6000,
        netWeightGrams: null,
        containerNumber: null,
        sealNumber: null,
        scannedOutAt: null,
        contents: [
          {
            orderItemId: 'item-1',
            quantity: 100,
            batchNumber: 'LOT-1',
            expiryDate: null,
            serialNumbers: null,
          },
        ],
      },
    ],
    invoices: [],
    packingLists: [],
    ...overrides,
  };
}

function stub(routes: Record<string, () => Response>) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : input.toString();
    for (const [fragment, respond] of Object.entries(routes)) {
      if (url.includes(fragment)) return Promise.resolve(respond());
    }
    return Promise.resolve(jsonResponse({}));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('ConsignmentDocumentsPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('translates the server checklist, naming the item that needs an HSN code', async () => {
    stub({
      '/documents': () => jsonResponse({ consignments: [consignment()] }),
      '/invoice/preview': () =>
        jsonResponse({
          invoice: {
            id: 'inv-1',
            kind: 'TAX_INVOICE',
            status: 'VALIDATION_REQUIRED',
            number: null,
            totals: TOTALS,
            validation: [
              {
                field: 'lines.0.hsn',
                code: 'REQUIRED',
                message: 'english',
                meta: { name: 'Nitrile gloves' },
              },
            ],
          },
        }),
    });
    renderWithProviders(<ConsignmentDocumentsPanel sellerOrderId="group-1" canAct />);

    fireEvent.click((await screen.findAllByRole('button', { name: 'Check' }))[0] as HTMLElement);
    expect(await screen.findByText('Fix these first:')).toBeInTheDocument();
    expect(
      screen.getByText(
        '“Nitrile gloves” has no HSN code. Add a 4, 6 or 8-digit code to the listing.',
      ),
    ).toBeInTheDocument();
  });

  it('offers a credit note, never an edit, once the invoice is issued', async () => {
    stub({
      '/documents': () =>
        jsonResponse({
          consignments: [
            consignment({
              packedAt: '2026-09-24T10:00:00.000Z',
              packagesLocked: 'PACKING_LIST_ISSUED',
              invoices: [
                {
                  id: 'inv-1',
                  kind: 'TAX_INVOICE',
                  status: 'ISSUED',
                  number: 'INV/26-27/00001',
                  totals: TOTALS,
                  validation: null,
                },
              ],
              packingLists: [
                {
                  id: 'pl-1',
                  status: 'ISSUED',
                  number: 'PL-2026-000001',
                  packageCount: 1,
                  totalBaseUnits: 100,
                  grossWeightGrams: '6000',
                  validation: null,
                },
              ],
            }),
          ],
        }),
    });
    renderWithProviders(<ConsignmentDocumentsPanel sellerOrderId="group-1" canAct />);

    expect(await screen.findByText('INV/26-27/00001')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Issue credit note' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Issue invoice' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark as packed' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit packages' })).toBeDisabled();
    expect(
      screen.getByText(
        'Packages can no longer change while the packing list stands. Replace the packing list to change them.',
      ),
    ).toBeInTheDocument();
  });

  it('shows the checklist the server returned when Mark as packed is refused', async () => {
    stub({
      '/documents': () => jsonResponse({ consignments: [consignment()] }),
      '/pack': () =>
        errorResponse(422, 'SELLER_DOCUMENT_VALIDATION_FAILED', 'The invoice cannot be issued.', [
          {
            field: 'seller.gstin',
            code: 'CHECKSUM',
            message: 'english',
            meta: { gstin: '27AAPFU0939F1ZA' },
          },
        ]),
    });
    renderWithProviders(<ConsignmentDocumentsPanel sellerOrderId="group-1" canAct />);

    fireEvent.click(await screen.findByRole('button', { name: 'Mark as packed' }));
    expect(
      await screen.findByText(
        'Your GSTIN 27AAPFU0939F1ZA is not valid: the check character does not match.',
      ),
    ).toBeInTheDocument();
  });
});

describe('issueKey', () => {
  it('folds line indexes and package references into one sentence per rule', () => {
    expect(issueKey({ field: 'lines.3.hsn', code: 'REQUIRED' })).toBe(
      'sellerDocs.issue.line.hsn.REQUIRED',
    );
    expect(issueKey({ field: 'packages.PKG-2.weight', code: 'REQUIRED' })).toBe(
      'sellerDocs.issue.package.weight.REQUIRED',
    );
    expect(issueKey({ field: 'contents.01ABC', code: 'MISMATCH' })).toBe(
      'sellerDocs.issue.contents.MISMATCH',
    );
    expect(issueKey({ field: 'seller.gstin', code: 'STATE' })).toBe(
      'sellerDocs.issue.seller.gstin.STATE',
    );
  });
});

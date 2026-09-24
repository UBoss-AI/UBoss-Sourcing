/**
 * The packing list for one consignment, as a PDF.
 *
 * A packing list travels with the goods and is read by people who have no
 * business knowing what anything cost: a warehouse, a driver, a port. So it
 * carries NO prices - identities, what is in each package, weights,
 * dimensions, batches, serials, handling and seals - and its QR carries only
 * the document number and a verification code, never the buyer's details.
 */
import { PdfBuilder } from './pdf.js';
import {
  formatCount,
  formatDay,
  formatGrams,
  qrPng,
  verificationCode,
  verificationUrl,
} from './document-format.js';

export const PACKING_LIST_TEMPLATE_VERSION = 'packing-list-1';

export interface PackingListDocument {
  number: string | null;
  issueDay: string;
  issuedAt: Date;
  shipper: { name: string; lines: string[] };
  consignee: { name: string; lines: string[] };
  origin: string[];
  destination: string[];
  facts: [string, string][];
  packages: {
    reference: string;
    type: string;
    contents: string;
    netWeightGrams: number | null;
    grossWeightGrams: number;
    dimensions: string;
    volumeCm3: number | null;
    seal: string | null;
  }[];
  lines: {
    sku: string;
    description: string;
    quantity: number;
    unitsPerCarton: number | null;
    cartonsPerPallet: number | null;
    palletsPerContainer: number | null;
    batches: string;
    serials: string;
    origin: string;
  }[];
  totals: {
    packages: number;
    pieces: number;
    netWeightGrams: number;
    grossWeightGrams: number;
    volumeCm3: number;
  };
  handling: string[];
}

export async function renderPackingList(
  document: PackingListDocument,
  options: { draft: boolean },
): Promise<{ bytes: Buffer; pageCount: number }> {
  const reference = document.number ?? 'DRAFT';
  const pdf = new PdfBuilder({
    title: `Packing list ${reference}`,
    issuedAt: document.issuedAt,
    author: document.shipper.name,
    subject: `Packing list ${reference}`,
    reference: `Packing list ${reference} · ${document.shipper.name}`,
    watermark: options.draft ? 'DRAFT PACKING LIST' : null,
  });

  pdf.title('PACKING LIST', null, null);
  pdf.facts(
    [['Packing list number', reference], ['Date', formatDay(document.issueDay)], ...document.facts],
    3,
  );

  pdf.boxes([
    { heading: 'Shipper', lines: [document.shipper.name, ...document.shipper.lines] },
    { heading: 'Consignee', lines: [document.consignee.name, ...document.consignee.lines] },
  ]);
  pdf.boxes([
    { heading: 'Despatched from', lines: document.origin },
    { heading: 'Delivered to', lines: document.destination },
  ]);

  pdf.paragraph('Packages', { bold: true });
  pdf.table(
    [
      { header: '#', weight: 2, align: 'center' },
      { header: 'Package ID', weight: 9 },
      { header: 'Type', weight: 5 },
      { header: 'Contents', weight: 17 },
      { header: 'Net', weight: 5, align: 'right' },
      { header: 'Gross', weight: 5, align: 'right' },
      { header: 'L × W × H (mm)', weight: 8 },
      { header: 'Volume (m³)', weight: 5, align: 'right' },
    ],
    [
      ...document.packages.map((pack, index) => [
        String(index + 1),
        pack.seal === null ? pack.reference : `${pack.reference}\n${pack.seal}`,
        pack.type,
        pack.contents,
        pack.netWeightGrams === null ? '—' : formatGrams(pack.netWeightGrams),
        formatGrams(pack.grossWeightGrams),
        pack.dimensions,
        pack.volumeCm3 === null ? '—' : (pack.volumeCm3 / 1_000_000).toFixed(3),
      ]),
      [
        '',
        `${formatCount(document.totals.packages)} package(s)`,
        '',
        `${formatCount(document.totals.pieces)} pieces`,
        formatGrams(document.totals.netWeightGrams),
        formatGrams(document.totals.grossWeightGrams),
        '',
        (document.totals.volumeCm3 / 1_000_000).toFixed(3),
      ],
    ],
    { fontSize: 7, boldLastRow: true },
  );

  pdf.paragraph('Goods', { bold: true });
  pdf.table(
    [
      { header: 'SKU', weight: 7 },
      { header: 'Description', weight: 15 },
      { header: 'Qty', weight: 5, align: 'right' },
      { header: 'Units / carton', weight: 5, align: 'right' },
      { header: 'Cartons / pallet', weight: 5, align: 'right' },
      { header: 'Pallets / container', weight: 5, align: 'right' },
      { header: 'Batch / lot', weight: 7 },
      { header: 'Serials', weight: 7 },
      { header: 'Origin', weight: 3.5 },
    ],
    document.lines.map((line) => [
      line.sku,
      line.description,
      formatCount(line.quantity),
      line.unitsPerCarton === null ? '—' : formatCount(line.unitsPerCarton),
      line.cartonsPerPallet === null ? '—' : formatCount(line.cartonsPerPallet),
      line.palletsPerContainer === null ? '—' : formatCount(line.palletsPerContainer),
      line.batches === '' ? '—' : line.batches,
      line.serials === '' ? '—' : line.serials,
      line.origin,
    ]),
    { fontSize: 7 },
  );

  if (document.handling.length > 0) {
    pdf.paragraph('Handling', { bold: true });
    for (const note of document.handling) pdf.paragraph(note);
  }

  const qr =
    document.number === null ? null : await qrPng(verificationUrl('packing-list', document.number));

  pdf.closing({
    qrPng: qr,
    qrCaption:
      document.number === null
        ? null
        : `Check code ${verificationCode('packing-list', document.number)}`,
    signatures: [
      {
        heading: 'Packed and released by',
        lines: [document.shipper.name, 'Name:', 'Date and time:'],
      },
      {
        heading: 'Received by carrier',
        lines: ['Carrier / driver:', 'Vehicle:', 'Date and time:'],
      },
    ],
  });

  pdf.paragraph(
    'The carrier signs above on collection to acknowledge the number of packages and their condition. This document carries no prices.',
    { muted: true, size: 7 },
  );

  return pdf.finish();
}

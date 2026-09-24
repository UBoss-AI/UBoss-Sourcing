/**
 * The seller's invoice and credit note, as a PDF.
 *
 * One template with jurisdiction-specific parts, rather than three templates
 * that drift apart:
 *
 *   IN_GST   Rule 46 of the CGST Rules - supplier and recipient GSTINs, HSN
 *            per line, place of supply with state code, CGST + SGST inside one
 *            state or IGST across states and on exports, reverse-charge
 *            indicator, amount in words, the supplier's signatory. Exports
 *            carry the LUT declaration when no IGST was charged.
 *   EU_VAT   Art. 226 of Directive 2006/112/EC - both VAT numbers, tax per
 *            rate, the reverse-charge or export wording where it applies.
 *   GENERIC  Both parties, tax per rate as charged.
 *
 * It never claims what the system has not done. There is no IRN and no GST
 * e-invoice QR: that requires registration on the Invoice Registration Portal,
 * which this software does not integrate with. The QR printed is Glovia's own
 * document check and says so.
 */
import { PdfBuilder, type Column } from './pdf.js';
import { formatAmount, formatDay, formatPlain, qrPng, verificationUrl } from './document-format.js';
import { halfRate } from '../../domain/seller-invoice.js';

export const INVOICE_TEMPLATE_VERSION = {
  IN_GST: 'in-gst-1',
  EU_VAT: 'eu-vat-1',
  GENERIC: 'generic-1',
} as const;

export interface InvoiceParty {
  name: string;
  lines: string[];
  taxLabel: string | null;
  taxNumber: string | null;
  stateLabel: string | null;
}

export interface InvoiceLineView {
  description: string;
  sku: string;
  hsn: string | null;
  quantity: number;
  unitPriceMinor: bigint;
  discountMinor: bigint;
  taxableMinor: bigint;
  ratePercent: string;
  cgstMinor: bigint;
  sgstMinor: bigint;
  igstMinor: bigint;
  taxMinor: bigint;
  totalMinor: bigint;
  orderedAs: string | null;
}

export interface InvoiceDocument {
  kind: 'TAX_INVOICE' | 'CREDIT_NOTE';
  jurisdiction: 'IN_GST' | 'EU_VAT' | 'GENERIC';
  number: string | null;
  /** The issuing seller's id: binds the QR's check code to them. */
  issuerId: string;
  issueDay: string;
  issuedAt: Date;
  creditsNumber: string | null;
  currency: string;
  supplier: InvoiceParty;
  recipient: InvoiceParty;
  shipTo: InvoiceParty;
  facts: [string, string][];
  lines: InvoiceLineView[];
  taxRows: {
    ratePercent: string;
    taxableMinor: bigint;
    cgstMinor: bigint;
    sgstMinor: bigint;
    igstMinor: bigint;
    otherMinor: bigint;
  }[];
  totals: {
    taxableMinor: bigint;
    cgstMinor: bigint;
    sgstMinor: bigint;
    igstMinor: bigint;
    cessMinor: bigint;
    otherTaxMinor: bigint;
    freightMinor: bigint;
    totalTaxMinor: bigint;
    grandTotalMinor: bigint;
  };
  amountInWords: string;
  declarations: string[];
  signatory: { forName: string; name: string | null; designation: string | null };
  footer: string;
}

function title(document: InvoiceDocument): string {
  if (document.kind === 'CREDIT_NOTE') return 'CREDIT NOTE';
  return document.jurisdiction === 'GENERIC' ? 'INVOICE' : 'TAX INVOICE';
}

function partyLines(party: InvoiceParty): string[] {
  return [
    party.name,
    ...party.lines,
    ...(party.taxNumber === null ? [] : [`${party.taxLabel ?? 'Tax number'}: ${party.taxNumber}`]),
    ...(party.stateLabel === null ? [] : [party.stateLabel]),
  ];
}

export async function renderInvoice(
  document: InvoiceDocument,
  options: { draft: boolean },
): Promise<{ bytes: Buffer; pageCount: number }> {
  const reference = document.number ?? 'DRAFT';
  const pdf = new PdfBuilder({
    title: `${title(document)} ${reference}`,
    issuedAt: document.issuedAt,
    author: document.supplier.name,
    subject: `${title(document)} ${reference}`,
    reference: `${title(document)} ${reference} · ${document.supplier.name}`,
    watermark: options.draft ? 'DRAFT — NOT A TAX INVOICE' : null,
  });

  pdf.title(
    title(document),
    document.creditsNumber === null ? null : `Against invoice ${document.creditsNumber}`,
    document.jurisdiction === 'IN_GST' ? 'ORIGINAL FOR RECIPIENT' : null,
  );

  pdf.facts(
    [
      [document.kind === 'CREDIT_NOTE' ? 'Credit note number' : 'Invoice number', reference],
      [
        document.kind === 'CREDIT_NOTE' ? 'Credit note date' : 'Invoice date',
        formatDay(document.issueDay),
      ],
      ['Currency', document.currency],
      ...document.facts,
    ],
    3,
  );

  pdf.boxes([
    { heading: 'Supplier', lines: partyLines(document.supplier) },
    { heading: 'Bill to', lines: partyLines(document.recipient) },
    { heading: 'Ship to', lines: partyLines(document.shipTo) },
  ]);

  const gst = document.jurisdiction === 'IN_GST';
  const intra = gst && document.totals.cgstMinor + document.totals.sgstMinor !== 0n;
  const money = (value: bigint) => formatPlain(value, document.currency);

  const columns: Column[] = [
    { header: '#', weight: 2.2, align: 'center' },
    { header: 'Description', weight: 16 },
    ...(gst ? [{ header: 'HSN', weight: 5.5 }] : []),
    { header: 'Qty', weight: 5, align: 'right' as const },
    { header: 'UoM', weight: 3.4 },
    { header: 'Unit price', weight: 7, align: 'right' as const },
    { header: 'Discount', weight: 6, align: 'right' as const },
    { header: 'Taxable value', weight: 8, align: 'right' as const },
    { header: 'Rate', weight: 4, align: 'right' as const },
    ...(gst
      ? intra
        ? [
            { header: 'CGST', weight: 6.5, align: 'right' as const },
            { header: 'SGST', weight: 6.5, align: 'right' as const },
          ]
        : [{ header: 'IGST', weight: 7, align: 'right' as const }]
      : [{ header: 'Tax', weight: 7, align: 'right' as const }]),
    { header: 'Total', weight: 8, align: 'right' as const },
  ];

  const rows = document.lines.map((line, index) => [
    String(index + 1),
    [
      line.description,
      `SKU ${line.sku}`,
      ...(line.orderedAs === null ? [] : [line.orderedAs]),
    ].join('\n'),
    ...(gst ? [line.hsn ?? '—'] : []),
    new Intl.NumberFormat('en-IN').format(line.quantity),
    'PCS',
    money(line.unitPriceMinor),
    money(line.discountMinor),
    money(line.taxableMinor),
    `${line.ratePercent}%`,
    ...(gst
      ? intra
        ? [
            `${money(line.cgstMinor)}\n@${halfRate(line.ratePercent)}%`,
            `${money(line.sgstMinor)}\n@${halfRate(line.ratePercent)}%`,
          ]
        : [money(line.igstMinor)]
      : [money(line.taxMinor)]),
    money(line.totalMinor),
  ]);

  pdf.table(columns, rows, { fontSize: 7 });

  // Tax per rate, which Rule 46 and Art. 226(8)-(10) both require as a figure
  // per rate rather than one combined total.
  pdf.paragraph('Tax summary', { bold: true });
  pdf.table(
    [
      { header: 'Rate', weight: 3, align: 'right' },
      { header: 'Taxable value', weight: 6, align: 'right' },
      ...(gst
        ? intra
          ? [
              { header: 'CGST', weight: 5, align: 'right' as const },
              { header: 'SGST', weight: 5, align: 'right' as const },
            ]
          : [{ header: 'IGST', weight: 5, align: 'right' as const }]
        : [{ header: 'Tax', weight: 5, align: 'right' as const }]),
    ],
    document.taxRows.map((row) => [
      `${row.ratePercent}%`,
      money(row.taxableMinor),
      ...(gst
        ? intra
          ? [money(row.cgstMinor), money(row.sgstMinor)]
          : [money(row.igstMinor)]
        : [money(row.otherMinor)]),
    ]),
    { fontSize: 7.5 },
  );

  const t = document.totals;
  pdf.totals([
    { label: 'Total taxable value', value: formatAmount(t.taxableMinor, document.currency) },
    ...(gst
      ? intra
        ? [
            { label: 'CGST', value: formatAmount(t.cgstMinor, document.currency) },
            { label: 'SGST', value: formatAmount(t.sgstMinor, document.currency) },
          ]
        : [{ label: 'IGST', value: formatAmount(t.igstMinor, document.currency) }]
      : [{ label: 'Tax', value: formatAmount(t.otherTaxMinor, document.currency) }]),
    ...(gst ? [{ label: 'Cess', value: formatAmount(t.cessMinor, document.currency) }] : []),
    { label: 'Total tax', value: formatAmount(t.totalTaxMinor, document.currency) },
    ...(t.freightMinor === 0n
      ? []
      : [
          {
            label: 'Freight, as charged on the order',
            value: formatAmount(t.freightMinor, document.currency),
          },
        ]),
    {
      label: document.kind === 'CREDIT_NOTE' ? 'Total credited' : 'Grand total',
      value: formatAmount(t.grandTotalMinor, document.currency),
      strong: true,
    },
  ]);

  pdf.paragraph(`Amount in words: ${document.amountInWords}`, { bold: true });
  for (const declaration of document.declarations) pdf.paragraph(declaration, { muted: true });

  const qr =
    document.number === null
      ? null
      : await qrPng(verificationUrl('invoice', document.number, document.issuerId));

  pdf.closing({
    qrPng: qr,
    qrCaption: qr === null ? null : 'Glovia document check.\nNot a GST e-invoice QR.',
    signatures: [
      {
        heading: `For ${document.signatory.forName}`,
        lines: [
          document.signatory.name ?? '',
          document.signatory.designation ?? 'Authorised Signatory',
        ],
      },
    ],
  });

  pdf.paragraph(document.footer, { muted: true, size: 7 });

  return pdf.finish();
}

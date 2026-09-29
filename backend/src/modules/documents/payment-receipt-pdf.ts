/**
 * A payment or refund receipt, as a PDF.
 *
 * One page, drawn with the same toolkit as the invoices so it looks like it
 * came from the same place. What it carries is exactly what JOURNEY-023 asks
 * a buyer to be able to keep: the receipt number, the order, when, how much,
 * how it was paid, the provider's reference, the status, and where to ask.
 * Nothing on it names this product - the issuer is the operator's own trading
 * name, frozen on the receipt row when it was issued.
 */
import type { SupportedLanguage } from '../identity/language.service.js';
import { formatAmount } from './document-format.js';
import { PdfBuilder } from './pdf.js';
import { fill, receiptText } from './receipt-text.js';

export const PAYMENT_RECEIPT_TEMPLATE_VERSION = 'payment-receipt-1';

export interface PaymentReceiptDocument {
  kind: 'PAYMENT' | 'REFUND';
  receiptNumber: string;
  issuedAt: Date;
  orderNumber: string;
  /** When the money moved: captured, or the refund completed. */
  occurredAt: Date;
  amountMinor: bigint;
  currency: string;
  method: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  providerReference: string | null;
  /** On a refund receipt: the payment it went back against. */
  originalPaymentReference: string | null;
  payerName: string | null;
  issuer: {
    marketplaceName: string;
    legalName: string;
    supportEmail: string;
    supportPhone: string | null;
    timezone: string;
  };
}

const LOCALE: Record<SupportedLanguage, string> = {
  en: 'en-GB',
  de: 'de-DE',
  el: 'el-GR',
  es: 'es-ES',
  fr: 'fr-FR',
  it: 'it-IT',
  nl: 'nl-NL',
  pl: 'pl-PL',
};

function formatInstant(at: Date, language: SupportedLanguage, timezone: string): string {
  let zone = timezone;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
  } catch {
    zone = 'UTC';
  }
  const text = new Intl.DateTimeFormat(LOCALE[language], {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: zone,
  }).format(at);
  return `${text} (${zone})`;
}

/** "Visa •••• 4242", "Card", or null when nothing is known. */
function cardLabel(brand: string | null, last4: string | null): string | null {
  if (brand === null && last4 === null) return null;
  const name = brand === null ? '' : brand.charAt(0).toUpperCase() + brand.slice(1);
  return last4 === null ? name : `${name} •••• ${last4}`.trim();
}

export async function renderPaymentReceipt(
  document: PaymentReceiptDocument,
  language: SupportedLanguage,
): Promise<{ bytes: Buffer; pageCount: number }> {
  const text = receiptText(language);
  const { issuer } = document;
  const title = document.kind === 'PAYMENT' ? text.paymentTitle : text.refundTitle;
  const amount = formatAmount(document.amountMinor, document.currency);

  const pdf = new PdfBuilder({
    title: `${title} ${document.receiptNumber}`,
    issuedAt: document.issuedAt,
    author: issuer.marketplaceName,
    subject: `${title} ${document.receiptNumber} · ${document.orderNumber}`,
    reference: `${document.receiptNumber} · ${issuer.marketplaceName}`,
    watermark: null,
  });

  pdf.title(title, issuer.marketplaceName, document.receiptNumber);
  pdf.facts(
    [
      [text.receiptNumber, document.receiptNumber],
      [text.issued, formatInstant(document.issuedAt, language, issuer.timezone)],
      [text.orderNumber, document.orderNumber],
    ],
    3,
  );

  pdf.paragraph(
    fill(document.kind === 'PAYMENT' ? text.paymentSentence : text.refundSentence, {
      marketplace: issuer.marketplaceName,
    }),
  );

  const card = cardLabel(document.cardBrand, document.cardLast4);
  const rows: [string, string][] = [
    [text.date, formatInstant(document.occurredAt, language, issuer.timezone)],
    [text.status, document.kind === 'PAYMENT' ? text.statusPaid : text.statusRefunded],
    [text.method, document.method ?? text.unknown],
    ...(card === null ? [] : ([[text.card, card]] as [string, string][])),
    [text.providerReference, document.providerReference ?? text.unknown],
    ...(document.kind === 'REFUND'
      ? ([[text.originalPayment, document.originalPaymentReference ?? text.unknown]] as [string, string][])
      : []),
  ];
  pdf.facts(rows, 2);

  pdf.totals([{ label: `${text.amount} (${document.currency})`, value: amount, strong: true }]);

  pdf.boxes([
    {
      heading: text.issuedBy,
      lines: [issuer.marketplaceName, ...(issuer.legalName !== issuer.marketplaceName ? [issuer.legalName] : [])],
    },
    ...(document.payerName === null ? [] : [{ heading: text.receivedFrom, lines: [document.payerName] }]),
  ]);

  const contact = issuer.supportPhone === null ? issuer.supportEmail : `${issuer.supportEmail} · ${issuer.supportPhone}`;
  pdf.paragraph(text.support, { bold: true });
  pdf.paragraph(fill(text.supportLine, { marketplace: issuer.marketplaceName, contact }));
  pdf.paragraph(text.notInvoice, { muted: true, size: 7.5 });

  return pdf.finish();
}

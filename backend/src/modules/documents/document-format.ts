/**
 * How figures are written on an issued document, and the check code on it.
 *
 * Documents are issued in English - the legal language of an Indian GST
 * invoice, and the common one of a packing list read at a port - with amounts
 * and dates formatted for the seller's jurisdiction: an Indian invoice groups
 * digits in lakhs and crores (₹9,61,800.50), a European one does not. The
 * figure itself is the stored minor-unit integer, formatted from a decimal
 * STRING so no float ever touches it.
 */
import { createHmac } from 'node:crypto';

import { env } from '../../config/env.js';
import { formatMinorToMajor } from '../../domain/money.js';
import QRCode from 'qrcode';

export function documentLocale(currency: string): string {
  return currency.toUpperCase() === 'INR' ? 'en-IN' : 'en-GB';
}

/** "₹9,61,800.50" for rupees, "€1,234.56" for everything else. */
export function formatAmount(minor: bigint, currency: string): string {
  const decimal = formatMinorToMajor(minor, currency);
  return new Intl.NumberFormat(documentLocale(currency), {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(decimal as unknown as number);
}

/** The amount without its symbol, for a table column headed with the currency. */
export function formatPlain(minor: bigint, currency: string): string {
  const decimal = formatMinorToMajor(minor, currency);
  return new Intl.NumberFormat(documentLocale(currency), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(decimal as unknown as number);
}

export function formatCount(value: number, currency = 'INR'): string {
  return new Intl.NumberFormat(documentLocale(currency)).format(value);
}

/** A calendar day, "24 Sep 2026", read in UTC so it cannot shift a day. */
export function formatDay(day: string): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, date)));
}

export function formatGrams(grams: bigint | number): string {
  const value = typeof grams === 'bigint' ? Number(grams) : grams;
  return `${new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value / 1000)} kg`;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export type VerifiableKind = 'invoice' | 'packing-list';

/**
 * A 16-character code that proves a document number was issued here.
 *
 * An HMAC over the kind, the number and - for an invoice - the seller that
 * issued it, keyed from the session secret this deployment already guards.
 * Invoice numbers are unique per SELLER, not across the marketplace: two
 * sellers can both issue INV/26-27/00001, and a code over the number alone
 * would let the check name the wrong one. Packing-list numbers are global. Printed in the QR with the number; the public
 * check endpoint recomputes it. It carries nothing about the buyer - a QR on a
 * carton is read by strangers.
 */
export function verificationCode(kind: VerifiableKind, number: string, issuerId = ''): string {
  return createHmac('sha256', `document-verification:${env.SESSION_COOKIE_SECRET}`)
    .update(issuerId === '' ? `${kind}:${number}` : `${kind}:${issuerId}:${number}`)
    .digest('hex')
    .slice(0, 16)
    .toUpperCase();
}

export function verificationUrl(kind: VerifiableKind, number: string, issuerId = ''): string {
  const base = env.CUSTOMER_WEB_PUBLIC_URL.replace(/\/$/, '');
  return `${base}/verify-document?kind=${kind}&number=${encodeURIComponent(number)}&code=${verificationCode(kind, number, issuerId)}`;
}

/** The QR as a PNG. Deterministic for a given text, so the PDF hash is too. */
export async function qrPng(text: string): Promise<Buffer> {
  return QRCode.toBuffer(text, { type: 'png', errorCorrectionLevel: 'M', margin: 1, width: 240 });
}

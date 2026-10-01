/**
 * Quotes on a request for quotation, and the offers inside them
 * (checklist Master rows 18 and 19).
 *
 * A QUOTE is one seller's answer to one request. It is a chain of immutable
 * OFFER VERSIONS: the seller's first terms are version 1, and every counter
 * from either side is a new version that supersedes the one before. Nothing
 * in a version is ever edited; a changed term is a new version.
 *
 *   quote:   OPEN ──accept──► ACCEPTED
 *              ├──reject────► REJECTED
 *              ├──withdraw──► WITHDRAWN   (the seller)
 *              └──(another quote accepted, or the request closed) ► CLOSED (system)
 *
 *   version: PROPOSED ──counter──► SUPERSEDED
 *                     ├─accept──► ACCEPTED
 *                     ├─reject──► REJECTED
 *                     ├─withdraw► WITHDRAWN
 *                     └─closed──► CLOSED
 *
 * Only the side that did NOT write a version may accept or reject it, and an
 * expired version can be countered but never accepted.
 *
 * The terms are hashed in one canonical form (`offerTermsHash`), and
 * accepting names the hash the accepter was shown: terms that changed in
 * between cannot be accepted by accident, and the accepted hash is what a
 * later purchase order would have to match.
 */
import { createHash } from 'node:crypto';
import { ErrorCode, conflict } from './errors.js';

export const RfqQuoteStatusValues = ['OPEN', 'ACCEPTED', 'REJECTED', 'WITHDRAWN', 'CLOSED'] as const;
export type RfqQuoteStatusName = (typeof RfqQuoteStatusValues)[number];

export const RfqOfferStateValues = ['PROPOSED', 'SUPERSEDED', 'ACCEPTED', 'REJECTED', 'WITHDRAWN', 'CLOSED'] as const;
export type RfqOfferStateName = (typeof RfqOfferStateValues)[number];

export type QuoteActor = 'BUYER' | 'SUPPLIER' | 'SYSTEM';

const QUOTE_TRANSITIONS: Readonly<Record<RfqQuoteStatusName, readonly { to: RfqQuoteStatusName; actors: readonly QuoteActor[] }[]>> =
  Object.freeze({
    OPEN: [
      { to: 'ACCEPTED', actors: ['BUYER', 'SUPPLIER'] },
      { to: 'REJECTED', actors: ['BUYER', 'SUPPLIER'] },
      { to: 'WITHDRAWN', actors: ['SUPPLIER'] },
      { to: 'CLOSED', actors: ['SYSTEM'] },
    ],
    ACCEPTED: [],
    REJECTED: [],
    WITHDRAWN: [],
    CLOSED: [],
  });

export function assertQuoteTransition(request: { from: RfqQuoteStatusName; to: RfqQuoteStatusName; actor: QuoteActor }): void {
  const allowed = QUOTE_TRANSITIONS[request.from].some(
    (rule) => rule.to === request.to && rule.actors.includes(request.actor),
  );
  if (!allowed) {
    throw conflict(
      ErrorCode.RFQ_OFFER_NOT_OPEN,
      `A quote that is ${request.from.toLowerCase()} cannot be ${request.to.toLowerCase()}.`,
      [{ code: request.from, meta: { from: request.from, to: request.to, actor: request.actor } }],
    );
  }
}

/** Whether `party` may answer (accept or reject) a version written by `author`. */
export function mayAnswer(author: 'BUYER' | 'SUPPLIER', party: 'BUYER' | 'SUPPLIER'): boolean {
  return author !== party;
}

/** The terms of one offer version, as strings - the form they are hashed and shown in. */
export interface OfferTerms {
  quoteId: string;
  versionNumber: number;
  author: 'BUYER' | 'SUPPLIER';
  currency: string;
  unitPriceMinor: string;
  quantity: string;
  moq: string | null;
  leadTimeDays: number | null;
  capacityPerMonth: string | null;
  incoterm: string | null;
  incotermPlace: string | null;
  paymentTerms: string | null;
  inspectionTerms: string | null;
  warranty: string | null;
  toolingMinor: string | null;
  sampleCostMinor: string | null;
  shippingEstimateMinor: string | null;
  taxesDisclosure: string | null;
  tiers: { minQuantity: string; unitPriceMinor: string }[];
  expiresAt: string;
  /**
   * The export documents the supplier will provide (JOURNEY-016). Present only
   * when at least one is offered: a version written before this field existed
   * hashes exactly as it did, so no accepted hash changes.
   */
  exportDocuments?: ExportDocument[];
}

/** Export documents a quote can promise. Fixed codes the screens translate. */
export const EXPORT_DOCUMENTS = [
  'COMMERCIAL_INVOICE',
  'PACKING_LIST',
  'CERTIFICATE_OF_ORIGIN',
  'BILL_OF_LADING_OR_AWB',
  'INSPECTION_CERTIFICATE',
  'INSURANCE_CERTIFICATE',
  'TEST_REPORT',
  'SAFETY_DATA_SHEET',
  'EXPORT_LICENCE',
] as const;
export type ExportDocument = (typeof EXPORT_DOCUMENTS)[number];

/** The stored list, in the fixed order, without unknown codes. */
export function exportDocumentsOf(value: unknown): ExportDocument[] {
  if (!Array.isArray(value)) return [];
  return EXPORT_DOCUMENTS.filter((code) => value.includes(code));
}

/** Keys sorted, arrays kept in order: one string for one set of terms. */
export function canonicalRfqJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalRfqJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalRfqJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function offerTermsHash(terms: OfferTerms): string {
  return createHash('sha256').update(canonicalRfqJson(terms)).digest('hex');
}

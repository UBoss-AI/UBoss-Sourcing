/**
 * Quotes, offers and the comparison: the storefront and Seller Hub side of the
 * API (Master rows 18 and 19). Money is minor units as strings throughout.
 */
import { api, BASE_URL, postFile } from './api';
import type { Money } from './format';
import type { RfqAttachment } from './rfq';

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
}

export interface OfferVersion {
  id: string;
  versionNumber: number;
  author: 'BUYER' | 'SUPPLIER';
  state: 'PROPOSED' | 'SUPERSEDED' | 'ACCEPTED' | 'REJECTED' | 'WITHDRAWN' | 'CLOSED';
  isExpired: boolean;
  termsHash: string;
  terms: OfferTerms;
  unitPrice: Money;
  tooling: Money | null;
  sampleCost: Money | null;
  shippingEstimate: Money | null;
  comment: string | null;
  responseNote: string | null;
  createdAt: string;
  respondedAt: string | null;
}

export interface Quote {
  id: string;
  rfqId: string;
  sellerAccountId: string;
  status: 'OPEN' | 'ACCEPTED' | 'REJECTED' | 'WITHDRAWN' | 'CLOSED';
  currency: string;
  shortlisted: boolean;
  basedOnRequirementVersion: number;
  currentVersionNumber: number;
  current: OfferVersion | null;
  versions: OfferVersion[];
  acceptedVersionId: string | null;
  acceptedTermsHash: string | null;
  acceptedAt: string | null;
  closedReason: string | null;
  createdAt: string;
}

export interface ComparisonRow {
  quoteId: string;
  supplier: { sellerAccountId: string; displayName: string; registrationCountry: string; verifiedAt: string | null; verified: boolean };
  status: Quote['status'];
  shortlisted: boolean;
  versionNumber: number;
  author: 'BUYER' | 'SUPPLIER';
  basedOnRequirementVersion: number;
  onCurrentRequirement: boolean;
  expiresAt: string;
  isExpired: boolean;
  quantity: string;
  quoted: {
    currency: string;
    unitPrice: Money;
    applicableUnitPrice: Money;
    total: Money;
    tooling: Money | null;
    sampleCost: Money | null;
    shippingEstimate: Money | null;
  };
  converted: {
    unitPrice: Money;
    applicableUnitPrice: Money;
    total: Money;
    tooling: Money | null;
    sampleCost: Money | null;
    shippingEstimate: Money | null;
    conversion: { currency: string; rate: string; rateAsOf: string; provider: string; snapshotId: string | null };
  } | null;
  conversionUnavailable: boolean;
  moq: string | null;
  leadTimeDays: number | null;
  capacityPerMonth: string | null;
  incoterm: string | null;
  incotermPlace: string | null;
  paymentTerms: string | null;
  inspectionTerms: string | null;
  warranty: string | null;
  taxesDisclosure: string | null;
  tiers: { minQuantity: string; unitPrice: Money }[];
}

export interface Comparison {
  rfqId: string;
  reference: string;
  currency: string;
  unitOfMeasure: string | null;
  currentRequirementVersion: number;
  rows: ComparisonRow[];
}

export type ComparisonSort = 'total' | 'unitPrice' | 'leadTime' | 'moq' | 'supplier';

export interface QuoteInput {
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
  comment: string | null;
  expiresAt: string;
  attachmentIds: string[];
}

export async function fetchComparison(
  rfqId: string,
  query: { currency: string | null; sort: ComparisonSort; shortlisted: boolean },
): Promise<Comparison> {
  return (
    await api.get<{ comparison: Comparison }>(`/rfqs/${rfqId}/comparison`, {
      query: { currency: query.currency, sort: query.sort, shortlisted: query.shortlisted ? 'true' : undefined },
    })
  ).comparison;
}

export function comparisonCsvUrl(rfqId: string, currency: string | null, sort: ComparisonSort, shortlisted: boolean): string {
  const params = new URLSearchParams({ sort });
  if (currency !== null) params.set('currency', currency);
  if (shortlisted) params.set('shortlisted', 'true');
  return `${BASE_URL}/rfqs/${rfqId}/comparison.csv?${params.toString()}`;
}

export async function setQuoteShortlist(rfqId: string, quoteId: string, shortlisted: boolean): Promise<Quote> {
  return (await api.put<{ quote: Quote }>(`/rfqs/${rfqId}/quotes/${quoteId}/shortlist`, { shortlisted })).quote;
}

export async function fetchBuyerQuotes(rfqId: string): Promise<Quote[]> {
  return (await api.get<{ quotes: Quote[] }>(`/rfqs/${rfqId}/quotes`)).quotes;
}

export async function fetchBuyerQuote(rfqId: string, quoteId: string): Promise<Quote> {
  return (await api.get<{ quote: Quote }>(`/rfqs/${rfqId}/quotes/${quoteId}`)).quote;
}

export async function fetchSellerQuote(rfqId: string): Promise<Quote | null> {
  return (await api.get<{ quote: Quote | null }>(`/seller/rfqs/${rfqId}/quote`)).quote;
}

export async function submitSellerQuote(rfqId: string, input: QuoteInput): Promise<Quote> {
  return (await api.post<{ quote: Quote }>(`/seller/rfqs/${rfqId}/quotes`, input)).quote;
}

export async function uploadSellerRfqFile(rfqId: string, purpose: 'QUOTE' | 'NEGOTIATION', file: File): Promise<RfqAttachment> {
  const form = new FormData();
  form.append('file', file);
  return (await postFile<{ attachment: RfqAttachment }>(`/seller/rfqs/${rfqId}/attachments`, form, { query: { purpose } })).attachment;
}

/**
 * Delivery, returns, refunds and dispute administration (Doc 07) and the
 * commercial terms frozen on each order line (Doc 08), as the buyer and the
 * Seller Hub see them.
 *
 * Money is a string of minor units and every rate is whole basis points, the
 * same as everywhere else. Every list is read defensively: a server from
 * before these routes, or a test that answers every GET with one shape, must
 * read as "nothing yet" rather than crash the page around it.
 */
import type { Translate, TranslationKey } from '@/i18n/i18n-context';
import { api } from '@/lib/api';
import { humanise } from '@/lib/format';

export const CASE_CATEGORIES = [
  'FRAUD',
  'SAFETY',
  'DEFECT',
  'SHORTAGE',
  'TRANSIT_LOSS',
  'WRONG_ITEM',
  'DELAY',
  'IMPORT_FAILURE',
  'CANCELLATION',
  'WARRANTY',
  'INSTALLATION',
  'SERVICE_BREACH',
] as const;
export type CaseCategory = (typeof CASE_CATEGORIES)[number];

/** The case facts a claim may carry. Optional: a claim without them is handled as before. */
export interface ClaimCaseFacts {
  category: CaseCategory;
  urgency?: 'NORMAL' | 'URGENT';
  statutoryBasis?: boolean;
  lateExplanation?: string | null;
  affectedQuantity?: number | null;
  lotsOrSerials?: string[] | null;
}

export interface CaseDraft {
  category: CaseCategory | '';
  urgency: 'NORMAL' | 'URGENT';
  statutoryBasis: boolean;
  lateExplanation: string;
  affectedQuantity: string;
  lotsOrSerials: string;
}

export const EMPTY_CASE_DRAFT: CaseDraft = {
  category: '',
  urgency: 'NORMAL',
  statutoryBasis: false,
  lateExplanation: '',
  affectedQuantity: '',
  lotsOrSerials: '',
};

/** The `case` object for the claim body, or undefined when no category was chosen. */
export function caseFromDraft(draft: CaseDraft): ClaimCaseFacts | undefined {
  if (draft.category === '') return undefined;
  const quantity = Number.parseInt(draft.affectedQuantity, 10);
  const lots = draft.lotsOrSerials
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');
  return {
    category: draft.category,
    urgency: draft.urgency,
    statutoryBasis: draft.statutoryBasis,
    lateExplanation: draft.lateExplanation.trim() === '' ? null : draft.lateExplanation.trim(),
    affectedQuantity: Number.isInteger(quantity) && quantity > 0 ? quantity : null,
    lotsOrSerials: lots.length > 0 ? lots : null,
  };
}

export interface EvidenceRequest {
  id: string;
  purpose: string;
  description: string;
  dueAt: string | null;
  status: string;
  respondedAt: string | null;
}

export interface DecidedRemedy {
  kind: string;
  amountMinor: string | null;
  currency: string | null;
  payer: string;
  returnFreightPayer: string | null;
  quantity: number | null;
  expectedCompletionAt: string | null;
  status: string;
  completedAt: string | null;
}

export interface PartyCaseControls {
  category: string | null;
  urgency: string | null;
  lateIntake: boolean;
  acknowledgedAt: string | null;
  initialDecisionDueAt: string | null;
  appealReviewDueAt: string | null;
  reasoning: string | null;
  requests: EvidenceRequest[];
  remedies: DecidedRemedy[];
  legalNotice: string | null;
}

function normaliseCase(raw: Partial<PartyCaseControls> | null | undefined): PartyCaseControls {
  return {
    category: raw?.category ?? null,
    urgency: raw?.urgency ?? null,
    lateIntake: raw?.lateIntake === true,
    acknowledgedAt: raw?.acknowledgedAt ?? null,
    initialDecisionDueAt: raw?.initialDecisionDueAt ?? null,
    appealReviewDueAt: raw?.appealReviewDueAt ?? null,
    reasoning: raw?.reasoning ?? null,
    requests: Array.isArray(raw?.requests) ? raw.requests : [],
    remedies: Array.isArray(raw?.remedies) ? raw.remedies : [],
    legalNotice: typeof raw?.legalNotice === 'string' ? raw.legalNotice : null,
  };
}

export type CaseSurface = 'buyer' | 'seller';

const casePath = (surface: CaseSurface, reference: string): string =>
  `${surface === 'seller' ? '/seller' : ''}/disputes/${encodeURIComponent(reference)}/case-controls`;

export const commercialKeys = {
  caseControls: (surface: CaseSurface, reference: string) => ['commercial', 'case', surface, reference] as const,
  refunds: (orderId: string) => ['commercial', 'refunds', orderId] as const,
  sellerControls: (id: string) => ['commercial', 'seller-controls', id] as const,
  sellerDispatch: (id: string) => ['commercial', 'seller-dispatch', id] as const,
  sellerFees: ['commercial', 'seller-fees'] as const,
};

export async function fetchCaseControls(surface: CaseSurface, reference: string): Promise<PartyCaseControls> {
  return normaliseCase(await api.get<Partial<PartyCaseControls>>(casePath(surface, reference)));
}

export function answerEvidenceRequest(surface: CaseSurface, reference: string, requestId: string, note: string, key: string): Promise<void> {
  return api.post(`${casePath(surface, reference)}/evidence-requests/${requestId}`, { note }, { idempotencyKey: key });
}

// --- Refunds ----------------------------------------------------------------

export type RefundState = 'REQUESTED' | 'SUBMITTED' | 'PENDING_PROVIDER' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

export interface RefundStatus {
  id: string;
  amountMinor: string;
  currency: string;
  instructedAt: string;
  providerConfirmedAt: string | null;
  /** One of `RefundState`; read as a string so an unknown state never crashes the card. */
  state: string;
  outcomeUnknown: boolean;
}

export async function fetchRefundStatus(orderId: string): Promise<RefundStatus[]> {
  const result = await api.get<{ refunds?: unknown }>(`/orders/${orderId}/refund-status`);
  return Array.isArray(result.refunds) ? (result.refunds as RefundStatus[]) : [];
}

// --- Seller order controls ----------------------------------------------------

export interface CommercialLine {
  id: string;
  orderItemId: string;
  sellerAccountId: string | null;
  manufacturerName: string | null;
  productVersion: string | null;
  facilityRef: string | null;
  sellerCountry: string | null;
  destinationCountry: string;
  channel: string;
  deliveryTerm: string;
  namedPlace: string | null;
  importerOfRecord: string;
  leadTimeDays: number | null;
  technicalAcceptanceDays: number | null;
  titleTransferPoint: string | null;
  riskTransferPoint: string | null;
  returnRoute: string | null;
  packagingNote: string | null;
  currency: string;
  commissionBaseMinor: string;
  commissionBps: number;
  commissionMinor: string;
  commissionSource: string;
  commissionRuleVersion: string | null;
  rounding: string;
  controlGapsJson: unknown;
}

export interface GroupControls {
  status: string;
  editable: boolean;
  gateMode: string;
  lines: CommercialLine[];
}

export async function fetchSellerControls(id: string): Promise<GroupControls> {
  const raw = await api.get<Partial<GroupControls>>(`/seller/orders/${id}/controls`);
  return { status: raw.status ?? '', editable: raw.editable === true, gateMode: raw.gateMode ?? '', lines: Array.isArray(raw.lines) ? raw.lines : [] };
}

export interface ControlsInput {
  returnRoute?: string;
  packagingNote?: string;
  transportRestrictionsReviewed?: boolean;
  insurance?: { decided: true; arrangement: string; insuredValueMinor?: string | null };
  namedPlace?: string;
  leadTimeDays?: number;
  technicalAcceptanceDays?: number | null;
  titleTransferPoint?: string;
  riskTransferPoint?: string;
  election?: { term: 'FCA' | 'DDP'; approvalReference: string } | null;
}

export function saveSellerControls(id: string, input: ControlsInput): Promise<void> {
  return api.patch(`/seller/orders/${id}/controls`, input);
}

/** Basis points as a percentage: 1250 → "12.50 %". Integer arithmetic, no float rounding. */
export function bpsToPercent(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const rest = Math.abs(bps % 100);
  return `${String(whole)}.${String(rest).padStart(2, '0')} %`;
}

export const gapLabel = (t: Translate, code: string): string =>
  t(`commercial.gap.${code}` as TranslationKey, { defaultValue: humanise(code) });

export function gapsOf(line: { controlGapsJson: unknown }): string[] {
  return Array.isArray(line.controlGapsJson) ? line.controlGapsJson.filter((g): g is string => typeof g === 'string') : [];
}

// --- Seller dispatch controls ---------------------------------------------------

export interface CustomsDocument {
  kind: string;
  status: string;
  requiredBeforeDispatch: boolean;
}

export interface DispatchControls {
  gaps: string[];
  documents: CustomsDocument[];
  requirements: string[];
  custodyCount: number;
  hasBooking: boolean;
}

export async function fetchSellerDispatch(id: string): Promise<DispatchControls> {
  const raw = await api.get<Record<string, unknown>>(`/seller/orders/${id}/dispatch-controls`);
  const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
  return {
    gaps: list<string>(raw.gaps),
    documents: list<CustomsDocument>(raw.documents),
    requirements: list<string>(raw.requirements),
    custodyCount: list(raw.custody).length,
    hasBooking: raw.booking !== null && raw.booking !== undefined,
  };
}

export interface DispatchEvidenceInput {
  quantities: { orderItemId: string; quantity: number }[];
  lots?: { orderItemId: string; lot?: string; serial?: string }[];
  seals?: string[];
  packingPhotoRefs?: string[];
  temperatureLogRef?: string | null;
  handlingEvidence?: { kind: string; evidence: string }[];
}

export function saveDispatchEvidence(id: string, input: DispatchEvidenceInput): Promise<unknown> {
  return api.put(`/seller/orders/${id}/dispatch-evidence`, input);
}

export interface CustodyInput {
  fromParty: string;
  toParty: string;
  place: string;
  handedOverAt: string;
  packages: number;
  sealsIntact: boolean;
  exceptionNote?: string | null;
}

export function recordCustodyHandover(id: string, input: CustodyInput, key: string): Promise<unknown> {
  return api.post(`/seller/orders/${id}/custody-handovers`, input, { idempotencyKey: key });
}

export interface FreightQuoteInput {
  providerName: string;
  amountMinor: string;
  currency: string;
  transitDaysMin?: number | null;
  transitDaysMax?: number | null;
  comparable?: boolean;
  reference?: string | null;
}

export interface FreightBookingInput {
  lane: string;
  grossWeightGrams: number;
  dimensions: { lengthMm: number; widthMm: number; heightMm: number; packages: number };
  packaging: string;
  hazardClass?: string | null;
  custody: { leg: string; responsible: string }[];
  returnCapability?: string | null;
  singleSourceReason?: string | null;
  quotes: FreightQuoteInput[];
  selectedIndex: number | null;
}

export function saveFreightBooking(id: string, input: FreightBookingInput): Promise<unknown> {
  return api.put(`/seller/orders/${id}/freight-booking`, input);
}

// --- Seller fees and security -----------------------------------------------------

export interface CommissionAdjustment {
  id: string;
  refundId: string;
  orderItemId: string;
  refundedGoodsMinor: string;
  reversedMinor: string;
  currency: string;
  basis: string;
  fault: string;
  status: string;
  appliedAt: string | null;
  createdAt: string;
}

export interface SecuritySchedule {
  id: string;
  tier: string;
  form: string;
  reserveBps: number;
  holdDays: number;
  guaranteeMinor: string;
  depositMinor: string;
  capMinor: string | null;
  currency: string;
  status: string;
  activatedAt: string | null;
  nextMonthlyReviewAt: string | null;
  nextQuarterlyReviewAt: string | null;
}

export interface SecurityReview {
  id: string;
  scheduleId: string;
  kind: string;
  periodKey: string;
  heldMinor: string | null;
  exposureMinor: string | null;
  excessMinor: string | null;
  outcome: string;
  dueAt: string;
  reviewedAt: string | null;
}

export interface CertificationProgramme {
  id: string;
  reference: string;
  title: string;
  currency: string;
  capBps: number;
  periodStart: string;
  periodEnd: string;
  status: string;
  eligibleCostMinor: string;
  confirmedMinor: string;
  unrecoveredMinor: string;
}

export interface SellerFees {
  adjustments: CommissionAdjustment[];
  schedules: SecuritySchedule[];
  reviews: SecurityReview[];
  programmes: CertificationProgramme[];
}

export async function fetchSellerFees(): Promise<SellerFees> {
  const raw = await api.get<{ adjustments?: unknown; security?: { schedules?: unknown; reviews?: unknown }; programmes?: unknown }>('/seller/commercial/fees');
  const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
  return {
    adjustments: list<CommissionAdjustment>(raw.adjustments),
    schedules: list<SecuritySchedule>(raw.security?.schedules),
    reviews: list<SecurityReview>(raw.security?.reviews),
    programmes: list<CertificationProgramme>(raw.programmes),
  };
}


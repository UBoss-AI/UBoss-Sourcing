/**
 * The seller turnover eligibility policy, on the storefront side.
 *
 * The SERVER decides. Everything here exists so the form can say the same
 * thing sooner - and so that what it sends is exactly what was typed. That is
 * why the conversion is string and `bigint` arithmetic end to end: "30.000000001
 * crore" is 3,000,000,000.1 rupees is 300,000,000,010 paise, and no float ever
 * holds any of those numbers on the way. The amount leaves this file as a
 * string of whole minor units, the same shape every money field on the wire
 * uses.
 *
 * Crore is offered only where the policy's currency is INR: 1 crore =
 * 10,000,000 rupees, so a crore figure may carry up to seven decimal places
 * plus the currency's own (two for paise) before it stops being exact.
 */
import { api } from './api';

export interface TurnoverPolicy {
  required: boolean;
  /** The minimum a turnover must EXCEED, in whole minor units. */
  minimumMinor: string;
  currency: string;
  currencyExponent: number;
  policyVersion: string;
  financialYearStartMonth: number;
  suggestedFinancialYear: { start: string; end: string };
}

export type TurnoverStanding = 'NOT_DECLARED' | 'ELIGIBLE' | 'BELOW_MINIMUM' | 'OUT_OF_DATE';
export type TurnoverVerificationState =
  | 'NOT_STARTED'
  | 'AWAITING_INPUT'
  | 'IN_PROGRESS'
  | 'VERIFIED'
  | 'FAILED'
  | 'PROVIDER_UNCONFIGURED'
  | 'EXPIRED';

export interface SellerTurnoverView {
  policy: TurnoverPolicy;
  applies: boolean;
  standing: TurnoverStanding;
  declaration: {
    id: string;
    amountMinor: string;
    currency: string;
    financialYearStart: string;
    financialYearEnd: string;
    policyVersion: string;
    declaredAt: string;
    verificationState: TurnoverVerificationState;
    decisionReason: string | null;
    reviewedAt: string | null;
  } | null;
  isEditable: boolean;
}

/** What the server is sent, on `/sellers/apply` and `PUT /seller/turnover`. */
export interface TurnoverDeclarationInput {
  amountMinor: string;
  currency: string;
  financialYearStart: string;
  financialYearEnd: string;
  declarationAccepted: boolean;
}

export function fetchSellerTurnover(): Promise<SellerTurnoverView> {
  return api.get<SellerTurnoverView>('/seller/turnover');
}

export function saveSellerTurnover(input: TurnoverDeclarationInput): Promise<SellerTurnoverView> {
  return api.put<SellerTurnoverView>('/seller/turnover', input);
}

/** The requirement key evidence is uploaded against. Matches the server's. */
export const TURNOVER_EVIDENCE_FIELD_KEY = 'annual_turnover_evidence';

// ---------------------------------------------------------------------------
// Units and exact conversion
// ---------------------------------------------------------------------------

/** How the amount is typed. CRORE only exists for INR. */
export type TurnoverUnit = 'MAJOR' | 'CRORE';

/** Decimal places of the major unit in one crore: 10^7. */
const CRORE_DIGITS = 7;

export type TurnoverEntryProblem = 'REQUIRED' | 'NEGATIVE' | 'MALFORMED' | 'TOO_PRECISE' | 'TOO_LARGE';

/** Whole minor units fit a signed BIGINT column up to 18 digits. */
const MAX_MINOR_DIGITS = 18;

function scaleFor(unit: TurnoverUnit, exponent: number): number {
  return unit === 'CRORE' ? CRORE_DIGITS + exponent : exponent;
}

/**
 * Turn what was typed into whole minor units, exactly - or say what is wrong.
 *
 * Grouping commas and spaces are accepted ("30,00,00,000.50" is how an Indian
 * accountant writes it) and dropped; anything else that is not a digit or one
 * decimal point is refused rather than guessed at.
 */
export function parseTurnoverEntry(
  text: string,
  unit: TurnoverUnit,
  exponent: number,
): { ok: true; minor: bigint } | { ok: false; problem: TurnoverEntryProblem } {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, problem: 'REQUIRED' };
  if (trimmed.startsWith('-') || trimmed.startsWith('−')) return { ok: false, problem: 'NEGATIVE' };

  const compact = trimmed.replace(/[,\s\u00A0\u202F]/g, '');
  const match = /^(\d+)(?:\.(\d+))?$/.exec(compact);
  if (match === null) return { ok: false, problem: 'MALFORMED' };

  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  const scale = scaleFor(unit, exponent);
  if (fraction.length > scale) return { ok: false, problem: 'TOO_PRECISE' };

  const digits = (whole + fraction.padEnd(scale, '0')).replace(/^0+(?=\d)/, '');
  if (digits.length > MAX_MINOR_DIGITS) return { ok: false, problem: 'TOO_LARGE' };
  return { ok: true, minor: BigInt(digits) };
}

/**
 * Minor units back into the text a unit is typed in, exactly and without
 * trailing zeros: 300000000000 paise is "30" crore and "3000000000" rupees.
 * Used when the unit is switched, so the figure the person typed is kept.
 */
export function minorToEntry(minor: bigint, unit: TurnoverUnit, exponent: number): string {
  const scale = scaleFor(unit, exponent);
  const digits = minor.toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, '');
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

/** Strictly greater - exactly the minimum is not eligible. */
export function exceedsMinimum(amountMinor: bigint, policy: Pick<TurnoverPolicy, 'minimumMinor'>): boolean {
  return amountMinor > BigInt(policy.minimumMinor);
}

/** Minor units as an exact decimal string of the major unit, for `Intl`. */
function majorString(minor: bigint, exponent: number): string {
  if (exponent === 0) return minor.toString();
  const digits = minor.toString().padStart(exponent + 1, '0');
  return `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
}

/**
 * A full amount in the policy's currency, e.g. "₹3,00,00,00,000.01".
 *
 * `Intl` is handed a decimal STRING, which it formats exactly; a number would
 * round a large turnover to the nearest representable double first.
 */
export function formatTurnover(minor: bigint, policy: Pick<TurnoverPolicy, 'currency' | 'currencyExponent'>, locale: string): string {
  const format = new Intl.NumberFormat(policy.currency === 'INR' ? 'en-IN' : locale, {
    style: 'currency',
    currency: policy.currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: policy.currencyExponent,
  });
  return format.format(majorString(minor, policy.currencyExponent) as unknown as number);
}

/** "30" for INR 30 crore; exact, with as many decimals as the amount needs. */
export function croreFigure(minor: bigint, exponent: number): string {
  return minorToEntry(minor, 'CRORE', exponent);
}

/**
 * The minimum in compact words of the reader's own language, e.g. "INR 300
 * million" or "300 Millionen INR". Only used where it is a whole number of
 * millions, so the compact form is never a rounding.
 */
export function compactEquivalent(minor: bigint, policy: Pick<TurnoverPolicy, 'currency' | 'currencyExponent'>, locale: string): string | null {
  const major = minor / 10n ** BigInt(policy.currencyExponent);
  if (minor % 10n ** BigInt(policy.currencyExponent) !== 0n || major % 1_000_000n !== 0n) return null;
  const words = new Intl.NumberFormat(locale, { notation: 'compact', compactDisplay: 'long' }).format(
    major.toString() as unknown as number,
  );
  return `${policy.currency} ${words}`;
}

// ---------------------------------------------------------------------------
// Financial years
// ---------------------------------------------------------------------------

export interface FinancialYearOption {
  /** `start|end`, the select's value. */
  key: string;
  start: string;
  end: string;
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The most recently completed twelve months that start in `startMonth` (1-12). */
export function mostRecentFinancialYear(startMonth: number, today: Date): { start: string; end: string } {
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  for (let year = today.getFullYear(); ; year -= 1) {
    const start = new Date(Date.UTC(year, startMonth - 1, 1));
    const end = new Date(Date.UTC(year + 1, startMonth - 1, 0));
    if (end.getTime() < todayUtc) return { start: iso(start), end: iso(end) };
  }
}

/**
 * The years a business can report against: the most recently completed one
 * for the usual start month first, then for the other common year-ends
 * (January, April, July, October). Only the latest completed year of each -
 * the policy asks for the most recent figures, so an older year is not offered.
 */
export function financialYearOptions(preferredStartMonth: number, today: Date): FinancialYearOption[] {
  const months = [preferredStartMonth, 4, 1, 7, 10].filter((month, index, all) => all.indexOf(month) === index);
  return months.map((month) => {
    const year = mostRecentFinancialYear(month, today);
    return { key: `${year.start}|${year.end}`, ...year };
  });
}

/** "1 Apr 2025 – 31 Mar 2026", in the reader's language. */
export function formatPeriod(start: string, end: string, locale: string): string {
  const format = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return `${format.format(new Date(`${start}T00:00:00Z`))} – ${format.format(new Date(`${end}T00:00:00Z`))}`;
}

/** "FY 2025–26" for a year that spans two calendar years, "2025" for one that does not. */
export function shortYearLabel(start: string, end: string): string {
  const from = start.slice(0, 4);
  const to = end.slice(0, 4);
  return from === to ? from : `${from}–${to.slice(2)}`;
}

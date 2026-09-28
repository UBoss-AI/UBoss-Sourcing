/**
 * The seam every business-registry check plugs into.
 *
 * A provider answers one narrow question about one identifier ("is this NIP
 * an active VAT payer, and under what name?") from one official source. It
 * never decides an application. What it returns becomes one immutable row in
 * `buyer_company_checks`, which a reviewer reads beside everything else.
 *
 * Adding a country is adding a provider and listing it in `index.ts`. The
 * onboarding flow, the review console and the state machine do not change.
 *
 * Two rules every provider keeps, and `providers.test.ts` holds them to:
 *
 *   1. **An unreachable, slow or confused source is UNAVAILABLE, never FAIL.**
 *      Only a source that answered, clearly, "no such registration" may say
 *      FAIL. Registry downtime moves an application to a person, never out of
 *      the door.
 *   2. **Only what verification needs is kept.** A register that also returns
 *      bank accounts, home addresses or the names of private individuals has
 *      those fields dropped in `normalise` before anything is stored.
 */
import type { BuyerCompanyEntityTypeName } from '../../../domain/buyer-company-identifiers.js';

export type CheckOutcome =
  'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'UNAVAILABLE' | 'MANUAL_REQUIRED' | 'SIGNAL';

/** What a provider may know about the application. Nothing else is passed in. */
export interface CompanySubject {
  companyId: string;
  legalName: string | null;
  tradingName: string | null;
  entityType: BuyerCompanyEntityTypeName | null;
  registrationCountry: string | null;
  /** Normalised. */
  registrationNumber: string | null;
  /** scheme -> normalised value, for identifiers given (not declared N/A). */
  identifiers: ReadonlyMap<string, string>;
}

export interface CheckResult {
  /** Which scheme or rule this row is about - IN_GSTIN, REGISTRATION, ... */
  subject: string;
  outcome: CheckOutcome;
  /** One line, in English, for the reviewer. Never shown to the applicant. */
  summary: string;
  /** What was asked. The identifier, not the application. */
  request: Record<string, string | null>;
  /** The source's answer, minimised. */
  result?: Record<string, unknown> | null;
  sourceReference?: string | null;
  /** The official register a reviewer should open. */
  sourceUrl?: string | null;
}

export interface BusinessVerificationProvider {
  /** Stored in `buyer_company_checks.provider`. */
  readonly key: string;
  /** Plain words for the console: "EU VIES (VAT status)". */
  readonly label: string;
  /** Whether this provider has anything to check for this application. */
  appliesTo(subject: CompanySubject): boolean;
  /** Never throws. Every failure is a result. */
  check(subject: CompanySubject): Promise<CheckResult[]>;
}

/** Fill `{name}` placeholders with URL-encoded values. */
export function fillUrl(template: string, values: Record<string, string>): string {
  let url = template;
  for (const [name, value] of Object.entries(values)) {
    url = url.split(`{${name}}`).join(encodeURIComponent(value));
  }
  return url;
}

/**
 * Whether two company names are plausibly the same company.
 *
 * Compared after `normaliseCompanyLegalName`, so legal suffixes, accents and
 * punctuation do not count. Containment either way is enough - a register
 * that writes "ACME POLSKA SP. Z O.O." against an application that says
 * "Acme Polska" is a match a reviewer would call a match.
 */
export function namesAgree(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/**
 * Destination documentation readiness and the pre-dispatch exception hold
 * (JOURNEY-049).
 *
 * The operator's trade rules (`TradeComplianceRule`) say, per destination,
 * category and HS prefix, that goods are prohibited or restricted there, that
 * a document must be produced and by whom, and whether the HS code must be
 * verified by marketplace staff first. Nothing in the code knows any country's
 * law: staff write the rules.
 *
 * This file is pure. The service (`modules/compliance/destination-compliance.service.ts`)
 * gathers the facts for one seller order; this decides which rules apply, how
 * far each one is met, and whether the goods are on hold. A hold refuses
 * READY_FOR_DISPATCH, a dispatch and a carrier collection with 409
 * DESTINATION_DOCUMENTS_NOT_READY until the cause is fixed or a member of
 * staff overrides it with a written reason.
 *
 * What holds the goods:
 *
 *   - a matching PROHIBITED rule;
 *   - a document the SELLER must produce that has no current VALID version
 *     (awaiting review is not enough to let goods leave);
 *   - an HS code a rule needs verified that is not VERIFIED (or is missing).
 *
 * Documents the buyer, the forwarder or the operator must produce are listed
 * for that party but do not hold the seller's goods: the seller cannot upload
 * the buyer's import licence, and holding them for it would be a hold nobody
 * on the seller's side can clear.
 *
 * An override covers the holds that existed when it was granted, by key. A new
 * cause that appears later holds the goods again.
 */
import { ErrorCode, conflict } from './errors.js';

export type TradeRestrictionName = 'NONE' | 'RESTRICTED' | 'PROHIBITED';
export type ResponsiblePartyName = 'SELLER' | 'BUYER' | 'FORWARDER' | 'OPERATOR';
export type HsStateName = 'DECLARED' | 'VERIFIED' | 'REJECTED';
export type TradeValidationState = 'PENDING_REVIEW' | 'VALID' | 'REJECTED' | 'EXPIRED';

/** EXPIRED wins over everything but a rejection: an expired certificate is not valid. */
export function validationStateOf(
  validation: 'PENDING_REVIEW' | 'VALID' | 'REJECTED',
  expiresOn: Date | null,
  today: Date = new Date(),
): TradeValidationState {
  if (validation === 'REJECTED') return 'REJECTED';
  if (expiresOn !== null && expiresOn.toISOString().slice(0, 10) < today.toISOString().slice(0, 10)) {
    return 'EXPIRED';
  }
  return validation;
}

export interface ComplianceRuleFact {
  id: string;
  name: string;
  /** '' for every destination. */
  destinationCountry: string;
  categoryId: string | null;
  /** '' for every code. */
  hsPrefix: string;
  restriction: TradeRestrictionName;
  requiredDocumentKind: string | null;
  requiredDocumentName: string | null;
  responsibleParty: ResponsiblePartyName;
  requiresHsVerification: boolean;
  note: string | null;
}

export interface ComplianceLineFact {
  sku: string;
  /** The product's category and every category above it. */
  categoryIds: readonly string[];
  /** The declared code. */
  hsCode: string | null;
  hsState: HsStateName;
  /** A code staff corrected it to when verifying, if any. */
  hsVerifiedCode: string | null;
}

/** The code a line is matched by: the corrected one once staff verified it. */
export function effectiveHsCode(line: Pick<ComplianceLineFact, 'hsCode' | 'hsState' | 'hsVerifiedCode'>): string {
  if (line.hsState === 'VERIFIED' && line.hsVerifiedCode !== null && line.hsVerifiedCode !== '') {
    return line.hsVerifiedCode;
  }
  return line.hsCode ?? '';
}

/** Whether a rule applies to one line going to `destination`. */
export function ruleMatchesLine(rule: ComplianceRuleFact, line: ComplianceLineFact, destination: string): boolean {
  if (rule.destinationCountry !== '' && rule.destinationCountry !== destination) return false;
  if (rule.categoryId !== null && !line.categoryIds.includes(rule.categoryId)) return false;
  if (rule.hsPrefix !== '' && !effectiveHsCode(line).startsWith(rule.hsPrefix)) return false;
  return true;
}

export type ComplianceItemStatus =
  /** A current version is VALID. */
  | 'VALID'
  /** A current version is waiting for the marketplace's review. */
  | 'PENDING_REVIEW'
  | 'MISSING'
  | 'REJECTED'
  | 'EXPIRED'
  /** The rule asks for no document. */
  | 'NO_DOCUMENT';

export interface ComplianceItem {
  ruleId: string;
  ruleName: string;
  restriction: TradeRestrictionName;
  responsibleParty: ResponsiblePartyName;
  documentKind: string | null;
  documentName: string | null;
  requiresHsVerification: boolean;
  note: string | null;
  status: ComplianceItemStatus;
  /** The SKUs the rule matched. */
  skus: string[];
}

export type HoldCode = 'PROHIBITED' | 'DOCUMENT_MISSING' | 'DOCUMENT_NOT_VALID' | 'HS_UNVERIFIED' | 'HS_REJECTED';

export interface ComplianceHold {
  /** Stable for the same cause, so an override can name what it covers. */
  key: string;
  code: HoldCode;
  ruleId: string;
  ruleName: string;
  responsibleParty: ResponsiblePartyName;
  documentKind: string | null;
  sku: string | null;
  /** Whether an active override covers it. */
  covered: boolean;
}

export interface ComplianceVerdict {
  destination: string;
  items: ComplianceItem[];
  holds: ComplianceHold[];
  /** True when nothing holds the goods, or an override covers every hold. */
  open: boolean;
  overridden: boolean;
}

export const COMPLIANCE_NOT_APPLICABLE: ComplianceVerdict = Object.freeze({
  destination: '',
  items: [],
  holds: [],
  open: true,
  overridden: false,
});

function documentStatus(states: readonly TradeValidationState[]): ComplianceItemStatus {
  if (states.includes('VALID')) return 'VALID';
  if (states.includes('PENDING_REVIEW')) return 'PENDING_REVIEW';
  if (states.includes('EXPIRED')) return 'EXPIRED';
  if (states.includes('REJECTED')) return 'REJECTED';
  return 'MISSING';
}

export function evaluateCompliance(input: {
  destination: string;
  rules: readonly ComplianceRuleFact[];
  lines: readonly ComplianceLineFact[];
  /** The current-version state of each recorded document, by kind. */
  documents: ReadonlyMap<string, readonly TradeValidationState[]>;
  /** The hold keys an active override covers, or null. */
  overrideKeys: readonly string[] | null;
}): ComplianceVerdict {
  const items: ComplianceItem[] = [];
  const holds: Omit<ComplianceHold, 'covered'>[] = [];

  const sorted = [...input.rules].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  for (const rule of sorted) {
    const matched = input.lines.filter((line) => ruleMatchesLine(rule, line, input.destination));
    if (matched.length === 0) continue;

    const kind = rule.requiredDocumentKind === '' ? null : rule.requiredDocumentKind;
    const status: ComplianceItemStatus = kind === null ? 'NO_DOCUMENT' : documentStatus(input.documents.get(kind) ?? []);
    items.push({
      ruleId: rule.id,
      ruleName: rule.name,
      restriction: rule.restriction,
      responsibleParty: rule.responsibleParty,
      documentKind: kind,
      documentName: kind === null ? null : (rule.requiredDocumentName ?? kind),
      requiresHsVerification: rule.requiresHsVerification,
      note: rule.note,
      status,
      skus: matched.map((line) => line.sku),
    });

    const base = { ruleId: rule.id, ruleName: rule.name, responsibleParty: rule.responsibleParty };
    if (rule.restriction === 'PROHIBITED') {
      holds.push({ ...base, key: `PROHIBITED:${rule.id}`, code: 'PROHIBITED', documentKind: null, sku: null });
    }
    if (kind !== null && rule.responsibleParty === 'SELLER' && status !== 'VALID') {
      const code: HoldCode = status === 'MISSING' ? 'DOCUMENT_MISSING' : 'DOCUMENT_NOT_VALID';
      holds.push({ ...base, key: `${code}:${rule.id}:${kind}`, code, documentKind: kind, sku: null });
    }
    if (rule.requiresHsVerification) {
      for (const line of matched) {
        if (line.hsState === 'VERIFIED' && (line.hsCode ?? '') !== '') continue;
        const code: HoldCode = line.hsState === 'REJECTED' ? 'HS_REJECTED' : 'HS_UNVERIFIED';
        holds.push({ ...base, key: `${code}:${rule.id}:${line.sku}`, code, documentKind: null, sku: line.sku });
      }
    }
  }

  const covered = new Set(input.overrideKeys ?? []);
  const marked = holds.map((hold) => ({ ...hold, covered: covered.has(hold.key) }));
  const uncovered = marked.filter((hold) => !hold.covered);
  return {
    destination: input.destination,
    items,
    holds: marked,
    open: uncovered.length === 0,
    overridden: holds.length > 0 && uncovered.length === 0,
  };
}

const HOLD_SENTENCE: Record<HoldCode, string> = {
  PROHIBITED: 'These goods may not be sent to this destination.',
  DOCUMENT_MISSING: 'A document the destination requires has not been recorded.',
  DOCUMENT_NOT_VALID: 'A document the destination requires has not been accepted yet.',
  HS_UNVERIFIED: 'The HS code of an item has not been verified yet.',
  HS_REJECTED: 'The HS code of an item was rejected.',
};

/**
 * Refuse a dispatch, a ready-for-dispatch or a collection while the goods are
 * on hold. `details` lists every uncovered hold with the party who must act.
 */
export function assertComplianceOpen(verdict: ComplianceVerdict, meta: { from: string; to: string }): void {
  if (verdict.open) return;
  const uncovered = verdict.holds.filter((hold) => !hold.covered);
  const first = uncovered[0];
  throw conflict(
    ErrorCode.DESTINATION_DOCUMENTS_NOT_READY,
    first === undefined ? 'The goods are on a compliance hold.' : HOLD_SENTENCE[first.code],
    uncovered.slice(0, 20).map((hold) => ({
      code: hold.code,
      meta: {
        ...meta,
        rule: hold.ruleName,
        party: hold.responsibleParty,
        documentKind: hold.documentKind,
        sku: hold.sku,
      },
    })),
  );
}

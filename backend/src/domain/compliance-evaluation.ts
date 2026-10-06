/**
 * Does this seller (or this product) meet the approved requirements for this
 * category, supply role and market - requirement by requirement, and why not?
 *
 * Pure: the service gathers the approved rules, the case's scope and the
 * seller's compliance documents, and this decides. The rules it holds to:
 *
 *   - Only APPROVED requirement versions are evaluated. A draft, however well
 *     researched, decides nothing.
 *   - A requirement applies when the case falls inside its scope: one of its
 *     categories (or a descendant, when it says so), and - where it lists any -
 *     the supply role, the origin country, the destination market and the
 *     device risk class. An empty list is "any".
 *   - CONDITIONAL and UNRESOLVED requirements need a reviewer's per-case
 *     determination. Until one is made they block approval, and "unresolved"
 *     never turns into "satisfied" by itself.
 *   - A document satisfies a requirement only when it is APPROVED, claims that
 *     requirement's code, covers the case's category (or an ancestor), covers
 *     the product for a product-level requirement, matches the manufacturing
 *     site when the case names one and the document is site-specific, and has
 *     not expired. A document with no stated category scope covers nothing.
 *   - OPTIONAL_QUALIFICATION requirements are shown, never required.
 *
 * Nothing here says a document is authentic. It says the reviewer approved it
 * with a recorded verification method, and that its scope and dates fit.
 */

export type Obligation = 'LEGAL' | 'CONTRACTUAL' | 'OPTIONAL_QUALIFICATION';
export type Applicability = 'APPLIES' | 'CONDITIONAL' | 'UNRESOLVED';
export type CaseLevel = 'SELLER_CATEGORY' | 'PRODUCT';

export interface RequirementRule {
  id: string;
  code: string;
  ruleVersion: number;
  name: string;
  obligation: Obligation;
  level: CaseLevel;
  categoryIds: readonly string[];
  includeDescendants: boolean;
  supplyRoles: readonly string[];
  originCountries: readonly string[];
  destinationMarkets: readonly string[];
  riskClasses: readonly string[];
  applicability: Applicability;
  expiryKind: 'DOCUMENT_EXPIRY' | 'NO_EXPIRY' | 'PERIODIC_REVIEW';
  reviewMonths: number | null;
}

export interface CaseScope {
  level: CaseLevel;
  /** The case's category, then its ancestors up to the department. */
  categoryPath: readonly string[];
  productId: string | null;
  supplyRole: string;
  /** Alpha-2 or "EU"; '' when the case is for the seller's own market only. */
  destinationMarket: string;
  /** The seller's registration country (alpha-2). */
  originCountry: string | null;
  factoryId: string | null;
  /** EU MDR class from the product's device record, when it has one. */
  riskClass: string | null;
}

export interface ComplianceDocumentFacts {
  id: string;
  reviewStatus: string;
  requirementCodes: readonly string[];
  categoryScopeIds: readonly string[];
  productScopeIds: readonly string[];
  factoryId: string | null;
  expiresOn: string | null;
  noExpiryReason: string | null;
  verifiedAt: string | null;
  verificationMethod: string | null;
  verificationOutcome: string;
}

export interface Determination {
  decision: 'APPLIES' | 'NOT_APPLICABLE' | 'UNRESOLVED';
  reason: string;
}

export type RequirementState =
  /** Applies and an approved, in-scope, in-date document satisfies it. */
  | 'SATISFIED'
  /** Applies and nothing satisfies it. */
  | 'MISSING'
  /** The only matching document has expired or passed its review interval. */
  | 'EXPIRED'
  /** A document claims the code but does not cover this category, product or site. */
  | 'WRONG_SCOPE'
  /** A document claims it and is not approved yet. */
  | 'PENDING_REVIEW'
  /** A reviewer decided it does not apply to this case, with a reason. */
  | 'NOT_APPLICABLE'
  /** Applicability is conditional or unresolved and nobody has decided. */
  | 'NEEDS_DETERMINATION'
  /** A reviewer recorded that applicability could not be settled. */
  | 'UNRESOLVED'
  /** Optional, and not held. Never blocks. */
  | 'OPTIONAL_NOT_HELD';

export interface RequirementOutcome {
  requirementId: string;
  code: string;
  ruleVersion: number;
  name: string;
  obligation: Obligation;
  applicability: Applicability;
  state: RequirementState;
  /** Whether this line stops the case being approved. */
  blocking: boolean;
  /** The document that satisfies it, when one does. */
  documentId: string | null;
  /** The earliest date this satisfaction stops holding, if any. */
  validUntil: string | null;
}

export interface Evaluation {
  outcomes: RequirementOutcome[];
  /** True when nothing blocks: every applicable mandatory line is satisfied. */
  ready: boolean;
  /** No approved requirement applies at all - say so, never "qualified by default". */
  noApprovedRules: boolean;
  /** The earliest `validUntil` among the satisfied lines. */
  expiresAt: string | null;
}

function addMonths(isoDate: string, months: number): string {
  const date = new Date(`${isoDate.slice(0, 10)}T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
}

function inScope(rule: RequirementRule, scope: CaseScope): boolean {
  if (rule.level !== scope.level) return false;
  const [own, ...ancestors] = scope.categoryPath;
  const categoryMatches =
    rule.categoryIds.length > 0 &&
    rule.categoryIds.some((id) => id === own || (rule.includeDescendants && ancestors.includes(id)));
  if (!categoryMatches) return false;
  if (rule.supplyRoles.length > 0 && !rule.supplyRoles.includes(scope.supplyRole)) return false;
  if (rule.originCountries.length > 0 && (scope.originCountry === null || !rule.originCountries.includes(scope.originCountry))) return false;
  if (rule.destinationMarkets.length > 0) {
    const market = scope.destinationMarket === '' ? scope.originCountry ?? '' : scope.destinationMarket;
    if (!rule.destinationMarkets.includes(market)) return false;
  }
  // A rule limited to device classes applies only to a product whose class is
  // known and listed. A seller-level case has no single class, so it is in
  // scope and the class is decided per product.
  if (rule.riskClasses.length > 0 && scope.level === 'PRODUCT') {
    if (scope.riskClass === null || !rule.riskClasses.includes(scope.riskClass)) return false;
  }
  return true;
}

/** Which approved rules apply to this case's scope. */
export function applicableRules(rules: readonly RequirementRule[], scope: CaseScope): RequirementRule[] {
  return rules.filter((rule) => inScope(rule, scope));
}

function coversScope(document: ComplianceDocumentFacts, scope: CaseScope, rule: RequirementRule): boolean {
  if (!document.categoryScopeIds.some((id) => scope.categoryPath.includes(id))) return false;
  if (rule.level === 'PRODUCT' && scope.productId !== null && !document.productScopeIds.includes(scope.productId)) return false;
  if (scope.factoryId !== null && document.factoryId !== null && document.factoryId !== scope.factoryId) return false;
  return true;
}

function validUntilOf(document: ComplianceDocumentFacts, rule: RequirementRule): string | null {
  const dates: string[] = [];
  if (document.expiresOn !== null) dates.push(document.expiresOn.slice(0, 10));
  if (rule.expiryKind === 'PERIODIC_REVIEW' && rule.reviewMonths !== null && document.verifiedAt !== null) {
    dates.push(addMonths(document.verifiedAt, rule.reviewMonths));
  }
  return dates.length === 0 ? null : dates.sort()[0] ?? null;
}

export function evaluateCompliance(input: {
  rules: readonly RequirementRule[];
  scope: CaseScope;
  documents: readonly ComplianceDocumentFacts[];
  determinations: Readonly<Record<string, Determination>>;
  /** ISO date, YYYY-MM-DD. */
  today: string;
}): Evaluation {
  const outcomes: RequirementOutcome[] = [];

  for (const rule of applicableRules(input.rules, input.scope)) {
    const base = {
      requirementId: rule.id,
      code: rule.code,
      ruleVersion: rule.ruleVersion,
      name: rule.name,
      obligation: rule.obligation,
      applicability: rule.applicability,
      documentId: null as string | null,
      validUntil: null as string | null,
    };
    const optional = rule.obligation === 'OPTIONAL_QUALIFICATION';

    if (rule.applicability !== 'APPLIES') {
      const determination = input.determinations[rule.code];
      if (determination === undefined) {
        outcomes.push({ ...base, state: optional ? 'OPTIONAL_NOT_HELD' : 'NEEDS_DETERMINATION', blocking: !optional });
        continue;
      }
      if (determination.decision === 'NOT_APPLICABLE') {
        outcomes.push({ ...base, state: 'NOT_APPLICABLE', blocking: false });
        continue;
      }
      if (determination.decision === 'UNRESOLVED') {
        outcomes.push({ ...base, state: optional ? 'OPTIONAL_NOT_HELD' : 'UNRESOLVED', blocking: !optional });
        continue;
      }
    }

    const claiming = input.documents.filter((document) => document.requirementCodes.includes(rule.code));
    let best: { state: RequirementState; documentId: string | null; validUntil: string | null } = {
      state: 'MISSING',
      documentId: null,
      validUntil: null,
    };
    const rank: Record<string, number> = { MISSING: 0, PENDING_REVIEW: 1, WRONG_SCOPE: 2, EXPIRED: 3, SATISFIED: 4 };

    for (const document of claiming) {
      let state: RequirementState;
      let validUntil: string | null = null;
      if (document.reviewStatus !== 'APPROVED') {
        state = 'PENDING_REVIEW';
      } else if (!coversScope(document, input.scope, rule)) {
        state = 'WRONG_SCOPE';
      } else if (document.expiresOn === null && (document.noExpiryReason ?? '').trim().length === 0) {
        // No expiry date and no recorded reason why none is needed.
        state = 'WRONG_SCOPE';
      } else {
        validUntil = validUntilOf(document, rule);
        state = validUntil !== null && validUntil < input.today ? 'EXPIRED' : 'SATISFIED';
      }
      if ((rank[state] ?? 0) > (rank[best.state] ?? 0)) best = { state, documentId: document.id, validUntil };
    }

    const satisfied = best.state === 'SATISFIED';
    outcomes.push({
      ...base,
      state: satisfied ? 'SATISFIED' : optional ? 'OPTIONAL_NOT_HELD' : best.state,
      blocking: !satisfied && !optional,
      documentId: best.documentId,
      validUntil: best.validUntil,
    });
  }

  const validDates = outcomes
    .filter((outcome) => outcome.state === 'SATISFIED' && outcome.validUntil !== null)
    .map((outcome) => outcome.validUntil as string)
    .sort();

  return {
    outcomes,
    ready: outcomes.every((outcome) => !outcome.blocking) && outcomes.some((outcome) => outcome.obligation !== 'OPTIONAL_QUALIFICATION'),
    noApprovedRules: outcomes.length === 0,
    expiresAt: validDates[0] ?? null,
  };
}

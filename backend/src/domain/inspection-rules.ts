/**
 * Does this order need an inspection? The rules engine.
 *
 * Pure. The service reads the order - what is in it, what it is worth, where
 * it is going, who is selling it - and the operator's active rules, and this
 * decides: MANDATORY, RISK_TRIGGERED, BUYER_REQUESTED or NOT_REQUIRED, with
 * the rule that fired and a sentence saying why (FLOW-001, JOURNEY-063). The
 * decision is recorded on the requirement row and never recomputed silently:
 * a rule edited next week does not change what an order in progress needs.
 *
 * Every condition on a rule must match. A condition left empty matches
 * everything, so "every order to Germany" is a rule with only a destination.
 * Among matching rules MANDATORY beats RISK_TRIGGERED, then the lower
 * `priority` number wins, then the older rule - so the answer is the same
 * however the rows come back from the database.
 */

export type RequirementLevel = 'MANDATORY' | 'RISK_TRIGGERED' | 'BUYER_REQUESTED' | 'NOT_REQUIRED';
export type SupplierRiskTier = 'LOW' | 'MEDIUM' | 'HIGH';

const RISK_ORDER: Record<SupplierRiskTier, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

export interface RuleCandidate {
  id: string;
  name: string;
  level: 'MANDATORY' | 'RISK_TRIGGERED';
  priority: number;
  createdAt: Date;
  isActive: boolean;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  categoryId: string | null;
  minOrderValueMinor: bigint | null;
  currency: string | null;
  destinationCountries: string[] | null;
  supplierRiskAtLeast: SupplierRiskTier | null;
  planId: string | null;
  preferredAgencyId: string | null;
  allowConditionalRelease: boolean;
}

export interface OrderFacts {
  /** Every category on the order, with its ancestors - `path` ids plus its own. */
  categoryIds: string[];
  /** The seller's part of the order, goods only, minor units. */
  valueMinor: bigint;
  currency: string;
  /** Alpha-2, upper case. */
  destinationCountry: string | null;
  supplierRisk: SupplierRiskTier;
  buyerRequested: boolean;
  now: Date;
}

export interface RequirementDecision {
  level: RequirementLevel;
  ruleId: string | null;
  ruleName: string | null;
  reason: string;
  planId: string | null;
  preferredAgencyId: string | null;
  allowConditionalRelease: boolean;
  /** Which conditions matched, for the record. */
  matched: string[];
}

export function ruleMatches(rule: RuleCandidate, facts: OrderFacts): { matches: boolean; matched: string[] } {
  const matched: string[] = [];

  if (!rule.isActive) return { matches: false, matched };
  if (rule.effectiveFrom.getTime() > facts.now.getTime()) return { matches: false, matched };
  if (rule.effectiveTo !== null && rule.effectiveTo.getTime() <= facts.now.getTime()) {
    return { matches: false, matched };
  }

  if (rule.categoryId !== null) {
    if (!facts.categoryIds.includes(rule.categoryId)) return { matches: false, matched };
    matched.push('category');
  }

  if (rule.minOrderValueMinor !== null) {
    // A value threshold is in one currency. An order in another currency does
    // not meet it - converting here would make the rule's meaning depend on
    // the day's exchange rate, which nobody setting it meant.
    if (rule.currency === null || rule.currency !== facts.currency) return { matches: false, matched };
    if (facts.valueMinor < rule.minOrderValueMinor) return { matches: false, matched };
    matched.push('value');
  }

  if (rule.destinationCountries !== null && rule.destinationCountries.length > 0) {
    if (facts.destinationCountry === null) return { matches: false, matched };
    if (!rule.destinationCountries.includes(facts.destinationCountry)) return { matches: false, matched };
    matched.push('destination');
  }

  if (rule.supplierRiskAtLeast !== null) {
    if (RISK_ORDER[facts.supplierRisk] < RISK_ORDER[rule.supplierRiskAtLeast]) {
      return { matches: false, matched };
    }
    matched.push('supplierRisk');
  }

  if (matched.length === 0) matched.push('policy');

  return { matches: true, matched };
}

export function decideRequirement(rules: readonly RuleCandidate[], facts: OrderFacts): RequirementDecision {
  const hits = rules
    .map((rule) => ({ rule, ...ruleMatches(rule, facts) }))
    .filter((hit) => hit.matches)
    .sort(
      (a, b) =>
        (a.rule.level === b.rule.level ? 0 : a.rule.level === 'MANDATORY' ? -1 : 1) ||
        a.rule.priority - b.rule.priority ||
        a.rule.createdAt.getTime() - b.rule.createdAt.getTime() ||
        a.rule.id.localeCompare(b.rule.id),
    );

  const winner = hits[0];

  if (winner !== undefined) {
    const words = winner.matched.map((key) => MATCH_WORDS[key] ?? key).join(', ');
    return {
      level: winner.rule.level,
      ruleId: winner.rule.id,
      ruleName: winner.rule.name,
      reason: `${winner.rule.level === 'MANDATORY' ? 'Mandatory' : 'Risk-triggered'} by the rule "${winner.rule.name}" (${words}).`,
      planId: winner.rule.planId,
      preferredAgencyId: winner.rule.preferredAgencyId,
      allowConditionalRelease: winner.rule.allowConditionalRelease,
      matched: winner.matched,
    };
  }

  if (facts.buyerRequested) {
    return {
      level: 'BUYER_REQUESTED',
      ruleId: null,
      ruleName: null,
      reason: 'No rule requires it; the buyer asked for an inspection.',
      planId: null,
      preferredAgencyId: null,
      allowConditionalRelease: true,
      matched: ['buyerRequest'],
    };
  }

  return {
    level: 'NOT_REQUIRED',
    ruleId: null,
    ruleName: null,
    reason: 'No inspection rule applies to this order.',
    planId: null,
    preferredAgencyId: null,
    allowConditionalRelease: true,
    matched: [],
  };
}

const MATCH_WORDS: Record<string, string> = {
  category: 'category',
  value: 'order value',
  destination: 'destination country',
  supplierRisk: 'supplier risk',
  policy: 'platform policy for every order',
};

/**
 * The supplier's risk: the operator's own rating, raised to HIGH when the
 * seller has failed enough inspections recently. The higher of the two wins,
 * so a rating of LOW does not hide a run of failures.
 */
export function supplierRiskFrom(input: {
  rated: SupplierRiskTier | null;
  recentFailures: number;
  failThreshold: number;
}): SupplierRiskTier {
  const computed: SupplierRiskTier =
    input.failThreshold > 0 && input.recentFailures >= input.failThreshold ? 'HIGH' : 'LOW';
  const rated = input.rated ?? 'LOW';
  return RISK_ORDER[computed] > RISK_ORDER[rated] ? computed : rated;
}

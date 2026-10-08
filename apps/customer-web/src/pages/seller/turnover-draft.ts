/**
 * The eligibility card's draft and what it means: the state the card edits,
 * how far it is from eligible, and the request body it becomes. Kept apart
 * from the component file so React fast refresh can reload the card.
 */
import { useI18n } from '@/i18n/i18n-context';
import {
  compactEquivalent,
  croreFigure,
  exceedsMinimum,
  formatTurnover,
  parseTurnoverEntry,
  type TurnoverDeclarationInput,
  type TurnoverEntryProblem,
  type TurnoverPolicy,
  type TurnoverUnit,
} from '@/lib/turnover';

export interface TurnoverDraft {
  amountText: string;
  unit: TurnoverUnit;
  /** `start|end` of the chosen financial year, or '' for none. */
  yearKey: string;
  declared: boolean;
  /** Set once the amount has been left or submitted, so an empty field is not an error on arrival. */
  touched: boolean;
}

export function emptyTurnoverDraft(policy: TurnoverPolicy): TurnoverDraft {
  const year = policy.suggestedFinancialYear;
  return {
    amountText: '',
    unit: policy.currency === 'INR' ? 'CRORE' : 'MAJOR',
    yearKey: `${year.start}|${year.end}`,
    declared: false,
    touched: false,
  };
}

export type TurnoverEvaluation =
  | { state: 'INVALID'; problem: TurnoverEntryProblem | null; yearMissing: boolean }
  | { state: 'BELOW'; amountMinor: bigint }
  | { state: 'ELIGIBLE'; amountMinor: bigint };

/** Where a draft stands. `INVALID` with no problem means "nothing typed yet". */
export function evaluateTurnover(draft: TurnoverDraft, policy: TurnoverPolicy): TurnoverEvaluation {
  const yearMissing = draft.yearKey.length === 0;
  const parsed = parseTurnoverEntry(draft.amountText, draft.unit, policy.currencyExponent);
  if (!parsed.ok) return { state: 'INVALID', problem: parsed.problem, yearMissing };
  if (yearMissing) return { state: 'INVALID', problem: null, yearMissing };
  return exceedsMinimum(parsed.minor, policy)
    ? { state: 'ELIGIBLE', amountMinor: parsed.minor }
    : { state: 'BELOW', amountMinor: parsed.minor };
}

/** The request body for a draft, or null while it is not complete. */
export function turnoverInputFor(draft: TurnoverDraft, policy: TurnoverPolicy): TurnoverDeclarationInput | null {
  const evaluation = evaluateTurnover(draft, policy);
  if (evaluation.state === 'INVALID' || !draft.declared) return null;
  const [start = '', end = ''] = draft.yearKey.split('|');
  return {
    amountMinor: evaluation.amountMinor.toString(),
    currency: policy.currency,
    financialYearStart: start,
    financialYearEnd: end,
    declarationAccepted: true,
  };
}

/** The minimum, the way this page states it: "₹30 crore" for INR. */
export function useThresholdText(policy: TurnoverPolicy): { threshold: string; equivalent: string | null } {
  const { t, intlLocale } = useI18n();
  const minimum = BigInt(policy.minimumMinor);
  if (policy.currency === 'INR') {
    return {
      threshold: t('seller.turnover.croreAmount', { amount: croreFigure(minimum, policy.currencyExponent) }),
      equivalent: compactEquivalent(minimum, policy, intlLocale),
    };
  }
  return { threshold: formatTurnover(minimum, policy, intlLocale), equivalent: null };
}

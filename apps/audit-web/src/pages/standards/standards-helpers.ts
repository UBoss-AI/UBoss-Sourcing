/**
 * Non-component helpers for the standards screens (rules, checklists, team).
 *
 * Kept out of the component files so Fast Refresh keeps their state, and so
 * the conversions between a form's strings and the API's shapes are in one
 * readable place.
 */
import type { CoverageRow, RuleInput, RuleView } from '@/lib/console-types';

/** The AQL values the sampling table supports, in the server's own spelling. */
export const SUPPORTED_AQL = [
  '0',
  '0.010',
  '0.015',
  '0.025',
  '0.040',
  '0.065',
  '0.10',
  '0.15',
  '0.25',
  '0.40',
  '0.65',
  '1.0',
  '1.5',
  '2.5',
  '4.0',
  '6.5',
] as const;

export const INSPECTION_LEVELS = ['I', 'II', 'III'] as const;

export const AGENCY_ROLES = ['AGENCY_ADMIN', 'COORDINATOR', 'INSPECTOR', 'QA_REVIEWER'] as const;
export type AgencyRoleName = (typeof AGENCY_ROLES)[number];

/** The rule draft form, every field as the form holds it. */
export interface RuleFormValues {
  code: string;
  name: string;
  description: string;
  requiredEvidence: string;
  obligation: RuleInput['obligation'];
  level: RuleInput['level'];
  categoryIds: string[];
  includeDescendants: boolean;
  supplyRoles: string[];
  originCountries: string[];
  destinationMarkets: string[];
  riskClasses: string[];
  productTypeNote: string;
  intendedUseNote: string;
  applicability: RuleInput['applicability'];
  applicabilityNote: string;
  expiryKind: RuleInput['expiryKind'];
  reviewMonths: string;
  sourceUrl: string;
  sourceTitle: string;
  sourcePublisher: string;
  lastReviewedOn: string;
  confidence: '' | 'HIGH' | 'MEDIUM' | 'LOW';
  effectiveFrom: string;
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function emptyRuleForm(): RuleFormValues {
  return {
    code: '',
    name: '',
    description: '',
    requiredEvidence: '',
    obligation: 'LEGAL',
    level: 'SELLER_CATEGORY',
    categoryIds: [],
    includeDescendants: true,
    supplyRoles: [],
    originCountries: [],
    destinationMarkets: [],
    riskClasses: [],
    productTypeNote: '',
    intendedUseNote: '',
    applicability: 'APPLIES',
    applicabilityNote: '',
    expiryKind: 'DOCUMENT_EXPIRY',
    reviewMonths: '',
    sourceUrl: 'https://',
    sourceTitle: '',
    sourcePublisher: '',
    lastReviewedOn: todayIso(),
    confidence: '',
    effectiveFrom: '',
  };
}

export function ruleToForm(rule: RuleView): RuleFormValues {
  return {
    code: rule.code,
    name: rule.name,
    description: rule.description,
    requiredEvidence: rule.requiredEvidence,
    obligation: rule.obligation,
    level: rule.level,
    categoryIds: [...rule.categoryIds],
    includeDescendants: rule.includeDescendants,
    supplyRoles: [...rule.supplyRoles],
    originCountries: [...rule.originCountries],
    destinationMarkets: [...rule.destinationMarkets],
    riskClasses: [...rule.riskClasses],
    productTypeNote: rule.productTypeNote ?? '',
    intendedUseNote: rule.intendedUseNote ?? '',
    applicability: rule.applicability,
    applicabilityNote: rule.applicabilityNote ?? '',
    expiryKind: rule.expiryKind,
    reviewMonths: rule.reviewMonths === null ? '' : String(rule.reviewMonths),
    sourceUrl: rule.sourceUrl,
    sourceTitle: rule.sourceTitle,
    sourcePublisher: rule.sourcePublisher,
    lastReviewedOn: rule.lastReviewedOn,
    confidence: rule.confidence ?? '',
    effectiveFrom: rule.effectiveFrom === null ? '' : rule.effectiveFrom.slice(0, 10),
  };
}

const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());

export function formToRuleInput(values: RuleFormValues): RuleInput {
  const months = Number.parseInt(values.reviewMonths, 10);
  return {
    code: values.code.trim().toUpperCase(),
    name: values.name.trim(),
    description: values.description.trim(),
    requiredEvidence: values.requiredEvidence.trim(),
    obligation: values.obligation,
    level: values.level,
    categoryIds: values.categoryIds,
    includeDescendants: values.includeDescendants,
    supplyRoles: values.supplyRoles,
    originCountries: values.originCountries,
    destinationMarkets: values.destinationMarkets,
    riskClasses: values.riskClasses,
    productTypeNote: orNull(values.productTypeNote),
    intendedUseNote: orNull(values.intendedUseNote),
    applicability: values.applicability,
    applicabilityNote: orNull(values.applicabilityNote),
    expiryKind: values.expiryKind,
    reviewMonths: values.expiryKind === 'PERIODIC_REVIEW' && Number.isFinite(months) ? months : null,
    sourceUrl: values.sourceUrl.trim(),
    sourceTitle: values.sourceTitle.trim(),
    sourcePublisher: values.sourcePublisher.trim(),
    lastReviewedOn: values.lastReviewedOn,
    confidence: values.confidence === '' ? null : values.confidence,
    effectiveFrom: values.effectiveFrom === '' ? null : values.effectiveFrom,
  };
}

/** Problems the form can see before sending; keys are field names, values are i18n key suffixes. */
export function ruleFormProblems(values: RuleFormValues): Record<string, string> {
  const problems: Record<string, string> = {};
  if (!/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(values.code.trim().toUpperCase())) problems.code = 'codeInvalid';
  if (values.name.trim().length < 3) problems.name = 'tooShort';
  if (values.description.trim().length < 10) problems.description = 'tooShort';
  if (values.requiredEvidence.trim().length < 5) problems.requiredEvidence = 'tooShort';
  if (values.categoryIds.length === 0) problems.categoryIds = 'categoryRequired';
  if (!values.sourceUrl.trim().startsWith('https://') || values.sourceUrl.trim().length < 12) problems.sourceUrl = 'httpsRequired';
  if (values.sourceTitle.trim().length < 3) problems.sourceTitle = 'tooShort';
  if (values.sourcePublisher.trim().length < 2) problems.sourcePublisher = 'tooShort';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.lastReviewedOn)) problems.lastReviewedOn = 'dateRequired';
  if (values.expiryKind === 'PERIODIC_REVIEW') {
    const months = Number.parseInt(values.reviewMonths, 10);
    if (!Number.isFinite(months) || months < 1 || months > 240) problems.reviewMonths = 'monthsInvalid';
  }
  return problems;
}

/** Category id → name, from the coverage list. */
export function categoryNames(rows: CoverageRow[] | undefined): Map<string, string> {
  return new Map((rows ?? []).map((row) => [row.categoryId, row.name]));
}

/** A checklist line as the plan form holds it. */
export interface PlanLineValues {
  key: string;
  code: string;
  section: string;
  label: string;
  requirement: string;
  tolerance: string;
  kind: string;
  mandatory: boolean;
  requiresLabReport: boolean;
  requiresEquipment: boolean;
}

let lineCounter = 0;

export function emptyPlanLine(): PlanLineValues {
  lineCounter += 1;
  return {
    key: `line-${String(lineCounter)}`,
    code: '',
    section: 'PRODUCT',
    label: '',
    requirement: '',
    tolerance: '',
    kind: '',
    mandatory: false,
    requiresLabReport: false,
    requiresEquipment: false,
  };
}

export const CHECK_CODE_PATTERN = /^[A-Z0-9_.-]{1,48}$/i;

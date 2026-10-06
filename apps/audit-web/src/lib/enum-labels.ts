/**
 * Server enums as words, and the tone of the badge that carries them.
 *
 * Every family has its keys in `en.json` under `enum.<family>.<VALUE>`. A
 * value the server adds later that this file has not met yet is still shown,
 * as a readable form of the raw value - a badge that says "Under Appeal" is
 * honest; a blank one is not.
 *
 * Tones never carry meaning alone: a badge always holds its words.
 */
import type { BadgeTone } from '@/components/ui';
import type { Translate, TranslationKey } from '@/i18n/i18n-context';
import { humanise } from './format';

export type EnumFamily =
  | 'applicability'
  | 'caseLevel'
  | 'caseStatus'
  | 'checkKind'
  | 'checkOutcome'
  | 'checklistSection'
  | 'confidence'
  | 'countingMethod'
  | 'determination'
  | 'documentBadge'
  | 'documentStatus'
  | 'documentType'
  | 'evidencePurpose'
  | 'expiryKind'
  | 'inspectionPointType'
  | 'integrity'
  | 'jobKind'
  | 'jobStatus'
  | 'memberStatus'
  | 'ncrStatus'
  | 'obligation'
  | 'readiness'
  | 'reconciliation'
  | 'reportResult'
  | 'reportStatus'
  | 'requirementState'
  | 'riskClass'
  | 'ruleStatus'
  | 'scanState'
  | 'scopeMethod'
  | 'sellerKind'
  | 'sellerStatus'
  | 'severity'
  | 'slaState'
  | 'stage'
  | 'subLotState'
  | 'supplyRole'
  | 'trustCheckState'
  | 'unit'
  | 'verificationMethod'
  | 'verificationOutcome';

/** The words for one enum value. Unknown values read as Title Case, never as blank. */
export function enumLabel(t: Translate, family: EnumFamily, value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  return t(`enum.${family}.${value}` as TranslationKey, { defaultValue: humanise(value) });
}

const TONES: Partial<Record<EnumFamily, Record<string, BadgeTone>>> = {
  jobStatus: {
    REQUESTED: 'warning',
    ACCEPTED: 'accent',
    INSPECTOR_ASSIGNED: 'accent',
    IN_PROGRESS: 'operational',
    REPORT_SUBMITTED: 'warning',
    COMPLETED: 'success',
    DECLINED: 'neutral',
    CANCELLED: 'neutral',
  },
  slaState: { ON_TIME: 'success', ACCEPT_OVERDUE: 'danger', REPORT_OVERDUE: 'danger' },
  caseStatus: {
    REQUESTED: 'warning',
    UNDER_REVIEW: 'accent',
    CHANGES_REQUESTED: 'warning',
    QUALIFIED: 'success',
    REJECTED: 'danger',
    SUSPENDED: 'danger',
    EXPIRED: 'danger',
    REREVIEW_REQUIRED: 'warning',
    WITHDRAWN: 'neutral',
  },
  documentStatus: {
    DRAFT: 'neutral',
    SUBMITTED: 'warning',
    UNDER_REVIEW: 'accent',
    CHANGES_REQUESTED: 'warning',
    APPROVED: 'success',
    REJECTED: 'danger',
    EXPIRED: 'danger',
    SUSPENDED: 'danger',
  },
  documentBadge: {
    EVIDENCE_REVIEWED: 'accent',
    VERIFIED_WITH_ISSUER_OR_REGISTER: 'success',
    EVIDENCE_REVIEWED_REGISTER_UNAVAILABLE: 'warning',
  },
  verificationOutcome: { NOT_CHECKED: 'neutral', VERIFIED: 'success', UNABLE_TO_VERIFY: 'warning', MISMATCH: 'danger' },
  requirementState: {
    SATISFIED: 'success',
    MISSING: 'danger',
    EXPIRED: 'danger',
    WRONG_SCOPE: 'danger',
    PENDING_REVIEW: 'warning',
    NOT_APPLICABLE: 'neutral',
    NEEDS_DETERMINATION: 'warning',
    UNRESOLVED: 'warning',
    OPTIONAL_NOT_HELD: 'neutral',
  },
  obligation: { LEGAL: 'brand', CONTRACTUAL: 'accent', OPTIONAL_QUALIFICATION: 'neutral' },
  applicability: { APPLIES: 'neutral', CONDITIONAL: 'warning', UNRESOLVED: 'danger' },
  determination: { APPLIES: 'accent', NOT_APPLICABLE: 'neutral', UNRESOLVED: 'warning' },
  ruleStatus: { DRAFT: 'neutral', IN_REVIEW: 'warning', APPROVED: 'success', REJECTED: 'danger', RETIRED: 'neutral' },
  confidence: { HIGH: 'success', MEDIUM: 'warning', LOW: 'danger' },
  severity: { CRITICAL: 'danger', MAJOR: 'warning', MINOR: 'neutral' },
  ncrStatus: { OPEN: 'danger', CAPA_SUBMITTED: 'warning', VERIFIED_CLOSED: 'success' },
  reportStatus: { SUBMITTED: 'warning', RETURNED: 'danger', SIGNED: 'success' },
  reportResult: { PASS: 'success', FAIL: 'danger', INCONCLUSIVE: 'warning' },
  integrity: { VERIFIED: 'success', MISMATCH: 'danger', UNSIGNED: 'neutral' },
  checkOutcome: { CONFORM: 'success', NONCONFORM: 'danger', NOT_APPLICABLE: 'neutral' },
  subLotState: { PENDING_APPROVAL: 'warning', APPROVED: 'success', REJECTED: 'danger', CANCELLED: 'neutral' },
  reconciliation: { NOT_VERIFIED: 'neutral', MATCHES: 'success', SHORT: 'danger', EXCESS: 'warning' },
  memberStatus: { INVITED: 'warning', ACTIVE: 'success', DISABLED: 'neutral' },
  sellerStatus: {
    DRAFT: 'neutral',
    SUBMITTED: 'warning',
    UNDER_REVIEW: 'accent',
    ACTION_REQUIRED: 'warning',
    APPROVED: 'success',
    REJECTED: 'danger',
    SUSPENDED: 'danger',
  },
  trustCheckState: { PENDING: 'warning', VERIFIED: 'success', REJECTED: 'danger' },
  scanState: { CLEAN: 'success', PENDING_SCAN: 'warning' },
  readiness: { READY: 'success', NOT_READY: 'warning' },
  stage: { RAW_MATERIAL: 'neutral', DURING_PRODUCTION: 'neutral', PRE_SHIPMENT: 'neutral', RECEIVING: 'neutral' },
  scopeMethod: { FULL: 'operational', SAMPLE: 'neutral' },
  jobKind: { INITIAL: 'neutral', REINSPECTION: 'warning' },
};

export function enumTone(family: EnumFamily, value: string | null | undefined): BadgeTone {
  if (value === null || value === undefined) return 'neutral';
  return TONES[family]?.[value] ?? 'neutral';
}

/** A short place line from an inspection point's JSON: name, city, country - whichever are there. */
export function placeLine(point: unknown): string | null {
  if (point === null || typeof point !== 'object') return null;
  const record = point as Record<string, unknown>;
  const parts = ['name', 'line1', 'city', 'country']
    .map((key) => record[key])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return parts.length === 0 ? null : parts.join(', ');
}

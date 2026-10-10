/** Badge tones for Shipment Assessment statuses and check outcomes. */
import type { BadgeTone } from '@/components/ui';
import type { AssessmentStatus, CheckOutcome } from '@/lib/shipment-assessment';

export const STATUS_TONE: Record<AssessmentStatus, BadgeTone> = {
  AWAITING_L1: 'neutral',
  READY_FOR_ASSESSMENT: 'brand',
  IN_PROGRESS: 'action',
  AWAITING_QA: 'action',
  WAIVER_REVIEW: 'brand',
  APPROVED_FOR_L2: 'success',
  FAILED: 'danger',
  ON_HOLD: 'danger',
  REASSESSMENT_REQUIRED: 'warning',
  DISPATCHED: 'operational',
  CANCELLED: 'neutral',
};

export const OUTCOME_TONE: Record<CheckOutcome, BadgeTone> = { PASS: 'success', FAIL: 'danger', HOLD: 'warning', NOT_APPLICABLE: 'neutral' };

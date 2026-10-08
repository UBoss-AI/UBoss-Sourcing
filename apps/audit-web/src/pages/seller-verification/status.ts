import type { BadgeTone } from '@/components/ui';
import type { SellerApplicationStatus, VerificationDecisionStatus } from '@/lib/seller-verification';

export const STATUS_TONE: Record<SellerApplicationStatus, BadgeTone> = {
  DRAFT: 'neutral',
  SUBMITTED: 'brand',
  UNDER_REVIEW: 'brand',
  ACTION_REQUIRED: 'warning',
  APPROVED: 'success',
  REJECTED: 'danger',
  SUSPENDED: 'danger',
};

/**
 * The decisions the state machine allows from here, for the Audit Team.
 * Lifting a suspension is not one of them: it stays an Admin Panel control.
 * The server refuses anything else anyway; this is so it is never offered.
 */
export function decisionsFor(status: SellerApplicationStatus): VerificationDecisionStatus[] {
  switch (status) {
    case 'SUBMITTED':
      return ['UNDER_REVIEW', 'APPROVED', 'ACTION_REQUIRED', 'REJECTED'];
    case 'UNDER_REVIEW':
      return ['APPROVED', 'ACTION_REQUIRED', 'REJECTED'];
    case 'ACTION_REQUIRED':
      return ['REJECTED'];
    case 'APPROVED':
      return ['ACTION_REQUIRED'];
    case 'SUSPENDED':
      return ['ACTION_REQUIRED', 'REJECTED'];
    case 'REJECTED':
      return ['ACTION_REQUIRED'];
    case 'DRAFT':
      return [];
  }
}

/** A reason the seller reads is required for these. */
export const NEEDS_REASON: ReadonlySet<VerificationDecisionStatus> = new Set(['ACTION_REQUIRED', 'REJECTED']);

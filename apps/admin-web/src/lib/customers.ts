/**
 * Customer types and status presentation, shared by the list and detail pages.
 *
 * Kept out of the page files so those export only components - a file that
 * mixes the two cannot keep its state across a Fast Refresh edit.
 */
import type { BadgeTone } from '@/components/ui';

export interface CustomerLimits {
  perOrderMinMinor: string | null;
  perOrderMaxMinor: string | null;
  monthlySpendCapMinor: string | null;
  requiresOrderApproval: boolean;
  approvalThresholdMinor: string | null;
}

export interface CustomerListItem {
  id: string;
  userId: string;
  email: string;
  status: string;
  fullName: string | null;
  organization: string | null;
  department: string | null;
  phone: string | null;
  customerCode: string | null;
  activatedAt: string | null;
  invitedAt: string | null;
  lastLoginAt: string | null;
  orderCount: number;
  scheduleCount: number;
  addressCount: number;
  limits: CustomerLimits;
  createdAt: string;
}

/** Colour is a second signal; the badge always carries its label too. */
export function customerStatusTone(status: string): BadgeTone {
  if (status === 'ACTIVE') return 'success';
  if (status === 'INVITED' || status === 'PENDING') return 'warning';
  if (status === 'SUSPENDED' || status === 'DISABLED') return 'danger';
  return 'neutral';
}

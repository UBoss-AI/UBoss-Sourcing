/**
 * Customer types and status presentation, shared by the list and detail pages.
 *
 * Kept out of the page files so those export only components - a file that
 * mixes the two cannot keep its state across a Fast Refresh edit.
 */
import type { BadgeTone } from '@/components/ui';

/** Agreed terms for one market. Amounts are strings of minor units. */
export interface CurrencyLimits {
  currencyCode: string;
  perOrderMinMinor: string | null;
  perOrderMaxMinor: string | null;
  monthlySpendCapMinor: string | null;
  approvalThresholdMinor: string | null;
}

export interface CustomerLimits {
  /** A policy about the account, so it is not per currency. */
  requiresOrderApproval: boolean;
  /** One entry per market this account may order in. Empty means none. */
  perCurrency: CurrencyLimits[];
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

/**
 * Colour is a second signal; the badge always carries its label too.
 *
 * The names are `UserStatus` from the schema, verbatim. They used to be a
 * guess - INVITED, SUSPENDED, PENDING - none of which the backend has ever
 * sent, so every non-active customer rendered grey.
 */
export function customerStatusTone(status: string): BadgeTone {
  if (status === 'ACTIVE') return 'success';
  // Both are waiting on somebody: an invitation to be opened, or a colleague
  // to approve a self-registered account.
  if (status === 'PENDING_INVITATION' || status === 'PENDING_APPROVAL') return 'warning';
  if (status === 'DEACTIVATED') return 'danger';
  return 'neutral';
}

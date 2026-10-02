/**
 * Maker-checker helpers shared by the record pages (JOURNEY-061).
 *
 * Kept apart from `components/governance.tsx` so that file exports only
 * components (fast refresh).
 */
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import { useI18n } from '@/i18n/i18n-context';
import { humanise } from './format';

export interface PendingAction {
  id: string;
  kind: 'SELLER_SUSPEND' | 'SELLER_REJECT' | 'CUSTOMER_DEACTIVATE' | 'BUYER_COMPANY_SUSPEND';
  status: string;
  resourceType: string;
  resourceId: string;
  resourceLabel: string;
  reason: string;
  requestedById: string;
  requestedByEmail: string;
  requestedAt: string;
  decidedByEmail: string | null;
  decidedAt: string | null;
  failureMessage: string | null;
}

/** True when a write answered 202 with a request waiting for a second approver. */
export function isPendingResponse(value: unknown): value is { pending: PendingAction } {
  return typeof value === 'object' && value !== null && 'pending' in value;
}

export const PENDING_ACTIONS_KEY = ['admin-pending-actions'] as const;

/** The toast after a write that went for approval instead of happening. */
export function usePendingNotice(): (pending: PendingAction) => void {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  return (pending) => {
    toast.success(t('governance.pending.sent', { label: pending.resourceLabel }));
    void queryClient.invalidateQueries({ queryKey: PENDING_ACTIONS_KEY });
  };
}

/** A role key as words, for the queue owner columns. */
export function roleLabel(role: string): string {
  return humanise(role);
}

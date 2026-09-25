/** Which badge colour a status and a priority wear, in the queue and the header alike. */
import type { BadgeTone } from '@/components/ui';
import type { ChatPriority, ChatStatus } from '@/lib/preorder-chats';

export function statusTone(status: ChatStatus): BadgeTone {
  switch (status) {
    case 'NEW':
      return 'action';
    case 'OPEN':
      return 'brand';
    case 'WAITING_FOR_CUSTOMER':
    case 'WAITING_FOR_INTERNAL':
      return 'warning';
    case 'RESOLVED':
      return 'success';
    case 'SPAM':
    case 'BLOCKED':
      return 'danger';
    default:
      return 'neutral';
  }
}

export function priorityTone(priority: ChatPriority): BadgeTone {
  switch (priority) {
    case 'URGENT':
      return 'danger';
    case 'HIGH':
      return 'warning';
    case 'LOW':
      return 'neutral';
    default:
      return 'neutral';
  }
}

/** How close a wait is to the response target, as a word and a colour. */
export function slaState(waitingMinutes: number | null, slaMinutes: number | null): 'breached' | 'approaching' | 'ok' | null {
  if (waitingMinutes === null) return null;
  if (slaMinutes === null) return 'ok';
  if (waitingMinutes >= slaMinutes) return 'breached';
  if (waitingMinutes >= slaMinutes * 0.75) return 'approaching';
  return 'ok';
}

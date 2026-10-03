/**
 * How the notification centre arranges what arrived (ENH-020): escalated,
 * unread alerts first and deduplicated (one row per event and subject, with a
 * count); low-priority news bundled into one row per family; the rest as sent.
 */
import type { AccountNotification } from '@/lib/types';

export interface UrgentAlert { entry: AccountNotification; count: number }
export interface LowBundle { family: string; entries: AccountNotification[] }

export function arrangeNotifications(list: AccountNotification[]): { urgent: UrgentAlert[]; rest: AccountNotification[]; bundles: LowBundle[] } {
  const urgent = new Map<string, UrgentAlert>();
  const bundles = new Map<string, AccountNotification[]>();
  const rest: AccountNotification[] = [];
  for (const entry of list) {
    if (entry.escalation != null && (entry.readAt ?? null) === null) {
      const key = `${entry.eventKey}\n${entry.relatedType ?? ''}\n${entry.relatedId ?? ''}`;
      const seen = urgent.get(key);
      // The list arrives newest first, so the first one kept is the latest.
      if (seen === undefined) urgent.set(key, { entry, count: 1 });
      else seen.count += 1;
    } else if (entry.priority === 'LOW') {
      const family = entry.family ?? 'other';
      bundles.set(family, [...(bundles.get(family) ?? []), entry]);
    } else {
      rest.push(entry);
    }
  }
  return {
    urgent: [...urgent.values()],
    rest,
    bundles: [...bundles.entries()].map(([family, entries]) => ({ family, entries })),
  };
}

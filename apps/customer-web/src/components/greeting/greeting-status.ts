/**
 * What the greeting page knows about the customer looking at it.
 *
 * Three reads, all of them optional, none of them able to break the page:
 * the account profile (for a name to greet), the repeat purchases (for the
 * next delivery) and the auto-pay settings (for whether anything can actually
 * be charged when that delivery comes round).
 *
 * **Nothing here is fetched for a guest.** Every query is `enabled` behind
 * `isCustomer`, so a stranger on the front page makes exactly the same three
 * requests they made before this page existed: none.
 *
 * **Every field is allowed to be missing.** `fullName` is nullable in the API
 * and empty in plenty of real accounts; a customer may have no schedules; a
 * deployment may not offer auto-pay at all; and any of the three calls may
 * simply fail. Each of those is a section that does not render, never a
 * greeting that says "Welcome back, null" and never a page that throws.
 *
 * The query keys are deliberately the *same* keys the account screens use —
 * `['account-profile']`, `['schedules']`, `autoPayKeys.settings`. Sharing them
 * means pressing "Manage schedule" from here renders the schedule list from
 * cache instead of spinning, and an edit made over there invalidates what is
 * shown here without this module knowing anything about it.
 *
 * ---
 *
 * **One thing this deliberately does not report: whether an ERP is
 * connected.** There is no customer-facing endpoint for it, and there should
 * not be — a connection is a URL plus a credential belonging to whoever runs
 * the installation. So the ERP entry below is *guidance*, worded as an
 * explanation of how the hand-off works, and it never claims a state. A green
 * "ERP connected" chip on this page would be a decoration pretending to be a
 * status, which is worse than no chip at all.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { autoPayApi, autoPayKeys } from '@/lib/autopay';
import type { TranslationKey } from '@/i18n/i18n-context';
import type { AccountResponse, AutoPaySettings, Schedule } from '@/lib/types';

/** The next delivery a standing arrangement will produce, if there is one. */
export interface NextDelivery {
  scheduleId: string;
  name: string;
  /** The server's own description of the recurrence. Never rebuilt here. */
  summary: string;
  status: string;
  nextRunAt: string;
  itemCount: number;
}

/**
 * Something the customer may want to finish setting up.
 *
 * `warning` means an arrangement they already have will not work as it
 * stands. `info` means an explanation. Neither ever blocks anything: this
 * page's job is to say what is unfinished, not to hold the catalogue hostage
 * until it is done.
 */
export interface SetupTask {
  id: 'autopay' | 'erp';
  tone: 'warning' | 'info';
  titleKey: TranslationKey;
  bodyKey: TranslationKey;
  to?: string;
  ctaKey?: TranslationKey;
}

export interface GreetingStatus {
  /** True while any of the three reads is still in flight. */
  isPending: boolean;
  /**
   * True when a read failed.
   *
   * Reported rather than thrown. A landing page whose account summary could
   * not be loaded is still a landing page: the catalogue below it, the hub
   * above it and every link on it work perfectly well, and replacing all of
   * that with an error wall because one optional panel is missing would be a
   * far larger failure than the one that actually happened.
   */
  hasError: boolean;
  /** Ask for the failed reads again. */
  retry: () => void;
  /** The first word of a supplied full name, or null. Never an email. */
  greetingName: string | null;
  nextDelivery: NextDelivery | null;
  /** How many standing arrangements are in force. Zero is an ordinary answer. */
  activePlanCount: number;
  autoPay: AutoPaySettings | null;
  /** Whether this deployment offers automatic payment at all. */
  autoPayAvailable: boolean;
  tasks: SetupTask[];
}

/** The first word of a name, if there is a name and it has a word in it. */
function firstName(fullName: string | null): string | null {
  const trimmed = (fullName ?? '').trim();
  if (trimmed === '') return null;

  // Only the first word, so "Welcome back, Priya" rather than the full legal
  // name somebody typed into a purchasing account. Deliberately not derived
  // from the email address: `ops.procurement@` is not a person's name.
  return trimmed.split(/\s+/)[0] ?? null;
}

/** The soonest run among the arrangements that are actually going to run. */
function soonestDelivery(schedules: readonly Schedule[]): NextDelivery | null {
  const candidates = schedules
    .filter((schedule) => schedule.status === 'ACTIVE' && schedule.nextRunAt !== null)
    // Sort by the ISO string. These are UTC instants from the API in a fixed
    // format, so lexicographic order is chronological order, and comparing
    // them without constructing twelve Date objects is both cheaper and
    // immune to a browser parsing one of them into `Invalid Date`.
    .sort((a, b) => (a.nextRunAt ?? '').localeCompare(b.nextRunAt ?? ''));

  const next = candidates[0];
  if (next === undefined || next.nextRunAt === null) return null;

  return {
    scheduleId: next.id,
    name: next.name,
    summary: next.summary,
    status: next.status,
    nextRunAt: next.nextRunAt,
    itemCount: next.itemCount,
  };
}

/**
 * What still needs doing, in the order it needs doing.
 *
 * At most one auto-pay entry: a customer whose card has expired does not also
 * need to be told that automatic payment exists.
 */
function setupTasks(
  autoPay: AutoPaySettings | null,
  autoPayAvailable: boolean,
  activePlanCount: number,
): SetupTask[] {
  const tasks: SetupTask[] = [];

  const payment: Omit<SetupTask, 'tone' | 'titleKey' | 'bodyKey'> = {
    id: 'autopay',
    to: '/account/autopay',
    ctaKey: 'greeting.task.autopayCta',
  };

  if (autoPay !== null && autoPayAvailable) {
    if (autoPay.enabled && !autoPay.paymentMethodUsable) {
      // The one genuinely urgent case on this page. A charge weeks from now
      // will be attempted against a card that has already said no.
      tasks.push({
        ...payment,
        tone: 'warning',
        titleKey: 'greeting.task.cardUnusableTitle',
        bodyKey: 'greeting.task.cardUnusableBody',
      });
    } else if (autoPay.status === 'PAUSED') {
      tasks.push({
        ...payment,
        tone: 'warning',
        titleKey: 'greeting.task.autopayPausedTitle',
        bodyKey: 'greeting.task.autopayPausedBody',
      });
    } else if (autoPay.status === 'DISABLED' && activePlanCount > 0) {
      tasks.push({
        ...payment,
        tone: 'warning',
        titleKey: 'greeting.task.autopayMissingTitle',
        bodyKey: 'greeting.task.autopayMissingBody',
      });
    } else if (autoPay.status === 'DISABLED') {
      tasks.push({
        ...payment,
        tone: 'info',
        titleKey: 'greeting.task.autopayOfferTitle',
        bodyKey: 'greeting.task.autopayOfferBody',
      });
    }
  }

  /*
   * ERP guidance, and only where it is relevant.
   *
   * Shown once the customer has a standing arrangement, because that is the
   * point at which "orders arrive in your own system without anybody
   * re-typing them" stops being a feature list item and starts being
   * something they would notice the absence of. There is no CTA, because
   * there is nowhere in this app for it to point: see the header.
   */
  if (activePlanCount > 0) {
    tasks.push({
      id: 'erp',
      tone: 'info',
      titleKey: 'greeting.task.erpTitle',
      bodyKey: 'greeting.task.erpBody',
    });
  }

  return tasks;
}

export function useGreetingStatus({
  isCustomer,
  hasRecurringOrders,
}: {
  isCustomer: boolean;
  hasRecurringOrders: boolean;
}): GreetingStatus {
  const profileQuery = useQuery({
    queryKey: ['account-profile'],
    queryFn: () => api.get<AccountResponse>('/account/profile'),
    enabled: isCustomer,
    staleTime: 5 * 60_000,
  });

  const schedulesQuery = useQuery({
    queryKey: ['schedules'],
    queryFn: () => api.get<{ schedules: Schedule[] }>('/recurring-schedules'),
    enabled: isCustomer && hasRecurringOrders,
  });

  const autoPayQuery = useQuery({
    queryKey: autoPayKeys.settings,
    queryFn: () => autoPayApi.get(),
    enabled: isCustomer,
  });

  const schedules = schedulesQuery.data?.schedules ?? [];
  const activePlanCount = schedules.filter((schedule) => schedule.status === 'ACTIVE').length;

  const autoPay = autoPayQuery.data?.autoPay ?? null;
  const autoPayAvailable = autoPayQuery.data?.available ?? false;

  return {
    // `isFetching` rather than `isPending`: a disabled query is permanently
    // pending, and a guest would otherwise sit under a skeleton for ever.
    isPending:
      profileQuery.isFetching || schedulesQuery.isFetching || autoPayQuery.isFetching,
    hasError: profileQuery.isError || schedulesQuery.isError || autoPayQuery.isError,
    retry: () => {
      // `void` on each: a click handler that drops a promise swallows its
      // error, and refetching is a courtesy — a second failure should leave
      // the same message on screen, not an unhandled rejection in the console.
      void profileQuery.refetch();
      void schedulesQuery.refetch();
      void autoPayQuery.refetch();
    },
    greetingName: firstName(profileQuery.data?.profile.fullName ?? null),
    nextDelivery: soonestDelivery(schedules),
    activePlanCount,
    autoPay,
    autoPayAvailable,
    tasks: setupTasks(autoPay, autoPayAvailable, activePlanCount),
  };
}

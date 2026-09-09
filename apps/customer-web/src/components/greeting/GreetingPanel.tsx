/**
 * What a signed-in customer is shown under the greeting.
 *
 * Three bands, in the order somebody actually reads them: what they can do,
 * what is already arranged, and what is not finished. A guest sees none of
 * this — the whole component returns null — because every line of it is about
 * an account.
 *
 * The rule that shapes it: **guidance never gates.** An unfinished auto-pay
 * enrolment is reported in the third band and changes nothing about the first,
 * so a customer who has not set up automatic payment can still open their
 * orders, build a basket and schedule one. A setup notice that quietly
 * disables the buttons beside it is how a storefront turns a five-minute task
 * into a support call.
 *
 * Actions appear only where they lead somewhere. "Schedule a basket" is absent
 * on a deployment with recurring orders switched off, and "Ask AI" is absent
 * without an assistant configured — not greyed out, not present with a
 * tooltip. The one action with no route behind it is the ERP one, and it is
 * honest about that: it opens an explanation of who creates a connection and
 * where, rather than pretending to be a link. See `orchestration-nodes.ts`,
 * which makes the same distinction for the same reason.
 */
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { useStorefront } from '@/app/storefront-context';
import { useSession } from '@/auth/session-context';
import {
  AlertIcon,
  CalendarIcon,
  CartIcon,
  ChevronRightIcon,
  GridIcon,
  LinkIcon,
  SparkIcon,
} from '@/components/icons';
import { Badge, Button } from '@/components/ui';
import { cx } from '@/lib/cx';
import { openAssistantPanel } from '@/lib/assistant-panel';
import { formatDateTime } from '@/lib/format';
import { scheduleStatusLabel, scheduleStatusTone } from '@/lib/order-status';
import { useI18n } from '@/i18n/i18n-context';
import { useGreetingStatus } from './greeting-status';
import type { SetupTask } from './greeting-status';

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const ACTION_SHELL =
  'group flex h-full items-center gap-3 rounded-lg border border-border bg-surface p-3.5 ' +
  'text-left shadow-card transition-[border-color,box-shadow] hover:border-brand/40 ' +
  'hover:shadow-card-hover';

const ACTION_MARK =
  'flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-brand-soft text-brand ' +
  'ring-1 ring-inset ring-brand/15 transition-colors group-hover:bg-brand-soft-hover';

function ActionBody({
  icon: Mark,
  label,
  hint,
}: {
  icon: (props: { className?: string }) => React.JSX.Element;
  label: string;
  hint: string;
}): React.JSX.Element {
  return (
    <>
      <span aria-hidden="true" className={ACTION_MARK}>
        <Mark className="h-[1.15rem] w-[1.15rem]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold leading-snug text-ink group-hover:text-brand">
          {label}
        </span>
        <span className="mt-0.5 block text-xs leading-snug text-ink-muted">{hint}</span>
      </span>
      <ChevronRightIcon
        aria-hidden="true"
        className="h-4 w-4 shrink-0 text-ink-subtle transition-colors group-hover:text-brand"
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Setup guidance
// ---------------------------------------------------------------------------

const TASK_TONES: Record<SetupTask['tone'], string> = {
  warning: 'border-warning/30 bg-warning-soft',
  info: 'border-border bg-brand-soft/70',
};

const TASK_MARK_TONES: Record<SetupTask['tone'], string> = {
  warning: 'bg-surface text-warning ring-warning/25',
  info: 'bg-surface text-brand ring-brand/20',
};

function TaskCard({ task }: { task: SetupTask }): React.JSX.Element {
  const { t } = useI18n();

  const Mark = task.tone === 'warning' ? AlertIcon : LinkIcon;

  return (
    <li className={cx('rounded-lg border p-4', TASK_TONES[task.tone])}>
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={cx(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-md ring-1 ring-inset',
            TASK_MARK_TONES[task.tone],
          )}
        >
          <Mark className="h-4 w-4" />
        </span>

        <div className="min-w-0">
          <p className="text-title-xs text-ink">{t(task.titleKey)}</p>
          <p className="mt-1 max-w-prose text-sm leading-relaxed text-ink-muted">
            {t(task.bodyKey)}
          </p>

          {task.to !== undefined && task.ctaKey !== undefined && (
            <Link
              to={task.to}
              className="mt-2.5 inline-flex items-center gap-1 rounded text-sm font-medium text-brand hover:underline"
            >
              {t(task.ctaKey)}
              <ChevronRightIcon aria-hidden="true" className="h-4 w-4" />
            </Link>
          )}
        </div>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------

export function GreetingPanel(): React.JSX.Element | null {
  const { t } = useI18n();
  const { features } = useStorefront();
  const { isCustomer, isLoading } = useSession();

  const status = useGreetingStatus({
    isCustomer,
    hasRecurringOrders: features.recurringOrders,
  });

  const [isErpOpen, setIsErpOpen] = useState(false);
  const erpId = useId();

  // Nothing here is for a guest, and nothing here should flash into view for
  // half a second while the session is still unknown.
  if (isLoading || !isCustomer) return null;

  const { nextDelivery, tasks } = status;

  return (
    <section
      aria-labelledby="greeting-panel"
      className="mb-12 rounded-2xl border border-border bg-surface/70 p-5 shadow-card backdrop-blur-sm sm:p-6"
    >
      <h2 id="greeting-panel" className="text-title-sm text-ink">
        {t('greeting.panel.title')}
      </h2>
      <p className="mt-1 max-w-prose text-sm text-ink-muted">{t('greeting.panel.description')}</p>

      {/* --- What they can do --------------------------------------------- */}
      <ul className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <li>
          <Link to="/account/orders" className={ACTION_SHELL}>
            <ActionBody
              icon={GridIcon}
              label={t('greeting.action.dashboard')}
              hint={t('greeting.action.dashboardHint')}
            />
          </Link>
        </li>

        {features.assistant && (
          <li>
            <button type="button" onClick={openAssistantPanel} className={cx(ACTION_SHELL, 'w-full')}>
              <ActionBody
                icon={SparkIcon}
                label={t('greeting.action.askAi')}
                hint={t('greeting.action.askAiHint')}
              />
            </button>
          </li>
        )}

        <li>
          <Link to="/products" className={ACTION_SHELL}>
            <ActionBody
              icon={CartIcon}
              label={t('greeting.action.buildCart')}
              hint={t('greeting.action.buildCartHint')}
            />
          </Link>
        </li>

        {features.recurringOrders && (
          <li>
            <Link to="/schedules/new" className={ACTION_SHELL}>
              <ActionBody
                icon={CalendarIcon}
                label={t('greeting.action.scheduleCart')}
                hint={t('greeting.action.scheduleCartHint')}
              />
            </Link>
          </li>
        )}

        {/* The one action that is not a link, and says so by behaving like a
            disclosure rather than by looking disabled. */}
        <li>
          <button
            type="button"
            aria-expanded={isErpOpen}
            aria-controls={erpId}
            onClick={() => {
              setIsErpOpen((open) => !open);
            }}
            className={cx(ACTION_SHELL, 'w-full')}
          >
            <ActionBody
              icon={LinkIcon}
              label={t('greeting.action.connectErp')}
              hint={t('greeting.action.connectErpHint')}
            />
          </button>
        </li>
      </ul>

      <div
        id={erpId}
        hidden={!isErpOpen}
        className="mt-3 rounded-lg border border-border bg-brand-soft/70 p-4"
      >
        <p className="max-w-prose text-sm leading-relaxed text-ink-muted">
          {t('greeting.note.erp')}
        </p>
      </div>

      {/* --- What is already arranged ------------------------------------- */}
      {status.hasError && (
        <div
          role="status"
          className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-surface-sunken px-4 py-3"
        >
          <p className="text-sm text-ink-muted">{t('greeting.status.unavailable')}</p>
          <Button variant="ghost" size="sm" onClick={status.retry}>
            {t('common.retry')}
          </Button>
        </div>
      )}

      {features.recurringOrders && !status.hasError && (
        <div className="mt-5 rounded-lg border border-border bg-surface-sunken p-4">
          {status.isPending && nextDelivery === null ? (
            // A skeleton the same height as the row it becomes, so the panel
            // does not jump when the answer arrives.
            <div aria-hidden="true" className="h-14 animate-pulse rounded-md bg-surface-hover" />
          ) : nextDelivery === null ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-ink-muted">{t('greeting.status.noSchedule')}</p>
              <Link
                to="/schedules/new"
                className="inline-flex items-center gap-1 rounded text-sm font-medium text-brand hover:underline"
              >
                {t('greeting.status.startOne')}
                <ChevronRightIcon aria-hidden="true" className="h-4 w-4" />
              </Link>
            </div>
          ) : (
            <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
              <div className="min-w-0">
                <p className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                  {t('greeting.status.nextDelivery')}
                </p>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-sm font-semibold text-ink">
                  <span className="tabular">{formatDateTime(nextDelivery.nextRunAt)}</span>
                  <Badge tone={scheduleStatusTone(nextDelivery.status)}>
                    {scheduleStatusLabel(t, nextDelivery.status)}
                  </Badge>
                </p>
                {/* The recurrence in the server's own words, and the plan's
                    own name. Rebuilding either here would be a second
                    implementation of the recurrence rules. */}
                <p className="mt-1 text-sm text-ink-muted">
                  {nextDelivery.name} · {nextDelivery.summary} ·{' '}
                  {t('greeting.status.lineCount', { count: nextDelivery.itemCount })}
                </p>
              </div>

              <Link
                to={`/account/schedules/${nextDelivery.scheduleId}`}
                className="inline-flex shrink-0 items-center gap-1 rounded text-sm font-medium text-brand hover:underline"
              >
                {t('greeting.status.manageSchedule')}
                <ChevronRightIcon aria-hidden="true" className="h-4 w-4" />
              </Link>
            </div>
          )}
        </div>
      )}

      {/* --- What is not finished ----------------------------------------- */}
      {tasks.length > 0 && (
        <ul className="mt-5 grid gap-3 lg:grid-cols-2">
          {tasks.map((task) => (
            <TaskCard key={task.id} task={task} />
          ))}
        </ul>
      )}
    </section>
  );
}

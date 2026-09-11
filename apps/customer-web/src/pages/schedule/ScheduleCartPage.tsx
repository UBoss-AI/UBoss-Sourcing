/**
 * Schedule Cart — the other half of the cart.
 *
 * `/cart` spends a basket today. This screen is where a buyer keeps the
 * arrangements that spend one again and again, and it is the destination the
 * cart's second tab leads to.
 *
 * The shape is a list and an editor, because that is the shape of the job. A
 * hospital store keeps several independent standing orders — gloves monthly,
 * feeding sets quarterly, saline every fortnight — and the work is comparing
 * them and then changing one. A page per plan makes the comparison a
 * navigation exercise; a list with the open plan beside it does not.
 *
 * **Which plan is open lives in the URL** (`?id=`), not in component state.
 * That is what makes a schedule linkable, survivable across a refresh, and
 * reachable with the back button after the editor has been open — and it is
 * why the editor is keyed on that id, so switching plans remounts the form
 * rather than leaving one plan's unsaved quantities on another's basket.
 *
 * Nothing on this screen holds schedule data of its own. Every figure comes
 * from `/recurring-schedules`, priced by the server's own `quoteSchedule`, and
 * every write goes back through the same owner-scoped API — a plan belonging
 * to somebody else is not found, whatever id is typed into the address bar.
 */
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStorefront } from '@/app/storefront-context';
import { CartModeTabs } from '@/components/CartModeTabs';
import { Modal } from '@/components/Modal';
import { PageEmptyState } from '@/components/PageEmptyState';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  ButtonLink,
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/ui';
import { CalendarIcon, ClockIcon, PlusIcon, RepeatIcon, TrashIcon } from '@/components/icons';
import { api } from '@/lib/api';
import { cx } from '@/lib/cx';
import { errorMessage } from '@/lib/errors';
import { formatDateTime, formatMoney, formatNumber } from '@/lib/format';
import { scheduleStatusLabel, scheduleStatusTone } from '@/lib/order-status';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { useI18n } from '@/i18n/i18n-context';
import type { Schedule } from '@/lib/types';
import { NewSchedulePanel } from './NewSchedulePanel';
import { ScheduleEditor } from './ScheduleEditor';

/** One figure on a schedule card. */
function Figure({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-xxs uppercase tracking-wider text-ink-subtle">{label}</dt>
      <dd className="mt-0.5 truncate text-ink">{children}</dd>
    </div>
  );
}

/**
 * A schedule in the list.
 *
 * **The card is a `<div>` and the plan's name is the button**, stretched over
 * the whole card by a `::after` overlay — the same pattern `ProductCard` uses,
 * and for the same two reasons. A card-sized button gives a screen reader one
 * accessible name made of the card's entire text ("Gloves, monthly Every month
 * on the 9th Active Next processing …₹1,200.00"), which is not a name. And a
 * finished plan needs a Remove control *on* the card, which cannot be a button
 * inside a button.
 *
 * It selects rather than navigates: the plan opens in the panel beside the
 * list. The URL still changes — the page writes `?id=` — so the state is
 * shareable without the row pretending to be a destination.
 */
function ScheduleRow({
  schedule,
  isOpen,
  onOpen,
  onRemove,
}: {
  schedule: Schedule;
  isOpen: boolean;
  onOpen: () => void;
  /** Absent while this plan is still running. See `canRemove`. */
  onRemove?: (() => void) | undefined;
}): React.JSX.Element {
  const { t } = useI18n();

  return (
    <li>
      {/* `relative` is load-bearing: it is the containing block the stretched
          button's overlay resolves against, so the button covers this card and
          nothing outside it. */}
      <div
        className={cx(
          'relative rounded-lg border p-4 text-left transition-[box-shadow,border-color,background-color]',
          'focus-within:ring-2 focus-within:ring-brand focus-within:ring-offset-2',
          'motion-reduce:transition-none',
          isOpen
            ? // The open row is filled rather than merely outlined: "which of
              // these am I editing" is the question this column answers, and a
              // border alone answers it faintly at a glance.
              'border-brand/40 bg-brand-soft shadow-card-hover'
            : 'border-border bg-surface shadow-card hover:border-border-hover hover:shadow-card-hover',
        )}
      >
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
          <span className="min-w-0">
            <button
              type="button"
              onClick={onOpen}
              aria-current={isOpen ? 'true' : undefined}
              // The stretched button: an empty pseudo-element covering the
              // whole card, so a click anywhere on it selects this plan while
              // the accessible name stays just the plan's name.
              className="block max-w-full truncate rounded text-left text-title-xs text-ink after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
            >
              {schedule.name}
            </button>

            {/* The server's own description of the recurrence. Rebuilding it
                here would be a second implementation of the rules. */}
            <span className="mt-0.5 block truncate text-xs text-ink-muted">
              {schedule.summary}
            </span>
          </span>

          <Badge tone={scheduleStatusTone(schedule.status)}>
            {scheduleStatusLabel(t, schedule.status)}
          </Badge>
        </div>

        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border-subtle pt-3 text-sm">
          <Figure label={t('scheduleCart.nextProcessing')}>
            {schedule.nextRunAt === null ? (
              <span className="text-ink-muted">{t('schedules.notScheduled')}</span>
            ) : (
              <>
                <span className="block">{formatDateTime(schedule.nextRunAt)}</span>
                {/* The zone stays beside the date: this runs on the
                    customer's chosen wall clock, and somebody reading it from
                    another country needs to know which clock is meant. */}
                <span className="block text-xxs text-ink-subtle">{schedule.timezone}</span>
              </>
            )}
          </Figure>

          <Figure label={t('scheduleCart.items')}>
            {t('scheduleCart.itemCount', {
              count: schedule.itemCount,
              quantity: formatNumber(schedule.itemCount),
            })}
          </Figure>

          {/*
           * How it is paid for, and NOT how often.
           *
           * The recurrence is already the line under the name, in full and in
           * the server's own words. A second cell repeating it truncated to a
           * half-column told the reader nothing they had not just read, and
           * cost the card the one slot that could carry something else. How
           * each delivery is paid for is the thing a buyer comparing two
           * standing orders actually wants beside the amount.
           */}
          <Figure label={t('scheduleCart.payment')}>
            {schedule.paymentMode === 'AUTO_PAY'
              ? t('schedules.chargedAutomatically')
              : t('schedules.paymentLink')}
          </Figure>

          <Figure label={t('scheduleCart.estimatedAmount')}>
            {schedule.estimatedTotal === undefined ? (
              // The list was not asked to price itself.
              <span className="text-ink-muted">—</span>
            ) : schedule.estimatedTotal === null ? (
              // Priced, and it could not be: out of stock, an address that has
              // gone, a product withdrawn. A dash and a word, never a
              // confident 0.00.
              <span className="text-ink-muted" title={t('scheduleCart.couldNotPrice')}>
                {t('scheduleCart.notPriced')}
              </span>
            ) : (
              <span className="tabular">{formatMoney(schedule.estimatedTotal)}</span>
            )}
          </Figure>
        </dl>

        {schedule.estimateOk === false && schedule.estimatedTotal !== null && (
          <span className="mt-2 block text-xxs text-warning">
            {t('scheduleCart.needsAttention')}
          </span>
        )}

        {/*
         * Remove, on a plan that has stopped.
         *
         * `relative z-[1]` raises it above the stretched button, or it would
         * not be clickable at all — the overlay covers the whole card. The
         * same trick the product card uses to keep its SKU selectable.
         *
         * It says "remove from this list" rather than "delete", because that
         * is what it does: the plan, its consent record and its orders stay
         * exactly where they are, and staff still read them.
         */}
        {onRemove !== undefined && (
          <div className="relative z-[1] mt-3 flex justify-end border-t border-border-subtle pt-2.5">
            <button
              type="button"
              onClick={onRemove}
              aria-label={t('scheduleCart.removeFromList', { name: schedule.name })}
              className="inline-flex items-center gap-1.5 rounded px-1.5 py-1 text-xxs font-semibold text-ink-subtle transition-colors hover:bg-danger-soft hover:text-danger focus-visible:bg-danger-soft focus-visible:text-danger motion-reduce:transition-none"
            >
              <TrashIcon aria-hidden="true" className="h-3.5 w-3.5" />
              {t('scheduleCart.remove')}
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * Whether this plan can be taken off the list.
 *
 * Only a plan that has stopped. An ACTIVE or PAUSED plan is a live authority to
 * charge, and hiding one would mean money leaving an account for an arrangement
 * the customer can no longer see; a FAILED plan is one they are still allowed
 * to resume; a DRAFT is a review they can still confirm. The server refuses all
 * four — this is so the control is not offered in the first place.
 */
function canRemove(schedule: Schedule): boolean {
  return schedule.status === 'CANCELLED' || schedule.status === 'COMPLETED';
}

export function ScheduleCartPage(): React.JSX.Element {
  const { t } = useI18n();
  const { business, features } = useStorefront();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [params, setParams] = useSearchParams();
  const [isCreating, setIsCreating] = useState(false);

  /** The plan whose removal is being confirmed, if any. */
  const [removing, setRemoving] = useState<Schedule | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  useDocumentMeta({ title: t('scheduleCart.pageTitle'), noIndex: true }, business.displayName);

  const list = useQuery({
    // Priced, which is what the cards show. See the `estimate` flag on the
    // list route: it is opt-in precisely because this is the one screen that
    // needs the figures.
    queryKey: ['schedules', 'priced'],
    queryFn: () =>
      api.get<{ schedules: Schedule[]; estimatedCount?: number; estimateLimit?: number }>(
        '/recurring-schedules',
        { query: { estimate: 'true' } },
      ),
    enabled: features.recurringOrders,
  });

  const remove = useMutation({
    mutationFn: (scheduleId: string) =>
      api.post<{ hidden: boolean }>(`/recurring-schedules/${scheduleId}/hide`, {}),
    onSuccess: async (_result, scheduleId) => {
      setRemoving(null);
      setRemoveError(null);
      toast.success(t('scheduleCart.removedFromList'));

      // If the plan being removed was the one open beside the list, the editor
      // has to go with it: a form for a plan that is no longer in the list
      // reads as a page that half-finished the thing it was asked to do.
      if (scheduleId === params.get('id')) setSelection(null);

      await queryClient.invalidateQueries({ queryKey: ['schedules'] });
    },
    onError: (error) => {
      // The server names the rule — "cancel this one first, and then remove
      // it" — and that sentence is more use than "could not remove".
      setRemoveError(errorMessage(t, error, t('scheduleCart.couldNotRemove')));
    },
  });

  const selectedId = params.get('id');

  /** Select a plan, or nothing. Leaves the create panel if it was open. */
  const open = (id: string | null): void => {
    setIsCreating(false);
    setSelection(id);
  };

  const setSelection = (id: string | null): void => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (id === null) next.delete('id');
        else next.set('id', id);
        return next;
      },
      // Replace rather than push: clicking down a list of six schedules
      // should not bury the page the buyer arrived from under six history
      // entries.
      { replace: true },
    );
  };

  /**
   * Start a new plan.
   *
   * The selection is cleared as well as the panel switched, so the list has no
   * row highlighted while a plan that does not exist yet is being described —
   * a highlighted row beside a blank form reads as editing that row.
   */
  const startCreating = (): void => {
    setSelection(null);
    setIsCreating(true);
  };

  // A deployment with recurring orders switched off has one way to spend a
  // basket. Said plainly, with the way back to the cart, rather than rendering
  // an empty workspace.
  if (!features.recurringOrders) {
    return (
      <>
        <CartModeTabs current="schedule" />
        <PageEmptyState
          title={t('scheduleCart.switchedOffTitle')}
          description={t('scheduleCart.switchedOffBody')}
          action={
            <ButtonLink to="/cart" variant="primary" size="lg">
              {t('scheduleCart.backToCart')}
            </ButtonLink>
          }
        />
      </>
    );
  }

  if (list.isPending) return <LoadingState label={t('scheduleCart.loadingSchedules')} />;

  if (list.isError) {
    return (
      <ErrorState
        error={list.error}
        onRetry={() => {
          void list.refetch();
        }}
      />
    );
  }

  const schedules = list.data.schedules;
  // A plan that has since been cancelled from another tab, or an id somebody
  // typed. Falls back to the list rather than to an error: the id is not a
  // destination, it is a selection.
  const selected = schedules.find((schedule) => schedule.id === selectedId) ?? null;

  return (
    <>
      <CartModeTabs current="schedule" />

      <PageHeader
        title={t('scheduleCart.pageTitle')}
        description={t('scheduleCart.pageDescription')}
        actions={
          <Button variant="operational" onClick={startCreating}>
            <PlusIcon aria-hidden="true" className="h-4 w-4" />
            {t('scheduleCart.newSchedule')}
          </Button>
        }
      />

      {/*
       * Removing asks first.
       *
       * Not because it is dangerous — it is the least dangerous act on this
       * screen — but because it is irreversible from the customer's side, and
       * the dialog is where the two halves of what it does can both be said:
       * the card goes, the record does not.
       */}
      <Modal
        isOpen={removing !== null}
        onClose={() => {
          setRemoving(null);
        }}
        title={
          removing === null ? '' : t('scheduleCart.removeQuestion', { name: removing.name })
        }
        footer={
          <>
            <Button
              disabled={remove.isPending}
              onClick={() => {
                setRemoving(null);
              }}
            >
              {t('scheduleCart.keepItOnTheList')}
            </Button>
            <Button
              variant="danger"
              isLoading={remove.isPending}
              onClick={() => {
                if (removing !== null) remove.mutate(removing.id);
              }}
            >
              {t('scheduleCart.removeIt')}
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <p className="text-ink-muted">{t('scheduleCart.removeExplain')}</p>

          {removeError !== null && (
            <p
              role="alert"
              className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-danger"
            >
              {removeError}
            </p>
          )}
        </div>
      </Modal>

      {schedules.length === 0 && !isCreating ? (
        <PageEmptyState
          title={t('scheduleCart.noneYetTitle')}
          description={t('scheduleCart.noneYetBody')}
          action={
            <Button variant="operational" size="lg" onClick={startCreating}>
              <RepeatIcon aria-hidden="true" className="h-4 w-4" />
              {t('scheduleCart.createFirst')}
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[22rem_minmax(0,1fr)] lg:items-start">
          {/* --- The plans ---------------------------------------------------- */}
          <section
            aria-labelledby="schedule-list-heading"
            // Sticky from `lg`, offset to clear the sticky header. Below that
            // it is an ordinary block above the editor: a pinned list on a
            // phone is a list covering the form it selects into.
            className="lg:sticky lg:top-28 lg:self-start"
          >
            <h2
              id="schedule-list-heading"
              className="mb-2 flex items-center gap-2 text-xxs font-semibold uppercase tracking-wider text-ink-subtle"
            >
              <CalendarIcon aria-hidden="true" className="h-3.5 w-3.5" />
              {t('scheduleCart.yourSchedules')}
            </h2>

            <ul className="space-y-2.5">
              {schedules.map((schedule) => (
                <ScheduleRow
                  key={schedule.id}
                  schedule={schedule}
                  isOpen={!isCreating && schedule.id === selected?.id}
                  onOpen={() => {
                    open(schedule.id);
                  }}
                  {...(canRemove(schedule)
                    ? {
                        onRemove: () => {
                          setRemoveError(null);
                          setRemoving(schedule);
                        },
                      }
                    : {})}
                />
              ))}
            </ul>

            {list.data.estimatedCount !== undefined &&
              list.data.estimateLimit !== undefined &&
              schedules.length > list.data.estimateLimit && (
                <p className="mt-2 text-xxs text-ink-subtle">
                  {t('scheduleCart.onlyFirstPriced', {
                    count: list.data.estimateLimit,
                    quantity: formatNumber(list.data.estimateLimit),
                  })}
                </p>
              )}
          </section>

          {/* --- The one being worked on -------------------------------------- */}
          <div className="min-w-0">
            {isCreating ? (
              <NewSchedulePanel
                onCreated={(id) => {
                  setIsCreating(false);
                  open(id);
                }}
                onDismiss={() => {
                  setIsCreating(false);
                }}
              />
            ) : selected === null ? (
              <div className="rounded-lg border border-border bg-surface p-8 text-center shadow-card">
                <span
                  aria-hidden="true"
                  className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-brand-soft text-brand ring-1 ring-inset ring-brand/20"
                >
                  <ClockIcon className="h-6 w-6" />
                </span>
                <h2 className="mt-4 text-title-sm text-ink">
                  {t('scheduleCart.pickOneTitle')}
                </h2>
                <p className="mx-auto mt-2 max-w-md text-sm text-ink-muted">
                  {t('scheduleCart.pickOneBody')}
                </p>
                <p className="mt-4 text-xs text-ink-subtle">
                  <Link
                    to="/cart"
                    className="font-medium text-brand underline underline-offset-2 hover:no-underline"
                  >
                    {t('scheduleCart.backToCart')}
                  </Link>
                </p>
              </div>
            ) : (
              // Keyed on the id, so switching plans remounts the form. Without
              // it, one plan's unsaved quantities would still be in state
              // when the next plan's basket rendered.
              <ScheduleEditor key={selected.id} scheduleId={selected.id} />
            )}
          </div>
        </div>
      )}
    </>
  );
}

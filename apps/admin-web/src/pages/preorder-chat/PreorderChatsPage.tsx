/**
 * Preorder Chats: customers asking the team about a preorder, from a product
 * page, answered here.
 *
 * A support inbox in three panes on a wide screen - the queue, the open
 * conversation, and what it is about (product, customer, seller, preorder,
 * offer, notes). Below `xl` the third folds behind a "Details" button and
 * opens over the conversation; below `lg` each pane is its own view, with
 * `/preorder-chats` the queue and `/preorder-chats/:id` the conversation, so
 * nothing is ever squeezed into unusable columns and nothing scrolls sideways.
 *
 * THE FRAME
 *
 * `AppShell` makes this route exactly the window's height and stops the
 * document scrolling. Inside it the queue list, the message history and the
 * context panel each scroll on their own; the page heading, the queue's
 * search and the conversation's header and reply box never move. Every flex
 * ancestor on the way down carries `min-h-0` - one without it is how a long
 * conversation makes the whole console scroll again.
 *
 * Filtering, searching, sorting and paging are the server's. The queue reads
 * conversation rows only and never a message history; the history loads when
 * a conversation is opened.
 */
import { useEffect, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Badge, Button, ErrorState } from '@/components/ui';
import { useSession } from '@/auth/session-context';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';
import { formatDateTime, formatNumber, formatRelative } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import {
  ChatAvatar,
  ChatEmptyState,
  ConversationListSkeleton,
  UnreadBadge,
} from '@/lib/chat-kit/primitives';
import {
  INBOX_FILTERS,
  INBOX_SORTS,
  PREORDER_CHATS_PATH,
  fetchInbox,
  fetchInboxCounts,
  fetchOperations,
  inboxKeys,
  waitLabel,
  type InboxConversation,
  type InboxFilter,
  type InboxSort,
} from '@/lib/preorder-chats';
import { desktopAlertsOn, desktopAlertsSupported, requestDesktopAlerts } from '@/lib/use-preorder-chat-live';
import { faqQuestionText } from '@/lib/preorder-assistant';
import { ConversationPane } from './ConversationPane';
import { priorityTone, slaState, statusTone } from './tones';

/** The queue's own views, as chips. */
const QUEUE_VIEWS = [
  'all',
  'human_requested',
  'unassigned',
  'mine',
  'unread',
  'priority',
] as const satisfies readonly InboxFilter[];
/** Views by where a conversation is, in a menu. */
const STATUS_VIEWS = [
  'open',
  'waiting_customer',
  'waiting_internal',
  'resolved',
  'closed',
  'spam',
] as const satisfies readonly InboxFilter[];

function isFilter(value: string | null): value is InboxFilter {
  return value !== null && (INBOX_FILTERS as readonly string[]).includes(value);
}
function isSort(value: string | null): value is InboxSort {
  return value !== null && (INBOX_SORTS as readonly string[]).includes(value);
}

export function PreorderChatsPage(): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const { id } = useParams<{ id: string }>();
  const [params, setParams] = useSearchParams();
  const filter: InboxFilter = isFilter(params.get('filter')) ? (params.get('filter') as InboxFilter) : 'all';
  const sort: InboxSort = isSort(params.get('sort')) ? (params.get('sort') as InboxSort) : 'newest';
  const [search, setSearch] = useState(params.get('q') ?? '');
  const q = params.get('q') ?? '';

  // Search waits for a pause in typing, then goes to the server.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (search.trim() === q) return;
      const next = new URLSearchParams(params);
      if (search.trim() === '') next.delete('q');
      else next.set('q', search.trim());
      setParams(next, { replace: true });
    }, 350);
    return () => {
      window.clearTimeout(timer);
    };
  }, [search, q, params, setParams]);

  const setParam = (key: string, value: string): void => {
    const next = new URLSearchParams(params);
    next.set(key, value);
    setParams(next, { replace: true });
  };

  const inbox = useInfiniteQuery({
    queryKey: inboxKeys.list(filter, sort, q),
    queryFn: ({ pageParam }) => fetchInbox({ filter, sort, q, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    // The socket keeps this fresh; this is the safety net.
    refetchInterval: 60_000,
  });
  const counts = useQuery({ queryKey: inboxKeys.counts, queryFn: fetchInboxCounts, refetchInterval: 60_000 });
  const operations = useQuery({ queryKey: inboxKeys.operations, queryFn: fetchOperations, refetchInterval: 120_000 });
  const slaMinutes = operations.data?.slaMinutes ?? null;

  const [alerts, setAlerts] = useState(desktopAlertsOn());
  const conversations: InboxConversation[] = inbox.data?.pages.flatMap((page) => page.conversations) ?? [];
  const query = params.toString();
  const suffix = query === '' ? '' : `?${query}`;
  const isOpen = id !== undefined;
  const countOf = (view: InboxFilter): string | null =>
    counts.data === undefined ? null : formatNumber(counts.data.counts[view]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {/* The heading and the desk's numbers, on one line where they fit. */}
      <header className={cx('flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5', isOpen && 'max-lg:hidden')}>
        <h1 className="text-lg font-semibold text-ink">{t('preorderChats.title')}</h1>
        {operations.data !== undefined && (
          <dl className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
            {(
              [
                ['open', formatNumber(operations.data.queue.open), false],
                ['unassigned', formatNumber(operations.data.queue.unassigned), false],
                ['awaitingReply', formatNumber(operations.data.queue.awaitingReply), false],
                ['breachedSla', formatNumber(operations.data.queue.breachedSla), operations.data.queue.breachedSla > 0],
                [
                  'firstResponse',
                  operations.data.last30Days.averageFirstResponseSeconds === null
                    ? '—'
                    : durationLabel(t, operations.data.last30Days.averageFirstResponseSeconds),
                  false,
                ],
              ] as const
            ).map(([key, value, alarm]) => (
              <div key={key} className="flex items-baseline gap-1">
                <dt>{t(`preorderChats.ops.${key}` as TranslationKey)}</dt>
                <dd className={cx('font-semibold tabular-nums', alarm ? 'text-danger' : 'text-ink')}>{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {desktopAlertsSupported() && (
          <Button
            size="sm"
            variant="secondary"
            className="ml-auto"
            aria-pressed={alerts}
            onClick={() => {
              void requestDesktopAlerts(!alerts).then(setAlerts);
            }}
          >
            {alerts ? t('preorderChats.alerts.off') : t('preorderChats.alerts.on')}
          </Button>
        )}
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-surface shadow-card">
        {/* The queue. */}
        <section
          aria-label={t('preorderChats.queueLabel')}
          className={cx(
            'flex min-h-0 w-full min-w-0 flex-col lg:w-80 lg:shrink-0 lg:border-r lg:border-border-subtle xl:w-[22rem]',
            isOpen && 'max-lg:hidden',
          )}
        >
          <div className="shrink-0 space-y-2 border-b border-border-subtle p-3">
            <label className="relative block">
              <span className="sr-only">{t('preorderChats.search')}</span>
              <svg
                aria-hidden="true"
                viewBox="0 0 20 20"
                className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-subtle"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <path d="m14 14 4 4m-2-9a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z" strokeLinecap="round" />
              </svg>
              <input
                type="search"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                }}
                placeholder={t('preorderChats.searchPlaceholder')}
                className="w-full rounded-md border border-border bg-surface py-1.5 pl-8 pr-2 text-sm text-ink placeholder:text-ink-subtle focus-visible:border-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand/40"
              />
            </label>

            <div
              role="group"
              aria-label={t('preorderChats.viewsLabel')}
              className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-0.5 [scrollbar-width:thin]"
            >
              {QUEUE_VIEWS.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={filter === value}
                  onClick={() => {
                    setParam('filter', value);
                  }}
                  className={cx(
                    'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
                    filter === value
                      ? 'border-brand bg-brand-soft font-semibold text-brand'
                      : 'border-border text-ink-muted hover:bg-surface-hover',
                  )}
                >
                  {t(`preorderChats.filter.${value}` as TranslationKey)}
                  {countOf(value) !== null && <span className="tabular-nums opacity-80">{countOf(value)}</span>}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2 text-xs text-ink-muted">
              <label className="min-w-0 flex-1">
                <span className="sr-only">{t('preorderChats.byStatus')}</span>
                <select
                  value={(STATUS_VIEWS as readonly string[]).includes(filter) ? filter : ''}
                  onChange={(event) => {
                    setParam('filter', event.target.value === '' ? 'all' : event.target.value);
                  }}
                  className="w-full rounded border border-border bg-surface px-2 py-1 text-xs text-ink"
                >
                  <option value="">{t('preorderChats.byStatus')}</option>
                  {STATUS_VIEWS.map((value) => (
                    <option key={value} value={value}>
                      {t(`preorderChats.filter.${value}` as TranslationKey)}
                      {countOf(value) !== null ? ` (${countOf(value) ?? ''})` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex min-w-0 flex-1 items-center gap-1">
                <span className="shrink-0">{t('preorderChats.sortLabel')}</span>
                <select
                  value={sort}
                  onChange={(event) => {
                    setParam('sort', event.target.value);
                  }}
                  className="w-full min-w-0 rounded border border-border bg-surface px-2 py-1 text-xs text-ink"
                >
                  {INBOX_SORTS.map((value) => (
                    <option key={value} value={value}>
                      {t(`preorderChats.sort.${value}` as TranslationKey)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {inbox.isPending && <ConversationListSkeleton label={t('preorderChats.loading')} />}
            {inbox.isError && <ErrorState error={inbox.error} onRetry={() => void inbox.refetch()} />}
            {inbox.isSuccess && conversations.length === 0 && (
              <ChatEmptyState title={t('preorderChats.emptyTitle')} description={t('preorderChats.empty')} />
            )}
            {conversations.length > 0 && (
              <ul className="divide-y divide-border-subtle">
                {conversations.map((conversation) => (
                  <li key={conversation.id}>
                    <InboxRow
                      conversation={conversation}
                      selected={conversation.id === id}
                      suffix={suffix}
                      slaMinutes={slaMinutes}
                    />
                  </li>
                ))}
              </ul>
            )}
            {inbox.hasNextPage && (
              <div className="p-2">
                <Button
                  size="sm"
                  variant="ghost"
                  className="w-full"
                  isLoading={inbox.isFetchingNextPage}
                  onClick={() => void inbox.fetchNextPage()}
                >
                  {t('preorderChats.more')}
                </Button>
              </div>
            )}
          </div>
        </section>

        {/* The open conversation, and its details. */}
        <section
          aria-label={t('preorderChats.conversationLabel')}
          className={cx('flex min-h-0 min-w-0 flex-1', !isOpen && 'max-lg:hidden')}
        >
          {id === undefined ? (
            <ChatEmptyState title={t('preorderChats.selectOne')} description={t('preorderChats.description')} />
          ) : (
            <ConversationPane
              key={id}
              conversationId={id}
              backTo={`${PREORDER_CHATS_PATH}${suffix}`}
              canReply={can(Permission.PREORDER_CHAT_REPLY)}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function durationLabel(t: ReturnType<typeof useI18n>['t'], seconds: number): string {
  const wait = waitLabel(Math.round(seconds / 60));
  return t(`preorderChats.wait.${wait.unit}` as TranslationKey, { value: formatNumber(wait.value) });
}

function InboxRow({
  conversation,
  selected,
  suffix,
  slaMinutes,
}: {
  conversation: InboxConversation;
  selected: boolean;
  suffix: string;
  slaMinutes: number | null;
}): React.JSX.Element {
  const { t } = useI18n();
  const wait = conversation.waitingMinutes === null ? null : waitLabel(conversation.waitingMinutes);
  const sla = slaState(conversation.waitingMinutes, slaMinutes);
  const customer = conversation.customer.organization ?? conversation.customer.name ?? '—';
  const unread = conversation.unreadCount > 0;

  return (
    <Link
      to={`${PREORDER_CHATS_PATH}/${conversation.id}${suffix}`}
      aria-current={selected ? 'page' : undefined}
      className={cx(
        'relative flex gap-3 px-3 py-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand',
        selected ? 'bg-brand-soft' : 'hover:bg-surface-hover',
      )}
    >
      {selected && <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-brand" />}
      <ChatAvatar name={customer} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className={cx('truncate text-ink', unread ? 'font-semibold' : 'font-medium')} title={customer}>
            {customer}
          </span>
          <time
            dateTime={conversation.lastMessageAt}
            title={formatDateTime(conversation.lastMessageAt)}
            className="shrink-0 text-xxs text-ink-subtle"
          >
            {formatRelative(conversation.lastMessageAt)}
          </time>
        </span>
        <span className="block truncate text-xxs text-ink-muted" title={conversation.product.name}>
          {conversation.product.name}
          {conversation.seller.name !== null && <> · {conversation.seller.name}</>}
        </span>
        <span className="mt-0.5 flex items-center gap-2">
          <span className={cx('min-w-0 flex-1 truncate text-xs', unread ? 'text-ink' : 'text-ink-muted')}>
            {conversation.lastMessagePreview === null
              ? conversation.handoff !== null
                ? t('preorderChats.handoff.badge')
                : '—'
              : conversation.lastMessageSender === 'ADMIN'
                ? `${t('preorderChats.you')}: ${conversation.lastMessagePreview}`
                : conversation.lastMessagePreview}
          </span>
          <UnreadBadge count={conversation.unreadCount} label={t('preorderChats.unread', { count: conversation.unreadCount })} />
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-1.5">
          <Badge tone={statusTone(conversation.status)}>
            {t(`preorderChats.status.${conversation.status}` as TranslationKey)}
          </Badge>
          {conversation.handoff?.waiting === true && (
            // A long topic is cut short in the row; the whole of it is on hover
            // and in the conversation itself.
            <span
              className="inline-flex min-w-0 max-w-full"
              title={
                conversation.handoff.topic === null ? undefined : faqQuestionText(conversation.handoff.topic, t)
              }
            >
              <Badge tone="warning">
                <span className="block max-w-[16rem] truncate">
                  {conversation.handoff.topic === null
                    ? t('preorderChats.handoff.badge')
                    : t('preorderChats.handoff.badgeTopic', {
                        topic: faqQuestionText(conversation.handoff.topic, t),
                      })}
                </span>
              </Badge>
            </span>
          )}
          {conversation.priority !== 'NORMAL' && (
            <Badge tone={priorityTone(conversation.priority)}>
              {t(`preorderChats.priority.${conversation.priority}` as TranslationKey)}
            </Badge>
          )}
          {wait !== null && (
            <span
              className={cx(
                'inline-flex items-center gap-1 text-xxs',
                sla === 'breached' ? 'font-semibold text-danger' : sla === 'approaching' ? 'text-warning' : 'text-ink-muted',
              )}
            >
              <svg aria-hidden="true" viewBox="0 0 20 20" className="size-3" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M10 5v5l3 2m5-2a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z" strokeLinecap="round" />
              </svg>
              {t('preorderChats.waiting', {
                wait: t(`preorderChats.wait.${wait.unit}` as TranslationKey, { value: formatNumber(wait.value) }),
              })}
              {sla === 'breached' && <> · {t('preorderChats.sla.breached')}</>}
              {sla === 'approaching' && <> · {t('preorderChats.sla.approaching')}</>}
            </span>
          )}
          <span className="min-w-0 truncate text-xxs text-ink-subtle">
            {conversation.assignedTo === null
              ? t('preorderChats.unassigned')
              : t('preorderChats.assignedTo', { email: conversation.assignedTo.email })}
          </span>
        </span>
      </span>
    </Link>
  );
}

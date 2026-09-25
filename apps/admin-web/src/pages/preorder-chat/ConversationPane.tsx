/**
 * One conversation in the inbox: its header and actions, the thread, the
 * internal notes, the activity - and, beside it, what it is about.
 *
 * The scrolling, the reply box and the message pieces are `lib/chat-kit/` -
 * the same files the storefront's Account -> Messages runs - so Enter sends
 * here exactly as it does for the customer, and the history keeps its place
 * the same way on both sides.
 *
 * INTERNAL NOTES LOOK NOTHING LIKE A REPLY
 *
 * They live on their own tab, on an amber ground, under a heading that says
 * the customer never sees them, and they are written in a separate box with a
 * separate button - and that box does NOT send on Enter: a note is saved with
 * the button or Ctrl+Enter, deliberately. A note typed into the reply box by
 * mistake is the one error this screen is built to make hard; the server keeps
 * them apart as well, in another table no customer route reads.
 *
 * HONEST ABOUT WHO IS HERE
 *
 * The customer's typing line and a colleague's typing line appear only on a
 * real typing frame from the server. Nothing claims the customer is online or
 * that a colleague is viewing: the server does not report either, so neither
 * is shown.
 */
import { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useSession } from '@/auth/session-context';
import { Badge, Button, ErrorState, LoadingState, Spinner } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';
import { errorMessage } from '@/lib/errors';
import { formatDateTime, formatNumber } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import { useChatScroll } from '@/lib/chat-kit/chat-scroll';
import {
  ChatAnnouncer,
  ChatAvatar,
  ChatComposer,
  ChatViewport,
  ConnectionBanner,
  DaySeparator,
  DeliveryMark,
  JumpToLatest,
  MessageText,
  ThreadSkeleton,
  TypingIndicator,
  UnreadSeparator,
} from '@/lib/chat-kit/primitives';
import { buildTimeline, dayLabel, firstUnreadKey } from '@/lib/chat-kit/timeline';
import {
  CHAT_PRIORITIES,
  addNote,
  assign,
  changeStatus,
  exportTranscript,
  fetchActivity,
  fetchConversation,
  fetchNotes,
  inboxKeys,
  openAttachment,
  redact,
  setPriority,
  type ChatPriority,
  type ChatStatus,
  type ConversationDetail,
  type StaffMessage,
} from '@/lib/preorder-chats';
import { messageKey, useStaffThread, type PendingReply } from '@/lib/use-staff-thread';
import { ContextPanel } from './ContextPanel';
import { ProposalSummary } from './ProposalSummary';
import { priorityTone, statusTone } from './tones';

type Tab = 'thread' | 'notes' | 'activity';

/** The moves offered from each status, in the order a person reaches for them. */
function movesFrom(status: ChatStatus): ChatStatus[] {
  switch (status) {
    case 'NEW':
    case 'OPEN':
      return ['WAITING_FOR_CUSTOMER', 'WAITING_FOR_INTERNAL', 'RESOLVED', 'CLOSED', 'SPAM'];
    case 'WAITING_FOR_CUSTOMER':
      return ['OPEN', 'WAITING_FOR_INTERNAL', 'RESOLVED', 'CLOSED', 'SPAM'];
    case 'WAITING_FOR_INTERNAL':
      return ['OPEN', 'WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED', 'SPAM'];
    case 'RESOLVED':
      return ['OPEN', 'CLOSED', 'SPAM'];
    case 'CLOSED':
      return ['OPEN'];
    case 'SPAM':
      return ['OPEN', 'CLOSED'];
    case 'BLOCKED':
      return [];
  }
}

/** The one move a person most often wants, as a button: resolve an open one, reopen a finished one. */
function primaryMove(status: ChatStatus): ChatStatus | null {
  if (status === 'RESOLVED' || status === 'CLOSED') return 'OPEN';
  if (
    status === 'NEW' ||
    status === 'OPEN' ||
    status === 'WAITING_FOR_CUSTOMER' ||
    status === 'WAITING_FOR_INTERNAL'
  ) {
    return 'RESOLVED';
  }
  return null;
}

/** The details panel starts open where there is room for it beside the thread. */
function wideEnoughForDetails(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(min-width: 1280px)').matches
    : true;
}

export function ConversationPane({
  conversationId,
  backTo,
  canReply,
}: {
  conversationId: string;
  backTo: string;
  canReply: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const { user, can } = useSession();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>('thread');
  const [showDetails, setShowDetails] = useState(wideEnoughForDetails);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const detail = useQuery({
    queryKey: inboxKeys.detail(conversationId),
    queryFn: () => fetchConversation(conversationId),
  });
  const thread = useStaffThread(conversationId);
  const conversation = detail.data?.conversation;

  // Arriving at a conversation, the reader is told which one it is.
  const loaded = conversation !== undefined;
  useEffect(() => {
    if (loaded) headingRef.current?.focus({ preventScroll: true });
  }, [loaded]);

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: inboxKeys.detail(conversationId) });
    void queryClient.invalidateQueries({ queryKey: ['preorder-chats', 'list'] });
    void queryClient.invalidateQueries({ queryKey: inboxKeys.counts });
    void queryClient.invalidateQueries({ queryKey: inboxKeys.activity(conversationId) });
  };

  const action = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: refresh,
  });

  if (detail.isPending) return <LoadingState label={t('preorderChats.loadingConversation')} />;
  if (detail.isError)
    return <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />;
  if (conversation === undefined) return <LoadingState />;

  const mine = conversation.assignedTo?.id === user?.id;
  const receipts = thread.receipts ?? conversation.receipts;
  const customer = conversation.customer.organization ?? conversation.customer.name ?? '—';
  const primary = canReply ? primaryMove(conversation.status) : null;
  const moves = movesFrom(conversation.status)
    .filter((to) => to !== primary)
    .filter((to) => to !== 'SPAM' || can(Permission.PREORDER_CHAT_MODERATE))
    // Leaving spam is a moderation move too.
    .filter(() => conversation.status !== 'SPAM' || can(Permission.PREORDER_CHAT_MODERATE));

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* The header. Never scrolls. */}
        <header className="shrink-0 border-b border-border-subtle px-3 py-2.5 sm:px-4">
          <div className="flex items-start gap-3">
            <Link
              to={backTo}
              aria-label={t('preorderChats.back')}
              className="-ml-1 inline-flex size-9 shrink-0 items-center justify-center rounded-md text-ink-muted hover:bg-surface-hover hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand lg:hidden"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 20 20"
                className="size-5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <path d="M12.5 4.5 7 10l5.5 5.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Link>
            <ChatAvatar name={customer} />
            <div className="min-w-0 flex-1">
              <h2
                ref={headingRef}
                tabIndex={-1}
                className="truncate text-base font-semibold text-ink outline-none"
                title={customer}
              >
                {customer}
              </h2>
              <p className="truncate text-xs text-ink-muted" title={conversation.product.name}>
                {conversation.customer.organization !== null &&
                  conversation.customer.name !== null && <>{conversation.customer.name} · </>}
                {conversation.product.name}
                {conversation.product.variantName !== null && (
                  <> · {conversation.product.variantName}</>
                )}
                {conversation.seller.name !== null && (
                  <> · {t('preorderChats.sellerRef', { name: conversation.seller.name })}</>
                )}
              </p>
            </div>
            <button
              type="button"
              aria-expanded={showDetails}
              onClick={() => {
                setShowDetails((open) => !open);
              }}
              className={cx(
                'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
                showDetails
                  ? 'border-brand bg-brand-soft text-brand'
                  : 'border-border text-ink-muted hover:bg-surface-hover',
              )}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 20 20"
                className="size-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
              >
                <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
                <path d="M12.5 3.5v13" />
              </svg>
              <span className="hidden sm:inline">
                {showDetails ? t('preorderChats.detailsHide') : t('preorderChats.detailsShow')}
              </span>
              <span className="sr-only sm:hidden">
                {showDetails ? t('preorderChats.detailsHide') : t('preorderChats.detailsShow')}
              </span>
            </button>
          </div>

          {/* Where it stands, and what can be done about it. */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge tone={statusTone(conversation.status)}>
              {t(`preorderChats.status.${conversation.status}` as TranslationKey)}
            </Badge>
            <Badge tone={priorityTone(conversation.priority)}>
              {t(`preorderChats.priority.${conversation.priority}` as TranslationKey)}
            </Badge>
            <span className="text-xxs text-ink-muted">
              {conversation.assignedTo === null
                ? t('preorderChats.unassigned')
                : mine
                  ? t('preorderChats.assignedToYou')
                  : t('preorderChats.assignedTo', { email: conversation.assignedTo.email })}
            </span>

            <span className="ml-auto flex flex-wrap items-center gap-1.5">
              {canReply && !mine && (
                <Button
                  size="sm"
                  variant="secondary"
                  isLoading={action.isPending}
                  onClick={() => {
                    action.mutate(() => assign(conversationId, user?.id ?? null));
                  }}
                >
                  {t('preorderChats.take')}
                </Button>
              )}
              {canReply && mine && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    action.mutate(() => assign(conversationId, null));
                  }}
                >
                  {t('preorderChats.release')}
                </Button>
              )}
              {primary !== null && (
                <Button
                  size="sm"
                  variant={primary === 'RESOLVED' ? 'primary' : 'secondary'}
                  onClick={() => {
                    action.mutate(() => changeStatus(conversationId, primary, null));
                  }}
                >
                  {primary === 'RESOLVED'
                    ? t('preorderChats.quick.resolve')
                    : t('preorderChats.quick.reopen')}
                </Button>
              )}
              <MoreActions label={t('preorderChats.moreActions')}>
                {canReply && moves.length > 0 && (
                  <label>
                    <span className="mb-0.5 block text-xxs font-medium text-ink-muted">
                      {t('preorderChats.moveTo')}
                    </span>
                    <select
                      value=""
                      onChange={(event) => {
                        const to = event.target.value as ChatStatus;
                        if (to.length > 0)
                          action.mutate(() => changeStatus(conversationId, to, null));
                      }}
                      className="h-8 rounded-md border border-border bg-surface px-2 text-xs text-ink"
                    >
                      <option value="">{t('preorderChats.chooseStatus')}</option>
                      {moves.map((to) => (
                        <option key={to} value={to}>
                          {t(`preorderChats.moveAction.${to}` as TranslationKey)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {canReply && (
                  <label>
                    <span className="mb-0.5 block text-xxs font-medium text-ink-muted">
                      {t('preorderChats.priorityLabel')}
                    </span>
                    <select
                      value={conversation.priority}
                      onChange={(event) => {
                        action.mutate(() =>
                          setPriority(conversationId, event.target.value as ChatPriority),
                        );
                      }}
                      className="h-8 rounded-md border border-border bg-surface px-2 text-xs text-ink"
                    >
                      {CHAT_PRIORITIES.map((priority) => (
                        <option key={priority} value={priority}>
                          {t(`preorderChats.priority.${priority}` as TranslationKey)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {can(Permission.PREORDER_CHAT_EXPORT) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      void exportTranscript(conversationId);
                    }}
                  >
                    {t('preorderChats.export')}
                  </Button>
                )}
              </MoreActions>
            </span>
          </div>
          {action.isError && (
            <p role="alert" className="mt-2 text-xs text-danger">
              {errorMessage(t, action.error)}
            </p>
          )}
        </header>

        {thread.connection !== 'open' && thread.connection !== 'idle' && (
          <ConnectionBanner
            tone={thread.connection === 'connecting' ? 'info' : 'warning'}
            text={t(`preorderChats.connection.${thread.connection}` as TranslationKey)}
          />
        )}

        <div
          role="tablist"
          aria-label={t('preorderChats.tabsLabel')}
          className="flex shrink-0 gap-1 border-b border-border-subtle px-3"
        >
          {(['thread', 'notes', 'activity'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              id={`${conversationId}-tab-${value}`}
              aria-selected={tab === value}
              aria-controls={`${conversationId}-panel`}
              onClick={() => {
                setTab(value);
              }}
              className={cx(
                '-mb-px border-b-2 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand',
                tab === value
                  ? 'border-brand font-medium text-ink'
                  : 'border-transparent text-ink-muted hover:text-ink',
                value === 'notes' && tab === value && 'border-warning',
              )}
            >
              {t(`preorderChats.tab.${value}` as TranslationKey)}
            </button>
          ))}
        </div>

        <div
          id={`${conversationId}-panel`}
          role="tabpanel"
          aria-labelledby={`${conversationId}-tab-${tab}`}
          className="flex min-h-0 flex-1 flex-col"
        >
          {tab === 'thread' && (
            <Thread
              conversation={conversation}
              thread={thread}
              receipts={receipts}
              canReply={canReply}
              canModerate={can(Permission.PREORDER_CHAT_MODERATE)}
            />
          )}
          {tab === 'notes' && <Notes conversationId={conversationId} canWrite={canReply} />}
          {tab === 'activity' && <Activity conversationId={conversationId} />}
        </div>
      </div>

      {/* What it is about. A column beside the thread from `xl`; over it,
          from the right, below that - so the thread keeps its width. */}
      {showDetails && (
        <div
          className={cx(
            'flex min-h-0 w-[min(22rem,100%)] shrink-0 flex-col border-l border-border-subtle bg-surface',
            'max-xl:absolute max-xl:inset-y-0 max-xl:right-0 max-xl:z-20 max-xl:shadow-overlay xl:w-80',
          )}
        >
          <div className="flex shrink-0 items-center justify-between border-b border-border-subtle px-3 py-2 xl:hidden">
            <p className="text-sm font-semibold text-ink">{t('preorderChats.contextLabel')}</p>
            <button
              type="button"
              onClick={() => {
                setShowDetails(false);
              }}
              aria-label={t('preorderChats.detailsHide')}
              className="inline-flex size-8 items-center justify-center rounded-md text-ink-muted hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 20 20"
                className="size-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <path d="m5 5 10 10M15 5 5 15" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
            <ContextPanel
              conversation={conversation}
              onChanged={refresh}
              onOpenNotes={() => {
                setTab('notes');
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The actions reached for less often - another status, the priority, the
 * transcript - behind one button, so the header stays two lines and the
 * history keeps its height on a laptop. A disclosure, not a menu widget: the
 * controls inside are ordinary selects and buttons, reached with Tab, and
 * Escape or a click outside closes it.
 */
function MoreActions({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: PointerEvent): void => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={label}
        title={label}
        onClick={() => {
          setOpen((current) => !current);
        }}
        className="inline-flex size-8 items-center justify-center rounded-md border border-border text-ink-muted hover:bg-surface-hover hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      >
        <svg aria-hidden="true" viewBox="0 0 20 20" className="size-4" fill="currentColor">
          <circle cx="4" cy="10" r="1.6" />
          <circle cx="10" cy="10" r="1.6" />
          <circle cx="16" cy="10" r="1.6" />
        </svg>
      </button>
      {/* Rendered only while open: a `flex` panel with `hidden` is still drawn,
          because the class beats the attribute. */}
      {open && (
        <div
          id={panelId}
          className="absolute right-0 top-full z-30 mt-1 flex w-60 flex-col items-stretch gap-2 rounded-lg border border-border bg-surface p-2 shadow-popover [&_select]:w-full"
        >
          {children}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The thread and the reply box
// ---------------------------------------------------------------------------

type ThreadItem =
  { kind: 'message'; message: StaffMessage } | { kind: 'pending'; entry: PendingReply };

function pendingKey(entry: PendingReply): string {
  return `p-${entry.clientMessageId}`;
}

function Thread({
  conversation,
  thread,
  receipts,
  canReply,
  canModerate,
}: {
  conversation: ConversationDetail;
  thread: ReturnType<typeof useStaffThread>;
  receipts: { deliveredSeq: number; readSeq: number };
  canReply: boolean;
  canModerate: boolean;
}): React.JSX.Element {
  const { t, intlLocale } = useI18n();
  const [draft, setDraft] = useState('');
  const customerName =
    conversation.customer.organization ?? conversation.customer.name ?? t('preorderChats.customer');

  // The first unread message, from the count the conversation opened with -
  // read once, because opening it marks it read and the count goes to zero.
  const anchor = useRef<string | null | undefined>(undefined);
  if (anchor.current === undefined && !thread.isLoading) {
    anchor.current = firstUnreadKey(
      thread.messages,
      conversation.unreadCount,
      (message) => message.senderType === 'CUSTOMER',
      messageKey,
    );
  }
  const initialAnchorKey = anchor.current ?? null;

  const items = useMemo<ThreadItem[]>(
    () => [
      ...thread.messages.map((message) => ({ kind: 'message' as const, message })),
      ...thread.pending.map((entry) => ({ kind: 'pending' as const, entry })),
    ],
    [thread.messages, thread.pending],
  );
  const itemKey = (item: ThreadItem): string =>
    item.kind === 'message' ? messageKey(item.message) : pendingKey(item.entry);
  const timeline = useMemo(
    () =>
      buildTimeline(items, {
        keyOf: itemKey,
        timeOf: (item) => (item.kind === 'message' ? item.message.createdAt : item.entry.createdAt),
        // Staff group by who wrote it, so two colleagues' replies do not merge.
        authorOf: (item) =>
          item.kind === 'pending'
            ? 'me'
            : item.message.messageType === 'TEXT' || item.message.messageType === 'ATTACHMENT'
              ? item.message.senderType === 'ADMIN'
                ? `admin-${item.message.senderUserId ?? item.message.senderName ?? ''}`
                : item.message.senderType
              : null,
        firstUnreadKey: initialAnchorKey,
      }),
    [items, initialAnchorKey],
  );
  const first = items[0];
  const last = items.at(-1);

  const scroll = useChatScroll({
    conversationKey: conversation.id,
    ready: !thread.isLoading,
    firstKey: first === undefined ? null : itemKey(first),
    lastKey: last === undefined ? null : itemKey(last),
    count: items.length,
    // A reply this member of staff just sent: always scrolled into view. A
    // colleague's reply is somebody else's news, like the customer's.
    lastIsOwn: last?.kind === 'pending',
    initialAnchorKey,
    onReachTop: thread.hasEarlier
      ? () => {
          void thread.loadEarlier();
        }
      : undefined,
  });

  const lastIncoming =
    [...thread.messages].reverse().find((message) => message.senderType === 'CUSTOMER') ?? null;
  const closed = conversation.status === 'CLOSED';

  const send = (text: string): void => {
    thread.send(text);
    setDraft('');
    thread.setTyping(false);
  };

  return (
    <>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <ChatViewport
          ref={scroll.viewportRef}
          onScroll={scroll.onScroll}
          label={t('preorderChats.historyLabel')}
        >
          <div ref={scroll.contentRef} className="mx-auto w-full max-w-4xl px-3 py-3 sm:px-4">
            {thread.isLoading && <ThreadSkeleton label={t('preorderChats.loadingConversation')} />}
            {thread.loadError !== null && (
              <ErrorState error={thread.loadError} onRetry={() => void thread.refresh()} />
            )}
            {thread.hasEarlier && (
              <div className="my-2 flex justify-center">
                {thread.isLoadingEarlier ? (
                  <p role="status" className="flex items-center gap-2 text-xs text-ink-muted">
                    <Spinner className="size-3.5" /> {t('preorderChats.loadingEarlier')}
                  </p>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => void thread.loadEarlier()}>
                    {t('preorderChats.loadEarlier')}
                  </Button>
                )}
              </div>
            )}
            <ol className="flex flex-col">
              {timeline.map((entry) => {
                if (entry.kind === 'day') {
                  return (
                    <li key={entry.key}>
                      <DaySeparator
                        dateTime={entry.day}
                        label={dayLabel(entry.day, intlLocale, {
                          today: t('preorderChats.day.today'),
                          yesterday: t('preorderChats.day.yesterday'),
                        })}
                      />
                    </li>
                  );
                }
                if (entry.kind === 'unread') {
                  return (
                    <li key={entry.key}>
                      <UnreadSeparator label={t('preorderChats.unreadSeparator')} />
                    </li>
                  );
                }
                const { item } = entry;
                return (
                  <li
                    key={entry.key}
                    data-chat-key={entry.key}
                    className={entry.groupStart ? 'mt-3 first:mt-0' : 'mt-0.5'}
                  >
                    {item.kind === 'message' ? (
                      <StaffBubble
                        message={item.message}
                        receipts={receipts}
                        conversationId={conversation.id}
                        currency={conversation.pricingCurrency}
                        canModerate={canModerate}
                        onRedacted={thread.replaceMessage}
                        groupStart={entry.groupStart}
                        groupEnd={entry.groupEnd}
                        customerName={customerName}
                      />
                    ) : (
                      <PendingBubble
                        entry={item.entry}
                        onRetry={thread.retry}
                        onDiscard={thread.discard}
                      />
                    )}
                  </li>
                );
              })}
            </ol>
            {thread.customerTyping && <TypingIndicator label={t('preorderChats.customerTyping')} />}
            {thread.colleagueTyping && (
              <TypingIndicator label={t('preorderChats.colleagueTyping')} />
            )}
          </div>
        </ChatViewport>

        {!scroll.isPinned && (
          <JumpToLatest
            onClick={scroll.jumpToLatest}
            label={
              scroll.newCount > 0
                ? t('preorderChats.jump.new', { count: scroll.newCount })
                : t('preorderChats.jump.latest')
            }
          />
        )}
      </div>

      <ChatAnnouncer
        text={
          lastIncoming === null
            ? ''
            : t('preorderChats.announce', { text: lastIncoming.body.slice(0, 200) })
        }
      />

      {canReply && (
        <div className="shrink-0 border-t border-border-subtle px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 sm:px-4">
          <div className="mx-auto w-full max-w-4xl">
            {closed && (
              <p className="mb-2 rounded-md bg-surface-sunken px-3 py-1.5 text-xs text-ink-muted">
                {t('preorderChats.closedReply')}
              </p>
            )}
            <ChatComposer
              value={draft}
              onChange={(value) => {
                setDraft(value);
                thread.setTyping(value.trim().length > 0);
              }}
              onSend={send}
              canSend={!closed}
              disabled={closed}
              labels={{
                label: t('preorderChats.replyLabel'),
                placeholder: t('preorderChats.replyPlaceholder'),
                send: t('preorderChats.send'),
                hint: t('preorderChats.composer.hint'),
                touchHint: t('preorderChats.composer.touchHint'),
              }}
              footer={
                <span className="[@media(max-height:760px)]:hidden">
                  {t('preorderChats.replyHint')}
                </span>
              }
            />
          </div>
        </div>
      )}
    </>
  );
}

function MessageTime({ at }: { at: string }): React.JSX.Element {
  const { intlLocale } = useI18n();
  const full = formatDateTime(at);
  const short = new Intl.DateTimeFormat(intlLocale, { hour: '2-digit', minute: '2-digit' }).format(
    new Date(at),
  );
  return (
    <time dateTime={at} title={full}>
      <span aria-hidden="true">{short}</span>
      <span className="sr-only">{full}</span>
    </time>
  );
}

const StaffBubble = memo(function StaffBubble({
  message,
  receipts,
  conversationId,
  currency,
  canModerate,
  onRedacted,
  groupStart,
  groupEnd,
  customerName,
}: {
  message: StaffMessage;
  receipts: { deliveredSeq: number; readSeq: number };
  conversationId: string;
  currency: string;
  canModerate: boolean;
  onRedacted: (message: StaffMessage) => void;
  groupStart: boolean;
  groupEnd: boolean;
  customerName: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const [redacting, setRedacting] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const reasonId = useId();

  if (message.messageType === 'SYSTEM_EVENT' || message.messageType === 'STRUCTURED_OFFER') {
    const event = message.systemEvent ?? 'unknown';
    return (
      <div className="py-1">
        <p className="text-center text-xxs text-ink-subtle">
          {t(`preorderChats.system.${event}` as TranslationKey, {
            requestNumber: String(message.systemMeta['requestNumber'] ?? ''),
            defaultValue: t('preorderChats.system.unknown'),
          })}
        </p>
        {message.messageType === 'STRUCTURED_OFFER' && message.proposal !== null && (
          <ProposalSummary proposal={message.proposal} currency={currency} />
        )}
      </div>
    );
  }

  const fromCustomer = message.senderType === 'CUSTOMER';
  const staffState =
    message.senderType === 'ADMIN'
      ? message.seq <= receipts.readSeq
        ? 'READ'
        : message.seq <= receipts.deliveredSeq
          ? 'DELIVERED'
          : 'SENT'
      : null;

  return (
    <div
      className={cx('group flex items-end gap-2', fromCustomer ? 'flex-row' : 'flex-row-reverse')}
    >
      {fromCustomer && (
        <span className="w-7 shrink-0">
          {groupEnd && <ChatAvatar name={customerName} size="sm" />}
        </span>
      )}
      <div
        className={cx(
          'flex min-w-0 max-w-[min(85%,40rem)] flex-col',
          fromCustomer ? 'items-start' : 'items-end',
        )}
      >
        {groupStart && (
          <p className="mb-0.5 px-1 text-xxs font-medium text-ink-muted">
            {fromCustomer ? customerName : (message.senderName ?? t('preorderChats.team'))}
          </p>
        )}
        <div
          className={cx(
            'flex max-w-full items-center gap-1',
            fromCustomer ? 'flex-row' : 'flex-row-reverse',
          )}
        >
          <div
            className={cx(
              'min-w-0 max-w-full rounded-2xl px-3 py-2 text-sm',
              fromCustomer ? 'bg-surface-sunken text-ink' : 'bg-brand-soft text-ink',
              fromCustomer ? !groupStart && 'rounded-tl-md' : !groupStart && 'rounded-tr-md',
              fromCustomer ? !groupEnd && 'rounded-bl-md' : !groupEnd && 'rounded-br-md',
            )}
          >
            {message.redacted ? (
              <p className="italic text-ink-muted">
                {t('preorderChats.redacted', { reason: message.redactionReason ?? '—' })}
              </p>
            ) : message.attachment !== null ? (
              <button
                type="button"
                disabled={!message.attachment.downloadable}
                className="flex min-w-0 items-center gap-1.5 text-left underline disabled:no-underline disabled:opacity-60"
                onClick={() => {
                  void openAttachment(conversationId, message.attachment?.id ?? '').catch(setError);
                }}
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 20 20"
                  className="size-4 shrink-0"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                >
                  <path
                    d="M6 2.5h5.5L15.5 6.5V17a.5.5 0 0 1-.5.5H6a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5Z"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  {message.attachment.fileName}
                </span>
                <span className="shrink-0 text-xs opacity-80">
                  {formatNumber(Math.max(1, Math.round(message.attachment.byteSize / 1024)))} KB
                </span>
              </button>
            ) : (
              <MessageText body={message.body} />
            )}
          </div>
          {canModerate && !message.redacted && !redacting && (
            <button
              type="button"
              onClick={() => {
                setRedacting(true);
              }}
              className="shrink-0 rounded px-1 text-xxs text-ink-subtle underline opacity-0 hover:text-ink focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand group-hover:opacity-100"
            >
              {t('preorderChats.redact')}
            </button>
          )}
        </div>
        {groupEnd && (
          <p className="mt-0.5 flex items-center gap-1.5 px-1 text-xxs text-ink-subtle">
            <MessageTime at={message.createdAt} />
            {staffState !== null && (
              <DeliveryMark
                state={staffState}
                label={t(`preorderChats.delivery.${staffState}` as TranslationKey)}
              />
            )}
          </p>
        )}
        {redacting && (
          <form
            className="mt-1 flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void redact(conversationId, message.id, reason.trim())
                .then((updated) => {
                  onRedacted(updated);
                  setRedacting(false);
                })
                .catch(setError);
            }}
          >
            <label htmlFor={reasonId} className="text-xs text-ink-muted">
              {t('preorderChats.redactReason')}
            </label>
            <input
              id={reasonId}
              value={reason}
              required
              minLength={3}
              maxLength={255}
              onChange={(event) => {
                setReason(event.target.value);
              }}
              className="rounded border border-border bg-surface px-2 py-0.5 text-sm"
            />
            <Button size="sm" type="submit" variant="danger" disabled={reason.trim().length < 3}>
              {t('preorderChats.redactConfirm')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setRedacting(false);
              }}
            >
              {t('common.cancel')}
            </Button>
          </form>
        )}
        {error !== null && (
          <p role="alert" className="text-xs text-danger">
            {errorMessage(t, error)}
          </p>
        )}
      </div>
    </div>
  );
});

function PendingBubble({
  entry,
  onRetry,
  onDiscard,
}: {
  entry: PendingReply;
  onRetry: (id: string) => void;
  onDiscard: (id: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const failed = entry.status === 'FAILED';
  return (
    <div className="flex flex-col items-end">
      <div
        className={cx(
          'min-w-0 max-w-[min(85%,40rem)] rounded-2xl px-3 py-2 text-sm',
          failed ? 'border border-danger/50 bg-danger-soft' : 'bg-brand-soft/60',
        )}
      >
        <MessageText body={entry.body} />
      </div>
      <p className="mt-0.5 flex flex-wrap items-center justify-end gap-x-2 px-1 text-xxs text-ink-subtle">
        <DeliveryMark
          state={entry.status}
          label={t(`preorderChats.delivery.${entry.status}` as TranslationKey)}
        />
        {failed && (
          <>
            <span className="text-danger">{errorMessage(t, entry.error)}</span>
            <button
              type="button"
              className="rounded font-semibold text-brand underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
              onClick={() => {
                onRetry(entry.clientMessageId);
              }}
            >
              {t('preorderChats.retry')}
            </button>
            <button
              type="button"
              className="rounded underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
              onClick={() => {
                onDiscard(entry.clientMessageId);
              }}
            >
              {t('preorderChats.discard')}
            </button>
          </>
        )}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Internal notes and activity
// ---------------------------------------------------------------------------

function Notes({
  conversationId,
  canWrite,
}: {
  conversationId: string;
  canWrite: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const notes = useQuery({
    queryKey: inboxKeys.notes(conversationId),
    queryFn: () => fetchNotes(conversationId),
  });
  const [body, setBody] = useState('');
  const noteId = useId();
  const save = useMutation({
    mutationFn: () => addNote(conversationId, body.trim()),
    onSuccess: () => {
      setBody('');
      void queryClient.invalidateQueries({ queryKey: inboxKeys.notes(conversationId) });
    },
  });
  const submit = (): void => {
    if (body.trim() !== '' && !save.isPending) save.mutate();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-warning-soft/40">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-3">
        <p className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-xs font-medium text-ink">
          {t('preorderChats.notesWarning')}
        </p>
        {notes.isPending && <LoadingState />}
        {notes.data?.notes.length === 0 && (
          <p className="text-sm text-ink-muted">{t('preorderChats.notesEmpty')}</p>
        )}
        <ul className="space-y-2">
          {notes.data?.notes.map((note) => (
            <li
              key={note.id}
              className="rounded-md border border-warning/30 bg-surface px-3 py-2 text-sm"
            >
              <p className="mb-1 text-xxs text-ink-muted">
                {note.authorEmail ?? '—'} ·{' '}
                <time dateTime={note.createdAt}>{formatDateTime(note.createdAt)}</time>
              </p>
              <MessageText body={note.body} />
            </li>
          ))}
        </ul>
      </div>
      {canWrite && (
        <form
          className="shrink-0 border-t border-warning/40 px-4 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label htmlFor={noteId} className="mb-1 block text-xs font-medium text-ink">
            {t('preorderChats.noteLabel')}
          </label>
          <textarea
            id={noteId}
            value={body}
            rows={2}
            onChange={(event) => {
              setBody(event.target.value);
            }}
            onKeyDown={(event) => {
              // Deliberately NOT Enter: a note is saved on purpose.
              if (
                event.key === 'Enter' &&
                (event.ctrlKey || event.metaKey) &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                submit();
              }
            }}
            className="block max-h-40 w-full resize-y rounded-md border border-warning/50 bg-surface px-3 py-2 text-sm"
          />
          {save.isError && (
            <p role="alert" className="text-xs text-danger">
              {errorMessage(t, save.error)}
            </p>
          )}
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <span className="text-xxs text-ink-muted">{t('preorderChats.noteHint')}</span>
            <Button
              type="submit"
              size="sm"
              variant="secondary"
              isLoading={save.isPending}
              disabled={body.trim() === ''}
            >
              {t('preorderChats.addNote')}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

function Activity({ conversationId }: { conversationId: string }): React.JSX.Element {
  const { t } = useI18n();
  const activity = useQuery({
    queryKey: inboxKeys.activity(conversationId),
    queryFn: () => fetchActivity(conversationId),
  });
  if (activity.isPending) return <LoadingState />;
  if (activity.isError) return <ErrorState error={activity.error} />;
  return (
    <ol className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain px-4 py-3 text-sm">
      {activity.data.activity.map((entry) => (
        <li key={entry.id} className="border-b border-border-subtle pb-2">
          <p className="text-ink">
            {t(
              `preorderChats.activity.${entry.action.replace('preorder_chat.', '')}` as TranslationKey,
              {
                defaultValue: entry.action,
              },
            )}
          </p>
          <p className="text-xxs text-ink-muted">
            {entry.actorEmail ??
              t(`preorderChats.actor.${entry.actorType}` as TranslationKey, {
                defaultValue: entry.actorType,
              })}{' '}
            · <time dateTime={entry.createdAt}>{formatDateTime(entry.createdAt)}</time>
          </p>
        </li>
      ))}
    </ol>
  );
}

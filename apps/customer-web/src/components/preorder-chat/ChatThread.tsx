/**
 * One preorder chat, as the customer reads and writes it.
 *
 * Used by the drawer on the product page and by Account -> Messages, so both
 * say the same thing in the same way. The scrolling, the composer and the
 * message pieces are `lib/chat-kit/` - the same files the admin console's
 * inbox runs.
 *
 * Five rules the screen keeps:
 *
 *   - **The customer is talking to the {{marketplace}} team.** Never to the
 *     seller: the seller's name appears as a fact about the product ("Seller:
 *     …"), never as the other party in the conversation.
 *   - **Messages are text.** Everything anybody wrote is rendered as React
 *     text nodes - never `dangerouslySetInnerHTML`, never Markdown. Links are
 *     made only from `http:` and `https:` addresses (`linkify`).
 *   - **The history is a log that does not read itself aloud.** Screen readers
 *     are told about a NEW message from the team through one separate polite
 *     announcement, so loading earlier messages never reads them all out.
 *   - **Honest about the connection, the team and the price.** "Available" only
 *     when the server says somebody who can reply is connected right now. The
 *     product strip is labelled a snapshot, and a proposal's price is labelled
 *     indicative: nothing in a chat is a quote, a reservation or an order.
 *   - **Only the history scrolls, and only on purpose** - see
 *     `lib/chat-kit/chat-scroll.ts` for when it moves and why.
 *
 * Before a conversation exists, the history holds the preorder assistant
 * (`PreorderAssistant`): automated answers from the product's own data, and
 * a way to a person at any time. Its answers travel into the conversation the
 * first message or "Connect with a human agent" creates, as the assistant's
 * messages - never as the team's.
 */
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button, Spinner } from '@/components/ui';
import {
  ArrowLeftIcon,
  BoxIcon,
  ChevronDownIcon,
  DocumentIcon,
  PaperclipIcon,
  ShieldIcon,
} from '@/components/icons';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';
import { errorMessage } from '@/lib/errors';
import { formatDateTime, formatNumber } from '@/lib/format';
import { formatIsoDate } from '@/lib/calendar-date';
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
import { buildTimeline, dayLabel } from '@/lib/chat-kit/timeline';
import {
  CHAT_ORDERING_UNITS,
  MESSAGES_PATH,
  chatKeys,
  deliveryStateOf,
  fetchChatAvailability,
  openChatAttachment,
  type ChatContextCard,
  type ChatContextInput,
  type ChatMessage,
  type ChatOrderingUnit,
  type ChatProposal,
  type CustomerChatStatus,
  type DeliveryState,
} from '@/lib/preorder-chat';
import { messageKey, useChatThread, type PendingMessage } from '@/lib/use-preorder-chat';
import { faqQuestionText, signedAnswers, takeHandoffIntent, type FaqId } from '@/lib/preorder-assistant';
import { usePreorderAssistant } from '@/lib/use-preorder-assistant';
import { AnswerLines, AssistantLabel, AssistantMark, PreorderAssistant, type HandoffStatus } from './PreorderAssistant';
import { ProposalCard } from './ProposalCard';

export interface ChatThreadProps {
  conversationId: string | null;
  context: ChatContextInput | null;
  /** Before the first message the customer may still change what they ask about. */
  onContextChange?: (next: ChatContextInput) => void;
  active: boolean;
  /** Open a proposal in the preorder form. */
  onReviewProposal: (conversationId: string, proposalId: string) => void;
  /** Tells the parent which conversation this became, once it exists. */
  onConversation?: (conversationId: string) => void;
  /**
   * `page` draws its own conversation header (Account -> Messages); `drawer`
   * sits under the drawer's header and shows only the availability line.
   */
  variant?: 'page' | 'drawer';
  className?: string;
}

/** A pending message's key: never the same shape as a stored one. */
function pendingKey(entry: PendingMessage): string {
  return `p-${entry.clientMessageId}`;
}

type ThreadItem = { kind: 'message'; message: ChatMessage } | { kind: 'pending'; entry: PendingMessage };

export function ChatThread({
  conversationId,
  context: contextInput,
  onContextChange,
  active,
  onReviewProposal,
  onConversation,
  variant = 'drawer',
  className,
}: ChatThreadProps): React.JSX.Element {
  const { t, language, intlLocale } = useI18n();
  const availability = useQuery({
    queryKey: chatKeys.availability,
    queryFn: fetchChatAvailability,
    staleTime: 30_000,
  });
  // Only ever used before a conversation exists; after that its answers are
  // messages in the conversation.
  const assistant = usePreorderAssistant({
    context: contextInput,
    enabled: contextInput !== null && conversationId === null,
    signedIn: true,
  });
  const entriesRef = useRef(assistant.entries);
  entriesRef.current = assistant.entries;
  const clearAssistant = assistant.clear;
  const thread = useChatThread({
    conversationId,
    context: contextInput,
    locale: language,
    active,
    startTranscript: () => signedAnswers(entriesRef.current),
    onConversationStarted: clearAssistant,
  });
  const { conversation, context, messages, pending } = thread;

  // ---- Asking for a person ---------------------------------------------------
  const [handoffStatus, setHandoffStatus] = useState<HandoffStatus>('idle');
  const [handoffError, setHandoffError] = useState<unknown>(null);
  const handoffBusy = useRef(false);
  const requestHuman = thread.requestHuman;
  const connectHuman = useCallback(
    (topic: FaqId | null): void => {
      if (handoffBusy.current) return;
      handoffBusy.current = true;
      setHandoffStatus('sending');
      setHandoffError(null);
      requestHuman(topic, signedAnswers(entriesRef.current))
        .then(() => {
          setHandoffStatus('idle');
        })
        .catch((error: unknown) => {
          setHandoffStatus('failed');
          setHandoffError(error);
        })
        .finally(() => {
          handoffBusy.current = false;
        });
    },
    [requestHuman],
  );

  // A guest asked for a person and has just signed in: finish what they asked.
  const intentChecked = useRef(false);
  useEffect(() => {
    if (intentChecked.current || thread.isLoading || contextInput === null) return;
    intentChecked.current = true;
    const intent = takeHandoffIntent(contextInput.productId, contextInput.variantId);
    if (intent !== null) connectHuman(intent.topic);
  }, [thread.isLoading, contextInput, connectHuman]);

  useEffect(() => {
    if (conversation !== null) onConversation?.(conversation.id);
  }, [conversation, onConversation]);

  const maxChars = availability.data?.maxMessageChars ?? 4000;
  // A live connection knows who is here now. Before the first connection the
  // server's answer a moment ago is fresh enough to show; once a connection
  // has been LOST, that answer is stale, so the line says it is checking
  // rather than repeating it.
  const restAvailable = availability.data?.teamAvailable ?? null;
  const teamAvailable =
    thread.connection === 'open'
      ? (thread.teamAvailable ?? restAvailable)
      : thread.connection === 'connecting' || thread.connection === 'idle'
        ? restAvailable
        : null;
  const attachments = availability.data?.attachments;
  const typicalResponse = availability.data?.typicalResponse ?? null;

  const [draft, setDraft] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  // Arriving at a conversation from the list, the reader is told where they
  // are. `preventScroll`: the frame does not scroll, and must not start to.
  useEffect(() => {
    if (variant === 'page') headingRef.current?.focus({ preventScroll: true });
  }, [variant]);

  // ---- The timeline ---------------------------------------------------------
  const items = useMemo<ThreadItem[]>(
    () => [
      ...messages.map((message) => ({ kind: 'message' as const, message })),
      ...pending.map((entry) => ({ kind: 'pending' as const, entry })),
    ],
    [messages, pending],
  );
  const itemKey = (item: ThreadItem): string =>
    item.kind === 'message' ? messageKey(item.message) : pendingKey(item.entry);
  const timeline = useMemo(
    () =>
      buildTimeline(items, {
        keyOf: itemKey,
        timeOf: (item) => (item.kind === 'message' ? item.message.createdAt : item.entry.createdAt),
        authorOf: (item) =>
          item.kind === 'pending'
            ? 'CUSTOMER'
            : item.message.messageType === 'TEXT' ||
                item.message.messageType === 'ATTACHMENT' ||
                item.message.messageType === 'FAQ_QUESTION' ||
                item.message.messageType === 'AUTOMATED_REPLY'
              ? item.message.senderType
              : null,
        firstUnreadKey: thread.initialUnreadKey,
      }),
    [items, thread.initialUnreadKey],
  );
  const first = items[0];
  const last = items.at(-1);

  // ---- Scrolling ------------------------------------------------------------
  const scroll = useChatScroll({
    conversationKey: conversation?.id ?? conversationId ?? 'new',
    ready: !thread.isLoading,
    firstKey: first === undefined ? null : itemKey(first),
    lastKey: last === undefined ? null : itemKey(last),
    count: items.length,
    lastIsOwn: last !== undefined && (last.kind === 'pending' || last.message.senderType === 'CUSTOMER'),
    initialAnchorKey: thread.initialUnreadKey,
    onReachTop: thread.hasEarlier
      ? () => {
          void thread.loadEarlier();
        }
      : undefined,
  });

  // ---- Composer -------------------------------------------------------------
  // Code points, exactly as the server counts them, so the counter and the
  // server agree about what is too long.
  const characters = Array.from(draft).length;
  const tooLong = characters > maxChars;
  const canSend = conversation?.canSend !== false && !tooLong;
  // The round button's own state: progress while the message just sent is on
  // its way (the box is empty then, so there is nothing else to send), and a
  // mark while the newest attempt has failed - its text waits in the outbox,
  // with Retry, so nothing typed is lost.
  const newestPending = pending.at(-1);
  const sendState =
    newestPending?.status === 'FAILED'
      ? ('failed' as const)
      : newestPending?.status === 'SENDING' && draft.trim() === ''
        ? ('sending' as const)
        : ('idle' as const);
  const typingTimer = useRef<number | null>(null);

  const onDraftChange = (value: string): void => {
    setDraft(value);
    if (value.trim().length === 0) {
      thread.setTyping(false);
      return;
    }
    thread.setTyping(true);
    if (typingTimer.current !== null) window.clearTimeout(typingTimer.current);
    typingTimer.current = window.setTimeout(() => {
      thread.setTyping(false);
    }, 4_000);
  };

  // The draft is cleared only once the text is in the outbox, where it stays -
  // with Retry - if the network refuses it. Nothing typed is ever lost.
  const send = (text: string): void => {
    thread.send(text);
    setDraft('');
    thread.setTyping(false);
  };

  const pickFile = (file: File | undefined): void => {
    setFileError(null);
    if (file === undefined || attachments === undefined) return;
    if (!attachments.types.includes(file.type)) {
      setFileError(t('preorderChat.composer.fileType'));
      return;
    }
    if (file.size > attachments.maxBytes) {
      setFileError(
        t('preorderChat.composer.fileTooLarge', {
          size: `${formatNumber(Math.round(attachments.maxBytes / 1_048_576))} MB`,
        }),
      );
      return;
    }
    thread.sendFile(file);
  };

  const productName = context?.product.name ?? '';
  const status = conversation?.status ?? null;
  const latestProposal = [...messages].reverse().find((message) => message.proposal !== null)?.proposal ?? null;
  const teamName = t('preorderChat.team.name');
  // The marketplace's own name - never `business.displayName`, which on a
  // seller's shop front is the SELLER.
  const marketplace = t('preorderChat.team.short');

  return (
    <div className={cx('flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden', className)}>
      {variant === 'page' ? (
        <ConversationHeader
          headingRef={headingRef}
          teamName={teamName}
          context={context}
          status={status}
          preorder={conversation?.preorder ?? null}
          teamAvailable={teamAvailable}
          typicalResponse={typicalResponse}
        />
      ) : (
        <AvailabilityLine teamAvailable={teamAvailable} typicalResponse={typicalResponse} status={status} />
      )}

      <ConnectionLine state={thread.connection} />

      {/* Once the conversation exists, what it is about is a strip rather than
          a card inside the history: always in reach, never scrolled away. */}
      {conversation !== null && context !== null && <ProductStrip card={context} proposal={latestProposal} />}

      {/* The history. The one thing on this screen that scrolls. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <ChatViewport ref={scroll.viewportRef} onScroll={scroll.onScroll} label={t('preorderChat.historyLabel')}>
          <div ref={scroll.contentRef} className="mx-auto w-full max-w-3xl px-3 py-3 sm:px-4">
            {conversation === null && context !== null && (
              <ContextCard
                card={context}
                editable={onContextChange !== undefined}
                input={contextInput}
                onChange={onContextChange}
              />
            )}

            {thread.isLoading && <ThreadSkeleton label={t('preorderChat.loading')} />}
            {thread.loadError !== null && (
              <div role="alert" className="my-3 rounded-md border border-danger/30 bg-danger-soft p-3 text-sm">
                <p>{errorMessage(t, thread.loadError, t('preorderChat.loadError'))}</p>
                <Button size="sm" variant="secondary" className="mt-2" onClick={() => void thread.refresh()}>
                  {t('preorderChat.tryAgain')}
                </Button>
              </div>
            )}

            {thread.hasEarlier ? (
              <div className="my-2 flex justify-center">
                {thread.isLoadingEarlier ? (
                  <p role="status" className="flex items-center gap-2 text-xs text-ink-muted">
                    <Spinner className="size-3.5" /> {t('preorderChat.loadingEarlier')}
                  </p>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => void thread.loadEarlier()}>
                    {t('preorderChat.loadEarlier')}
                  </Button>
                )}
              </div>
            ) : (
              // Before a conversation exists: the assistant, automated and
              // labelled as such. It waits for the product to load, because
              // its greeting names the product.
              !thread.isLoading &&
              conversation === null &&
              thread.loadError === null && (
                <PreorderAssistant
                  assistant={assistant}
                  productName={productName}
                  signedIn
                  handoffStatus={handoffStatus}
                  handoffError={handoffError}
                  onRequestHuman={() => {
                    connectHuman(assistant.topic);
                  }}
                />
              )
            )}

            <ol className="flex flex-col">
              {timeline.map((entry) => {
                if (entry.kind === 'day') {
                  return (
                    <li key={entry.key}>
                      <DaySeparator
                        dateTime={entry.day}
                        label={dayLabel(entry.day, intlLocale, {
                          today: t('preorderChat.day.today'),
                          yesterday: t('preorderChat.day.yesterday'),
                        })}
                      />
                    </li>
                  );
                }
                if (entry.kind === 'unread') {
                  return (
                    <li key={entry.key}>
                      <UnreadSeparator label={t('preorderChat.unreadSeparator')} />
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
                      <MessageBubble
                        message={item.message}
                        receipts={conversation?.receipts ?? { deliveredSeq: 0, readSeq: 0 }}
                        conversationId={conversation?.id ?? null}
                        onReviewProposal={onReviewProposal}
                        groupStart={entry.groupStart}
                        groupEnd={entry.groupEnd}
                        marketplaceName={marketplace}
                      />
                    ) : (
                      <PendingBubble
                        entry={item.entry}
                        groupEnd={entry.groupEnd}
                        onRetry={thread.retry}
                        onDiscard={thread.discard}
                      />
                    )}
                  </li>
                );
              })}
            </ol>

            {thread.teamTyping && (
              <TypingIndicator label={t('preorderChat.typing')} />
            )}
          </div>
        </ChatViewport>

        {!scroll.isPinned && (
          <JumpToLatest
            onClick={scroll.jumpToLatest}
            label={
              scroll.newCount > 0
                ? t('preorderChat.jump.new', { count: scroll.newCount })
                : t('preorderChat.jump.latest')
            }
          />
        )}
      </div>

      <ChatAnnouncer
        text={
          thread.lastIncoming === null
            ? ''
            : t('preorderChat.announce', {
                text:
                  thread.lastIncoming.messageType === 'TEXT'
                    ? thread.lastIncoming.body.slice(0, 200)
                    : t('preorderChat.announceUpdate'),
              })
        }
      />

      {/* The composer. Never scrolls, never scrolled away. */}
      <div className="shrink-0 border-t border-border-subtle bg-surface px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 sm:px-4">
        <div className="mx-auto w-full max-w-3xl">
          {status === 'CLOSED' && <Notice text={t('preorderChat.closedNotice')} />}
          {status === 'BLOCKED' && <Notice text={t('preorderChat.blockedNotice')} />}
          {status === 'RESOLVED' && <Notice text={t('preorderChat.resolvedNotice')} tone="info" />}
          {status === 'AWAITING_YOU' && <Notice text={t('preorderChat.awaitingNotice')} tone="info" />}
          {/* Queued, and only that: nothing here says a person is online. */}
          {conversation?.humanRequested === true && status !== 'CLOSED' && status !== 'BLOCKED' && (
            <Notice text={t('preorderChat.handoff.queued')} tone="info" />
          )}

          {conversation?.canSend !== false && (
            <>
              <ChatComposer
                value={draft}
                onChange={onDraftChange}
                onSend={send}
                canSend={canSend}
                invalid={tooLong}
                textareaRef={composerRef}
                sendAppearance="round"
                sendState={sendState}
                labels={{
                  label: t('preorderChat.composer.label'),
                  placeholder: t('preorderChat.composer.placeholder'),
                  send: t('preorderChat.composer.sendMessage'),
                  hint: t('preorderChat.composer.hint'),
                  touchHint: t('preorderChat.composer.touchHint'),
                  sendFailed: t('preorderChat.composer.sendFailed'),
                }}
                leading={
                  conversation !== null ? (
                    <>
                      <input
                        ref={fileRef}
                        type="file"
                        className="sr-only"
                        tabIndex={-1}
                        accept={attachments?.types.join(',')}
                        aria-hidden="true"
                        onChange={(event) => {
                          pickFile(event.target.files?.[0]);
                          event.target.value = '';
                        }}
                      />
                      <button
                        type="button"
                        disabled={attachments?.available !== true}
                        aria-label={
                          attachments?.available === true
                            ? t('preorderChat.composer.attach')
                            : t('preorderChat.composer.attachUnavailable')
                        }
                        title={
                          attachments?.available === true
                            ? t('preorderChat.composer.attach')
                            : t('preorderChat.composer.attachUnavailable')
                        }
                        onClick={() => fileRef.current?.click()}
                        className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg border border-border text-ink-muted hover:text-brand disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                      >
                        <PaperclipIcon className="size-5" />
                      </button>
                    </>
                  ) : undefined
                }
                footer={
                  // Quiet until it matters: the count appears near the limit.
                  characters > maxChars * 0.8 ? (
                    <span className={cx(tooLong ? 'font-medium text-danger' : 'text-ink-subtle')}>
                      {tooLong
                        ? t('preorderChat.composer.tooLong', { max: formatNumber(maxChars) })
                        : t('preorderChat.composer.counter', {
                            used: formatNumber(characters),
                            max: formatNumber(maxChars),
                          })}
                    </span>
                  ) : undefined
                }
              />
              {fileError !== null && (
                <p role="alert" className="mt-1 text-xs text-danger">
                  {fileError}
                </p>
              )}
            </>
          )}

          {/* On a short window it keeps to one line on screen; the full text is
              still there for a screen reader, and on hover. */}
          <p
            className="mt-1.5 flex items-start gap-1.5 text-xxs leading-snug text-ink-subtle"
            title={t('preorderChat.safety')}
          >
            <ShieldIcon className="mt-px size-3.5 shrink-0" />
            <span className="[@media(max-height:760px)]:line-clamp-1">{t('preorderChat.safety')}</span>
          </p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The header, the availability line and the notices
// ---------------------------------------------------------------------------

function AvailabilityDot({ available }: { available: boolean | null }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cx(
        'size-2 shrink-0 rounded-full',
        available === true ? 'bg-success-fill' : available === false ? 'bg-ink-subtle' : 'bg-border',
      )}
    />
  );
}

function availabilityText(t: ReturnType<typeof useI18n>['t'], available: boolean | null): string {
  return available === null
    ? t('preorderChat.availability.checking')
    : available
      ? t('preorderChat.availability.available')
      : t('preorderChat.availability.offline');
}

function StatusPill({ status }: { status: CustomerChatStatus }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <span
      className={cx(
        'shrink-0 rounded-full px-2 py-0.5 text-xxs font-semibold',
        status === 'AWAITING_YOU'
          ? 'bg-warning-soft text-warning'
          : status === 'OPEN'
            ? 'bg-brand-soft text-brand'
            : 'bg-surface-sunken text-ink-muted',
      )}
    >
      {t(`preorderChat.conversationStatus.${status}` as TranslationKey)}
    </span>
  );
}

function AvailabilityLine({
  teamAvailable,
  typicalResponse,
  status,
}: {
  teamAvailable: boolean | null;
  typicalResponse: string | null;
  status: CustomerChatStatus | null;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-subtle px-4 py-2 text-xs text-ink-muted">
      <span className="inline-flex items-center gap-1.5">
        <AvailabilityDot available={teamAvailable} />
        {availabilityText(t, teamAvailable)}
      </span>
      {typicalResponse !== null && <span>{t('preorderChat.availability.typical', { value: typicalResponse })}</span>}
      {status !== null && (
        <span className="ml-auto">
          <StatusPill status={status} />
        </span>
      )}
    </div>
  );
}

function ConversationHeader({
  headingRef,
  teamName,
  context,
  status,
  preorder,
  teamAvailable,
  typicalResponse,
}: {
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  teamName: string;
  context: ChatContextCard | null;
  status: CustomerChatStatus | null;
  preorder: { id: string; requestNumber: string | null } | null;
  teamAvailable: boolean | null;
  typicalResponse: string | null;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-border-subtle px-3 py-2.5 sm:px-4">
      <Link
        to={MESSAGES_PATH}
        aria-label={t('preorderChat.header.back')}
        className="-ml-1 inline-flex size-9 shrink-0 items-center justify-center rounded-md text-ink-muted hover:bg-surface-hover hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand md:hidden"
      >
        <ArrowLeftIcon className="size-5" />
      </Link>
      {/* On a phone the product strip right below already shows the picture. */}
      <span className="max-sm:hidden">
        <ChatAvatar name={context?.product.name} imageUrl={context?.product.imageUrl} square />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="truncate text-sm font-semibold text-ink outline-none"
          >
            {teamName}
          </h2>
          {status !== null && <StatusPill status={status} />}
        </div>
        <p className="truncate text-xs text-ink-muted" title={context?.product.name}>
          {context?.product.name ?? '—'}
          {context !== null && (
            <span className="text-ink-subtle"> · {t('preorderChat.context.seller', { name: context.sellerName })}</span>
          )}
        </p>
        <p className="flex min-w-0 items-center gap-1.5 text-xxs text-ink-subtle">
          <AvailabilityDot available={teamAvailable} />
          <span className="truncate">
            {availabilityText(t, teamAvailable)}
            {typicalResponse !== null && <> · {t('preorderChat.availability.typical', { value: typicalResponse })}</>}
          </span>
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {preorder !== null && (
          <Link
            to={`/account/preorders/${preorder.id}`}
            className="hidden rounded-md px-2 py-1.5 text-xs font-medium text-brand hover:bg-brand-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand sm:inline-flex"
          >
            {t('preorderChat.header.viewPreorder')}
          </Link>
        )}
        {context !== null && (
          <Link
            to={`/product/${context.product.slug}`}
            aria-label={t('preorderChat.header.viewProduct')}
            className="inline-flex items-center rounded-md px-2 py-1.5 text-xs font-medium text-brand hover:bg-brand-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
          >
            <span className="max-sm:hidden">{t('preorderChat.header.viewProduct')}</span>
            <BoxIcon aria-hidden="true" className="size-5 sm:hidden" />
          </Link>
        )}
      </div>
    </header>
  );
}

function Notice({ text, tone = 'warn' }: { text: string; tone?: 'warn' | 'info' }): React.JSX.Element {
  return (
    <p
      role="status"
      className={cx(
        'mb-2 rounded-md px-3 py-1.5 text-xs',
        tone === 'warn' ? 'bg-warning-soft text-ink' : 'bg-brand-soft text-ink',
      )}
    >
      {text}
    </p>
  );
}

function ConnectionLine({ state }: { state: string }): React.JSX.Element | null {
  const { t } = useI18n();
  if (state === 'open' || state === 'idle') return null;
  return (
    <ConnectionBanner
      tone={state === 'connecting' ? 'info' : 'warning'}
      text={t(`preorderChat.connection.${state}` as TranslationKey)}
    />
  );
}

// ---------------------------------------------------------------------------
// The product strip and the product card
// ---------------------------------------------------------------------------

const STRIP_KEY = 'uboss.preorderChat.productStrip';

/** Below this window height the strip starts folded: the history needs the room more. */
const SHORT_WINDOW_PX = 820;

function readStripOpen(): boolean {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STRIP_KEY);
  } catch {
    stored = null;
  }
  if (stored === 'open') return true;
  if (stored === 'closed') return false;
  return typeof window === 'undefined' || window.innerHeight >= SHORT_WINDOW_PX;
}

/**
 * What the conversation is about, between the header and the history.
 *
 * Folds to one line, and remembers that in this browser - it is a
 * convenience, not a setting. Everything in it is the SNAPSHOT taken when the
 * conversation started, and says so; the only price-shaped thing is the
 * newest proposal's state, labelled indicative.
 */
function ProductStrip({ card, proposal }: { card: ChatContextCard; proposal: ChatProposal | null }): React.JSX.Element {
  const { t, intlLocale } = useI18n();
  const [open, setOpen] = useState(readStripOpen);
  const regionId = useId();
  const request = card.request;
  const unit = t(`preorderChat.unit.${request.orderingUnit}` as TranslationKey);
  const requested =
    request.unitQuantity === null
      ? unit
      : t('preorderChat.requestSummary', { quantity: formatNumber(request.unitQuantity), unit });

  const toggle = (): void => {
    setOpen((current) => {
      try {
        localStorage.setItem(STRIP_KEY, current ? 'closed' : 'open');
      } catch {
        /* private mode: it just does not remember */
      }
      return !current;
    });
  };

  return (
    <section
      aria-label={t('preorderChat.strip.heading')}
      className="shrink-0 border-b border-border-subtle bg-surface-sunken/60 px-3 py-2 sm:px-4"
    >
      <div className="mx-auto flex w-full max-w-3xl items-center gap-3">
        <ChatAvatar name={card.product.name} imageUrl={card.product.imageUrl} size="sm" square />
        <p className="min-w-0 flex-1 truncate text-xs">
          <span className="font-medium text-ink">{card.product.name}</span>
          <span className="text-ink-muted"> · {requested}</span>
        </p>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={regionId}
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xxs font-medium text-ink-muted hover:bg-surface-hover hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
        >
          {open ? t('preorderChat.strip.hide') : t('preorderChat.strip.show')}
          <ChevronDownIcon className={cx('size-3.5 transition-transform motion-reduce:transition-none', open && 'rotate-180')} />
        </button>
      </div>
      <div id={regionId} hidden={!open} className="mx-auto w-full max-w-3xl">
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xxs sm:grid-cols-4">
          <StripFact label={t('preorderChat.strip.option')}>
            {card.variant === null ? t('preorderChat.context.noVariant') : card.variant.name}
          </StripFact>
          <StripFact label={t('preorderChat.strip.moq')}>
            {card.preorder.minimumBaseUnits === null
              ? t('preorderChat.strip.none')
              : t('preorderChat.strip.pieces', { pieces: formatNumber(card.preorder.minimumBaseUnits) })}
          </StripFact>
          <StripFact label={t('preorderChat.strip.requested')}>
            {requested}
            {request.baseUnits !== null && request.unitQuantity !== null && (
              <> = {t('preorderChat.strip.pieces', { pieces: formatNumber(request.baseUnits) })}</>
            )}
          </StripFact>
          <StripFact label={t('preorderChat.context.date')}>
            {request.desiredDeliveryDate === null
              ? t('preorderChat.context.dateNone')
              : formatIsoDate(request.desiredDeliveryDate, intlLocale)}
          </StripFact>
        </dl>
        <p className="mt-1.5 text-xxs text-ink-subtle">
          {proposal === null
            ? t('preorderChat.strip.noProposal')
            : t('preorderChat.strip.proposal', {
                revision: String(proposal.revision),
                state: t(`preorderChat.proposal.state.${proposal.state}` as TranslationKey),
              })}{' '}
          · {t('preorderChat.strip.snapshot', { date: formatDateTime(card.capturedAt) })}
        </p>
      </div>
    </section>
  );
}

function StripFact({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-ink-subtle">{label}</dt>
      <dd className="truncate font-medium text-ink">{children}</dd>
    </div>
  );
}

function ContextCard({
  card,
  editable,
  input,
  onChange,
}: {
  card: ChatContextCard;
  editable: boolean;
  input: ChatContextInput | null;
  onChange: ((next: ChatContextInput) => void) | undefined;
}): React.JSX.Element {
  const { t, intlLocale } = useI18n();
  const quantityId = useId();
  const unitId = useId();
  const dateId = useId();
  const [quantityText, setQuantityText] = useState(
    input?.unitQuantity === null || input?.unitQuantity === undefined ? '' : String(input.unitQuantity),
  );

  const request = card.request;
  const commit = (patch: Partial<ChatContextInput>): void => {
    if (input === null || onChange === undefined) return;
    onChange({ ...input, ...patch });
  };

  return (
    <section
      aria-label={t('preorderChat.context.heading')}
      className="mb-3 rounded-lg border border-border-subtle bg-surface p-3 shadow-sm"
    >
      <div className="flex gap-3">
        <ChatAvatar name={card.product.name} imageUrl={card.product.imageUrl} size="lg" square />
        <div className="min-w-0 text-sm">
          <p className="font-medium text-ink [overflow-wrap:anywhere]">{card.product.name}</p>
          <p className="text-xs text-ink-muted">{t('preorderChat.context.seller', { name: card.sellerName })}</p>
          <p className="text-xs text-ink-muted">
            {t('preorderChat.context.sku', { sku: card.variant?.sku ?? card.product.sku })}
            {' · '}
            {card.variant === null
              ? t('preorderChat.context.noVariant')
              : t('preorderChat.context.variant', { name: card.variant.name })}
          </p>
          <p className="text-xs text-ink-muted">
            {card.preorder.minimumBaseUnits === null
              ? t('preorderChat.context.moqNone')
              : t('preorderChat.context.moq', { quantity: formatNumber(card.preorder.minimumBaseUnits) })}
          </p>
          <Link
            to={`/product/${card.product.slug}`}
            className="text-xs font-medium text-brand underline underline-offset-2"
          >
            {t('preorderChat.context.viewProduct')}
          </Link>
        </div>
      </div>

      <div className="mt-3 border-t border-border-subtle pt-2 text-xs">
        <p className="mb-1 font-medium text-ink">{t('preorderChat.context.requirement')}</p>
        {editable && input !== null ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <div>
              <label htmlFor={unitId} className="block text-ink-muted">
                {t('preorderChat.context.unit')}
              </label>
              <select
                id={unitId}
                value={input.orderingUnit}
                onChange={(event) => {
                  commit({ orderingUnit: event.target.value as ChatOrderingUnit });
                }}
                className="mt-0.5 w-full rounded border border-border bg-surface px-2 py-1 text-ink"
              >
                {CHAT_ORDERING_UNITS.map((unit) => (
                  <option key={unit} value={unit}>
                    {t(`preorderChat.unit.${unit}` as TranslationKey)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={quantityId} className="block text-ink-muted">
                {t('preorderChat.context.quantity')}
              </label>
              <input
                id={quantityId}
                inputMode="numeric"
                value={quantityText}
                onChange={(event) => {
                  setQuantityText(event.target.value.replace(/[^\d]/g, '').slice(0, 10));
                }}
                onBlur={() => {
                  const value = Number(quantityText);
                  commit({ unitQuantity: quantityText === '' || value <= 0 ? null : value });
                }}
                className="mt-0.5 w-full rounded border border-border bg-surface px-2 py-1 text-ink"
              />
            </div>
            <div className="col-span-2 sm:col-span-1">
              <label htmlFor={dateId} className="block text-ink-muted">
                {t('preorderChat.context.date')}
              </label>
              <input
                id={dateId}
                type="date"
                value={input.desiredDeliveryDate ?? ''}
                onChange={(event) => {
                  commit({ desiredDeliveryDate: event.target.value === '' ? null : event.target.value });
                }}
                className="mt-0.5 w-full rounded border border-border bg-surface px-2 py-1 text-ink"
              />
            </div>
          </div>
        ) : (
          <p className="text-ink-muted">
            {request.unitQuantity === null
              ? t(`preorderChat.unit.${request.orderingUnit}` as TranslationKey)
              : t('preorderChat.requestSummary', {
                  quantity: formatNumber(request.unitQuantity),
                  unit: t(`preorderChat.unit.${request.orderingUnit}` as TranslationKey),
                })}
            {' · '}
            {request.desiredDeliveryDate === null
              ? t('preorderChat.context.dateNone')
              : formatIsoDate(request.desiredDeliveryDate, intlLocale)}
          </p>
        )}
        {request.unitQuantity !== null && (
          <p className="mt-1 text-ink-muted">
            {request.baseUnits === null
              ? t('preorderChat.context.piecesUnknown')
              : t('preorderChat.context.pieces', { pieces: formatNumber(request.baseUnits) })}
          </p>
        )}
        {!editable && <p className="mt-1 text-xxs text-ink-subtle">{t('preorderChat.context.snapshotNote')}</p>}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

const KNOWN_SYSTEM_EVENTS = new Set([
  'status.resolved',
  'status.closed',
  'status.awaiting_customer',
  'status.reopened',
  'preorder.linked',
  'proposal.created',
  'proposal.updated',
  'proposal.withdrawn',
  'proposal.declined',
  'proposal.submitted',
  'handoff.joined',
]);

function systemText(t: ReturnType<typeof useI18n>['t'], message: ChatMessage): string {
  const requestNumber = String(message.systemMeta['requestNumber'] ?? '');
  return KNOWN_SYSTEM_EVENTS.has(message.systemEvent ?? '')
    ? t(`preorderChat.system.${message.systemEvent ?? 'unknown'}` as TranslationKey, { requestNumber })
    : t('preorderChat.system.unknown');
}

/** HH:mm under a group; the full date and time on hover and for a screen reader. */
function MessageTime({ at }: { at: string }): React.JSX.Element {
  const { intlLocale } = useI18n();
  const full = formatDateTime(at);
  const short = new Intl.DateTimeFormat(intlLocale, { hour: '2-digit', minute: '2-digit' }).format(new Date(at));
  return (
    <time dateTime={at} title={full}>
      <span aria-hidden="true">{short}</span>
      <span className="sr-only">{full}</span>
    </time>
  );
}

const MessageBubble = memo(function MessageBubble({
  message,
  receipts,
  conversationId,
  onReviewProposal,
  groupStart,
  groupEnd,
  marketplaceName,
}: {
  message: ChatMessage;
  receipts: { deliveredSeq: number; readSeq: number };
  conversationId: string | null;
  onReviewProposal: (conversationId: string, proposalId: string) => void;
  groupStart: boolean;
  groupEnd: boolean;
  marketplaceName: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const mine = message.senderType === 'CUSTOMER';

  if (message.messageType === 'SYSTEM_EVENT') {
    // Quieter than anything a person wrote - except a person joining, which
    // is the moment the customer was waiting for.
    return (
      <p
        className={cx(
          'py-1 text-center text-xxs',
          message.systemEvent === 'handoff.joined' ? 'font-semibold text-brand' : 'text-ink-subtle',
        )}
      >
        {systemText(t, message)}
      </p>
    );
  }

  // The customer asked for a person: their own act, told back quietly.
  if (message.messageType === 'HANDOFF_REQUEST') {
    return <p className="py-1 text-center text-xxs text-ink-subtle">{t('preorderChat.handoff.requested')}</p>;
  }

  // A common question the customer picked, in their own language.
  if (message.messageType === 'FAQ_QUESTION') {
    return (
      <div className="flex flex-col items-end">
        <div className="min-w-0 max-w-[min(85%,36rem)] rounded-2xl rounded-br-md bg-brand-fill px-3 py-2 text-sm text-white">
          {groupStart && <span className="sr-only">{t('preorderChat.sender.you')}: </span>}
          <p className="[overflow-wrap:anywhere]">{faqQuestionText(message.systemEvent ?? '', t)}</p>
        </div>
      </div>
    );
  }

  // The assistant's answer, as the customer was shown it - labelled
  // automated, with its own mark, never the team's.
  if (message.messageType === 'AUTOMATED_REPLY') {
    return (
      <div className="flex items-end gap-2">
        <span className="w-7 shrink-0">{groupEnd && <AssistantMark />}</span>
        <div className="flex min-w-0 max-w-[min(85%,36rem)] flex-col items-start">
          {groupStart && <AssistantLabel />}
          <div className="min-w-0 max-w-full rounded-2xl rounded-bl-md border border-brand/15 bg-brand-soft/40 px-3 py-2 text-sm text-ink">
            {message.automation === null || message.automation === undefined ? (
              <p className="italic text-ink-muted">{t('preorderChat.assistant.answerUnavailable')}</p>
            ) : (
              <AnswerLines answer={message.automation} />
            )}
          </div>
          {groupEnd && (
            <p className="mt-0.5 px-1 text-xxs text-ink-subtle">
              <MessageTime at={message.createdAt} />
            </p>
          )}
        </div>
      </div>
    );
  }

  if (message.messageType === 'STRUCTURED_OFFER' && message.proposal !== null && conversationId !== null) {
    const proposal = message.proposal;
    return (
      <div className="mx-auto w-full max-w-lg">
        <p className="py-1 text-center text-xxs text-ink-subtle">{systemText(t, message)}</p>
        <ProposalCard
          proposal={proposal}
          conversationId={conversationId}
          onReview={() => {
            onReviewProposal(conversationId, proposal.id);
          }}
        />
      </div>
    );
  }

  const state: DeliveryState | null = mine ? deliveryStateOf(message.seq, receipts) : null;

  return (
    <div className={cx('flex items-end gap-2', mine ? 'flex-row-reverse' : 'flex-row')}>
      {!mine && (
        <span className="w-7 shrink-0">{groupEnd && <ChatAvatar name={marketplaceName} size="sm" tone="brand" />}</span>
      )}
      <div className={cx('flex min-w-0 max-w-[min(85%,36rem)] flex-col', mine ? 'items-end' : 'items-start')}>
        {groupStart && !mine && (
          <p className="mb-0.5 px-1 text-xxs font-medium text-ink-muted">
            {t('preorderChat.sender.team')}
          </p>
        )}
        <div
          className={cx(
            'min-w-0 max-w-full rounded-2xl px-3 py-2 text-sm',
            mine ? 'bg-brand-fill text-white' : 'bg-surface-sunken text-ink',
            mine ? !groupStart && 'rounded-tr-md' : !groupStart && 'rounded-tl-md',
            mine ? !groupEnd && 'rounded-br-md' : !groupEnd && 'rounded-bl-md',
          )}
        >
          {groupStart && mine && <span className="sr-only">{t('preorderChat.sender.you')}: </span>}
          {message.redacted ? (
            <p className="italic">{t('preorderChat.redacted')}</p>
          ) : message.attachment !== null ? (
            <AttachmentLink message={message} conversationId={conversationId} mine={mine} />
          ) : (
            <MessageText body={message.body} />
          )}
        </div>
        {groupEnd && (
          <p className="mt-0.5 flex items-center gap-1.5 px-1 text-xxs text-ink-subtle">
            <MessageTime at={message.createdAt} />
            {state !== null && (
              <DeliveryMark state={state} label={t(`preorderChat.status.${state}` as TranslationKey)} />
            )}
          </p>
        )}
      </div>
    </div>
  );
});

function AttachmentLink({
  message,
  conversationId,
  mine,
}: {
  message: ChatMessage;
  conversationId: string | null;
  mine: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const [error, setError] = useState<unknown>(null);
  const attachment = message.attachment;
  if (attachment === null) return <></>;
  const size = `${formatNumber(Math.max(1, Math.round(attachment.byteSize / 1024)))} KB`;
  if (!attachment.downloadable || conversationId === null) {
    return (
      <p className="flex items-center gap-1.5">
        <DocumentIcon className="size-4 shrink-0" />
        <span className="min-w-0 [overflow-wrap:anywhere]">{attachment.fileName}</span>
        <span className="shrink-0 text-xs opacity-80">({t('preorderChat.attachment.unavailable')})</span>
      </p>
    );
  }
  return (
    <>
      <button
        type="button"
        className={cx('flex min-w-0 items-center gap-1.5 text-left underline underline-offset-2', mine && 'text-white')}
        aria-label={t('preorderChat.attachment.open', { name: attachment.fileName })}
        onClick={() => {
          setError(null);
          void openChatAttachment(conversationId, attachment.id).catch(setError);
        }}
      >
        <DocumentIcon className="size-4 shrink-0" />
        <span className="min-w-0 [overflow-wrap:anywhere]">{attachment.fileName}</span>
        <span className="shrink-0 text-xs opacity-80">{size}</span>
      </button>
      {error !== null && <p role="alert" className="mt-1 text-xs">{errorMessage(t, error)}</p>}
    </>
  );
}

function PendingBubble({
  entry,
  groupEnd,
  onRetry,
  onDiscard,
}: {
  entry: PendingMessage;
  groupEnd: boolean;
  onRetry: (clientMessageId: string) => void;
  onDiscard: (clientMessageId: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const failed = entry.status === 'FAILED';
  return (
    <div className="flex flex-col items-end">
      <div
        className={cx(
          'min-w-0 max-w-[min(85%,36rem)] rounded-2xl px-3 py-2 text-sm',
          failed ? 'border border-danger/50 bg-danger-soft text-ink' : 'bg-brand-fill/70 text-white',
        )}
      >
        {entry.file !== undefined ? (
          <p className="flex items-center gap-1.5">
            <DocumentIcon className="size-4 shrink-0" />
            <span className="min-w-0 [overflow-wrap:anywhere]">{entry.file.name}</span>
          </p>
        ) : (
          <MessageText body={entry.body} />
        )}
      </div>
      {(groupEnd || failed) && (
        <p className="mt-0.5 flex flex-wrap items-center justify-end gap-x-2 px-1 text-xxs text-ink-subtle">
          <DeliveryMark state={entry.status} label={t(`preorderChat.status.${entry.status}` as TranslationKey)} />
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
                {t('preorderChat.retry')}
              </button>
              <button
                type="button"
                className="rounded underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
                onClick={() => {
                  onDiscard(entry.clientMessageId);
                }}
              >
                {t('preorderChat.discard')}
              </button>
            </>
          )}
        </p>
      )}
    </div>
  );
}

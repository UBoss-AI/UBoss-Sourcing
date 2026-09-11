/**
 * AI Mode — the assistant as a page.
 *
 * This replaces the chat widget that used to be pinned to the bottom-right
 * corner of every screen. The widget is gone entirely: the launcher, the
 * fixed positioning, the open/closed state, the window event a page used to
 * dispatch at it, and the `sessionStorage` keys it kept. Nothing in the
 * storefront floats over the catalogue any more.
 *
 * What the move buys, and why it was worth doing rather than making the panel
 * bigger:
 *
 *   - **The history belongs to the account.** The widget kept one conversation
 *     id in `sessionStorage` and forgot it when the tab closed. For a signed-in
 *     customer the threads now come from the API, scoped to their own profile
 *     on every read, so a buyer who asked something on Tuesday finds it on
 *     Thursday on a different machine — and cannot reach anybody else's.
 *   - **There is room to answer properly.** A 23rem panel over a product grid
 *     is the wrong shape for a reply that lists eight product codes.
 *   - **It is a route, so it can be linked and returned to.** The landing
 *     page's search bar sends a question here and it is asked on arrival. That
 *     flow has nowhere to live in a widget.
 *
 * **The page is open to everybody**, on the same reasoning that puts the
 * sign-in wall at the cart rather than the front door: somebody deciding
 * whether this catalogue has what they need should be able to ask before
 * opening an account. Signing in is what adds a history, not what buys an
 * answer.
 *
 * So there are two kinds of visitor here and the difference is small but real:
 *
 *   - A **customer** is recognised by their session. The rail lists their
 *     threads; they can open, rename and delete them.
 *   - A **guest** holds one conversation, proved by an opaque token the API
 *     handed back when it was opened. The rail invites them to sign in instead
 *     of listing anything, because there is nothing to list. The token lives in
 *     React state and nowhere else — see the note on `guestToken`.
 *
 * An operator who would rather pay only for their own customers sets
 * `ASSISTANT_ALLOW_GUESTS=false` on the API, and a guest's first send comes
 * back 401.
 *
 * The server holds the transcript, whoever asked. This page sends one message
 * at a time with a conversation id and does not post history back, so what
 * staff read under Enquiries is what the model was actually sent.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { useAccountIdentity } from '@/pages/account/useAccountIdentity';
import { useStorefront } from '@/app/storefront-context';
import { ImageSearchDialog } from '@/components/hero-search/ImageSearchDialog';
import { Button, Spinner } from '@/components/ui';
import { SidebarIcon, SparkIcon } from '@/components/icons';
import { cx } from '@/lib/cx';
import { ApiError, api, requestStream } from '@/lib/api';
import { readAssistantStream } from '@/lib/assistant-stream';
import { takePendingQuestion } from '@/lib/ai-mode';
import type { ImageSearchResult } from '@/lib/image-search';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { AiComposer } from './ai/AiComposer';
import { AiMessage } from './ai/AiMessage';
import { AiSidebar } from './ai/AiSidebar';
import type { ChatMessage } from './ai/AiMessage';
import type { ConversationSummary } from './ai/conversations';

/** Mirrors ASSISTANT_MAX_TURNS on the API, which rejects anything longer. */
const MAX_TURNS = 20;

/**
 * The starters.
 *
 * Five, and every one of them is something this system can actually answer
 * from: the catalogue, stock, an order history, a recurring schedule, the
 * operator's own supplier requirements. A chip that opens a conversation the
 * assistant has to decline is worse than no chip.
 */
const SUGGESTIONS: readonly TranslationKey[] = [
  'aiMode.suggestion.diagnostics',
  'aiMode.suggestion.compare',
  'aiMode.suggestion.warehouse',
  'aiMode.suggestion.recurring',
  'aiMode.suggestion.supplier',
];

interface ConversationDetail extends ConversationSummary {
  messages: { id: string; role: 'user' | 'assistant'; content: string; createdAt: string }[];
}

export function AiModePage(): React.JSX.Element {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { business, features, assistant } = useStorefront();
  const { user, logout, isCustomer } = useSession();

  /**
   * The first name on the account, for the greeting, and nothing else.
   *
   * The same hook the header button and the account sidebar use, so this page
   * greets somebody by exactly the name they are greeted by everywhere else -
   * and shares its query key, so on a signed-in visit it usually costs no
   * request at all. `shortName` is null for a guest, for an account with no
   * name typed into it, and while the read is still in flight; all three are
   * ordinary and the greeting simply drops the name line. It is deliberately
   * never derived from the email address: `ops.procurement@` is not a person,
   * and "Hello, Ops" is worse than no name at all.
   */
  const identity = useAccountIdentity(isCustomer);

  useDocumentMeta({ title: t('aiMode.title'), description: t('aiMode.metaDescription') }, business.displayName);

  const [activeId, setActiveId] = useState<string | null>(null);
  /**
   * A guest's proof that the open conversation is theirs.
   *
   * Null for a signed-in customer, whose account is the proof.
   *
   * Deliberately **not** persisted. Storing it would let a reload resume the
   * conversation, but a guest cannot re-read a transcript — that route belongs
   * to accounts — so the page would come back empty while the model carried
   * context nobody could see, and the next answer would refer to things that
   * are not on screen. A reload starting a fresh conversation is the version
   * where what is shown and what the server holds are the same thing.
   */
  const [guestToken, setGuestToken] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The question the last failed send was carrying, so Retry can re-send it. */
  const [retryable, setRetryable] = useState<string | null>(null);
  /** Index of a reply the stream cut off part-way. */
  const [truncatedAt, setTruncatedAt] = useState<number | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isSidebarPinned, setIsSidebarPinned] = useState(true);
  const [isAttachOpen, setIsAttachOpen] = useState(false);

  const transcriptRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // --- History -------------------------------------------------------------

  const history = useQuery({
    queryKey: ['assistant', 'conversations'],
    queryFn: () =>
      api.get<{ conversations: ConversationSummary[] }>('/assistant/conversations'),
    // A history is a thing an account has. A guest would only collect a 401
    // here, and a failing query in the cache is what the service banner reads
    // to decide the whole store is in trouble.
    enabled: isCustomer,
    // Threads change only when this page changes them, and it invalidates the
    // key itself when it does. Refetching on every window focus would be a
    // request per tab switch for a list that cannot have moved.
    staleTime: 60_000,
  });

  const conversations = history.data?.conversations ?? [];

  const rename = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      api.patch<null>(`/assistant/conversations/${id}`, { title }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['assistant', 'conversations'] });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete<null>(`/assistant/conversations/${id}`),
    onSuccess: (_result, id) => {
      void queryClient.invalidateQueries({ queryKey: ['assistant', 'conversations'] });
      // Deleting the thread you are reading has to clear the pane as well as
      // the row, or the transcript stays on screen after the conversation it
      // belongs to has gone.
      if (id === activeId) {
        setActiveId(null);
        setMessages([]);
        setTruncatedAt(null);
      }
    },
  });

  // --- Sending -------------------------------------------------------------

  /**
   * Open a conversation, returning its id and whatever proves it is ours.
   *
   * An existing one wins. Where the API opens a new one for a guest it hands
   * back a token — the only thing that will ever prove the conversation is
   * theirs, since they have no account to be recognised by.
   */
  const ensureConversation = useCallback(
    async (
      existing: { id: string; token: string | null } | null,
    ): Promise<{ id: string; token: string | null }> => {
      if (existing !== null) return existing;

      const started = await api.post<{ conversationId: string; conversationToken?: string }>(
        '/assistant/start',
        {},
      );

      const token = started.conversationToken ?? null;

      setActiveId(started.conversationId);
      setGuestToken(token);

      return { id: started.conversationId, token };
    },
    [],
  );

  const send = useCallback(
    async (text: string): Promise<void> => {
      const question = text.trim();
      if (question.length === 0 || isStreaming) return;

      setError(null);
      setRetryable(null);
      setTruncatedAt(null);

      let conversation: { id: string; token: string | null };
      try {
        conversation = await ensureConversation(
          activeId === null ? null : { id: activeId, token: guestToken },
        );
      } catch (caught) {
        setError(
          caught instanceof ApiError && caught.isRateLimited
            ? t('chat.tooManyAttempts')
            : t('chat.couldNotStartTheChat'),
        );
        setRetryable(question);
        return;
      }

      // The assistant row is appended empty and filled by the deltas, so the
      // transcript grows in place instead of appearing all at once.
      setMessages((current) => [
        ...current,
        { role: 'user', content: question },
        { role: 'assistant', content: '' },
      ]);
      setIsStreaming(true);

      const abort = new AbortController();
      abortRef.current = abort;

      try {
        const response = await requestStream('/assistant/chat', {
          body: {
            conversationId: conversation.id,
            message: question,
            // Only a guest sends one. A customer's account is the proof, and
            // the API ignores a token from a signed-in caller anyway.
            ...(conversation.token === null ? {} : { conversationToken: conversation.token }),
          },
          signal: abort.signal,
        });

        if (!response.ok || response.body === null) {
          // Drop the pair we optimistically added: an empty bubble reads as a
          // reply that said nothing, which is worse than no bubble at all.
          setMessages((current) => current.slice(0, -2));

          if (response.status === 401) {
            /*
             * The session went while they were typing.
             *
             * The page is public, so this is not the end of the road: the
             * conversation that belonged to the dead session is dropped and the
             * next send opens a guest one. The question goes back in the
             * composer rather than being lost — somebody who spent a minute
             * describing what they need should not have to type it twice
             * because a token expired while they did.
             */
            setActiveId(null);
            setGuestToken(null);
            setMessages([]);
            setDraft(question);
            setError(t('chat.sessionExpired'));
            return;
          }

          if (response.status === 404) {
            // The conversation is not one the API will answer for — swept,
            // deleted from another tab, or a guest token this browser no
            // longer holds. Start a fresh one on the next send.
            setActiveId(null);
            setGuestToken(null);
            setDraft(question);
            setError(t('chat.chatEndedRestart'));
            return;
          }

          setError(
            response.status === 429
              ? t('chat.thatIsALotOfQuestions')
              : t('chat.assistantUnavailable'),
          );
          setRetryable(question);
          return;
        }

        // Sent. Only now is the composer cleared, so nothing above this line
        // can lose what was typed.
        setDraft('');

        await readAssistantStream(t, response.body, {
          onDelta: (delta) => {
            setMessages((current) => {
              const next = [...current];
              const last = next[next.length - 1];
              if (last?.role === 'assistant') {
                next[next.length - 1] = { role: 'assistant', content: last.content + delta };
              }
              return next;
            });
          },
          onError: (message) => {
            setError(message);
            /*
             * An error frame after some text has already streamed leaves a
             * reply that stops mid-sentence but reads as finished. On a
             * catalogue of cannulae and feeding tubes that is worse than no
             * answer: half a list of product codes looks like the whole list.
             */
            setMessages((current) => {
              const last = current[current.length - 1];
              if (last?.role === 'assistant' && last.content.length > 0) {
                setTruncatedAt(current.length - 1);
              }
              return current;
            });
          },
        });

        // A stream that carried an error and no text leaves an empty bubble.
        setMessages((current) => {
          const last = current[current.length - 1];
          if (last?.role === 'assistant' && last.content.length === 0) return current.slice(0, -1);
          return current;
        });

        // The thread is now in the customer's history, or has moved to the top
        // of it. Either way the sidebar is out of date.
        void queryClient.invalidateQueries({ queryKey: ['assistant', 'conversations'] });
      } catch {
        if (!abort.signal.aborted) {
          setError(t('chat.theConnectionDropped'));
          setMessages((current) => current.slice(0, -2));
          setRetryable(question);
        }
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [activeId, ensureConversation, guestToken, isStreaming, queryClient, t],
  );

  // Leaving mid-answer aborts the request, which stops the generation the
  // deployment is paying for rather than letting it run into a dead socket.
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  /*
   * Keep the newest message in view as it streams in — but only once there is
   * one.
   *
   * The empty state is a welcome heading, an introduction and a row of
   * starters, and it is taller than the pane on a laptop. Scrolling it to the
   * bottom opens the page part-way down its own greeting, with the heading
   * above the fold, which reads as a page that has lost its place.
   */
  useEffect(() => {
    if (messages.length === 0) return;

    const transcript = transcriptRef.current;
    if (transcript !== null) transcript.scrollTop = transcript.scrollHeight;
  }, [messages]);

  /*
   * The question that arrived from the landing page.
   *
   * Read once — `takePendingQuestion` clears as it reads — so a refresh does
   * not re-ask what was already asked. `send` is deliberately NOT in the
   * dependency list: it changes identity whenever `activeId` or `isStreaming`
   * does, and re-running this effect on that would collect a second pending
   * question that is not there and, worse, fire again the moment one appeared.
   */
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  }, [send]);

  useEffect(() => {
    const pending = takePendingQuestion();
    if (pending === null) return;

    if (pending.intent === 'send') void sendRef.current(pending.text);
    else setDraft(pending.text);
  }, []);

  // --- Switching threads ---------------------------------------------------

  const openConversation = useCallback(
    async (id: string): Promise<void> => {
      // Stop whatever is streaming into the thread being left. Without this the
      // deltas keep landing on the transcript of the thread just opened.
      abortRef.current?.abort();
      abortRef.current = null;
      setIsStreaming(false);

      setActiveId(id);
      // Only an account has saved threads, so anything opened from the sidebar
      // is owned by that account and no token comes with it.
      setGuestToken(null);
      setMessages([]);
      setError(null);
      setRetryable(null);
      setTruncatedAt(null);
      setIsSidebarOpen(false);

      try {
        const detail = await api.get<{ conversation: ConversationDetail }>(
          `/assistant/conversations/${id}`,
        );
        setMessages(
          detail.conversation.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        );
      } catch {
        setError(t('aiMode.couldNotLoadConversation'));
      }
    },
    [t],
  );

  const startNewChat = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
    setActiveId(null);
    setGuestToken(null);
    setMessages([]);
    setDraft('');
    setError(null);
    setRetryable(null);
    setTruncatedAt(null);
    setIsSidebarOpen(false);
  }, []);

  /**
   * Put what a photograph found into the composer.
   *
   * Not sent, and not turned into a message of its own: it is context the
   * customer then asks a question about ("which of these fits a 10 Fr port?").
   * Written as product paths so the reply can link them straight back — the
   * transcript renderer turns `/product/...` into a router link and nothing
   * else.
   */
  const attachImageResult = useCallback(
    (result: ImageSearchResult) => {
      // The model's sentence usually ends in a full stop and the sentence it is
      // being dropped into supplies its own, so one of them has to go. Trimming
      // here rather than rewording the key keeps the sentence readable in all
      // eight languages whether or not the description arrived punctuated.
      const description = result.description.trim().replace(/[.。]$/, '');

      const lines = [
        t('aiMode.attachedIntro', { description }),
        ...result.products
          .slice(0, 8)
          .map((product) => `- ${product.name} (/product/${product.slug})`),
      ];

      setDraft((current) => {
        const block = lines.join('\n');
        return current.trim().length === 0 ? `${block}\n\n` : `${current.trimEnd()}\n\n${block}\n\n`;
      });
      setIsAttachOpen(false);
    },
    [t],
  );

  // --- Derived -------------------------------------------------------------

  const askedTurns = messages.filter((message) => message.role === 'user').length;
  const isFull = askedTurns >= MAX_TURNS;
  const isEmpty = messages.length === 0;

  /** The last question asked, for "Ask again". */
  const lastQuestion =
    [...messages].reverse().find((message) => message.role === 'user')?.content ?? null;

  return (
    <div className="flex h-full min-h-0">
      {/* --- Sidebar ---------------------------------------------------------
       *
       * One component, two presentations. Below `lg` it is a drawer over the
       * page with its own scrim; from `lg` it is a rail in the layout that can
       * be pinned open or collapsed. Two components would be two definitions of
       * what "selected" looks like.
       */}
      {isSidebarOpen && (
        <button
          type="button"
          onClick={() => {
            setIsSidebarOpen(false);
          }}
          aria-label={t('aiMode.hideSidebar')}
          className="fixed inset-0 z-30 bg-navy/40 lg:hidden"
        />
      )}

      <aside
        className={cx(
          'fixed inset-y-0 left-0 z-40 w-72 border-r border-border transition-transform lg:static lg:z-auto lg:translate-x-0',
          isSidebarOpen ? 'translate-x-0' : '-translate-x-full',
          isSidebarPinned ? 'lg:block' : 'lg:hidden',
        )}
      >
        <AiSidebar
          conversations={conversations}
          isLoading={history.isPending}
          activeId={activeId}
          onSelect={(id) => {
            void openConversation(id);
          }}
          onNewChat={startNewChat}
          onRename={(id, title) => {
            rename.mutate({ id, title });
          }}
          onDelete={(id) => {
            remove.mutate(id);
          }}
          onCollapse={() => {
            setIsSidebarOpen(false);
            setIsSidebarPinned(false);
          }}
          isSignedIn={isCustomer}
          onSignOut={() => {
            /*
             * End the session and start again as a guest, on this page.
             *
             * `/ai` is public, so there is nowhere to be thrown out to — and
             * dropping somebody onto the home page for pressing Sign out would
             * be a worse answer than simply forgetting who they were. The
             * conversation goes with the session: it was theirs, and the
             * browser has no token for it.
             */
            startNewChat();
            void logout();
          }}
          customerName={user?.email ?? null}
        />
      </aside>

      {/* --- Conversation ---------------------------------------------------- */}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-3 py-2.5 sm:px-6">
          <button
            type="button"
            onClick={() => {
              setIsSidebarOpen(true);
              setIsSidebarPinned(true);
            }}
            aria-label={t('aiMode.showSidebar')}
            className={cx(
              'flex h-9 w-9 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink',
              // Hidden from `lg` only while the rail is already there.
              isSidebarPinned && 'lg:hidden',
            )}
          >
            <SidebarIcon className="h-[1.15rem] w-[1.15rem]" />
          </button>

          <p className="flex min-w-0 items-center gap-2 text-title-xs text-ink">
            <SparkIcon className="h-4 w-4 shrink-0 text-brand" />
            <span className="truncate">{t('aiMode.title')}</span>
          </p>
        </header>

        <div ref={transcriptRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-6 sm:px-6">
          <div className="mx-auto max-w-3xl space-y-5">
            {isEmpty ? (
              <div className="pt-8 text-center sm:pt-16">
                {/*
                 * The greeting, and it is two lines rather than a paragraph.
                 *
                 * What used to be here was a heading plus four lines
                 * explaining what the assistant could be asked and where its
                 * answers came from. All of it true, none of it read: somebody
                 * who has opened a chat has already decided to type, and an
                 * onboarding paragraph between them and the composer is a
                 * thing to scroll past. The starters below say what can be
                 * asked by being askable, which is a better answer than a
                 * sentence claiming it.
                 *
                 * The name is a separate line above the question rather than
                 * folded into it, so its absence costs nothing - a guest sees
                 * the question, correctly positioned, and not a re-flowed
                 * heading with a gap where a name was meant to be.
                 *
                 * The gradient runs the brand blue into its own hover step and
                 * ends before it reaches the question, which stays solid ink:
                 * a decorative fill on the words somebody actually has to read
                 * is a contrast cost for nothing.
                 */}
                {identity.shortName !== null && (
                  <p className="bg-gradient-to-br from-brand to-brand-hover bg-clip-text text-2xl font-semibold tracking-tight text-transparent sm:text-4xl">
                    {t('aiMode.greeting', { name: identity.shortName })}
                  </p>
                )}

                <h1
                  className={cx(
                    'text-2xl font-semibold tracking-tight text-ink sm:text-4xl',
                    identity.shortName !== null && 'mt-1.5',
                  )}
                >
                  {t('aiMode.greetingQuestion')}
                </h1>

                <ul className="mt-8 flex flex-wrap justify-center gap-2">
                  {SUGGESTIONS.map((key) => (
                    <li key={key}>
                      <button
                        type="button"
                        onClick={() => {
                          void send(t(key));
                        }}
                        className="rounded-full border border-border bg-surface px-3.5 py-2 text-sm text-ink-muted shadow-card transition-[background-color,border-color,color,box-shadow] hover:border-brand hover:bg-brand-soft hover:text-brand hover:shadow-card-hover focus-visible:border-brand focus-visible:bg-brand-soft focus-visible:text-brand motion-reduce:transition-none"
                      >
                        {t(key)}
                      </button>
                    </li>
                  ))}
                </ul>

                {/* AI Act Art. 50(1): said before they engage, not after. The
                    vendor is named because that vendor receives whatever is
                    typed, which is a GDPR Art. 13(1)(e) disclosure too. */}
                <p className="mx-auto mt-8 max-w-lg text-xs leading-relaxed text-ink-subtle">
                  {t('chat.aiNotice')}{' '}
                  {assistant.vendor !== null &&
                    `${t('chat.aiVendorNotice', { vendor: assistant.vendor.name })} `}
                  {t('chat.retentionNotice')}
                </p>
              </div>
            ) : (
              messages.map((message, index) =>
                // The streaming reply is appended as an empty assistant message
                // the moment the request goes out, so the deltas have somewhere
                // to land. Until the first token arrives it must not be drawn.
                message.role === 'assistant' && message.content.length === 0 ? null : (
                  <AiMessage
                    key={index}
                    message={message}
                    isTruncated={truncatedAt === index}
                    onAskAgain={
                      message.role === 'assistant' &&
                      !isStreaming &&
                      index === messages.length - 1 &&
                      lastQuestion !== null
                        ? () => {
                            void send(lastQuestion);
                          }
                        : undefined
                    }
                  />
                ),
              )
            )}

            {/* Announced politely, and only while it is actually thinking: a
                screen reader should learn that an answer is coming without
                having every streamed token read out as it lands. */}
            {isStreaming && (
              <div className="flex items-center gap-2 text-xs text-ink-muted" role="status">
                <Spinner className="h-3.5 w-3.5" />
                {t('chat.thinking')}
              </div>
            )}

            {error !== null && (
              <div
                role="alert"
                className="rounded-lg border border-danger/30 bg-danger-soft px-3.5 py-3"
              >
                <p className="text-sm text-danger">{error}</p>
                {retryable !== null && (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="mt-2.5"
                    onClick={() => {
                      const question = retryable;
                      setRetryable(null);
                      void send(question);
                    }}
                  >
                    {t('aiMode.retry')}
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>

        <AiComposer
          value={draft}
          onChange={setDraft}
          onSend={() => {
            void send(draft);
          }}
          onStop={() => {
            abortRef.current?.abort();
          }}
          onAttach={
            features.imageSearch === true
              ? () => {
                  setIsAttachOpen(true);
                }
              : undefined
          }
          isStreaming={isStreaming}
          isDisabled={isFull}
          disabledNote={isFull ? t('aiMode.turnLimit') : undefined}
        />
      </section>

      {/* Mounted only while open — see the note on the same dialog in
          `HeroSearch`. */}
      {features.imageSearch === true && isAttachOpen && (
        <ImageSearchDialog
          isOpen
          onClose={() => {
            setIsAttachOpen(false);
          }}
          onUse={attachImageResult}
        />
      )}
    </div>
  );
}

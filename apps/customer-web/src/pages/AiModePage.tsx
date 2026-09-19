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
 * **The page is reachable by everybody; whether it answers a guest is the
 * deployment's decision, and it ships as no.** `ASSISTANT_ALLOW_GUESTS`
 * defaults to `false` on the API, because an anonymous caller spends the
 * operator's AI provider budget on a page anybody on the internet can open. An
 * operator who would rather let a buyer evaluate the catalogue before opening
 * an account sets it to `true` — the same reasoning that puts the sign-in wall
 * at the cart rather than at the front door.
 *
 * So this page handles two kinds of visitor, and the difference is small but
 * real:
 *
 *   - A **customer** is recognised by their session. The rail lists their
 *     threads; they can open, rename and delete them.
 *   - A **guest**, where guests are allowed, holds one conversation, proved by
 *     an opaque token the API handed back when it was opened. The rail invites
 *     them to sign in instead of listing anything, because there is nothing to
 *     list. The token lives in React state and nowhere else — see the note on
 *     `guestToken`.
 *
 * With guests off, a signed-out visitor is offered the way in **instead of a
 * composer**. The setting is published in `/config`, so the page knows before
 * it draws rather than after somebody has typed out what they need and pressed
 * Send. Not a disabled text box either: people type into those anyway and then
 * wonder why nothing happened. The starter chips are withheld for the same
 * reason — a chip that opens a conversation the deployment will refuse looks
 * like an invitation and is not one. No request is made at all.
 *
 * A question carried here from the landing page's search bar is left parked in
 * `sessionStorage` rather than consumed, so it survives the page load that
 * signing in costs and is asked on the way back.
 *
 * The 401 branch below still matters for the case where the config and the
 * server disagree — an operator flipping the setting while somebody has the
 * page open. It answers with the same invitation rather than "your session has
 * expired", which is the other thing a 401 means here and would send somebody
 * who never had a session looking for a problem that does not exist.
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
import { Modal } from '@/components/Modal';
import { Button, ButtonLink, Spinner } from '@/components/ui';
import { SidebarIcon, SparkIcon } from '@/components/icons';
import { cx } from '@/lib/cx';
import { formatNumber } from '@/lib/format';
import { GREETING_KEYS, greetingPeriod } from '@/lib/greeting-time';
import { ApiError, api, requestStream } from '@/lib/api';
import { readAssistantStream } from '@/lib/assistant-stream';
import { AI_MODE_PATH, takePendingQuestion } from '@/lib/ai-mode';
import type { ImageSearchResult } from '@/lib/image-search';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { stockedCategories } from '@/lib/category-tree';
import type { CategoryNode } from '@/lib/types';
import { AiComposer } from './ai/AiComposer';
import { AiMessage } from './ai/AiMessage';
import { AiSidebar } from './ai/AiSidebar';
import type { ChatMessage } from './ai/AiMessage';
import type { ConversationSummary } from './ai/conversations';

/** Mirrors ASSISTANT_MAX_TURNS on the API, which rejects anything longer. */
const MAX_TURNS = 20;

/**
 * The starters that do not depend on what is in stock.
 *
 * Two, down from five, and the three that went were the tell. "Find suitable
 * diagnostic equipment" named one trade on a marketplace that sells every
 * trade. "Check warehouse availability" opened a conversation the assistant is
 * told in its own prompt it cannot have - it has no live stock figures.
 * "Explain supplier requirements" was a sentence rather than a question, and
 * the assistant has nothing behind it. A chip that opens a conversation the
 * assistant must decline is worse than no chip.
 *
 * What replaced them is below, and it is not a fixed list at all: the real
 * categories of this deployment's own catalogue.
 */
const SUGGESTIONS: readonly TranslationKey[] = [
  'aiMode.suggestion.compare',
  'aiMode.suggestion.recurring',
];

/** How many live categories are offered as starters beside the fixed two. */
const CATEGORY_SUGGESTIONS = 3;

/**
 * The starters this deployment can actually answer, newest catalogue first.
 *
 * A chip reading "What do you have in Cables & Wiring?" does two things a
 * hard-coded one cannot. It is true - the category exists here, today, with
 * products in it - and it tells somebody opening the panel what kind of shop
 * they are in before they have typed anything. On a marketplace whose range is
 * whatever its sellers list, that is not decoration: it is the only honest
 * answer to "what can I ask you about", and it rewrites itself the moment a
 * seller opens up a category nobody was trading in yesterday.
 *
 * Biggest first, and top level only. A department with four hundred lines
 * behind it is a better invitation than a leaf category with one, and the
 * question is meant to open a conversation rather than end it.
 */
function categoryStarters(tree: CategoryNode[] | undefined): string[] {
  if (tree === undefined) return [];

  return stockedCategories(tree)
    .slice()
    .sort((left, right) => right.totalProductCount - left.totalProductCount)
    .slice(0, CATEGORY_SUGGESTIONS)
    .map((node) => node.name);
}

interface ConversationDetail extends ConversationSummary {
  messages: { id: string; role: 'user' | 'assistant'; content: string; createdAt: string }[];
}

export function AiModePage(): React.JSX.Element {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { business, features, assistant } = useStorefront();
  const { user, logout, isCustomer, isLoading: isSessionLoading } = useSession();

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

  /**
   * Which greeting the hour has earned, and whether a name goes in it.
   *
   * Read once per mount rather than watched. A greeting that changed under
   * somebody at midday because a tab had been open since eleven would be a
   * jump on a page they are reading, and the page is replaced by a transcript
   * the moment they ask anything.
   *
   * Null only for a guest in the small hours, where the period is `plain` and
   * there is no name to put in "Hello, ...". That is the one combination with
   * nothing worth saying, and the line is dropped rather than filled.
   */
  const greetingKey = ((): TranslationKey | null => {
    const keys = GREETING_KEYS[greetingPeriod()];
    return identity.shortName === null ? keys.bare : keys.named;
  })();

  /*
   * The catalogue's own shape, for the starters and the line under the
   * greeting.
   *
   * Same query key and same endpoint as the catalogue page, so on a visit that
   * has already browsed - which is most of them - this is a cache read and
   * costs no request. A failure is not handled because there is nothing to
   * handle: the starters fall back to the fixed two and the greeting drops one
   * line, which is the page it used to be.
   */
  const categoryTree = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get<{ categories: CategoryNode[] }>('/catalog/categories'),
    staleTime: 5 * 60_000,
  });

  const starterCategories = categoryStarters(categoryTree.data?.categories);

  /**
   * How many products the whole shop has on sale, and the range it covers.
   *
   * Counted from the top level, where `totalProductCount` already includes
   * everything filed beneath - summing every node instead would count a
   * product once for its department and again for each of its ancestors.
   */
  const catalogueSize = (categoryTree.data?.categories ?? []).reduce(
    (total, node) => total + node.totalProductCount,
    0,
  );

  /**
   * Whether this visitor will be refused before they have typed anything.
   *
   * True when nobody is signed in and the deployment keeps the assistant for
   * account holders — `ASSISTANT_ALLOW_GUESTS`, which ships off.
   *
   * The whole point of knowing this up front is that the page can say so
   * instead of offering a composer whose only outcome is a 401. Somebody who
   * has typed out what they need and pressed Send has spent something; being
   * told *then* that they needed an account is the version of this interaction
   * that annoys people.
   *
   * It is deliberately not `assistant.available === false`: that is a
   * deployment with no AI provider at all, which the router already keeps this
   * page out of.
   *
   * False while the session is still settling. `isCustomer` is false during the
   * first `/auth/me` call for everybody, signed in or not, so without this a
   * customer who reloads the page watches a sign-in panel appear and then
   * vanish - and a panel that flashes reads as a bug even when the page ends up
   * correct.
   */
  const mustSignIn = !isSessionLoading && !isCustomer && !assistant.allowsGuests;

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

  /**
   * How many free questions a visitor with no account has left.
   *
   * `null` means "say nothing about an allowance", which is the answer for a
   * signed-in customer and for a deployment that has set no cap. It is not
   * "none left": a counter on a screen where the number is unlimited is a
   * limit the interface invented.
   *
   * Set from `/assistant/start` before the first question and from the `done`
   * frame after each one, always from the server. Never decremented here — a
   * browser counting down on its own disagrees with the server the first time
   * a send is retried, and the disagreement shows up as the wall arriving one
   * question early or one question late.
   */
  const [guestRemaining, setGuestRemaining] = useState<number | null>(null);

  /**
   * Whether the "you have used your free questions" prompt is up.
   *
   * Its own state rather than `guestRemaining === 0`, because the two are
   * genuinely different: the counter says how many are left and stays on
   * screen; the prompt is a modal somebody can dismiss and then carry on
   * reading what they already got. Tying the dialog to the number would make
   * it impossible to close.
   */
  const [isGuestLimitOpen, setIsGuestLimitOpen] = useState(false);
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

      const started = await api.post<{
        conversationId: string;
        conversationToken?: string;
        guestMessagesRemaining?: number | null;
      }>('/assistant/start', {});

      const token = started.conversationToken ?? null;

      setActiveId(started.conversationId);
      setGuestToken(token);
      // Before the first question rather than after the last. A wall somebody
      // hits with no warning reads as the thing having broken; a line saying
      // "5 free questions" from the start reads as an offer.
      setGuestRemaining(started.guestMessagesRemaining ?? null);

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
        /*
         * A 401 here is not a failure to reach the API. It is the deployment
         * saying the assistant is for account holders — `ASSISTANT_ALLOW_GUESTS`
         * is off, which is how it ships.
         *
         * So no Retry button: pressing it would fail identically, every time,
         * and a button that cannot work is worse than none. The question goes
         * back into the composer instead, so it is still there after signing
         * in.
         */
        if (caught instanceof ApiError && caught.status === 401) {
          setError(t('chat.signInToAsk'));
          setDraft(question);
          return;
        }

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
             * Two different things arrive here as the same status, and telling
             * somebody the wrong one is worse than saying nothing.
             *
             *   - They WERE signed in, and the session went while they were
             *     typing. The page is public, so this is not the end of the
             *     road: the conversation that belonged to the dead session is
             *     dropped and the next send opens a guest one, where guests are
             *     allowed.
             *   - They were NEVER signed in, and this deployment keeps the
             *     assistant for account holders (`ASSISTANT_ALLOW_GUESTS` off,
             *     which is the default). Nothing expired. Telling them their
             *     session did would send them looking for a problem that is not
             *     there.
             *
             * Either way the question goes back into the composer rather than
             * being lost — somebody who spent a minute describing what they
             * need should not type it twice because of a token.
             */
            setActiveId(null);
            setGuestToken(null);
            setMessages([]);
            setDraft(question);
            setError(isCustomer ? t('chat.sessionExpired') : t('chat.signInToAsk'));
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

          /*
           * The free questions are used up.
           *
           * Read out of the body rather than inferred from the 400, because a
           * 400 on this route is also "that conversation is too long" and the
           * two need opposite answers: one says start a new conversation, this
           * one says starting a new conversation will not help.
           *
           * The body is parsed defensively — this is the one path in `send`
           * that reads a failed response's payload, and a deployment answering
           * with something unexpected must fall through to the ordinary error
           * rather than throw inside the handler.
           *
           * Three things happen, in this order and for a reason:
           *
           *   - The counter goes to zero, so the line under the composer stops
           *     promising questions that no longer exist.
           *   - The question goes back into the composer. They spent time on
           *     it; it is still theirs after signing in.
           *   - The prompt comes up. The transcript stays on screen behind it
           *     — what they already got is theirs to read, and taking it away
           *     at the moment of asking for an account is the worst possible
           *     trade.
           */
          if (response.status === 400) {
            const code = await response
              .json()
              .then((body: unknown) => (body as { error?: { code?: unknown } }).error?.code)
              .catch(() => null);

            if (code === 'ASSISTANT_GUEST_LIMIT_REACHED') {
              setGuestRemaining(0);
              setDraft(question);
              setIsGuestLimitOpen(true);
              return;
            }
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
          onDone: ({ guestMessagesRemaining }) => {
            // The server's figure, every turn. Not `previous - 1`: see the
            // note on the state itself for why the browser never counts.
            setGuestRemaining(guestMessagesRemaining);

            /*
             * The prompt comes up when the LAST free question has been
             * answered, not when the next one is refused.
             *
             * The refusal path above still exists and still works — it is the
             * backstop for a browser whose counter is stale, and for the
             * second tab. But asking somebody to open an account at the moment
             * their answer finishes is the moment they have just got something
             * out of it, and asking after they have typed a question that is
             * then thrown away is the moment they have not.
             */
            if (guestMessagesRemaining === 0) setIsGuestLimitOpen(true);
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
    [activeId, ensureConversation, guestToken, isCustomer, isStreaming, queryClient, t],
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
    /*
     * Left where it is when this visitor cannot ask.
     *
     * `takePendingQuestion` clears as it reads, so taking it here would consume
     * the question on a page that is about to send them to sign in — and it
     * would be gone by the time they came back. Leaving it parked means the
     * question waits in `sessionStorage` through the sign-in page load and is
     * asked on the way back, which is what somebody who typed it expects.
     */
    if (mustSignIn) return;

    const pending = takePendingQuestion();
    if (pending === null) return;

    if (pending.intent === 'send') void sendRef.current(pending.text);
    else setDraft(pending.text);
  }, [mustSignIn]);

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
                 * The greeting, and it is three lines rather than a paragraph.
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
                 * The first line greets by the hour and by name — "Good
                 * morning, Priya" — because "Hello" is correct at every hour
                 * and warm at none of them, and a shop that notices what time
                 * of day it is reads as a shop staffed by somebody. What it
                 * must never do is guess wrong, so `greetingPeriod` hands back
                 * the plain greeting between ten at night and five in the
                 * morning rather than wishing a dispatch desk a good evening
                 * at three.
                 *
                 * The greeting is a separate line above the question rather
                 * than folded into it, so a missing name costs nothing - a
                 * guest is still greeted, correctly positioned, rather than
                 * seeing a re-flowed heading with a gap where a name was meant
                 * to be.
                 *
                 * The gradient runs the brand blue into its own hover step and
                 * ends before it reaches the question, which stays solid ink:
                 * a decorative fill on the words somebody actually has to read
                 * is a contrast cost for nothing.
                 */}
                {greetingKey !== null && (
                  <p className="bg-gradient-to-br from-brand to-brand-hover bg-clip-text text-2xl font-semibold tracking-tight text-transparent sm:text-4xl">
                    {identity.shortName === null
                      ? t(greetingKey)
                      : t(greetingKey, { name: identity.shortName })}
                  </p>
                )}

                <h1
                  className={cx(
                    'text-2xl font-semibold tracking-tight text-ink sm:text-4xl',
                    greetingKey !== null && 'mt-1.5',
                  )}
                >
                  {t('aiMode.greetingQuestion')}
                </h1>

                {/*
                 * One line, and only where the catalogue has answered.
                 *
                 * The paragraph that used to live here explained what the
                 * assistant was and where its answers came from, and was
                 * removed for good reasons that still hold - somebody who has
                 * opened a chat has already decided to type. This is not that
                 * paragraph coming back. It is a single line of this shop's
                 * own figures, and it earns its place by being the thing a
                 * generic greeting could not say: how much there is and what
                 * kind of shop this is. It costs nothing when the read has not
                 * landed, because then it is not drawn.
                 */}
                {catalogueSize > 0 && starterCategories.length > 0 && (
                  <p className="mt-3 text-sm text-ink-muted sm:text-base">
                    {t('aiMode.greetingRange', {
                      total: formatNumber(catalogueSize),
                      categories: starterCategories.join(', '),
                    })}
                  </p>
                )}

                {/* Not offered to somebody who cannot ask. A chip that opens a
                    conversation the deployment will refuse is the same mistake
                    as a composer that can only end in a 401 - and it is worse
                    here, because a chip looks like an invitation. */}
                {!mustSignIn && (
                  <ul className="mt-8 flex flex-wrap justify-center gap-2">
                    {[
                      ...starterCategories.map((category) => ({
                        key: `category:${category}`,
                        label: t('aiMode.suggestion.category', { category }),
                      })),
                      ...SUGGESTIONS.map((key) => ({ key, label: t(key) })),
                    ].map((chip) => (
                      <li key={chip.key}>
                        <button
                          type="button"
                          onClick={() => {
                            void send(chip.label);
                          }}
                          className="rounded-full border border-border bg-surface px-3.5 py-2 text-sm text-ink-muted shadow-card transition-[background-color,border-color,color,box-shadow] hover:border-brand hover:bg-brand-soft hover:text-brand hover:shadow-card-hover focus-visible:border-brand focus-visible:bg-brand-soft focus-visible:text-brand motion-reduce:transition-none"
                        >
                          {chip.label}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

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

        {mustSignIn ? (
          /*
           * The way in, where the composer would have been.
           *
           * Not a disabled composer: a text box that will not accept text is a
           * puzzle, and somebody will type into it anyway and wonder why
           * nothing happened. This says what is true - the assistant answers
           * account holders here - and gives them the one thing that changes
           * it.
           *
           * `state.from` is what `LoginPage` reads to come back, so signing in
           * returns them to this page rather than the home page. A question
           * carried from the landing page's search bar is still parked in
           * `sessionStorage`, untouched, and is asked on the way back.
           */
          <section
            aria-labelledby="ai-sign-in-heading"
            className="border-t border-border bg-surface px-4 py-6 sm:px-6"
          >
            <div className="mx-auto flex max-w-2xl flex-col items-center gap-3 text-center">
              {/* A real heading, and a named region around it. The rail already
                  has a Sign in link of its own, so "the Sign in link" is
                  ambiguous on this page unless this panel can be addressed as
                  one thing - by a screen reader and by a test alike. */}
              <h2 id="ai-sign-in-heading" className="text-base font-semibold text-ink">
                {t('aiMode.signInHeading')}
              </h2>
              <p className="max-w-lg text-sm leading-relaxed text-ink-muted">
                {t('aiMode.signInBody')}
              </p>
              <ButtonLink
                to="/login"
                state={{ from: AI_MODE_PATH }}
                variant="primary"
                className="mt-1"
              >
                {t('aiMode.signInAction')}
              </ButtonLink>
            </div>
          </section>
        ) : (
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
            isDisabled={isFull || guestRemaining === 0}
            /*
             * One note, and the order the three cases are tested in is the
             * order of how final they are.
             *
             * The turn limit is about this conversation and a new one fixes
             * it. The guest allowance is about the visitor and a new
             * conversation does not fix it — so where both are true, the one
             * that cannot be worked around is the one worth saying. The
             * countdown is last, because it is the only one of the three that
             * is not a refusal.
             */
            disabledNote={
              isFull
                ? t('aiMode.turnLimit')
                : guestRemaining === 0
                  ? t('aiMode.guestLimitNote')
                  : guestRemaining === null
                    ? undefined
                    : t('aiMode.guestRemaining', { count: guestRemaining })
            }
          />
        )}
      </section>

      {/*
       * The free questions are used up, and the way on is an account.
       *
       * Mounted only while open, which is the rule this app's `Modal` states
       * in its own header: a closed `<dialog>` carrying `display: flex` renders
       * in the page flow as a bordered card in the middle of whatever mounted
       * it, and every caller here avoids that by not mounting it.
       *
       * Two ways out and both are real. Sign in and Create an account both
       * carry `from` so the visitor lands back on this page afterwards with
       * the question they typed still in the composer. Dismissing it leaves
       * the transcript on screen — what they already got is theirs to read,
       * and taking it away at the moment of asking them to register is the
       * worst possible trade.
       */}
      {isGuestLimitOpen && (
        <Modal
          isOpen
          onClose={() => {
            setIsGuestLimitOpen(false);
          }}
          title={t('aiMode.guestLimitHeading')}
          description={t('aiMode.guestLimitBody')}
          footer={
            <>
              <ButtonLink to="/register" state={{ from: AI_MODE_PATH }} variant="primary">
                {t('aiMode.guestLimitRegister')}
              </ButtonLink>
              <ButtonLink to="/login" state={{ from: AI_MODE_PATH }}>
                {t('aiMode.guestLimitSignIn')}
              </ButtonLink>
            </>
          }
        >
          <ul className="space-y-2 text-sm leading-relaxed text-ink-muted">
            <li>{t('aiMode.guestLimitBenefitHistory')}</li>
            <li>{t('aiMode.guestLimitBenefitUnlimited')}</li>
            <li>{t('aiMode.guestLimitBenefitOrders')}</li>
          </ul>
        </Modal>
      )}

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

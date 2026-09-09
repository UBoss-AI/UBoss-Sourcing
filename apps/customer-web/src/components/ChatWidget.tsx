/**
 * The storefront chat widget.
 *
 * A launcher pinned bottom-right and a panel that opens above it. Mounted only
 * when `config.features.assistant` is true, and lazy-loaded, so a deployment
 * with no AI key pays nothing for it — not a button, not a byte of JavaScript.
 *
 * Things that are deliberate:
 *
 *   - **It is for signed-in customers.** A guest sees the launcher and a panel
 *     offering a way in, and nothing else: no composer, no conversation, no
 *     request that could reach the provider. This is a courtesy, not the
 *     control — every `/assistant` route is behind the customer session guard,
 *     and a browser talking to the API directly gets a 401 rather than an
 *     answer.
 *   - **It asks nobody who they are.** It used to open with a name, a mobile
 *     number and an email before it would answer anything. All three are gone.
 *     Whoever is here signed in, so the API reads what it needs from the
 *     account — and reads it under that session, never from anything this file
 *     sends.
 *   - **No API key here.** The panel posts to `/assistant/chat` on our own
 *     API, which holds the key and decides the model, the system prompt and
 *     every other parameter. Anything else would ship the key to every
 *     visitor in the page source.
 *   - **The server holds the transcript.** This component sends one message at
 *     a time with a conversation id; it does not post the history back. What
 *     staff read is then what the model was actually sent.
 *   - **A dead session keeps the draft.** An expired or revoked session
 *     answers 401, the message is not sent, and what was typed stays in the
 *     composer and in `sessionStorage` so signing in again does not cost
 *     somebody their question. The transcript is never persisted — only the
 *     one unsent line.
 *   - **The reply streams.** Server-Sent Events, read off `response.body`.
 *     A chat panel that sits blank for four seconds gets closed.
 *   - **Model output is never HTML.** It is rendered as text, with one
 *     exception: a `/product/...` path becomes a router link. That pattern
 *     cannot express anything but an internal route, so linkifying it is safe
 *     by construction — no sanitiser needed and no external URL possible.
 *   - **It is a panel, not a modal.** `aria-modal` is false and the page
 *     behind it stays usable: somebody comparing two cannulae wants to keep
 *     scrolling the catalogue while they ask about it.
 */
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useStorefront } from '@/app/storefront-context';
import { useSession } from '@/auth/session-context';
import { ButtonLink, Spinner } from './ui';
// The cross is the shared one. `ChatIcon` and `SendIcon` below are still
// local because nothing else in the app draws them; a close button is not in
// that position, and two crosses at two stroke weights is how an icon set
// starts drifting.
import { CloseIcon } from './icons';
import { cx } from '@/lib/cx';
import { ASSISTANT_OPEN_EVENT } from '@/lib/assistant-panel';
import { ApiError, api, requestStream } from '@/lib/api';
import { useI18n } from '@/i18n/i18n-context';
import type { Translate } from '@/i18n/i18n-context';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Mirrors ASSISTANT_MAX_TURNS on the API, which rejects anything longer. */
const MAX_TURNS = 20;
const MAX_MESSAGE_CHARS = 2_000;

/*
 * `sessionStorage`, not `localStorage`, for both of the things kept here: they
 * belong to this visit and are forgotten when the tab closes. A shared machine
 * in a hospital procurement office must not offer the next person the last
 * person's half-typed question.
 *
 * What is kept is deliberately small. The conversation id, so closing and
 * reopening the panel does not abandon the conversation — it is an opaque
 * identifier the API only honours for the account that owns it, so on its own
 * it grants nothing. And the unsent composer line, so an expired session does
 * not cost somebody the question they were part-way through typing.
 *
 * What is NOT kept: the transcript, anything about the customer, and any kind
 * of token. The transcript lives on the server, where the retention sweep can
 * reach it and an erasure request can delete it.
 */
const CONVERSATION_KEY = 'uboss_chat_conversation';
const DRAFT_KEY = 'uboss_chat_draft';
/** Set on the way to the sign-in page, so the panel reopens on the way back. */
const REOPEN_KEY = 'uboss_chat_reopen';

/**
 * The conversation this browser has going, and whose it is.
 *
 * The owner is recorded so that signing out and signing in as somebody else on
 * the same machine does not hand the second person a conversation belonging to
 * the first. The API would refuse it anyway — ownership is checked there — but
 * the panel should not have to learn that from a 404.
 */
interface StoredConversation {
  conversationId: string;
  userId: string;
}

function readStored<T>(key: string, isValid: (value: unknown) => value is T): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (raw === null) return null;

    const parsed: unknown = JSON.parse(raw);
    return isValid(parsed) ? parsed : null;
  } catch {
    // Private browsing, blocked site data, or a value somebody hand-edited.
    // None of them is a reason to break the widget.
    return null;
  }
}

function writeStored(key: string, value: unknown): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage refused. Everything still works for as long as this tab is open,
    // which is the whole conversation in practice.
  }
}

function isStoredConversation(value: unknown): value is StoredConversation {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as StoredConversation).conversationId === 'string' &&
    typeof (value as StoredConversation).userId === 'string'
  );
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

// ---------------------------------------------------------------------------
// Icons
//
// Local rather than in components/icons.tsx: they exist for this widget and
// nothing else, and the file is lazy-loaded — putting them in the shared icon
// module would pull them into the main bundle for every visitor.
// ---------------------------------------------------------------------------

function ChatIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}

function SendIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" />
    </svg>
  );
}

function LockIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="10.5" width="16" height="10" rx="2" />
      <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Rendering model output
// ---------------------------------------------------------------------------

/**
 * Product paths only. Nothing else in the reply becomes a link.
 *
 * The pattern is deliberately narrow — a lowercase slug under `/product/` —
 * because that is the one shape that cannot be turned into an off-site link,
 * a `javascript:` URL or anything else worth worrying about. A general URL
 * matcher here would be an injection surface fed by model output.
 */
const PRODUCT_PATH = /\/product\/[a-z0-9][a-z0-9-]*/g;

function renderLine(line: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let cursor = 0;

  for (const match of line.matchAll(PRODUCT_PATH)) {
    const start = match.index;
    if (start > cursor) nodes.push(line.slice(cursor, start));

    nodes.push(
      <Link
        key={`${keyPrefix}-${String(start)}`}
        to={match[0]}
        className="font-medium text-brand underline decoration-brand/40 underline-offset-2 hover:decoration-brand"
      >
        {match[0]}
      </Link>,
    );

    cursor = start + match[0].length;
  }

  if (cursor < line.length) nodes.push(line.slice(cursor));
  return nodes;
}

/** Plain text, newlines preserved, product paths linked. Never HTML. */
function MessageBody({ text }: { text: string }): React.JSX.Element {
  return (
    <>
      {text.split('\n').map((line, index) => (
        <p key={index} className={cx(index > 0 && 'mt-1.5', line.length === 0 && 'h-1.5')}>
          {renderLine(line, String(index))}
        </p>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/**
 * Read the SSE body and hand each text delta to `onDelta`.
 *
 * Written against `response.body` rather than `EventSource`, because
 * `EventSource` can only issue GET requests and cannot send the message —
 * and because this way the same abort signal cancels the generation
 * server-side when the visitor closes the panel.
 */
async function readEventStream(
  t: Translate,
  body: ReadableStream<Uint8Array>,
  handlers: {
    onDelta: (text: string) => void;
    onError: (message: string) => void;
  },
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line. Anything after the last one is
    // a partial frame and stays in the buffer until the rest of it arrives.
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      let event = 'message';
      let data = '';

      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) data += line.slice(6);
      }

      if (data.length === 0) continue;

      // A malformed frame is not worth taking the panel down for.
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }

      if (event === 'delta' && typeof (parsed as { text?: unknown }).text === 'string') {
        handlers.onDelta((parsed as { text: string }).text);
      } else if (event === 'error') {
        const message = (parsed as { message?: unknown }).message;
        handlers.onError(
          typeof message === 'string' ? message : t('chat.assistantCouldNotAnswer'),
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The AI disclosure
//
// AI Act Art. 50(1): a person has to be told they are dealing with a machine,
// and told before they deal with it rather than in a footnote afterwards. It
// is shown to a guest as well as to a customer — somebody deciding whether to
// sign in for this is exactly who the obligation is about.
// ---------------------------------------------------------------------------

function AiNotice(): React.JSX.Element {
  const { t } = useI18n();
  const { assistant } = useStorefront();

  return (
    <div className="rounded-md border border-border bg-surface-sunken px-3 py-2.5">
      <p className="text-xs font-medium text-ink">{t('chat.aiNotice')}</p>
      {assistant.vendor !== null && (
        <p className="mt-1 text-xxs leading-relaxed text-ink-muted">
          {t('chat.aiVendorNotice', { vendor: assistant.vendor.name })}
        </p>
      )}
      <p className="mt-1 text-xxs leading-relaxed text-ink-muted">{t('chat.aiCanBeWrong')}</p>
    </div>
  );
}

/**
 * The way in, for somebody who is not signed in.
 *
 * `from` carries the page they were on, so signing in returns them to it
 * rather than to the home page — and `REOPEN_KEY` carries the fact that they
 * were mid-way through opening the assistant, so it opens itself again when
 * they land. Between the two, "sign in to use AI" leads back to a composer
 * with a cursor in it rather than to a catalogue page and a second hunt for
 * the button.
 */
function SignInPrompt({
  reason,
}: {
  reason: 'guest' | 'expired';
}): React.JSX.Element {
  const { t } = useI18n();
  const location = useLocation();

  return (
    <div className="space-y-3.5 px-4 py-4">
      <AiNotice />

      {reason === 'expired' ? (
        <p
          role="alert"
          className="rounded-md border border-border bg-surface-sunken px-3 py-2 text-xs leading-relaxed text-ink"
        >
          {t('chat.sessionExpired')}
        </p>
      ) : (
        <p className="text-sm leading-relaxed text-ink-muted">{t('chat.signInToChat')}</p>
      )}

      {/* A link, not a button: this navigates, so middle-click and "open in a
          new tab" keep working and a screen reader announces it as a link. */}
      <ButtonLink
        to="/login"
        state={{ from: location.pathname + location.search }}
        onClick={() => {
          writeStored(REOPEN_KEY, true);
        }}
        variant="primary"
        fullWidth
      >
        <LockIcon className="mr-2 h-4 w-4" />
        {reason === 'expired' ? t('chat.signInAgain') : t('chat.signInToUseAi')}
      </ButtonLink>

      <p className="text-xxs leading-relaxed text-ink-subtle">{t('chat.retentionNotice')}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

function ChatPanel({
  onClose,
  returnFocusTo,
  isSignedIn,
  sessionEnded,
  onSessionEnded,
  conversationId,
  onConversationId,
  messages,
  setMessages,
  draft,
  setDraft,
}: {
  onClose: () => void;
  returnFocusTo: React.RefObject<HTMLButtonElement | null>;
  isSignedIn: boolean;
  sessionEnded: boolean;
  onSessionEnded: () => void;
  conversationId: string | null;
  onConversationId: (id: string | null) => void;
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  draft: string;
  setDraft: (value: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();

  const { business } = useStorefront();

  const [isStreaming, setIsStreaming] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /*
   * Index of a reply the stream cut off part-way.
   *
   * Held separately rather than on the message itself because `messages` is
   * also the transcript this panel renders and nothing else may travel with
   * it. It is why this cannot be a flag on ChatMessage.
   */
  const [truncatedAt, setTruncatedAt] = useState<number | null>(null);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const isFull = messages.filter((message) => message.role === 'user').length >= MAX_TURNS;

  /*
   * Open a conversation the moment the panel does, if there is not one
   * already.
   *
   * This is the whole of what used to be a three-field form. Nothing is asked
   * and nothing is typed: the API knows who is calling, so the panel goes
   * straight from the launcher to a composer with the cursor in it.
   */
  /*
   * A ref, and not the `isStarting` state, because a state flag is not read
   * back soon enough: StrictMode mounts this effect twice in development and
   * the second run would still see `false`, opening two conversations for one
   * opened panel every time, in the environment where it is hardest to notice.
   * The state exists only to disable the send button.
   */
  const startingRef = useRef(false);

  /*
   * The request is deliberately NOT cancelled on unmount. Closing the panel
   * mid-start should keep the conversation that is already being created —
   * `onConversationId` writes to the launcher, which outlives this component,
   * so reopening lands in the same conversation instead of leaving an orphan
   * row behind and opening a second one. The two panel-local setters after it
   * are no-ops once unmounted.
   *
   * An in-flight start that was abandoned instead would also strand the ref
   * above: the next effect run would bail on it and the run that set it would
   * clear it a moment later, with nothing left to try again.
   */
  useEffect(() => {
    // `sessionEnded` matters as much as `isSignedIn` here. A 401 clears the
    // conversation, and without this guard that immediately looks like "no
    // conversation yet" and fires another `/start` into the same dead session
    // — which would also overwrite the cleared id in storage.
    if (sessionEnded || !isSignedIn || conversationId !== null || startingRef.current) return;

    startingRef.current = true;
    setIsStarting(true);

    void (async () => {
      try {
        // An explicit empty object, not an absent body. `api.post` only sets a
        // content-type when there is one to describe, and a bodiless POST is
        // one more thing for a proxy in front of the API to have an opinion
        // about. `{}` is also exactly what the endpoint's strict schema takes.
        const started = await api.post<{ conversationId: string }>('/assistant/start', {});
        setError(null);
        onConversationId(started.conversationId);
      } catch (caught) {
        // 401 here means the cookie went stale between the page load and the
        // panel opening. Nothing has been typed yet, so there is no draft to
        // rescue — only a sign-in to offer.
        if (caught instanceof ApiError && caught.isAuthError) {
          onSessionEnded();
          return;
        }

        setError(
          caught instanceof ApiError && caught.isRateLimited
            ? t('chat.tooManyAttempts')
            : t('chat.couldNotStartTheChat'),
        );
      } finally {
        startingRef.current = false;
        setIsStarting(false);
      }
    })();
  }, [conversationId, isSignedIn, onConversationId, onSessionEnded, sessionEnded, t]);

  // Focus the composer on open, and hand focus back to the launcher on close —
  // otherwise a keyboard user is dropped at the top of the document.
  useEffect(() => {
    inputRef.current?.focus();

    // Captured here, not read in the cleanup: the launcher is rendered by the
    // parent and outlives this panel, so the node at mount is the node to
    // hand focus back to.
    const launcher = returnFocusTo.current;

    return () => {
      launcher?.focus();
    };
  }, [returnFocusTo]);

  // Escape closes, from anywhere inside the panel.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  // Closing mid-answer aborts the request, which stops the generation the
  // deployment is paying for rather than letting it run into a dead socket.
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  // Keep the newest message in view as it streams in.
  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript !== null) transcript.scrollTop = transcript.scrollHeight;
  }, [messages]);

  const send = useCallback(
    async (text: string): Promise<void> => {
      const question = text.trim();
      if (question.length === 0 || isStreaming || conversationId === null) return;

      setError(null);

      // The assistant row is appended empty and filled by the deltas, so the
      // transcript grows in place instead of appearing all at once.
      setMessages((current) => [
        ...current,
        { role: 'user', content: question },
        { role: 'assistant', content: '' },
      ]);
      setTruncatedAt(null);
      setIsStreaming(true);

      const abort = new AbortController();
      abortRef.current = abort;

      try {
        const response = await requestStream('/assistant/chat', {
          body: { conversationId, message: question },
          signal: abort.signal,
        });

        if (!response.ok || response.body === null) {
          // Drop the pair we optimistically added: an empty bubble reads as a
          // reply that said nothing, which is worse than no bubble at all.
          setMessages((current) => current.slice(0, -2));

          /*
           * 401 after a refresh that did not take. The message was never sent,
           * so it goes back into the composer rather than being lost: somebody
           * who spent a minute describing what they need should not have to
           * type it twice because a token expired while they did.
           */
          if (response.status === 401) {
            setDraft(question);
            onSessionEnded();
            return;
          }

          // 404 means the conversation this browser remembers is not one the
          // API will answer for — swept, or belonging to somebody else. Drop
          // it and the panel opens a fresh one on the next render.
          if (response.status === 404) {
            onConversationId(null);
            setDraft(question);
            setError(t('chat.chatEndedRestart'));
            return;
          }

          setError(
            response.status === 429
              ? t('chat.thatIsALotOfQuestions')
              : t('chat.assistantUnavailable'),
          );
          setDraft(question);
          return;
        }

        // Sent. Only now is the composer cleared, so nothing above this line
        // can lose what was typed.
        setDraft('');

        await readEventStream(t, response.body, {
          onDelta: (delta) => {
            setMessages((current) => {
              const next = [...current];
              const last = next[next.length - 1];
              if (last?.role === 'assistant') {
                next[next.length - 1] = {
                  role: 'assistant',
                  content: last.content + delta,
                };
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
             * Mark it so the bubble itself says it is incomplete.
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

        // A stream that carried an error and no text leaves the same empty
        // bubble, so clear it here too.
        setMessages((current) => {
          const last = current[current.length - 1];
          if (last?.role === 'assistant' && last.content.length === 0) return current.slice(0, -1);
          return current;
        });
      } catch {
        if (!abort.signal.aborted) {
          setError(t('chat.theConnectionDropped'));
          setMessages((current) => current.slice(0, -2));
          setDraft(question);
        }
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [conversationId, isStreaming, onConversationId, onSessionEnded, setDraft, setMessages, t],
  );

  const transcript: ChatMessage[] =
    messages.length === 0 ? [{ role: 'assistant', content: t('chat.greeting') }] : messages;

  return (
    <div
      role="dialog"
      // Not modal: the catalogue behind stays scrollable and usable, which is
      // the point of a panel rather than a dialog.
      aria-modal="false"
      aria-label={t('chat.askStore', { store: business.displayName })}
      className="fixed inset-x-3 bottom-3 z-40 flex max-h-[min(32rem,calc(100dvh-1.5rem))] flex-col
                 overflow-hidden rounded-xl border border-border bg-surface shadow-overlay
                 animate-dialog-in sm:inset-x-auto sm:right-5 sm:bottom-24 sm:w-[23rem]
                 sm:max-h-[min(32rem,calc(100dvh-7.5rem))]"
    >
      {/* Header */}
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border-subtle bg-surface-sunken px-4 py-3">
        <div className="min-w-0">
          <p className="text-title-xs text-ink">{t('chat.askAboutOurProducts')}</p>
          <p className="mt-0.5 text-xxs leading-relaxed text-ink-muted">
            {/* Repeated here on purpose. Somebody who opened this panel
                yesterday and comes back to it today never saw the sign-in
                screen, and the disclosure has to hold for them too. */}
            {t('chat.aiNotice')} {t('chat.answersComeFromThisCatalogue')}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('chat.closeTheChat')}
          className="-mr-1 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md
                     text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>

      {/*
        `sessionEnded` is checked as well as `isSignedIn`, and it is not
        redundant. A 401 is the panel's own first-hand evidence that the
        session is over; the session provider learns the same thing a moment
        later and flips `isSignedIn`. Waiting for it would leave a live
        composer in front of somebody whose next message cannot be sent.
      */}
      {!isSignedIn || sessionEnded ? (
        <div className="flex-1 overflow-y-auto">
          <SignInPrompt reason={sessionEnded ? 'expired' : 'guest'} />
        </div>
      ) : (
        <>
          {/* Transcript */}
          <div ref={transcriptRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3.5">
            {/* The streaming reply is appended as an empty assistant message
                the moment the request goes out, so the deltas have somewhere
                to land. Until the first token arrives it must not be drawn: an
                empty bubble sitting beside "Thinking…" reads as a reply that
                said nothing. */}
            {transcript.map((message, index) =>
              message.role === 'assistant' && message.content.length === 0 ? null : (
                <div
                  key={index}
                  className={cx('flex', message.role === 'user' ? 'justify-end' : 'justify-start')}
                >
                  <div
                    className={cx(
                      'max-w-[85%] rounded-lg px-3 py-2 text-sm leading-relaxed',
                      message.role === 'user'
                        ? 'bg-brand text-white'
                        : 'bg-surface-sunken text-ink ring-1 ring-inset ring-border',
                    )}
                  >
                    <MessageBody text={message.content} />
                    {truncatedAt === index && (
                      <p className="mt-2 border-t border-border pt-2 text-xs text-ink-muted">
                        {t('chat.thisAnswerWasCutOff')}
                      </p>
                    )}
                  </div>
                </div>
              ),
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
              <p
                role="alert"
                className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger"
              >
                {error}
              </p>
            )}
          </div>

          {/* Composer */}
          <form
            className="shrink-0 border-t border-border-subtle bg-surface px-3 py-3"
            onSubmit={(event) => {
              event.preventDefault();
              void send(draft);
            }}
          >
            {isFull ? (
              <p className="px-1 py-1 text-xs leading-relaxed text-ink-muted">
                {business.supportEmail === null ? (
                  t('chat.lengthLimitReached', { email: t('chat.ourSupportTeam') })
                ) : (
                  <>
                    {/*
                      Called with no values, so the `{{email}}` placeholder
                      survives for the split to find and the address can keep
                      its mailto link.
                    */}
                    {t('chat.lengthLimitReached').split('{{email}}')[0]}
                    <a
                      href={`mailto:${business.supportEmail}`}
                      className="font-medium text-brand underline underline-offset-2"
                    >
                      {business.supportEmail}
                    </a>
                    {t('chat.lengthLimitReached').split('{{email}}')[1]}
                  </>
                )}
              </p>
            ) : (
              <div className="flex items-end gap-2">
                <label htmlFor="assistant-input" className="sr-only">
                  {t('chat.yourQuestion')}
                </label>
                <textarea
                  id="assistant-input"
                  ref={inputRef}
                  rows={1}
                  value={draft}
                  maxLength={MAX_MESSAGE_CHARS}
                  placeholder={t('chat.eGDoYouHave')}
                  disabled={isStreaming}
                  onChange={(event) => {
                    setDraft(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    // Enter sends; Shift+Enter is a newline. The other way
                    // round is the standard complaint about chat inputs.
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      void send(draft);
                    }
                  }}
                  className="max-h-28 min-h-10 flex-1 resize-none rounded-md border border-border-strong
                             bg-surface px-3 py-2 text-sm text-ink shadow-card transition-colors
                             placeholder:text-ink-subtle hover:border-border-hover
                             disabled:cursor-not-allowed disabled:bg-surface-sunken"
                />
                <button
                  type="submit"
                  disabled={
                    isStreaming || isStarting || conversationId === null || draft.trim().length === 0
                  }
                  aria-label={t('chat.send')}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-brand
                             text-white shadow-card transition-colors hover:bg-brand-hover
                             focus-visible:ring-brand disabled:cursor-not-allowed disabled:bg-ink-subtle
                             disabled:shadow-none"
                >
                  {isStarting ? <Spinner className="h-4 w-4" /> : <SendIcon className="h-4 w-4" />}
                </button>
              </div>
            )}
          </form>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Launcher
// ---------------------------------------------------------------------------

export function ChatWidget(): React.JSX.Element | null {
  const { t } = useI18n();
  const { features } = useStorefront();
  const { isCustomer, isLoading, user } = useSession();

  const [isOpen, setIsOpen] = useState(false);
  const launcherRef = useRef<HTMLButtonElement>(null);

  /*
   * The conversation, the transcript and the unsent line live here rather than
   * in the panel, so closing the panel and opening it again does not throw the
   * conversation away. The id and the draft are seeded from sessionStorage, so
   * a reload mid-visit does not either.
   */
  const [stored, setStored] = useState<StoredConversation | null>(() =>
    readStored(CONVERSATION_KEY, isStoredConversation),
  );
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraftState] = useState<string>(
    () => readStored(DRAFT_KEY, isString) ?? '',
  );
  /** True once a request came back 401. Only changes the wording, not the gate. */
  const [sessionEnded, setSessionEnded] = useState(false);

  const userId = user?.id ?? null;

  const close = useCallback(() => {
    setIsOpen(false);
  }, []);

  const setDraft = useCallback((value: string) => {
    setDraftState(value);
    writeStored(DRAFT_KEY, value.length === 0 ? null : value);
  }, []);

  const setConversationId = useCallback(
    (id: string | null) => {
      if (id === null || userId === null) {
        setStored(null);
        writeStored(CONVERSATION_KEY, null);
        return;
      }

      const next: StoredConversation = { conversationId: id, userId };
      setStored(next);
      writeStored(CONVERSATION_KEY, next);
    },
    [userId],
  );

  const handleSessionEnded = useCallback(() => {
    setSessionEnded(true);
    // The conversation is not this browser's to resume any more. The draft is
    // deliberately left alone: it is the one thing worth carrying across a
    // sign-in, and it is the reason this is not simply a page reload.
    setStored(null);
    writeStored(CONVERSATION_KEY, null);
    setMessages([]);
  }, []);

  /*
   * Whose conversation is in storage, and is it still theirs?
   *
   * Signing out and signing in as somebody else on a shared machine must not
   * hand the second person the first person's conversation. The API refuses it
   * regardless — every conversation is checked against the caller's account —
   * but the panel should not have to find that out from a 404.
   */
  useEffect(() => {
    if (isLoading) return;

    // Read outside the updater rather than inside it: `writeStored` touches
    // sessionStorage, and StrictMode calls a state updater twice.
    const keep = stored !== null && userId !== null && stored.userId === userId;

    if (stored !== null && !keep) {
      setStored(null);
      writeStored(CONVERSATION_KEY, null);
    }

    // Nobody signed in has a transcript to show — neither their own, nor the
    // one the last person left on a shared machine.
    if (!isCustomer) setMessages((current) => (current.length === 0 ? current : []));
  }, [isCustomer, isLoading, stored, userId]);

  /*
   * Clearing the "your session ended" state, which is fiddlier than it looks.
   *
   * It must NOT be cleared just because `isCustomer` is true: that is true
   * again on the very render where the 401 arrives, and clearing it there puts
   * a live composer back in front of somebody whose next message cannot be
   * sent. Only a transition clears it — signed out, then signed in.
   */
  const wasSignedIn = useRef(isCustomer);

  useEffect(() => {
    if (isLoading) return;

    if (isCustomer && !wasSignedIn.current) setSessionEnded(false);
    wasSignedIn.current = isCustomer;
  }, [isCustomer, isLoading]);

  /*
   * Reopen after a sign-in that started here.
   *
   * "Sign in to use AI" has to land back on a composer, not on a catalogue
   * page with the button to press again. The flag is written on the way out
   * and consumed exactly once on the way back.
   *
   * Coming back also clears the dead-session state, whatever the session
   * provider believes. Without that, a 401 the provider never noticed leaves
   * the panel on a "sign in again" screen whose link the sign-in page bounces
   * straight back — a loop with no way out of it. Clearing it here costs at
   * worst one more `/start`, which answers 401 again if the session really is
   * gone.
   */
  useEffect(() => {
    if (isLoading || !isCustomer) return;
    if (readStored(REOPEN_KEY, (value): value is boolean => value === true) === null) return;

    writeStored(REOPEN_KEY, null);
    setSessionEnded(false);
    setIsOpen(true);
  }, [isCustomer, isLoading]);

  /*
   * Opened from somewhere else on the page.
   *
   * The greeting page's "AI Assistant" node is the only caller today. It
   * cannot reach this component — the widget is mounted by the shell, not by
   * the route — so it asks by name instead; see `lib/assistant-panel.ts`.
   *
   * It opens the panel and nothing more. Whether there is a composer behind
   * it is still decided by `isCustomer` inside `ChatPanel`, exactly as it is
   * when the launcher is pressed, so an event cannot talk its way past the
   * sign-in gate. The node that dispatches it will not even offer the action
   * to a guest, and the API answers a signed-out browser with a 401 either
   * way.
   */
  useEffect(() => {
    const open = (): void => {
      setIsOpen(true);
    };

    window.addEventListener(ASSISTANT_OPEN_EVENT, open);

    return () => {
      window.removeEventListener(ASSISTANT_OPEN_EVENT, open);
    };
  }, []);

  // The single gate on the widget existing at all. No key configured on this
  // deployment, no widget — not a disabled button, not a tooltip.
  if (!features.assistant) return null;

  return (
    <>
      {isOpen && (
        <Suspense fallback={null}>
          <ChatPanel
            onClose={close}
            returnFocusTo={launcherRef}
            isSignedIn={isCustomer}
            sessionEnded={sessionEnded}
            onSessionEnded={handleSessionEnded}
            conversationId={stored?.conversationId ?? null}
            onConversationId={setConversationId}
            messages={messages}
            setMessages={setMessages}
            draft={draft}
            setDraft={setDraft}
          />
        </Suspense>
      )}

      {/*
       * 56px, above the safe-area inset so it clears the home indicator on
       * iOS. Hidden while the panel is open on a phone, where the panel takes
       * the full width and the launcher would sit on top of the composer.
       *
       * Shown to a guest too, and labelled for them. Hiding it outright would
       * mean nobody ever discovers the assistant exists; what a guest gets on
       * pressing it is a way in, never a composer.
       */}
      <button
        ref={launcherRef}
        type="button"
        onClick={() => {
          setIsOpen((open) => !open);
        }}
        aria-expanded={isOpen}
        aria-label={
          isOpen
            ? t('chat.closeTheChat')
            : isCustomer
              ? t('chat.askAboutOurProducts')
              : t('chat.signInToUseAi')
        }
        className={cx(
          'fixed bottom-5 right-5 z-40 flex h-14 w-14 items-center justify-center rounded-full',
          'bg-brand text-white shadow-lift transition-[background-color,transform]',
          'hover:bg-brand-hover active:translate-y-px',
          isOpen && 'hidden sm:flex',
        )}
        style={{ marginBottom: 'env(safe-area-inset-bottom, 0px)' }}
      >
        {isOpen ? <CloseIcon className="h-6 w-6" /> : <ChatIcon className="h-6 w-6" />}
      </button>
    </>
  );
}

export default ChatWidget;

/**
 * The storefront chat widget.
 *
 * A launcher pinned bottom-right and a panel that opens above it. Mounted only
 * when `config.features.assistant` is true, and lazy-loaded, so a deployment
 * with no AI key pays nothing for it — not a button, not a byte of JavaScript.
 *
 * Things that are deliberate:
 *
 *   - **It asks who you are first.** Name, mobile number and email, before the
 *     first question. A visitor asking which safety cannula comes in a 22G is
 *     a sales lead, and a lead that exists only in their browser tab is a lead
 *     nobody follows up. The details go to the API, which keeps the enquiry
 *     and the whole transcript for staff. Nothing is verified here — this is a
 *     contact form, not a sign-in.
 *   - **No API key here.** The panel posts to `/assistant/chat` on our own
 *     API, which holds the key and decides the model, the system prompt and
 *     every other parameter. Anything else would ship the key to every
 *     visitor in the page source.
 *   - **The server holds the transcript.** This component sends one message at
 *     a time with a conversation id and an opaque token; it no longer posts the
 *     history back. What staff read is then what the model was actually sent.
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
import { Link } from 'react-router-dom';
import { useStorefront } from '@/app/storefront-context';
import { Button, Field, Input, Spinner } from './ui';
import { cx } from '@/lib/cx';
import { ApiError, BASE_URL, api } from '@/lib/api';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * The conversation this browser has going.
 *
 * The token is the only thing standing between one visitor's conversation and
 * another's on an endpoint with no session, so it is held in memory and in
 * `sessionStorage` — never in a cookie and never in the URL.
 */
interface ChatSession {
  conversationId: string;
  token: string;
  /** Kept so the panel can greet by name after a reload. */
  name: string;
}

/** Mirrors ASSISTANT_MAX_TURNS on the API, which rejects anything longer. */
const MAX_TURNS = 20;
const MAX_MESSAGE_CHARS = 2_000;

/*
 * `sessionStorage`, not `localStorage`: the details are remembered for this
 * visit so the panel does not interrogate somebody twice on their way through
 * the catalogue, and forgotten when the tab closes. A shared machine in a
 * hospital procurement office should not offer the next person the last
 * person's chat.
 */
const SESSION_KEY = 'uboss_chat_session';

function readStoredSession(): ChatSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (raw === null) return null;

    const parsed = JSON.parse(raw) as Partial<ChatSession>;
    if (
      typeof parsed.conversationId !== 'string' ||
      typeof parsed.token !== 'string' ||
      typeof parsed.name !== 'string'
    ) {
      return null;
    }

    return { conversationId: parsed.conversationId, token: parsed.token, name: parsed.name };
  } catch {
    // Private browsing, blocked site data, or a value somebody hand-edited.
    // None of them is a reason to break the widget; the visitor is asked again.
    return null;
  }
}

function storeSession(session: ChatSession | null): void {
  try {
    if (session === null) sessionStorage.removeItem(SESSION_KEY);
    else sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // Storage refused. The session still works for as long as this panel is
    // mounted, which is the whole conversation in practice.
  }
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

function CloseIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M18 6 6 18M6 6l12 12" />
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
  body: ReadableStream<Uint8Array>,
  handlers: { onDelta: (text: string) => void; onError: (message: string) => void },
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
          typeof message === 'string' ? message : 'The assistant could not answer that.',
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Who is asking
// ---------------------------------------------------------------------------

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Validated here as well as on the API, so a typo is caught before a round
 * trip. The API's rules are the ones that count; these mirror them.
 */
function validateVisitor(values: { name: string; phone: string; email: string }): Record<
  string,
  string
> {
  const errors: Record<string, string> = {};

  if (values.name.trim().length < 2) errors.name = 'Please enter your name.';

  // Digits only for the length check: people write +91 98765 43210,
  // (022) 4567-8900 and 09876543210, and all three are the same number.
  const digits = values.phone.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) {
    errors.phone = 'Enter a mobile number with 7 to 15 digits.';
  }

  if (!EMAIL_PATTERN.test(values.email.trim())) errors.email = 'Enter a valid email address.';

  return errors;
}

function VisitorForm({
  onStarted,
}: {
  onStarted: (session: ChatSession) => void;
}): React.JSX.Element {
  const { business } = useStorefront();

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const submit = async (): Promise<void> => {
    const values = { name: name.trim(), phone: phone.trim(), email: email.trim() };
    const found = validateVisitor(values);

    setErrors(found);
    setFailure(null);
    if (Object.keys(found).length > 0) return;

    setIsSubmitting(true);

    try {
      const started = await api.post<{ conversationId: string; token: string }>(
        '/assistant/start',
        values,
      );

      onStarted({ ...started, name: values.name });
    } catch (error) {
      if (error instanceof ApiError) {
        // Field-level details land on the fields; anything else is a message
        // above the form. A 429 here means somebody is filling the enquiry
        // table, and the honest answer is to wait.
        const fieldErrors = error.fieldErrors();

        if (Object.keys(fieldErrors).length > 0) setErrors(fieldErrors);
        else {
          setFailure(
            error.isRateLimited
              ? 'Too many attempts just now. Please wait a moment and try again.'
              : 'We could not start the chat. Please try again shortly.',
          );
        }
      } else {
        setFailure('Could not reach the store. Check your connection and try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form
      className="space-y-3.5 px-4 py-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      noValidate
    >
      <p className="text-sm leading-relaxed text-ink-muted">
        Tell us who you are and we will answer your questions about the catalogue. Our team can
        then follow up if you need a quotation.
      </p>

      <Field label="Your name" error={errors.name} required>
        {({ inputId, describedBy }) => (
          <Input
            id={inputId}
            ref={nameRef}
            value={name}
            autoComplete="name"
            maxLength={120}
            invalid={errors.name !== undefined}
            aria-describedby={describedBy}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        )}
      </Field>

      <Field label="Mobile number" error={errors.phone} required>
        {({ inputId, describedBy }) => (
          <Input
            id={inputId}
            type="tel"
            inputMode="tel"
            value={phone}
            autoComplete="tel"
            maxLength={32}
            placeholder="+91 98765 43210"
            invalid={errors.phone !== undefined}
            aria-describedby={describedBy}
            onChange={(event) => {
              setPhone(event.target.value);
            }}
          />
        )}
      </Field>

      <Field label="Email address" error={errors.email} required>
        {({ inputId, describedBy }) => (
          <Input
            id={inputId}
            type="email"
            inputMode="email"
            value={email}
            autoComplete="email"
            maxLength={320}
            placeholder="you@hospital.org"
            invalid={errors.email !== undefined}
            aria-describedby={describedBy}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
        )}
      </Field>

      {failure !== null && (
        <p
          role="alert"
          className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger"
        >
          {failure}
        </p>
      )}

      <Button type="submit" variant="primary" fullWidth isLoading={isSubmitting}>
        Start chatting
      </Button>

      <p className="text-xxs leading-relaxed text-ink-subtle">
        {business.displayName} keeps your details and this conversation so the team can respond.
      </p>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

function greetingFor(name: string): string {
  const firstName = name.trim().split(/\s+/)[0] ?? '';
  const hello = firstName.length > 0 ? `Hello ${firstName}.` : 'Hello.';

  return `${hello} Ask me about a product, what is in a pack, or which page to look at. I will keep answers short.`;
}

function ChatPanel({
  onClose,
  returnFocusTo,
  session,
  onSession,
  messages,
  setMessages,
}: {
  onClose: () => void;
  returnFocusTo: React.RefObject<HTMLButtonElement | null>;
  session: ChatSession | null;
  onSession: (session: ChatSession | null) => void;
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
}): React.JSX.Element {
  const { business } = useStorefront();

  const [draft, setDraft] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
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

  // Focus the input on open, and hand focus back to the launcher on close —
  // otherwise a keyboard user is dropped at the top of the document. The
  // details form focuses its own first field instead.
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
      if (question.length === 0 || isStreaming || session === null) return;

      setError(null);
      setDraft('');

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
        const response = await fetch(`${BASE_URL}/assistant/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            conversationId: session.conversationId,
            token: session.token,
            message: question,
          }),
          signal: abort.signal,
        });

        if (!response.ok || response.body === null) {
          // 404 means the conversation this browser remembers is not one the
          // API has. Clearing it sends the visitor back to the details form,
          // which is the only recovery that leads anywhere.
          if (response.status === 404) {
            onSession(null);
            setMessages([]);
            setError('This chat has ended. Please enter your details to start a new one.');
            return;
          }

          setError(
            response.status === 429
              ? 'That is a lot of questions at once. Please wait a moment and try again.'
              : 'The assistant is unavailable right now. Please try again shortly.',
          );
          // Drop the pair we optimistically added: an empty bubble reads as a
          // reply that said nothing, which is worse than no bubble at all.
          setMessages((current) => current.slice(0, -2));
          return;
        }

        await readEventStream(response.body, {
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
          setError('The connection dropped. Please try again.');
          setMessages((current) => current.slice(0, -2));
        }
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [isStreaming, onSession, session, setMessages],
  );

  const transcript: ChatMessage[] =
    session !== null && messages.length === 0
      ? [{ role: 'assistant', content: greetingFor(session.name) }]
      : messages;

  return (
    <div
      role="dialog"
      // Not modal: the catalogue behind stays scrollable and usable, which is
      // the point of a panel rather than a dialog.
      aria-modal="false"
      aria-label={`Ask ${business.displayName}`}
      className="fixed inset-x-3 bottom-3 z-40 flex max-h-[min(32rem,calc(100dvh-1.5rem))] flex-col
                 overflow-hidden rounded-xl border border-border bg-surface shadow-overlay
                 animate-dialog-in sm:inset-x-auto sm:right-5 sm:bottom-24 sm:w-[23rem]
                 sm:max-h-[min(32rem,calc(100dvh-7.5rem))]"
    >
      {/* Header */}
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border-subtle bg-surface-sunken px-4 py-3">
        <div className="min-w-0">
          <p className="text-title-xs text-ink">Ask about our products</p>
          <p className="mt-0.5 text-xxs leading-relaxed text-ink-muted">
            Answers come from this catalogue. Not clinical advice.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the chat"
          className="-mr-1 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md
                     text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>

      {session === null ? (
        <div className="flex-1 overflow-y-auto">
          {/* An error carried over from an expired conversation belongs here,
              above the form the visitor now has to fill in again. */}
          {error !== null && (
            <p
              role="alert"
              className="mx-4 mt-4 rounded-md border border-border bg-surface-sunken px-3 py-2 text-xs text-ink-muted"
            >
              {error}
            </p>
          )}

          <VisitorForm
            onStarted={(started) => {
              setError(null);
              onSession(started);
            }}
          />
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
                      This answer was cut off. Please ask again for the full reply.
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
                Thinking…
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
                This conversation has reached its length limit. Reload the page to start a new one,
                or email{' '}
                {business.supportEmail === null ? 'our support team' : (
                  <a
                    href={`mailto:${business.supportEmail}`}
                    className="font-medium text-brand underline underline-offset-2"
                  >
                    {business.supportEmail}
                  </a>
                )}
                .
              </p>
            ) : (
              <div className="flex items-end gap-2">
                <label htmlFor="assistant-input" className="sr-only">
                  Your question
                </label>
                <textarea
                  id="assistant-input"
                  ref={inputRef}
                  rows={1}
                  value={draft}
                  maxLength={MAX_MESSAGE_CHARS}
                  placeholder="e.g. do you have 22G safety cannula?"
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
                  disabled={isStreaming || draft.trim().length === 0}
                  aria-label="Send"
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-brand
                             text-white shadow-card transition-colors hover:bg-brand-hover
                             focus-visible:ring-brand disabled:cursor-not-allowed disabled:bg-ink-subtle
                             disabled:shadow-none"
                >
                  <SendIcon className="h-4 w-4" />
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
  const { features } = useStorefront();
  const [isOpen, setIsOpen] = useState(false);
  const launcherRef = useRef<HTMLButtonElement>(null);

  /*
   * The session and the transcript live here, not in the panel, so closing the
   * panel and opening it again does not throw away the conversation or ask a
   * visitor for their number twice. Seeded from sessionStorage, so a reload
   * mid-visit does not either.
   */
  const [session, setSession] = useState<ChatSession | null>(readStoredSession);
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const close = useCallback(() => {
    setIsOpen(false);
  }, []);

  const changeSession = useCallback((next: ChatSession | null) => {
    setSession(next);
    storeSession(next);
  }, []);

  // The single gate. No key configured on this deployment, no widget at all —
  // not a disabled button, not a tooltip.
  if (!features.assistant) return null;

  return (
    <>
      {isOpen && (
        <Suspense fallback={null}>
          <ChatPanel
            onClose={close}
            returnFocusTo={launcherRef}
            session={session}
            onSession={changeSession}
            messages={messages}
            setMessages={setMessages}
          />
        </Suspense>
      )}

      {/*
       * 56px, above the safe-area inset so it clears the home indicator on
       * iOS. Hidden while the panel is open on a phone, where the panel takes
       * the full width and the launcher would sit on top of the composer.
       */}
      <button
        ref={launcherRef}
        type="button"
        onClick={() => {
          setIsOpen((open) => !open);
        }}
        aria-expanded={isOpen}
        aria-label={isOpen ? 'Close the chat' : 'Ask about our products'}
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

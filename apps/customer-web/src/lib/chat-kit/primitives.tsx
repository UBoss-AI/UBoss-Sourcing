/**
 * The pieces a chat screen is drawn from.
 *
 * SHARED FILE - see the note in `chat-scroll.ts`. Nothing in here translates:
 * every word arrives as a prop, so the storefront and the console keep their
 * own catalogues and these stay the same file.
 *
 * Messages are text. Everything anybody wrote is rendered as React text nodes -
 * never `dangerouslySetInnerHTML`, never Markdown - and links are made only by
 * `linkify`, open in a new tab and carry `noopener noreferrer nofollow ugc`.
 */
import { forwardRef, useId } from 'react';
import { cx } from '@/lib/cx';
import { useChatComposer } from './composer';
import { initialsOf, linkify } from './timeline';

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

/**
 * The one scrolling element of a conversation.
 *
 * `role="log"` is what a chat history is. Its live announcing is switched OFF
 * (`aria-live="off"`), because a log announces every node added to it - and
 * loading fifty earlier messages would read fifty messages aloud. New messages
 * are announced by `ChatAnnouncer`, one at a time.
 *
 * `overscroll-contain` keeps a wheel that reaches the end of the history from
 * scrolling whatever is behind it; `min-h-0` is what lets a flex child shrink
 * below its content and scroll instead of growing the page.
 */
export const ChatViewport = forwardRef<
  HTMLDivElement,
  { label: string; onScroll: () => void; children: React.ReactNode; className?: string }
>(function ChatViewport({ label, onScroll, children, className }, ref) {
  return (
    <div
      ref={ref}
      role="log"
      aria-live="off"
      aria-label={label}
      // A scrolling region has to take focus, or somebody without a mouse
      // cannot scroll it at all (WCAG 2.1.1). A log is not "interactive" to
      // the linter, and is to a keyboard.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      onScroll={onScroll}
      className={cx(
        'min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain [overflow-anchor:none]',
        'focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand',
        className,
      )}
    >
      {children}
    </div>
  );
});

/** One polite announcement for the newest incoming message, nothing else. */
export function ChatAnnouncer({ text }: { text: string }): React.JSX.Element {
  return (
    <p className="sr-only" aria-live="polite" aria-atomic="true">
      {text}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Separators and markers
// ---------------------------------------------------------------------------

export function DaySeparator({ label, dateTime }: { label: string; dateTime: string }): React.JSX.Element {
  return (
    <div role="separator" aria-label={label} className="my-3 flex items-center gap-3 text-xxs font-medium text-ink-subtle">
      <span aria-hidden="true" className="h-px flex-1 bg-border-subtle" />
      <time dateTime={dateTime} className="shrink-0 rounded-full bg-surface-sunken px-2.5 py-0.5">
        {label}
      </time>
      <span aria-hidden="true" className="h-px flex-1 bg-border-subtle" />
    </div>
  );
}

export function UnreadSeparator({ label }: { label: string }): React.JSX.Element {
  return (
    <div role="separator" aria-label={label} className="my-3 flex items-center gap-3 text-xxs font-semibold text-brand">
      <span aria-hidden="true" className="h-px flex-1 bg-brand/40" />
      <span className="shrink-0">{label}</span>
      <span aria-hidden="true" className="h-px flex-1 bg-brand/40" />
    </div>
  );
}

/** "3 new messages" / "Jump to latest", floating over the bottom of the history. */
export function JumpToLatest({ label, onClick }: { label: string; onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute bottom-3 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-brand-fill px-3.5 py-1.5 text-xs font-semibold text-white shadow-popover hover:bg-brand-fill-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
    >
      <svg aria-hidden="true" viewBox="0 0 20 20" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M10 4v12m0 0-5-5m5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {label}
    </button>
  );
}

/** Three dots and the words - the words are what a screen reader gets. */
export function TypingIndicator({ label }: { label: string }): React.JSX.Element {
  return (
    <p className="mt-2 flex items-center gap-2 text-xs text-ink-muted" role="status">
      <span aria-hidden="true" className="inline-flex gap-0.5 rounded-full bg-surface-sunken px-2 py-1.5">
        {[0, 1, 2].map((dot) => (
          <span
            key={dot}
            className="size-1.5 animate-bounce rounded-full bg-ink-subtle motion-reduce:animate-none"
            style={{ animationDelay: `${dot * 150}ms` }}
          />
        ))}
      </span>
      {label}
    </p>
  );
}

export type ConnectionTone = 'info' | 'warning';

/** Reconnecting, offline, signed out - shown only when it is true. */
export function ConnectionBanner({ text, tone = 'warning' }: { text: string; tone?: ConnectionTone }): React.JSX.Element {
  return (
    <p
      role="status"
      className={cx(
        'flex shrink-0 items-center gap-2 border-b border-border-subtle px-4 py-1.5 text-xs text-ink',
        tone === 'warning' ? 'bg-warning-soft' : 'bg-brand-soft',
      )}
    >
      <svg aria-hidden="true" viewBox="0 0 20 20" className="size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M10 6v5m0 3h.01M3 16h14L10 3 3 16Z" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {text}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export type DeliveryMarkState = 'SENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';

/**
 * Sending, Sent, Delivered, Read, Not sent - as a shape AND a word, never as a
 * colour alone.
 */
export function DeliveryMark({ state, label }: { state: DeliveryMarkState; label: string }): React.JSX.Element {
  return (
    <span className={cx('inline-flex items-center gap-1', state === 'FAILED' ? 'text-danger' : state === 'READ' ? 'text-brand' : '')}>
      <svg aria-hidden="true" viewBox="0 0 20 20" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
        {state === 'SENDING' && <path d="M10 5v5l3 2m5-2a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z" strokeLinecap="round" />}
        {state === 'SENT' && <path d="m4 10.5 3.5 3.5L16 5.5" strokeLinecap="round" strokeLinejoin="round" />}
        {(state === 'DELIVERED' || state === 'READ') && (
          <path d="M1.5 10.5 5 14l7.5-8.5M8 12.5 9.5 14l8-8.5" strokeLinecap="round" strokeLinejoin="round" />
        )}
        {state === 'FAILED' && <path d="M10 6v5m0 3h.01M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z" strokeLinecap="round" />}
      </svg>
      <span>{label}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

/** A message body: line breaks kept, long words and URLs wrapped, links safe. */
export function MessageText({ body, className }: { body: string; className?: string }): React.JSX.Element {
  return (
    <p className={cx('whitespace-pre-wrap break-words [overflow-wrap:anywhere]', className)}>
      {linkify(body).map((part, index) =>
        part.kind === 'text' ? (
          <span key={index}>{part.text}</span>
        ) : (
          <a
            key={index}
            href={part.href}
            target="_blank"
            rel="noopener noreferrer nofollow ugc"
            className="underline underline-offset-2"
          >
            {part.text}
          </a>
        ),
      )}
    </p>
  );
}

/**
 * A round badge of initials or a picture. The picture has a fixed box, so it
 * decoding late never moves the history.
 */
export function ChatAvatar({
  name,
  imageUrl,
  size = 'md',
  tone = 'neutral',
  square = false,
}: {
  name: string | null | undefined;
  imageUrl?: string | null | undefined;
  size?: 'sm' | 'md' | 'lg';
  tone?: 'neutral' | 'brand';
  square?: boolean;
}): React.JSX.Element {
  const box = size === 'sm' ? 'size-7 text-xxs' : size === 'lg' ? 'size-12 text-sm' : 'size-10 text-xs';
  const shape = square ? 'rounded-md' : 'rounded-full';
  if (imageUrl !== null && imageUrl !== undefined && imageUrl !== '') {
    return (
      <img
        src={imageUrl}
        alt=""
        loading="lazy"
        decoding="async"
        className={cx(box, shape, 'shrink-0 bg-surface-sunken object-cover')}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cx(
        box,
        shape,
        'inline-flex shrink-0 items-center justify-center font-semibold',
        tone === 'brand' ? 'bg-brand-soft text-brand ring-1 ring-inset ring-brand/20' : 'bg-surface-sunken text-ink-muted',
      )}
    >
      {initialsOf(name)}
    </span>
  );
}

/** A count on a conversation row. The words are for a screen reader. */
export function UnreadBadge({ count, label }: { count: number; label: string }): React.JSX.Element | null {
  if (count <= 0) return null;
  return (
    <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-brand-fill px-1.5 text-xxs font-semibold tabular-nums text-white">
      <span aria-hidden="true">{count > 99 ? '99+' : count}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Loading and empty
// ---------------------------------------------------------------------------

export function ConversationListSkeleton({ rows = 6, label }: { rows?: number; label: string }): React.JSX.Element {
  return (
    <div role="status" aria-label={label} className="divide-y divide-border-subtle">
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="flex gap-3 px-3 py-3">
          <span className="size-10 shrink-0 animate-pulse rounded-full bg-surface-sunken motion-reduce:animate-none" />
          <span className="flex-1 space-y-2 pt-1">
            <span className="block h-3 w-2/3 animate-pulse rounded bg-surface-sunken motion-reduce:animate-none" />
            <span className="block h-2.5 w-11/12 animate-pulse rounded bg-surface-sunken motion-reduce:animate-none" />
          </span>
        </div>
      ))}
    </div>
  );
}

export function ThreadSkeleton({ label }: { label: string }): React.JSX.Element {
  return (
    <div role="status" aria-label={label} className="space-y-4 py-4">
      {['w-2/3', 'ml-auto w-1/2', 'w-3/5', 'ml-auto w-2/5'].map((width, row) => (
        <span
          key={row}
          className={cx('block h-12 animate-pulse rounded-lg bg-surface-sunken motion-reduce:animate-none', width)}
        />
      ))}
    </div>
  );
}

export function ChatEmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="m-auto max-w-sm px-6 py-10 text-center">
      <svg aria-hidden="true" viewBox="0 0 48 48" className="mx-auto mb-3 size-12 text-ink-subtle" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M8 12a4 4 0 0 1 4-4h24a4 4 0 0 1 4 4v16a4 4 0 0 1-4 4H20l-8 7v-7a4 4 0 0 1-4-4V12Z" strokeLinejoin="round" />
        <path d="M16 18h16M16 24h10" strokeLinecap="round" />
      </svg>
      <p className="text-sm font-semibold text-ink">{title}</p>
      {description !== undefined && <p className="mt-1 text-sm text-ink-muted">{description}</p>}
      {action !== undefined && <div className="mt-4">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The composer
// ---------------------------------------------------------------------------

export interface ChatComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: (text: string) => void;
  /** False when nothing may be sent right now. The box stays usable for a draft. */
  canSend: boolean;
  disabled?: boolean;
  labels: {
    label: string;
    placeholder: string;
    send: string;
    /** "Enter to send • Shift+Enter for a new line" */
    hint: string;
    /** For a touch keyboard, where Enter is a new line. */
    touchHint: string;
  };
  /** Controls before the box: an attach button. */
  leading?: React.ReactNode;
  /** Lines under the box: a counter, an error. Linked to the box for a screen reader. */
  footer?: React.ReactNode;
  invalid?: boolean;
  isEnterClaimed?: () => boolean;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  className?: string;
}

export function ChatComposer({
  value,
  onChange,
  onSend,
  canSend,
  disabled = false,
  labels,
  leading,
  footer,
  invalid = false,
  isEnterClaimed,
  textareaRef,
  className,
}: ChatComposerProps): React.JSX.Element {
  const id = useId();
  const composer = useChatComposer({
    value,
    onSend,
    canSend: canSend && !disabled,
    ...(isEnterClaimed === undefined ? {} : { isEnterClaimed }),
  });
  const setRef = (element: HTMLTextAreaElement | null): void => {
    composer.textareaRef.current = element;
    if (textareaRef !== undefined) textareaRef.current = element;
  };
  const sendable = canSend && !disabled && value.trim().length > 0;

  return (
    <form
      className={cx('shrink-0', className)}
      onSubmit={(event) => {
        event.preventDefault();
        composer.submit();
      }}
    >
      <div className="flex items-end gap-2">
        {leading}
        <div className="min-w-0 flex-1">
          <label htmlFor={id} className="sr-only">
            {labels.label}
          </label>
          <textarea
            id={id}
            ref={setRef}
            value={value}
            rows={1}
            disabled={disabled}
            aria-invalid={invalid}
            aria-describedby={`${id}-hint`}
            placeholder={labels.placeholder}
            enterKeyHint={composer.newlineOnEnter ? 'enter' : 'send'}
            onChange={(event) => {
              onChange(event.target.value);
            }}
            onKeyDown={composer.onKeyDown}
            onCompositionStart={composer.onCompositionStart}
            onCompositionEnd={composer.onCompositionEnd}
            className="block max-h-[10.5rem] min-h-10 w-full resize-none rounded-lg border border-border bg-surface px-3 py-2 text-sm leading-5 text-ink placeholder:text-ink-subtle focus-visible:border-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-brand/40 disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-danger"
          />
        </div>
        <button
          type="submit"
          disabled={!sendable}
          aria-label={labels.send}
          className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg bg-brand-fill px-3 text-sm font-semibold text-white hover:bg-brand-fill-hover disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        >
          <svg aria-hidden="true" viewBox="0 0 20 20" className="size-5" fill="currentColor">
            <path d="M3.1 2.3a.75.75 0 0 0-1 .9l1.9 6.05H10a.75.75 0 0 1 0 1.5H4l-1.9 6.05a.75.75 0 0 0 1 .9l15-7.25a.75.75 0 0 0 0-1.35l-15-7.8Z" />
          </svg>
          <span className="hidden sm:inline">{labels.send}</span>
        </button>
      </div>
      <div id={`${id}-hint`} className="mt-1 flex flex-wrap items-center justify-between gap-x-3 text-xxs text-ink-subtle">
        <span>{composer.newlineOnEnter ? labels.touchHint : labels.hint}</span>
        {footer}
      </div>
    </form>
  );
}

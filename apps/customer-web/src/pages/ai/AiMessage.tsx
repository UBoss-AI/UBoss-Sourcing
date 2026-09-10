/**
 * One turn in the AI Mode transcript.
 *
 * The rule that matters here is the one this replaced the corner widget's
 * renderer to keep: **model output is never HTML.** It is rendered as text,
 * with exactly one exception — a `/product/...` path becomes a router link.
 * That pattern cannot express anything but an internal route, so linkifying it
 * is safe by construction: no sanitiser is needed, and no external URL, no
 * `javascript:` and no markup can come out the other end. A general URL matcher
 * here would be an injection surface fed by model output, which is the whole
 * reason the narrow pattern exists.
 *
 * The two actions under an assistant reply are deliberately what they are:
 *
 *   - **Copy** puts the reply on the clipboard. A procurement office pastes
 *     product codes into a requisition, and selecting streamed text by hand on
 *     a phone is miserable.
 *   - **Ask again** re-sends the question as a new turn. It does not replace
 *     the reply already given, and it is not called Regenerate for that
 *     reason: the transcript lives on the server, where it is the record of
 *     what this deployment's AI told a buyer about a medical device. A button
 *     that quietly deleted a recorded answer would make that record a fiction.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CopyIcon, CheckIcon, RefreshIcon } from '@/components/icons';
import { cx } from '@/lib/cx';
import { useI18n } from '@/i18n/i18n-context';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Product paths only. Nothing else in a reply becomes a link. */
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
export function MessageBody({ text }: { text: string }): React.JSX.Element {
  return (
    <>
      {text.split('\n').map((line, index) => (
        <p key={index} className={cx(index > 0 && 'mt-2', line.length === 0 && 'h-2')}>
          {renderLine(line, String(index))}
        </p>
      ))}
    </>
  );
}

function CopyButton({ text }: { text: string }): React.JSX.Element {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  // The tick reverts on its own. Left permanently, a row of ticks under every
  // reply stops meaning "just copied" and starts meaning nothing.
  useEffect(() => {
    if (!copied) return;

    const timer = window.setTimeout(() => {
      setCopied(false);
    }, 2_000);

    return () => {
      window.clearTimeout(timer);
    };
  }, [copied]);

  return (
    <button
      type="button"
      onClick={() => {
        // `writeText` rejects on an insecure origin and where the permission is
        // refused. Nothing is broken by that — the text is still on screen and
        // selectable — so the failure is swallowed rather than announced.
        // `navigator.clipboard` is absent outside a secure context, which
        // the DOM types do not admit and jsdom does not provide.
        if (typeof navigator.clipboard !== 'object') return;

        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
          })
          .catch(() => {
            /* Clipboard unavailable. The reply is still there to select. */
          });
      }}
      className="inline-flex items-center gap-1.5 rounded px-1.5 py-1 text-xs text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink"
    >
      {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
      {copied ? t('aiMode.copied') : t('aiMode.copy')}
    </button>
  );
}

export function AiMessage({
  message,
  isTruncated,
  onAskAgain,
}: {
  message: ChatMessage;
  /** True when the stream carried an error after some text had already landed. */
  isTruncated: boolean;
  /** Absent while a reply is still streaming, and on the customer's own turns. */
  onAskAgain?: (() => void) | undefined;
}): React.JSX.Element {
  const { t } = useI18n();

  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-brand-fill px-4 py-2.5 text-sm leading-relaxed text-white">
          <MessageBody text={message.content} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="max-w-[92%]">
        <div className="rounded-2xl rounded-bl-md bg-surface-sunken px-4 py-3 text-sm leading-relaxed text-ink ring-1 ring-inset ring-border">
          <MessageBody text={message.content} />

          {isTruncated && (
            <p className="mt-2.5 border-t border-border pt-2.5 text-xs text-ink-muted">
              {t('chat.thisAnswerWasCutOff')}
            </p>
          )}
        </div>

        {/* Only under a finished reply. Offering Copy on a bubble that is still
            filling in copies half an answer. */}
        {onAskAgain !== undefined && (
          <div className="mt-1 flex items-center gap-1">
            <CopyButton text={message.content} />
            <button
              type="button"
              onClick={onAskAgain}
              className="inline-flex items-center gap-1.5 rounded px-1.5 py-1 text-xs text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink"
            >
              <RefreshIcon className="h-3.5 w-3.5" />
              {t('aiMode.askAgain')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

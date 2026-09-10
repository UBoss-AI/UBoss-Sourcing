/**
 * The AI Mode composer.
 *
 * A textarea that grows, three controls around it, and one rule about which of
 * them is showing: while a reply is streaming the Send button becomes Stop.
 * Never both. A composer that offers Send during a generation invites a second
 * question the deployment pays for and nobody reads, and one that offers
 * neither leaves somebody watching a wall of text they cannot interrupt.
 *
 * `Enter` sends and `Shift+Enter` is a newline, which is the way round every
 * chat interface has settled on — and the reason the field is a textarea at
 * all: a customer describing what they need writes three lines, not three
 * words.
 *
 * On a phone the whole thing sits above `env(safe-area-inset-bottom)`, so the
 * Send button clears the home indicator when the keyboard is up. That is the
 * one control that must never be under the customer's thumb rest.
 */
import { useCallback, useEffect, useRef } from 'react';
import { MicIcon, PaperclipIcon, SendIcon, StopIcon } from '@/components/icons';
import { cx } from '@/lib/cx';
import { useVoiceSearch } from '@/lib/voice-search';
import { useI18n } from '@/i18n/i18n-context';
import { languageOption } from '@/i18n/languages';

/** Mirrors the API's own per-message cap, which rejects anything longer. */
const MAX_MESSAGE_CHARS = 2_000;

export function AiComposer({
  value,
  onChange,
  onSend,
  onStop,
  onAttach,
  isStreaming,
  isDisabled,
  disabledNote,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  /** Absent on a deployment with no image search configured. */
  onAttach?: (() => void) | undefined;
  isStreaming: boolean;
  /** True while the conversation cannot take another turn at all. */
  isDisabled: boolean;
  /** Why, when it is disabled. Rendered instead of the hint line. */
  disabledNote?: string | undefined;
}): React.JSX.Element {
  const { t, language } = useI18n();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const appendTranscript = useCallback(
    (text: string) => {
      // Appended, never assigned: somebody who typed half a question and then
      // dictated the rest of it means both halves.
      onChange(value.trim().length === 0 ? text : `${value.trim()} ${text}`);
      textareaRef.current?.focus();
    },
    [onChange, value],
  );

  const voice = useVoiceSearch({
    language: languageOption(language).intlLocale,
    onTranscript: appendTranscript,
  });

  /*
   * Grow with the content, up to a ceiling.
   *
   * Height is reset to `auto` before `scrollHeight` is read, because
   * `scrollHeight` on an element with an explicit height never shrinks — delete
   * three lines from a grown textarea without this and it stays tall.
   */
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea === null) return;

    textarea.style.height = 'auto';
    textarea.style.height = `${String(Math.min(textarea.scrollHeight, 200))}px`;
  }, [value]);

  const isListening = voice.status === 'listening' || voice.status === 'starting';
  const canSend = value.trim().length > 0 && !isStreaming && !isDisabled;

  return (
    <div
      className="shrink-0 border-t border-border bg-surface px-3 pb-3 pt-3 sm:px-6"
      style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom, 0px))' }}
    >
      <form
        className="mx-auto max-w-3xl"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSend) onSend();
        }}
      >
        <div className="rounded-2xl border border-border-strong bg-surface shadow-card transition-[border-color,box-shadow] focus-within:border-brand focus-within:shadow-card-hover">
          <label htmlFor="ai-composer" className="sr-only">
            {t('aiMode.composerLabel')}
          </label>
          <textarea
            id="ai-composer"
            ref={textareaRef}
            rows={1}
            value={value}
            maxLength={MAX_MESSAGE_CHARS}
            disabled={isDisabled}
            placeholder={t('aiMode.composerPlaceholder')}
            onChange={(event) => {
              onChange(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                if (canSend) onSend();
              }
            }}
            className="block max-h-[200px] w-full resize-none bg-transparent px-4 pt-3 text-sm leading-relaxed text-ink outline-none placeholder:text-ink-subtle disabled:cursor-not-allowed"
          />

          <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5 pt-1">
            <div className="flex items-center gap-0.5">
              {onAttach !== undefined && (
                <button
                  type="button"
                  onClick={onAttach}
                  disabled={isDisabled}
                  aria-label={t('aiMode.attachImage')}
                  className="flex h-9 w-9 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-brand-soft hover:text-brand disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <PaperclipIcon className="h-[1.15rem] w-[1.15rem]" />
                </button>
              )}

              {voice.isSupported && (
                <button
                  type="button"
                  onClick={() => {
                    if (isListening) voice.stop();
                    else voice.start();
                  }}
                  disabled={isDisabled}
                  aria-pressed={isListening}
                  aria-label={isListening ? t('voice.stopListening') : t('voice.startListening')}
                  className={cx(
                    'relative flex h-9 w-9 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                    isListening
                      ? 'bg-danger-fill text-white'
                      : 'text-ink-muted hover:bg-brand-soft hover:text-brand',
                  )}
                >
                  <MicIcon className="h-[1.15rem] w-[1.15rem]" />
                  {isListening && (
                    <span
                      aria-hidden="true"
                      className="absolute inset-0 animate-ping rounded-full bg-danger/40"
                    />
                  )}
                </button>
              )}
            </div>

            {/* Send, or Stop. Never both — see the header. */}
            {isStreaming ? (
              <button
                type="button"
                onClick={onStop}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-ink text-white transition-colors hover:bg-navy"
                aria-label={t('aiMode.stopGenerating')}
              >
                <StopIcon className="h-4 w-4" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!canSend}
                aria-label={t('aiMode.send')}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-fill text-white transition-colors hover:bg-brand-fill-hover disabled:cursor-not-allowed disabled:bg-ink-subtle"
              >
                <SendIcon className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {/* One line under the box: what the voice engine is doing, why the
            composer is closed, or the standing AI disclosure. In that order —
            the transient states are the ones somebody is waiting on. */}
        <p role="status" aria-live="polite" className="mt-2 min-h-4 text-center text-xxs leading-relaxed text-ink-muted">
          {voice.status === 'starting' && t('voice.allowMicrophone')}
          {voice.status === 'listening' && (
            <span className="font-medium text-danger">
              {t('voice.listening')}
              {voice.interim.length > 0 && (
                <span className="ml-1.5 font-normal italic text-ink-muted">{voice.interim}</span>
              )}
            </span>
          )}
          {voice.status === 'idle' && voice.errorKey !== null && (
            <span className="text-danger">{t(voice.errorKey)}</span>
          )}
          {voice.status === 'idle' &&
            voice.errorKey === null &&
            (disabledNote ?? t('aiMode.disclaimer'))}
        </p>
      </form>
    </div>
  );
}

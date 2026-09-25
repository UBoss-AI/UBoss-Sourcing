/**
 * The keyboard rules of a chat composer.
 *
 * SHARED FILE - see the note in `chat-scroll.ts`.
 *
 *     Enter          sends
 *     Shift+Enter    starts a new line
 *     Send button    sends
 *
 * And the cases that make those three lines harder than they look:
 *
 *   - **An input method composing a character is left alone.** Japanese,
 *     Chinese and Korean input confirm a character with Enter; sending on that
 *     Enter sends half a word. `isComposing` is checked on the event and on the
 *     native event, the composition events are tracked as well, and keyCode 229
 *     - which Safari reports for the Enter that ENDS a composition - is
 *     ignored.
 *   - **Something else may want the Enter.** A handler earlier in the chain
 *     that called `preventDefault()` (a suggestion menu choosing an item), or
 *     `isEnterClaimed()` returning true, means it is not a send.
 *   - **One press is one message.** A held-down key repeats; two presses can
 *     land before the screen redraws; a click can arrive with a key. A send is
 *     accepted at most once per distinct draft, until the draft changes.
 *   - **A touch keyboard is not a desktop keyboard.** On a phone Enter is the
 *     only way to start a new line, and the Send button is right there, so on
 *     a coarse pointer without hover Enter inserts a line break.
 *   - **Paste never sends.** Sending happens on a key press, and a paste is
 *     not one - a multi-line paste lands in the box as it was copied.
 *
 * What is sent is the draft with its outer whitespace trimmed; the line
 * breaks inside it are kept. Whitespace alone is not a message.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/** Lines the box grows to before it scrolls inside itself. */
export const COMPOSER_MAX_ROWS = 6;

/** The text a draft sends, or null when it would send nothing. */
export function outgoingText(draft: string): string | null {
  const text = draft.trim();
  return text.length === 0 ? null : text;
}

/** True where Enter should insert a line rather than send: touch keyboards. */
export function prefersNewlineOnEnter(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
}

export interface ComposerKeyEvent {
  key: string;
  shiftKey: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  repeat?: boolean;
  keyCode?: number;
  defaultPrevented?: boolean;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean };
  preventDefault: () => void;
}

/**
 * What a key press in the composer means. Exported on its own so every rule
 * above has a test that does not need a browser.
 */
export function composerKeyAction(
  event: ComposerKeyEvent,
  state: { composing: boolean; newlineOnEnter: boolean; enterClaimed: boolean },
): 'send' | 'ignore' | 'default' {
  if (event.key !== 'Enter') return 'default';
  if (event.isComposing === true || event.nativeEvent?.isComposing === true || state.composing) return 'ignore';
  if (event.keyCode === 229) return 'ignore';
  if (event.defaultPrevented === true || state.enterClaimed) return 'ignore';
  // Shift+Enter is a new line. Alt/Ctrl/Meta+Enter are left to the browser
  // and to assistive technology, which use some of them.
  if (event.shiftKey || event.altKey === true || event.ctrlKey === true || event.metaKey === true) {
    return 'default';
  }
  if (state.newlineOnEnter) return 'default';
  return 'send';
}

export interface ComposerOptions {
  value: string;
  /** Hands the trimmed text to the outbox. Must not throw for a network failure. */
  onSend: (text: string) => void;
  /** False while the conversation cannot take a message (closed, too long…). */
  canSend: boolean;
  /** True while a menu attached to the box is using Enter itself. */
  isEnterClaimed?: () => boolean;
}

export interface ComposerState {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  /** Enter sends where it should: hand `onKeyDown`, `onCompositionStart` and `onCompositionEnd` to the textarea. */
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  /** For the Send button and the form's submit. */
  submit: () => void;
  /** Enter inserts a line here (a touch keyboard) - the hint says so. */
  newlineOnEnter: boolean;
}

export function useChatComposer(options: ComposerOptions): ComposerState {
  const { value, onSend, canSend, isEnterClaimed } = options;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composing = useRef(false);
  // The draft last handed over. The same draft is not handed over twice; any
  // change to the draft - including clearing it - releases the lock.
  const sentDraft = useRef<string | null>(null);
  const [newlineOnEnter, setNewlineOnEnter] = useState(prefersNewlineOnEnter);

  useEffect(() => {
    if (sentDraft.current !== null && value !== sentDraft.current) sentDraft.current = null;
  }, [value]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia('(hover: none) and (pointer: coarse)');
    const update = (): void => {
      setNewlineOnEnter(query.matches);
    };
    query.addEventListener('change', update);
    return () => {
      query.removeEventListener('change', update);
    };
  }, []);

  // Grow with the text up to COMPOSER_MAX_ROWS lines, then scroll inside.
  useLayoutEffect(() => {
    const box = textareaRef.current;
    if (box === null) return;
    box.style.height = 'auto';
    const style = window.getComputedStyle(box);
    const px = (property: string): number => Number.parseFloat(style.getPropertyValue(property)) || 0;
    const line = px('line-height') || 20;
    const borders = px('border-top-width') + px('border-bottom-width');
    const max = line * COMPOSER_MAX_ROWS + px('padding-top') + px('padding-bottom') + borders;
    // `scrollHeight` counts the padding but not the border.
    const wanted = box.scrollHeight + borders;
    box.style.height = `${Math.min(wanted, max)}px`;
    box.style.overflowY = wanted > max ? 'auto' : 'hidden';
  }, [value]);

  const submit = useCallback((): void => {
    const text = outgoingText(value);
    if (text === null || !canSend) return;
    if (sentDraft.current === value) return;
    sentDraft.current = value;
    onSend(text);
    // A click on Send moved focus to the button; the next message starts in
    // the box.
    textareaRef.current?.focus();
  }, [value, canSend, onSend]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
      const action = composerKeyAction(event, {
        composing: composing.current,
        newlineOnEnter,
        enterClaimed: isEnterClaimed?.() === true,
      });
      if (action !== 'send') return;
      // Enter never inserts a line in this mode, even when there is nothing to
      // send - an empty box that fills with blank lines is a box that lies.
      event.preventDefault();
      if (event.repeat) return;
      submit();
    },
    [newlineOnEnter, isEnterClaimed, submit],
  );

  return {
    textareaRef,
    onKeyDown,
    onCompositionStart: () => {
      composing.current = true;
    },
    onCompositionEnd: () => {
      composing.current = false;
    },
    submit,
    newlineOnEnter,
  };
}

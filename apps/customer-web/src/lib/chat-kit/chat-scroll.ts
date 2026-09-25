/**
 * Where a chat history is scrolled to, decided on purpose.
 *
 * SHARED FILE. `lib/chat-kit/` is the same set of files in the storefront and
 * in the admin console - Account -> Messages and Preorder Chats scroll and
 * send the same way because they run the same code. `chat-kit.sync.test.ts`
 * fails when the two copies differ, so a fix is made in one and copied to the
 * other, never made twice.
 *
 * One element scrolls: the message viewport. The page around it does not, the
 * header above it does not, the composer below it does not. This hook owns
 * that one element's `scrollTop` and moves it for exactly these reasons:
 *
 *   1. **Opening a conversation** lands on the first unread message when there
 *      is one, and on the newest message otherwise.
 *   2. **Your own message** is always scrolled into view - you just sent it.
 *   3. **Somebody else's message** scrolls the history only when you were
 *      already reading the newest one ("pinned"). Reading older messages, you
 *      keep your place and a "N new messages" count appears instead.
 *   4. **Older messages loaded above** keep what you were reading exactly where
 *      it was: the scroll offset grows by the height that was added.
 *   5. **Something changing size** - a typing line, a picture decoding, the
 *      phone keyboard shrinking the viewport - keeps a pinned history at the
 *      bottom and leaves an unpinned one alone.
 *
 * It never animates. A smooth scroll is a scroll whose position is wrong for
 * half a second, and every decision above reads the position.
 *
 * Why not `scrollIntoView()` after every render: it scrolls every scrollable
 * ANCESTOR too, which is how a chat drags the whole page with it.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/** Within this many pixels of the bottom counts as reading the newest. */
export const PINNED_THRESHOLD_PX = 96;
/** Within this many pixels of the top asks for older messages. */
export const TOP_THRESHOLD_PX = 160;

export interface ChatScrollOptions {
  /** Changing this resets everything: a different conversation is a fresh start. */
  conversationKey: string | null;
  /** False until the first page of messages is on screen. */
  ready: boolean;
  /** Key of the oldest rendered item. A change with the same `lastKey` is a prepend. */
  firstKey: string | null;
  /** Key of the newest rendered item. */
  lastKey: string | null;
  /** How many items are rendered. */
  count: number;
  /** True when the newest item is one the viewer wrote themselves. */
  lastIsOwn: boolean;
  /**
   * `data-chat-key` of the first unread item, read once when the conversation
   * opens. Null opens at the newest message.
   */
  initialAnchorKey: string | null;
  /** Called when the viewer scrolls near the top and older messages exist. */
  onReachTop?: (() => void) | undefined;
}

export interface ChatScrollState {
  viewportRef: React.RefObject<HTMLDivElement | null>;
  contentRef: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  /** Whether the newest message is in view. */
  isPinned: boolean;
  /** Messages that arrived below while the viewer was reading older ones. */
  newCount: number;
  /** Go to the newest message and clear the count. */
  jumpToLatest: () => void;
}

export function distanceFromBottom(element: HTMLElement): number {
  return element.scrollHeight - element.scrollTop - element.clientHeight;
}

function toBottom(element: HTMLElement): void {
  element.scrollTop = element.scrollHeight;
}

export function useChatScroll(options: ChatScrollOptions): ChatScrollState {
  const { conversationKey, ready, firstKey, lastKey, count, lastIsOwn, initialAnchorKey, onReachTop } = options;
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const [isPinned, setIsPinned] = useState(true);
  const [newCount, setNewCount] = useState(0);

  // Refs, not state: they are read and written inside layout effects and
  // observers, where a re-render per scroll event would be the bug.
  const pinned = useRef(true);
  const positioned = useRef(false);
  const previous = useRef({ key: conversationKey, first: firstKey, last: lastKey, count, height: 0 });
  const reachTop = useRef(onReachTop);
  reachTop.current = onReachTop;

  const setPinned = useCallback((value: boolean): void => {
    pinned.current = value;
    setIsPinned(value);
    if (value) setNewCount(0);
  }, []);

  // A different conversation starts again from nothing.
  if (previous.current.key !== conversationKey) {
    previous.current = { key: conversationKey, first: null, last: null, count: 0, height: 0 };
    positioned.current = false;
    pinned.current = true;
  }

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null || !ready) return;
    const before = previous.current;

    if (!positioned.current) {
      // (1) Opening: the first unread message, or the newest. Whatever the
      // last conversation had counted is not this one's news.
      positioned.current = true;
      setNewCount(0);
      const anchor =
        initialAnchorKey === null
          ? null
          : ([...viewport.querySelectorAll<HTMLElement>('[data-chat-key]')].find(
              (element) => element.dataset['chatKey'] === initialAnchorKey,
            ) ?? null);
      if (anchor !== null) {
        const offset = anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
        // A little of the message before it stays visible, so the reader can
        // see where the unread part starts rather than landing on its edge.
        viewport.scrollTop = Math.max(0, viewport.scrollTop + offset - 48);
        const atBottom = distanceFromBottom(viewport) < PINNED_THRESHOLD_PX;
        pinned.current = atBottom;
        setIsPinned(atBottom);
      } else {
        toBottom(viewport);
        pinned.current = true;
        setIsPinned(true);
      }
    } else if (firstKey !== before.first && lastKey === before.last && count > before.count) {
      // (4) Older messages above: move down by exactly what was added.
      viewport.scrollTop += viewport.scrollHeight - before.height;
    } else if (lastKey !== before.last && lastKey !== null) {
      if (lastIsOwn || pinned.current) {
        // (2) and (3) pinned.
        toBottom(viewport);
        if (!pinned.current) setPinned(true);
      } else if (count > before.count) {
        // (3) reading older ones. A removed item (a failed message
        // discarded) changes the last key too, and is not news.
        setNewCount((current) => current + (count - before.count));
      }
    }

    previous.current = { key: conversationKey, first: firstKey, last: lastKey, count, height: viewport.scrollHeight };
  }, [conversationKey, ready, firstKey, lastKey, count, lastIsOwn, initialAnchorKey, setPinned]);

  // (5) Size changes that are not new items.
  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (viewport === null || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      if (pinned.current && positioned.current) toBottom(viewport);
      previous.current.height = viewport.scrollHeight;
    });
    observer.observe(viewport);
    if (content !== null) observer.observe(content);
    return () => {
      observer.disconnect();
    };
  }, [conversationKey]);

  const onScroll = useCallback((): void => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const atBottom = distanceFromBottom(viewport) < PINNED_THRESHOLD_PX;
    if (atBottom !== pinned.current) setPinned(atBottom);
    else if (atBottom) setNewCount(0);
    previous.current.height = viewport.scrollHeight;
    if (positioned.current && viewport.scrollTop < TOP_THRESHOLD_PX) reachTop.current?.();
  }, [setPinned]);

  const jumpToLatest = useCallback((): void => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    toBottom(viewport);
    setPinned(true);
  }, [setPinned]);

  return { viewportRef, contentRef, onScroll, isPinned, newCount, jumpToLatest };
}

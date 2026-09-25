/**
 * The height a full-screen chat may use, keyboard included.
 *
 * SHARED FILE - see the note in `chat-scroll.ts`.
 *
 * `100dvh` follows a phone's collapsing toolbar but not its on-screen keyboard:
 * the keyboard is drawn OVER the layout, so a composer pinned to the bottom of
 * a `100dvh` frame sits under it. The visual viewport is the part of the page
 * the person can actually see, and it does shrink for the keyboard - so while
 * a chat screen is mounted its height is published as `--chat-viewport-height`
 * and the frame is sized from that, falling back to `100dvh` where there is no
 * visual viewport (and before the first measurement).
 *
 * Scoped to the screen that asks for it: the variable is removed again when
 * the screen unmounts, so no other page is sized by it.
 */
import { useEffect } from 'react';

export const CHAT_VIEWPORT_VAR = '--chat-viewport-height';

/** The CSS height a chat frame should use. */
export const CHAT_FRAME_HEIGHT = `var(${CHAT_VIEWPORT_VAR}, 100dvh)`;

export function useChatViewportHeight(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined;
    // Typed as always there; it is not in every browser, nor in jsdom.
    const viewport = window.visualViewport as VisualViewport | null | undefined;
    if (viewport === null || viewport === undefined) return undefined;
    const root = document.documentElement;
    let frame = 0;
    const update = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        root.style.setProperty(CHAT_VIEWPORT_VAR, `${Math.round(viewport.height)}px`);
        // A focused box can make some browsers scroll the layout under the
        // keyboard. The frame is exactly what is visible, so there is nothing
        // to scroll to: put it back.
        if (window.scrollY !== 0 && document.documentElement.scrollHeight <= viewport.height + 1) {
          window.scrollTo(0, 0);
        }
      });
    };
    update();
    viewport.addEventListener('resize', update);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener('resize', update);
      root.style.removeProperty(CHAT_VIEWPORT_VAR);
    };
  }, [enabled]);
}

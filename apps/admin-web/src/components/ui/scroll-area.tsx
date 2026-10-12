/**
 * A pane that scrolls inside the page, with a drawn scrollbar in the theme's
 * own colours instead of the operating system's grey gutter.
 *
 * Built on Radix ScrollArea, which keeps the browser's native scrolling - the
 * wheel, a trackpad, touch, the keyboard and a screen reader all move the same
 * element they always did - and only replaces the bar that is drawn. The bar
 * is an overlay, so it takes no width and nothing jumps when it appears.
 *
 * **The viewport is the element that scrolls.** Anything that reads
 * `scrollTop`, listens for `scroll` or measures `scrollHeight` - a chat that
 * keeps its place, a dialog that waits for the end of an agreement - has to be
 * given `viewportRef` and `onViewportScroll`, never the root. The root does not
 * scroll, and a listener on it hears nothing.
 *
 * The root is a column flex box and the viewport its growing child, so the
 * pane can sit inside another flex column (a dialog, a chat panel) and shrink
 * to it, as long as the root itself is given `min-h-0` there. Give it a
 * definite height, or a constrained flex slot; on an unconstrained one it just
 * grows to its content and never scrolls.
 *
 * Never put the main page in one of these: the page scrolls on the document,
 * and that is what keeps the address bar, pull-to-refresh and find-in-page
 * working on a phone. Never nest two for the same content either.
 *
 * Three looks, all from the theme's tokens (see `.scroll-area` in index.css):
 * `ocean` by default, `violet` for an AI conversation, `minimal` for dense
 * operational screens - a table, a queue - where colour would be noise.
 *
 * This file is kept identical in all four apps; `scroll-area-sync.test.ts`
 * fails the build when the copies drift.
 */
import { forwardRef } from 'react';
import type { ComponentPropsWithoutRef, ComponentRef, ReactNode, Ref, UIEventHandler } from 'react';
import * as Radix from '@radix-ui/react-scroll-area';

type ViewportProps = ComponentPropsWithoutRef<typeof Radix.Viewport>;

export type ScrollAreaProps = Omit<ComponentPropsWithoutRef<typeof Radix.Root>, 'asChild' | 'onScroll' | 'children'> & {
  children?: ReactNode;
  /** The name a screen reader announces for the scrolling region. Omit it only when `viewportProps` names it. */
  label?: string;
  orientation?: 'vertical' | 'horizontal' | 'both';
  variant?: 'ocean' | 'violet' | 'minimal';
  /** The element that actually scrolls. */
  viewportRef?: Ref<HTMLDivElement> | undefined;
  /** Scroll events from the element that actually scrolls. */
  onViewportScroll?: UIEventHandler<HTMLDivElement> | undefined;
  viewportProps?: Omit<ViewportProps, 'asChild' | 'children' | 'onScroll'> & Record<`data-${string}`, unknown>;
  /** Whether the viewport takes focus, so a keyboard can scroll it. Defaults to yes. */
  focusable?: boolean;
};

const cx = (...parts: Array<string | false | null | undefined>): string => parts.filter(Boolean).join(' ');

export const ScrollArea = forwardRef<ComponentRef<typeof Radix.Root>, ScrollAreaProps>(function ScrollArea(
  {
    children,
    label,
    orientation = 'vertical',
    variant = 'ocean',
    type = 'auto',
    dir,
    className,
    viewportRef,
    onViewportScroll,
    viewportProps,
    focusable = true,
    ...rootProps
  },
  forwardedRef,
) {
  const { className: viewportClassName, ...restViewport } = viewportProps ?? {};
  const vertical = orientation !== 'horizontal';
  const horizontal = orientation !== 'vertical';
  // Radix flips the bar for right-to-left only when told to; follow the page.
  const direction =
    dir ?? (typeof document !== 'undefined' && document.documentElement.dir === 'rtl' ? 'rtl' : undefined);

  return (
    <Radix.Root
      {...rootProps}
      ref={forwardedRef}
      type={type}
      {...(direction === undefined ? {} : { dir: direction })}
      data-variant={variant}
      data-orientation={orientation}
      className={cx('scroll-area', className)}
    >
      <Radix.Viewport
        {...(label === undefined ? {} : { role: 'region', 'aria-label': label })}
        {...(focusable ? { tabIndex: 0 } : {})}
        {...restViewport}
        ref={viewportRef}
        onScroll={onViewportScroll}
        className={cx('scroll-area__viewport', viewportClassName)}
      >
        {children}
      </Radix.Viewport>
      {vertical && (
        <Radix.Scrollbar orientation="vertical" className="scroll-area__track">
          <Radix.Thumb className="scroll-area__thumb" />
        </Radix.Scrollbar>
      )}
      {horizontal && (
        <Radix.Scrollbar orientation="horizontal" className="scroll-area__track">
          <Radix.Thumb className="scroll-area__thumb" />
        </Radix.Scrollbar>
      )}
      {vertical && horizontal && <Radix.Corner className="scroll-area__corner" />}
    </Radix.Root>
  );
});

/**
 * The chat kit: the keyboard rules, the scroll decisions and the timeline.
 *
 * SHARED FILE - see the note in `chat-scroll.ts`. It runs in both apps, so
 * the storefront and the console are held to the same behaviour by the same
 * test.
 *
 * jsdom does no layout, so the scroll tests give the viewport a simulated
 * one: every item is ITEM pixels tall, the viewport shows VIEW pixels, and
 * `scrollTop` is clamped the way a browser clamps it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { composerKeyAction, outgoingText } from './composer';
import { useChatScroll } from './chat-scroll';
import { ChatComposer } from './primitives';
import { buildTimeline, dayLabel, firstUnreadKey, initialsOf, linkify } from './timeline';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// The composer
// ---------------------------------------------------------------------------

const LABELS = { label: 'Message', placeholder: 'Write…', send: 'Send', hint: 'Enter to send', touchHint: 'Tap Send' };

/** A composer the way a screen uses it: the parent owns the draft and clears it on send. */
function Composer({
  onSend,
  canSend = true,
  clearOnSend = true,
  initial = '',
}: {
  onSend: (text: string) => void;
  canSend?: boolean;
  clearOnSend?: boolean;
  initial?: string;
}): React.JSX.Element {
  const [draft, setDraft] = useState(initial);
  return (
    <ChatComposer
      value={draft}
      onChange={setDraft}
      onSend={(text) => {
        onSend(text);
        if (clearOnSend) setDraft('');
      }}
      canSend={canSend}
      labels={LABELS}
      leading={
        <button type="button" data-testid="attach">
          attach
        </button>
      }
    />
  );
}

function box(): HTMLTextAreaElement {
  return screen.getByLabelText('Message');
}

function type(text: string): void {
  fireEvent.change(box(), { target: { value: text } });
}

/** Fires Enter and says whether the browser's default (a new line) was stopped. */
function press(options: Partial<KeyboardEventInit> & { keyCode?: number } = {}): boolean {
  return !fireEvent.keyDown(box(), { key: 'Enter', code: 'Enter', ...options });
}

describe('the composer', () => {
  it('sends on Enter, exactly once, and never inserts a line', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    type('Hello');
    expect(press()).toBe(true);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('Hello');
    expect(box().value).toBe('');
  });

  it('starts a new line on Shift+Enter and sends nothing', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    type('Line one');
    expect(press({ shiftKey: true })).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('sends nothing for an empty or whitespace-only draft', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    press();
    type('   \n\t  ');
    press();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('trims the outside of a message and keeps the line breaks inside it', () => {
    expect(outgoingText('  first line\n\nsecond line \n ')).toBe('first line\n\nsecond line');
    expect(outgoingText(' \n ')).toBeNull();
  });

  it('leaves Enter alone while an input method is composing', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    type('にほ');
    expect(press({ isComposing: true })).toBe(false);
    fireEvent.compositionStart(box());
    press();
    fireEvent.compositionEnd(box());
    // Safari's Enter that ends a composition.
    press({ keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();
    press();
    expect(onSend).toHaveBeenCalledWith('にほ');
  });

  it('does not send a multi-line paste', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    fireEvent.paste(box());
    type('pasted\nacross\nlines');
    expect(onSend).not.toHaveBeenCalled();
    expect(box().value).toBe('pasted\nacross\nlines');
  });

  it('sends once from the Send button and puts focus back in the box', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    type('By button');
    const send = screen.getByRole('button', { name: 'Send' });
    send.focus();
    fireEvent.click(send);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(box());
  });

  it('sends one message for a held key, rapid presses, and a click on top', () => {
    const onSend = vi.fn();
    // A parent that has not cleared the draft yet: the worst case.
    render(<Composer onSend={onSend} clearOnSend={false} />);
    type('Only once');
    press();
    press({ repeat: true });
    press();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledTimes(1);
    // A changed draft is a new message.
    type('Only once, edited');
    press();
    expect(onSend).toHaveBeenCalledTimes(2);
  });

  it('sends nothing while the conversation cannot take a message', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} canSend={false} initial="Closed" />);
    press();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('does not send when Enter is pressed on another control', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} initial="Draft" />);
    fireEvent.keyDown(screen.getByTestId('attach'), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('keeps Enter as a new line on a touch keyboard, where Send is the button', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
    const onSend = vi.fn();
    render(<Composer onSend={onSend} initial="On a phone" />);
    expect(press()).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByText('Tap Send')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('lets a menu that claimed Enter keep it', () => {
    const state = { composing: false, newlineOnEnter: false, enterClaimed: false };
    const event = { key: 'Enter', shiftKey: false, preventDefault: () => undefined };
    expect(composerKeyAction(event, state)).toBe('send');
    expect(composerKeyAction({ ...event, defaultPrevented: true }, state)).toBe('ignore');
    expect(composerKeyAction(event, { ...state, enterClaimed: true })).toBe('ignore');
    expect(composerKeyAction({ ...event, ctrlKey: true }, state)).toBe('default');
    expect(composerKeyAction({ ...event, key: 'a' }, state)).toBe('default');
  });
});

// ---------------------------------------------------------------------------
// Scrolling
// ---------------------------------------------------------------------------

const ITEM = 50;
const VIEW = 500;
const tops = new WeakMap<Element, number>();
let resize: (() => void) | null = null;

function isViewport(element: Element): boolean {
  return (element as HTMLElement).dataset['testid'] === 'viewport';
}
function heightOf(element: Element): number {
  return element.querySelectorAll('[data-chat-key]').length * ITEM;
}

beforeEach(() => {
  resize = null;
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return isViewport(this) ? Math.max(VIEW, heightOf(this)) : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return isViewport(this) ? VIEW : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement) {
      return tops.get(this) ?? 0;
    },
    set(this: HTMLElement, value: number) {
      const max = Math.max(0, this.scrollHeight - this.clientHeight);
      tops.set(this, Math.min(max, Math.max(0, value)));
    },
  });
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
    const viewport = this.closest('[data-testid="viewport"]');
    const index = Number(this.dataset['index'] ?? 0);
    const top = isViewport(this) || viewport === null ? 0 : index * ITEM - viewport.scrollTop;
    return { top, bottom: top + ITEM, left: 0, right: 0, width: 0, height: ITEM, x: 0, y: top, toJSON: () => ({}) };
  };
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe(): void {}
      disconnect(): void {}
    },
  );
});

function keys(from: number, to: number): string[] {
  return Array.from({ length: to - from }, (_, index) => `m-${from + index}`);
}

function Scroller({
  conversation = 'a',
  items,
  own = false,
  anchor = null,
  onTop,
}: {
  conversation?: string;
  items: string[];
  own?: boolean;
  anchor?: string | null;
  onTop?: () => void;
}): React.JSX.Element {
  const scroll = useChatScroll({
    conversationKey: conversation,
    ready: true,
    firstKey: items[0] ?? null,
    lastKey: items.at(-1) ?? null,
    count: items.length,
    lastIsOwn: own,
    initialAnchorKey: anchor,
    onReachTop: onTop,
  });
  return (
    <>
      <div data-testid="viewport" ref={scroll.viewportRef} onScroll={scroll.onScroll}>
        <div ref={scroll.contentRef}>
          {items.map((key, index) => (
            <div key={key} data-chat-key={key} data-index={index} />
          ))}
        </div>
      </div>
      <output data-testid="state">{`${scroll.isPinned ? 'pinned' : 'reading'} ${scroll.newCount}`}</output>
      {!scroll.isPinned && (
        <button type="button" onClick={scroll.jumpToLatest}>
          jump
        </button>
      )}
    </>
  );
}

function viewport(): HTMLElement {
  return screen.getByTestId('viewport');
}
function bottom(count: number): number {
  return count * ITEM - VIEW;
}
function readAt(top: number): void {
  viewport().scrollTop = top;
  fireEvent.scroll(viewport());
}
function state(): string {
  return screen.getByTestId('state').textContent;
}

describe('the message history', () => {
  it('opens at the newest message when nothing is unread', () => {
    render(<Scroller items={keys(0, 40)} />);
    expect(viewport().scrollTop).toBe(bottom(40));
    expect(state()).toBe('pinned 0');
  });

  it('opens at the first unread message, with a little of what came before', () => {
    render(<Scroller items={keys(0, 40)} anchor="m-20" />);
    expect(viewport().scrollTop).toBe(20 * ITEM - 48);
    expect(state()).toBe('reading 0');
  });

  it('follows a new message when the reader is at the bottom', () => {
    const { rerender } = render(<Scroller items={keys(0, 40)} />);
    rerender(<Scroller items={keys(0, 41)} />);
    expect(viewport().scrollTop).toBe(bottom(41));
    expect(state()).toBe('pinned 0');
  });

  it('keeps the reader’s place for a new message while they read older ones, and counts it', () => {
    const { rerender } = render(<Scroller items={keys(0, 40)} />);
    readAt(300);
    rerender(<Scroller items={keys(0, 42)} />);
    expect(viewport().scrollTop).toBe(300);
    expect(state()).toBe('reading 2');

    fireEvent.click(screen.getByRole('button', { name: 'jump' }));
    expect(viewport().scrollTop).toBe(bottom(42));
    expect(state()).toBe('pinned 0');
  });

  it('always scrolls to the reader’s own message', () => {
    const { rerender } = render(<Scroller items={keys(0, 40)} />);
    readAt(100);
    rerender(<Scroller items={[...keys(0, 40), 'p-mine']} own />);
    expect(viewport().scrollTop).toBe(bottom(41));
    expect(state()).toBe('pinned 0');
  });

  it('keeps the same message in view when older messages load above', () => {
    const onTop = vi.fn();
    const { rerender } = render(<Scroller items={keys(50, 100)} onTop={onTop} />);
    readAt(40);
    expect(onTop).toHaveBeenCalled();
    rerender(<Scroller items={keys(0, 100)} onTop={onTop} />);
    // Fifty messages were added above, so the offset grew by fifty items.
    expect(viewport().scrollTop).toBe(40 + 50 * ITEM);
    expect(state()).toBe('reading 0');
  });

  it('starts again for a different conversation', () => {
    const { rerender } = render(<Scroller conversation="a" items={keys(0, 40)} />);
    readAt(0);
    rerender(<Scroller conversation="b" items={keys(100, 130)} />);
    expect(viewport().scrollTop).toBe(bottom(30));
    expect(state()).toBe('pinned 0');
  });

  it('does not count a removed message as news', () => {
    const { rerender } = render(<Scroller items={[...keys(0, 40), 'p-failed']} />);
    readAt(100);
    rerender(<Scroller items={keys(0, 40)} />);
    expect(state()).toBe('reading 0');
  });

  it('does not jump when something resizes while the reader is reading older messages', () => {
    render(<Scroller items={keys(0, 40)} />);
    readAt(200);
    act(() => {
      resize?.();
    });
    expect(viewport().scrollTop).toBe(200);
  });

  it('stays at the bottom when something resizes while pinned', () => {
    render(<Scroller items={keys(0, 40)} />);
    // The keyboard opening, a picture decoding: the height changed.
    tops.set(viewport(), 1000);
    act(() => {
      resize?.();
    });
    expect(viewport().scrollTop).toBe(bottom(40));
  });

  it('handles a history of several hundred messages', () => {
    const { rerender } = render(<Scroller items={keys(300, 600)} />);
    expect(viewport().scrollTop).toBe(bottom(300));
    readAt(10);
    rerender(<Scroller items={keys(0, 600)} />);
    expect(viewport().scrollTop).toBe(10 + 300 * ITEM);
  });
});

// ---------------------------------------------------------------------------
// The timeline
// ---------------------------------------------------------------------------

interface Row {
  id: string;
  at: string;
  by: string | null;
}

const rules = (firstUnread: string | null = null) => ({
  keyOf: (row: Row) => row.id,
  timeOf: (row: Row) => row.at,
  authorOf: (row: Row) => row.by,
  firstUnreadKey: firstUnread,
  timeZone: 'UTC',
});

describe('the timeline', () => {
  const rows: Row[] = [
    { id: 'a', at: '2026-09-23T10:00:00Z', by: 'CUSTOMER' },
    { id: 'b', at: '2026-09-23T10:01:00Z', by: 'CUSTOMER' },
    { id: 'c', at: '2026-09-23T10:02:00Z', by: 'ADMIN' },
    { id: 'd', at: '2026-09-23T10:30:00Z', by: 'ADMIN' },
    { id: 'e', at: '2026-09-23T10:31:00Z', by: null },
    { id: 'f', at: '2026-09-24T09:00:00Z', by: 'ADMIN' },
  ];

  it('groups one author’s messages written close together', () => {
    const items = buildTimeline(rows, rules()).filter((entry) => entry.kind === 'item');
    expect(items.map((entry) => [entry.key, entry.groupStart, entry.groupEnd])).toEqual([
      ['a', true, false],
      ['b', false, true],
      ['c', true, true],
      // Twenty-eight minutes later is a new group.
      ['d', true, true],
      // A system event never groups.
      ['e', true, true],
      ['f', true, true],
    ]);
  });

  it('starts each day with a separator, in the reader’s time zone', () => {
    const days = buildTimeline(rows, rules()).flatMap((entry) => (entry.kind === 'day' ? [entry] : []));
    expect(days.map((entry) => entry.day)).toEqual(['2026-09-23', '2026-09-24']);
  });

  it('marks where unread starts, and breaks the group there', () => {
    const timeline = buildTimeline(rows, rules('b'));
    const at = timeline.findIndex((entry) => entry.kind === 'unread');
    expect(timeline[at + 1]?.key).toBe('b');
    const b = timeline[at + 1];
    expect(b?.kind === 'item' && b.groupStart).toBe(true);
  });

  it('finds the first unread message from the server’s count', () => {
    const theirs = (row: Row): boolean => row.by === 'ADMIN';
    expect(firstUnreadKey(rows, 0, theirs, (row) => row.id)).toBeNull();
    expect(firstUnreadKey(rows, 2, theirs, (row) => row.id)).toBe('d');
    expect(firstUnreadKey(rows, 99, theirs, (row) => row.id)).toBe('c');
  });

  it('says today and yesterday, and a date otherwise', () => {
    const now = new Date('2026-09-24T12:00:00Z');
    const words = { today: 'Today', yesterday: 'Yesterday' };
    expect(dayLabel('2026-09-24', 'en-GB', words, now, 'UTC')).toBe('Today');
    expect(dayLabel('2026-09-23', 'en-GB', words, now, 'UTC')).toBe('Yesterday');
    expect(dayLabel('2026-09-01', 'en-GB', words, now, 'UTC')).toBe('Tuesday 1 September');
    expect(dayLabel('2025-12-31', 'en-GB', words, now, 'UTC')).toContain('2025');
  });

  it('makes links only of plain http and https addresses', () => {
    expect(linkify('see https://example.com/a.').map((part) => part.kind)).toEqual(['text', 'link', 'text']);
    expect(linkify('javascript:alert(1)')).toEqual([{ kind: 'text', text: 'javascript:alert(1)' }]);
    expect(linkify('data:text/html,<b>x</b>')).toEqual([{ kind: 'text', text: 'data:text/html,<b>x</b>' }]);
    // A link that hides a sign-in in front of the host is not made clickable.
    expect(linkify('https://bank.example@evil.example/').every((part) => part.kind === 'text')).toBe(true);
  });

  it('takes initials from a name, never from an address', () => {
    expect(initialsOf('Sikka Pvt Ltd')).toBe('SP');
    expect(initialsOf('Ölmez')).toBe('ÖL');
    expect(initialsOf(null)).toBe('');
  });
});

/**
 * The flipping word.
 *
 * What is worth testing here is not the animation — jsdom has no layout, no
 * computed transform and no frames, so "the letters stagger in" is not a fact
 * this suite can hold. Four things around the animation are, and every one of
 * them is a way the upstream component was wrong before it was adapted:
 *
 *   - **The word advances, once, per duration.** The original's effect
 *     depended on the `words` array itself, so a caller passing an inline
 *     array — which is how its own demo is written, and how the greeting
 *     writes it — re-armed a new uncleaned timer on every render. Two flips
 *     from one wait is the shape that failure takes.
 *   - **A screen reader is told one steady word.** The moving copy is split
 *     into a span per letter and rebuilt every few seconds; reading it is
 *     reading the line aloud again and again, spelt out.
 *   - **`prefers-reduced-motion` gets no timer at all**, not a faster one.
 *   - **The line has no accessibility violations**, which is what stops the
 *     `aria-hidden` copy and the `sr-only` copy from being both or neither.
 *
 * `components/ui/flip-words.tsx` records why each of those had to change.
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlipWords } from './flip-words';
import { expectNoA11yViolations } from '@/test/axe';

const WORDS = ['Sourcing', 'Intelligence', 'Optimism'];

/** jsdom has no media queries; this is the smallest stand-in. */
function stubReducedMotion(reduce: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduce,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

/**
 * The word arriving, letters and all.
 *
 * The moving copy is a span per letter, so it has no text of its own and
 * `getByText` cannot find it - which is also why it is the copy that carries
 * `aria-hidden`. The *last* of them, because while a word is leaving there
 * are two: the outgoing one still in place and the incoming one after it.
 */
function shownWord(container: HTMLElement): string {
  const copies = container.querySelectorAll('[aria-hidden="true"]');

  return copies[copies.length - 1]?.textContent ?? '';
}

/**
 * The word anything but an eye receives.
 *
 * Deliberately the *first* word rather than the current one: a line whose
 * accessible name rewrites itself every three seconds is a line a screen
 * reader starts over, mid-sentence, forever. Finding two of these would be
 * the bug.
 */
function spokenWord(): HTMLElement {
  return screen.getByText(/^(Sourcing|Intelligence|Optimism)$/);
}

beforeEach(() => {
  stubReducedMotion(false);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the flipping word', () => {
  it('opens on the first word', () => {
    render(<FlipWords words={WORDS} />);

    expect(spokenWord()).toHaveTextContent('Sourcing');
  });

  it('says the word once, and hides the moving copy from assistive technology', () => {
    const { container } = render(<FlipWords words={WORDS} />);

    // One copy reaches a screen reader, and it is the still one.
    expect(spokenWord()).toHaveClass('sr-only');

    // The copy that moves is the one that is hidden, not the other way round.
    const moving = container.querySelector('[aria-hidden="true"]');
    expect(moving).not.toBeNull();
    expect(moving).toHaveTextContent('Sourcing');
  });

  it('advances one word per duration, and no further while the old one leaves', () => {
    // An inline array, on purpose: this is the shape that re-armed an
    // uncleaned timer on every render upstream.
    const { container, rerender } = render(
      <FlipWords words={['Sourcing', 'Intelligence', 'Optimism']} duration={3000} />,
    );

    act(() => {
      vi.advanceTimersByTime(2999);
    });
    expect(shownWord(container)).toBe('Sourcing');

    // A render that changes nothing must not restart the wait either.
    rerender(<FlipWords words={['Sourcing', 'Intelligence', 'Optimism']} duration={3000} />);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(shownWord(container)).toBe('Intelligence');

    // The next wait is armed off the back of the exit finishing, and nothing
    // finishes leaving without frames. A third word here would mean a timer
    // had been left running behind the first - the leak the adaptation exists
    // to close.
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(shownWord(container)).toBe('Intelligence');

    // And the spoken copy stayed put while the shown one moved.
    expect(spokenWord()).toHaveTextContent('Sourcing');
  });

  it('never moves, and arms nothing, under reduced motion', () => {
    stubReducedMotion(true);
    const { container } = render(<FlipWords words={WORDS} duration={3000} />);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(screen.getByText('Sourcing')).toBeInTheDocument();
    expect(screen.queryByText('Intelligence')).not.toBeInTheDocument();

    // No hidden second copy either: with nothing moving, the plain word is
    // the whole component and a duplicate would just be noise in the page.
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it('holds still for a single word, rather than replacing it with itself', () => {
    const { container } = render(<FlipWords words={['Sourcing']} />);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(shownWord(container)).toBe('Sourcing');
  });

  it('has no accessibility violations', async () => {
    vi.useRealTimers();
    const { container } = render(
      <p>
        <b>Northgate Supply</b> <FlipWords words={WORDS} />
      </p>,
    );

    await expectNoA11yViolations(container);
  });
});

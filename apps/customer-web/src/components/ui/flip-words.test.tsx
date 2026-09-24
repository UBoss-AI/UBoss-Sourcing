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
 *
 * ---
 *
 * WHOLE PHRASES, AND THE LABEL THAT COVERS THEM
 *
 * The greeting no longer cycles one word after the shop's name. It alternates
 * two complete phrases under it — "Source with Intelligence" and "Deliver with
 * Confidence" — and
 * that changes what "told once" has to mean: announcing only the first would
 * leave the other unreachable, and announcing them as they change would re-read
 * the line every four seconds. The second half of this file is that case.
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

// ---------------------------------------------------------------------------
// Whole phrases
// ---------------------------------------------------------------------------

const STRAPLINE = 'Source with Intelligence';
const ATTRIBUTION = 'Deliver with Confidence';
const LABEL = `${STRAPLINE}. ${ATTRIBUTION}.`;

/** The non-breaking space the animation puts between a phrase's words. */
const NBSP = String.fromCharCode(0xa0);

/** Every moving copy on screen, with the ordinary spaces put back. */
function shownPhrases(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[aria-hidden="true"]')].map((node) =>
    node.textContent.replaceAll(NBSP, ' '),
  );
}

describe('a rotation of whole phrases', () => {
  it('opens on the first and moves on to the second', () => {
    const { container } = render(
      <FlipWords words={[STRAPLINE, ATTRIBUTION]} duration={4200} srLabel={LABEL} />,
    );

    expect(shownPhrases(container)).toEqual([STRAPLINE]);

    act(() => {
      vi.advanceTimersByTime(4200);
    });

    // The outgoing phrase is still in place while it leaves, so what is
    // asserted is that the second has arrived rather than that the first has
    // gone.
    expect(shownPhrases(container)).toContain(ATTRIBUTION);
  });

  it('never goes back to a name the headline used to cycle', () => {
    const { container } = render(
      <FlipWords words={[STRAPLINE, ATTRIBUTION]} duration={4200} srLabel={LABEL} />,
    );

    for (let step = 0; step < 6; step++) {
      act(() => {
        vi.advanceTimersByTime(4200);
      });

      const text = shownPhrases(container).join(' ');
      for (const retired of ['UBOSS Sourcing', 'UBOSS Intelligence', 'UBOSS Innovation']) {
        expect(text).not.toContain(retired);
      }
    }
  });

  it('leaves no timer behind when it is unmounted', () => {
    const { unmount } = render(
      <FlipWords words={[STRAPLINE, ATTRIBUTION]} duration={4200} srLabel={LABEL} />,
    );

    expect(vi.getTimerCount()).toBeGreaterThan(0);

    unmount();

    // Nothing pending, so nothing can call `setState` on a component that is
    // no longer there.
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('the label that covers every phrase', () => {
  it('is what a screen reader is told, instead of the rotation', () => {
    const { container } = render(<FlipWords words={[STRAPLINE, ATTRIBUTION]} srLabel={LABEL} />);

    expect(container.querySelector('.sr-only')).toHaveTextContent(LABEL);
  });

  it('does not change when the phrase does', () => {
    const { container } = render(
      <FlipWords words={[STRAPLINE, ATTRIBUTION]} duration={4200} srLabel={LABEL} />,
    );

    act(() => {
      vi.advanceTimersByTime(4200);
    });

    expect(container.querySelector('.sr-only')).toHaveTextContent(LABEL);
  });

  it('is never in a live region', () => {
    // The whole reason the label exists rather than an announcement: a phrase
    // swapping itself inside `aria-live` interrupts a screen-reader user every
    // four seconds for as long as the page is open.
    const { container } = render(<FlipWords words={[STRAPLINE, ATTRIBUTION]} srLabel={LABEL} />);

    expect(container.querySelector('[aria-live]')).toBeNull();
  });

  it('still reaches a visitor who asked for less movement', () => {
    stubReducedMotion(true);
    const { container } = render(
      <FlipWords words={[STRAPLINE, ATTRIBUTION]} duration={4200} srLabel={LABEL} />,
    );

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    // Still, and still complete: the one drawn phrase is hidden from
    // assistive technology and the label carries both, so a reduced-motion
    // visitor is told the same message as everybody else rather than only
    // whichever phrase happens to be first.
    expect(shownPhrases(container)).toEqual([STRAPLINE]);
    expect(container.querySelector('.sr-only')).toHaveTextContent(LABEL);
  });

  it('is the first word where the caller gave none', () => {
    // The original behaviour, which is right when the rotation is one word
    // inside a sentence the rest of the line already carries.
    const { container } = render(<FlipWords words={WORDS} />);

    expect(container.querySelector('.sr-only')).toHaveTextContent('Sourcing');
  });
});

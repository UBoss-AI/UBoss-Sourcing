/**
 * The product card's lean, and the three cases where it must not happen.
 *
 * The effect itself is a few degrees of `rotateY` and a highlight, and a test
 * cannot see whether that looks good. What it can hold down is the set of
 * rules that make it safe to ship on a page that draws forty of these:
 *
 *   1. **A mouse tilts it, a finger does not.** A touch screen has no hover, so
 *      a tilt driven by touch would fire as a tap landed and then stay leaning
 *      until the next tap somewhere else — a card stuck at an angle, which
 *      reads as a rendering fault rather than as a hover effect.
 *   2. **`prefers-reduced-motion` gets nothing.** Checked in the hook as well
 *      as in the stylesheet, so the two cannot disagree.
 *   3. **Leaving puts it back.** The properties are *removed* rather than set
 *      to zero, so the resting state has exactly one definition and it lives
 *      in the CSS.
 *
 * jsdom lays nothing out, so `getBoundingClientRect` returns zeros and the
 * hook would divide by them. The box is stubbed here for that reason — see
 * `stubBox` — which also makes the expected angles arithmetic rather than
 * guesswork.
 */
import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductCard } from './ProductCard';
import { makeProduct } from '@/test/fixtures';
import { renderWithProviders } from '@/test/harness';

/**
 * A pointer event React will actually read `pointerType` off.
 *
 * jsdom implements no `PointerEvent`, so Testing Library's
 * `fireEvent.pointerOver` falls back to a generic event and the `pointerType`
 * in its init never reaches the object React copies from — every case below
 * then looks like "a mouse was ignored", which is the opposite of what is
 * being tested. A `MouseEvent` carries the coordinates properly and the one
 * missing property is defined onto it.
 *
 * `pointerover` and `pointerout`, not `pointerenter`/`pointerleave`: React
 * derives the enter and leave pair from the bubbling pair, so those are the
 * events a real browser would deliver here too.
 */
function firePointer(
  element: HTMLElement,
  type: 'pointerover' | 'pointermove' | 'pointerout',
  init: { pointerType?: string; clientX?: number; clientY?: number } = {},
): void {
  const { pointerType = 'mouse', clientX = 0, clientY = 0 } = init;
  const event = new MouseEvent(type, { bubbles: true, clientX, clientY });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  element.dispatchEvent(event);
}

/**
 * A 200x400 card at the origin, so the middle is (100, 200).
 *
 * Spied rather than assigned, so vitest owns the restore: a
 * `getBoundingClientRect` left stubbed leaks into every test file that runs
 * after this one in the same worker, and the symptom there is somebody else's
 * layout assertion failing for no reason they can see.
 */
function stubBox(): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 200,
    bottom: 400,
    width: 200,
    height: 400,
    toJSON: () => ({}),
  });
}

function card(): HTMLElement {
  // The card is an `article` with no accessible name of its own, so it is
  // reached through the product name inside it.
  const heading = screen.getByRole('heading', { name: /IV Administration Set/ });
  const element = heading.closest('article');
  if (element === null) throw new Error('the card is not an <article> any more');
  return element;
}

function tiltOf(element: HTMLElement): Record<string, string> {
  return {
    x: element.style.getPropertyValue('--tilt-x'),
    y: element.style.getPropertyValue('--tilt-y'),
    gx: element.style.getPropertyValue('--tilt-gx'),
    gy: element.style.getPropertyValue('--tilt-gy'),
  };
}

/** The hook coalesces into a frame, so the frame has to be let through. */
async function nextFrame(): Promise<void> {
  await new Promise((resolve) => {
    requestAnimationFrame(() => {
      resolve(null);
    });
  });
}

beforeEach(() => {
  stubBox();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderCard(): void {
  renderWithProviders(<ProductCard product={makeProduct({ name: 'IV Administration Set' })} />);
}

/** jsdom has no media queries; this is the smallest stand-in. */
function stubReducedMotion(reduce: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduce,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

describe('the product card lean', () => {
  it('rests flat, with the angles left to the stylesheet', () => {
    renderCard();

    // Nothing inline: the resting transform is `.tilt`'s own fallbacks.
    expect(tiltOf(card())).toEqual({ x: '', y: '', gx: '', gy: '' });
    expect(card()).toHaveClass('tilt');
  });

  it('leans away from a mouse, in the direction the pointer is', async () => {
    renderCard();
    const element = card();

    // The bottom-right corner of a 200x400 box: dx = +1, dy = +1.
    firePointer(element, 'pointerover', { pointerType: 'mouse', clientX: 200, clientY: 400 });
    await nextFrame();

    // `rotateX` is negated, so a pointer at the bottom tips the *far* edge
    // away rather than the near one. Getting this backwards is the one bug
    // here that still looks like an effect.
    expect(tiltOf(element)).toEqual({
      x: '-6.00deg',
      y: '6.00deg',
      gx: '50.0%',
      gy: '50.0%',
    });

    // And the opposite corner is the mirror image, which is what says the
    // centre of the card is the centre of the effect.
    firePointer(element, 'pointermove', { pointerType: 'mouse', clientX: 0, clientY: 0 });
    await nextFrame();

    expect(tiltOf(element)).toEqual({
      x: '6.00deg',
      y: '-6.00deg',
      gx: '-50.0%',
      gy: '-50.0%',
    });
  });

  it('is flat in the middle, where there is no direction to lean', async () => {
    renderCard();
    const element = card();

    firePointer(element, 'pointerover', { pointerType: 'mouse', clientX: 100, clientY: 200 });
    await nextFrame();

    expect(tiltOf(element)).toEqual({
      x: '0.00deg',
      y: '0.00deg',
      gx: '0.0%',
      gy: '0.0%',
    });
  });

  it('ignores a finger, because a touch screen has no hover', async () => {
    renderCard();
    const element = card();

    firePointer(element, 'pointerover', { pointerType: 'touch', clientX: 200, clientY: 400 });
    firePointer(element, 'pointermove', { pointerType: 'touch', clientX: 180, clientY: 380 });
    await nextFrame();

    // A card left leaning after a tap is a card that looks broken until the
    // next tap somewhere else.
    expect(tiltOf(element)).toEqual({ x: '', y: '', gx: '', gy: '' });
  });

  it('ignores a mouse move that did not follow a pointer entering', async () => {
    renderCard();
    const element = card();

    // No `pointerenter`, so no box was measured. A move on its own must not
    // reach for a rect that was never taken — which on a real page would be a
    // layout read on every mouse event.
    firePointer(element, 'pointermove', { pointerType: 'mouse', clientX: 200, clientY: 400 });
    await nextFrame();

    expect(tiltOf(element)).toEqual({ x: '', y: '', gx: '', gy: '' });
  });

  it('does nothing at all when reduced motion is asked for', async () => {
    stubReducedMotion(true);
    renderCard();
    const element = card();

    firePointer(element, 'pointerover', { pointerType: 'mouse', clientX: 200, clientY: 400 });
    firePointer(element, 'pointermove', { pointerType: 'mouse', clientX: 150, clientY: 300 });
    await nextFrame();

    expect(tiltOf(element)).toEqual({ x: '', y: '', gx: '', gy: '' });
  });

  it('puts the card back when the pointer leaves', async () => {
    renderCard();
    const element = card();

    firePointer(element, 'pointerover', { pointerType: 'mouse', clientX: 200, clientY: 400 });
    await nextFrame();
    expect(tiltOf(element).x).toBe('-6.00deg');

    firePointer(element, 'pointerout');

    // Removed, not zeroed: `.tilt`'s fallbacks are the single definition of
    // flat, and a `0deg` left inline would quietly become a second one.
    expect(tiltOf(element)).toEqual({ x: '', y: '', gx: '', gy: '' });
  });
});

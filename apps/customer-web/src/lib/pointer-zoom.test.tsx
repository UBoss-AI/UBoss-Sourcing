/**
 * The product image magnifier, and the rules that keep it out of the way.
 *
 * What a test cannot see is whether a zoom looks right, so what is held down
 * here is the arithmetic and the exemptions:
 *
 *   1. **Where the pointer is, as 0 to 1 on each axis.** The CSS turns those
 *      two numbers into the transform — see `.zoom-layer` in index.css — so
 *      getting them wrong is the one way the magnifier lands somewhere other
 *      than where somebody pointed.
 *   2. **Clamped to the box.** A pointer can be reported a fraction outside
 *      the box on the last frame of a hover, and an out-of-range value slides
 *      the layer past its own edge and shows the frame behind it.
 *   3. **A mouse only.** A finger has no hover: on a touch screen the zoom
 *      would open on a tap and stay open until the next tap somewhere else.
 *   4. **Leaving resets it**, by removing rather than re-centring, so the
 *      resting position has one definition and it lives in the stylesheet.
 *
 * Tested through a probe rather than through `ProductPage`, which needs the
 * product, the market, the session and four API reads before it will render an
 * image at all — none of which this behaviour touches. The probe is the same
 * two elements the gallery has.
 *
 * jsdom lays nothing out, so the box is stubbed. That also makes the expected
 * numbers arithmetic rather than guesswork.
 */
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePointerZoom } from './pointer-zoom';

/**
 * A pointer event React will read `pointerType` off.
 *
 * jsdom implements no `PointerEvent`, so Testing Library's `fireEvent` cannot
 * carry `pointerType` onto the object React copies from, and every case here
 * would look like "a mouse was ignored". `pointerover` / `pointerout` rather
 * than the enter/leave pair, because React derives enter and leave from the
 * bubbling pair — which is what a browser delivers too.
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

/** A 400x200 box at (100, 50), so the middle is (300, 150). */
function stubBox(): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 100,
    y: 50,
    left: 100,
    top: 50,
    right: 500,
    bottom: 250,
    width: 400,
    height: 200,
    toJSON: () => ({}),
  });
}

function Probe(): React.JSX.Element {
  const zoom = usePointerZoom();

  return (
    <div
      data-testid="viewport"
      ref={zoom.ref}
      onPointerEnter={zoom.onPointerEnter}
      onPointerMove={zoom.onPointerMove}
      onPointerLeave={zoom.onPointerLeave}
      className="zoom-viewport"
    >
      <img alt="" className="zoom-layer" src="/x.jpg" />
    </div>
  );
}

function viewport(): HTMLElement {
  return screen.getByTestId('viewport');
}

function state(element: HTMLElement): Record<string, string | null> {
  return {
    u: element.style.getPropertyValue('--zoom-u'),
    v: element.style.getPropertyValue('--zoom-v'),
    zooming: element.dataset.zooming ?? null,
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
});

describe('the product image magnifier', () => {
  it('rests with nothing written, so the stylesheet decides where the layer sits', () => {
    render(<Probe />);

    expect(state(viewport())).toEqual({ u: '', v: '', zooming: null });
  });

  it('reports where in the box the pointer is, as a fraction of each side', async () => {
    render(<Probe />);
    const element = viewport();

    // The middle of a 400x200 box at (100, 50).
    firePointer(element, 'pointerover', { clientX: 300, clientY: 150 });
    await nextFrame();

    expect(state(element)).toEqual({ u: '0.5000', v: '0.5000', zooming: 'true' });

    // A quarter across and three quarters down.
    firePointer(element, 'pointermove', { clientX: 200, clientY: 200 });
    await nextFrame();

    expect(state(element)).toEqual({ u: '0.2500', v: '0.7500', zooming: 'true' });
  });

  it('clamps to the box, so the layer can never slide off its own edge', async () => {
    render(<Probe />);
    const element = viewport();

    firePointer(element, 'pointerover', { clientX: 300, clientY: 150 });
    await nextFrame();

    // Past the right and below the bottom, which is what the last frame of a
    // fast exit reports.
    firePointer(element, 'pointermove', { clientX: 640, clientY: 400 });
    await nextFrame();
    expect(state(element)).toMatchObject({ u: '1.0000', v: '1.0000' });

    // And past the left and above the top.
    firePointer(element, 'pointermove', { clientX: -40, clientY: -40 });
    await nextFrame();
    expect(state(element)).toMatchObject({ u: '0.0000', v: '0.0000' });
  });

  it('ignores a finger, because a touch screen has no hover', async () => {
    render(<Probe />);
    const element = viewport();

    firePointer(element, 'pointerover', { pointerType: 'touch', clientX: 200, clientY: 200 });
    firePointer(element, 'pointermove', { pointerType: 'touch', clientX: 210, clientY: 210 });
    await nextFrame();

    // `zooming` is what the CSS keys the layer's visibility off, so a tap that
    // set it would leave a 2.5x image on screen until the next tap elsewhere.
    expect(state(element)).toEqual({ u: '', v: '', zooming: null });
  });

  it('ignores a move that did not follow a pointer arriving', async () => {
    render(<Probe />);
    const element = viewport();

    // No `pointerover`, so no box was measured. A move on its own must not
    // reach for a rect that was never taken — on a real page that would be a
    // layout read on every mouse event.
    firePointer(element, 'pointermove', { clientX: 200, clientY: 200 });
    await nextFrame();

    expect(state(element)).toEqual({ u: '', v: '', zooming: null });
  });

  it('closes and forgets when the pointer leaves', async () => {
    render(<Probe />);
    const element = viewport();

    firePointer(element, 'pointerover', { clientX: 200, clientY: 200 });
    await nextFrame();
    expect(state(element).zooming).toBe('true');

    firePointer(element, 'pointerout');

    // Removed, not re-centred: `.zoom-layer`'s own 0.5 fallbacks are the
    // single definition of where an un-pointed layer rests.
    expect(state(element)).toEqual({ u: '', v: '', zooming: null });
  });
});

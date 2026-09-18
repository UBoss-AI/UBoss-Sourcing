/**
 * The sweep itself, driven one frame at a time.
 *
 * `vanish.test.tsx` covers the part of this that works with no canvas at all —
 * which is the path the rest of the suite runs on, because jsdom has no 2D
 * context and `test/setup.ts` makes it say so honestly. This file is the other
 * half: a canvas that *does* answer, so the loop can be stepped and the two
 * things that would hang it can be asserted.
 *
 * **That it finishes.** The loop re-arms itself from inside its own frame, and
 * the field's real text is transparent for as long as it is running. A
 * termination condition that is never met is not a glitch — it is a composer
 * whose message cannot be read, permanently.
 *
 * **That it finishes even when no frame ever runs.** `requestAnimationFrame`
 * does not fire in a background tab. Somebody who presses Send and switches
 * tab in the same second parks the sweep part-way, and it would stay parked
 * for as long as they were away. The deadline is what ends it regardless, and
 * a timer — unlike a frame — is not parked.
 *
 * Neither is observable in a real browser from a test, and both are the kind
 * of thing that is only ever found by the person it happens to.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { useVanish } from './vanish';

// ---------------------------------------------------------------------------
// A canvas that answers
// ---------------------------------------------------------------------------

/** Every `clearRect` the loop made, in order. The sweep, as a list. */
let clearedFrom: number[] = [];

/**
 * Put back for every other file in the run — `test/setup.ts` owns this.
 *
 * Kept as a property descriptor rather than as the method itself: a bare
 * reference to a prototype method is an unbound one, which the lint rules here
 * reject, and rightly — it is only safe because the only thing done with it is
 * to put it back where the call site supplies `this`.
 */
const realGetContext = Object.getOwnPropertyDescriptor(
  HTMLCanvasElement.prototype,
  'getContext',
);

/**
 * A 2D context that behaves enough like one.
 *
 * `getImageData` returns a band of opaque pixels across the top-left of the
 * canvas — a stand-in for painted text. What matters is that the alpha test in
 * `paint` finds something, so that there are particles for the loop to sweep.
 */
function fakeContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  return {
    canvas,
    font: '',
    fillStyle: '',
    strokeStyle: '',
    textBaseline: 'top',
    measureText: (text: string) => ({ width: text.length * 8 }),
    fillText: () => undefined,
    fillRect: () => undefined,
    clearRect: (x: number) => {
      clearedFrom.push(x);
    },
    getImageData: (_x: number, _y: number, width: number, height: number) => {
      const data = new Uint8ClampedArray(width * height * 4);
      // One opaque band, forty pixels tall and a quarter of the width.
      for (let y = 0; y < Math.min(40, height); y += 1) {
        for (let x = 0; x < Math.floor(width / 4); x += 1) {
          const at = (y * width + x) * 4;
          data[at] = 255;
          data[at + 1] = 255;
          data[at + 2] = 255;
          data[at + 3] = 255;
        }
      }
      return { data, width, height };
    },
  } as unknown as CanvasRenderingContext2D;
}

// ---------------------------------------------------------------------------
// A frame clock this test owns
// ---------------------------------------------------------------------------

let frames = new Map<number, () => void>();
let nextFrameId = 1;

/**
 * Run one frame, and let whatever it schedules be the next one.
 *
 * Cancellation is honoured rather than stubbed away — a queue that ignores
 * `cancelAnimationFrame` would report the second of these three tests as
 * passing whether or not the code under it cancelled anything.
 */
function step(): void {
  const due = [...frames.values()];
  frames = new Map();
  act(() => {
    for (const frame of due) frame();
  });
}

// ---------------------------------------------------------------------------

function Harness(): React.JSX.Element {
  const field = useRef<HTMLTextAreaElement>(null);
  const { canvasRef, isVanishing, vanish } = useVanish(field);

  return (
    <div>
      <canvas ref={canvasRef} data-testid="canvas" />
      <textarea ref={field} defaultValue="" data-testid="field" />
      <output data-testid="state">{isVanishing ? 'vanishing' : 'still'}</output>
      <button
        type="button"
        onClick={() => {
          vanish('a question long enough to wrap onto more than one line of the box');
        }}
      >
        Send
      </button>
    </div>
  );
}

beforeEach(() => {
  clearedFrom = [];
  frames = new Map();
  nextFrameId = 1;
  vi.useFakeTimers();

  /*
   * `getContext` is replaced rather than spied on.
   *
   * It is overloaded once per context type, so a single-signature stand-in
   * lines up with none of them: `vi.spyOn(...).mockImplementation` is rejected
   * by the compiler, and the double assertion that satisfies the compiler is
   * then rejected by the lint rule that objects to unnecessary assertions.
   * Defining the property takes an untyped value, which is the honest shape of
   * what this is — a double for one overload and no other. `test/setup.ts`
   * stands in for absent jsdom methods the same way.
   */
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    writable: true,
    value: function getContext(this: HTMLCanvasElement) {
      return fakeContext(this);
    },
  });

  // jsdom reports every box as 0x0, and `paint` refuses a field with no size —
  // rightly, since there would be nothing to paint into.
  vi.spyOn(HTMLTextAreaElement.prototype, 'clientWidth', 'get').mockReturnValue(600);
  vi.spyOn(HTMLTextAreaElement.prototype, 'clientHeight', 'get').mockReturnValue(40);

  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
    const id = nextFrameId;
    nextFrameId += 1;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();

  if (realGetContext !== undefined) {
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', realGetContext);
  }
});

describe('the sweep', () => {
  it('runs, moves right to left, and comes to an end', () => {
    render(<Harness />);

    act(() => {
      screen.getByRole('button', { name: 'Send' }).click();
    });

    expect(screen.getByTestId('state')).toHaveTextContent('vanishing');

    // The loop re-arms itself from inside its own frame, so it is stepped
    // rather than run. The bound is the assertion: a sweep that has not
    // finished in this many frames is one that never will.
    let stepped = 0;
    while (frames.size > 0 && stepped < 600) {
      step();
      stepped += 1;
    }

    expect(screen.getByTestId('state')).toHaveTextContent('still');
    expect(stepped).toBeLessThan(600);

    // Right to left, and it crosses the whole of the text: the last band
    // cleared is at or past the left edge of what was painted.
    expect(clearedFrom.length).toBeGreaterThan(10);
    const sweep = clearedFrom.slice(1);
    expect(sweep[0]).toBeGreaterThan(sweep[sweep.length - 1] ?? 0);
    expect(sweep[sweep.length - 1]).toBeLessThanOrEqual(0);
  });

  it('ends on its own when no frame ever runs, as in a background tab', () => {
    render(<Harness />);

    act(() => {
      screen.getByRole('button', { name: 'Send' }).click();
    });

    expect(screen.getByTestId('state')).toHaveTextContent('vanishing');

    // Not one frame is delivered — which is exactly what a browser does with a
    // tab nobody is looking at. Without the deadline the field's text would
    // stay transparent under a half-finished picture until the tab came back.
    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(screen.getByTestId('state')).toHaveTextContent('still');
  });

  it('cancels the sweep already running when a second send starts one', () => {
    render(<Harness />);
    const send = screen.getByRole('button', { name: 'Send' });

    act(() => {
      send.click();
    });
    step();
    const afterFirst = clearedFrom.length;

    act(() => {
      send.click();
    });

    // Two live loops writing to one canvas is a flicker with no owner: each
    // frame clears what the other has just drawn. The second send wins, and
    // the frame the first one had queued is dropped rather than run.
    expect(frames.size).toBe(1);

    let stepped = 0;
    while (frames.size > 0 && stepped < 600) {
      step();
      stepped += 1;
    }

    expect(clearedFrom.length).toBeGreaterThan(afterFirst);
    expect(screen.getByTestId('state')).toHaveTextContent('still');
  });
});

/**
 * The vanish, and the placeholder clock.
 *
 * jsdom has no 2D canvas context, so the particles themselves cannot be
 * asserted on here and are not what would go wrong quietly. What would is
 * everything around them:
 *
 *   - **That a missing canvas is survivable.** `useVanish` is used by the AI
 *     composer, which every AI Mode test renders. If it threw — or got stuck
 *     with `isVanishing` true and the real text hidden under a picture that
 *     never arrives — sending a message would stop working in this suite and,
 *     more to the point, in any browser that refuses a context.
 *   - **That the placeholder clock is one timer.** The original leaves a new
 *     interval behind on every render and another on every return to the tab.
 *     A count is what makes that visible.
 *   - **That a hidden tab parks it**, rather than queueing up a burst of
 *     changes for the moment somebody comes back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useCyclingPlaceholder, useVanish } from './vanish';
import { PlaceholdersAndVanishInput } from './placeholders-and-vanish-input';
import { useRef } from 'react';

const PLACEHOLDERS = ['What do you need?', 'Ask us anything', 'Start with a question'];

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  setVisibility('visible');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the vanish', () => {
  it('survives a browser that will not give it a canvas context', () => {
    const { result } = renderHook(() => {
      const field = useRef<HTMLTextAreaElement>(null);
      return useVanish(field);
    });

    act(() => {
      result.current.vanish('a question that cannot be painted');
    });

    // Not stuck. The field's own text is hidden while `isVanishing` is true,
    // so a vanish that starts and never finishes leaves the composer looking
    // empty with a message still in it.
    expect(result.current.isVanishing).toBe(false);
  });

  it('does not clear the field it was given', () => {
    // The whole reason `useVanish` takes a ref instead of owning an input:
    // `AiModePage` holds the draft until the API has accepted it and puts it
    // back on a 401. An animation that cleared would take the words with it.
    const { result } = renderHook(() => {
      const field = useRef<HTMLTextAreaElement>(null);
      return useVanish(field);
    });

    expect(result.current).not.toHaveProperty('setValue');
    expect(Object.keys(result.current).sort()).toEqual(['canvasRef', 'isVanishing', 'vanish']);
  });
});

describe('the placeholder clock', () => {
  it('moves on, and wraps round', () => {
    const { result } = renderHook(() => useCyclingPlaceholder(PLACEHOLDERS.length, false));

    expect(result.current).toBe(0);

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current).toBe(1);

    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(result.current).toBe(0);
  });

  it('parks while the tab is hidden, and does not queue anything up', () => {
    const { result } = renderHook(() => useCyclingPlaceholder(PLACEHOLDERS.length, false));

    act(() => {
      setVisibility('hidden');
      vi.advanceTimersByTime(30_000);
    });

    // Ten changes' worth of time passed behind another tab. None of them
    // happened, and none of them are waiting.
    expect(result.current).toBe(0);

    act(() => {
      setVisibility('visible');
      vi.advanceTimersByTime(3000);
    });
    expect(result.current).toBe(1);
  });

  it('runs exactly one timer, however many times it re-renders', () => {
    const { rerender } = renderHook(() => useCyclingPlaceholder(PLACEHOLDERS.length, false));

    for (let index = 0; index < 5; index += 1) rerender();

    // The original arms its interval off the `placeholders` array, which its
    // own demo passes as a literal — a new identity every render, so every
    // render leaves another live timer behind. This one is armed off a number.
    expect(vi.getTimerCount()).toBe(1);
  });

  it('stops while the field has something in it', () => {
    const { result } = renderHook(() => useCyclingPlaceholder(PLACEHOLDERS.length, true));

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    // Suggestions that keep rewriting themselves beside words somebody is in
    // the middle of typing are a distraction, not a prompt.
    expect(result.current).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never reads past the end of a list that has shrunk', () => {
    const { result, rerender } = renderHook(({ count }) => useCyclingPlaceholder(count, false), {
      initialProps: { count: 3 },
    });

    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(result.current).toBe(2);

    rerender({ count: 2 });
    expect(result.current).toBe(0);
  });
});

describe('the whole control', () => {
  it('names its field and its button, and hands the value to the caller', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onSubmit = vi.fn();

    render(
      <PlaceholdersAndVanishInput
        placeholders={PLACEHOLDERS}
        label="Search the catalogue"
        submitLabel="Search"
        onSubmit={onSubmit}
      />,
    );

    // The placeholders cycle, so they cannot be the field's accessible name,
    // and the button is an icon on its own. Both are the failure this checks.
    const field = screen.getByRole('textbox', { name: 'Search the catalogue' });
    const submit = screen.getByRole('button', { name: 'Search' });

    expect(submit).toBeDisabled();

    await user.type(field, 'cannula');
    await user.click(submit);

    expect(onSubmit).toHaveBeenCalledWith('cannula');
    expect(screen.getByRole('textbox')).toHaveValue('');
  });
});

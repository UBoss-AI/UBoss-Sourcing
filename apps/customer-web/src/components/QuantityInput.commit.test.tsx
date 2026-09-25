/**
 * When a quantity counts as the buyer's answer.
 *
 * Typing 1000 must be one commit, of 1000 - never 1, 10 and 100 on the way.
 * A stepper press and an arrow key are deliberate steps and commit at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { renderWithProviders } from '@/test/harness';
import type { PurchaseRules } from '@/lib/types';
import { QuantityInput, TYPING_SETTLE_MS, type QuantityCommitSource } from './QuantityInput';

const RULES: PurchaseRules = { minOrderQty: 1, maxOrderQty: null, qtyIncrement: 1 } as PurchaseRules;

function Harness({ onCommit }: { onCommit: (n: number, s: QuantityCommitSource, p: number) => void }) {
  const [value, setValue] = useState(1);
  return <QuantityInput value={value} onChange={setValue} onCommit={onCommit} rules={RULES} />;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('QuantityInput commits', () => {
  it('commits typed digits once, after the pause, with the final value', () => {
    const onCommit = vi.fn();
    renderWithProviders(<Harness onCommit={onCommit} />);
    const box = screen.getByRole('spinbutton');

    for (const value of ['1', '10', '100', '1000']) {
      fireEvent.change(box, { target: { value } });
      act(() => {
        vi.advanceTimersByTime(200);
      });
    }
    expect(onCommit).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(TYPING_SETTLE_MS);
    });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(1_000, 'typed', 1);
  });

  it('commits on Enter and does not commit the same number again on blur', () => {
    const onCommit = vi.fn();
    renderWithProviders(<Harness onCommit={onCommit} />);
    const box = screen.getByRole('spinbutton');
    fireEvent.change(box, { target: { value: '501' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.blur(box);
    act(() => {
      vi.advanceTimersByTime(TYPING_SETTLE_MS * 2);
    });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(501, 'typed', 1);
  });

  it('commits a stepper press at once, as a step', () => {
    const onCommit = vi.fn();
    renderWithProviders(<Harness onCommit={onCommit} />);
    fireEvent.click(screen.getByRole('button', { name: /increase quantity/i }));
    expect(onCommit).toHaveBeenCalledWith(2, 'step', 1);
  });

  it('reads a pasted "1,000" as a thousand and commits it at once', () => {
    const onCommit = vi.fn();
    renderWithProviders(<Harness onCommit={onCommit} />);
    fireEvent.paste(screen.getByRole('spinbutton'), { clipboardData: { getData: () => '1,000' } });
    expect(onCommit).toHaveBeenCalledWith(1_000, 'typed', 1);
    expect(screen.getByRole('spinbutton')).toHaveValue(1_000);
  });

  it('refuses a pasted negative, fraction or exponent, and commits nothing', () => {
    const onCommit = vi.fn();
    renderWithProviders(<Harness onCommit={onCommit} />);
    const box = screen.getByRole('spinbutton');
    for (const [text, message] of [
      ['-5', 'Enter a quantity above zero.'],
      ['2.5', 'Enter a whole number of pieces.'],
      ['1e3', 'Enter a quantity using digits only.'],
      ['0', 'Enter a quantity of at least 1.'],
      ['200000000', 'Enter at most 100,000,000.'],
    ] as const) {
      fireEvent.paste(box, { clipboardData: { getData: () => text } });
      expect(screen.getByRole('alert')).toHaveTextContent(message);
      expect(box).toHaveAttribute('aria-invalid', 'true');
    }
    act(() => {
      vi.advanceTimersByTime(TYPING_SETTLE_MS * 2);
    });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('blocks e, + and - from being typed at all', () => {
    renderWithProviders(<Harness onCommit={vi.fn()} />);
    const box = screen.getByRole('spinbutton');
    for (const key of ['e', 'E', '+', '-']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      box.dispatchEvent(event);
      expect(event.defaultPrevented, key).toBe(true);
    }
  });

  it('puts the last good quantity back when a fraction is left in the box', () => {
    const onCommit = vi.fn();
    renderWithProviders(<Harness onCommit={onCommit} />);
    const box = screen.getByRole('spinbutton');
    fireEvent.change(box, { target: { value: '7' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.change(box, { target: { value: '7.5' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a whole number of pieces.');
    fireEvent.blur(box);
    expect(box).toHaveValue(7);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(7, 'typed', 1);
  });

  it('commits an arrow-key change at once, as a step', () => {
    const onCommit = vi.fn();
    renderWithProviders(<Harness onCommit={onCommit} />);
    const box = screen.getByRole('spinbutton');
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    fireEvent.change(box, { target: { value: '2' } });
    expect(onCommit).toHaveBeenCalledWith(2, 'step', 1);
  });
});

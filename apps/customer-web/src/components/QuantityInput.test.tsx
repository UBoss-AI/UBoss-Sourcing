/**
 * Typing a quantity.
 *
 * The reported fault: clear the box with Backspace and it filled with 0; type
 * 1000 after that and it read "01000". An empty box must stay empty while it
 * is being retyped, and what is typed must read as the number it is.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { renderWithProviders } from '@/test/harness';
import type { PurchaseRules } from '@/lib/types';
import { QuantityInput } from './QuantityInput';

const RULES = { minOrderQty: 1, maxOrderQty: null, qtyIncrement: 1 } as unknown as PurchaseRules;

function Harness({ rules = RULES, start = 5 }: { rules?: PurchaseRules; start?: number }): React.JSX.Element {
  const [value, setValue] = useState(start);
  return (
    <>
      <QuantityInput value={value} onChange={setValue} rules={rules} label="Quantity" />
      <output data-testid="value">{value}</output>
    </>
  );
}

function box(): HTMLInputElement {
  return screen.getByRole('spinbutton', { name: 'Quantity' });
}

describe('typing a quantity', () => {
  it('stays empty when cleared, and reads 1000 when 1000 is typed', () => {
    renderWithProviders(<Harness />);
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: '' } });
    expect(box().value).toBe('');
    // The page keeps the last good quantity while the box is empty.
    expect(screen.getByTestId('value').textContent).toBe('5');

    for (const typed of ['1', '10', '100', '1000']) fireEvent.change(box(), { target: { value: typed } });
    expect(box().value).toBe('1000');
    expect(screen.getByTestId('value').textContent).toBe('1000');
  });

  it('drops a leading zero as it is typed', () => {
    renderWithProviders(<Harness />);
    fireEvent.change(box(), { target: { value: '01000' } });
    expect(box().value).toBe('1000');
    expect(screen.getByTestId('value').textContent).toBe('1000');
  });

  it('settles an empty box on the minimum, and a typed one on the rules, when it is left', () => {
    const rules = { minOrderQty: 10, maxOrderQty: null, qtyIncrement: 5 } as unknown as PurchaseRules;
    renderWithProviders(<Harness rules={rules} start={10} />);
    fireEvent.change(box(), { target: { value: '' } });
    fireEvent.blur(box());
    expect(box().value).toBe('10');

    fireEvent.change(box(), { target: { value: '23' } });
    fireEvent.blur(box());
    expect(box().value).toBe(screen.getByTestId('value').textContent);
    expect(Number(box().value) % 5).toBe(0);
  });

  it('still steps from what was typed', () => {
    renderWithProviders(<Harness />);
    fireEvent.change(box(), { target: { value: '40' } });
    fireEvent.blur(box());
    fireEvent.click(screen.getByRole('button', { name: /increase/i }));
    expect(box().value).toBe('41');
  });
});

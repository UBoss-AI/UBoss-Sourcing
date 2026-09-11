/**
 * The calendar field.
 *
 * What is asserted is the behaviour a buyer would notice, and the behaviour
 * that would cost them if it broke:
 *
 *   - a day inside the notice period cannot be chosen, and is visibly not
 *     available rather than silently refused;
 *   - the day it hands back is the day that was clicked — the timezone trap
 *     this component was written to avoid;
 *   - the keyboard can reach every day, and Escape gives focus back;
 *   - the earliest available day is one press away, because a greyed-out
 *     fortnight is a rule nobody has stated.
 */
import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DatePicker } from './DatePicker';
import { renderWithProviders } from '@/test/harness';

/** The calendar, once it is open. */
function panel(): HTMLElement {
  return screen.getByRole('dialog');
}

function day(iso: string): HTMLElement {
  const cell = panel().querySelector<HTMLElement>(`[data-iso="${iso}"]`);
  if (cell === null) throw new Error(`no cell for ${iso}`);
  return cell;
}

describe('opening it', () => {
  it('shows the month the current value is in', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <DatePicker label="Delivery date" value="2026-09-24" onChange={vi.fn()} />,
    );

    // The trigger names the field and the value: a button's accessible name
    // comes from its content, so the surrounding label alone would leave a
    // screen reader announcing a date with no idea what it is the date of.
    const trigger = screen.getByRole('button', { name: /Delivery date: .*24 September 2026/i });
    await user.click(trigger);

    expect(panel()).toBeInTheDocument();
    expect(within(panel()).getByText('September 2026')).toBeInTheDocument();
    expect(day('2026-09-24')).toHaveAttribute('aria-pressed', 'true');
  });

  it('opens on the earliest available month when there is no value', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <DatePicker label="Delivery date" value="" min="2026-11-18" onChange={vi.fn()} />,
    );

    await user.click(screen.getByRole('button', { name: /Delivery date: no date chosen/i }));

    expect(within(panel()).getByText('November 2026')).toBeInTheDocument();
  });
});

describe('the notice period', () => {
  it('will not let a day inside it be chosen', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    renderWithProviders(
      <DatePicker
        label="Delivery date"
        value="2026-09-24"
        min="2026-09-18"
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Delivery date/i }));

    // Disabled, not merely styled: a native date input enforces `min`
    // silently, and being refused with no explanation is the thing this
    // component replaced.
    expect(day('2026-09-14')).toBeDisabled();
    expect(day('2026-09-17')).toBeDisabled();
    expect(day('2026-09-18')).toBeEnabled();

    await user.click(day('2026-09-14'));

    expect(onChange).not.toHaveBeenCalled();
    // And the panel stays open, so nothing looks like it worked.
    expect(panel()).toBeInTheDocument();
  });

  it('says the rule in words and offers the earliest day in one press', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    renderWithProviders(
      <DatePicker label="Delivery date" value="" min="2026-09-18" onChange={onChange} />,
    );

    await user.click(screen.getByRole('button', { name: /Delivery date/i }));

    expect(within(panel()).getByText(/earliest date we can take is 18 Sept 2026/i)).toBeInTheDocument();

    await user.click(within(panel()).getByRole('button', { name: /choose it/i }));

    expect(onChange).toHaveBeenCalledWith('2026-09-18');
  });

  it('still shows a value that has fallen inside the period, rather than losing it', async () => {
    const user = userEvent.setup();

    // A plan created weeks ago: its start date is now inside the notice window.
    renderWithProviders(
      <DatePicker
        label="Delivery date"
        value="2026-09-10"
        min="2026-09-18"
        onChange={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Delivery date: .*10 September/i }));

    // Marked as the selection even though it can no longer be re-chosen —
    // silently blanking somebody's saved date would be worse than showing it.
    expect(day('2026-09-10')).toHaveAttribute('aria-pressed', 'true');
    // And the keyboard lands on the first day they could move it to.
    expect(day('2026-09-18')).toHaveFocus();
  });
});

describe('choosing a day', () => {
  it('hands back the day that was clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    renderWithProviders(
      <DatePicker label="Delivery date" value="2026-09-24" onChange={onChange} />,
    );

    await user.click(screen.getByRole('button', { name: /Delivery date/i }));
    await user.click(day('2026-09-30'));

    // Not the 29th. A picker that shows one date and reports another is the
    // one bug this component exists to make impossible.
    expect(onChange).toHaveBeenCalledWith('2026-09-30');
  });

  it('closes and gives focus back to the field', async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <DatePicker label="Delivery date" value="2026-09-24" onChange={vi.fn()} />,
    );

    const trigger = screen.getByRole('button', { name: /Delivery date/i });
    await user.click(trigger);
    await user.click(day('2026-09-30'));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(trigger).toHaveFocus();
  });

  it('reaches a neighbouring month without paging', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    renderWithProviders(
      <DatePicker label="Delivery date" value="2026-09-24" onChange={onChange} />,
    );

    await user.click(screen.getByRole('button', { name: /Delivery date/i }));
    // The trailing days of the grid are real dates, and clicking the 1st of
    // next month is a thing people do.
    await user.click(day('2026-10-01'));

    expect(onChange).toHaveBeenCalledWith('2026-10-01');
  });
});

describe('paging months', () => {
  it('moves forwards and back', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <DatePicker label="Delivery date" value="2026-09-24" onChange={vi.fn()} />,
    );

    await user.click(screen.getByRole('button', { name: /Delivery date/i }));

    await user.click(within(panel()).getByRole('button', { name: /next month/i }));
    expect(within(panel()).getByText('October 2026')).toBeInTheDocument();

    await user.click(within(panel()).getByRole('button', { name: /previous month/i }));
    expect(within(panel()).getByText('September 2026')).toBeInTheDocument();
  });

  it('will not page back past a month with nothing available in it', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <DatePicker label="Delivery date" value="2026-09-24" min="2026-09-18" onChange={vi.fn()} />,
    );

    await user.click(screen.getByRole('button', { name: /Delivery date/i }));

    // August holds no selectable day, so there is nowhere to go.
    expect(within(panel()).getByRole('button', { name: /previous month/i })).toBeDisabled();
  });

  it('does page back to a month that still holds one', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <DatePicker label="Delivery date" value="2026-10-05" min="2026-09-18" onChange={vi.fn()} />,
    );

    await user.click(screen.getByRole('button', { name: /Delivery date/i }));

    // September is worth going back to for the 18th through the 30th, even
    // though its 1st is out of range.
    expect(within(panel()).getByRole('button', { name: /previous month/i })).toBeEnabled();
  });
});

describe('the keyboard', () => {
  it('moves by a day, by a week and by a month', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <DatePicker label="Delivery date" value="2026-09-24" onChange={vi.fn()} />,
    );

    await user.click(screen.getByRole('button', { name: /Delivery date/i }));
    expect(day('2026-09-24')).toHaveFocus();

    await user.keyboard('{ArrowRight}');
    expect(day('2026-09-25')).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(day('2026-10-02')).toHaveFocus();

    // The view follows the focus out of the month, or the focused day would
    // not be on screen.
    expect(within(panel()).getByText('October 2026')).toBeInTheDocument();

    await user.keyboard('{PageUp}');
    expect(day('2026-09-02')).toHaveFocus();
  });

  it('chooses the focused day with Enter', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    renderWithProviders(
      <DatePicker label="Delivery date" value="2026-09-24" onChange={onChange} />,
    );

    await user.click(screen.getByRole('button', { name: /Delivery date/i }));
    await user.keyboard('{ArrowRight}{Enter}');

    expect(onChange).toHaveBeenCalledWith('2026-09-25');
  });

  it('closes on Escape and puts focus back on the field', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    renderWithProviders(
      <DatePicker label="Delivery date" value="2026-09-24" onChange={onChange} />,
    );

    const trigger = screen.getByRole('button', { name: /Delivery date/i });
    await user.click(trigger);
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    // A keyboard user dropped at the top of the document has lost their place.
    expect(trigger).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps one day in the tab order, not thirty-five', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <DatePicker label="Delivery date" value="2026-09-24" onChange={vi.fn()} />,
    );

    await user.click(screen.getByRole('button', { name: /Delivery date/i }));

    const tabbable = [...panel().querySelectorAll('[data-iso]')].filter(
      (cell) => cell.getAttribute('tabindex') === '0',
    );

    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toHaveAttribute('data-iso', '2026-09-24');
  });
});

describe('when it is disabled', () => {
  it('does not open', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <DatePicker label="Delivery date" value="2026-09-24" disabled onChange={vi.fn()} />,
    );

    const trigger = screen.getByRole('button', { name: /Delivery date/i });
    expect(trigger).toBeDisabled();

    await user.click(trigger);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

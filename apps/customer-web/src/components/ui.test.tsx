/**
 * The error summary, tested for the one thing that made the logistics sign-in
 * screen unusable on the second attempt: **a self-focusing element that
 * focuses itself again on every render.**
 *
 * The summary is meant to take the cursor when it appears, so a keyboard or
 * screen-reader user is put on the problem rather than left at the submit
 * button. What it must not do is take the cursor again on every render of the
 * form behind it - because a form that has been submitted once re-validates on
 * every keystroke, so "every render" means "every character somebody types
 * while fixing the very errors this box is listing".
 *
 * That is the difference between a callback ref React attaches once and an
 * inline arrow it reattaches on every render, and nothing but a test of what
 * happens on the second render can tell the two apart.
 */
import { useState } from 'react';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ErrorSummary, Input } from './ui';
import { renderWithProviders as render } from '@/test/harness';

/**
 * A form with one field and a summary above it, the shape every checkout step
 * in this app has: the summary stays up while the customer fixes the field,
 * and the field is controlled, so every keystroke is a render.
 */
function FormWithSummary(): React.JSX.Element {
  const [value, setValue] = useState('');

  return (
    <form>
      <ErrorSummary title="Check these" errors={[{ message: 'A postcode is needed.' }]} />
      <label htmlFor="postcode">Postcode</label>
      <input
        id="postcode"
        value={value}
        onChange={(event) => {
          setValue(event.currentTarget.value);
        }}
      />
    </form>
  );
}

describe('the form-level error summary', () => {
  it('takes the cursor when it appears', () => {
    render(<FormWithSummary />);

    expect(document.activeElement).toBe(screen.getByRole('alert'));
  });

  it('leaves the cursor alone while the customer fixes the field', () => {
    render(<FormWithSummary />);

    const postcode = screen.getByLabelText('Postcode');
    postcode.focus();

    // Three characters, three renders. Under an inline ref every one of them
    // would have thrown the cursor back onto the summary.
    for (const value of ['S', 'W', '1']) {
      fireEvent.change(postcode, { target: { value } });
      expect(document.activeElement).toBe(postcode);
    }
  });

  it('renders nothing at all when there is nothing wrong', () => {
    render(<ErrorSummary errors={[]} />);

    expect(screen.queryByRole('alert')).toBeNull();
  });

  // Nothing about the summary should have changed the field beside it.
  it('still renders a plain field unfocused', () => {
    render(<Input aria-label="Untouched" />);

    expect(document.activeElement).not.toBe(screen.getByLabelText('Untouched'));
  });
});

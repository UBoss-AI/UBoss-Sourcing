/**
 * The seller's registered address, as a form.
 *
 * `lib/business-address.test.ts` holds the RULES — what a valid PIN code is,
 * how an absent part is formatted. These are the things only a rendered form
 * can be held to, and each one is a promise the brief makes:
 *
 *   - Every input has a visible label, and the required ones say so. A
 *     placeholder is never the only label.
 *   - The country picker stores a CODE and shows a NAME, and is reachable and
 *     operable from the keyboard alone.
 *   - The region is a picker where the country has a list and a text box where
 *     it does not.
 *   - Changing the country does not silently submit an incompatible region:
 *     the old value stays on screen and is called out in words.
 *   - The postal code is a text field, so a leading zero survives.
 *   - Errors are attached to their own inputs, which is what makes
 *     `aria-describedby` true rather than decorative.
 */
import { useState } from 'react';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BusinessAddressFields } from './BusinessAddressFields';
import { renderWithProviders, makeLocale } from '@/test/harness';
import { expectNoA11yViolations } from '@/test/axe';
import { EMPTY_BUSINESS_ADDRESS, validateBusinessAddress } from '@/lib/business-address';
import type { AddressProblems, BusinessAddress } from '@/lib/business-address';

/** The countries this deployment serves, as `LocaleProvider` would supply them. */
const COUNTRIES = [
  { code: 'IN', name: 'India', currencyCode: 'INR', phonePrefix: '+91' },
  { code: 'ID', name: 'Indonesia', currencyCode: 'IDR', phonePrefix: '+62' },
  { code: 'NL', name: 'Netherlands', currencyCode: 'EUR', phonePrefix: '+31' },
  { code: 'DE', name: 'Germany', currencyCode: 'EUR', phonePrefix: '+49' },
];

/**
 * The fields, driven by real state.
 *
 * A controlled component tested with a `vi.fn()` onChange and a frozen value
 * can only ever assert the first keystroke. This wrapper is what the real
 * callers do — hold the address, hand it down, take it back — so typing and
 * choosing behave here as they do on the page.
 */
function Harness({
  initial = EMPTY_BUSINESS_ADDRESS,
  problems,
  onValue,
}: {
  initial?: BusinessAddress;
  problems?: AddressProblems;
  onValue?: (value: BusinessAddress) => void;
}): React.JSX.Element {
  const [value, setValue] = useState<BusinessAddress>(initial);

  return (
    <BusinessAddressFields
      value={value}
      {...(problems === undefined ? {} : { problems })}
      onChange={(next) => {
        setValue(next);
        onValue?.(next);
      }}
    />
  );
}

function render(ui: React.ReactElement) {
  return renderWithProviders(ui, { locale: makeLocale({ countries: COUNTRIES }) });
}

describe('the six fields', () => {
  it('gives every input a visible label, and marks the required ones', async () => {
    render(<Harness />);

    // Found by their labels, which is the test: a field reachable only by
    // placeholder is a field a screen reader cannot announce.
    expect(screen.getByLabelText(/address line 1/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/address line 2/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/city/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/state \/ province \/ region/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/pin \/ zip \/ postal code/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/country/i)).toBeInTheDocument();

    // Line 2 is the only optional one, and the asterisk is decoration — this
    // is what a screen reader actually hears.
    const line1 = screen.getByLabelText(/address line 1/i);
    expect(line1.closest('div')?.parentElement?.textContent).toContain('(required)');

    await expectNoA11yViolations(document.body);
  });

  it('carries the autocomplete tokens a browser fills from', () => {
    render(<Harness />);

    expect(screen.getByLabelText(/address line 1/i)).toHaveAttribute(
      'autocomplete',
      'address-line1',
    );
    expect(screen.getByLabelText(/address line 2/i)).toHaveAttribute(
      'autocomplete',
      'address-line2',
    );
    expect(screen.getByLabelText(/city/i)).toHaveAttribute('autocomplete', 'address-level2');
    expect(screen.getByLabelText(/state \/ province \/ region/i)).toHaveAttribute(
      'autocomplete',
      'address-level1',
    );
    expect(screen.getByLabelText(/postal code/i)).toHaveAttribute('autocomplete', 'postal-code');
    expect(screen.getByLabelText(/country/i)).toHaveAttribute('autocomplete', 'country');
  });

  it('pre-fills every saved field when an address is handed in', () => {
    render(
      <Harness
        initial={{
          line1: '42 Industrial Estate',
          line2: 'Phase 2',
          city: 'Noida',
          region: 'Uttar Pradesh (UP)',
          postcode: '201301',
          country: 'IN',
        }}
      />,
    );

    expect(screen.getByLabelText(/address line 1/i)).toHaveValue('42 Industrial Estate');
    expect(screen.getByLabelText(/address line 2/i)).toHaveValue('Phase 2');
    expect(screen.getByLabelText(/city/i)).toHaveValue('Noida');
    expect(screen.getByLabelText(/postal code/i)).toHaveValue('201301');
    // The NAME is shown; the code is what is stored.
    expect(screen.getByLabelText(/country/i)).toHaveValue('India');
    // The region picker is on its code.
    expect(screen.getByLabelText(/state \/ province \/ region/i)).toHaveValue('UP');
  });
});

describe('the country picker', () => {
  it('shows the name and stores the code', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();

    render(<Harness onValue={onValue} />);

    const country = screen.getByLabelText(/country/i);
    await user.click(country);
    await user.type(country, 'Indi');

    // Both India and Indonesia contain "indi"; the one chosen is the one
    // pressed, and what leaves the component is a two-letter code.
    const list = screen.getByRole('listbox', { name: /country/i });
    await user.click(within(list).getByRole('option', { name: /^India/ }));

    expect(onValue).toHaveBeenCalledWith(expect.objectContaining({ country: 'IN' }));
    expect(country).toHaveValue('India');
  });

  it('never stores a position in the list', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();

    render(<Harness onValue={onValue} />);

    const country = screen.getByLabelText(/country/i);
    await user.click(country);

    // Germany is the fourth row. What is stored must be "DE" and nothing that
    // could be mistaken for an index — a stored position points at a different
    // country the first time an operator reorders the table.
    const list = screen.getByRole('listbox', { name: /country/i });
    await user.click(within(list).getByRole('option', { name: /^Germany/ }));

    const stored = onValue.mock.calls.at(-1)?.[0] as BusinessAddress;
    expect(stored.country).toBe('DE');
    expect(stored.country).not.toBe('3');
  });

  it('is operable from the keyboard alone', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();

    render(<Harness onValue={onValue} />);

    const country = screen.getByLabelText(/country/i);

    // Tabbed to, not clicked, and tabbed to through the other five fields —
    // which also pins that the picker is IN the tab order rather than merely
    // focusable, and that it is last, where the layout puts it.
    for (let i = 0; i < 6; i += 1) await user.tab();
    expect(country).toHaveFocus();

    // Focus opens the list with the first row highlighted; one Down moves to
    // the second; Enter chooses it. No pointer is involved at any point, which
    // is the whole assertion.

    await user.keyboard('{ArrowDown}{Enter}');

    expect(onValue).toHaveBeenCalledWith(expect.objectContaining({ country: 'ID' }));
    expect(country).toHaveValue('Indonesia');
  });

  it('searches by name and says when nothing matches', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const country = screen.getByLabelText(/country/i);
    await user.click(country);
    await user.type(country, 'Nether');

    const list = screen.getByRole('listbox', { name: /country/i });
    expect(within(list).getAllByRole('option')).toHaveLength(1);
    expect(within(list).getByRole('option', { name: /^Netherlands/ })).toBeInTheDocument();

    await user.clear(country);
    await user.type(country, 'Atlantis');
    expect(screen.getByText(/no country matches/i)).toBeInTheDocument();
  });

  it('shows a placeholder rather than a country nobody chose', () => {
    render(<Harness />);
    expect(screen.getByLabelText(/country/i)).toHaveAttribute('placeholder', 'Select country');
    expect(screen.getByLabelText(/country/i)).toHaveValue('');
  });
});

describe('the region', () => {
  it('is a picker where the country has a list', () => {
    render(<Harness initial={{ ...EMPTY_BUSINESS_ADDRESS, country: 'IN' }} />);

    const region = screen.getByLabelText(/state \/ province \/ region/i);
    expect(region.tagName).toBe('SELECT');
    // 36 states and union territories, plus the placeholder row.
    expect(within(region).getAllByRole('option')).toHaveLength(37);
    expect(within(region).getByRole('option', { name: 'Gujarat' })).toBeInTheDocument();
  });

  it('falls back to a text box where no reliable list exists', () => {
    // Not a gap: a Dutch business address carries no province anybody writes
    // on an invoice, and a picker would force an answer to an unasked question.
    render(<Harness initial={{ ...EMPTY_BUSINESS_ADDRESS, country: 'NL' }} />);

    const region = screen.getByLabelText(/state \/ province \/ region/i);
    expect(region.tagName).toBe('INPUT');
  });

  it('stores the name and the code together when picked from a list', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();

    render(
      <Harness initial={{ ...EMPTY_BUSINESS_ADDRESS, country: 'IN' }} onValue={onValue} />,
    );

    await user.selectOptions(screen.getByLabelText(/state \/ province \/ region/i), 'GJ');

    expect(onValue).toHaveBeenCalledWith(expect.objectContaining({ region: 'Gujarat (GJ)' }));
  });

  /*
   * The behaviour the brief singles out, and the one it would be easiest to
   * get wrong in the tempting direction.
   */
  it('does not silently drop a region that no longer fits the country', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();

    render(
      <Harness
        initial={{
          line1: '42 Industrial Estate',
          line2: '',
          city: 'Noida',
          region: 'Uttar Pradesh (UP)',
          postcode: '201301',
          country: 'IN',
        }}
        onValue={onValue}
      />,
    );

    const country = screen.getByLabelText(/country/i);
    await user.click(country);
    const list = screen.getByRole('listbox', { name: /country/i });
    await user.click(within(list).getByRole('option', { name: /^Germany/ }));

    // NOT wiped. Wiping is how somebody loses a value they typed and only
    // notices after saving.
    const stored = onValue.mock.calls.at(-1)?.[0] as BusinessAddress;
    expect(stored.region).toBe('Uttar Pradesh (UP)');

    // Said in words, where somebody who cannot see the field change will hear
    // it, with a one-press way out.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Uttar Pradesh/);
    expect(alert).toHaveTextContent(/not a region of the country you have chosen/i);

    await user.click(screen.getByRole('button', { name: /clear the region/i }));
    expect((onValue.mock.calls.at(-1)?.[0] as BusinessAddress).region).toBe('');
  });
});

describe('the postal code', () => {
  it('is a text field, so a leading zero survives', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();

    render(<Harness onValue={onValue} />);

    const postcode = screen.getByLabelText(/postal code/i);
    // `type="number"` is the mistake this pins: a browser would hand back 1234
    // for "01234", and 01234 is a real place in Massachusetts.
    expect(postcode).toHaveAttribute('type', 'text');

    await user.type(postcode, '01234');

    expect(postcode).toHaveValue('01234');
    expect((onValue.mock.calls.at(-1)?.[0] as BusinessAddress).postcode).toBe('01234');
  });

  it('stops at the length the column and the API both hold', () => {
    render(<Harness />);
    expect(screen.getByLabelText(/postal code/i)).toHaveAttribute('maxlength', '20');
  });
});

describe('errors', () => {
  it('attaches each message to its own input', () => {
    const address: BusinessAddress = {
      ...EMPTY_BUSINESS_ADDRESS,
      country: 'IN',
      postcode: '12',
    };

    render(<Harness initial={address} problems={validateBusinessAddress(address)} />);

    const postcode = screen.getByLabelText(/postal code/i);
    expect(postcode).toHaveAttribute('aria-invalid', 'true');

    // The message is REACHABLE from the input rather than merely near it,
    // which is the difference between an accessible error and a red sentence.
    const describedBy = postcode.getAttribute('aria-describedby') ?? '';
    const ids = describedBy.split(' ').filter((id) => id.length > 0);
    const messages = ids
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');

    // India's rule, named with an example rather than only refused.
    expect(messages).toMatch(/valid postal code for the selected country/i);
    expect(messages).toMatch(/380015/);
  });

  it('shows every objection at once rather than the first', () => {
    render(
      <Harness
        initial={EMPTY_BUSINESS_ADDRESS}
        problems={validateBusinessAddress(EMPTY_BUSINESS_ADDRESS)}
      />,
    );

    expect(screen.getByText(/enter the street address/i)).toBeInTheDocument();
    expect(screen.getByText(/enter the city or district/i)).toBeInTheDocument();
    expect(screen.getByText(/enter the state, province or region/i)).toBeInTheDocument();
    expect(screen.getByText(/enter the postal code/i)).toBeInTheDocument();
    expect(screen.getByText(/choose the country/i)).toBeInTheDocument();
  });

  it('has no accessibility violations while showing them', async () => {
    render(
      <Harness
        initial={EMPTY_BUSINESS_ADDRESS}
        problems={validateBusinessAddress(EMPTY_BUSINESS_ADDRESS)}
      />,
    );

    await expectNoA11yViolations(document.body);
  });
});

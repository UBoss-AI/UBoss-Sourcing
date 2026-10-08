/**
 * The seller eligibility card.
 *
 * What it must never do is tell somebody they qualify when the server will
 * refuse them: exactly the minimum is "not met", one paisa more is "met", and
 * the tick alone makes nobody eligible. It also has to work from a keyboard
 * and read in every language the storefront ships.
 */
import { fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { i18n } from '@/i18n/config';
import type { TurnoverPolicy } from '@/lib/turnover';
import { expectNoA11yViolations } from '@/test/axe';
import { renderWithProviders } from '@/test/harness';
import {
  TurnoverEligibilityCard,
} from './TurnoverEligibilityCard';
import {
  emptyTurnoverDraft,
  turnoverInputFor,
  type TurnoverDraft,
} from './turnover-draft';

const POLICY: TurnoverPolicy = {
  required: true,
  minimumMinor: '30000000000',
  currency: 'INR',
  currencyExponent: 2,
  policyVersion: '2026-10',
  financialYearStartMonth: 4,
  suggestedFinancialYear: { start: '2025-04-01', end: '2026-03-31' },
};

let latest: TurnoverDraft | null = null;

function Harness(): React.JSX.Element {
  const [draft, setDraft] = useState<TurnoverDraft>(() => emptyTurnoverDraft(POLICY));
  latest = draft;
  return <TurnoverEligibilityCard policy={POLICY} draft={draft} onChange={setDraft} showShoppingLink />;
}

function amountInput(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>(/Annual turnover \(INR\)/);
}

afterEach(async () => {
  latest = null;
  await i18n.changeLanguage('en');
});

describe('the policy', () => {
  it('states the threshold, the equivalent and that it is a platform policy', () => {
    renderWithProviders(<Harness />);
    expect(screen.getByRole('heading', { name: 'Seller eligibility' })).toBeInTheDocument();
    expect(screen.getByText(/Businesses with annual turnover exceeding ₹30 crore are eligible/)).toBeInTheDocument();
    expect(screen.getByText(/Equivalent to INR 300 million/)).toBeInTheDocument();
    expect(screen.getByText('More than')).toBeInTheDocument();
    expect(screen.getByText(/not a government or legal requirement/)).toBeInTheDocument();
    // The declaration starts unticked.
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });
});

describe('the answer', () => {
  it('says "not met" at exactly the minimum and offers the way back to shopping', () => {
    renderWithProviders(<Harness />);
    fireEvent.change(amountInput(), { target: { value: '30' } });
    expect(screen.getByText(/does not currently meet our seller turnover requirement/)).toBeInTheDocument();
    expect(screen.queryByText('Turnover requirement met.')).toBeNull();
    expect(screen.getByRole('link', { name: 'Continue shopping' })).toHaveAttribute('href', '/');
  });

  it('says "met" one paisa above it, and is still not sendable until the declaration is ticked', () => {
    renderWithProviders(<Harness />);
    fireEvent.change(amountInput(), { target: { value: '30.000000001' } });
    expect(screen.getByText('Turnover requirement met.')).toBeInTheDocument();
    expect(screen.getByText(/Your application is still subject to verification/)).toBeInTheDocument();
    expect(turnoverInputFor(latest as TurnoverDraft, POLICY)).toBeNull();

    fireEvent.click(screen.getByRole('checkbox'));
    expect(turnoverInputFor(latest as TurnoverDraft, POLICY)).toEqual({
      amountMinor: '30000000001',
      currency: 'INR',
      financialYearStart: '2025-04-01',
      financialYearEnd: '2026-03-31',
      declarationAccepted: true,
    });
  });

  it('never shows an eligible state for a ticked box and no figure', () => {
    renderWithProviders(<Harness />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.queryByText('Turnover requirement met.')).toBeNull();
    expect(turnoverInputFor(latest as TurnoverDraft, POLICY)).toBeNull();
  });

  it.each([
    ['-31', /cannot be negative/],
    ['31.0000000001', /no more than 9 decimal places/],
    ['31 crore', /Use digits and at most one decimal point/],
  ])('explains how to correct %j', (value, message) => {
    renderWithProviders(<Harness />);
    fireEvent.change(amountInput(), { target: { value } });
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(amountInput()).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByText('Turnover requirement met.')).toBeNull();
  });
});

describe('the unit switch', () => {
  it('converts what was typed exactly, and back', () => {
    renderWithProviders(<Harness />);
    fireEvent.change(amountInput(), { target: { value: '30.000000001' } });
    fireEvent.click(screen.getByRole('radio', { name: 'INR' }));
    expect(amountInput().value).toBe('300000000.01');
    expect(screen.getByText(/Exactly ₹30,00,00,000\.01/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Crore' }));
    expect(amountInput().value).toBe('30.000000001');
  });
});

describe('access', () => {
  it('has no WCAG 2.1 AA violations, eligible or not', async () => {
    const { container } = renderWithProviders(<Harness />);
    await expectNoA11yViolations(container);
    fireEvent.change(amountInput(), { target: { value: '29' } });
    await expectNoA11yViolations(container);
  });

  it('explains the reporting period on keyboard focus', () => {
    renderWithProviders(<Harness />);
    const info = screen.getByRole('button', { name: 'About the reporting period' });
    info.focus();
    fireEvent.focus(info);
    expect(screen.getByRole('tooltip')).toHaveTextContent(/last full financial year/);
    expect(info).toHaveAttribute('aria-describedby', screen.getByRole('tooltip').id);
  });
});

describe.each(['de', 'el', 'es', 'fr', 'it', 'nl', 'pl'])('in %s', (language) => {
  it('renders translated, with the threshold filled in and no raw keys', async () => {
    await i18n.changeLanguage(language);
    const { container } = renderWithProviders(<Harness />);
    expect(container.textContent).not.toMatch(/seller\.turnover\./);
    expect(container.textContent).not.toContain('Seller eligibility');
    expect(container.textContent).toMatch(/₹30 crore/i);
  });
});

describe('the unit switch from the keyboard', () => {
  it('is one tab stop, and the arrow keys change the unit', () => {
    renderWithProviders(<Harness />);
    const crore = screen.getByRole('radio', { name: 'Crore' });
    const inr = screen.getByRole('radio', { name: 'INR' });
    expect(crore).toHaveAttribute('tabindex', '0');
    expect(inr).toHaveAttribute('tabindex', '-1');
    fireEvent.change(amountInput(), { target: { value: '31' } });
    fireEvent.keyDown(crore, { key: 'ArrowRight' });
    expect(screen.getByRole('radio', { name: 'INR' })).toHaveAttribute('aria-checked', 'true');
    expect(amountInput().value).toBe('310000000');
  });
});

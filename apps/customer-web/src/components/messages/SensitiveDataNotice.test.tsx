/**
 * The warning above message composers (JOURNEY-055): always there, and louder
 * when the draft looks like it carries contact or payment details.
 */
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/harness';
import { detectSensitiveData } from '@/lib/sensitive-data';
import { SensitiveDataNotice } from './SensitiveDataNotice';

describe('detectSensitiveData', () => {
  it('finds nothing in an ordinary message, including an order number', () => {
    expect(detectSensitiveData('Can you ship 1,500 pieces by Friday? Order ORD-2026-000123.')).toEqual([]);
  });

  it('finds an email address', () => {
    expect(detectSensitiveData('Write to me at priya@example.com')).toEqual(['EMAIL']);
  });

  it('finds a telephone number written with spaces', () => {
    expect(detectSensitiveData('Call +49 151 2345 6789')).toEqual(['PHONE']);
  });

  it('finds a card number that passes the Luhn check', () => {
    expect(detectSensitiveData('Card 4111 1111 1111 1111')).toEqual(['CARD']);
  });

  it('finds an IBAN', () => {
    expect(detectSensitiveData('Pay to DE89 3704 0044 0532 0130 00')).toContain('IBAN');
  });
});

describe('SensitiveDataNotice', () => {
  it('always says never to send payment details and never to pay outside', () => {
    renderWithProviders(<SensitiveDataNotice draft="" />);
    expect(screen.getByText(/Never send bank details/)).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('warns louder when the draft holds an email address', () => {
    renderWithProviders(<SensitiveDataNotice draft="mail me: a@b.co" />);
    expect(screen.getByRole('status')).toHaveTextContent('an email address');
  });
});

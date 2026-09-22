/**
 * The caption under a converted price.
 *
 * Two claims, and the first is the one that matters: a price somebody typed
 * for this market gets NO caption at all. That is the ordinary case and the
 * default for every deployment, and captioning it would tell every buyer in
 * every currency that the price they are reading is approximate when it is
 * not.
 */
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { ApproximatePrice } from './ApproximatePrice';
import type { PriceConversion } from '@/lib/types';

const CONVERTED: PriceConversion = {
  approximate: true,
  baseCurrency: 'EUR',
  rate: '4.48800000',
  rateAsOf: '2026-09-18T00:00:00.000Z',
  provider: 'ecb',
};

function renderCaption(conversion: PriceConversion | null, variant?: 'inline' | 'block') {
  return renderWithProviders(
    <ApproximatePrice conversion={conversion} {...(variant === undefined ? {} : { variant })} />,
  );
}

describe('a price somebody typed', () => {
  it('renders nothing at all', () => {
    const { container } = renderCaption(null);
    expect(container.querySelector('[data-approximate-price]')).toBeNull();
  });

  it('renders nothing for an absent conversion either', () => {
    const { container } = renderWithProviders(<ApproximatePrice conversion={undefined} />);
    expect(container.querySelector('[data-approximate-price]')).toBeNull();
  });
});

describe('a converted price', () => {
  it('says it is approximate and names the currency it came from', async () => {
    renderCaption(CONVERTED);

    const caption = await screen.findByText(/approximate/i);
    expect(caption).toBeInTheDocument();
    expect(caption.textContent).toContain('EUR');
  });

  it('names the date the rate was published on a product page', async () => {
    // The two facts that let somebody check the arithmetic: which currency it
    // came from, and when the rate was published.
    renderCaption(CONVERTED, 'block');

    const caption = await screen.findByText(/approximate/i);
    expect(caption.textContent).toMatch(/2026/);
  });

  it('drops the date in a tight space', async () => {
    // A catalogue card has room for a phrase, not a sentence.
    renderCaption(CONVERTED, 'inline');

    const caption = await screen.findByText(/approximate/i);
    expect(caption.textContent).not.toMatch(/2026/);
  });

  it('never shows the rate or the provider to a shopper', async () => {
    // Eight decimal places is not something anybody reads, and which feed the
    // shop uses is an operations fact that belongs on the settings screen.
    renderCaption(CONVERTED);

    const caption = await screen.findByText(/approximate/i);
    expect(caption.textContent).not.toContain('4.488');
    expect(caption.textContent.toLowerCase()).not.toContain('ecb');
  });

  it('survives a rate date it cannot parse', async () => {
    // Never throws inside a render. A malformed date falls back to the short
    // phrase rather than printing "Invalid Date".
    renderCaption({ ...CONVERTED, rateAsOf: 'not-a-date' });

    const caption = await screen.findByText(/approximate/i);
    expect(caption.textContent).not.toMatch(/invalid/i);
  });
});

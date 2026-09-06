/**
 * The banner, tested for the two things it must not get wrong: naming both
 * currencies so nobody accepts a switch blind, and never repricing on its own.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { makeLocale, renderWithProviders } from '@/test/harness';
import { MarketSuggestionBanner } from './MarketSuggestionBanner';

const SUGGESTION = {
  language: 'pl',
  country: 'PL',
  countryName: 'Poland',
  currency: 'PLN',
};

describe('the market suggestion banner', () => {
  it('renders nothing when there is no offer', () => {
    renderWithProviders(<MarketSuggestionBanner />, {
      locale: makeLocale({ marketSuggestion: null }),
    });

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('names both the current currency and the one being offered', () => {
    renderWithProviders(<MarketSuggestionBanner />, {
      locale: makeLocale({ currency: 'EUR', marketSuggestion: SUGGESTION }),
    });

    // Accepting a switch you cannot see the terms of is not a choice.
    expect(screen.getByRole('status')).toHaveTextContent('EUR');
    expect(screen.getByRole('status')).toHaveTextContent('PLN');
    expect(screen.getByRole('status')).toHaveTextContent('Poland');
  });

  it('switches only when the shopper asks it to', async () => {
    const acceptSuggestion = vi.fn().mockResolvedValue(undefined);

    renderWithProviders(<MarketSuggestionBanner />, {
      locale: makeLocale({ currency: 'EUR', marketSuggestion: SUGGESTION, acceptSuggestion }),
    });

    // Rendering the offer must not have moved anything by itself.
    expect(acceptSuggestion).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /PLN/ }));

    await waitFor(() => {
      expect(acceptSuggestion).toHaveBeenCalledTimes(1);
    });
  });

  it('remembers a refusal through the provider rather than hiding itself', async () => {
    const dismissSuggestion = vi.fn();

    renderWithProviders(<MarketSuggestionBanner />, {
      locale: makeLocale({ currency: 'EUR', marketSuggestion: SUGGESTION, dismissSuggestion }),
    });

    await userEvent.click(screen.getByRole('button', { name: /EUR/ }));

    expect(dismissSuggestion).toHaveBeenCalledTimes(1);
  });

  it('says so when the switch could not be saved, and leaves the offer up', async () => {
    const acceptSuggestion = vi.fn().mockRejectedValue(new Error('offline'));

    renderWithProviders(<MarketSuggestionBanner />, {
      locale: makeLocale({ currency: 'EUR', marketSuggestion: SUGGESTION, acceptSuggestion }),
    });

    await userEvent.click(screen.getByRole('button', { name: /PLN/ }));

    // The prices on screen are still the old ones, so the shopper has to be
    // told the switch did not happen rather than left assuming it did.
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/could not be saved/i);
    });

    expect(screen.getByRole('button', { name: /PLN/ })).toBeEnabled();
  });
});

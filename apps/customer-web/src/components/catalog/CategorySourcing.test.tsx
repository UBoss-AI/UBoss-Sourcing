/**
 * The sourcing panel on a category page (checklist Master row 3): the
 * destination's rules, the verified suppliers selling here, and a hand-off to
 * the assistant - each shown only when it has something true to say.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CategorySourcing, type CategoryMarketNote } from './CategorySourcing';
import { FALLBACK_CONFIG } from '@/app/storefront-context';
import { takePendingQuestion } from '@/lib/ai-mode';
import { jsonResponse, renderWithProviders } from '@/test/harness';
import type { StorefrontConfig } from '@/lib/types';

const fetchMock = vi.fn();

function config(assistant: boolean): StorefrontConfig {
  return { ...FALLBACK_CONFIG, features: { ...FALLBACK_CONFIG.features, assistant } };
}

function suppliers(count: number): void {
  fetchMock.mockResolvedValue(
    jsonResponse({
      suppliers: Array.from({ length: Math.min(count, 6) }, (_, index) => ({
        slug: `s-${String(index)}`,
        displayName: `Supplier ${String(index)}`,
        kind: 'MANUFACTURER',
        registrationCountry: 'IN',
        verifiedAt: null,
        productCount: 2,
        logoUrl: null,
      })),
      countries: [{ country: 'IN', count }],
      total: count,
    }),
  );
}

function render(notes: CategoryMarketNote[], options: { assistant?: boolean; country?: string | null } = {}): void {
  renderWithProviders(
    <CategorySourcing slug="gloves" categoryName="Gloves" country={options.country ?? 'DE'} notes={notes} />,
    { config: config(options.assistant ?? true) },
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CategorySourcing', () => {
  it('counts the verified suppliers and keeps the category when one is chosen', async () => {
    suppliers(9);
    render([]);

    expect(await screen.findByText('9 verified suppliers sell in Gloves.')).toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: /Supplier \d/ });
    expect(links).toHaveLength(6);
    expect(links[0]).toHaveAttribute('href', '/category/gloves?seller=s-0');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('category=gloves');
  });

  it('explains a block for the destination, in the operator’s words', async () => {
    suppliers(0);
    render([{ effect: 'BLOCK', reason: 'Restricted under national rules.', requiredDocuments: [], categoryName: 'Gloves' }]);

    const note = await screen.findByRole('note');
    expect(note).toHaveTextContent('Products in this category cannot be sold to Germany.');
    expect(note).toHaveTextContent('Restricted under national rules.');
  });

  it('lists the documents a buyer there must hold', async () => {
    suppliers(0);
    render([
      { effect: 'DOCUMENTS_REQUIRED', reason: 'Licensed goods.', requiredDocuments: ['Import licence', 'End-user certificate'], categoryName: 'Gloves' },
    ]);

    const note = await screen.findByRole('note');
    expect(note).toHaveTextContent('Buyers in Germany need documents for this category.');
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Import licence',
      'End-user certificate',
    ]);
  });

  it('parks an editable sourcing question for the assistant', async () => {
    suppliers(1);
    render([]);

    await userEvent.click(await screen.findByRole('link', { name: 'Ask the assistant about sourcing Gloves' }));
    expect(takePendingQuestion()).toEqual({
      text: 'I am sourcing products in Gloves. Which suppliers and products here fit my requirement?',
      intent: 'compose',
    });
  });

  it('offers no assistant when it is switched off, and nothing at all with nothing to say', async () => {
    suppliers(0);
    render([], { assistant: false });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});

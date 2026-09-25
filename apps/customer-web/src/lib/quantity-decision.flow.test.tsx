/**
 * The quantity decision end to end: a real quantity box, the real hook, and a
 * server that holds 500 in stock.
 *
 * These are the scenarios the brief names, run with real timers so typing
 * pauses, the pricing debounce and the decision delay all happen as they do in
 * a browser:
 *
 *   typed 400, 500           -> no preorder prompt (offers, on an increase)
 *   typed 501                -> preorder prompt
 *   pasted 1000              -> preorder prompt
 *   stepped 500 -> 501       -> preorder prompt
 *   offer chosen: 1000       -> preorder prompt
 *   501 -> 502 -> 503        -> the prompt opens once
 *   typed 1, 10, 100, 1000   -> judged once, on 1000
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { QuantityInput } from '@/components/QuantityInput';
import { jsonResponse, renderWithProviders } from '@/test/harness';
import type { PurchaseRules } from '@/lib/types';
import { useQuantityDecision } from './use-quantity-decision';

const STOCK = 500;
const RULES = { minOrderQty: 1, maxOrderQty: null, qtyIncrement: 1 } as PurchaseRules;
const money = (minor: string) => ({ minor, formatted: minor, currency: 'INR' });

/** The server: offers at 10 and 1000, and 500 in stock. */
function stubServer(): { asked: number[] } {
  const asked: number[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (!url.pathname.endsWith('/catalog/bulk-pricing')) return Promise.resolve(jsonResponse({}));
      const quantity = Number(url.searchParams.get('quantity'));
      asked.push(quantity);
      const card = (min: number, price: string) => ({
        minQuantity: min,
        maxQuantity: null,
        unitPrice: money(price),
        listUnitPrice: money('18000'),
        savingPerPiece: money('0'),
        lineTotal: money('0'),
        totalSaving: money('0'),
        savingBasisPoints: 100,
        businessBuyersOnly: false,
        endsAt: null,
        isCurrent: false,
        isNext: false,
        isBestValue: false,
        withinStock: min <= STOCK,
        approximateUnitPrice: null,
      });
      return Promise.resolve(
        jsonResponse({
          available: true,
          offerId: 'o1',
          sellerName: 'Acme',
          currency: 'INR',
          quantity,
          listUnitPrice: money('18000'),
          current: { unitPrice: money('18000'), lineTotal: money('0'), savingBasisPoints: 0, saving: money('0'), tierMinQuantity: null },
          next: null,
          ladder: [],
          preorderBands: [],
          offers: [card(10, '17500'), card(1_000, '15000')],
          preorderOffers: [],
          units: [],
          stockBaseUnits: STOCK,
          exceedsStock: quantity > STOCK,
          preorderAvailable: true,
          approximate: null,
        }),
      );
    }),
  );
  return { asked };
}

/** Records every dialog the decision opens, then lets the test close it. */
function Page({ start, opened }: { start: number; opened: string[] }) {
  const [pieces, setPieces] = useState(start);
  // One product per test, so session memory from another test cannot leak in.
  const [productId] = useState(() => `p-${String(start)}-${String(Math.random())}`);
  const decision = useQuantityDecision({
    productId,
    variantId: null,
    pieces,
    displayCurrency: null,
    enabled: true,
    otherDialogOpen: false,
  });
  const kind = decision.dialog?.kind ?? null;
  if (kind !== null && opened[opened.length - 1] !== `open:${kind}`) opened.push(`open:${kind}`);
  return (
    <>
      <QuantityInput value={pieces} onChange={setPieces} onCommit={decision.commit} rules={RULES} />
      <p data-testid="dialog">{kind ?? 'none'}</p>
      <button
        type="button"
        onClick={() => {
          if (kind === 'preorder') decision.closePreorderPrompt();
          else decision.dismissOffers();
          opened.push('closed');
        }}
      >
        close dialog
      </button>
      <button
        type="button"
        onClick={() => {
          const before = pieces;
          setPieces(1_000);
          decision.chooseOffer(1_000, before);
        }}
      >
        choose 1000
      </button>
    </>
  );
}

const box = () => screen.getByRole('spinbutton');
const dialog = () => screen.getByTestId('dialog').textContent;

/**
 * Let real time pass in short slices, each inside act, so React applies the
 * updates timers make as they happen - one long act() would hold them all
 * until it ended, which no browser does.
 */
async function elapse(ms: number): Promise<void> {
  for (let waited = 0; waited < ms; waited += 50) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }
}

async function typeAndSettle(value: string): Promise<void> {
  fireEvent.change(box(), { target: { value } });
  // Typing pause (800) + pricing settle (350) + decision delay (700), and a margin.
  await elapse(2_400);
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

describe('the quantity decision, end to end, with 500 in stock', () => {
  it('typed 400 → no preorder prompt', async () => {
    stubServer();
    const opened: string[] = [];
    renderWithProviders(<Page start={1} opened={opened} />);
    await typeAndSettle('400');
    expect(dialog()).not.toBe('preorder');
  });

  it('typed 500 → no preorder prompt', async () => {
    stubServer();
    const opened: string[] = [];
    renderWithProviders(<Page start={1} opened={opened} />);
    await typeAndSettle('500');
    expect(dialog()).not.toBe('preorder');
  });

  it('typed 501 → preorder prompt, and never the offers first', async () => {
    stubServer();
    const opened: string[] = [];
    renderWithProviders(<Page start={1} opened={opened} />);
    await typeAndSettle('501');
    expect(dialog()).toBe('preorder');
    expect(opened).toEqual(['open:preorder']);
  });

  it('pasted 1000 → preorder prompt', async () => {
    stubServer();
    const opened: string[] = [];
    renderWithProviders(<Page start={1} opened={opened} />);
    fireEvent.paste(box(), { clipboardData: { getData: () => '1,000' } });
    await waitFor(() => {
      expect(dialog()).toBe('preorder');
    }, { timeout: 3_000 });
  });

  it('stepped 500 → 501 → preorder prompt', async () => {
    stubServer();
    const opened: string[] = [];
    renderWithProviders(<Page start={500} opened={opened} />);
    fireEvent.click(screen.getByRole('button', { name: /increase quantity/i }));
    await waitFor(() => {
      expect(dialog()).toBe('preorder');
    }, { timeout: 3_000 });
  });

  it('an offer choosing 1000 → preorder prompt', async () => {
    stubServer();
    const opened: string[] = [];
    renderWithProviders(<Page start={20} opened={opened} />);
    fireEvent.click(screen.getByRole('button', { name: 'choose 1000' }));
    await waitFor(() => {
      expect(dialog()).toBe('preorder');
    }, { timeout: 3_000 });
  });

  it('501 → 502 → 503 opens the prompt once, and again after coming back to stock', async () => {
    stubServer();
    const opened: string[] = [];
    renderWithProviders(<Page start={500} opened={opened} />);
    const plus = screen.getByRole('button', { name: /increase quantity/i });

    fireEvent.click(plus);
    await waitFor(() => {
      expect(dialog()).toBe('preorder');
    }, { timeout: 3_000 });
    fireEvent.click(screen.getByRole('button', { name: 'close dialog' }));

    fireEvent.click(plus);
    await elapse(1_500);
    fireEvent.click(plus);
    await elapse(1_500);
    expect(dialog()).toBe('none');
    expect(opened.filter((entry) => entry === 'open:preorder')).toHaveLength(1);

    await typeAndSettle('500');
    await typeAndSettle('501');
    expect(opened.filter((entry) => entry === 'open:preorder')).toHaveLength(2);
  }, 20_000);

  it('judges typed 1, 10, 100, 1000 once, on 1000', async () => {
    const server = stubServer();
    const opened: string[] = [];
    renderWithProviders(<Page start={1} opened={opened} />);
    for (const value of ['1', '10', '100', '1000']) {
      fireEvent.change(box(), { target: { value } });
      await elapse(150);
    }
    await elapse(2_500);
    // Offers never opened on the way: the first thing decided was 1000.
    expect(opened).toEqual(['open:preorder']);
    expect(server.asked.at(-1)).toBe(1_000);
  });

  it('a fraction commits nothing and opens nothing', async () => {
    stubServer();
    const opened: string[] = [];
    renderWithProviders(<Page start={1} opened={opened} />);
    await typeAndSettle('600.5');
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a whole number of pieces.');
    expect(opened).toEqual([]);
  });
});

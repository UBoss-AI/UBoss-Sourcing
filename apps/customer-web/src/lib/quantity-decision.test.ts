/**
 * The quantity decision, on its own: which dialog a settled quantity opens.
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_MEMORY,
  decide,
  offerSignature,
  type Commit,
  type DecisionFigures,
  type DecisionMemory,
  type QuantitySource,
} from './quantity-decision';

const SCOPE = 'p1:-';
const OFFERS = offerSignature([
  { minQuantity: 10, unitPrice: { minor: '17500', currency: 'INR' } },
  { minQuantity: 100, unitPrice: { minor: '16500', currency: 'INR' } },
]);

let seq = 0;
function commit(quantity: number, previous: number, source: QuantitySource = 'step'): Commit {
  seq += 1;
  return { quantity, previous, source, scope: SCOPE, seq };
}

function figures(quantity: number, overrides: Partial<DecisionFigures> = {}): DecisionFigures {
  const stock = overrides.stock ?? 500;
  return {
    quantity,
    scope: SCOPE,
    offerSignature: OFFERS,
    offerCount: 2,
    exceedsStock: quantity > stock,
    preorderAvailable: true,
    stock,
    ...overrides,
  };
}

/** Run a sequence of settled quantities, carrying memory, returning what each opened. */
function run(
  steps: { quantity: number; source?: QuantitySource; open?: boolean }[],
  start: DecisionMemory = EMPTY_MEMORY,
  base: Partial<DecisionFigures> = {},
): (string | null)[] {
  let memory = start;
  let previous = 1;
  return steps.map((step) => {
    const result = decide({
      commit: commit(step.quantity, previous, step.source ?? 'step'),
      figures: figures(step.quantity, base),
      memory,
      dialogOpen: step.open ?? false,
    });
    memory = result.memory;
    previous = step.quantity;
    return result.open?.kind ?? null;
  });
}

describe('offers', () => {
  it('open on the first increase that has offers, and not on every + after it', () => {
    expect(run([{ quantity: 2 }, { quantity: 3 }, { quantity: 4 }])).toEqual(['offers', null, null]);
  });

  it('do not open on a decrease, a chosen band, or a change of version', () => {
    expect(
      run([
        { quantity: 1 },
        { quantity: 10, source: 'tier' },
        { quantity: 10, source: 'variant' },
      ]),
    ).toEqual([null, null, null]);
  });

  it('do not open where the seller has set none', () => {
    expect(run([{ quantity: 2 }], EMPTY_MEMORY, { offerCount: 0, offerSignature: '' })).toEqual([null]);
  });

  it('stay closed once dismissed', () => {
    expect(run([{ quantity: 2 }], { ...EMPTY_MEMORY, offersDismissed: true })).toEqual([null]);
  });

  it('open again only when the set of offers itself changes', () => {
    const shown: DecisionMemory = { ...EMPTY_MEMORY, shownSignatures: [OFFERS] };
    expect(run([{ quantity: 5 }], shown)).toEqual([null]);
    expect(run([{ quantity: 5 }], shown, { offerSignature: 'other-bands' })).toEqual(['offers']);
  });

  it('never open over another dialog', () => {
    expect(run([{ quantity: 2, open: true }])).toEqual([null]);
  });
});

describe('stock, which comes first', () => {
  it('opens the preorder prompt, not the offers, on the change that goes over stock', () => {
    expect(run([{ quantity: 501, source: 'typed' }])).toEqual(['preorder']);
  });

  it('opens once for 501 → 502 → 503, and again after coming back to stock', () => {
    expect(
      run([{ quantity: 501 }, { quantity: 502 }, { quantity: 503 }, { quantity: 500 }, { quantity: 1_000 }]),
    ).toEqual(['preorder', null, null, null, 'preorder']);
  });

  it('treats exactly the stock as in stock', () => {
    expect(run([{ quantity: 400, source: 'typed' }])).toEqual(['offers']);
    expect(run([{ quantity: 500, source: 'typed' }])).toEqual(['offers']);
  });

  it('hands a chosen band that is over stock to the preorder prompt', () => {
    expect(run([{ quantity: 1_000, source: 'tier' }])).toEqual(['preorder']);
  });

  it('says nothing where the seller takes no preorders, and does not fire later', () => {
    expect(run([{ quantity: 501 }, { quantity: 600 }], EMPTY_MEMORY, { preorderAvailable: false })).toEqual([
      null,
      null,
    ]);
  });

  it('moves the latch even while another dialog is open, so it does not fire late', () => {
    expect(run([{ quantity: 501, open: true }, { quantity: 502 }])).toEqual([null, null]);
  });
});

describe('only the answer for the committed quantity counts', () => {
  it('ignores figures for another quantity or another version', () => {
    const c = commit(1_000, 1, 'typed');
    expect(decide({ commit: c, figures: figures(100), memory: EMPTY_MEMORY, dialogOpen: false }).open).toBeNull();
    expect(
      decide({ commit: c, figures: { ...figures(1_000), scope: 'p1:v2' }, memory: EMPTY_MEMORY, dialogOpen: false })
        .open,
    ).toBeNull();
  });

  it('refuses a quantity that is not a whole positive number', () => {
    for (const quantity of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = decide({
        commit: commit(quantity, 1, 'typed'),
        figures: figures(quantity),
        memory: EMPTY_MEMORY,
        dialogOpen: false,
      });
      expect(result.open, String(quantity)).toBeNull();
    }
  });
});

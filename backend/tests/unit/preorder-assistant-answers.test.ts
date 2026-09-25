/**
 * The preorder assistant's answer rules, without a database.
 *
 * Every answer is built from `FaqFacts`. These tests hold the rule the
 * assistant exists to keep: a figure is shown only when the product's own data
 * holds it, and otherwise the answer says the team has to confirm it.
 */
import { describe, expect, it } from 'vitest';
import { answerFaq, type FaqAnswer, type FaqFacts } from '../../src/modules/preorder-chat/assistant/answers.js';
import {
  FAQ_IDS,
  NEEDS_CONFIRMATION_KEY,
  activeFaqEntries,
  allFaqEntries,
  faqEntry,
} from '../../src/modules/preorder-chat/assistant/catalogue.js';
import { signAnswer, verifyAnswer } from '../../src/modules/preorder-chat/assistant/facts.service.js';
import { readStoredAnswer } from '../../src/modules/preorder-chat/assistant/transcript.js';

function facts(overrides: Partial<FaqFacts> = {}): FaqFacts {
  return {
    open: true,
    moq: { minimumBaseUnits: 1_200, incrementBaseUnits: 48, maximumBaseUnits: null, moqUnit: 'CARTON', moqQuantity: 25 },
    pricing: {
      mode: 'FIXED',
      currency: 'EUR',
      bands: [
        { minBaseUnits: 1_200, unitPriceMinor: '85' },
        { minBaseUnits: 10_000, unitPriceMinor: '72' },
      ],
    },
    containers: {
      CONTAINER_20_FT: { pieces: 96_000, cartons: 2_000, piecesPerCarton: 48 },
      CONTAINER_40_FT: null,
    },
    stockBaseUnits: 5_000,
    requestedBaseUnits: 2_000,
    window: { earliest: '2026-11-02', latest: '2027-03-31', hasPublishedTransit: false },
    allowSplitDelivery: true,
    allowPartialFulfilment: true,
    cancellationTerms: null,
    deliveryCountries: ['DE', 'FR'],
    ...overrides,
  };
}

const CLOSED: Partial<FaqFacts> = {
  open: false,
  moq: null,
  pricing: null,
  containers: { CONTAINER_20_FT: null, CONTAINER_40_FT: null },
  window: null,
  allowSplitDelivery: null,
  allowPartialFulfilment: null,
};

function keys(answer: FaqAnswer | null): string[] {
  return (answer?.lines ?? []).map((line) => line.key.replace('preorderChat.assistant.a.', ''));
}

describe('the catalogue', () => {
  it('has every question once, active, in display order', () => {
    const ids = activeFaqEntries().map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...FAQ_IDS]);
  });

  it('lists every line an answer can produce, so each can be checked for translations', () => {
    const every = [facts(), facts(CLOSED), facts({ stockBaseUnits: 0 }), facts({ requestedBaseUnits: null }),
      facts({ stockBaseUnits: 100 }), facts({ allowSplitDelivery: false }), facts({ cancellationTerms: 'Free within 48 hours.' }),
      facts({ pricing: { mode: 'QUOTE_REQUIRED', currency: 'EUR', bands: [] } }), facts({ stockBaseUnits: null }),
      facts({ deliveryCountries: [] }), facts({ moq: { minimumBaseUnits: 10, incrementBaseUnits: 1, maximumBaseUnits: 900, moqUnit: 'PIECE', moqQuantity: 10 } }),
      facts({ containers: { CONTAINER_20_FT: { pieces: 90, cartons: null, piecesPerCarton: null }, CONTAINER_40_FT: null } })];
    for (const entry of allFaqEntries()) {
      for (const input of every) {
        const answer = answerFaq(entry.id, input);
        for (const line of answer?.lines ?? []) {
          expect(entry.answerTemplateTranslationKeys, `${entry.id} -> ${line.key}`).toContain(line.key);
        }
      }
    }
  });

  it('does not offer an unknown question', () => {
    expect(faqEntry('secretDiscount')).toBeNull();
    expect(answerFaq('secretDiscount', facts())).toBeNull();
  });
});

describe('answers', () => {
  it('states the minimum in pieces, the seller unit, and the step', () => {
    const answer = answerFaq('moq', facts());
    expect(answer?.outcome).toBe('ANSWERED');
    expect(keys(answer)).toEqual(['moq', 'moqInUnit', 'moqStep']);
    expect(answer?.lines[0]?.values['minimum']).toEqual({ kind: 'number', value: 1_200 });
    expect(answer?.lines[1]?.values['unit']).toEqual({ kind: 'unit', value: 'CARTON' });
  });

  it('shows the first and the best price band, and says they are indicative', () => {
    const answer = answerFaq('bulkPricing', facts());
    expect(keys(answer)).toEqual(['bulkBands', 'bulkBest', 'indicative']);
    expect(answer?.lines[1]?.values['price']).toEqual({ kind: 'money', minor: '72', currency: 'EUR' });
  });

  it('says a quote is needed rather than inventing a price', () => {
    const answer = answerFaq('bulkPricing', facts({ pricing: { mode: 'QUOTE_REQUIRED', currency: 'EUR', bands: [] } }));
    expect(keys(answer)).toEqual(['bulkQuote']);
  });

  it('gives verified container loading, and nothing for a size not verified', () => {
    expect(answerFaq('container20', facts())?.lines[0]?.values).toMatchObject({
      pieces: { kind: 'number', value: 96_000 },
      cartons: { kind: 'number', value: 2_000 },
    });
    const forty = answerFaq('container40', facts());
    expect(forty?.outcome).toBe('NEEDS_CONFIRMATION');
    expect(forty?.lines.at(-1)?.key).toBe(NEEDS_CONFIRMATION_KEY);
    expect(JSON.stringify(forty)).not.toContain('"number"');
  });

  it('compares stock with the quantity asked about, and never promises it is reserved', () => {
    expect(keys(answerFaq('stock', facts()))).toEqual(['stockCovers', 'stockNotReserved']);
    expect(keys(answerFaq('stock', facts({ stockBaseUnits: 100 })))).toEqual(['stockShort', 'stockNotReserved']);
    expect(keys(answerFaq('stock', facts({ stockBaseUnits: 0 })))).toEqual(['stockNone', 'stockNotReserved']);
    expect(keys(answerFaq('stock', facts({ requestedBaseUnits: null })))).toEqual([
      'stockNow',
      'stockAskQuantity',
      'stockNotReserved',
    ]);
    expect(answerFaq('stock', facts({ stockBaseUnits: null }))?.outcome).toBe('NEEDS_CONFIRMATION');
  });

  it('follows the seller\'s split-delivery setting', () => {
    expect(keys(answerFaq('splitShipments', facts()))).toEqual(['splitYes']);
    expect(keys(answerFaq('splitShipments', facts({ allowSplitDelivery: false })))).toEqual(['splitNo']);
    expect(keys(answerFaq('insufficientStock', facts({ allowSplitDelivery: false })))).toEqual([
      'shortOptions',
      'shortWhole',
      'sellerDecides',
    ]);
  });

  it('gives the delivery window and says the route is not measured when it is not', () => {
    const answer = answerFaq('deliveryDate', facts());
    expect(keys(answer)).toEqual(['deliveryEarliest', 'deliveryLatest', 'deliveryNoRoute', 'deliveryConfirm']);
    expect(answer?.lines[0]?.values['date']).toEqual({ kind: 'date', value: '2026-11-02' });
  });

  it('quotes the seller\'s own cancellation terms only when there are some', () => {
    expect(keys(answerFaq('changeCancel', facts()))).toEqual(['changeBefore', 'changeAfterPayment']);
    const withTerms = answerFaq('changeCancel', facts({ cancellationTerms: 'Free within 48 hours.' }));
    expect(withTerms?.lines[1]?.values['terms']).toEqual({ kind: 'text', value: 'Free within 48 hours.' });
  });

  it('answers every preorder-term question honestly when there are no terms', () => {
    for (const id of ['moq', 'bulkPricing', 'container20', 'container40', 'insufficientStock', 'deliveryDate', 'splitShipments']) {
      const answer = answerFaq(id, facts(CLOSED));
      expect(answer?.outcome, id).toBe('NEEDS_CONFIRMATION');
      expect(answer?.lines.at(-1)?.key, id).toBe(NEEDS_CONFIRMATION_KEY);
    }
  });

  it('always hands customisation to the team', () => {
    expect(answerFaq('customisation', facts())?.outcome).toBe('NEEDS_CONFIRMATION');
  });
});

describe('signed answers', () => {
  const scope = { productId: '01JABCDEFGHJKMNPQRSTVWXYZ0', variantId: null };
  const answer = answerFaq('moq', facts()) as FaqAnswer;
  const askedAt = new Date().toISOString();
  const token = signAnswer(scope, answer, askedAt);

  it('verifies what it signed', () => {
    expect(verifyAnswer(scope, answer, askedAt, token)).toBe(true);
  });

  it('refuses a changed value, another product, and an old answer', () => {
    const changed = structuredClone(answer);
    changed.lines[0] = { key: changed.lines[0]?.key ?? '', values: { minimum: { kind: 'number', value: 1 } } };
    expect(verifyAnswer(scope, changed, askedAt, token)).toBe(false);
    expect(verifyAnswer({ ...scope, productId: '01JABCDEFGHJKMNPQRSTVWXYZ1' }, answer, askedAt, token)).toBe(false);
    const old = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    expect(verifyAnswer(scope, answer, old, signAnswer(scope, answer, old))).toBe(false);
  });

  it('reads a stored answer back only when it still validates', () => {
    expect(readStoredAnswer({ answer, askedAt })?.faqId).toBe('moq');
    expect(readStoredAnswer({ answer: { ...answer, lines: [{ key: '<script>', values: {} }] }, askedAt })).toBeNull();
    expect(readStoredAnswer('nonsense')).toBeNull();
  });
});

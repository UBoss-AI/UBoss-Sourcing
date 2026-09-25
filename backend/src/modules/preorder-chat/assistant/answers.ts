/**
 * The preorder assistant's answers, from facts to lines.
 *
 * Pure: `FaqFacts` in, `FaqAnswer` out, nothing read and nothing written, so
 * every rule below has a test that needs no database. `facts.service.ts` is
 * the one place facts come from.
 *
 * THE RULE EVERY ANSWER KEEPS
 *
 * A figure appears in an answer only when the product's own data holds it: the
 * seller's preorder terms, the loading the seller verified, the stock on the
 * listing, the delivery window the preorder form would offer. Where that data
 * is missing the answer does not guess a nominal figure - it says the team has
 * to confirm it, and the outcome is NEEDS_CONFIRMATION so the screen offers a
 * person straight away.
 *
 * An answer is a list of lines, each a translation key and the values that
 * fill it. Values are typed - a number, a date, an amount of money - so each
 * frontend formats them in its reader's language and currency conventions, and
 * nothing in a value is ever HTML.
 */
import { NEEDS_CONFIRMATION_KEY, faqEntry, type FaqEntry, type FaqId } from './catalogue.js';

export type FaqValue =
  | { kind: 'number'; value: number }
  | { kind: 'text'; value: string }
  | { kind: 'date'; value: string }
  | { kind: 'money'; minor: string; currency: string }
  | { kind: 'unit'; value: string }
  | { kind: 'countries'; value: string[] };

export interface FaqAnswerLine {
  key: string;
  values: Record<string, FaqValue>;
}

export type FaqOutcome = 'ANSWERED' | 'NEEDS_CONFIRMATION';

export interface FaqAnswer {
  faqId: FaqId;
  version: number;
  outcome: FaqOutcome;
  lines: FaqAnswerLine[];
}

export interface FaqContainerFacts {
  pieces: number;
  cartons: number | null;
  piecesPerCarton: number | null;
}

/** Everything an answer may say, read by `facts.service.ts`. Null means "not known". */
export interface FaqFacts {
  /** Preorder terms exist and preorders are open for this product and option. */
  open: boolean;
  moq: {
    minimumBaseUnits: number;
    incrementBaseUnits: number;
    maximumBaseUnits: number | null;
    /** How the seller states the minimum, when it is not in pieces. */
    moqUnit: string;
    moqQuantity: number | null;
  } | null;
  pricing: {
    mode: 'FIXED' | 'QUOTE_REQUIRED';
    currency: string;
    /** Ascending by minimum. Money as a string of minor units. */
    bands: { minBaseUnits: number; unitPriceMinor: string }[];
  } | null;
  containers: { CONTAINER_20_FT: FaqContainerFacts | null; CONTAINER_40_FT: FaqContainerFacts | null };
  /** Pieces on the listing now. Null when there is no listing to read. */
  stockBaseUnits: number | null;
  /** The quantity the customer is asking about, in pieces, or null. */
  requestedBaseUnits: number | null;
  window: { earliest: string; latest: string | null; hasPublishedTransit: boolean } | null;
  allowSplitDelivery: boolean | null;
  allowPartialFulfilment: boolean | null;
  /** The seller's own words, plain text, already trimmed and bounded. */
  cancellationTerms: string | null;
  deliveryCountries: string[];
}

const key = (name: string): string => `preorderChat.assistant.a.${name}`;
const line = (name: string, values: Record<string, FaqValue> = {}): FaqAnswerLine => ({
  key: key(name),
  values,
});
const num = (value: number): FaqValue => ({ kind: 'number', value });

function answered(entry: FaqEntry, lines: FaqAnswerLine[]): FaqAnswer {
  return { faqId: entry.id, version: entry.version, outcome: 'ANSWERED', lines };
}

/** Whatever was known, then the honest line that the team has to confirm the rest. */
function needsTeam(entry: FaqEntry, lines: FaqAnswerLine[] = []): FaqAnswer {
  return {
    faqId: entry.id,
    version: entry.version,
    outcome: 'NEEDS_CONFIRMATION',
    lines: [...lines, { key: NEEDS_CONFIRMATION_KEY, values: {} }],
  };
}

function containerAnswer(entry: FaqEntry, facts: FaqFacts, size: '20' | '40'): FaqAnswer {
  if (!facts.open) return needsTeam(entry, [line('notOpen')]);
  const loaded = size === '20' ? facts.containers.CONTAINER_20_FT : facts.containers.CONTAINER_40_FT;
  if (loaded === null) return needsTeam(entry, [line('containerUnverified', { size: { kind: 'text', value: size } })]);
  return answered(entry, [
    loaded.cartons !== null && loaded.piecesPerCarton !== null
      ? line('containerCartons', {
          size: { kind: 'text', value: size },
          pieces: num(loaded.pieces),
          cartons: num(loaded.cartons),
          perCarton: num(loaded.piecesPerCarton),
        })
      : line('containerPieces', { size: { kind: 'text', value: size }, pieces: num(loaded.pieces) }),
  ]);
}

/** The answer to one question, from the facts. Null for a question that is not offered. */
export function answerFaq(id: string, facts: FaqFacts): FaqAnswer | null {
  const entry = faqEntry(id);
  if (entry === null) return null;
  if (entry.requiresHumanConfirmation) {
    return needsTeam(entry, entry.id === 'customisation' ? [line('customisationUnlisted')] : []);
  }

  switch (entry.id) {
    case 'moq': {
      if (!facts.open || facts.moq === null) return needsTeam(entry, [line('notOpen')]);
      const { moq } = facts;
      const lines = [line('moq', { minimum: num(moq.minimumBaseUnits) })];
      if (moq.moqUnit !== 'PIECE' && moq.moqQuantity !== null) {
        lines.push(line('moqInUnit', { quantity: num(moq.moqQuantity), unit: { kind: 'unit', value: moq.moqUnit } }));
      }
      if (moq.incrementBaseUnits > 1) lines.push(line('moqStep', { step: num(moq.incrementBaseUnits) }));
      if (moq.maximumBaseUnits !== null) lines.push(line('moqMaximum', { maximum: num(moq.maximumBaseUnits) }));
      return answered(entry, lines);
    }

    case 'bulkPricing': {
      if (!facts.open || facts.pricing === null) return needsTeam(entry, [line('notOpen')]);
      const { pricing } = facts;
      if (pricing.mode === 'QUOTE_REQUIRED') return answered(entry, [line('bulkQuote')]);
      const first = pricing.bands[0];
      const best = pricing.bands.at(-1);
      if (first === undefined || best === undefined) return needsTeam(entry);
      const lines = [
        line('bulkBands', {
          bands: num(pricing.bands.length),
          minimum: num(first.minBaseUnits),
          price: { kind: 'money', minor: first.unitPriceMinor, currency: pricing.currency },
        }),
      ];
      if (pricing.bands.length > 1) {
        lines.push(
          line('bulkBest', {
            minimum: num(best.minBaseUnits),
            price: { kind: 'money', minor: best.unitPriceMinor, currency: pricing.currency },
          }),
        );
      }
      lines.push(line('indicative'));
      return answered(entry, lines);
    }

    case 'container20':
      return containerAnswer(entry, facts, '20');
    case 'container40':
      return containerAnswer(entry, facts, '40');

    case 'stock': {
      if (facts.stockBaseUnits === null) return needsTeam(entry);
      const stock = facts.stockBaseUnits;
      if (facts.requestedBaseUnits === null) {
        return answered(entry, [
          stock > 0 ? line('stockNow', { stock: num(stock) }) : line('stockNone'),
          line('stockAskQuantity'),
          line('stockNotReserved'),
        ]);
      }
      const requested = num(facts.requestedBaseUnits);
      return answered(entry, [
        stock >= facts.requestedBaseUnits
          ? line('stockCovers', { stock: num(stock), requested })
          : stock > 0
            ? line('stockShort', { stock: num(stock), requested })
            : line('stockNone'),
        line('stockNotReserved'),
      ]);
    }

    case 'insufficientStock': {
      if (!facts.open || facts.allowSplitDelivery === null) return needsTeam(entry, [line('notOpen')]);
      return answered(entry, [
        line('shortOptions'),
        facts.allowSplitDelivery ? line('shortSplit') : line('shortWhole'),
        line('sellerDecides'),
      ]);
    }

    case 'deliveryDate': {
      if (!facts.open || facts.window === null) return needsTeam(entry, [line('notOpen')]);
      const { window } = facts;
      const lines = [line('deliveryEarliest', { date: { kind: 'date', value: window.earliest } })];
      if (window.latest !== null) lines.push(line('deliveryLatest', { date: { kind: 'date', value: window.latest } }));
      if (!window.hasPublishedTransit) lines.push(line('deliveryNoRoute'));
      lines.push(line('deliveryConfirm'));
      return answered(entry, lines);
    }

    case 'splitShipments': {
      if (!facts.open || facts.allowSplitDelivery === null) return needsTeam(entry, [line('notOpen')]);
      return answered(entry, [facts.allowSplitDelivery ? line('splitYes') : line('splitNo')]);
    }

    case 'payment':
      // How the platform works, not a promise about any one product: a preorder
      // request charges nothing, and accepting the seller's terms creates an
      // ordinary order that is paid at checkout.
      return answered(entry, [line('paymentWhen'), line('paymentMethods')]);

    case 'logistics': {
      const lines: FaqAnswerLine[] = [];
      if (facts.deliveryCountries.length > 0) {
        lines.push(line('logisticsCountries', { countries: { kind: 'countries', value: facts.deliveryCountries } }));
      }
      lines.push(line('logisticsTracking'));
      return answered(entry, lines);
    }

    case 'changeCancel': {
      const lines = [line('changeBefore')];
      if (facts.cancellationTerms !== null) {
        lines.push(line('cancelTerms', { terms: { kind: 'text', value: facts.cancellationTerms } }));
      }
      lines.push(line('changeAfterPayment'));
      return answered(entry, lines);
    }

    case 'customisation':
      return needsTeam(entry, [line('customisationUnlisted')]);
  }
}

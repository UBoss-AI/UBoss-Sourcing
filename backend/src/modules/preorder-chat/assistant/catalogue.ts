/**
 * The preorder assistant's questions.
 *
 * WHAT THIS FILE IS
 *
 * The configuration of the automated answers a customer sees before they talk
 * to a person: which questions exist, in what order, which facts each answer
 * is built from, and whether an answer can ever stand on its own or always
 * needs the team to confirm it. The WORDS are not here - every question and
 * answer is a translation key, and each frontend holds them in all eight
 * languages, the same way a system event is an event key and values. The
 * FACTS are not here either: `answers.ts` reads them from the product's own
 * preorder terms, loading and stock, and nothing else.
 *
 * VERSIONS
 *
 * `version` goes up whenever what an answer SAYS changes - a new line, a fact
 * it reads, a rule it applies. A stored answer keeps the version it was given
 * under, so a transcript read next year still says which rules produced it.
 *
 * MAKING IT ADMIN-MANAGED LATER
 *
 * Everything an operator might want to change - active, order, the "needs
 * confirmation" switch - is a plain field, validated below by one schema. A
 * table with the same columns can replace `CATALOGUE` without touching the
 * answers or the frontends. What it must never do is carry answer TEXT that a
 * browser renders as HTML: the frontends render every line as text.
 */
import { z } from 'zod';

/** The facts an answer can be built from. Named so a stored answer can say which it used. */
export const FAQ_DATA_FIELDS = [
  'preorderTerms',
  'moq',
  'priceBands',
  'container20',
  'container40',
  'stock',
  'requestedQuantity',
  'deliveryWindow',
  'splitDelivery',
  'partialFulfilment',
  'cancellationTerms',
  'deliveryCountries',
  'platformPolicy',
] as const;
export type FaqDataField = (typeof FAQ_DATA_FIELDS)[number];

export const FAQ_CATEGORIES = [
  'ORDERING',
  'PRICING',
  'CONTAINERS',
  'AVAILABILITY',
  'DELIVERY',
  'PRODUCT',
  'PAYMENT',
  'CHANGES',
] as const;
export type FaqCategory = (typeof FAQ_CATEGORIES)[number];

export const FAQ_IDS = [
  'moq',
  'bulkPricing',
  'container20',
  'container40',
  'stock',
  'insufficientStock',
  'deliveryDate',
  'splitShipments',
  'customisation',
  'payment',
  'logistics',
  'changeCancel',
] as const;
export type FaqId = (typeof FAQ_IDS)[number];

export interface FaqEntry {
  id: FaqId;
  category: FaqCategory;
  /** In both frontends' catalogues. */
  questionTranslationKey: string;
  /** Every answer line this question can produce, so a test can check each is translated. */
  answerTemplateTranslationKeys: readonly string[];
  requiredDataFields: readonly FaqDataField[];
  displayOrder: number;
  active: boolean;
  /**
   * True where no product data can answer it - the reply is always the honest
   * "this needs the team" line, followed by the offer of a person.
   */
  requiresHumanConfirmation: boolean;
  version: number;
}

const KEY = /^preorderChat\.assistant\.[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)*$/;

const entrySchema = z
  .object({
    id: z.enum(FAQ_IDS),
    category: z.enum(FAQ_CATEGORIES),
    questionTranslationKey: z.string().regex(KEY),
    answerTemplateTranslationKeys: z.array(z.string().regex(KEY)).min(1),
    requiredDataFields: z.array(z.enum(FAQ_DATA_FIELDS)),
    displayOrder: z.number().int().min(0).max(10_000),
    active: z.boolean(),
    requiresHumanConfirmation: z.boolean(),
    version: z.number().int().min(1),
  })
  .strict();

/** The line every answer ends with when the facts are not there. */
export const NEEDS_CONFIRMATION_KEY = 'preorderChat.assistant.a.needsConfirmation';

const q = (id: FaqId): string => `preorderChat.assistant.q.${id}`;
const a = (...names: string[]): string[] => [...names.map((name) => `preorderChat.assistant.a.${name}`), NEEDS_CONFIRMATION_KEY];

const CATALOGUE: readonly FaqEntry[] = [
  {
    id: 'moq',
    category: 'ORDERING',
    questionTranslationKey: q('moq'),
    answerTemplateTranslationKeys: a('moq', 'moqStep', 'moqMaximum', 'moqInUnit', 'notOpen'),
    requiredDataFields: ['preorderTerms', 'moq'],
    displayOrder: 10,
    active: true,
    requiresHumanConfirmation: false,
    version: 1,
  },
  {
    id: 'bulkPricing',
    category: 'PRICING',
    questionTranslationKey: q('bulkPricing'),
    answerTemplateTranslationKeys: a('bulkBands', 'bulkBest', 'bulkQuote', 'indicative', 'notOpen'),
    requiredDataFields: ['preorderTerms', 'priceBands'],
    displayOrder: 20,
    active: true,
    requiresHumanConfirmation: false,
    version: 1,
  },
  {
    id: 'container20',
    category: 'CONTAINERS',
    questionTranslationKey: q('container20'),
    answerTemplateTranslationKeys: a('containerCartons', 'containerPieces', 'containerUnverified', 'notOpen'),
    requiredDataFields: ['preorderTerms', 'container20'],
    displayOrder: 30,
    active: true,
    requiresHumanConfirmation: false,
    version: 1,
  },
  {
    id: 'container40',
    category: 'CONTAINERS',
    questionTranslationKey: q('container40'),
    answerTemplateTranslationKeys: a('containerCartons', 'containerPieces', 'containerUnverified', 'notOpen'),
    requiredDataFields: ['preorderTerms', 'container40'],
    displayOrder: 40,
    active: true,
    requiresHumanConfirmation: false,
    version: 1,
  },
  {
    id: 'stock',
    category: 'AVAILABILITY',
    questionTranslationKey: q('stock'),
    answerTemplateTranslationKeys: a('stockCovers', 'stockShort', 'stockNone', 'stockNow', 'stockAskQuantity', 'stockNotReserved'),
    requiredDataFields: ['stock', 'requestedQuantity'],
    displayOrder: 50,
    active: true,
    requiresHumanConfirmation: false,
    version: 1,
  },
  {
    id: 'insufficientStock',
    category: 'AVAILABILITY',
    questionTranslationKey: q('insufficientStock'),
    answerTemplateTranslationKeys: a('shortOptions', 'shortSplit', 'shortWhole', 'sellerDecides', 'notOpen'),
    requiredDataFields: ['preorderTerms', 'splitDelivery'],
    displayOrder: 60,
    active: true,
    requiresHumanConfirmation: false,
    version: 1,
  },
  {
    id: 'deliveryDate',
    category: 'DELIVERY',
    questionTranslationKey: q('deliveryDate'),
    answerTemplateTranslationKeys: a('deliveryEarliest', 'deliveryLatest', 'deliveryNoRoute', 'deliveryConfirm', 'notOpen'),
    requiredDataFields: ['preorderTerms', 'deliveryWindow'],
    displayOrder: 70,
    active: true,
    requiresHumanConfirmation: false,
    version: 1,
  },
  {
    id: 'splitShipments',
    category: 'DELIVERY',
    questionTranslationKey: q('splitShipments'),
    answerTemplateTranslationKeys: a('splitYes', 'splitNo', 'notOpen'),
    requiredDataFields: ['preorderTerms', 'splitDelivery'],
    displayOrder: 80,
    active: true,
    requiresHumanConfirmation: false,
    version: 1,
  },
  {
    id: 'customisation',
    category: 'PRODUCT',
    questionTranslationKey: q('customisation'),
    answerTemplateTranslationKeys: a('customisationUnlisted'),
    requiredDataFields: [],
    displayOrder: 90,
    active: true,
    // No listing field says whether a product can be customised, so this is
    // never answered automatically.
    requiresHumanConfirmation: true,
    version: 1,
  },
  {
    id: 'payment',
    category: 'PAYMENT',
    questionTranslationKey: q('payment'),
    answerTemplateTranslationKeys: a('paymentWhen', 'paymentMethods'),
    requiredDataFields: ['platformPolicy'],
    displayOrder: 100,
    active: true,
    requiresHumanConfirmation: false,
    version: 1,
  },
  {
    id: 'logistics',
    category: 'DELIVERY',
    questionTranslationKey: q('logistics'),
    answerTemplateTranslationKeys: a('logisticsCountries', 'logisticsTracking'),
    requiredDataFields: ['deliveryCountries', 'platformPolicy'],
    displayOrder: 110,
    active: true,
    requiresHumanConfirmation: false,
    version: 1,
  },
  {
    id: 'changeCancel',
    category: 'CHANGES',
    questionTranslationKey: q('changeCancel'),
    answerTemplateTranslationKeys: a('changeBefore', 'cancelTerms', 'changeAfterPayment'),
    requiredDataFields: ['platformPolicy', 'cancellationTerms'],
    displayOrder: 120,
    active: true,
    requiresHumanConfirmation: false,
    version: 1,
  },
];

function validate(entries: readonly FaqEntry[]): readonly FaqEntry[] {
  const parsed = entries.map((entry) => entrySchema.parse(entry) as FaqEntry);
  const ids = new Set(parsed.map((entry) => entry.id));
  if (ids.size !== parsed.length) throw new Error('The preorder assistant has two questions with one id.');
  return Object.freeze(parsed.map((entry) => Object.freeze(entry)));
}

const VALIDATED = validate(CATALOGUE);

/** Every question, active or not. */
export function allFaqEntries(): readonly FaqEntry[] {
  return VALIDATED;
}

/** The questions the customer is offered, in order. */
export function activeFaqEntries(): FaqEntry[] {
  return VALIDATED.filter((entry) => entry.active).sort((x, y) => x.displayOrder - y.displayOrder);
}

export function faqEntry(id: string): FaqEntry | null {
  return VALIDATED.find((entry) => entry.id === id && entry.active) ?? null;
}

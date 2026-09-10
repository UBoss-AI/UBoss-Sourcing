/**
 * Search the catalogue with a photograph instead of a word.
 *
 * Somebody holding a box of cannulae in a store room knows exactly what they
 * need and often cannot name it: the label is in another language, the product
 * code has worn off, or the person reordering is not the person who chose it.
 * A camera answers that question in a way a search box cannot.
 *
 * How it actually works, because "image search" covers several very different
 * things and this is only one of them:
 *
 *   1. The published catalogue is rendered as a short index — slug, name,
 *      category, one summary line. Not the full snapshot the chat assistant
 *      gets: matching a photograph does not need prices, tax classes, ordering
 *      rules or a variant list, and leaving them out roughly quarters the
 *      prompt.
 *   2. The image and that index go to the deployment's own AI provider, with
 *      one instruction: identify what is in the picture and name the entries
 *      from the index that match it. Nothing else.
 *   3. Every slug that comes back is checked against the index before it is
 *      used. A model that invents `/product/blue-syringe-box` gets its answer
 *      silently dropped rather than turned into a 404 the customer has to
 *      work out for themselves.
 *
 * What this is NOT, and must not be mistaken for: a perceptual-similarity
 * search over product photographs. There is no embedding index here, and no
 * pretence of one — the deployment's product images are not vectorised, and
 * matching is on what the model recognises the item to *be*. That is the
 * honest description of the result, and it is the reason `description` comes
 * back with the matches: the customer is shown what the picture was understood
 * as, so a wrong reading is obvious at a glance instead of looking like a
 * catalogue with the wrong stock in it.
 *
 * Cost is bounded the same way everything else on the provider is: the caller
 * must be a signed-in customer, the route is rate limited well below the chat
 * endpoint, the image is capped by `UPLOAD_MAX_BYTES`, and the reply is capped
 * at a few hundred tokens because it is a list of slugs.
 */
import { env } from '../../config/env.js';
import { publicProductWhere } from '../catalog/catalog.visibility.js';
import { prisma } from '../../infra/prisma.js';
import { activeProvider } from './assistant.service.js';

/** How many catalogue matches are worth showing. Beyond this it is a browse. */
const MAX_MATCHES = 12;

/** A list of slugs and a sentence. It does not need more room than this. */
const MAX_TOKENS = 700;

/**
 * How long the index is reused before it is rebuilt.
 *
 * Shorter than it looks: it is the same sixty seconds the chat snapshot uses,
 * and for the same reason — a product published a minute ago should be
 * findable, and rebuilding a list of a few thousand rows on every upload would
 * put a database read in front of a provider call that is already the slow
 * part.
 */
const INDEX_TTL_MS = 60_000;

let index: { text: string; slugs: Set<string>; builtAt: number } | null = null;

/**
 * The catalogue as the vision model sees it.
 *
 * `publicProductWhere()` is the same visibility filter every storefront read
 * uses, so a draft or unpublished product cannot be matched into an answer —
 * the customer would be shown a card that 404s and staff would be asked about
 * a product that is not for sale.
 */
async function buildIndex(): Promise<{ text: string; slugs: Set<string> }> {
  const products = await prisma.product.findMany({
    where: publicProductWhere(),
    select: {
      slug: true,
      name: true,
      shortDescription: true,
      category: { select: { name: true } },
    },
    orderBy: [{ category: { sortOrder: 'asc' } }, { name: 'asc' }],
  });

  const slugs = new Set(products.map((product) => product.slug));

  const lines = products.map((product) => {
    const summary =
      product.shortDescription === null ? '' : ` — ${product.shortDescription.slice(0, 160)}`;
    return `${product.slug} | ${product.category.name} | ${product.name}${summary}`;
  });

  const text = [
    'CATALOGUE INDEX — every product this store publishes, one per line, as',
    '`slug | category | name — summary`. These slugs are the only ones that exist.',
    '',
    ...lines,
  ].join('\n');

  return { text, slugs };
}

async function catalogueIndex(): Promise<{ text: string; slugs: Set<string> }> {
  if (index !== null && Date.now() - index.builtAt < INDEX_TTL_MS) return index;

  const built = await buildIndex();
  index = { ...built, builtAt: Date.now() };
  return index;
}

/** Called after a catalogue write, so a new product is findable immediately. */
export function invalidateImageSearchIndex(): void {
  index = null;
}

const SYSTEM_PROMPT = `You identify medical and laboratory products in photographs for a
medical supplies store, and match them against that store's own catalogue.

Rules:
- Match on what the item IS: the type of product, its form, its material, its
  apparent size and any visible markings, brand or product code.
- Only ever name slugs that appear verbatim in the catalogue index. Never
  invent one, never correct one, never guess at one.
- Order the matches best first, and return at most ${String(MAX_MATCHES)}.
- Return no matches at all rather than a bad one. A shopper shown the wrong
  cannula gauge is worse off than a shopper shown nothing.
- If the photograph is not of a product at all — a person, a document, a room,
  a screenshot — return no matches and say what it is in one short sentence.
- Never comment on, describe or speculate about any person visible in the
  image. Describe the product only.

Reply with JSON and nothing else, in exactly this shape:
{"description":"one short sentence naming what is in the photograph",
 "terms":["two to five words a shopper would type to find this"],
 "slugs":["catalogue-slug","..."]}`;

const USER_PROMPT =
  'Identify the product in this photograph and match it against the catalogue index. Reply with the JSON object only.';

export interface ImageSearchAnalysis {
  /** What the model understood the photograph to be. Shown to the customer. */
  description: string;
  /** Words a shopper would have typed. Used when nothing in the catalogue matched. */
  terms: string[];
  /** Catalogue slugs, best first, every one of them verified to exist. */
  slugs: string[];
}

/**
 * Pull the JSON object out of a reply, tolerantly.
 *
 * Models wrap JSON in a fenced code block often enough that refusing one is a
 * self-inflicted failure. Anything that is still not an object after the fence
 * is stripped is a genuinely unusable answer and returns null, which the caller
 * reports as "could not read the image" rather than as an empty catalogue.
 */
function parseReply(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();

  // A leading apology before a valid object is the other common shape.
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function stringsFrom(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(0, limit);
}

/** Thrown when the provider answered but not with anything usable. */
export class ImageSearchUnreadableError extends Error {
  constructor() {
    super('The assistant did not return a readable answer for this image.');
    this.name = 'ImageSearchUnreadableError';
  }
}

/**
 * Identify a photographed product and match it to the catalogue.
 *
 * Throws `AssistantBusyError` (from the provider) when the deployment's quota
 * is exhausted or the provider is overloaded, and `ImageSearchUnreadableError`
 * when the reply could not be parsed. Both are conditions the route turns into
 * something a customer can act on; neither is an empty result, because "we
 * could not look" and "we looked and found nothing" are different answers and a
 * shopper deserves to know which one they got.
 */
export async function analyseProductImage(
  image: { data: Buffer; mimeType: string },
  options: { signal?: AbortSignal | undefined } = {},
): Promise<ImageSearchAnalysis & { model: string; inputTokens: number; outputTokens: number }> {
  const provider = activeProvider();
  // Unreachable through the route, which checks `isAssistantConfigured()`
  // first. Narrowed rather than asserted so a future caller cannot skip it.
  if (provider === null) throw new ImageSearchUnreadableError();

  const catalogue = await catalogueIndex();

  const result = await provider.describeImage({
    systemPrompt: SYSTEM_PROMPT,
    catalogue: catalogue.text,
    image,
    prompt: USER_PROMPT,
    maxTokens: MAX_TOKENS,
    signal: options.signal,
  });

  const parsed = parseReply(result.text);
  if (typeof parsed !== 'object' || parsed === null) throw new ImageSearchUnreadableError();

  const record = parsed as { description?: unknown; terms?: unknown; slugs?: unknown };

  const description =
    typeof record.description === 'string' ? record.description.trim().slice(0, 300) : '';

  /*
   * The validation that makes the rest of this safe to use.
   *
   * A slug the index does not contain is dropped without comment. That covers
   * a hallucinated product, a slug from a catalogue the model saw in training,
   * and a product unpublished in the sixty seconds since the index was built —
   * all three would otherwise become a card linking to a 404.
   */
  const slugs = stringsFrom(record.slugs, MAX_MATCHES * 2)
    .filter((slug) => catalogue.slugs.has(slug))
    .slice(0, MAX_MATCHES);

  return {
    description,
    terms: stringsFrom(record.terms, 5),
    slugs,
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  };
}

/** The ceiling the route enforces before a byte reaches the provider. */
export const IMAGE_SEARCH_MAX_BYTES = env.UPLOAD_MAX_BYTES;

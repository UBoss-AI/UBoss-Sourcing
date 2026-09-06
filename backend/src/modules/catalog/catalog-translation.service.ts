/**
 * Machine-translating the shop's own catalogue.
 *
 * The interface catalogues are translated once, in the repository, and ship
 * with the product. A shop's products cannot be: every deployment sells
 * something different, and twenty products across seven languages is a hundred
 * and forty pieces of copy - which is precisely why nobody writes them and why
 * a "multilingual" storefront ends up showing English product names to a Greek
 * buyer.
 *
 * So this does the same job as `scripts/auto-translate.mjs`, from inside the
 * admin panel, against `product_translations` and `category_translations`.
 * `translation.service.ts` already defines how those rows are read: field by
 * field, with the base row filling any gap.
 *
 * What it refuses to do:
 *
 *   - **Overwrite a reviewed row.** `isReviewed` means a person read it. A
 *     machine must not undo that, ever, whatever flags are passed.
 *   - **Overwrite an unreviewed row**, unless explicitly asked. Re-running
 *     after adding ten products should cost ten products, not the whole
 *     catalogue's worth of API characters.
 *   - **Translate an identifier.** `sku`, `slug` and variant names stay as they
 *     are: "14G x FEP" is a gauge and a material, and a translator turns that
 *     into confident nonsense.
 */
import { ErrorCode, badRequest } from '../../domain/errors.js';
import { decryptSecret, encryptSecret } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';

/** One settings row, addressed by a fixed id. Mirrors `CurrencyRateSync`. */
const SETTINGS_ID = '00000000000000000000000001';

/**
 * The languages the catalogue is translated into.
 *
 * The interface languages minus English, which is the source. Kept in step
 * with `SUPPORTED_LANGUAGES` in the identity service by hand - a language the
 * UI cannot render is not worth paying to translate copy into.
 */
export const CATALOGUE_LANGUAGES = ['nl', 'fr', 'de', 'el', 'it', 'pl', 'es'] as const;

export type CatalogueLanguage = (typeof CATALOGUE_LANGUAGES)[number];

/** DeepL's own codes differ from ours in one place: Greek is EL either way,
 *  but Dutch is NL, Polish PL... only the case differs. Upper-cased on send. */
function deeplTarget(language: CatalogueLanguage): string {
  return language.toUpperCase();
}

/** DeepL supports a formality setting on all of ours except Greek. */
const FORMAL = new Set<CatalogueLanguage>(['nl', 'fr', 'de', 'it', 'pl', 'es']);

/**
 * Terms that must survive untranslated.
 *
 * Same list and same mechanism as the interface script: wrapped in a tag DeepL
 * is told to ignore. A brand name translated into Greek is not a brand name.
 */
const KEEP = ['UBOSS', 'GSTIN', 'IBAN', 'GDPR'];

/**
 * Wrap the do-not-translate terms, and make the rest safe to send as XML.
 *
 * The escaping is not optional. `tag_handling: xml` means DeepL parses the
 * whole string, so one ampersand in a product description - "Luer Lock & Luer
 * Slip" - fails the entire batch with a parser error that names a column and
 * not a product. Interface strings never hit this; catalogue copy written by a
 * merchant hits it immediately.
 */
function protect(text: string): string {
  let out = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  for (const term of KEEP) out = out.split(term).join(`<x>${term}</x>`);
  return out;
}

function unprotect(text: string): string {
  // Ampersand last, so an escaped `&lt;` in the source does not come back as
  // a literal `<`.
  return text
    .replace(/<\/?x>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface CatalogTranslationSettings {
  /** Whether a provider key is stored. The key itself is never returned. */
  hasApiKey: boolean;
  /** Last four characters, so staff can tell which key is in there. */
  apiKeyHint: string | null;
  isRunning: boolean;
  lastRunAt: string | null;
  lastRunStatus: 'ok' | 'skipped' | 'failed' | null;
  lastRunMessage: string | null;
  lastRunTranslated: number;
}

interface SettingsRow {
  apiKeyEncrypted: string | null;
  apiKeyHint: string | null;
  isRunning: boolean;
  lastRunAt: Date | null;
  lastRunStatus: string | null;
  lastRunMessage: string | null;
  lastRunTranslated: number;
}

function view(row: SettingsRow): CatalogTranslationSettings {
  return {
    hasApiKey: row.apiKeyEncrypted !== null,
    apiKeyHint: row.apiKeyHint,
    isRunning: row.isRunning,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastRunStatus:
      row.lastRunStatus === 'ok' || row.lastRunStatus === 'skipped' || row.lastRunStatus === 'failed'
        ? row.lastRunStatus
        : null,
    lastRunMessage: row.lastRunMessage,
    lastRunTranslated: row.lastRunTranslated,
  };
}

async function settingsRow(): Promise<SettingsRow> {
  return prisma.catalogTranslationSync.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID },
    update: {},
  });
}

export async function getCatalogTranslationSettings(): Promise<CatalogTranslationSettings> {
  return view(await settingsRow());
}

/** Store a provider key. Encrypted at rest; only the last four are readable. */
export async function setCatalogTranslationKey(
  apiKey: string,
  actorId: string | null,
): Promise<CatalogTranslationSettings> {
  const trimmed = apiKey.trim();

  if (trimmed.length < 8) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'That does not look like an API key.', [
      { field: 'apiKey', code: ErrorCode.VALIDATION_FAILED },
    ]);
  }

  const row = await prisma.catalogTranslationSync.upsert({
    where: { id: SETTINGS_ID },
    create: {
      id: SETTINGS_ID,
      apiKeyEncrypted: encryptSecret(trimmed),
      apiKeyHint: trimmed.slice(-4),
      updatedById: actorId,
    },
    update: {
      apiKeyEncrypted: encryptSecret(trimmed),
      apiKeyHint: trimmed.slice(-4),
      updatedById: actorId,
    },
  });

  return view(row);
}

export async function clearCatalogTranslationKey(
  actorId: string | null,
): Promise<CatalogTranslationSettings> {
  const row = await prisma.catalogTranslationSync.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID },
    update: { apiKeyEncrypted: null, apiKeyHint: null, updatedById: actorId },
  });

  return view(row);
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

/**
 * Which host a key belongs to.
 *
 * DeepL splits its free and paid tiers across two hostnames and distinguishes
 * them by a `:fx` suffix on the key. Sending a free key to the paid host is a
 * 403 that reads like an authentication failure, which is a genuinely
 * confusing thing to debug, so it is decided here rather than configured.
 */
function endpointFor(apiKey: string): string {
  return apiKey.endsWith(':fx')
    ? 'https://api-free.deepl.com/v2/translate'
    : 'https://api.deepl.com/v2/translate';
}

/** DeepL accepts many texts per call; this is its documented ceiling. */
const BATCH_SIZE = 50;

/**
 * Rows translated per language, per run.
 *
 * This runs inside the HTTP request that asked for it, so it has to finish
 * inside one. A twenty-product catalogue takes well under a minute; a
 * five-thousand-product one would take an hour and time out somewhere in the
 * middle, having spent the characters anyway. Capping it means a large
 * catalogue is translated by pressing the button a few times, and every press
 * makes progress that is already saved.
 */
const MAX_ROWS_PER_LANGUAGE = 100;

async function translateBatch(
  apiKey: string,
  texts: readonly string[],
  language: CatalogueLanguage,
): Promise<string[]> {
  const response = await fetch(endpointFor(apiKey), {
    method: 'POST',
    headers: {
      authorization: `DeepL-Auth-Key ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      text: texts.map(protect),
      source_lang: 'EN',
      target_lang: deeplTarget(language),
      // XML handling is only here to make `<x>` mean "leave this alone".
      tag_handling: 'xml',
      ignore_tags: ['x'],
      ...(FORMAL.has(language) ? { formality: 'prefer_more' } : {}),
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `The translation provider answered ${String(response.status)}${detail === '' ? '' : `: ${detail.slice(0, 200)}`}`,
    );
  }

  const body: unknown = await response.json();
  const translations =
    typeof body === 'object' && body !== null && 'translations' in body
      ? (body).translations
      : null;

  if (!Array.isArray(translations) || translations.length !== texts.length) {
    throw new Error('The translation provider returned an unexpected response.');
  }

  return translations.map((entry) => {
    const text = (entry as { text?: unknown }).text;
    if (typeof text !== 'string') throw new Error('A translation came back empty.');
    return unprotect(text);
  });
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface CatalogTranslationRequest {
  /** Which languages to fill. Defaults to all of them. */
  languages?: readonly CatalogueLanguage[];
  /**
   * Replace rows that already exist and have not been reviewed. Reviewed rows
   * are never replaced, whatever this says.
   */
  overwrite?: boolean;
  /** Count the work without sending anything or spending any characters. */
  dryRun?: boolean;
}

export interface CatalogTranslationResult {
  status: 'ok' | 'skipped' | 'failed';
  message: string;
  /** Rows written, per language. */
  byLanguage: { language: string; products: number; categories: number }[];
  translated: number;
  /** Rows the per-run cap could not reach. Press again to continue. */
  remaining: number;
  /** Characters sent, so the panel can show what a run costs. */
  characters: number;
}

/** The fields translated for a product, in a fixed order the batch relies on. */
const PRODUCT_FIELDS = [
  'name',
  'shortDescription',
  'description',
  'metaTitle',
  'metaDescription',
] as const;

const CATEGORY_FIELDS = ['name', 'description', 'metaTitle', 'metaDescription'] as const;

interface Pending {
  kind: 'product' | 'category';
  id: string;
  /** Field name to source text, only for fields that have something to say. */
  fields: Map<string, string>;
}

/**
 * Translate the catalogue into every language that is missing copy.
 *
 * One provider call per batch of fifty strings, per language. Each language is
 * committed on its own: Greek failing halfway must not throw away the French
 * that already succeeded.
 */
export async function translateCatalogue(
  request: CatalogTranslationRequest,
  actorId: string | null,
): Promise<CatalogTranslationResult> {
  const row = await settingsRow();

  if (row.apiKeyEncrypted === null) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Add a DeepL API key before translating the catalogue.',
      [{ field: 'apiKey', code: ErrorCode.VALIDATION_FAILED }],
    );
  }

  const apiKey = decryptSecret(row.apiKeyEncrypted);
  const languages = request.languages ?? CATALOGUE_LANGUAGES;
  const dryRun = request.dryRun === true;

  const [products, categories] = await Promise.all([
    prisma.product.findMany({
      where: { archivedAt: null },
      select: {
        id: true,
        name: true,
        shortDescription: true,
        description: true,
        metaTitle: true,
        metaDescription: true,
        translations: { select: { language: true, isReviewed: true } },
      },
    }),
    prisma.category.findMany({
      where: { archivedAt: null },
      select: {
        id: true,
        name: true,
        description: true,
        metaTitle: true,
        metaDescription: true,
        translations: { select: { language: true, isReviewed: true } },
      },
    }),
  ]);

  const byLanguage: CatalogTranslationResult['byLanguage'] = [];
  const failures: string[] = [];
  let translated = 0;
  let characters = 0;
  /** Rows this run could not reach because of the per-run cap. */
  let remaining = 0;

  if (!dryRun) {
    await prisma.catalogTranslationSync.update({
      where: { id: SETTINGS_ID },
      data: { isRunning: true },
    });
  }

  try {
    for (const language of languages) {
      const pending: Pending[] = [];

      for (const product of products) {
        const existing = product.translations.find((row) => row.language === language);
        if (existing?.isReviewed === true) continue;
        if (existing !== undefined && request.overwrite !== true) continue;

        const fields = new Map<string, string>();
        for (const field of PRODUCT_FIELDS) {
          const value = product[field];
          if (typeof value === 'string' && value.trim() !== '') fields.set(field, value);
        }

        if (fields.size > 0) pending.push({ kind: 'product', id: product.id, fields });
      }

      for (const category of categories) {
        const existing = category.translations.find((row) => row.language === language);
        if (existing?.isReviewed === true) continue;
        if (existing !== undefined && request.overwrite !== true) continue;

        const fields = new Map<string, string>();
        for (const field of CATEGORY_FIELDS) {
          const value = category[field];
          if (typeof value === 'string' && value.trim() !== '') fields.set(field, value);
        }

        if (fields.size > 0) pending.push({ kind: 'category', id: category.id, fields });
      }

      // Bounded so one run finishes inside one request. Whatever is left is
      // picked up by the next press, because rows already written are skipped.
      const batch = pending.slice(0, MAX_ROWS_PER_LANGUAGE);
      if (pending.length > batch.length) remaining += pending.length - batch.length;

      // A flat list of every string, with a note of where each came back to.
      const texts: string[] = [];
      const origins: { entry: Pending; field: string }[] = [];

      for (const entry of batch) {
        for (const [field, value] of entry.fields) {
          texts.push(value);
          origins.push({ entry, field });
        }
      }

      characters += texts.reduce((total, text) => total + text.length, 0);

      const productCount = batch.filter((entry) => entry.kind === 'product').length;
      const categoryCount = batch.length - productCount;
      byLanguage.push({ language, products: productCount, categories: categoryCount });

      if (dryRun || texts.length === 0) {
        translated += batch.length;
        continue;
      }

      try {
        const output: string[] = [];
        for (let index = 0; index < texts.length; index += BATCH_SIZE) {
          output.push(...(await translateBatch(apiKey, texts.slice(index, index + BATCH_SIZE), language)));
        }

        // Fold the flat results back onto the rows they belong to.
        const copy = new Map<Pending, Record<string, string>>();
        output.forEach((text, index) => {
          const origin = origins[index];
          if (origin === undefined) return;

          const target = copy.get(origin.entry) ?? {};
          target[origin.field] = text;
          copy.set(origin.entry, target);
        });

        for (const [entry, values] of copy) {
          const name = values.name;
          // The name is the one field a row cannot exist without, and the
          // schema agrees - so a response that lost it is skipped rather than
          // written as an empty product title.
          if (typeof name !== 'string' || name.trim() === '') continue;

          if (entry.kind === 'product') {
            await prisma.productTranslation.upsert({
              where: { productId_language: { productId: entry.id, language } },
              create: {
                id: newId(),
                productId: entry.id,
                language,
                name,
                shortDescription: values.shortDescription ?? null,
                description: values.description ?? null,
                metaTitle: values.metaTitle ?? null,
                metaDescription: values.metaDescription ?? null,
              },
              update: {
                name,
                shortDescription: values.shortDescription ?? null,
                description: values.description ?? null,
                metaTitle: values.metaTitle ?? null,
                metaDescription: values.metaDescription ?? null,
                // Machine output. Whoever reads it sets this, not us.
                isReviewed: false,
              },
            });
          } else {
            await prisma.categoryTranslation.upsert({
              where: { categoryId_language: { categoryId: entry.id, language } },
              create: {
                id: newId(),
                categoryId: entry.id,
                language,
                name,
                description: values.description ?? null,
                metaTitle: values.metaTitle ?? null,
                metaDescription: values.metaDescription ?? null,
              },
              update: {
                name,
                description: values.description ?? null,
                metaTitle: values.metaTitle ?? null,
                metaDescription: values.metaDescription ?? null,
                isReviewed: false,
              },
            });
          }

          translated += 1;
        }
      } catch (cause) {
        failures.push(`${language}: ${cause instanceof Error ? cause.message : 'failed'}`);
      }
    }
  } finally {
    if (!dryRun) {
      const status: CatalogTranslationResult['status'] =
        failures.length > 0 && translated === 0 ? 'failed' : translated === 0 ? 'skipped' : 'ok';

      const message =
        failures.length > 0
          ? failures.join(' ')
          : translated === 0
            ? 'Everything is already translated.'
            : `${String(translated)} rows translated.`;

      await prisma.catalogTranslationSync.update({
        where: { id: SETTINGS_ID },
        data: {
          isRunning: false,
          lastRunAt: new Date(),
          lastRunStatus: status,
          lastRunMessage: message.slice(0, 512),
          lastRunTranslated: translated,
          updatedById: actorId,
        },
      });
    }
  }

  const status: CatalogTranslationResult['status'] =
    failures.length > 0 && translated === 0 ? 'failed' : translated === 0 ? 'skipped' : 'ok';

  const result: CatalogTranslationResult = {
    status,
    message:
      failures.length > 0
        ? failures.join(' ')
        : translated === 0
          ? 'Everything is already translated.'
          : `${String(translated)} rows translated.`,
    byLanguage,
    translated,
    remaining,
    characters,
  };

  if (!dryRun) logger.info({ ...result, byLanguage: undefined }, 'catalogue translation finished');

  return result;
}

/** Rows a language is still missing, for the panel's coverage line. */
export async function catalogueTranslationCoverage(): Promise<
  { language: string; products: number; categories: number }[]
> {
  const [productTotal, categoryTotal, productRows, categoryRows] = await Promise.all([
    prisma.product.count({ where: { archivedAt: null } }),
    prisma.category.count({ where: { archivedAt: null } }),
    prisma.productTranslation.groupBy({ by: ['language'], _count: true }),
    prisma.categoryTranslation.groupBy({ by: ['language'], _count: true }),
  ]);

  const products = new Map(productRows.map((row) => [row.language, row._count]));
  const categories = new Map(categoryRows.map((row) => [row.language, row._count]));

  return CATALOGUE_LANGUAGES.map((language) => ({
    language,
    products: productTotal - (products.get(language) ?? 0),
    categories: categoryTotal - (categories.get(language) ?? 0),
  }));
}

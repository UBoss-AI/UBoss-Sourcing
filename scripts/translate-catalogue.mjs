#!/usr/bin/env node
/**
 * Fills in missing product and category copy from the base row, via DeepL.
 *
 *     cd backend
 *     node ../scripts/translate-catalogue.mjs --dry-run
 *     node ../scripts/translate-catalogue.mjs
 *     node ../scripts/translate-catalogue.mjs --only=pl,el
 *
 * Run from `backend/`, because it uses that package's Prisma client and reads
 * its `.env` for `DATABASE_URL`. Needs `DEEPL_API_KEY` in the environment.
 *
 * This is the catalogue twin of `auto-translate.mjs`, which does the same job
 * for the interface strings. Same rules apply:
 *
 *   - It never overwrites an existing row. Only the (row, language) pairs that
 *     have no translation are sent, so it is safe to re-run and a human
 *     correction is permanent.
 *   - Everything it writes is left `isReviewed: false`. The admin panel shows
 *     that as "not checked", which is the only thing that makes the review
 *     actually happen.
 *   - Formality is pinned where DeepL supports it, so a supplier's catalogue
 *     does not drift between the polite and familiar registers mid-listing.
 *
 * WHAT IT WILL NOT TRANSLATE
 *
 *   - `slug` and `sku` - one URL per product, and a SKU is an identifier.
 *   - `descriptionHtml` - the rich-text body carries markup this table has no
 *     way to keep in step with the plain-text copy.
 *   - `product_variants.name` - those read "14G x FEP": a gauge and a
 *     material, identical in every language and actively wrong to translate.
 */
import process from 'node:process';
// The backend's own configured client, not a fresh PrismaClient: Prisma 7
// connects through a driver adapter, and duplicating that setup here would be
// a second place for the connection details to drift.
import { prisma } from '../backend/src/infra/prisma.js';

const TARGETS = ['nl', 'fr', 'de', 'el', 'it', 'pl', 'es'];
const FORMAL = new Set(['nl', 'fr', 'de', 'it', 'pl', 'es']);
const KEEP = ['UBOSS', 'GSTIN', 'IBAN'];

const flags = process.argv.slice(2);
const dryRun = flags.includes('--dry-run');
const only = flags.find((f) => f.startsWith('--only='))?.slice('--only='.length);
const languages = only === undefined ? TARGETS : only.split(',').filter((l) => TARGETS.includes(l));

/** Product codes and measurements must survive a translation unchanged. */
function protect(text) {
  let out = text;
  for (const term of KEEP) out = out.split(term).join(`<x>${term}</x>`);
  // "14G", "45 mm", "2.5 ml" - a translator has no business reordering these.
  out = out.replace(/\b(\d+(?:\.\d+)?\s?(?:G|mm|cm|ml|l|kg|g|mg|mcg|Fr|in|")|\d+G)\b/gi, '<x>$1</x>');
  return out;
}

function unprotect(text) {
  return text.replace(/<\/?x>/g, '');
}

let translator = null;
if (!dryRun) {
  const key = process.env.DEEPL_API_KEY;
  if (key === undefined || key === '') {
    console.error('DEEPL_API_KEY is not set. Re-run with --dry-run to see what would be sent.');
    process.exit(1);
  }
  const deepl = await import('deepl-node');
  translator = new deepl.Translator(key);
}

async function translateMany(texts, language) {
  if (texts.length === 0) return [];

  const results = await translator.translateText(texts.map(protect), 'en', language, {
    tagHandling: 'xml',
    ignoreTags: ['x'],
    ...(FORMAL.has(language) ? { formality: 'prefer_more' } : {}),
  });

  return results.map((entry) => unprotect(entry.text));
}

/** ULID-ish id, matching what the backend's `newId()` produces in shape. */
function newId() {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let out = '';
  for (let i = 0; i < 26; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

let totalChars = 0;
let totalRows = 0;

// --- categories -----------------------------------------------------------
const categories = await prisma.category.findMany({
  where: { archivedAt: null },
  select: { id: true, name: true, description: true, translations: { select: { language: true } } },
});

// --- products -------------------------------------------------------------
const products = await prisma.product.findMany({
  where: { archivedAt: null },
  select: {
    id: true,
    name: true,
    shortDescription: true,
    description: true,
    translations: { select: { language: true } },
  },
});

console.log(
  `${String(categories.length)} categories, ${String(products.length)} products, ` +
    `${String(languages.length)} languages\n`,
);

for (const language of languages) {
  const missingCategories = categories.filter(
    (row) => !row.translations.some((t) => t.language === language),
  );
  const missingProducts = products.filter(
    (row) => !row.translations.some((t) => t.language === language),
  );

  const chars =
    missingCategories.reduce((n, r) => n + r.name.length + (r.description?.length ?? 0), 0) +
    missingProducts.reduce(
      (n, r) => n + r.name.length + (r.shortDescription?.length ?? 0) + (r.description?.length ?? 0),
      0,
    );

  totalChars += chars;
  totalRows += missingCategories.length + missingProducts.length;

  console.log(
    `${language}: ${String(missingCategories.length)} categories, ` +
      `${String(missingProducts.length)} products (${String(chars)} chars)` +
      (dryRun ? '  [dry run]' : ''),
  );

  if (dryRun) continue;

  for (const row of missingCategories) {
    const [name, description] = await translateMany(
      [row.name, row.description ?? ''].filter((_, i) => i === 0 || row.description !== null),
      language,
    );

    await prisma.categoryTranslation.create({
      data: {
        id: newId(),
        categoryId: row.id,
        language,
        name,
        description: row.description === null ? null : (description ?? null),
        isReviewed: false,
      },
    });
  }

  for (const row of missingProducts) {
    // One request per product rather than per field: DeepL charges by
    // character, not by call, and keeping a product's fields in one request
    // gives the engine the surrounding context to disambiguate a term.
    const fields = [row.name, row.shortDescription, row.description];
    const present = fields.filter((f) => f !== null && f !== '');
    const translated = await translateMany(present, language);

    let cursor = 0;
    const next = (original) => (original === null || original === '' ? null : translated[cursor++]);

    const name = next(row.name);
    const shortDescription = next(row.shortDescription);
    const description = next(row.description);

    await prisma.productTranslation.create({
      data: {
        id: newId(),
        productId: row.id,
        language,
        name: name ?? row.name,
        shortDescription,
        description,
        isReviewed: false,
      },
    });
  }
}

console.log(
  `\ntotal: ${String(totalRows)} rows, ${String(totalChars)} characters` +
    (dryRun ? ' would be sent' : ' sent'),
);

if (!dryRun && totalRows > 0) {
  console.log(
    '\nEvery row was written with isReviewed = false.\n' +
      'The admin panel lists those as unchecked - that list is the review queue.',
  );
}

await prisma.$disconnect();

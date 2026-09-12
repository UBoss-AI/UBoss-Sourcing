/**
 * Give catalogue products their photograph.
 *
 *   cd backend
 *   npm run catalog:images              # dry run
 *   npm run catalog:images -- --apply
 *
 * A dry run is the default, for the same reason it is on the sheet importer:
 * the destructive spelling should be the one you have to type.
 *
 * THREE RULES
 *
 * **It only ever adds.** A product that already has a photograph is left
 * alone, always — an administrator's upload outranks anything decided by a
 * table in this repository, and a second run must not pile a stock shot on top
 * of a real one.
 *
 * **One upload per photograph, not per product.** Two hundred cannulae share
 * one `media_assets` row between them. Uploading the same 32 KB two hundred
 * times would put 6 MB in the storage driver to say one thing.
 *
 * **A product with no matching photograph gets none,** and is counted in the
 * report by department so it is obvious what still needs photographing. See
 * `image-rules.ts` for why a near-miss is worse than the placeholder.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newId } from '../../../infra/ids.js';
import { prisma } from '../../../infra/prisma.js';
import { storage } from '../../../infra/storage/index.js';
import {
  imageRuleFor,
  PRODUCT_IMAGE_RULES,
  type ProductImageRule,
} from './image-rules.js';

const ASSETS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'assets',
  'product-images',
);

interface Arguments {
  apply: boolean;
}

function parseArguments(argv: string[]): Arguments {
  let apply = false;
  for (const argument of argv) {
    if (argument === '--apply') apply = true;
    else throw new Error(`Unknown option "${argument}".`);
  }
  return { apply };
}

/** The administrator the upload is recorded against. */
async function resolveActorId(): Promise<string> {
  const user = await prisma.user.findFirst({
    where: { type: 'ADMIN', status: 'ACTIVE' },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });

  if (user === null) {
    throw new Error('No active administrator was found to attribute these uploads to.');
  }
  return user.id;
}

/**
 * Upload one photograph, or reuse the row a previous run made.
 *
 * Matched on the checksum the storage driver computes, which is what
 * `media_assets.checksum` and its index exist for — so re-running this after a
 * database reset does not fill the storage driver with identical files.
 */
async function mediaIdFor(
  rule: ProductImageRule,
  actorId: string,
  cache: Map<string, string>,
): Promise<string> {
  const cached = cache.get(rule.file);
  if (cached !== undefined) return cached;

  const bytes = await readFile(path.join(ASSETS, rule.file));
  const stored = await storage.put(bytes, 'image/jpeg', 'jpg');

  const existing = await prisma.mediaAsset.findFirst({
    where: { checksum: stored.checksum },
    select: { id: true },
  });

  if (existing !== null) {
    cache.set(rule.file, existing.id);
    return existing.id;
  }

  const id = newId();
  await prisma.mediaAsset.create({
    data: {
      id,
      storageKey: stored.storageKey,
      url: stored.url,
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      width: stored.width ?? null,
      height: stored.height ?? null,
      altText: rule.altText,
      checksum: stored.checksum,
      uploadedById: actorId,
    },
  });

  cache.set(rule.file, id);
  return id;
}

async function main(): Promise<void> {
  const { apply } = parseArguments(process.argv.slice(2));

  // Only products with no photograph at all. An administrator's upload is
  // never competed with.
  const products = await prisma.product.findMany({
    where: { archivedAt: null, media: { none: {} } },
    select: {
      id: true,
      name: true,
      category: { select: { name: true } },
      importRecords: {
        take: 1,
        select: { genericName: true, brand: true },
      },
    },
    orderBy: { name: 'asc' },
  });

  const matched = new Map<string, string[]>();
  const unmatched = new Map<string, number>();

  for (const product of products) {
    const record = product.importRecords[0];
    const rule = imageRuleFor({
      categoryName: product.category.name,
      genericName: record?.genericName ?? product.name,
      brand: record?.brand ?? '',
    });

    if (rule === null) {
      unmatched.set(product.category.name, (unmatched.get(product.category.name) ?? 0) + 1);
      continue;
    }

    matched.set(rule.file, [...(matched.get(rule.file) ?? []), product.id]);
  }

  const total = [...matched.values()].reduce((sum, ids) => sum + ids.length, 0);

  console.log(apply ? 'Attaching photographs.' : 'DRY RUN — nothing will be written.');
  console.log('');
  console.log(`Products with no image   ${String(products.length)}`);
  console.log(`Matched to a photograph  ${String(total)}`);
  console.log(`Left without one         ${String(products.length - total)}`);
  console.log('');
  console.log('By photograph');
  console.log('-------------');
  for (const [file, ids] of [...matched].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${String(ids.length).padStart(4)}  ${file}`);
  }

  if (unmatched.size > 0) {
    console.log('');
    console.log('Departments with no photograph in Images/');
    console.log('-----------------------------------------');
    for (const [category, count] of [...unmatched].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(4)}  ${category}`);
    }
    console.log('');
    console.log('These keep the neutral placeholder. Photograph them and add a rule');
    console.log('in image-rules.ts — nothing here invents a picture for them.');
  }

  if (!apply) {
    console.log('');
    console.log('Re-run with --apply to attach them.');
    return;
  }

  const actorId = await resolveActorId();
  const cache = new Map<string, string>();
  let attached = 0;

  for (const [file, productIds] of matched) {
    // The file came out of a rule a moment ago, so this cannot miss - but it
    // is a lookup rather than an assertion, because a rule renamed between the
    // two passes should skip its photograph rather than crash halfway through
    // attaching two hundred of them.
    const rule = PRODUCT_IMAGE_RULES.find((candidate) => candidate.file === file);
    if (rule === undefined) continue;

    const mediaId = await mediaIdFor(rule, actorId, cache);

    // One transaction per photograph rather than one for all of them: a single
    // transaction holding two hundred inserts across the whole run is a long
    // lock for no extra safety — each link is independent of every other.
    await prisma.$transaction(async (tx) => {
      for (const productId of productIds) {
        await tx.productMedia.create({
          data: { id: newId(), productId, mediaId, sortOrder: 0, isPrimary: true },
        });
      }
    });

    attached += productIds.length;
    console.log(`  attached ${String(productIds.length).padStart(4)}  ${file}`);
  }

  console.log('');
  console.log(`Attached ${String(attached)} product images from ${String(cache.size)} uploads.`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });

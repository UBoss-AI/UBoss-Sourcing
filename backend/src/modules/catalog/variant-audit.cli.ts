/**
 * Audit and re-normalise variant option signatures.
 *
 * The migration that introduced `optionSignature` computed it in SQL, because
 * a constraint and the backfill that makes it possible have to be in the same
 * transaction as each other or a deployment can end up with one and not the
 * other. SQL cannot do what the application does - sort the axes by key, fold
 * accents, hold a measurement's number and unit apart - so the historical rows
 * carry a coarser signature than anything written since.
 *
 * This brings them onto the application's own form, and reports what it found
 * on the way. Run it once after upgrading; run it again whenever you want the
 * report.
 *
 *   npm run variants:audit            # report only, changes nothing
 *   npm run variants:audit -- --apply # rewrite the signatures it can
 *
 * Three things it will not do, and they are the point rather than omissions:
 *
 *   - **It never merges two variants.** Two rows that describe themselves
 *     identically are a data problem for a human to look at, not a row for a
 *     script to delete. Both are on somebody's order. It reports them and
 *     leaves both signatures distinct.
 *   - **It never edits an option value.** The seller wrote what they wrote.
 *   - **It never touches a row it cannot rewrite safely.** A rewrite that
 *     would collide with another row on the same product is skipped and
 *     reported, so the run is idempotent and can be repeated.
 */
import { signatureOfMap } from '../../domain/variants/axis.js';
import { prisma } from '../../infra/prisma.js';

interface AuditRow {
  id: string;
  productId: string;
  sku: string;
  name: string;
  optionsJson: unknown;
  optionSignature: string;
}

/** `optionsJson` as a flat map, or null when it is not one. */
function optionsOf(value: unknown): Record<string, string> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;

  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') result[key] = entry;
    else if (typeof entry === 'number' || typeof entry === 'boolean') result[key] = String(entry);
    else return null;
  }
  return result;
}

export interface AuditReport {
  /** Rows whose stored signature already matches what the application computes. */
  alreadyCanonical: number;
  /** Rows rewritten to the canonical form (or that would be, on a dry run). */
  rewritten: number;
  /** Rows left alone because rewriting them would collide with a sibling. */
  skipped: { id: string; sku: string; reason: string }[];
  /**
   * Products whose variants do not distinguish themselves by their options.
   *
   * Reported rather than fixed. This is a catalogue that has more SKUs than it
   * has ways of telling them apart, which nothing automatic can resolve - only
   * whoever knows what the difference actually is.
   */
  indistinct: { productId: string; signature: string; skus: string[] }[];
}

export async function auditVariantSignatures(apply: boolean): Promise<AuditReport> {
  const rows = (await prisma.productVariant.findMany({
    select: {
      id: true,
      productId: true,
      sku: true,
      name: true,
      optionsJson: true,
      optionSignature: true,
    },
    orderBy: [{ productId: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
  })) as unknown as AuditRow[];

  const report: AuditReport = {
    alreadyCanonical: 0,
    rewritten: 0,
    skipped: [],
    indistinct: [],
  };

  // Signatures already in use, per product, so a rewrite cannot take one.
  const takenByProduct = new Map<string, Set<string>>();
  for (const row of rows) {
    const held = takenByProduct.get(row.productId) ?? new Set<string>();
    held.add(row.optionSignature);
    takenByProduct.set(row.productId, held);
  }

  // Products whose option maps repeat. Grouped on the CANONICAL signature, so
  // this finds "Black" and "black" as well as two identical maps.
  const canonicalGroups = new Map<string, AuditRow[]>();

  for (const row of rows) {
    const options = optionsOf(row.optionsJson);
    if (options === null) {
      report.skipped.push({
        id: row.id,
        sku: row.sku,
        reason: 'options are not a flat map of values',
      });
      continue;
    }

    if (Object.keys(options).length === 0) {
      // A variant with no options at all. It keeps the `legacy-<id>` signature
      // the migration gave it, which is unique and harmless - and it is
      // reported, because a variant that says nothing about itself is one a
      // buyer cannot choose between and a picker cannot label.
      report.skipped.push({
        id: row.id,
        sku: row.sku,
        reason: 'no option values recorded - nothing distinguishes this variant',
      });
      continue;
    }

    let canonical: string;
    try {
      canonical = signatureOfMap(options);
    } catch (error) {
      report.skipped.push({ id: row.id, sku: row.sku, reason: (error as Error).message });
      continue;
    }

    const groupKey = `${row.productId}\u0000${canonical}`;
    canonicalGroups.set(groupKey, [...(canonicalGroups.get(groupKey) ?? []), row]);
  }

  for (const [groupKey, group] of canonicalGroups) {
    const [productId = '', canonical = ''] = groupKey.split('\u0000');

    if (group.length > 1) {
      report.indistinct.push({
        productId,
        signature: canonical,
        skus: group.map((row) => row.sku),
      });
      // Every row in an indistinct group keeps the disambiguated signature the
      // migration gave it. Rewriting them to the canonical form is exactly the
      // collision the index exists to prevent.
      continue;
    }

    const row = group[0];
    if (row === undefined) continue;

    if (row.optionSignature === canonical) {
      report.alreadyCanonical += 1;
      continue;
    }

    const taken = takenByProduct.get(productId) ?? new Set<string>();
    if (taken.has(canonical)) {
      report.skipped.push({
        id: row.id,
        sku: row.sku,
        reason: `another variant of this product already holds "${canonical}"`,
      });
      continue;
    }

    if (apply) {
      await prisma.productVariant.update({
        where: { id: row.id },
        data: { optionSignature: canonical },
      });
    }

    taken.delete(row.optionSignature);
    taken.add(canonical);
    takenByProduct.set(productId, taken);
    report.rewritten += 1;
  }

  return report;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');

  const report = await auditVariantSignatures(apply);

  console.log('');
  console.log(apply ? 'Variant signature audit (applied)' : 'Variant signature audit (dry run)');
  console.log('----------------------------------------------');
  console.log(`  already canonical : ${report.alreadyCanonical}`);
  console.log(`  ${apply ? 'rewritten        ' : 'would rewrite    '} : ${report.rewritten}`);
  console.log(`  skipped           : ${report.skipped.length}`);
  console.log(`  indistinct groups : ${report.indistinct.length}`);

  if (report.skipped.length > 0) {
    console.log('');
    console.log('Skipped:');
    for (const entry of report.skipped) console.log(`  ${entry.sku}  ${entry.reason}`);
  }

  if (report.indistinct.length > 0) {
    console.log('');
    console.log('These products have variants their options cannot tell apart.');
    console.log('Nothing is broken and nothing was changed - each still has its own SKU and');
    console.log('sells normally. Add the missing option (tip, sterilisation, finish) to each');
    console.log('so the difference is visible to a buyer as well as on the label.');
    console.log('');
    for (const entry of report.indistinct) {
      console.log(`  product ${entry.productId}  [${entry.signature}]`);
      console.log(`    ${entry.skus.join(', ')}`);
    }
  }

  if (!apply && report.rewritten > 0) {
    console.log('');
    console.log('Re-run with --apply to write these.');
  }

  await prisma.$disconnect();
}

if (process.argv[1]?.includes('variant-audit')) {
  await main();
}

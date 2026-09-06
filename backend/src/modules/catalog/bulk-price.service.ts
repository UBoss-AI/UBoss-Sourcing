/**
 * Filling a whole currency's price list in one pass.
 *
 * The catalogue holds a real, staff-entered figure per currency and never
 * converts at read time - `price.service.ts` explains why, and nothing here
 * weakens it. This is a *writing* tool: it converts once, at a rate staff chose
 * and can see, and stores the result as ordinary price rows. From that moment
 * the numbers are exactly as real as hand-typed ones. They do not move when the
 * rate moves, they can be edited product by product afterwards, and the price
 * quoted is still the price charged.
 *
 * That distinction is the whole design. A live conversion would make every
 * displayed price a guess at settlement time; a one-off conversion is just a
 * faster way of typing.
 *
 * Two safeguards are deliberate:
 *
 *   - **The base currency can never be a target.** It is the source of truth
 *     the mirror on `products` and every report key off. Overwriting it with a
 *     converted number would make the authoritative figure derived.
 *   - **Existing prices are kept unless asked for.** A market somebody has
 *     already priced by hand is the case most worth protecting: re-running this
 *     must not quietly undo a deliberate local price.
 *
 * Every SKU is converted, variants included, so a variant that costs more than
 * its base product in rupees still does in euro.
 */
import { ErrorCode, badRequest } from '../../domain/errors.js';
import { currencyExponent, type Minor } from '../../domain/money.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';

/** How a converted figure is tidied into a price a human would have typed. */
export type PriceRounding =
  /** Keep the exact conversion, to the minor unit. */
  | 'exact'
  /** Up to the next whole major unit: 45.30 -> 46.00. */
  | 'whole'
  /** Up to the next .99: 45.30 -> 45.99, and 45.00 -> 45.99. */
  | 'charm';

export interface BulkPriceRequest {
  /** Currency the prices are read from. Normally the base currency. */
  sourceCurrency: string;
  /** Currency being filled in. Never the base currency. */
  targetCurrency: string;
  /** Exact decimal: one major unit of source buys this many of target. */
  rate: string;
  rounding: PriceRounding;
  /** Replace prices already entered in the target currency. */
  overwriteExisting: boolean;
  /** Restrict to one category. Null covers the whole catalogue. */
  categoryId?: string | null;

  /**
   * Flag what is written as rate-maintained, so the scheduled refresh may keep
   * it current. False writes prices the refresh will never touch again.
   */
  autoManaged?: boolean;

  /**
   * Only replace prices that are themselves rate-maintained.
   *
   * This is what makes the scheduled refresh safe to leave running: a price a
   * person typed for this market outranks the rate permanently, and the job
   * has no way to reach it. Manual runs leave this off - staff overwriting
   * their own prices is a decision they are making on purpose.
   */
  restrictToAutoManaged?: boolean;

  /**
   * Abandon the whole run if any single price would move by more than this
   * percentage. Null disables the check.
   *
   * Aimed at an unattended run: a feed that returns a wrong base, a shifted
   * decimal, or an error body that happens to parse is a catalogue-wide
   * mispricing nobody is watching for. Refusing entirely beats writing half of
   * it and leaving two rates live at once.
   */
  maxDriftPercent?: string | null;
}

export interface BulkPriceLine {
  productId: string;
  sku: string;
  name: string;
  /** The variant's own SKU suffix, or null for the base product. */
  variantKey: string | null;
  sourceMinor: string;
  targetMinor: string;
  /** What is already stored in the target currency, when anything is. */
  existingMinor: string | null;
  /** Why this row will not be written, or null when it will be. */
  skipped: 'existing' | null;
}

export interface BulkPriceResult {
  sourceCurrency: string;
  targetCurrency: string;
  /** SKUs found with a price in the source currency. */
  scanned: number;
  /** SKUs that will be, or were, written. */
  writable: number;
  /** SKUs left alone because they are already priced in the target. */
  skippedExisting: number;
  /**
   * SKUs whose exact conversion rounded to nothing and were lifted to one
   * minor unit. A non-zero count means the rate is wrong, or the catalogue
   * holds items too cheap to price in this currency.
   */
  liftedToMinimum: number;
  /**
   * The largest move any single price would make against what is already
   * stored, as a percentage with two decimals. Null when nothing is being
   * replaced, so there is nothing to compare against.
   */
  maxDriftPercent: string | null;
  /** A readable slice of the whole set, for the confirmation screen. */
  sample: BulkPriceLine[];
  /** Rows actually written. Zero for a preview. */
  written: number;
}

/** How many rows the preview carries back. The rest are counted, not listed. */
const SAMPLE_SIZE = 25;

/**
 * The ceiling on one run.
 *
 * Not a performance limit so much as a blast-radius one: a mistyped rate
 * applied to fifty thousand SKUs is not something a confirmation dialog can
 * meaningfully be read for. Narrow by category and run it again.
 */
const MAX_ROWS = 5_000;

/** Half-up, matching every other rounding in `domain/money.ts`. */
function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
}

/** Smallest multiple of `unit` that is not below `amount`. */
function ceilTo(amount: bigint, unit: bigint): bigint {
  const remainder = amount % unit;
  return remainder === 0n ? amount : amount + (unit - remainder);
}

/** The parts of a request that decide the arithmetic, and nothing else. */
export interface ConversionTerms {
  sourceCurrency: string;
  targetCurrency: string;
  rate: string;
  rounding: PriceRounding;
}

export interface Conversion {
  /** Multiply a source minor amount by this... */
  numerator: bigint;
  /** ...then divide by this. Both fold in the two currencies' exponents. */
  denominator: bigint;
  /** One major unit of the target, in minor units. */
  unit: bigint;
  rounding: PriceRounding;
}

/**
 * Turn a rate and two currencies into integer arithmetic.
 *
 * The rate arrives as a decimal string and stays one: parsed as a fraction
 * rather than a float, because `0.011` is not representable in binary and a
 * catalogue-wide price list is the last place to discover that.
 */
export function conversionFor(terms: ConversionTerms): Conversion {
  const trimmed = terms.rate.trim();

  if (!/^\d+(\.\d{1,8})?$/.test(trimmed)) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Enter the rate as a plain decimal, e.g. 0.0105 or 92.50 (up to 8 decimal places).',
      [{ field: 'rate', code: ErrorCode.VALIDATION_FAILED }],
    );
  }

  const [whole = '0', fraction = ''] = trimmed.split('.');
  const scaled = BigInt(whole + fraction);

  if (scaled === 0n) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'The rate must be greater than zero.', [
      { field: 'rate', code: ErrorCode.VALIDATION_FAILED },
    ]);
  }

  const sourceExponent = currencyExponent(terms.sourceCurrency);
  const targetExponent = currencyExponent(terms.targetCurrency);

  return {
    numerator: scaled * 10n ** BigInt(targetExponent),
    denominator: 10n ** BigInt(fraction.length) * 10n ** BigInt(sourceExponent),
    unit: 10n ** BigInt(targetExponent),
    rounding: terms.rounding,
  };
}

export function convert(amount: Minor, conversion: Conversion): Minor {
  const exact = divideRoundHalfUp(amount * conversion.numerator, conversion.denominator);

  if (conversion.rounding === 'exact') return exact;

  const whole = ceilTo(exact, conversion.unit);

  // A zero-decimal currency has no .99 to land on, so charm pricing collapses
  // into whole-unit pricing rather than producing a price one yen below.
  if (conversion.rounding === 'whole' || conversion.unit === 1n) return whole;

  const charm = whole - 1n;
  return charm < exact ? charm + conversion.unit : charm;
}

/**
 * Convert one currency's price list into another.
 *
 * `apply` false answers "what would this do", from exactly the same code path
 * that would do it - the preview cannot drift from the write, because they are
 * one function.
 */
export async function bulkPriceFromCurrency(
  request: BulkPriceRequest,
  baseCurrency: string,
  actorId: string | null,
  apply: boolean,
): Promise<BulkPriceResult> {
  const source = request.sourceCurrency.trim().toUpperCase();
  const target = request.targetCurrency.trim().toUpperCase();

  if (source === target) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Choose a different currency to convert into.',
      [{ field: 'targetCurrency', code: ErrorCode.VALIDATION_FAILED }],
    );
  }

  if (target === baseCurrency) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      `${baseCurrency} is the base currency and every other figure is measured against it. ` +
        'Edit those prices directly rather than converting into them.',
      [{ field: 'targetCurrency', code: ErrorCode.VALIDATION_FAILED }],
    );
  }

  const currency = await prisma.currency.findUnique({
    where: { code: target },
    select: { isActive: true },
  });

  if (currency === null || !currency.isActive) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      `${target} is not an active currency. Activate it in Settings first.`,
      [{ field: 'targetCurrency', code: ErrorCode.VALIDATION_FAILED }],
    );
  }

  const conversion = conversionFor({ ...request, sourceCurrency: source, targetCurrency: target });

  const rows = await prisma.productPrice.findMany({
    where: {
      currencyCode: source,
      product: {
        archivedAt: null,
        ...(request.categoryId === null || request.categoryId === undefined
          ? {}
          : { categoryId: request.categoryId }),
      },
    },
    select: {
      productId: true,
      variantId: true,
      variantKey: true,
      basePriceMinor: true,
      compareAtPriceMinor: true,
      product: { select: { name: true, sku: true } },
    },
    orderBy: [{ product: { name: 'asc' } }, { variantKey: 'asc' }],
    take: MAX_ROWS + 1,
  });

  if (rows.length > MAX_ROWS) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      `This would touch more than ${String(MAX_ROWS)} prices. Narrow it to one category and run it again.`,
      [{ field: 'categoryId', code: ErrorCode.VALIDATION_FAILED }],
    );
  }

  const existing = await prisma.productPrice.findMany({
    where: {
      currencyCode: target,
      productId: { in: [...new Set(rows.map((row) => row.productId))] },
    },
    select: {
      productId: true,
      variantKey: true,
      basePriceMinor: true,
      isAutoConverted: true,
    },
  });

  const existingByKey = new Map(
    existing.map((row) => [`${row.productId}:${row.variantKey}`, row]),
  );

  const sample: BulkPriceLine[] = [];
  const writes: {
    productId: string;
    variantId: string | null;
    variantKey: string;
    basePriceMinor: Minor;
    compareAtPriceMinor: Minor | null;
  }[] = [];

  let skippedExisting = 0;
  let liftedToMinimum = 0;
  /** Largest observed move, in hundredths of a percent, to keep it integral. */
  let maxDriftBasis = 0n;

  for (const row of rows) {
    const key = `${row.productId}:${row.variantKey}`;
    const current = existingByKey.get(key) ?? null;
    const already = current?.basePriceMinor ?? null;

    // Two separate reasons to leave a row alone, and the second is the one the
    // scheduled refresh depends on: a hand-typed price is out of its reach
    // whatever the settings say.
    const skip =
      already !== null &&
      (!request.overwriteExisting ||
        (request.restrictToAutoManaged === true && current?.isAutoConverted !== true));

    let converted = convert(row.basePriceMinor, conversion);

    // A price of zero is not a price. It means the rate has put this item
    // below the currency's smallest unit, and selling it for nothing is worse
    // than selling it for a cent.
    if (converted <= 0n) {
      converted = 1n;
      if (!skip) liftedToMinimum += 1;
    }

    const compareAt =
      row.compareAtPriceMinor === null ? null : convert(row.compareAtPriceMinor, conversion);

    if (sample.length < SAMPLE_SIZE) {
      sample.push({
        productId: row.productId,
        sku: row.product.sku,
        name: row.product.name,
        variantKey: row.variantKey === '' ? null : row.variantKey,
        sourceMinor: row.basePriceMinor.toString(),
        targetMinor: converted.toString(),
        existingMinor: already?.toString() ?? null,
        skipped: skip ? 'existing' : null,
      });
    }

    if (skip) {
      skippedExisting += 1;
      continue;
    }

    // Measured only against a price being replaced. A market being opened for
    // the first time has nothing to have drifted from, and treating a first
    // price as an infinite move would block every new currency.
    if (already !== null && already > 0n) {
      const move = converted > already ? converted - already : already - converted;
      const basis = (move * 10_000n) / already;
      if (basis > maxDriftBasis) maxDriftBasis = basis;
    }

    writes.push({
      productId: row.productId,
      variantId: row.variantId,
      variantKey: row.variantKey,
      basePriceMinor: converted,
      // Rounding can pull a strike-through price to or below the selling
      // price, at which point it is not a saving and must not be shown as one.
      compareAtPriceMinor: compareAt !== null && compareAt > converted ? compareAt : null,
    });
  }

  /** Hundredths of a percent back to the "12.34" the API and screens speak. */
  const observedDrift =
    maxDriftBasis === 0n && existing.length === 0
      ? null
      : `${String(maxDriftBasis / 100n)}.${String(maxDriftBasis % 100n).padStart(2, '0')}`;

  const result: BulkPriceResult = {
    sourceCurrency: source,
    targetCurrency: target,
    scanned: rows.length,
    writable: writes.length,
    skippedExisting,
    liftedToMinimum,
    maxDriftPercent: observedDrift,
    sample,
    written: 0,
  };

  // Checked before the transaction opens, and on the preview too, so the
  // refusal is the same whether a person or the scheduler asked.
  if (request.maxDriftPercent !== null && request.maxDriftPercent !== undefined) {
    const limit = BigInt(Math.round(Number(request.maxDriftPercent) * 100));

    if (limit > 0n && maxDriftBasis > limit) {
      throw badRequest(
        ErrorCode.VALIDATION_FAILED,
        `A price would move by ${observedDrift ?? '?'}%, over the ${request.maxDriftPercent}% limit. ` +
          'Nothing has been written. Check the rate, or raise the limit if the move is real.',
        [{ field: 'rate', code: ErrorCode.VALIDATION_FAILED }],
      );
    }
  }

  if (!apply || writes.length === 0) return result;

  // One transaction: a half-priced catalogue is a shop quoting two different
  // rates. The timeout is raised because this is a bulk write by definition,
  // and `MAX_ROWS` is what keeps it bounded.
  await prisma.$transaction(
    async (tx) => {
      for (const write of writes) {
        await tx.productPrice.upsert({
          where: {
            productId_variantKey_currencyCode: {
              productId: write.productId,
              variantKey: write.variantKey,
              currencyCode: target,
            },
          },
          create: {
            id: newId(),
            productId: write.productId,
            variantId: write.variantId,
            variantKey: write.variantKey,
            currencyCode: target,
            basePriceMinor: write.basePriceMinor,
            compareAtPriceMinor: write.compareAtPriceMinor,
            isAutoConverted: request.autoManaged === true,
            updatedById: actorId,
          },
          update: {
            basePriceMinor: write.basePriceMinor,
            compareAtPriceMinor: write.compareAtPriceMinor,
            isAutoConverted: request.autoManaged === true,
            updatedById: actorId,
          },
        });
      }
    },
    { timeout: 120_000, maxWait: 15_000 },
  );

  return { ...result, written: writes.length };
}

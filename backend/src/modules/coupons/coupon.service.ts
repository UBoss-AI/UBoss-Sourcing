/**
 * Coupons.
 *
 * A percentage off, optionally narrowed to a set of categories, that unlocks
 * once the cart is worth enough in the currency being quoted.
 *
 * Three rules the rest of the system relies on:
 *
 *   * The threshold is per currency, never converted. "Works above 5,000"
 *     cannot mean the same thing in INR and USD, and deriving one from the
 *     other would make the rule move with the exchange rate. A coupon with no
 *     row for a currency does not apply in that currency at all.
 *
 *   * Evaluation is pure arithmetic over amounts the caller already priced.
 *     Nothing here reads a price - the cart is the only thing allowed to decide
 *     what a line costs, and the coupon only ever divides that number up.
 *
 *   * The discount is apportioned across the eligible lines with the same
 *     largest-remainder helper the tax code uses, so the parts sum to the whole
 *     exactly and per-line tax stays consistent with the total charged.
 */
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { apportion, percentOf, sumMinor, type Minor } from '../../domain/money.js';
import { newId } from '../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';

import type { CouponScope, CouponStatus, Prisma } from '../../generated/prisma/client.js';

/** Unambiguous alphabet: no O/0, I/1, S/5. Codes get read off screens aloud. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXYZ2346789';
const CODE_LENGTH = 8;

// --- Evaluation ------------------------------------------------------------

export interface CouponLineInput {
  /** Index into the caller's own line array; echoed back on the result. */
  index: number;
  productId: string;
  categoryId: string;
  /** Quantity x unit price, before any discount and before tax. */
  lineSubtotalMinor: Minor;
}

export interface CouponEvaluation {
  couponId: string;
  code: string;
  name: string;
  description: string | null;
  discountPercent: string;
  /** Total discount, in the cart's currency. */
  discountMinor: Minor;
  /** Per-line shares, keyed by the `index` the caller supplied. */
  perLineMinor: Map<number, Minor>;
  /** How many lines the coupon actually touched. */
  eligibleLineCount: number;
}

export interface CouponRejection {
  code: string;
  message: string;
  meta?: Record<string, string | number | boolean | null>;
}

export type CouponOutcome =
  | { ok: true; evaluation: CouponEvaluation }
  | { ok: false; rejection: CouponRejection };

type LoadedCoupon = Prisma.CouponGetPayload<{
  include: { categories: true; minimums: true };
}>;

/**
 * Expand a coupon's category list to the ids that actually match.
 *
 * Categories carry a materialised `path` of `/ancestorId/.../ownId/`, so a
 * whole branch is one indexed LIKE rather than a recursive walk.
 */
async function eligibleCategoryIds(coupon: LoadedCoupon): Promise<Set<string> | null> {
  if (coupon.scope === 'ALL_PRODUCTS') return null;

  const direct = coupon.categories.map((row) => row.categoryId);
  if (direct.length === 0) return new Set();

  const withDescendants = coupon.categories
    .filter((row) => row.includeDescendants)
    .map((row) => row.categoryId);

  const ids = new Set(direct);
  if (withDescendants.length === 0) return ids;

  const descendants = await prisma.category.findMany({
    where: { OR: withDescendants.map((id) => ({ path: { contains: `/${id}/` } })) },
    select: { id: true },
  });

  for (const row of descendants) ids.add(row.id);
  return ids;
}

/**
 * Decide whether a coupon applies to this cart, and by how much.
 *
 * Returns a rejection rather than throwing: the cart shows every reason at
 * once, and an expired coupon sitting on an open cart is a normal state to
 * render, not an exception.
 */
export async function evaluateCoupon(input: {
  coupon: LoadedCoupon;
  lines: readonly CouponLineInput[];
  currency: string;
  /** Whole-cart subtotal, before discount and tax. What the threshold measures. */
  subtotalMinor: Minor;
  customerProfileId: string | null;
  now?: Date;
}): Promise<CouponOutcome> {
  const { coupon, lines, currency, subtotalMinor, customerProfileId } = input;
  const now = input.now ?? new Date();

  const reject = (code: string, message: string, meta?: CouponRejection['meta']): CouponOutcome => ({
    ok: false,
    rejection: { code, message, ...(meta !== undefined ? { meta } : {}) },
  });

  if (coupon.status !== 'ACTIVE' || coupon.archivedAt !== null) {
    return reject(ErrorCode.COUPON_NOT_ACTIVE, `Coupon ${coupon.code} is not available.`);
  }

  if (coupon.validFrom !== null && now < coupon.validFrom) {
    return reject(ErrorCode.COUPON_NOT_YET_VALID, `Coupon ${coupon.code} is not active yet.`, {
      validFrom: coupon.validFrom.toISOString(),
    });
  }

  if (coupon.validUntil !== null && now > coupon.validUntil) {
    return reject(ErrorCode.COUPON_EXPIRED, `Coupon ${coupon.code} has expired.`, {
      validUntil: coupon.validUntil.toISOString(),
    });
  }

  if (coupon.usageLimit !== null && coupon.usageCount >= coupon.usageLimit) {
    return reject(
      ErrorCode.COUPON_USAGE_LIMIT_REACHED,
      `Coupon ${coupon.code} has been fully claimed.`,
    );
  }

  if (coupon.perCustomerLimit !== null && customerProfileId !== null) {
    const used = await prisma.couponRedemption.count({
      where: { couponId: coupon.id, customerProfileId },
    });
    if (used >= coupon.perCustomerLimit) {
      return reject(
        ErrorCode.COUPON_USAGE_LIMIT_REACHED,
        `You have already used coupon ${coupon.code}.`,
        { limit: coupon.perCustomerLimit },
      );
    }
  }

  // No threshold row for this currency means the coupon was never offered in
  // this market. Converting another currency's figure would make the rule move
  // with the exchange rate, so it simply does not apply.
  const minimum = coupon.minimums.find((row) => row.currencyCode === currency);
  if (minimum === undefined) {
    return reject(
      ErrorCode.COUPON_NOT_APPLICABLE,
      `Coupon ${coupon.code} is not available in ${currency}.`,
      { currency },
    );
  }

  if (subtotalMinor < minimum.minOrderMinor) {
    return reject(
      ErrorCode.COUPON_MINIMUM_NOT_MET,
      `Spend a little more to use coupon ${coupon.code}.`,
      { minOrderMinor: minimum.minOrderMinor.toString(), currency },
    );
  }

  const categoryIds = await eligibleCategoryIds(coupon);
  const eligible = lines.filter(
    (line) => categoryIds === null || categoryIds.has(line.categoryId),
  );

  const eligibleSubtotal = sumMinor(eligible.map((line) => line.lineSubtotalMinor));
  if (eligible.length === 0 || eligibleSubtotal <= 0n) {
    return reject(
      ErrorCode.COUPON_NOT_APPLICABLE,
      `Nothing in your cart qualifies for coupon ${coupon.code}.`,
    );
  }

  const percent = coupon.discountPercent.toString();
  const discountMinor = percentOf(eligibleSubtotal, percent);

  // Apportion by line value so the parts sum to the whole exactly. Without
  // this, per-line tax would not add up to the tax actually charged.
  const shares = apportion(
    discountMinor,
    eligible.map((line) => line.lineSubtotalMinor),
  );

  const perLineMinor = new Map<number, Minor>();
  eligible.forEach((line, position) => {
    perLineMinor.set(line.index, shares[position] ?? 0n);
  });

  return {
    ok: true,
    evaluation: {
      couponId: coupon.id,
      code: coupon.code,
      name: coupon.name,
      description: coupon.description,
      discountPercent: percent,
      discountMinor,
      perLineMinor,
      eligibleLineCount: eligible.length,
    },
  };
}

/** Load a coupon by the code a shopper typed. Case- and space-insensitive. */
export async function findCouponByCode(code: string): Promise<LoadedCoupon | null> {
  const normalised = normaliseCode(code);
  if (normalised === '') return null;

  return prisma.coupon.findFirst({
    where: { code: normalised },
    include: { categories: true, minimums: true },
  });
}

export async function findCouponById(id: string): Promise<LoadedCoupon | null> {
  return prisma.coupon.findUnique({ where: { id }, include: { categories: true, minimums: true } });
}

/**
 * The coupons worth advertising on the cart: live, publicly listed, and
 * carrying a threshold in the currency being quoted.
 */
export async function listPublicCoupons(currency: string, now = new Date()): Promise<LoadedCoupon[]> {
  return prisma.coupon.findMany({
    where: {
      status: 'ACTIVE',
      isPubliclyListed: true,
      archivedAt: null,
      minimums: { some: { currencyCode: currency } },
      AND: [
        { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
        { OR: [{ validUntil: null }, { validUntil: { gte: now } }] },
      ],
    },
    include: { categories: true, minimums: true },
    orderBy: [{ discountPercent: 'desc' }, { code: 'asc' }],
    take: 50,
  });
}

// --- Redemption ------------------------------------------------------------

/**
 * Record that an order used a coupon.
 *
 * Called inside the checkout transaction. The unique index on `orderId` is what
 * makes a retried checkout collide instead of counting the coupon twice, so the
 * insert is deliberately not an upsert.
 */
export async function recordRedemption(
  tx: PrismaTransaction,
  input: {
    couponId: string;
    orderId: string;
    customerProfileId: string | null;
    codeSnapshot: string;
    discountPercentSnapshot: string;
    currencyCode: string;
    discountMinor: Minor;
  },
): Promise<void> {
  await tx.couponRedemption.create({
    data: {
      id: newId(),
      couponId: input.couponId,
      orderId: input.orderId,
      customerProfileId: input.customerProfileId,
      codeSnapshot: input.codeSnapshot,
      discountPercentSnapshot: input.discountPercentSnapshot,
      currencyCode: input.currencyCode,
      discountMinor: input.discountMinor,
    },
  });

  // A cache for listing screens. `coupon_redemptions` remains the truth.
  await tx.coupon.update({
    where: { id: input.couponId },
    data: { usageCount: { increment: 1 } },
  });
}

// --- Authoring -------------------------------------------------------------

export function normaliseCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, '');
}

function randomCode(): string {
  const bytes = new Uint32Array(CODE_LENGTH);
  globalThis.crypto.getRandomValues(bytes);

  let out = '';
  for (const byte of bytes) out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return out;
}

/**
 * Generate a code that is free right now.
 *
 * The unique index is still the real guard - two admins creating a coupon in
 * the same millisecond would both pass this check - so callers must handle the
 * collision on insert. This just makes that essentially never happen.
 */
export async function generateUniqueCode(prefix?: string): Promise<string> {
  const clean = prefix === undefined ? '' : normaliseCode(prefix).slice(0, 8);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = clean === '' ? randomCode() : `${clean}${randomCode().slice(0, 5)}`;
    const taken = await prisma.coupon.count({ where: { code: candidate } });
    if (taken === 0) return candidate;
  }

  throw conflict(ErrorCode.COUPON_CODE_ALREADY_EXISTS, 'Could not generate a free coupon code.');
}

export interface CouponMinimumInput {
  currencyCode: string;
  minOrderMinor: Minor;
}

export interface CouponWriteInput {
  code?: string | null;
  name: string;
  description?: string | null;
  discountPercent: string;
  scope: CouponScope;
  categoryIds?: readonly string[];
  includeDescendants?: boolean;
  minimums: readonly CouponMinimumInput[];
  status?: CouponStatus;
  isPubliclyListed?: boolean;
  validFrom?: Date | null;
  validUntil?: Date | null;
  usageLimit?: number | null;
  perCustomerLimit?: number | null;
}

function validate(input: CouponWriteInput): void {
  const percent = Number(input.discountPercent);
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Discount must be between 0 and 100 percent.', [
      { field: 'discountPercent', code: ErrorCode.VALIDATION_FAILED },
    ]);
  }

  if (input.scope === 'CATEGORIES' && (input.categoryIds ?? []).length === 0) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Choose at least one category, or set the coupon to apply to all products.',
      [{ field: 'categoryIds', code: ErrorCode.VALIDATION_FAILED }],
    );
  }

  if (input.minimums.length === 0) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Set a qualifying amount for at least one currency, or the coupon can never apply.',
      [{ field: 'minimums', code: ErrorCode.VALIDATION_FAILED }],
    );
  }

  for (const minimum of input.minimums) {
    if (minimum.minOrderMinor < 0n) {
      throw badRequest(
        ErrorCode.VALIDATION_FAILED,
        `The ${minimum.currencyCode} qualifying amount cannot be negative.`,
        [{ field: `minimums.${minimum.currencyCode}`, code: ErrorCode.VALIDATION_FAILED }],
      );
    }
  }

  if (
    input.validFrom !== null &&
    input.validFrom !== undefined &&
    input.validUntil !== null &&
    input.validUntil !== undefined &&
    input.validFrom >= input.validUntil
  ) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'The end date must fall after the start date.', [
      { field: 'validUntil', code: ErrorCode.VALIDATION_FAILED },
    ]);
  }
}

export async function createCoupon(
  input: CouponWriteInput,
  actorId: string | null,
): Promise<LoadedCoupon> {
  validate(input);

  const code =
    input.code !== null && input.code !== undefined && normaliseCode(input.code) !== ''
      ? normaliseCode(input.code)
      : await generateUniqueCode();

  const existing = await prisma.coupon.count({ where: { code } });
  if (existing > 0) {
    throw conflict(ErrorCode.COUPON_CODE_ALREADY_EXISTS, `Coupon code ${code} is already in use.`, [
      { field: 'code', code: ErrorCode.COUPON_CODE_ALREADY_EXISTS },
    ]);
  }

  const id = newId();
  const includeDescendants = input.includeDescendants ?? true;

  await prisma.$transaction(async (tx) => {
    await tx.coupon.create({
      data: {
        id,
        code,
        name: input.name.trim(),
        description: input.description?.trim() ?? null,
        discountPercent: input.discountPercent,
        scope: input.scope,
        status: input.status ?? 'DRAFT',
        isPubliclyListed: input.isPubliclyListed ?? true,
        validFrom: input.validFrom ?? null,
        validUntil: input.validUntil ?? null,
        usageLimit: input.usageLimit ?? null,
        perCustomerLimit: input.perCustomerLimit ?? null,
        createdById: actorId,
        updatedById: actorId,
      },
    });

    await writeChildren(tx, id, input, includeDescendants);
  });

  const created = await findCouponById(id);
  if (created === null) throw notFound('Coupon');
  return created;
}

export async function updateCoupon(
  id: string,
  input: CouponWriteInput,
  actorId: string | null,
): Promise<LoadedCoupon> {
  validate(input);

  const current = await prisma.coupon.findUnique({ where: { id }, select: { code: true } });
  if (current === null) throw notFound('Coupon');

  const code =
    input.code !== null && input.code !== undefined && normaliseCode(input.code) !== ''
      ? normaliseCode(input.code)
      : current.code;

  if (code !== current.code) {
    const clash = await prisma.coupon.count({ where: { code } });
    if (clash > 0) {
      throw conflict(
        ErrorCode.COUPON_CODE_ALREADY_EXISTS,
        `Coupon code ${code} is already in use.`,
        [{ field: 'code', code: ErrorCode.COUPON_CODE_ALREADY_EXISTS }],
      );
    }
  }

  const includeDescendants = input.includeDescendants ?? true;

  await prisma.$transaction(async (tx) => {
    await tx.coupon.update({
      where: { id },
      data: {
        code,
        name: input.name.trim(),
        description: input.description?.trim() ?? null,
        discountPercent: input.discountPercent,
        scope: input.scope,
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.isPubliclyListed !== undefined
          ? { isPubliclyListed: input.isPubliclyListed }
          : {}),
        validFrom: input.validFrom ?? null,
        validUntil: input.validUntil ?? null,
        usageLimit: input.usageLimit ?? null,
        perCustomerLimit: input.perCustomerLimit ?? null,
        updatedById: actorId,
      },
    });

    await tx.couponCategory.deleteMany({ where: { couponId: id } });
    await tx.couponMinimum.deleteMany({ where: { couponId: id } });
    await writeChildren(tx, id, input, includeDescendants);
  });

  const updated = await findCouponById(id);
  if (updated === null) throw notFound('Coupon');
  return updated;
}

async function writeChildren(
  tx: PrismaTransaction,
  couponId: string,
  input: CouponWriteInput,
  includeDescendants: boolean,
): Promise<void> {
  if (input.scope === 'CATEGORIES') {
    const ids = [...new Set(input.categoryIds ?? [])];
    if (ids.length > 0) {
      await tx.couponCategory.createMany({
        data: ids.map((categoryId) => ({ couponId, categoryId, includeDescendants })),
      });
    }
  }

  const seen = new Set<string>();
  const minimums = input.minimums.filter((minimum) => {
    const code = minimum.currencyCode.trim().toUpperCase();
    if (seen.has(code)) return false;
    seen.add(code);
    return true;
  });

  if (minimums.length > 0) {
    await tx.couponMinimum.createMany({
      data: minimums.map((minimum) => ({
        couponId,
        currencyCode: minimum.currencyCode.trim().toUpperCase(),
        minOrderMinor: minimum.minOrderMinor,
      })),
    });
  }
}

export interface CouponListFilters {
  status?: CouponStatus;
  search?: string;
  includeArchived?: boolean;
  page?: number;
  pageSize?: number;
}

export async function listCoupons(
  filters: CouponListFilters,
): Promise<{ rows: LoadedCoupon[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 25));

  const where: Prisma.CouponWhereInput = {
    ...(filters.status !== undefined ? { status: filters.status } : {}),
    ...(filters.includeArchived === true ? {} : { archivedAt: null }),
    ...(filters.search !== undefined && filters.search.trim() !== ''
      ? {
          OR: [
            { code: { contains: filters.search.trim().toUpperCase() } },
            { name: { contains: filters.search.trim() } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.coupon.findMany({
      where,
      include: { categories: true, minimums: true },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.coupon.count({ where }),
  ]);

  return { rows, total, page, pageSize };
}

/**
 * Archive rather than delete.
 *
 * Redemptions reference the coupon with onDelete: Restrict, because an order's
 * history must stay explicable years later. Archiving takes it out of every
 * list while keeping that trail intact.
 */
export async function archiveCoupon(id: string, actorId: string | null): Promise<void> {
  const existing = await prisma.coupon.findUnique({ where: { id }, select: { id: true } });
  if (existing === null) throw notFound('Coupon');

  await prisma.coupon.update({
    where: { id },
    data: { archivedAt: new Date(), status: 'DISABLED', updatedById: actorId },
  });
}

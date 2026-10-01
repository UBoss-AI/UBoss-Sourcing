/**
 * Country / compliance rules - checklist Master row 69.
 *
 * The operator keeps one `market_rules` row per thing that may not be sent to
 * a destination (`BLOCK`) or may be sent only to a buyer holding named
 * documents (`DOCUMENTS_REQUIRED`). A rule names a product or a category; a
 * category rule covers everything beneath it. A rule may carry a value
 * threshold: then it applies only to an order whose total reaches it.
 *
 * Two halves live here: the admin CRUD (every write audited), and the
 * checkout guard `assertBasketAllowedForDestination`, which refuses a basket
 * holding anything a rule in force blocks for the delivery country. The
 * listing filter and the RFQ check live in `market-eligibility.service`.
 */
import { z } from 'zod';
import type { MarketRule, Prisma } from '../../generated/prisma/client.js';
import { badRequest, conflict, ErrorCode, notFound } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import type { SettingsActor } from '../settings/settings.service.js';

const COUNTRY = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/)
  .transform((value) => value.toUpperCase());
const CURRENCY = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/)
  .transform((value) => value.toUpperCase());

export const marketRuleInput = z
  .object({
    scope: z.enum(['PRODUCT', 'CATEGORY']),
    /** For PRODUCT. The product's address, as the storefront shows it. */
    productSlug: z.string().trim().max(255).nullable().optional(),
    /** For CATEGORY. */
    categoryId: z.string().length(26).nullable().optional(),
    countryCode: COUNTRY,
    effect: z.enum(['BLOCK', 'DOCUMENTS_REQUIRED']),
    reason: z.string().trim().min(3).max(512),
    requiredDocuments: z.array(z.string().trim().min(1).max(160)).max(20).default([]),
    /** Minor units as a string, or null for "every order". */
    minOrderValueMinor: z
      .string()
      .trim()
      .regex(/^[0-9]{1,18}$/)
      .nullable()
      .optional(),
    thresholdCurrency: CURRENCY.nullable().optional(),
    source: z.string().trim().min(2).max(255),
    version: z.string().trim().min(1).max(32),
    ownerName: z.string().trim().min(2).max(160),
    effectiveFrom: z.coerce.date(),
    effectiveUntil: z.coerce.date().nullable().optional(),
    isActive: z.boolean().default(true),
  })
  .strict();
export type MarketRuleInput = z.infer<typeof marketRuleInput>;

export interface MarketRuleView {
  id: string;
  scope: 'PRODUCT' | 'CATEGORY';
  countryCode: string;
  effect: 'BLOCK' | 'DOCUMENTS_REQUIRED';
  product: { id: string; slug: string; name: string } | null;
  category: { id: string; slug: string; name: string } | null;
  reason: string;
  requiredDocuments: string[];
  minOrderValueMinor: string | null;
  thresholdCurrency: string | null;
  source: string;
  version: string;
  ownerName: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
  isActive: boolean;
  updatedAt: string;
}

type RuleRow = MarketRule & {
  product: { id: string; slug: string; name: string } | null;
  category: { id: string; slug: string; name: string } | null;
};

const INCLUDE = {
  product: { select: { id: true, slug: true, name: true } },
  category: { select: { id: true, slug: true, name: true } },
} as const;

function documents(value: Prisma.JsonValue | null): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function view(row: RuleRow): MarketRuleView {
  return {
    id: row.id,
    scope: row.scope,
    countryCode: row.countryCode,
    effect: row.effect,
    product: row.product,
    category: row.category,
    reason: row.reason,
    requiredDocuments: documents(row.requiredDocumentsJson),
    minOrderValueMinor: row.minOrderValueMinor === null ? null : row.minOrderValueMinor.toString(),
    thresholdCurrency: row.thresholdCurrency,
    source: row.source,
    version: row.version,
    ownerName: row.ownerName,
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveUntil: row.effectiveUntil === null ? null : row.effectiveUntil.toISOString(),
    isActive: row.isActive,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listMarketRules(filter: { countryCode?: string | undefined }): Promise<MarketRuleView[]> {
  const rows = await prisma.marketRule.findMany({
    where: filter.countryCode === undefined ? {} : { countryCode: filter.countryCode.toUpperCase() },
    include: INCLUDE,
    orderBy: [{ countryCode: 'asc' }, { effect: 'asc' }, { createdAt: 'asc' }],
    take: 1000,
  });
  return rows.map(view);
}

/** The columns a rule input writes, after every cross-field check. */
async function columnsFor(input: MarketRuleInput): Promise<{
  productId: string | null;
  categoryId: string | null;
  minOrderValueMinor: bigint | null;
  thresholdCurrency: string | null;
}> {
  const invalid = (field: string, code: string, message: string) =>
    badRequest(ErrorCode.MARKET_RULE_INVALID, message, [{ field, code }]);

  let productId: string | null = null;
  let categoryId: string | null = null;
  if (input.scope === 'PRODUCT') {
    const slug = input.productSlug ?? '';
    if (slug === '') throw invalid('productSlug', 'REQUIRED', 'Name the product this rule is about.');
    const product = await prisma.product.findFirst({ where: { slug }, select: { id: true } });
    if (product === null) throw invalid('productSlug', 'NOT_FOUND', 'No product has that address.');
    productId = product.id;
  } else {
    const id = input.categoryId ?? '';
    if (id === '') throw invalid('categoryId', 'REQUIRED', 'Choose the category this rule is about.');
    const category = await prisma.category.findUnique({ where: { id }, select: { id: true } });
    if (category === null) throw invalid('categoryId', 'NOT_FOUND', 'That category does not exist.');
    categoryId = category.id;
  }

  const threshold = input.minOrderValueMinor ?? null;
  const currency = input.thresholdCurrency ?? null;
  if ((threshold === null) !== (currency === null)) {
    throw invalid(
      threshold === null ? 'minOrderValueMinor' : 'thresholdCurrency',
      'REQUIRED',
      'A value threshold needs both an amount and a currency.',
    );
  }
  if (threshold !== null && BigInt(threshold) <= 0n) {
    throw invalid('minOrderValueMinor', 'NOT_POSITIVE', 'A value threshold must be above zero.');
  }
  if (input.effectiveUntil !== undefined && input.effectiveUntil !== null && input.effectiveUntil.getTime() <= input.effectiveFrom.getTime()) {
    throw invalid('effectiveUntil', 'BEFORE_START', 'A rule cannot end before it starts.');
  }
  return { productId, categoryId, minOrderValueMinor: threshold === null ? null : BigInt(threshold), thresholdCurrency: currency };
}

function auditSnapshot(rule: MarketRuleView): Record<string, unknown> {
  return {
    scope: rule.scope,
    countryCode: rule.countryCode,
    effect: rule.effect,
    productId: rule.product?.id ?? null,
    categoryId: rule.category?.id ?? null,
    minOrderValueMinor: rule.minOrderValueMinor,
    thresholdCurrency: rule.thresholdCurrency,
    isActive: rule.isActive,
    version: rule.version,
  };
}

export async function saveMarketRule(
  id: string | null,
  input: MarketRuleInput,
  actor: SettingsActor,
): Promise<MarketRuleView> {
  const columns = await columnsFor(input);
  const data = {
    scope: input.scope,
    countryCode: input.countryCode,
    effect: input.effect,
    reason: input.reason,
    requiredDocumentsJson: input.effect === 'DOCUMENTS_REQUIRED' ? [...new Set(input.requiredDocuments)] : [],
    source: input.source,
    version: input.version,
    ownerName: input.ownerName,
    effectiveFrom: input.effectiveFrom,
    effectiveUntil: input.effectiveUntil ?? null,
    isActive: input.isActive,
    updatedById: actor.userId,
    ...columns,
  };

  return prisma.$transaction(async (tx) => {
    const before = id === null ? null : await tx.marketRule.findUnique({ where: { id }, include: INCLUDE });
    if (id !== null && before === null) throw notFound('Country rule');
    const row =
      id === null
        ? await tx.marketRule.create({ data: { id: newId(), createdById: actor.userId, ...data }, include: INCLUDE })
        : await tx.marketRule.update({ where: { id }, data, include: INCLUDE });
    const after = view(row);
    await recordAudit(
      {
        action: AuditAction.SETTINGS_UPDATED,
        resourceType: 'market_rule',
        resourceId: row.id,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: before === null ? null : auditSnapshot(view(before)),
        after: auditSnapshot(after),
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
    return after;
  });
}

export async function deleteMarketRule(id: string, actor: SettingsActor): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const before = await tx.marketRule.findUnique({ where: { id }, include: INCLUDE });
    if (before === null) throw notFound('Country rule');
    await tx.marketRule.delete({ where: { id } });
    await recordAudit(
      {
        action: AuditAction.SETTINGS_UPDATED,
        resourceType: 'market_rule',
        resourceId: id,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: auditSnapshot(view(before)),
        after: null,
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });
}

// --- Enforcement -------------------------------------------------------------

export interface DestinationRestriction {
  productId: string;
  reason: string;
}

/**
 * What in a basket may not be sent to `country`, for an order of `total`.
 *
 * Only `BLOCK` rules in force. A rule with a threshold counts when the order
 * reaches it in the rule's currency - or when the order is in another
 * currency, because no exchange rate is guessed for a compliance rule.
 */
export async function destinationRestrictions(
  country: string,
  productIds: readonly string[],
  total: { amountMinor: bigint; currency: string },
  now: Date = new Date(),
): Promise<DestinationRestriction[]> {
  const ids = [...new Set(productIds)];
  if (ids.length === 0) return [];
  const rules = await prisma.marketRule.findMany({
    where: {
      countryCode: country.toUpperCase(),
      effect: 'BLOCK',
      isActive: true,
      effectiveFrom: { lte: now },
      OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: now } }],
    },
    select: { scope: true, productId: true, categoryId: true, reason: true, minOrderValueMinor: true, thresholdCurrency: true },
    orderBy: { createdAt: 'asc' },
  });
  const applying = rules.filter(
    (rule) =>
      rule.minOrderValueMinor === null ||
      rule.thresholdCurrency !== total.currency ||
      total.amountMinor >= rule.minOrderValueMinor,
  );
  if (applying.length === 0) return [];

  const products = await prisma.product.findMany({
    where: { id: { in: ids } },
    select: { id: true, categoryId: true, category: { select: { path: true } } },
  });
  const found: DestinationRestriction[] = [];
  for (const product of products) {
    const lineage = new Set([
      ...(product.category?.path ?? '').split('/').filter((part) => part.length > 0),
      product.categoryId,
    ]);
    const rule = applying.find((candidate) =>
      candidate.scope === 'PRODUCT'
        ? candidate.productId === product.id
        : candidate.categoryId !== null && lineage.has(candidate.categoryId),
    );
    if (rule !== undefined) found.push({ productId: product.id, reason: rule.reason });
  }
  return found;
}

/** Refuses checkout when anything in the basket is blocked for the destination. */
export async function assertBasketAllowedForDestination(
  country: string,
  productIds: readonly string[],
  total: { amountMinor: bigint; currency: string },
  now: Date = new Date(),
): Promise<void> {
  const blocked = await destinationRestrictions(country, productIds, total, now);
  if (blocked.length === 0) return;
  throw conflict(
    ErrorCode.MARKET_DESTINATION_RESTRICTED,
    blocked[0]?.reason ?? 'Something in your basket cannot be delivered to that country.',
    blocked.map((entry) => ({
      field: 'shippingAddressId',
      code: 'RESTRICTED',
      meta: { productId: entry.productId, reason: entry.reason, country: country.toUpperCase() },
    })),
  );
}

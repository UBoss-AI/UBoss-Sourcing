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
    effect: z.enum(['BLOCK', 'DOCUMENTS_REQUIRED', 'LABEL_REQUIRED']),
    reason: z.string().trim().min(3).max(512),
    requiredDocuments: z.array(z.string().trim().min(1).max(160)).max(20).default([]),
    /** For LABEL_REQUIRED: the labelling the goods must carry in that country. */
    labelText: z.string().trim().max(4000).nullable().optional(),
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
  effect: 'BLOCK' | 'DOCUMENTS_REQUIRED' | 'LABEL_REQUIRED';
  product: { id: string; slug: string; name: string } | null;
  category: { id: string; slug: string; name: string } | null;
  reason: string;
  requiredDocuments: string[];
  labelText: string | null;
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
    labelText: row.labelText,
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
  if (input.effect === 'LABEL_REQUIRED' && (input.labelText ?? '').length < 3) {
    throw invalid('labelText', 'REQUIRED', 'Say what the label must show in that country.');
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

/** Everything a rule says, for its history row: what a reader of the history needs to see. */
function historySnapshot(rule: MarketRuleView): Prisma.InputJsonObject {
  return {
    scope: rule.scope,
    countryCode: rule.countryCode,
    effect: rule.effect,
    product: rule.product === null ? null : { id: rule.product.id, slug: rule.product.slug, name: rule.product.name },
    category: rule.category === null ? null : { id: rule.category.id, slug: rule.category.slug, name: rule.category.name },
    reason: rule.reason,
    requiredDocuments: rule.requiredDocuments,
    labelText: rule.labelText,
    minOrderValueMinor: rule.minOrderValueMinor,
    thresholdCurrency: rule.thresholdCurrency,
    source: rule.source,
    version: rule.version,
    ownerName: rule.ownerName,
    effectiveFrom: rule.effectiveFrom,
    effectiveUntil: rule.effectiveUntil,
    isActive: rule.isActive,
  };
}

/** Append one history row for a rule. Revisions count up from 1 per rule. */
async function recordRuleVersion(
  tx: Prisma.TransactionClient,
  rule: MarketRuleView,
  changeKind: 'CREATED' | 'UPDATED' | 'DELETED',
  actor: { userId: string; email: string | null },
): Promise<void> {
  const last = await tx.marketRuleVersion.findFirst({
    where: { ruleId: rule.id },
    orderBy: { revision: 'desc' },
    select: { revision: true },
  });
  await tx.marketRuleVersion.create({
    data: {
      id: newId(),
      ruleId: rule.id,
      revision: (last?.revision ?? 0) + 1,
      changeKind,
      snapshotJson: historySnapshot(rule),
      changedById: actor.userId,
      changedByEmail: actor.email,
    },
  });
}

export interface MarketRuleVersionView {
  revision: number;
  changeKind: string;
  snapshot: Record<string, unknown>;
  changedByEmail: string | null;
  changedAt: string;
}

/** A rule's history, newest first. Works for a deleted rule too. */
export async function listMarketRuleVersions(ruleId: string): Promise<MarketRuleVersionView[]> {
  const rows = await prisma.marketRuleVersion.findMany({
    where: { ruleId },
    orderBy: { revision: 'desc' },
    take: 200,
  });
  return rows.map((row) => ({
    revision: row.revision,
    changeKind: row.changeKind,
    snapshot:
      row.snapshotJson !== null && typeof row.snapshotJson === 'object' && !Array.isArray(row.snapshotJson)
        ? (row.snapshotJson as Record<string, unknown>)
        : {},
    changedByEmail: row.changedByEmail,
    changedAt: row.createdAt.toISOString(),
  }));
}

/**
 * Block one product in a list of countries, from a moderator's approval
 * (JOURNEY-062). Each country becomes an ordinary PRODUCT-scope BLOCK rule
 * with its history row, so it shows on the Country rules screen and can be
 * changed or removed there like any other.
 */
export async function blockProductInCountries(
  tx: Prisma.TransactionClient,
  input: {
    productId: string;
    countries: readonly string[];
    reason: string;
    source: string;
    actor: { userId: string; email: string | null };
  },
): Promise<number> {
  let created = 0;
  for (const countryCode of input.countries) {
    const existing = await tx.marketRule.findFirst({
      where: { scope: 'PRODUCT', productId: input.productId, countryCode, effect: 'BLOCK', isActive: true },
      select: { id: true },
    });
    if (existing !== null) continue;
    const row = await tx.marketRule.create({
      data: {
        id: newId(),
        scope: 'PRODUCT',
        productId: input.productId,
        countryCode,
        effect: 'BLOCK',
        reason: input.reason.slice(0, 512),
        requiredDocumentsJson: [],
        source: input.source.slice(0, 255),
        version: '1',
        ownerName: (input.actor.email ?? 'Listing moderation').slice(0, 160),
        effectiveFrom: new Date(),
        isActive: true,
        createdById: input.actor.userId,
        updatedById: input.actor.userId,
      },
      include: INCLUDE,
    });
    await recordRuleVersion(tx, view(row), 'CREATED', input.actor);
    created += 1;
  }
  if (created > 0) {
    await recordAudit(
      {
        action: AuditAction.LISTING_DESTINATIONS_RESTRICTED,
        resourceType: 'product',
        resourceId: input.productId,
        actorType: 'ADMIN',
        actorUserId: input.actor.userId,
        actorEmail: input.actor.email,
        before: null,
        after: { countries: input.countries, reason: input.reason },
      },
      tx,
    );
  }
  return created;
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
    labelText: input.effect === 'LABEL_REQUIRED' ? (input.labelText ?? null) : null,
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
    await recordRuleVersion(tx, after, id === null ? 'CREATED' : 'UPDATED', { userId: actor.userId, email: actor.email });
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
    await recordRuleVersion(tx, view(before), 'DELETED', { userId: actor.userId, email: actor.email });
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

export interface LabelRequirement {
  productId: string;
  reason: string;
  labelText: string;
}

/**
 * The labelling rules in force for a basket going to `country` (JOURNEY-064).
 *
 * LABEL_REQUIRED rules never stop a sale; checkout shows them so the buyer
 * knows what the goods will carry and the seller knows what to print. A
 * category rule covers everything beneath it, as for BLOCK.
 */
export async function labelRequirements(
  country: string,
  productIds: readonly string[],
  now: Date = new Date(),
): Promise<LabelRequirement[]> {
  const ids = [...new Set(productIds)];
  if (ids.length === 0) return [];
  const rules = await prisma.marketRule.findMany({
    where: {
      countryCode: country.toUpperCase(),
      effect: 'LABEL_REQUIRED',
      isActive: true,
      effectiveFrom: { lte: now },
      OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: now } }],
    },
    select: { scope: true, productId: true, categoryId: true, reason: true, labelText: true },
    orderBy: { createdAt: 'asc' },
  });
  if (rules.length === 0) return [];
  const products = await prisma.product.findMany({
    where: { id: { in: ids } },
    select: { id: true, categoryId: true, category: { select: { path: true } } },
  });
  const found: LabelRequirement[] = [];
  for (const product of products) {
    const lineage = new Set([
      ...(product.category?.path ?? '').split('/').filter((part) => part.length > 0),
      product.categoryId,
    ]);
    for (const rule of rules) {
      const applies =
        rule.scope === 'PRODUCT'
          ? rule.productId === product.id
          : rule.categoryId !== null && lineage.has(rule.categoryId);
      if (applies) found.push({ productId: product.id, reason: rule.reason, labelText: rule.labelText ?? '' });
    }
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

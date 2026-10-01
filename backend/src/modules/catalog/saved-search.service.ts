/**
 * Saved searches and their alerts.
 *
 * A buyer keeps the search they ran on the storefront - the term and the
 * narrowing they had on - and can ask to be told when something new matches
 * it. "New" means a product published, or its price changed, since the last
 * alert for that search. The alert is one e-mail per search per pass, sent
 * through the notification outbox like every other e-mail, and never more
 * often than `SAVED_SEARCH_ALERT_INTERVAL_MS`.
 *
 * Ownership is the same rule as everywhere else: every read and write is
 * scoped by the buyer's own profile id, and a search belonging to someone else
 * is simply not found.
 */
import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import { AppError, ErrorCode, notFound } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { NO_VARIANT_KEY } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { NotificationEvent, enqueueNotification } from '../notifications/notification.service.js';
import { publicUrl } from '../rfq/rfq.service.js';
import { publicProductWhere } from './catalog.visibility.js';
import { findCategoryBySlug, subtreeCategoryIds } from './category.service.js';
import { destinationFor } from './location-price.service.js';
import { marketEligibleWhere } from './market-eligibility.service.js';

/** How many searches one buyer may keep. */
export const SAVED_SEARCH_LIMIT = 20;

/** The shortest gap between two alerts for the same search: one a day. */
export const SAVED_SEARCH_ALERT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Searches looked at in one pass; the rest wait for the next beat. */
const ALERT_BATCH = 200;

const minorAmount = z
  .string()
  .regex(/^\d{1,18}$/, 'A whole number of minor units, as a string.');

export const savedSearchFiltersSchema = z
  .object({
    category: z.string().trim().min(1).max(120).optional(),
    country: z
      .string()
      .regex(/^[A-Za-z]{2}$/)
      .transform((value) => value.toUpperCase())
      .optional(),
    currency: z
      .string()
      .regex(/^[A-Za-z]{3}$/)
      .transform((value) => value.toUpperCase())
      .optional(),
    minPrice: minorAmount.optional(),
    maxPrice: minorAmount.optional(),
  })
  .strict()
  .refine(
    (filters) =>
      (filters.minPrice === undefined && filters.maxPrice === undefined) ||
      filters.currency !== undefined,
    { message: 'A price range needs its currency.', path: ['currency'] },
  )
  .refine(
    (filters) =>
      filters.minPrice === undefined ||
      filters.maxPrice === undefined ||
      BigInt(filters.minPrice) <= BigInt(filters.maxPrice),
    { message: 'The lowest price is above the highest.', path: ['minPrice'] },
  );

export type SavedSearchFilters = z.infer<typeof savedSearchFiltersSchema>;

export const createSavedSearchSchema = z.object({
  name: z.string().trim().min(1).max(120),
  query: z.string().trim().min(1).max(200),
  filters: savedSearchFiltersSchema.optional(),
  alertsEnabled: z.boolean().optional(),
});

export const updateSavedSearchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    alertsEnabled: z.boolean().optional(),
  })
  .refine((value) => value.name !== undefined || value.alertsEnabled !== undefined, {
    message: 'Nothing to change.',
  });

export interface SavedSearchView {
  id: string;
  name: string;
  query: string;
  filters: SavedSearchFilters;
  alertsEnabled: boolean;
  lastNotifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

type SavedSearchRow = Prisma.SavedSearchGetPayload<Record<string, never>>;

function filtersOf(value: Prisma.JsonValue | null): SavedSearchFilters {
  const parsed = savedSearchFiltersSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : {};
}

function toView(row: SavedSearchRow): SavedSearchView {
  return {
    id: row.id,
    name: row.name,
    query: row.query,
    filters: filtersOf(row.filters),
    alertsEnabled: row.alertsEnabled,
    lastNotifiedAt: row.lastNotifiedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listSavedSearches(customerProfileId: string): Promise<SavedSearchView[]> {
  const rows = await prisma.savedSearch.findMany({
    where: { customerProfileId },
    orderBy: { createdAt: 'desc' },
    take: SAVED_SEARCH_LIMIT,
  });
  return rows.map(toView);
}

export async function createSavedSearch(
  customerProfileId: string,
  input: z.infer<typeof createSavedSearchSchema>,
): Promise<SavedSearchView> {
  return prisma.$transaction(async (tx) => {
    // Lock the buyer's profile row so two saves at once cannot both pass the cap.
    await tx.$queryRaw`SELECT id FROM customer_profiles WHERE id = ${customerProfileId} FOR UPDATE`;
    const count = await tx.savedSearch.count({ where: { customerProfileId } });
    if (count >= SAVED_SEARCH_LIMIT) {
      throw new AppError({
        statusCode: 409,
        code: ErrorCode.SAVED_SEARCH_LIMIT_REACHED,
        message: `You can keep up to ${String(SAVED_SEARCH_LIMIT)} saved searches. Delete one to save another.`,
        details: [{ meta: { limit: SAVED_SEARCH_LIMIT } }],
      });
    }
    const row = await tx.savedSearch.create({
      data: {
        id: newId(),
        customerProfileId,
        name: input.name,
        query: input.query,
        filters: input.filters ?? {},
        alertsEnabled: input.alertsEnabled ?? true,
      },
    });
    return toView(row);
  });
}

export async function updateSavedSearch(
  customerProfileId: string,
  id: string,
  input: z.infer<typeof updateSavedSearchSchema>,
): Promise<SavedSearchView> {
  const result = await prisma.savedSearch.updateMany({
    where: { id, customerProfileId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.alertsEnabled !== undefined ? { alertsEnabled: input.alertsEnabled } : {}),
    },
  });
  if (result.count === 0) throw notFound('Saved search');
  const row = await prisma.savedSearch.findUniqueOrThrow({ where: { id } });
  return toView(row);
}

export async function deleteSavedSearch(customerProfileId: string, id: string): Promise<void> {
  const result = await prisma.savedSearch.deleteMany({ where: { id, customerProfileId } });
  if (result.count === 0) throw notFound('Saved search');
}

/**
 * The products a saved search matches that are new or repriced since `since`.
 *
 * A deliberately smaller cousin of the storefront's own search: the same
 * visibility rule, the same term columns, the same category subtree and
 * market eligibility, and a price range on the base listed price in the
 * search's currency.
 */
export async function savedSearchMatchWhere(
  query: string,
  filters: SavedSearchFilters,
  since: Date,
): Promise<Prisma.ProductWhereInput | null> {
  const conditions: Prisma.ProductWhereInput[] = [
    {
      OR: [
        { name: { contains: query } },
        { shortDescription: { contains: query } },
        { sku: { contains: query } },
        { gtin: { contains: query } },
        { modelIdentifier: { contains: query } },
      ],
    },
  ];

  if (filters.category !== undefined) {
    const category = await findCategoryBySlug(filters.category);
    if (category === null) return null;
    conditions.push({ categoryId: { in: await subtreeCategoryIds(category.id) } });
  }

  const eligible = await marketEligibleWhere(destinationFor(filters.country));
  if (eligible !== null) conditions.push(eligible);

  const priceChanged: Prisma.ProductPriceWhereInput = {
    variantKey: NO_VARIANT_KEY,
    updatedAt: { gt: since },
    ...(filters.currency !== undefined ? { currencyCode: filters.currency } : {}),
  };
  conditions.push({ OR: [{ publishedAt: { gt: since } }, { prices: { some: priceChanged } }] });

  if (filters.minPrice !== undefined || filters.maxPrice !== undefined) {
    conditions.push({
      isPriceOnRequest: false,
      prices: {
        some: {
          variantKey: NO_VARIANT_KEY,
          currencyCode: filters.currency ?? '',
          basePriceMinor: {
            ...(filters.minPrice !== undefined ? { gte: BigInt(filters.minPrice) } : {}),
            ...(filters.maxPrice !== undefined ? { lte: BigInt(filters.maxPrice) } : {}),
          },
        },
      },
    });
  }

  return { ...publicProductWhere(), AND: conditions };
}

/** The storefront link that reruns a saved search. */
export function savedSearchUrl(query: string, filters: SavedSearchFilters): string {
  const params = new URLSearchParams({ q: query });
  if (filters.category !== undefined) params.set('category', filters.category);
  if (filters.minPrice !== undefined) params.set('minPrice', filters.minPrice);
  if (filters.maxPrice !== undefined) params.set('maxPrice', filters.maxPrice);
  return publicUrl(`/search?${params.toString()}`);
}

/**
 * One pass of the alert job.
 *
 * Takes every search with alerts on whose last alert (or, before the first,
 * whose creation) is at least a day old, finds what matches it since then and,
 * when anything does, queues one e-mail. The window moves forward whether or
 * not anything matched, so a quiet search is not re-scanned from the start
 * next time, and the dedupe key makes a retried pass send once.
 *
 * Returns how many e-mails were queued.
 */
export async function runSavedSearchAlerts(
  options: { now?: Date; minIntervalMs?: number } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - (options.minIntervalMs ?? SAVED_SEARCH_ALERT_INTERVAL_MS));

  const due = await prisma.savedSearch.findMany({
    where: {
      alertsEnabled: true,
      OR: [
        { lastNotifiedAt: null, createdAt: { lte: cutoff } },
        { lastNotifiedAt: { lte: cutoff } },
      ],
    },
    orderBy: { lastNotifiedAt: 'asc' },
    take: ALERT_BATCH,
    include: {
      customerProfile: {
        select: { fullName: true, user: { select: { email: true, status: true, erasedAt: true } } },
      },
    },
  });

  let queued = 0;
  for (const search of due) {
    try {
      const since = search.lastNotifiedAt ?? search.createdAt;
      const user = search.customerProfile.user;
      const filters = filtersOf(search.filters);
      const where =
        user.status === 'ACTIVE' && user.erasedAt === null
          ? await savedSearchMatchWhere(search.query, filters, since)
          : null;

      if (where !== null) {
        const [matchCount, examples] = await Promise.all([
          prisma.product.count({ where }),
          prisma.product.findMany({
            where,
            select: { name: true },
            orderBy: { updatedAt: 'desc' },
            take: 3,
          }),
        ]);

        if (matchCount > 0) {
          await enqueueNotification({
            eventKey: NotificationEvent.SAVED_SEARCH_MATCHES,
            recipientEmail: user.email,
            recipientName: search.customerProfile.fullName,
            variables: {
              searchName: search.name,
              matchCount,
              examples: examples.map((product) => product.name).join(', '),
              searchUrl: savedSearchUrl(search.query, filters),
              manageUrl: publicUrl('/account/saved-searches'),
            },
            dedupeKey: `saved_search:${search.id}:${since.toISOString()}`,
            relatedType: 'SavedSearch',
            relatedId: search.id,
          });
          queued += 1;
        }
      }

      await prisma.savedSearch.update({
        where: { id: search.id },
        data: { lastNotifiedAt: now },
      });
    } catch (error) {
      // One bad search must not stop the others; it is retried next pass.
      logger.error({ err: error, savedSearchId: search.id }, 'saved search alert failed');
    }
  }
  return queued;
}

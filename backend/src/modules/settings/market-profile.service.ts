/**
 * Market landing pages - checklist Master row 8.
 *
 * `/markets/:country` tells a buyer in one destination what shopping here
 * means for them: the currency they are quoted in, what may not be sold to
 * them (and why), and whatever the operator has written for that market -
 * an introduction, duties guidance, delivery notes, compliance notes and the
 * categories to feature.
 *
 * TWO KINDS OF CONTENT, KEPT APART
 *
 *   - **Facts the system holds**: the country's currency and the market rules
 *     in force for it. Always shown, because they are true whatever the
 *     operator has or has not written.
 *   - **The operator's own words** (`market_profiles`), shown only once the
 *     operator publishes them. A draft is never public.
 *
 * Only countries the deployment sells in (`countries.isActive`) have a page;
 * any other code is a 404.
 */
import { z } from 'zod';
import { notFound } from '../../domain/errors.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { publicCategoryWhere } from '../catalog/catalog.visibility.js';
import type { SettingsActor } from './settings.service.js';

const TEXT = z.string().trim().max(4000).nullable();

export const marketProfileInput = z.object({
  headline: z.string().trim().max(200).nullable(),
  intro: TEXT,
  dutiesGuidance: TEXT,
  deliveryPromise: TEXT,
  complianceNotes: TEXT,
  featuredCategories: z
    .array(z.string().trim().max(255).regex(/^[a-z0-9-]+$/))
    .max(12),
  isPublished: z.boolean(),
});
export type MarketProfileInput = z.infer<typeof marketProfileInput>;

const blank = (value: string | null): string | null => (value === null || value.trim() === '' ? null : value.trim());

async function activeCountry(code: string) {
  const country = await prisma.country.findFirst({
    where: { code: code.toUpperCase(), isActive: true },
    select: { code: true, name: true, currencyCode: true },
  });
  if (country === null) throw notFound('Market');
  return country;
}

function slugs(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

export interface MarketPage {
  country: { code: string; name: string; currencyCode: string };
  profile: {
    headline: string | null;
    intro: string | null;
    dutiesGuidance: string | null;
    deliveryPromise: string | null;
    complianceNotes: string | null;
    featuredCategories: { slug: string; name: string }[];
  } | null;
  restrictions: {
    effect: 'BLOCK' | 'DOCUMENTS_REQUIRED';
    category: { slug: string; name: string } | null;
    product: { slug: string; name: string } | null;
    reason: string;
    requiredDocuments: string[];
  }[];
}

export async function marketPage(code: string, now: Date = new Date()): Promise<MarketPage> {
  const country = await activeCountry(code);

  const [profile, rules] = await Promise.all([
    prisma.marketProfile.findUnique({ where: { countryCode: country.code } }),
    prisma.marketRule.findMany({
      where: {
        countryCode: country.code,
        isActive: true,
        effectiveFrom: { lte: now },
        OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: now } }],
      },
      orderBy: [{ effect: 'asc' }, { createdAt: 'asc' }],
      select: {
        effect: true,
        reason: true,
        requiredDocumentsJson: true,
        category: { select: { slug: true, name: true } },
        product: { select: { slug: true, name: true, isPublished: true, status: true } },
      },
    }),
  ]);

  const published = profile !== null && profile.isPublished ? profile : null;
  const featuredSlugs = published === null ? [] : slugs(published.featuredCategoriesJson);
  const featured =
    featuredSlugs.length === 0
      ? []
      : await prisma.category.findMany({
          where: { ...publicCategoryWhere(), slug: { in: featuredSlugs } },
          select: { slug: true, name: true },
        });
  // In the operator's order, and only the ones that still exist publicly.
  const featuredCategories = featuredSlugs
    .map((slug) => featured.find((category) => category.slug === slug))
    .filter((category): category is { slug: string; name: string } => category !== undefined);

  return {
    country,
    profile:
      published === null
        ? null
        : {
            headline: published.headline,
            intro: published.intro,
            dutiesGuidance: published.dutiesGuidance,
            deliveryPromise: published.deliveryPromise,
            complianceNotes: published.complianceNotes,
            featuredCategories,
          },
    restrictions: rules
      // A rule on an unpublished product names nothing a buyer could find.
      .filter((rule) => rule.product === null || (rule.product.isPublished && rule.product.status === 'ACTIVE'))
      .map((rule) => ({
        effect: rule.effect,
        category: rule.category,
        product: rule.product === null ? null : { slug: rule.product.slug, name: rule.product.name },
        reason: rule.reason,
        requiredDocuments: slugs(rule.requiredDocumentsJson),
      })),
  };
}

// --- Admin -----------------------------------------------------------------

export async function listMarketProfiles() {
  const [countries, profiles] = await Promise.all([
    prisma.country.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { code: true, name: true, currencyCode: true },
    }),
    prisma.marketProfile.findMany(),
  ]);
  return countries.map((country) => {
    const profile = profiles.find((row) => row.countryCode === country.code) ?? null;
    return {
      ...country,
      profile:
        profile === null
          ? null
          : {
              headline: profile.headline,
              intro: profile.intro,
              dutiesGuidance: profile.dutiesGuidance,
              deliveryPromise: profile.deliveryPromise,
              complianceNotes: profile.complianceNotes,
              featuredCategories: slugs(profile.featuredCategoriesJson),
              isPublished: profile.isPublished,
              updatedAt: profile.updatedAt.toISOString(),
            },
    };
  });
}

export async function saveMarketProfile(code: string, input: MarketProfileInput, actor: SettingsActor): Promise<void> {
  const country = await activeCountry(code);
  const data = {
    headline: blank(input.headline),
    intro: blank(input.intro),
    dutiesGuidance: blank(input.dutiesGuidance),
    deliveryPromise: blank(input.deliveryPromise),
    complianceNotes: blank(input.complianceNotes),
    featuredCategoriesJson: [...new Set(input.featuredCategories)],
    isPublished: input.isPublished,
    updatedById: actor.userId,
  };

  await prisma.$transaction(async (tx) => {
    const before = await tx.marketProfile.findUnique({ where: { countryCode: country.code } });
    await tx.marketProfile.upsert({
      where: { countryCode: country.code },
      create: { countryCode: country.code, ...data },
      update: data,
    });
    await recordAudit(
      {
        action: AuditAction.SETTINGS_UPDATED,
        resourceType: 'market_profile',
        resourceId: country.code,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before:
          before === null
            ? null
            : { isPublished: before.isPublished, headline: before.headline, featuredCategories: before.featuredCategoriesJson },
        after: { isPublished: data.isPublished, headline: data.headline, featuredCategories: data.featuredCategoriesJson },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });
}

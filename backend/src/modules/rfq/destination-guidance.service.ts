/** Read-only operator guidance; submission and amendment remain authoritative. */
import { z } from 'zod';
import { isIsoCountryCode } from '../../domain/country-boundaries.js';
import { badRequest, ErrorCode } from '../../domain/errors.js';
import { prisma } from '../../infra/prisma.js';
import { categoryMarketNotes, productMarketNotes } from '../catalog/market-eligibility.service.js';

export const destinationGuidanceQuery = z.object({
  country: z.string().trim().transform(value => value.toUpperCase()).refine(isIsoCountryCode),
  categoryId: z.string().length(26).optional(),
}).strict();

export async function destinationGuidance(input: z.infer<typeof destinationGuidanceQuery>, now: Date = new Date()) {
  const category = input.categoryId === undefined ? null : await prisma.category.findFirst({
    where: { id: input.categoryId, isActive: true, archivedAt: null },
    select: { id: true, path: true },
  });
  if (input.categoryId !== undefined && category === null) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Choose an active category.', [{ field: 'categoryId', code: 'UNKNOWN' }]);
  }
  const [profile, notes] = await Promise.all([
    prisma.marketProfile.findFirst({ where: { countryCode: input.country, isPublished: true }, select: { complianceNotes: true } }),
    category === null ? Promise.resolve([]) : categoryMarketNotes(input.country, category, now),
  ]);
  return {
    country: input.country,
    categoryId: category?.id ?? null,
    complianceNotes: profile?.complianceNotes ?? null,
    notes,
    blockedReason: notes.find(note => note.effect === 'BLOCK' && note.minOrderValueMinor === null)?.reason ?? null,
  };
}

/**
 * Checkout's importer and document prompts for a basket. Labels have their own
 * notice and blocks are refused when the order is placed, so neither repeats here.
 */
export async function basketDestinationGuidance(country: string, productIds: string[], now: Date = new Date()) {
  const code = country.toUpperCase();
  const [profile, products] = await Promise.all([
    prisma.marketProfile.findFirst({ where: { countryCode: code, isPublished: true }, select: { complianceNotes: true } }),
    prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, categoryId: true } }),
  ]);
  const notes = (await Promise.all(products.map(product => productMarketNotes(code, product, now)))).flat();
  const documents = new Map<string, { reason: string; requiredDocuments: string[] }>();
  for (const note of notes) {
    if (note.effect !== 'DOCUMENTS_REQUIRED') continue;
    documents.set(`${note.reason}\n${note.requiredDocuments.join('\n')}`, { reason: note.reason, requiredDocuments: note.requiredDocuments });
  }
  return { country: code, complianceNotes: profile?.complianceNotes ?? null, documentRequirements: [...documents.values()] };
}

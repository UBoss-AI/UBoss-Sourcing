/**
 * The legal documents a developer's machine starts with, so every agreement
 * screen shows a complete, real-reading text from the first sign-up.
 *
 * Called by the development seed only, which refuses to run in production.
 * It publishes the World Mart texts in `legal/drafts/world-mart/`. Those
 * carry SAMPLE company details (registered office, CIN, GSTIN, grievance
 * officer and contacts) that were made up to stand in for the real ones, so a
 * deployment must never go live with them: Settings → Master data lists every
 * published document that still contains them (`SAMPLE_LEGAL_MARKER`), and
 * `legal/drafts/world-mart/CHANGE-TABLE.md` lists each value to replace.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { legalContentHash } from '../../domain/legal-document.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { parseDraftFile } from './draft-file.js';

/** The version prefix an earlier seed published its generic sample text under (`dev-placeholder`, `dev-placeholder-2`). */
export const DEVELOPMENT_TERMS_VERSION = 'dev-placeholder';

/** The sample CIN in every seeded document: a published body containing it has not been made real. */
export const SAMPLE_LEGAL_MARKER = 'U62099HR2024PTC118452';

const DRAFTS = fileURLToPath(new URL('../../../../legal/drafts/world-mart/', import.meta.url));

/**
 * Publish each document in `legal/drafts/world-mart/` whose kind has nothing
 * published, or only what a seed published. An operator's own published text
 * is never superseded. Idempotent.
 */
export async function seedDevelopmentTerms(): Promise<number> {
  let published = 0;
  for (const name of readdirSync(DRAFTS).filter((file) => file.endsWith('.txt')).sort()) {
    const draft = parseDraftFile(name, readFileSync(`${DRAFTS}${name}`, 'utf8'));
    const { kind, version, locale } = draft;

    const operatorOwn = await prisma.legalDocument.count({
      where: {
        kind,
        status: 'PUBLISHED',
        NOT: [{ version: { startsWith: DEVELOPMENT_TERMS_VERSION } }, { body: { contains: SAMPLE_LEGAL_MARKER } }],
      },
    });
    if (operatorOwn > 0) continue;

    const existing = await prisma.legalDocument.findUnique({
      where: { kind_version_locale: { kind, version, locale } },
      select: { id: true, status: true },
    });
    if (existing?.status === 'PUBLISHED') continue;

    const now = new Date();
    const data = {
      ...draft,
      status: 'PUBLISHED' as const,
      effectiveAt: now,
      publishedAt: now,
      contentSha256: legalContentHash(draft),
    };
    // A draft of the same version, loaded by `legal:import-drafts`, becomes the published row.
    // Conditioned on DRAFT, like the service, so a published row can never be rewritten.
    if (existing === null) await prisma.legalDocument.create({ data: { id: newId(), ...data } });
    else {
      const { count } = await prisma.legalDocument.updateMany({ where: { id: existing.id, status: 'DRAFT' }, data });
      if (count === 0) continue;
    }
    published += 1;
  }
  return published;
}

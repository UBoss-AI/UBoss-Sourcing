/**
 * Load legal-document drafts from text files into Administration > Legal
 * documents, as DRAFTS. It never publishes: a person reads each one there,
 * fills in every `[[DECISION: ...]]` blank, and presses Publish - which refuses
 * while any blank remains.
 *
 *   cd backend; npm run legal:import-drafts -- ../legal/drafts/gloviaa-mart
 *
 * Each `*.txt` file starts with a header, then a line `---`, then the body in
 * the legal-document format (`## ` heading, `- ` bullet):
 *
 *   kind: PRIVACY_POLICY
 *   version: 2026-10-draft-1
 *   locale: en
 *   title: Gloviaa Mart Privacy Policy
 *   ---
 *
 * Safe to re-run. A draft with the same kind, version and language is
 * replaced with the file's text; a PUBLISHED one is never touched, and the
 * file is reported as skipped.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { findLegalPlaceholders } from '../../domain/legal-document.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { parseDraftFile, type DraftFile } from './draft-file.js';

async function importDraft(draft: DraftFile): Promise<'created' | 'updated' | 'skipped'> {
  const { kind } = draft;
  const existing = await prisma.legalDocument.findUnique({
    where: { kind_version_locale: { kind, version: draft.version, locale: draft.locale } },
    select: { id: true, status: true },
  });
  if (existing?.status === 'PUBLISHED') return 'skipped';

  const id = existing?.id ?? newId();
  await prisma.$transaction(async (tx) => {
    if (existing === null) {
      await tx.legalDocument.create({
        data: {
          id,
          kind,
          version: draft.version,
          locale: draft.locale,
          title: draft.title,
          body: draft.body,
          // A placeholder date: the editor chooses the real one, and
          // publishing moves a past date to the moment of publication.
          effectiveAt: new Date(),
        },
      });
    } else {
      await tx.legalDocument.updateMany({
        where: { id, status: 'DRAFT' },
        data: { title: draft.title, body: draft.body },
      });
    }
    await recordAudit(
      {
        action: existing === null ? AuditAction.LEGAL_DOCUMENT_DRAFTED : AuditAction.LEGAL_DOCUMENT_DRAFT_UPDATED,
        resourceType: 'legal_document',
        resourceId: id,
        actorType: 'SYSTEM',
        after: { kind: draft.kind, version: draft.version, locale: draft.locale, source: 'legal:import-drafts' },
      },
      tx,
    );
  });
  return existing === null ? 'created' : 'updated';
}

async function main(): Promise<void> {
  const dir = process.argv[2];
  if (dir === undefined) {
    console.error('Usage: npm run legal:import-drafts -- <folder of *.txt drafts>');
    process.exitCode = 2;
    return;
  }

  const folder = resolve(dir);
  const files = readdirSync(folder).filter((file) => file.endsWith('.txt')).sort();
  if (files.length === 0) throw new Error(`No .txt drafts in ${folder}`);

  // Parse everything before writing anything, so one bad file leaves nothing half-imported.
  const drafts = files.map((file) => parseDraftFile(file, readFileSync(join(folder, file), 'utf8')));

  for (const [index, draft] of drafts.entries()) {
    const outcome = await importDraft(draft);
    const blanks = findLegalPlaceholders(draft.body).length;
    console.log(
      `${outcome.padEnd(8)} ${draft.kind} ${draft.version} (${draft.locale}) from ${files[index] ?? ''}` +
        (blanks > 0 ? ` - ${String(blanks)} blank(s) to fill before it can be published` : ''),
    );
  }
  console.log('');
  console.log('Drafts only. Nothing was published. Review each in Administration > Legal documents.');
}

main()
  .catch((error: unknown) => {
    console.error('Importing legal drafts failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });

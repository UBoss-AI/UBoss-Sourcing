/**
 * Legal documents against a real MariaDB: drafting, publishing, the frozen
 * published row, which version is in force, the language fallback and the PDF.
 *
 * Every document this file publishes is deleted again in afterAll. Nothing in
 * here accepts one, so nothing stops that - and the next file finds the suite's
 * own test Terms in force again, as `tests/global-setup.ts` left them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { legalContentHash } from '../../src/domain/legal-document.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import {
  assertAcceptableTerms,
  createDraft,
  deleteDraft,
  findCurrentDocument,
  getPublishedDocument,
  listDocumentsInForce,
  listLegalDocuments,
  listPublishedVersions,
  publishDraft,
  renderLegalDocumentPdf,
  updateDraft,
  type DraftInput,
  type LegalActor,
} from '../../src/modules/legal/legal-document.service.js';

const RUN = Date.now().toString(36);
const created: string[] = [];
let actor: LegalActor;

function draft(overrides: Partial<DraftInput> = {}): DraftInput {
  return {
    kind: 'PLATFORM_TERMS',
    version: `it-${RUN}`,
    locale: 'en',
    title: 'Terms and Conditions',
    body: '## Using the marketplace\nText written by the operator.\n\n- one\n- two',
    changeSummary: null,
    effectiveAt: new Date(Date.now() - 60_000),
    ...overrides,
  };
}

async function newDraft(overrides: Partial<DraftInput> = {}) {
  const view = await createDraft(draft(overrides), actor);
  created.push(view.id);
  return view;
}

beforeAll(async () => {
  const userId = newId();
  await prisma.user.create({
    data: { id: userId, type: 'ADMIN', email: `legal-${RUN}@test.local`, emailNormalized: `legal-${RUN}@test.local`, status: 'ACTIVE' },
  });
  actor = { userId, email: `legal-${RUN}@test.local` };
});

afterAll(async () => {
  // Newest first: a document can point at the one it superseded.
  const rows = await prisma.legalDocument.findMany({
    where: { id: { in: created } },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  for (const row of rows) await prisma.legalDocument.deleteMany({ where: { id: row.id } });
  await prisma.auditLog.deleteMany({ where: { actorUserId: actor.userId } });
  await prisma.user.deleteMany({ where: { id: actor.userId } });
});

describe('drafts', () => {
  it('are never visible to the public', async () => {
    const view = await newDraft({ version: `draft-${RUN}` });
    expect(view.status).toBe('DRAFT');
    expect(view.contentSha256).toBeNull();
    await expect(getPublishedDocument(view.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      assertAcceptableTerms({ kind: 'PLATFORM_TERMS', acceptedTerms: true, documentId: view.id }),
    ).rejects.toMatchObject({ code: 'TERMS_VERSION_OUTDATED' });
  });

  it('can be changed and deleted', async () => {
    const view = await newDraft({ version: `edit-${RUN}` });
    const edited = await updateDraft(view.id, draft({ version: `edit-${RUN}`, title: 'Changed' }), actor);
    expect(edited.title).toBe('Changed');
    await deleteDraft(view.id, actor);
    expect(await prisma.legalDocument.count({ where: { id: view.id } })).toBe(0);
  });

  it('refuse a second document with the same kind, version and language', async () => {
    await newDraft({ version: `dup-${RUN}` });
    await expect(createDraft(draft({ version: `dup-${RUN}` }), actor)).rejects.toMatchObject({
      code: 'LEGAL_DOCUMENT_VERSION_EXISTS',
    });
  });

  it('refuse a version that is not a plain identifier, and a language the system does not have', async () => {
    await expect(createDraft(draft({ version: 'has spaces' }), actor)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(createDraft(draft({ locale: 'xx' }), actor)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});

describe('publishing', () => {
  let publishedId = '';

  it('freezes the text with its hash, and makes it the version in force', async () => {
    const view = await newDraft();
    const published = await publishDraft(view.id, actor);
    publishedId = published.id;

    expect(published.status).toBe('PUBLISHED');
    expect(published.contentSha256).toBe(
      legalContentHash({ kind: 'PLATFORM_TERMS', version: `it-${RUN}`, locale: 'en', title: view.title, body: view.body }),
    );
    // A date in the past becomes the moment of publishing: no backdating.
    expect(new Date(published.effectiveAt).getTime()).toBeGreaterThanOrEqual(new Date(published.publishedAt ?? 0).getTime() - 5);
    expect(published.isCurrentVersion).toBe(true);
    expect(published.supersedesId).not.toBeNull();

    const current = await findCurrentDocument('PLATFORM_TERMS', 'en');
    expect(current?.document.id).toBe(published.id);
    expect(current?.isFallback).toBe(false);

    const audit = await prisma.auditLog.findFirst({ where: { action: 'legal_document.published', resourceId: published.id } });
    expect(audit).not.toBeNull();
  });

  it('never lets a published document be changed or deleted', async () => {
    await expect(updateDraft(publishedId, draft({ title: 'Sneaky edit' }), actor)).rejects.toMatchObject({
      code: 'LEGAL_DOCUMENT_IMMUTABLE',
    });
    await expect(deleteDraft(publishedId, actor)).rejects.toMatchObject({ code: 'LEGAL_DOCUMENT_IMMUTABLE' });
    await expect(publishDraft(publishedId, actor)).rejects.toMatchObject({ code: 'LEGAL_DOCUMENT_IMMUTABLE' });
    const row = await prisma.legalDocument.findUniqueOrThrow({ where: { id: publishedId } });
    expect(row.title).toBe('Terms and Conditions');
  });

  it('makes the older version unacceptable, while it stays readable', async () => {
    const older = await findCurrentDocument('PLATFORM_TERMS', 'en');
    expect(older?.document.id).toBe(publishedId);
    const [previous] = await prisma.legalDocument.findMany({
      where: { id: (await prisma.legalDocument.findUniqueOrThrow({ where: { id: publishedId } })).supersedesId ?? '' },
    });
    expect(previous).toBeDefined();
    await expect(
      assertAcceptableTerms({ kind: 'PLATFORM_TERMS', acceptedTerms: true, documentId: previous?.id ?? null }),
    ).rejects.toMatchObject({ code: 'TERMS_VERSION_OUTDATED', statusCode: 409 });
    // Still published, so still readable by whoever accepted it.
    expect((await getPublishedDocument(previous?.id ?? '')).version).toBe(previous?.version);
  });

  it('accepts the current version, and refuses no agreement at all', async () => {
    const terms = await assertAcceptableTerms({ kind: 'PLATFORM_TERMS', acceptedTerms: true, documentId: publishedId });
    expect(terms.version).toBe(`it-${RUN}`);
    await expect(
      assertAcceptableTerms({ kind: 'PLATFORM_TERMS', acceptedTerms: false, documentId: publishedId }),
    ).rejects.toMatchObject({ code: 'TERMS_ACCEPTANCE_REQUIRED', statusCode: 400 });
    await expect(
      assertAcceptableTerms({ kind: 'PLATFORM_TERMS', acceptedTerms: true, documentId: null }),
    ).rejects.toMatchObject({ code: 'TERMS_ACCEPTANCE_REQUIRED' });
    // The buyer terms are not the carrier terms.
    await expect(
      assertAcceptableTerms({ kind: 'LOGISTICS_PARTNER_TERMS', acceptedTerms: true, documentId: publishedId }),
    ).rejects.toMatchObject({ code: 'TERMS_VERSION_OUTDATED' });
  });

  it('falls back to English, and says so, until the reader\'s language is published', async () => {
    const before = await findCurrentDocument('PLATFORM_TERMS', 'pl');
    expect(before?.document.locale).toBe('en');
    expect(before?.isFallback).toBe(true);
    expect(before?.requestedLocale).toBe('pl');

    const polish = await newDraft({ locale: 'pl', title: 'Regulamin', body: '## Korzystanie\nTekst operatora - zażółć gęślą jaźń.' });
    await publishDraft(polish.id, actor);

    const after = await findCurrentDocument('PLATFORM_TERMS', 'pl');
    expect(after?.document.id).toBe(polish.id);
    expect(after?.isFallback).toBe(false);
    // Either language of the version in force can be accepted.
    await expect(
      assertAcceptableTerms({ kind: 'PLATFORM_TERMS', acceptedTerms: true, documentId: polish.id }),
    ).resolves.toMatchObject({ locale: 'pl' });
  });

  it('does not put a future version in force before its date', async () => {
    const future = await newDraft({ locale: 'de', version: `future-${RUN}`, effectiveAt: new Date(Date.now() + 86_400_000) });
    await publishDraft(future.id, actor);
    await expect(
      assertAcceptableTerms({ kind: 'PLATFORM_TERMS', acceptedTerms: true, documentId: future.id }),
    ).rejects.toMatchObject({ code: 'TERMS_VERSION_OUTDATED' });
    const versions = await listPublishedVersions('PLATFORM_TERMS');
    expect(versions.find((entry) => entry.id === future.id)?.isCurrent).toBe(false);
    expect(versions.find((entry) => entry.id === publishedId)?.isCurrent).toBe(true);

    // And nothing may later be published in German effective before it.
    const earlier = await newDraft({ locale: 'de', version: `earlier-${RUN}` });
    await expect(publishDraft(earlier.id, actor)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('counts acceptances on the list, and never names anyone', async () => {
    const list = await listLegalDocuments({ kind: 'PLATFORM_TERMS' });
    const mine = list.find((entry) => entry.id === publishedId);
    expect(mine?.acceptanceCount).toBe(0);
    expect(Object.keys(mine ?? {})).not.toContain('acceptances');
  });

  it('renders the same PDF every time, from the stored text', async () => {
    const first = await renderLegalDocumentPdf(publishedId);
    const second = await renderLegalDocumentPdf(publishedId);
    expect(first.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(first.bytes.equals(second.bytes)).toBe(true);
    expect(first.fileName).toBe(`platform_terms-it-${RUN}-en.pdf`);
  });
});

describe('published policies (Master row 9)', () => {
  it('publishes a policy like the terms, and lists it among the documents in force', async () => {
    const view = await newDraft({ kind: 'RETURNS_POLICY', version: `it-${RUN}-returns`, title: 'Returns policy' });
    // A draft is not in force.
    expect((await listDocumentsInForce('en')).some((entry) => entry.id === view.id)).toBe(false);

    const published = await publishDraft(view.id, actor);
    expect(published.contentSha256).toBe(
      legalContentHash({ kind: 'RETURNS_POLICY', version: `it-${RUN}-returns`, locale: 'en', title: view.title, body: view.body }),
    );
    const listed = (await listDocumentsInForce('en')).find((entry) => entry.kind === 'RETURNS_POLICY');
    expect(listed).toMatchObject({ id: published.id, title: 'Returns policy', version: `it-${RUN}-returns`, isFallback: false });
    // The hub lists titles and links, never the body.
    expect(JSON.stringify(listed)).not.toContain('Text written by the operator');
  });

  it('never lets a policy stand in for the terms at sign-up', async () => {
    const policy = await findCurrentDocument('RETURNS_POLICY', 'en');
    expect(policy).not.toBeNull();
    await expect(
      assertAcceptableTerms({ kind: 'PLATFORM_TERMS', acceptedTerms: true, documentId: policy?.document.id ?? null }),
    ).rejects.toMatchObject({ code: 'TERMS_VERSION_OUTDATED' });
  });

  it('leaves the carrier terms out of the storefront hub', async () => {
    const kinds = (await listDocumentsInForce('en')).map((entry) => entry.kind);
    expect(kinds).not.toContain('LOGISTICS_PARTNER_TERMS');
  });
});

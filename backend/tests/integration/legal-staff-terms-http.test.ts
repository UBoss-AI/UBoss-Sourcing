/**
 * The staff terms the admin console's sign-in shows.
 *
 * `GET /legal/current?kind=STAFF_TERMS` is read before anybody is signed in,
 * so it must answer without a session. With nothing published it answers 503
 * TERMS_DOCUMENT_UNAVAILABLE - which the console reads as "fall back to the
 * plain tick", never as "nobody may sign in". And the staff terms are for
 * staff: the storefront's help hub must never list them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { legalContentHash } from '../../src/domain/legal-document.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';

const documentIds: string[] = [];
let app: Awaited<ReturnType<typeof buildApp>>;

async function publishStaffTerms(locale: string, title: string): Promise<string> {
  const id = newId();
  const now = new Date();
  const content = {
    kind: 'STAFF_TERMS',
    version: `staff-${id}`,
    locale,
    title,
    body: '## Test document\nInstalled by the test suite. Not legal text.',
  };
  await prisma.legalDocument.create({
    data: {
      id,
      ...content,
      kind: 'STAFF_TERMS',
      status: 'PUBLISHED',
      effectiveAt: now,
      publishedAt: now,
      contentSha256: legalContentHash(content),
    },
  });
  documentIds.push(id);
  return id;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  // Nobody accepts a staff document, so nothing references these rows.
  for (const id of [...documentIds].reverse()) await prisma.legalDocument.deleteMany({ where: { id } });
  await app?.close();
});

describe('GET /legal/current?kind=STAFF_TERMS', () => {
  it('answers 503 TERMS_DOCUMENT_UNAVAILABLE, without a session, when none are published', async () => {
    const published = await prisma.legalDocument.count({ where: { kind: 'STAFF_TERMS', status: 'PUBLISHED' } });
    // Another file may have left one in force; the point here is the shape of "none".
    if (published > 0) return;
    const response = await app.inject({ method: 'GET', url: '/api/v1/legal/current?kind=STAFF_TERMS&locale=en' });
    expect(response.statusCode, response.body).toBe(503);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('TERMS_DOCUMENT_UNAVAILABLE');
  });

  it('serves the published staff terms to an anonymous reader, and never lists them in the help hub', async () => {
    const id = await publishStaffTerms('en', 'Staff terms (test)');

    const response = await app.inject({ method: 'GET', url: '/api/v1/legal/current?kind=STAFF_TERMS&locale=en' });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const current = response.json<{ document: { id: string; kind: string; title: string }; isFallback: boolean }>();
    expect(current.document).toMatchObject({ id, kind: 'STAFF_TERMS', title: 'Staff terms (test)' });
    expect(current.isFallback).toBe(false);

    const hub = await app.inject({ method: 'GET', url: '/api/v1/legal/in-force?locale=en' });
    expect(hub.statusCode, hub.body).toBe(200);
    const kinds = hub.json<{ documents: { kind: string }[] }>().documents.map((entry) => entry.kind);
    expect(kinds).not.toContain('STAFF_TERMS');
  });

  it('falls back to English when the staff terms are not published in the reader\'s language', async () => {
    await publishStaffTerms('en', 'Staff terms (fallback test)');
    const response = await app.inject({ method: 'GET', url: '/api/v1/legal/current?kind=STAFF_TERMS&locale=pl' });
    expect(response.statusCode, response.body).toBe(200);
    const current = response.json<{ document: { locale: string }; requestedLocale: string; isFallback: boolean }>();
    expect(current).toMatchObject({ requestedLocale: 'pl', isFallback: true });
    expect(current.document.locale).toBe('en');
  });
});

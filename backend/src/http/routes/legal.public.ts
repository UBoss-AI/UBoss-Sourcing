/**
 * Published legal documents, for anybody: the storefront's sign-up form, the
 * carrier portal's activation page, and the public Terms pages.
 *
 * Read-only and published-only. A draft is never found here, whatever id is
 * asked for, and nothing on this surface can change a document.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { LEGAL_DOCUMENT_KINDS } from '../../domain/legal-document.js';
import {
  getCurrentDocument,
  getPublishedDocument,
  listPublishedVersions,
  renderLegalDocumentPdf,
} from '../../modules/legal/legal-document.service.js';

const kindQuery = z.object({
  kind: z.enum(LEGAL_DOCUMENT_KINDS).default('PLATFORM_TERMS'),
  locale: z.string().trim().max(10).default('en'),
});

const idParam = z.object({ id: z.string().length(26) });

export function registerPublicLegalRoutes(app: FastifyInstance): Promise<void> {
  // The Terms in force now for a kind of account, in the reader's language where it is published. 503 TERMS_DOCUMENT_UNAVAILABLE when none are.
  app.get('/current', async (request, reply) => {
    const { kind, locale } = kindQuery.parse(request.query);
    return reply.header('cache-control', 'no-store').send(await getCurrentDocument(kind, locale));
  });

  // Every published version of a kind, newest first, so anybody can read the terms they agreed to at the time.
  app.get('/versions', async (request, reply) => {
    const { kind } = kindQuery.parse(request.query);
    return reply.send({ versions: await listPublishedVersions(kind) });
  });

  // One published document, of any version. Drafts are never returned.
  app.get('/documents/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return reply.send(await getPublishedDocument(id));
  });

  // One published document as a PDF, built from exactly the stored text.
  app.get(
    '/documents/:id/pdf',
    { config: { rateLimit: { max: 30, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const file = await renderLegalDocumentPdf(id);
      return reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', `attachment; filename="${file.fileName}"`)
        // A published document never changes, so its PDF never does either.
        .header('cache-control', 'public, max-age=86400, immutable')
        .send(file.bytes);
    },
  );

  return Promise.resolve();
}

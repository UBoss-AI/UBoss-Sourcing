/**
 * Seller invoices and packing lists, per consignment. Under `/seller`.
 *
 * The seller comes from the session's membership and every service narrows
 * reads and writes to it, so another seller's consignment, invoice or packing
 * list answers 404. PDFs are streamed with `Cache-Control: no-store`: a tax
 * invoice does not belong in a shared cache.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { SellerPermission } from '../../domain/seller-permissions.js';
import {
  packagesInputSchema,
  savePackages,
  splitConsignment,
  splitInputSchema,
} from '../../modules/documents/consignment.service.js';
import {
  batchInputSchema,
  packConsignment,
  readConsignmentDocuments,
  readSellerOrderDocuments,
  sellerBatchLink,
  sellerDocumentLink,
} from '../../modules/documents/documents.service.js';
import {
  invoiceSettingsSchema,
  readInvoiceSettings,
  readTradeCodes,
  saveInvoiceSettings,
  saveTradeCodes,
  tradeCodesSchema,
} from '../../modules/documents/invoice-settings.service.js';
import {
  issuePackingList,
  packingListPdfForSeller,
  preparePackingList,
  supersedeInputSchema,
  supersedePackingList,
} from '../../modules/documents/packing-list.service.js';
import {
  creditInputSchema,
  creditInvoice,
  invoicePdfForSeller,
  issueInvoice,
  prepareInvoice,
} from '../../modules/documents/seller-invoice.service.js';
import { currentUser } from '../plugins/auth.js';
import { currentSeller, requireSeller, requireTradingSeller } from '../plugins/seller.js';

const WRITE = { max: 60, timeWindow: '1 minute' } as const;
const ISSUE = { max: 20, timeWindow: '1 minute' } as const;
const idParam = z.object({ id: z.string().length(26) });
const kindParam = z.object({
  kind: z.enum(['invoice', 'packing-list']),
  id: z.string().length(26),
});

function sendPdf(reply: FastifyReply, file: { bytes: Buffer; fileName: string }) {
  return reply
    .header('content-type', 'application/pdf')
    .header(
      'content-disposition',
      `inline; filename="${file.fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
    )
    .header('cache-control', 'no-store')
    .send(file.bytes);
}

export function registerSellerDocumentRoutes(app: FastifyInstance): Promise<void> {
  const read = { preHandler: requireSeller(SellerPermission.ORDER_READ) };
  const write = {
    preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL),
    config: { rateLimit: WRITE },
  };
  const issue = {
    preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL),
    config: { rateLimit: ISSUE },
  };

  app.get('/orders/:id/documents', read, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return reply.send(await readSellerOrderDocuments(currentSeller(request), id));
  });

  app.get('/consignments/:id/documents', read, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return reply.send({ consignment: await readConsignmentDocuments(currentSeller(request), id) });
  });

  app.put('/consignments/:id/packages', write, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await savePackages(currentSeller(request), id, packagesInputSchema.parse(request.body));
    return reply.send({ consignment: await readConsignmentDocuments(currentSeller(request), id) });
  });

  app.post('/consignments/:id/split', write, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const created = await splitConsignment(
      currentSeller(request),
      id,
      splitInputSchema.parse(request.body),
    );
    return reply.status(201).send(created);
  });

  // --- Invoice ---------------------------------------------------------------

  app.post('/consignments/:id/invoice/preview', write, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return reply.send({ invoice: await prepareInvoice(currentSeller(request), id) });
  });

  app.get('/consignments/:id/invoice/pdf', read, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return sendPdf(
      reply,
      await invoicePdfForSeller(currentSeller(request), id, request.correlationId),
    );
  });

  app.post('/consignments/:id/invoice/issue', issue, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return reply.send({
      invoice: await issueInvoice(currentSeller(request), id, request.correlationId),
    });
  });

  app.post('/invoices/:id/credit', issue, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return reply.status(201).send({
      creditNote: await creditInvoice(
        currentSeller(request),
        id,
        creditInputSchema.parse(request.body),
        request.correlationId,
      ),
    });
  });

  // --- Packing list ----------------------------------------------------------------

  app.post('/consignments/:id/packing-list/preview', write, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return reply.send({ packingList: await preparePackingList(currentSeller(request), id) });
  });

  app.get('/consignments/:id/packing-list/pdf', read, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return sendPdf(
      reply,
      await packingListPdfForSeller(currentSeller(request), id, request.correlationId),
    );
  });

  app.post('/consignments/:id/packing-list/issue', issue, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return reply.send({
      packingList: await issuePackingList(currentSeller(request), id, request.correlationId),
    });
  });

  app.post('/consignments/:id/packing-list/supersede', issue, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await supersedePackingList(
      currentSeller(request),
      id,
      supersedeInputSchema.parse(request.body),
      request.correlationId,
    );
    return reply.send({ consignment: await readConsignmentDocuments(currentSeller(request), id) });
  });

  /** Invoice + packing list + packed, together or not at all. */
  app.post('/consignments/:id/pack', issue, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return reply.send({
      consignment: await packConsignment(currentSeller(request), id, request.correlationId),
    });
  });

  // --- Downloads -----------------------------------------------------------------------

  app.post('/document-links/:kind/:id', read, async (request, reply) => {
    const { kind, id } = kindParam.parse(request.params);
    return reply.send(
      await sellerDocumentLink(currentSeller(request), currentUser(request).id, kind, id),
    );
  });

  app.post('/document-links/batch', read, async (request, reply) => {
    return reply.send(
      await sellerBatchLink(
        currentSeller(request),
        currentUser(request).id,
        batchInputSchema.parse(request.body),
      ),
    );
  });

  // --- Settings and trade codes ------------------------------------------------------------

  app.get(
    '/invoice-settings',
    { preHandler: requireSeller(SellerPermission.ACCOUNT_READ) },
    async (request, reply) => {
      return reply.send(await readInvoiceSettings(currentSeller(request)));
    },
  );

  app.put(
    '/invoice-settings',
    { preHandler: requireSeller(SellerPermission.ACCOUNT_WRITE), config: { rateLimit: WRITE } },
    async (request, reply) => {
      return reply.send(
        await saveInvoiceSettings(
          currentSeller(request),
          invoiceSettingsSchema.parse(request.body),
        ),
      );
    },
  );

  app.get(
    '/offers/:id/trade-codes',
    { preHandler: requireSeller(SellerPermission.LISTING_READ) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      return reply.send(await readTradeCodes(currentSeller(request), id));
    },
  );

  app.put(
    '/offers/:id/trade-codes',
    { preHandler: requireSeller(SellerPermission.LISTING_WRITE), config: { rateLimit: WRITE } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      return reply.send(
        await saveTradeCodes(currentSeller(request), id, tradeCodesSchema.parse(request.body)),
      );
    },
  );

  return Promise.resolve();
}

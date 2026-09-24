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

  /** Every consignment of one of the seller's orders, with its packages, invoices and packing lists. */
  app.get('/orders/:id/documents', read, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return reply.send(await readSellerOrderDocuments(currentSeller(request), id));
  });

  /** One of the seller's consignments, with its packages, invoices and packing lists. */
  app.get('/consignments/:id/documents', read, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return reply.send({ consignment: await readConsignmentDocuments(currentSeller(request), id) });
  });

  /**
   * Replace the list of packages in a consignment and what each one holds.
   * Refused once a package has been scanned out, a shipping label bought or a
   * packing list issued.
   */
  app.put('/consignments/:id/packages', write, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await savePackages(currentSeller(request), id, packagesInputSchema.parse(request.body));
    return reply.send({ consignment: await readConsignmentDocuments(currentSeller(request), id) });
  });

  /**
   * Move some of a consignment's items onto a new consignment, for example a
   * second vehicle or a second day. Refused once an invoice or packing list is
   * issued or the packages are locked.
   */
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

  /**
   * Prepare or refresh the draft invoice for a consignment and say whether it
   * can be issued, listing anything that must be fixed first. Never changes an
   * issued invoice.
   */
  app.post('/consignments/:id/invoice/preview', write, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return reply.send({ invoice: await prepareInvoice(currentSeller(request), id) });
  });

  /** The consignment's invoice as a PDF: the issued one if there is one, otherwise a watermarked draft. */
  app.get('/consignments/:id/invoice/pdf', read, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return sendPdf(
      reply,
      await invoicePdfForSeller(currentSeller(request), id, request.correlationId),
    );
  });

  /**
   * Issue the consignment's tax invoice: give it its number, store the final
   * PDF and email the buyer. Refused while the draft still has problems; asking
   * again after it is issued returns the same invoice. Writes an audit entry.
   */
  app.post('/consignments/:id/invoice/issue', issue, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return reply.send({
      invoice: await issueInvoice(currentSeller(request), id, request.correlationId),
    });
  });

  /**
   * Cancel an issued invoice by issuing a credit note for the same amount, with
   * a reason. The original is kept and marked void, and the consignment can then
   * be invoiced again under a new number. Writes an audit entry.
   */
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

  /**
   * Prepare or refresh the draft packing list for a consignment and say whether
   * it can be issued, listing anything that must be fixed first.
   */
  app.post('/consignments/:id/packing-list/preview', write, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return reply.send({ packingList: await preparePackingList(currentSeller(request), id) });
  });

  /** The consignment's packing list as a PDF: the issued one if there is one, otherwise a watermarked draft. */
  app.get('/consignments/:id/packing-list/pdf', read, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return sendPdf(
      reply,
      await packingListPdfForSeller(currentSeller(request), id, request.correlationId),
    );
  });

  /**
   * Issue the consignment's packing list: give it its number and store the
   * final PDF. Refused while the draft still has problems; asking again after it
   * is issued returns the same list. Writes an audit entry.
   */
  app.post('/consignments/:id/packing-list/issue', issue, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return reply.send({
      packingList: await issuePackingList(currentSeller(request), id, request.correlationId),
    });
  });

  /**
   * Withdraw an issued packing list, with a reason, so the load can be re-packed
   * and a new list issued. Only allowed before the carrier has scanned anything
   * out. Writes an audit entry.
   */
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

  /** Get a short-lived, single-use download link for one of the seller's own invoices or packing lists. */
  app.post('/document-links/:kind/:id', read, async (request, reply) => {
    const { kind, id } = kindParam.parse(request.params);
    return reply.send(
      await sellerDocumentLink(currentSeller(request), currentUser(request).id, kind, id),
    );
  });

  /**
   * Get a short-lived, single-use link that downloads up to 100 of the seller's
   * own documents as one ZIP file.
   */
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

  /**
   * The seller's invoice settings (number series, financial year, signatory,
   * export bond reference, footer), plus the legal name and tax number invoices
   * will be issued under.
   */
  app.get(
    '/invoice-settings',
    { preHandler: requireSeller(SellerPermission.ACCOUNT_READ) },
    async (request, reply) => {
      return reply.send(await readInvoiceSettings(currentSeller(request)));
    },
  );

  /** Save the seller's invoice settings. Writes an entry in the seller's activity log. */
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

  /** The HSN (customs) code and country of origin saved on one of the seller's listings. */
  app.get(
    '/offers/:id/trade-codes',
    { preHandler: requireSeller(SellerPermission.LISTING_READ) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      return reply.send(await readTradeCodes(currentSeller(request), id));
    },
  );

  /**
   * Save the HSN (customs) code and country of origin on one of the seller's
   * listings, which its invoices print. Writes an entry in the seller's activity log.
   */
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

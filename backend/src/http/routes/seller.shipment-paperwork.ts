/**
 * Shipment documents and shipment booking for a seller's own orders (Master
 * rows 42 and 56). Under `/seller`.
 *
 * The seller comes from the session's membership and every service narrows to
 * it, so another seller's order or consignment answers 404. Files are served
 * with `Cache-Control: no-store`.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { SellerPermission } from '../../domain/seller-permissions.js';
import {
  readShipmentBooking,
  saveShipmentBooking,
} from '../../modules/seller/shipment-booking.service.js';
import {
  addTradeDocumentVersion,
  generateCertificateOfOriginDraft,
  listSellerTradeDocuments,
  sellerTradeDocumentFile,
} from '../../modules/seller/trade-documents.service.js';
import { currentSeller, requireSeller, requireTradingSeller } from '../plugins/seller.js';

const WRITE = { max: 30, timeWindow: '1 minute' } as const;
const idParam = z.object({ id: z.string().length(26) });

export function sendDocumentFile(
  reply: FastifyReply,
  file: { bytes: Buffer; fileName: string; contentType: string },
) {
  return reply
    .header('content-type', file.contentType)
    .header('content-disposition', `inline; filename="${file.fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`)
    .header('x-content-type-options', 'nosniff')
    .header('cache-control', 'no-store')
    .send(file.bytes);
}

function fieldValue(fields: Record<string, unknown>, name: string): string | null {
  const field = fields[name];
  if (typeof field === 'object' && field !== null && 'value' in field) {
    const value = String((field).value).trim();
    return value === '' ? null : value;
  }
  return null;
}

function dateOrNull(value: string | null): Date | null {
  if (value === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const referenceVersionSchema = z
  .object({
    shipmentId: z.string().length(26).nullable().optional(),
    kind: z.string().trim().min(1).max(64),
    title: z.string().trim().max(160).nullable().optional(),
    referenceNumber: z.string().trim().max(64).nullable().optional(),
    issuerName: z.string().trim().max(200),
    issuedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  })
  .strict();

const bookingSchema = z
  .object({
    mode: z.string().trim().max(16),
    incoterm: z.string().trim().max(3),
    incotermPlace: z.string().trim().max(120).nullable().optional(),
    originPort: z.string().trim().max(5).nullable().optional(),
    destinationPort: z.string().trim().max(5).nullable().optional(),
    routeNote: z.string().trim().max(500).nullable().optional(),
    pickupDate: z.string().trim().max(10).nullable().optional(),
    pickupWindowFrom: z.string().trim().max(5).nullable().optional(),
    pickupWindowTo: z.string().trim().max(5).nullable().optional(),
    manualCarrier: z.enum(['DHL', 'FEDEX', 'INDIA_POST']).nullable().optional(),
  })
  .strict();

export function registerSellerShipmentPaperworkRoutes(app: FastifyInstance): Promise<void> {
  // The certificate of origin, waybills and other trade documents of one seller order, with what the destination and category rules require.
  app.get(
    '/orders/:id/trade-documents',
    { preHandler: requireSeller(SellerPermission.ORDER_READ) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const result = await listSellerTradeDocuments(currentSeller(request).sellerAccountId, id);
      return reply.header('cache-control', 'no-store').send(result);
    },
  );

  // Record a new version of a trade document by its number only (a waybill, a shipping bill), with issuer and dates.
  app.post(
    '/orders/:id/trade-documents',
    { preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL), config: { rateLimit: WRITE } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = referenceVersionSchema.parse(request.body);
      const seller = currentSeller(request);
      const document = await addTradeDocumentVersion({
        actor: { sellerAccountId: seller.sellerAccountId, label: seller.displayName },
        orderGroupId: id,
        shipmentId: body.shipmentId ?? null,
        kind: body.kind,
        title: body.title ?? null,
        referenceNumber: body.referenceNumber ?? null,
        issuerName: body.issuerName,
        issuedOn: dateOrNull(body.issuedOn ?? null),
        expiresOn: dateOrNull(body.expiresOn ?? null),
        file: null,
        correlationId: request.correlationId,
      });
      return reply.status(201).send({ document });
    },
  );

  // Upload a new version of a trade document as a PDF or image, with its kind, issuer, number and dates as form fields.
  app.post(
    '/orders/:id/trade-documents/upload',
    { preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL), config: { rateLimit: WRITE } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const file = await request.file();
      if (file === undefined) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Attach a file.',
            details: [{ field: 'file', code: 'REQUIRED' }],
            correlationId: request.correlationId,
          },
        });
      }
      const fields = file.fields as Record<string, unknown>;
      const bytes = await file.toBuffer();
      const seller = currentSeller(request);
      const document = await addTradeDocumentVersion({
        actor: { sellerAccountId: seller.sellerAccountId, label: seller.displayName },
        orderGroupId: id,
        shipmentId: fieldValue(fields, 'shipmentId'),
        kind: fieldValue(fields, 'kind') ?? '',
        title: fieldValue(fields, 'title'),
        referenceNumber: fieldValue(fields, 'referenceNumber'),
        issuerName: fieldValue(fields, 'issuerName') ?? '',
        issuedOn: dateOrNull(fieldValue(fields, 'issuedOn')),
        expiresOn: dateOrNull(fieldValue(fields, 'expiresOn')),
        file: { fileName: file.filename, bytes },
        correlationId: request.correlationId,
      });
      return reply.status(201).send({ document });
    },
  );

  // Generate a certificate of origin draft PDF from the order, for an issuing authority to certify.
  app.post(
    '/orders/:id/trade-documents/certificate-of-origin',
    { preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL), config: { rateLimit: WRITE } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z
        .object({ shipmentId: z.string().length(26).nullable().optional() })
        .strict()
        .parse(request.body ?? {});
      const seller = currentSeller(request);
      const document = await generateCertificateOfOriginDraft({
        actor: { sellerAccountId: seller.sellerAccountId, label: seller.displayName },
        orderGroupId: id,
        shipmentId: body.shipmentId ?? null,
        correlationId: request.correlationId,
      });
      return reply.status(201).send({ document });
    },
  );

  // Download the file of one version of the seller's own trade document.
  app.get(
    '/trade-documents/versions/:id/file',
    { preHandler: requireSeller(SellerPermission.ORDER_READ) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      return sendDocumentFile(reply, await sellerTradeDocumentFile(currentSeller(request).sellerAccountId, id));
    },
  );

  // The booking of one consignment: mode, Incoterm, ports, pickup date and window, and who carries it.
  app.get(
    '/consignments/:id/booking',
    { preHandler: requireSeller(SellerPermission.ORDER_READ) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const booking = await readShipmentBooking(currentSeller(request).sellerAccountId, id);
      return reply.header('cache-control', 'no-store').send({ booking });
    },
  );

  // Book a consignment: store its mode, Incoterm, ports and pickup, and record a hand booking with DHL, FedEx or India Post when one is named.
  app.put(
    '/consignments/:id/booking',
    { preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL), config: { rateLimit: WRITE } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = bookingSchema.parse(request.body);
      const seller = currentSeller(request);
      const booking = await saveShipmentBooking({
        actor: { sellerAccountId: seller.sellerAccountId, memberId: seller.memberId, label: seller.displayName },
        shipmentId: id,
        booking: body,
        correlationId: request.correlationId,
      });
      return reply.status(200).send({ booking });
    },
  );

  return Promise.resolve();
}

/**
 * VAT rates, VAT number checks and invoices — admin only.
 *
 * Three groups of route, and each one exists because a piece of the VAT engine
 * has to be correctable by a person without a release.
 *
 *   - **Rates.** Member states change them with a few months' notice, and no
 *     codebase can ship a live feed. A rate is added, never edited: the row
 *     carries the date it starts, so a correction is a new period and every
 *     invoice already raised keeps the rate it was raised at. There is
 *     deliberately no DELETE.
 *
 *   - **VAT number checks.** The button that asks VIES again. The whole
 *     difference between a zero-rated supply and the seller paying the tax
 *     themselves is whether a member state has confirmed the number, and that
 *     answer goes stale — registrations get cancelled.
 *
 *   - **Invoices.** Raising one and, when it was wrong, raising the credit
 *     note that reverses it. There is no edit and no delete here either, for
 *     the reason in `invoice.service.ts`: a gap in an invoice sequence reads to
 *     a tax inspector as a destroyed document.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ErrorCode, badRequest, notFound } from '../../domain/errors.js';
import { Permission } from '../../domain/permissions.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../../modules/audit/audit.service.js';
import {
  creditInvoice,
  getInvoice,
  getInvoiceForOrder,
  issueInvoice,
} from '../../modules/invoicing/invoice.service.js';
import {
  renderInvoiceUbl,
  validateInvoiceForEn16931,
} from '../../modules/invoicing/ubl.service.js';
import { refreshCustomerVatNumber } from '../../modules/tax/vies.service.js';
import { currentUser, requireAdmin } from '../plugins/auth.js';

const VAT_CATEGORIES = ['STANDARD', 'REDUCED', 'SUPER_REDUCED', 'ZERO', 'EXEMPT'] as const;

/**
 * A new rate period.
 *
 * `ratePercent` arrives as a string and stays one all the way to the Decimal
 * column. Parsing "19.5" through a JavaScript number on the way would be the
 * one place in this system where a tax rate goes through binary floating point.
 */
const rateSchema = z.object({
  countryCode: z.string().trim().length(2).toUpperCase(),
  category: z.enum(VAT_CATEGORIES),
  ratePercent: z
    .string()
    .trim()
    .regex(/^\d{1,3}(\.\d{1,6})?$/, 'Use a plain percentage, e.g. 19 or 19.5.'),
  label: z.string().trim().max(128).nullable().optional(),
  /** The date this rate starts applying. Defaults to today. */
  validFrom: z.string().date().optional(),
  validTo: z.string().date().nullable().optional(),
});

const listQuery = z.object({
  countryCode: z.string().trim().length(2).toUpperCase().optional(),
});

function actorFrom(request: FastifyRequest): {
  userId: string;
  email: string;
  correlationId: string;
} {
  const auth = currentUser(request);
  return { userId: auth.id, email: auth.email, correlationId: request.correlationId };
}

export function registerAdminVatRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Every rate, with the member states flagged.
   *
   * Returns the country list alongside, because "which countries am I treating
   * as EU VAT territory" and "what rates do they have" are the same question
   * to whoever is checking this screen, and two round trips to answer it
   * invites the two going out of sync on screen.
   */
  app.get(
    '/vat-rates',
    { preHandler: requireAdmin(Permission.SETTINGS_READ) },
    async (request, reply) => {
      const query = listQuery.parse(request.query);

      const [rates, countries, business] = await Promise.all([
        prisma.vatRate.findMany({
          where: query.countryCode === undefined ? {} : { countryCode: query.countryCode },
          orderBy: [{ countryCode: 'asc' }, { category: 'asc' }, { validFrom: 'desc' }],
        }),
        prisma.country.findMany({
          where: { isEuVat: true },
          select: { code: true, name: true },
          orderBy: { code: 'asc' },
        }),
        prisma.businessProfile.findFirst({ select: { vatCountry: true, vatNumber: true } }),
      ]);

      const now = Date.now();

      return reply.status(200).send({
        rates: rates.map((rate) => ({
          id: rate.id,
          countryCode: rate.countryCode,
          category: rate.category,
          ratePercent: rate.ratePercent.toString(),
          label: rate.label,
          validFrom: rate.validFrom.toISOString().slice(0, 10),
          validTo: rate.validTo?.toISOString().slice(0, 10) ?? null,
          // Which row a sale today would actually use. Computed here rather
          // than left to the panel: "why is this order at 19%" is answered by
          // exactly one of these rows, and the reader should not have to work
          // out which by comparing dates.
          inForce:
            rate.validFrom.getTime() <= now &&
            (rate.validTo === null || rate.validTo.getTime() >= now),
        })),
        euCountries: countries,
        seller: {
          vatCountry: business?.vatCountry ?? null,
          vatNumber: business?.vatNumber ?? null,
          // The flag that decides whether any of this runs at all.
          euVatActive: business?.vatCountry !== null && business?.vatCountry !== undefined,
        },
      });
    },
  );

  /**
   * Add a rate period.
   *
   * A rate for the same country, band and start date already existing is a
   * conflict rather than an overwrite: correcting a rate means a NEW period,
   * and silently replacing one would rewrite the rate that historic invoices
   * were raised at.
   */
  app.post(
    '/vat-rates',
    { preHandler: requireAdmin(Permission.SETTINGS_WRITE) },
    async (request, reply) => {
      const body = rateSchema.parse(request.body);
      const actor = actorFrom(request);

      const validFrom =
        body.validFrom === undefined
          ? new Date(new Date().toISOString().slice(0, 10))
          : new Date(body.validFrom);

      const validTo = body.validTo === undefined || body.validTo === null ? null : new Date(body.validTo);

      if (validTo !== null && validTo < validFrom) {
        throw badRequest(ErrorCode.VALIDATION_FAILED, 'A rate cannot end before it starts.', [
          { field: 'validTo', code: 'BEFORE_START' },
        ]);
      }

      const clash = await prisma.vatRate.findUnique({
        where: {
          countryCode_category_validFrom: {
            countryCode: body.countryCode,
            category: body.category,
            validFrom,
          },
        },
        select: { id: true },
      });

      if (clash !== null) {
        throw badRequest(
          ErrorCode.CONFLICT,
          'That country already has a rate for this band starting on that date. ' +
            'Correcting a rate means adding a period with a later start date.',
          [{ field: 'validFrom', code: 'PERIOD_EXISTS' }],
        );
      }

      const id = newId();

      await prisma.vatRate.create({
        data: {
          id,
          countryCode: body.countryCode,
          category: body.category,
          ratePercent: body.ratePercent,
          label: body.label ?? null,
          validFrom,
          validTo,
        },
      });

      await recordAudit({
        action: AuditAction.VAT_RATE_UPDATED,
        resourceType: 'vat_rate',
        resourceId: id,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        after: {
          countryCode: body.countryCode,
          category: body.category,
          ratePercent: body.ratePercent,
          validFrom: validFrom.toISOString().slice(0, 10),
        },
        correlationId: actor.correlationId,
      });

      return reply.status(201).send({ id });
    },
  );

  /**
   * Close a rate period.
   *
   * The only mutation a rate row allows, and only ever forward: setting the
   * date a rate stopped applying. The percentage itself is immutable, because
   * every invoice raised while it was in force states it.
   */
  app.patch(
    '/vat-rates/:id',
    { preHandler: requireAdmin(Permission.SETTINGS_WRITE) },
    async (request, reply) => {
      const { id: rateId } = z.object({ id: z.string().length(26) }).parse(request.params);
      const body = z.object({ validTo: z.string().date().nullable() }).parse(request.body);
      const actor = actorFrom(request);

      const rate = await prisma.vatRate.findUnique({ where: { id: rateId } });
      if (rate === null) throw notFound('VAT rate');

      const validTo = body.validTo === null ? null : new Date(body.validTo);

      if (validTo !== null && validTo < rate.validFrom) {
        throw badRequest(ErrorCode.VALIDATION_FAILED, 'A rate cannot end before it starts.', [
          { field: 'validTo', code: 'BEFORE_START' },
        ]);
      }

      await prisma.vatRate.update({ where: { id: rateId }, data: { validTo } });

      await recordAudit({
        action: AuditAction.VAT_RATE_UPDATED,
        resourceType: 'vat_rate',
        resourceId: rateId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { validTo: rate.validTo?.toISOString().slice(0, 10) ?? null },
        after: { validTo: body.validTo },
        correlationId: actor.correlationId,
      });

      return reply.status(200).send({ updated: true });
    },
  );

  /**
   * Ask VIES about this customer's VAT number, now.
   *
   * `force` skips the cache, because the entire point of pressing the button is
   * to find out what the register says today rather than what it said last
   * week. Rate-limited: each call reaches a member state's own system, and the
   * Commission's guidance discourages repeated identical enquiries.
   */
  app.post(
    '/customers/:id/vat-number/check',
    {
      preHandler: requireAdmin(Permission.CUSTOMER_WRITE),
      config: { rateLimit: { max: 20, timeWindow: '5 minutes' } },
    },
    async (request, reply) => {
      const { id: customerId } = z.object({ id: z.string().length(26) }).parse(request.params);
      const actor = actorFrom(request);

      const result = await refreshCustomerVatNumber(customerId, { force: true });

      if (result === null) {
        throw badRequest(
          ErrorCode.VALIDATION_FAILED,
          'This customer has no VAT number on file.',
          [{ field: 'vatNumber', code: 'MISSING' }],
        );
      }

      await recordAudit({
        action: AuditAction.VAT_NUMBER_CHECKED,
        resourceType: 'customer_profile',
        resourceId: customerId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        after: {
          countryCode: result.countryCode,
          isValid: result.isValid,
          // The Art. 31 Reg. 904/2010 reference, on the record: it is the
          // seller's evidence that they relied on an official answer.
          consultationNumber: result.consultationNumber,
          unavailableReason: result.unavailableReason,
        },
        correlationId: actor.correlationId,
      });

      return reply.status(200).send({
        countryCode: result.countryCode,
        number: result.number,
        isValid: result.isValid,
        registeredName: result.registeredName,
        registeredAddress: result.registeredAddress,
        consultationNumber: result.consultationNumber,
        unavailableReason: result.unavailableReason,
        checkedAt: result.checkedAt.toISOString(),
      });
    },
  );

  /** The invoice for an order, or null when none has been raised. */
  app.get(
    '/orders/:id/invoice',
    { preHandler: requireAdmin(Permission.INVOICE_READ) },
    async (request, reply) => {
      const { id: orderId } = z.object({ id: z.string().length(26) }).parse(request.params);
      const invoice = await getInvoiceForOrder(orderId);
      return reply.status(200).send({ invoice });
    },
  );

  /** Raise it. Idempotent by order - see `issueInvoice`. */
  app.post(
    '/orders/:id/invoice',
    { preHandler: requireAdmin(Permission.INVOICE_ISSUE) },
    async (request, reply) => {
      const { id: orderId } = z.object({ id: z.string().length(26) }).parse(request.params);
      const actor = actorFrom(request);

      const issued = await issueInvoice({
        orderId,
        actorUserId: actor.userId,
        actorEmail: actor.email,
        correlationId: actor.correlationId,
      });

      return reply.status(201).send(issued);
    },
  );

  app.get(
    '/invoices/:id',
    { preHandler: requireAdmin(Permission.INVOICE_READ) },
    async (request, reply) => {
      const { id: invoiceId } = z.object({ id: z.string().length(26) }).parse(request.params);
      const invoice = await getInvoice(invoiceId);
      return reply.status(200).send(invoice);
    },
  );

  /**
   * The invoice as EN 16931 UBL (Peppol BIS Billing 3.0).
   *
   * The bytes an access point expects to be handed. Downloading it by hand is
   * the manual path a deployment uses before it has an AP contract, and the
   * same function is what an AP integration would call.
   */
  app.get(
    '/invoices/:id/ubl',
    { preHandler: requireAdmin(Permission.INVOICE_READ) },
    async (request, reply) => {
      const { id: invoiceId } = z.object({ id: z.string().length(26) }).parse(request.params);
      const rendered = await renderInvoiceUbl(invoiceId);

      return reply
        .header('Content-Type', 'application/xml; charset=utf-8')
        // `attachment`: this is a document to be filed or forwarded, not one
        // to be rendered in the panel's own origin.
        .header('Content-Disposition', `attachment; filename="${rendered.fileName}"`)
        .header('X-Content-Type-Options', 'nosniff')
        .status(200)
        .send(rendered.xml);
    },
  );

  /**
   * What a receiver's validator would object to.
   *
   * Run before sending rather than after being rejected. Every issue it
   * reports is a missing value somebody can go and fill in.
   */
  app.get(
    '/invoices/:id/en16931-check',
    { preHandler: requireAdmin(Permission.INVOICE_READ) },
    async (request, reply) => {
      const { id: invoiceId } = z.object({ id: z.string().length(26) }).parse(request.params);
      const issues = await validateInvoiceForEn16931(invoiceId);

      return reply.status(200).send({ ok: issues.length === 0, issues });
    },
  );

  /**
   * Reverse an invoice with a credit note.
   *
   * The only correction available. There is no DELETE on this resource and
   * there will not be one.
   */
  app.post(
    '/invoices/:id/credit',
    { preHandler: requireAdmin(Permission.INVOICE_ISSUE) },
    async (request, reply) => {
      const { id: invoiceId } = z.object({ id: z.string().length(26) }).parse(request.params);
      const actor = actorFrom(request);

      const credit = await creditInvoice({
        invoiceId,
        actorUserId: actor.userId,
        actorEmail: actor.email,
        correlationId: actor.correlationId,
      });

      return reply.status(201).send(credit);
    },
  );

  return Promise.resolve();
}

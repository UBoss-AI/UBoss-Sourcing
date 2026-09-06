/**
 * Issuing an invoice.
 *
 * An invoice is not a rendering of an order. Article 226 of Directive
 * 2006/112/EC lists what one must contain, member-state law requires it be
 * kept for six to ten years, and — the part that decides this file's shape —
 * it must not change afterwards. Not when the customer moves. Not when a VAT
 * rate is corrected. Not when somebody fixes a typo in a product name.
 *
 * A view over live tables cannot promise that, so everything the document says
 * is copied into the row at the moment of issue and nothing here has an update
 * path. The only way to change an issued invoice is to issue a credit note
 * against it, which is what `creditInvoice` does.
 *
 * Two details that look like over-engineering and are not:
 *
 *   - **The number comes from a locked counter, not a count.** Art. 226(2)
 *     wants a sequential number that uniquely identifies the invoice, and tax
 *     authorities read gaps as deleted invoices. `SELECT COUNT(*) + 1` under
 *     concurrency issues the same number twice; `UPDATE ... value = value + 1`
 *     takes an InnoDB row lock and cannot.
 *
 *   - **The VAT breakdown is per rate, not a single total.** An invoice with a
 *     standard-rated box of gloves and a reduced-rated dressing has to show
 *     the taxable amount and the tax for each band separately — Art. 226(8) to
 *     (10). One combined "VAT: €31.40" is not a valid invoice, however correct
 *     the arithmetic.
 */
import { ErrorCode, conflict, notFound } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';

/**
 * Order statuses an invoice may be raised against.
 *
 * A draft or an order awaiting approval has not been supplied and has nothing
 * to invoice. A cancelled one had its supply undone; if it was already
 * invoiced, the answer is a credit note, not a second invoice.
 */
const INVOICEABLE = Object.freeze([
  'PENDING_PAYMENT',
  'CONFIRMED',
  'PROCESSING',
  'SHIPPED',
  'DELIVERED',
  'RETURNED',
  'REFUNDED',
] as const);

export interface InvoiceLineView {
  description: string;
  sku: string;
  quantity: number;
  unitPriceMinor: string;
  discountMinor: string;
  netMinor: string;
  vatRatePercent: string;
  vatAmountMinor: string;
  grossMinor: string;
}

export interface VatBreakdownRow {
  ratePercent: string;
  taxableMinor: string;
  vatMinor: string;
}

/**
 * Allocate the next invoice number.
 *
 * `INV-2026-000123`. The series restarts each calendar year, which is what
 * most member states' bookkeeping rules expect, and the year is part of the
 * counter key so that restart needs no separate reset job.
 *
 * Gaps are tolerable in an order sequence and are not here: an accountant
 * reading a missing invoice number will ask what was deleted. So the number is
 * allocated inside the same transaction that writes the row, and a rolled-back
 * issue takes its number back with it.
 */
async function nextInvoiceNumber(tx: PrismaTransaction, series: string): Promise<string> {
  const year = new Date().getUTCFullYear();
  const key = `invoice:${series}:${String(year)}`;

  await tx.numberSequence.upsert({
    where: { key },
    update: { value: { increment: 1 } },
    create: { key, value: 1, prefix: series, padding: 6 },
  });

  const sequence = await tx.numberSequence.findUniqueOrThrow({ where: { key } });
  const padded = sequence.value.toString().padStart(sequence.padding, '0');

  return `${series}-${String(year)}-${padded}`;
}

/**
 * Group the lines by rate.
 *
 * Art. 226(8)-(10). Keyed on the rate as written rather than as a number, so
 * "21" and "21.000000" cannot become two rows on the same invoice; the rate
 * strings all originate from the same `Decimal.toString()`, so this is a
 * normalisation, not a coincidence.
 */
function summariseVat(lines: InvoiceLineView[]): VatBreakdownRow[] {
  const byRate = new Map<string, { taxable: bigint; vat: bigint }>();

  for (const line of lines) {
    const key = line.vatRatePercent;
    const running = byRate.get(key) ?? { taxable: 0n, vat: 0n };

    running.taxable += BigInt(line.netMinor);
    running.vat += BigInt(line.vatAmountMinor);

    byRate.set(key, running);
  }

  return [...byRate.entries()]
    // Highest rate first, which is how a printed invoice reads.
    .sort((a, b) => Number(b[0]) - Number(a[0]))
    .map(([ratePercent, sums]) => ({
      ratePercent,
      taxableMinor: sums.taxable.toString(),
      vatMinor: sums.vat.toString(),
    }));
}

export interface IssueInvoiceInput {
  orderId: string;
  actorUserId?: string | null;
  actorEmail?: string | null;
  correlationId?: string | null;
}

export interface IssuedInvoice {
  id: string;
  number: string;
  issuedAt: string;
}

/**
 * Issue the invoice for an order.
 *
 * Idempotent by order: an order already invoiced returns the invoice it has.
 * That is not a convenience — it is what stops a retried job, a double-clicked
 * button or a redelivered webhook from putting two documents with two numbers
 * against one supply, which is a real problem to unpick once both are in a VAT
 * return.
 */
export async function issueInvoice(input: IssueInvoiceInput): Promise<IssuedInvoice> {
  // "Already invoiced" means a live invoice, not a credit note against the
  // same order - which is why this is a findFirst with a condition rather than
  // the unique lookup on orderId it used to be.
  const existing = await prisma.invoice.findFirst({
    where: { orderId: input.orderId, creditsInvoiceId: null },
    select: { id: true, number: true, issuedAt: true },
  });

  if (existing !== null) {
    logger.info({ orderId: input.orderId, number: existing.number }, 'invoice already issued');
    return {
      id: existing.id,
      number: existing.number,
      issuedAt: existing.issuedAt.toISOString(),
    };
  }

  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    include: {
      items: { orderBy: { createdAt: 'asc' } },
      customerProfile: {
        select: {
          fullName: true,
          organization: true,
          customerCode: true,
          vatNumber: true,
          user: { select: { email: true } },
        },
      },
    },
  });

  if (order === null) throw notFound('Order');

  if (!INVOICEABLE.includes(order.status as (typeof INVOICEABLE)[number])) {
    throw conflict(
      ErrorCode.ORDER_TRANSITION_NOT_ALLOWED,
      `An order that is ${order.status.toLowerCase()} has not been supplied and cannot be invoiced.`,
    );
  }

  const business = await prisma.businessProfile.findFirst({
    select: {
      legalName: true,
      displayName: true,
      supportEmail: true,
      supportPhone: true,
      addressJson: true,
      gstin: true,
      vatNumber: true,
      vatCountry: true,
      invoicePrefix: true,
    },
  });

  // Art. 226(6)-(10), per line.
  const lines: InvoiceLineView[] = order.items.map((item) => {
    const net = item.lineSubtotalMinor - item.discountMinor;

    return {
      description:
        item.variantNameSnapshot === null
          ? item.nameSnapshot
          : `${item.nameSnapshot} — ${item.variantNameSnapshot}`,
      sku: item.skuSnapshot,
      quantity: item.quantity,
      unitPriceMinor: item.unitPriceMinor.toString(),
      discountMinor: item.discountMinor.toString(),
      // The taxable amount, which is the discounted figure. Invoicing the
      // pre-discount value would state a taxable base the customer never paid.
      netMinor: net.toString(),
      vatRatePercent: item.taxRatePercent.toString(),
      vatAmountMinor: item.taxAmountMinor.toString(),
      grossMinor: item.lineTotalMinor.toString(),
    };
  });

  const seller = {
    legalName: business?.legalName ?? business?.displayName ?? 'Unknown',
    address: business?.addressJson ?? null,
    email: business?.supportEmail ?? null,
    phone: business?.supportPhone ?? null,
    // Both registrations travel: a business may hold an EU VAT number and an
    // Indian GSTIN, and which one belongs on the document depends on the sale.
    vatNumber: business?.vatNumber ?? null,
    taxRegistration: business?.gstin ?? null,
    country: business?.vatCountry ?? null,
  };

  const buyer = {
    name: order.customerProfile.fullName,
    organization: order.customerProfile.organization,
    customerCode: order.customerProfile.customerCode,
    email: order.customerProfile.user.email,
    // Art. 226(5): the address on the invoice is the one the goods were billed
    // to at the time, not whatever the customer record says today.
    billingAddress: order.billingAddressJson,
    deliveryAddress: order.shippingAddressJson,
    vatNumber: order.buyerVatNumberSnapshot ?? order.customerProfile.vatNumber,
  };

  const series = business?.invoicePrefix ?? 'INV';
  const exemptionNote = exemptionNoteFor(order.taxTreatment);

  const invoice = await prisma.$transaction(async (tx) => {
    const number = await nextInvoiceNumber(tx, series);
    const id = newId();

    const row = await tx.invoice.create({
      data: {
        id,
        number,
        series,
        orderId: order.id,
        // Art. 226(7): the date of supply, which is not always the date of
        // issue and can fall in a different VAT period. The order was placed
        // when it was placed; the invoice is raised now.
        suppliedAt: order.placedAt ?? order.createdAt,
        sellerJson: seller as never,
        buyerJson: buyer as never,
        sellerVatNumber: order.sellerVatNumberSnapshot ?? seller.vatNumber,
        buyerVatNumber: buyer.vatNumber,
        taxTreatment: order.taxTreatment,
        taxCountry: order.taxCountry,
        exemptionNote,
        currency: order.currency,
        linesJson: lines as never,
        vatBreakdownJson: summariseVat(lines) as never,
        subtotalMinor: order.subtotalMinor,
        discountMinor: order.discountMinor,
        taxMinor: order.taxMinor,
        shippingMinor: order.shippingMinor,
        grandTotalMinor: order.grandTotalMinor,
      },
      select: { id: true, number: true, issuedAt: true },
    });

    await recordAudit(
      {
        action: AuditAction.INVOICE_ISSUED,
        resourceType: 'invoice',
        resourceId: id,
        actorType: input.actorUserId === null || input.actorUserId === undefined ? 'SYSTEM' : 'ADMIN',
        actorUserId: input.actorUserId ?? null,
        actorEmail: input.actorEmail ?? null,
        after: {
          number,
          orderNumber: order.orderNumber,
          taxTreatment: order.taxTreatment,
          grandTotalMinor: order.grandTotalMinor,
        },
        correlationId: input.correlationId ?? null,
      },
      tx,
    );

    return row;
  });

  logger.info(
    { invoiceId: invoice.id, number: invoice.number, orderId: order.id },
    'invoice issued',
  );

  return {
    id: invoice.id,
    number: invoice.number,
    issuedAt: invoice.issuedAt.toISOString(),
  };
}

/**
 * The Art. 226(11) wording for a treatment.
 *
 * Duplicated from `tax/vat.service.ts` deliberately rather than imported: what
 * an invoice says has to be frozen at issue, and a shared constant is exactly
 * the thing that would silently rewrite the note on every historic document
 * the next time somebody improves the wording. The copy here is written once
 * onto the row and never read again.
 */
function exemptionNoteFor(treatment: string): string | null {
  switch (treatment) {
    case 'INTRA_EU_REVERSE_CHARGE':
      return (
        'Reverse charge. Intra-Community supply exempt under Article 138 of Council Directive ' +
        '2006/112/EC. VAT is to be accounted for by the recipient under Article 196.'
      );
    case 'EXPORT':
      return 'Zero-rated export of goods under Article 146 of Council Directive 2006/112/EC.';
    default:
      return null;
  }
}

/**
 * Cancel an issued invoice with a credit note.
 *
 * The only correction an invoice sequence permits. Deleting the row would
 * leave a gap that a tax inspector reads as a destroyed document, and editing
 * it would mean the copy the customer holds and the copy in the database say
 * different things. So the original stands, and a second document of equal and
 * opposite value is issued against it.
 */
export async function creditInvoice(input: {
  invoiceId: string;
  actorUserId: string;
  actorEmail: string;
  correlationId?: string | null;
}): Promise<IssuedInvoice> {
  const original = await prisma.invoice.findUnique({ where: { id: input.invoiceId } });
  if (original === null) throw notFound('Invoice');

  const alreadyCredited = await prisma.invoice.findFirst({
    where: { creditsInvoiceId: original.id },
    select: { id: true, number: true, issuedAt: true },
  });

  if (alreadyCredited !== null) {
    return {
      id: alreadyCredited.id,
      number: alreadyCredited.number,
      issuedAt: alreadyCredited.issuedAt.toISOString(),
    };
  }

  const negated = (value: bigint): bigint => -value;

  const lines = (original.linesJson as unknown as InvoiceLineView[]).map((line) => ({
    ...line,
    unitPriceMinor: negated(BigInt(line.unitPriceMinor)).toString(),
    discountMinor: negated(BigInt(line.discountMinor)).toString(),
    netMinor: negated(BigInt(line.netMinor)).toString(),
    vatAmountMinor: negated(BigInt(line.vatAmountMinor)).toString(),
    grossMinor: negated(BigInt(line.grossMinor)).toString(),
  }));

  const credit = await prisma.$transaction(async (tx) => {
    // A credit note belongs to the same series as the invoice it cancels, so
    // the two sit together in the sequence an accountant reads.
    const number = await nextInvoiceNumber(tx, original.series);
    const id = newId();

    const row = await tx.invoice.create({
      data: {
        id,
        number,
        series: original.series,
        // The same supply as the invoice it cancels, so it hangs off the same
        // order. `creditsInvoiceId` is what tells the two apart.
        orderId: original.orderId,
        suppliedAt: original.suppliedAt,
        sellerJson: original.sellerJson as never,
        buyerJson: original.buyerJson as never,
        sellerVatNumber: original.sellerVatNumber,
        buyerVatNumber: original.buyerVatNumber,
        taxTreatment: original.taxTreatment,
        taxCountry: original.taxCountry,
        exemptionNote: original.exemptionNote,
        currency: original.currency,
        linesJson: lines as never,
        vatBreakdownJson: summariseVat(lines) as never,
        subtotalMinor: negated(original.subtotalMinor),
        discountMinor: negated(original.discountMinor),
        taxMinor: negated(original.taxMinor),
        shippingMinor: negated(original.shippingMinor),
        grandTotalMinor: negated(original.grandTotalMinor),
        creditsInvoiceId: original.id,
      },
      select: { id: true, number: true, issuedAt: true },
    });

    await recordAudit(
      {
        action: AuditAction.INVOICE_CREDITED,
        resourceType: 'invoice',
        resourceId: id,
        actorType: 'ADMIN',
        actorUserId: input.actorUserId,
        actorEmail: input.actorEmail,
        before: { number: original.number },
        after: { number, credits: original.number },
        correlationId: input.correlationId ?? null,
      },
      tx,
    );

    return row;
  });

  return {
    id: credit.id,
    number: credit.number,
    issuedAt: credit.issuedAt.toISOString(),
  };
}

/** One invoice, as the console and the customer's own copy render it. */
export async function getInvoice(invoiceId: string): Promise<Record<string, unknown>> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { order: { select: { orderNumber: true, customerProfileId: true } } },
  });

  if (invoice === null) throw notFound('Invoice');

  return {
    id: invoice.id,
    number: invoice.number,
    series: invoice.series,
    orderId: invoice.orderId,
    orderNumber: invoice.order.orderNumber,
    customerProfileId: invoice.order.customerProfileId,
    issuedAt: invoice.issuedAt.toISOString(),
    suppliedAt: invoice.suppliedAt.toISOString(),
    seller: invoice.sellerJson,
    buyer: invoice.buyerJson,
    sellerVatNumber: invoice.sellerVatNumber,
    buyerVatNumber: invoice.buyerVatNumber,
    taxTreatment: invoice.taxTreatment,
    taxCountry: invoice.taxCountry,
    exemptionNote: invoice.exemptionNote,
    currency: invoice.currency,
    lines: invoice.linesJson,
    vatBreakdown: invoice.vatBreakdownJson,
    totals: {
      subtotalMinor: invoice.subtotalMinor.toString(),
      discountMinor: invoice.discountMinor.toString(),
      taxMinor: invoice.taxMinor.toString(),
      shippingMinor: invoice.shippingMinor.toString(),
      grandTotalMinor: invoice.grandTotalMinor.toString(),
    },
    creditsInvoiceId: invoice.creditsInvoiceId,
    isCreditNote: invoice.creditsInvoiceId !== null,
  };
}

/** The invoice for an order, or null when none has been issued. */
export async function getInvoiceForOrder(orderId: string): Promise<Record<string, unknown> | null> {
  const invoice = await prisma.invoice.findFirst({
    where: { orderId, creditsInvoiceId: null },
    select: { id: true },
  });

  return invoice === null ? null : getInvoice(invoice.id);
}

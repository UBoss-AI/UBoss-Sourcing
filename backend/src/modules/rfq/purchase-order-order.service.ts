/**
 * An approved RFQ purchase order becomes a marketplace order (LIVE-004).
 *
 * The purchase order is the contract: the item, the quantity, the agreed unit
 * price, the tooling charge, the supplier's shipping estimate, the Incoterm
 * and the inspection terms, sealed by `contractHash`. Converting it does not
 * renegotiate anything. It makes an ordinary order the rest of the system
 * already knows how to take payment for, split to the seller, inspect, ship
 * and settle - so an RFQ-made order goes through the same gates as any other.
 *
 * WHY A PRIVATE PRODUCT AND OFFER
 *
 * Every order line names a catalogue product (`order_items.productId` is
 * required) and the seller split, the inspection rules, the platform fee and
 * the documents all read the product's category and the line's seller offer.
 * An RFQ is filed against a category, not a product. So conversion makes one
 * product and one seller offer for this purchase order alone - in the RFQ's
 * category, for the awarded seller, never published, never orderable, archived
 * from the day it is made - and the order lines point at those. Nothing
 * downstream needs a special case to find the seller, the category or the
 * price, and nothing can buy the private product from the catalogue.
 *
 * THE RULES
 *
 *   - Only an APPROVED purchase order converts, and only by a buyer who can
 *     see it and may purchase for that context. A seller, or another buyer,
 *     gets the same 404 as a purchase order that does not exist.
 *   - One purchase order, one live order. `rfq_purchase_orders.orderId` is
 *     linked conditionally inside the transaction that creates the order, so a
 *     double press or two tabs both end on the same order. A CANCELLED order
 *     that was never paid may be replaced by a new one; a paid one never is.
 *   - The quantity must be a whole number of units (`domain/rfq-po-order.ts`).
 *   - The quoted price is exclusive of tax. Tax is worked out for the delivery
 *     country by the ordinary engine; tooling is its own taxed line; the
 *     supplier's shipping estimate is the order's shipping charge.
 *   - The order is paid in full through the ordinary payment screen. The free
 *     text payment terms on the quote ("30% advance") are recorded on the
 *     order, and the payment is held until the goods are inspected and
 *     delivered, as every marketplace payment is. Staged or deferred payment
 *     is arranged by the operator with a payment link.
 *   - The order is confirmed only by a signature-verified payment webhook,
 *     like any order. `onRfqOrderConfirmed` is how the purchase order hears.
 */
import { ErrorCode, conflict, notFound } from '../../domain/errors.js';
import { serialiseMoney } from '../../domain/money.js';
import { priceLines, type PricingLineInput } from '../../domain/pricing.js';
import { wholeOrderQuantity } from '../../domain/rfq-po-order.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { nextOrderNumber } from '../orders/order.service.js';
import { captureOrderItemSnapshots } from '../orders/order-item-snapshot.service.js';
import { notifySeller } from '../seller/notification.service.js';
import { applyLineTax, loadTaxContext } from '../tax/vat.service.js';
import type { RfqBuyer } from './access.js';
import type { PurchaseOrderActor } from './purchase-order.service.js';
import { tellBuyer } from './quote.service.js';
import { loadRfqForBuyer, recordEvent } from './rfq.service.js';

/** The parts of the sealed contract conversion reads. */
interface ContractFacts {
  rfq: { reference: string };
  quote: { acceptedTermsHash: string };
  supplier: { sellerAccountId: string; name: string };
  item: { buyerSku: string | null; title: string; quantity: string; unitOfMeasure: string | null };
  delivery: {
    destinationCountry: string | null;
    destinationAddress: string | null;
    destinationPort: string | null;
    incoterm: string | null;
    incotermPlace: string | null;
  };
  commercial: {
    currency: string;
    applicableUnitPriceMinor: string;
    paymentTerms: string | null;
    goodsTotalMinor: string;
    toolingMinor: string;
    shippingMinor: string;
  };
  quality: {
    inspectionRequirement: string;
    inspectionTerms: string | null;
    exportDocuments?: string[];
  };
}

export interface ConvertedOrder {
  order: { id: string; orderNumber: string; status: string };
  created: boolean;
}

/** Order statuses that mean the purchase order's order is still the live one. */
function stillLive(order: { status: string; confirmedAt: Date | null }): boolean {
  return order.status !== 'CANCELLED' || order.confirmedAt !== null;
}

function notConvertible(code: string, message: string): never {
  throw conflict(ErrorCode.RFQ_PURCHASE_ORDER_NOT_CONVERTIBLE, message, [{ code }]);
}

/** Thrown inside the transaction when another request linked an order first. */
class LostRaceSignal extends Error {}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
}

async function existingOrder(orderId: string | null) {
  if (orderId === null) return null;
  return prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, orderNumber: true, status: true, confirmedAt: true },
  });
}

/**
 * Turn the buyer's approved purchase order into an order awaiting payment, or
 * return the one already made from it.
 */
export async function convertPurchaseOrderToOrder(
  buyer: RfqBuyer,
  rfqId: string,
  actor: PurchaseOrderActor,
): Promise<ConvertedOrder> {
  const rfq = await loadRfqForBuyer(buyer, rfqId);
  // Committing a company to an order needs the company to be approved, as
  // every other purchase does.
  if (buyer.context.kind === 'COMPANY' && buyer.context.companyStatus !== 'APPROVED') {
    throw notFound('Purchase order');
  }
  const po = await prisma.rfqPurchaseOrder.findUnique({ where: { rfqId: rfq.id } });
  if (po === null) throw notFound('Purchase order');

  const current = await existingOrder(po.orderId);
  if (current !== null && stillLive(current)) {
    return { order: { id: current.id, orderNumber: current.orderNumber, status: current.status }, created: false };
  }

  if (po.status !== 'APPROVED') {
    notConvertible('NOT_APPROVED', 'This purchase order is not approved yet, so it cannot become an order.');
  }

  // The contract is the authority. Its sealed totals and the columns beside
  // it must agree before anybody is billed from it; the price check below
  // then proves the order charges exactly what was signed for.
  const contract = po.contractJson as unknown as ContractFacts;
  if (
    contract.quote.acceptedTermsHash !== po.acceptedTermsHash ||
    contract.commercial.goodsTotalMinor !== po.goodsTotalMinor.toString() ||
    contract.commercial.toolingMinor !== po.toolingMinor.toString() ||
    contract.commercial.shippingMinor !== po.shippingMinor.toString() ||
    contract.commercial.currency !== po.currency
  ) {
    logger.error({ purchaseOrderId: po.id }, 'an RFQ purchase order disagrees with its own contract');
    notConvertible('CONTRACT_MISMATCH', 'This purchase order cannot be verified. Contact the marketplace team.');
  }
  if (rfq.categoryId === null) {
    notConvertible('CONTRACT_MISMATCH', 'This request has no category, so it cannot become an order.');
  }

  const quantity = wholeOrderQuantity(contract.item.quantity);
  if (!quantity.ok) {
    notConvertible(
      quantity.code,
      quantity.code === 'FRACTIONAL_QUANTITY'
        ? 'The ordered quantity is not a whole number of units, so it cannot go on an order line. Ask the supplier to quote a whole number.'
        : 'The ordered quantity is too large for one order line.',
    );
  }

  const seller = await prisma.sellerAccount.findUnique({
    where: { id: po.sellerAccountId },
    select: { id: true, status: true, displayName: true },
  });
  if (seller?.status !== 'APPROVED') {
    notConvertible('SELLER_UNAVAILABLE', 'The supplier on this purchase order cannot take orders at the moment.');
  }

  const [profile, taxClass] = await Promise.all([
    prisma.customerProfile.findUniqueOrThrow({
      where: { id: buyer.customerProfileId },
      select: { fullName: true, phone: true, vatNumber: true, vatNumberValid: true, requiresOrderApproval: true },
    }),
    prisma.taxClass.findFirst({ where: { isDefault: true, isActive: true } }),
  ]);
  if (taxClass === null) {
    notConvertible('TAX_UNAVAILABLE', 'No default tax class is set up, so this order cannot be priced.');
  }

  const taxSetup = await loadTaxContext({
    destinationCountry: contract.delivery.destinationCountry,
    vatNumber: profile.vatNumber,
    vatNumberValid: profile.vatNumberValid ?? false,
  });
  const unitPrice = BigInt(contract.commercial.applicableUnitPriceMinor);
  const tooling = po.toolingMinor;
  const priceFor = (amount: bigint, name: string) => {
    // The quoted price is the seller's price before tax, so it goes in
    // exclusive; the destination's tax is added on top by the one engine.
    const tax = applyLineTax(
      taxSetup,
      {
        vatCategory: taxClass.vatCategory,
        flatRatePercent: taxClass.ratePercent.toString(),
        taxInclusive: false,
        productName: name,
      },
      amount,
    );
    if (tax.problem !== null) notConvertible('TAX_UNAVAILABLE', `Tax for this delivery cannot be worked out: ${tax.problem}`);
    return tax;
  };

  const productId = newId();
  const title = contract.item.title.slice(0, 255);
  const goodsTax = priceFor(unitPrice, title);
  const pricingProduct = (id: string, name: string, sku: string, tax: typeof goodsTax): PricingLineInput['product'] => ({
    productId: id,
    variantId: null,
    name,
    sku,
    variantName: null,
    unitPriceMinor: tax.unitPriceMinor,
    taxClassCode: taxClass.code,
    taxRatePercent: tax.taxRatePercent,
    taxInclusive: tax.taxInclusive,
    isRecurringEligible: false,
    imageUrl: null,
  });
  const inputs: PricingLineInput[] = [
    { product: pricingProduct(productId, title, po.reference, goodsTax), quantity: quantity.units },
  ];
  if (tooling > 0n) {
    const toolingName = `Tooling - ${title}`.slice(0, 255);
    inputs.push({
      product: pricingProduct(productId, toolingName, `${po.reference}-TOOLING`, priceFor(tooling, toolingName)),
      quantity: 1,
    });
  }
  // The supplier's shipping estimate goes in as seller delivery - the path
  // every seller's delivery charge takes at checkout.
  const pricing = priceLines(inputs, { sellerDeliveryMinor: po.shippingMinor });

  // The order must charge exactly what was signed for, before tax.
  if (pricing.lines[0]?.lineSubtotalMinor !== po.goodsTotalMinor || pricing.totals.shippingMinor !== po.shippingMinor) {
    logger.error(
      { purchaseOrderId: po.id, priced: pricing.lines[0]?.lineSubtotalMinor, sealed: po.goodsTotalMinor },
      'an RFQ purchase order priced differently from its sealed totals',
    );
    notConvertible('CONTRACT_MISMATCH', 'This purchase order cannot be priced as it was signed. Contact the marketplace team.');
  }

  const address = {
    contactName: profile.fullName,
    contactPhone: profile.phone ?? '',
    line1: (contract.delivery.destinationAddress ?? contract.delivery.destinationPort ?? '').slice(0, 500),
    line2: contract.delivery.destinationPort,
    city: '',
    state: '',
    postalCode: '',
    country: contract.delivery.destinationCountry ?? '',
  };
  const initialStatus = profile.requiresOrderApproval ? 'PENDING_APPROVAL' : 'PENDING_PAYMENT';
  const now = new Date();
  const orderId = newId();
  const slug = `rfq-po-${po.id.toLowerCase()}`;
  const unitLabel = contract.item.unitOfMeasure === null ? 'units' : contract.item.unitOfMeasure;
  const lineNote = [
    `Purchase order ${po.reference}: ${contract.item.quantity} ${unitLabel}.`,
    contract.item.buyerSku === null ? null : `Buyer SKU ${contract.item.buyerSku}.`,
    contract.delivery.incoterm === null
      ? null
      : `Incoterm ${contract.delivery.incoterm}${contract.delivery.incotermPlace === null ? '' : ` ${contract.delivery.incotermPlace}`}.`,
  ]
    .filter((part): part is string => part !== null)
    .join(' ')
    .slice(0, 500);
  const customerNote = [
    `Purchase order ${po.reference} · RFQ ${rfq.reference}`,
    contract.commercial.paymentTerms === null ? null : `Payment terms agreed: ${contract.commercial.paymentTerms}`,
  ]
    .filter((part): part is string => part !== null)
    .join('\n');

  let orderNumber: string;
  try {
    orderNumber = await prisma.$transaction(async (tx) => {
      // One private product and offer per purchase order, made once and reused
      // if a cancelled unpaid order is ever replaced.
      const product =
        (await tx.product.findUnique({ where: { slug }, select: { id: true } })) ??
        (await tx.product.create({
          data: {
            id: productId,
            categoryId: rfq.categoryId ?? '',
            taxClassId: taxClass.id,
            name: title,
            slug,
            sku: po.reference,
            shortDescription: `Made for purchase order ${po.reference} only. Not for sale in the catalogue.`,
            basePriceMinor: unitPrice,
            currency: po.currency,
            status: 'INACTIVE',
            isPublished: false,
            isOrderable: false,
            unavailabilityReason: `Made for purchase order ${po.reference}.`,
            isStockTracked: false,
            isMarketplaceProduct: true,
            createdBySellerAccountId: po.sellerAccountId,
            archivedAt: now,
            createdById: actor.userId,
          },
          select: { id: true },
        }));
      const offer =
        (await tx.sellerOffer.findFirst({
          where: { productId: product.id, sellerAccountId: po.sellerAccountId },
          select: { id: true },
        })) ??
        (await tx.sellerOffer.create({
          data: {
            id: newId(),
            sellerAccountId: po.sellerAccountId,
            productId: product.id,
            variantKey: '',
            sellerSku: po.reference,
            status: 'ARCHIVED',
            statusReason: `Made for purchase order ${po.reference}; never offered in the catalogue.`,
            priceMinor: unitPrice,
            currency: po.currency,
            orderingUnit: 'PIECE',
            availableQuantity: 0,
            archivedAt: now,
          },
          select: { id: true },
        }));

      const number = await nextOrderNumber(tx);
      await tx.order.create({
        data: {
          id: orderId,
          orderNumber: number,
          customerProfileId: buyer.customerProfileId,
          buyerCompanyId: rfq.buyerCompanyId,
          buyerContextKind: rfq.buyerCompanyId === null ? 'INDIVIDUAL' : 'COMPANY',
          source: 'RFQ_PURCHASE_ORDER',
          status: initialStatus,
          currency: po.currency,
          subtotalMinor: pricing.totals.subtotalMinor,
          discountMinor: pricing.totals.discountMinor,
          taxMinor: pricing.totals.taxMinor,
          shippingMinor: pricing.totals.shippingMinor,
          grandTotalMinor: pricing.totals.grandTotalMinor,
          billingAddressJson: address,
          shippingAddressJson: address,
          paymentMode: 'ONLINE',
          customerNote,
          placedAt: now,
          taxTreatment: taxSetup.context.treatment,
          taxCountry: taxSetup.context.rateCountry,
          sellerVatNumberSnapshot: taxSetup.context.sellerVatNumber,
          buyerVatNumberSnapshot: taxSetup.context.buyerVatNumber,
          // The supplier stated this price in this currency; nothing was converted.
          fxPriceSource: 'MANUAL',
        },
      });

      for (const [index, line] of pricing.lines.entries()) {
        await tx.orderItem.create({
          data: {
            id: newId(),
            orderId,
            productId: product.id,
            variantId: null,
            sellerOfferId: offer.id,
            noteSnapshot: index === 0 ? lineNote : `Tooling charge agreed on purchase order ${po.reference}.`,
            nameSnapshot: line.nameSnapshot,
            skuSnapshot: line.skuSnapshot,
            variantNameSnapshot: null,
            taxClassCodeSnapshot: line.taxClassCodeSnapshot,
            imageUrlSnapshot: null,
            unitPriceMinor: line.unitPriceMinor,
            quantity: line.quantity,
            lineSubtotalMinor: line.lineSubtotalMinor,
            taxRatePercent: line.taxRatePercent,
            taxInclusive: line.taxInclusive,
            taxAmountMinor: line.taxAmountMinor,
            discountMinor: line.discountMinor,
            lineTotalMinor: line.lineTotalMinor,
            isRecurringEligibleSnapshot: false,
            orderingUnit: 'PIECE',
            unitQuantity: line.quantity,
            piecesPerUnitSnapshot: 1,
          },
        });
      }
      await captureOrderItemSnapshots(tx, orderId);

      await tx.orderStatusHistory.create({
        data: {
          id: newId(),
          orderId,
          fromStatus: null,
          toStatus: initialStatus,
          actorType: 'CUSTOMER',
          actorUserId: actor.userId,
          reason: `Made from purchase order ${po.reference}`,
          correlationId: actor.correlationId ?? null,
        },
      });
      if (profile.requiresOrderApproval) {
        await tx.orderApproval.create({
          data: { id: newId(), orderId, status: 'PENDING', requiredReason: 'Approval required by account policy.' },
        });
      }

      // The link, conditional on the one read: a second press, or a second
      // tab, finds it taken and rolls everything above back.
      const linked = await tx.rfqPurchaseOrder.updateMany({
        where: { id: po.id, status: 'APPROVED', orderId: po.orderId },
        data: { orderId, convertedAt: now, convertedByUserId: actor.userId },
      });
      if (linked.count !== 1) throw new LostRaceSignal();

      await recordEvent(tx, {
        rfqId: rfq.id,
        kind: 'PURCHASE_ORDER_CONVERTED',
        actorParty: 'BUYER',
        actorUserId: actor.userId,
        sellerAccountId: po.sellerAccountId,
        meta: { purchaseOrderId: po.id, reference: po.reference, orderId, orderNumber: number },
      });
      const total = `${serialiseMoney(pricing.totals.grandTotalMinor, po.currency).formatted} ${po.currency}`;
      await notifySeller({
        sellerAccountId: po.sellerAccountId,
        kind: 'RFQ_UPDATE',
        title: `Purchase order ${po.reference} is now order ${number}`,
        body: `The buyer turned purchase order ${po.reference} into order ${number} (${total}). It is waiting for payment; do not start production until it is paid.`,
        linkPath: `/seller/rfqs/${rfq.id}`,
        subjectType: 'rfq_request',
        subjectId: rfq.id,
        dedupeKey: `rfq:${rfq.id}:po:${po.id}:order:${orderId}`,
        tx,
      });
      await tellBuyer(
        tx,
        rfq,
        `purchase order ${po.reference} is now order ${number}, waiting for payment of ${total}`,
        `rfq:${rfq.id}:po:${po.id}:order:${orderId}`,
      );
      await recordAudit(
        {
          action: AuditAction.RFQ_PURCHASE_ORDER_CONVERTED,
          resourceType: 'rfq_purchase_order',
          resourceId: po.id,
          actorType: 'CUSTOMER',
          actorUserId: actor.userId,
          actorEmail: actor.email,
          before: { orderId: po.orderId },
          after: {
            orderId,
            orderNumber: number,
            contractHash: po.contractHash,
            grandTotalMinor: pricing.totals.grandTotalMinor,
            currency: po.currency,
            replacedCancelledOrder: po.orderId,
          },
          ipAddress: actor.ipAddress ?? null,
          correlationId: actor.correlationId ?? null,
        },
        tx,
      );
      await recordAudit(
        {
          action: AuditAction.ORDER_CREATED,
          resourceType: 'order',
          resourceId: orderId,
          actorType: 'CUSTOMER',
          actorUserId: actor.userId,
          actorEmail: actor.email,
          after: {
            via: 'rfq_purchase_order',
            purchaseOrderId: po.id,
            orderNumber: number,
            status: initialStatus,
            grandTotalMinor: pricing.totals.grandTotalMinor,
            currency: po.currency,
          },
          correlationId: actor.correlationId ?? null,
        },
        tx,
      );
      return number;
    });
  } catch (error) {
    if (!(error instanceof LostRaceSignal) && !isUniqueViolation(error)) throw error;
    // Another request converted it first. Nothing above was written; answer
    // with the order that won.
    const winner = await prisma.rfqPurchaseOrder.findUniqueOrThrow({ where: { id: po.id }, select: { orderId: true } });
    const won = await existingOrder(winner.orderId);
    if (won === null) throw error;
    return { order: { id: won.id, orderNumber: won.orderNumber, status: won.status }, created: false };
  }

  return { order: { id: orderId, orderNumber, status: initialStatus }, created: true };
}

/**
 * Called inside `transitionOrder`'s move to CONFIRMED - reached only from a
 * signature-verified payment event. Records on the request that the purchase
 * order is paid and tells the supplier production may start. A no-op for
 * every other order.
 */
export async function onRfqOrderConfirmed(orderId: string, tx: PrismaTransaction): Promise<void> {
  const po = await tx.rfqPurchaseOrder.findUnique({
    where: { orderId },
    select: { id: true, reference: true, rfqId: true, sellerAccountId: true },
  });
  if (po === null) return;
  await recordEvent(tx, {
    rfqId: po.rfqId,
    kind: 'PURCHASE_ORDER_PAID',
    actorParty: 'SYSTEM',
    actorUserId: null,
    sellerAccountId: po.sellerAccountId,
    meta: { purchaseOrderId: po.id, reference: po.reference, orderId },
  });
  await notifySeller({
    sellerAccountId: po.sellerAccountId,
    kind: 'RFQ_UPDATE',
    title: `Purchase order ${po.reference} is paid`,
    body: `The order for purchase order ${po.reference} is paid. Accept it in your orders to start production.`,
    linkPath: `/seller/rfqs/${po.rfqId}`,
    subjectType: 'rfq_request',
    subjectId: po.rfqId,
    dedupeKey: `rfq:${po.rfqId}:po:${po.id}:paid:${orderId}`,
    tx,
  });
  await recordAudit(
    {
      action: AuditAction.RFQ_PURCHASE_ORDER_CONVERTED,
      resourceType: 'rfq_purchase_order',
      resourceId: po.id,
      actorType: 'SYSTEM',
      before: { orderId, paid: false },
      after: { orderId, paid: true },
    },
    tx,
  );
}

/** What an order made from a purchase order carries from it, for the screens that show the order. */
export interface PurchaseOrderLink {
  id: string;
  reference: string;
  rfqId: string;
  rfqReference: string;
  buyerSku: string | null;
  incoterm: string | null;
  incotermPlace: string | null;
  paymentTerms: string | null;
  inspectionTerms: string | null;
  exportDocuments: string[];
}

export async function purchaseOrderForOrder(
  orderId: string,
  client: PrismaTransaction | typeof prisma = prisma,
): Promise<PurchaseOrderLink | null> {
  const po = await client.rfqPurchaseOrder.findUnique({
    where: { orderId },
    select: { id: true, reference: true, rfqId: true, buyerSku: true, contractJson: true, rfq: { select: { reference: true } } },
  });
  if (po === null) return null;
  const contract = po.contractJson as unknown as ContractFacts;
  return {
    id: po.id,
    reference: po.reference,
    rfqId: po.rfqId,
    rfqReference: po.rfq.reference,
    buyerSku: po.buyerSku,
    incoterm: contract.delivery.incoterm,
    incotermPlace: contract.delivery.incotermPlace,
    paymentTerms: contract.commercial.paymentTerms,
    inspectionTerms: contract.quality.inspectionTerms,
    exportDocuments: contract.quality.exportDocuments ?? [],
  };
}

/**
 * Orders - customer and admin.
 *
 * Both surfaces are registered from this file so the serialisation stays in one
 * place, but they are separate route trees with separate guards. The customer
 * view is scoped by session-derived profile id and omits internal notes; the
 * admin view is permission-gated and shows everything.
 */
import { readOrderItemSnapshot } from '../../domain/order-item-snapshot.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { fromDateColumn } from '../../domain/delivery-dates.js';
import { notFound } from '../../domain/errors.js';
import { getInvoiceForOrder } from '../../modules/invoicing/invoice.service.js';
import { serialiseMoney } from '../../domain/money.js';
import { OrderStatusValues } from '../../domain/order-state-machine.js';
import { describePackaging, type PackageType } from '../../domain/packaging.js';
import { loadTypeForPackage } from '../../domain/freight-load.js';
import { Permission } from '../../domain/permissions.js';
import { customerDeliveryStage, logisticsStage } from '../../domain/logistics-stage.js';
import { prisma } from '../../infra/prisma.js';
import {
  availableTransitions,
  decideApproval,
  transitionOrder,
} from '../../modules/orders/order.service.js';
import { currentUser, requireAdmin, requireCustomer } from '../plugins/auth.js';

const idParam = z.object({ id: z.string().length(26) });

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(OrderStatusValues).optional(),
  source: z.enum(['ONE_TIME', 'RECURRING']).optional(),
});

const adminListQuerySchema = listQuerySchema.extend({
  q: z.string().trim().max(120).optional(),
  customerProfileId: z.string().length(26).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

type OrderRow = Awaited<ReturnType<typeof prisma.order.findFirstOrThrow>>;

/**
 * Where this order ships from and what was promised, or null.
 *
 * Null on every order placed before fulfilment options existed, and on any
 * order whose destination no warehouse published a lane to - those are priced
 * by the configured shipping method and say so through `shippingMethodName`
 * instead. Two shapes rather than one with empty fields, so a screen cannot
 * render "Arrives between  and " for an order that never had a window.
 *
 * The dates come back as `YYYY-MM-DD` rather than as instants. They are
 * calendar days - "arrives on the 18th" is the 18th wherever it is read - and
 * an ISO timestamp would print as the 17th for every reader west of
 * Greenwich.
 */
function serialiseFulfilment(
  order: OrderRow & { fulfilmentLocation?: { id: string; code: string; name: string } | null },
): Record<string, unknown> | null {
  if (
    order.fulfilmentDispatchDate === null ||
    order.fulfilmentDeliveryFrom === null ||
    order.fulfilmentDeliveryTo === null
  ) {
    return null;
  }

  return {
    warehouse:
      order.fulfilmentLocation === undefined || order.fulfilmentLocation === null
        ? null
        : {
            id: order.fulfilmentLocation.id,
            code: order.fulfilmentLocation.code,
            name: order.fulfilmentLocation.name,
          },
    carrier: order.fulfilmentCarrier,
    serviceLevel: order.fulfilmentServiceLevel,
    dispatchDate: fromDateColumn(order.fulfilmentDispatchDate),
    deliveryFromDate: fromDateColumn(order.fulfilmentDeliveryFrom),
    deliveryToDate: fromDateColumn(order.fulfilmentDeliveryTo),
    quoteId: order.fulfilmentQuoteId,
  };
}

/**
 * The frozen bulk breakdown of one line, or null.
 *
 * Null on every ordinary line, which is most of them - and null is what makes
 * every screen that draws an order render exactly as it did before bulk
 * ordering existed.
 *
 * Built from the SNAPSHOT and never from the seller's current configuration,
 * which is the whole reason the snapshot exists: an order from last month
 * describes the pallet it was actually bought as, after the seller has
 * re-specified theirs.
 *
 * The per-line totals come from `describePackaging`, the same function the
 * basket, the seller's preview and the freight request all use, so the figure
 * on an invoice and the figure on a packing list are one calculation rather
 * than four.
 */
function serialisePackaging(
  packaging: {
    packageType: string;
    palletStandard: string | null;
    containerType: string | null;
    containerLoadMode: string | null;
    containerLoadingMethod: string | null;
    packageQuantity: number;
    unitsPerPackage: number;
    totalBaseUnits: number;
    unitsPerCarton: number | null;
    cartonsPerPallet: number | null;
    palletsPerContainer: number | null;
    cartonsPerContainer: number | null;
    lengthMm: number | null;
    widthMm: number | null;
    heightMm: number | null;
    grossWeightGrams: bigint | null;
    cargoVolumeCm3: bigint | null;
    packagePriceMinor: bigint;
    unitPriceMinor: bigint;
    currency: string;
    appliedTierMinPackages: number | null;
    profileVersion: number;
    requiresFreightQuote: boolean;
    packageSkuSnapshot: string | null;
    incotermSnapshot: string | null;
    originPortLabelSnapshot: string | null;
  } | null
    | undefined,
): Record<string, unknown> | null {
  if (packaging === null || packaging === undefined) return null;

  const packageType = packaging.packageType as PackageType;

  const breakdown = describePackaging({
    packageType,
    packageQuantity: packaging.packageQuantity,
    unitsPerPackage: packaging.unitsPerPackage,
    unitsPerCarton: packaging.unitsPerCarton,
    cartonsPerPallet: packaging.cartonsPerPallet,
    palletsPerContainer: packaging.palletsPerContainer,
    cartonsPerContainer: packaging.cartonsPerContainer,
    grossWeightGrams: packaging.grossWeightGrams,
    cargoVolumeCm3: packaging.cargoVolumeCm3,
  });

  return {
    packageType,
    palletStandard: packaging.palletStandard,
    containerType: packaging.containerType,
    containerLoadMode: packaging.containerLoadMode,
    containerLoadingMethod: packaging.containerLoadingMethod,
    packageQuantity: packaging.packageQuantity,
    unitsPerPackage: packaging.unitsPerPackage,
    totalBaseUnits: packaging.totalBaseUnits,
    unitsPerCarton: packaging.unitsPerCarton,
    cartonsPerPallet: packaging.cartonsPerPallet,
    palletsPerContainer: packaging.palletsPerContainer,
    cartonsPerContainer: packaging.cartonsPerContainer,
    totalCartons: breakdown.totalCartons,
    totalPallets: breakdown.totalPallets,
    totalContainers: breakdown.totalContainers,
    lengthMm: packaging.lengthMm,
    widthMm: packaging.widthMm,
    heightMm: packaging.heightMm,
    // The WHOLE line's weight and volume, not one package's. Strings, like
    // every other large integer this API returns.
    grossWeightGrams: breakdown.grossWeightGrams?.toString() ?? null,
    volumeCm3: breakdown.volumeCm3?.toString() ?? null,
    packagePriceMinor: packaging.packagePriceMinor.toString(),
    unitPriceMinor: packaging.unitPriceMinor.toString(),
    currency: packaging.currency,
    appliedTierMinPackages: packaging.appliedTierMinPackages,
    profileVersion: packaging.profileVersion,
    requiresFreightQuote: packaging.requiresFreightQuote,
    loadType: loadTypeForPackage(
      packageType,
      packaging.containerLoadMode as 'FCL' | 'LCL' | null,
    ),
    packageSku: packaging.packageSkuSnapshot,
    incoterm: packaging.incotermSnapshot,
    originPortLabel: packaging.originPortLabelSnapshot,
    // The stepper's bounds are NOT here. An order is placed; there is nothing
    // left to step. Sending them would invite a screen to offer a control that
    // cannot do anything.
  };
}

function serialiseTotals(order: OrderRow): Record<string, unknown> {
  return {
    subtotal: serialiseMoney(order.subtotalMinor, order.currency),
    discount: serialiseMoney(order.discountMinor, order.currency),
    tax: serialiseMoney(order.taxMinor, order.currency),
    shipping: serialiseMoney(order.shippingMinor, order.currency),
    grandTotal: serialiseMoney(order.grandTotalMinor, order.currency),
    paid: serialiseMoney(order.paidMinor, order.currency),
    refunded: serialiseMoney(order.refundedMinor, order.currency),
  };
}

function serialiseSummary(order: OrderRow & { _count?: { items: number } }): Record<string, unknown> {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    source: order.source,
    currency: order.currency,
    totals: serialiseTotals(order),
    paymentMode: order.paymentMode,
    placedAt: order.placedAt?.toISOString() ?? null,
    confirmedAt: order.confirmedAt?.toISOString() ?? null,
    itemCount: order._count?.items ?? 0,
    createdAt: order.createdAt.toISOString(),
  };
}

// --- Customer routes -------------------------------------------------------

export function registerCustomerOrderRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireCustomer);

  app.get('/', async (request, reply) => {
    const auth = currentUser(request);
    const query = listQuerySchema.parse(request.query);

    // Scoped by the session's profile. There is no customer route that accepts
    // a profile id, so there is nothing here to forget to check.
    const where = {
      customerProfileId: auth.customerProfileId ?? '',
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.source !== undefined ? { source: query.source } : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.order.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: { _count: { select: { items: true } } },
      }),
      prisma.order.count({ where }),
    ]);

    return reply.status(200).send({
      orders: rows.map(serialiseSummary),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    });
  });

  /**
   * The customer's own invoice.
   *
   * Ownership is the `where` clause on the order, exactly as on the detail
   * route above: an invoice for somebody else's order simply does not match.
   * A buyer is entitled to the document, and a supplier who makes them email
   * for it is creating support work for no reason.
   */
  app.get('/:id/invoice', async (request, reply) => {
    const auth = currentUser(request);
    const { id } = idParam.parse(request.params);

    const order = await prisma.order.findFirst({
      where: { id, customerProfileId: auth.customerProfileId ?? '' },
      select: { id: true },
    });

    if (order === null) throw notFound('Order');

    const invoice = await getInvoiceForOrder(order.id);
    return reply.status(200).send({ invoice });
  });

  app.get('/:id', async (request, reply) => {
    const auth = currentUser(request);
    const { id } = idParam.parse(request.params);

    const order = await prisma.order.findFirst({
      // The ownership check is the `where` clause itself: another customer's
      // order simply does not match, so it 404s rather than 403s.
      where: { id, customerProfileId: auth.customerProfileId ?? '' },
      include: {
        /*
         * The frozen bulk breakdown travels with the line.
         *
         * Null on every ordinary line, which is most of them. Included so the
         * order page can show "2 UK pallets x 50 cartons x 24 units" beside
         * the 2,400 - a line reading 2,400 against a five-figure total is a
         * number nobody can check.
         */
        items: { include: { packaging: true } },
        statusHistory: { orderBy: { createdAt: 'asc' } },
        shipments: true,
        approvals: true,
        /*
         * The sellers' own parcels.
         *
         * A marketplace order's boxes never appear in `shipments` - that table
         * is this shop's own dispatches - so a buyer who bought from a seller
         * would be shown a tracking list with nothing in it while a courier
         * was carrying their order. Included here and merged below, named by
         * whoever sent it, because "who is this parcel from" is the first
         * question a buyer expecting two boxes asks.
         */
        sellerOrderGroups: {
          select: {
            id: true,
            // For the delivery stage: "waiting for the seller to confirm" is
            // the buyer's business, and is all of it they see.
            status: true,
            sellerAccount: { select: { displayName: true } },
            shipments: {
              orderBy: { createdAt: 'asc' },
              select: {
                carrierName: true,
                trackingNumber: true,
                trackingUrl: true,
                status: true,
                dispatchedAt: true,
                deliveredAt: true,
              },
            },
          },
        },
        /*
         * The carrier actually holding the parcel.
         *
         * A consignment is raised for every part of a confirmed order and is
         * then offered to a haulier, so this is where "who is bringing it"
         * lives - the two tables above only ever hold a despatch note somebody
         * typed. Without it a buyer watched their order sit at "confirmed"
         * while a named carrier was driving it across the country.
         *
         * The carrier's NAME and our own tracking number, and nothing else.
         * The consignment also carries pickup addresses, handling flags and a
         * declared value, none of which is the buyer's business.
         */
        logisticsShipments: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            sellerOrderGroupId: true,
            trackingNumber: true,
            // The carrier's OWN waybill number, which is what the buyer types
            // into DHL's site. Present only when a carrier API returned it or
            // a person entered it; never generated here.
            carrierTrackingNumber: true,
            carrierTrackingUrl: true,
            status: true,
            dispatchedAt: true,
            deliveredAt: true,
            assignedPartner: { select: { displayName: true } },
            /*
             * How the seller said this would be delivered.
             *
             * The buyer is told the seller's APPROVED public name, which is
             * not always the legal one and is never the seller's internal
             * shorthand. Nothing else about the arrangement reaches them.
             */
            sellerFulfilmentMethod: { select: { publicDisplayName: true, mode: true } },
            /*
             * Only the tracking mode, and only so the buyer can be told
             * whether updates arrive on their own or are entered by hand.
             * Never the provider's credentials, the account number, or
             * anything else about the seller's arrangement with them.
             */
            sellerCarrierConnection: { select: { trackingMode: true } },
            /*
             * Facts for the stage, and nothing the buyer reads directly: the
             * newest offer's STATE (not which company, not why it refused),
             * whether a driver is on it (not who), and the carrier of a
             * hand-made booking.
             */
            assignments: { orderBy: { offeredAt: 'desc' }, take: 1, select: { state: true } },
            driverAssignments: { where: { activeShipmentId: { not: null } }, select: { id: true } },
            manualCarrierBookings: {
              where: { activeShipmentId: { not: null } },
              select: { provider: true, status: true },
            },
            /*
             * The timeline, in the words written FOR the buyer. The internal
             * note beside each event is the carrier's own and never selected.
             */
            events: {
              where: { publicDescription: { not: null } },
              orderBy: { occurredAt: 'asc' },
              select: { status: true, publicDescription: true, occurredAt: true },
            },
          },
        },
        // Which building it is coming from. The customer chose it at
        // checkout, so telling them is the least this screen can do - and
        // "ships from Antwerp, arriving Thursday to Monday" is the answer
        // most order-status emails are asking for.
        fulfilmentLocation: { select: { id: true, code: true, name: true } },
      },
    });

    if (order === null) throw notFound('Order');

    // Which seller each consignment is for, and whether that seller has
    // already sent a despatch note for it. Both read by the tracking list.
    const sellerNameByGroup = new Map(
      order.sellerOrderGroups.map((group) => [group.id, group.sellerAccount.displayName]),
    );
    const groupStatusById = new Map<string, string>(
      order.sellerOrderGroups.map((group) => [group.id, group.status]),
    );
    const groupShipmentCounts = new Map(
      order.sellerOrderGroups.map((group) => [group.id, group.shipments.length]),
    );

    return reply.status(200).send({
      order: {
        ...serialiseSummary(order),
        shippingAddress: order.shippingAddressJson,
        billingAddress: order.billingAddressJson,
        shippingMethodName: order.shippingMethodName,
        // Null where no warehouse option priced this order - see the
        // serialiser. The shipping method above is the other half of the
        // pair, and exactly one of the two is ever set.
        fulfilment: serialiseFulfilment(order),
        customerNote: order.customerNote,
        /*
         * How the customer said they would pay, and with which of their cards.
         *
         * The payment page reads these back rather than being handed them, so
         * a reload - or coming back to an unpaid order from an email hours
         * later - offers the same thing they chose rather than starting over.
         *
         * The gateway is deliberately NOT here. It is resolved from the
         * instrument at payment time and is the operator's business; a
         * customer's order record has no reason to name an acquirer.
         */
        preferredPaymentInstrument: order.preferredPaymentInstrument,
        preferredPaymentMethodId: order.preferredPaymentMethodId,
        // `internalNote` is deliberately absent: it is written by staff about
        // the order and is not the customer's to read.
        cancelReason: order.cancelReason,
        // Why the tax line says what it says. A business reading a zero-rated
        // order needs to know it is reverse-charged - they have to account for
        // the VAT themselves, and an unexplained zero looks like a mistake.
        taxTreatment: order.taxTreatment,
        taxCountry: order.taxCountry,
        buyerVatNumber: order.buyerVatNumberSnapshot,
        items: order.items.map((item) => ({
          id: item.id,
          // The product and variant ids let a customer reorder from their own
          // history. They identify no more than the SKU already returned
          // beside them, and without them Reorder cannot name what to add.
          productId: item.productId,
          variantId: item.variantId,
          name: item.nameSnapshot,
          sku: item.skuSnapshot,
          variantName: item.variantNameSnapshot,
          imageUrl: item.imageUrlSnapshot,
          quantity: item.quantity,
          /**
           * What the buyer actually ordered, in the unit they ordered it in.
           *
           * The quantity beside it is pieces, which is what the warehouse
           * picks and what the price is per. Both are sent because an order
           * that says "1,000 × 12.50" to somebody who bought two cartons is a
           * dispute nobody can settle, and one that says only "2 cartons"
           * cannot be checked against the total.
           *
           * Read off the line's own snapshot, so an order placed when a
           * carton held a different number still describes itself correctly.
           */
          ordering: {
            unit: item.orderingUnit,
            unitQuantity: item.unitQuantity,
            piecesPerUnit: item.piecesPerUnitSnapshot,
          },
          packaging: serialisePackaging(item.packaging),
          unitPrice: serialiseMoney(item.unitPriceMinor, order.currency),
          lineSubtotal: serialiseMoney(item.lineSubtotalMinor, order.currency),
          tax: serialiseMoney(item.taxAmountMinor, order.currency),
          lineTotal: serialiseMoney(item.lineTotalMinor, order.currency),
          taxRatePercent: item.taxRatePercent.toString(),
          // What they asked for on this line. Sent back to the customer as
          // well as to staff: an instruction somebody cannot re-read on their
          // own order is one they cannot check was understood.
          note: item.noteSnapshot,
          // What they bought, as it was described when they ordered it:
          // description, specifications, packaging and their selections. Null
          // on an order from before these were kept. Never today's listing -
          // the customer's record of a purchase is the purchase.
          productInfo: readOrderItemSnapshot(item.productInfoSnapshotJson),
        })),
        timeline: order.statusHistory.map((entry) => ({
          from: entry.fromStatus,
          to: entry.toStatus,
          reason: entry.reason,
          at: entry.createdAt.toISOString(),
        })),
        shipments: [
          ...order.shipments.map((shipment) => ({
            carrier: shipment.carrier,
            trackingNumber: shipment.trackingNumber,
            trackingUrl: shipment.trackingUrl,
            status: shipment.status,
            dispatchedAt: shipment.dispatchedAt?.toISOString() ?? null,
            deliveredAt: shipment.deliveredAt?.toISOString() ?? null,
            // This shop's own box. Null rather than the shop's name: a buyer
            // on a shop's own site does not need telling who the shop is.
            sentBy: null,
          })),
          ...order.sellerOrderGroups.flatMap((group) =>
            group.shipments.map((shipment) => ({
              carrier: shipment.carrierName,
              trackingNumber: shipment.trackingNumber,
              trackingUrl: shipment.trackingUrl,
              status: shipment.status,
              dispatchedAt: shipment.dispatchedAt?.toISOString() ?? null,
              deliveredAt: shipment.deliveredAt?.toISOString() ?? null,
              sentBy: group.sellerAccount.displayName,
            })),
          ),
          /*
           * The consignment, where the part it covers has no despatch note of
           * its own yet.
           *
           * The two are one parcel, not two: the seller's own note and the
           * carrier's consignment describe the same box, and listing both
           * would tell a buyer expecting one delivery to expect two. The note
           * wins once it exists, because it is the one with the seller's own
           * carrier reference on it.
           */
          ...order.logisticsShipments
            .filter((consignment) =>
              consignment.sellerOrderGroupId === null
                ? order.shipments.length === 0
                : (groupShipmentCounts.get(consignment.sellerOrderGroupId) ?? 0) === 0,
            )
            .map((consignment) => ({
              /*
               * The carrier actually holding it, or the seller's approved
               * public name for how they deliver.
               *
               * The assigned carrier wins because it is the company whose van
               * will arrive. The method's name is the fallback for a parcel
               * going by the seller's own arrangement, where there is no third
               * party to name.
               */
              carrier:
                consignment.assignedPartner?.displayName ??
                manualCarrierName(consignment.manualCarrierBookings[0]?.provider) ??
                consignment.sellerFulfilmentMethod?.publicDisplayName ??
                null,
              trackingNumber: consignment.trackingNumber,
              carrierTrackingNumber: consignment.carrierTrackingNumber,
              /*
               * One stage, from the same function the seller, the carrier and
               * the marketplace see - coarsened so a refusal or a pending
               * offer reads as "awaiting a carrier".
               */
              deliveryStage: customerDeliveryStage({
                sellerOrderStatus:
                  consignment.sellerOrderGroupId === null
                    ? null
                    : (groupStatusById.get(consignment.sellerOrderGroupId) ?? null),
                stage: logisticsStage({
                  shipmentStatus: consignment.status,
                  latestAssignmentState: consignment.assignments[0]?.state ?? null,
                  hasActiveDriver: consignment.driverAssignments.length > 0,
                  manualBookingStatus: bookingStatus(consignment.manualCarrierBookings[0]?.status),
                }),
              }),
              events: consignment.events.map((event) => ({
                status: event.status,
                description: event.publicDescription,
                occurredAt: event.occurredAt.toISOString(),
              })),
              trackingUrl: consignment.carrierTrackingUrl,
              status: consignment.status,
              dispatchedAt: consignment.dispatchedAt?.toISOString() ?? null,
              deliveredAt: consignment.deliveredAt?.toISOString() ?? null,
              sentBy:
                sellerNameByGroup.get(consignment.sellerOrderGroupId ?? '') ?? null,
              /*
               * Whether updates arrive on their own.
               *
               * FALSE means somebody types them in, or they live on the
               * carrier's own page - which is the India Post case. A buyer who
               * is not told sits refreshing a page waiting for movement that
               * was never going to appear there, and then rings somebody.
               *
               * Null where there is no carrier account behind it at all, which
               * is every consignment carried inside this system: those DO move
               * on their own, as the portal records them.
               */
              trackingIsAutomatic:
                consignment.manualCarrierBookings.length > 0
                  ? false
                  : consignment.sellerCarrierConnection === null
                    ? null
                    : consignment.sellerCarrierConnection.trackingMode === 'AUTOMATIC_API',
            })),
        ],
        approval: order.approvals[0] ?? null,
      },
    });
  });

  /** Cancel an order the policy still allows to be cancelled. */
  app.post('/:id/cancel', async (request, reply) => {
    const auth = currentUser(request);
    const { id } = idParam.parse(request.params);
    const body = z.object({ reason: z.string().trim().min(1).max(512) }).parse(request.body);

    const order = await prisma.order.findFirst({
      where: { id, customerProfileId: auth.customerProfileId ?? '' },
      select: { id: true },
    });
    if (order === null) throw notFound('Order');

    // The state machine decides whether a customer may cancel from the current
    // status. After dispatch they cannot, and it says so.
    const result = await transitionOrder({
      orderId: id,
      to: 'CANCELLED',
      actor: {
        userId: auth.id,
        email: auth.email,
        type: 'CUSTOMER',
        ipAddress: request.ip,
        correlationId: request.correlationId,
      },
      reason: body.reason,
    });

    return reply.status(200).send(result);
  });

  return Promise.resolve();
}

// --- Admin routes ----------------------------------------------------------

export function registerAdminOrderRoutes(app: FastifyInstance): Promise<void> {
  app.get('/orders', { preHandler: requireAdmin(Permission.ORDER_READ) }, async (request, reply) => {
    const query = adminListQuerySchema.parse(request.query);

    const where = {
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.source !== undefined ? { source: query.source } : {}),
      ...(query.customerProfileId !== undefined
        ? { customerProfileId: query.customerProfileId }
        : {}),
      ...(query.from !== undefined || query.to !== undefined
        ? {
            createdAt: {
              ...(query.from !== undefined ? { gte: new Date(query.from) } : {}),
              ...(query.to !== undefined ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
      ...(query.q !== undefined && query.q.length > 0
        ? {
            OR: [
              { orderNumber: { contains: query.q } },
              { customerProfile: { fullName: { contains: query.q } } },
              { customerProfile: { organization: { contains: query.q } } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.order.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: {
          _count: { select: { items: true } },
          customerProfile: {
            select: { id: true, fullName: true, organization: true },
          },
        },
      }),
      prisma.order.count({ where }),
    ]);

    return reply.status(200).send({
      orders: rows.map((row) => ({
        ...serialiseSummary(row),
        customer: row.customerProfile,
      })),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    });
  });

  app.get(
    '/orders/:id',
    { preHandler: requireAdmin(Permission.ORDER_READ) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const auth = currentUser(request);

      const order = await prisma.order.findUnique({
        where: { id },
        include: {
          // The same breakdown the buyer sees, on the staff screen. A support
          // conversation about a pallet order is two people reading one fact,
          // which it stops being the moment one of them has the arithmetic and
          // the other has only the total.
          items: { include: { packaging: true } },
          statusHistory: { orderBy: { createdAt: 'asc' } },
          approvals: true,
          payments: true,
          paymentLinks: true,
          refunds: true,
          shipments: true,
          reservations: true,
          fulfilmentLocation: { select: { id: true, code: true, name: true } },
          customerProfile: {
            include: { user: { select: { email: true, status: true } } },
          },
        },
      });

      if (order === null) throw notFound('Order');

      // The Admin Panel renders exactly these as buttons, so what it offers
      // always matches what the API will accept.
      const transitions = await availableTransitions(id, {
        userId: auth.id,
        email: auth.email,
        type: 'ADMIN',
        permissions: auth.permissions,
      });

      return reply.status(200).send({
        order: {
          ...serialiseSummary(order),
          customer: {
            id: order.customerProfile.id,
            fullName: order.customerProfile.fullName,
            organization: order.customerProfile.organization,
            email: order.customerProfile.user.email,
            status: order.customerProfile.user.status,
          },
          shippingAddress: order.shippingAddressJson,
          billingAddress: order.billingAddressJson,
          shippingMethodName: order.shippingMethodName,
          // Where the warehouse team is meant to pick this, and the window
          // the customer was promised. The same block the customer sees, so
          // a support conversation is two people reading one fact.
          fulfilment: serialiseFulfilment(order),
          customerNote: order.customerNote,
          internalNote: order.internalNote,
          cancelReason: order.cancelReason,
          items: order.items.map((item) => ({
            id: item.id,
            productId: item.productId,
            name: item.nameSnapshot,
            sku: item.skuSnapshot,
            variantName: item.variantNameSnapshot,
            quantity: item.quantity,
            // Pieces above, cartons here. Staff answering a query about an
            // order are reading the same two numbers the customer is.
            ordering: {
              unit: item.orderingUnit,
              unitQuantity: item.unitQuantity,
              piecesPerUnit: item.piecesPerUnitSnapshot,
            },
            packaging: serialisePackaging(item.packaging),
            unitPrice: serialiseMoney(item.unitPriceMinor, order.currency),
            lineSubtotal: serialiseMoney(item.lineSubtotalMinor, order.currency),
            tax: serialiseMoney(item.taxAmountMinor, order.currency),
            lineTotal: serialiseMoney(item.lineTotalMinor, order.currency),
            taxRatePercent: item.taxRatePercent.toString(),
            taxClassCode: item.taxClassCodeSnapshot,
            // The buyer's instruction for this line. Staff answering a query
            // about an order are reading exactly what the customer wrote,
            // beside the line it was written about.
            note: item.noteSnapshot,
          })),
          timeline: order.statusHistory.map((entry) => ({
            from: entry.fromStatus,
            to: entry.toStatus,
            actorType: entry.actorType,
            actorUserId: entry.actorUserId,
            reason: entry.reason,
            at: entry.createdAt.toISOString(),
          })),
          approvals: order.approvals,
          payments: order.payments.map((payment) => ({
            id: payment.id,
            provider: payment.provider,
            mode: payment.mode,
            status: payment.status,
            amount: serialiseMoney(payment.amountMinor, payment.currency),
            captured: serialiseMoney(payment.capturedMinor, payment.currency),
            providerOrderId: payment.providerOrderId,
            providerPaymentId: payment.providerPaymentId,
            failureCode: payment.failureCode,
            createdAt: payment.createdAt.toISOString(),
          })),
          paymentLinks: order.paymentLinks.map((link) => ({
            id: link.id,
            // The token hash is never exposed; only its lifecycle is.
            recipientEmail: link.recipientEmail,
            amount: serialiseMoney(link.amountMinor, link.currency),
            expiresAt: link.expiresAt.toISOString(),
            sentAt: link.sentAt?.toISOString() ?? null,
            usedAt: link.usedAt?.toISOString() ?? null,
            revokedAt: link.revokedAt?.toISOString() ?? null,
          })),
          refunds: order.refunds.map((refund) => ({
            id: refund.id,
            status: refund.status,
            amount: serialiseMoney(refund.amountMinor, refund.currency),
            reason: refund.reason,
            createdAt: refund.createdAt.toISOString(),
          })),
          shipments: order.shipments,
          reservationCount: order.reservations.filter((r) => r.status === 'ACTIVE').length,
          availableTransitions: transitions,
        },
      });
    },
  );

  /**
   * Apply a status transition.
   *
   * One endpoint rather than per-status routes, because the state machine
   * already knows which moves are legal and which permission each needs -
   * duplicating that as route definitions would let the two drift apart.
   */
  app.post(
    '/orders/:id/transition',
    { preHandler: requireAdmin(Permission.ORDER_READ) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z
        .object({
          to: z.enum(OrderStatusValues),
          reason: z.string().max(512).optional(),
        })
        .parse(request.body);

      const auth = currentUser(request);

      const result = await transitionOrder({
        orderId: id,
        to: body.to,
        actor: {
          userId: auth.id,
          email: auth.email,
          type: 'ADMIN',
          // The state machine performs the per-transition permission check.
          permissions: auth.permissions,
          ipAddress: request.ip,
          correlationId: request.correlationId,
        },
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
      });

      return reply.status(200).send(result);
    },
  );

  /**
   * Approve or reject an order that is waiting for staff approval, with an
   * optional comment. Approving moves it on to waiting for payment; rejecting
   * cancels it. Refused if the order has no approval still pending.
   */
  app.post(
    '/orders/:id/approval',
    { preHandler: requireAdmin(Permission.ORDER_APPROVE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z
        .object({ approved: z.boolean(), comment: z.string().max(512).optional() })
        .parse(request.body);

      const auth = currentUser(request);

      const result = await decideApproval(
        id,
        body.approved,
        {
          userId: auth.id,
          email: auth.email,
          type: 'ADMIN',
          permissions: auth.permissions,
          ipAddress: request.ip,
          correlationId: request.correlationId,
        },
        body.comment,
      );

      return reply.status(200).send(result);
    },
  );

  /**
   * Replace, or clear, the staff-only internal note on an order. Customers
   * never see it.
   */
  app.patch(
    '/orders/:id/note',
    { preHandler: requireAdmin(Permission.ORDER_NOTE_WRITE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z.object({ internalNote: z.string().max(20_000).nullable() }).parse(request.body);

      const updated = await prisma.order.updateMany({
        where: { id },
        data: { internalNote: body.internalNote },
      });

      if (updated.count === 0) throw notFound('Order');
      return reply.status(200).send({ updated: true });
    },
  );

  return Promise.resolve();
}

/** The name of an outside carrier booked by hand, as the carrier writes it. */
function manualCarrierName(provider: string | undefined): string | null {
  switch (provider) {
    case 'DHL':
      return 'DHL';
    case 'FEDEX':
      return 'FedEx';
    case 'INDIA_POST':
      return 'India Post';
    default:
      return null;
  }
}

function bookingStatus(status: string | undefined): 'BOOKING_REQUIRED' | 'BOOKED' | null {
  return status === 'BOOKING_REQUIRED' || status === 'BOOKED' ? status : null;
}

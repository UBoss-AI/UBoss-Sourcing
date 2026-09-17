/**
 * The operator's side: carriers, their shipments, their exceptions, their
 * integrations.
 *
 * Guarded by the ADMIN permission catalogue, never the logistics one - see
 * `domain/logistics-permissions.ts` for why the two are kept apart. A route
 * here that accepted a carrier's own membership would be a route a carrier
 * could reach.
 *
 * Nothing in this file is tenant-scoped, and that is correct: the marketplace
 * sees every carrier's work. What it does NOT do is expose one carrier's data
 * to another - there is no route here that a carrier can call at all.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import { env } from '../../config/env.js';
import { OPEN_EXCEPTION_STATES } from '../../modules/logistics/exception.service.js';
import { Permission } from '../../domain/permissions.js';
import { ErrorCode, conflict, notFound } from '../../domain/errors.js';
import {
  ShipmentStatusValues,
  allowedShipmentTransitions,
  type ShipmentStatusName,
} from '../../domain/logistics-shipment-state.js';
import { knownCarrierCodes, isCarrierProvider } from '../../domain/carrier-status-map.js';
import { prisma } from '../../infra/prisma.js';
import {
  advanceShipmentStatus,
  correctShipmentStatus,
  createLogisticsPartner,
  decideCapability,
  inviteAsOperator,
  listIntegrations,
  rotateWebhookSecret,
  setPartnerStatus,
  setServiceRegions,
  testIntegration,
  upsertIntegration,
  upsertSlaPolicy,
  upsertStatusMapping,
  type AdminActor,
} from '../../modules/logistics/admin.service.js';
import {
  findEligiblePartners,
  offerAssignment,
  withdrawAssignment,
} from '../../modules/logistics/assignment.service.js';
import { createShipmentsForOrder } from '../../modules/logistics/shipment-create.service.js';
import { readDriverAssignmentHistory } from '../../modules/logistics/driver-assignment.service.js';
import {
  asOperator,
  assignDriver,
  createDriver,
  createVehicle,
  listDrivers,
  listVehicles,
  unassignDriver,
  updateDriver,
  type FleetActor,
} from '../../modules/logistics/driver.service.js';
import { describeProviders } from '../../modules/logistics/carrier/registry.js';
import { buildTokenUrl } from '../../modules/identity/token.service.js';
import { email } from '../../infra/email/index.js';
import { currentUser } from '../plugins/auth.js';
import { requireAdmin } from '../plugins/auth.js';
import type { FastifyRequest } from 'fastify';

const idParam = z.object({ id: z.string().length(26) });
const isoDate = z.coerce.date();

/**
 * How many options a filter select is ever offered.
 *
 * A cap rather than a page, because a select nobody can page is a select that
 * has to be short enough to read. Anybody who cannot find a business in the
 * first hundred is looking for a business rather than narrowing a list, and
 * the Companies screen is where that is done.
 */
const FILTER_OPTION_LIMIT = 100;

function actorFor(request: FastifyRequest): AdminActor {
  const auth = currentUser(request);

  return {
    userId: auth.id,
    email: auth.email,
    permissions: auth.permissions,
    ipAddress: request.ip,
    correlationId: request.correlationId,
  };
}

/**
 * The marketplace, acting on a named carrier's fleet.
 *
 * The operator's own `users.id` is carried through for the marketplace audit
 * trail. What is written into the CARRIER’s trail is the label - the
 * marketplace, not the individual - which is the same line `SellerAuditLog`
 * draws: a tenant sees that the operator acted, never which member of
 * somebody else's staff it was.
 */
function fleetActorFor(request: FastifyRequest, logisticsPartnerId: string): FleetActor {
  return asOperator({ logisticsPartnerId, userId: currentUser(request).id });
}

/**
 * The carrier this consignment is with, or a refusal.
 *
 * Every fleet action on a consignment - putting a driver on it, taking one
 * off - needs a fleet to take the driver FROM, and the only correct one is the
 * carrier the consignment is already assigned to. Asking the caller to name it
 * would let the marketplace put one carrier’s driver on another’s parcel,
 * which is not an authority question but a nonsense, so it is derived here and
 * never accepted from the body.
 */
async function carrierHoldingShipment(shipmentId: string): Promise<string> {
  const shipment = await prisma.logisticsShipment.findUnique({
    where: { id: shipmentId },
    select: { assignedPartnerId: true },
  });

  if (shipment === null) throw notFound('Shipment');

  if (shipment.assignedPartnerId === null) {
    throw conflict(
      ErrorCode.SHIPMENT_NOT_ASSIGNED,
      'This consignment is not with a carrier yet, so there is no fleet to take a driver from.',
    );
  }

  return shipment.assignedPartnerId;
}

/**
 * Send an activation link.
 *
 * The raw token is used once, here, and is never stored or logged. It is
 * emailed and forgotten - the only thing on disk is its SHA-256. If the email
 * driver is `log`, which it is on a fresh checkout, the link appears in the
 * server log and nowhere else, which is the intended development behaviour and
 * is why this function does not also return it to the caller.
 */
async function sendActivationEmail(params: {
  to: string;
  fullName: string;
  partnerName: string;
  token: string;
  expiresAt: Date;
}): Promise<void> {
  const url = buildTokenUrl('INVITATION', params.token, 'LOGISTICS');

  await email.send({
    to: params.to,
    subject: `Set up your ${params.partnerName} logistics account`,
    text:
      `Hello ${params.fullName},\n\n` +
      `You have been given access to the logistics portal for ${params.partnerName}.\n\n` +
      `Open this link to choose a password. It works once and expires on ` +
      `${params.expiresAt.toISOString()}.\n\n${url}\n\n` +
      'If you were not expecting this, ignore it and tell your operations contact.\n',
  });
}

export function registerAdminLogisticsRoutes(app: FastifyInstance): Promise<void> {
  // --- Carriers -----------------------------------------------------------

  app.get(
    '/logistics/partners',
    { preHandler: requireAdmin(Permission.LOGISTICS_READ) },
    async (request, reply) => {
      const query = z
        .object({
          status: z
            .enum(['PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'])
            .optional(),
          search: z.string().trim().max(160).optional(),
        })
        .parse(request.query);

      const partners = await prisma.logisticsPartner.findMany({
        where: {
          archivedAt: null,
          ...(query.status !== undefined ? { status: query.status } : {}),
          ...(query.search !== undefined
            ? {
                OR: [
                  { displayName: { contains: query.search } },
                  { legalName: { contains: query.search } },
                  { partnerCode: { contains: query.search } },
                ],
              }
            : {}),
        },
        orderBy: [{ status: 'asc' }, { displayName: 'asc' }],
        take: 200,
        select: {
          id: true,
          partnerCode: true,
          displayName: true,
          legalName: true,
          registrationCountry: true,
          status: true,
          contractStatus: true,
          contractEndsAt: true,
          contactEmail: true,
          maxOpenShipments: true,
          createdAt: true,
          _count: { select: { users: true, regions: true } },
        },
      });

      /*
       * Open consignments per carrier, in one grouped query rather than a
       * count per row. Two hundred carriers would otherwise be two hundred
       * round trips on a screen somebody opens all day.
       */
      const open = await prisma.logisticsShipment.groupBy({
        by: ['assignedPartnerId'],
        where: {
          assignedPartnerId: { not: null },
          status: { notIn: ['DELIVERED', 'CANCELLED', 'RETURNED', 'LOST'] },
        },
        _count: { _all: true },
      });

      const openByPartner = new Map(open.map((row) => [row.assignedPartnerId, row._count._all]));

      return reply.status(200).send({
        partners: partners.map((partner) => ({
          ...partner,
          memberCount: partner._count.users,
          regionCount: partner._count.regions,
          openShipments: openByPartner.get(partner.id) ?? 0,
        })),
      });
    },
  );

  app.get(
    '/logistics/partners/:id',
    { preHandler: requireAdmin(Permission.LOGISTICS_READ) },
    async (request, reply) => {
      const params = idParam.parse(request.params);

      const partner = await prisma.logisticsPartner.findFirst({
        where: { id: params.id, archivedAt: null },
        select: {
          id: true,
          partnerCode: true,
          legalName: true,
          displayName: true,
          registrationNumber: true,
          taxNumber: true,
          licenceNumber: true,
          licenceExpiresAt: true,
          registrationCountry: true,
          contactEmail: true,
          contactPhone: true,
          emergencyPhone: true,
          websiteUrl: true,
          addressJson: true,
          status: true,
          contractStatus: true,
          contractReference: true,
          contractStartsAt: true,
          contractEndsAt: true,
          suspensionReason: true,
          suspendedAt: true,
          maxOpenShipments: true,
          maxDailyAssignments: true,
          autoAssignEnabled: true,
          // The operator's own free-text about this carrier. Selected HERE and
          // never on a path a carrier can reach - it routinely names other
          // people, the same line `CustomerProfile.internalNotes` draws.
          internalNotes: true,
          createdAt: true,
          carrierIntegration: { select: { id: true, name: true, provider: true, state: true } },
          regions: {
            orderBy: [{ countryCode: 'asc' }],
            select: {
              id: true,
              scope: true,
              countryCode: true,
              regionValue: true,
              supportsPickup: true,
              supportsDelivery: true,
              isActive: true,
            },
          },
          capabilities: {
            orderBy: { kind: 'asc' },
            select: {
              id: true,
              kind: true,
              state: true,
              evidenceReference: true,
              evidenceExpiresAt: true,
              decidedAt: true,
              decisionNote: true,
            },
          },
          slaPolicies: {
            orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
            select: {
              id: true,
              name: true,
              serviceType: true,
              pickupHours: true,
              deliveryHours: true,
              riskWindowMinutes: true,
              maxDeliveryAttempts: true,
              podRequiresRecipientName: true,
              podRequiresSignature: true,
              podRequiresPhoto: true,
              podRequiresOtp: true,
              podRequiresDesignation: true,
              isDefault: true,
              isActive: true,
            },
          },
          users: {
            orderBy: [{ status: 'asc' }, { fullName: 'asc' }],
            select: {
              id: true,
              fullName: true,
              role: true,
              status: true,
              jobTitle: true,
              lastActiveAt: true,
              user: { select: { email: true, mfaEnabledAt: true } },
            },
          },
        },
      });

      if (partner === null) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Logistics partner was not found.',
            details: [],
            correlationId: request.correlationId,
          },
        });
      }

      return reply.status(200).send(partner);
    },
  );

  app.post(
    '/logistics/partners',
    { preHandler: requireAdmin(Permission.LOGISTICS_WRITE) },
    async (request, reply) => {
      const body = z
        .object({
          legalName: z.string().trim().min(2).max(255),
          displayName: z.string().trim().min(2).max(160),
          registrationCountry: z.string().length(2),
          contactEmail: z.string().email().max(320),
          contactPhone: z.string().trim().max(32).optional(),
          emergencyPhone: z.string().trim().max(32).optional(),
          websiteUrl: z.string().url().max(512).optional(),
          registrationNumber: z.string().trim().max(64).optional(),
          taxNumber: z.string().trim().max(64).optional(),
          licenceNumber: z.string().trim().max(64).optional(),
          licenceExpiresAt: isoDate.optional(),
          contractReference: z.string().trim().max(64).optional(),
          contractStartsAt: isoDate.optional(),
          contractEndsAt: isoDate.optional(),
          maxOpenShipments: z.number().int().min(1).max(1_000_000).optional(),
          carrierIntegrationId: z.string().length(26).optional(),
          internalNotes: z.string().trim().max(4000).optional(),
          ownerEmail: z.string().email().max(320),
          ownerFullName: z.string().trim().min(2).max(160),
        })
        .parse(request.body);

      const created = await createLogisticsPartner(actorFor(request), body);

      await sendActivationEmail({
        to: created.invitation.email,
        fullName: body.ownerFullName,
        partnerName: created.displayName,
        token: created.invitation.token,
        expiresAt: created.invitation.expiresAt,
      });

      /*
       * The token is NOT in the response.
       *
       * It went into one email. Returning it here would put a credential that
       * sets a password into an admin panel's network tab, its console
       * history, and any screenshot of either.
       */
      return reply.status(201).send({
        id: created.id,
        partnerCode: created.partnerCode,
        displayName: created.displayName,
        invitedOwner: created.invitation.email,
        invitationExpiresAt: created.invitation.expiresAt,
      });
    },
  );

  app.post(
    '/logistics/partners/:id/status',
    { preHandler: requireAdmin(Permission.LOGISTICS_WRITE) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z
        .object({
          status: z.enum(['PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED']),
          reason: z.string().trim().max(512).optional(),
          handoverShipments: z.boolean().optional(),
        })
        .parse(request.body);

      const result = await setPartnerStatus(
        actorFor(request),
        params.id,
        body.status,
        body.reason ?? null,
        { handoverShipments: body.handoverShipments ?? false },
      );

      return reply.status(200).send(result);
    },
  );

  app.put(
    '/logistics/partners/:id/regions',
    { preHandler: requireAdmin(Permission.LOGISTICS_WRITE) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z
        .object({
          regions: z
            .array(
              z.object({
                scope: z.enum(['COUNTRY', 'STATE', 'CITY', 'POSTCODE_PREFIX']),
                countryCode: z.string().length(2),
                regionValue: z.string().trim().max(120).optional(),
                supportsPickup: z.boolean().optional(),
                supportsDelivery: z.boolean().optional(),
              }),
            )
            .max(2000),
        })
        .parse(request.body);

      const result = await setServiceRegions(actorFor(request), params.id, body.regions);
      return reply.status(200).send(result);
    },
  );

  app.post(
    '/logistics/partners/:id/capabilities',
    { preHandler: requireAdmin(Permission.LOGISTICS_WRITE) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z
        .object({
          kind: z.enum([
            'TEMPERATURE_CONTROLLED',
            'COLD_CHAIN_2_8',
            'FROZEN',
            'STERILE_HANDLING',
            'DANGEROUS_GOODS',
            'FRAGILE_HANDLING',
            'OVERSIZED',
            'PALLET',
            'TAIL_LIFT',
            'WHITE_GLOVE',
            'SAME_DAY',
            'NEXT_DAY',
            'INTERNATIONAL',
            'CUSTOMS_BROKERAGE',
            'PROOF_OF_DELIVERY_PHOTO',
            'PROOF_OF_DELIVERY_OTP',
          ]),
          state: z.enum(['REQUESTED', 'APPROVED', 'REJECTED', 'SUSPENDED']),
          evidenceReference: z.string().trim().max(255).optional(),
          evidenceExpiresAt: isoDate.optional(),
          temperatureMinC: z.number().min(-100).max(100).optional(),
          temperatureMaxC: z.number().min(-100).max(100).optional(),
          note: z.string().trim().max(512).optional(),
        })
        .parse(request.body);

      await decideCapability(actorFor(request), params.id, body.kind, body);
      return reply.status(204).send();
    },
  );

  app.put(
    '/logistics/partners/:id/sla-policies',
    { preHandler: requireAdmin(Permission.LOGISTICS_WRITE) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z
        .object({
          id: z.string().length(26).optional(),
          name: z.string().trim().min(1).max(120),
          serviceType: z.enum([
            'STANDARD',
            'EXPRESS',
            'SAME_DAY',
            'ECONOMY',
            'FREIGHT',
            'WHITE_GLOVE',
          ]),
          pickupHours: z.number().int().min(0).max(8760).nullable().optional(),
          deliveryHours: z.number().int().min(0).max(8760).nullable().optional(),
          riskWindowMinutes: z.number().int().min(0).max(40_320).optional(),
          maxDeliveryAttempts: z.number().int().min(1).max(10).optional(),
          podRequiresRecipientName: z.boolean().optional(),
          podRequiresSignature: z.boolean().optional(),
          podRequiresPhoto: z.boolean().optional(),
          podRequiresOtp: z.boolean().optional(),
          podRequiresDesignation: z.boolean().optional(),
          isDefault: z.boolean().optional(),
          isActive: z.boolean().optional(),
        })
        .parse(request.body);

      const result = await upsertSlaPolicy(actorFor(request), params.id, body);
      return reply.status(200).send(result);
    },
  );

  app.post(
    '/logistics/partners/:id/invitations',
    { preHandler: requireAdmin(Permission.LOGISTICS_WRITE) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z
        .object({
          email: z.string().email().max(320),
          fullName: z.string().trim().min(2).max(160),
          role: z.enum([
            'LOGISTICS_PARTNER_OWNER',
            'LOGISTICS_PARTNER_ADMIN',
            'DISPATCHER',
            'DRIVER',
            'OPERATIONS_AGENT',
            'READ_ONLY_TRACKING_USER',
          ]),
        })
        .parse(request.body);

      const partner = await prisma.logisticsPartner.findFirst({
        where: { id: params.id, archivedAt: null },
        select: { displayName: true },
      });

      const invitation = await inviteAsOperator(actorFor(request), params.id, body);

      await sendActivationEmail({
        to: invitation.email,
        fullName: body.fullName,
        partnerName: partner?.displayName ?? 'the logistics partner',
        token: invitation.token,
        expiresAt: invitation.expiresAt,
      });

      return reply
        .status(201)
        .send({ email: invitation.email, expiresAt: invitation.expiresAt });
    },
  );

  // --- Shipments ----------------------------------------------------------

  /**
   * Every consignment, across every carrier, narrowed the way an operations
   * desk actually thinks about them.
   *
   * WHY SO MANY FILTERS
   *
   * This screen answers questions that cross tenants, which is the one thing
   * no carrier's own portal can do: "what is going wrong for St Luke's this
   * week", "is Northwind's stock stuck at one depot", "which of DHL's drivers
   * has our failures". Each of those is a different axis, and an operator who
   * cannot ask on the axis they care about ends up paging through everything.
   *
   * Every filter narrows on the SERVER and every one of them has an index
   * behind it - `ix_logistics_shipment_seller`, `_receiver`, `_origin`,
   * `_status`, `_partner_status`, and `ix_logistics_driver_assignment_driver_time`
   * for the driver. A list expected to run to tens of thousands of rows cannot
   * afford a filter that scans.
   *
   * THE SUMMARY IS COUNTED OVER THE SAME FILTER
   *
   * Not over everything. A desk that has filtered to one carrier and still
   * sees the whole marketplace's totals above the table is a desk that reads
   * the wrong number - the tiles have to describe the list underneath them.
   */
  app.get(
    '/logistics/shipments',
    { preHandler: requireAdmin(Permission.LOGISTICS_READ) },
    async (request, reply) => {
      const query = z
        .object({
          status: z.enum(ShipmentStatusValues).optional(),
          partnerId: z.string().length(26).optional(),
          unassignedOnly: z.coerce.boolean().optional(),
          /** Consignments with a problem open on them, whatever their status. */
          exceptionsOnly: z.coerce.boolean().optional(),
          /** The business receiving it. */
          customerProfileId: z.string().length(26).optional(),
          /** The business whose goods these are. */
          sellerAccountId: z.string().length(26).optional(),
          /** The building it is collected from. */
          warehouseId: z.string().length(26).optional(),
          /** The person carrying it, through their live assignment. */
          driverProfileId: z.string().length(26).optional(),
          /** Raised on or after this instant. */
          from: z.coerce.date().optional(),
          /** Raised before this instant. */
          to: z.coerce.date().optional(),
          search: z.string().trim().max(120).optional(),
          page: z.coerce.number().int().min(1).max(10_000).optional(),
          pageSize: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(request.query);

      const page = query.page ?? 1;
      const pageSize = query.pageSize ?? 25;

      const where: Prisma.LogisticsShipmentWhereInput = {
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.partnerId !== undefined ? { assignedPartnerId: query.partnerId } : {}),
        ...(query.unassignedOnly === true ? { assignedPartnerId: null } : {}),
        ...(query.customerProfileId !== undefined
          ? { receivingCustomerProfileId: query.customerProfileId }
          : {}),
        ...(query.sellerAccountId !== undefined
          ? { sellerAccountId: query.sellerAccountId }
          : {}),
        ...(query.warehouseId !== undefined ? { originLocationId: query.warehouseId } : {}),
        /*
         * The driver filter goes through the ASSIGNMENT rather than through a
         * column on the shipment, because there is no such column and there
         * should not be: a consignment's driver is a fact with a history, and
         * denormalising it would be a second place for that history to
         * disagree with itself. `unassignedAt: null` narrows it to whoever has
         * it now.
         */
        ...(query.driverProfileId !== undefined
          ? {
              driverAssignments: {
                some: { driverProfileId: query.driverProfileId, unassignedAt: null },
              },
            }
          : {}),
        /*
         * OPEN and ESCALATED only, the same set the navigation rail counts.
         * ACKNOWLEDGED and IN_PROGRESS are problems somebody is already
         * holding, and a filter that returned those would never empty.
         */
        ...(query.exceptionsOnly === true
          ? { exceptions: { some: { state: { in: ['OPEN', 'ESCALATED'] } } } }
          : {}),
        ...(query.from !== undefined || query.to !== undefined
          ? {
              createdAt: {
                ...(query.from === undefined ? {} : { gte: query.from }),
                ...(query.to === undefined ? {} : { lt: query.to }),
              },
            }
          : {}),
        ...(query.search !== undefined
          ? {
              OR: [
                { shipmentReference: { contains: query.search } },
                { trackingNumber: { contains: query.search } },
                { receivingCompanyName: { contains: query.search } },
                { sellerCompanyName: { contains: query.search } },
                { order: { orderNumber: { contains: query.search } } },
              ],
            }
          : {}),
      };

      const [total, shipments, byStatus, exceptionCount] = await Promise.all([
        prisma.logisticsShipment.count({ where }),
        prisma.logisticsShipment.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: {
            id: true,
            shipmentReference: true,
            trackingNumber: true,
            status: true,
            slaState: true,
            sellerCompanyName: true,
            receivingCompanyName: true,
            destinationCity: true,
            destinationCountry: true,
            packageCount: true,
            expectedPickupAt: true,
            estimatedDeliveryAt: true,
            lastEventAt: true,
            createdAt: true,
            assignedPartner: { select: { id: true, displayName: true } },
            order: { select: { id: true, orderNumber: true } },
            originLocation: { select: { id: true, name: true, code: true } },
            /*
             * The live driver, one row per shipment.
             *
             * `take: 1` over the filtered relation rather than a join on every
             * assignment ever made: a consignment that has changed hands three
             * times has three rows and the list wants the one that counts.
             */
            driverAssignments: {
              where: { unassignedAt: null },
              take: 1,
              select: {
                id: true,
                assignedAt: true,
                driver: {
                  select: { id: true, fullName: true },
                },
              },
            },
            exceptions: {
              where: { state: { in: ['OPEN', 'ESCALATED'] } },
              take: 1,
              select: { id: true, type: true, severity: true },
            },
          },
        }),
        // One grouped query for the tiles rather than six counts. The desk
        // reads these before it reads the table, and they have to describe the
        // filtered list rather than the whole marketplace.
        prisma.logisticsShipment.groupBy({
          by: ['status'],
          where,
          _count: { _all: true },
        }),
        prisma.logisticsShipment.count({
          where: {
            AND: [where, { exceptions: { some: { state: { in: ['OPEN', 'ESCALATED'] } } } }],
          },
        }),
      ]);

      const counts = new Map(byStatus.map((row) => [row.status, row._count._all]));
      const sum = (statuses: readonly ShipmentStatusName[]): number =>
        statuses.reduce((running, status) => running + (counts.get(status) ?? 0), 0);

      return reply.header('cache-control', 'no-store').status(200).send({
        shipments: shipments.map((row) => {
          const { driverAssignments, exceptions, ...rest } = row;
          const live = driverAssignments[0];

          return {
            ...rest,
            // Flattened, because "who has it" is one column on the table and a
            // nested array of one would make every consumer unwrap it.
            driver:
              live === undefined
                ? null
                : {
                    assignmentId: live.id,
                    driverProfileId: live.driver.id,
                    fullName: live.driver.fullName,
                    assignedAt: live.assignedAt,
                  },
            openException: exceptions[0] ?? null,
          };
        }),
        total,
        page,
        pageCount: Math.max(1, Math.ceil(total / pageSize)),
        summary: {
          /** Raised, and nobody has taken it yet. */
          awaitingAssignment: sum(['CREATED', 'AWAITING_ASSIGNMENT', 'ACCEPTANCE_PENDING']),
          /** On a carrier's books, not yet collected. */
          accepted: sum(['ASSIGNED', 'ACCEPTED', 'PICKUP_SCHEDULED', 'READY_FOR_PICKUP']),
          inTransit: sum([
            'PICKED_UP',
            'DISPATCHED',
            'AT_ORIGIN_HUB',
            'IN_TRANSIT',
            'AT_DESTINATION_HUB',
          ]),
          outForDelivery: sum(['OUT_FOR_DELIVERY', 'DELIVERY_ATTEMPTED']),
          delivered: sum(['DELIVERED']),
          /** Anything gone wrong, by status. */
          failed: sum([
            'DELAYED',
            'ON_HOLD',
            'ADDRESS_ISSUE',
            'CUSTOMS_HOLD',
            'DAMAGED',
            'TEMPERATURE_EXCEPTION',
            'DELIVERY_FAILED',
            'LOST',
          ]),
          returned: sum(['RETURN_REQUESTED', 'RETURN_IN_TRANSIT', 'RETURNED']),
          cancelled: sum(['CANCELLED']),
          /**
           * Consignments with an open EXCEPTION, which is a different question
           * from the statuses above: a parcel can be in transit and still have
           * an address problem nobody has worked.
           */
          withOpenException: exceptionCount,
        },
      });
    },
  );

  /**
   * What there is to filter the tracking list BY.
   *
   * Derived from the consignments that exist rather than from the tables
   * behind them, and that is the whole design: a seller picker listing every
   * approved seller on the marketplace is a picker mostly full of businesses
   * that have never shipped anything, and an operator scrolling it learns
   * nothing. Grouping the shipment table gives the companies, buildings and
   * drivers that actually appear in the list underneath.
   *
   * Every list is capped. This is chrome for a filter bar, not a directory -
   * the Companies screen is the directory, and anybody who needs to find a
   * business rather than narrow a list should be there.
   */
  app.get(
    '/logistics/tracking-filters',
    { preHandler: requireAdmin(Permission.LOGISTICS_READ) },
    async (_request, reply) => {
      const [sellers, customers, warehouses, partners, drivers] = await Promise.all([
        prisma.logisticsShipment.groupBy({
          by: ['sellerAccountId', 'sellerCompanyName'],
          where: { sellerAccountId: { not: null } },
          _count: { _all: true },
          orderBy: { _count: { id: 'desc' } },
          take: FILTER_OPTION_LIMIT,
        }),
        prisma.logisticsShipment.groupBy({
          by: ['receivingCustomerProfileId', 'receivingCompanyName'],
          where: { receivingCustomerProfileId: { not: null } },
          _count: { _all: true },
          orderBy: { _count: { id: 'desc' } },
          take: FILTER_OPTION_LIMIT,
        }),
        prisma.inventoryLocation.findMany({
          // Only buildings consignments are actually collected from. A
          // warehouse that has never dispatched one would filter to nothing.
          where: { logisticsShipments: { some: {} } },
          orderBy: [{ name: 'asc' }],
          take: FILTER_OPTION_LIMIT,
          select: { id: true, name: true, code: true },
        }),
        prisma.logisticsPartner.findMany({
          orderBy: [{ displayName: 'asc' }],
          take: FILTER_OPTION_LIMIT,
          select: { id: true, displayName: true, partnerCode: true, status: true },
        }),
        prisma.logisticsDriverProfile.findMany({
          // Drivers who have carried something. A fleet register belongs to
          // the carrier's own portal; this is the subset the operator can
          // usefully filter on.
          where: { assignments: { some: {} } },
          orderBy: [{ createdAt: 'asc' }],
          take: FILTER_OPTION_LIMIT,
          select: {
            id: true,
            state: true,
            fullName: true,
            partner: { select: { id: true, displayName: true } },
          },
        }),
      ]);

      return reply.header('cache-control', 'no-store').status(200).send({
        sellers: sellers
          .filter((row) => row.sellerAccountId !== null)
          .map((row) => ({
            id: row.sellerAccountId,
            name: row.sellerCompanyName,
            shipmentCount: row._count._all,
          })),
        customers: customers
          .filter((row) => row.receivingCustomerProfileId !== null)
          .map((row) => ({
            id: row.receivingCustomerProfileId,
            name: row.receivingCompanyName,
            shipmentCount: row._count._all,
          })),
        warehouses,
        partners,
        drivers: drivers.map((row) => ({
          id: row.id,
          fullName: row.fullName,
          state: row.state,
          partnerId: row.partner.id,
          partnerName: row.partner.displayName,
        })),
      });
    },
  );

  /**
   * One consignment, as the operator sees it.
   *
   * The carrier's own view of the same row is `shipment.service.ts`, and the
   * two are deliberately different. That one masks a recipient's telephone
   * number down to a prefix and hides the declared value entirely, because a
   * haulier has no business with either; this one does not, because the
   * marketplace is the party that holds the customer relationship and it is
   * the one answering the telephone when a delivery goes wrong.
   *
   * The timeline is capped rather than paged. Two hundred events is a parcel
   * that has been round the country twice, and a screen that pages through a
   * timeline is a screen where nobody ever reads the beginning.
   */
  app.get(
    '/logistics/shipments/:id',
    { preHandler: requireAdmin(Permission.LOGISTICS_READ) },
    async (request, reply) => {
      const params = idParam.parse(request.params);

      const shipment = await prisma.logisticsShipment.findUnique({
        where: { id: params.id },
        select: {
          id: true,
          shipmentReference: true,
          trackingNumber: true,
          status: true,
          serviceType: true,
          slaState: true,
          sellerCompanyName: true,
          receivingCompanyName: true,
          pickupAddressJson: true,
          deliveryAddressJson: true,
          pickupContactName: true,
          pickupContactPhone: true,
          pickupContactEmail: true,
          deliveryContactName: true,
          deliveryContactPhone: true,
          deliveryContactEmail: true,
          originCountry: true,
          destinationCountry: true,
          destinationCity: true,
          destinationPostalCode: true,
          packageCount: true,
          totalWeightGrams: true,
          productCategorySummary: true,
          requiresColdChain: true,
          requiresTemperatureRange: true,
          temperatureMinC: true,
          temperatureMaxC: true,
          requiresSterileHandling: true,
          isFragile: true,
          isDangerousGoods: true,
          dangerousGoodsClass: true,
          handlingNotes: true,
          declaredValueMinor: true,
          currency: true,
          expectedPickupAt: true,
          pickupDueAt: true,
          estimatedDeliveryAt: true,
          deliveryDueAt: true,
          acceptedAt: true,
          pickedUpAt: true,
          dispatchedAt: true,
          deliveredAt: true,
          deliveryAttemptCount: true,
          lastEventAt: true,
          lastCarrierSyncAt: true,
          carrierTrackingNumber: true,
          carrierTrackingUrl: true,
          createdAt: true,
          order: { select: { id: true, orderNumber: true } },
          assignedPartner: { select: { id: true, displayName: true, partnerCode: true } },
          carrierIntegration: { select: { id: true, name: true, provider: true, state: true } },
          assignments: {
            orderBy: { offeredAt: 'desc' },
            take: 50,
            select: {
              id: true,
              state: true,
              assignedAutomatically: true,
              offeredAt: true,
              respondBy: true,
              respondedAt: true,
              responseReason: true,
              withdrawnAt: true,
              withdrawnReason: true,
              completedAt: true,
              partner: { select: { id: true, displayName: true } },
            },
          },
          exceptions: {
            orderBy: { createdAt: 'desc' },
            take: 50,
            select: {
              id: true,
              type: true,
              severity: true,
              state: true,
              reason: true,
              resolutionDueAt: true,
              revisedEtaAt: true,
              resolvedAt: true,
              createdAt: true,
            },
          },
          events: {
            orderBy: [{ occurredAt: 'desc' }, { recordedAt: 'desc' }],
            take: 200,
            select: {
              id: true,
              previousStatus: true,
              status: true,
              publicDescription: true,
              internalNote: true,
              occurredAt: true,
              recordedAt: true,
              locationLabel: true,
              locationCountry: true,
              source: true,
              externalStatusCode: true,
              isCorrection: true,
              reason: true,
            },
          },
        },
      });

      if (shipment === null) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'That consignment was not found.',
            details: [],
            correlationId: request.correlationId,
          },
        });
      }

      const { declaredValueMinor, temperatureMinC, temperatureMaxC, ...rest } = shipment;

      /*
       * Everyone who has carried it, read after the row rather than joined
       * into it.
       *
       * Its own query because it is the same reader the carrier's own screen
       * uses - one chain, one shape, so the two screens cannot describe the
       * same handover differently. The tenant check has already happened: this
       * route is behind `logistics.read`, which is the marketplace's own
       * authority over every consignment.
       */
      const driverAssignments = await readDriverAssignmentHistory(shipment.id);

      return reply.status(200).send({
        ...rest,
        driverAssignments,
        /** Whoever has it right now, flattened out of the chain above. */
        driver: driverAssignments.find((entry) => entry.isActive) ?? null,
        /*
         * Money as a string, and coordinates-style decimals likewise. A
         * `BigInt` has no JSON form and a `Decimal` serialises to an object;
         * both become a string here, which is what every other money path in
         * this API does.
         */
        declaredValueMinor: declaredValueMinor === null ? null : declaredValueMinor.toString(),
        temperatureMinC: temperatureMinC === null ? null : temperatureMinC.toString(),
        temperatureMaxC: temperatureMaxC === null ? null : temperatureMaxC.toString(),
        /*
         * What an operator may move it to, from where it is now. The same
         * adjacency list the carrier's own screen reads, so the two offer the
         * same choices; `correct-status` is the separate door out of a
         * terminal state and is not listed here.
         */
        allowedTransitions: allowedShipmentTransitions(shipment.status, 'UBOSS_ADMIN'),
      });
    },
  );

  /**
   * Raise the consignments for an order.
   *
   * Idempotent: one per seller group and warehouse, and re-running returns
   * what already exists. Safe to press twice, and safe for the order module to
   * call again after a retried webhook.
   */
  app.post(
    '/logistics/orders/:id/shipments',
    { preHandler: requireAdmin(Permission.LOGISTICS_ASSIGN) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const auth = currentUser(request);

      const created = await createShipmentsForOrder(params.id, auth.id);
      return reply.status(201).send({ shipments: created });
    },
  );

  app.get(
    '/logistics/shipments/:id/eligible-partners',
    { preHandler: requireAdmin(Permission.LOGISTICS_ASSIGN) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const partners = await findEligiblePartners(params.id);
      return reply.status(200).send({ partners });
    },
  );

  app.post(
    '/logistics/shipments/:id/assign',
    { preHandler: requireAdmin(Permission.LOGISTICS_ASSIGN) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z
        .object({
          logisticsPartnerId: z.string().length(26),
          respondByHours: z.number().int().min(1).max(720).optional(),
        })
        .parse(request.body);

      const auth = currentUser(request);

      const result = await offerAssignment({
        shipmentId: params.id,
        logisticsPartnerId: body.logisticsPartnerId,
        offeredByUserId: auth.id,
        automatic: false,
        respondByHours: body.respondByHours ?? null,
        correlationId: request.correlationId,
      });

      return reply.status(201).send(result);
    },
  );

  app.post(
    '/logistics/shipments/:id/withdraw',
    { preHandler: requireAdmin(Permission.LOGISTICS_ASSIGN) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z.object({ reason: z.string().trim().min(4).max(512) }).parse(request.body);
      const auth = currentUser(request);

      await withdrawAssignment({
        shipmentId: params.id,
        reason: body.reason,
        actorUserId: auth.id,
        correlationId: request.correlationId,
      });

      return reply.status(204).send();
    },
  );

  /**
   * Correct a status the carrier got wrong.
   *
   * The only way out of DELIVERED, RETURNED, LOST or CANCELLED in the wrong
   * direction, and it demands a written reason of at least eight characters.
   * The resulting event is flagged as a correction, so a corrected timeline
   * reads as corrected months later rather than as a parcel that went
   * backwards.
   */
  app.post(
    '/logistics/shipments/:id/correct-status',
    { preHandler: requireAdmin(Permission.LOGISTICS_ASSIGN) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z
        .object({
          status: z.enum(ShipmentStatusValues),
          reason: z.string().trim().min(8).max(512),
        })
        .parse(request.body);

      const result = await correctShipmentStatus(
        actorFor(request),
        params.id,
        body.status,
        body.reason,
      );

      return reply.status(200).send(result);
    },
  );

  // --- A carrier’s fleet, from the operations desk ---------------------
  //
  // Every route below is the marketplace doing what the carrier’s own portal
  // does, through the SAME service functions. Not a parallel implementation:
  // `FleetActor` is the one seam, so a rule about who may drive what is
  // written once and holds on both sides. The difference is only how
  // authority is proved - a carrier by its own permissions, the marketplace
  // by an admin grant - and which name lands in the carrier’s audit trail.

  app.get(
    '/logistics/partners/:id/drivers',
    { preHandler: requireAdmin(Permission.LOGISTICS_READ) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const drivers = await listDrivers(fleetActorFor(request, params.id));
      return reply.status(200).send({ drivers });
    },
  );

  /**
   * Add somebody to a carrier’s fleet, on their behalf.
   *
   * A name is all that is required, exactly as in the portal. The operations
   * desk takes these over the phone from hauliers who will never open the
   * software, and a register that could only hold people with a login is a
   * register that does not describe the fleet.
   */
  app.post(
    '/logistics/partners/:id/drivers',
    { preHandler: requireAdmin(Permission.LOGISTICS_WRITE) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z
        .object({
          fullName: z.string().trim().min(2).max(160),
          phone: z.string().trim().max(32).optional(),
          email: z.string().trim().email().max(320).optional(),
          employeeReference: z.string().trim().max(64).optional(),
          licenceNumber: z.string().trim().max(64).optional(),
          licenceExpiresAt: isoDate.optional(),
          canCarryDangerousGoods: z.boolean().optional(),
          canCarryColdChain: z.boolean().optional(),
          canCarrySterile: z.boolean().optional(),
          state: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']).optional(),
          partnerUserId: z.string().length(26).optional(),
        })
        .parse(request.body);

      const driver = await createDriver(
        fleetActorFor(request, params.id),
        body,
        request.correlationId,
      );

      return reply.status(201).send(driver);
    },
  );

  app.patch(
    '/logistics/partners/:id/drivers/:driverId',
    { preHandler: requireAdmin(Permission.LOGISTICS_WRITE) },
    async (request, reply) => {
      const params = z
        .object({ id: z.string().length(26), driverId: z.string().length(26) })
        .parse(request.params);
      const body = z
        .object({
          fullName: z.string().trim().min(2).max(160).optional(),
          phone: z.string().trim().max(32).nullable().optional(),
          email: z.string().trim().max(320).nullable().optional(),
          employeeReference: z.string().trim().max(64).nullable().optional(),
          licenceNumber: z.string().trim().max(64).nullable().optional(),
          licenceExpiresAt: isoDate.nullable().optional(),
          canCarryDangerousGoods: z.boolean().optional(),
          canCarryColdChain: z.boolean().optional(),
          canCarrySterile: z.boolean().optional(),
          state: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']).optional(),
          partnerUserId: z.string().length(26).nullable().optional(),
        })
        .parse(request.body);

      const driver = await updateDriver(
        fleetActorFor(request, params.id),
        params.driverId,
        body,
        request.correlationId,
      );

      return reply.status(200).send(driver);
    },
  );

  app.get(
    '/logistics/partners/:id/vehicles',
    { preHandler: requireAdmin(Permission.LOGISTICS_READ) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const vehicles = await listVehicles(fleetActorFor(request, params.id));
      return reply.status(200).send({ vehicles });
    },
  );

  app.post(
    '/logistics/partners/:id/vehicles',
    { preHandler: requireAdmin(Permission.LOGISTICS_WRITE) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z
        .object({
          registration: z.string().trim().min(1).max(32),
          kind: z.enum([
            'VAN',
            'TRUCK',
            'BIKE',
            'CAR',
            'REFRIGERATED_VAN',
            'REFRIGERATED_TRUCK',
          ]),
          hasRefrigeration: z.boolean().optional(),
          hasTailLift: z.boolean().optional(),
          temperatureMinC: z.number().min(-100).max(100).optional(),
          temperatureMaxC: z.number().min(-100).max(100).optional(),
          maxWeightGrams: z.number().int().min(0).max(100_000_000).optional(),
        })
        .parse(request.body);

      const vehicle = await createVehicle(
        fleetActorFor(request, params.id),
        body,
        request.correlationId,
      );

      return reply.status(201).send(vehicle);
    },
  );

  /**
   * Put a driver on a consignment, or move it to another driver.
   *
   * The fleet is the one the consignment is already with, derived rather than
   * accepted, so this cannot put one carrier’s driver on another’s parcel.
   */
  app.post(
    '/logistics/shipments/:id/assign-driver',
    { preHandler: requireAdmin(Permission.LOGISTICS_ASSIGN) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z
        .object({
          driverProfileId: z.string().length(26),
          vehicleId: z.string().length(26).optional(),
          isPickupLeg: z.boolean().optional(),
          isDeliveryLeg: z.boolean().optional(),
          routeSequence: z.number().int().min(0).max(999).optional(),
          reason: z.string().trim().max(512).optional(),
        })
        .parse(request.body);

      const partnerId = await carrierHoldingShipment(params.id);

      const result = await assignDriver(
        fleetActorFor(request, partnerId),
        {
          shipmentId: params.id,
          driverProfileId: body.driverProfileId,
          vehicleId: body.vehicleId ?? null,
          isPickupLeg: body.isPickupLeg ?? false,
          isDeliveryLeg: body.isDeliveryLeg ?? true,
          routeSequence: body.routeSequence ?? null,
          reason: body.reason ?? null,
        },
        request.correlationId,
      );

      return reply.status(201).send(result);
    },
  );

  app.post(
    '/logistics/shipments/:id/unassign-driver',
    { preHandler: requireAdmin(Permission.LOGISTICS_ASSIGN) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z.object({ reason: z.string().trim().min(4).max(512) }).parse(request.body);

      const partnerId = await carrierHoldingShipment(params.id);

      const result = await unassignDriver(
        fleetActorFor(request, partnerId),
        params.id,
        body.reason,
        request.correlationId,
      );

      return reply.status(200).send(result);
    },
  );


  /**
   * Move the consignment along: dispatched, on the way, delivered.
   *
   * The ordinary forward move, and distinct from `correct-status` in the way
   * that matters to anybody reading the timeline afterwards: this one is not
   * flagged as a correction, because nothing is being corrected. A carrier who
   * cannot reach their own portal rings the desk, and the parcel keeps moving
   * on the customer’s tracking page.
   *
   * `Idempotency-Key` is honoured, so a dispatcher on a bad line who presses
   * the button twice writes one event.
   */
  app.post(
    '/logistics/shipments/:id/status-events',
    { preHandler: requireAdmin(Permission.LOGISTICS_ASSIGN) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z
        .object({
          status: z.enum(ShipmentStatusValues),
          reason: z.string().trim().max(512).optional(),
          publicDescription: z.string().trim().max(512).optional(),
          internalNote: z.string().trim().max(2000).optional(),
          occurredAt: isoDate.optional(),
          locationLabel: z.string().trim().max(255).optional(),
          locationCountry: z.string().length(2).optional(),
          hasProofOfDelivery: z.boolean().optional(),
        })
        .parse(request.body);

      const suppliedKey = request.headers['idempotency-key'];

      const result = await advanceShipmentStatus(actorFor(request), params.id, body.status, {
        reason: body.reason ?? null,
        publicDescription: body.publicDescription ?? null,
        internalNote: body.internalNote ?? null,
        occurredAt: body.occurredAt ?? null,
        locationLabel: body.locationLabel ?? null,
        locationCountry: body.locationCountry ?? null,
        hasProofOfDelivery: body.hasProofOfDelivery ?? false,
        idempotencyKey: typeof suppliedKey === 'string' ? suppliedKey : null,
      });

      return reply.status(result.duplicate ? 200 : 201).send(result);
    },
  );

  app.get(
    '/logistics/exceptions',
    { preHandler: requireAdmin(Permission.LOGISTICS_READ) },
    async (request, reply) => {
      const query = z
        .object({
          openOnly: z.coerce.boolean().optional(),
          severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
          page: z.coerce.number().int().min(1).max(10_000).optional(),
          pageSize: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(request.query);

      const page = query.page ?? 1;
      const pageSize = query.pageSize ?? 25;

      const where: Prisma.LogisticsShipmentExceptionWhereInput = {
        ...(query.openOnly !== false ? { state: { in: [...OPEN_EXCEPTION_STATES] } } : {}),
        ...(query.severity !== undefined ? { severity: query.severity } : {}),
      };

      const [total, exceptions] = await Promise.all([
        prisma.logisticsShipmentException.count({ where }),
        prisma.logisticsShipmentException.findMany({
          where,
          orderBy: [{ severity: 'desc' }, { createdAt: 'asc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: {
            id: true,
            shipmentId: true,
            type: true,
            severity: true,
            state: true,
            reason: true,
            resolutionDueAt: true,
            revisedEtaAt: true,
            createdAt: true,
            shipment: {
              select: { shipmentReference: true, receivingCompanyName: true },
            },
            partner: { select: { id: true, displayName: true } },
          },
        }),
      ]);

      return reply.status(200).send({
        exceptions,
        total,
        page,
        pageCount: Math.max(1, Math.ceil(total / pageSize)),
      });
    },
  );

  // --- Integrations -------------------------------------------------------

  app.get(
    '/logistics/integrations',
    { preHandler: requireAdmin(Permission.LOGISTICS_READ) },
    async (_request, reply) => {
      const integrations = await listIntegrations(env.API_PUBLIC_URL);

      return reply.status(200).send({
        integrations,
        // What each provider needs, so the screen can say so rather than
        // leaving an operator guessing which key is missing.
        providers: describeProviders(),
      });
    },
  );

  app.put(
    '/logistics/integrations',
    { preHandler: requireAdmin(Permission.LOGISTICS_INTEGRATION_WRITE) },
    async (request, reply) => {
      const body = z
        .object({
          id: z.string().length(26).optional(),
          provider: z.enum(['MANUAL', 'CUSTOM', 'DHL', 'FEDEX', 'UPS']),
          name: z.string().trim().min(2).max(120),
          baseUrl: z.string().trim().max(512).optional(),
          credentials: z.record(z.string(), z.string().max(2048)).optional(),
          pollingEnabled: z.boolean().optional(),
          pollingIntervalMinutes: z.number().int().min(1).max(1440).optional(),
          rateLimitPerMinute: z.number().int().min(1).max(10_000).optional(),
          webhookSignatureHeader: z.string().trim().max(64).optional(),
          webhookTimestampHeader: z.string().trim().max(64).optional(),
          webhookAlgorithm: z.enum(['sha256', 'sha512']).optional(),
          webhookToleranceSeconds: z.number().int().min(30).max(3600).optional(),
          isActive: z.boolean().optional(),
        })
        .parse(request.body);

      const result = await upsertIntegration(actorFor(request), body);
      return reply.status(200).send(result);
    },
  );

  app.post(
    '/logistics/integrations/:id/test',
    { preHandler: requireAdmin(Permission.LOGISTICS_INTEGRATION_WRITE) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const result = await testIntegration(actorFor(request), params.id);
      return reply.status(200).send(result);
    },
  );

  /**
   * Mint a new webhook signing secret.
   *
   * Step-up guarded by the narrowest permission in the admin catalogue, and
   * the secret is in THIS response and no other. There is no endpoint that
   * reads it back.
   */
  app.post(
    '/logistics/integrations/:id/rotate-secret',
    {
      preHandler: requireAdmin(Permission.LOGISTICS_INTEGRATION_WRITE),
      config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const rotated = await rotateWebhookSecret(actorFor(request), params.id);

      return reply.header('cache-control', 'no-store').status(200).send({
        secret: rotated.secret,
        webhookUrl: `${env.API_PUBLIC_URL.replace(/\/$/, '')}/api/v1/integrations/carriers/${rotated.webhookPathToken}/webhook`,
        // Said plainly, because it is true and because somebody will close the
        // dialog before copying it.
        notice:
          'This is the only time this secret is shown. Paste it into the carrier console now; ' +
          'if you lose it, rotate again.',
      });
    },
  );

  app.put(
    '/logistics/integrations/:id/status-mappings',
    { preHandler: requireAdmin(Permission.LOGISTICS_INTEGRATION_WRITE) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z
        .object({
          providerCode: z.string().trim().min(1).max(64),
          canonicalStatus: z.enum(ShipmentStatusValues).nullable(),
          raisesExceptionType: z.string().trim().max(48).nullable().optional(),
          publicDescription: z.string().trim().max(255).optional(),
          note: z.string().trim().max(255).optional(),
        })
        .parse(request.body);

      await upsertStatusMapping(actorFor(request), params.id, {
        providerCode: body.providerCode,
        canonicalStatus: body.canonicalStatus,
        raisesExceptionType: body.raisesExceptionType ?? null,
        publicDescription: body.publicDescription ?? null,
        note: body.note ?? null,
      });

      return reply.status(204).send();
    },
  );

  /** What this build already knows about a provider's codes. */
  app.get(
    '/logistics/integrations/known-codes',
    { preHandler: requireAdmin(Permission.LOGISTICS_READ) },
    async (request, reply) => {
      const query = z.object({ provider: z.string().trim().max(24) }).parse(request.query);

      if (!isCarrierProvider(query.provider)) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_FAILED',
            message: 'That is not a provider this build knows.',
            details: [{ field: 'provider', code: 'UNKNOWN_PROVIDER' }],
            correlationId: request.correlationId,
          },
        });
      }

      return reply.status(200).send({ codes: knownCarrierCodes(query.provider) });
    },
  );

  return Promise.resolve();
}

/**
 * Running the day: collections, manifests, exceptions, drivers and vehicles.
 *
 * One file because these are one workspace to a dispatcher, and because the
 * guards are the interesting part - each route declares the narrowest
 * permission that covers it, so a tracking viewer reading the pickup board
 * cannot reach the driver assignment two routes below it.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LogisticsPermission } from '../../domain/logistics-permissions.js';
import { listExceptions, updateException } from '../../modules/logistics/exception.service.js';
import {
  asPartner,
  assignDriver,
  createDriver,
  createVehicle,
  findScannedPackage,
  listDrivers,
  listVehicles,
  recordPackageScan,
  unassignDriver,
  updateDriver,
} from '../../modules/logistics/driver.service.js';
import { readDriverAssignmentHistory } from '../../modules/logistics/driver-assignment.service.js';
import { assertShipmentAccess } from '../../modules/logistics/shipment.service.js';
import {
  completePickup,
  confirmPickupReadiness,
  createManifest,
  failPickup,
  handOverManifest,
  listManifests,
  listPickups,
  readManifestForPrint,
  schedulePickup,
} from '../../modules/logistics/operations.service.js';
import { currentLogistics, requireLogistics } from '../plugins/logistics.js';

const idParam = z.object({ id: z.string().length(26) });
const isoDate = z.coerce.date();

export function registerLogisticsOperationsRoutes(app: FastifyInstance): Promise<void> {
  // --- Collections --------------------------------------------------------

  /**
   * The pickup board: this carrier's collections in window order, filterable
   * by state, date range, driver or warehouse.
   */
  app.get(
    '/pickups',
    { preHandler: requireLogistics(LogisticsPermission.PICKUP_READ) },
    async (request, reply) => {
      const query = z
        .object({
          state: z
            .union([
              z.enum(['REQUESTED', 'SCHEDULED', 'CONFIRMED', 'COMPLETED', 'FAILED', 'CANCELLED']),
              z.array(
                z.enum(['REQUESTED', 'SCHEDULED', 'CONFIRMED', 'COMPLETED', 'FAILED', 'CANCELLED']),
              ),
            ])
            .optional(),
          from: isoDate.optional(),
          to: isoDate.optional(),
          driverProfileId: z.string().length(26).optional(),
          locationId: z.string().length(26).optional(),
        })
        .parse(request.query);

      const pickups = await listPickups(currentLogistics(request), {
        state:
          query.state === undefined
            ? null
            : Array.isArray(query.state)
              ? query.state
              : [query.state],
        from: query.from ?? null,
        to: query.to ?? null,
        driverProfileId: query.driverProfileId ?? null,
        locationId: query.locationId ?? null,
      });

      return reply.header('cache-control', 'no-store').status(200).send({ pickups });
    },
  );

  /**
   * Book a collection window for a shipment, optionally with a driver and
   * vehicle, and move the shipment to "pickup scheduled". Refused when the
   * window ends before it starts, or the driver or vehicle is not this
   * carrier's.
   */
  app.post(
    '/pickups',
    { preHandler: requireLogistics(LogisticsPermission.PICKUP_WRITE) },
    async (request, reply) => {
      const body = z
        .object({
          shipmentId: z.string().length(26),
          windowStartAt: isoDate,
          windowEndAt: isoDate,
          timezone: z.string().trim().max(64).optional(),
          driverProfileId: z.string().length(26).optional(),
          vehicleId: z.string().length(26).optional(),
          warehouseInstructions: z.string().trim().max(1024).optional(),
        })
        .parse(request.body);

      const result = await schedulePickup(
        currentLogistics(request),
        {
          shipmentId: body.shipmentId,
          windowStartAt: body.windowStartAt,
          windowEndAt: body.windowEndAt,
          timezone: body.timezone ?? null,
          driverProfileId: body.driverProfileId ?? null,
          vehicleId: body.vehicleId ?? null,
          warehouseInstructions: body.warehouseInstructions ?? null,
        },
        request.correlationId,
      );

      return reply.status(201).send(result);
    },
  );

  /**
   * Confirm that the goods are ready on the dock for a booked collection.
   * Refused when the collection is no longer waiting to be confirmed.
   */
  app.post(
    '/pickups/:id/confirm',
    { preHandler: requireLogistics(LogisticsPermission.PICKUP_WRITE) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      await confirmPickupReadiness(currentLogistics(request), params.id);
      return reply.status(204).send();
    },
  );

  /**
   * The van came and took the goods.
   *
   * Idempotent on the `Idempotency-Key` header, which a driver's phone should
   * always send: a queued action flushed twice completes one collection. A
   * repeat answers 200 with `duplicate: true` rather than an error, because a
   * phone told "that failed" will try again.
   */
  app.post(
    '/pickups/:id/complete',
    { preHandler: requireLogistics(LogisticsPermission.PICKUP_WRITE) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z
        .object({
          packagesCollected: z.coerce.number().int().min(0).max(10_000).optional(),
          occurredAt: isoDate.optional(),
        })
        .parse(request.body ?? {});

      const suppliedKey = request.headers['idempotency-key'];

      const result = await completePickup(
        currentLogistics(request),
        {
          pickupId: params.id,
          packagesCollected: body.packagesCollected ?? null,
          occurredAt: body.occurredAt ?? null,
          idempotencyKey: typeof suppliedKey === 'string' ? suppliedKey : null,
        },
        request.correlationId,
      );

      return reply.status(200).send(result);
    },
  );

  /**
   * Record that a collection could not be made, with the reason. Raises a
   * high-severity missed-collection problem on the shipment. Refused once the
   * collection is already completed or cancelled.
   */
  app.post(
    '/pickups/:id/fail',
    { preHandler: requireLogistics(LogisticsPermission.PICKUP_WRITE) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z.object({ reason: z.string().trim().min(4).max(512) }).parse(request.body);

      await failPickup(currentLogistics(request), params.id, body.reason, request.correlationId);
      return reply.status(204).send();
    },
  );

  // --- Dispatch -----------------------------------------------------------

  /**
   * List this carrier's load lists, newest first, with the driver, vehicle and
   * how many consignments and packages each carries. Can be filtered by state.
   */
  app.get(
    '/dispatch-manifests',
    { preHandler: requireLogistics(LogisticsPermission.DISPATCH_READ) },
    async (request, reply) => {
      const query = z
        .object({
          state: z
            .union([
              z.enum(['OPEN', 'CLOSED', 'HANDED_OVER', 'CANCELLED']),
              z.array(z.enum(['OPEN', 'CLOSED', 'HANDED_OVER', 'CANCELLED'])),
            ])
            .optional(),
        })
        .parse(request.query);

      const manifests = await listManifests(currentLogistics(request), {
        state:
          query.state === undefined
            ? null
            : Array.isArray(query.state)
              ? query.state
              : [query.state],
      });

      return reply.status(200).send({ manifests });
    },
  );

  /**
   * Build a load and dispatch it.
   *
   * Every consignment is authorised individually before anything is written -
   * see `createManifest`. A bulk endpoint that authorised the first id and
   * assumed the rest is the classic way a bulk action becomes a cross-tenant
   * write.
   */
  app.post(
    '/dispatch-manifests',
    { preHandler: requireLogistics(LogisticsPermission.DISPATCH_WRITE) },
    async (request, reply) => {
      const body = z
        .object({
          shipmentIds: z.array(z.string().length(26)).min(1).max(200),
          driverProfileId: z.string().length(26).optional(),
          vehicleId: z.string().length(26).optional(),
          originLabel: z.string().trim().max(160).optional(),
          destinationLabel: z.string().trim().max(160).optional(),
          plannedDepartureAt: isoDate.optional(),
          notes: z.string().trim().max(1024).optional(),
        })
        .parse(request.body);

      const result = await createManifest(
        currentLogistics(request),
        {
          shipmentIds: body.shipmentIds,
          driverProfileId: body.driverProfileId ?? null,
          vehicleId: body.vehicleId ?? null,
          originLabel: body.originLabel ?? null,
          destinationLabel: body.destinationLabel ?? null,
          plannedDepartureAt: body.plannedDepartureAt ?? null,
          notes: body.notes ?? null,
        },
        request.correlationId,
      );

      return reply.status(201).send(result);
    },
  );

  /**
   * One load list ready to print: driver, vehicle, route and a line per
   * consignment with its packages, weight and any cold-chain or dangerous-goods
   * flag.
   */
  app.get(
    '/dispatch-manifests/:id',
    { preHandler: requireLogistics(LogisticsPermission.DISPATCH_READ) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const manifest = await readManifestForPrint(currentLogistics(request), params.id);
      return reply.status(200).send(manifest);
    },
  );

  /**
   * Mark a load as handed over and record the name of whoever signed for it.
   * Refused when the manifest has already been handed over or cancelled.
   */
  app.post(
    '/dispatch-manifests/:id/handover',
    { preHandler: requireLogistics(LogisticsPermission.DISPATCH_WRITE) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z.object({ signedBy: z.string().trim().min(2).max(160) }).parse(request.body);

      await handOverManifest(currentLogistics(request), params.id, body.signedBy);
      return reply.status(204).send();
    },
  );

  // --- Exceptions ---------------------------------------------------------

  /**
   * This carrier's queue of delivery problems, most severe and oldest first, a
   * page at a time. Shows only open ones unless asked otherwise, and can be
   * narrowed by severity or shipment.
   */
  app.get(
    '/exceptions',
    { preHandler: requireLogistics(LogisticsPermission.SHIPMENT_READ) },
    async (request, reply) => {
      const query = z
        .object({
          openOnly: z.coerce.boolean().optional(),
          severity: z
            .union([
              z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
              z.array(z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])),
            ])
            .optional(),
          shipmentId: z.string().length(26).optional(),
          page: z.coerce.number().int().min(1).max(10_000).optional(),
          pageSize: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(request.query);

      const page = await listExceptions(
        currentLogistics(request),
        {
          openOnly: query.openOnly ?? true,
          severity:
            query.severity === undefined
              ? null
              : Array.isArray(query.severity)
                ? query.severity
                : [query.severity],
          shipmentId: query.shipmentId ?? null,
        },
        { page: query.page ?? 1, pageSize: query.pageSize ?? 25 },
      );

      return reply.status(200).send(page);
    },
  );

  /**
   * Work a delivery problem: change its state, severity or owner, add notes,
   * or record that the customer has been told. Resolving needs a note, a
   * severity cannot be lowered below its floor, and a revised arrival date
   * also moves the shipment's own expected date.
   */
  app.patch(
    '/exceptions/:id',
    { preHandler: requireLogistics(LogisticsPermission.SHIPMENT_EXCEPTION_WRITE) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z
        .object({
          state: z
            .enum(['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'ESCALATED', 'RESOLVED', 'CLOSED'])
            .optional(),
          severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
          ownerPartnerUserId: z.string().length(26).nullable().optional(),
          resolutionNotes: z.string().trim().max(2000).optional(),
          revisedEtaAt: isoDate.nullable().optional(),
          resolutionDueAt: isoDate.nullable().optional(),
          escalationNote: z.string().trim().max(512).optional(),
          customerNotified: z.boolean().optional(),
        })
        .parse(request.body);

      const updated = await updateException(
        currentLogistics(request),
        params.id,
        body,
        request.correlationId,
      );

      return reply.status(200).send(updated);
    },
  );

  // --- The fleet ----------------------------------------------------------

  /**
   * List this carrier's drivers, those on the rota first, with their
   * certifications, whether they can use the phone app, whether they have
   * agreed to location sharing and how many open tasks they hold.
   */
  app.get(
    '/drivers',
    { preHandler: requireLogistics(LogisticsPermission.DRIVER_READ) },
    async (request, reply) => {
      const drivers = await listDrivers(asPartner(currentLogistics(request)));
      return reply.status(200).send({ drivers });
    },
  );

  /**
   * Add somebody to the fleet.
   *
   * **A name is all that is required.** No account, no invitation, no email
   * round trip - a carrier employs people who will never open this software,
   * and a register that could only hold people with a login is a register that
   * does not describe the fleet.
   *
   * `partnerUserId` is optional and additive: supplying it links an existing
   * team member's account so this driver can also use the phone app, which is
   * what gates the task list, the scanner, proof of delivery and the trip a
   * location ping needs.
   */
  app.post(
    '/drivers',
    { preHandler: requireLogistics(LogisticsPermission.DRIVER_WRITE) },
    async (request, reply) => {
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
          /** Links an existing team member's account. Rarely supplied. */
          partnerUserId: z.string().length(26).optional(),
        })
        .parse(request.body);

      const driver = await createDriver(
        asPartner(currentLogistics(request)),
        body,
        request.correlationId,
      );

      return reply.status(201).send(driver);
    },
  );

  /**
   * Change a driver's details, or take them off the rota.
   *
   * Keyed on the DRIVER RECORD, because most drivers have no account to key
   * on. Only the fields supplied are written, so correcting a licence number
   * cannot silently clear the certifications beside it.
   */
  app.patch(
    '/drivers/:id',
    { preHandler: requireLogistics(LogisticsPermission.DRIVER_WRITE) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
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
        asPartner(currentLogistics(request)),
        params.id,
        body,
        request.correlationId,
      );

      return reply.status(200).send(driver);
    },
  );

  /**
   * List this carrier's vehicles, in-service ones first, with their
   * refrigeration, tail lift and weight limits.
   */
  app.get(
    '/vehicles',
    { preHandler: requireLogistics(LogisticsPermission.VEHICLE_READ) },
    async (request, reply) => {
      const vehicles = await listVehicles(asPartner(currentLogistics(request)));
      return reply.status(200).send({ vehicles });
    },
  );

  /**
   * Add a vehicle to this carrier's fleet list. Refused when a vehicle with the
   * same registration is already on it. Writes an audit entry.
   */
  app.post(
    '/vehicles',
    { preHandler: requireLogistics(LogisticsPermission.VEHICLE_WRITE) },
    async (request, reply) => {
      const body = z
        .object({
          registration: z.string().trim().min(1).max(32),
          kind: z.enum(['VAN', 'TRUCK', 'BIKE', 'CAR', 'REFRIGERATED_VAN', 'REFRIGERATED_TRUCK']),
          hasRefrigeration: z.boolean().optional(),
          hasTailLift: z.boolean().optional(),
          temperatureMinC: z.number().min(-100).max(100).optional(),
          temperatureMaxC: z.number().min(-100).max(100).optional(),
          maxWeightGrams: z.number().int().min(0).max(100_000_000).optional(),
        })
        .parse(request.body);

      const vehicle = await createVehicle(
        asPartner(currentLogistics(request)),
        body,
        request.correlationId,
      );
      return reply.status(201).send(vehicle);
    },
  );

  /**
   * Put a driver on a consignment, or move it from one driver to another.
   *
   * One endpoint for both, because from a dispatcher's point of view they are
   * one action - "this parcel is Anja's now" - and the difference is a fact
   * about what was already there rather than about what they are asking for.
   * The service decides: a first assignment needs no reason, a move requires
   * one, and pressing it twice on the same driver changes nothing.
   */
  app.post(
    '/shipments/:id/assign-driver',
    { preHandler: requireLogistics(LogisticsPermission.DRIVER_ASSIGN) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z
        .object({
          driverProfileId: z.string().length(26),
          vehicleId: z.string().length(26).optional(),
          isPickupLeg: z.boolean().optional(),
          isDeliveryLeg: z.boolean().optional(),
          routeSequence: z.number().int().min(0).max(999).optional(),
          /** Required by the service when a driver is being replaced. */
          reason: z.string().trim().max(512).optional(),
        })
        .parse(request.body);

      const result = await assignDriver(
        asPartner(currentLogistics(request)),
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

  /**
   * Take the driver off, without putting another one on.
   *
   * The case a reassignment cannot cover: somebody has called in sick and the
   * depot does not yet know who is taking their round. Leaving them on the
   * consignment leaves a stop on a task list nobody will work.
   *
   * Idempotent - a consignment with no driver is the desired end state, so
   * saying so twice is not an error.
   */
  app.post(
    '/shipments/:id/unassign-driver',
    { preHandler: requireLogistics(LogisticsPermission.DRIVER_ASSIGN) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z.object({ reason: z.string().trim().min(4).max(512) }).parse(request.body);

      const result = await unassignDriver(
        asPartner(currentLogistics(request)),
        params.id,
        body.reason,
        request.correlationId,
      );

      return reply.status(200).send(result);
    },
  );

  /**
   * Everyone who has carried this consignment, oldest first.
   *
   * `assertShipmentAccess` inside the route rather than the service, because
   * the marketplace's own screen reads the same history through
   * `logistics.read` and must not be made to hold a carrier membership to do
   * it. Each caller proves its own right to the consignment; the reader is
   * shared.
   */
  app.get(
    '/shipments/:id/driver-history',
    { preHandler: requireLogistics(LogisticsPermission.SHIPMENT_READ) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const access = await assertShipmentAccess(currentLogistics(request), params.id, 'READ');

      const assignments = await readDriverAssignmentHistory(access.shipmentId);
      return reply.status(200).send({ assignments });
    },
  );

  // --- Scanning -----------------------------------------------------------

  /**
   * What is this barcode?
   *
   * Tenant-scoped, so a scanner pointed at another carrier's label finds
   * nothing rather than telling the driver whose it is.
   */
  app.get('/packages/lookup', { preHandler: requireLogistics() }, async (request, reply) => {
    const query = z.object({ reference: z.string().trim().min(1).max(64) }).parse(request.query);
    const found = await findScannedPackage(currentLogistics(request), query.reference);
    return reply.status(200).send(found);
  });

  /**
   * Record that a carton went onto the van, or came off it. Only the first
   * scan in each direction is kept, so scanning the same carton again changes
   * nothing; a carton on a consignment this carrier does not hold is not found.
   */
  app.post('/packages/:id/scan', { preHandler: requireLogistics() }, async (request, reply) => {
    const params = idParam.parse(request.params);
    const body = z.object({ direction: z.enum(['OUT', 'IN']) }).parse(request.body);

    await recordPackageScan(currentLogistics(request), params.id, body.direction);
    return reply.status(204).send();
  });

  return Promise.resolve();
}

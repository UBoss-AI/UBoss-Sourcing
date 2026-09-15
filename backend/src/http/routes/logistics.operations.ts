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
  assignDriver,
  createVehicle,
  findScannedPackage,
  listDrivers,
  listVehicles,
  recordPackageScan,
  upsertDriver,
} from '../../modules/logistics/driver.service.js';
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

  app.get(
    '/dispatch-manifests/:id',
    { preHandler: requireLogistics(LogisticsPermission.DISPATCH_READ) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const manifest = await readManifestForPrint(currentLogistics(request), params.id);
      return reply.status(200).send(manifest);
    },
  );

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

  app.get(
    '/drivers',
    { preHandler: requireLogistics(LogisticsPermission.DRIVER_READ) },
    async (request, reply) => {
      const drivers = await listDrivers(currentLogistics(request));
      return reply.status(200).send({ drivers });
    },
  );

  app.post(
    '/drivers',
    { preHandler: requireLogistics(LogisticsPermission.DRIVER_WRITE) },
    async (request, reply) => {
      const body = z
        .object({
          partnerUserId: z.string().length(26),
          employeeReference: z.string().trim().max(64).optional(),
          licenceNumber: z.string().trim().max(64).optional(),
          licenceExpiresAt: isoDate.optional(),
          canCarryDangerousGoods: z.boolean().optional(),
          canCarryColdChain: z.boolean().optional(),
          canCarrySterile: z.boolean().optional(),
          state: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']).optional(),
        })
        .parse(request.body);

      const driver = await upsertDriver(currentLogistics(request), body, request.correlationId);
      return reply.status(200).send(driver);
    },
  );

  app.get(
    '/vehicles',
    { preHandler: requireLogistics(LogisticsPermission.VEHICLE_READ) },
    async (request, reply) => {
      const vehicles = await listVehicles(currentLogistics(request));
      return reply.status(200).send({ vehicles });
    },
  );

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

      const vehicle = await createVehicle(currentLogistics(request), body);
      return reply.status(201).send(vehicle);
    },
  );

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
        })
        .parse(request.body);

      const result = await assignDriver(
        currentLogistics(request),
        {
          shipmentId: params.id,
          driverProfileId: body.driverProfileId,
          vehicleId: body.vehicleId ?? null,
          isPickupLeg: body.isPickupLeg ?? false,
          isDeliveryLeg: body.isDeliveryLeg ?? true,
          routeSequence: body.routeSequence ?? null,
        },
        request.correlationId,
      );

      return reply.status(201).send(result);
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

  app.post('/packages/:id/scan', { preHandler: requireLogistics() }, async (request, reply) => {
    const params = idParam.parse(request.params);
    const body = z.object({ direction: z.enum(['OUT', 'IN']) }).parse(request.body);

    await recordPackageScan(currentLogistics(request), params.id, body.direction);
    return reply.status(204).send();
  });

  return Promise.resolve();
}

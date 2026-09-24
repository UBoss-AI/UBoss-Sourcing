/**
 * The driver's own routes: today's stops, and the trip that carries positions.
 *
 * Mounted apart from the rest of the portal, and the separation is the point:
 * a DRIVER holds no permission that can list shipments, so this is the only
 * path from a driver's session to a consignment, and every query behind it
 * starts from the caller's own driver profile.
 *
 * THE LOCATION ENDPOINT IS DIFFERENT FROM EVERY OTHER ROUTE IN THIS CODEBASE
 *
 * `POST /driver/location-pings` is authenticated by a DEVICE TOKEN rather than
 * by a session, and deliberately so. A phone flushing an offline queue on a
 * cellular connection may have a session that expired while it was in a
 * basement; the trip's own token is scoped to one trip, expires in hours, and
 * authorises position ingestion for that trip and nothing else. A token lifted
 * off a handset cannot read a shipment.
 *
 * It is still rate-limited, and hard: a device reporting every sixty seconds
 * needs one request a minute, and anything approaching the limit is a fault or
 * an attack.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { LogisticsPermission } from '../../domain/logistics-permissions.js';
import { readDriverTasks } from '../../modules/logistics/driver.service.js';
import {
  endTrip,
  recordLocationPing,
  setLocationConsent,
  startTrip,
} from '../../modules/logistics/trip.service.js';
import { currentLogistics, requireLogistics } from '../plugins/logistics.js';

const isoDate = z.coerce.date();

export function registerLogisticsDriverRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Today's stops, in route order.
   *
   * No cache header: a driver refreshing at a junction is refreshing because
   * the dispatcher just moved something, and a proxy holding the old round for
   * a minute sends them to the wrong door.
   */
  app.get(
    '/driver/tasks',
    { preHandler: requireLogistics(LogisticsPermission.DRIVER_TASK_READ) },
    async (request, reply) => {
      const query = z
        .object({ horizonHours: z.coerce.number().int().min(1).max(168).optional() })
        .parse(request.query);

      const tasks = await readDriverTasks(currentLogistics(request), {
        horizonHours: query.horizonHours ?? 48,
      });

      return reply.header('cache-control', 'no-store').status(200).send({ tasks });
    },
  );

  /**
   * Agree, or stop agreeing, to location sharing.
   *
   * A driver's own decision and nobody else's - which is why it is on this
   * route tree, behind that driver's own session, rather than on the fleet
   * screen where a manager could set it for somebody. Withdrawing ends any
   * live trip in the same breath: consent that takes effect at the end of the
   * shift has not been withdrawn.
   */
  app.post(
    '/driver/location-consent',
    { preHandler: requireLogistics(LogisticsPermission.TRIP_WRITE) },
    async (request, reply) => {
      const body = z.object({ granted: z.boolean() }).parse(request.body);
      await setLocationConsent(currentLogistics(request), body.granted);
      return reply.status(204).send();
    },
  );

  /**
   * Start a trip for the signed-in driver, optionally tied to one shipment and
   * vehicle, and hand back the one-time device token the phone uses to report
   * positions. Refused unless the driver is active and has agreed to location
   * sharing; any trip already live for that driver is abandoned.
   */
  app.post(
    '/driver/trips',
    { preHandler: requireLogistics(LogisticsPermission.TRIP_WRITE) },
    async (request, reply) => {
      const body = z
        .object({
          shipmentId: z.string().length(26).optional(),
          vehicleId: z.string().length(26).optional(),
        })
        .parse(request.body ?? {});

      const trip = await startTrip(currentLogistics(request), {
        shipmentId: body.shipmentId ?? null,
        vehicleId: body.vehicleId ?? null,
      });

      /*
       * The device token is in THIS response and in no other. There is no
       * endpoint that reads it back, and no-store is not a nicety here: a
       * cached response containing a live credential is the credential, in a
       * proxy, for as long as the cache keeps it.
       */
      return reply.header('cache-control', 'no-store').status(201).send(trip);
    },
  );

  /**
   * End or pause the driver's own live trip, which stops its device token being
   * accepted for position reports. Refused as not found when the trip is not
   * this driver's, or is not live.
   */
  app.post(
    '/driver/trips/:id/end',
    { preHandler: requireLogistics(LogisticsPermission.TRIP_WRITE) },
    async (request, reply) => {
      const params = z.object({ id: z.string().length(26) }).parse(request.params);
      const body = z
        .object({ state: z.enum(['COMPLETED', 'PAUSED']).default('COMPLETED') })
        .parse(request.body ?? {});

      await endTrip(currentLogistics(request), params.id, body.state);
      return reply.status(204).send();
    },
  );

  /**
   * One position report.
   *
   * NO SESSION GUARD. The trip's device token is the authority - see this
   * file's header for why, and `trip.service.ts` for every check it goes
   * through: a live trip, a valid unexpired token, consent still given,
   * plausible coordinates, a timestamp inside the window, a speed a vehicle
   * achieves, and a sequence number not already seen.
   *
   * A refusal is deliberately uninformative. The caller is a phone in a van
   * and its only sensible response to any of them is to drop the ping and
   * carry on; telling it precisely which check failed would help somebody
   * tuning a spoofing attempt and nobody else.
   */
  app.post(
    '/driver/location-pings',
    {
      config: {
        // A device reporting every sixty seconds needs one request a minute.
        // 120 in fifteen minutes allows a queued offline batch to flush and
        // still refuses anything that looks like a flood.
        rateLimit: { max: 120, timeWindow: '15 minutes' },
      },
    },
    async (request, reply) => {
      const body = z
        .object({
          tripId: z.string().length(26),
          deviceToken: z.string().min(16).max(256),
          latitude: z.number().min(-90).max(90),
          longitude: z.number().min(-180).max(180),
          accuracyM: z.number().int().min(0).max(100_000).optional(),
          headingDeg: z.number().int().min(0).max(359).optional(),
          speedMps: z.number().min(0).max(400).optional(),
          deviceTimestamp: isoDate,
          sequence: z.number().int().min(1).max(2_000_000_000),
          idempotencyKey: z.string().trim().max(64).optional(),
        })
        .parse(request.body);

      const result = await recordLocationPing({
        tripId: body.tripId,
        deviceToken: body.deviceToken,
        latitude: body.latitude,
        longitude: body.longitude,
        accuracyM: body.accuracyM ?? null,
        headingDeg: body.headingDeg ?? null,
        speedMps: body.speedMps ?? null,
        deviceTimestamp: body.deviceTimestamp,
        sequence: body.sequence,
        idempotencyKey: body.idempotencyKey ?? null,
      });

      return reply.header('cache-control', 'no-store').status(202).send({
        ...result,
        // The device is TOLD how often to report, rather than deciding. An
        // operator can slow every handset in the fleet at once, and a
        // battery-aware client can be asked to.
        configuredIntervalSeconds: env.LOGISTICS_PING_INTERVAL_SECONDS,
      });
    },
  );

  return Promise.resolve();
}

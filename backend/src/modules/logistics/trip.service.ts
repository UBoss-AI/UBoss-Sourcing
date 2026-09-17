/**
 * Where a driver is, while they are working.
 *
 * PHASE 1 SHIPS THE ARCHITECTURE AND NOT A SIMULATION.
 *
 * Everything here is real: the trip lifecycle, the device-scoped credential,
 * the validation, the authorisation, the retention. What is NOT here is any
 * code that invents a position. If no device has reported, the portal is told
 * so and renders "Live location unavailable" or the last scan checkpoint. A
 * marker that moves because the software interpolated it is worse than no
 * marker, for the same reason a fabricated carrier success is worse than a
 * configuration-required screen.
 *
 * THE CONSENT AND DUTY GATES, IN ORDER
 *
 *   1. The driver has consented, and has not withdrawn it
 *      (`locationConsentAt` / `locationConsentWithdrawnAt`).
 *   2. A trip of their own is ACTIVE. No trip, no collection - which is what
 *      "no background tracking outside active duty" means in code rather than
 *      in a policy document.
 *   3. The ping carries the device token minted for THAT trip. The token
 *      authorises position ingestion for one trip and nothing else, so a token
 *      lifted off a handset cannot read a shipment.
 *   4. The position is plausible: real coordinates, a timestamp inside the
 *      window, a speed a vehicle achieves, a sequence number not seen before.
 *
 * WHO MAY LOOK
 *
 * `logistics.trip.location.read`, held by owners, administrators and
 * dispatchers - and deliberately not by the read-only tracking viewer. A
 * courier's whereabouts while they work is personal data about that person and
 * reading it is a supervisory act, not a side effect of opening a page.
 */
import type { LogisticsTripState } from '../../generated/prisma/enums.js';
import { env } from '../../config/env.js';
import { ErrorCode, badRequest, conflict, forbidden, notFound } from '../../domain/errors.js';
import { LogisticsPermission } from '../../domain/logistics-permissions.js';
import { generateToken, sha256Hex } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { assertShipmentAccess } from './shipment.service.js';
import {
  assertLogisticsPermission,
  type LogisticsMembership,
} from './partner.service.js';

export interface StartedTrip {
  tripId: string;
  /** The raw device token. Returned once and never stored in the clear. */
  deviceToken: string;
  expiresAt: Date;
  pingIntervalSeconds: number;
}

/**
 * A driver goes on duty.
 *
 * One ACTIVE trip per driver. Starting a second ends the first as ABANDONED
 * rather than refusing: a handset that crashed mid-round leaves a live trip
 * behind, and a driver who cannot start their afternoon because of their
 * morning is a driver who stops using the app.
 */
export async function startTrip(
  membership: LogisticsMembership,
  input: { shipmentId?: string | null; vehicleId?: string | null },
): Promise<StartedTrip> {
  assertLogisticsPermission(membership, LogisticsPermission.TRIP_WRITE);

  if (membership.driverProfileId === null) {
    throw conflict(
      ErrorCode.LOGISTICS_DRIVER_NOT_ELIGIBLE,
      'This account has no driver record, so it cannot start a trip.',
    );
  }

  const driver = await prisma.logisticsDriverProfile.findUniqueOrThrow({
    where: { id: membership.driverProfileId },
    select: { id: true, state: true, locationConsentAt: true, locationConsentWithdrawnAt: true },
  });

  if (driver.state !== 'ACTIVE') {
    throw conflict(ErrorCode.LOGISTICS_DRIVER_NOT_ELIGIBLE, 'This driver record is not active.');
  }

  /*
   * Consent, checked before a single coordinate is accepted.
   *
   * "The employer switched it on" is not consent, which is why this is a
   * column on the driver rather than a setting on the carrier. Withdrawing it
   * stops collection immediately; it does not delete what was already
   * gathered, because that is the retention sweep's job and a different legal
   * question.
   */
  if (driver.locationConsentAt === null || driver.locationConsentWithdrawnAt !== null) {
    throw forbidden(
      ErrorCode.LOGISTICS_LOCATION_NOT_AVAILABLE,
      'Location sharing has not been agreed for this account. You can still work without it.',
    );
  }

  if ((input.shipmentId !== undefined && input.shipmentId !== null)) {
    await assertShipmentAccess(membership, input.shipmentId, 'WRITE');
  }

  const { token: deviceToken, tokenHash } = generateToken(32);
  const expiresAt = new Date(Date.now() + env.LOGISTICS_TRIP_TOKEN_TTL_HOURS * 3_600_000);
  const tripId = newId();

  await prisma.$transaction(async (tx) => {
    await tx.logisticsActiveTrip.updateMany({
      where: { driverProfileId: driver.id, state: 'ACTIVE' },
      data: { state: 'ABANDONED', endedAt: new Date() },
    });

    await tx.logisticsActiveTrip.create({
      data: {
        id: tripId,
        driverProfileId: driver.id,
        vehicleId: input.vehicleId ?? null,
        shipmentId: input.shipmentId ?? null,
        state: 'ACTIVE',
        deviceTokenHash: tokenHash,
        deviceTokenExpiresAt: expiresAt,
        pingIntervalSeconds: env.LOGISTICS_PING_INTERVAL_SECONDS,
      },
    });
  });

  return {
    tripId,
    deviceToken,
    expiresAt,
    pingIntervalSeconds: env.LOGISTICS_PING_INTERVAL_SECONDS,
  };
}

/** Off duty. Collection stops immediately. */
export async function endTrip(
  membership: LogisticsMembership,
  tripId: string,
  state: Extract<LogisticsTripState, 'COMPLETED' | 'PAUSED'> = 'COMPLETED',
): Promise<void> {
  assertLogisticsPermission(membership, LogisticsPermission.TRIP_WRITE);

  const claimed = await prisma.logisticsActiveTrip.updateMany({
    where: {
      id: tripId,
      driverProfileId: membership.driverProfileId ?? '',
      state: 'ACTIVE',
    },
    data: { state, ...(state === 'COMPLETED' ? { endedAt: new Date() } : {}) },
  });

  if (claimed.count !== 1) throw notFound('Trip');
}

export interface LocationPingInput {
  /** The trip the device is reporting for. */
  tripId: string;
  /** The raw device token minted when the trip started. */
  deviceToken: string;
  latitude: number;
  longitude: number;
  accuracyM?: number | null;
  headingDeg?: number | null;
  speedMps?: number | null;
  /** When the DEVICE says it took the fix. */
  deviceTimestamp: Date;
  /** Monotonic per trip. */
  sequence: number;
  idempotencyKey?: string | null;
}

export interface PingResult {
  accepted: boolean;
  /** Present when refused. One code, several reasons - see the error catalogue. */
  reason?: string;
  /** What the device should do next. */
  nextIntervalSeconds: number;
}

/** Metres between two coordinates, for the plausible-speed check. */
function haversineMetres(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6_371_000;
  const toRad = (value: number): number => (value * Math.PI) / 180;

  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Accept one position report, or refuse it.
 *
 * Every refusal is the same error code with a different detail. The caller is
 * a phone in a van, and its only sensible response to any of them is to drop
 * the ping and carry on - telling it precisely which check failed would help
 * nobody except somebody tuning a spoofing attempt.
 *
 * The write is a plain insert against two UNIQUE indexes - `(tripId,
 * idempotencyKey)` and `(tripId, sequence)` - so an offline queue flushing
 * twice writes each position once without a read-modify-write anywhere.
 */
export async function recordLocationPing(input: LocationPingInput): Promise<PingResult> {
  const now = new Date();

  // --- Plausible coordinates -------------------------------------------
  if (
    !Number.isFinite(input.latitude) ||
    !Number.isFinite(input.longitude) ||
    input.latitude < -90 ||
    input.latitude > 90 ||
    input.longitude < -180 ||
    input.longitude > 180 ||
    // 0,0 is in the Gulf of Guinea and is what a handset reports when its
    // location provider has failed. No van is ever there.
    (input.latitude === 0 && input.longitude === 0)
  ) {
    throw badRequest(ErrorCode.LOGISTICS_LOCATION_PING_REJECTED, 'That position is not usable.', [
      { code: 'INVALID_COORDINATES' },
    ]);
  }

  // --- A live trip, and the token that belongs to it ---------------------
  const trip = await prisma.logisticsActiveTrip.findUnique({
    where: { id: input.tripId },
    select: {
      id: true,
      state: true,
      deviceTokenHash: true,
      deviceTokenExpiresAt: true,
      pingIntervalSeconds: true,
      lastSequence: true,
      lastLatitude: true,
      lastLongitude: true,
      lastPingAt: true,
      driverProfileId: true,
      driver: {
        select: {
          locationConsentAt: true,
          locationConsentWithdrawnAt: true,
          partnerUser: { select: { userId: true } },
        },
      },
    },
  });

  if (
    trip === null ||
    trip.state !== 'ACTIVE' ||
    trip.deviceTokenExpiresAt.getTime() <= now.getTime() ||
    trip.deviceTokenHash !== sha256Hex(input.deviceToken)
  ) {
    // One answer for "no such trip", "trip finished", "token expired" and
    // "wrong token". A caller that could tell them apart could enumerate
    // trips.
    throw forbidden(
      ErrorCode.LOGISTICS_LOCATION_PING_REJECTED,
      'This device is not currently allowed to report a position.',
    );
  }

  // Consent can be withdrawn mid-trip, and it takes effect on the next ping.
  if (trip.driver.locationConsentAt === null || trip.driver.locationConsentWithdrawnAt !== null) {
    throw forbidden(
      ErrorCode.LOGISTICS_LOCATION_PING_REJECTED,
      'Location sharing has been turned off for this account.',
    );
  }

  // --- A plausible timestamp --------------------------------------------
  const ageMinutes = (now.getTime() - input.deviceTimestamp.getTime()) / 60_000;

  if (ageMinutes > env.LOGISTICS_PING_MAX_AGE_MINUTES) {
    throw badRequest(ErrorCode.LOGISTICS_LOCATION_PING_REJECTED, 'That position is too old to use.', [
      { code: 'STALE_TIMESTAMP' },
    ]);
  }

  // A device clock running fast. Two minutes of tolerance covers ordinary
  // skew; beyond that a "future" position could be replayed to keep a marker
  // alive after a driver went off duty.
  if (ageMinutes < -2) {
    throw badRequest(ErrorCode.LOGISTICS_LOCATION_PING_REJECTED, 'That position is not usable.', [
      { code: 'FUTURE_TIMESTAMP' },
    ]);
  }

  // --- A sequence not already seen ---------------------------------------
  if (input.sequence <= trip.lastSequence) {
    // Not an error to the device: it is a duplicate of something we have.
    return { accepted: false, reason: 'DUPLICATE_SEQUENCE', nextIntervalSeconds: trip.pingIntervalSeconds };
  }

  // --- A speed a vehicle achieves ----------------------------------------
  if (trip.lastLatitude !== null && trip.lastLongitude !== null && trip.lastPingAt !== null) {
    const seconds = (input.deviceTimestamp.getTime() - trip.lastPingAt.getTime()) / 1000;

    if (seconds > 0) {
      const metres = haversineMetres(
        { lat: Number(trip.lastLatitude), lon: Number(trip.lastLongitude) },
        { lat: input.latitude, lon: input.longitude },
      );

      const kmh = (metres / seconds) * 3.6;

      if (kmh > env.LOGISTICS_PING_MAX_SPEED_KMH) {
        throw badRequest(
          ErrorCode.LOGISTICS_LOCATION_PING_REJECTED,
          'That position is not usable.',
          [{ code: 'IMPLAUSIBLE_SPEED' }],
        );
      }
    }
  }

  // --- Store it ----------------------------------------------------------
  const key = (input.idempotencyKey ?? `${input.tripId}:${String(input.sequence)}`).slice(0, 64);

  try {
    await prisma.$transaction(async (tx) => {
      await tx.logisticsLocationPing.create({
        data: {
          id: newId(),
          tripId: trip.id,
          driverProfileId: trip.driverProfileId,
          /*
           * Non-null by construction, and the `??` is not defensiveness.
           *
           * A ping arrives on a device token minted when THIS driver started a
           * trip in the app, and only a driver with an account can do either -
           * so a record-only driver never reaches this line. The fallback
           * exists because the relation is nullable in the schema now, and a
           * cast would have hidden that rather than stated it.
           */
          driverUserId: trip.driver.partnerUser?.userId ?? '',
          latitude: input.latitude,
          longitude: input.longitude,
          accuracyM: input.accuracyM ?? null,
          headingDeg: input.headingDeg ?? null,
          speedMps: input.speedMps ?? null,
          deviceTimestamp: input.deviceTimestamp,
          sequence: input.sequence,
          idempotencyKey: key,
        },
      });

      /*
       * The trip's own "last known", denormalised.
       *
       * Guarded on `lastSequence` so an out-of-order flush from an offline
       * queue is STORED - it is history and belongs in the table - without
       * dragging the live marker backwards.
       */
      await tx.logisticsActiveTrip.updateMany({
        where: { id: trip.id, lastSequence: { lt: input.sequence } },
        data: {
          lastLatitude: input.latitude,
          lastLongitude: input.longitude,
          lastAccuracyM: input.accuracyM ?? null,
          lastPingAt: input.deviceTimestamp,
          lastSequence: input.sequence,
        },
      });
    });
  } catch (error) {
    // P2002: this position is already stored. The device retried; that is what
    // the idempotency key is for, and it is a success.
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002') {
      return { accepted: false, reason: 'ALREADY_RECORDED', nextIntervalSeconds: trip.pingIntervalSeconds };
    }
    throw error;
  }

  return { accepted: true, nextIntervalSeconds: trip.pingIntervalSeconds };
}

export interface LiveLocation {
  tripId: string;
  driverName: string;
  latitude: string;
  longitude: string;
  accuracyM: number | null;
  at: Date;
  /** How stale it is, so the portal can say "3 minutes ago" or warn. */
  ageSeconds: number;
}

/**
 * Where the driver on this consignment currently is, or null.
 *
 * NULL IS A REAL ANSWER AND IS RENDERED AS SUCH. No interpolation, no last-
 * known-position-dressed-up-as-live, no animation between two scans.
 *
 * Requires `TRIP_LOCATION_READ`, which a read-only tracking viewer does not
 * hold: answering "where is my order" is a milestone question, and a courier's
 * live position is not the answer to it.
 */
export async function readLiveLocation(
  membership: LogisticsMembership,
  shipmentId: string,
): Promise<LiveLocation | null> {
  assertLogisticsPermission(membership, LogisticsPermission.TRIP_LOCATION_READ);
  await assertShipmentAccess(membership, shipmentId, 'READ');

  const trip = await prisma.logisticsActiveTrip.findFirst({
    where: {
      shipmentId,
      state: 'ACTIVE',
      lastPingAt: { not: null },
      // The trip has to belong to this carrier. The shipment access check
      // above proves the carrier may see the consignment; this proves the van
      // is theirs, which is a different question when a shipment has been
      // reassigned.
      driver: { logisticsPartnerId: membership.logisticsPartnerId },
    },
    orderBy: { lastPingAt: 'desc' },
    select: {
      id: true,
      lastLatitude: true,
      lastLongitude: true,
      lastAccuracyM: true,
      lastPingAt: true,
      driver: { select: { fullName: true } },
    },
  });

  if (
    trip === null ||
    trip.lastLatitude === null ||
    trip.lastLongitude === null ||
    trip.lastPingAt === null
  ) {
    return null;
  }

  return {
    tripId: trip.id,
    driverName: trip.driver.fullName,
    latitude: trip.lastLatitude.toString(),
    longitude: trip.lastLongitude.toString(),
    accuracyM: trip.lastAccuracyM,
    at: trip.lastPingAt,
    ageSeconds: Math.max(0, Math.round((Date.now() - trip.lastPingAt.getTime()) / 1000)),
  };
}

/** A driver gives, or withdraws, permission to record where they are. */
export async function setLocationConsent(
  membership: LogisticsMembership,
  granted: boolean,
): Promise<void> {
  if (membership.driverProfileId === null) {
    throw conflict(
      ErrorCode.LOGISTICS_DRIVER_NOT_ELIGIBLE,
      'This account has no driver record.',
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.logisticsDriverProfile.update({
      where: { id: membership.driverProfileId as string },
      data: granted
        ? { locationConsentAt: new Date(), locationConsentWithdrawnAt: null }
        : { locationConsentWithdrawnAt: new Date() },
    });

    // Withdrawing ends any live trip in the same breath. A consent that takes
    // effect at the end of the shift is not a consent that has been withdrawn.
    if (!granted) {
      await tx.logisticsActiveTrip.updateMany({
        where: { driverProfileId: membership.driverProfileId as string, state: 'ACTIVE' },
        data: { state: 'COMPLETED', endedAt: new Date() },
      });
    }
  });
}

/**
 * Housekeeping.
 *
 * Two jobs on one beat, because both are cheap indexed writes and both are
 * about a driver who is no longer on duty:
 *
 *   - Trips that were started and never ended. A trip that stays ACTIVE is a
 *     device that keeps being allowed to send positions, which is precisely
 *     what the duty gate exists to prevent.
 *   - Positions older than the retention window. Storage limitation (Art.
 *     5(1)(e)) is a number rather than an intention, and this is the number.
 */
export async function sweepTripsAndPings(now = new Date()): Promise<{
  abandoned: number;
  deleted: number;
}> {
  const staleTripCutoff = new Date(
    now.getTime() - env.LOGISTICS_TRIP_TOKEN_TTL_HOURS * 3_600_000,
  );

  const abandoned = await prisma.logisticsActiveTrip.updateMany({
    where: { state: 'ACTIVE', startedAt: { lt: staleTripCutoff } },
    data: { state: 'ABANDONED', endedAt: now },
  });

  if (env.RETENTION_LOGISTICS_LOCATION_PING_DAYS === 0) {
    return { abandoned: abandoned.count, deleted: 0 };
  }

  const pingCutoff = new Date(
    now.getTime() - env.RETENTION_LOGISTICS_LOCATION_PING_DAYS * 86_400_000,
  );

  // Bounded, so one pass cannot lock the largest table in the schema for
  // minutes. What is left is taken by the next pass.
  const doomed = await prisma.logisticsLocationPing.findMany({
    where: { receivedAt: { lt: pingCutoff } },
    take: 5000,
    select: { id: true },
  });

  if (doomed.length === 0) return { abandoned: abandoned.count, deleted: 0 };

  const deleted = await prisma.logisticsLocationPing.deleteMany({
    where: { id: { in: doomed.map((row) => row.id) } },
  });

  return { abandoned: abandoned.count, deleted: deleted.count };
}

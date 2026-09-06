/**
 * Where an admin session was opened from.
 *
 * The Admin Panel asks the browser for the device's position immediately after
 * a sign-in and posts it here; until this has run, `requireAdmin` refuses every
 * route. The reasoning is the one behind the whole gate: a self-hosted console
 * is shared by several staff accounts and has no perimeter around it, so the
 * people running the shop need the sign-ins themselves to be visible. The bell
 * saying "signed in from Pune" the moment it happens is what turns a sign-in
 * nobody made into something somebody notices.
 *
 * Three decisions worth keeping:
 *
 *   - **The browser is not trusted, and does not have to be.** Coordinates
 *     arrive from a client that could send anything, so this is evidence for a
 *     person to read, never an authorisation input. Nothing anywhere decides
 *     access from the position - the gate only asks that one was given.
 *   - **The reverse lookup is best-effort.** A geocoder that is slow, blocked
 *     by a firewall or switched off leaves `locationLabel` null and the
 *     notification shows coordinates. It must never be the thing that keeps
 *     somebody out of the panel they just signed in to.
 *   - **One bell per session, not per request.** A retried post - a flaky
 *     network, a double click - writes the same row again and is deduped, so a
 *     single sign-in never rings twice.
 */
import { env } from '../../config/env.js';
import { Permission } from '../../domain/permissions.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import {
  AdminNotificationKind,
  createAdminNotification,
} from '../notifications/admin-notification.service.js';

export interface RecordSessionLocationInput {
  sessionId: string;
  userId: string;
  userEmail: string;
  /** WGS-84 degrees, as the Geolocation API reports them. */
  latitude: number;
  longitude: number;
  /** The radius the device claimed, in metres. Null when it reported none. */
  accuracyM: number | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
}

export interface RecordedSessionLocation {
  latitude: number;
  longitude: number;
  accuracyM: number | null;
  /** The place, when a lookup was possible. Null means "show the coordinates". */
  label: string | null;
  /** The country that place is in, when the geocoder named one. */
  country: string | null;
  capturedAt: Date;
}

/** What a reverse lookup managed to say about a pair of coordinates. */
export interface GeocodedPlace {
  /** A human-readable place, for a notification line. */
  label: string | null;
  /** ISO-3166-1 alpha-2, upper case. What the console prices for. */
  country: string | null;
}

/**
 * Coordinates as a person reads them.
 *
 * Four decimals is ~11m, which is finer than any of these fixes and short
 * enough to sit in a notification line. Used as the label when no geocoder
 * answered, so a row always says *something* about where it came from.
 */
export function formatCoordinates(latitude: number, longitude: number): string {
  return `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
}

/**
 * The country an address block names, ISO-3166-1 alpha-2.
 *
 * Nominatim returns `address.country_code` in lower case; clones and other
 * services spell the same fact `countryCode` or `ISO3166-1`. All three are
 * accepted and anything that is not two letters is treated as no answer -
 * a geocoder guessing at a country is not a reason to price a shop wrongly.
 */
function countryFrom(body: Record<string, unknown>): string | null {
  const address =
    typeof body.address === 'object' && body.address !== null
      ? (body.address as Record<string, unknown>)
      : {};

  const candidate = [address.country_code, address.countryCode, body.countryCode].find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );

  if (candidate === undefined) return null;

  const code = candidate.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

/**
 * Turn coordinates into a place, and into the country it sits in.
 *
 * Exported for the tests, and deliberately total: every failure path - no URL
 * configured, a timeout, a non-200, a body in a shape this does not recognise -
 * returns nulls rather than throwing. The caller has already accepted the
 * position by the time this runs, and the sign-in must not hinge on a third
 * party being reachable.
 */
export async function reverseGeocode(latitude: number, longitude: number): Promise<GeocodedPlace> {
  const empty: GeocodedPlace = { label: null, country: null };

  const template = env.GEOCODE_REVERSE_URL.trim();
  if (template.length === 0) return empty;

  const filled = template
    .replace('{lat}', encodeURIComponent(latitude.toFixed(6)))
    .replace('{lon}', encodeURIComponent(longitude.toFixed(6)));

  // The country lives in the address block, which Nominatim only returns when
  // asked. Appended rather than assumed, so a deployment whose .env still
  // pins the previous URL gets the country too - and a geocoder that has
  // never heard of the parameter ignores it, which is why adding it is safe
  // for the installations that point somewhere else entirely.
  const url = filled.includes('addressdetails')
    ? filled
    : `${filled}${filled.includes('?') ? '&' : '?'}addressdetails=1`;

  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        // OpenStreetMap's usage policy asks callers to identify themselves, and
        // an unidentified client is the one they block first.
        'user-agent': `UBOSS/1.0 (+${env.API_PUBLIC_URL})`,
      },
      signal: AbortSignal.timeout(env.GEOCODE_TIMEOUT_MS),
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, 'reverse geocode answered a non-200');
      return empty;
    }

    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) return empty;

    // Tolerant of the shape, like the rate feed next door: `display_name` is
    // what Nominatim and most of its clones return, and a plain `name` covers
    // the rest. Anything else is treated as no answer at all.
    const record = body as Record<string, unknown>;
    const candidate = [record.display_name, record.name].find(
      (value): value is string => typeof value === 'string' && value.trim().length > 0,
    );

    return {
      // The column is 255, and a full Nominatim display name can run past it.
      label: candidate === undefined ? null : candidate.trim().slice(0, 255),
      // Independent of the label: a service that answers with a country and no
      // display name still tells the console which market to price for.
      country: countryFrom(record),
    };
  } catch (error) {
    logger.warn({ err: error }, 'reverse geocode failed; falling back to coordinates');
    return empty;
  }
}

/**
 * Record the position for one admin session, and tell the console about it.
 *
 * Idempotent by session: posting twice updates the same row and rings the bell
 * once, because the notification is deduped on the session id.
 */
export async function recordSessionLocation(
  input: RecordSessionLocationInput,
): Promise<RecordedSessionLocation> {
  const { label, country } = await reverseGeocode(input.latitude, input.longitude);
  const capturedAt = new Date();

  // `updateMany` rather than `update`: a session revoked between the guard and
  // this write should quietly affect nothing rather than throw a record-not-
  // found at somebody whose only mistake was being slow to click Allow.
  await prisma.session.updateMany({
    where: { id: input.sessionId },
    data: {
      locationLatitude: input.latitude.toFixed(6),
      locationLongitude: input.longitude.toFixed(6),
      locationAccuracyM: input.accuracyM === null ? null : Math.round(input.accuracyM),
      locationLabel: label,
      // The market this session's console prices for. Null where no geocoder
      // answered, which the panel reads as "the seller's own country".
      locationCountry: country,
      locationCapturedAt: capturedAt,
    },
  });

  await createAdminNotification({
    kind: AdminNotificationKind.ADMIN_SIGNED_IN,
    variables: {
      email: input.userEmail,
      // Always something readable, whether or not a geocoder answered.
      place: label ?? formatCoordinates(input.latitude, input.longitude),
      latitude: input.latitude.toFixed(6),
      longitude: input.longitude.toFixed(6),
      accuracyM: input.accuracyM === null ? null : Math.round(input.accuracyM),
      ipAddress: input.ipAddress ?? null,
    },
    // Who signed in from where is staff information, and it names a colleague.
    // A Catalog Manager has no business reading the movements of the person who
    // runs the warehouse, so it goes to whoever may already read staff records.
    requiredPermission: Permission.STAFF_READ,
    relatedType: 'session',
    relatedId: input.sessionId,
    dedupeKey: `session-location:${input.sessionId}`,
  });

  await recordAudit({
    action: AuditAction.USER_SESSION_LOCATION,
    resourceType: 'session',
    resourceId: input.sessionId,
    actorType: 'ADMIN',
    actorUserId: input.userId,
    actorEmail: input.userEmail,
    after: {
      latitude: input.latitude.toFixed(6),
      longitude: input.longitude.toFixed(6),
      accuracyM: input.accuracyM === null ? null : Math.round(input.accuracyM),
      label,
      country,
    },
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    correlationId: input.correlationId ?? null,
  });

  return {
    latitude: input.latitude,
    longitude: input.longitude,
    accuracyM: input.accuracyM === null ? null : Math.round(input.accuracyM),
    label,
    country,
    capturedAt,
  };
}

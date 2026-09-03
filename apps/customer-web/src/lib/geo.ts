/**
 * Working out which country a visitor is in, without calling anybody.
 *
 * Two independent signals, both resolved in the browser:
 *
 *   1. **The IANA time zone.** `Asia/Kolkata` means India. This needs no
 *      permission, is available immediately, and is right far more often than
 *      an IP lookup - which sees the VPN exit, not the person.
 *
 *   2. **Geolocation coordinates**, when the visitor grants the permission.
 *      Checked against coarse bounding boxes for the markets this store
 *      actually serves.
 *
 * Neither is treated as authoritative. Both feed the picker as a *suggestion*
 * next to the question, and the answer the shopper gives is what gets saved.
 * That is the point of storing `detectedCountry` separately from
 * `preferredCountry` on the server: the two can disagree visibly rather than
 * one silently overriding the other.
 *
 * There is deliberately no third-party geocoding call here. Sending a
 * customer's coordinates to an external service to learn something a time zone
 * already tells us is not a trade worth making.
 */

/**
 * IANA zone to ISO-3166 country, for the markets this store serves.
 *
 * Only zones that map unambiguously to one of our countries are listed. A zone
 * we do not recognise yields null, and the picker simply opens with no
 * suggestion rather than a wrong one.
 */
const ZONE_TO_COUNTRY: Readonly<Record<string, string>> = {
  'Asia/Kolkata': 'IN',
  'Asia/Calcutta': 'IN',
  'Asia/Dubai': 'AE',
  'Asia/Muscat': 'OM',
  'Asia/Qatar': 'QA',
  'Asia/Riyadh': 'SA',
  'Asia/Singapore': 'SG',
  'Asia/Kuala_Lumpur': 'MY',
  'Asia/Tokyo': 'JP',
  'Asia/Seoul': 'KR',
  'Europe/London': 'GB',
  'Europe/Dublin': 'IE',
  'Europe/Paris': 'FR',
  'Europe/Berlin': 'DE',
  'Europe/Madrid': 'ES',
  'Europe/Rome': 'IT',
  'Europe/Amsterdam': 'NL',
  'Europe/Brussels': 'BE',
  'Europe/Vienna': 'AT',
  'Australia/Sydney': 'AU',
  'Australia/Melbourne': 'AU',
  'Australia/Brisbane': 'AU',
  'Australia/Perth': 'AU',
  'Pacific/Auckland': 'NZ',
};

/** Zone prefixes, for the many US and Canadian zones not worth listing. */
const ZONE_PREFIX_TO_COUNTRY: readonly (readonly [string, string])[] = [
  ['America/Toronto', 'CA'],
  ['America/Vancouver', 'CA'],
  ['America/Edmonton', 'CA'],
  ['America/Winnipeg', 'CA'],
  ['America/Halifax', 'CA'],
  ['America/', 'US'],
  ['US/', 'US'],
];

/** The visitor's country according to their clock, or null if unrecognised. */
export function countryFromTimeZone(): string | null {
  let zone: string;
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return null;
  }

  if (zone === '') return null;

  const exact = ZONE_TO_COUNTRY[zone];
  if (exact !== undefined) return exact;

  for (const [prefix, country] of ZONE_PREFIX_TO_COUNTRY) {
    if (zone.startsWith(prefix)) return country;
  }

  return null;
}

interface BoundingBox {
  country: string;
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

/**
 * Coarse boxes for the served markets.
 *
 * Deliberately approximate: this only has to pick one of about twenty
 * countries, not draw a border. Where boxes overlap the first match wins, so
 * smaller countries are listed before the large ones that contain them.
 */
const BOXES: readonly BoundingBox[] = [
  { country: 'SG', minLat: 1.15, maxLat: 1.48, minLon: 103.6, maxLon: 104.1 },
  { country: 'AE', minLat: 22.6, maxLat: 26.1, minLon: 51.5, maxLon: 56.4 },
  { country: 'QA', minLat: 24.4, maxLat: 26.2, minLon: 50.7, maxLon: 51.7 },
  { country: 'OM', minLat: 16.6, maxLat: 26.4, minLon: 52.0, maxLon: 59.9 },
  { country: 'SA', minLat: 16.3, maxLat: 32.2, minLon: 34.5, maxLon: 55.7 },
  { country: 'IN', minLat: 6.7, maxLat: 35.7, minLon: 68.1, maxLon: 97.4 },
  { country: 'MY', minLat: 0.8, maxLat: 7.4, minLon: 99.6, maxLon: 119.3 },
  { country: 'JP', minLat: 24.0, maxLat: 45.6, minLon: 122.9, maxLon: 146.0 },
  { country: 'KR', minLat: 33.1, maxLat: 38.6, minLon: 125.0, maxLon: 129.6 },
  { country: 'IE', minLat: 51.4, maxLat: 55.4, minLon: -10.6, maxLon: -5.9 },
  { country: 'GB', minLat: 49.8, maxLat: 60.9, minLon: -8.7, maxLon: 1.8 },
  { country: 'NL', minLat: 50.7, maxLat: 53.6, minLon: 3.3, maxLon: 7.2 },
  { country: 'BE', minLat: 49.5, maxLat: 51.5, minLon: 2.5, maxLon: 6.4 },
  { country: 'AT', minLat: 46.4, maxLat: 49.0, minLon: 9.5, maxLon: 17.2 },
  { country: 'DE', minLat: 47.3, maxLat: 55.1, minLon: 5.9, maxLon: 15.0 },
  { country: 'FR', minLat: 41.3, maxLat: 51.1, minLon: -5.1, maxLon: 9.6 },
  { country: 'ES', minLat: 36.0, maxLat: 43.8, minLon: -9.3, maxLon: 3.3 },
  { country: 'IT', minLat: 36.6, maxLat: 47.1, minLon: 6.6, maxLon: 18.5 },
  { country: 'NZ', minLat: -47.3, maxLat: -34.4, minLon: 166.4, maxLon: 178.6 },
  { country: 'AU', minLat: -43.7, maxLat: -10.1, minLon: 112.9, maxLon: 153.7 },
  { country: 'CA', minLat: 41.7, maxLat: 83.1, minLon: -141.0, maxLon: -52.6 },
  { country: 'US', minLat: 24.4, maxLat: 49.4, minLon: -125.0, maxLon: -66.9 },
];

export function countryFromCoordinates(latitude: number, longitude: number): string | null {
  for (const box of BOXES) {
    if (
      latitude >= box.minLat &&
      latitude <= box.maxLat &&
      longitude >= box.minLon &&
      longitude <= box.maxLon
    ) {
      return box.country;
    }
  }
  return null;
}

export type LocationPermission = 'granted' | 'denied' | 'unavailable';

export interface DetectionResult {
  /** Best guess, or null when nothing recognised the visitor. */
  country: string | null;
  /** Which signal produced it. Shown to the shopper so the guess is explicable. */
  source: 'geolocation' | 'timezone' | 'none';
  permission: LocationPermission;
}

/**
 * Ask the browser where the visitor is.
 *
 * Resolves rather than rejects on refusal: declining the permission is a normal
 * answer, not an error, and the picker still works from the time zone alone.
 * The prompt is only raised when `requestPrecise` is true, so the storefront
 * can decide when it is polite to ask.
 */
export async function detectCountry(requestPrecise: boolean): Promise<DetectionResult> {
  const fromZone = countryFromTimeZone();

  if (!requestPrecise || typeof navigator === 'undefined' || !('geolocation' in navigator)) {
    return {
      country: fromZone,
      source: fromZone === null ? 'none' : 'timezone',
      permission: 'unavailable',
    };
  }

  const position = await new Promise<GeolocationPosition | null>((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (result) => {
        resolve(result);
      },
      () => {
        resolve(null);
      },
      // A coarse fix is all a country lookup needs, and asking for a precise
      // one keeps the device's radio busy for no extra accuracy here.
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 600_000 },
    );
  });

  if (position === null) {
    return {
      country: fromZone,
      source: fromZone === null ? 'none' : 'timezone',
      permission: 'denied',
    };
  }

  const fromCoords = countryFromCoordinates(
    position.coords.latitude,
    position.coords.longitude,
  );

  if (fromCoords !== null) {
    return { country: fromCoords, source: 'geolocation', permission: 'granted' };
  }

  return {
    country: fromZone,
    source: fromZone === null ? 'none' : 'timezone',
    permission: 'granted',
  };
}

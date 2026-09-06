/**
 * Checking a VAT number against VIES.
 *
 * VIES is the Commission's front door onto twenty-seven national registers. It
 * holds nothing itself: an enquiry about a German number is forwarded to
 * Germany, and the answer is only as available as Germany's system is that
 * afternoon. Several member states take it down overnight for batch runs.
 *
 * That shapes everything here.
 *
 *   - **Three outcomes, not two.** Valid, invalid, and *could not ask*. A
 *     timeout is not a "no". Collapsing the third into the second would
 *     silently start charging VAT to a wholesaler with a perfectly good number
 *     because Italy was rebooting, and collapsing it into the first would
 *     zero-rate a supply on no evidence at all. `VatNumberCheck` records which
 *     of the three happened.
 *
 *   - **Answers are cached, and the cache has a half-life.** A number
 *     confirmed this morning is good enough to price a basket this afternoon.
 *     A number confirmed last year is not: registrations are cancelled, and
 *     the seller carries the liability. `CACHE_TTL_DAYS` is that half-life.
 *
 *   - **The consultation number is the point.** Art. 31 of Regulation 904/2010
 *     lets a seller rely on what VIES told them; the reference VIES returns is
 *     the evidence they were told it. Without it, a zero-rated supply to a
 *     customer whose number later turns out to be bad becomes the seller's tax
 *     bill rather than the customer's. It is requested on every check and
 *     stored whenever it comes back.
 *
 *   - **Nothing here ever throws into a checkout.** The worst outcome is
 *     "unverified", which the VAT engine treats as "charge the tax" - the safe
 *     direction to be wrong in, because it costs the customer cash flow rather
 *     than costing the seller the tax.
 *
 * The REST endpoint is used rather than the old SOAP service: same data, same
 * consultation numbers, and no XML parser in the dependency tree.
 */
import { env } from '../../config/env.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';

/**
 * How long a confirmed answer is trusted.
 *
 * Short enough that a cancelled registration is caught within a working week,
 * long enough that a customer's regular weekly order does not hammer a member
 * state's register. VIES's own guidance discourages repeated identical
 * enquiries.
 */
const CACHE_TTL_DAYS = 7;

/**
 * A failed lookup is retried sooner than a successful one is refreshed. The
 * usual cause is the member state being briefly down, and an hour is long
 * enough not to hammer it while short enough that a checkout later the same
 * day gets a real answer.
 */
const FAILURE_TTL_MINUTES = 60;

export interface VatNumberCheckResult {
  countryCode: string;
  number: string;
  /** Null means the check could not be made - see `unavailableReason`. */
  isValid: boolean | null;
  registeredName: string | null;
  registeredAddress: string | null;
  /** Art. 31 Reg. 904/2010 evidence. Null when the service returned none. */
  consultationNumber: string | null;
  unavailableReason: string | null;
  checkedAt: Date;
  /** True when this answer came from the cache rather than the wire. */
  cached: boolean;
}

/**
 * Split a VAT number into the member state prefix and the rest.
 *
 * Formatting is stripped: people paste "NL 8021 25 100 B01" off a letterhead,
 * and spaces, dots and hyphens are decoration in every member state's format.
 * The prefix is the two leading letters, with Greece's quirk handled - Greece
 * issues numbers under ISO code GR but registers them in VIES as EL, and a
 * lookup under GR simply fails.
 */
export function parseVatNumber(raw: string): { countryCode: string; number: string } | null {
  const cleaned = raw.toUpperCase().replace(/[\s.\-/]/g, '');
  const match = /^([A-Z]{2})([0-9A-Z]{2,20})$/.exec(cleaned);

  if (match === null) return null;

  const prefix = match[1] ?? '';
  const number = match[2] ?? '';

  return { countryCode: prefix === 'GR' ? 'EL' : prefix, number };
}

/** How VIES spells a country versus how the rest of the system does. */
export function isoCountryForVatPrefix(prefix: string): string {
  return prefix.toUpperCase() === 'EL' ? 'GR' : prefix.toUpperCase();
}

interface ViesResponse {
  valid?: unknown;
  name?: unknown;
  address?: unknown;
  requestIdentifier?: unknown;
  userError?: unknown;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  // Several member states answer with "---" rather than a name as a matter of
  // policy. That is an answer meaning "we will not say", not a name.
  if (trimmed.length === 0 || trimmed === '---') return null;
  return trimmed;
}

/**
 * Ask VIES, with no caching.
 *
 * Exported for the tests. Total by construction: every failure path - the
 * service switched off, a timeout, a non-200, a body in a shape this does not
 * recognise - comes back as `isValid: null` with a reason, never as a throw.
 */
export async function queryVies(
  countryCode: string,
  number: string,
): Promise<Omit<VatNumberCheckResult, 'checkedAt' | 'cached'>> {
  const base: Omit<VatNumberCheckResult, 'checkedAt' | 'cached'> = {
    countryCode,
    number,
    isValid: null,
    registeredName: null,
    registeredAddress: null,
    consultationNumber: null,
    unavailableReason: null,
  };

  const template = env.VIES_CHECK_URL.trim();

  if (template.length === 0) {
    return { ...base, unavailableReason: 'VAT number checking is switched off.' };
  }

  const url = template
    .replace('{country}', encodeURIComponent(countryCode))
    .replace('{number}', encodeURIComponent(number));

  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        // The Commission asks callers to identify themselves, and an
        // unidentified client is the first one throttled.
        'user-agent': `UBOSS/1.0 (+${env.API_PUBLIC_URL})`,
      },
      signal: AbortSignal.timeout(env.VIES_TIMEOUT_MS),
    });

    if (!response.ok) {
      return {
        ...base,
        unavailableReason: `VIES answered ${String(response.status)}.`,
      };
    }

    const body = (await response.json()) as ViesResponse;

    // `userError` is how the service reports a member state being unreachable,
    // as well as a malformed request. Either way it is not an answer about the
    // number, so it must not be read as "invalid".
    const userError = text(body.userError);
    if (userError !== null && userError !== 'VALID' && userError !== 'INVALID') {
      return { ...base, unavailableReason: `VIES: ${userError}` };
    }

    if (typeof body.valid !== 'boolean') {
      return { ...base, unavailableReason: 'VIES returned no verdict.' };
    }

    return {
      ...base,
      isValid: body.valid,
      registeredName: text(body.name),
      registeredAddress: text(body.address)?.slice(0, 512) ?? null,
      consultationNumber: text(body.requestIdentifier)?.slice(0, 64) ?? null,
    };
  } catch (error) {
    logger.warn({ err: error, countryCode }, 'VIES lookup failed');
    return { ...base, unavailableReason: 'VIES could not be reached.' };
  }
}

/**
 * Check a number, using the cache where it is still fresh.
 *
 * `force` skips the cache — for the button in the admin customer screen, where
 * the whole point of pressing it is to find out what the register says now.
 */
export async function checkVatNumber(
  raw: string,
  options: { force?: boolean } = {},
): Promise<VatNumberCheckResult> {
  const parsed = parseVatNumber(raw);

  if (parsed === null) {
    return {
      countryCode: '',
      number: raw.slice(0, 32),
      isValid: false,
      registeredName: null,
      registeredAddress: null,
      consultationNumber: null,
      // A locally decidable "no". Every member state's format starts with two
      // letters and continues with alphanumerics; anything else is a typo, and
      // asking VIES about it would waste a round trip to learn that.
      unavailableReason: null,
      checkedAt: new Date(),
      cached: false,
    };
  }

  const { countryCode, number } = parsed;

  const cached = await prisma.vatNumberCheck.findUnique({
    where: { countryCode_number: { countryCode, number } },
  });

  if (cached !== null && options.force !== true) {
    const ageMs = Date.now() - cached.checkedAt.getTime();
    const ttlMs =
      cached.unavailableReason === null
        ? CACHE_TTL_DAYS * 86_400_000
        : FAILURE_TTL_MINUTES * 60_000;

    if (ageMs < ttlMs) {
      return {
        countryCode,
        number,
        isValid: cached.unavailableReason === null ? cached.isValid : null,
        registeredName: cached.registeredName,
        registeredAddress: cached.registeredAddress,
        consultationNumber: cached.consultationNumber,
        unavailableReason: cached.unavailableReason,
        checkedAt: cached.checkedAt,
        cached: true,
      };
    }
  }

  const answer = await queryVies(countryCode, number);
  const checkedAt = new Date();

  // Stored whatever the outcome, including the failures: the failure row is
  // what stops a broken member state being asked once per page load, and its
  // shorter TTL is what stops the failure sticking.
  await prisma.vatNumberCheck.upsert({
    where: { countryCode_number: { countryCode, number } },
    create: {
      id: newId(),
      countryCode,
      number,
      isValid: answer.isValid ?? false,
      registeredName: answer.registeredName,
      registeredAddress: answer.registeredAddress,
      consultationNumber: answer.consultationNumber,
      unavailableReason: answer.unavailableReason,
      checkedAt,
    },
    update: {
      isValid: answer.isValid ?? false,
      registeredName: answer.registeredName,
      registeredAddress: answer.registeredAddress,
      // A fresh failure must not erase the consultation number from the last
      // successful check: that reference is the seller's evidence for supplies
      // already zero-rated, and it does not stop being evidence because the
      // register is down today.
      ...(answer.consultationNumber === null ? {} : { consultationNumber: answer.consultationNumber }),
      unavailableReason: answer.unavailableReason,
      checkedAt,
    },
  });

  return { ...answer, checkedAt, cached: false };
}

/**
 * Check the number on a customer profile and record the verdict on it.
 *
 * The profile carries the verdict, not just the number, because pricing runs
 * on every cart read and must not make a network call to find out whether to
 * zero-rate. `vatNumberValid` stays null when the check could not be made,
 * which the VAT engine reads as "charge the tax".
 */
export async function refreshCustomerVatNumber(
  customerProfileId: string,
  options: { force?: boolean } = {},
): Promise<VatNumberCheckResult | null> {
  const profile = await prisma.customerProfile.findUnique({
    where: { id: customerProfileId },
    select: { vatNumber: true },
  });

  if (profile?.vatNumber === null || profile?.vatNumber === undefined) return null;

  const result = await checkVatNumber(profile.vatNumber, options);

  await prisma.customerProfile.update({
    where: { id: customerProfileId },
    data: {
      vatNumberValid: result.isValid,
      vatNumberCheckedAt: result.checkedAt,
      ...(result.consultationNumber === null
        ? {}
        : { vatNumberReference: result.consultationNumber }),
    },
  });

  return result;
}

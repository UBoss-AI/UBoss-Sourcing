/**
 * What a courier is allowed to read about the person at the door.
 *
 * A logistics partner needs enough to deliver a parcel and no more. That is
 * not a slogan, it is a list, and this file is the list: one function per kind
 * of contact detail, each taking the reason the caller wants it, so that
 * "because I am looking at a shipment list" and "because I am standing outside
 * the building" get different answers.
 *
 * WHY THIS IS A DOMAIN MODULE AND NOT A FORMATTER
 *
 * Because it is a security control and it has to be applied on the SERVER,
 * before the value reaches a response body. A frontend that renders
 * `+44 •••• ••89` from a full number it was sent has masked nothing - the
 * number is in the network tab, in the browser cache and in any screenshot of
 * the developer tools. Every logistics read path calls these functions while
 * building its payload, and the full value never leaves this process.
 *
 * THE TWO RULES
 *
 *   1. **Masking is by ROLE and by NEED, together.** A dispatcher planning
 *      tomorrow's round gets a masked number; the driver who has the parcel on
 *      their van today gets the real one, because the alternative is a driver
 *      standing outside a locked loading bay with no way to ring the bell.
 *   2. **The unmasking is recorded.** `revealPolicyFor` returns whether a
 *      reveal happened, and the caller writes an audit row. A control nobody
 *      can audit is a control nobody can rely on.
 */
import type { LogisticsPermissionKey } from './logistics-permissions.js';
import { LogisticsPermission } from './logistics-permissions.js';

/**
 * Why the caller wants a contact detail.
 *
 * `ACTIVE_DELIVERY` is the only context that unmasks, and only for the person
 * actually carrying the parcel. Everything else gets the masked form plus a
 * secure contact action - a call placed through the platform, which connects
 * the two without either side learning the other's number.
 */
export type ContactContext =
  | 'LIST'
  | 'SHIPMENT_DETAIL'
  | 'ACTIVE_DELIVERY'
  | 'EXCEPTION_HANDLING';

export interface ContactViewer {
  permissions: ReadonlySet<LogisticsPermissionKey>;
  /** True when this caller is the driver assigned to the shipment in hand. */
  isAssignedDriver: boolean;
}

export interface MaskedContact {
  /** Safe to render anywhere. Never the full value unless `isMasked` is false. */
  display: string | null;
  isMasked: boolean;
  /**
   * Whether the portal should offer a "call through UBOSS" button instead of a
   * tel: link. True whenever the value is masked and a value exists.
   */
  offerSecureContact: boolean;
}

const EMPTY: MaskedContact = Object.freeze({
  display: null,
  isMasked: false,
  offerSecureContact: false,
});

/**
 * Keep the country prefix and the last two digits, mask the rest.
 *
 * The prefix stays because a dispatcher routing across a border needs to know
 * which country they are calling, and it identifies nobody. The last two stay
 * because a driver reading a number off a paper manifest needs to confirm they
 * are looking at the same consignment, and two digits confirm that without
 * being dialable.
 *
 * Deliberately NOT the last four, which is the habit inherited from card
 * numbers: four digits of a national number plus a city is frequently enough
 * to find the person.
 */
export function maskPhone(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;

  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const hasPrefix = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 4) return '•••';

  const prefix = hasPrefix ? `+${digits.slice(0, Math.min(3, digits.length - 2))}` : '';
  const tail = digits.slice(-2);
  const hiddenCount = Math.max(2, digits.length - tail.length - (hasPrefix ? prefix.length - 1 : 0));

  return `${prefix} ${'•'.repeat(Math.min(hiddenCount, 8))} ${tail}`.trim();
}

/**
 * First character, the domain, and nothing in between.
 *
 * `j••••@hospital.example` tells a dispatcher which organisation they are
 * dealing with - which is genuinely operational information on a B2B
 * consignment - without handing over a mailbox to write to.
 */
export function maskEmail(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;

  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const at = trimmed.lastIndexOf('@');
  if (at <= 0) return '•••';

  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at);
  const head = local.slice(0, 1);

  return `${head}${'•'.repeat(Math.min(Math.max(local.length - 1, 1), 6))}${domain}`;
}

/**
 * A person's name, reduced to what a delivery needs.
 *
 * Given name and the initial of the family name. Enough to ask for somebody at
 * a reception desk, not enough to look them up. Applied to the RECEIVING
 * contact only - a warehouse contact is acting in a business capacity and is
 * not masked, which is the same line the rest of this codebase draws.
 */
export function maskPersonName(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;

  const parts = raw
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);

  if (parts.length === 0) return null;

  const first = parts[0] ?? '';
  if (parts.length === 1) return first;

  const lastInitial = (parts[parts.length - 1] ?? '').slice(0, 1).toUpperCase();
  return `${first} ${lastInitial}.`;
}

/**
 * Does this viewer, in this context, get the real value?
 *
 * The one place the rule is written down. Everything else in the logistics
 * module asks this rather than deciding for itself, so widening or narrowing
 * who may see a telephone number is a one-line change with one test in front
 * of it.
 */
export function revealPolicyFor(
  viewer: ContactViewer,
  context: ContactContext,
): { reveal: boolean; reason: string } {
  // The courier who has the parcel, on the day they have it. The only reveal.
  if (context === 'ACTIVE_DELIVERY' && viewer.isAssignedDriver) {
    return { reveal: true, reason: 'ASSIGNED_DRIVER_ON_ACTIVE_DELIVERY' };
  }

  /*
   * An operations agent working a live exception - a failed delivery, an
   * address that does not exist - has to be able to reach somebody. It is a
   * narrower door than it looks: EXCEPTION_HANDLING is passed only by the
   * exception endpoints, only for a shipment already in an exception status,
   * and the reveal is audited like every other.
   */
  if (context === 'EXCEPTION_HANDLING' && viewer.permissions.has(
    LogisticsPermission.SHIPMENT_EXCEPTION_WRITE,
  )) {
    return { reveal: true, reason: 'EXCEPTION_HANDLING' };
  }

  return { reveal: false, reason: 'DEFAULT_MASKED' };
}

/** Apply the policy to a telephone number. */
export function contactPhoneFor(
  raw: string | null | undefined,
  viewer: ContactViewer,
  context: ContactContext,
): MaskedContact {
  if (raw === null || raw === undefined || raw.trim().length === 0) return EMPTY;

  const { reveal } = revealPolicyFor(viewer, context);

  return reveal
    ? { display: raw.trim(), isMasked: false, offerSecureContact: false }
    : { display: maskPhone(raw), isMasked: true, offerSecureContact: true };
}

/** Apply the policy to an email address. */
export function contactEmailFor(
  raw: string | null | undefined,
  viewer: ContactViewer,
  context: ContactContext,
): MaskedContact {
  if (raw === null || raw === undefined || raw.trim().length === 0) return EMPTY;

  const { reveal } = revealPolicyFor(viewer, context);

  return reveal
    ? { display: raw.trim(), isMasked: false, offerSecureContact: false }
    : { display: maskEmail(raw), isMasked: true, offerSecureContact: true };
}

/**
 * The fields of a delivery address a carrier may always see.
 *
 * All of them. A parcel cannot be delivered to a masked address, and
 * pretending otherwise would produce a portal nobody could work in. What is
 * withheld is everything the address is *attached to* - the order lines, the
 * prices, the buyer's purchasing history - and that is withheld by never
 * selecting it, which is a stronger control than masking it afterwards.
 *
 * This function exists to make that decision explicit and greppable rather
 * than implicit in the absence of a call.
 */
export function deliveryAddressIsVisibleToCarrier(): true {
  return true;
}

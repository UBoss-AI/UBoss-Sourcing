/**
 * Where a supplier's factory, and each certificate it holds, may move in
 * verification - and who may move it (checklist Master row 13). Pure; the
 * services ask before every write.
 *
 * FACTORY
 *
 * A factory's status is not a column on the factory. It is the state of its
 * CURRENT `SellerTrustCheck` (kind FACTORY, subjectId = the factory), and no
 * current check at all means NOT_SUBMITTED. Every move appends a new check row
 * and flips `isCurrent` on the old one, so the history of decisions is never
 * overwritten:
 *
 *   NOT_SUBMITTED ──seller submits──▶ PENDING ──staff──▶ VERIFIED ──validUntil passes──▶ EXPIRED
 *                                        │                  │
 *                                        └──staff──▶ REJECTED ◀──staff withdraws──┘
 *
 *   REJECTED / EXPIRED ──seller resubmits──▶ PENDING
 *   VERIFIED ──seller changes a material fact──▶ PENDING   (a visible re-verification)
 *
 * CERTIFICATION
 *
 * A certificate carries its own `state` (`TrustCheckState`). It starts PENDING
 * - there is no draft: a certificate is added with its proof, and adding it is
 * asking for it to be checked. The same moves apply, with `expiresOn` in place
 * of `validUntil`.
 */
import { ErrorCode, conflict } from './errors.js';

export type FactoryStatusName = 'NOT_SUBMITTED' | 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXPIRED';
export type CertificationStateName = 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXPIRED';
export type TrustActor = 'SELLER' | 'STAFF' | 'SYSTEM';

type Moves<S extends string> = Record<S, { to: S; actors: TrustActor[] }[]>;

const FACTORY_MOVES: Moves<FactoryStatusName> = {
  NOT_SUBMITTED: [{ to: 'PENDING', actors: ['SELLER'] }],
  PENDING: [
    { to: 'VERIFIED', actors: ['STAFF'] },
    { to: 'REJECTED', actors: ['STAFF'] },
  ],
  VERIFIED: [
    { to: 'EXPIRED', actors: ['SYSTEM'] },
    // A verification that turned out wrong can be withdrawn.
    { to: 'REJECTED', actors: ['STAFF'] },
    // The seller changed what was verified: it has to be checked again.
    { to: 'PENDING', actors: ['SELLER'] },
  ],
  REJECTED: [{ to: 'PENDING', actors: ['SELLER'] }],
  EXPIRED: [{ to: 'PENDING', actors: ['SELLER'] }],
};

const CERTIFICATION_MOVES: Moves<CertificationStateName> = {
  PENDING: [
    { to: 'VERIFIED', actors: ['STAFF'] },
    { to: 'REJECTED', actors: ['STAFF'] },
  ],
  VERIFIED: [
    { to: 'EXPIRED', actors: ['SYSTEM'] },
    { to: 'REJECTED', actors: ['STAFF'] },
    { to: 'PENDING', actors: ['SELLER'] },
  ],
  REJECTED: [{ to: 'PENDING', actors: ['SELLER'] }],
  EXPIRED: [{ to: 'PENDING', actors: ['SELLER'] }],
};

const words = (value: string): string => value.toLowerCase().replace('_', ' ');

export function canMoveFactory(from: FactoryStatusName, to: FactoryStatusName, actor: TrustActor): boolean {
  return FACTORY_MOVES[from].some((move) => move.to === to && move.actors.includes(actor));
}

export function assertFactoryTransition(input: { from: FactoryStatusName; to: FactoryStatusName; actor: TrustActor }): void {
  if (!canMoveFactory(input.from, input.to, input.actor)) {
    throw conflict(
      ErrorCode.FACTORY_TRANSITION_INVALID,
      `A factory that is ${words(input.from)} cannot be moved to ${words(input.to)}.`,
      [{ code: 'TRANSITION', meta: { from: input.from, to: input.to, actor: input.actor } }],
    );
  }
}

export function canMoveCertification(
  from: CertificationStateName,
  to: CertificationStateName,
  actor: TrustActor,
): boolean {
  return CERTIFICATION_MOVES[from].some((move) => move.to === to && move.actors.includes(actor));
}

export function assertCertificationTransition(input: {
  from: CertificationStateName;
  to: CertificationStateName;
  actor: TrustActor;
}): void {
  if (!canMoveCertification(input.from, input.to, input.actor)) {
    throw conflict(
      ErrorCode.CERTIFICATION_TRANSITION_INVALID,
      `A certificate that is ${words(input.from)} cannot be moved to ${words(input.to)}.`,
      [{ code: 'TRANSITION', meta: { from: input.from, to: input.to, actor: input.actor } }],
    );
  }
}

/**
 * The status a factory is in right now, from its current check.
 *
 * A VERIFIED check whose `validUntil` has passed reads as EXPIRED here even
 * before anything has written the EXPIRED row, so no screen and no public page
 * ever presents a lapsed verification as current.
 */
export function effectiveFactoryStatus(
  check: { state: CertificationStateName; validUntil: Date | null } | null,
  now: Date,
): FactoryStatusName {
  if (check === null) return 'NOT_SUBMITTED';
  if (check.state === 'VERIFIED' && check.validUntil !== null && check.validUntil.getTime() <= now.getTime()) {
    return 'EXPIRED';
  }
  return check.state;
}

/** A certificate past its expiry date reads as EXPIRED, whatever its row says. */
export function effectiveCertificationState(
  certificate: { state: CertificationStateName; expiresOn: Date | null },
  today: string,
): CertificationStateName {
  if (
    certificate.state === 'VERIFIED' &&
    certificate.expiresOn !== null &&
    certificate.expiresOn.toISOString().slice(0, 10) < today
  ) {
    return 'EXPIRED';
  }
  return certificate.state;
}

/**
 * Only where the seller may change a factory. While it is with a reviewer the
 * reviewer is looking at exactly what was sent; everywhere else a change is
 * allowed, and on a VERIFIED factory a material change sends it back to review.
 */
export function isFactoryEditable(status: FactoryStatusName): boolean {
  return status !== 'PENDING';
}

export function isCertificationEditable(state: CertificationStateName): boolean {
  return state !== 'PENDING';
}

/**
 * The facts about a factory that a verification vouches for. Changing any of
 * them on a VERIFIED factory sends it back to PENDING. The name is not one: a
 * plant renamed "Unit 2" is the same plant.
 */
export const FACTORY_MATERIAL_FIELDS = Object.freeze([
  'addressLine1',
  'addressLine2',
  'city',
  'region',
  'postcode',
  'countryCode',
  'latitude',
  'longitude',
  'establishedYear',
  'floorAreaSqm',
  'workforceCount',
  'qcStaffCount',
  'monthlyCapacity',
  'capacityUnit',
  'productsMade',
  'qcProcess',
] as const);

export type FactoryMaterialField = (typeof FACTORY_MATERIAL_FIELDS)[number];

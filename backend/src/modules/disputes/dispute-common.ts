/**
 * What every part of the dispute module shares: who is asking, how a
 * dispute is found for them, the text rules, the history writer and the
 * notices. The rules about WHAT may happen live in `dispute.service.ts` and
 * `domain/dispute-state.ts`; this file only makes sure each of them asks the
 * same question the same way.
 *
 * WHO MAY READ A DISPUTE
 *
 *   - **The buyer**: a claim on an order their session may see - the same
 *     scope the Orders page uses, so a company buyer sees what the company's
 *     Orders page shows and nobody else's. Chargebacks are not shown to
 *     buyers: their bank raised it, and it is between the bank and the shop.
 *   - **The seller**: a claim whose `sellerAccountId` is theirs. A claim on a
 *     line of another seller's goods is not theirs to see.
 *   - **Staff** holding `dispute.view`: everything.
 *
 * A reference that is not the asker's answers "not found", exactly like one
 * that does not exist - the order-page rule.
 */
import { randomBytes } from 'node:crypto';
import { env } from '../../config/env.js';
import { characterCount, cleanChatText } from '../../domain/chat-text.js';
import { ErrorCode, badRequest, forbidden, notFound } from '../../domain/errors.js';
import type { PermissionKey } from '../../domain/permissions.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { DisputeEventKind, DisputeParty } from '../../generated/prisma/enums.js';
import { newId } from '../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';

export const DISPUTE_LIMITS = Object.freeze({
  descriptionMin: 10,
  descriptionMax: 5000,
  messageMax: 5000,
  reasonMin: 10,
  reasonMax: 1000,
});

/** Crockford base32 without I, L, O, U - readable over the telephone. */
const REFERENCE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** DP-XXXX-XXXX: 40 random bits, so it cannot be walked to find another one. */
export function newDisputeReference(): string {
  const bytes = randomBytes(8);
  let out = 'DP-';
  bytes.forEach((byte, index) => {
    if (index === 4) out += '-';
    out += REFERENCE_ALPHABET.charAt(byte % 32);
  });
  return out;
}

export const REFERENCE_PATTERN = /^DP-[0-9A-Za-z]{4}-[0-9A-Za-z]{4}$/;

// ---------------------------------------------------------------------------
// Who is asking
// ---------------------------------------------------------------------------

export interface BuyerActor {
  side: 'BUYER';
  userId: string;
  email: string;
  customerProfileId: string;
  /** The orders this session may see - the Orders page's own filter. */
  orderScope: { customerProfileId?: string; buyerCompanyId: string | null };
  ipAddress?: string | null;
  correlationId?: string | null;
}

export interface SellerActor {
  side: 'SELLER';
  userId: string;
  email: string;
  sellerAccountId: string;
  /** Holds `seller.return.handle`: may answer, propose and add evidence. */
  canRespond: boolean;
  ipAddress?: string | null;
  correlationId?: string | null;
}

export interface StaffActor {
  side: 'STAFF';
  userId: string;
  email: string;
  permissions: ReadonlySet<string>;
  ipAddress?: string | null;
  correlationId?: string | null;
}

export type PartyActor = BuyerActor | SellerActor;
export type DisputeActor = PartyActor | StaffActor;

export function requirePermission(actor: StaffActor, ...permissions: PermissionKey[]): void {
  for (const permission of permissions) {
    if (!actor.permissions.has(permission)) {
      throw forbidden(ErrorCode.FORBIDDEN, 'Your role does not allow this.');
    }
  }
}

export function requireSellerCanRespond(actor: SellerActor): void {
  if (!actor.canRespond) {
    throw forbidden(ErrorCode.FORBIDDEN, 'Your role in this seller account cannot answer claims.');
  }
}

/** The filter every buyer read goes through. Claims only. */
export function buyerWhere(actor: BuyerActor): Prisma.DisputeWhereInput {
  return { kind: 'CLAIM', order: actor.orderScope };
}

/** The filter every seller read goes through. Claims on their goods only. */
export function sellerWhere(actor: SellerActor): Prisma.DisputeWhereInput {
  return { kind: 'CLAIM', sellerAccountId: actor.sellerAccountId };
}

export function partyWhere(actor: PartyActor): Prisma.DisputeWhereInput {
  return actor.side === 'BUYER' ? buyerWhere(actor) : sellerWhere(actor);
}

/** The dispute's id, if this party may see it; otherwise "not found". */
export async function ownDisputeId(actor: PartyActor, reference: string): Promise<string> {
  const row = await prisma.dispute.findFirst({
    where: { ...partyWhere(actor), reference: reference.trim().toUpperCase() },
    select: { id: true },
  });
  if (row === null) throw notFound('Dispute');
  return row.id;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * Plain text as it will be stored, or a 400 naming the field. The chat's
 * cleaning: control characters and bidirectional overrides go; nothing is
 * escaped, because nothing renders it as HTML.
 */
export function cleanText(raw: string, field: string, limits: { min: number; max: number }): string {
  const text = cleanChatText(raw).trim();
  const length = characterCount(text);
  if (length < limits.min) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, `${field} is too short.`, [
      { field, code: length === 0 ? 'REQUIRED' : 'TOO_SHORT', meta: { min: limits.min } },
    ]);
  }
  if (length > limits.max) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, `${field} is too long.`, [
      { field, code: 'TOO_LONG', meta: { max: limits.max } },
    ]);
  }
  return text;
}

/** Whole minor units, as a string on the wire. Null when absent. */
export function parseMinor(raw: string | null | undefined, field: string): bigint | null {
  if (raw === undefined || raw === null || raw.trim() === '') return null;
  if (!/^\d{1,18}$/.test(raw.trim())) {
    throw badRequest(ErrorCode.DISPUTE_AMOUNT_INVALID, 'Amounts must be whole minor units.', [
      { field, code: 'INVALID_MONEY' },
    ]);
  }
  return BigInt(raw.trim());
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

type EventClient = Pick<PrismaTransaction, 'disputeEvent'>;

export interface EventInput {
  disputeId: string;
  kind: DisputeEventKind;
  party: DisputeParty;
  visibleToBuyer: boolean;
  visibleToSeller: boolean;
  actorUserId?: string | null;
  body?: string | null;
  fromValue?: string | null;
  toValue?: string | null;
  amountMinor?: bigint | null;
  createdAt?: Date;
}

export async function writeEvent(client: EventClient, input: EventInput): Promise<void> {
  await client.disputeEvent.create({
    data: {
      id: newId(),
      disputeId: input.disputeId,
      kind: input.kind,
      party: input.party,
      visibleToBuyer: input.visibleToBuyer,
      visibleToSeller: input.visibleToSeller,
      actorUserId: input.actorUserId ?? null,
      body: input.body ?? null,
      fromValue: input.fromValue ?? null,
      toValue: input.toValue ?? null,
      amountMinor: input.amountMinor ?? null,
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    },
  });
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

function trimSlash(url: string): string {
  return url.replace(/\/$/, '');
}

export function buyerDisputeUrl(reference: string): string {
  return `${trimSlash(env.CUSTOMER_WEB_PUBLIC_URL)}/account/disputes/${reference}`;
}

export function sellerDisputePath(reference: string): string {
  return `/seller/disputes/${reference}`;
}

export function consoleDisputePath(disputeId: string): string {
  return `/disputes/${disputeId}`;
}

export function consoleDisputeUrl(disputeId: string): string {
  return `${trimSlash(env.ADMIN_WEB_PUBLIC_URL)}${consoleDisputePath(disputeId)}`;
}

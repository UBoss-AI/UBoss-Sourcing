/**
 * A supplier's factories, and the operator's verification of each one -
 * checklist Master row 13.
 *
 * WHAT A SELLER RECORDS
 *
 * Each plant: where it is (with optional coordinates), when it was set up, its
 * floor area, workforce and quality-control staff, what it makes, its monthly
 * capacity and the unit it is counted in, how quality is checked, the machines
 * on its floor, and evidence - existing `SellerDocument`s of this seller (a
 * photograph, an audit report, a lease), each optionally with where it was
 * taken. Then they send the factory for review.
 *
 * WHO DECIDES, AND HOW IT IS RECORDED
 *
 * An operator with `customer.status.write` verifies or refuses it. The status
 * lives in `SellerTrustCheck` rows (kind FACTORY): every submission, decision
 * and expiry APPENDS a row and moves `isCurrent`, so the history of who
 * decided what, when and why is never overwritten. The moves themselves are
 * in `domain/factory-verification-state.ts`.
 *
 * Every state change of one factory takes a row lock on the factory first
 * (`lockFactory`), and a decision is also conditional on the check the
 * reviewer was looking at - two reviewers deciding at once get one winner
 * and one STALE refusal, never two decisions.
 *
 * WHAT THE SELLER CANNOT DO
 *
 * Set a status. There is no field for it on any seller input (the schemas are
 * strict, so an extra `status` is a 400) and no seller route that decides.
 * And a VERIFIED factory whose material facts change goes back to PENDING in
 * the same transaction as the change - a verification never silently covers
 * facts nobody checked.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  FACTORY_MATERIAL_FIELDS,
  assertFactoryTransition,
  effectiveFactoryStatus,
  isFactoryEditable,
  type FactoryStatusName,
} from '../../domain/factory-verification-state.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { assertSellerPermission, type SellerMembership } from '../seller/account.service.js';
import { OPERATOR_LABEL, recordSellerAudit } from '../seller/audit.service.js';
import { notifySeller } from '../seller/notification.service.js';

/** Plants one seller may hold at once. */
export const MAX_FACTORIES_PER_SELLER = 50;
export const MAX_MACHINES_PER_FACTORY = 100;
export const MAX_EVIDENCE_PER_FACTORY = 20;
/** The longest a reviewer may make one verification last, in days. */
const MAX_VALIDITY_DAYS = 5 * 366;

export interface StaffActor {
  userId: string;
  email: string | null;
  correlationId?: string | null;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const count = (max: number) => z.number().int().min(0).max(max).nullable().optional();
const latitude = z.number().min(-90).max(90);
const longitude = z.number().min(-180).max(180);

const factoryFields = {
  name: text(160),
  addressLine1: text(255),
  addressLine2: optionalText(255),
  city: text(120),
  region: optionalText(120),
  postcode: text(24),
  countryCode: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/)
    .transform((value) => value.toUpperCase()),
  latitude: latitude.nullable().optional(),
  longitude: longitude.nullable().optional(),
  establishedYear: z.number().int().min(1800).max(new Date().getUTCFullYear()).nullable().optional(),
  floorAreaSqm: count(100_000_000),
  workforceCount: count(10_000_000),
  qcStaffCount: count(10_000_000),
  monthlyCapacity: count(2_000_000_000),
  capacityUnit: optionalText(40),
  productsMade: optionalText(4000),
  qcProcess: optionalText(4000),
};

type FactoryShape = {
  latitude?: number | null | undefined;
  longitude?: number | null | undefined;
  workforceCount?: number | null | undefined;
  qcStaffCount?: number | null | undefined;
  monthlyCapacity?: number | null | undefined;
  capacityUnit?: string | null | undefined;
};

/**
 * Rules across fields, for a whole factory. A patch is checked against the
 * stored row by the service instead, because only there are both halves of a
 * pair known.
 */
function refineFactory(value: FactoryShape, context: z.RefinementCtx): void {
  const hasLat = value.latitude !== undefined && value.latitude !== null;
  const hasLong = value.longitude !== undefined && value.longitude !== null;
  if (hasLat !== hasLong) {
    context.addIssue({ code: 'custom', path: [hasLat ? 'longitude' : 'latitude'], message: 'Give both coordinates or neither.' });
  }
  if (
    typeof value.workforceCount === 'number' &&
    typeof value.qcStaffCount === 'number' &&
    value.qcStaffCount > value.workforceCount
  ) {
    context.addIssue({ code: 'custom', path: ['qcStaffCount'], message: 'Quality-control staff are part of the workforce, so cannot outnumber it.' });
  }
  if (typeof value.monthlyCapacity === 'number' && value.monthlyCapacity > 0 && (value.capacityUnit ?? '').trim() === '') {
    context.addIssue({ code: 'custom', path: ['capacityUnit'], message: 'Say what the capacity is counted in.' });
  }
}

/** A new factory. Strict: an unknown key - `status`, say - is refused, not ignored. */
export const factoryInput = z.strictObject(factoryFields).superRefine(refineFactory);

/** A change to one. Any subset of the same fields, and nothing else. */
export const factoryPatch = z.strictObject(
  Object.fromEntries(Object.entries(factoryFields).map(([key, schema]) => [key, schema.optional()])) as {
    [K in keyof typeof factoryFields]: z.ZodOptional<(typeof factoryFields)[K]>;
  },
);

export const machinesInput = z.strictObject({
  machines: z
    .array(
      z.strictObject({
        name: text(160),
        quantity: z.number().int().min(1).max(100_000),
        capacityNote: optionalText(255),
      }),
    )
    .max(MAX_MACHINES_PER_FACTORY),
});

export const evidenceInput = z
  .strictObject({
    documentId: z.string().length(26),
    caption: optionalText(255),
    capturedLatitude: latitude.nullable().optional(),
    capturedLongitude: longitude.nullable().optional(),
  })
  .superRefine((value, context) => {
    const hasLat = value.capturedLatitude !== undefined && value.capturedLatitude !== null;
    const hasLong = value.capturedLongitude !== undefined && value.capturedLongitude !== null;
    if (hasLat !== hasLong) {
      context.addIssue({ code: 'custom', path: [hasLat ? 'capturedLongitude' : 'capturedLatitude'], message: 'Give both coordinates or neither.' });
    }
  });

export const factoryDecisionInput = z.strictObject({
  decision: z.enum(['VERIFIED', 'REJECTED']),
  /** The check the reviewer was looking at. A newer one means somebody moved first. */
  expectedCheckId: z.string().length(26),
  /** Seller-visible. Required to refuse. */
  reason: z.string().trim().max(2000).nullable().optional(),
  /** Operator-only. */
  internalNote: z.string().trim().max(4000).nullable().optional(),
  /** When the verification lapses. Defaults to the deployment's re-verification interval. */
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface TrustTimings {
  reverificationDays: number;
  expiryWarningDays: number;
}

/** The deployment's own timings, from `trust_settings`; the schema defaults if the row is missing. */
export async function trustTimings(): Promise<TrustTimings> {
  const row = await prisma.trustSettings.findUnique({
    where: { id: 'default' },
    select: { reverificationDays: true, expiryWarningDays: true },
  });
  return { reverificationDays: row?.reverificationDays ?? 365, expiryWarningDays: row?.expiryWarningDays ?? 30 };
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const FACTORY_INCLUDE = {
  machines: { orderBy: { sortOrder: 'asc' as const } },
  evidence: { orderBy: { createdAt: 'asc' as const } },
} as const;

type FactoryRow = NonNullable<Awaited<ReturnType<typeof loadFactoryRow>>>;

function loadFactoryRow(client: PrismaTransaction | typeof prisma, id: string, sellerAccountId: string | null) {
  return client.sellerFactory.findFirst({
    where: { id, archivedAt: null, ...(sellerAccountId === null ? {} : { sellerAccountId }) },
    include: FACTORY_INCLUDE,
  });
}

type CheckRow = {
  id: string;
  state: 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXPIRED';
  method: string;
  checkedAt: Date | null;
  validUntil: Date | null;
  sellerReason: string | null;
  internalNote: string | null;
  decidedByUserId: string | null;
  isCurrent: boolean;
  createdAt: Date;
};

const CHECK_SELECT = {
  id: true,
  subjectId: true,
  state: true,
  method: true,
  checkedAt: true,
  validUntil: true,
  sellerReason: true,
  internalNote: true,
  decidedByUserId: true,
  isCurrent: true,
  createdAt: true,
} as const;

async function currentCheck(
  client: PrismaTransaction | typeof prisma,
  sellerAccountId: string,
  factoryId: string,
): Promise<CheckRow | null> {
  return client.sellerTrustCheck.findFirst({
    where: { sellerAccountId, kind: 'FACTORY', subjectId: factoryId, isCurrent: true },
    orderBy: { createdAt: 'desc' },
    select: CHECK_SELECT,
  });
}

/** Serialise every change to one factory's verification behind its row. */
async function lockFactory(tx: PrismaTransaction, factoryId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM seller_factories WHERE id = ${factoryId} FOR UPDATE`;
}

const coordinate = (value: { toString(): string } | null): number | null => (value === null ? null : Number(value.toString()));
const fixed = (value: number | null | undefined): string | null | undefined =>
  value === undefined ? undefined : value === null ? null : value.toFixed(7);

/**
 * The facts a verification vouches for, in a fixed order, hashed. Frozen into
 * the check as `checkedValue`, so a later reader can tell whether what is on
 * the factory now is what was verified.
 */
function scalarText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  // A Prisma Decimal, which prints its own digits.
  return (value as { toString(): string }).toString();
}

function materialFingerprint(factory: FactoryRow): string {
  const facts: Record<string, unknown> = {};
  for (const field of FACTORY_MATERIAL_FIELDS) facts[field] = scalarText(factory[field]);
  facts['machines'] = factory.machines.map((machine) => [machine.name, machine.quantity, machine.capacityNote]);
  facts['evidence'] = factory.evidence.map((item) => item.documentId).sort();
  return `sha256:${createHash('sha256').update(JSON.stringify(facts)).digest('hex')}`;
}

export interface FactoryEvidenceView {
  id: string;
  documentId: string;
  caption: string | null;
  capturedLatitude: number | null;
  capturedLongitude: number | null;
  createdAt: string;
  /** Metadata only. The file itself is fetched through the audited document link. */
  document: {
    originalFileName: string;
    kind: string;
    contentType: string;
    byteSize: number;
    scanState: string;
    status: 'PENDING' | 'APPROVED' | 'REJECTED';
    isReplaced: boolean;
  } | null;
}

export interface FactoryCheckView {
  id: string;
  state: 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXPIRED';
  at: string;
  reason: string | null;
  validUntil: string | null;
  /** Operator-only fields, absent on the seller's view. */
  internalNote?: string | null;
  method?: string;
  decidedBy?: { id: string; email: string | null } | null;
}

export interface FactoryView {
  id: string;
  name: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  region: string | null;
  postcode: string;
  countryCode: string;
  latitude: number | null;
  longitude: number | null;
  establishedYear: number | null;
  floorAreaSqm: number | null;
  workforceCount: number | null;
  qcStaffCount: number | null;
  monthlyCapacity: number | null;
  capacityUnit: string | null;
  productsMade: string | null;
  qcProcess: string | null;
  machines: { id: string; name: string; quantity: number; capacityNote: string | null }[];
  evidence: FactoryEvidenceView[];
  verification: {
    status: FactoryStatusName;
    /** The current check, which a reviewer's decision names. Null before the first submission. */
    checkId: string | null;
    /** The seller-visible reason on the latest decision. */
    reason: string | null;
    submittedAt: string | null;
    decidedAt: string | null;
    validUntil: string | null;
    isEditable: boolean;
  };
  history: FactoryCheckView[];
  createdAt: string;
  updatedAt: string;
}

async function documentsById(ids: string[], sellerAccountId: string) {
  if (ids.length === 0) return new Map<string, FactoryEvidenceView['document']>();
  const rows = await prisma.sellerDocument.findMany({
    where: { id: { in: ids }, sellerAccountId },
    select: {
      id: true,
      originalFileName: true,
      kind: true,
      contentType: true,
      byteSize: true,
      scanState: true,
      approvedAt: true,
      rejectedReason: true,
      supersededAt: true,
    },
  });
  return new Map(
    rows.map((row) => [
      row.id,
      {
        originalFileName: row.originalFileName,
        kind: row.kind,
        contentType: row.contentType,
        byteSize: row.byteSize,
        scanState: row.scanState,
        status: row.approvedAt !== null ? ('APPROVED' as const) : row.rejectedReason !== null ? ('REJECTED' as const) : ('PENDING' as const),
        isReplaced: row.supersededAt !== null,
      },
    ]),
  );
}

async function viewFactories(
  sellerAccountId: string,
  rows: FactoryRow[],
  audience: 'seller' | 'staff',
  now: Date,
): Promise<FactoryView[]> {
  const ids = rows.map((row) => row.id);
  const [checks, documents] = await Promise.all([
    ids.length === 0
      ? Promise.resolve([])
      : prisma.sellerTrustCheck.findMany({
          where: { sellerAccountId, kind: 'FACTORY', subjectId: { in: ids } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: CHECK_SELECT,
        }),
    documentsById(
      rows.flatMap((row) => row.evidence.map((item) => item.documentId)),
      sellerAccountId,
    ),
  ]);

  const reviewers =
    audience === 'staff'
      ? new Map(
          (
            await prisma.user.findMany({
              where: { id: { in: [...new Set(checks.map((check) => check.decidedByUserId).filter((id): id is string => id !== null))] } },
              select: { id: true, email: true },
            })
          ).map((user) => [user.id, user.email]),
        )
      : new Map<string, string | null>();

  return rows.map((row) => {
    const own = checks.filter((check) => check.subjectId === row.id);
    const current = own.filter((check) => check.isCurrent).at(-1) ?? null;
    const status = effectiveFactoryStatus(current, now);
    const latestDecision = [...own].reverse().find((check) => check.state !== 'PENDING') ?? null;
    const latestSubmission = [...own].reverse().find((check) => check.state === 'PENDING') ?? null;
    return {
      id: row.id,
      name: row.name,
      addressLine1: row.addressLine1,
      addressLine2: row.addressLine2,
      city: row.city,
      region: row.region,
      postcode: row.postcode,
      countryCode: row.countryCode,
      latitude: coordinate(row.latitude),
      longitude: coordinate(row.longitude),
      establishedYear: row.establishedYear,
      floorAreaSqm: row.floorAreaSqm,
      workforceCount: row.workforceCount,
      qcStaffCount: row.qcStaffCount,
      monthlyCapacity: row.monthlyCapacity,
      capacityUnit: row.capacityUnit,
      productsMade: row.productsMade,
      qcProcess: row.qcProcess,
      machines: row.machines.map((machine) => ({
        id: machine.id,
        name: machine.name,
        quantity: machine.quantity,
        capacityNote: machine.capacityNote,
      })),
      evidence: row.evidence.map((item) => ({
        id: item.id,
        documentId: item.documentId,
        caption: item.caption,
        capturedLatitude: coordinate(item.capturedLatitude),
        capturedLongitude: coordinate(item.capturedLongitude),
        createdAt: item.createdAt.toISOString(),
        document: documents.get(item.documentId) ?? null,
      })),
      verification: {
        status,
        checkId: current?.id ?? null,
        reason: current !== null && current.state !== 'PENDING' ? current.sellerReason : null,
        submittedAt: latestSubmission?.createdAt.toISOString() ?? null,
        decidedAt: latestDecision?.checkedAt?.toISOString() ?? latestDecision?.createdAt.toISOString() ?? null,
        validUntil: current?.state === 'VERIFIED' || status === 'EXPIRED' ? (current?.validUntil?.toISOString() ?? null) : null,
        isEditable: isFactoryEditable(status),
      },
      history: own.map((check) => ({
        id: check.id,
        state: check.state,
        at: (check.checkedAt ?? check.createdAt).toISOString(),
        reason: check.sellerReason,
        validUntil: check.validUntil?.toISOString() ?? null,
        ...(audience === 'staff'
          ? {
              internalNote: check.internalNote,
              method: check.method,
              decidedBy:
                check.decidedByUserId === null
                  ? null
                  : { id: check.decidedByUserId, email: reviewers.get(check.decidedByUserId) ?? null },
            }
          : {}),
      })),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}

/**
 * Move every lapsed verification of these factories to EXPIRED, on read.
 *
 * The worker's sweep does the same for factories nobody opens; this makes
 * sure that the first screen to look at a lapsed one records it rather than
 * showing "verified" until the sweep comes round.
 */
async function expireLapsed(sellerAccountId: string, factoryIds: string[], now: Date): Promise<void> {
  if (factoryIds.length === 0) return;
  const lapsed = await prisma.sellerTrustCheck.findMany({
    where: {
      sellerAccountId,
      kind: 'FACTORY',
      subjectId: { in: factoryIds },
      isCurrent: true,
      state: 'VERIFIED',
      validUntil: { lte: now },
    },
    select: { subjectId: true },
  });
  for (const check of lapsed) await expireFactory(sellerAccountId, check.subjectId, now);
}

/** One factory's lapsed verification, as an appended EXPIRED check. Safe to race. */
async function expireFactory(sellerAccountId: string, factoryId: string, now: Date): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await lockFactory(tx, factoryId);
    const current = await currentCheck(tx, sellerAccountId, factoryId);
    if (current?.state !== 'VERIFIED' || current.validUntil === null || current.validUntil.getTime() > now.getTime()) {
      return false; // Somebody moved it first, or it has not lapsed.
    }
    assertFactoryTransition({ from: 'VERIFIED', to: 'EXPIRED', actor: 'SYSTEM' });
    await appendCheck(tx, {
      sellerAccountId,
      factoryId,
      previousId: current.id,
      state: 'EXPIRED',
      method: 'system',
      checkedAt: now,
      validUntil: current.validUntil,
    });
    await recordAudit(
      {
        action: AuditAction.SELLER_FACTORY_EXPIRED,
        resourceType: 'seller_factory',
        resourceId: factoryId,
        actorType: 'SYSTEM',
        before: { status: 'VERIFIED' },
        after: { status: 'EXPIRED', validUntil: current.validUntil.toISOString() },
      },
      tx,
    );
    await recordSellerAudit({
      sellerAccountId,
      action: 'seller.factory.expired',
      actor: { type: 'SYSTEM', label: OPERATOR_LABEL },
      resourceType: 'seller_factory',
      resourceId: factoryId,
      summary: 'A factory verification reached its end date and must be renewed.',
      tx,
    });
    return true;
  });
}

/**
 * Append a check and retire the one it replaces.
 *
 * Conditional on the previous check still being current: if it is not, a
 * colleague or the seller moved first and this write is refused as STALE
 * rather than landing a second "current" row.
 */
async function appendCheck(
  tx: PrismaTransaction,
  input: {
    sellerAccountId: string;
    factoryId: string;
    previousId: string | null;
    state: 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXPIRED';
    method?: string;
    checkedAt?: Date | null;
    validUntil?: Date | null;
    checkedValue?: string | null;
    sellerReason?: string | null;
    internalNote?: string | null;
    decidedByUserId?: string | null;
  },
): Promise<string> {
  if (input.previousId !== null) {
    const retired = await tx.sellerTrustCheck.updateMany({
      where: { id: input.previousId, isCurrent: true },
      data: { isCurrent: false },
    });
    if (retired.count === 0) throw staleFactory();
  } else {
    const existing = await tx.sellerTrustCheck.count({
      where: { sellerAccountId: input.sellerAccountId, kind: 'FACTORY', subjectId: input.factoryId, isCurrent: true },
    });
    if (existing > 0) throw staleFactory();
  }
  const id = newId();
  await tx.sellerTrustCheck.create({
    data: {
      id,
      sellerAccountId: input.sellerAccountId,
      kind: 'FACTORY',
      subjectId: input.factoryId,
      state: input.state,
      method: input.method ?? 'manual_review',
      checkedAt: input.checkedAt ?? null,
      validUntil: input.validUntil ?? null,
      checkedValue: input.checkedValue ?? null,
      sellerReason: input.sellerReason ?? null,
      internalNote: input.internalNote ?? null,
      decidedByUserId: input.decidedByUserId ?? null,
      isCurrent: true,
    },
  });
  return id;
}

const staleFactory = () =>
  conflict(ErrorCode.FACTORY_TRANSITION_INVALID, 'This factory changed while you were looking at it. Reload it and decide again.', [
    { code: 'STALE' },
  ]);

// ---------------------------------------------------------------------------
// The seller's side
// ---------------------------------------------------------------------------

async function ownFactory(membership: SellerMembership, factoryId: string): Promise<FactoryRow> {
  const row = await loadFactoryRow(prisma, factoryId, membership.sellerAccountId);
  // Another seller's factory is the same answer as one that never existed.
  if (row === null) throw notFound('Factory');
  return row;
}

async function oneView(membership: SellerMembership, factoryId: string): Promise<FactoryView> {
  const row = await ownFactory(membership, factoryId);
  const [view] = await viewFactories(membership.sellerAccountId, [row], 'seller', new Date());
  return view!;
}

/** Every plant this seller has recorded, with where each one's verification stands. */
export async function listFactories(membership: SellerMembership): Promise<FactoryView[]> {
  assertSellerPermission(membership, SellerPermission.ACCOUNT_READ);
  const now = new Date();
  const ids = (
    await prisma.sellerFactory.findMany({
      where: { sellerAccountId: membership.sellerAccountId, archivedAt: null },
      select: { id: true },
    })
  ).map((row) => row.id);
  await expireLapsed(membership.sellerAccountId, ids, now);
  const rows = await prisma.sellerFactory.findMany({
    where: { sellerAccountId: membership.sellerAccountId, archivedAt: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: FACTORY_INCLUDE,
  });
  return viewFactories(membership.sellerAccountId, rows, 'seller', now);
}

function sellerActor(membership: SellerMembership) {
  return { type: 'CUSTOMER' as const, label: membership.displayName };
}

export async function createFactory(
  membership: SellerMembership,
  input: z.infer<typeof factoryInput>,
  correlationId?: string | null,
): Promise<FactoryView> {
  assertSellerPermission(membership, SellerPermission.ACCOUNT_WRITE);
  const held = await prisma.sellerFactory.count({ where: { sellerAccountId: membership.sellerAccountId, archivedAt: null } });
  if (held >= MAX_FACTORIES_PER_SELLER) {
    throw conflict(ErrorCode.CONFLICT, `You can record up to ${String(MAX_FACTORIES_PER_SELLER)} factories. Archive one you no longer use.`);
  }
  const id = newId();
  await prisma.$transaction(async (tx) => {
    await tx.sellerFactory.create({
      data: {
        id,
        sellerAccountId: membership.sellerAccountId,
        name: input.name,
        addressLine1: input.addressLine1,
        addressLine2: input.addressLine2 ?? null,
        city: input.city,
        region: input.region ?? null,
        postcode: input.postcode,
        countryCode: input.countryCode,
        latitude: fixed(input.latitude) ?? null,
        longitude: fixed(input.longitude) ?? null,
        establishedYear: input.establishedYear ?? null,
        floorAreaSqm: input.floorAreaSqm ?? null,
        workforceCount: input.workforceCount ?? null,
        qcStaffCount: input.qcStaffCount ?? null,
        monthlyCapacity: input.monthlyCapacity ?? null,
        capacityUnit: input.capacityUnit ?? null,
        productsMade: input.productsMade ?? null,
        qcProcess: input.qcProcess ?? null,
      },
    });
    await recordSellerAudit({
      sellerAccountId: membership.sellerAccountId,
      action: 'seller.factory.created',
      actor: sellerActor(membership),
      resourceType: 'seller_factory',
      resourceId: id,
      after: { name: input.name, city: input.city, countryCode: input.countryCode },
      summary: `Added the factory "${input.name}".`,
      correlationId: correlationId ?? null,
      tx,
    });
  });
  return oneView(membership, id);
}

/**
 * Change a factory, in the same transaction as whatever that does to its
 * verification: refused while it is with a reviewer, and a material change to
 * a VERIFIED factory sends it back to PENDING.
 */
async function changeFactory(
  membership: SellerMembership,
  factoryId: string,
  action: string,
  summary: string,
  apply: (tx: PrismaTransaction, factory: FactoryRow) => Promise<{ material: boolean; before?: unknown; after?: unknown }>,
  correlationId?: string | null,
): Promise<FactoryView> {
  assertSellerPermission(membership, SellerPermission.ACCOUNT_WRITE);
  await ownFactory(membership, factoryId);
  const now = new Date();
  await expireLapsed(membership.sellerAccountId, [factoryId], now);

  await prisma.$transaction(async (tx) => {
    await lockFactory(tx, factoryId);
    const factory = await loadFactoryRow(tx, factoryId, membership.sellerAccountId);
    if (factory === null) throw notFound('Factory');
    const current = await currentCheck(tx, membership.sellerAccountId, factoryId);
    const status = effectiveFactoryStatus(current, now);
    if (!isFactoryEditable(status)) {
      throw conflict(ErrorCode.FACTORY_NOT_EDITABLE, 'This factory is with a reviewer. Wait for their decision before you change it.');
    }

    const change = await apply(tx, factory);

    let reverify = false;
    if (change.material && status === 'VERIFIED' && current !== null) {
      assertFactoryTransition({ from: 'VERIFIED', to: 'PENDING', actor: 'SELLER' });
      await appendCheck(tx, { sellerAccountId: membership.sellerAccountId, factoryId, previousId: current.id, state: 'PENDING' });
      reverify = true;
    }

    await recordSellerAudit({
      sellerAccountId: membership.sellerAccountId,
      action,
      actor: sellerActor(membership),
      resourceType: 'seller_factory',
      resourceId: factoryId,
      before: change.before,
      after: change.after,
      summary: reverify ? `${summary} It was verified, so it has gone back for review.` : summary,
      correlationId: correlationId ?? null,
      tx,
    });
  });
  return oneView(membership, factoryId);
}

export async function updateFactory(
  membership: SellerMembership,
  factoryId: string,
  patch: z.infer<typeof factoryPatch>,
  correlationId?: string | null,
): Promise<FactoryView> {
  return changeFactory(
    membership,
    factoryId,
    'seller.factory.updated',
    'Changed a factory’s details.',
    async (tx, factory) => {
      const data: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        data[key] = key === 'latitude' || key === 'longitude' ? fixed(value as number | null) : value;
      }
      // Coordinates travel as a pair. A patch naming one keeps the other only
      // if the result is still a pair or no pair at all.
      const nextLat = 'latitude' in data ? data['latitude'] : factory.latitude;
      const nextLong = 'longitude' in data ? data['longitude'] : factory.longitude;
      if ((nextLat === null) !== (nextLong === null)) {
        throw badRequest(ErrorCode.VALIDATION_FAILED, 'Give both coordinates or neither.', [{ field: 'latitude', code: 'PAIR' }]);
      }
      const nextWorkforce = 'workforceCount' in data ? data['workforceCount'] : factory.workforceCount;
      const nextQc = 'qcStaffCount' in data ? data['qcStaffCount'] : factory.qcStaffCount;
      if (typeof nextWorkforce === 'number' && typeof nextQc === 'number' && nextQc > nextWorkforce) {
        throw badRequest(ErrorCode.VALIDATION_FAILED, 'Quality-control staff are part of the workforce, so cannot outnumber it.', [
          { field: 'qcStaffCount', code: 'ABOVE_WORKFORCE' },
        ]);
      }
      const nextCapacity = 'monthlyCapacity' in data ? data['monthlyCapacity'] : factory.monthlyCapacity;
      const nextUnit = 'capacityUnit' in data ? data['capacityUnit'] : factory.capacityUnit;
      if (typeof nextCapacity === 'number' && nextCapacity > 0 && (typeof nextUnit !== 'string' || nextUnit.trim() === '')) {
        throw badRequest(ErrorCode.VALIDATION_FAILED, 'Say what the capacity is counted in.', [{ field: 'capacityUnit', code: 'REQUIRED' }]);
      }

      const changed = Object.keys(data).filter((key) => {
        const before = (factory as unknown as Record<string, unknown>)[key];
        // A decimal read back as "18.52" is the same coordinate as "18.5200000".
        const normal = (value: unknown): string | null => {
          const printed = scalarText(value);
          return printed !== null && (key === 'latitude' || key === 'longitude') ? String(Number(printed)) : printed;
        };
        return normal(before) !== normal(data[key]);
      });
      if (changed.length === 0) return { material: false };

      await tx.sellerFactory.update({ where: { id: factory.id }, data: Object.fromEntries(changed.map((key) => [key, data[key]])) });
      const material = changed.some((key) => (FACTORY_MATERIAL_FIELDS as readonly string[]).includes(key));
      const pick = (source: Record<string, unknown>) => Object.fromEntries(changed.map((key) => [key, source[key] ?? null]));
      return {
        material,
        before: pick(factory),
        after: pick(data),
      };
    },
    correlationId,
  );
}

/** Replace the list of machines on the floor. A changed list is a material change. */
export async function replaceMachines(
  membership: SellerMembership,
  factoryId: string,
  input: z.infer<typeof machinesInput>,
  correlationId?: string | null,
): Promise<FactoryView> {
  return changeFactory(
    membership,
    factoryId,
    'seller.factory.machines_updated',
    'Changed the machines listed for a factory.',
    async (tx, factory) => {
      const before = factory.machines.map((machine) => [machine.name, machine.quantity, machine.capacityNote ?? null]);
      const after = input.machines.map((machine) => [machine.name, machine.quantity, machine.capacityNote ?? null]);
      if (JSON.stringify(before) === JSON.stringify(after)) return { material: false };
      await tx.sellerFactoryMachine.deleteMany({ where: { factoryId: factory.id } });
      if (input.machines.length > 0) {
        await tx.sellerFactoryMachine.createMany({
          data: input.machines.map((machine, index) => ({
            id: newId(),
            factoryId: factory.id,
            name: machine.name,
            quantity: machine.quantity,
            capacityNote: machine.capacityNote ?? null,
            sortOrder: index,
          })),
        });
      }
      return { material: true, before: { machines: before.length }, after: { machines: after.length } };
    },
    correlationId,
  );
}

/**
 * The seller's own document, fit to be offered as evidence.
 *
 * Another seller's document is a 404 - the same answer as one that does not
 * exist, so this cannot be used to probe for ids. A replaced or withdrawn one,
 * or one that failed its scan, is refused by name.
 */
export async function usableOwnDocument(sellerAccountId: string, documentId: string): Promise<void> {
  const document = await prisma.sellerDocument.findFirst({
    where: { id: documentId, sellerAccountId },
    select: { supersededAt: true, scanState: true },
  });
  if (document === null) throw notFound('Document');
  if (document.supersededAt !== null || document.scanState === 'INFECTED' || document.scanState === 'SCAN_FAILED') {
    throw conflict(ErrorCode.TRUST_EVIDENCE_UNUSABLE, 'That document was replaced, withdrawn or failed its security scan. Choose or upload another.');
  }
}

/** Attach one of the seller's documents as evidence. Adding proof never undoes a verification. */
export async function addEvidence(
  membership: SellerMembership,
  factoryId: string,
  input: z.infer<typeof evidenceInput>,
  correlationId?: string | null,
): Promise<FactoryView> {
  await usableOwnDocument(membership.sellerAccountId, input.documentId);
  return changeFactory(
    membership,
    factoryId,
    'seller.factory.evidence_added',
    'Attached evidence to a factory.',
    async (tx, factory) => {
      if (factory.evidence.some((item) => item.documentId === input.documentId)) return { material: false };
      if (factory.evidence.length >= MAX_EVIDENCE_PER_FACTORY) {
        throw conflict(ErrorCode.CONFLICT, `A factory can carry up to ${String(MAX_EVIDENCE_PER_FACTORY)} pieces of evidence.`);
      }
      await tx.sellerFactoryEvidence.create({
        data: {
          id: newId(),
          factoryId: factory.id,
          documentId: input.documentId,
          caption: input.caption ?? null,
          capturedLatitude: fixed(input.capturedLatitude) ?? null,
          capturedLongitude: fixed(input.capturedLongitude) ?? null,
        },
      });
      return { material: false, after: { documentId: input.documentId } };
    },
    correlationId,
  );
}

/** Detach evidence. Removing proof a verification relied on sends a verified factory back for review. */
export async function removeEvidence(
  membership: SellerMembership,
  factoryId: string,
  evidenceId: string,
  correlationId?: string | null,
): Promise<FactoryView> {
  return changeFactory(
    membership,
    factoryId,
    'seller.factory.evidence_removed',
    'Removed evidence from a factory.',
    async (tx, factory) => {
      const item = factory.evidence.find((entry) => entry.id === evidenceId);
      if (item === undefined) throw notFound('Evidence');
      await tx.sellerFactoryEvidence.delete({ where: { id: item.id } });
      return { material: true, before: { documentId: item.documentId } };
    },
    correlationId,
  );
}

/** Stop showing a factory. Its history of checks is kept. */
export async function archiveFactory(
  membership: SellerMembership,
  factoryId: string,
  correlationId?: string | null,
): Promise<void> {
  assertSellerPermission(membership, SellerPermission.ACCOUNT_WRITE);
  const factory = await ownFactory(membership, factoryId);
  await prisma.$transaction(async (tx) => {
    await tx.sellerFactory.update({ where: { id: factory.id }, data: { archivedAt: new Date() } });
    await recordSellerAudit({
      sellerAccountId: membership.sellerAccountId,
      action: 'seller.factory.archived',
      actor: sellerActor(membership),
      resourceType: 'seller_factory',
      resourceId: factory.id,
      summary: `Archived the factory "${factory.name}".`,
      correlationId: correlationId ?? null,
      tx,
    });
  });
}

/** Send a factory for review: first time, after a refusal, or after it expired. */
export async function submitFactory(
  membership: SellerMembership,
  factoryId: string,
  correlationId?: string | null,
): Promise<FactoryView> {
  assertSellerPermission(membership, SellerPermission.ACCOUNT_SUBMIT);
  await ownFactory(membership, factoryId);
  const now = new Date();
  await expireLapsed(membership.sellerAccountId, [factoryId], now);

  await prisma.$transaction(async (tx) => {
    await lockFactory(tx, factoryId);
    const factory = await loadFactoryRow(tx, factoryId, membership.sellerAccountId);
    if (factory === null) throw notFound('Factory');
    const current = await currentCheck(tx, membership.sellerAccountId, factoryId);
    const status = effectiveFactoryStatus(current, now);
    if (status === 'VERIFIED' || status === 'PENDING') {
      throw conflict(
        ErrorCode.FACTORY_TRANSITION_INVALID,
        status === 'PENDING' ? 'This factory is already with a reviewer.' : 'This factory is verified. Change its details to send it for review again.',
        [{ code: 'TRANSITION', meta: { from: status, to: 'PENDING', actor: 'SELLER' } }],
      );
    }
    assertFactoryTransition({ from: status, to: 'PENDING', actor: 'SELLER' });
    if (factory.evidence.length === 0) {
      throw badRequest(ErrorCode.FACTORY_INCOMPLETE, 'Attach at least one piece of evidence - a photograph, an audit report, a lease - before sending the factory for review.', [
        { field: 'evidence', code: 'REQUIRED' },
      ]);
    }
    await appendCheck(tx, {
      sellerAccountId: membership.sellerAccountId,
      factoryId,
      previousId: current?.id ?? null,
      state: 'PENDING',
    });
    await recordSellerAudit({
      sellerAccountId: membership.sellerAccountId,
      action: 'seller.factory.submitted',
      actor: sellerActor(membership),
      resourceType: 'seller_factory',
      resourceId: factoryId,
      before: { status },
      after: { status: 'PENDING' },
      summary: `Sent the factory "${factory.name}" for verification.`,
      correlationId: correlationId ?? null,
      tx,
    });
  });
  return oneView(membership, factoryId);
}

// ---------------------------------------------------------------------------
// The operator's side
// ---------------------------------------------------------------------------

/** Every current factory of one seller, with evidence metadata and the full history of checks. */
export async function listFactoriesForReview(sellerAccountId: string): Promise<FactoryView[]> {
  const exists = await prisma.sellerAccount.count({ where: { id: sellerAccountId } });
  if (exists === 0) throw notFound('Seller');
  const now = new Date();
  const ids = (
    await prisma.sellerFactory.findMany({ where: { sellerAccountId, archivedAt: null }, select: { id: true } })
  ).map((row) => row.id);
  await expireLapsed(sellerAccountId, ids, now);
  const rows = await prisma.sellerFactory.findMany({
    where: { sellerAccountId, archivedAt: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: FACTORY_INCLUDE,
  });
  return viewFactories(sellerAccountId, rows, 'staff', now);
}

const dateOnlyToEndOfDay = (value: string): Date => new Date(`${value}T23:59:59.999Z`);

/**
 * Verify or refuse a factory, or withdraw a verification that turned out
 * wrong. Appends a check; never edits one.
 */
export async function decideFactory(input: {
  factoryId: string;
  decision: 'VERIFIED' | 'REJECTED';
  expectedCheckId: string;
  reason: string | null;
  internalNote: string | null;
  validUntil: string | null;
  actor: StaffActor;
}): Promise<FactoryView> {
  const found = await prisma.sellerFactory.findFirst({
    where: { id: input.factoryId, archivedAt: null },
    select: { sellerAccountId: true },
  });
  if (found === null) throw notFound('Factory');
  const sellerAccountId = found.sellerAccountId;
  const now = new Date();
  await expireLapsed(sellerAccountId, [input.factoryId], now);

  const reason = input.reason === null || input.reason.trim() === '' ? null : input.reason.trim();
  if (input.decision === 'REJECTED' && (reason === null || reason.length < 5)) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Say why the factory is refused; the seller is shown the reason.', [
      { field: 'reason', code: 'REQUIRED' },
    ]);
  }

  const { reverificationDays } = await trustTimings();
  let validUntil: Date | null = null;
  if (input.decision === 'VERIFIED') {
    validUntil = input.validUntil === null ? new Date(now.getTime() + reverificationDays * DAY_MS) : dateOnlyToEndOfDay(input.validUntil);
    if (validUntil.getTime() <= now.getTime() || validUntil.getTime() > now.getTime() + MAX_VALIDITY_DAYS * DAY_MS) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'The verification must end after today and within five years.', [
        { field: 'validUntil', code: 'OUT_OF_RANGE' },
      ]);
    }
  }

  let factoryName = '';
  let previous: FactoryStatusName = 'NOT_SUBMITTED';
  await prisma.$transaction(async (tx) => {
    await lockFactory(tx, input.factoryId);
    const factory = await loadFactoryRow(tx, input.factoryId, sellerAccountId);
    if (factory === null) throw notFound('Factory');
    factoryName = factory.name;
    const current = await currentCheck(tx, sellerAccountId, input.factoryId);
    // A decision taken on a screen that is out of date - a colleague decided,
    // the seller changed it, it lapsed - is refused, never layered on top.
    if (current === null || current.id !== input.expectedCheckId) throw staleFactory();
    previous = effectiveFactoryStatus(current, now);
    assertFactoryTransition({ from: previous, to: input.decision, actor: 'STAFF' });
    if (input.decision === 'VERIFIED' && factory.evidence.length === 0) {
      throw conflict(ErrorCode.FACTORY_INCOMPLETE, 'This factory has no evidence attached. Refuse it and say what is needed.', [
        { field: 'evidence', code: 'REQUIRED' },
      ]);
    }

    await appendCheck(tx, {
      sellerAccountId,
      factoryId: input.factoryId,
      previousId: current.id,
      state: input.decision,
      checkedAt: now,
      validUntil,
      checkedValue: input.decision === 'VERIFIED' ? materialFingerprint(factory) : null,
      sellerReason: reason,
      internalNote: input.internalNote === null || input.internalNote.trim() === '' ? null : input.internalNote.trim(),
      decidedByUserId: input.actor.userId,
    });
    await recordAudit(
      {
        action: AuditAction.SELLER_FACTORY_DECIDED,
        resourceType: 'seller_factory',
        resourceId: input.factoryId,
        actorType: 'ADMIN',
        actorUserId: input.actor.userId,
        actorEmail: input.actor.email,
        before: { status: previous },
        after: { status: input.decision, validUntil: validUntil?.toISOString() ?? null, sellerAccountId },
        correlationId: input.actor.correlationId ?? null,
      },
      tx,
    );
    await recordSellerAudit({
      sellerAccountId,
      action: 'seller.factory.decided',
      actor: { type: 'ADMIN', userId: input.actor.userId, label: OPERATOR_LABEL },
      resourceType: 'seller_factory',
      resourceId: input.factoryId,
      before: { status: previous },
      after: { status: input.decision },
      summary:
        input.decision === 'VERIFIED'
          ? `The factory "${factory.name}" was verified.`
          : `The factory "${factory.name}" was not verified: ${reason ?? ''}`,
      correlationId: input.actor.correlationId ?? null,
      tx,
    });
  });

  await notifySeller({
    sellerAccountId,
    kind: 'APPLICATION_STATUS',
    title: input.decision === 'VERIFIED' ? 'Your factory was verified' : 'Your factory was not verified',
    body:
      input.decision === 'VERIFIED'
        ? `"${factoryName}" can now be shown on your supplier page as a verified factory.`
        : `"${factoryName}": ${reason ?? ''}`,
    linkPath: '/seller/factories',
    severity: input.decision === 'VERIFIED' ? 'SUCCESS' : 'WARNING',
    subjectType: 'seller_factory',
    subjectId: input.factoryId,
  }).catch((error: unknown) => {
    logger.warn({ err: error, factoryId: input.factoryId }, 'could not notify the seller of a factory decision');
  });

  const row = await loadFactoryRow(prisma, input.factoryId, sellerAccountId);
  const [view] = await viewFactories(sellerAccountId, [row!], 'staff', new Date());
  return view!;
}

// ---------------------------------------------------------------------------
// The public page, and the worker
// ---------------------------------------------------------------------------

/**
 * The factories a public page may show: the current check is VERIFIED and has
 * not passed its end date. Read straight from the checks, so a lapsed one is
 * hidden even before anything has recorded that it lapsed.
 */
export async function verifiedFactoryIds(sellerAccountId: string, now: Date): Promise<Map<string, Date | null>> {
  const checks = await prisma.sellerTrustCheck.findMany({
    where: {
      sellerAccountId,
      kind: 'FACTORY',
      isCurrent: true,
      state: 'VERIFIED',
      validUntil: { gt: now },
    },
    select: { subjectId: true, checkedAt: true },
  });
  return new Map(checks.map((check) => [check.subjectId, check.checkedAt]));
}

/** For the worker: record every lapsed factory verification. Bounded per beat. */
export async function sweepExpiredFactories(now: Date = new Date(), limit = 200): Promise<number> {
  const lapsed = await prisma.sellerTrustCheck.findMany({
    where: { kind: 'FACTORY', isCurrent: true, state: 'VERIFIED', validUntil: { lte: now } },
    select: { sellerAccountId: true, subjectId: true },
    take: limit,
  });
  let expired = 0;
  for (const check of lapsed) {
    try {
      if (await expireFactory(check.sellerAccountId, check.subjectId, now)) expired += 1;
    } catch (error) {
      logger.error({ err: error, factoryId: check.subjectId }, 'could not expire a factory verification');
    }
  }
  return expired;
}

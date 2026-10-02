/**
 * Storefront banners and category content blocks - checklist Master row 72,
 * with approval, preview, versions and conflict checks (JOURNEY-067).
 *
 * The operator writes a block, targets it at a country and/or a language
 * ('' = everyone), schedules it (`startsAt` / `endsAt`, either open) and sends
 * it for approval. A DIFFERENT member of staff approves it, and only then is
 * it published. Any edit sends a block back to DRAFT and off the storefront
 * until it is approved again, so what shoppers see is always something two
 * people agreed to.
 *
 *     DRAFT --submit--> PENDING_APPROVAL --approve (someone else)--> PUBLISHED
 *       ^                     |                                        |
 *       +------- return ------+------------------ return / any edit ---+
 *
 * Every save writes a `content_block_versions` snapshot. Restoring a version
 * writes it back as a new save (so a DRAFT, needing approval again): nothing
 * is overwritten and the history only grows.
 *
 * Conflict checks run on every save and are returned as warnings. Two of them
 * are serious enough that approval refuses the block (CONTENT_BLOCK_CONFLICT):
 * a coupon that ends before the block starts, and an archived coupon.
 *
 * Promotions are the existing coupons: a block may name one by code, and the
 * code is shown to shoppers only while that coupon is ACTIVE and publicly
 * listed - a block never advertises a code the cart would refuse.
 */
import { z } from 'zod';
import type { ContentBlock, Prisma } from '../../generated/prisma/client.js';
import { badRequest, conflict, ErrorCode, forbidden, notFound } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit, type AuditActionKey } from '../audit/audit.service.js';
import type { SettingsActor } from './settings.service.js';

/** Root-relative ("/media/...") or https://. Never javascript: or http:. */
const SAFE_URL = z
  .string()
  .trim()
  .max(1024)
  .refine((value) => /^\/(?!\/)/.test(value) || /^https:\/\/[^\s]+$/i.test(value), 'URL');

export const contentBlockInput = z
  .object({
    placement: z.enum(['HOME_BANNER', 'CATEGORY_BLOCK']),
    categoryId: z.string().length(26).nullable().optional(),
    title: z.string().trim().min(1).max(160),
    body: z.string().trim().max(4000).nullable().optional(),
    imageUrl: SAFE_URL.nullable().optional(),
    linkUrl: SAFE_URL.nullable().optional(),
    couponCode: z.string().trim().max(32).nullable().optional(),
    countryCode: z
      .string()
      .trim()
      .regex(/^([A-Za-z]{2})?$/)
      .transform((value) => value.toUpperCase())
      .default(''),
    languageCode: z
      .string()
      .trim()
      .regex(/^([a-z]{2}(-[A-Za-z]{2,4})?)?$/)
      .default(''),
    startsAt: z.coerce.date().nullable().optional(),
    endsAt: z.coerce.date().nullable().optional(),
    /**
     * True sends the block for approval as it is saved. It never publishes on
     * its own: a second member of staff has to approve it.
     */
    isPublished: z.boolean().default(false),
    sortOrder: z.number().int().min(-1000).max(1000).default(0),
  })
  .strict();
export type ContentBlockInput = z.infer<typeof contentBlockInput>;

type BlockRow = ContentBlock & {
  category: { id: string; slug: string; name: string } | null;
  coupon: {
    id: string;
    code: string;
    status: string;
    isPubliclyListed: boolean;
    validFrom: Date | null;
    validUntil: Date | null;
    archivedAt: Date | null;
    minimums: { currencyCode: string }[];
  } | null;
};

const INCLUDE = {
  category: { select: { id: true, slug: true, name: true } },
  coupon: {
    select: {
      id: true,
      code: true,
      status: true,
      isPubliclyListed: true,
      validFrom: true,
      validUntil: true,
      archivedAt: true,
      minimums: { select: { currencyCode: true } },
    },
  },
} as const;

export interface ContentConflict {
  code:
    | 'COUPON_NOT_ACTIVE'
    | 'COUPON_NOT_PUBLIC'
    | 'COUPON_ARCHIVED'
    | 'COUPON_ENDS_BEFORE_START'
    | 'COUPON_ENDS_BEFORE_BLOCK'
    | 'COUPON_STARTS_AFTER_BLOCK'
    | 'COUPON_CURRENCY_MISMATCH'
    | 'OVERLAPPING_BLOCK';
  /** Refuses approval. A warning only asks for a second look. */
  blocking: boolean;
  meta?: Record<string, string>;
}

export interface ContentBlockView {
  id: string;
  placement: 'HOME_BANNER' | 'CATEGORY_BLOCK';
  category: { id: string; slug: string; name: string } | null;
  title: string;
  body: string | null;
  imageUrl: string | null;
  linkUrl: string | null;
  coupon: { code: string; status: string; isPubliclyListed: boolean } | null;
  countryCode: string;
  languageCode: string;
  startsAt: string | null;
  endsAt: string | null;
  isPublished: boolean;
  status: 'DRAFT' | 'PENDING_APPROVAL' | 'PUBLISHED';
  revision: number;
  submittedById: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  sortOrder: number;
  updatedAt: string;
}

function view(row: BlockRow): ContentBlockView {
  return {
    id: row.id,
    placement: row.placement,
    category: row.category,
    title: row.title,
    body: row.body,
    imageUrl: row.imageUrl,
    linkUrl: row.linkUrl,
    coupon:
      row.coupon === null
        ? null
        : { code: row.coupon.code, status: row.coupon.status, isPubliclyListed: row.coupon.isPubliclyListed },
    countryCode: row.countryCode,
    languageCode: row.languageCode,
    startsAt: row.startsAt === null ? null : row.startsAt.toISOString(),
    endsAt: row.endsAt === null ? null : row.endsAt.toISOString(),
    isPublished: row.isPublished,
    status: row.status,
    revision: row.revision,
    submittedById: row.submittedById,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    sortOrder: row.sortOrder,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listContentBlocks(): Promise<ContentBlockView[]> {
  const rows = await prisma.contentBlock.findMany({
    include: INCLUDE,
    orderBy: [{ placement: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
    take: 1000,
  });
  return rows.map(view);
}

function invalid(field: string, code: string, message: string) {
  return badRequest(ErrorCode.CONTENT_BLOCK_INVALID, message, [{ field, code }]);
}

async function columnsFor(input: ContentBlockInput): Promise<{ categoryId: string | null; couponId: string | null }> {
  let categoryId: string | null = null;
  if (input.placement === 'CATEGORY_BLOCK') {
    const id = input.categoryId ?? '';
    if (id === '') throw invalid('categoryId', 'REQUIRED', 'Choose the category this block appears on.');
    const category = await prisma.category.findUnique({ where: { id }, select: { id: true } });
    if (category === null) throw invalid('categoryId', 'NOT_FOUND', 'That category does not exist.');
    categoryId = category.id;
  }
  let couponId: string | null = null;
  const code = (input.couponCode ?? '').trim().toUpperCase();
  if (code !== '') {
    const coupon = await prisma.coupon.findUnique({ where: { code }, select: { id: true } });
    if (coupon === null) throw invalid('couponCode', 'NOT_FOUND', 'No coupon has that code.');
    couponId = coupon.id;
  }
  const startsAt = input.startsAt ?? null;
  const endsAt = input.endsAt ?? null;
  if (startsAt !== null && endsAt !== null && endsAt.getTime() <= startsAt.getTime()) {
    throw invalid('endsAt', 'BEFORE_START', 'A block cannot end before it starts.');
  }
  return { categoryId, couponId };
}

function auditSnapshot(block: ContentBlockView): Record<string, unknown> {
  return {
    placement: block.placement,
    categoryId: block.category?.id ?? null,
    title: block.title,
    coupon: block.coupon?.code ?? null,
    countryCode: block.countryCode,
    languageCode: block.languageCode,
    startsAt: block.startsAt,
    endsAt: block.endsAt,
    status: block.status,
    isPublished: block.isPublished,
    revision: block.revision,
  };
}

async function audit(
  tx: Prisma.TransactionClient,
  actor: SettingsActor,
  id: string,
  before: ContentBlockView | null,
  after: ContentBlockView | null,
  action: AuditActionKey = AuditAction.SETTINGS_UPDATED,
): Promise<void> {
  await recordAudit(
    {
      action,
      resourceType: 'content_block',
      resourceId: id,
      actorType: 'ADMIN',
      actorUserId: actor.userId,
      actorEmail: actor.email,
      before: before === null ? null : auditSnapshot(before),
      after: after === null ? null : auditSnapshot(after),
      ipAddress: actor.ipAddress ?? null,
      correlationId: actor.correlationId ?? null,
    },
    tx,
  );
}

const blank = (value: string | null | undefined): string | null =>
  value === undefined || value === null || value === '' ? null : value;

/** Whether two optional windows share any instant. An open end is forever. */
function windowsOverlap(
  a: { startsAt: Date | null; endsAt: Date | null },
  b: { startsAt: Date | null; endsAt: Date | null },
): boolean {
  const aStart = a.startsAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const aEnd = a.endsAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const bStart = b.startsAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const bEnd = b.endsAt?.getTime() ?? Number.POSITIVE_INFINITY;
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Everything that might make this block show the wrong thing.
 *
 * Exported for the unit test of the coupon rules; the overlap check reads the
 * other blocks and runs only through `contentConflicts`.
 */
export function couponConflicts(
  block: { startsAt: Date | null; endsAt: Date | null; countryCurrency: string | null },
  coupon: BlockRow['coupon'],
): ContentConflict[] {
  if (coupon === null) return [];
  const found: ContentConflict[] = [];
  const meta = { coupon: coupon.code };
  if (coupon.archivedAt !== null) found.push({ code: 'COUPON_ARCHIVED', blocking: true, meta });
  if (coupon.status !== 'ACTIVE') found.push({ code: 'COUPON_NOT_ACTIVE', blocking: false, meta });
  if (!coupon.isPubliclyListed) found.push({ code: 'COUPON_NOT_PUBLIC', blocking: false, meta });
  if (coupon.validUntil !== null && block.startsAt !== null && coupon.validUntil.getTime() <= block.startsAt.getTime()) {
    found.push({ code: 'COUPON_ENDS_BEFORE_START', blocking: true, meta });
  } else if (coupon.validUntil !== null && (block.endsAt === null || block.endsAt.getTime() > coupon.validUntil.getTime())) {
    found.push({ code: 'COUPON_ENDS_BEFORE_BLOCK', blocking: false, meta });
  }
  if (coupon.validFrom !== null && (block.startsAt === null || block.startsAt.getTime() < coupon.validFrom.getTime())) {
    found.push({ code: 'COUPON_STARTS_AFTER_BLOCK', blocking: false, meta });
  }
  if (
    block.countryCurrency !== null &&
    coupon.minimums.length > 0 &&
    !coupon.minimums.some((minimum) => minimum.currencyCode === block.countryCurrency)
  ) {
    found.push({ code: 'COUPON_CURRENCY_MISMATCH', blocking: false, meta: { ...meta, currency: block.countryCurrency } });
  }
  return found;
}

async function contentConflicts(row: BlockRow, client: Prisma.TransactionClient | typeof prisma = prisma): Promise<ContentConflict[]> {
  const country =
    row.countryCode === ''
      ? null
      : await client.country.findUnique({ where: { code: row.countryCode }, select: { currencyCode: true } });
  const found = couponConflicts(
    { startsAt: row.startsAt, endsAt: row.endsAt, countryCurrency: country?.currencyCode ?? null },
    row.coupon,
  );

  // Two banners for the same slot, audience and time: the shopper sees one
  // and the operator thinks they are seeing the other.
  const others = await client.contentBlock.findMany({
    where: {
      id: { not: row.id },
      placement: row.placement,
      categoryId: row.categoryId,
      status: { in: ['PENDING_APPROVAL', 'PUBLISHED'] },
      countryCode: row.countryCode === '' ? undefined : { in: ['', row.countryCode] },
      languageCode: row.languageCode === '' ? undefined : { in: ['', row.languageCode] },
    },
    select: { id: true, title: true, startsAt: true, endsAt: true },
    take: 50,
  });
  for (const other of others) {
    if (windowsOverlap(row, other)) {
      found.push({ code: 'OVERLAPPING_BLOCK', blocking: false, meta: { blockId: other.id, title: other.title } });
    }
  }
  return found;
}

/** The fields a version keeps, enough to write the block back exactly. */
function versionSnapshot(row: BlockRow): Prisma.InputJsonObject {
  return {
    placement: row.placement,
    categoryId: row.categoryId,
    title: row.title,
    body: row.body,
    imageUrl: row.imageUrl,
    linkUrl: row.linkUrl,
    couponCode: row.coupon?.code ?? null,
    countryCode: row.countryCode,
    languageCode: row.languageCode,
    startsAt: row.startsAt?.toISOString() ?? null,
    endsAt: row.endsAt?.toISOString() ?? null,
    sortOrder: row.sortOrder,
  };
}

export async function saveContentBlock(
  id: string | null,
  input: ContentBlockInput,
  actor: SettingsActor,
): Promise<{ block: ContentBlockView; warnings: ContentConflict[] }> {
  const columns = await columnsFor(input);
  const now = new Date();
  // An edit is a new draft. `isPublished: true` asks for approval at once.
  const data = {
    placement: input.placement,
    title: input.title,
    body: blank(input.body),
    imageUrl: blank(input.imageUrl),
    linkUrl: blank(input.linkUrl),
    countryCode: input.countryCode,
    languageCode: input.languageCode,
    startsAt: input.startsAt ?? null,
    endsAt: input.endsAt ?? null,
    isPublished: false,
    status: input.isPublished ? ('PENDING_APPROVAL' as const) : ('DRAFT' as const),
    submittedById: input.isPublished ? actor.userId : null,
    submittedAt: input.isPublished ? now : null,
    approvedById: null,
    approvedAt: null,
    sortOrder: input.sortOrder,
    updatedByUserId: actor.userId,
    ...columns,
  };
  return prisma.$transaction(async (tx) => {
    const before = id === null ? null : await tx.contentBlock.findUnique({ where: { id }, include: INCLUDE });
    if (id !== null && before === null) throw notFound('Content block');
    const revision = (before?.revision ?? 0) + 1;
    const row =
      id === null
        ? await tx.contentBlock.create({
            data: { id: newId(), createdByUserId: actor.userId, revision, ...data },
            include: INCLUDE,
          })
        : await tx.contentBlock.update({ where: { id }, data: { ...data, revision }, include: INCLUDE });
    await tx.contentBlockVersion.create({
      data: {
        id: newId(),
        blockId: row.id,
        revision,
        snapshotJson: versionSnapshot(row),
        savedById: actor.userId,
        savedByEmail: actor.email,
      },
    });
    const after = view(row);
    await audit(tx, actor, row.id, before === null ? null : view(before), after);
    if (input.isPublished) await audit(tx, actor, row.id, null, after, AuditAction.CONTENT_BLOCK_SUBMITTED);
    return { block: after, warnings: await contentConflicts(row, tx) };
  });
}

export async function deleteContentBlock(id: string, actor: SettingsActor): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const before = await tx.contentBlock.findUnique({ where: { id }, include: INCLUDE });
    if (before === null) throw notFound('Content block');
    await tx.contentBlock.delete({ where: { id } });
    await audit(tx, actor, id, view(before), null);
  });
}

/** Send a draft for approval. */
export async function submitContentBlock(id: string, actor: SettingsActor): Promise<ContentBlockView> {
  return prisma.$transaction(async (tx) => {
    const before = await tx.contentBlock.findUnique({ where: { id }, include: INCLUDE });
    if (before === null) throw notFound('Content block');
    if (before.status !== 'DRAFT') {
      throw conflict(ErrorCode.CONTENT_BLOCK_NOT_PENDING, 'Only a draft can be sent for approval.', [
        { code: 'NOT_DRAFT', meta: { status: before.status } },
      ]);
    }
    const row = await tx.contentBlock.update({
      where: { id },
      data: { status: 'PENDING_APPROVAL', submittedById: actor.userId, submittedAt: new Date() },
      include: INCLUDE,
    });
    await audit(tx, actor, id, view(before), view(row), AuditAction.CONTENT_BLOCK_SUBMITTED);
    return view(row);
  });
}

/**
 * Approve a block waiting for approval, which publishes it.
 *
 * Refused for the person who submitted it, and refused while a blocking
 * conflict stands (CONTENT_BLOCK_CONFLICT, with each one in `details`).
 */
export async function approveContentBlock(id: string, actor: SettingsActor): Promise<ContentBlockView> {
  return prisma.$transaction(async (tx) => {
    const before = await tx.contentBlock.findUnique({ where: { id }, include: INCLUDE });
    if (before === null) throw notFound('Content block');
    if (before.status !== 'PENDING_APPROVAL') {
      throw conflict(ErrorCode.CONTENT_BLOCK_NOT_PENDING, 'This block is not waiting for approval.', [
        { code: 'NOT_PENDING', meta: { status: before.status } },
      ]);
    }
    if (before.submittedById !== null && before.submittedById === actor.userId) {
      throw forbidden(
        ErrorCode.CONTENT_BLOCK_SAME_APPROVER,
        'You sent this block for approval, so a different member of staff has to approve it.',
      );
    }
    const blocking = (await contentConflicts(before, tx)).filter((item) => item.blocking);
    if (blocking.length > 0) {
      throw conflict(
        ErrorCode.CONTENT_BLOCK_CONFLICT,
        'This block cannot be published as it is.',
        blocking.map((item) => ({ code: item.code, ...(item.meta === undefined ? {} : { meta: item.meta }) })),
      );
    }
    const moved = await tx.contentBlock.updateMany({
      where: { id, status: 'PENDING_APPROVAL', revision: before.revision },
      data: { status: 'PUBLISHED', isPublished: true, approvedById: actor.userId, approvedAt: new Date() },
    });
    if (moved.count !== 1) {
      throw conflict(ErrorCode.CONTENT_BLOCK_NOT_PENDING, 'This block changed while you were approving it. Reload it.');
    }
    const row = await tx.contentBlock.findUniqueOrThrow({ where: { id }, include: INCLUDE });
    await audit(tx, actor, id, view(before), view(row), AuditAction.CONTENT_BLOCK_APPROVED);
    return view(row);
  });
}

/** Send a block back to draft: refuse an approval, or take a published block off the storefront. */
export async function returnContentBlock(id: string, actor: SettingsActor): Promise<ContentBlockView> {
  return prisma.$transaction(async (tx) => {
    const before = await tx.contentBlock.findUnique({ where: { id }, include: INCLUDE });
    if (before === null) throw notFound('Content block');
    if (before.status === 'DRAFT') {
      throw conflict(ErrorCode.CONTENT_BLOCK_NOT_PENDING, 'This block is already a draft.');
    }
    const row = await tx.contentBlock.update({
      where: { id },
      data: { status: 'DRAFT', isPublished: false, approvedById: null, approvedAt: null },
      include: INCLUDE,
    });
    await audit(tx, actor, id, view(before), view(row), AuditAction.CONTENT_BLOCK_RETURNED);
    return view(row);
  });
}

export interface ContentBlockVersionView {
  revision: number;
  snapshot: Record<string, unknown>;
  savedByEmail: string | null;
  savedAt: string;
}

export async function listContentBlockVersions(id: string): Promise<ContentBlockVersionView[]> {
  const rows = await prisma.contentBlockVersion.findMany({
    where: { blockId: id },
    orderBy: { revision: 'desc' },
    take: 100,
  });
  return rows.map((row) => ({
    revision: row.revision,
    snapshot:
      row.snapshotJson !== null && typeof row.snapshotJson === 'object' && !Array.isArray(row.snapshotJson)
        ? (row.snapshotJson as Record<string, unknown>)
        : {},
    savedByEmail: row.savedByEmail,
    savedAt: row.createdAt.toISOString(),
  }));
}

/**
 * Roll a block back to one of its earlier versions.
 *
 * Written as a NEW save of the old content: the block becomes a draft that
 * needs approval again, and the versions after it stay in the history.
 */
export async function restoreContentBlockVersion(
  id: string,
  revision: number,
  actor: SettingsActor,
): Promise<{ block: ContentBlockView; warnings: ContentConflict[] }> {
  const version = await prisma.contentBlockVersion.findUnique({
    where: { blockId_revision: { blockId: id, revision } },
  });
  if (version === null) throw notFound('Content block version');
  const input = contentBlockInput.parse({ ...(version.snapshotJson as Record<string, unknown>), isPublished: false });
  const result = await saveContentBlock(id, input, actor);
  await recordAudit({
    action: AuditAction.CONTENT_BLOCK_RESTORED,
    resourceType: 'content_block',
    resourceId: id,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    before: null,
    after: { restoredRevision: revision, newRevision: result.block.revision },
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });
  return result;
}

/** What a shopper is shown. No ids of staff, no drafts, no coupon it cannot use. */
export interface PublicContentBlock {
  id: string;
  title: string;
  body: string | null;
  imageUrl: string | null;
  linkUrl: string | null;
  couponCode: string | null;
}

interface BlockQuery {
  placement: 'HOME_BANNER' | 'CATEGORY_BLOCK';
  country: string | null;
  language: string | null;
  categorySlug?: string | null;
}

async function blocksFor(
  query: BlockQuery,
  now: Date,
  statuses: readonly ('DRAFT' | 'PENDING_APPROVAL' | 'PUBLISHED')[] | 'live',
): Promise<BlockRow[]> {
  const country = (query.country ?? '').toUpperCase();
  const language = (query.language ?? '').toLowerCase();
  // A regional language ("pt-br") also sees blocks for its base ("pt").
  const languages = [...new Set(['', language, language.split('-')[0] ?? ''])];

  let categoryId: string | undefined;
  if (query.placement === 'CATEGORY_BLOCK') {
    const slug = query.categorySlug ?? '';
    if (slug === '') return [];
    const category = await prisma.category.findFirst({ where: { slug }, select: { id: true } });
    if (category === null) return [];
    categoryId = category.id;
  }

  return prisma.contentBlock.findMany({
    where: {
      placement: query.placement,
      ...(categoryId === undefined ? {} : { categoryId }),
      ...(statuses === 'live' ? { isPublished: true } : { status: { in: [...statuses] } }),
      countryCode: { in: country === '' ? [''] : ['', country] },
      languageCode: { in: languages },
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
      ],
    },
    include: INCLUDE,
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    take: 20,
  });
}

function publicView(row: BlockRow, now: Date): PublicContentBlock {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    imageUrl: row.imageUrl,
    linkUrl: row.linkUrl,
    couponCode:
      row.coupon !== null &&
      row.coupon.status === 'ACTIVE' &&
      row.coupon.isPubliclyListed &&
      (row.coupon.validFrom === null || row.coupon.validFrom <= now) &&
      (row.coupon.validUntil === null || row.coupon.validUntil > now)
        ? row.coupon.code
        : null,
  };
}

export async function liveContentBlocks(query: BlockQuery, now: Date = new Date()): Promise<PublicContentBlock[]> {
  const rows = await blocksFor(query, now, 'live');
  return rows.map((row) => publicView(row, now));
}

/**
 * What the storefront would show for a country, a language and a moment,
 * for staff (JOURNEY-067). With `includeUnpublished`, drafts and blocks
 * waiting for approval are included and marked, so a block can be checked
 * before anybody approves it.
 */
export async function previewContentBlocks(
  query: BlockQuery & { at: Date; includeUnpublished: boolean },
): Promise<(PublicContentBlock & { status: string })[]> {
  const rows = await blocksFor(
    query,
    query.at,
    query.includeUnpublished ? ['DRAFT', 'PENDING_APPROVAL', 'PUBLISHED'] : ['PUBLISHED'],
  );
  return rows.map((row) => ({ ...publicView(row, query.at), status: row.status }));
}

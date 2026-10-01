/**
 * Storefront banners and category content blocks - checklist Master row 72.
 *
 * The operator writes a block, targets it at a country and/or a language
 * ('' = everyone), schedules it (`startsAt` / `endsAt`, either open) and
 * publishes it. The storefront asks for the blocks live right now for the
 * shopper's country and language; a draft, a block outside its schedule or
 * one targeted elsewhere is never returned.
 *
 * Promotions are the existing coupons: a block may name one by code, and the
 * code is shown to shoppers only while that coupon is ACTIVE and publicly
 * listed - a block never advertises a code the cart would refuse.
 */
import { z } from 'zod';
import type { ContentBlock, Prisma } from '../../generated/prisma/client.js';
import { badRequest, ErrorCode, notFound } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
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
  } | null;
};

const INCLUDE = {
  category: { select: { id: true, slug: true, name: true } },
  coupon: { select: { id: true, code: true, status: true, isPubliclyListed: true, validFrom: true, validUntil: true } },
} as const;

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
    isPublished: block.isPublished,
  };
}

async function audit(
  tx: Prisma.TransactionClient,
  actor: SettingsActor,
  id: string,
  before: ContentBlockView | null,
  after: ContentBlockView | null,
): Promise<void> {
  await recordAudit(
    {
      action: AuditAction.SETTINGS_UPDATED,
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

export async function saveContentBlock(
  id: string | null,
  input: ContentBlockInput,
  actor: SettingsActor,
): Promise<ContentBlockView> {
  const columns = await columnsFor(input);
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
    isPublished: input.isPublished,
    sortOrder: input.sortOrder,
    updatedByUserId: actor.userId,
    ...columns,
  };
  return prisma.$transaction(async (tx) => {
    const before = id === null ? null : await tx.contentBlock.findUnique({ where: { id }, include: INCLUDE });
    if (id !== null && before === null) throw notFound('Content block');
    const row =
      id === null
        ? await tx.contentBlock.create({ data: { id: newId(), createdByUserId: actor.userId, ...data }, include: INCLUDE })
        : await tx.contentBlock.update({ where: { id }, data, include: INCLUDE });
    const after = view(row);
    await audit(tx, actor, row.id, before === null ? null : view(before), after);
    return after;
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

/** What a shopper is shown. No ids of staff, no drafts, no coupon it cannot use. */
export interface PublicContentBlock {
  id: string;
  title: string;
  body: string | null;
  imageUrl: string | null;
  linkUrl: string | null;
  couponCode: string | null;
}

export async function liveContentBlocks(
  query: { placement: 'HOME_BANNER' | 'CATEGORY_BLOCK'; country: string | null; language: string | null; categorySlug?: string | null },
  now: Date = new Date(),
): Promise<PublicContentBlock[]> {
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

  const rows = await prisma.contentBlock.findMany({
    where: {
      placement: query.placement,
      ...(categoryId === undefined ? {} : { categoryId }),
      isPublished: true,
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
  return rows.map((row) => ({
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
  }));
}

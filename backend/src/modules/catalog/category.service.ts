/**
 * Categories.
 *
 * The hierarchy is stored as a materialised path (`/rootId/childId/`) plus a
 * depth, so a subtree read is one indexed prefix query rather than a recursive
 * walk. The cost is that moving a category has to rewrite its descendants'
 * paths - done here in one transaction, so a half-moved tree cannot be observed.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { sanitiseProductHtml, stripHtml } from '../../infra/sanitize.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { publicCategoryWhere, slugify } from './catalog.visibility.js';

export interface CategoryActor {
  userId: string;
  email: string;
  ipAddress?: string | null;
  correlationId?: string | null;
}

export interface CreateCategoryInput {
  name: string;
  slug?: string;
  parentId?: string | null;
  description?: string | null;
  imageMediaId?: string | null;
  bannerMediaId?: string | null;
  sortOrder?: number;
  isActive?: boolean;
  metaTitle?: string | null;
  metaDescription?: string | null;
}

export type UpdateCategoryInput = Partial<CreateCategoryInput>;

/** Deepest nesting permitted. Beyond this, navigation stops being usable. */
const MAX_CATEGORY_DEPTH = 4;

async function assertSlugAvailable(
  slug: string,
  excludeId: string | null,
  tx: PrismaTransaction | typeof prisma,
): Promise<void> {
  const existing = await tx.category.findUnique({ where: { slug }, select: { id: true } });

  if (existing !== null && existing.id !== excludeId) {
    throw conflict(ErrorCode.SLUG_ALREADY_EXISTS, `The URL slug "${slug}" is already in use.`, [
      { field: 'slug', code: 'DUPLICATE', meta: { slug } },
    ]);
  }
}

/**
 * Resolve a parent into the path and depth its children inherit.
 *
 * `excludeId` is the category being moved: a category cannot become its own
 * descendant, and the path prefix test catches that in one comparison.
 */
async function resolveParent(
  parentId: string | null | undefined,
  excludeId: string | null,
  tx: PrismaTransaction | typeof prisma,
): Promise<{ path: string; depth: number; parentId: string | null }> {
  if (parentId === null || parentId === undefined) {
    return { path: '/', depth: 0, parentId: null };
  }

  if (excludeId !== null && parentId === excludeId) {
    throw badRequest(ErrorCode.CATEGORY_CYCLE_DETECTED, 'A category cannot be its own parent.', [
      { field: 'parentId', code: 'SELF_PARENT' },
    ]);
  }

  const parent = await tx.category.findUnique({
    where: { id: parentId },
    select: { id: true, path: true, depth: true, archivedAt: true },
  });

  if (parent === null || parent.archivedAt !== null) {
    throw notFound('Parent category');
  }

  // The cycle check. If the proposed parent sits inside the subtree being
  // moved, attaching to it would detach the whole branch from the root.
  if (excludeId !== null && parent.path.includes(`/${excludeId}/`)) {
    throw badRequest(
      ErrorCode.CATEGORY_CYCLE_DETECTED,
      'That parent is inside this category, which would create a loop.',
      [{ field: 'parentId', code: 'CYCLE' }],
    );
  }

  if (parent.depth + 1 > MAX_CATEGORY_DEPTH) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      `Categories cannot be nested more than ${String(MAX_CATEGORY_DEPTH)} levels deep.`,
      [{ field: 'parentId', code: 'MAX_DEPTH_EXCEEDED' }],
    );
  }

  return {
    path: `${parent.path}${parent.id}/`,
    depth: parent.depth + 1,
    parentId: parent.id,
  };
}

export async function createCategory(
  input: CreateCategoryInput,
  actor: CategoryActor,
): Promise<{ id: string; slug: string }> {
  const slug = slugify(input.slug ?? input.name);

  if (slug.length === 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Could not derive a URL slug from that name.', [
      { field: 'slug', code: 'EMPTY_SLUG' },
    ]);
  }

  return prisma.$transaction(async (tx) => {
    await assertSlugAvailable(slug, null, tx);
    const parent = await resolveParent(input.parentId, null, tx);

    const id = newId();

    await tx.category.create({
      data: {
        id,
        name: input.name.trim(),
        slug,
        parentId: parent.parentId,
        path: parent.path,
        depth: parent.depth,
        description: sanitiseProductHtml(input.description),
        imageMediaId: input.imageMediaId ?? null,
        bannerMediaId: input.bannerMediaId ?? null,
        sortOrder: input.sortOrder ?? 0,
        // Draft by default. A new category becomes visible only when an admin
        // deliberately activates it.
        isActive: input.isActive ?? false,
        metaTitle: stripHtml(input.metaTitle),
        metaDescription: stripHtml(input.metaDescription),
        createdById: actor.userId,
        updatedById: actor.userId,
      },
    });

    await recordAudit(
      {
        action: AuditAction.CATEGORY_CREATED,
        resourceType: 'category',
        resourceId: id,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        after: { name: input.name, slug, parentId: parent.parentId, isActive: input.isActive ?? false },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );

    return { id, slug };
  });
}

export async function updateCategory(
  categoryId: string,
  input: UpdateCategoryInput,
  actor: CategoryActor,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.category.findUnique({ where: { id: categoryId } });

    if (existing === null || existing.archivedAt !== null) throw notFound('Category');

    const data: Prisma.CategoryUncheckedUpdateInput = { updatedById: actor.userId };

    if (input.name !== undefined) data.name = input.name.trim();
    if (input.description !== undefined) data.description = sanitiseProductHtml(input.description);
    if (input.imageMediaId !== undefined) data.imageMediaId = input.imageMediaId;
    if (input.bannerMediaId !== undefined) data.bannerMediaId = input.bannerMediaId;
    if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
    if (input.isActive !== undefined) data.isActive = input.isActive;
    if (input.metaTitle !== undefined) data.metaTitle = stripHtml(input.metaTitle);
    if (input.metaDescription !== undefined) {
      data.metaDescription = stripHtml(input.metaDescription);
    }

    if (input.slug !== undefined) {
      const slug = slugify(input.slug);
      await assertSlugAvailable(slug, categoryId, tx);
      data.slug = slug;
    }

    // Reparenting rewrites this row's path and every descendant's.
    if (input.parentId !== undefined && input.parentId !== existing.parentId) {
      const parent = await resolveParent(input.parentId, categoryId, tx);

      data.parentId = parent.parentId;
      data.path = parent.path;
      data.depth = parent.depth;

      const oldPrefix = `${existing.path}${existing.id}/`;
      const newPrefix = `${parent.path}${existing.id}/`;
      const depthShift = parent.depth - existing.depth;

      const descendants = await tx.category.findMany({
        where: { path: { startsWith: oldPrefix } },
        select: { id: true, path: true, depth: true },
      });

      // A deep move could exceed the limit for descendants even though the
      // moved node itself fits.
      for (const descendant of descendants) {
        if (descendant.depth + depthShift > MAX_CATEGORY_DEPTH) {
          throw badRequest(
            ErrorCode.VALIDATION_FAILED,
            `That move would nest sub-categories more than ${String(MAX_CATEGORY_DEPTH)} levels deep.`,
            [{ field: 'parentId', code: 'MAX_DEPTH_EXCEEDED' }],
          );
        }
      }

      for (const descendant of descendants) {
        await tx.category.update({
          where: { id: descendant.id },
          data: {
            path: newPrefix + descendant.path.slice(oldPrefix.length),
            depth: descendant.depth + depthShift,
          },
        });
      }
    }

    await tx.category.update({ where: { id: categoryId }, data });

    await recordAudit(
      {
        action: AuditAction.CATEGORY_UPDATED,
        resourceType: 'category',
        resourceId: categoryId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: {
          name: existing.name,
          slug: existing.slug,
          parentId: existing.parentId,
          isActive: existing.isActive,
        },
        after: input,
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });
}

/**
 * Archive a category.
 *
 * Refuses while products still reference it. Silently orphaning a product -
 * leaving it published under an invisible category - is exactly the state
 * `publicProductWhere` exists to prevent, so the caller is made to deal with
 * the products first. `force` archives the subtree too, but never the products.
 */
export async function archiveCategory(
  categoryId: string,
  actor: CategoryActor,
  options: { force?: boolean } = {},
): Promise<{ archivedCount: number }> {
  return prisma.$transaction(async (tx) => {
    const category = await tx.category.findUnique({ where: { id: categoryId } });
    if (category === null || category.archivedAt !== null) throw notFound('Category');

    const subtreePrefix = `${category.path}${category.id}/`;

    const descendants = await tx.category.findMany({
      where: { path: { startsWith: subtreePrefix }, archivedAt: null },
      select: { id: true },
    });

    const affectedIds = [categoryId, ...descendants.map((d) => d.id)];

    const productCount = await tx.product.count({
      where: { categoryId: { in: affectedIds }, archivedAt: null },
    });

    if (productCount > 0) {
      throw conflict(
        ErrorCode.CATEGORY_HAS_PRODUCTS,
        `This category still has ${String(productCount)} product(s). Move or archive them first.`,
        [{ field: 'categoryId', code: 'HAS_PRODUCTS', meta: { productCount } }],
      );
    }

    if (descendants.length > 0 && options.force !== true) {
      throw conflict(
        ErrorCode.CONFLICT,
        `This category has ${String(descendants.length)} sub-categories. Confirm to archive them too.`,
        [{ field: 'categoryId', code: 'HAS_CHILDREN', meta: { childCount: descendants.length } }],
      );
    }

    const now = new Date();
    await tx.category.updateMany({
      where: { id: { in: affectedIds } },
      data: { archivedAt: now, isActive: false, updatedById: actor.userId },
    });

    await recordAudit(
      {
        action: AuditAction.CATEGORY_ARCHIVED,
        resourceType: 'category',
        resourceId: categoryId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { name: category.name, isActive: category.isActive },
        after: { archivedAt: now.toISOString(), archivedCount: affectedIds.length },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );

    return { archivedCount: affectedIds.length };
  });
}

export interface CategoryNode {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  depth: number;
  sortOrder: number;
  isActive: boolean;
  productCount: number;
  children: CategoryNode[];
}

/**
 * The category tree.
 *
 * One flat query, assembled in memory. `includeInactive` is false for public
 * callers - the storefront navigation must never show a draft category.
 */
export async function listCategoryTree(
  options: { includeInactive?: boolean } = {},
): Promise<CategoryNode[]> {
  const where: Prisma.CategoryWhereInput =
    options.includeInactive === true ? { archivedAt: null } : publicCategoryWhere();

  const rows = await prisma.category.findMany({
    where,
    orderBy: [{ depth: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      name: true,
      slug: true,
      parentId: true,
      depth: true,
      sortOrder: true,
      isActive: true,
      _count: { select: { products: true } },
    },
  });

  const nodeById = new Map<string, CategoryNode>();
  const roots: CategoryNode[] = [];

  for (const row of rows) {
    nodeById.set(row.id, {
      id: row.id,
      name: row.name,
      slug: row.slug,
      parentId: row.parentId,
      depth: row.depth,
      sortOrder: row.sortOrder,
      isActive: row.isActive,
      productCount: row._count.products,
      children: [],
    });
  }

  // Rows are depth-ordered, so a parent is always in the map before its child.
  for (const row of rows) {
    const node = nodeById.get(row.id);
    if (node === undefined) continue;

    const parent = row.parentId === null ? undefined : nodeById.get(row.parentId);

    // A child whose parent was filtered out (inactive) is deliberately dropped
    // rather than promoted to a root - promoting it would surface a category
    // whose parent the admin has hidden.
    if (row.parentId === null) {
      roots.push(node);
    } else if (parent !== undefined) {
      parent.children.push(node);
    }
  }

  return roots;
}

export async function findCategoryBySlug(
  slug: string,
  options: { includeInactive?: boolean } = {},
): Promise<{ id: string; name: string; slug: string; description: string | null } | null> {
  return prisma.category.findFirst({
    where: {
      slug,
      ...(options.includeInactive === true ? { archivedAt: null } : publicCategoryWhere()),
    },
    select: { id: true, name: true, slug: true, description: true },
  });
}

/** All ids in a category's subtree, for "include sub-categories" filtering. */
export async function subtreeCategoryIds(categoryId: string): Promise<string[]> {
  const category = await prisma.category.findUnique({
    where: { id: categoryId },
    select: { id: true, path: true },
  });

  if (category === null) return [];

  const descendants = await prisma.category.findMany({
    where: { path: { startsWith: `${category.path}${category.id}/` }, archivedAt: null },
    select: { id: true },
  });

  return [category.id, ...descendants.map((d) => d.id)];
}

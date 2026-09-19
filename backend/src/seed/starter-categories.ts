/**
 * The departments a marketplace starts life with.
 *
 * A seller can list anything. The category picker in the listing wizard is
 * what decides whether that is true in practice: it offers the categories this
 * deployment actually has, so a deployment whose only department arrived on a
 * supplier's spreadsheet offers exactly that department, and a seller with a
 * box of cable ties to sell finds nowhere to put them. That is not a
 * marketplace with one department in it — it is a marketplace nobody else can
 * sell on.
 *
 * So a fresh deployment is planted with a broad, plainly named set of
 * departments covering the trades a general marketplace serves, each with a
 * handful of sub-categories underneath. From the moment the seed has run, a
 * seller can find somewhere sensible for whatever they sell.
 *
 * Three things this is careful about, because the catalogue belongs to the
 * operator and this is a product other companies run:
 *
 *   - **A department that already exists is left entirely alone**, children and
 *     all. A deployment that already has "Medical Devices" with twenty-six
 *     sub-categories of its own keeps them; this does not add its own eight
 *     alongside. Matching is by slug.
 *   - **Nothing is ever renamed, reactivated or deleted.** An operator who
 *     switched a department off, renamed it, or reordered it has made a
 *     decision, and re-running the seed must not put our guess back.
 *   - **Names are a starting point, not a rule.** Everything here can be
 *     renamed, re-parented, archived or deleted in the admin panel, and a
 *     category the operator added themselves is never touched.
 *
 * Empty departments do not clutter the shop front: the storefront home and
 * category pages show only categories with something published beneath them
 * (`stockedCategories` in the customer app), so a department nobody has listed
 * in yet is visible to a seller choosing where to file a product and to nobody
 * else.
 *
 * `seedSellerHub` runs after this and attaches its category-specific listing
 * fields by slug, which is why the medical department below carries the slug
 * that seed looks for.
 */
import { newId } from '../infra/ids.js';
import { prisma } from '../infra/prisma.js';
import { STARTER_DEPARTMENTS as DEPARTMENTS } from './starter-departments.js';

export interface StarterCategoryResult {
  /** Departments created by this run. */
  departments: number;
  /** Sub-categories created by this run. */
  children: number;
  /** Departments already present, and therefore left untouched. */
  skipped: number;
}

/**
 * Plant the starter departments.
 *
 * Idempotent, and create-only: a slug that already exists is never written to,
 * so a second run reports everything skipped and changes nothing.
 */
export async function seedStarterCategories(): Promise<StarterCategoryResult> {
  // One read rather than a query per slug. The taxonomy is a hundred-odd rows
  // and this runs against a live database on every deployment upgrade.
  const taken = new Set(
    (
      await prisma.category.findMany({
        where: {
          slug: {
            in: [
              ...DEPARTMENTS.map((department) => department.slug),
              ...DEPARTMENTS.flatMap((department) =>
                department.children.map((child) => child.slug),
              ),
            ],
          },
        },
        select: { slug: true },
      })
    ).map((row) => row.slug),
  );

  let departments = 0;
  let children = 0;
  let skipped = 0;

  for (const department of DEPARTMENTS) {
    if (taken.has(department.slug)) {
      // The operator already has this department. What is filed under it is
      // theirs, so nothing of ours is added beside it.
      skipped += 1;
      continue;
    }

    const departmentId = newId();

    await prisma.category.create({
      data: {
        id: departmentId,
        name: department.name,
        slug: department.slug,
        parentId: null,
        path: '/',
        depth: 0,
        sortOrder: department.sortOrder,
        // Active on creation, unlike a category added by hand in the panel. A
        // department nobody can see is a department nobody can list in, and the
        // point of planting these is that a seller has somewhere to file a
        // product on the day the deployment opens.
        isActive: true,
      },
    });

    departments += 1;

    for (const [index, child] of department.children.entries()) {
      // A sub-category slug this deployment already uses somewhere else keeps
      // its existing home: slugs are unique across the whole tree, and taking
      // one would move somebody's category by accident.
      if (taken.has(child.slug)) continue;

      await prisma.category.create({
        data: {
          id: newId(),
          name: child.name,
          slug: child.slug,
          parentId: departmentId,
          path: `/${departmentId}/`,
          depth: 1,
          sortOrder: (index + 1) * 10,
          isActive: true,
        },
      });

      taken.add(child.slug);
      children += 1;
    }
  }

  return { departments, children, skipped };
}

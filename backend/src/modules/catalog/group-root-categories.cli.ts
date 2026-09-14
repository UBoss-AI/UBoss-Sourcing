/**
 * File every top-level category under one department.
 *
 *   cd backend
 *   npm run catalog:group -- --name "Medical Devices"            # dry run
 *   npm run catalog:group -- --name "Medical Devices" --apply
 *   npm run catalog:group -- --name "Medical Devices" --apply --actor admin@example.com
 *
 * A catalogue imported from a supplier sheet arrives flat: every distinct
 * category band in the workbook becomes its own top-level category, and the
 * storefront home page - which shows the top level, because that is what a
 * department is - ends up with twenty-odd cards reading "ABG Kit", "Flush
 * Syringe", "Ryles Tube". That is a parts list, not a shop front.
 *
 * This moves all of them under one named parent, so the home page shows the
 * one department and the rest become its sub-categories, reachable from the
 * category page's sidebar exactly as before. Nothing is renamed, nothing is
 * deleted, and no product changes hands: opening a category already filters on
 * its whole subtree, so the new parent lists everything its children hold.
 *
 * The department's name is an argument rather than a constant, because what a
 * given deployment sells is the operator's business and not this project's.
 * Two operators running the same code will type two different names here.
 *
 * Re-running it is safe, and is the intended way to tidy up after a later
 * import: anything that has appeared at the top level since is swept in, and
 * anything already inside is left alone.
 */
import { ErrorCode, isAppError } from '../../domain/errors.js';
import { prisma } from '../../infra/prisma.js';
import { slugify } from './catalog.visibility.js';
import { createCategory, updateCategory, type CategoryActor } from './category.service.js';

interface Arguments {
  name: string;
  slug: string;
  apply: boolean;
  actorEmail: string | undefined;
}

function parseArguments(argv: string[]): Arguments {
  let name: string | undefined;
  let slug: string | undefined;
  let apply = false;
  let actorEmail: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') {
      apply = true;
    } else if (argument === '--name') {
      index += 1;
      name = argv[index];
    } else if (argument === '--slug') {
      index += 1;
      slug = argv[index];
    } else if (argument === '--actor') {
      index += 1;
      actorEmail = argv[index];
    } else {
      throw new Error(`Unknown option "${String(argument)}".`);
    }
  }

  const trimmed = name?.trim() ?? '';
  if (trimmed.length === 0) {
    throw new Error('Which department? Pass --name "Medical Devices".');
  }

  const resolvedSlug = slugify(slug ?? trimmed);
  if (resolvedSlug.length === 0) {
    throw new Error(`No URL slug can be derived from "${trimmed}". Pass --slug as well.`);
  }

  return { name: trimmed, slug: resolvedSlug, apply, actorEmail };
}

/**
 * Who the audit log will name.
 *
 * Moving every department in the catalogue is an administrative act, and each
 * move writes an audit row. Running it as nobody would leave a shelf of rows
 * pointing at no one, so this refuses rather than inventing an actor.
 */
async function resolveActor(email: string | undefined): Promise<CategoryActor> {
  const user = await prisma.user.findFirst({
    where:
      email === undefined
        ? { type: 'ADMIN', status: 'ACTIVE' }
        : { type: 'ADMIN', emailNormalized: email.trim().toLowerCase() },
    select: { id: true, email: true },
    orderBy: { createdAt: 'asc' },
  });

  if (user === null) {
    throw new Error(
      email === undefined
        ? 'No active administrator was found to attribute this to. Seed one first, or pass --actor <email>.'
        : `No administrator with the email "${email}" was found.`,
    );
  }

  return { userId: user.id, email: user.email };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));

  const roots = await prisma.category.findMany({
    where: { parentId: null, archivedAt: null },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      name: true,
      slug: true,
      isActive: true,
      _count: { select: { products: true, children: true } },
    },
  });

  const existingParent = roots.find((root) => root.slug === options.slug) ?? null;
  const toMove = roots.filter((root) => root.id !== existingParent?.id);

  console.log(
    options.apply
      ? `Filing top-level categories under "${options.name}".`
      : 'DRY RUN — nothing will be written.',
  );
  console.log('');
  console.log(
    existingParent === null
      ? `Department               ${options.name} (/${options.slug}) — will be created`
      : `Department               ${existingParent.name} (/${existingParent.slug}) — already exists`,
  );
  console.log(`Top-level categories     ${String(toMove.length)} to move`);
  console.log('');

  if (toMove.length === 0 && existingParent !== null) {
    console.log('Nothing to do — the top level is already this one department.');
    return;
  }

  for (const root of toMove) {
    const children = root._count.children;
    const subs = children === 0 ? '' : ` + ${String(children)} sub`;
    const draft = root.isActive ? '' : '   (inactive)';
    const count = root._count.products;
    const products = `${String(count).padStart(4)} product${count === 1 ? ' ' : 's'}`;
    console.log(`  ${root.name.padEnd(34)} ${products}${subs}${draft}`);
  }
  console.log('');

  if (!options.apply) {
    console.log('Re-run with --apply to move them.');
    return;
  }

  const actor = await resolveActor(options.actorEmail);
  let parentId = existingParent?.id ?? null;

  if (parentId === null) {
    const created = await createCategory(
      {
        name: options.name,
        slug: options.slug,
        // Active, because the whole point is that this is the one card the
        // home page shows. A draft parent would hide its children with it.
        isActive: true,
        sortOrder: 0,
      },
      actor,
    );
    parentId = created.id;
    console.log(`Created ${options.name}.`);
  }

  let moved = 0;
  let failed = 0;

  for (const root of toMove) {
    try {
      await updateCategory(root.id, { parentId }, actor);
      moved += 1;
    } catch (error: unknown) {
      // Almost always the nesting limit: a branch that is already as deep as
      // the tree allows cannot gain a level by being moved down one. Say which
      // one, and carry on rather than abandoning the ones that would work.
      failed += 1;
      const detail =
        isAppError(error) && error.code === ErrorCode.VALIDATION_FAILED
          ? `${error.message} Flatten it first, then re-run.`
          : messageOf(error);
      console.log(`  SKIPPED ${root.name} — ${detail}`);
    }
  }

  console.log('');
  console.log(`Moved ${String(moved)} categories under ${options.name}.`);

  if (failed > 0) {
    console.log(`${String(failed)} could not be moved. See the lines above.`);
    process.exitCode = 1;
    return;
  }

  console.log('');
  console.log('The storefront home page now shows one department. Its sub-categories');
  console.log('are listed on the category page, and the department itself shows every');
  console.log('product in all of them.');
}

main()
  .catch((error: unknown) => {
    console.error(messageOf(error));
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });

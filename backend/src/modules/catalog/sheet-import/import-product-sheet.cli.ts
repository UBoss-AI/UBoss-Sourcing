/**
 * Load a supplier product sheet into the catalogue.
 *
 *   npm run catalog:import -- "C:\path\to\sheet.xlsx"            # dry run
 *   npm run catalog:import -- "C:\path\to\sheet.xlsx" --apply    # writes
 *
 * A dry run is the default, and that is deliberate. The destructive spelling
 * should be the one you have to type, not the one you get by forgetting a flag.
 *
 * Options:
 *   --apply              Write the changes. Without it, nothing is written.
 *   --publish            After importing, publish each product through the
 *                        normal publication check. Nothing is bypassed: a
 *                        product that fails the check stays a draft and the
 *                        report says why. Needs --apply.
 *   --sheet "<name>"     Which worksheet. Defaults to the first one.
 *   --actor <email>      Which administrator the audit log records. Defaults
 *                        to the first active administrator in the database.
 *   --out <path>         Also write the full report as JSON, for a record of
 *                        exactly what one run saw.
 *
 * Re-running it is safe. Identity is a fingerprint of the source row's own
 * fields, so a second run of the same file updates what the first run made
 * rather than creating a parallel catalogue.
 */
import { writeFileSync } from 'node:fs';
import { prisma } from '../../../infra/prisma.js';
import { formatReport, importProductSheet, type SheetImportActor } from './sheet-import.service.js';

interface Arguments {
  filePath: string;
  apply: boolean;
  publish: boolean;
  sheetName: string | undefined;
  actorEmail: string | undefined;
  outPath: string | undefined;
}

function parseArguments(argv: string[]): Arguments {
  const positional: string[] = [];
  let apply = false;
  let publish = false;
  let sheetName: string | undefined;
  let actorEmail: string | undefined;
  let outPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;

    if (argument === '--apply') {
      apply = true;
    } else if (argument === '--publish') {
      publish = true;
    } else if (argument === '--sheet') {
      index += 1;
      sheetName = argv[index];
    } else if (argument === '--actor') {
      index += 1;
      actorEmail = argv[index];
    } else if (argument === '--out') {
      index += 1;
      outPath = argv[index];
    } else if (argument.startsWith('--')) {
      throw new Error(`Unknown option "${argument}".`);
    } else {
      positional.push(argument);
    }
  }

  const filePath = positional[0];
  if (filePath === undefined) {
    throw new Error(
      'Give the path to the .xlsx file.\n\n' +
        '  npm run catalog:import -- "C:\\path\\to\\sheet.xlsx"          (dry run)\n' +
        '  npm run catalog:import -- "C:\\path\\to\\sheet.xlsx" --apply  (writes)',
    );
  }

  if (publish && !apply) {
    throw new Error('--publish only makes sense with --apply; a dry run has nothing to publish.');
  }

  return { filePath, apply, publish, sheetName, actorEmail, outPath };
}

/**
 * Who the audit log will name.
 *
 * A catalogue import is an administrative act and every product it creates
 * carries a `createdById`. Running it as "whoever" would leave several hundred
 * audit rows pointing at nobody, so this refuses rather than inventing an actor.
 */
async function resolveActor(email: string | undefined): Promise<SheetImportActor> {
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
        ? 'No active administrator was found to attribute this import to. Seed one first, or pass --actor <email>.'
        : `No administrator with the email "${email}" was found.`,
    );
  }

  return { userId: user.id, email: user.email };
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const actor = await resolveActor(options.actorEmail);

  const report = await importProductSheet({
    filePath: options.filePath,
    sheetName: options.sheetName,
    dryRun: !options.apply,
    publish: options.publish,
    actor,
  });

  console.log(formatReport(report));

  if (options.outPath !== undefined) {
    writeFileSync(options.outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`Full report written to ${options.outPath}`);
  }

  if (!options.apply) {
    console.log('Re-run with --apply to write these changes.');
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });

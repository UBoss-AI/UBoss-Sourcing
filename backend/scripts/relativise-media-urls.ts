/**
 * Rewrites the absolute media URLs held in media_assets.url to root-relative
 * ones ("/media/...").
 *
 * The column is written once, at upload time, from STORAGE_PUBLIC_BASE_URL - so
 * every row baked in whatever host the API had then. That host is wrong for
 * anyone who is not on this machine: a visitor's browser resolves
 * http://localhost:4000 to their own laptop and every product image breaks.
 *
 * Relative wins over simply swapping in the tunnel's host, because it is
 * correct on every origin the app is ever served from, and it does not rot when
 * the tunnel is restarted. Nothing server-side needs these to be absolute -
 * storageKey is a separate column, and no email or report embeds them.
 *
 * Run from `backend/`:  npx tsx scripts/relativise-media-urls.ts [--revert <base>]
 */
import { prisma } from '../src/infra/prisma.js';

const revertTo = process.argv.includes('--revert')
  ? process.argv[process.argv.indexOf('--revert') + 1]
  : undefined;

async function main(): Promise<void> {
  const before = await prisma.mediaAsset.findMany({ select: { url: true } });
  const absolute = before.filter((m) => /^https?:\/\//i.test(m.url)).length;

  console.log(`\n  ${before.length} media rows, ${absolute} with an absolute URL.`);

  if (revertTo !== undefined) {
    const base = revertTo.replace(/\/$/, '');
    const n = await prisma.$executeRawUnsafe(
      "UPDATE media_assets SET url = CONCAT(?, url) WHERE url LIKE '/media/%'",
      base,
    );
    console.log(`  reverted ${n} row(s) to ${base}/media/...\n`);
    return;
  }

  // Keep everything from /media/ onward, drop scheme://host in front of it.
  const n = await prisma.$executeRawUnsafe(
    "UPDATE media_assets SET url = SUBSTRING(url, LOCATE('/media/', url)) " +
      "WHERE url LIKE 'http%' AND LOCATE('/media/', url) > 0",
  );

  const after = await prisma.mediaAsset.findFirst({ select: { url: true } });
  console.log(`  rewrote ${n} row(s).`);
  console.log(`  sample now: ${after?.url ?? '(no rows)'}\n`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });

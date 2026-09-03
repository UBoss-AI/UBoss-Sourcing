/**
 * Bulk product import - integration, against a real MariaDB.
 *
 * The property under test throughout is that the preview tells the truth. A
 * dry run that under-reports errors is worse than no dry run, because an
 * administrator confirms on the strength of it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/infra/prisma.js';
import { newId } from '../../src/infra/ids.js';
import { createCategory } from '../../src/modules/catalog/category.service.js';
import { createProduct } from '../../src/modules/catalog/product.service.js';
import {
  confirmProductImport,
  createProductImportDryRun,
  getImportJob,
  parseCsv,
  productImportTemplate,
} from '../../src/modules/catalog/import.service.js';

let actor: { userId: string; email: string };
let categorySlug: string;

const HEADER = 'sku,name,categorySlug,price,status,compareAtPrice,minOrderQty,maxOrderQty,isStockTracked';

function file(...rows: string[]): Buffer {
  return Buffer.from([HEADER, ...rows].join('\r\n') + '\r\n', 'utf8');
}

async function preview(content: Buffer): Promise<Record<string, unknown>> {
  const { importJobId } = await createProductImportDryRun(
    { fileName: 'test.csv', content },
    actor,
  );
  return getImportJob(importJobId, 1, 200);
}

async function resetImports(): Promise<void> {
  await prisma.importRowError.deleteMany({});
  await prisma.importJob.deleteMany({});
  await prisma.auditLog.deleteMany({});
  await prisma.productVariant.deleteMany({});
  await prisma.productAttribute.deleteMany({});
  await prisma.product.deleteMany({});

  const categories = await prisma.category.findMany({
    orderBy: { depth: 'desc' },
    select: { id: true },
  });
  for (const category of categories) {
    await prisma.category.delete({ where: { id: category.id } });
  }

  await prisma.taxClass.deleteMany({});
  await prisma.userRole.deleteMany({});
  await prisma.user.deleteMany({ where: { emailNormalized: 'import@test.local' } });
}

beforeEach(async () => {
  await resetImports();

  const actorId = newId();
  await prisma.user.create({
    data: {
      id: actorId,
      type: 'ADMIN',
      email: 'import@test.local',
      emailNormalized: 'import@test.local',
      status: 'ACTIVE',
    },
  });
  actor = { userId: actorId, email: 'import@test.local' };

  await prisma.taxClass.create({
    data: {
      id: newId(),
      code: 'GST18',
      name: 'GST 18%',
      ratePercent: '18.000000',
      isDefault: true,
      isActive: true,
    },
  });

  const category = await createCategory({ name: 'Fasteners', isActive: true }, actor);
  const row = await prisma.category.findUniqueOrThrow({
    where: { id: category.id },
    select: { slug: true },
  });
  categorySlug = row.slug;
});

describe('CSV parsing', () => {
  it('keeps a quoted comma inside one field', () => {
    const rows = parseCsv('a,b\r\n"one, two",three\r\n');
    expect(rows[1]).toEqual(['one, two', 'three']);
  });

  it('keeps a quoted newline inside one field', () => {
    const rows = parseCsv('a,b\r\n"line one\nline two",x\r\n');
    expect(rows).toHaveLength(2);
    expect(rows[1]?.[0]).toBe('line one\nline two');
  });

  it('unescapes a doubled quote', () => {
    const rows = parseCsv('a\r\n"He said ""hi"""\r\n');
    expect(rows[1]?.[0]).toBe('He said "hi"');
  });

  it('strips the BOM Excel writes, so the first column still matches', () => {
    const rows = parseCsv('﻿sku,name\r\nA-1,Widget\r\n');
    expect(rows[0]?.[0]).toBe('sku');
  });

  it('reads a final row that has no trailing newline', () => {
    const rows = parseCsv('a,b\r\n1,2');
    expect(rows[1]).toEqual(['1', '2']);
  });

  it('treats CRLF as one terminator, not two', () => {
    expect(parseCsv('a\r\nb\r\nc\r\n')).toHaveLength(3);
  });
});

describe('template', () => {
  it('round-trips through the parser it is meant to feed', () => {
    const rows = parseCsv(productImportTemplate());
    expect(rows[0]).toContain('sku');
    expect(rows[0]).toContain('categorySlug');
    // Header, worked example, blank row.
    expect(rows).toHaveLength(3);
  });
});

describe('dry run', () => {
  it('writes no products', async () => {
    const job = await preview(file(`IMP-A,Widget,${categorySlug},10.00,ACTIVE,,,,`));

    expect(job.validRows).toBe(1);
    expect(await prisma.product.count()).toBe(0);
  });

  it('refuses a file missing a required column', async () => {
    const job = await preview(Buffer.from('sku,name\r\nA-1,Widget\r\n', 'utf8'));

    expect(job.status).toBe('FAILED');
    expect(String(job.errorMessage)).toContain('categorySlug');
  });

  it('numbers rows the way a spreadsheet does', async () => {
    // Row 1 is the header, so the first data row is row 2.
    const job = await preview(file(`,Missing SKU,${categorySlug},10.00,,,,,`));
    const errors = job.rowErrors as { rowNumber: number; code: string }[];

    expect(errors[0]?.rowNumber).toBe(2);
  });

  it('reports a SKU repeated inside the file rather than letting the last row win', async () => {
    const job = await preview(
      file(
        `IMP-DUP,First,${categorySlug},10.00,,,,,`,
        `IMP-DUP,Second,${categorySlug},99.00,,,,,`,
      ),
    );
    const errors = job.rowErrors as { code: string; message: string }[];

    expect(errors.map((error) => error.code)).toContain('DUPLICATE_IN_FILE');
    expect(job.validRows).toBe(1);
  });

  it('rejects money that is not exact minor units', async () => {
    const job = await preview(
      file(
        `IMP-1,Thousands separator,${categorySlug},"1,299.00",,,,,`,
        `IMP-2,Too many decimals,${categorySlug},45.555,,,,,`,
        `IMP-3,Negative,${categorySlug},-5.00,,,,,`,
        `IMP-4,Currency symbol,${categorySlug},Rs 10.00,,,,,`,
      ),
    );

    expect(job.validRows).toBe(0);
    expect(job.errorRows).toBe(4);
  });

  it('converts a decimal price to minor units without floating point', async () => {
    const { importJobId } = await createProductImportDryRun(
      { fileName: 'p.csv', content: file(`IMP-P,Price,${categorySlug},45.55,,,,,`) },
      actor,
    );
    await confirmProductImport(importJobId, { skipInvalidRows: false }, actor);

    const product = await prisma.product.findUniqueOrThrow({ where: { sku: 'IMP-P' } });
    // 45.55 * 100 is 4554.999... in binary floating point.
    expect(product.basePriceMinor).toBe(4555n);
  });

  it('reports every problem in a row, not just the first', async () => {
    const job = await preview(file(`,,no-such-category,abc,NOPE,,,,`));
    const errors = job.rowErrors as { field: string | null }[];

    expect(errors.length).toBeGreaterThan(3);
  });

  it('skips blank padding rows without counting them', async () => {
    const job = await preview(file(`IMP-A,Widget,${categorySlug},10.00,,,,,`, ',,,,,,,,', ',,,,,,,,'));

    expect(job.totalRows).toBe(1);
    expect(job.validRows).toBe(1);
  });

  it('rejects a quantity range no order could satisfy', async () => {
    const job = await preview(file(`IMP-Q,Range,${categorySlug},10.00,,,10,5,`));
    const errors = job.rowErrors as { field: string | null; code: string }[];

    expect(errors[0]?.field).toBe('maxOrderQty');
  });
});

describe('confirm', () => {
  it('refuses a file with errors unless invalid rows are explicitly skipped', async () => {
    const { importJobId } = await createProductImportDryRun(
      {
        fileName: 'mixed.csv',
        content: file(
          `IMP-OK,Good,${categorySlug},10.00,,,,,`,
          `IMP-BAD,Bad,no-such-category,10.00,,,,,`,
        ),
      },
      actor,
    );

    await expect(confirmProductImport(importJobId, { skipInvalidRows: false }, actor)).rejects.toThrow(
      /row\(s\) have errors/,
    );
    expect(await prisma.product.count()).toBe(0);

    const applied = await confirmProductImport(importJobId, { skipInvalidRows: true }, actor);
    const job = await getImportJob(applied.importJobId);

    expect(job.createdRows).toBe(1);
    expect(await prisma.product.count()).toBe(1);
  });

  it('cannot be applied twice from one preview', async () => {
    const { importJobId } = await createProductImportDryRun(
      { fileName: 'once.csv', content: file(`IMP-ONCE,Widget,${categorySlug},10.00,,,,,`) },
      actor,
    );

    await confirmProductImport(importJobId, { skipInvalidRows: false }, actor);
    await expect(confirmProductImport(importJobId, { skipInvalidRows: false }, actor)).rejects.toThrow(
      /already been imported/,
    );

    expect(await prisma.product.count()).toBe(1);
  });

  it('updates a product whose SKU already exists instead of creating a second one', async () => {
    await createProduct(
      {
        name: 'Original',
        sku: 'IMP-UPD',
        categoryId: (await prisma.category.findFirstOrThrow()).id,
        basePriceMinor: '1000',
      },
      actor,
    );

    const { importJobId } = await createProductImportDryRun(
      { fileName: 'u.csv', content: file(`IMP-UPD,Renamed,${categorySlug},25.00,ACTIVE,,,,`) },
      actor,
    );
    const previewJob = await getImportJob(importJobId);
    expect((previewJob.result as { updates: number }).updates).toBe(1);

    const applied = await confirmProductImport(importJobId, { skipInvalidRows: false }, actor);
    const job = await getImportJob(applied.importJobId);

    expect(job.updatedRows).toBe(1);
    expect(job.createdRows).toBe(0);

    const product = await prisma.product.findUniqueOrThrow({ where: { sku: 'IMP-UPD' } });
    expect(product.name).toBe('Renamed');
    expect(product.basePriceMinor).toBe(2500n);
    expect(await prisma.product.count()).toBe(1);
  });

  it('never publishes, however the file is written', async () => {
    const { importJobId } = await createProductImportDryRun(
      { fileName: 'pub.csv', content: file(`IMP-PUB,Widget,${categorySlug},10.00,ACTIVE,,,,`) },
      actor,
    );
    await confirmProductImport(importJobId, { skipInvalidRows: false }, actor);

    const product = await prisma.product.findUniqueOrThrow({ where: { sku: 'IMP-PUB' } });

    // Import can activate a product. Only an explicit publish, with its own
    // checks, puts it on the Customer Website.
    expect(product.status).toBe('ACTIVE');
    expect(product.isPublished).toBe(false);
    expect(product.publishedAt).toBeNull();
  });

  it('re-validates against the database rather than trusting the preview', async () => {
    const { importJobId } = await createProductImportDryRun(
      { fileName: 'stale.csv', content: file(`IMP-STALE,Widget,${categorySlug},10.00,,,,,`) },
      actor,
    );

    const previewJob = await getImportJob(importJobId);
    expect(previewJob.validRows).toBe(1);

    // The category the preview resolved is archived before the confirm.
    const category = await prisma.category.findFirstOrThrow();
    await prisma.category.update({
      where: { id: category.id },
      data: { archivedAt: new Date() },
    });

    await expect(confirmProductImport(importJobId, { skipInvalidRows: false }, actor)).rejects.toThrow(
      /row\(s\) have errors/,
    );
    expect(await prisma.product.count()).toBe(0);
  });

  it('applies every valid row in one pass', async () => {
    const { importJobId } = await createProductImportDryRun(
      {
        fileName: 'two.csv',
        content: file(
          `IMP-W1,First,${categorySlug},10.00,,,,,`,
          `IMP-W2,Second,${categorySlug},20.00,,,,,`,
        ),
      },
      actor,
    );

    const applied = await confirmProductImport(importJobId, { skipInvalidRows: false }, actor);
    const job = await getImportJob(applied.importJobId);

    expect(job.createdRows).toBe(2);
    expect(job.status).toBe('SUCCEEDED');
  });
});

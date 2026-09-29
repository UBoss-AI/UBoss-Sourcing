/**
 * Every table records when each row was created and when it last changed.
 *
 * DOD-019. The rule is universal on purpose: "when did this appear" and "when
 * did it last move" are the first two questions anybody asks of a row in an
 * incident, a support case or a data-subject request, and a table that cannot
 * answer them is only discovered to be one on the day it matters. Domain
 * timestamps (receivedAt, assignedAt, decidedAt ...) stay alongside - they
 * mean something the row-level stamps do not - but they do not replace them.
 *
 * So this reads `schema.prisma` as text, the way
 * `export-bundle-completeness.test.ts` does, and fails for any model without
 * both columns in the house form:
 *
 *   createdAt DateTime @default(now()) @db.DateTime(3)
 *   updatedAt DateTime @updatedAt @db.DateTime(3)      (a @default(now()) too is fine)
 *
 * A new model that forgets either turns this red before its migration ships.
 * The migration adding a column is checked separately, by CI's
 * `prisma migrate diff` step: a column declared here and never migrated is
 * drift, and that step fails on drift.
 *
 * There is no allowlist. If a table ever genuinely must not have one of these,
 * add an entry here with the reason, so the exception is a decision somebody
 * can read rather than an omission nobody noticed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCHEMA_PATH = fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url));
const GRANTS_PATH = fileURLToPath(
  new URL('../../../deploy/mariadb/post-migrate-grants.sql', import.meta.url),
);

/** Models allowed to lack a column, each with the reason. Empty by design. */
const EXCEPTIONS: Readonly<Record<string, { createdAt?: string; updatedAt?: string }>> = {};

interface ModelTimestamps {
  model: string;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Each model's createdAt / updatedAt declaration, or null when absent. */
function readModelTimestamps(schema: string): ModelTimestamps[] {
  const text = schema.replace(/\r\n/g, '\n');
  const models: ModelTimestamps[] = [];
  const modelPattern = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let match: RegExpExecArray | null;
  while ((match = modelPattern.exec(text)) !== null) {
    const fields = (match[2] ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^\w+\s+\S/.test(line) && !line.startsWith('//'));
    const find = (name: string): string | null =>
      fields.find((line) => line.split(/\s+/)[0] === name) ?? null;
    models.push({ model: match[1] ?? '', createdAt: find('createdAt'), updatedAt: find('updatedAt') });
  }
  return models;
}

const CREATED_FORM = /^createdAt\s+DateTime\s+@default\(now\(\)\)\s+@db\.DateTime\(3\)$/;
const UPDATED_FORM =
  /^updatedAt\s+DateTime\s+(@default\(now\(\)\)\s+)?@updatedAt\s+(@default\(now\(\)\)\s+)?@db\.DateTime\(3\)$/;

/** Human-readable problems, one per offending model and column. */
function timestampProblems(models: ModelTimestamps[]): string[] {
  const problems: string[] = [];
  for (const { model, createdAt, updatedAt } of models) {
    const exception = EXCEPTIONS[model] ?? {};
    if (exception.createdAt === undefined) {
      if (createdAt === null) problems.push(`${model}: no createdAt`);
      else if (!CREATED_FORM.test(createdAt)) problems.push(`${model}: createdAt is "${createdAt}"`);
    }
    if (exception.updatedAt === undefined) {
      if (updatedAt === null) problems.push(`${model}: no updatedAt`);
      else if (!UPDATED_FORM.test(updatedAt)) problems.push(`${model}: updatedAt is "${updatedAt}"`);
    }
  }
  return problems;
}

describe('every table has createdAt and updatedAt (DOD-019)', () => {
  const models = readModelTimestamps(readFileSync(SCHEMA_PATH, 'utf8'));

  it('reads the real schema, not an empty file', () => {
    expect(models.length).toBeGreaterThan(200);
  });

  it('no model is missing either column, and both use the house form', () => {
    expect(timestampProblems(models)).toEqual([]);
  });

  it('every exception names a real model and gives a reason', () => {
    const names = new Set(models.map((m) => m.model));
    for (const [model, reasons] of Object.entries(EXCEPTIONS)) {
      expect(names.has(model), `${model} is not a model`).toBe(true);
      for (const reason of Object.values(reasons)) expect(reason.trim().length).toBeGreaterThan(20);
    }
  });

  it('catches a model that lacks them, or declares them the wrong way', () => {
    const sample = [
      'model Good {',
      '  id        String   @id',
      '  createdAt DateTime @default(now()) @db.DateTime(3)',
      '  updatedAt DateTime @updatedAt @db.DateTime(3)',
      '}',
      'model NoStamps {',
      '  id         String   @id',
      '  receivedAt DateTime @db.DateTime(3)',
      '}',
      'model WrongForm {',
      '  id        String    @id',
      '  // createdAt DateTime  -- a comment is not a column',
      '  createdAt DateTime?',
      '  updatedAt DateTime  @db.DateTime(3)',
      '}',
    ].join('\r\n');
    expect(timestampProblems(readModelTimestamps(sample))).toEqual([
      'NoStamps: no createdAt',
      'NoStamps: no updatedAt',
      'WrongForm: createdAt is "createdAt DateTime?"',
      'WrongForm: updatedAt is "updatedAt DateTime  @db.DateTime(3)"',
    ]);
  });

  /*
   * audit_logs is append-only for the application account, and the
   * maintenance account may UPDATE only named columns. Prisma writes
   * `updatedAt` on every update it issues, including the erasure's
   * pseudonymising `updateMany`, so without updatedAt in that grant a GDPR
   * erasure would fail in production with a permission error - while passing
   * here, where one account holds every grant.
   */
  it('the audit maintenance grant lets Prisma stamp updatedAt when it pseudonymises', () => {
    const grants = readFileSync(GRANTS_PATH, 'utf8');
    expect(grants).toMatch(/GRANT UPDATE \(actorEmail, ipAddress, updatedAt, userAgent\) ON/);
    expect(grants).toContain("= ''actorEmail,ipAddress,updatedAt,userAgent''");
  });
});

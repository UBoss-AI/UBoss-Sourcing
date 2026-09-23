/**
 * A CHECK constraint may not sit over a column a foreign key can rewrite.
 *
 * WHY THIS TEST EXISTS
 *
 * From MariaDB 10.5 onwards, this is refused:
 *
 *   Function or expression 'sellerCarrierConnectionId' cannot be used in the
 *   CHECK clause of `chk_seller_fulfilment_method_single_target`
 *
 * Two referential actions REWRITE a child column - `ON UPDATE CASCADE`, which
 * copies a changed parent key down, and `ON DELETE SET NULL`, which writes a
 * NULL. Either would leave a checked row holding a value the check never saw,
 * so the server refuses to let both apply to one column. `ON DELETE CASCADE`
 * and `RESTRICT` are fine: they remove the row or refuse the parent's change
 * rather than editing this column.
 *
 * Whichever of the two constraints is added second is the one that fails, so
 * reordering a migration does not help - it only moves the error.
 *
 * WHY IT IS A TEST AND NOT A NOTE IN A GUIDE
 *
 * Development runs MariaDB 10.4, which allows all of it. A migration with this
 * fault therefore applies cleanly on every machine here, passes review, and
 * fails on the first fresh 11.4 database it meets - which is CI, or worse, a
 * customer installing the product. It cost two red pipelines to find once.
 *
 * Prisma emits `ON UPDATE CASCADE` on every relation unless told otherwise, so
 * the fault is the DEFAULT, and anybody adding a CHECK constraint will hit it
 * eventually. This reads the committed migrations and says so first.
 *
 * WHAT TO DO WHEN IT FAILS
 *
 * Decide which of the two the column actually needs.
 *
 *   - The parent's key is a ULID generated once and never updated, so
 *     `ON UPDATE CASCADE` has nothing to cascade. Declare `onUpdate: Restrict`
 *     on the relation in schema.prisma and write `ON UPDATE RESTRICT` in the
 *     migration. This is almost always the answer.
 *   - `ON DELETE SET NULL` under a CHECK is usually a real design conflict
 *     rather than a technicality: emptying the column is precisely what the
 *     check forbids. `ON DELETE RESTRICT` is normally what was meant.
 *
 * Never fix it by dropping the CHECK. The constraint is the invariant; the
 * referential action is a default nobody chose.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = path.join(process.cwd(), 'prisma', 'migrations');

/** One `ALTER TABLE` statement, comments stripped and whitespace flattened. */
function statementsOf(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim().replace(/\s+/g, ' '))
    .filter((statement) => statement.length > 0);
}

interface Clash {
  table: string;
  column: string;
  migration: string;
  order: string;
}

/**
 * Replays every migration in order and reports each column that ends up with
 * both a CHECK constraint and a foreign key that can rewrite it.
 *
 * In order, because the two halves are usually in different files: a table
 * gains its keys when it is created and its CHECK constraints months later.
 */
function findClashes(): Clash[] {
  const rewritable = new Map<string, Set<string>>();
  const checked = new Map<string, Set<string>>();
  const clashes = new Map<string, Clash>();

  const record = (table: string, column: string, migration: string, order: string): void => {
    clashes.set(`${table}.${column}`, { table, column, migration, order });
  };

  const directories = readdirSync(MIGRATIONS)
    .filter((entry) => /^\d/.test(entry))
    .sort();

  for (const directory of directories) {
    let sql: string;
    try {
      sql = readFileSync(path.join(MIGRATIONS, directory, 'migration.sql'), 'utf8');
    } catch {
      continue;
    }

    for (const statement of statementsOf(sql)) {
      const table = /^ALTER TABLE `([^`]+)`/i.exec(statement)?.[1];
      if (table === undefined) continue;

      // One ALTER may add several constraints, so each is matched separately
      // and only up to the comma that ends it - otherwise one key's SET NULL
      // would be read as belonging to the next key in the same statement.
      for (const match of statement.matchAll(
        /ADD CONSTRAINT `[^`]+` FOREIGN KEY \(`([^`]+)`\)[^,;]*/gi,
      )) {
        const column = match[1] as string;
        const rewrites =
          /ON UPDATE (CASCADE|SET NULL)/i.test(match[0]) || /ON DELETE SET NULL/i.test(match[0]);

        if (!rewritable.has(table)) rewritable.set(table, new Set());
        // A key dropped and re-added with a safe action clears the mark, which
        // is exactly how one of these is meant to be fixed.
        if (rewrites) rewritable.get(table)?.add(column);
        else rewritable.get(table)?.delete(column);

        if (rewrites && checked.get(table)?.has(column) === true) {
          record(table, column, directory, 'the foreign key was added after the CHECK');
        }
      }

      const check = /ADD CONSTRAINT `[^`]+`\s*CHECK \(([\s\S]*)\)$/i.exec(statement);
      if (check !== null) {
        if (!checked.has(table)) checked.set(table, new Set());
        for (const column of (check[1] as string).matchAll(/`([^`]+)`/g)) {
          const name = column[1] as string;
          checked.get(table)?.add(name);
          if (rewritable.get(table)?.has(name) === true) {
            record(table, name, directory, 'the CHECK was added after the foreign key');
          }
        }
      }
    }
  }

  return [...clashes.values()];
}

describe('migration CHECK constraints', () => {
  it('never guards a column that a foreign key can rewrite', () => {
    const clashes = findClashes();

    // The message carries the whole diagnosis, because a bare count tells
    // somebody a rule was broken and nothing about where or what to do.
    const detail = clashes
      .map(
        (clash) =>
          `  ${clash.table}.${clash.column} — in ${clash.migration}, ${clash.order}`,
      )
      .join('\n');

    expect(
      clashes,
      clashes.length === 0
        ? ''
        : `MariaDB 10.5+ refuses a CHECK constraint over a column a foreign key can rewrite ` +
            `(ON UPDATE CASCADE / SET NULL, or ON DELETE SET NULL). 10.4 allows it, so this ` +
            `applies here and fails on a fresh production-version database:\n${detail}\n` +
            `Give the relation onUpdate: Restrict (and usually onDelete: Restrict) in ` +
            `schema.prisma and in the migration. Do not drop the CHECK.`,
    ).toEqual([]);
  });

  it('reads the migrations it claims to read', () => {
    // A guard that silently scans nothing passes for ever. This is the cheap
    // proof that the directory was found and the parser matched something.
    const directories = readdirSync(MIGRATIONS).filter((entry) => /^\d/.test(entry));
    expect(directories.length).toBeGreaterThan(50);

    const anyForeignKey = directories.some((directory) =>
      statementsOf(
        readFileSync(path.join(MIGRATIONS, directory, 'migration.sql'), 'utf8'),
      ).some((statement) => /FOREIGN KEY/i.test(statement)),
    );
    expect(anyForeignKey).toBe(true);
  });
});

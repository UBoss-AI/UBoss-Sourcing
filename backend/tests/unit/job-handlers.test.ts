/**
 * Every job type the system can enqueue must have somewhere to be run.
 *
 * The regression this file exists for: a job whose handler is missing used to
 * be marked DEAD on its first attempt, and 312 of them were destroyed over one
 * afternoon before anybody noticed. The runner now hands such a job back to the
 * queue instead - but a type that no worker anywhere implements still ends up
 * dead once its attempts run out, so the real fix is to never ship one.
 *
 * `RESERVED_TYPES` is the deliberate exception: constants declared ahead of the
 * feature that will use them. They are safe only for as long as nothing
 * enqueues them, which the second test checks.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JobType } from '../../src/infra/queue/types.js';
import { HANDLERS, handlerFor } from '../../src/worker/handlers.js';

/**
 * Declared, but no feature enqueues them yet. Adding a handler? Remove the
 * entry. Adding an `enqueue` call? Write the handler first.
 */
const RESERVED_TYPES: readonly string[] = [
  JobType.PAYMENT_RECONCILE,
  JobType.REFUND_POLL,
  JobType.IMPORT_PROCESS,
];

const sourceOf = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(`../../src/${relativePath}`, import.meta.url)), 'utf8');

describe('job handler coverage', () => {
  it('registers a handler for every job type that is not explicitly reserved', () => {
    const expected = Object.values(JobType)
      .filter((type) => !RESERVED_TYPES.includes(type))
      .sort();

    const registered = Object.keys(HANDLERS).sort();

    expect(registered).toEqual(expected);
  });

  it('resolves each registered type to a callable handler', () => {
    for (const type of Object.keys(HANDLERS)) {
      expect(typeof handlerFor(type)).toBe('function');
    }
  });

  it('has no handler for a reserved type, and no code enqueuing one', () => {
    // Both halves matter. A reserved type with a handler is just an
    // out-of-date list; a reserved type that something enqueues is a job that
    // will retry until its attempts run out and then die.
    const workerSource = sourceOf('worker/index.ts');
    const handlersSource = sourceOf('worker/handlers.ts');

    for (const type of RESERVED_TYPES) {
      expect(handlerFor(type), `${type} is reserved but has a handler`).toBeUndefined();

      const constantName = Object.entries(JobType).find(([, value]) => value === type)?.[0] ?? '';
      const reference = `JobType.${constantName}`;

      expect(
        workerSource.includes(reference) || handlersSource.includes(reference),
        `${type} is reserved but the worker references it`,
      ).toBe(false);
    }
  });

  it('never reports an unknown type as handled', () => {
    expect(handlerFor('does.not.exist')).toBeUndefined();
  });
});

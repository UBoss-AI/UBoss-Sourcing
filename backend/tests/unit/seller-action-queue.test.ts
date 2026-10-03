import { describe, expect, it } from 'vitest';
import { rankTasks, type ActionKind } from '../../src/modules/seller/action-queue.service.js';

const NOW = new Date('2026-10-03T12:00:00.000Z');
const H = 3_600_000;
const t = (id: string, kind: ActionKind, offsetMs: number, impact: bigint) => ({
  kind, id, reference: id, dueAt: new Date(NOW.getTime() + offsetMs).toISOString(), overdue: offsetMs <= 0,
  amountMinor: impact.toString(), currency: 'EUR', href: '/' + id, at: NOW.getTime() + offsetMs, impact,
});

describe('seller action queue ranking (ENH-018)', () => {
  it('puts overdue first, then due within a day, then by deadline, kind weight, amount and id', () => {
    const ranked = rankTasks([
      t('q-far', 'QUOTE', 72 * H, 10n ** 18n),
      t('d-soon', 'DISPATCH', 5 * H, 100n),
      t('q-late', 'QUOTE', -2 * H, 1n),
      t('x-exact', 'DISPATCH', 0, 1n),
      t('dsp-same', 'DISPUTE_RESPONSE', 5 * H, 1n),
      t('d-same-big', 'DISPATCH', 5 * H, 9007199254740993n),
      t('b-tie', 'QUOTE', 48 * H, 5n),
      t('a-tie', 'QUOTE', 48 * H, 5n),
    ], NOW);
    expect(ranked.map((task) => task.id)).toEqual(['q-late', 'x-exact', 'dsp-same', 'd-same-big', 'd-soon', 'a-tie', 'b-tie', 'q-far']);
    expect(ranked[1]?.overdue).toBe(true);
    expect(Object.keys(ranked[0] ?? {})).not.toContain('impact');
  });
});

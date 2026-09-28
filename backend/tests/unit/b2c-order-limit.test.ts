/**
 * The B2C maximum order quantity: what a seller may type, who it binds, and
 * how the whole product is counted so duplicate lines and variants cannot
 * split round it.
 */
import { describe, expect, it } from 'vitest';

import {
  B2C_MAX_ORDER_QUANTITY_CEILING,
  findB2cViolations,
  isB2cChangeRefused,
  isB2cLimitApplicable,
  totalB2cGroups,
  validateB2cMaxOrderQuantity,
  type B2cBuyer,
  type B2cLine,
} from '../../src/domain/b2c-order-limit.js';

const individual: B2cBuyer = { kind: 'INDIVIDUAL' };
const guest: B2cBuyer = { kind: 'GUEST' };
const approved: B2cBuyer = { kind: 'COMPANY', companyId: 'c1', companyStatus: 'APPROVED' };

function line(overrides: Partial<B2cLine>): B2cLine {
  return { productId: 'p1', sellerAccountId: 's1', quantity: 1, limit: 100, ...overrides };
}

describe('validateB2cMaxOrderQuantity', () => {
  it('accepts a whole number from one up to the ceiling', () => {
    expect(validateB2cMaxOrderQuantity(1)).toEqual({ ok: true, value: 1 });
    expect(validateB2cMaxOrderQuantity(100)).toEqual({ ok: true, value: 100 });
    expect(validateB2cMaxOrderQuantity(B2C_MAX_ORDER_QUANTITY_CEILING)).toEqual({
      ok: true,
      value: B2C_MAX_ORDER_QUANTITY_CEILING,
    });
  });

  it.each([
    [null, 'REQUIRED'],
    [undefined, 'REQUIRED'],
    ['', 'REQUIRED'],
    [0, 'NOT_POSITIVE'],
    [-5, 'NOT_POSITIVE'],
    [2.5, 'NOT_A_WHOLE_NUMBER'],
    [Number.NaN, 'NOT_A_WHOLE_NUMBER'],
    [Number.POSITIVE_INFINITY, 'NOT_A_WHOLE_NUMBER'],
    ['100', 'NOT_A_WHOLE_NUMBER'],
    ['1e2', 'NOT_A_WHOLE_NUMBER'],
    ['abc', 'NOT_A_WHOLE_NUMBER'],
    [true, 'NOT_A_WHOLE_NUMBER'],
    [B2C_MAX_ORDER_QUANTITY_CEILING + 1, 'TOO_LARGE'],
    [1e300, 'TOO_LARGE'],
  ])('refuses %p with %s', (raw, code) => {
    expect(validateB2cMaxOrderQuantity(raw)).toEqual({ ok: false, code });
  });

  it('refuses a limit below the offer minimum, which would make it unbuyable', () => {
    expect(validateB2cMaxOrderQuantity(5, { minimumOrderQuantity: 10 })).toEqual({
      ok: false,
      code: 'BELOW_MINIMUM',
    });
    expect(validateB2cMaxOrderQuantity(10, { minimumOrderQuantity: 10 })).toEqual({ ok: true, value: 10 });
  });
});

describe('isB2cLimitApplicable', () => {
  it('binds guests and individuals', () => {
    expect(isB2cLimitApplicable(guest)).toBe(true);
    expect(isB2cLimitApplicable(individual)).toBe(true);
  });

  it('exempts only an APPROVED company', () => {
    expect(isB2cLimitApplicable(approved)).toBe(false);
    for (const status of [
      'DRAFT',
      'SUBMITTED',
      'UNDER_REVIEW',
      'MORE_INFORMATION_REQUIRED',
      'REJECTED',
      'SUSPENDED',
      'REVERIFICATION_REQUIRED',
    ]) {
      expect(isB2cLimitApplicable({ kind: 'COMPANY', companyId: 'c1', companyStatus: status })).toBe(true);
    }
  });
});

describe('findB2cViolations', () => {
  it('allows below and exactly at the limit, refuses one over', () => {
    expect(findB2cViolations(individual, [line({ quantity: 99 })])).toEqual([]);
    expect(findB2cViolations(individual, [line({ quantity: 100 })])).toEqual([]);
    expect(findB2cViolations(individual, [line({ quantity: 101 })])).toHaveLength(1);
  });

  it('adds variants of one product together: 60 + 50 against 100 is over', () => {
    const [violation] = findB2cViolations(individual, [line({ quantity: 60 }), line({ quantity: 50 })]);
    expect(violation).toMatchObject({ productId: 'p1', totalQuantity: 110, limit: 100 });
  });

  it('counts each seller of a shared product separately', () => {
    expect(
      findB2cViolations(individual, [
        line({ sellerAccountId: 's1', quantity: 80 }),
        line({ sellerAccountId: 's2', quantity: 80 }),
      ]),
    ).toEqual([]);
  });

  it('keeps the operator stock as its own group', () => {
    const groups = totalB2cGroups([line({ sellerAccountId: null, quantity: 3 }), line({ quantity: 4 })]);
    expect(groups.size).toBe(2);
  });

  it('takes the lowest limit when lines disagree, so a gap cannot open', () => {
    const [violation] = findB2cViolations(individual, [
      line({ quantity: 40, limit: 100 }),
      line({ quantity: 40, limit: 50 }),
    ]);
    expect(violation?.limit).toBe(50);
  });

  it('applies no ceiling where none is configured', () => {
    expect(findB2cViolations(individual, [line({ quantity: 10_000, limit: null })])).toEqual([]);
  });

  it('never flags an approved company', () => {
    expect(findB2cViolations(approved, [line({ quantity: 10_000 })])).toEqual([]);
  });
});

describe('isB2cChangeRefused', () => {
  const change = { currentGroupQuantity: 60, proposedGroupQuantity: 110, limit: 100 };

  it('refuses an increase that ends over the limit', () => {
    expect(isB2cChangeRefused(individual, change)).toBe(true);
    expect(isB2cChangeRefused(guest, change)).toBe(true);
  });

  it('allows an increase that ends exactly at the limit', () => {
    expect(isB2cChangeRefused(individual, { ...change, proposedGroupQuantity: 100 })).toBe(false);
  });

  it('always allows a reduction, even one that is still over', () => {
    expect(
      isB2cChangeRefused(individual, { currentGroupQuantity: 150, proposedGroupQuantity: 120, limit: 100 }),
    ).toBe(false);
  });

  it('lets an approved company past, and a pending one not', () => {
    expect(isB2cChangeRefused(approved, change)).toBe(false);
    expect(
      isB2cChangeRefused({ kind: 'COMPANY', companyId: 'c1', companyStatus: 'UNDER_REVIEW' }, change),
    ).toBe(true);
  });
});

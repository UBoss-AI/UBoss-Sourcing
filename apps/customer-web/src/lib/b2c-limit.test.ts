/**
 * The storefront's half of the B2C maximum order quantity: who is held to it,
 * which next step they are offered, what "Reduce to" offers, and what a
 * seller may type. The server decides all of it again; these decide what the
 * page says before it asks.
 */
import { describe, expect, it } from 'vitest';

import { ApiError } from './api';
import {
  B2C_LIMIT_CEILING,
  b2cAudience,
  b2cRefusalOf,
  isB2cLimitApplicable,
  largestValidAtMost,
  parseB2cLimitInput,
  remainingUnderLimit,
} from './b2c-limit';
import type { BuyerContext, CompanyContextOption } from '@/auth/session-context';

const approved: CompanyContextOption = {
  companyId: 'C1',
  companyName: 'Acme',
  companyStatus: 'APPROVED',
  role: 'OWNER',
  applicationReference: 'BC-1',
};
const pending: CompanyContextOption = { ...approved, companyId: 'C2', companyName: 'Beta', companyStatus: 'UNDER_REVIEW' };
const individual: BuyerContext = { kind: 'INDIVIDUAL' };

describe('isB2cLimitApplicable', () => {
  it('holds guests, individuals and unapproved companies; exempts only an approved company', () => {
    expect(isB2cLimitApplicable({ isCustomer: false, buyerContext: individual })).toBe(true);
    expect(isB2cLimitApplicable({ isCustomer: true, buyerContext: individual })).toBe(true);
    expect(isB2cLimitApplicable({ isCustomer: true, buyerContext: { kind: 'COMPANY', ...pending } })).toBe(true);
    expect(
      isB2cLimitApplicable({ isCustomer: true, buyerContext: { kind: 'COMPANY', ...pending, companyStatus: 'SUSPENDED' } }),
    ).toBe(true);
    expect(isB2cLimitApplicable({ isCustomer: true, buyerContext: { kind: 'COMPANY', ...approved } })).toBe(false);
  });
});

describe('b2cAudience', () => {
  it('offers a guest sign-in', () => {
    expect(b2cAudience({ isCustomer: false, buyerContext: individual, companies: [] }).kind).toBe('GUEST');
  });

  it('offers a switch to somebody with an approved company, ahead of a pending one', () => {
    const audience = b2cAudience({ isCustomer: true, buyerContext: individual, companies: [pending, approved] });
    expect(audience).toEqual({ kind: 'HAS_APPROVED', companies: [approved] });
  });

  it('offers the verification status when every company is still pending', () => {
    expect(b2cAudience({ isCustomer: true, buyerContext: individual, companies: [pending] })).toEqual({
      kind: 'HAS_PENDING',
      company: pending,
    });
  });

  it('offers registration to somebody with no company', () => {
    expect(b2cAudience({ isCustomer: true, buyerContext: individual, companies: [] }).kind).toBe('NO_COMPANY');
  });

  it('names the company when buying for one that is not approved', () => {
    const audience = b2cAudience({ isCustomer: true, buyerContext: { kind: 'COMPANY', ...pending }, companies: [pending] });
    expect(audience).toEqual({ kind: 'COMPANY_NOT_APPROVED', company: pending });
  });
});

describe('b2cRefusalOf', () => {
  it('reads the figures from a B2C refusal', () => {
    const error = new ApiError(409, {
      code: 'B2C_MAX_ORDER_QUANTITY_EXCEEDED',
      message: 'Individual buyers can order up to 100 units of this product.',
      details: [
        {
          code: 'B2C_MAX_ORDER_QUANTITY_EXCEEDED',
          meta: { productId: 'P1', allowedQuantity: 100, requestedQuantity: 110, currentCartQuantity: 60 },
        },
      ],
    });
    expect(b2cRefusalOf(error)).toEqual({
      productId: 'P1',
      allowedQuantity: 100,
      requestedQuantity: 110,
      currentCartQuantity: 60,
    });
  });

  it('finds the B2C line inside a checkout refused over basket lines', () => {
    const error = new ApiError(409, {
      code: 'CART_ITEM_UNAVAILABLE',
      message: 'Some items need attention.',
      details: [{ code: 'INSUFFICIENT_STOCK' }, { code: 'B2C_MAX_ORDER_QUANTITY_EXCEEDED', meta: { allowedQuantity: 5 } }],
    });
    expect(b2cRefusalOf(error)?.allowedQuantity).toBe(5);
  });

  it('ignores anything else', () => {
    expect(b2cRefusalOf(new ApiError(409, { code: 'QUANTITY_ABOVE_MAXIMUM', message: 'x' }))).toBeNull();
    expect(b2cRefusalOf(new Error('x'))).toBeNull();
  });
});

describe('what "Reduce to" offers', () => {
  it('adds only what still fits on top of the basket', () => {
    expect(remainingUnderLimit(100, 60)).toBe(40);
    expect(remainingUnderLimit(100, 120)).toBe(0);
  });

  it('rounds DOWN to a quantity the product accepts, never over the limit', () => {
    const rules = { minOrderQty: 10, maxOrderQty: null, qtyIncrement: 5 };
    expect(largestValidAtMost(100, rules)).toBe(100);
    expect(largestValidAtMost(98, rules)).toBe(95);
    expect(largestValidAtMost(9, rules)).toBeNull();
    expect(largestValidAtMost(100, { ...rules, maxOrderQty: 60 })).toBe(60);
  });
});

describe('parseB2cLimitInput', () => {
  it('accepts a whole number from 1 to the ceiling', () => {
    expect(parseB2cLimitInput('100')).toEqual({ ok: true, value: 100 });
    expect(parseB2cLimitInput(' 7 ')).toEqual({ ok: true, value: 7 });
    expect(parseB2cLimitInput(String(B2C_LIMIT_CEILING))).toEqual({ ok: true, value: B2C_LIMIT_CEILING });
  });

  it.each([
    ['', 'REQUIRED'],
    ['0', 'NOT_POSITIVE'],
    ['-3', 'NOT_POSITIVE'],
    ['2.5', 'NOT_A_WHOLE_NUMBER'],
    ['1e2', 'NOT_A_WHOLE_NUMBER'],
    ['100abc', 'NOT_A_WHOLE_NUMBER'],
    ['NaN', 'NOT_A_WHOLE_NUMBER'],
    [String(B2C_LIMIT_CEILING + 1), 'TOO_LARGE'],
  ])('refuses %p as %s, rather than correcting it', (typed, problem) => {
    expect(parseB2cLimitInput(typed)).toEqual({ ok: false, problem });
  });

  it('refuses a limit below the minimum order quantity', () => {
    expect(parseB2cLimitInput('5', { minimumOrderQuantity: 10 })).toEqual({ ok: false, problem: 'BELOW_MINIMUM' });
  });
});

/**
 * Seller roles, and the escalations they must not permit.
 *
 * The interesting assertions here are all negative. A permission matrix is
 * easy to get right in the direction of "can the owner do everything" and easy
 * to get wrong in the direction of "can a support member quietly become one",
 * and the second is the one that matters.
 */
import { describe, expect, it } from 'vitest';
import {
  ALL_SELLER_PERMISSIONS,
  SELLER_ROLE_DEFINITIONS,
  SellerPermission,
  SellerRole,
  canGrantSellerRole,
  permissionsForSellerRole,
  sellerRoleDefinition,
  sellerRoleHas,
} from '../../src/domain/seller-permissions.js';

describe('the role catalogue', () => {
  it('gives the owner everything', () => {
    const owner = permissionsForSellerRole(SellerRole.OWNER);
    for (const permission of ALL_SELLER_PERMISSIONS) {
      expect(owner.has(permission)).toBe(true);
    }
  });

  it('grants nothing at all for a role it does not know', () => {
    // The safe direction to fail. A `SellerMemberRole` added to the schema
    // without a grant here locks its holders out rather than letting them
    // through.
    expect(permissionsForSellerRole('DIRECTOR_OF_VIBES').size).toBe(0);
    expect(sellerRoleDefinition('DIRECTOR_OF_VIBES')).toBeUndefined();
  });

  it('has a definition for every role it names', () => {
    for (const role of Object.values(SellerRole)) {
      expect(sellerRoleDefinition(role)).toBeDefined();
    }
  });

  it('never grants a seller permission that looks like an operator one', () => {
    // Every key is namespaced `seller.`. A key without that prefix would be a
    // key that could collide with the operator catalogue, and a route that
    // accepted either is the route through which a seller reaches another
    // seller's data.
    for (const permission of ALL_SELLER_PERMISSIONS) {
      expect(permission.startsWith('seller.')).toBe(true);
    }
  });
});

describe('the restrictions that look like omissions', () => {
  it('lets only the owner accept an agreement', () => {
    // Signing binds the business. Running the business's day is not the same
    // as signing for it.
    for (const definition of SELLER_ROLE_DEFINITIONS) {
      expect(sellerRoleHas(definition.key, SellerPermission.AGREEMENT_ACCEPT)).toBe(
        definition.key === SellerRole.OWNER,
      );
    }
  });

  it('lets only the owner and an admin change who is in the organisation', () => {
    // `MEMBER_WRITE` is the permission that grants permissions. A catalogue
    // manager holding it could invite themselves a second account with every
    // other key.
    for (const definition of SELLER_ROLE_DEFINITIONS) {
      const expected =
        definition.key === SellerRole.OWNER || definition.key === SellerRole.ADMIN;

      expect(sellerRoleHas(definition.key, SellerPermission.MEMBER_WRITE)).toBe(expected);
    }
  });

  it('keeps the finance viewer read-only', () => {
    const finance = permissionsForSellerRole(SellerRole.FINANCE_VIEWER);

    for (const permission of [
      SellerPermission.LISTING_WRITE,
      SellerPermission.OFFER_PUBLISH,
      SellerPermission.OFFER_PRICE_WRITE,
      SellerPermission.INVENTORY_WRITE,
      SellerPermission.INVENTORY_ADJUST,
      SellerPermission.ORDER_FULFIL,
      SellerPermission.ORDER_CANCEL,
      SellerPermission.PAYOUT_SETUP,
    ]) {
      expect(finance.has(permission)).toBe(false);
    }

    expect(finance.has(SellerPermission.FINANCE_READ)).toBe(true);
  });

  it('lets a support member change nothing', () => {
    const support = permissionsForSellerRole(SellerRole.SUPPORT_MEMBER);

    for (const permission of support) {
      // Every key they hold ends in `.read`. That is the whole role.
      expect(permission.endsWith('.read')).toBe(true);
    }
  });

  it('does not let a catalogue manager touch stock or money', () => {
    const catalogue = permissionsForSellerRole(SellerRole.CATALOGUE_MANAGER);

    expect(catalogue.has(SellerPermission.INVENTORY_READ)).toBe(true);
    expect(catalogue.has(SellerPermission.INVENTORY_WRITE)).toBe(false);
    expect(catalogue.has(SellerPermission.INVENTORY_ADJUST)).toBe(false);
    expect(catalogue.has(SellerPermission.FINANCE_READ)).toBe(false);
  });

  it('does not let an inventory manager publish a listing', () => {
    const inventory = permissionsForSellerRole(SellerRole.INVENTORY_MANAGER);

    expect(inventory.has(SellerPermission.INVENTORY_ADJUST)).toBe(true);
    expect(inventory.has(SellerPermission.LISTING_WRITE)).toBe(false);
    expect(inventory.has(SellerPermission.OFFER_PUBLISH)).toBe(false);
  });
});

describe('canGrantSellerRole', () => {
  it('lets an owner appoint anybody', () => {
    for (const definition of SELLER_ROLE_DEFINITIONS) {
      expect(canGrantSellerRole(SellerRole.OWNER, definition.key)).toBe(true);
    }
  });

  it('refuses to let an admin mint an owner', () => {
    // The escalation this function exists to close: an ADMIN doing so would be
    // awarding themselves `AGREEMENT_ACCEPT`, the one permission ADMIN
    // deliberately lacks.
    expect(canGrantSellerRole(SellerRole.ADMIN, SellerRole.OWNER)).toBe(false);

    // Everything at or below their own authority is still fine.
    expect(canGrantSellerRole(SellerRole.ADMIN, SellerRole.ADMIN)).toBe(true);
    expect(canGrantSellerRole(SellerRole.ADMIN, SellerRole.CATALOGUE_MANAGER)).toBe(true);
  });

  it('refuses anybody without MEMBER_WRITE, whatever else they hold', () => {
    for (const role of [
      SellerRole.CATALOGUE_MANAGER,
      SellerRole.INVENTORY_MANAGER,
      SellerRole.ORDER_MANAGER,
      SellerRole.FINANCE_VIEWER,
      SellerRole.SUPPORT_MEMBER,
    ]) {
      expect(canGrantSellerRole(role, SellerRole.SUPPORT_MEMBER)).toBe(false);
    }
  });

  it('refuses an unknown role on either side', () => {
    expect(canGrantSellerRole('NOPE', SellerRole.SUPPORT_MEMBER)).toBe(false);
    expect(canGrantSellerRole(SellerRole.OWNER, 'NOPE')).toBe(false);
  });

  it('never lets anybody grant more than they hold', () => {
    // The general property, asserted over the whole matrix rather than the
    // cases somebody thought of.
    for (const granter of SELLER_ROLE_DEFINITIONS) {
      for (const target of SELLER_ROLE_DEFINITIONS) {
        if (!canGrantSellerRole(granter.key, target.key)) continue;

        const held = permissionsForSellerRole(granter.key);
        for (const permission of target.permissions) {
          expect(held.has(permission)).toBe(true);
        }
      }
    }
  });
});

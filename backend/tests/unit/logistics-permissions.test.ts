/**
 * The logistics role matrix.
 *
 * Four claims the role definitions make in prose, asserted here so they cannot
 * drift: a driver cannot list shipments, only owners and administrators touch
 * membership, nobody grants a role above their own, and a tracking viewer
 * cannot see where a courier is.
 *
 * Plus the one that is easy to lose in a refactor: the three permission
 * catalogues are disjoint, so no route can be written that accepts a key from
 * two of them.
 */
import { describe, expect, it } from 'vitest';
import {
  ALL_LOGISTICS_PERMISSIONS,
  LOGISTICS_ROLE_DEFINITIONS,
  LogisticsPermission,
  LogisticsRole,
  canGrantLogisticsRole,
  logisticsRoleDefinition,
  logisticsRoleHas,
  logisticsRoleRequiresMfa,
  permissionsForLogisticsRole,
} from '../../src/domain/logistics-permissions.js';
import { ALL_PERMISSIONS } from '../../src/domain/permissions.js';
import { ALL_SELLER_PERMISSIONS } from '../../src/domain/seller-permissions.js';

describe('the catalogue', () => {
  it('shares no key with the marketplace or the seller catalogue', () => {
    /*
     * The single most important assertion in this file.
     *
     * If a key appeared in two catalogues, a route could be written that
     * accepted "the permission" and be satisfied by the wrong kind of caller -
     * which is exactly how a courier's dispatcher ends up passing a check
     * written for a member of staff.
     */
    const marketplace = new Set<string>(ALL_PERMISSIONS);
    const seller = new Set<string>(ALL_SELLER_PERMISSIONS);

    const overlaps = ALL_LOGISTICS_PERMISSIONS.filter(
      (key) => marketplace.has(key) || seller.has(key),
    );

    expect(overlaps).toEqual([]);
  });

  it('names every key exactly once', () => {
    expect(new Set(ALL_LOGISTICS_PERMISSIONS).size).toBe(ALL_LOGISTICS_PERMISSIONS.length);
  });

  it('has six roles and no UBOSS_LOGISTICS_ADMIN', () => {
    /*
     * The brief lists seven. The seventh is the OPERATOR's own role and lives
     * in the admin catalogue as `logistics.*` - see the header of
     * `logistics-permissions.ts`. A role added here by that name would be a
     * role a carrier could be given.
     */
    expect(LOGISTICS_ROLE_DEFINITIONS).toHaveLength(6);
    expect(logisticsRoleDefinition('UBOSS_LOGISTICS_ADMIN')).toBeUndefined();
  });

  it('grants nothing for a role it does not know', () => {
    // The safe direction to fail: a `LogisticsPartnerRole` added to the schema
    // without a grant here locks its holders out rather than letting them
    // through.
    expect(permissionsForLogisticsRole('WAREHOUSE_ROBOT').size).toBe(0);
    expect(logisticsRoleHas('WAREHOUSE_ROBOT', LogisticsPermission.SHIPMENT_READ)).toBe(false);
  });
});

describe('what each role may do', () => {
  it('gives the owner everything', () => {
    const owner = permissionsForLogisticsRole(LogisticsRole.OWNER);
    expect(owner.size).toBe(ALL_LOGISTICS_PERMISSIONS.length);
  });

  it('will not let a DRIVER list shipments', () => {
    const driver = permissionsForLogisticsRole(LogisticsRole.DRIVER);

    expect(driver.has(LogisticsPermission.SHIPMENT_READ)).toBe(false);
    expect(driver.has(LogisticsPermission.SHIPMENT_EXPORT)).toBe(false);
    expect(driver.has(LogisticsPermission.COMPANY_READ)).toBe(false);

    // What they DO hold: their own task list, and the things a person beside a
    // van actually does.
    expect(driver.has(LogisticsPermission.DRIVER_TASK_READ)).toBe(true);
    expect(driver.has(LogisticsPermission.POD_WRITE)).toBe(true);
    expect(driver.has(LogisticsPermission.TRIP_WRITE)).toBe(true);
  });

  it('keeps membership to the owner and the administrator', () => {
    const holders = LOGISTICS_ROLE_DEFINITIONS.filter((role) =>
      role.permissions.includes(LogisticsPermission.MEMBER_WRITE),
    ).map((role) => role.key);

    expect(holders.sort()).toEqual(['LOGISTICS_PARTNER_ADMIN', 'LOGISTICS_PARTNER_OWNER']);
  });

  it('lets no role change its own approved regions, capabilities or SLA', () => {
    /*
     * There is deliberately no permission for it AT ALL. A carrier that could
     * widen its own approved regions could assign itself work it is not
     * licensed to carry, and this is medical freight - so the authority lives
     * in the admin catalogue and nowhere else.
     */
    const suspicious = ALL_LOGISTICS_PERMISSIONS.filter(
      (key) => key.includes('region') || key.includes('capability') || key.includes('sla'),
    );

    expect(suspicious).toEqual([]);
  });

  it('will not show a tracking viewer where a courier is', () => {
    const viewer = permissionsForLogisticsRole(LogisticsRole.READ_ONLY_TRACKING_USER);

    expect(viewer.has(LogisticsPermission.SHIPMENT_READ)).toBe(true);
    expect(viewer.has(LogisticsPermission.TRIP_LOCATION_READ)).toBe(false);

    // And changes nothing at all.
    const writes = [...viewer].filter((key) => key.includes('.write') || key.includes('.accept'));
    expect(writes).toEqual([]);
  });

  it('gives a dispatcher the live position but not the fleet record', () => {
    const dispatcher = permissionsForLogisticsRole(LogisticsRole.DISPATCHER);

    // Routing a van around a city is the one job that genuinely needs it.
    expect(dispatcher.has(LogisticsPermission.TRIP_LOCATION_READ)).toBe(true);
    expect(dispatcher.has(LogisticsPermission.DRIVER_ASSIGN)).toBe(true);
    // Hiring is not a dispatcher's job.
    expect(dispatcher.has(LogisticsPermission.DRIVER_WRITE)).toBe(false);
    expect(dispatcher.has(LogisticsPermission.MEMBER_WRITE)).toBe(false);
  });
});

describe('second factor', () => {
  it('is required of exactly the two roles that can change who has access', () => {
    const required = LOGISTICS_ROLE_DEFINITIONS.filter((role) => role.requiresMfa).map(
      (role) => role.key,
    );

    expect(required.sort()).toEqual(['LOGISTICS_PARTNER_ADMIN', 'LOGISTICS_PARTNER_OWNER']);

    // And those are exactly the roles holding MEMBER_WRITE, which is the
    // permission that grants permissions.
    const memberWriters = LOGISTICS_ROLE_DEFINITIONS.filter((role) =>
      role.permissions.includes(LogisticsPermission.MEMBER_WRITE),
    ).map((role) => role.key);

    expect(required.sort()).toEqual(memberWriters.sort());
  });

  it('answers false for a role it does not know', () => {
    expect(logisticsRoleRequiresMfa('WAREHOUSE_ROBOT')).toBe(false);
  });
});

describe('granting roles', () => {
  it('lets an owner grant anything', () => {
    for (const role of LOGISTICS_ROLE_DEFINITIONS) {
      expect(canGrantLogisticsRole(LogisticsRole.OWNER, role.key)).toBe(true);
    }
  });

  it('will not let an administrator mint an owner', () => {
    /*
     * The escalation this function exists to stop. An ADMIN holds
     * MEMBER_WRITE, so without the permission-superset check they could invite
     * themselves a second account as OWNER and thereby grant themselves every
     * key ADMIN deliberately lacks.
     */
    expect(canGrantLogisticsRole(LogisticsRole.ADMIN, LogisticsRole.OWNER)).toBe(false);
    expect(canGrantLogisticsRole(LogisticsRole.ADMIN, LogisticsRole.DISPATCHER)).toBe(true);
  });

  it('refuses anybody without MEMBER_WRITE', () => {
    expect(canGrantLogisticsRole(LogisticsRole.DISPATCHER, LogisticsRole.DRIVER)).toBe(false);
    expect(canGrantLogisticsRole(LogisticsRole.DRIVER, LogisticsRole.DRIVER)).toBe(false);
  });

  it('refuses a role neither side knows', () => {
    expect(canGrantLogisticsRole(LogisticsRole.OWNER, 'WAREHOUSE_ROBOT')).toBe(false);
    expect(canGrantLogisticsRole('WAREHOUSE_ROBOT', LogisticsRole.DRIVER)).toBe(false);
  });
});

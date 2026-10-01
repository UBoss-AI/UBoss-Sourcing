/**
 * Least privilege for the operator's staff roles (checklist SEC-002).
 *
 * The role table is the whole of a staff member's authority: a permission not
 * granted here is refused by `requireAdmin` on every route. These tests pin
 * the separations that matter, so widening a role is a deliberate change that
 * fails here first rather than a quiet one found in an incident.
 */
import { describe, expect, it } from 'vitest';
import {
  ADMIN_ROLE_KEYS,
  ALL_PERMISSIONS,
  Permission,
  Role,
  ROLE_DEFINITIONS,
  permissionsForRoles,
  type PermissionKey,
} from '../../src/domain/permissions.js';

const MONEY: PermissionKey[] = [
  Permission.REFUND_CREATE,
  Permission.PAYMENT_LINK_CREATE,
  Permission.PAYMENT_GATEWAY_WRITE,
  Permission.FINANCE_POLICY_WRITE,
  Permission.DISPUTE_APPROVE,
  Permission.INSPECTION_RELEASE,
  Permission.COMMISSION_INVOICE_ISSUE,
];

const ADMINISTRATION: PermissionKey[] = [
  Permission.ROLE_ASSIGN,
  Permission.STAFF_WRITE,
  Permission.FEATURE_FLAG_WRITE,
  Permission.SETTINGS_WRITE,
];

function grants(role: string): Set<PermissionKey> {
  return permissionsForRoles([role]);
}

describe('staff roles', () => {
  it('lists the support and compliance roles as assignable staff roles', () => {
    expect(ADMIN_ROLE_KEYS).toContain(Role.SUPPORT_AGENT);
    expect(ADMIN_ROLE_KEYS).toContain(Role.COMPLIANCE_OFFICER);
    expect(ADMIN_ROLE_KEYS).not.toContain(Role.CUSTOMER);
  });

  it('only grants permissions that exist', () => {
    const known = new Set(ALL_PERMISSIONS);
    for (const definition of ROLE_DEFINITIONS) {
      for (const permission of definition.permissions) expect(known.has(permission)).toBe(true);
    }
  });

  it('keeps role assignment, staff changes and settings with the business owner alone', () => {
    for (const role of ADMIN_ROLE_KEYS.filter((key) => key !== Role.BUSINESS_OWNER)) {
      for (const permission of [Permission.ROLE_ASSIGN, Permission.STAFF_WRITE, Permission.FEATURE_FLAG_WRITE]) {
        expect(grants(role).has(permission), `${role} holds ${permission}`).toBe(false);
      }
    }
  });

  it('gives a customer no staff permission at all', () => {
    expect(grants(Role.CUSTOMER).size).toBe(0);
  });

  it('lets support answer customers but never move money or change an order', () => {
    const support = grants(Role.SUPPORT_AGENT);
    expect(support.has(Permission.SUPPORT_TICKET_REPLY)).toBe(true);
    expect(support.has(Permission.ORDER_READ)).toBe(true);
    for (const permission of [
      ...MONEY,
      ...ADMINISTRATION,
      Permission.ORDER_CANCEL,
      Permission.ORDER_RETURN,
      Permission.ORDER_FULFIL,
      Permission.DISPUTE_MANAGE,
      Permission.CUSTOMER_STATUS_WRITE,
      Permission.DATA_REQUEST_ACTION,
      Permission.AUDIT_READ,
      Permission.EXPORT_CREATE,
    ]) {
      expect(support.has(permission), `support holds ${permission}`).toBe(false);
    }
  });

  it('lets compliance verify and work privacy requests, but not pay, sell or administer', () => {
    const compliance = grants(Role.COMPLIANCE_OFFICER);
    for (const permission of [
      Permission.CUSTOMER_STATUS_WRITE,
      Permission.BUYER_COMPANY_REVIEW,
      Permission.DATA_REQUEST_ACTION,
      Permission.AUDIT_READ,
    ]) {
      expect(compliance.has(permission), `compliance lacks ${permission}`).toBe(true);
    }
    for (const permission of [
      ...MONEY,
      ...ADMINISTRATION,
      Permission.PRODUCT_WRITE,
      Permission.PRODUCT_PUBLISH,
      Permission.ORDER_CANCEL,
      Permission.INVOICE_ISSUE,
    ]) {
      expect(compliance.has(permission), `compliance holds ${permission}`).toBe(false);
    }
  });

  it('keeps refund approval away from the order desk and the catalogue', () => {
    for (const role of [Role.ORDER_MANAGER, Role.CATALOG_MANAGER, Role.INVENTORY_MANAGER]) {
      expect(grants(role).has(Permission.REFUND_CREATE)).toBe(false);
      expect(grants(role).has(Permission.PAYMENT_GATEWAY_WRITE)).toBe(false);
    }
  });

  it('keeps privacy requests out of every role but the owner and compliance', () => {
    for (const role of ADMIN_ROLE_KEYS) {
      const allowed = role === Role.BUSINESS_OWNER || role === Role.COMPLIANCE_OFFICER;
      expect(grants(role).has(Permission.DATA_REQUEST_ACTION), role).toBe(allowed);
    }
  });
});

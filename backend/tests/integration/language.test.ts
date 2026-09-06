/**
 * The per-account interface language - integration, against a real MariaDB.
 *
 * The three properties worth holding onto:
 *
 *   - Null and "en" are different answers. Null means the account has never
 *     chosen, which is what lets the frontend fall back to the browser's
 *     preference; writing "en" on signup would take that away from everyone.
 *   - The preference lives on `users`, so it works for staff and customers
 *     alike from one column and one service.
 *   - An unsupported code never comes back out, whatever route got it in.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ROLE_DEFINITIONS, Role } from '../../src/domain/permissions.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import {
  SUPPORTED_LANGUAGES,
  getUserLanguage,
  isSupportedLanguage,
  setUserLanguage,
} from '../../src/modules/identity/language.service.js';

let adminUserId: string;
let customerUserId: string;

async function resetDatabase(): Promise<void> {
  await prisma.auditLog.deleteMany({});
  await prisma.loginAttempt.deleteMany({});
  await prisma.session.deleteMany({});
  await prisma.authToken.deleteMany({});
  await prisma.address.deleteMany({});
  await prisma.customerProfile.deleteMany({});
  await prisma.userRole.deleteMany({});
  await prisma.user.deleteMany({});
}

async function seedRoles(): Promise<void> {
  for (const definition of ROLE_DEFINITIONS) {
    await prisma.role.upsert({
      where: { key: definition.key },
      update: {},
      create: {
        id: newId(),
        key: definition.key,
        name: definition.name,
        description: definition.description,
        isSystem: true,
      },
    });
  }
}

async function createUser(email: string, type: 'ADMIN' | 'CUSTOMER'): Promise<string> {
  const id = newId();
  const roleKey = type === 'ADMIN' ? Role.BUSINESS_OWNER : Role.CUSTOMER;
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });

  await prisma.user.create({
    data: {
      id,
      type,
      email,
      emailNormalized: email.toLowerCase(),
      passwordHash: await hashPassword('LanguageTestPass!2026'),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: role.id } },
    },
  });

  return id;
}

beforeAll(async () => {
  await resetDatabase();
  await seedRoles();
});

beforeEach(async () => {
  await resetDatabase();
  await seedRoles();

  adminUserId = await createUser('lang-admin@test.local', 'ADMIN');
  customerUserId = await createUser('lang-customer@test.local', 'CUSTOMER');
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

describe('isSupportedLanguage', () => {
  it('accepts every language the frontends ship a catalogue for', () => {
    for (const code of SUPPORTED_LANGUAGES) {
      expect(isSupportedLanguage(code)).toBe(true);
    }
  });

  it('rejects anything else', () => {
    // The value reaches `<html lang>`, so the guard is the thing standing
    // between a request body and a page attribute.
    for (const value of ['', 'xx', 'en-GB', 'EN', 'javascript:alert(1)', null, 42, {}]) {
      expect(isSupportedLanguage(value)).toBe(false);
    }
  });
});

describe('getUserLanguage', () => {
  it('is null for an account that has never chosen', async () => {
    // Not "en". The distinction is what lets the storefront fall back to the
    // browser's own preference for a buyer who has never opened the picker.
    await expect(getUserLanguage(adminUserId)).resolves.toBeNull();
  });

  it('is null for an unknown user rather than throwing', async () => {
    await expect(getUserLanguage(newId())).resolves.toBeNull();
  });

  it('reads back a language that is no longer supported as null', async () => {
    // A language withdrawn after somebody chose it. Handing the frontend a
    // code it has no catalogue for just moves the problem downstream.
    await prisma.user.update({
      where: { id: adminUserId },
      data: { preferredLanguage: 'sv' },
    });

    await expect(getUserLanguage(adminUserId)).resolves.toBeNull();
  });
});

describe('setUserLanguage', () => {
  it('saves and reads back', async () => {
    await setUserLanguage(adminUserId, 'pl');
    await expect(getUserLanguage(adminUserId)).resolves.toBe('pl');
  });

  it('overwrites a previous choice', async () => {
    await setUserLanguage(adminUserId, 'el');
    await setUserLanguage(adminUserId, 'nl');

    await expect(getUserLanguage(adminUserId)).resolves.toBe('nl');
  });

  it('keeps staff and customer preferences apart', async () => {
    // One column on `users` serves both surfaces; it must not become one
    // shared setting.
    await setUserLanguage(adminUserId, 'de');
    await setUserLanguage(customerUserId, 'es');

    await expect(getUserLanguage(adminUserId)).resolves.toBe('de');
    await expect(getUserLanguage(customerUserId)).resolves.toBe('es');
  });

  it('works for a customer with no profile row', async () => {
    // The reason the column is on `users` rather than on `customer_profiles`:
    // a staff account has no profile, and a customer part-way through
    // activation may not have one yet either.
    const profile = await prisma.customerProfile.findUnique({
      where: { userId: customerUserId },
    });
    expect(profile).toBeNull();

    await setUserLanguage(customerUserId, 'fr');
    await expect(getUserLanguage(customerUserId)).resolves.toBe('fr');
  });
});

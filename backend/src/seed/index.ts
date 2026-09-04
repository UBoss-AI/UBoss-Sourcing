/**
 * Development seed.
 *
 * Idempotent: every write is an upsert keyed on a natural key, so running it
 * repeatedly converges rather than duplicating. That matters because it is also
 * how roles and permissions get installed after a migration adds new ones.
 *
 * The credentials below are development-only and are refused outside
 * development. Never point this at production.
 */
import { env, isProduction } from '../config/env.js';
import {
  ALL_PERMISSIONS,
  ROLE_DEFINITIONS,
  Role,
  type PermissionKey,
} from '../domain/permissions.js';
import { hashPassword } from '../infra/crypto.js';
import { newId } from '../infra/ids.js';
import { seedReferenceData } from './reference-data.js';
import { prisma } from '../infra/prisma.js';

/**
 * Seed credentials. Deliberately long enough to satisfy the 12-character
 * policy, and deliberately obvious so nobody mistakes them for real ones.
 */
const SEED_ACCOUNTS = [
  { email: 'owner@uboss.local', name: 'Priya Nair', role: Role.BUSINESS_OWNER, password: 'OwnerDev!2026' },
  { email: 'catalog@uboss.local', name: 'Arun Mehta', role: Role.CATALOG_MANAGER, password: 'CatalogDev!2026' },
  { email: 'inventory@uboss.local', name: 'Sana Qureshi', role: Role.INVENTORY_MANAGER, password: 'StockDev!2026' },
  { email: 'orders@uboss.local', name: 'Ravi Menon', role: Role.ORDER_MANAGER, password: 'OrdersDev!2026' },
  { email: 'finance@uboss.local', name: 'Neha Kulkarni', role: Role.FINANCE_APPROVER, password: 'FinanceDev!2026' },
] as const;

const SEED_CUSTOMERS = [
  {
    email: 'buyer@acme.local',
    name: 'Deepak Sharma',
    organization: 'Acme Manufacturing Pvt Ltd',
    department: 'Procurement',
    password: 'BuyerDev!2026',
    // Active, so it can be signed into immediately.
    active: true,
  },
  {
    email: 'invited@zenith.local',
    name: 'Fatima Sheikh',
    organization: 'Zenith Labs',
    department: 'Operations',
    password: null,
    // Left PENDING_INVITATION on purpose: exercises the activation flow.
    active: false,
  },
] as const;

async function seedRolesAndPermissions(): Promise<void> {
  // Permissions first - roles reference them.
  for (const key of ALL_PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key },
      update: {},
      create: { id: newId(), key, description: null },
    });
  }

  const permissionRows = await prisma.permission.findMany({ select: { id: true, key: true } });
  const permissionIdByKey = new Map(permissionRows.map((row) => [row.key, row.id]));

  for (const definition of ROLE_DEFINITIONS) {
    const role = await prisma.role.upsert({
      where: { key: definition.key },
      update: { name: definition.name, description: definition.description },
      create: {
        id: newId(),
        key: definition.key,
        name: definition.name,
        description: definition.description,
        isSystem: true,
      },
    });

    // Replace grants wholesale rather than merging: a permission removed from
    // the catalogue must actually be revoked, not linger on the role.
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });

    const grants = definition.permissions
      .map((key: PermissionKey) => permissionIdByKey.get(key))
      .filter((id): id is string => id !== undefined)
      .map((permissionId) => ({ roleId: role.id, permissionId }));

    if (grants.length > 0) {
      await prisma.rolePermission.createMany({ data: grants, skipDuplicates: true });
    }
  }

  console.log(
    `  roles: ${String(ROLE_DEFINITIONS.length)}, permissions: ${String(ALL_PERMISSIONS.length)}`,
  );
}

async function seedBusinessConfiguration(): Promise<void> {
  const existing = await prisma.businessProfile.findFirst();

  if (existing === null) {
    await prisma.businessProfile.create({
      data: {
        id: newId(),
        legalName: 'UBOSS Sourcing Private Limited',
        displayName: 'UBOSS Sourcing',
        supportEmail: 'support@uboss.local',
        supportPhone: '+91 80 4000 0000',
        gstin: '29AAAAA0000A1Z5',
        addressJson: {
          line1: '1st Floor, Industrial Estate',
          city: 'Bengaluru',
          state: 'Karnataka',
          postalCode: '560001',
          country: 'IN',
        },
        currency: env.DEFAULT_CURRENCY,
        timezone: env.DEFAULT_TIMEZONE,
        invoicePrefix: 'INV',
        orderPrefix: 'UB',
      },
    });
  }

  // 18% GST, exclusive. Flagged in docs/STATUS.md as an assumption pending
  // client confirmation - change here and in the products that reference it.
  await prisma.taxClass.upsert({
    where: { code: 'GST18' },
    update: {},
    create: {
      id: newId(),
      code: 'GST18',
      name: 'GST 18%',
      ratePercent: '18.000000',
      isInclusive: false,
      isDefault: true,
      isActive: true,
    },
  });

  await prisma.taxClass.upsert({
    where: { code: 'GST5' },
    update: {},
    create: {
      id: newId(),
      code: 'GST5',
      name: 'GST 5%',
      ratePercent: '5.000000',
      isInclusive: false,
      isDefault: false,
      isActive: true,
    },
  });

  await prisma.shippingMethod.upsert({
    where: { code: 'STANDARD' },
    update: {},
    create: {
      id: newId(),
      code: 'STANDARD',
      name: 'Standard delivery',
      description: '3-5 business days',
      priceMinor: 9900n, // Rs 99.00
      freeAboveMinor: 500_000n, // Free above Rs 5,000.00
      estimatedDaysMin: 3,
      estimatedDaysMax: 5,
      isActive: true,
      sortOrder: 0,
    },
  });

  await prisma.inventoryLocation.upsert({
    where: { code: 'MAIN' },
    update: {},
    create: {
      id: newId(),
      code: 'MAIN',
      name: 'Main warehouse',
      isDefault: true,
      isActive: true,
    },
  });

  const flags: { key: string; enabled: boolean; description: string }[] = [
    {
      key: 'customer_self_registration',
      enabled: env.FEATURE_CUSTOMER_SELF_REGISTRATION,
      description: 'Allow visitors to register without an admin invitation.',
    },
    {
      key: 'stock_reservations',
      enabled: env.FEATURE_STOCK_RESERVATIONS,
      description: 'Hold stock briefly during checkout.',
    },
    {
      key: 'order_approvals',
      enabled: env.FEATURE_ORDER_APPROVALS,
      description: 'Route orders above a threshold to an approver.',
    },
    {
      key: 'recurring_orders',
      enabled: env.FEATURE_RECURRING_ORDERS,
      description: 'Allow customers to create repeat-purchase schedules.',
    },
  ];

  for (const flag of flags) {
    await prisma.featureFlag.upsert({
      where: { key: flag.key },
      update: { description: flag.description },
      create: { id: newId(), ...flag },
    });
  }

  console.log('  business profile, 2 tax classes, 1 shipping method, 1 location, 4 flags');
}

async function seedStaff(): Promise<void> {
  const roles = await prisma.role.findMany({ select: { id: true, key: true } });
  const roleIdByKey = new Map(roles.map((role) => [role.key, role.id]));

  for (const account of SEED_ACCOUNTS) {
    const emailNormalized = account.email.toLowerCase();
    const passwordHash = await hashPassword(account.password);

    const user = await prisma.user.upsert({
      where: { emailNormalized },
      update: { status: 'ACTIVE' },
      create: {
        id: newId(),
        type: 'ADMIN',
        email: account.email,
        emailNormalized,
        passwordHash,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
    });

    const roleId = roleIdByKey.get(account.role);
    if (roleId !== undefined) {
      await prisma.userRole.upsert({
        where: { userId_roleId: { userId: user.id, roleId } },
        update: {},
        create: { userId: user.id, roleId },
      });
    }
  }

  console.log(`  staff accounts: ${String(SEED_ACCOUNTS.length)}`);
}

async function seedCustomers(): Promise<void> {
  const customerRole = await prisma.role.findUnique({ where: { key: Role.CUSTOMER } });

  for (const customer of SEED_CUSTOMERS) {
    const emailNormalized = customer.email.toLowerCase();
    const passwordHash = customer.password === null ? null : await hashPassword(customer.password);

    const user = await prisma.user.upsert({
      where: { emailNormalized },
      update: {},
      create: {
        id: newId(),
        type: 'CUSTOMER',
        email: customer.email,
        emailNormalized,
        passwordHash,
        status: customer.active ? 'ACTIVE' : 'PENDING_INVITATION',
        emailVerifiedAt: customer.active ? new Date() : null,
      },
    });

    if (customerRole !== null) {
      await prisma.userRole.upsert({
        where: { userId_roleId: { userId: user.id, roleId: customerRole.id } },
        update: {},
        create: { userId: user.id, roleId: customerRole.id },
      });
    }

    const profile = await prisma.customerProfile.upsert({
      where: { userId: user.id },
      update: {},
      create: {
        id: newId(),
        userId: user.id,
        fullName: customer.name,
        organization: customer.organization,
        department: customer.department,
        phone: '+91 98000 00000',
        activatedAt: customer.active ? new Date() : null,
        consentAcceptedAt: customer.active ? new Date() : null,
        consentVersion: customer.active ? 'v1' : null,
      },
    });

    // Terms per market. INR is where this business trades; a USD set is seeded
    // too so the multi-currency path has something to exercise.
    for (const terms of [
      { currencyCode: 'INR', min: 50_000n, max: 50_000_000n }, // Rs 500 - Rs 500,000
      { currencyCode: 'USD', min: 1_000n, max: 600_000n }, // $10 - $6,000
    ]) {
      await prisma.customerLimit.upsert({
        where: {
          customerProfileId_currencyCode: {
            customerProfileId: profile.id,
            currencyCode: terms.currencyCode,
          },
        },
        update: {},
        create: {
          customerProfileId: profile.id,
          currencyCode: terms.currencyCode,
          perOrderMinMinor: terms.min,
          perOrderMaxMinor: terms.max,
        },
      });
    }

    const addressCount = await prisma.address.count({
      where: { customerProfileId: profile.id },
    });

    if (addressCount === 0) {
      await prisma.address.create({
        data: {
          id: newId(),
          customerProfileId: profile.id,
          kind: 'BOTH',
          label: 'Head office',
          contactName: customer.name,
          contactPhone: '+91 98000 00000',
          line1: 'Plot 42, Industrial Area Phase II',
          city: 'Pune',
          state: 'Maharashtra',
          postalCode: '411057',
          country: 'IN',
          isDefaultBilling: true,
          isDefaultShipping: true,
        },
      });
    }
  }

  console.log(`  customers: ${String(SEED_CUSTOMERS.length)} (1 active, 1 pending invitation)`);
}

async function main(): Promise<void> {
  if (isProduction) {
    throw new Error(
      'The seed installs known development credentials and refuses to run with NODE_ENV=production.',
    );
  }

  console.log(`Seeding ${env.NODE_ENV} database...`);

  await seedRolesAndPermissions();
  await seedBusinessConfiguration();
  // Currencies and countries are not development fixtures - the storefront
  // cannot price anything without them - but the dev seed installs them too
  // so a fresh clone comes up with a working catalogue.
  const reference = await seedReferenceData();
  console.log(
    `  reference data: ${String(reference.currencies)} currencies, ` +
      `${String(reference.countries)} countries, ` +
      `${String(reference.backfilledPrices)} prices backfilled`,
  );
  await seedStaff();
  await seedCustomers();

  console.log('\nSeed complete. Development sign-in credentials:\n');
  console.log('  Admin Panel  POST /api/v1/admin/auth/login');
  for (const account of SEED_ACCOUNTS) {
    console.log(`    ${account.email.padEnd(24)} ${account.password.padEnd(18)} (${account.role})`);
  }
  console.log('\n  Customer Website  POST /api/v1/auth/login');
  for (const customer of SEED_CUSTOMERS) {
    console.log(
      `    ${customer.email.padEnd(24)} ${(customer.password ?? '(invitation pending)').padEnd(18)}`,
    );
  }
  console.log('\nThese are development credentials. Never use them anywhere real.\n');
}

main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });

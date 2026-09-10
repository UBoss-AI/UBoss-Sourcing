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

  // The default warehouse, and deliberately the plain one: it carries no
  // country, no coordinates and no ERP mapping, which is exactly the state
  // every warehouse in an installation that predates those columns is in. The
  // Warehouses screen has to keep working for it, so the seed keeps one.
  //
  // The four real ones are in `seedWarehouses`, which runs after the country
  // reference data it has a foreign key into.
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

/**
 * The warehouses.
 *
 * Development fixtures, like every other account and address in this file, and
 * they are here rather than in a migration for the reason the whole product is
 * built on: **this software is bought and run by other companies, so where the
 * warehouses are is never a fact the repository gets to assert.** A real
 * deployment creates its own on the Warehouses screen, or loads them through
 * the API. What these four buy is a fresh clone that comes up with a map worth
 * looking at instead of one empty rectangle.
 *
 * The statuses are varied on purpose, the same way `invited@zenith.local` is
 * left waiting on an invitation: between them the four cover every operational
 * badge, every ERP sync state that can be reached, a warehouse that is not
 * mapped to the ERP at all, and one that is retired - so the filters and the
 * marker colours can be seen working without anybody having to set them up
 * first.
 *
 * Runs after `seedReferenceData`, and has to: `countryCode` is a foreign key
 * into `countries`, and the four member states below only exist once the
 * reference data has been installed.
 */
interface WarehouseSeed {
  code: string;
  name: string;
  countryCode: string;
  timezone: string;
  latitude: string;
  longitude: string;
  address: { line1: string; city: string; postalCode: string };
  operationalStatus: 'OPERATIONAL' | 'LIMITED' | 'MAINTENANCE' | 'SUSPENDED';
  erpExternalId: string | null;
  erpSyncStatus: 'NEVER_SYNCED' | 'SYNCED' | 'PENDING' | 'FAILED';
  /** Hours before now, so a re-seed always produces a recent-looking time. */
  erpSyncedHoursAgo: number | null;
  erpSyncMessage: string | null;
  isActive?: boolean;
}

const SEED_WAREHOUSES: readonly WarehouseSeed[] = [
  {
    code: 'BE-ANR',
    name: 'Antwerp distribution centre',
    countryCode: 'BE',
    timezone: 'Europe/Brussels',
    latitude: '51.219400',
    longitude: '4.402500',
    address: { line1: 'Noorderlaan 127', city: 'Antwerpen', postalCode: '2030' },
    operationalStatus: 'OPERATIONAL',
    erpExternalId: 'WH-ANR-01',
    erpSyncStatus: 'SYNCED',
    erpSyncedHoursAgo: 2,
    erpSyncMessage: '1,284 SKUs reconciled.',
  },
  {
    // This fixture used to be in Barcelona. Renaming its *code* is something
    // only a fixture may do - a real warehouse keeps its code forever, because
    // it is stamped on every movement ever booked against the place - so the
    // superseded code is listed in `SUPERSEDED_WAREHOUSE_CODES` below and
    // cleaned up, rather than left behind as a second Spanish warehouse in
    // every database the old seed had touched.
    code: 'ES-MAD',
    name: 'Madrid central warehouse',
    countryCode: 'ES',
    timezone: 'Europe/Madrid',
    // Villaverde, the industrial belt in the south of the city. Deliberately
    // inland: it is the fixture that shows the delivery-coverage panel's empty
    // answer, because no foreign border is anywhere near 100 km of it.
    latitude: '40.345000',
    longitude: '-3.690000',
    address: { line1: 'Calle Eduardo Barreiros 110', city: 'Madrid', postalCode: '28041' },
    operationalStatus: 'OPERATIONAL',
    erpExternalId: 'WH-MAD-01',
    erpSyncStatus: 'SYNCED',
    erpSyncedHoursAgo: 5,
    erpSyncMessage: '903 SKUs reconciled.',
  },
  {
    code: 'GR-ATH',
    name: 'Athens west hub',
    countryCode: 'GR',
    timezone: 'Europe/Athens',
    latitude: '38.064000',
    longitude: '23.596000',
    address: { line1: 'Leoforos NATO 22', city: 'Aspropyrgos', postalCode: '19300' },
    // Running, but not at full capacity - which is precisely the state
    // `isActive` could never express on its own.
    operationalStatus: 'LIMITED',
    erpExternalId: 'WH-ATH-01',
    erpSyncStatus: 'PENDING',
    // PENDING carries no completion time of its own: the last *finished* sync
    // is still whenever it was, which is what `recordErpSync` enforces.
    erpSyncedHoursAgo: 26,
    erpSyncMessage: 'Reconciliation queued behind a stock count.',
  },
  {
    code: 'PL-GDN',
    name: 'Gdańsk port warehouse',
    countryCode: 'PL',
    timezone: 'Europe/Warsaw',
    latitude: '54.352000',
    longitude: '18.646600',
    address: { line1: 'ul. Kontenerowa 7', city: 'Gdańsk', postalCode: '80-601' },
    operationalStatus: 'MAINTENANCE',
    erpExternalId: 'WH-GDN-01',
    erpSyncStatus: 'FAILED',
    erpSyncedHoursAgo: 73,
    erpSyncMessage: 'ERP rejected 4 SKUs: unit of measure mismatch.',
  },
];

/**
 * Warehouse codes this seed used to install and does not any more.
 *
 * The seed upserts on `code`, which is what makes re-running it converge - but
 * only for codes still in the list. A fixture that is renamed leaves its old
 * row behind for ever, and a developer who has been on the project a while
 * ends up with a database holding both halves of every rename anybody ever
 * did. So a retired code is written down here and removed on the next seed.
 *
 * **Only ever fixtures, and never at the cost of real data.** `removeSuperseded`
 * below refuses to delete a warehouse that anything points at or that holds
 * the default flag, and says so rather than failing: a developer who booked
 * stock against this warehouse while testing has data worth more than the
 * tidiness of the fixture list.
 */
const SUPERSEDED_WAREHOUSE_CODES: readonly string[] = [
  // Renamed to ES-MAD when the Spanish fixture moved from Barcelona to Madrid.
  'ES-BCN',
];

/**
 * Take out the warehouses the fixture list has stopped installing.
 *
 * The four tables that point at a warehouse all do so with
 * `onDelete: Restrict`, so this counts before it deletes - a blind delete
 * would throw a foreign-key error and take the whole seed down with it. Where
 * something does point at the row it is retired instead, which is exactly what
 * the panel offers a person in the same situation.
 */
async function removeSuperseded(): Promise<void> {
  for (const code of SUPERSEDED_WAREHOUSE_CODES) {
    const row = await prisma.inventoryLocation.findUnique({
      where: { code },
      select: { id: true, code: true, name: true, isDefault: true, isActive: true },
    });

    if (row === null) continue;

    // The default is left alone whatever else is true of it: a deployment with
    // no default warehouse cannot book a receipt at all, because
    // `defaultLocationId` in inventory.service.ts would find nothing.
    if (row.isDefault) {
      console.log(
        `  kept ${row.code}: it holds the default flag. Promote another warehouse, then re-run the seed.`,
      );
      continue;
    }

    const [balances, movements, reservations, schedules] = await Promise.all([
      prisma.inventoryBalance.count({ where: { locationId: row.id } }),
      prisma.inventoryMovement.count({ where: { locationId: row.id } }),
      prisma.stockReservation.count({ where: { locationId: row.id } }),
      prisma.recurringSchedule.count({ where: { inventoryLocationId: row.id } }),
    ]);

    const references = balances + movements + reservations + schedules;

    if (references > 0) {
      if (row.isActive) {
        await prisma.inventoryLocation.update({
          where: { id: row.id },
          data: { isActive: false },
        });
      }

      console.log(
        `  retired ${row.code}: ${String(references)} record(s) point at it, so the row has to stay.`,
      );
      continue;
    }

    await prisma.inventoryLocation.delete({ where: { id: row.id } });
    console.log(`  removed ${row.code}: superseded fixture, nothing referenced it.`);
  }
}

async function seedWarehouses(): Promise<number> {
  await removeSuperseded();

  for (const warehouse of SEED_WAREHOUSES) {
    const erpLastSyncAt =
      warehouse.erpSyncedHoursAgo === null
        ? null
        : new Date(Date.now() - warehouse.erpSyncedHoursAgo * 60 * 60 * 1000);

    const shared = {
      name: warehouse.name,
      countryCode: warehouse.countryCode,
      timezone: warehouse.timezone,
      latitude: warehouse.latitude,
      longitude: warehouse.longitude,
      addressJson: warehouse.address,
      operationalStatus: warehouse.operationalStatus,
      erpExternalId: warehouse.erpExternalId,
      erpSyncStatus: warehouse.erpSyncStatus,
      erpLastSyncAt,
      erpSyncMessage: warehouse.erpSyncMessage,
      isActive: warehouse.isActive ?? true,
    };

    await prisma.inventoryLocation.upsert({
      where: { code: warehouse.code },
      // Updated as well as created, so re-running the seed refreshes the sync
      // times rather than leaving a fixture that says "last synced in March".
      // `isDefault` is never touched here - whichever warehouse the deployment
      // has promoted stays promoted.
      update: shared,
      create: { id: newId(), code: warehouse.code, isDefault: false, ...shared },
    });
  }

  return SEED_WAREHOUSES.length;
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
  // After the reference data, not before: `inventory_locations.countryCode` is
  // a foreign key into `countries`, and the four member states these sit in
  // only exist once that has run.
  const warehouses = await seedWarehouses();
  console.log(`  warehouses: ${String(warehouses)} seeded (plus the default)`);
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

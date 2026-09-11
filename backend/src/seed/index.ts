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

  /**
   * The geofence, in kilometres. Null leaves this warehouse on the
   * deployment's `DELIVERY_COVERAGE_RADIUS_KM`.
   *
   * The fixtures deliberately do not all carry one: a warehouse running on the
   * deployment default is the ordinary case for an installation that has never
   * opened the delivery panel, and the screen says something different about
   * it, so the seed has to produce one.
   */
  deliveryRadiusKm: number | null;
  /** Days, as a window. Both or neither. */
  deliveryLeadTimeDays: { min: number; max: number } | null;
  /** Minor units and the currency they are in. Zero is a real fee - free. */
  deliveryFee: { minor: bigint; currency: string } | null;
  /**
   * Countries this warehouse will not deliver to, with the reason.
   *
   * Real reasons rather than lorem: the whole point of the field is that the
   * person reading the row in a year is not the person who wrote it, and a
   * fixture full of "test" teaches nobody what the field is for.
   */
  exclusions: readonly { countryCode: string; reason: string }[];

  /**
   * The lanes - which is what actually decides whether checkout offers this
   * warehouse.
   *
   * The radius above is geometry and drives the admin map; these are the
   * business arrangement, and the fixture list carries both precisely so the
   * difference is visible in a running database. Antwerp reaches the United
   * Kingdom on the map and has no lane there, which is what a closed country
   * looks like from the buyer's side.
   *
   * One warehouse is left with an empty list on purpose: a building that
   * holds stock and is offered to nobody is a real state, it is the state
   * every warehouse is in before somebody configures it, and the panel has to
   * be able to say so.
   */
  zones: readonly {
    countryCode: string;
    /** Comma-separated prefixes, or '' for the whole country. */
    postalPrefixes?: string;
    carrierName: string;
    serviceLevel: string;
    handlingDays: number;
    transitMinDays: number;
    transitMaxDays: number;
    usesBusinessDays?: boolean;
    feeMinor: bigint;
    feeCurrency: string;
    freeAboveMinor?: bigint | null;
    supportsColdChain?: boolean;
    priority?: number;
  }[];
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
    // 500 km from Antwerp is the fixture that makes the coverage panel worth
    // opening: it reaches the Netherlands, Germany, Luxembourg, France, and
    // the United Kingdom across the Channel.
    deliveryRadiusKm: 500,
    deliveryLeadTimeDays: { min: 2, max: 4 },
    deliveryFee: { minor: 1200n, currency: 'EUR' },
    exclusions: [
      // Reached comfortably inside 500 km and closed anyway, which is the
      // whole reason exclusions exist: geometry cannot know about paperwork.
      {
        countryCode: 'GB',
        reason: 'Post-Brexit customs broker not appointed yet - route via the Rotterdam agent.',
      },
    ],
    // Two service levels into Belgium is the arrangement the feature exists
    // for: the same box, two days apart, for the price of a coffee. It is
    // what makes the Fastest and Lowest Price badges mean two different
    // cards rather than decorating one.
    zones: [
      {
        countryCode: 'BE',
        carrierName: 'DPD',
        serviceLevel: 'Classic',
        handlingDays: 1,
        transitMinDays: 1,
        transitMaxDays: 2,
        feeMinor: 590n,
        feeCurrency: 'EUR',
        freeAboveMinor: 15_000n,
        priority: 0,
      },
      {
        countryCode: 'BE',
        carrierName: 'DPD',
        serviceLevel: 'Express',
        handlingDays: 0,
        transitMinDays: 1,
        transitMaxDays: 1,
        feeMinor: 1490n,
        feeCurrency: 'EUR',
        // The refrigerated lane. Paired with `requiresColdChain` on the
        // reagent fixtures, so a basket containing one is offered this and
        // not the Classic beside it.
        supportsColdChain: true,
        priority: 1,
      },
      {
        countryCode: 'NL',
        carrierName: 'PostNL',
        serviceLevel: 'Standard',
        handlingDays: 1,
        transitMinDays: 2,
        transitMaxDays: 3,
        feeMinor: 890n,
        feeCurrency: 'EUR',
        freeAboveMinor: 25_000n,
      },
      {
        // Postcode-scoped on purpose: Antwerp serves the Rhine-Ruhr belt and
        // nothing further into Germany. It is the fixture that shows a lane
        // narrower than a country, which is the case a country-level model
        // cannot express at all.
        countryCode: 'DE',
        postalPrefixes: '40,41,42,44,45,46,47,48',
        carrierName: 'DHL',
        serviceLevel: 'Paket',
        handlingDays: 1,
        transitMinDays: 2,
        transitMaxDays: 4,
        feeMinor: 1290n,
        feeCurrency: 'EUR',
      },
    ],
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
    // 800 km out of central Spain: Portugal, France, Andorra, and Morocco and
    // Algeria across the Mediterranean. The two African reaches are what make
    // this the fixture worth reading - a radius drawn on geography alone will
    // happily promise a continent nobody has customs cover for.
    deliveryRadiusKm: 800,
    deliveryLeadTimeDays: { min: 3, max: 6 },
    deliveryFee: { minor: 995n, currency: 'EUR' },
    exclusions: [
      { countryCode: 'MA', reason: 'No customs agent appointed for Morocco.' },
      { countryCode: 'DZ', reason: 'No customs agent appointed for Algeria.' },
    ],
    zones: [
      {
        countryCode: 'ES',
        carrierName: 'Correos Express',
        serviceLevel: 'Peninsular',
        handlingDays: 1,
        transitMinDays: 1,
        transitMaxDays: 3,
        feeMinor: 690n,
        feeCurrency: 'EUR',
        freeAboveMinor: 12_000n,
      },
      {
        // Madrid also reaches Belgium, slower and cheaper than Antwerp does.
        // That overlap is the point of the fixture: a Belgian buyer sees two
        // warehouses with genuinely different offers and has a choice worth
        // making.
        countryCode: 'BE',
        carrierName: 'SEUR',
        serviceLevel: 'International Road',
        handlingDays: 2,
        transitMinDays: 4,
        transitMaxDays: 6,
        feeMinor: 0n,
        feeCurrency: 'EUR',
      },
      {
        countryCode: 'PT',
        carrierName: 'CTT Expresso',
        serviceLevel: 'Standard',
        handlingDays: 1,
        transitMinDays: 2,
        transitMaxDays: 4,
        feeMinor: 950n,
        feeCurrency: 'EUR',
      },
    ],
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
    deliveryRadiusKm: 600,
    deliveryLeadTimeDays: { min: 4, max: 8 },
    deliveryFee: { minor: 1500n, currency: 'EUR' },
    exclusions: [
      {
        countryCode: 'TR',
        reason: 'Distributor holds exclusivity in Türkiye until the 2027 renewal.',
      },
    ],
    zones: [
      {
        countryCode: 'GR',
        carrierName: 'ACS',
        serviceLevel: 'Standard',
        handlingDays: 2,
        transitMinDays: 2,
        transitMaxDays: 5,
        feeMinor: 750n,
        feeCurrency: 'EUR',
        freeAboveMinor: 20_000n,
      },
      {
        // Calendar days rather than working days, which is the other fixture
        // worth having: a ferry does not observe a weekend, and a lane that
        // counted working days would quote four days for a crossing that
        // takes two.
        countryCode: 'CY',
        carrierName: 'ACS',
        serviceLevel: 'Island Freight',
        handlingDays: 2,
        transitMinDays: 4,
        transitMaxDays: 8,
        usesBusinessDays: false,
        feeMinor: 2400n,
        feeCurrency: 'EUR',
      },
    ],
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
    // No radius of its own, on purpose. This is the fixture that shows what a
    // warehouse nobody has configured looks like: the panel says the
    // deployment's default applies rather than showing a promise somebody
    // made. It is also under MAINTENANCE, so the storefront never offers it -
    // which is the pair of states worth having in a fixture list.
    deliveryRadiusKm: null,
    deliveryLeadTimeDays: null,
    deliveryFee: null,
    exclusions: [
      { countryCode: 'BY', reason: 'Sanctions screening - no shipments until further notice.' },
      { countryCode: 'RU', reason: 'Sanctions screening - no shipments until further notice.' },
    ],
    // No lanes, deliberately, and it is the same fixture decision as the null
    // radius above. This is what a warehouse nobody has configured looks
    // like: it holds stock, it appears on every map, and checkout offers it
    // to nobody - because nobody has said what a delivery from here would
    // cost or when it would arrive, and this software does not invent either.
    zones: [],
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
      deliveryRadiusKm: warehouse.deliveryRadiusKm,
      deliveryLeadTimeMinDays: warehouse.deliveryLeadTimeDays?.min ?? null,
      deliveryLeadTimeMaxDays: warehouse.deliveryLeadTimeDays?.max ?? null,
      deliveryFeeMinor: warehouse.deliveryFee?.minor ?? null,
      deliveryFeeCurrency: warehouse.deliveryFee?.currency ?? null,
    };

    const row = await prisma.inventoryLocation.upsert({
      where: { code: warehouse.code },
      // Updated as well as created, so re-running the seed refreshes the sync
      // times rather than leaving a fixture that says "last synced in March".
      // `isDefault` is never touched here - whichever warehouse the deployment
      // has promoted stays promoted.
      update: shared,
      create: { id: newId(), code: warehouse.code, isDefault: false, ...shared },
      select: { id: true },
    });

    /**
     * The closed countries, replaced outright.
     *
     * Delete-and-insert rather than upsert, for the same reason the service
     * does it that way: the fixture states the whole set, and a country taken
     * out of this list must actually come off the warehouse on the next seed
     * rather than linger because nothing deleted it.
     *
     * This is the one place the seed overwrites a decision a developer may
     * have made in the panel. It is the right trade for a fixture list whose
     * whole purpose is to demonstrate the feature, and it is why the reasons
     * above read like real ones - a developer who wants their own exclusions
     * on a fixture warehouse will see them replaced and know why.
     */
    await prisma.warehouseCountryExclusion.deleteMany({ where: { locationId: row.id } });

    if (warehouse.exclusions.length > 0) {
      await prisma.warehouseCountryExclusion.createMany({
        data: warehouse.exclusions.map((entry) => ({
          id: newId(),
          locationId: row.id,
          countryCode: entry.countryCode,
          reason: entry.reason,
        })),
      });
    }

    /**
     * The lanes, replaced outright, for the same reason the exclusions are.
     *
     * The fixture states the whole set, so a lane taken out of this list has
     * to actually come off the warehouse on the next seed rather than linger
     * because nothing deleted it. It is the second place the seed overwrites
     * a decision a developer may have made in the panel, and the same trade:
     * a fixture list whose purpose is to demonstrate the feature has to be
     * able to converge.
     *
     * Delete-then-insert also means the rows get new ids on every seed. That
     * is harmless - a quote holds `zoneId` as SET NULL and keeps its own
     * frozen copy of the fee and the dates - and the sweep clears the
     * orphaned offers on the next maintenance beat.
     */
    await prisma.warehouseDeliveryZone.deleteMany({ where: { locationId: row.id } });

    if (warehouse.zones.length > 0) {
      await prisma.warehouseDeliveryZone.createMany({
        data: warehouse.zones.map((zone) => ({
          id: newId(),
          locationId: row.id,
          countryCode: zone.countryCode,
          postalPrefixes: zone.postalPrefixes ?? '',
          carrierName: zone.carrierName,
          serviceLevel: zone.serviceLevel,
          handlingDays: zone.handlingDays,
          transitMinDays: zone.transitMinDays,
          transitMaxDays: zone.transitMaxDays,
          usesBusinessDays: zone.usesBusinessDays ?? true,
          shippingFeeMinor: zone.feeMinor,
          shippingFeeCurrency: zone.feeCurrency,
          freeAboveMinor: zone.freeAboveMinor ?? null,
          supportsColdChain: zone.supportsColdChain ?? false,
          priority: zone.priority ?? 0,
        })),
      });
    }
  }

  return SEED_WAREHOUSES.length;
}

/**
 * How much of each SKU a warehouse holds, in the fixture.
 *
 * Deterministic from the ids rather than random, and that is the whole point:
 * a developer who reports "Antwerp shows 240 of the 5L drum" is describing
 * something the next person can reproduce, and a screenshot taken today still
 * matches the database next week. `Math.random()` in a seed makes every bug
 * report unrepeatable.
 *
 * The spread is deliberate rather than uniform:
 *
 *   - Most combinations land somewhere between a dozen and a few hundred, so
 *     the valuation column and the unit totals read like a real building.
 *   - Roughly one in nine lands on **zero**, which is the state the screens
 *     most need to be able to show. It is what makes "Athens is out of it,
 *     Antwerp has it" appear on the storefront's delivery options, and it is
 *     the only way the third geofencing rule - only the warehouse that
 *     actually holds the item may offer it - is visible at all without
 *     somebody editing stock by hand first.
 *   - Roughly one in eleven lands *just* at or below a typical reorder
 *     threshold, so the low-stock badges and the low-stock filter have
 *     something to find.
 *
 * The hash is FNV-1a over the two ids. Not for any cryptographic reason - it
 * is here because ULIDs share a long time-ordered prefix, so anything that
 * looked at the first characters would give every SKU in a warehouse nearly
 * the same number.
 */
function fixtureQuantity(locationId: string, skuKey: string): number {
  let hash = 0x811c9dc5;

  for (const character of `${locationId}:${skuKey}`) {
    hash ^= character.charCodeAt(0);
    // FNV prime, in 32-bit arithmetic. `>>> 0` keeps it unsigned after the
    // multiply, which in JavaScript would otherwise go through a float.
    hash = (hash * 0x01000193) >>> 0;
  }

  const bucket = hash % 99;

  // Out of stock here. See the note above on why this case has to exist.
  if (bucket < 11) return 0;
  // Low, but not empty - between 1 and 9, which is at or under the reorder
  // threshold the catalogue fixtures use.
  if (bucket < 20) return 1 + (hash % 9);

  return 12 + (hash % 469);
}

/**
 * Put every product in every warehouse.
 *
 * The fixture behind "click a warehouse and see its inventory". The screen
 * itself is driven from the catalogue, so a product with no balance row still
 * appears - but a list of five hundred zeroes demonstrates nothing, and until
 * this ran `inventory_balances` was empty in every fresh clone.
 *
 * **Idempotent by leaving alone, not by overwriting.** A SKU that already has
 * a balance row at a warehouse is skipped entirely: a developer who received
 * 400 units while testing has data worth more than this fixture's opinion, and
 * a seed that reset it would be a seed nobody dares re-run. Only the missing
 * rows are created.
 *
 * **The ledger is written too.** Every balance this creates gets the RECEIPT
 * movement that explains it, because a balance with no movement behind it is
 * precisely the inconsistency the whole append-only design exists to prevent -
 * and the Movements screen showing stock that arrived from nowhere would teach
 * a developer that the ledger is optional. The movement carries a `dedupeKey`,
 * so two seeds racing each other collide on the unique index rather than
 * booking the stock twice.
 *
 * Written directly rather than through `receiveStock` deliberately. That
 * function is one transaction with a `SELECT ... FOR UPDATE` per SKU, which is
 * exactly right for a person receiving a delivery and about a thousand
 * transactions here. This is a fixture writing rows nothing else is touching
 * yet, in two `createMany` calls.
 */
async function seedWarehouseStock(): Promise<{
  tracked: number;
  skus: number;
  created: number;
  units: number;
}> {
  /**
   * Turn stock tracking on, for the products that have never had it.
   *
   * This is the one thing in the seed that edits the catalogue, and it is here
   * because without it the rest of this function has nothing to do. A product
   * with `isStockTracked = false` holds no quantity anywhere by definition -
   * `receiveStock` refuses it, `inventory_balances` has no row for it, and a
   * warehouse's inventory screen can only ever show it as "not tracked". A
   * catalogue of medical consumables imported with the flag off is a catalogue
   * where every warehouse is empty and nothing in the panel explains why.
   *
   * Narrow on purpose:
   *
   *   - Only unarchived products. An archived one is out of the catalogue and
   *     turning tracking on for it would put it back in every stock report.
   *   - Only products that are **not already tracked**, so a product somebody
   *     deliberately switched tracking off for stays off... which is a real
   *     limitation: this cannot tell "never configured" from "switched off on
   *     purpose", because nothing in the schema records the difference. In a
   *     development fixture that is the right trade; it is also why this runs
   *     only in the dev seed, which refuses `NODE_ENV=production` outright.
   *   - `reorderThreshold` is only set where it is still zero, because zero
   *     means "nobody set one" and a threshold somebody chose is a decision.
   *
   * A real deployment turns tracking on per product in the panel. This is the
   * fixture equivalent, and it says how many it changed.
   */
  const tracked = await prisma.product.updateMany({
    where: { archivedAt: null, isStockTracked: false },
    // 10 units is a threshold that actually fires against the quantities
    // `fixtureQuantity` produces - its "low" bucket lands between 1 and 9 - so
    // the low-stock badge, the low-stock filter and the low-stock alert job
    // all have something to act on in a fresh clone.
    data: { isStockTracked: true, reorderThreshold: 10 },
  });

  await prisma.product.updateMany({
    where: { archivedAt: null, isStockTracked: true, reorderThreshold: 0 },
    data: { reorderThreshold: 10 },
  });

  const [warehouses, products] = await Promise.all([
    prisma.inventoryLocation.findMany({
      where: { isActive: true },
      select: { id: true, code: true },
      orderBy: { code: 'asc' },
    }),
    prisma.product.findMany({
      where: { archivedAt: null, isStockTracked: true },
      select: {
        id: true,
        variants: { where: { archivedAt: null }, select: { id: true } },
      },
      orderBy: { sku: 'asc' },
    }),
  ]);

  // One entry per stock-keeping unit: a variant, or the product itself where
  // it has none. `variantKey` is '' for the latter - the same convention the
  // unique index uses, and never null, because MariaDB treats every NULL in a
  // unique index as distinct.
  interface SkuKey {
    productId: string;
    variantId: string | null;
    variantKey: string;
  }

  const skus = products.flatMap((product): SkuKey[] =>
    product.variants.length === 0
      ? [{ productId: product.id, variantId: null, variantKey: '' }]
      : product.variants.map((variant) => ({
          productId: product.id,
          variantId: variant.id,
          variantKey: variant.id,
        })),
  );

  const existing = await prisma.inventoryBalance.findMany({
    where: { locationId: { in: warehouses.map((warehouse) => warehouse.id) } },
    select: { locationId: true, productId: true, variantKey: true },
  });

  const held = new Set(
    existing.map((row) => `${row.locationId}:${row.productId}:${row.variantKey}`),
  );

  const balances: {
    id: string;
    productId: string;
    variantId: string | null;
    variantKey: string;
    locationId: string;
    onHandQty: number;
  }[] = [];

  const movements: {
    id: string;
    productId: string;
    variantId: string | null;
    variantKey: string;
    locationId: string;
    type: 'RECEIPT';
    quantityDelta: number;
    resultingOnHand: number;
    reason: string;
    dedupeKey: string;
  }[] = [];

  let units = 0;

  for (const warehouse of warehouses) {
    for (const sku of skus) {
      if (held.has(`${warehouse.id}:${sku.productId}:${sku.variantKey}`)) continue;

      const quantity = fixtureQuantity(warehouse.id, `${sku.productId}:${sku.variantKey}`);

      balances.push({
        id: newId(),
        productId: sku.productId,
        variantId: sku.variantId,
        variantKey: sku.variantKey,
        locationId: warehouse.id,
        onHandQty: quantity,
      });

      units += quantity;

      // A zero-quantity row gets no movement, because nothing arrived. The
      // row itself is the statement "this warehouse stocks this item", and
      // `resultingOnHand` of zero with a delta of zero would be a ledger entry
      // recording that nothing happened - which the column's own contract
      // ("never zero") forbids.
      if (quantity === 0) continue;

      movements.push({
        id: newId(),
        productId: sku.productId,
        variantId: sku.variantId,
        variantKey: sku.variantKey,
        locationId: warehouse.id,
        type: 'RECEIPT',
        quantityDelta: quantity,
        resultingOnHand: quantity,
        reason: `Opening stock installed by the development seed at ${warehouse.code}.`,
        dedupeKey: `seed:stock:${warehouse.id}:${sku.productId}:${sku.variantKey}`,
      });
    }
  }

  // Chunked, because MariaDB's max_allowed_packet is the limit a single
  // thousand-row INSERT runs into first and the failure it gives is not one
  // anybody enjoys reading. 500 rows is comfortably inside the default 1 MB
  // for rows this narrow.
  const CHUNK = 500;

  for (let index = 0; index < balances.length; index += CHUNK) {
    await prisma.inventoryBalance.createMany({ data: balances.slice(index, index + CHUNK) });
  }

  for (let index = 0; index < movements.length; index += CHUNK) {
    await prisma.inventoryMovement.createMany({ data: movements.slice(index, index + CHUNK) });
  }

  return { tracked: tracked.count, skus: skus.length, created: balances.length, units };
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
  // After the warehouses, and after whatever installed the catalogue: this
  // needs both sides of every balance row it writes to exist.
  const stock = await seedWarehouseStock();
  console.log(
    `  warehouse stock: ${String(stock.created)} balance rows created ` +
      `across ${String(stock.skus)} SKUs, ${String(stock.units)} units ` +
      `(rows that already existed were left alone)`,
  );
  if (stock.tracked > 0) {
    console.log(
      `    stock tracking switched on for ${String(stock.tracked)} product(s) that had it off - ` +
        `a product that is not tracked holds no quantity in any warehouse`,
    );
  }
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

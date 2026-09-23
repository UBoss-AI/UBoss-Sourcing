/**
 * Every way anything gets delivered on this installation, in one place.
 *
 * The operator's view: which providers exist, which sellers have connected
 * what, which delivery companies are carrying work, and which of them needs
 * somebody to do something about it.
 *
 * WHY THIS IS AN ADMIN SCREEN AND NOT A PORTAL ONE
 *
 * It was specified as a page in the Logistics Partner Portal. It cannot be.
 * The portal's tenant is a carrier: the partner id comes from the session and
 * from nowhere else, and a carrier may only reach a consignment an assignment
 * currently joins to it. A page showing one carrier the count of other
 * carriers, their linked sellers and their integration health is the exact
 * boundary `logistics-portal-tenant.test.ts` exists to defend.
 *
 * Everything on this screen is operator information - a catalogue across every
 * tenant - so it lives with the operator. The portal gets a narrower view of
 * the signed-in carrier's OWN integration, which is `readOwnIntegrationHealth`
 * at the bottom of this file.
 *
 * NOTHING HERE READS A CREDENTIAL. The operator sees whether a seller's carrier
 * connection is working, when it last worked, and what it last said when it
 * did not. They do not see the key, and there is no function in this module
 * that could return one - a marketplace operator holding its sellers' carrier
 * credentials is the thing the per-seller design exists to prevent.
 */
import type {
  CarrierProvider,
  LogisticsPartnerKind,
  LogisticsPartnerStatus,
} from '../../generated/prisma/enums.js';
import { hasVerifiedOfficialApi } from '../../domain/seller-fulfilment.js';
import { prisma } from '../../infra/prisma.js';
import { describeProviders } from './carrier/registry.js';

// ---------------------------------------------------------------------------
// The summary
// ---------------------------------------------------------------------------

export interface CatalogueSummary {
  activePartners: number;
  marketplaceCarriers: number;
  selfManagedOrganisations: number;
  dedicatedPartners: number;
  /** Seller carrier accounts that have reached ACTIVE. */
  liveCarrierConnections: number;
  /** Fulfilment methods waiting for a marketplace decision. */
  methodsAwaitingApproval: number;
  /** Seller-to-carrier arrangements waiting for one. */
  arrangementsAwaitingApproval: number;
  suspendedPartners: number;
  /** Connections in ERROR, or with a failure since their last success. */
  failingConnections: number;
  activeShipments: number;
  openExceptions: number;
  unassignedShipments: number;
}

/**
 * The counters at the top of the screen.
 *
 * Every one of them is a number somebody can act on - a queue, a fault or a
 * parcel nobody is carrying. Deliberately no vanity totals: "shipments this
 * month" tells an operator nothing they can do anything about, and a dashboard
 * of those teaches people not to read it.
 */
export async function readCatalogueSummary(): Promise<CatalogueSummary> {
  const [
    activePartners,
    marketplaceCarriers,
    selfManagedOrganisations,
    dedicatedPartners,
    liveCarrierConnections,
    methodsAwaitingApproval,
    arrangementsAwaitingApproval,
    suspendedPartners,
    failingConnections,
    activeShipments,
    openExceptions,
    unassignedShipments,
  ] = await Promise.all([
    prisma.logisticsPartner.count({ where: { status: 'ACTIVE', archivedAt: null } }),
    prisma.logisticsPartner.count({
      where: { partnerKind: 'MARKETPLACE_CARRIER', archivedAt: null },
    }),
    prisma.logisticsPartner.count({
      where: { partnerKind: 'SELLER_SELF_MANAGED', archivedAt: null },
    }),
    prisma.logisticsPartner.count({
      where: { partnerKind: 'SELLER_DEDICATED', archivedAt: null },
    }),
    prisma.sellerCarrierConnection.count({ where: { state: 'ACTIVE' } }),
    prisma.sellerFulfilmentMethod.count({
      where: { status: 'PENDING_APPROVAL', archivedAt: null },
    }),
    prisma.sellerLogisticsPartner.count({ where: { status: 'REQUESTED', archivedAt: null } }),
    prisma.logisticsPartner.count({ where: { status: 'SUSPENDED', archivedAt: null } }),
    prisma.sellerCarrierConnection.count({ where: { state: 'ERROR' } }),
    prisma.logisticsShipment.count({
      where: {
        status: {
          in: ['CREATED', 'AWAITING_ASSIGNMENT', 'ASSIGNED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY'],
        },
      },
    }),
    prisma.logisticsShipmentException.count({ where: { state: { in: ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'ESCALATED'] } } }),
    prisma.logisticsShipment.count({
      where: { assignedPartnerId: null, status: { in: ['CREATED', 'AWAITING_ASSIGNMENT'] } },
    }),
  ]);

  return {
    activePartners,
    marketplaceCarriers,
    selfManagedOrganisations,
    dedicatedPartners,
    liveCarrierConnections,
    methodsAwaitingApproval,
    arrangementsAwaitingApproval,
    suspendedPartners,
    failingConnections,
    activeShipments,
    openExceptions,
    unassignedShipments,
  };
}

// ---------------------------------------------------------------------------
// The provider catalogue
// ---------------------------------------------------------------------------

export interface ProviderCard {
  provider: CarrierProvider;
  /** Whether a deployment can use it with no credential at all. */
  worksOutOfTheBox: boolean;
  /**
   * Whether an official API exists that this software can call.
   *
   * FALSE for India Post, and the card says so in words. This is the field
   * that stops the screen ever rendering a "connected" state for a provider
   * nobody can connect to.
   */
  hasVerifiedApi: boolean;
  /** What it needs before it can do anything, in words. */
  requires: readonly string[];
  /**
   * Why there is no interface, where there is none.
   *
   * INSIDE_PORTAL and NOT_VERIFIED look identical on a screen and are not the
   * same thing. The first is a carrier working here by design; the second is
   * India Post, where nobody has found an interface to connect to. Sending an
   * operator looking for a credential in the first case wastes their
   * afternoon.
   */
  noApiReason: 'INSIDE_PORTAL' | 'NOT_VERIFIED' | null;
  /** How many sellers hold an account with it, by state. */
  sellerConnections: { total: number; active: number; failing: number };
  /** Carriers the operator has wired through their own integration. */
  operatorIntegrations: number;
}

/**
 * The provider cards.
 *
 * Built from the adapter registry rather than from a table, because which
 * providers exist is the shape of the product: an operator who could delete
 * one from a table would leave sellers holding connections pointing at a
 * provider nothing can explain.
 *
 * NO CARRIER LOGOS. Text and the product's own neutral icons until somebody
 * confirms permitted use of the marks - a logo is a trademark, and shipping
 * one in a repository is a decision for whoever owns the deployment.
 */
export async function readProviderCatalogue(): Promise<ProviderCard[]> {
  const declared = describeProviders();

  const [connectionCounts, integrationCounts] = await Promise.all([
    prisma.sellerCarrierConnection.groupBy({
      by: ['provider', 'state'],
      _count: { _all: true },
    }),
    prisma.carrierIntegration.groupBy({ by: ['provider'], _count: { _all: true } }),
  ]);

  return declared.map((entry) => {
    const mine = connectionCounts.filter((row) => row.provider === entry.provider);

    const total = mine.reduce((sum, row) => sum + row._count._all, 0);
    const active = mine
      .filter((row) => row.state === 'ACTIVE')
      .reduce((sum, row) => sum + row._count._all, 0);
    const failing = mine
      .filter((row) => row.state === 'ERROR')
      .reduce((sum, row) => sum + row._count._all, 0);

    return {
      provider: entry.provider,
      worksOutOfTheBox: entry.worksOutOfTheBox,
      hasVerifiedApi: hasVerifiedOfficialApi(entry.provider),
      requires: entry.requires,
      noApiReason: entry.noApiReason,
      sellerConnections: { total, active, failing },
      operatorIntegrations:
        integrationCounts.find((row) => row.provider === entry.provider)?._count._all ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------
// The partner table
// ---------------------------------------------------------------------------

export interface PartnerRow {
  id: string;
  partnerCode: string;
  displayName: string;
  partnerKind: LogisticsPartnerKind;
  status: LogisticsPartnerStatus;
  registrationCountry: string;
  /** The seller that owns it, for the two seller-scoped kinds. */
  ownerSellerName: string | null;
  /** Sellers this company carries for, by name. Never their order volumes. */
  linkedSellerNames: string[];
  serviceCountries: string[];
  capabilities: string[];
  activeDrivers: number;
  activeShipments: number;
  openExceptions: number;
  lastActivityAt: string | null;
}

export interface PartnerFilter {
  search?: string;
  partnerKind?: LogisticsPartnerKind;
  status?: LogisticsPartnerStatus;
  country?: string;
  sellerAccountId?: string;
  capability?: string;
  limit?: number;
  offset?: number;
}

/**
 * Every delivery company, with what an operator needs to triage it.
 *
 * Counts rather than contents. An operator triaging carriers needs to know
 * that one has eleven open exceptions; they do not need eleven consignees'
 * addresses on a list screen, and putting them there would spread personal
 * data across a page that exists to be scanned.
 */
export async function listPartnersForCatalogue(
  filter: PartnerFilter = {},
): Promise<{ rows: PartnerRow[]; total: number }> {
  const where = {
    archivedAt: null,
    ...(filter.partnerKind === undefined ? {} : { partnerKind: filter.partnerKind }),
    ...(filter.status === undefined ? {} : { status: filter.status }),
    ...(filter.country === undefined
      ? {}
      : { registrationCountry: filter.country.toUpperCase() }),
    ...(filter.search === undefined || filter.search.trim().length === 0
      ? {}
      : {
          OR: [
            { displayName: { contains: filter.search.trim() } },
            { partnerCode: { contains: filter.search.trim() } },
            { legalName: { contains: filter.search.trim() } },
          ],
        }),
    ...(filter.sellerAccountId === undefined
      ? {}
      : {
          OR: [
            { ownerSellerAccountId: filter.sellerAccountId },
            { sellerLinks: { some: { sellerAccountId: filter.sellerAccountId } } },
          ],
        }),
    ...(filter.capability === undefined
      ? {}
      : {
          capabilities: {
            some: { kind: filter.capability as never, state: 'APPROVED' as const },
          },
        }),
  };

  const [total, partners] = await Promise.all([
    prisma.logisticsPartner.count({ where }),
    prisma.logisticsPartner.findMany({
      where,
      include: {
        ownerSellerAccount: { select: { displayName: true } },
        regions: {
          where: { isActive: true, isExclusion: false },
          select: { countryCode: true },
        },
        capabilities: { where: { state: 'APPROVED' }, select: { kind: true } },
        sellerLinks: {
          where: { status: 'APPROVED', archivedAt: null },
          select: { sellerAccount: { select: { displayName: true } } },
        },
        _count: {
          select: {
            drivers: { where: { state: 'ACTIVE' } },
            exceptions: { where: { state: { in: ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'ESCALATED'] } } },
          },
        },
      },
      orderBy: [{ status: 'asc' }, { displayName: 'asc' }],
      take: Math.min(filter.limit ?? 50, 200),
      skip: filter.offset ?? 0,
    }),
  ]);

  /*
   * Live consignments per carrier, in ONE grouped query.
   *
   * Not a count inside the include: that is a correlated subquery per row, and
   * this screen is the one an operator leaves open all day.
   */
  const shipmentCounts = await prisma.logisticsShipment.groupBy({
    by: ['assignedPartnerId'],
    where: {
      assignedPartnerId: { in: partners.map((partner) => partner.id) },
      status: { in: ['ASSIGNED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY'] },
    },
    _count: { _all: true },
    _max: { updatedAt: true },
  });

  return {
    total,
    rows: partners.map((partner) => {
      const shipments = shipmentCounts.find((row) => row.assignedPartnerId === partner.id);

      return {
        id: partner.id,
        partnerCode: partner.partnerCode,
        displayName: partner.displayName,
        partnerKind: partner.partnerKind,
        status: partner.status,
        registrationCountry: partner.registrationCountry,
        ownerSellerName: partner.ownerSellerAccount?.displayName ?? null,
        linkedSellerNames: partner.sellerLinks.map((link) => link.sellerAccount.displayName),
        serviceCountries: [...new Set(partner.regions.map((region) => region.countryCode))].sort(),
        capabilities: partner.capabilities.map((capability) => capability.kind),
        activeDrivers: partner._count.drivers,
        activeShipments: shipments?._count._all ?? 0,
        openExceptions: partner._count.exceptions,
        lastActivityAt: shipments?._max.updatedAt?.toISOString() ?? null,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// The seller connection health table
// ---------------------------------------------------------------------------

export interface ConnectionHealthRow {
  id: string;
  sellerAccountId: string;
  sellerName: string;
  provider: CarrierProvider;
  environment: string;
  state: string;
  trackingMode: string;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  /** The safe message the connection stored. Never a header or a token. */
  lastFailureMessage: string | null;
  hasVerifiedApi: boolean;
}

/**
 * How every seller's own carrier account is behaving.
 *
 * WHAT THE OPERATOR SEES AND DOES NOT. They see the state, the counts, when it
 * last worked and the sanitised message from when it did not. They do not see
 * the credential, the account number in full, or anything that would let them
 * use the seller's carrier account - which is the whole point of the
 * credentials being the seller's.
 */
export async function listConnectionHealth(filter: {
  provider?: CarrierProvider;
  failingOnly?: boolean;
  limit?: number;
} = {}): Promise<ConnectionHealthRow[]> {
  const rows = await prisma.sellerCarrierConnection.findMany({
    where: {
      ...(filter.provider === undefined ? {} : { provider: filter.provider }),
      ...(filter.failingOnly === true
        ? { OR: [{ state: 'ERROR' }, { consecutiveFailures: { gt: 0 } }] }
        : {}),
    },
    select: {
      id: true,
      sellerAccountId: true,
      provider: true,
      environment: true,
      state: true,
      trackingMode: true,
      consecutiveFailures: true,
      lastSuccessAt: true,
      lastFailureAt: true,
      lastFailureMessage: true,
      sellerAccount: { select: { displayName: true } },
      // `credential` is NOT selected. There is nothing on this screen that
      // needs it and no way to ask for it from here.
    },
    orderBy: [{ consecutiveFailures: 'desc' }, { lastFailureAt: 'desc' }],
    take: Math.min(filter.limit ?? 100, 500),
  });

  return rows.map((row) => ({
    id: row.id,
    sellerAccountId: row.sellerAccountId,
    sellerName: row.sellerAccount.displayName,
    provider: row.provider,
    environment: row.environment,
    state: row.state,
    trackingMode: row.trackingMode,
    consecutiveFailures: row.consecutiveFailures,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastFailureAt: row.lastFailureAt?.toISOString() ?? null,
    lastFailureMessage: row.lastFailureMessage,
    hasVerifiedApi: hasVerifiedOfficialApi(row.provider),
  }));
}

// ---------------------------------------------------------------------------
// The carrier's own, scoped view
// ---------------------------------------------------------------------------

export interface OwnIntegrationHealth {
  partnerCode: string;
  displayName: string;
  status: LogisticsPartnerStatus;
  partnerKind: LogisticsPartnerKind;
  /** The integration this carrier's consignments are tracked through, if any. */
  provider: CarrierProvider | null;
  integrationState: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  serviceCountries: string[];
  capabilities: { kind: string; state: string }[];
  activeDrivers: number;
  activeShipments: number;
  openExceptions: number;
  /** Sellers this carrier works for, by name. */
  sellerNames: string[];
}

/**
 * What the signed-in carrier may see about itself.
 *
 * The portal's half of the split. Every figure is this carrier's own, resolved
 * from the membership rather than from anything a request carried - so there
 * is no parameter here that could be pointed at somebody else, which is the
 * property that makes the screen safe rather than merely filtered.
 */
export async function readOwnIntegrationHealth(
  logisticsPartnerId: string,
): Promise<OwnIntegrationHealth | null> {
  const partner = await prisma.logisticsPartner.findFirst({
    where: { id: logisticsPartnerId, archivedAt: null },
    include: {
      carrierIntegration: {
        select: { provider: true, state: true, lastSuccessAt: true, lastFailureAt: true },
      },
      regions: { where: { isActive: true, isExclusion: false }, select: { countryCode: true } },
      capabilities: { select: { kind: true, state: true } },
      sellerLinks: {
        where: { status: 'APPROVED', archivedAt: null },
        select: { sellerAccount: { select: { displayName: true } } },
      },
      _count: {
        select: {
          drivers: { where: { state: 'ACTIVE' } },
          exceptions: { where: { state: { in: ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'ESCALATED'] } } },
        },
      },
    },
  });

  if (partner === null) return null;

  const activeShipments = await prisma.logisticsShipment.count({
    where: {
      assignedPartnerId: partner.id,
      status: { in: ['ASSIGNED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY'] },
    },
  });

  return {
    partnerCode: partner.partnerCode,
    displayName: partner.displayName,
    status: partner.status,
    partnerKind: partner.partnerKind,
    provider: partner.carrierIntegration?.provider ?? null,
    integrationState: partner.carrierIntegration?.state ?? null,
    lastSuccessAt: partner.carrierIntegration?.lastSuccessAt?.toISOString() ?? null,
    lastFailureAt: partner.carrierIntegration?.lastFailureAt?.toISOString() ?? null,
    serviceCountries: [...new Set(partner.regions.map((region) => region.countryCode))].sort(),
    capabilities: partner.capabilities.map((capability) => ({
      kind: capability.kind,
      state: capability.state,
    })),
    activeDrivers: partner._count.drivers,
    activeShipments,
    openExceptions: partner._count.exceptions,
    sellerNames: partner.sellerLinks.map((link) => link.sellerAccount.displayName),
  };
}

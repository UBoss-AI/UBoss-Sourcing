/**
 * The operator's company directory.
 *
 * One screen answering one question an administrator asks constantly and could
 * not previously answer without opening three lists side by side: **who is this
 * company, and what does it do here?**
 *
 * A business can hold three kinds of account at once — it buys, it sells, it
 * carries — and each kind lives in its own table with its own name field. This
 * module reads all three, groups them by company (see
 * `domain/company-directory.ts` for the rule and why it is a name), and returns
 * a tree: company → its accounts → the people inside each account.
 *
 * READ-ONLY, AND DELIBERATELY SO
 *
 * Nothing here writes. Every action an operator might take from this screen —
 * approving a seller, suspending a carrier, editing a customer — already has a
 * route that enforces its own permission and writes its own audit row, and the
 * directory links to those rather than growing a second way to do them. A
 * screen that shows everything must not also be a screen that does everything.
 *
 * WHAT IT SHOWS DEPENDS ON WHO IS ASKING
 *
 * Carriers are omitted entirely for an administrator who does not hold
 * `logistics.read`, and customer and seller accounts for one who does not hold
 * `customer.read`. Not greyed out, not counted in a total they cannot see:
 * absent. The route asks for one of the two and this service is told which,
 * because a directory that leaks the existence of every carrier to a catalogue
 * assistant is a directory that quietly widened a permission.
 *
 * SCALE
 *
 * Companies are counted in hundreds even where accounts are counted in tens of
 * thousands, so the index — one row per seller, per carrier, per distinct buyer
 * organisation — is assembled in memory and paged there. Buyers with no company
 * name at all are NOT part of that index: there can be a hundred thousand of
 * them and they are not companies. They come back as one summary with a count
 * and the most recent few, which is what that group actually is.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import {
  groupIntoCompanies,
  normaliseCompanyName,
  type DirectoryAccountKind,
  type DirectoryIndexEntry,
} from '../../domain/company-directory.js';
import { prisma } from '../../infra/prisma.js';
import { logoUrlFor } from '../seller/logo.service.js';

/**
 * How many companies are read into the index before it is paged.
 *
 * A ceiling rather than a page size: the index has to be complete enough to
 * sort and merge across three sources, and merging cannot be done a page at a
 * time. When it is hit the answer says so (`isTruncated`) and the screen tells
 * the operator to narrow the search, which is honest — silently returning the
 * first five hundred companies as though they were all of them is not.
 */
const INDEX_CAP = 600;

/** People listed inside one account before the list is cut short. */
const PEOPLE_PER_ACCOUNT = 50;

/** Recently-joined buyers shown in the "no company name" summary. */
const UNLISTED_SAMPLE = 12;

export type { DirectoryAccountKind };

/** One person, and everything this company's accounts make them. */
export interface DirectoryPerson {
  userId: string;
  customerProfileId: string | null;
  name: string;
  email: string;
  /** `UserStatus`. What the account itself can do, regardless of any role. */
  accountStatus: string;
  /**
   * Their standing in each of this company's accounts.
   *
   * A list rather than one value, and that is the point of the whole screen:
   * the person who owns the seller organisation is usually also the person
   * whose buying account placed last week's order, and an operator looking at
   * two rows in two lists has no way to know that.
   */
  roles: { kind: DirectoryAccountKind; label: string }[];
  /** Orders this person has placed as a buyer. */
  ordersPlaced: number;
  lastLoginAt: string | null;
}

export interface DirectorySellerAccount {
  id: string;
  displayName: string;
  legalName: string;
  slug: string;
  status: string;
  kind: string;
  registrationCountry: string;
  logoUrl: string | null;
  /** Approved and switched on — what a buyer can actually see. */
  liveListings: number;
  /** Submitted and waiting for a moderator. */
  listingsInReview: number;
  /** Not submitted. Only the seller sees these. */
  draftListings: number;
  ordersReceived: number;
  createdAt: string;
}

export interface DirectoryLogisticsAccount {
  id: string;
  partnerCode: string;
  displayName: string;
  legalName: string;
  status: string;
  contractStatus: string;
  registrationCountry: string;
  contactEmail: string;
  /** Consignments in this carrier's hands right now. */
  openShipments: number;
  memberCount: number;
  createdAt: string;
}

export interface DirectoryBuyerAccount {
  /** The organisation exactly as the buyers typed it, one row per spelling. */
  organisationNames: string[];
  profileCount: number;
  ordersPlaced: number;
}

export interface DirectoryCompany {
  key: string;
  name: string;
  country: string | null;
  kinds: DirectoryAccountKind[];
  seller: DirectorySellerAccount | null;
  logistics: DirectoryLogisticsAccount | null;
  buyer: DirectoryBuyerAccount | null;
  people: DirectoryPerson[];
  /** True when this company has more people than were listed. */
  hasMorePeople: boolean;
}

export interface DirectoryQuery {
  search?: string | null;
  kind?: DirectoryAccountKind | null;
  page?: number;
  pageSize?: number;
  /** Set from the caller's own permissions. See the header. */
  canReadCustomers: boolean;
  canReadLogistics: boolean;
}

export interface DirectoryResult {
  companies: DirectoryCompany[];
  page: number;
  pageSize: number;
  total: number;
  /** More companies matched than the index could hold. Narrow the search. */
  isTruncated: boolean;
  counts: { sellers: number; logistics: number; buyerOrganisations: number };
  /**
   * Buyers who never named an employer. Not a company and not shown as one —
   * an individual buying from a home address is the ordinary case on a
   * marketplace, not missing data.
   */
  unlistedBuyers: { total: number; sample: DirectoryPerson[] } | null;
}

/** Seller member roles, and logistics roles, as a person would say them. */
function roleLabel(raw: string): string {
  return raw
    .replace(/^LOGISTICS_PARTNER_/, '')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/^./, (character) => character.toUpperCase());
}

function containsFilter(search: string | null): string | undefined {
  return search === null || search.length === 0 ? undefined : search;
}

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

interface IndexSources {
  sellers: Map<string, SellerIndexRow>;
  partners: Map<string, PartnerIndexRow>;
  /** Normalised organisation name → every raw spelling and its profile count. */
  buyerOrganisations: Map<string, { names: string[]; profileCount: number }>;
}

interface SellerIndexRow {
  id: string;
  displayName: string;
  legalName: string;
  slug: string;
  status: string;
  kind: string;
  registrationCountry: string;
  logoStorageKey: string | null;
  createdAt: Date;
}

interface PartnerIndexRow {
  id: string;
  partnerCode: string;
  displayName: string;
  legalName: string;
  status: string;
  contractStatus: string;
  registrationCountry: string;
  contactEmail: string;
  createdAt: Date;
}

async function readIndex(query: DirectoryQuery): Promise<IndexSources> {
  const search = containsFilter(query.search?.trim() ?? null);
  const wantsSellers = query.canReadCustomers && query.kind !== 'LOGISTICS';
  const wantsBuyers = query.canReadCustomers && query.kind !== 'LOGISTICS' && query.kind !== 'SELLER';
  const wantsLogistics = query.canReadLogistics && query.kind !== 'SELLER' && query.kind !== 'BUYER';

  const sellerRows = wantsSellers
    ? await prisma.sellerAccount.findMany({
        where: {
          archivedAt: null,
          ...(search === undefined
            ? {}
            : {
                OR: [
                  { displayName: { contains: search } },
                  { legalName: { contains: search } },
                  { slug: { contains: search } },
                ],
              }),
        },
        orderBy: [{ displayName: 'asc' }],
        take: INDEX_CAP + 1,
        select: {
          id: true,
          displayName: true,
          legalName: true,
          slug: true,
          status: true,
          kind: true,
          registrationCountry: true,
          logoStorageKey: true,
          createdAt: true,
        },
      })
    : [];

  const partnerRows = wantsLogistics
    ? await prisma.logisticsPartner.findMany({
        where: {
          archivedAt: null,
          ...(search === undefined
            ? {}
            : {
                OR: [
                  { displayName: { contains: search } },
                  { legalName: { contains: search } },
                  { partnerCode: { contains: search } },
                ],
              }),
        },
        orderBy: [{ displayName: 'asc' }],
        take: INDEX_CAP + 1,
        select: {
          id: true,
          partnerCode: true,
          displayName: true,
          legalName: true,
          status: true,
          contractStatus: true,
          registrationCountry: true,
          contactEmail: true,
          createdAt: true,
        },
      })
    : [];

  /*
   * Distinct employer names, not distinct buyers.
   *
   * `groupBy` rather than reading every profile: a deployment with forty
   * thousand buyers has a few hundred employers between them, and it is the
   * employers this screen is a list of.
   */
  const organisationRows = wantsBuyers
    ? await prisma.customerProfile.groupBy({
        by: ['organization'],
        where: {
          organization: { not: null },
          ...(search === undefined ? {} : { organization: { contains: search, not: null } }),
        },
        _count: { _all: true },
        orderBy: { organization: 'asc' },
        take: INDEX_CAP + 1,
      })
    : [];

  const buyerOrganisations = new Map<string, { names: string[]; profileCount: number }>();

  for (const row of organisationRows) {
    const raw = (row.organization ?? '').trim();
    if (raw.length === 0) continue;

    const key = normaliseCompanyName(raw);
    if (key.length === 0) continue;

    const existing = buyerOrganisations.get(key);

    if (existing === undefined) {
      buyerOrganisations.set(key, { names: [raw], profileCount: row._count._all });
    } else {
      // Two spellings of one employer. Both are kept, because the profiles are
      // found by the exact string a buyer typed.
      if (!existing.names.includes(raw)) existing.names.push(raw);
      existing.profileCount += row._count._all;
    }
  }

  return {
    sellers: new Map(sellerRows.map((row) => [row.id, row])),
    partners: new Map(partnerRows.map((row) => [row.id, row])),
    buyerOrganisations,
  };
}

// ---------------------------------------------------------------------------
// Hydration
// ---------------------------------------------------------------------------

/** Orders placed, per customer profile, in one query rather than per person. */
async function ordersByProfile(profileIds: string[]): Promise<Map<string, number>> {
  if (profileIds.length === 0) return new Map();

  const rows = await prisma.order.groupBy({
    by: ['customerProfileId'],
    where: { customerProfileId: { in: profileIds } },
    _count: { _all: true },
  });

  return new Map(rows.map((row) => [row.customerProfileId, row._count._all]));
}

/**
 * Fold a person into a company's people list.
 *
 * Merges by user id rather than appending, which is the whole reason a seller's
 * owner does not appear twice on one company: once as the seller's owner and
 * once as one of its buying accounts. They are one person with two roles, and
 * the row says so.
 */
function upsertPerson(
  into: Map<string, DirectoryPerson>,
  person: Omit<DirectoryPerson, 'roles'> & { role: { kind: DirectoryAccountKind; label: string } },
): void {
  const existing = into.get(person.userId);

  if (existing === undefined) {
    const { role, ...rest } = person;
    into.set(person.userId, { ...rest, roles: [role] });
    return;
  }

  const already = existing.roles.some(
    (role) => role.kind === person.role.kind && role.label === person.role.label,
  );
  if (!already) existing.roles.push(person.role);

  // A profile id learned from the buying side fills a gap left by a logistics
  // row, which has no customer profile at all.
  existing.customerProfileId ??= person.customerProfileId;
  if (person.ordersPlaced > existing.ordersPlaced) existing.ordersPlaced = person.ordersPlaced;
}

// ---------------------------------------------------------------------------
// The directory
// ---------------------------------------------------------------------------

export async function readDirectory(query: DirectoryQuery): Promise<DirectoryResult> {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(Math.max(1, query.pageSize ?? 25), 100);

  if (!query.canReadCustomers && !query.canReadLogistics) {
    // Not an error: the route's guard already decided this caller may open the
    // screen. It means they hold neither of the reads the screen is made of,
    // which is an empty directory rather than a refusal halfway down a page.
    return {
      companies: [],
      page,
      pageSize,
      total: 0,
      isTruncated: false,
      counts: { sellers: 0, logistics: 0, buyerOrganisations: 0 },
      unlistedBuyers: null,
    };
  }

  const sources = await readIndex(query);

  const entries: DirectoryIndexEntry[] = [];

  for (const seller of sources.sellers.values()) {
    entries.push({
      kind: 'SELLER',
      id: seller.id,
      name: seller.displayName,
      country: seller.registrationCountry,
      alsoKnownAs: seller.legalName,
    });
  }

  for (const partner of sources.partners.values()) {
    entries.push({
      kind: 'LOGISTICS',
      id: partner.id,
      name: partner.displayName,
      country: partner.registrationCountry,
      alsoKnownAs: partner.legalName,
    });
  }

  for (const [key, organisation] of sources.buyerOrganisations) {
    entries.push({
      kind: 'BUYER',
      id: key,
      name: organisation.names[0] ?? key,
      country: null,
    });
  }

  const grouped = groupIntoCompanies(entries);

  const isTruncated =
    sources.sellers.size > INDEX_CAP ||
    sources.partners.size > INDEX_CAP ||
    sources.buyerOrganisations.size > INDEX_CAP;

  const total = grouped.length;
  const pageNodes = grouped.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);

  // --- Everything the page needs, in one round of queries -------------------

  const sellerIds = pageNodes.flatMap((node) =>
    node.entries.filter((entry) => entry.kind === 'SELLER').map((entry) => entry.id),
  );
  const partnerIds = pageNodes.flatMap((node) =>
    node.entries.filter((entry) => entry.kind === 'LOGISTICS').map((entry) => entry.id),
  );
  const organisationNames = pageNodes.flatMap((node) =>
    node.entries
      .filter((entry) => entry.kind === 'BUYER')
      .flatMap((entry) => sources.buyerOrganisations.get(entry.id)?.names ?? []),
  );

  const [
    offerCounts,
    draftCounts,
    orderGroupCounts,
    sellerMembers,
    openShipmentCounts,
    partnerUsers,
    buyerProfiles,
  ] = await Promise.all([
    sellerIds.length === 0
      ? []
      : prisma.sellerOffer.groupBy({
          by: ['sellerAccountId', 'status'],
          where: { sellerAccountId: { in: sellerIds } },
          _count: { _all: true },
        }),
    sellerIds.length === 0
      ? []
      : prisma.sellerListingDraft.groupBy({
          by: ['sellerAccountId', 'status'],
          where: { sellerAccountId: { in: sellerIds } },
          _count: { _all: true },
        }),
    sellerIds.length === 0
      ? []
      : prisma.sellerOrderGroup.groupBy({
          by: ['sellerAccountId'],
          where: { sellerAccountId: { in: sellerIds } },
          _count: { _all: true },
        }),
    sellerIds.length === 0
      ? []
      : prisma.sellerMember.findMany({
          where: { sellerAccountId: { in: sellerIds }, removedAt: null },
          take: sellerIds.length * PEOPLE_PER_ACCOUNT,
          orderBy: [{ sellerAccountId: 'asc' }, { joinedAt: 'asc' }],
          select: {
            sellerAccountId: true,
            role: true,
            customerProfile: {
              select: {
                id: true,
                fullName: true,
                user: {
                  select: { id: true, email: true, status: true, lastLoginAt: true },
                },
              },
            },
          },
        }),
    partnerIds.length === 0
      ? []
      : prisma.logisticsShipment.groupBy({
          by: ['assignedPartnerId'],
          where: {
            assignedPartnerId: { in: partnerIds },
            status: { notIn: ['DELIVERED', 'CANCELLED', 'RETURNED', 'LOST'] },
          },
          _count: { _all: true },
        }),
    partnerIds.length === 0
      ? []
      : prisma.logisticsPartnerUser.findMany({
          where: { logisticsPartnerId: { in: partnerIds } },
          take: partnerIds.length * PEOPLE_PER_ACCOUNT,
          orderBy: [{ logisticsPartnerId: 'asc' }, { createdAt: 'asc' }],
          select: {
            logisticsPartnerId: true,
            role: true,
            fullName: true,
            user: { select: { id: true, email: true, status: true, lastLoginAt: true } },
          },
        }),
    organisationNames.length === 0
      ? []
      : prisma.customerProfile.findMany({
          where: { organization: { in: organisationNames } },
          take: organisationNames.length * PEOPLE_PER_ACCOUNT,
          orderBy: [{ organization: 'asc' }, { createdAt: 'asc' }],
          select: {
            id: true,
            organization: true,
            fullName: true,
            user: { select: { id: true, email: true, status: true, lastLoginAt: true } },
          },
        }),
  ]);

  const profileIds = [
    ...new Set([
      ...sellerMembers.map((member) => member.customerProfile.id),
      ...buyerProfiles.map((profile) => profile.id),
    ]),
  ];
  const orderCounts = await ordersByProfile(profileIds);

  // --- Assemble -------------------------------------------------------------

  const companies: DirectoryCompany[] = pageNodes.map((node) => {
    const sellerEntry = node.entries.find((entry) => entry.kind === 'SELLER');
    const partnerEntry = node.entries.find((entry) => entry.kind === 'LOGISTICS');
    const buyerEntries = node.entries.filter((entry) => entry.kind === 'BUYER');

    const people = new Map<string, DirectoryPerson>();

    // ---- The seller account ----
    let seller: DirectorySellerAccount | null = null;

    if (sellerEntry !== undefined) {
      const row = sources.sellers.get(sellerEntry.id);

      if (row !== undefined) {
        const offers = offerCounts.filter((count) => count.sellerAccountId === row.id);
        const drafts = draftCounts.filter((count) => count.sellerAccountId === row.id);

        seller = {
          id: row.id,
          displayName: row.displayName,
          legalName: row.legalName,
          slug: row.slug,
          status: row.status,
          kind: row.kind,
          registrationCountry: row.registrationCountry,
          logoUrl: logoUrlFor(row.logoStorageKey),
          liveListings: offers
            .filter((offer) => offer.status === 'ACTIVE')
            .reduce((sum, offer) => sum + offer._count._all, 0),
          listingsInReview: drafts
            .filter((draft) => draft.status === 'PENDING_REVIEW')
            .reduce((sum, draft) => sum + draft._count._all, 0),
          draftListings: drafts
            .filter((draft) =>
              ['DRAFT', 'VALIDATION_FAILED', 'READY_FOR_SUBMISSION', 'ACTION_REQUIRED'].includes(
                draft.status,
              ),
            )
            .reduce((sum, draft) => sum + draft._count._all, 0),
          ordersReceived:
            orderGroupCounts.find((count) => count.sellerAccountId === row.id)?._count._all ?? 0,
          createdAt: row.createdAt.toISOString(),
        };

        for (const member of sellerMembers) {
          if (member.sellerAccountId !== row.id) continue;

          upsertPerson(people, {
            userId: member.customerProfile.user.id,
            customerProfileId: member.customerProfile.id,
            name: member.customerProfile.fullName,
            email: member.customerProfile.user.email,
            accountStatus: member.customerProfile.user.status,
            ordersPlaced: orderCounts.get(member.customerProfile.id) ?? 0,
            lastLoginAt: member.customerProfile.user.lastLoginAt?.toISOString() ?? null,
            role: { kind: 'SELLER', label: roleLabel(member.role) },
          });
        }
      }
    }

    // ---- The carrier account ----
    let logistics: DirectoryLogisticsAccount | null = null;

    if (partnerEntry !== undefined) {
      const row = sources.partners.get(partnerEntry.id);

      if (row !== undefined) {
        const members = partnerUsers.filter((user) => user.logisticsPartnerId === row.id);

        logistics = {
          id: row.id,
          partnerCode: row.partnerCode,
          displayName: row.displayName,
          legalName: row.legalName,
          status: row.status,
          contractStatus: row.contractStatus,
          registrationCountry: row.registrationCountry,
          contactEmail: row.contactEmail,
          openShipments:
            openShipmentCounts.find((count) => count.assignedPartnerId === row.id)?._count._all ?? 0,
          memberCount: members.length,
          createdAt: row.createdAt.toISOString(),
        };

        for (const member of members) {
          upsertPerson(people, {
            userId: member.user.id,
            customerProfileId: null,
            name: member.fullName,
            email: member.user.email,
            accountStatus: member.user.status,
            ordersPlaced: 0,
            lastLoginAt: member.user.lastLoginAt?.toISOString() ?? null,
            role: { kind: 'LOGISTICS', label: roleLabel(member.role) },
          });
        }
      }
    }

    // ---- The buying accounts ----
    let buyer: DirectoryBuyerAccount | null = null;
    let buyerProfilesListed = 0;

    if (buyerEntries.length > 0) {
      const names = buyerEntries.flatMap(
        (entry) => sources.buyerOrganisations.get(entry.id)?.names ?? [],
      );
      const profiles = buyerProfiles.filter(
        (profile) => profile.organization !== null && names.includes(profile.organization),
      );

      buyer = {
        organisationNames: names,
        profileCount: buyerEntries.reduce(
          (sum, entry) => sum + (sources.buyerOrganisations.get(entry.id)?.profileCount ?? 0),
          0,
        ),
        ordersPlaced: profiles.reduce(
          (sum, profile) => sum + (orderCounts.get(profile.id) ?? 0),
          0,
        ),
      };

      buyerProfilesListed = profiles.length;

      for (const profile of profiles) {
        upsertPerson(people, {
          userId: profile.user.id,
          customerProfileId: profile.id,
          name: profile.fullName,
          email: profile.user.email,
          accountStatus: profile.user.status,
          ordersPlaced: orderCounts.get(profile.id) ?? 0,
          lastLoginAt: profile.user.lastLoginAt?.toISOString() ?? null,
          role: { kind: 'BUYER', label: 'Buyer' },
        });
      }
    }

    const listed = [...people.values()];

    /*
     * "There are more people here than this shows."
     *
     * Two ways that happens: the node's own list was cut to `PEOPLE_PER_ACCOUNT`,
     * or the buying side reported more profiles than were read back. Stating it
     * matters more than it looks — an operator who reads five names and assumes
     * that is everybody has drawn a conclusion about a company from a truncated
     * list.
     */
    const hasMorePeople =
      listed.length > PEOPLE_PER_ACCOUNT ||
      (buyer !== null && buyer.profileCount > buyerProfilesListed);

    return {
      key: node.key,
      name: node.name,
      country: node.country,
      kinds: node.kinds,
      seller,
      logistics,
      buyer,
      people: listed.slice(0, PEOPLE_PER_ACCOUNT),
      hasMorePeople,
    };
  });

  // --- Buyers with no employer named ---------------------------------------

  let unlistedBuyers: DirectoryResult['unlistedBuyers'] = null;

  if (query.canReadCustomers && query.kind !== 'SELLER' && query.kind !== 'LOGISTICS') {
    const where: Prisma.CustomerProfileWhereInput = {
      OR: [{ organization: null }, { organization: '' }],
      ...(query.search === undefined || query.search === null || query.search.trim().length === 0
        ? {}
        : {
            AND: [
              {
                OR: [
                  { fullName: { contains: query.search.trim() } },
                  { user: { emailNormalized: { contains: query.search.trim().toLowerCase() } } },
                ],
              },
            ],
          }),
    };

    const [unlistedTotal, sample] = await Promise.all([
      prisma.customerProfile.count({ where }),
      prisma.customerProfile.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: UNLISTED_SAMPLE,
        select: {
          id: true,
          fullName: true,
          user: { select: { id: true, email: true, status: true, lastLoginAt: true } },
        },
      }),
    ]);

    const sampleOrders = await ordersByProfile(sample.map((profile) => profile.id));

    unlistedBuyers = {
      total: unlistedTotal,
      sample: sample.map((profile) => ({
        userId: profile.user.id,
        customerProfileId: profile.id,
        name: profile.fullName,
        email: profile.user.email,
        accountStatus: profile.user.status,
        roles: [{ kind: 'BUYER' as const, label: 'Buyer' }],
        ordersPlaced: sampleOrders.get(profile.id) ?? 0,
        lastLoginAt: profile.user.lastLoginAt?.toISOString() ?? null,
      })),
    };
  }

  return {
    companies,
    page,
    pageSize,
    total,
    isTruncated,
    counts: {
      sellers: sources.sellers.size,
      logistics: sources.partners.size,
      buyerOrganisations: sources.buyerOrganisations.size,
    },
    unlistedBuyers,
  };
}

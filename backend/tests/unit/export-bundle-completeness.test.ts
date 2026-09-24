/**
 * The bundle has to cover every table that names a person.
 *
 * The failure mode of an access request is not an error anybody sees. It is a
 * table somebody added six months after the bundle was written, holding a
 * customer's data, quietly absent from every copy sent since. Nothing else in
 * the suite would catch that - the export still builds, still validates, still
 * looks right.
 *
 * So this test reads `schema.prisma` itself, finds every model that carries a
 * link to a person, and requires each one to be accounted for: either it is a
 * section of the bundle, or it is on the withheld list with a reason, or it is
 * named here as deliberately out of scope. Adding a model with a
 * `customerProfileId` and forgetting the export turns this red.
 *
 * It parses the schema as text rather than importing the generated client's
 * DMMF on purpose. The point is to compare the bundle against the source of
 * truth a developer just edited, not against a client that may not have been
 * regenerated yet.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SECTIONS } from '../../src/modules/privacy/export-bundle.service.js';

const SCHEMA_PATH = fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url));

/**
 * Columns that make a row somebody's personal data.
 *
 * `userId` and `customerProfileId` are the direct links. `actorUserId` is the
 * audit trail's, and `visitorEmailNormalized` catches the chat enquiry, which
 * is about a person who may not have an account at all.
 */
const SUBJECT_COLUMNS = [
  'userId',
  'customerProfileId',
  'actorUserId',
  'subjectUserId',
  'visitorEmailNormalized',
] as const;

/**
 * Every model that links to a person, and what the bundle does about it.
 *
 * A section name means "disclosed under that key". `null` means the model is
 * deliberately out of scope, and the string beside it is the reason - which is
 * the part a supervisory authority would actually ask about.
 */
const DISPOSITION: Readonly<Record<string, string | null>> = Object.freeze({
  // --- Disclosed ---
  CustomerProfile: 'profile',
  Address: 'addresses',
  Order: 'orders',
  Cart: 'carts',
  RecurringSchedule: 'recurringSchedules',
  CustomerPaymentMethod: 'savedPaymentMethods',
  CouponRedemption: 'couponRedemptions',
  CustomerLimit: 'purchasingLimits',
  WishlistItem: 'wishlist',

  // What a shopper asked a seller for, on a product they did not buy. Their
  // own words, held until they take them back, so disclosed in full.
  ProductInstruction: 'productInstructions',
  AssistantConversation: 'chatEnquiries',
  Session: 'sessions',
  DataRequest: 'dataRequests',

  // Delivery options this person was shown at checkout - the price and the
  // dates each warehouse promised. Short-lived and mostly never accepted, and
  // disclosed anyway: the one they took is the evidence behind a delivery
  // date they may later be disputing.
  FulfilmentQuote: 'fulfilmentQuotes',

  // The standing authority to be charged. The OPERATOR's ERP tables are
  // deliberately absent from this map: they carry no link to a person at all,
  // because that ERP belongs to the business rather than to any customer, so
  // the parser above never finds them.
  CustomerAutoPaySetting: 'autoPayAuthority',

  // Where a customer works and what authority they hold there. The BUYER's own
  // ERP tables are absent for the same reason the operator's are - they are
  // keyed on `organizationId`, not on a person - but this one is not: a
  // membership is a fact about an individual, so it is disclosed.
  BuyerOrganizationMember: 'organisationMembership',

  // The same fact about the other side of the marketplace: where this person
  // sells and what authority they hold there. The seller BUSINESS's rows -
  // its listings, stock, orders and settlements - are keyed on
  // `sellerAccountId` rather than on a person, so the parser never finds them,
  // which is correct: they belong to the company.
  SellerMember: 'sellerMembership',

  // The third one. A person who drives for a carrier that delivers for this
  // marketplace: their membership and driver record are theirs, and the
  // carrier's consignments are the carrier's.
  LogisticsPartnerUser: 'logisticsMembership',

  // --- Withheld, with the reason on the manifest the subject receives ---
  AuditLog: 'auditTrail',
  AuthToken: 'credentials',
  SellerAuditLog: 'sellerAuditTrail',
  LogisticsAuditLog: 'logisticsAuditTrail',

  // --- Out of scope, and why ---
  UserRole:
    'Role membership. Every customer holds exactly the customer role, so the row carries no ' +
    'information about the individual; the account section already says the account is a ' +
    'customer account.',
  AdminNotificationRead:
    'Which console notifications a member of STAFF has opened. A customer never has a row ' +
    'here, and a staff member exercising this right gets the account section.',
  InventoryMovement:
    'Stock ledger. `actorUserId` is the member of staff who received or adjusted stock, never ' +
    'the customer, and the row is about a product rather than a person.',
  OrderStatusHistory:
    'Who moved an order between statuses - staff activity against the order. The order itself ' +
    'is disclosed; who in the warehouse touched it is their data, not the customer’s.',
  LogisticsShipmentEvent:
    'Who moved a consignment between statuses - a carrier\u2019s staff acting against a parcel. ' +
    'The events themselves belong to the shipment and are shown to the buyer on the tracking ' +
    'page; `actorUserId` names an employee of a third-party logistics company, which is that ' +
    'person\u2019s data rather than the buyer\u2019s. A logistics employee exercising this right ' +
    'gets the account section and `logisticsMembership`.',
  SellerErpAuditEvent:
    'What happened to a SELLER’s connection to their own accounting system - a bridge ' +
    'paired, a token rotated, a tax ledger remapped. `actorUserId` names a member of that ' +
    'seller’s own staff acting on their own company’s books, and no shopper ever has a ' +
    'row here: nothing a buyer does reaches this table, and the buyer-facing consequence of ' +
    'any of it - what was posted about their order - is already in `orders`. A seller’s ' +
    'employee exercising this right gets the account section and `sellerMembership`; the ' +
    'trail itself belongs to the seller BUSINESS, on the same line `sellerAuditTrail` draws.',
  // A bulk preorder this person asked for, with every set of terms put to
  // them. Disclosed whole, as `preorderRequests`.
  PreorderRequest: 'preorderRequests',
  PreorderStatusHistory:
    'Who moved a preorder between statuses. The history itself is disclosed inside ' +
    '`preorderRequests` (from, to, when and why); `actorUserId` names whoever acted - the ' +
    'buyer themselves, a member of the seller’s staff or the marketplace’s - and a ' +
    'staff member’s identity is their data rather than the buyer’s.',
  SellerLogisticsRelationshipEvent:
    'How a seller-to-carrier arrangement reached its current status. `actorUserId` names a ' +
    'member of the MARKETPLACE\u2019s staff who approved, refused or suspended a commercial ' +
    'arrangement between two businesses \u2014 a seller and a delivery company \u2014 and the row ' +
    'says nothing whatever about any shopper. No customer ever has a row here. A staff member ' +
    'exercising this right gets the account section and `auditTrail`.',
});

function modelsWithSubjectColumns(): string[] {
  const schema = readFileSync(SCHEMA_PATH, 'utf8');
  const found: string[] = [];

  // Model blocks are `model Name {` ... `}` at column 0, which the formatter
  // guarantees for this file.
  const blocks = schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm);

  for (const block of blocks) {
    const name = block[1];
    const body = block[2];
    if (name === undefined || body === undefined) continue;

    // `User` is the subject itself, not a model that references one.
    if (name === 'User') continue;

    const references = SUBJECT_COLUMNS.some((column) =>
      // A field declaration, not a mention inside an index or a comment.
      new RegExp(`^\\s{2,}${column}\\s+String`, 'm').test(body),
    );

    if (references) found.push(name);
  }

  return found.sort();
}

describe('export bundle completeness', () => {
  it('accounts for every model that links to a person', () => {
    const models = modelsWithSubjectColumns();

    // A sanity check on the parser itself. Without it, a regex that silently
    // stopped matching would turn this whole file green while the bundle
    // quietly lost sections - which is precisely the failure it exists to
    // catch. These four cover the three link shapes the parser looks for.
    expect(models).toContain('Order'); // customerProfileId
    expect(models).toContain('Session'); // userId
    expect(models).toContain('AuditLog'); // actorUserId
    expect(models).toContain('DataRequest'); // subjectUserId
    expect(models.length).toBeGreaterThan(8);

    const unaccounted = models.filter((model) => !(model in DISPOSITION));

    expect(
      unaccounted,
      `These models hold personal data but the Art. 15 bundle says nothing about them. ` +
        `Add each one to DISPOSITION in this test - as a bundle section, as a withheld ` +
        `section with a reason, or as out of scope with the reason why: ` +
        `${unaccounted.join(', ')}`,
    ).toEqual([]);
  });

  it('names a real section for every model it claims to disclose', () => {
    const declared = new Set<string>([
      ...SECTIONS.included,
      ...SECTIONS.withheld.map((entry) => entry.section),
    ]);

    const claimed = Object.values(DISPOSITION).filter(
      (value): value is string => value !== null && !value.includes(' '),
    );

    for (const section of claimed) {
      expect(declared, `DISPOSITION maps a model to "${section}", which the bundle does not have`)
        .toContain(section);
    }
  });

  it('gives every withheld section a reason the subject can read', () => {
    for (const entry of SECTIONS.withheld) {
      // Art. 15 does not permit quiet omission: if something is held back, the
      // person is told what and why.
      expect(entry.reason.length).toBeGreaterThan(40);
    }
  });

  it('discloses the sections the account and profile depend on', () => {
    // A bundle that lost these would still be a valid JSON file and a useless
    // answer.
    for (const section of ['account', 'profile', 'orders', 'addresses', 'consents']) {
      expect(SECTIONS.included).toContain(section);
    }
  });
});

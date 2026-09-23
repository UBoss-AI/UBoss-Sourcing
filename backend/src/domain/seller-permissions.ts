/**
 * What somebody may do inside one seller organisation.
 *
 * A parallel catalogue to `permissions.ts`, and deliberately not an extension
 * of it. The keys there grant authority over the MARKETPLACE - every order,
 * every customer, every price. The keys here grant authority over ONE seller's
 * own rows and nothing else. Merging the two catalogues would make it possible
 * to write a route that accepts either, and the first such route would let a
 * seller read another seller's orders.
 *
 * Every seller permission is therefore checked together with tenant ownership,
 * never instead of it: `requireSeller` resolves the caller's membership from
 * the session and every query filters on that id. A permission answers "may
 * this person do this kind of thing"; the tenant filter answers "to whose
 * data", and only the second one keeps sellers apart.
 */

/**
 * Seller permission keys, as `resource.action`.
 *
 * Read and write are separate throughout, for the same reason they are in the
 * admin catalogue: a Support Member who can read an order to answer a buyer
 * must not thereby be able to cancel it.
 */
export const SellerPermission = {
  // --- The organisation itself ---
  /// Read the application, the business profile and the onboarding state.
  ACCOUNT_READ: 'seller.account.read',
  /// Change the business profile and onboarding answers.
  ACCOUNT_WRITE: 'seller.account.write',
  /// Submit the application for review. Held apart from writing it: filling in
  /// a form and declaring it true are different acts, and the second one binds
  /// the business.
  ACCOUNT_SUBMIT: 'seller.account.submit',
  /// Accept the marketplace agreement, the commission schedule, the returns
  /// policy. OWNER only - nobody else can bind the business to a contract.
  AGREEMENT_ACCEPT: 'seller.agreement.accept',

  // --- People ---
  MEMBER_READ: 'seller.member.read',
  /// Invite, change a role, remove. The one permission that can enlarge the
  /// set of people who hold every other permission, which is why only OWNER
  /// and ADMIN have it.
  MEMBER_WRITE: 'seller.member.write',

  // --- Catalogue ---
  LISTING_READ: 'seller.listing.read',
  LISTING_WRITE: 'seller.listing.write',
  /// Send a listing to quality review. Separate from writing it, on the same
  /// reasoning as `ACCOUNT_SUBMIT`.
  LISTING_SUBMIT: 'seller.listing.submit',
  /// Pause, resume, archive a live offer. Separate again because it changes
  /// what buyers can currently buy, rather than what a draft says.
  OFFER_PUBLISH: 'seller.offer.publish',
  /// Change the price on a live offer.
  OFFER_PRICE_WRITE: 'seller.offer.price.write',
  BRAND_REQUEST: 'seller.brand.request',
  MEDIA_UPLOAD: 'seller.media.upload',
  BULK_IMPORT: 'seller.bulk_import.run',

  // --- Stock and places ---
  INVENTORY_READ: 'seller.inventory.read',
  INVENTORY_WRITE: 'seller.inventory.write',
  /// Adjustments can conjure or destroy stock, so they are their own grant -
  /// exactly as `inventory.adjust` is in the admin catalogue.
  INVENTORY_ADJUST: 'seller.inventory.adjust',
  LOCATION_READ: 'seller.location.read',
  LOCATION_WRITE: 'seller.location.write',

  // --- Orders ---
  ORDER_READ: 'seller.order.read',
  /// Accept, reject, allocate, ship.
  ORDER_FULFIL: 'seller.order.fulfil',
  ORDER_CANCEL: 'seller.order.cancel',
  RETURN_HANDLE: 'seller.return.handle',

  // --- Money ---
  /// Settlements, statements, payout history. Read-only everywhere: a
  /// marketplace seller does not move their own money from this interface.
  FINANCE_READ: 'seller.finance.read',
  /// Start or re-run payout onboarding with the provider.
  PAYOUT_SETUP: 'seller.payout.setup',

  // --- How this seller's goods get delivered ---
  //
  /// Read which delivery methods the business has, how they are routed, and
  /// whether each is healthy. NOT the credentials behind them - there is no
  /// permission anywhere that returns one of those, because no endpoint does.
  FULFILMENT_READ: 'seller.fulfilment.read',
  /// Choose a delivery method, make one primary, pause one, write the rules
  /// that route a parcel.
  ///
  /// Held by OWNER and ADMIN only. It looks like an operations key and is not:
  /// changing how the business ships changes what every order costs and how
  /// long it takes, and an Order Manager dispatching today's parcels has no
  /// business switching the company to a different courier.
  FULFILMENT_WRITE: 'seller.fulfilment.write',
  /// Store or rotate the API credentials for the seller's own carrier account.
  ///
  /// SEPARATE from FULFILMENT_WRITE on purpose. Choosing to ship by DHL and
  /// holding the key that bills the company's DHL account are different acts
  /// with different consequences, and the second one is the narrower of the
  /// two. Nothing here ever READS a credential back - see
  /// `SellerCarrierCredential`.
  CARRIER_CREDENTIAL_WRITE: 'seller.carrier.credential.write',

  // --- Integrations and records ---
  INTEGRATION_READ: 'seller.integration.read',
  INTEGRATION_WRITE: 'seller.integration.write',
  ANALYTICS_READ: 'seller.analytics.read',
  AUDIT_READ: 'seller.audit.read',
} as const;

export type SellerPermissionKey = (typeof SellerPermission)[keyof typeof SellerPermission];

export const ALL_SELLER_PERMISSIONS: readonly SellerPermissionKey[] = Object.freeze(
  Object.values(SellerPermission),
);

/**
 * Role keys. These are the `SellerMemberRole` enum members, as strings - the
 * database stores the enum and this file decides what each one may do, so the
 * two must stay in step. A member added to the enum with no entry here holds
 * nothing, which is the safe direction to fail.
 */
export const SellerRole = {
  OWNER: 'OWNER',
  ADMIN: 'ADMIN',
  CATALOGUE_MANAGER: 'CATALOGUE_MANAGER',
  INVENTORY_MANAGER: 'INVENTORY_MANAGER',
  ORDER_MANAGER: 'ORDER_MANAGER',
  FINANCE_VIEWER: 'FINANCE_VIEWER',
  SUPPORT_MEMBER: 'SUPPORT_MEMBER',
} as const;

export type SellerRoleKey = (typeof SellerRole)[keyof typeof SellerRole];

export interface SellerRoleDefinition {
  key: SellerRoleKey;
  name: string;
  description: string;
  permissions: readonly SellerPermissionKey[];
}

/**
 * Role -> permission grants.
 *
 * Three restrictions look like omissions and are not:
 *
 *   - **Only OWNER accepts agreements.** Signing the marketplace contract and
 *     the commission schedule binds the business. An ADMIN runs the business's
 *     day; they do not sign for it.
 *   - **Nobody but OWNER and ADMIN touches membership.** `MEMBER_WRITE` is the
 *     permission that grants permissions; giving it to a Catalogue Manager
 *     means giving them every other key by way of inviting themselves a second
 *     account.
 *   - **FINANCE_VIEWER really is read-only.** It reads money and nothing else
 *     - no listings, no stock, no orders beyond what a settlement line names.
 *     An accountant does not need to be able to pause a product.
 */
export const SELLER_ROLE_DEFINITIONS: readonly SellerRoleDefinition[] = Object.freeze([
  {
    key: SellerRole.OWNER,
    name: 'Seller Owner',
    description:
      'Full control of the seller account, including the team and the marketplace agreements.',
    permissions: ALL_SELLER_PERMISSIONS,
  },

  {
    key: SellerRole.ADMIN,
    name: 'Seller Admin',
    description: 'Runs the business day to day. Cannot sign agreements on its behalf.',
    permissions: Object.freeze([
      SellerPermission.ACCOUNT_READ,
      SellerPermission.ACCOUNT_WRITE,
      SellerPermission.ACCOUNT_SUBMIT,
      SellerPermission.MEMBER_READ,
      SellerPermission.MEMBER_WRITE,
      SellerPermission.LISTING_READ,
      SellerPermission.LISTING_WRITE,
      SellerPermission.LISTING_SUBMIT,
      SellerPermission.OFFER_PUBLISH,
      SellerPermission.OFFER_PRICE_WRITE,
      SellerPermission.BRAND_REQUEST,
      SellerPermission.MEDIA_UPLOAD,
      SellerPermission.BULK_IMPORT,
      SellerPermission.INVENTORY_READ,
      SellerPermission.INVENTORY_WRITE,
      SellerPermission.INVENTORY_ADJUST,
      SellerPermission.LOCATION_READ,
      SellerPermission.LOCATION_WRITE,
      SellerPermission.ORDER_READ,
      SellerPermission.ORDER_FULFIL,
      SellerPermission.ORDER_CANCEL,
      SellerPermission.RETURN_HANDLE,
      SellerPermission.FINANCE_READ,
      SellerPermission.PAYOUT_SETUP,
      SellerPermission.FULFILMENT_READ,
      SellerPermission.FULFILMENT_WRITE,
      SellerPermission.CARRIER_CREDENTIAL_WRITE,
      SellerPermission.INTEGRATION_READ,
      SellerPermission.INTEGRATION_WRITE,
      SellerPermission.ANALYTICS_READ,
      SellerPermission.AUDIT_READ,
    ]),
  },

  {
    key: SellerRole.CATALOGUE_MANAGER,
    name: 'Catalogue Manager',
    description: 'Listings, brands, product media and offer prices.',
    permissions: Object.freeze([
      SellerPermission.ACCOUNT_READ,
      SellerPermission.LISTING_READ,
      SellerPermission.LISTING_WRITE,
      SellerPermission.LISTING_SUBMIT,
      SellerPermission.OFFER_PUBLISH,
      SellerPermission.OFFER_PRICE_WRITE,
      SellerPermission.BRAND_REQUEST,
      SellerPermission.MEDIA_UPLOAD,
      SellerPermission.BULK_IMPORT,
      // Reads stock because a listing cannot be published without knowing
      // whether any exists. Does not write it.
      SellerPermission.INVENTORY_READ,
      SellerPermission.LOCATION_READ,
      SellerPermission.ANALYTICS_READ,
    ]),
  },

  {
    key: SellerRole.INVENTORY_MANAGER,
    name: 'Inventory Manager',
    description: 'Stock, warehouses, reorder thresholds and stock synchronisation.',
    permissions: Object.freeze([
      SellerPermission.ACCOUNT_READ,
      SellerPermission.LISTING_READ,
      SellerPermission.INVENTORY_READ,
      SellerPermission.INVENTORY_WRITE,
      SellerPermission.INVENTORY_ADJUST,
      SellerPermission.LOCATION_READ,
      // Opening a second warehouse is this role's job, on the same reasoning
      // as `inventory.location.write` in the admin catalogue: it is the person
      // receiving the stock who knows a new place exists.
      SellerPermission.LOCATION_WRITE,
      SellerPermission.ORDER_READ,
      // Reads how each building ships, because a pickup window and a cutoff
      // are facts about the warehouse this role runs. Does not choose the
      // method - that is an account-level decision.
      SellerPermission.FULFILMENT_READ,
      SellerPermission.INTEGRATION_READ,
      SellerPermission.ANALYTICS_READ,
    ]),
  },

  {
    key: SellerRole.ORDER_MANAGER,
    name: 'Order Manager',
    description: 'Orders, dispatch, shipments and returns.',
    permissions: Object.freeze([
      SellerPermission.ACCOUNT_READ,
      SellerPermission.LISTING_READ,
      SellerPermission.INVENTORY_READ,
      SellerPermission.LOCATION_READ,
      SellerPermission.ORDER_READ,
      SellerPermission.ORDER_FULFIL,
      SellerPermission.ORDER_CANCEL,
      SellerPermission.RETURN_HANDLE,
      // Reads which method a consignment is going by, because that is what
      // this role is dispatching. Cannot change the configuration behind it.
      SellerPermission.FULFILMENT_READ,
      SellerPermission.ANALYTICS_READ,
    ]),
  },

  {
    key: SellerRole.FINANCE_VIEWER,
    name: 'Finance Viewer',
    description: 'Settlements, statements and payout history. Read-only.',
    permissions: Object.freeze([
      SellerPermission.ACCOUNT_READ,
      SellerPermission.FINANCE_READ,
      // Reads orders because a settlement line points at one and a statement
      // that cannot be traced to an order cannot be checked.
      SellerPermission.ORDER_READ,
      SellerPermission.ANALYTICS_READ,
    ]),
  },

  {
    key: SellerRole.SUPPORT_MEMBER,
    name: 'Support Member',
    description: 'Reads orders and returns to answer a buyer. Changes nothing.',
    permissions: Object.freeze([
      SellerPermission.ACCOUNT_READ,
      SellerPermission.LISTING_READ,
      SellerPermission.ORDER_READ,
      SellerPermission.INVENTORY_READ,
    ]),
  },
]);

const SELLER_ROLE_BY_KEY = new Map<string, SellerRoleDefinition>(
  SELLER_ROLE_DEFINITIONS.map((definition) => [definition.key, definition]),
);

export function sellerRoleDefinition(key: string): SellerRoleDefinition | undefined {
  return SELLER_ROLE_BY_KEY.get(key);
}

/**
 * What one role may do.
 *
 * A role this file does not know returns an empty set rather than throwing.
 * That is the safe direction: an unknown role grants nothing, so a
 * `SellerMemberRole` added to the schema without a grant here locks its holders
 * out rather than letting them through.
 */
export function permissionsForSellerRole(roleKey: string): ReadonlySet<SellerPermissionKey> {
  return new Set(SELLER_ROLE_BY_KEY.get(roleKey)?.permissions ?? []);
}

export function sellerRoleHas(roleKey: string, permission: SellerPermissionKey): boolean {
  return permissionsForSellerRole(roleKey).has(permission);
}

/**
 * A member may only grant a role whose permissions they themselves hold.
 *
 * Without this, an ADMIN with `MEMBER_WRITE` could mint an OWNER and so grant
 * themselves `AGREEMENT_ACCEPT` - the one permission ADMIN deliberately lacks.
 * Called on every invitation and every role change, exactly as `canGrantRole`
 * is in the admin catalogue.
 */
export function canGrantSellerRole(granterRoleKey: string, targetRoleKey: string): boolean {
  const granter = SELLER_ROLE_BY_KEY.get(granterRoleKey);
  const target = SELLER_ROLE_BY_KEY.get(targetRoleKey);

  if (granter === undefined || target === undefined) return false;
  if (!granter.permissions.includes(SellerPermission.MEMBER_WRITE)) return false;

  const held = new Set<SellerPermissionKey>(granter.permissions);
  return target.permissions.every((permission) => held.has(permission));
}

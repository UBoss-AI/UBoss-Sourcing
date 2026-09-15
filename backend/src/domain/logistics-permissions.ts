/**
 * What somebody may do inside one logistics organisation.
 *
 * A THIRD catalogue, beside `permissions.ts` and `seller-permissions.ts`, and
 * deliberately not an extension of either. The keys in `permissions.ts` grant
 * authority over the MARKETPLACE - every order, every customer, every price.
 * The keys in `seller-permissions.ts` grant authority over one seller's own
 * rows. The keys here grant authority over one CARRIER's own shipments and
 * nothing else.
 *
 * Merging any two of the three would make it possible to write a route that
 * accepts either, and the first such route would let a courier read a price.
 *
 * Every logistics permission is checked together with tenant ownership AND
 * with shipment assignment, never instead of either: `requireLogistics`
 * resolves the caller's membership from the session, every query filters on
 * that partner id, and `assertShipmentAccess` additionally requires a live
 * assignment joining the shipment to that partner. A permission answers "may
 * this person do this kind of thing"; the other two answer "to whose data" and
 * "to which parcel", and only those keep carriers apart.
 */

/**
 * Logistics permission keys, as `resource.action`.
 *
 * Read and write are separate throughout, for the same reason they are in the
 * other two catalogues: a tracking-only user who can read a shipment to answer
 * a customer must not thereby be able to mark it delivered.
 */
export const LogisticsPermission = {
  // --- The organisation itself ---
  /// Read the company record, its service regions, capabilities and SLA policy.
  ORGANISATION_READ: 'logistics.organisation.read',
  /// Change contact details and operating preferences. Regions, capabilities
  /// and SLA are set by the OPERATOR, never by the partner - see the note on
  /// the role table below.
  ORGANISATION_WRITE: 'logistics.organisation.write',

  // --- People ---
  MEMBER_READ: 'logistics.member.read',
  /// Invite, change a role, disable. The one permission that can enlarge the
  /// set of people who hold every other permission, which is why only OWNER
  /// and ADMIN have it.
  MEMBER_WRITE: 'logistics.member.write',

  // --- Shipments ---
  SHIPMENT_READ: 'logistics.shipment.read',
  /// Accept or reject an assignment. Held apart from moving a shipment along,
  /// because accepting one commits the company to an SLA.
  SHIPMENT_ACCEPT: 'logistics.shipment.accept',
  /// Record a status event. The single most consequential key here: it is what
  /// tells a hospital its consignment arrived.
  SHIPMENT_STATUS_WRITE: 'logistics.shipment.status.write',
  /// Raise or update an exception.
  SHIPMENT_EXCEPTION_WRITE: 'logistics.shipment.exception.write',
  /// Export the shipments the caller can already see, as CSV. Its own key
  /// because a screenful of rows and a file of ten thousand are different
  /// acts, and only the second one leaves the building.
  SHIPMENT_EXPORT: 'logistics.shipment.export',

  // --- Paperwork ---
  DOCUMENT_READ: 'logistics.document.read',
  DOCUMENT_WRITE: 'logistics.document.write',
  /// Capture a Proof of Delivery. Separate from a status event because a POD
  /// is evidence rather than a claim, and because a driver holds this while
  /// holding almost nothing else.
  POD_WRITE: 'logistics.pod.write',

  // --- Operations ---
  PICKUP_READ: 'logistics.pickup.read',
  PICKUP_WRITE: 'logistics.pickup.write',
  DISPATCH_READ: 'logistics.dispatch.read',
  DISPATCH_WRITE: 'logistics.dispatch.write',

  // --- People who drive ---
  DRIVER_READ: 'logistics.driver.read',
  DRIVER_WRITE: 'logistics.driver.write',
  /// Put a named driver on a shipment. Held by dispatchers, not by drivers:
  /// a driver who could assign work could assign themselves somebody else's.
  DRIVER_ASSIGN: 'logistics.driver.assign',
  VEHICLE_READ: 'logistics.vehicle.read',
  VEHICLE_WRITE: 'logistics.vehicle.write',

  /// Read one's OWN task list, and nothing else. The one key a DRIVER holds
  /// that no other role needs, and it is narrow on purpose: it authorises the
  /// driver task endpoints, which filter by the caller's own driver profile
  /// before they filter by anything else.
  DRIVER_TASK_READ: 'logistics.driver.task.read',
  /// Start and end a trip, and send location pings while one is running.
  TRIP_WRITE: 'logistics.trip.write',
  /// See where a driver currently is. Deliberately NOT granted to every role
  /// that can read a shipment: a courier's position while they work is
  /// personal data about that person, and reading it is a supervisory act.
  TRIP_LOCATION_READ: 'logistics.trip.location.read',

  // --- Who we carry for ---
  /// The companies this partner ships for, and the counts beside each. Never
  /// their catalogue, their payments or their stock.
  COMPANY_READ: 'logistics.company.read',

  // --- Records ---
  ANALYTICS_READ: 'logistics.analytics.read',
  AUDIT_READ: 'logistics.audit.read',
  /// Read the health of the carrier integration this partner is wired through.
  /// Read-only everywhere: credentials are rotated by the operator.
  INTEGRATION_READ: 'logistics.integration.read',
} as const;

export type LogisticsPermissionKey =
  (typeof LogisticsPermission)[keyof typeof LogisticsPermission];

export const ALL_LOGISTICS_PERMISSIONS: readonly LogisticsPermissionKey[] = Object.freeze(
  Object.values(LogisticsPermission),
);

/**
 * Role keys. These are the `LogisticsPartnerRole` enum members, as strings -
 * the database stores the enum and this file decides what each one may do, so
 * the two must stay in step. A member added to the enum with no entry here
 * holds nothing, which is the safe direction to fail.
 *
 * **`UBOSS_LOGISTICS_ADMIN` is deliberately absent.** The brief lists it
 * beside these six, and it does not belong with them: it is the OPERATOR's own
 * role, held by a member of staff, and it is spelled in `permissions.ts` as
 * `logistics.read` / `logistics.write` / `logistics.assign` /
 * `logistics.integration.write`. Putting it in this catalogue would mean a
 * route could accept "a logistics role" and be satisfied by either a courier's
 * dispatcher or the marketplace's own administrator - which is exactly the
 * merge the header of this file refuses. The two are checked by two different
 * guards against two different tables, and that is what keeps them apart.
 */
export const LogisticsRole = {
  OWNER: 'LOGISTICS_PARTNER_OWNER',
  ADMIN: 'LOGISTICS_PARTNER_ADMIN',
  DISPATCHER: 'DISPATCHER',
  DRIVER: 'DRIVER',
  OPERATIONS_AGENT: 'OPERATIONS_AGENT',
  READ_ONLY_TRACKING_USER: 'READ_ONLY_TRACKING_USER',
} as const;

export type LogisticsRoleKey = (typeof LogisticsRole)[keyof typeof LogisticsRole];

export interface LogisticsRoleDefinition {
  key: LogisticsRoleKey;
  name: string;
  description: string;
  permissions: readonly LogisticsPermissionKey[];
  /**
   * Whether a session held by this role must pass a TOTP challenge before it
   * may do anything.
   *
   * True for the two roles that can change who else is in the organisation.
   * A stolen dispatcher session costs a day of rerouted parcels; a stolen
   * owner session costs every account in the company, permanently.
   */
  requiresMfa: boolean;
}

/**
 * Role -> permission grants.
 *
 * Four restrictions look like omissions and are not:
 *
 *   - **A DRIVER cannot list shipments.** They hold `DRIVER_TASK_READ` and not
 *     `SHIPMENT_READ`, so the only parcels they can reach are the ones on
 *     their own task list. A driver who could list the organisation's
 *     shipments could read the delivery address of every hospital it serves.
 *   - **Nobody but OWNER and ADMIN touches membership.** `MEMBER_WRITE` is the
 *     permission that grants permissions; giving it to a dispatcher means
 *     giving them every other key by way of inviting themselves a second
 *     account.
 *   - **A partner never writes its own service regions, capabilities or SLA.**
 *     Those are the contract between the marketplace and the carrier. A
 *     carrier that could widen its own approved regions could assign itself
 *     work it is not licensed to carry - and this is medical freight.
 *   - **READ_ONLY_TRACKING_USER really is read-only,** and does not hold
 *     `TRIP_LOCATION_READ`. It exists for a customer-service desk that answers
 *     "where is my order"; the answer to that is a milestone, not a courier's
 *     live position.
 */
export const LOGISTICS_ROLE_DEFINITIONS: readonly LogisticsRoleDefinition[] = Object.freeze([
  {
    key: LogisticsRole.OWNER,
    name: 'Partner Owner',
    description:
      'Full control of the logistics organisation, including its people. Cannot change the ' +
      'service regions, capabilities or SLA the marketplace approved it for.',
    permissions: ALL_LOGISTICS_PERMISSIONS,
    requiresMfa: true,
  },

  {
    key: LogisticsRole.ADMIN,
    name: 'Partner Administrator',
    description: 'Runs the company day to day, including its people and its fleet.',
    permissions: Object.freeze([
      LogisticsPermission.ORGANISATION_READ,
      LogisticsPermission.ORGANISATION_WRITE,
      LogisticsPermission.MEMBER_READ,
      LogisticsPermission.MEMBER_WRITE,
      LogisticsPermission.SHIPMENT_READ,
      LogisticsPermission.SHIPMENT_ACCEPT,
      LogisticsPermission.SHIPMENT_STATUS_WRITE,
      LogisticsPermission.SHIPMENT_EXCEPTION_WRITE,
      LogisticsPermission.SHIPMENT_EXPORT,
      LogisticsPermission.DOCUMENT_READ,
      LogisticsPermission.DOCUMENT_WRITE,
      LogisticsPermission.POD_WRITE,
      LogisticsPermission.PICKUP_READ,
      LogisticsPermission.PICKUP_WRITE,
      LogisticsPermission.DISPATCH_READ,
      LogisticsPermission.DISPATCH_WRITE,
      LogisticsPermission.DRIVER_READ,
      LogisticsPermission.DRIVER_WRITE,
      LogisticsPermission.DRIVER_ASSIGN,
      LogisticsPermission.VEHICLE_READ,
      LogisticsPermission.VEHICLE_WRITE,
      LogisticsPermission.TRIP_LOCATION_READ,
      LogisticsPermission.COMPANY_READ,
      LogisticsPermission.ANALYTICS_READ,
      LogisticsPermission.AUDIT_READ,
      LogisticsPermission.INTEGRATION_READ,
    ]),
    requiresMfa: true,
  },

  {
    key: LogisticsRole.DISPATCHER,
    name: 'Dispatcher',
    description:
      'Accepts work, schedules pickups, builds manifests and puts drivers on shipments.',
    permissions: Object.freeze([
      LogisticsPermission.ORGANISATION_READ,
      LogisticsPermission.SHIPMENT_READ,
      LogisticsPermission.SHIPMENT_ACCEPT,
      LogisticsPermission.SHIPMENT_STATUS_WRITE,
      LogisticsPermission.SHIPMENT_EXCEPTION_WRITE,
      LogisticsPermission.SHIPMENT_EXPORT,
      LogisticsPermission.DOCUMENT_READ,
      LogisticsPermission.DOCUMENT_WRITE,
      LogisticsPermission.PICKUP_READ,
      LogisticsPermission.PICKUP_WRITE,
      LogisticsPermission.DISPATCH_READ,
      LogisticsPermission.DISPATCH_WRITE,
      LogisticsPermission.DRIVER_READ,
      LogisticsPermission.DRIVER_ASSIGN,
      LogisticsPermission.VEHICLE_READ,
      // A dispatcher routing a van around a city is the one job that genuinely
      // needs to know where the van is.
      LogisticsPermission.TRIP_LOCATION_READ,
      LogisticsPermission.COMPANY_READ,
      LogisticsPermission.ANALYTICS_READ,
    ]),
    requiresMfa: false,
  },

  {
    key: LogisticsRole.DRIVER,
    name: 'Driver',
    description:
      'Sees their own stops for today, scans packages, updates status and captures Proof of ' +
      'Delivery. Cannot list the organisation’s shipments.',
    permissions: Object.freeze([
      LogisticsPermission.DRIVER_TASK_READ,
      LogisticsPermission.SHIPMENT_STATUS_WRITE,
      LogisticsPermission.SHIPMENT_EXCEPTION_WRITE,
      LogisticsPermission.DOCUMENT_WRITE,
      LogisticsPermission.POD_WRITE,
      LogisticsPermission.TRIP_WRITE,
    ]),
    requiresMfa: false,
  },

  {
    key: LogisticsRole.OPERATIONS_AGENT,
    name: 'Operations Agent',
    description:
      'Works the exception queue: chases delays, corrects addresses, arranges re-delivery.',
    permissions: Object.freeze([
      LogisticsPermission.ORGANISATION_READ,
      LogisticsPermission.SHIPMENT_READ,
      LogisticsPermission.SHIPMENT_STATUS_WRITE,
      LogisticsPermission.SHIPMENT_EXCEPTION_WRITE,
      LogisticsPermission.SHIPMENT_EXPORT,
      LogisticsPermission.DOCUMENT_READ,
      LogisticsPermission.DOCUMENT_WRITE,
      LogisticsPermission.PICKUP_READ,
      LogisticsPermission.DISPATCH_READ,
      LogisticsPermission.DRIVER_READ,
      LogisticsPermission.COMPANY_READ,
      LogisticsPermission.ANALYTICS_READ,
    ]),
    requiresMfa: false,
  },

  {
    key: LogisticsRole.READ_ONLY_TRACKING_USER,
    name: 'Tracking Viewer',
    description:
      'Reads shipments and their timelines to answer a question. Changes nothing, and cannot ' +
      'see where a driver is.',
    permissions: Object.freeze([
      LogisticsPermission.ORGANISATION_READ,
      LogisticsPermission.SHIPMENT_READ,
      LogisticsPermission.DOCUMENT_READ,
      LogisticsPermission.PICKUP_READ,
      LogisticsPermission.COMPANY_READ,
    ]),
    requiresMfa: false,
  },
]);

const LOGISTICS_ROLE_BY_KEY = new Map<string, LogisticsRoleDefinition>(
  LOGISTICS_ROLE_DEFINITIONS.map((definition) => [definition.key, definition]),
);

export function logisticsRoleDefinition(key: string): LogisticsRoleDefinition | undefined {
  return LOGISTICS_ROLE_BY_KEY.get(key);
}

/**
 * What one role may do.
 *
 * A role this file does not know returns an empty set rather than throwing.
 * That is the safe direction: an unknown role grants nothing, so a
 * `LogisticsPartnerRole` added to the schema without a grant here locks its
 * holders out rather than letting them through.
 */
export function permissionsForLogisticsRole(
  roleKey: string,
): ReadonlySet<LogisticsPermissionKey> {
  return new Set(LOGISTICS_ROLE_BY_KEY.get(roleKey)?.permissions ?? []);
}

export function logisticsRoleHas(roleKey: string, permission: LogisticsPermissionKey): boolean {
  return permissionsForLogisticsRole(roleKey).has(permission);
}

/** Whether a session held by this role must pass a TOTP challenge first. */
export function logisticsRoleRequiresMfa(roleKey: string): boolean {
  return LOGISTICS_ROLE_BY_KEY.get(roleKey)?.requiresMfa ?? false;
}

/**
 * A member may only grant a role whose permissions they themselves hold.
 *
 * Without this, an ADMIN with `MEMBER_WRITE` could mint an OWNER and so grant
 * themselves the keys ADMIN deliberately lacks. Called on every invitation and
 * every role change, exactly as `canGrantRole` and `canGrantSellerRole` are.
 */
export function canGrantLogisticsRole(granterRoleKey: string, targetRoleKey: string): boolean {
  const granter = LOGISTICS_ROLE_BY_KEY.get(granterRoleKey);
  const target = LOGISTICS_ROLE_BY_KEY.get(targetRoleKey);

  if (granter === undefined || target === undefined) return false;
  if (!granter.permissions.includes(LogisticsPermission.MEMBER_WRITE)) return false;

  const held = new Set<LogisticsPermissionKey>(granter.permissions);
  return target.permissions.every((permission) => held.has(permission));
}

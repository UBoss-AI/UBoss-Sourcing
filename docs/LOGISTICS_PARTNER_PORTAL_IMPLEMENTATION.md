# UBOSS Logistics Partner Portal — implementation plan and impact analysis

This is the repository-specific plan for adding a portal that third-party
logistics companies sign into. It records what already exists, what is being
added, what is deliberately reused, what is deliberately **not** reused, and
what cannot be finished here without a credential or a decision this repository
does not hold.

It is written before the code, and it is the document to read first when
something in that code looks arbitrary.

## 1. What the repository already has

The portal is not built on an empty floor. These are load-bearing and are
reused rather than duplicated:

| Concern | Where it lives today | How the portal uses it |
|---|---|---|
| Authentication, sessions, CSRF, refresh rotation | `backend/src/http/plugins/auth.ts`, `modules/identity` | One more **audience** of the same machinery. No second login implementation, no second token format. |
| Tenancy pattern | `SellerAccount`/`SellerMember`, `BuyerOrganization`/`BuyerOrganizationMember` | `LogisticsPartner`/`LogisticsPartnerUser` copies the shape exactly: the tenant id comes from the session and from nowhere else. |
| Permission catalogues | `domain/permissions.ts` (marketplace), `domain/seller-permissions.ts` (one seller) | `domain/logistics-permissions.ts` is a **third, separate** catalogue, for the reason stated in the seller file's header. |
| State machines | `domain/order-state-machine.ts`, `domain/schedule-state.ts` | `domain/logistics-shipment-state.ts` follows the same rule: nothing writes `status` except through an assertion. |
| Invitation tokens | `modules/identity/token.service.ts` | Partner users are invited with the same hashed, single-use, expiring `AuthToken`. No password is ever emailed. |
| Errors | `domain/errors.ts` | New codes only. No existing code is repurposed. |
| Audit | `AuditLog` (operator), `SellerAuditLog` (seller) | `LogisticsAuditLog` (partner), for the same reason the seller has its own: an operator's audit trail must not be readable by a tenant. |
| Outbound HTTP with SSRF protection | `infra/outbound-http.ts` | Every carrier adapter call goes through it. |
| Signed inbound webhooks, raw-body capture | `http/app.ts` `RAW_BODY_ROUTES`, `modules/payments` | Carrier webhooks are verified over the untouched bytes, exactly as payment webhooks are. |
| Job queue, lease pattern, dead-letter | `infra/queue`, `JobQueue` | Carrier polling, webhook retry and location-ping retention run as jobs. |
| Object storage, private prefix, signed download tokens | `infra/storage`, `registerExportDownloadRoute` | Labels, PODs and damage photographs are private objects behind short-lived tokens. |
| Money | `domain/money.ts`, BigInt minor units | Rate-card reference figures. No float anywhere. |

Two facts from `CLAUDE.md` shape most of what follows: the database is
**MariaDB 10.4** (no `SKIP LOCKED`, no native UUID, `NULL`s distinct inside a
`UNIQUE` index), and **every business detail is a setting**, because each buyer
of this product runs their own deployment and is its operator.

## 2. The decisions that shape everything else

### 2.1 A logistics partner is a third audience, not a flag on a customer

A seller is a `CUSTOMER` — the same person buys and sells, and that is what
makes "become a seller" reuse a login somebody already has. A logistics partner
is **not**. It is a different company, employing different people, who must
never be able to reach a cart, an order total, a price, a payment method or
another partner's shipment.

So `UserType` gains a third member, `LOGISTICS`, and `UserKind` gains
`'LOGISTICS'`. The consequences are deliberate and they are the point:

- The cookie jar is its own (`uboss_logi_at` / `_rt` / `_csrf`), so a partner
  session cannot overwrite or be mistaken for a staff or shopper session in the
  same browser.
- `authenticate()` already checks the audience **twice** — once against the
  token claim and once against the `users.type` row — so an access token minted
  for the storefront cannot reach a logistics route even if the signing key
  were shared.
- `login()` already refuses a credential presented at the wrong surface before
  the password is compared, so the three surfaces cannot enumerate each other's
  accounts.

This is additive. Every existing row in `users` is `ADMIN` or `CUSTOMER` and
behaves exactly as it did.

### 2.2 The pre-existing `Shipment` model is not touched

`Shipment` today is the operator's dispatch note against an order, and
`SellerShipment` is a seller's. Both are read by the orders module, the reports
module and the customer's own order page. Widening either into a carrier-grade
record would change what those screens mean.

The portal's record is therefore a **new** model, `LogisticsShipment`, which
*links* to an order, a seller order group and an origin warehouse rather than
replacing anything. Where an operator dispatch note and a logistics shipment
describe the same parcel, the logistics shipment carries `shipmentId` pointing
at it.

Every model this feature adds is prefixed `Logistics` or `Carrier`, so a reader
of `schema.prisma` can tell at a glance which tenant owns a table.

### 2.3 Status is an enum plus a transition matrix, never free text

`LogisticsShipmentStatus` has the fifteen forward states and the twelve
exception/terminal states from the brief.
`domain/logistics-shipment-state.ts` owns `assertShipmentTransition`, and no
service writes `status` — the same rule `assertTransition` and
`schedule-state.ts` already enforce, and it matters here for the same reason it
matters there: a shipment changes status inside a webhook handler with nobody
watching, and the state it lands in decides whether a customer is told their
goods arrived.

### 2.4 An event is immutable; the status column is a projection of it

`LogisticsShipmentEvent` rows are append-only. `LogisticsShipment.status` is
maintained from them inside the same transaction that writes the event, so the
timeline is the record and the column is the index.

Duplicate suppression is a database constraint rather than a code path:

- `@@unique([shipmentId, idempotencyKey])` — a client that retries a status
  update under the same key writes at most one event.
- `@@unique([externalEventKey])` — a carrier that redelivers a webhook writes
  at most one event. `externalEventKey` is `NOT NULL` and carries
  `"<provider>:<their id>"` for carrier events and the event's own ULID
  otherwise, because **a MariaDB `UNIQUE` index treats every `NULL` as
  distinct** and a nullable column here would enforce nothing. That is the same
  `variantKey` idiom the schema already uses in three places.

### 2.5 Real-time GPS is prepared, and not faked

Phase 1 ships the tables, the ingestion endpoint, the validation and the
authorisation — and the map says `Live location unavailable` when nothing has
been received. There is no simulated marker anywhere, on the same reasoning as
`SELLER_PAYOUT_PROVIDER_UNCONFIGURED`: a screen that invents a fact is worse
than a screen that admits it does not have one.

### 2.6 Carrier integration is an adapter interface with one real adapter

The adapter interface names every operation from the brief. The only adapter
shipped as *working* is `MANUAL`, which is the UBOSS logistics partner doing
the work in this portal. DHL, FedEx and UPS adapters exist as declared
providers whose methods answer `CARRIER_PROVIDER_UNCONFIGURED` until the
deployment supplies credentials — never a fabricated success.

## 3. Data model added

All new models live at the end of `backend/prisma/schema.prisma` behind a
banner, in one migration
(`20260915120000_logistics_partner_portal`), for the same reason the Seller Hub
was one migration: the tables are mutually dependent through foreign keys, and
splitting them produces intermediate states that cannot have their constraints
added.

**Tenancy and people**
`LogisticsPartner`, `LogisticsPartnerUser`, `LogisticsPartnerInvitation`,
`LogisticsServiceRegion`, `LogisticsCapability`, `LogisticsSlaPolicy`.

**The shipment**
`LogisticsShipment`, `LogisticsShipmentPackage`, `LogisticsShipmentAssignment`,
`LogisticsShipmentEvent`, `LogisticsShipmentException`,
`LogisticsShipmentDocument`, `LogisticsProofOfDelivery`.

**Operations**
`LogisticsPickupRequest`, `LogisticsDispatchManifest`,
`LogisticsDispatchManifestEntry`, `LogisticsDriverProfile`,
`LogisticsVehicle`, `LogisticsDriverAssignment`, `LogisticsActiveTrip`,
`LogisticsLocationPing`.

**Integration**
`CarrierIntegration`, `CarrierStatusMapping`, `CarrierWebhookEvent`.

**Records**
`LogisticsNotification`, `LogisticsAuditLog`.

**Impact on existing tables**

- `UserType` gains `LOGISTICS`. Additive; no existing row changes.
- `Session` gains `mfaVerifiedAt DATETIME(3) NULL`. Additive and nullable; it
  is read only by the logistics guard.
- `AuthTokenType` gains nothing — partner invitations reuse `INVITATION`.
- `InventoryLocation`, `Order`, `SellerOrderGroup`, `Shipment`, `Address` gain
  nothing at all. The link is held on `LogisticsShipment`, so an existing order
  behaves exactly as it does today whether or not a logistics partner ever
  touches it.

**GDPR.** `LogisticsPartnerUser`, `LogisticsDriverProfile`,
`LogisticsLocationPing` and `LogisticsAuditLog` all name a person, so
`tests/unit/export-bundle-completeness.test.ts` fails until the Art. 15 bundle
accounts for each. It is added as two disclosed sections
(`logisticsMembership`, `logisticsLocationHistory`) and one withheld section
(`logisticsAuditTrail`) with the reason on the manifest. `LocationPing` is the
most sensitive personal data this feature creates and is disclosed in full,
subject to the retention window below.

## 4. Domain rules given their own module

- `domain/logistics-shipment-state.ts` — the canonical status list, the
  transition matrix, which actor may request which move, which moves demand a
  reason, and `assertShipmentTransition`.
- `domain/logistics-permissions.ts` — the seven roles from the brief and their
  grants.
- `domain/carrier-status-map.ts` — provider event code → UBOSS canonical
  status, with `UNMAPPED_EXTERNAL_EVENT` as the explicit answer for anything
  unknown, so an unrecognised carrier code is preserved and flagged rather than
  crashing or being silently discarded.
- `infra/totp.ts` — RFC 6238 TOTP, because MFA is required for partner owners
  and admins and the repository has the columns (`users.mfaSecretEnc`,
  `users.mfaEnabledAt`) but no implementation.

## 5. Surfaces

### 5.1 A third frontend application, `apps/logistics-web`

Not a section of the admin panel and not a section of the storefront. It has a
different audience, a different cookie jar, a different origin in `CORS`, and a
different deployment story — a carrier's dispatcher signs into it and must not
be able to reach the operator's console by editing a path. Modelled on
`apps/admin-web`, which is the closest existing analogue.

Routes: `/login`, `/activate`, `/mfa`, `/dashboard`, `/shipments`,
`/shipments/:id`, `/companies`, `/pickups`, `/dispatch`, `/exceptions`,
`/drivers`, `/driver/tasks`.

### 5.2 `apps/admin-web` gains the operator's side

`/logistics/partners`, `/logistics/partners/:id`, `/logistics/shipments`,
`/logistics/exceptions`, `/logistics/integrations`, guarded by new keys in the
existing admin catalogue (`logistics.read`, `logistics.write`,
`logistics.assign`, `logistics.integration.write`).

Nothing is removed from either app.

## 6. Security posture

Stated as controls rather than as intentions, because each one is testable:

1. **Tenant id never appears in a request.** No route takes a
   `logisticsPartnerId`. `resolveLogisticsMembership` derives it from the
   session, and every query filters on it. Cross-tenant access is not
   expressible, not merely checked for.
2. **Shipment authorisation is assignment, not merely tenancy.** Loading a
   shipment checks that an active `LogisticsShipmentAssignment` joins it to the
   caller's partner. A cancelled assignment leaves the shipment readable as
   history and refuses every write.
3. **A driver sees their own tasks.** `DRIVER` is additionally filtered by
   `LogisticsDriverAssignment`, so one driver cannot read another's stops.
4. **404, not 403, for a shipment belonging to somebody else** — the rule
   `assertOwnership` already follows, for the same reason.
5. **MFA is enforced server-side, per session.** For `LOGISTICS_PARTNER_OWNER`
   and `LOGISTICS_PARTNER_ADMIN` the guard refuses every route but `/auth/me`,
   `/auth/mfa/*` and `/auth/logout` until the session has passed a challenge —
   the same shape as `mustChangePassword` and `LOCATION_REQUIRED`, and for the
   same reason: a control that exists only in a screen is a suggestion.
6. **Every mutation revalidates the transition.** The form shows the allowed
   next states because `allowedShipmentTransitions` told it to; the endpoint
   asks the same function again.
7. **Documents are private objects behind short-lived signed tokens.** A
   signature image is never a public URL.
8. **Webhooks are verified over raw bytes**, with a timestamp window and a
   replay table keyed on the provider's own event id.
9. **Secrets are environment or encrypted-at-rest columns.** No carrier
   credential is logged, returned by an API, or stored in plaintext.
10. **Coordinates, OTPs and tokens are redacted from logs** — added to the
    existing `infra/logger.ts` redaction list.

## 7. What cannot be finished in this repository

Honest list, and each one is a *configuration-required state* in the product
rather than a silent failure or a fake success:

| Gap | What the product does instead |
|---|---|
| No DHL/FedEx/UPS credentials | The provider is selectable, the adapter exists, and every call answers `CARRIER_PROVIDER_UNCONFIGURED` naming the environment variables. No shipment is ever marked created at a carrier that was not called. |
| No malware scanner | A document upload records `scanState`. With no scanner configured the deployment's policy decides: refuse the upload, or accept it marked `SKIPPED`. Never marked clean. |
| No SMS driver | Delivery OTP is delivered by email, exactly as the repository's existing phone-change code is. The seam is one function. |
| No WebSocket layer | Live location is read by polling a documented endpoint. The fan-out point is one service function, named in §12 of the brief. |
| No geospatial index in MariaDB 10.4 for this shape | Geofence checks are computed with the existing `@turf/*` helpers the warehouse geofencing already uses. |

## 8. Test plan

`backend/tests/unit` gains: the transition matrix, the permission matrix,
carrier status mapping (including the unmapped case), TOTP vectors from
RFC 6238, the SLA calculator, the masking rules, and the idempotency-key
derivation. `backend/tests/integration` gains: tenant isolation, IDOR on
shipment ids, assignment accept/reject, duplicate status events, duplicate
webhooks, replay rejection, invalid coordinates, and stale-timestamp rejection.

## 9. Rollback

The migration only **adds**. Rolling back is `DROP TABLE` on the new tables plus
`ALTER TABLE users MODIFY type ENUM('ADMIN','CUSTOMER')` and
`ALTER TABLE sessions DROP COLUMN mfaVerifiedAt`, in that order, and is safe on
any deployment that has not invited a partner. The down script is written into
the migration as a comment, as the repository's other migrations do.

# Logistics Partner Portal — what was built, and what was not

The companion to `LOGISTICS_PARTNER_PORTAL_IMPLEMENTATION.md`, which is the
plan. This is the account of what the plan turned into, written after the
work, including the three defects found while checking it in a browser and what
was done about them.

Everything below was run on this machine. Where a number appears, it came out
of a command, not an estimate.

---

## 1. Changed files

### New applications and modules

| Path | What it is |
|---|---|
| `apps/logistics-web/` | The carrier's own application. React 19 + Vite 6, port 5175, its own cookie jar (`uboss_logi_*`), 11 screens. |
| `apps/admin-web/src/pages/logistics/` | Six operator screens inside the existing console. |
| `apps/admin-web/src/lib/logistics.ts` | The operator side's types and API calls. |
| `backend/src/modules/logistics/` | 17 services: partner, assignment, shipment, shipment events, shipment creation, exceptions, operations, driver, trip, document, proof of delivery, dashboard, SLA sweep, MFA, notifications, audit, and the carrier adapter, registry and webhook handler. |
| `backend/src/domain/logistics-shipment-state.ts` | 27 statuses and the only path any of them is written by. |
| `backend/src/domain/logistics-permissions.ts` | The carrier's own six roles. |
| `backend/src/domain/logistics-masking.ts` | Who may see a telephone number whole. |
| `backend/src/domain/logistics-sla.ts` | On track, at risk, missed. |
| `backend/src/domain/carrier-status-map.ts` | One carrier's vocabulary into ours, and what happens to a code nobody has mapped. |
| `backend/src/infra/totp.ts` | RFC 6238, implemented against the specification's own test vectors. |
| `backend/src/http/plugins/logistics.ts` | The session, permission and MFA gates every portal route sits behind. |
| `backend/src/http/routes/logistics.{portal,operations,driver,admin}.ts` | 71 routes. |
| `backend/src/http/routes/carrier-webhooks.ts` | Where a carrier posts. Unauthenticated by necessity; the signature is the guard. |
| `backend/src/seed/logistics.ts` | A development carrier and four consignments. Only where the portal is switched on, and never in production. |

### Modified

`backend/prisma/schema.prisma`, `backend/src/config/env.ts`,
`backend/src/domain/errors.ts`, `backend/src/domain/permissions.ts`,
`backend/src/http/app.ts`, `backend/src/http/plugins/auth.ts`,
`backend/src/http/routes/auth.ts`, `backend/src/infra/logger.ts`,
`backend/src/infra/queue/types.ts`, `backend/src/modules/audit/audit.service.ts`,
`backend/src/modules/identity/{auth,session,token}.service.ts`,
`backend/src/modules/notifications/admin-notification.service.ts`,
`backend/src/modules/privacy/export-bundle.service.ts`,
`backend/src/seed/index.ts`, `backend/src/worker/{handlers,index}.ts`,
`backend/tests/unit/export-bundle-completeness.test.ts`,
`apps/admin-web/src/{app/router.tsx,components/icons.tsx,layout/navigation.ts,layout/NotificationBell.tsx,lib/permissions.ts,i18n/locales/en.json}`,
`scripts/dev-stack.ps1`, `scripts/build-feature-guide-doc.mjs`, `CLAUDE.md`,
`SETUP.md`, `PROJECT-GUIDE.md`, `PROJECT-GUIDE.hinglish.md`,
`backend/.env.example`.

Nothing was removed. No existing behaviour was changed except where a new
audience had to be admitted — `UserType`, `ActorType`, the CORS allowlist and
the shared `/auth/me` route, each noted in the diff.

---

## 2. Database

Two migrations, both additive.

| Migration | What it does |
|---|---|
| `20260915120000_logistics_partner_portal` | 26 new tables, 51 foreign keys; `users.type` gains `LOGISTICS`; `users` gains `mfaLastCounter` and `mfaRecoveryCodeHashesJson`; `sessions` gains `mfaVerifiedAt`. |
| `20260915123000_logistics_actor_type` | Widens `actorType` on `audit_logs`, `order_status_history`, `inventory_movements` and `seller_audit_logs` to admit a carrier as an actor. |

The schema is now **170 tables, 136 enums, 45 migrations**. `prisma migrate
status` on the development database reports "Database schema is up to date!".

### New models

`LogisticsPartner`, `LogisticsPartnerUser`, `LogisticsPartnerInvitation`,
`LogisticsServiceRegion`, `LogisticsCapability`, `LogisticsSlaPolicy`,
`LogisticsShipment`, `LogisticsShipmentPackage`, `LogisticsShipmentAssignment`,
`LogisticsShipmentEvent`, `LogisticsShipmentException`,
`LogisticsShipmentDocument`, `LogisticsProofOfDelivery`,
`LogisticsPickupRequest`, `LogisticsDispatchManifest`,
`LogisticsDispatchManifestEntry`, `LogisticsDriverProfile`,
`LogisticsVehicle`, `LogisticsDriverAssignment`, `LogisticsActiveTrip`,
`LogisticsLocationPing`, `LogisticsNotification`, `LogisticsAuditLog`,
`CarrierIntegration`, `CarrierStatusMapping`, `CarrierWebhookEvent`.

### The constraints that carry the rules

- `LogisticsShipmentEvent` has `@@unique([shipmentId, idempotencyKey])` and
  `@@unique([externalEventKey])`. **Both columns are `NOT NULL`** with a
  computed surrogate when there is nothing to put in them, because MariaDB
  treats every `NULL` in a `UNIQUE` index as distinct — a nullable column there
  would enforce nothing at all.
- `LogisticsShipment.trackingNumber` and `.shipmentReference` are unique.
- `LogisticsShipment.version` is an optimistic-concurrency column; writes are
  conditional `updateMany`s that check the affected-row count.
- Money is `BigInt` minor units with its own currency column. Coordinates are
  `Decimal(9,6)`. Neither is ever a float.
- `LogisticsLocationPing` is kept apart from every audit table: it is
  high-volume and disposable, and the worker deletes it on a retention policy.

---

## 3. Pages and routes

### The carrier's application (port 5175)

`/login`, `/activate`, `/dashboard`, `/shipments`, `/shipments/:id`,
`/pickups`, `/dispatch`, `/exceptions`, `/companies`, `/drivers`, `/company`,
`/driver/tasks`.

`/` redirects by role rather than to a fixed screen: a driver holds no
permission the dashboard needs, so sending them there would land them on the
one page they cannot open.

### The operator's screens (inside the admin console, port 5173)

`/logistics/shipments`, `/logistics/shipments/:id`, `/logistics/exceptions`,
`/logistics/partners`, `/logistics/partners/:id`, `/logistics/integrations`.

They appear under a **Logistics** group in the sidebar, visible to anybody
holding `logistics.read`.

---

## 4. API

71 routes. Portal routes are under `/api/v1/logistics`, operator routes under
`/api/v1/admin/logistics`, and the carrier webhook under
`/api/v1/integrations/carriers`.

### The carrier's portal — `/api/v1/logistics`

```
GET    /auth/me                              POST   /auth/mfa/setup
POST   /auth/mfa/verify                      GET    /dashboard
GET    /shipments                            GET    /shipments/export
GET    /shipments/:id                        GET    /shipments/:id/timeline
POST   /shipments/:id/accept                 POST   /shipments/:id/reject
POST   /shipments/:id/status-events          POST   /shipments/:id/exceptions
GET    /shipments/:id/documents              POST   /shipments/:id/documents
POST   /documents/:id/link                   GET    /shipments/:id/proof-of-delivery
POST   /shipments/:id/proof-of-delivery      GET    /shipments/:id/live-location
GET    /companies                            GET    /organisation
PATCH  /organisation                         GET    /members
PATCH  /members/:id                          GET    /notifications
POST   /notifications/read                   GET    /audit
```

Plus the shared sign-in routes at `/api/v1/logistics/auth` — the same
`authRoutes` factory the other two audiences use, not a second implementation.

### Operations — `/api/v1/logistics`

```
GET    /pickups                              POST   /pickups
POST   /pickups/:id/confirm                  POST   /pickups/:id/complete
POST   /pickups/:id/fail                     GET    /dispatch-manifests
POST   /dispatch-manifests                   GET    /dispatch-manifests/:id
POST   /dispatch-manifests/:id/handover      GET    /exceptions
PATCH  /exceptions/:id                       GET    /drivers
POST   /drivers                              GET    /vehicles
POST   /vehicles                             POST   /shipments/:id/assign-driver
GET    /packages/lookup                      POST   /packages/:id/scan
```

### Driver — `/api/v1/logistics`

```
GET    /driver/tasks                         POST   /driver/location-consent
POST   /driver/trips                         POST   /driver/trips/:id/end
POST   /driver/location-pings
```

### The marketplace — `/api/v1/admin`

```
GET    /logistics/partners                   GET    /logistics/partners/:id
POST   /logistics/partners                   POST   /logistics/partners/:id/status
PUT    /logistics/partners/:id/regions       POST   /logistics/partners/:id/capabilities
PUT    /logistics/partners/:id/sla-policies  POST   /logistics/partners/:id/invitations
GET    /logistics/shipments                  GET    /logistics/shipments/:id
POST   /logistics/orders/:id/shipments       GET    /logistics/shipments/:id/eligible-partners
POST   /logistics/shipments/:id/assign       POST   /logistics/shipments/:id/withdraw
POST   /logistics/shipments/:id/correct-status
GET    /logistics/exceptions                 GET    /logistics/integrations
PUT    /logistics/integrations               POST   /logistics/integrations/:id/test
POST   /logistics/integrations/:id/rotate-secret
PUT    /logistics/integrations/:id/status-mappings
GET    /logistics/integrations/known-codes
```

### Carrier webhook

```
POST   /api/v1/integrations/carriers/:pathToken/webhook
```

---

## 5. Roles and permissions

### Inside a carrier

| Role | Permissions | Second factor |
|---|---|---|
| `LOGISTICS_PARTNER_OWNER` | 28 | **Required** |
| `LOGISTICS_PARTNER_ADMIN` | 26 | **Required** |
| `DISPATCHER` | 18 | Offered |
| `DRIVER` | 6 | Offered |
| `OPERATIONS_AGENT` | 12 | Offered |
| `READ_ONLY_TRACKING_USER` | 5 | Offered |

Required means required: an owner who has not set one up reaches the
enrolment screen and nothing else. Verified in a browser — see §9.

### On the marketplace's side

| Permission | What it grants | Which staff roles hold it |
|---|---|---|
| `logistics.read` | Read carriers, consignments, exceptions, connections | Business Owner, Inventory Manager, Order Manager |
| `logistics.write` | Create a carrier, approve a capability, set regions and SLA, invite, suspend | Business Owner |
| `logistics.assign` | Offer a consignment, take it back, correct a status | Business Owner, Order Manager |
| `logistics.integration.write` | Configure a carrier connection, rotate its secret | Business Owner |

An Order Manager can put work on a carrier and cannot sign a contract with
one; neither they nor an Inventory Manager can touch a credential.

---

## 6. Status transitions

27 statuses, 150 distinct edges, and one function (`assertShipmentTransition`)
that every write goes through.

**The rules that matter**

- `ASSIGNED` cannot become `DELIVERED`. Every step between is a step.
- A carrier cannot reverse `DELIVERED`, `RETURNED`, `LOST` or `CANCELLED`.
- The marketplace can, through one door — `correct-status` — which demands a
  reason of at least eight characters and writes an event flagged
  `isCorrection`.
- `RETURNED` and `LOST` are the only true dead ends. `CANCELLED` and
  `DELIVERED` keep one exit each, into the return workflow, because a returned
  parcel is a real thing that happens after both.
- Every transition names the actors allowed to make it and, for a carrier,
  the permission it needs.

---

## 7. Environment variables

Documented in `backend/.env.example` with the reasoning beside each.

| Variable | Default | Effect |
|---|---|---|
| `FEATURE_LOGISTICS_PORTAL` | `false` | The whole feature. Off means no sign-in, every route refuses, no carrier can be created, and the sidebar group is absent |
| `LOGISTICS_WEB_ORIGIN` | `http://localhost:5175` | The CORS allowlist entry |
| `LOGISTICS_WEB_PUBLIC_URL` | — | Where an activation link points. **Required when the flag is on** — the process refuses to start without it |
| `LOGISTICS_INVITE_TTL_HOURS` | `48` | How long an activation link works. Single-use regardless |
| `LOGISTICS_ASSIGNMENT_RESPONSE_HOURS` | `24` | How long a carrier has to accept |
| `LOGISTICS_DOCUMENT_URL_TTL_SECONDS` | `300` | Signed document links, proof-of-delivery images included |
| `LOGISTICS_ALLOW_UNSCANNED_DOCUMENTS` | `false` | Accept an upload no scanner has seen |
| `LOGISTICS_WEBHOOK_MAX_ATTEMPTS` | `6` | Retries before dead-lettering |
| `LOGISTICS_CARRIER_FAILURE_THRESHOLD` | `5` | Failures before a connection shows as degraded |
| `LOGISTICS_TRIP_TOKEN_TTL_HOURS` | `14` | A driver's device token: a shift, not a week |
| `LOGISTICS_PING_INTERVAL_SECONDS` | `60` | How often a device is asked to report while on duty |
| `LOGISTICS_PING_MAX_AGE_MINUTES` | `120` | Older than this is refused, not backdated |
| `LOGISTICS_PING_MAX_SPEED_KMH` | `200` | An implied speed above this is refused as impossible |
| `RETENTION_LOGISTICS_LOCATION_PING_DAYS` | `30` | How long positions are kept. `0` means forever |

Carrier credentials are **not** among them, and that is the point: they belong
in a secrets manager.

| Provider | Variables |
|---|---|
| DHL | `DHL_API_KEY`, `DHL_API_SECRET`, `DHL_ACCOUNT_NUMBER` |
| FedEx | `FEDEX_CLIENT_ID`, `FEDEX_CLIENT_SECRET`, `FEDEX_ACCOUNT_NUMBER` |
| UPS | `UPS_CLIENT_ID`, `UPS_CLIENT_SECRET`, `UPS_ACCOUNT_NUMBER` |
| Custom | The connection's own base URL, credential and status mapping |
| Manual | Nothing. It is not an API. |

---

## 8. Carrier integration and webhooks

One interface, whoever the carrier is: `createShipment`, `cancelShipment`,
`getRates`, `schedulePickup`, `cancelPickup`, `getTracking`,
`getProofOfDelivery`, `generateLabel`, `validateAddress`.

**Setting one up.** Logistics → Carrier connections → Add a connection. Pick
the provider; if it needs credentials the dialog says so before anything is
saved and names them. Save, then Test it. An unconfigured provider reports a
failure, in these words:

> DHL has no credentials on this installation. Add them, then test again. Until
> then, no shipment will be sent to this carrier and nothing will be reported
> as booked with it.

**Webhook setup.** Press "New signing secret". The secret is shown once, with
the URL the carrier posts to, and there is no endpoint that reads it back.
Paste both into the carrier's console. A post is accepted only when the HMAC
over the raw bytes matches in constant time, the timestamp inside the signed
payload is within tolerance, and the provider's event id has not been seen.

**An unknown status code never crashes anything.** The original is kept whole,
the event is queued as `UNMAPPED_EXTERNAL_EVENT`, operations are told, and the
mapping screen is where somebody gives it a meaning. Every mapped event keeps
the carrier's own code beside the status it became.

---

## 9. What was checked in a browser, and the three defects it found

The stack was brought up with `scripts/dev-stack.ps1 -Restart -Local`, seeded,
and walked through with a real session. Three things were wrong, and none of
them would have been found by a type-checker or a lint rule.

### 1. The QR code was a blank white square

Signing in as an owner reaches the second-factor enrolment. The secret was
printed, the code field was there, and where the QR code should have been was
an empty white box. Nothing was red, nothing was in the console, and the screen
looked finished.

The encoder's version table stopped at 10, on a comment that claimed an
`otpauth://` URI could not exceed 200 bytes. The real one was **215** — the URI
carries the deployment's own name twice, percent-encoded. The encoder threw,
and the component's deliberate fall-back (the secret is printed beside it, so a
person can still type it in) meant the failure was invisible.

Fixed by extending the tables to version 14, which is roughly 355 bytes —
about twice the longest URI a plausible business name produces.

### 2. The dark module was being cleared

Found by the test written for the first defect. The reservation loop for the
second format-information copy ran to eight modules on both sides; down column
8 it is seven, because the eighth position is the dark module, which the
specification requires and which the loop was overwriting with light.

A code without it still decodes on most readers, so nothing would have looked
wrong until one refused it.

### 3. The seed could not finish a run it had started

The shipment seed guarded on a count of the carrier's work, so a run that
failed halfway through could never be completed: the rows the first attempt
created satisfied the guard and the ones it never reached were never made.
Re-keyed per consignment.

`apps/logistics-web` gained a test runner (vitest + jsdom, the same shape the
storefront uses) as part of fixing the first two. The QR test **decodes what
the encoder draws** — walks the same zigzag, removes the mask, de-interleaves
the blocks and asserts the bytes are the bytes that went in. "It returned a
grid and did not throw" is satisfied by noise; this is not.

### What else was verified in the browser

| Checked | Result |
|---|---|
| Carrier dashboard counters | Match the seeded data exactly; all aggregated server-side |
| Shipment list, filters, detail, timeline | Work, with event sources labelled |
| "Live location unavailable" | Shown. No fake marker, no interpolated position |
| Route in words beside the schematic | Present on every consignment |
| Operator: consignments, detail, carriers, carrier detail, exceptions, connections | All six work |
| Offering, taking back, correcting | Present and permission-gated |
| DHL connection test with no credentials | Reported as a failure, naming the variables |
| Signing-secret rotation | Shown once, with the notice |
| Owner sign-in without a second factor | Cannot reach any screen but enrolment |
| Full TOTP enrolment with a real RFC 6238 code | Accepted; signed in |
| Console errors | None |

---

## 10. Tests

### Backend — `cd backend && npm run verify`

```
Test Files  107 passed (107)
     Tests  2186 passed (2186)
```

Typecheck and lint clean. Of those, the logistics work adds 163:

| File | Tests | What it holds |
|---|---|---|
| `unit/logistics-shipment-state.test.ts` | 22 | The transition matrix, including the refusals |
| `unit/logistics-permissions.test.ts` | 16 | The six roles and what each may do |
| `unit/carrier-status-map.test.ts` | 17 | Provider codes, and the unmapped case |
| `unit/totp.test.ts` | 19 | RFC 6238's own vectors, replay, recovery codes |
| `unit/logistics-sla.test.ts` | 15 | On track, at risk, missed, and no history |
| `unit/logistics-masking.test.ts` | 20 | Who sees a telephone number whole |
| `integration/logistics-tenant-isolation.test.ts` | 13 | One carrier cannot reach another's anything |
| `integration/logistics-carrier-webhook.test.ts` | 13 | Signature, replay, duplicates, unknown codes |
| `integration/logistics-driver-location.test.ts` | 16 | Consent, duty, invalid coordinates, stale time |
| `integration/logistics-admin-oversight.test.ts` | 12 | The operator routes, over HTTP, with real sessions |

### Frontends

```
apps/logistics-web   Test Files 2 passed    Tests 19 passed
apps/customer-web    Test Files 41 passed   Tests 500 passed
apps/admin-web       (no test runner; typecheck, lint, contrast audit, build)
```

All four packages pass `npm run verify`: typecheck, lint, contrast audit where
one exists, tests where they exist, and a production build.

### Contrast

`npm run audit:contrast` in `apps/logistics-web`: **no failures, in either
theme**. The three exemptions are recorded with the reason, as in the other
apps.

### Responsive and accessibility

Swept with a same-origin iframe harness at **390×844** and **834×1112** —
`resize_window` cannot narrow the viewport on this machine, which is why the
harness exists.

| Sweep | Routes | Result |
|---|---|---|
| Portal, sideways scroll and elements crossing the right edge | 8 × 2 widths | 0 and 0 everywhere |
| Operator screens, same | 4 × 2 widths | 0 and 0 everywhere |
| One `h1` per page, no heading-level jumps | 10 routes | Clean |
| Every form control labelled | 10 routes | 0 unlabelled |
| Buttons and links with an accessible name | 6 routes | 0 nameless |
| Live regions for status announcements | 6 routes | 2–3 per page |
| Touch targets on a phone | 6 routes | One hit: the skip link, which is `sr-only` at rest and 162×20 when focused — correct, not a fault |

### Screenshots

`docs/logistics-screenshots/`, seven of them: the portal dashboard, the
shipment list, the operator's consignments, the carrier connections screen
with DHL unconfigured, the MFA enrolment with a working QR code, and two
side-by-side tablet-and-phone captures.

---

## 11. Security controls

| Control | Where |
|---|---|
| Three audiences, three cookie jars, audience checked twice | `plugins/auth.ts`, `plugins/logistics.ts` |
| Second factor compulsory for owners and administrators | `logistics-permissions.ts`, enforced in `requireLogistics` |
| TOTP against RFC 6238, with a spent-counter replay guard | `infra/totp.ts` |
| QR drawn in the browser, so the secret never crosses a network | `apps/logistics-web/src/lib/qr.ts` |
| Tenant isolation from the session only; no partner id in any route | `partner.service.ts` |
| Assignment authorisation on every consignment read and write | `shipment.service.ts` |
| Another carrier's row answers 404, not 403 | `assertShipmentAccess` |
| Idempotency by UNIQUE constraint, never check-then-insert | `shipment-event.service.ts` |
| Optimistic concurrency on the shipment row | `version` column + conditional update |
| Contact masking by role and active need | `logistics-masking.ts` |
| Signed webhooks over raw bytes, constant time, with replay prevention | `carrier/webhook.service.ts` |
| Credentials encrypted with the row's id as additional data | `carrier/registry.ts` |
| Signing secret shown once, never read back | `rotateWebhookSecret` |
| Short-lived signed document URLs, malware-scan hook in front | `document.service.ts` |
| Proof-of-delivery images never on a guessable path | `pod.service.ts` |
| Device-scoped, shift-length driver tokens, consent recorded | `trip.service.ts` |
| No token, code, password or coordinate in a normal log line | `infra/logger.ts` redaction |
| Audit row for every consequential action | `LogisticsAuditLog` |
| Activation links: hashed, single-use, expiring; no password ever emailed | `partner.service.ts`, `token.service.ts` |

---

## 12. Remaining production blockers

Each is a **configuration-required state** in the product, not a silent
failure and never a fake success.

| Blocker | What the product does |
|---|---|
| No DHL, FedEx or UPS credentials | The provider is selectable, the adapter exists, and every call refuses naming the variables. Nothing is ever reported as booked with a carrier that was not called. |
| No malware scanner | An upload records its scan state. With none configured and `LOGISTICS_ALLOW_UNSCANNED_DOCUMENTS` off — the default — the upload is refused. It is never marked clean. |
| No SMS driver | Delivery OTP goes by email, as the existing phone-change flow does. |
| Live GPS | Not implemented, and nothing suggests it is. The endpoint, the device token, the consent record, the validation and the retention policy exist; the tracking does not. |
| No WebSocket layer | Live location is polled from a documented endpoint. The fan-out point is one service function. |

---

## 13. Deployment

1. `LOGISTICS_WEB_PUBLIC_URL` must be set before `FEATURE_LOGISTICS_PORTAL` is
   turned on. The process refuses to start otherwise, on purpose: an
   invitation email with no address in it is a person who cannot get in.
2. `npm run db:migrate:deploy`. Both migrations are additive and take no
   exclusive lock on an existing table beyond the three `ALTER`s.
3. Build and serve `apps/logistics-web` on its own hostname. Nothing proxies
   it — a carrier reaches it directly, which is why it has no `base` rewriting.
4. Add the new origin to the CORS allowlist via `LOGISTICS_WEB_ORIGIN`.
5. The worker picks up the SLA sweep, the assignment expiry and the location
   retention job with no further configuration.

### Rollback

The migration only adds, so rolling back is:

```sql
-- the 26 new tables, children first (the order is in the migration's own
-- ROLLBACK comment)
ALTER TABLE users MODIFY type ENUM('ADMIN','CUSTOMER');
ALTER TABLE sessions DROP COLUMN mfaVerifiedAt;
```

Safe on any deployment that has not yet invited a carrier. With the feature
flag off, leaving the tables in place costs nothing.

### The GPS phase, when it comes

The shape is already there: `LogisticsActiveTrip`, `LogisticsLocationPing`,
the device token, the consent record, and the validation that refuses an
impossible speed or a stale timestamp. What is missing is the push layer and a
map that draws a live position. When it is built, the retention policy and the
restriction on raw coordinates are already written and should not be relaxed
to make it easier.

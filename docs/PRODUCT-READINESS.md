# What is actually built

**UBOSS Sourcing — capability audit against the product brief**

Version 1.1 · 2026-09-16 · Repository at `28b89fe`

*1.1 — `ASSISTANT_ALLOW_GUESTS` now defaults to `false`, which closes the one
deviation from the brief that was a setting rather than a decision. §2.3, §3.*

*1.2 (2026-09-24) — M4 (erasure) and M7 (malware scanning) were built after
this audit and are marked as such in §4. The rest of the audit is unchanged.*

---

## What this document is for

`docs/DEPLOYMENT.md` answers *"can this be put on a server safely?"*. This one
answers the question underneath it: **"is the thing being deployed the thing the
product description says it is?"**

They are different questions and they have different failure modes. A system can
be perfectly deployable and still be missing the feature somebody sold. So this
audit walks the product brief capability by capability and says, for each one,
what the repository actually contains — with the file that proves it.

**Nothing here is inferred from a name.** A model called `SellerPayout` does not
mean sellers get paid; it means there is a table. Where the evidence stops, the
classification stops with it.

### How to read the classifications

| | Meaning |
|---|---|
| **Built** | Implemented and verified in the source. Routes, service and data model all present, and the tests exercise it |
| **Partial** | Some of it works. The row says which part, and which part does not |
| **Off by default** | Built, and switched off until somebody turns it on. The row names the flag |
| **Unconfigured by design** | Built to a provider boundary that this repository deliberately leaves empty, and which **refuses rather than pretending**. Not a gap — a decision |
| **Not built** | No implementation found |
| **Unverified** | Could not be established from the repository in this session, and is not claimed either way |

Evidence markers are the same as `DEPLOYMENT.md`: **[VR]** verified by reading
the repository, **[OD]** an owner decision.

---

## 1. Surfaces, and who may reach them

| Surface | Status | Evidence |
|---|---|---|
| Customer storefront | **Built** | `apps/customer-web` **[VR]** |
| Seller Hub | **Built** — a `/seller` route group inside the storefront application, not a fourth build. A seller is a customer account with a seller organisation attached, so it reuses that session rather than inventing another | `apps/customer-web/src/pages/seller/`, `backend/src/http/routes/seller.*.ts` **[VR]** |
| A seller's own shop front | **Built** — resolved from the `Host` header, one subdomain per seller | `app.ts` hook 1a **[VR]** |
| Admin console | **Built** | `apps/admin-web` **[VR]** |
| Logistics portal | **Built**, **off by default** (`FEATURE_LOGISTICS_PORTAL`, default `false`) | `apps/logistics-web`; built by `release.sh` only when the flag is on **[VR]** |
| API | **Built**, Fastify 5 | `backend/src/http` **[VR]** |
| Background worker | **Built**, separate process | `backend/src/worker` **[VR]** |
| Scheduler | **Built** — inside the worker, not a separate process. Periodic work is deduplicated on a `UNIQUE` time-slot key, so more than one worker cannot double-run it | `JobQueue.dedupeKey` **[VR]** |

**Authorisation is enforced on the server, not by hiding routes.** Each surface
has its own cookie jar, a `users.type` check and a token audience claim, so a
credential minted for one surface cannot be presented to another **[VR]**. The
seller storefront is resolved **once per request from the `Host` header only** —
never from a parameter, query string or cookie, because a shopper controls all
three and it decides whose prices they are charged **[VR]**.

---

## 2. The brief, capability by capability

### 2.1 Landing page and discovery

| Capability | Status | Note |
|---|---|---|
| Products tab / catalogue browsing | **Built** | |
| Product search, filters and facets | **Built** | Facets are the administrator's, from `/catalog/filters` |
| Voice search | **Built** | Browser's own speech engine — nothing is sent anywhere |
| Image search | **Built** | Needs an AI provider key; upload type decided by **magic bytes**, not the declared MIME |
| Animated sourcing globe | **Built** | A rendered earth whose maps ship with the build, so nothing is fetched. Reduced-motion, low-power and no-WebGL fallbacks all present |
| Feature cards (assistant, autopay, schedule, ERP) | **Built** | Real buttons — each opens its screen or explains why it cannot |
| Country / language / currency controls | **Built** | Eight languages; currency is separate from language, deliberately |

### 2.2 Authentication

| Capability | Status | Note |
|---|---|---|
| Email and password | **Built** | argon2; a dummy hash is computed for an unknown address so timing does not reveal whether it exists **[VR]** |
| Email verification, password reset | **Built** | Single-use, time-boxed tokens |
| Login lockout | **Built** | Counted **in the database**, so it is correct across all three API instances |
| Session cookies | **Built** | `httpOnly`, `secure` forced in production, `sameSite`, signed |
| CSRF | **Built** | Double-submit; the CSRF cookie is the only one JavaScript can read |
| MFA (TOTP, recovery codes, replay-proof counter) | **Built** | Enforced through enrolment in the logistics portal. **Not shown to be mandatory for admins** — that is `[OD]` (D22 in `DEPLOYMENT.md`) |
| **"Continue with Google"** | **Not built** | No Google client id, no OAuth sign-in route, no button in either application **[VR]**. The only OAuth in the system belongs to customer-ERP connectors. **This is a gap against the brief** — see §4 |
| Customer self-registration | **Off by default** | `FEATURE_CUSTOMER_SELF_REGISTRATION`, default `false` |

### 2.3 AI Mode

| Capability | Status | Note |
|---|---|---|
| AI Mode as a full page | **Built** | `AiModePage.tsx` — the floating widget is gone |
| Starts on the first message, no entry form | **Built** | |
| Product cards and links in replies | **Built** | A reply may only become a product the catalogue actually has — `lib/ai-products.ts` |
| Not presented as medical advice | **Built** | The system prompt forbids clinical advice |
| Isolation from other customers' data | **Built** | The assistant is given the catalogue, not account data **[VR]** |
| Guests are refused by default | **Built, and matches the brief** | `ASSISTANT_ALLOW_GUESTS` defaults to **`false`**. The setting is published in `/config`, so the storefront knows *before it draws the page*: a signed-out visitor is given the way in where the composer would be, the starter chips are not offered, and no request is made at all. A question carried from the landing page's search bar is left parked rather than consumed, so it survives the trip through sign-in and is asked on the way back. An operator who wants trial access sets it to `true`, and guests then get their own lower per-IP allowance |
| Provider failure behaviour | **Built** | Degrades; the shop keeps working |
| Prompt-injection red-teaming | **Unverified** | Not tested in this session. `DEPLOYMENT.md` S12 |

### 2.4 Catalogue and product data

| Capability | Status |
|---|---|
| SKU, brand, category, description, specifications, images | **Built** |
| Medical-device classification and compliance fields | **Built** — `ProductDeviceInfo`, GPSR fields, country restrictions |
| **Product-specific packaging** — pieces per box, boxes per carton, dimensions, weight | **Built** — `ProductPackaging`, `ProductPackDimension` |
| Minimum order quantity | **Built** |
| Per-currency prices | **Built** — a product with no price row in a currency is **left out of that market**, deliberately, rather than converted at a rate |
| Spreadsheet / catalogue import | **Built** — `catalog:import`, with `ProductImportRecord` |
| **Third-party sellers may sell by the piece** | **Built** — and this is recent, deliberate work: a seller's goods are not forced into the operator's carton rule |
| Money precision | **Built** — `BigInt` minor units everywhere, crossing the API as a string. No float in any money path **[VR]** |

### 2.5 Seller Hub

| Capability | Status | Note |
|---|---|---|
| Registration, business/KYB details, tax details | **Built** | `SellerBusinessProfile`, `SellerVerificationCase` |
| Pickup addresses | **Built** | `SellerLocation` |
| Compliance documents | **Built** | `SellerDocument`; `SELLER_ALLOW_UNSCANNED_DOCUMENTS` must stay off where policy requires scanning |
| Brand selection and brand-authorisation requests | **Built** | `Brand`, `BrandRequest` |
| Listing drafts, media, templates, variants | **Built** | `SellerListingDraft`, `SellerListingDraftMedia` |
| Admin review, rejection, rework | **Built** | `SellerListingIssue`, `moderation.service.ts` |
| **Asynchronous approval** — seller and admin never need to be online together | **Built** | Onboarding reaches a pending state and waits; approval is a later, audited action |
| **A listing cannot go on sale before approval** | **Built** | |
| Seller inventory, orders, order splitting | **Built** | `SellerInventory`, `order-split.service.ts` |
| Seller audit history | **Built** | `audit.service.ts`, `LogisticsAuditLog` equivalent for sellers |
| Settlements and commission | **Built** as records — commission is never taken on tax. By default it is taken on goods only; a platform-fee policy (Admin Panel → platform fees) can instead be set to goods **plus the seller's own delivery** (`PRODUCT_SUBTOTAL_PLUS_SELLER_DELIVERY`, `domain/platform-fee.ts`). Delivery the marketplace itself carries is never part of the base |
| **Payouts — actually moving money** | **Unconfigured by design** | `payout.service.ts` has exactly one adapter, `unconfigured`, returning `PROVIDER_UNCONFIGURED`. It deliberately **does not collect bank details**: a marketplace needs a connected-account id at a regulated provider, not an account number. **Stripe Connect or equivalent is not wired up.** See §4 |

### 2.6 Warehouses and fulfilment

| Capability | Status | Note |
|---|---|---|
| Warehouse records with country, address, coordinates, timezone, status | **Built** | |
| Seeded locations in **Belgium, Spain, Greece and Poland** | **Built** | `backend/src/seed/index.ts` **[VR]** |
| Admin warehouse map | **Built** | Works with no tile provider configured — warehouses are drawn in the right places relative to each other and **nothing about them is sent anywhere** until a map service is set |
| Eligible warehouses per destination | **Built** | |
| Delivery time and price estimates | **Built** | |
| Buyer chooses the fulfilment warehouse | **Built** | `FulfilmentWarehouseSection.tsx` |
| **Service areas are real, not a country circle** | **Built** | Per-route service levels **and named exclusions with reasons** — "no customs agent appointed for Morocco". This is the thing the brief warned against, and it is not what was done |

### 2.7 Cart, checkout and scheduled orders

| Capability | Status | Note |
|---|---|---|
| Buy Now | **Built** | |
| Buy Later — one future occurrence | **Built** | |
| Subscribe & Reorder — weekly, fortnightly, monthly, custom | **Built** | `ScheduleFrequency`, guarded by a CHECK constraint that names each member |
| Multiple schedules, edit, skip, pause, resume, cancel | **Built** | |
| Edit cutoff before an occurrence | **Built** | The reminder lead time is validated to be longer than the cutoff, so a reminder cannot offer a change that is already impossible |
| Plan and occurrence as separate states | **Built** | Both only ever change through `domain/schedule-state.ts` |
| **The seven-day rule** | **Built, defined and configurable** | `SCHEDULE_MIN_NOTICE_DAYS`, default **7**, in **calendar days on the customer's own clock** — never `7 × 24 × 3600 × 1000`, because the two disagree twice a year in every DST zone and permanently for any buyer whose today is not the server's. `domain/delivery-dates.ts` **[VR]**. The brief asked that this not be decided silently; **the repository had already decided it, explicitly, and says why** |
| One pricing path for a scheduled basket | **Built** | `quoteSchedule` — the review screen the customer confirms and the worker that charges them weeks later call the same function |
| Per-occurrence stock revalidation | **Built** | |
| Idempotency across scheduling, payment, order creation, ERP push | **Built** | `IdempotencyRecord` with `UNIQUE(scope,key)`, a SHA-256 of the canonical body and an owner scope |

### 2.7a Bulk ordering — carton, pallet and container

| Capability | Status | Note |
|---|---|---|
| Seller packaging per variant — individual units, carton, UK pallet, US pallet, container | **Built** | `SellerPackagingOption`, one row per variant per package type |
| Pallet and container presets | **Built, as guidance only** | Every preset field is named `nominal…` and is a **footprint**, never a guaranteed capacity. What the buyer is charged for comes from the seller’s own figures |
| Seller override of any derived figure, with both numbers shown | **Built** | The override and the derived value are stored side by side, and an audit row says who changed it |
| Canonical base-unit quantity | **Built** | `cart_items.quantity` and `order_items.quantity` stay a **piece count**. 2 pallets × 50 cartons × 24 units is stored as **2,400**, and a CHECK constraint enforces `totalBaseUnits = packageQuantity × unitsPerPackage` |
| Immutable packaging snapshot on every cart and order line | **Built** | `CartItemPackaging`, `OrderItemPackaging`. The order copy has **no `updatedAt` column** — it is never updated, and its absence is the documentation |
| Historical orders unchanged when a seller edits packaging | **Built, and tested** | `tests/integration/bulk-packaging.test.ts` edits the option after the order and asserts the order line did not move |
| Reservation and deduction on total base units | **Built** | Inventory never sees a package count |
| Exact-decimal packaging arithmetic | **Built** | Integer-first rational conversion — `48 × 25.4` is `1219.1999999999998` as a float and `1219` here |
| Package price divisibility | **Built, enforced at the seller’s form** | A package price must divide exactly by units per package, because the line charges `unitPrice × baseUnits`. The alternative was a second pricing engine **[OD]** |
| Buyer “Order by” selector, live breakdown, whole packages available | **Built**, storefront |
| Freight routing — no parcel API is offered a pallet or a container | **Built** | `domain/freight-load.ts`. DHL, FedEx, UPS and India Post declare **parcel and carton only** |
| Freight quote requests, answered by seller staff | **Built** | `SellerFreightQuoteRequest`. **No price is ever fabricated** — the screen says *Freight quote required* until a person enters one |
| Freight quote from a cart, before an order exists | **Not built** | The schema carries `cartId` for it; nothing writes it yet |
| Bulk packaging on a recurring schedule | **Not built** | `quoteSchedule` has not been taught package lines |
| Admin view of a bulk line | **Partial** | The order API returns the full packaging breakdown; **no admin screen renders it yet** |

### 2.8 Payments

| Capability | Status | Note |
|---|---|---|
| Provider-hosted card collection | **Built** | Stripe Elements and Razorpay Checkout. **No raw card data touches this system** |
| Reusable authorisation for auto-pay | **Built** | |
| Explicit auto-pay opt-in with consent timestamp | **Built** | `FEATURE_CUSTOMER_AUTOPAY`, off by default |
| Off-session charges for occurrences | **Built** | Payment attempts capped at 3 — banks read repeated declines as a signal about the card |
| Signed webhooks, replay protection | **Built** | HMAC over the **raw body**, `timingSafeEqual`, and **Stripe timestamp freshness enforced** so a captured signature does not stay valid forever |
| **An order is confirmed only by a verified webhook**, never by a redirect | **Built** | |
| Refunds and disputes | **Built** as records |
| Live/test key confusion | **Built** | A live key outside production, or a test key inside it, **refuses to start** |
| **Marketplace payment architecture** | **Not decided, not built** | Whether UBOSS is merchant of record, marketplace facilitator or collector for sellers is **[OD]** (D13). Ordinary single-merchant Stripe is what exists |

### 2.9 Customer ERP connectivity

| Capability | Status |
|---|---|
| Vendor-neutral connector — base URL, endpoints, methods, headers | **Built**, `FEATURE_CUSTOMER_ERP` off by default |
| API key, bearer, basic and OAuth 2.0 | **Built** |
| Field, product, SKU, warehouse, unit and inventory mappings | **Built** — `CustomerErpFieldMapping`, `CustomerErpWarehouseMap`, `CustomerErpProductCode` |
| Test connection, dry run, last-sync status, audit log | **Built** |
| Inbound webhooks and scheduled polling | **Built** |
| **Owned by the customer organisation, not by a global admin** | **Built** — with a separate admin view designed not to expose the customer's secrets |
| Credentials encrypted, never returned to the browser after saving | **Built** — `CustomerErpCredential`, `SECRETS_ENCRYPTION_KEY` |
| **SSRF protection** | **Built, and thorough** — scheme allowlist; DNS resolved **before** connecting; loopback, link-local (incl. `169.254.169.254`), private, CGNAT, multicast and IPv4-mapped IPv6 all rejected; **the connection is pinned to the validated address to defeat DNS rebinding**; redirects are not followed automatically and are re-validated |
| Failed ERP push after a successful payment | **Built** — a recoverable state, and the customer is not charged again |

### 2.9a Seller ERP connectivity — TallyPrime

A different feature from §2.9, and easy to confuse with it: that one is each
**buyer’s** purchasing system, this one is each **seller’s** accounting system.

| Capability | Status | Note |
|---|---|---|
| Per-seller connections, never one global one | **Built** | `SellerErpConnection` is keyed on the seller account |
| Outbound-only bridge — pairing code, local agent, HTTPS poll, task queue | **Built**, server side | Tally’s listener is never reached from the internet, and **the backend never treats its own `localhost` as the seller’s Tally machine** |
| **The bridge agent program itself** | **Not built here** | It is a separate Windows program. This repository holds the complete, tested **server half** of the contract |
| Direct URL mode for private or VPN deployments | **Built, and refuses by default** | Requires `SELLER_ERP_ALLOW_DIRECT` **and** a non-empty host allowlist; the configuration refuses to start with one and not the other |
| Truthful connection state | **Built** | Thirteen states **concluded from four timestamped facts**, not stored as a flag. Nothing says *Connected* without a heartbeat inside 180 seconds and a successful test inside 15 minutes |
| Guided ten-step setup, company picker, heartbeat and job visibility | **Built**, Seller Hub |
| Mapping — ledgers, stock items, godowns, units, voucher types, tax accounts, cost centres | **Built** | Chosen from **what a master pull actually found in the seller’s Tally**, never typed. Tally keys masters by name, so a typed name one space out is a mapping that looks complete and fails at post time |
| **Financial ledgers are never created automatically** | **Built** | A missing mapping refuses the job and names what is missing |
| Sync policy per event, with safe defaults | **Built** | Order placement and revenue recognition are **separate events**, defaulted apart |
| Packaging reaches Tally as base units | **Built, and tested end to end** | `tests/integration/bulk-order-to-tally.test.ts` asserts `baseQuantity === 2400`, with the pallet count carried as the alternate unit. **Two pallets never post as “2”** |
| Transactional outbox, deterministic idempotency key, lease dispatch, full-jitter retry, dead letter, manual retry | **Built** | A `UNIQUE` idempotency key, plus an external-reference row, plus Tally’s own `REMOTEID` — three independent duplicate defences |
| **A 200 is not a success** | **Built, and tested** | Tally’s response is parsed: `LINEERROR`, `EXCEPTIONMSG` and a zero created-or-altered counter each fail the job |
| XXE and DTD | **Refused, not stripped** | A hand-written parser with **no doctype support at all**. Billion laughs, external entities and a lower-case doctype are each asserted to be rejected |
| Bridge credentials at rest | **Built** | Pairing codes and bridge tokens are stored as SHA-256 — **never ciphertext, never plaintext**, so a copy of the database cannot be replayed. Codes are single-use and rate-limited |
| Receipts, credit notes and master upserts | **Partial** | Enums, policy switches, voucher kinds and request builders exist; **no lifecycle hook enqueues them yet** |
| Scheduled inventory pull | **Partial** | The request builder and the apply path exist; nothing schedules it on `inventoryPollMinutes` |
| Admin view of a seller’s ERP status | **Not built** | Deliberate for now — the data is seller-owned, and the admin screen has to be designed not to expose it |

### 2.10 Logistics portal

| Capability | Status | Note |
|---|---|---|
| Carrier authentication with its own credentials | **Built** | |
| **A new carrier gets its own organisation** | **Built, and explicitly tested** | `tests/integration/logistics-portal-tenant.test.ts`. The portal names the signed-in company and offers to sign out rather than switching quietly — the failure the brief describes (a new carrier seeing a seeded one) is the failure that test exists to prevent |
| Organisation-scoped shipments, assignments, events, exceptions | **Built** | |
| Status transitions validated, actor and timestamp on every change | **Built** | |
| Proof of delivery, notes, failure reasons, returns | **Built** | |
| Pickup requests, dispatch manifests, drivers, vehicles | **Built** | |
| Carrier integrations and webhooks | **Built** | `CarrierIntegration`, `CarrierWebhookEvent`, `CarrierStatusMapping` |
| **GPS / driver location** | **Built in the data model — treat as a decision, not a feature** | `LogisticsLocationPing`, `LogisticsActiveTrip`, and a retention setting. Latitude and longitude are **redacted from logs**. The brief is explicit that GPS must not be introduced without a DPIA, driver notice and access review — so **whether this is switched on is `[OD]`, and it is a data-protection decision before it is a technical one**. See §3 |

### 2.11 Admin, notifications and platform

| Capability | Status |
|---|---|
| Users, staff, roles and permissions | **Built** — every admin route requires a permission, not merely a session |
| Seller, brand and listing approval queues | **Built** |
| Warehouses, inventory, orders, payments, refunds, scheduled orders | **Built** |
| ERP connection health, logistics partners, carrier accounts, delivery assignment | **Built** |
| Compliance documents, audit events, platform configuration | **Built** |
| **Audit-log integrity** | **Built** — `UPDATE` and `DELETE` are revoked from the application user at the database, so the application cannot rewrite its own history |
| Notifications: verification, reset, approval, payment, schedule, shipment, operational alerts | **Built** — queued **after** the business record commits, so an email is never sent for an order that was not saved |
| GDPR Art. 15 export | **Built, and self-policing** — a test reads the schema and **fails** if a new table holding personal data is absent from the export |
| **Customer deletion / anonymisation** | **Not built** — it needs a business decision about what "delete" means for an account with orders. `RUNBOOK.md` §6 |

---

### 2.12 Seller fulfilment and carriers

How a seller's own goods reach a doorstep. Five ways, and they differ in who is
answerable rather than only in who drives. `PROJECT-GUIDE.md`, "How a seller's
own goods get delivered", carries the responsibility and capability matrices.

| Capability | Status | Note |
|---|---|---|
| Seller picks a delivery method during onboarding, and per product | **Built** | The step is **required** and always answerable: `OPERATOR_FULFILLED` needs nothing set up **[VR]** |
| **Self-Managed Logistics** — the seller's own vans | **Built** | Pickup profiles, service areas with exclusions, capability requests and versioned rate cards, each scoped to the seller's own organisation |
| **Dedicated Logistics Partner** — a courier contracted to one seller | **Built** | Invited by the seller, accepted by that company, and **that company manages its own fleet**. No seller route reaches another company's drivers |
| **DHL** on the seller's own account | **Built, unconfigured by design** | Full adapter — rates, consignment, tracking, address check, collection. **Never called with live credentials from this repository**; exercised against the sandbox with fabricated keys |
| **FedEx** on the seller's own account | **Built, unconfigured by design** | Full adapter — rates, consignment, cancel, tracking, address check. **Never called at all.** No sandbox account exists here |
| **India Post** | **Built as manual, by design** | There is no official API to hold. Every API operation refuses; pricing answers an empty list rather than an invented figure; the article number is entered and tracked by hand. **No screen shows it as connected** |
| Carrier credentials belong to the seller | **Built** | Entered in Seller Hub, AES-256-GCM in a table of their own with the connection id as additional authenticated data. **No read path returns a secret.** There is no operator environment variable for a carrier key |
| Going live needs a real call plus a person | **Built** | A connection reaches `ACTIVE` only after a successful test against the carrier **and** the seller's own confirmation. A green badge is never granted by an adapter answering from a fixture |
| Drivers for an external carrier | **Not built, deliberately** | DHL's couriers are DHL's staff. `driversAreManagedHere` decides it in one place, and the Seller Hub, the admin panel and the generated feature guide all read it |
| Quoting, buying and the label | **Built** | Quotes stored with the service they belong to; purchase idempotent at the database, so a double click returns the first answer rather than booking a second parcel. The label carries the consignee's address and is served only through a signed link |
| Booking the van | **Built** | Arranged by **exactly one** party, enforced by a CHECK constraint; a second live collection for one consignment collides on a UNIQUE index rather than being prevented by a query two dispatchers can both pass |
| Multi-seller orders | **Built** | One paid order raises one consignment **per seller**, never one shipment for the basket |
| Duplicate carrier webhooks | **Built** | Event records are idempotent, so a retried delivery notification does not notify twice |
| Admin oversight and customer tracking | **Built** | The operator sees seller, partner, driver and timeline; the customer sees what they are permitted to and no more |

---

## 3. Where the build differs from the brief — and why that is a decision

Two of these are decisions to make. None is a defect. Both are **[OD]**.

The third is now settled: **the assistant refuses guests by default**.
`ASSISTANT_ALLOW_GUESTS` shipped `true` and has been changed to `false`, which
is what the brief asks for and also the right default for software somebody else
pays to run — every reply costs the operator money with an AI supplier, and the
guest rate limit bounds that spend rather than removing it. A guest never
reached another conversation or any account data even before the change **[VR]**,
so this was a commercial default rather than a security hole. An operator who
wants a buyer to be able to evaluate the catalogue before opening an account
turns it back on.

1. **Driver location tracking exists in the data model.** The brief says not to
   introduce GPS without a privacy review. It is already modelled, with
   retention and log redaction. Nothing here decides whether it is switched on,
   and it should not be until D4 (controller/processor roles for carrier data)
   and a DPIA are done.

2. **Seller payouts refuse rather than pretend.** There is no payout provider
   and no bank-verification provider, so the adapter returns
   `PROVIDER_UNCONFIGURED`. A seller can be onboarded, sell, and have a
   settlement calculated; **money does not move**. That is the correct behaviour
   for an unconfigured provider and it is also a launch blocker for a
   marketplace that intends to pay sellers.

---

## 4. Missing business functionality

Reported separately, as the brief requires. **None of these is a deployment
blocker; every one of them is a product blocker for some launch shape.** No work
on any of them was done as part of the deployment-readiness task.

| # | Missing | What it blocks | Evidence |
|---|---|---|---|
| **M1** | **More than one user per buying business.** `CustomerProfile.userId` is `@unique` — one account, one buyer. `organization` and `department` are free-text fields on that profile, not a membership model. There is no buyer-side equivalent of `SellerMember` | A procurement team where three people order against one business account, shared addresses and shared purchasing limits. The brief asks specifically that this be verified | `backend/prisma/schema.prisma` **[VR]** |
| **M2** | **"Continue with Google".** No OAuth sign-in of any kind for people; the only OAuth is for customer-ERP connectors | Sign-up friction, and anything that assumes Google as an identity provider | **[VR]** |
| **M3** | **Seller payouts.** The model, settlements, commission and idempotency are all there; the provider is not | Paying third-party sellers at all. Needs D13 (marketplace role) answered first, then Stripe Connect or equivalent | `payout.service.ts` **[VR]** |
| ~~**M4**~~ | **Customer deletion / anonymisation — built since this audit.** An erasure data request, approved by staff holding `data_request.action`, runs `executeErasure`: addresses, carts, sessions, reset tokens and chat enquiries are deleted; the user and customer profile are pseudonymised; the billing and delivery address on a placed, invoiced order is kept, because tax law requires the invoice to be kept. Open orders, returns and similar obligations block it with `ERASURE_BLOCKED_BY_OBLIGATION` until they close | Nothing in code. What remains is organisational: the operator's written retention policy, and backups that stay coherent with the erasure promise | `modules/privacy/erasure.service.ts`, `backend/docs/DATA-PROTECTION.md` **[VR]** |
| **M5** | **Invoicing into KSeF.** Polish structured e-invoicing is analysed in `DEPLOYMENT.md` §7.2 and not implemented | Selling into Poland from a Polish establishment. Whether it applies at all follows from D1 and is a tax-adviser determination, not a code one | **[VR]** |
| **M6** | **SMS delivery.** `NotificationChannel` names SMS and nothing sends it; phone-change codes go to the verified email address instead | Anything that assumes a phone as a second factor or a delivery channel. Stated plainly in the schema rather than left to be discovered | **[VR]** |
| ~~**M7**~~ | **Malware scanning of uploads — built since this audit.** Every upload path (product images, seller logos, listing media, seller and logistics documents) is scanned by ClamAV before it is stored. Production refuses to start unless `MALWARE_SCANNER_DRIVER=clamav`, an unavailable scanner fails the upload closed, and both `*_ALLOW_UNSCANNED_DOCUMENTS` flags default to `false` and are refused in production | Nothing in code. **No live ClamAV has been exercised yet**: the host needs ClamAV installed, and a clean file, an EICAR file and a stopped daemon each tested (`SECURITY-AUDIT-REPORT.md` B-04) | `infra/malware-scan.ts`, `config/env.ts` **[VR]** |

---

## 5. What was not verified

Named so that nobody reads silence as assurance.

- **Prompt injection and data exfiltration through the assistant or image
  search.** The controls look right; no red-team pass was run.
- **Behaviour under load.** No load test exists, so no throughput or latency
  claim is made anywhere in this repository.
- **Penetration testing.** None commissioned.
- **Accessibility beyond automated contrast auditing.** Each frontend runs
  `audit:contrast` in `verify` and now in CI; that is evidence about colour and
  about nothing else. Keyboard operation, focus order and screen-reader
  behaviour have not been independently tested against WCAG 2.2 AA.
- **Whether the seeded reference data matches the operator's real commercial
  arrangements.** It is sample data and is meant to be replaced.
- **Any live carrier account.** The DHL adapter has only ever reached DHL's
  sandbox with fabricated credentials, and **the FedEx adapter has never been
  called at all** — no FedEx account exists in this repository. Both are
  complete and unit-tested against recorded shapes, and both stay unproven
  against a real contract until a seller connects one. This is by design:
  carrier credentials belong to each seller, so there is nothing here for the
  operator to supply that would prove it.
- **Any live TallyPrime.** The Tally half is complete, and every test runs
  against sanitized fixtures and a mock bridge that drives the real routes.
  **Nothing here has ever spoken to a real TallyPrime installation**, and it
  stays unproven until a seller pairs one. Recorded as residual risk RR-9.
- **India Post's absence is a finding, not a gap.** There is no official API to
  integrate, so the honest test is the one that asserts no screen claims a
  connection, and that test passes. If official access is later granted, the
  adapter interface is already the right shape.

---

## Related documents

| For | Read |
|---|---|
| Putting it on a server, and what must be decided first | `docs/DEPLOYMENT.md` |
| How it is built, and how a request travels from a click to a row | `PROJECT-GUIDE.md` |
| Features, configuration, markets, payments, going live | `README.md` |
| Operating it: backups, restores, incidents | `backend/docs/RUNBOOK.md` |
| Every feature in plain language, for a non-technical reader | `output/UBOSS_Sourcing_Feature_Guide.docx` |

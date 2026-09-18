# What is actually built

**UBOSS Sourcing — capability audit against the product brief**

Version 1.1 · 2026-09-16 · Repository at `28b89fe`

*1.1 — `ASSISTANT_ALLOW_GUESTS` now defaults to `false`, which closes the one
deviation from the brief that was a setting rather than a decision. §2.3, §3.*

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
| Settlements and commission | **Built** as records — commission is taken on goods only, never on tax, never on delivery |
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
| **M4** | **Customer deletion / anonymisation.** Export is built; erasure is not | GDPR Art. 17 requests on an account that has orders. It is not a coding problem — it needs an approved policy for what "delete" means when invoices must be retained | `RUNBOOK.md` §6 **[VR]** |
| **M5** | **Invoicing into KSeF.** Polish structured e-invoicing is analysed in `DEPLOYMENT.md` §7.2 and not implemented | Selling into Poland from a Polish establishment. Whether it applies at all follows from D1 and is a tax-adviser determination, not a code one | **[VR]** |
| **M6** | **SMS delivery.** `NotificationChannel` names SMS and nothing sends it; phone-change codes go to the verified email address instead | Anything that assumes a phone as a second factor or a delivery channel. Stated plainly in the schema rather than left to be discovered | **[VR]** |
| **M7** | **Malware scanning of uploads.** Type is decided by magic bytes and size is capped, but nothing scans content. Two flags exist to allow unscanned documents and default to allowing them | A policy that requires scanning before a reviewer opens a seller's certificate. ClamAV plus a worker job is the shape; it costs memory a KVM 4 does not have spare | `DEPLOYMENT.md` §10.6 **[VR]** |

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

---

## Related documents

| For | Read |
|---|---|
| Putting it on a server, and what must be decided first | `docs/DEPLOYMENT.md` |
| How it is built, and how a request travels from a click to a row | `PROJECT-GUIDE.md` |
| Features, configuration, markets, payments, going live | `README.md` |
| Operating it: backups, restores, incidents | `backend/docs/RUNBOOK.md` |
| Every feature in plain language, for a non-technical reader | `output/UBOSS_Sourcing_Feature_Guide.docx` |

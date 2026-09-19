# UBOSS Sourcing - Context for GPT discussions

Snapshot date: **2026-09-19**  
Repository: `UBoss-Software`  
Branch/HEAD when this briefing was prepared: `main` at `8c26040`

> This file is a compact briefing, not the ultimate source of truth. For a
> disputed implementation detail, inspect the current code, database migration,
> tests, and `PROJECT-GUIDE.md`. Never paste either `.env` file into a chat.

## Ready-to-use opening prompt

Copy the block below into a new GPT conversation, then attach this file and any
of the authoritative documents listed near the end.

```text
I am working on UBOSS Sourcing, a self-hosted B2B sourcing, ordering and
marketplace platform. It has a customer storefront and Seller Hub, an admin
console, an optional carrier/logistics portal, a Fastify API, a background
worker and a MariaDB database.

Treat the attached UBOSS project context and repository files as the source of
truth. Distinguish clearly between:
1. behavior implemented and verified in code,
2. behavior controlled by a feature flag or external provider,
3. sample/seed/demo data,
4. current local-database state,
5. work in progress in the dirty working tree,
6. legal, tax, operational or commercial decisions still requiring an owner.

Do not infer that a feature works merely because a table, type or screen exists.
Trace important claims through the route, service, domain rule, schema/migration
and tests. Preserve the project's invariants, especially BigInt minor-unit
money, server-side tenant isolation, state-machine transitions, webhook-only
payment confirmation, explicit publication, idempotency and append-only audit
history.

Do not request or reproduce .env files, passwords, API keys, session secrets,
payment credentials, database URLs or encryption keys. If configuration is
relevant, refer only to variable names and whether a value is required.

When proposing a change, explain:
- which user and workflow it affects;
- which frontend, route, service, schema/migration and tests would change;
- security, tenancy, money, tax, privacy and rollback implications;
- whether PROJECT-GUIDE.md, PROJECT-GUIDE.hinglish.md, README.md, SETUP.md or
  the generated feature guide also needs updating;
- how to verify the change on Windows/PowerShell and MariaDB 11.4 compatibility.

My question is:
[PUT THE QUESTION HERE]
```

## 1. Product identity

UBOSS Sourcing is a **self-hosted B2B commerce platform** that other companies
buy and operate with their own identity, catalogue, customers, policies and
infrastructure. Business identity and policy must therefore be configuration or
database data, never assumptions hard-coded for the original author.

Its central use case is a company selling products to other businesses. The
current catalogue is heavily medical, but the marketplace taxonomy and seller
listing system support many trades. The software covers discovery through
invoice and after-sales operations:

- catalogue, search, category navigation and product detail;
- customer accounts, buyer organisations, addresses and purchasing controls;
- carts, checkout, tax, discounts, payments and invoices;
- warehouse selection, stock, fulfilment, shipments, returns and refunds;
- scheduled purchases, subscriptions and saved payment methods;
- third-party seller onboarding, listings, offers, stock and settlements;
- customer-owned ERP connections;
- carrier operations through an optional logistics portal;
- admin operations, reports, audit history, privacy requests and configuration;
- catalogue-grounded AI assistance and image search.

B2B assumptions are important: customers may have negotiated prices, credit
terms, purchasing limits and approval thresholds; products may have minimums
and increments; markets have explicit currencies/prices; and orders may recur.

The medical catalogue also introduces GPSR, MDR, VAT, GDPR and product-safety
concerns. The software records useful compliance data, but software fields do
not by themselves establish legal conformity.

## 2. Users and tenancy

Main audiences:

- **Buyers** browse, purchase, manage orders, schedules, addresses, saved items,
  auto-pay and customer ERP connections.
- **Buyer organisations** let colleagues manage a business-owned ERP connection
  and organisation membership. The current code includes
  `BuyerOrganization`, `BuyerOrganizationMember` and invitations.
- **Marketplace sellers** apply, provide evidence, receive approval, manage
  locations, brands, listings, variants, offers, stock, orders and finances.
- **Operator staff** use permission-gated admin screens. Roles include business
  ownership, catalogue, inventory, order and finance responsibilities.
- **Logistics partners** are separate tenants with their own members, drivers,
  vehicles, assignments, manifests and shipment events.

Tenant identity is server-derived:

- a seller route obtains `sellerAccountId` from authenticated membership;
- a seller shop front is resolved from the trusted request host, not a caller
  parameter;
- a logistics user gets the carrier from authenticated membership;
- a buyer ERP connection belongs to the buyer organisation, not an arbitrary
  user-supplied organisation ID.

One tenant must never be able to read or mutate another tenant's rows.

## 3. Runtime architecture

Five runtime processes are involved:

| Program | Location | Default local port | Purpose |
|---|---|---:|---|
| Customer storefront + Seller Hub | `apps/customer-web/` | 5174 | Public shop, buyer account and `/seller` area |
| Admin console | `apps/admin-web/` | 5173 | Operator back office |
| Logistics portal | `apps/logistics-web/` | 5175 | Carrier-facing portal; feature-gated |
| Backend API | `backend/` | 4000 | Fastify HTTP API and business services |
| Worker | `backend/src/worker/` | none | Jobs, schedules, email, exports and integrations |

All browser applications communicate with the API using HTTP and JSON. The
frontends are intentionally separate builds with distinct session-cookie names
and token audiences. This permits simultaneous staff/customer sessions and
reduces cross-surface exposure.

The worker uses a database-backed queue with leases and deduplication. Multiple
workers are safe in principle, but local development should run one worker so
different builds do not compete over job types.

## 4. Technology stack

Backend:

- Node.js 24+
- TypeScript in strict mode
- Fastify 5
- Prisma 7 using the MariaDB driver adapter
- MariaDB: XAMPP 10.4 in local development; 11.4 LTS is the production and CI
  compatibility target
- Zod request/config validation
- argon2 password hashing
- Vitest tests

Frontends:

- React 19
- Vite 6
- TypeScript
- React Router 7
- TanStack Query 5
- React Hook Form + Zod
- Tailwind CSS
- i18next
- Motion, Three.js and React Three Fiber for selected visuals
- MapLibre and optional Google Maps in map-capable surfaces

Infrastructure:

- nginx and systemd deployment files under `deploy/`
- three API instances behind nginx in the documented single-VPS production
  shape, plus one worker and MariaDB
- local or S3-compatible storage; production refuses local-only storage
- log or SMTP email; production refuses log-only email
- Stripe and Razorpay payment integrations
- database queue and in-memory cache are implemented; Redis options are
  declared boundaries that currently refuse to start rather than silently
  pretending to work

## 5. Backend structure

The backend follows four layers:

```text
http/     request parsing, auth/permission checks, schemas and response shape
  -> modules/  business services and transactions
      -> domain/   pure rules, state machines, money and errors
          -> infra/    database, storage, email, queue, crypto and adapters
```

Routes should not contain business rules. Domain code should not perform I/O.

Major backend modules under `backend/src/modules/` include:

- `identity`, `customers`, `directory`
- `catalog`, `inventory`, `cart`, `orders`
- `payments`, `tax`, `invoicing`, `coupons`
- `fulfilment`, `recurring`
- `seller`, `logistics`
- `customer-erp`, `integrations`
- `assistant`, `reports`, `notifications`
- `privacy`, `audit`, `settings`

A typical request passes through security headers/CORS, rate limiting,
correlation ID assignment, authentication, permission checks, CSRF for unsafe
cookie-authenticated requests, Zod validation, service/domain logic in a
transaction, and standard error serialization.

The API error envelope is a contract:

```json
{
  "error": {
    "code": "STABLE_ERROR_CODE",
    "message": "Human-readable message",
    "details": [],
    "correlationId": "traceable-id"
  }
}
```

Error codes live in `backend/src/domain/errors.ts`. Add codes; do not repurpose
existing meanings because all frontends translate them.

## 6. Frontend surfaces

### Customer storefront

The storefront includes:

- home/search experience with animated globe and reduced-motion fallbacks;
- text, browser voice and AI-backed image search;
- category rail, category/listing pages, filters, facets and sorting;
- product detail, packaging, compliance information and variant selectors;
- cart, instant checkout, payment and confirmation;
- schedules: buy later and subscribe/reorder;
- buyer account, profile, addresses, orders, saved products and notifications;
- AI Mode as a full catalogue-grounded page;
- buyer-owned ERP connection wizard and organisation membership;
- the Seller Hub under `/seller`.

### Seller Hub

Seller behavior is organisation-scoped. It includes:

- application, business/KYB profile and required evidence;
- pickup/despatch locations;
- brand selection and authorisation requests;
- server-driven listing drafts whose fields depend on category;
- product/offer separation: product describes the thing; offer describes one
  seller's price, terms, stock and availability;
- variants and option matrices;
- listing moderation and rework;
- seller stock, split order groups, returns, commission and settlements;
- seller-specific audit and notifications.

The current working tree contains an in-progress full listing editor. It
distinguishes routine edits (price, terms, stock) from structural edits
(category/options/combinations). A live offer must be paused before structural
editing so a buyer's page does not rearrange underneath them. Withdrawn or
ordered variants are archived rather than deleted.

### Admin console

The admin application includes dashboards and operational queues for:

- customers, buyer companies and staff;
- categories, products, translations and imports;
- manufacturers/economic operators and product-safety information;
- inventory, warehouses and service areas;
- orders, scheduled orders, payments and refunds;
- sellers, brand requests and listing moderation;
- logistics partners and shipment operations;
- customer ERP visibility, integrations and processing status;
- privacy/data requests, audit history, reports, notifications and settings.

Every admin route is permission-gated on the server. Hiding a navigation item
is not authorization.

### Logistics portal

When enabled, carrier organisations can work with shipments, assignments,
drivers, vehicles, manifests, proof of delivery, events and exceptions. The
portal has its own cookie audience and tenant boundary.

## 7. Core workflows

### Product publication

A product is customer-visible only when all of these are true:

- product status is `ACTIVE`;
- `isPublished` is true;
- product is not archived;
- its category is active and not archived.

Import can create or activate products, but must not silently publish them.

### Product versus seller offer

A catalogue product is shared product identity and specification. A seller
offer is a seller's commercial proposition. Seller marketplace visibility is
driven by live offers. A projection allows catalogue searching/sorting, but the
offer remains the authoritative price charged.

### Units and packaging

The operator's own catalogue is configured to sell outer cartons, with
`PIECES_PER_CARTON` defining the piece factor. Third-party seller offers sell by
the piece. Cart and order rows preserve both the buyer-facing sell unit and the
piece quantity needed by stock, invoice and ERP flows. A requested unit that
does not match the offer is refused rather than reinterpreted.

Pack count on a variant is not cart quantity. For example, choosing "Pack of
10" and cart quantity 2 means two packs, not a cart quantity of twenty.

### Checkout and payment

- cart totals, discounts and tax are calculated server-side;
- tax applies after discount allocation;
- stock reservation and order creation occur transactionally;
- one idempotency key represents one checkout attempt;
- payment redirects never confirm an order;
- only a valid signed provider webhook confirms payment;
- duplicate webhooks and retries are structurally deduplicated;
- paid orders generate consignments by despatch location without changing an
  already-paid order back into failure.

### Scheduled orders

Plans and occurrences are separate state machines. The customer-facing review
and worker use the same `quoteSchedule` pricing path. Each occurrence
revalidates availability, price and stock. Schedule dates use customer-local
calendar-day rules, not fixed millisecond arithmetic. Auto-pay capabilities are
feature- and provider-dependent.

### Seller listing review

Listing decisions apply to the exact submitted revision. Optimistic versioning
prevents two moderators or a resubmission from silently overwriting each other.
Approval makes a listing eligible; the seller still chooses whether it is on
sale.

### Privacy requests

The current code includes access/export and approved erasure workflows.
Erasure pseudonymises or separates personal identity from records that must be
retained, and it has blockers for obligations such as unsettled orders/open
returns. Closing an account and executing legal erasure are different actions.

## 8. Money, markets, tax and pricing invariants

- Money is **BigInt minor units**, never floating point.
- Money crosses JSON as a string because values may exceed JavaScript's exact
  integer range.
- An amount is never silently converted into a currency in which it was not
  entered.
- Products without an explicit price for a market/currency are excluded from
  that market.
- Tax is computed on discounted amounts.
- Coupon allocation must make line totals add up exactly to the charged total.
- Order, price, tax, sell-unit and carton-size facts are snapshotted so history
  does not change when configuration changes.
- Marketplace role, VAT treatment, importer-of-record position and seller
  payment architecture are business/legal decisions, not values to guess.

## 9. Database and migration model

The schema lives in `backend/prisma/schema.prisma`; SQL migrations live under
`backend/prisma/migrations/`.

At this snapshot, direct repository counts are approximately:

- 172 Prisma models;
- 140 enums;
- 57 migration directories.

Documentation containing older counts may lag current committed or working-tree
changes. Use direct schema/migration inspection when the exact count matters.

Important design points:

- ULID string primary keys rather than auto-increment IDs;
- extensive foreign keys, unique constraints and check constraints;
- order and financial history is snapshotted;
- state transitions are controlled in domain functions;
- audit history is append-only, including database privilege restrictions in
  production;
- migrations must support rolling deployment: additive/expand first, contract
  in a later release;
- XAMPP/MariaDB 10.4 differences must be rehearsed against strict MariaDB 11.4;
- never copy the XAMPP data directory to production; use logical export and the
  documented allowlist/validation procedure.

Do not run `prisma migrate dev` casually against this project. Repository
automation and production use migration deployment and compatibility rehearsal.

## 10. Current catalogue and taxonomy snapshot

There are three different category facts that must not be confused:

1. **Starter taxonomy**: the generic defaults in
   `backend/src/seed/starter-categories.ts`.
2. **Current database taxonomy**: operator/import changes stored in MariaDB.
3. **Customer-visible taxonomy**: active categories whose subtree contains at
   least one active, published, non-archived product.

The generic starter set has 25 top-level departments. In the current database,
`Medical Devices` already existed with imported supplier categories, so the
starter seed correctly left that department and its children alone.

Current customer-visible English snapshot queried from the local database:

- **246 publicly visible products**;
- **6 visible top-level departments**:
  - Medical Devices - 240;
  - Tools & Hardware - 1;
  - Agriculture & Gardening - 1;
  - Food Service & Catering - 1;
  - Furniture & Fixtures - 1;
  - Clothing & Textiles - 2.

Medical Devices currently has 26 visible subcategories:

```text
ABG Kit
ABG Syringe
Adult diaper
Closed IV Cannula
DC Flush Syringe(Swab Cap)
Disinfectant Cap
Enfit syringe
Flush Syringe
Infant Feeding Tube
Infusion Set
Insulin Syringe
IV Cannula
Line Access
Oral Dosing Syringe
Oral Syiringe
Prefilled Heparin Syringe
Ryles Tube
Safety Needle
Sodium Citrate Prefilled Syringe
Sterile Water
Sterile Water With 10% Glycerine
Suction Catheter
Surgical Gloves
Line Conditioning
IV Administration Sets
Syringes & Needles
```

All 25 active top-level departments are:

```text
Medical Devices
Laboratory & Scientific
Industrial Supplies
Tools & Hardware
Electrical & Lighting
Electronics & Components
Computers & IT
Phones & Communication
Office & Stationery
Packaging & Shipping
Safety & Protective Equipment
Cleaning & Hygiene
Building & Construction
Automotive & Transport
Agriculture & Gardening
Food Service & Catering
Furniture & Fixtures
Home & Kitchen
Clothing & Textiles
Beauty & Personal Care
Sports & Outdoors
Toys, Hobbies & Crafts
Books & Media
Chemicals & Raw Materials
Energy & Environment
```

The current database also retains archived categories (`Apple`, `Electrical`,
`Industrial Fasteners`, `Packaging & Consumables`, `Safety Equipment`, plus an
archived child called `Smoke MTKF70EQ renamed`). They are excluded from the
customer tree.

The working tree includes a new demonstration-catalogue system intended to
plant representative products across every department/subcategory without
being able to overwrite operator-created products. It is tracked through a
separate `DemoCatalogEntry` table. Treat this as work in progress until its
migration, tests and verification are complete and committed; it is not the
same as the current 246-product database snapshot above.

## 11. Search, AI and integrations

The storefront AI is catalogue-grounded. It may describe products and return
verified product cards, but it must not invent catalogue entries or provide
clinical advice. Guest AI access defaults off. Provider failure must degrade
without taking down ordinary shopping.

Image search validates actual file bytes rather than trusting a supplied MIME
type. Voice search uses the browser capability.

Customer ERP connectivity is customer/buyer-organisation owned and includes
configurable endpoints, authentication, mappings, dry run, audit and inbound or
scheduled sync. Credentials are encrypted and not returned after saving. SSRF
protection resolves and validates destinations, blocks private/link-local and
metadata ranges, pins the validated address, and revalidates redirects.

Provider/adaptor boundaries should refuse explicitly when unconfigured rather
than return a fake success.

## 12. Authentication and security model

- Passwords use argon2.
- Unknown-email login still computes a dummy hash to reduce account discovery
  through timing.
- Sessions use signed, secure-in-production, HTTP-only cookies.
- Each surface has separate cookie names and token audiences.
- Unsafe cookie-authenticated requests use double-submit CSRF protection.
- Rate limits and login attempts are enforced; login lockout is database-backed
  so it works across API instances.
- MFA/TOTP and recovery-code support exists where used by the logistics flow;
  verify current policy before claiming it is mandatory for all administrators.
- Payment webhooks verify signatures over the raw request body and prevent
  replay.
- Uploaded file types are checked using magic bytes and size limits.
- Product HTML is sanitized on write and again before browser rendering.
- Private objects use signed, expiring access rather than public URLs.
- Secrets are validated at boot and sensitive values are redacted from logs.
- Live/test payment-key mismatches refuse to start.
- Correlation IDs connect user-facing errors to logs without exposing secrets.
- The audit log is append-only by application design and production DB grants.

## 13. Privacy, accessibility and compliance

Implemented technical controls include:

- GDPR access/export workflow;
- erasure/pseudonymisation workflow with retained-record explanations;
- retention jobs and documented retention settings;
- processor/configuration records;
- private storage separation;
- GPSR/product-responsibility fields;
- medical-device fields such as class, UDI, notified body and intended purpose;
- warning-language and country-restriction support;
- reduced-motion and no-WebGL fallbacks;
- frontend contrast audits and accessibility-oriented focus/keyboard design.

These controls do not replace owner decisions or professional advice. Before a
real EU/Poland launch, the operator still needs decisions and evidence around
controller/processor roles, contracts/DPAs, transfer safeguards, VAT/importer
position, MDR role, DSA marketplace obligations, GPS tracking DPIA, retention,
breach handling, accessibility verification and applicable invoicing rules.

No independent penetration test, load test, prompt-injection red team or full
manual WCAG audit should be assumed unless separately commissioned and recorded.

## 14. Feature and provider boundaries

Important feature flags/defaults in source include:

| Setting | Source default | Meaning |
|---|---:|---|
| `FEATURE_CUSTOMER_SELF_REGISTRATION` | false | Customers may register themselves |
| `FEATURE_STOCK_RESERVATIONS` | true | Reserve stock during order flow |
| `FEATURE_ORDER_APPROVALS` | false | Approval workflow for qualifying orders |
| `FEATURE_RECURRING_ORDERS` | true | Subscription/reorder plans |
| `FEATURE_SCHEDULED_ORDERS` | true | Future one-off purchases |
| `FEATURE_SCHEDULE_ANY_PRODUCT` | true | Scheduling eligibility policy |
| `FEATURE_SUBSCRIPTION_AUTOPAY` | false | Provider mandate charging capability |
| `FEATURE_CUSTOMER_AUTOPAY` | false | Customer-facing auto-pay controls |
| `FEATURE_ERP_INTEGRATION` | false | Operator ERP integration |
| `FEATURE_CUSTOMER_ERP` | false | Buyer-owned ERP connections |
| `FEATURE_ADMIN_LOGIN_LOCATION` | false | Admin location checks |
| `ASSISTANT_ALLOW_GUESTS` | false | AI access without sign-in |
| `FEATURE_LOGISTICS_PORTAL` | false | Carrier portal/routes |

The active values in `backend/.env` or `deploy/compat/.env` are deployment
secrets/configuration and are deliberately not reproduced here.

Provider limitations or unfinished external boundaries that must be described
honestly include:

- seller payout provider/connected accounts are not configured; no real seller
  payout can be claimed;
- bank verification and verified e-signature are not provided;
- document scanning has a hook/state but no malware scanner implementation;
- live carrier adapters for DHL/FedEx/UPS are boundaries, not working calls;
- live driver GPS tracking must not be treated as enabled merely because tables
  exist;
- Google social sign-in is not implemented; Google OAuth appearing elsewhere
  belongs to ERP connectors, not human authentication;
- Redis queue/cache drivers are not implemented;
- tax, shipping, refund, settlement-period and marketplace-payment policies
  require operator decisions.

## 15. Reliability, idempotency and audit principles

Non-negotiable rules:

- Money is not a float.
- Order status changes only through the order state machine.
- Schedule plan and occurrence status changes only through their state machine.
- Scheduled pricing has one implementation: `quoteSchedule`.
- Payment confirmation comes only from a verified provider event.
- Idempotency is structural, commonly enforced by unique constraints.
- Stock reservations must prevent overselling under concurrency.
- Unknown worker job types are returned to the queue during mixed-version
  deploys rather than destroyed.
- A product is never published by import or accident.
- Seller, buyer-organisation and carrier ownership is server-derived.
- Historical order, price, unit and variant facts are retained.
- A listing decision applies to the submitted revision reviewed.
- An unscanned file must never be labelled clean.
- A new personal-data table must be added to or explicitly excluded from the
  GDPR export completeness test.

## 16. Development and verification

Primary local command:

```powershell
.\scripts\dev-stack.ps1
```

Useful variants:

```powershell
.\scripts\dev-stack.ps1 -Status
.\scripts\dev-stack.ps1 -Restart
.\scripts\dev-stack.ps1 -Stop
.\scripts\dev-stack.ps1 -Tunnel
```

Logs go under `.dev-logs/`.

Before committing relevant changes:

```powershell
cd backend
npm run verify

cd ..\apps\customer-web
npm run verify

cd ..\admin-web
npm run verify

cd ..\logistics-web
npm run verify
```

Database-sensitive work should also use:

```powershell
.\scripts\db\audit-xampp.ps1
.\scripts\db\compat-test.ps1
.\scripts\db\validate-data.ps1
```

`compat-test.ps1` runs the production-compatible MariaDB 11.4 image on
`127.0.0.1:3307`, separate from XAMPP on 3306.

Use PowerShell syntax in documentation and commands. Do not use Unix-style
`VAR=value command` examples for this development environment.

## 17. Deployment shape

The documented starting production shape is one VPS with:

- nginx terminating TLS and serving the SPAs;
- three loopback-only API instances;
- one worker;
- MariaDB 11.4;
- object storage for media/private exports;
- SMTP for email;
- separate runtime and migration database users.

Releases are timestamped directories with a `current` symlink. The release
script builds before switching, migrates, rolls API instances one at a time and
checks readiness. Rollback repoints code but does not roll the database back,
which is why expand/contract migrations are required.

Operational design includes encrypted off-site backups, binlog shipping for a
smaller recovery point, restore drills, readiness checks, queue-age monitoring,
disk/inode checks and certificate checks. An external uptime monitor is still
required because an on-box monitor cannot report the loss of its own machine.

## 18. Current working-tree warning

At the time of this briefing, the repository is **not clean**: `git status`
reports 43 modified/untracked entries. Existing work belongs to the developer
and must not be discarded or reset.

Notable work in progress includes:

- seller listing edit/pause attribution and editing screens/services;
- a demonstration catalogue and `DemoCatalogEntry` model/migration;
- home-page collection shelves;
- catalogue visibility/API changes;
- customer-web translations and tests;
- generated Prisma client changes.

When discussing or reviewing a problem, specify whether the target is:

- committed HEAD (`8c26040`), or
- the current working tree including these uncommitted changes.

Do not assume a newly present migration/model/UI file has been applied to the
local database, verified, or committed without checking.

## 19. Documentation rules

Feature changes must keep documentation synchronized:

- `PROJECT-GUIDE.md` - detailed English explanation;
- `PROJECT-GUIDE.hinglish.md` - matching Hinglish guide, intentionally ignored
  by git but maintained locally;
- `README.md` - features, configuration, markets, payments and going live;
- `SETUP.md` - when installation/startup changes;
- `scripts/build-feature-guide-doc.mjs` and generated feature guide - plain
  language for non-technical readers.

The generated `.docx` is not edited by hand.

## 20. Authoritative file map

Attach only the files relevant to the question; uploading the entire repository
usually reduces answer quality.

| Question | Best files to attach/read |
|---|---|
| Complete behavior and rationale | `PROJECT-GUIDE.md` |
| High-level features and commands | `README.md` |
| Local setup | `SETUP.md` |
| Current schema | `backend/prisma/schema.prisma` plus relevant migration |
| Backend architecture/API handoff | `backend/README.md`, `backend/docs/HANDOFF.md` |
| Current routes | relevant file in `backend/src/http/routes/` and `backend/openapi.json` |
| Business behavior | relevant `backend/src/modules/...` service and domain file |
| Product readiness | `docs/PRODUCT-READINESS.md`, but verify its date against current code |
| Deployment/legal decisions | `docs/DEPLOYMENT.md` |
| Database production/migration | `docs/DATABASE-PRODUCTION.md`, `docs/DATABASE-MIGRATION.md` |
| Backup and recovery | `docs/DATABASE-RECOVERY.md`, `backend/docs/RUNBOOK.md` |
| Privacy | `backend/docs/DATA-PROTECTION.md` and privacy module/tests |
| Product safety | `backend/docs/PRODUCT-SAFETY.md` |
| Accessibility | `backend/docs/ACCESSIBILITY.md` |
| Storefront UI | relevant files in `apps/customer-web/src/` |
| Admin UI | relevant files in `apps/admin-web/src/` |
| Logistics UI | relevant files in `apps/logistics-web/src/` |
| Repository working rules | `CLAUDE.md` |

Some older status/handoff documents describe gaps that later code has closed.
For example, the current repository includes buyer organisations and an
erasure implementation even though an older readiness/status section may call
them missing. Prefer the current schema, services, routes, tests and current
`PROJECT-GUIDE.md`; treat dated audits as historical snapshots.

## 21. Good questions to ask GPT

Examples:

- "Review this proposed feature against UBOSS's tenant and money invariants."
- "Trace this customer flow from React page to route, service, transaction and
  tables, identifying failure states and missing tests."
- "Compare the current implementation with the product brief, separating code
  gaps from operator/legal decisions."
- "Review this migration for MariaDB 10.4/11.4 compatibility and rolling-deploy
  safety."
- "Threat-model this endpoint, including authorization, CSRF, SSRF, IDOR,
  idempotency, audit and sensitive-data exposure."
- "Assess whether this feature belongs in the storefront, Seller Hub, admin
  console, logistics portal, API or worker."
- "Design tests that prove tenant isolation and concurrency behavior."
- "Explain this feature to a non-technical business owner without claiming
  unconfigured providers work."

## 22. Question template

```text
Goal:

User/persona affected:

Current behavior:

Desired behavior:

Relevant screen/route/service/table:

Committed HEAD or current dirty working tree:

Constraints that must not change:

What I want from you (analysis/design/review/implementation plan):
```


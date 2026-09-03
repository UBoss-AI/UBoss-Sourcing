# Prompt 1 — implementation status

Last updated: 2026-09-02. Verified against MariaDB 10.4.32 on `127.0.0.1:3306`.

## Verification evidence

| Gate | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | pass (strict, `noUncheckedIndexedAccess`) |
| Lint | `npm run lint` | pass, 0 warnings |
| Tests | `npm test` | **468 passed / 468** |
| Production build | `npm run build` | pass |
| Migrations on empty DB | `prisma migrate deploy` | 2/2 applied, 55 tables |
| API boots | `GET /health/live` | `{"status":"ok"}` |
| Dependencies reachable | `GET /health/ready` | `database ok`, `queue ok` |

---

## Step-by-step

| Step | Scope | Status |
|---|---|---|
| **1. Inspect and bootstrap** | Repo, env validation, logging, health, error envelope, lint/format/test | ✅ **Done** |
| **2. Database schema** | 54 models, 32 enums, indexes, FKs, 82 CHECK constraints | ✅ **Done** |
| **3. Authentication and authorization** | Sessions, refresh rotation, RBAC, invitations, password reset | ✅ **Done** (MFA schema ready, TOTP enrolment not built) |
| **4. Catalog and media APIs** | Category/product CRUD, publication gate, media upload, public + admin routes | ✅ **Done** except CSV/XLSX import |
| **5. Inventory engine** | Ledger, receipts, adjustments, reservations, oversell prevention, low-stock events | ✅ **Done** (admin routes pending) |
| **6. Customers and purchasing limits** | Invite/activate/deactivate, addresses, quantity + order-value rules, monthly spend cap, approval routing | ✅ **Done** |
| **7. Cart, checkout, order state machine** | Cart APIs, repricing on every read, totals breakdown, idempotent checkout, guarded transitions, immutable snapshots | ✅ **Done** |
| **8. Payments, webhooks, payment links** | Razorpay adapter (live test API verified), signed-webhook verification, payment links, refunds, reconciliation | ✅ **Done** (Stripe adapter not written) |
| **9. Recurring purchase engine** | Schedules, timezone-correct recurrence, lease claiming, unique occurrences, re-validation, retries, auto-pause | ✅ **Done** (auto-pay mandate charge deliberately not implemented - see gaps) |
| **10. Notifications, integrations, reports** | Outbox delivery, custom API connector with circuit breaker, reporting endpoints, async exports with expiring signed download | ✅ **Done** |
| **11. Security, observability, recovery** | HTML sanitisation, per-endpoint rate limits, audit writes, Prometheus metrics, runbooks | ✅ **Done** |
| **12. Testing and delivery** | Unit, integration, API, webhook, concurrency, security tests; seed; OpenAPI; integration guide | ✅ **Done** |

**Backend Completion Gate: met.**

| Gate condition | State |
|---|---|
| All migrations apply to an empty database and the app starts | ✅ 2 migrations, 55 tables, 82 CHECK constraints |
| OpenAPI covers implemented endpoints and example error responses | ✅ 98 paths / 119 operations, derived from the live route table; error envelope on every operation |
| Critical automated tests pass, incl. authorization, webhook idempotency, stock concurrency | ✅ 468 tests |
| Admin and Customer API collections or generated clients available | ✅ `openapi.json` → `openapi-typescript`; see `FRONTEND-INTEGRATION.md` |
| No mock payment success, insecure secret storage or placeholder business logic | ✅ verified against the real Razorpay test API; credentials AES-256-GCM with AAD |

Prompt 1 is complete. Prompts 2 (Admin Panel) and 3 (Customer Website) are the
remaining work; `docs/HANDOFF.md` is written for starting them cold.

---

## What is built and proven

**Foundation**
- Zod-validated environment; the process exits on an invalid value rather than
  failing later inside a payment path. Production-only guards reject
  `COOKIE_SECURE=false`, the `log` email driver, `local` storage, and leftover
  `.env.example` placeholders.
- Fastify with a deliberate plugin order; raw-body capture on webhook routes so
  signatures can be verified against untouched bytes.
- Single error envelope with stable codes and a correlation id on every
  response. 500s disclose no stack, driver message or SQL.
- Pino with path-based redaction for credentials, tokens, signatures, card
  fields and address JSON.
- Graceful shutdown with a 15s ceiling, so an in-flight checkout commits.

**Data model** — 54 models covering identity/RBAC, business configuration,
catalog, inventory ledger, customers, cart, orders, payments, recurring
schedules, fulfilment, integrations, notifications, jobs and audit.

**Domain logic (no I/O, fully unit-tested)**
- `money.ts` — BigInt minor units, half-up rounding, inclusive/exclusive tax,
  largest-remainder apportionment.
- `pricing.ts` — server-authoritative line pricing, order-level discount
  apportioned before tax, quantity and order-value rule checks.
- `order-state-machine.ts` — the ten SOP statuses with guarded transitions.
- `permissions.ts` — the 6 SOP roles and 40 permission keys, plus
  `canGrantRole` so an admin can never grant more than they hold.
- `crypto.ts` — Argon2id, hashed single-use tokens, AES-256-GCM with AAD.

**Identity** — separate admin/customer sign-in contexts on one service,
rotating refresh-token families with reuse detection, per-account lockout,
invitation and password-reset tokens (hashed, single-use, expiring).

**Catalog** — publication gated behind a completeness check that returns every
blocker at once; `publicProductWhere()` as the single source of public
visibility; magic-byte image sniffing that ignores the client's Content-Type.

**Inventory** — append-only movement ledger, `SELECT ... FOR UPDATE` oversell
prevention, all-or-nothing reservations, idempotent commit, expiry sweep,
low-stock alerts that fire on the threshold crossing only.

**Customers** — invitation-only onboarding issued inside the creating
transaction, immediate session revocation on deactivation, addresses with a
single enforced default, and four purchasing rules (quantity, order value,
monthly spend cap, approval routing) that report every violation at once.

**Worker** — polling loop with lease reaping, parallel handlers, permanent-vs-
transient error classification, and an outbox safety net that re-dispatches
notifications stranded by a crash between commit and enqueue.

**Cart** — stores product ids and quantities and no prices at all, so every
read reprices from the catalog and a client cannot influence what anything
costs. Publication, stock and purchasing limits are revalidated on every read,
with per-line issues rather than an all-or-nothing failure.

**Checkout** — order row, immutable item snapshots and the stock reservation
commit in one transaction. Order numbers come from a row-locked counter.
Idempotency is enforced on `unique(scope, key)`, with a body hash so a reused
key carrying different data is rejected rather than silently replayed.

**Payments** — Razorpay adapter verified against the live TEST API (real order
created, real status query, no secret in the browser payload). Webhooks are
verified by HMAC over the raw body and matched on amount and currency before
anything is applied. Payment links are hashed, amount-bound, expiring and
single-use. Refunds are capped by the captured amount in the service, the
database and the provider.

**Live-credential guard** — the process refuses to start on an `rzp_live_` or
`sk_live_` key unless `NODE_ENV=production`, and refuses a test key when it
IS production. Verified by booting against both.

**Recurring engine** — wall-clock recurrence in the customer's own IANA zone
(so a DST change does not shift delivery by an hour), month-end clamping,
lease-based claiming without `SKIP LOCKED`, and full re-validation of status,
price, tax, stock, limits and mandate at every occurrence. A price rise past
the approved threshold pauses the schedule instead of charging it.

**Reports** — every figure is a database aggregate, never a sum of a paginated
page. Money stays BigInt and leaves as a string. Windows are half-open, so
adjacent periods cannot double-count a boundary row. Product reports read the
order-item snapshots, so a renamed product still reports what was sold.

**Exports** — built by the worker, paged so memory stays bounded. Downloads use
a hashed, expiring, requester-scoped token rather than a storage key. Files are
deleted when the window closes; the job row survives as an audit record.

**Connector** — HTTPS enforced, credentials AES-256-GCM encrypted, dry run by
default, row-level errors, circuit breaker after repeated failures. It only
ever UPDATES existing products: creating catalog rows from an external feed
would bypass the publication gate.

**HTML sanitisation** — allowlist, applied on WRITE so no reader has to
remember. Links get `noopener noreferrer`; `style`, `javascript:` and `data:`
are dropped; plain-text fields are stripped entirely.

**Metrics** — Prometheus on `/metrics`: request latency and errors, queue and
outbox depth, payment rejections, unreconciled payments, recurring outcomes,
low-stock count. Route labels are registered PATHS, never URLs, so an order id
cannot create a time series per order.

**Runbook** — `docs/RUNBOOK.md` covers backup, verified restore, migration on a
database with no transactional DDL, payment reconciliation, retention, a
production hardening checklist and incident response. RPO, RTO and alert
thresholds are left as `<APPROVE>` rather than invented.

**OpenAPI** — generated from Fastify's live route table, so it cannot document a
path that does not exist. 40 operations carry hand-authored schemas and the
behavioural nuance; the rest carry derived summaries with correct auth, tags and
parameters. A contract test fails on a dangling `$ref` or an undeclared path
parameter, and caught a real collision where two routes used different parameter
names for the same segment.

**Queue** — MariaDB-backed, lease-based claiming that works without
`SKIP LOCKED`, with retry backoff, dead-lettering and lease reaping.

### Tests worth naming

- **10 workers race for 5 jobs** → each claimed exactly once. This is the test
  that validates the whole `SKIP LOCKED` workaround.
- **Inclusive tax never loses a paisa** — `net + tax === gross` across awkward
  amounts.
- **Apportionment never loses or invents a minor unit** across many shapes.
- **AES-GCM AAD binding** — a credential row copied to another record fails to
  decrypt instead of yielding a working secret.
- **Order state machine negatives** — cannot reopen payment on a confirmed
  order, cannot cancel after delivery, `REFUNDED` is terminal, a customer
  cannot fulfil or approve their own order, an admin cannot skip payment.
- **Graph integrity** — every order status is reachable from `DRAFT`, so a rule
  edit cannot silently orphan one.
- **Ten concurrent reservations against a stock of 3** → exactly three succeed,
  and available never goes negative. This is what the raw `FOR UPDATE` buys.
- **Duplicate order confirmation** → stock is reduced once, and one
  `RESERVATION_COMMIT` movement is written, not two.
- **A draft product cannot leak** — not by list, not by direct slug, not after
  its category is deactivated, and the public select is an allowlist so a new
  internal column cannot start appearing.
- **Refresh-token replay** → the whole session family is revoked and audited.
- **Unknown email and wrong password** return an identical code AND message, so
  the login form is not an account-enumeration oracle.
- **A customer cannot raise their own spending cap.** The self-service schema
  omits every limit field, so the attempt is ignored rather than filtered.
- **Cross-customer address access returns 404, not 403** — confirming a record
  exists but belongs to someone else still leaks it.
- **A failed customer creation leaves no invitation token or outbox row**, so a
  rolled-back account cannot have a live activation link.
- **A retried checkout produces one order.** Same key replays the first
  response; same key with a different body is rejected; two concurrent
  submissions still yield exactly one order row.
- **A failed reservation writes no order at all** — no order row, no items, no
  reservation.
- **Editing a product does not rewrite a placed order.** Name, SKU and unit
  price stay as captured, and the stored total is unchanged.
- **An admin cannot move an order to CONFIRMED.** Only SYSTEM can, and only
  from a verified provider event.
- **A forged, tampered, wrongly-signed or unsigned webhook never confirms an
  order** — it is recorded as REJECTED and the order stays PENDING_PAYMENT.
- **A redelivered webhook is a no-op**: paid once, one stock movement, even
  when two deliveries arrive concurrently.
- **A capture whose amount or currency does not match the order is refused**
  and alerted, never applied.
- **A failed payment leaves the order payable and the stock still held**, so
  the customer can retry against the same order.
- **A payment link cannot be reused, resent-and-reused, or used after the
  order total changed.**
- **An over-refund is refused three times over** — service, database CHECK and
  provider.
- **A recurring slot run twice produces one order.** So does the same slot run
  by ten concurrent workers. So does a lease that expires and is reclaimed.
- **Two orders cannot attach to one occurrence** — the unique index refuses it
  even when the service is bypassed entirely.
- **An unpublished or de-eligible product pauses the schedule** and emails the
  customer, rather than quietly charging for a changed basket.
- **A resumed schedule does not fire for missed slots** — the next run is
  recomputed from now, so a month's pause is not a month's backlog.
- **A CSV cell starting with `=` is neutralised**, so an export cannot become
  a spreadsheet formula-injection vector.
- **Internal staff notes never reach an export**, and one admin cannot collect
  another admin's export of customer data.
- **A dead connector opens its circuit** after repeated failures and is refused
  outright rather than timing out on every scheduled sync.
- **Stored XSS is closed**: script tags, event handlers, `javascript:`/`data:`
  URLs, iframes, forms, svg and `style` all fail to survive sanitisation,
  including through nested and malformed markup.
- **An SVG or an HTML file cannot be uploaded as a product image**, whatever
  the client claims its Content-Type is.
- **No admin, with every permission granted, can move an order to CONFIRMED** -
  only SYSTEM, from a verified provider event.
- **A webhook signature is sensitive to whitespace**, proving verification runs
  over the raw bytes rather than a re-serialised object.
- **The OpenAPI document cannot drift from the routes** — it is derived from
  them, and the contract test asserts money is typed as a string, the error
  envelope is published, and idempotent operations declare their header.

### One real bug the tests caught

`needsRehash` was called with only `memoryCost` and `timeCost`. argon2 compares
omitted fields against *its own* defaults (`parallelism: 4`, not our `1`), so
every freshly created hash reported as stale and would have been rehashed on
every single login. Fixed by passing all three cost parameters.

---

## Known gaps and decisions still open

**Gaps in what is built**
- **Admin inventory routes were never written.** `receiveStock`,
  `adjustStock` and the movement ledger exist and are tested, but have no HTTP
  surface. Prompt 2 needs them for the Inventory screen.
- 79 of 119 OpenAPI operations carry a derived summary rather than a
  hand-authored schema. Auth, tags and parameters are correct; response bodies
  for those should be narrowed at the use site.
- **Customer deletion / anonymisation is not implemented.** SOP §17 requires an
  approved policy first: what "delete" means for an account that has orders is
  a business decision, not a technical default.
- MFA is schema-ready but TOTP enrolment is not built.
- **Auto-pay mandate charging is deliberately not implemented.** A schedule set
  to AUTO_PAY creates its order and leaves it PENDING_PAYMENT, with a warning
  logged. Razorpay e-mandate / UPI Autopay requires a registered mandate flow
  this deployment has not set up, and guessing at a charge path is the single
  most dangerous thing that could be written here. PAYMENT_LINK mode is
  complete and is the working recurring path today.
- There is no "run this schedule now" admin action, on purpose: a manual
  trigger is the obvious route to a duplicate charge, and the engine retries on
  its own.
- `prisma migrate dev` prompts interactively and will hang in an automated
  context. Use `db:migrate:deploy` in scripts and CI.
- No OpenAPI document yet; the frontends have no generated client.
- Redis driver is a deliberate throw, not an implementation.
- Local disk storage and the `log` email driver are development-only and are
  rejected at boot in production.

**Blocking business decisions (unchanged from the SOP)**
- Tax and shipping rules, and whether prices are tax-inclusive.
- Whether approval happens before or after payment, and the threshold.
- Refund policy and who may authorise one.
- Recurring-payment consent wording and the provider mandate type.
- Notification sender identity and internal recipient lists.
- Retry timing for recurring failures, to be agreed with the payment provider.

**Payments: what is and is not configured**
- Razorpay TEST credentials are in `.env` and verified against the live test
  API. No real money can move on a `rzp_test_` key.
- The webhook secret is self-generated. Razorpay cannot reach a localhost URL,
  so the dashboard webhook is only configured at deploy time - paste the
  `RAZORPAY_WEBHOOK_SECRET` from `.env` into
  **Account & Settings > Webhooks** then, pointing at the public
  `/api/v1/payments/webhooks/razorpay`.
- Signature verification is tested with locally signed payloads, which is the
  only way to cover forged, tampered and replayed deliveries.
- There is no mock-success path anywhere in the payment module, and none
  should be added.

---

## Recommended next slice

Prompt 2 (Admin Panel). Start with `docs/HANDOFF.md`, then
`docs/FRONTEND-INTEGRATION.md`. The first thing to add on the backend side is
the missing admin inventory routes.

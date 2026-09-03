# Handoff — everything Prompt 2 and Prompt 3 need

Written so the frontend work can start cold, without re-reading the backend.
If you are picking this up with no memory of building it, read this file and
`FRONTEND-INTEGRATION.md`, then start.

---

## Where things are

```
c:\Users\HP\Desktop\UBoss-Software\
├── UBOSS_Sourcing_Software_SOP.docx              business rules
├── UBOSS_Sourcing_Development_Implementation_Plan.docx
├── UBOSS_Claude_Implementation_Prompts.docx      Prompts 1, 2, 3
└── backend\                                      Prompt 1 — COMPLETE
    ├── openapi.json                              98 paths, 119 operations
    ├── docs\
    │   ├── STATUS.md                             step-by-step state
    │   ├── RUNBOOK.md                            ops, backup, incidents
    │   ├── FRONTEND-INTEGRATION.md               ← read this before coding UI
    │   └── HANDOFF.md                            this file
    ├── prisma\schema.prisma                      54 models, 32 enums
    └── src\
```

**Frontends do not exist yet.** Prompt 2 is `apps/admin-web`, Prompt 3 is
`apps/customer-web`. Neither has been started.

---

## The environment, exactly

| Thing | Value |
|---|---|
| Database | **MariaDB 10.4.32** via XAMPP on `127.0.0.1:3306` (XAMPP's "MySQL" IS MariaDB) |
| Databases | `uboss`, `uboss_test`, `uboss_shadow`, `uboss_test_shadow` |
| DB user | `root`, **no password** (dev only) |
| Node | v24.20.0, npm 11.19.0 |
| API | `http://localhost:4000` |
| Admin origin | `http://localhost:5173` (expected by CORS) |
| Customer origin | `http://localhost:5174` (expected by CORS) |
| Razorpay | TEST keys in `.env`, verified against the live test API |
| MySQL CLI | `/c/xampp/mysql/bin/mysql.exe -u root --protocol=TCP -h 127.0.0.1 -P 3306` |

### Start it

```bash
cd c:/Users/HP/Desktop/UBoss-Software/backend
npm run dev          # API  :4000
npm run dev:worker   # worker (needed for emails, recurring, exports)
npm run db:seed      # idempotent
npm run verify       # typecheck + lint + 468 tests
```

### Seeded logins

| Surface | Email | Password | Role |
|---|---|---|---|
| Admin | `owner@uboss.local` | `OwnerDev!2026` | business_owner |
| Admin | `catalog@uboss.local` | `CatalogDev!2026` | catalog_manager |
| Admin | `inventory@uboss.local` | `StockDev!2026` | inventory_manager |
| Admin | `orders@uboss.local` | `OrdersDev!2026` | order_manager |
| Admin | `finance@uboss.local` | `FinanceDev!2026` | finance_approver |
| Customer | `buyer@acme.local` | `BuyerDev!2026` | active |
| Customer | `invited@zenith.local` | — | pending invitation |

Dev credentials only.

---

## MariaDB 10.4 constraints that shaped the backend

Not oversights — properties of the database the client runs. They explain code
that would otherwise look odd:

| Missing | Consequence |
|---|---|
| `FOR UPDATE SKIP LOCKED` (10.6+) | Job and schedule claiming use lease-based conditional `UPDATE` + `affectedRows`. Proven by concurrency tests. |
| Native `UUID` type (10.7+) | IDs are ULIDs in `CHAR(26)` — sortable, InnoDB-friendly. **Every id is 26 chars**; frontends should validate that length. |
| Transactional DDL | A failed migration cannot roll itself back. See RUNBOOK §4. |
| — | A MySQL `UNIQUE` treats every `NULL` as distinct, so composite uniques store `variantKey` (`''` for base product), never `NULL`. |

Server timezone is `Asia/Calcutta`; the app pins its session to UTC.

---

## Non-negotiable invariants the frontends must respect

These are enforced server-side. A frontend that fights them will produce bugs
that look like backend bugs.

1. **Money is never a number.** Every amount is `{ minor, formatted, currency }`
   with `minor` a **string** of integer minor units. Use `BigInt` for
   arithmetic. Never `parseFloat`.
2. **The client never computes a total.** Send items; render what the server
   returns. `GET /cart` reprices on every call.
3. **Payment success comes only from the webhook.** A redirect back from
   Razorpay proves nothing. Poll `/payments/orders/:orderId/status` and show
   "Processing" until it says confirmed.
4. **Checkout and payment need `Idempotency-Key`.** Same key + same body →
   replays. Same key + different body → rejected. Generate one per attempt,
   reuse it on retry.
5. **Order history is immutable.** `order_items` are snapshots. Never display
   an order by joining the live catalog.
6. **Only Active + Published products are public.** Everything else 404s,
   including by direct slug.
7. **Admin UI gates on `permissions`** from `/auth/me`, not on role names.
8. **Order actions come from `availableTransitions`** on the admin order
   detail. Render exactly those buttons — what it offers is what the API will
   accept.

---

## Auth, precisely

Cookies are httpOnly and set automatically. The one thing the frontend must do
by hand:

```
POST /api/v1/auth/login  →  { user, accessToken, csrfToken }
                                                 ^^^^^^^^^
   Store csrfToken. Send it as `X-CSRF-Token` on EVERY subsequent
   POST/PATCH/DELETE. Without it: 403 FORBIDDEN, "CSRF validation failed".
```

- `credentials: 'include'` on every fetch.
- Admin: `/api/v1/admin/auth/*`. Customer: `/api/v1/auth/*`. Never mix.
- On 401 `SESSION_EXPIRED`, call `POST .../auth/refresh` once, then retry.
- On 401 `REFRESH_TOKEN_REUSED`, do **not** retry — send them to login. The
  whole session family was revoked because a token leaked.

---

## Error handling

Every failure, including 500s:

```json
{ "error": { "code": "QUANTITY_BELOW_MINIMUM",
             "message": "...",
             "details": [{ "field": "items.0.quantity", "code": "...", "meta": { "minimum": 10 } }],
             "correlationId": "01M1H..." } }
```

Map `code` to your own copy. `details[].field` is a dotted path for attaching
errors to form inputs. Show `correlationId` on 500s so support can trace it.

The full code list is `src/domain/errors.ts` — it is a published contract.

---

## What is deliberately NOT built

Do not "fix" these; each is a decision.

| Not built | Why |
|---|---|
| **Auto-pay mandate charging** | Razorpay e-mandate/UPI Autopay needs a registered flow this deployment lacks. AUTO_PAY schedules create the order and leave it PENDING_PAYMENT. **PAYMENT_LINK mode is the working recurring path.** |
| **"Run schedule now" admin action** | A manual trigger is the obvious route to a duplicate charge. |
| Stripe adapter | Interface exists; only Razorpay is implemented. |
| CSV/XLSX product import | Step 4 sub-item, skipped. |
| MFA (TOTP) enrolment | Schema ready, flow not built. |
| Customer delete/anonymise | SOP §17 needs an approved policy first. |
| Redis queue driver | Throws deliberately. `QUEUE_DRIVER=database` works. |

---

## Prompt 2 (Admin Panel) — what exists to build against

Route groups, all under `/api/v1/admin/`, all permission-gated. Every gap
listed in the Prompt 1 handoff has since been closed; the backend is complete
for the Admin Panel.

| Screen | Endpoints |
|---|---|
| Dashboard | `GET /dashboard` — one call, every panel, includes `alerts` |
| Categories | `GET/POST /categories`, `PATCH/DELETE /categories/:id` |
| Products | `GET/POST /products`, `GET/PATCH/DELETE /products/:id`, `PATCH /products/:id/publication`, `POST /products/:id/media` |
| Variants | `GET/POST /products/:id/variants`, `PATCH/DELETE /products/:id/variants/:variantId` |
| Bulk import | `GET /products/import/template` (CSV), `GET /products/import/columns`, `POST /products/import` (upload → preview), `POST /products/import/:id/confirm`, `GET /products/import`, `GET /products/import/:id` |
| Inventory | `GET /inventory`, `POST /inventory/receive`, `POST /inventory/adjust`, `GET /inventory/movements`, `GET /inventory/low-stock` |
| Customers | `GET/POST /customers`, `GET/PATCH /customers/:id`, `PATCH .../limits`, `PATCH .../status`, `POST .../invite`, addresses |
| Staff & roles | `GET/POST /staff`, `PATCH /staff/:id/roles`, `PATCH /staff/:id/status` |
| Orders | `GET /orders`, `GET /orders/:id` (with `availableTransitions`), `POST /orders/:id/transition`, `/approval`, `PATCH /orders/:id/note` |
| Fulfilment | `GET /orders/:id/shippable`, `POST /orders/:id/shipments`, `POST /orders/:id/returns`, `POST /returns/:id/inspect` |
| Payments | `GET /payments`, `GET /payments/webhook-health`, `POST /orders/:id/payment-links`, `GET /orders/:id/refund-quote`, `POST /orders/:id/refunds` |
| Gateway setup | `PUT /payments/connections` (save), `GET /payments/connections` (masked), `POST /payments/connections/:id/test`, `PATCH /payments/connections/:id/status` |
| Schedules | `GET /schedules`, `GET /schedules/:id`, `POST .../pause`, `.../resume`, `DELETE` |
| Settings | `GET/PUT /settings/business`, `GET/POST/PATCH /settings/tax-classes`, `GET/PATCH /settings/feature-flags`, `GET /settings/feature-flags/:key/impact` |
| Reports | `GET /reports/{sales,orders,payments,inventory,customers,recurring}` |
| Exports | `POST /exports`, `GET /exports`, `GET /exports/:id` → token → `GET /api/v1/exports/download/:token` |
| Integrations | `GET/POST /integrations`, `POST /integrations/:id/{test,sync}`, `PATCH .../status`, `GET /integrations/sync-runs/:id` |
| Audit | `GET /audit-logs` |

Permission keys are in `src/domain/permissions.ts` (40 keys, 6 roles).

### Gateway setup — the order the UI must follow

`PUT /payments/connections` saves credentials and **always** sets
`isActive: false` and clears `lastTestStatus`. `PATCH .../status` with
`{ active: true }` is refused unless `lastTestStatus === 'OK'`, and only
`POST .../:id/test` writes that field. So the Integrations screen is a
three-step flow — Save → Test → Activate — and there is no way to shortcut it.
A failed test also deactivates the connection: credentials that have stopped
working must not keep taking payments.

A key whose prefix disagrees with the selected mode (`rzp_live_` filed under
TEST, or the reverse) is rejected at save. Secrets are AES-256-GCM encrypted
with the connection id as AAD and never leave the server — `GET` returns
`credentialsMask` and `hasWebhookSecret` only.

### Bulk import — the contract

Upload never writes. `POST /products/import` returns a **preview job**; the
catalogue changes only when `POST /products/import/:id/confirm` is called.

- Preview and confirm run the *same* validator, so the preview cannot promise
  something the import will not do.
- Confirm re-reads the file and re-validates against the current database. A
  category archived between preview and confirm turns a valid row into an
  error, and the confirm is refused.
- A file with any row error imports **nothing** unless the caller passes
  `{ "skipInvalidRows": true }`.
- A preview can be confirmed once. A second attempt returns `CONFLICT`.
- `sku` is the identity: an existing SKU updates, a new one creates. Import
  **never deletes** and **never publishes** — it can set a product ACTIVE, but
  putting it on the Customer Website stays a separate, explicit act.
- CSV only (UTF-8, RFC 4180). XLSX is refused with a message telling the user
  to export as CSV. Row numbers in errors match what Excel shows.
- Limits: 5000 rows, 8 MB, 500 recorded errors per job (`pagination.truncated`
  says when the list was cut).

---

## Prompt 3 (Customer Website) — what exists to build against

| Screen | Endpoints |
|---|---|
| Home / category / search | `GET /catalog/products` (page, limit, category, q, minPrice, maxPrice, recurringOnly, sort), `GET /catalog/categories` |
| Product detail | `GET /catalog/products/:slug` |
| Activation | `POST /auth/invitations/accept` |
| Auth | `POST /auth/{login,logout,refresh}`, `/auth/password/{forgot,reset,change}`, `GET /auth/me` |
| Account | `GET/PATCH /account/profile`, `GET/POST /account/addresses`, `PATCH/DELETE /account/addresses/:addressId`, `GET /account/config` |
| Cart | `GET /cart`, `POST /cart/items`, `PATCH/DELETE /cart/items/:itemId`, `DELETE /cart` |
| Checkout | `POST /cart/checkout` (**Idempotency-Key required**) |
| Payment | `POST /payments/orders/:orderId/session`, `GET .../status`, `POST .../reconcile` |
| Payment link (payer) | `GET /payments/links/:token`, `POST /payments/links/:token/pay` |
| Orders | `GET /orders`, `GET /orders/:id`, `POST /orders/:id/cancel` |
| Recurring | `GET/POST /recurring-schedules`, `GET/PATCH /recurring-schedules/:id`, `POST .../pause`, `.../resume`, `DELETE` |

Guest browsing works; checkout requires an activated customer.

### The cart contract, which drives most of the UI

`GET /cart` returns per-line `issues[]` and a top-level `checkoutReady`.
Disable Checkout on `checkoutReady === false` and render each line's `issues`
inline. Codes you will see: `INSUFFICIENT_STOCK`, `QUANTITY_BELOW_MINIMUM`,
`QUANTITY_INCREMENT_INVALID`, `CART_ITEM_UNAVAILABLE`.

**`qtyIncrement` counts from `minOrderQty`, not from zero.** Min 10 / increment
5 permits 10, 15, 20 — not 5. Build the stepper accordingly.

---

## Payment flow, end to end

```
1. POST /cart/checkout          (Idempotency-Key)  → orderId, status PENDING_PAYMENT
2. POST /payments/orders/:id/session (Idempotency-Key) → checkoutPayload
3. Open Razorpay Checkout with checkoutPayload
4. Razorpay redirects back → show "Processing"      ← NOT proof of payment
5. Poll GET /payments/orders/:id/status until orderStatus === 'CONFIRMED'
6. If it never confirms: POST /payments/orders/:id/reconcile
```

Locally, Razorpay cannot reach `localhost`, so step 5 will not confirm on its
own. Two options for development:
- Expose the API with a tunnel and point a Razorpay dashboard webhook at
  `<public>/api/v1/payments/webhooks/razorpay` with the
  `RAZORPAY_WEBHOOK_SECRET` from `.env`.
- Or drive the state directly for UI work; the webhook path is covered by 21
  backend tests.

Test cards: Razorpay test mode, e.g. `4111 1111 1111 1111`, any future expiry,
any CVV. **No real money can move on an `rzp_test_` key** — and the process
refuses to start on a live key outside production.

---

## Backend state

| Gate | Result |
|---|---|
| `npm run typecheck` | pass, strict |
| `npm run lint` | pass, 0 warnings |
| `npm test` | **492 / 492** |
| `npm run build` | pass |
| Migrations | 2, applied; 55 tables, 82 CHECK constraints |

Prompt 1 is complete (steps 1–12), and every backend gap the Admin Panel
needed is now closed: admin inventory routes, settings and tax classes, staff
and role management, fulfilment (shipments and returns), product variants,
gateway credential setup with a real connection test, and bulk product import.

`openapi.json` is generated from the live Fastify route table — 135 paths,
165 operations — so it cannot drift from what the server actually serves.

Remaining open items are business decisions, not code; they are listed below
and in `docs/STATUS.md`.

---

## Business decisions still open (unchanged since day one)

Ask the client before production:

- Tax rate and whether prices are tax-inclusive (seeded: **18% GST, exclusive**)
- Shipping rules (seeded: **flat ₹99, free above ₹5,000**)
- Whether approval happens before or after payment, and the threshold
- Refund policy and who may authorise
- Recurring consent wording and provider mandate type
- Notification sender identity and internal recipient lists
- RPO, RTO, availability target, alert thresholds (`<APPROVE>` in RUNBOOK)
- What "delete a customer" means when they have orders

---

## Working notes for whoever continues

- **Do not write files with shell heredocs containing regexes.** Backslashes get
  eaten: `\d` became `d` twice during this build, once silently breaking a
  payment amount validator. Use the Edit/Write tools.
- `prisma migrate dev` prompts and will hang in a script. Use
  `db:migrate:deploy`.
- `tsx -e` cannot resolve relative imports — write a temp file instead.
- Node's `/tmp` on Windows resolves to `C:\tmp`, which does not exist. Use the
  scratchpad directory.
- The FK on `audit_logs.actorUserId` catches passing a `customerProfileId`
  where a user id belongs. It already caught one real bug.

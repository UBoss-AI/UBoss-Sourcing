# Frontend integration guide

For the Admin Panel (Prompt 2) and Customer Website (Prompt 3).

The machine-readable contract is `openapi.json` — regenerate it with
`npm run openapi:export`. This document covers the parts a schema cannot
express: why the API behaves as it does, and what a frontend must not assume.

---

## 1. Generating a typed client

```bash
cd backend && npm run openapi:export      # writes openapi.json

# In the frontend
npx openapi-typescript ../backend/openapi.json -o src/api/schema.d.ts
```

The document is derived from Fastify's **live route table**, so it cannot list
a path that does not exist. Request and response schemas for the 40 most
important operations are hand-authored; the rest carry a derived summary and
correct auth, tags and parameters. Treat those response bodies as `unknown` and
narrow at the use site.

Regenerate whenever the backend changes. A contract test
(`tests/integration/openapi.test.ts`) fails if a `$ref` dangles or a path
parameter goes undeclared.

---

## 2. Money — the rule that breaks things quietly

**Money is never a JSON number.**

```json
{ "minor": "149950", "formatted": "1499.50", "currency": "INR" }
```

- `minor` is an integer count of the currency's minor unit (paise), **as a
  string**.
- `formatted` is for display only.
- Never `parseFloat`. Never `Number()`. Above 2^53 paise a JS number silently
  loses precision, and a financial UI is exactly where that matters.

```ts
type Money = { minor: string; formatted: string; currency: string };

// Arithmetic, if you must do any:
const total = BigInt(a.minor) + BigInt(b.minor);

// Display: use `formatted`, or format the BigInt yourself.
```

Requests that carry money take a **string of minor units**:

```json
{ "basePriceMinor": "149950" }   // ✅ 1499.50
{ "basePriceMinor": "1499.50" }  // ❌ rejected: INVALID_MONEY
{ "basePriceMinor": 149950 }     // ❌ rejected: not a string
```

Prices, tax and totals are computed server-side. The client sends items and
renders the result. There is no endpoint that accepts a total.

---

## 3. Errors

Every failure — validation, permission, conflict, 500 — has one shape:

```json
{
  "error": {
    "code": "QUANTITY_BELOW_MINIMUM",
    "message": "Hex Bolt M12: the minimum order quantity is 10.",
    "details": [
      { "field": "items.0.quantity",
        "code": "QUANTITY_BELOW_MINIMUM",
        "message": "...",
        "meta": { "minimum": 10, "requested": 3 } }
    ],
    "correlationId": "01M1H8V6PEW6W6KFE4QGRK9YSS"
  }
}
```

**Branch on `code`, not on `message`.** Codes are a published contract; messages
are prose and may change. The full list is `src/domain/errors.ts`.

`details[].field` is a dotted path — `items.0.quantity` — so it maps directly
onto a form field. `meta` carries machine-readable context to interpolate.

Show `correlationId` on a 500. It is in the server logs.

### Codes worth handling explicitly

| Code | What the UI should do |
|---|---|
| `SESSION_EXPIRED` | Refresh once, retry once, then log out. |
| `REFRESH_TOKEN_REUSED` | Log out immediately. **Do not retry.** |
| `PERMISSION_DENIED` | The action should not have been offered. Hide it. |
| `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY` | A bug in your client — the key was reused for a different request. |
| `IDEMPOTENT_REQUEST_IN_PROGRESS` | Wait and retry the same key. Do not start a new one. |
| `PRODUCT_INCOMPLETE_FOR_PUBLISH` | Render `details` as a checklist. Every blocker is returned at once. |
| `INSUFFICIENT_STOCK` | `meta.available` says how many remain. |
| `CUSTOMER_SPEND_CAP_EXCEEDED` | `meta.remainingMinor` says what is left this month. |
| `PAYMENT_PROVIDER_NOT_CONFIGURED` | Admin has not connected a gateway. Not the customer's problem — say so. |

---

## 4. Authentication

Sessions are httpOnly cookies, set automatically. Two things the frontend must
do by hand.

### CSRF

```ts
const res = await fetch(`${API}/api/v1/auth/login`, {
  method: 'POST',
  credentials: 'include',                    // required, always
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
});

const { user, csrfToken } = await res.json();
// Keep csrfToken in memory. Send it on every POST / PATCH / DELETE.
```

Every cookie-authenticated write needs `X-CSRF-Token`. Without it: 403
`FORBIDDEN`, "CSRF validation failed". GETs do not need it.

A `Authorization: Bearer <accessToken>` request skips CSRF entirely — a browser
cannot attach a Bearer token cross-site. Useful for server-side rendering.

### Two separate surfaces

| | Admin | Customer |
|---|---|---|
| Login | `POST /api/v1/admin/auth/login` | `POST /api/v1/auth/login` |
| Session | `GET /api/v1/admin/auth/me` | `GET /api/v1/auth/me` |

An admin credential presented at the customer endpoint is rejected with the
same generic message as an unknown account, and vice versa. Never share a
client between the two apps.

### Refresh

```ts
// On 401 with code SESSION_EXPIRED — once, then give up.
await fetch(`${API}/api/v1/auth/refresh`, { method: 'POST', credentials: 'include' });
```

On `REFRESH_TOKEN_REUSED`, the whole session family was revoked because a token
leaked. Send the user to login; retrying achieves nothing.

---

## 5. Idempotency

Required on checkout, payment session creation and refunds. The document marks
them `x-idempotency-key: required`.

```ts
// Generate ONCE per user intent. Reuse it on every retry of that intent.
const key = crypto.randomUUID();

await fetch(`${API}/api/v1/cart/checkout`, {
  method: 'POST',
  credentials: 'include',
  headers: {
    'Content-Type': 'application/json',
    'X-CSRF-Token': csrfToken,
    'Idempotency-Key': key,
  },
  body: JSON.stringify(payload),
});
```

| Situation | Result |
|---|---|
| Same key, same body | The first response is replayed. `replayed: true`. **No second order.** |
| Same key, different body | Rejected. Generate a new key. |
| Key still in flight | 409 `IDEMPOTENT_REQUEST_IN_PROGRESS`. Wait, retry the same key. |
| Operation failed | The key is released. Retry it after fixing the problem. |

Generate a new key when the user genuinely starts over. Reusing a key for a
different cart is a client bug the server will catch.

---

## 6. The cart drives most of the storefront

`GET /api/v1/cart` reprices from the catalog on every call and revalidates
publication, stock and purchasing limits. It returns problems rather than
failing:

```json
{
  "cart": {
    "lines": [
      { "itemId": "01...", "name": "Hex Bolt M12", "quantity": 13,
        "unitPrice": { "minor": "4550", "formatted": "45.50", "currency": "INR" },
        "lineTotal": { "minor": "69797", "formatted": "697.97", "currency": "INR" },
        "availableQty": 100,
        "purchaseRules": { "minOrderQty": 10, "maxOrderQty": null, "qtyIncrement": 5 },
        "issues": [
          { "code": "QUANTITY_INCREMENT_INVALID",
            "message": "Hex Bolt M12: order in multiples of 5 starting from 10.",
            "meta": { "increment": 5, "minimum": 10 } }
        ] }
    ],
    "totals": { "subtotal": {...}, "tax": {...}, "shipping": {...}, "grandTotal": {...} },
    "checkoutReady": false,
    "blockingIssues": [],
    "requiresApproval": false,
    "itemCount": 13
  }
}
```

- Disable **Checkout** while `checkoutReady === false`.
- Render each line's `issues` inline on that line.
- Render `blockingIssues` (order value, spend cap) as a cart-level banner.
- If `requiresApproval` is true, tell the customer before they submit — the
  order will go to an approver rather than to payment.

Every mutation returns the whole repriced cart, so there is nothing to
recompute client-side.

### The quantity stepper

`qtyIncrement` counts **from `minOrderQty`, not from zero**. With min 10 and
increment 5: 10, 15, 20 are valid; 5 and 13 are not.

```ts
const steps = (n: number, { minOrderQty, qtyIncrement }: Rules) =>
  minOrderQty + n * qtyIncrement;
```

Adding an item below the minimum silently raises it to `minOrderQty` — a B2B
product should not sit in the cart at 1 and fail only at checkout.

---

## 7. Payment

```
1. POST /api/v1/cart/checkout                    → orderId, PENDING_PAYMENT
2. POST /api/v1/payments/orders/:orderId/session → checkoutPayload
3. Open the provider UI with checkoutPayload
4. Provider returns the browser → show "Processing"
5. Poll GET /api/v1/payments/orders/:orderId/status
6. Stuck? POST /api/v1/payments/orders/:orderId/reconcile
```

**Step 4 is the one that gets built wrong.** A redirect back from Razorpay is
not proof of payment. The browser can be closed, the callback can be forged,
the payment can still fail after the redirect. The authoritative signal is the
signed webhook, and `/status` reports what it established.

```ts
// Never do this:
if (razorpayResponse.razorpay_payment_id) showSuccess();   // ❌

// Do this:
const { orderStatus, paid } = await pollStatus(orderId);   // ✅
if (orderStatus === 'CONFIRMED') showSuccess();
```

`checkoutPayload` contains the **publishable** key only. No secret ever reaches
the browser.

### Retrying a failed payment

A failed payment leaves the order `PENDING_PAYMENT` with its stock still
reserved. Create a **new payment session against the same order** — do not
start a new checkout, which would create a second order.

### Payment-link mode

If the customer chooses `paymentMode: 'PAYMENT_LINK'`, or policy requires it,
the order is created and an approver is emailed. Show "Awaiting payment" and
the order timeline. The payer's page is `GET /api/v1/payments/links/:token` —
unauthenticated, because the payer is Finance reading an email, not a customer
with an account.

---

## 8. Orders

The customer's order list is scoped by session. There is no endpoint that takes
a customer id, so there is nothing to get wrong.

`items[]` are **immutable snapshots** — name, SKU, unit price and tax rate as
they were at checkout. Never render an order by joining the live catalog: a
renamed or repriced product must still show what was actually bought.

### Admin order actions

`GET /api/v1/admin/orders/:id` returns `availableTransitions`:

```json
"availableTransitions": [
  { "to": "PROCESSING", "requiresReason": false, "permission": "order.fulfil" },
  { "to": "CANCELLED",  "requiresReason": true,  "permission": "order.cancel" }
]
```

Render exactly these as buttons. The list already accounts for the order's
status and the operator's permissions, so what it offers is what
`POST /orders/:id/transition` will accept. Prompt a reason when
`requiresReason` is true.

**No admin can move an order to `CONFIRMED`**, whatever permissions they hold.
Only a verified payment event does that. Do not offer it.

---

## 9. Permissions in the Admin UI

`GET /api/v1/admin/auth/me` returns `permissions: string[]`. Gate on those, not
on role names — roles are a grouping, permissions are the contract.

```ts
const can = (p: string) => auth.permissions.includes(p);

{can('product.publish') && <PublishButton />}
{can('refund.create')  && <RefundButton />}
```

Separations worth knowing (from SOP §3):

| Role | Cannot |
|---|---|
| Catalog Manager | configure payments |
| Order Manager | issue refunds (Finance only) |
| Finance / Approver | archive catalog items |
| Inventory Manager | publish products |

The server enforces all of this. Hiding a control the user cannot use is a
courtesy, not the security boundary.

---

## 10. Publishing a product

`PATCH /api/v1/admin/products/:id/publication` runs a completeness check and
returns **every blocker at once**:

```json
{ "error": {
    "code": "PRODUCT_INCOMPLETE_FOR_PUBLISH",
    "details": [
      { "field": "media",         "code": "IMAGE_REQUIRED",  "message": "Add at least one product image before publishing." },
      { "field": "basePriceMinor","code": "PRICE_REQUIRED",  "message": "Set a price greater than zero before publishing." }
    ] } }
```

Render it as a checklist, not a single toast. That is the whole reason it
returns a list.

### Images

`POST /api/v1/admin/products/:id/media`, multipart. The server sniffs the type
from **magic bytes** and ignores the client `Content-Type`. JPEG, PNG, WebP and
GIF only — SVG is refused, because it is a script-capable document.

`descriptionHtml` is sanitised server-side against an allowlist before storage,
so it is safe to render. `<script>`, event handlers, `style`, `javascript:` and
`data:` URLs, iframes and forms do not survive. Links get
`rel="noopener noreferrer nofollow"`.

---

## 11. Recurring schedules

Times are **wall-clock in the schedule's own timezone**, not UTC offsets:

```json
{ "frequency": "EVERY_N_DAYS", "intervalDays": 7,
  "timezone": "Asia/Kolkata", "runAtMinute": 360,
  "startDate": "2026-09-15", "paymentMode": "PAYMENT_LINK",
  "consentAccepted": true }
```

`runAtMinute` is local minutes since midnight (360 = 06:00). A DST change moves
the UTC instant so the local time stays put.

Before activation the UI must show a readable summary and take explicit
consent — the API returns `summary` ("Every 7 days at 06:00 (Asia/Kolkata)")
for exactly this, and rejects `consentAccepted: false` with
`SCHEDULE_CONSENT_REQUIRED`.

Only products flagged `isRecurringEligible` can be scheduled; the flag is on
the public product response, so the UI can hide the option.

Editing or cancelling affects **future runs only**. Completed orders are
untouched. Say so in the confirmation dialog.

> **AUTO_PAY does not charge yet.** Mandate charging is deliberately not
> implemented. An AUTO_PAY schedule creates its order and leaves it awaiting
> payment. Use `PAYMENT_LINK` mode, or hide AUTO_PAY, until a mandate flow is
> agreed with the provider.

---

## 12. Pagination

```json
{ "pagination": { "page": 1, "limit": 25, "total": 143, "totalPages": 6 } }
```

Every list is sorted with `id` as the final tiebreaker, so a row cannot appear
on two pages or be skipped entirely. `limit` is capped server-side (60 on the
public catalog, 100 elsewhere) — do not try to fetch everything at once.

---

## 13. Local development

```bash
# Terminal 1
cd backend && npm run dev            # :4000

# Terminal 2 — needed for emails, recurring runs and exports
cd backend && npm run dev:worker
```

CORS expects `http://localhost:5173` (admin) and `http://localhost:5174`
(customer). Change `ADMIN_WEB_ORIGIN` / `CUSTOMER_WEB_ORIGIN` in `.env` if your
dev server picks a different port — the allowlist is exact, with no wildcards.

**Invitation and reset links** are printed by the worker in development
(`EMAIL_DRIVER=log`). Copy them from its output:

```
http://localhost:5174/activate?token=...
```

Health: `GET /health/live`, `GET /health/ready`. Metrics: `GET /metrics`.

# API reference: every endpoint

> **Generated file - do not edit by hand.** It is rebuilt from
> the route files in `backend/src/http/routes/` and `backend/src/http/app.ts` by `scripts/build-reference-docs.mjs`.
> After changing that code, run `cd scripts; npm run docs` and commit the result.
> `npm run docs:check` fails when this file has fallen behind the code.

This is the complete list. For **how** to call the API - signing in, cookies, money, errors, webhooks, worked examples - read [`../API.md`](../API.md) first.

**784 endpoints** in 66 route groups. Every path starts from the backend's own address, for example `http://localhost:4000`.

## How to read this file

- **Who** is who may call it:
  - **Public** - nobody needs to be signed in.
  - **Customer** - a signed-in storefront customer. **Signed in** - any signed-in user of the named kind.
  - **Seller** - a customer who is also a marketplace seller, with the seller permission shown.
  - **Staff** - a member of the operator's staff, signed in to the admin panel, with the permission shown.
  - **Logistics** - a person from a logistics partner company, signed in to the partner portal.
  - **Webhook (signature)** - called by another system (a payment gateway, a carrier, an ERP). It proves who it is with a signature, not a sign-in.
- **Guard** is the exact check in the code, and the permission it asks for. `TradingSeller` means the seller must be approved and trading, not just applied.
- `:id` in a path is a placeholder: put the real value there.
- **What it does** comes from the comment above the route in the code, or from the OpenAPI summary. Text in *italics* had neither, so it is read from the method and the path - a rough guide, not a promise. [`../API.md`](../API.md) explains the important ones properly.
- A path shown without a trailing slash, such as `/api/v1/cart`, also answers with one (`/api/v1/cart/`).

## Zones

| Zone | Endpoints |
|---|---|
| [Admin panel (staff)](#admin-panel-staff) | 306 |
| [Logistics partner portal](#logistics-partner-portal) | 72 |
| [Seller Hub](#seller-hub) | 218 |
| [Webhooks, integrations and health](#webhooks-integrations-and-health) | 11 |
| [Customer account](#customer-account) | 146 |
| [Public and storefront](#public-and-storefront) | 31 |

## Admin panel (staff)

### `admin/assistant`

Defined in `backend/src/http/routes/assistant.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/assistant/conversations` | Staff | Admin(ASSISTANT_CHAT_READ) | List chat enquiries made through the shopping assistant, a page at a time. Can be searched by name, email or phone, or narrowed to conversations linked to a customer account. |
| GET | `/api/v1/admin/assistant/conversations/:id` | Staff | Admin(ASSISTANT_CHAT_READ) | One chat conversation with the shopping assistant: the visitor's self-declared contact details and the full transcript. Read-only. |

### `admin/attention`

Defined in `backend/src/http/routes/notifications.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/attention` | Staff | Admin | What is still waiting, counted per queue. |

### `admin/audit-logs`

Defined in `backend/src/http/routes/reports.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/audit-logs` | Staff | Admin(AUDIT_READ) | Search the audit trail, newest first, a page at a time: who did what, to which record, when and from where. Filter by action, record, person or date range. Secrets were already blanked out when each entry was written. |

### `admin/auth`

Defined in `backend/src/http/routes/auth.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/admin/auth/login` | Public (admin sign-in) |  | Sign in to the Admin Panel |
| POST | `/api/v1/admin/auth/refresh` | Public (admin sign-in) |  | Rotate the session |
| POST | `/api/v1/admin/auth/mfa/setup` | Signed in | Authenticated('ADMIN') | Start setting up two-step sign-in for a staff account: returns a new authenticator secret and a set of recovery codes. Refused while the person is still on a temporary password, and, when replacing an existing setup, until this session has passed the current two-step check. *Only when `FEATURE_ADMIN_MFA` is on.* |
| POST | `/api/v1/admin/auth/mfa/verify` | Signed in | Authenticated('ADMIN') | Check a two-step sign-in code. In setup mode it switches two-step sign-in on for the account and writes an audit entry; otherwise it confirms this session, accepting either an authenticator code or a one-time recovery code. *Only when `FEATURE_ADMIN_MFA` is on.* |
| POST | `/api/v1/admin/auth/logout` | Signed in | Authenticated(kind) | Sign out of this session only and clear its cookies. |
| POST | `/api/v1/admin/auth/logout-all` | Signed in | Authenticated(kind) | Sign the person out on every device at once. Replies with how many sessions were ended. |
| GET | `/api/v1/admin/auth/me` | Signed in | Authenticated(kind) | Current administrator, with their permission set |
| POST | `/api/v1/admin/auth/session/location` | Signed in | Authenticated(kind) | Record where this admin session was opened from |
| GET | `/api/v1/admin/auth/language` | Signed in | Authenticated(kind) | The interface language for this account. |
| PUT | `/api/v1/admin/auth/language` | Signed in | Authenticated(kind) | Save the interface language the signed-in person wants to read. |
| POST | `/api/v1/admin/auth/password/change` | Signed in | Authenticated(kind) | Change the signed-in person's password, given their current one. Signs the account out of every session, including this one, and writes an audit entry. |
| POST | `/api/v1/admin/auth/password/forgot` | Public (admin sign-in) |  | Ask for a password-reset link. If an active account exists for the email address, a reset link is emailed to it; the reply is the same either way, so nobody can use it to find out who has an account. |
| POST | `/api/v1/admin/auth/password/reset` | Public (admin sign-in) |  | Set a new password using the link from a "forgot password" email. Signs the account out everywhere and writes an audit entry; refused if the link has expired or was already used. |

### `admin/brand-requests`

Defined in `backend/src/http/routes/sellers.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/brand-requests` | Staff | Admin(PRODUCT_READ) | Sellers' requests for new brands still awaiting a decision, oldest first, with how many listings are waiting on each. |
| POST | `/api/v1/admin/brand-requests/:id/decision` | Staff | Admin(PRODUCT_PUBLISH) | Approve, refuse or ask for more information about a seller's request to add a brand, optionally approving it under a corrected spelling. Refused if already decided. Notifies the seller and writes an audit entry. |

### `admin/categories`

Defined in `backend/src/http/routes/catalog.admin.ts`, `backend/src/http/routes/translations.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/categories` | Staff | Admin(CATEGORY_READ) | The full category tree, including inactive categories the storefront hides. |
| POST | `/api/v1/admin/categories` | Staff | Admin(CATEGORY_WRITE) | Create a category, optionally under a parent. Its web address is made from the name unless one is given, and must be unused. Writes an audit entry. |
| PATCH | `/api/v1/admin/categories/:id` | Staff | Admin(CATEGORY_WRITE) | Change a category - its name, web address, parent, description, images, order, visibility or search-engine text. Moving it moves its whole branch. Writes an audit entry. |
| DELETE | `/api/v1/admin/categories/:id` | Staff | Admin(CATEGORY_ARCHIVE) | Archive a category. Refused while products are still in it, and while it has subcategories unless `force=true` is passed, which archives those too (never the products). Writes an audit entry. |
| GET | `/api/v1/admin/categories/:id/translations` | Staff | Admin(CATEGORY_READ) | A category's English text together with every translation saved for it, so a translator can work with the source in front of them. |
| PUT | `/api/v1/admin/categories/:id/translations/:language` | Staff | Admin(CATEGORY_WRITE) | Save a category's name, description and search-engine text in one language other than English. A save from the panel is marked as reviewed by a person unless the caller says otherwise. |
| DELETE | `/api/v1/admin/categories/:id/translations/:language` | Staff | Admin(CATEGORY_WRITE) | Remove a category's copy in one language, so shoppers in that language see the English text again. |

### `admin/coupons`

Defined in `backend/src/http/routes/coupons.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/coupons` | Staff | Admin(COUPON_READ) | List coupons a page at a time, filtered by status or a search term. Archived coupons are left out unless asked for. |
| GET | `/api/v1/admin/coupons/suggest-code` | Staff | Admin(COUPON_WRITE) | A free code, so the form can show one before anything is saved. |
| GET | `/api/v1/admin/coupons/:couponId` | Staff | Admin(COUPON_READ) | One coupon with its categories, minimum cart values and usage so far. |
| POST | `/api/v1/admin/coupons` | Staff | Admin(COUPON_WRITE) | Create a percentage-off coupon, optionally limited to some categories, with a minimum cart value per currency. A code is generated if none is given. Writes an audit entry. |
| PUT | `/api/v1/admin/coupons/:couponId` | Staff | Admin(COUPON_WRITE) | Change a coupon - its code, discount, categories, minimum cart values, status, dates or usage limits. Writes an audit entry. |
| DELETE | `/api/v1/admin/coupons/:couponId` | Staff | Admin(COUPON_ARCHIVE) | Archive a coupon: it leaves every list and can no longer be used, but is kept so past orders that used it still make sense. Writes an audit entry. |

### `admin/currencies`

Defined in `backend/src/http/routes/catalog.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/currencies` | Staff | Admin(PRODUCT_READ) | The currencies this deployment sells in, and which of them hold prices. |

### `admin/customer-erp`

Defined in `backend/src/http/routes/customer-erp.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/customer-erp/connections` | Staff | Admin(INTEGRATION_READ) | Every customer’s ERP connection, with its health |
| GET | `/api/v1/admin/customer-erp/connections/:id/events` | Staff | Admin(INTEGRATION_READ) | One customer connection’s recent events |
| GET | `/api/v1/admin/customer-erp/connections/:id/deliveries` | Staff | Admin(INTEGRATION_READ) | Inbound deliveries on one customer connection |
| GET | `/api/v1/admin/customer-erp/summary` | Staff | Admin(INTEGRATION_READ) | How many customer connections, in what state |

### `admin/customers`

Defined in `backend/src/http/routes/customers.admin.ts`, `backend/src/http/routes/vat.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/customers` | Staff | Admin(CUSTOMER_READ) | List customers a page at a time, searchable and filterable by account status or organisation. |
| GET | `/api/v1/admin/customers/:id` | Staff | Admin(CUSTOMER_READ) | One customer's full record - account status, details, addresses and purchasing limits - with how much they have spent this month against their cap. |
| POST | `/api/v1/admin/customers` | Staff | Admin(CUSTOMER_WRITE, CUSTOMER_INVITE) | Create and invite a customer |
| PATCH | `/api/v1/admin/customers/:id` | Staff | Admin(CUSTOMER_WRITE) | Change a customer's details - name, organisation, department, phone, tax numbers, customer code or internal notes. Writes an audit entry. |
| PATCH | `/api/v1/admin/customers/:id/limits` | Staff | Admin(CUSTOMER_LIMITS_WRITE) | Change purchasing limits |
| PATCH | `/api/v1/admin/customers/:id/status` | Staff | Admin(CUSTOMER_STATUS_WRITE) | Deactivate a customer's account, signing them out everywhere, or reactivate it. An account that never finished setting up goes back to waiting for its invitation. Writes an audit entry with the reason given. |
| POST | `/api/v1/admin/customers/:id/approve` | Staff | Admin(CUSTOMER_STATUS_WRITE) | Let a self-registered account in |
| POST | `/api/v1/admin/customers/:id/invite` | Staff | Admin(CUSTOMER_INVITE) | Email the customer a fresh invitation link to set up their account; any earlier link stops working. Refused if the account is already active or deactivated. Writes an audit entry. |
| POST | `/api/v1/admin/customers/:id/password-reset` | Staff | Admin(CUSTOMER_WRITE) | Start a password reset on the customer's behalf. |
| POST | `/api/v1/admin/customers/:id/addresses` | Staff | Admin(CUSTOMER_WRITE) | Add a saved address to a customer's account. Their first address becomes the default for both billing and shipping. Writes an audit entry. |
| PATCH | `/api/v1/admin/customers/:id/addresses/:addressId` | Staff | Admin(CUSTOMER_WRITE) | Change one of a customer's saved addresses, or make it their default billing or shipping address. Moving the address looks up its map position again where a geocoder is set up. |
| DELETE | `/api/v1/admin/customers/:id/addresses/:addressId` | Staff | Admin(CUSTOMER_WRITE) | Remove one of a customer's saved addresses. Refused while an active or paused recurring schedule still delivers to or bills it. |
| POST | `/api/v1/admin/customers/:id/vat-number/check` | Staff | Admin(CUSTOMER_WRITE) | Check this customer’s VAT number against VIES |

### `admin/dashboard`

Defined in `backend/src/http/routes/reports.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/admin/dashboard/insights/stream` | Staff | Admin | The operational picture, explained. |
| POST | `/api/v1/admin/dashboard/insights` | Staff | Admin | A short written explanation of what is waiting across the platform for this member of staff, optionally answering a question. Uses the AI provider where one is set up and a plain summary otherwise; only queues the caller may see are included. |
| GET | `/api/v1/admin/dashboard` | Staff | Admin(REPORT_READ) | Dashboard aggregates |

### `admin/data-requests`

Defined in `backend/src/http/routes/privacy.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/data-requests` | Staff | Admin(DATA_REQUEST_READ) | The data subject request queue |
| GET | `/api/v1/admin/data-requests/:requestId` | Staff | Admin(DATA_REQUEST_READ) | One data subject request, with its erasure blockers |
| POST | `/api/v1/admin/data-requests/:requestId/approve` | Staff | Admin(DATA_REQUEST_ACTION) | Approve a data subject request |
| POST | `/api/v1/admin/data-requests/:requestId/reject` | Staff | Admin(DATA_REQUEST_ACTION) | Refuse a data subject request |

### `admin/directory`

Defined in `backend/src/http/routes/directory.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/directory` | Staff | Admin + Admin | Search the directory of companies on the platform - sellers, buyers and carriers - a page at a time. Staff see only the kinds their permissions allow, and are refused if they may read neither customers nor carriers. |

### `admin/documents`

Defined in `backend/src/http/routes/documents.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/admin/documents/:kind/:id/link` | Staff | Admin(INVOICE_READ) | Get a short-lived, single-use download link for a seller's invoice or packing list. |
| GET | `/api/v1/admin/documents/:kind/:id/download` | Staff | Admin(INVOICE_READ) | Download a seller's invoice or packing list as a PDF, using a link from the request above. The link works once, only for the admin it was made for, and the download is recorded in the audit log. |

### `admin/economic-operators`

Defined in `backend/src/http/routes/gpsr.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/economic-operators` | Staff | Admin(PRODUCT_READ) | Manufacturers, importers and EU responsible persons |
| POST | `/api/v1/admin/economic-operators` | Staff | Admin(PRODUCT_WRITE) | Add an economic operator |
| PATCH | `/api/v1/admin/economic-operators/:id` | Staff | Admin(PRODUCT_WRITE) | Update an economic operator |
| DELETE | `/api/v1/admin/economic-operators/:id` | Staff | Admin(PRODUCT_WRITE) | Retire an economic operator |

### `admin/erp`

Defined in `backend/src/http/routes/erp.admin.ts`, `backend/src/http/routes/schedules.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/erp/capabilities` | Staff | Admin(SETTINGS_READ) | What this installation offers, and the fields a mapping may name. |
| GET | `/api/v1/admin/erp/connections` | Staff | Admin(INTEGRATION_READ) | Every connection to this installation's own ERP system, oldest first. Stored passwords and keys are never shown. |
| POST | `/api/v1/admin/erp/connections` | Staff | Admin(INTEGRATION_WRITE) + Feature | Add a connection to the installation's ERP system. It starts as a draft that carries no orders until tested and switched on. Refused past the configured maximum number of connections, or when the name is taken. Writes an audit entry. |
| GET | `/api/v1/admin/erp/connections/:id` | Staff | Admin(INTEGRATION_READ) | One ERP connection's settings and status. Stored passwords and keys are never shown. |
| PUT | `/api/v1/admin/erp/connections/:id` | Staff | Admin(INTEGRATION_WRITE) + Feature | Save changes to an ERP connection. This puts it back to draft, so it must be tested again before it carries orders. Writes an audit entry. |
| DELETE | `/api/v1/admin/erp/connections/:id` | Staff | Admin(INTEGRATION_WRITE) + Feature | Retire an ERP connection. Its history is kept. Refused while it still has operations waiting to go through. Writes an audit entry. |
| POST | `/api/v1/admin/erp/connections/:id/test` | Staff | Admin(INTEGRATION_WRITE) + Feature | Test the connection. |
| POST | `/api/v1/admin/erp/connections/:id/dry-run` | Staff | Admin(INTEGRATION_WRITE) + Feature | Dry run: read, map, report, change nothing. |
| POST | `/api/v1/admin/erp/connections/:id/actions` | Staff | Admin(INTEGRATION_WRITE) + Feature | Activate, pause, resume, disable, reopen. The state machine decides. |
| POST | `/api/v1/admin/erp/connections/:id/sync` | Staff | Admin(INTEGRATION_WRITE) + Feature | Pull stock figures from the ERP now. Refused unless the connection is switched on; a dry run, which changes nothing, works at any time. |
| GET | `/api/v1/admin/erp/connections/:id/sync-runs` | Staff | Admin(INTEGRATION_READ) | The connection's recent stock syncs, newest first, with how many records each applied, skipped or failed. |
| GET | `/api/v1/admin/erp/sync-runs/:id/errors` | Staff | Admin(INTEGRATION_READ) | The individual records one stock sync could not apply, and why. |
| GET | `/api/v1/admin/erp/inventory` | Staff | Admin(INTEGRATION_READ) | The stock figures last received from the ERP, per product code and warehouse, including any figure set by hand. Can be narrowed to one connection, a product code, or only the figures that disagree with the platform. |
| POST | `/api/v1/admin/erp/inventory/manual` | Staff | Admin(INTEGRATION_WRITE) + Feature | Set or clear a figure by hand. |
| GET | `/api/v1/admin/erp/events` | Staff | Admin(INTEGRATION_READ) | The ERP activity log, newest first: connection tests, dry runs, orders sent, stock syncs and more. Can be filtered by connection, kind, status or order. |
| POST | `/api/v1/admin/erp/events/:id/retry` | Staff | Admin(INTEGRATION_WRITE) + Feature | Try a failed operation again. |
| GET | `/api/v1/admin/erp/orders/:id/status` | Staff | Admin(INTEGRATION_READ) | Where one order stands with the ERP. The "Paid - ERP pending" view. |
| GET | `/api/v1/admin/erp/order-pushes` | Staff | Admin(INTEGRATION_READ) | Orders the ERP has refused, and that a person now has to look at. |
| POST | `/api/v1/admin/erp/order-pushes/:orderId/retry` | Staff | Admin(INTEGRATION_WRITE) | Push an abandoned order to the ERP again, by hand. |

### `admin/exports`

Defined in `backend/src/http/routes/reports.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/admin/exports` | Staff | Admin(EXPORT_CREATE) | Request an asynchronous export |
| GET | `/api/v1/admin/exports` | Staff | Admin(EXPORT_CREATE) | The caller's own 50 most recent exports, with the status of each. Other staff members' exports are never shown. |
| GET | `/api/v1/admin/exports/:id` | Staff | Admin(EXPORT_CREATE) | Check on one export the caller requested. Once it is ready, and until the link expires, it includes the download token. |

### `admin/fulfilment-methods`

Defined in `backend/src/http/routes/sellers.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/fulfilment-methods/pending` | Staff | Admin(CUSTOMER_READ) | Sellers' delivery methods waiting for approval, oldest submission first. |
| PATCH | `/api/v1/admin/fulfilment-methods/:methodId` | Staff | Admin(CUSTOMER_STATUS_WRITE) | Approve, refuse or ask for changes to a seller's own delivery method, and decide whether it may ship across borders. Tells the seller and writes an audit entry. |

### `admin/integrations`

Defined in `backend/src/http/routes/reports.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/integrations` | Staff | Admin(INTEGRATION_READ) | List the integrations set up with outside systems, each with its latest sync. Credentials are never included. |
| POST | `/api/v1/admin/integrations` | Staff | Admin(INTEGRATION_WRITE) | Set up a connection to an outside system's product feed: its address, how to sign in to it, and which of its fields map to SKU, name, price and stock. It starts switched off. Writes an audit entry. |
| POST | `/api/v1/admin/integrations/:id/test` | Staff | Admin(INTEGRATION_WRITE) | Proves the endpoint answers and reports its field names, for mapping. |
| POST | `/api/v1/admin/integrations/:id/sync` | Staff | Admin(INTEGRATION_WRITE) | Run a sync. |
| PATCH | `/api/v1/admin/integrations/:id/status` | Staff | Admin(INTEGRATION_WRITE) | Switch an integration on or off. Switching on is refused until its last connection test passed. Writes an audit entry. |
| GET | `/api/v1/admin/integrations/sync-runs/:id` | Staff | Admin(INTEGRATION_READ) | The result of one integration sync: whether it was a trial run, how many records it handled and the errors it hit (up to 200). |

### `admin/inventory`

Defined in `backend/src/http/routes/inventory.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/inventory` | Staff | Admin(INVENTORY_READ) | Stock levels, one row per SKU and location. |
| GET | `/api/v1/admin/inventory/availability` | Staff | Admin(INVENTORY_READ) | Live availability for one SKU. Used by the receipt and adjustment dialogs. |
| GET | `/api/v1/admin/inventory/movements` | Staff | Admin(INVENTORY_READ) | Movement history. |
| POST | `/api/v1/admin/inventory/receipts` | Staff | Admin(INVENTORY_RECEIVE) | Receive stock. |
| POST | `/api/v1/admin/inventory/adjustments` | Staff | Admin(INVENTORY_ADJUST) | Adjust stock. |
| GET | `/api/v1/admin/inventory/locations` | Staff | Admin(INVENTORY_READ) | Locations, for the receipt and adjustment dialogs. |
| GET | `/api/v1/admin/inventory/warehouses` | Staff | Admin(INVENTORY_READ) | Warehouses, for the screen that manages them and draws them on a map. |
| POST | `/api/v1/admin/inventory/warehouses` | Staff | Admin(INVENTORY_LOCATION_WRITE) | Open a warehouse. |
| PATCH | `/api/v1/admin/inventory/warehouses/:id` | Staff | Admin(INVENTORY_LOCATION_WRITE) | Correct a warehouse, move it, retire it, or make it the default. |
| DELETE | `/api/v1/admin/inventory/warehouses/:id` | Staff | Admin(INVENTORY_LOCATION_WRITE) | Delete a warehouse that was never used. |
| GET | `/api/v1/admin/inventory/warehouse-countries` | Staff | Admin(INVENTORY_READ) | The countries a warehouse may be in, for the form and the filter. |
| GET | `/api/v1/admin/inventory/seller-search` | Staff | Admin(INVENTORY_READ, CUSTOMER_READ) | Search approved seller companies |
| GET | `/api/v1/admin/inventory/seller-warehouses` | Staff | Admin(INVENTORY_READ, CUSTOMER_READ) | An approved seller's dispatch locations, for the same map and table. |
| GET | `/api/v1/admin/inventory/warehouses/:id/delivery-coverage` | Staff | Admin(INVENTORY_READ) | Which countries this warehouse can deliver to inside a radius. |
| GET | `/api/v1/admin/inventory/world-countries` | Staff | Admin(INVENTORY_READ) | Every country there is, for the exclusion picker. |
| GET | `/api/v1/admin/inventory/warehouses/:id/inventory` | Staff | Admin(INVENTORY_READ) | Everything one warehouse holds, product by product. |
| PUT | `/api/v1/admin/inventory/warehouses/:id/erp-status` | Staff | Admin(INVENTORY_LOCATION_WRITE) | Where a warehouse stands with the ERP. |
| POST | `/api/v1/admin/inventory/warehouses/geocode` | Staff | Admin(INVENTORY_LOCATION_WRITE) | An address to coordinates, so nobody has to look up a warehouse's latitude by hand. |
| POST | `/api/v1/admin/inventory/warehouses/geocode/suggest` | Staff | Admin(INVENTORY_LOCATION_WRITE) | The same lookup, answering with every candidate rather than the first. |

### `admin/invoices`

Defined in `backend/src/http/routes/vat.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/invoices/:id` | Staff | Admin(INVOICE_READ) | One invoice or credit note |
| GET | `/api/v1/admin/invoices/:id/ubl` | Staff | Admin(INVOICE_READ) | The invoice as EN 16931 UBL |
| GET | `/api/v1/admin/invoices/:id/en16931-check` | Staff | Admin(INVOICE_READ) | What a receiver’s validator would object to |
| POST | `/api/v1/admin/invoices/:id/credit` | Staff | Admin(INVOICE_ISSUE) | Reverse an invoice with a credit note |

### `admin/logistics`

Defined in `backend/src/http/routes/logistics.admin.ts`, `backend/src/http/routes/logistics-levels.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/logistics/delivery-catalogue` | Staff | Admin(LOGISTICS_READ) | Every way anything gets delivered here, in one call. |
| GET | `/api/v1/admin/logistics/delivery-catalogue/partners` | Staff | Admin(LOGISTICS_READ) | The partner table, with the filters the brief asks for. |
| GET | `/api/v1/admin/logistics/partners` | Staff | Admin(LOGISTICS_READ) | The list of carriers, filterable by status or a name or code search, with team size, region count and how many open shipments each holds. |
| GET | `/api/v1/admin/logistics/partners/:id` | Staff | Admin(LOGISTICS_READ) | Everything about one carrier: registration, contacts, contract, limits, regions, capabilities, delivery-time commitments, team members and the marketplace's private notes about it. |
| POST | `/api/v1/admin/logistics/partners` | Staff | Admin(LOGISTICS_WRITE) | Add a new carrier and invite its first owner, who is emailed a one-time link to set a password. The carrier starts as pending and only becomes active when the marketplace activates it. Writes an audit entry. |
| POST | `/api/v1/admin/logistics/partners/:id/status` | Staff | Admin(LOGISTICS_WRITE) | Activate, suspend or close a carrier. Suspending or closing needs a reason. A suspended carrier gets no new work but can finish what it holds, unless its open shipments are also asked to be taken back. Writes an audit entry. |
| PUT | `/api/v1/admin/logistics/partners/:id/regions` | Staff | Admin(LOGISTICS_WRITE) | Replace a carrier's approved service regions (countries, states, cities or postcode areas, for pickup and delivery) with the list given. Only the marketplace can set these. Writes an audit entry. |
| POST | `/api/v1/admin/logistics/partners/:id/capabilities` | Staff | Admin(LOGISTICS_WRITE) | Approve, refuse or suspend one special-handling capability for a carrier, such as cold chain or dangerous goods, with its evidence. Only approved capabilities make a carrier eligible for shipments that need them. Writes an audit entry. |
| PUT | `/api/v1/admin/logistics/partners/:id/sla-policies` | Staff | Admin(LOGISTICS_WRITE) | Create or replace one of a carrier's delivery-time commitments: pickup and delivery hours for a service type, delivery attempts, and what proof of delivery must include. Writes an audit entry. |
| POST | `/api/v1/admin/logistics/partners/:id/invitations` | Staff | Admin(LOGISTICS_WRITE) | Invite a person to join a carrier's portal team with a given role. Emails them a one-time link to set a password; the link itself is never returned. |
| GET | `/api/v1/admin/logistics/shipments` | Staff | Admin(LOGISTICS_READ) | Every consignment, across every carrier, narrowed the way an operations desk actually thinks about them. |
| GET | `/api/v1/admin/logistics/tracking-filters` | Staff | Admin(LOGISTICS_READ) | What there is to filter the tracking list BY. |
| GET | `/api/v1/admin/logistics/shipments/:id` | Staff | Admin(LOGISTICS_READ) | One consignment, as the operator sees it. |
| PATCH | `/api/v1/admin/logistics/shipments/:id/manual-booking` | Staff | Admin(LOGISTICS_ASSIGN) | Enter what a seller's outside carrier gave them, on the seller's behalf. |
| POST | `/api/v1/admin/logistics/orders/:id/shipments` | Staff | Admin(LOGISTICS_ASSIGN) | Raise the consignments for an order. |
| GET | `/api/v1/admin/logistics/shipments/:id/eligible-partners` | Staff | Admin(LOGISTICS_ASSIGN) | Which carriers could take this shipment, and for those that cannot, the reason (no coverage, missing approval, over capacity and so on). |
| POST | `/api/v1/admin/logistics/shipments/:id/assign` | Staff | Admin(LOGISTICS_ASSIGN) | Offer a shipment to a carrier, with an optional deadline for it to answer. The carrier is notified. Refused when the carrier is not active, or the shipment is already with a carrier. |
| POST | `/api/v1/admin/logistics/shipments/:id/withdraw` | Staff | Admin(LOGISTICS_ASSIGN) | Take a shipment back from the carrier it was offered to or accepted by, with a reason. The shipment goes back to waiting for a carrier, and the carrier is notified and sees the reason in its activity log. |
| POST | `/api/v1/admin/logistics/shipments/:id/correct-status` | Staff | Admin(LOGISTICS_ASSIGN) | Correct a status the carrier got wrong. |
| GET | `/api/v1/admin/logistics/partners/:id/drivers` | Staff | Admin(LOGISTICS_READ) | One carrier's drivers, those on the rota first, with their certifications, app access, location-sharing consent and open tasks. |
| POST | `/api/v1/admin/logistics/partners/:id/drivers` | Staff | Admin(LOGISTICS_WRITE) | Add somebody to a carrier’s fleet, on their behalf. |
| PATCH | `/api/v1/admin/logistics/partners/:id/drivers/:driverId` | Staff | Admin(LOGISTICS_WRITE) | Change a carrier's driver details, or take them off the rota, on the carrier's behalf. Only the fields supplied are changed. |
| GET | `/api/v1/admin/logistics/partners/:id/vehicles` | Staff | Admin(LOGISTICS_READ) | One carrier's vehicles, in-service ones first. |
| POST | `/api/v1/admin/logistics/partners/:id/vehicles` | Staff | Admin(LOGISTICS_WRITE) | Add a vehicle to a carrier's fleet list on its behalf. Refused when that registration is already on the list. Recorded in the carrier's activity log. |
| POST | `/api/v1/admin/logistics/shipments/:id/assign-driver` | Staff | Admin(LOGISTICS_ASSIGN) | Put a driver on a consignment, or move it to another driver. |
| POST | `/api/v1/admin/logistics/shipments/:id/unassign-driver` | Staff | Admin(LOGISTICS_ASSIGN) | Take the driver off a shipment without putting another one on, with a reason, on behalf of the carrier that holds it. Refused when the shipment is not with a carrier yet. |
| POST | `/api/v1/admin/logistics/shipments/:id/status-events` | Staff | Admin(LOGISTICS_ASSIGN) | Move the consignment along: dispatched, on the way, delivered. |
| GET | `/api/v1/admin/logistics/exceptions` | Staff | Admin(LOGISTICS_READ) | Delivery problems across every carrier, most severe and oldest first, a page at a time. Shows only open ones unless asked otherwise, and can be narrowed by severity. |
| GET | `/api/v1/admin/logistics/integrations` | Staff | Admin(LOGISTICS_READ) | The carrier connections, with what each provider needs to be set up. Credentials are never returned, only a masked hint of which key is configured. |
| PUT | `/api/v1/admin/logistics/integrations` | Staff | Admin(LOGISTICS_INTEGRATION_WRITE) | Create or update a carrier connection: provider, name, address, credentials, polling and webhook settings. Credentials are stored encrypted, and the connection counts as configured only once it has some. Writes an audit entry. |
| POST | `/api/v1/admin/logistics/integrations/:id/test` | Staff | Admin(LOGISTICS_INTEGRATION_WRITE) | Try a carrier connection and record the result. An unconfigured one fails and says which settings it still needs; success is only reported for a carrier that was actually reached. |
| POST | `/api/v1/admin/logistics/integrations/:id/rotate-secret` | Staff | Admin(LOGISTICS_INTEGRATION_WRITE) | Mint a new webhook signing secret. |
| PUT | `/api/v1/admin/logistics/integrations/:id/status-mappings` | Staff | Admin(LOGISTICS_INTEGRATION_WRITE) | Say what one of a carrier's own status codes means here: which shipment status it moves to, and optionally which kind of delivery problem it raises. Adds the mapping, or replaces the existing one for that code. Writes an audit entry. |
| GET | `/api/v1/admin/logistics/integrations/known-codes` | Staff | Admin(LOGISTICS_READ) | What this build already knows about a provider's codes. |
| GET | `/api/v1/admin/logistics/managed-levels` | Staff | Admin(LOGISTICS_READ) | Every seller's delivery-level policy in force: who runs each of the four levels and which still have no published price. Can be narrowed to sellers with a UBOSS-run level, those missing a UBOSS price, or by seller name. |
| GET | `/api/v1/admin/logistics/managed-levels/sellers/:sellerAccountId` | Staff | Admin(LOGISTICS_READ) | One seller's delivery-level policy as UBOSS sees it, with its version and change history and the marketplace carriers that can be named on it. |
| POST | `/api/v1/admin/logistics/managed-levels/sellers/:sellerAccountId/rates` | Staff | Admin(LOGISTICS_WRITE) | Add a draft price for a delivery level UBOSS controls for this seller. Refused on a level the seller controls. Recorded in both the admin audit log and the seller's own history. |
| PUT | `/api/v1/admin/logistics/managed-levels/rates/:rateId` | Staff | Admin(LOGISTICS_WRITE) | Edit a delivery-level price UBOSS sets for a seller. Editing a published price creates a new draft that replaces it once published. Refused on a level the seller controls. Recorded in both audit logs. |
| POST | `/api/v1/admin/logistics/managed-levels/rates/:rateId/publish-price` | Staff | Admin(LOGISTICS_WRITE) | Publish a draft delivery-level price for a seller, replacing the price it supersedes. Recorded in both the admin audit log and the seller's own history. |
| POST | `/api/v1/admin/logistics/managed-levels/rates/:rateId/deactivate` | Staff | Admin(LOGISTICS_WRITE) | Switch off a delivery-level price that UBOSS sets for a seller. It stays on record, and orders already charged at it keep it. Recorded in both the admin audit log and the seller's own history. |
| GET | `/api/v1/admin/logistics/presentation` | Staff | Admin(SETTINGS_READ) | Whether buyers see each level's price or one delivery line. |
| PUT | `/api/v1/admin/logistics/presentation` | Staff | Admin(SETTINGS_WRITE) | Choose whether buyers see a price for each delivery level or a single delivery line. Writes an audit entry. |
| GET | `/api/v1/admin/logistics/legs` | Staff | Admin(LOGISTICS_READ) | Every delivery leg across all orders, newest first, filterable by who runs it, its status, one order, or only the legs still waiting for a carrier. |
| GET | `/api/v1/admin/logistics/legs/:id` | Staff | Admin(LOGISTICS_READ) | One delivery leg with the rest of its order's journey beside it, and the marketplace carriers it could be given to. |
| POST | `/api/v1/admin/logistics/legs/:id/assign` | Staff | Admin(LOGISTICS_ASSIGN) | Name who carries a UBOSS-run leg: an outside carrier or a delivery company on the platform. The company gets a notification, the seller is told, and a company that loses the leg is told why. Refused once the leg is moving; a leg the seller runs can only be assigned by the seller. |
| PATCH | `/api/v1/admin/logistics/legs/:id` | Staff | Admin(LOGISTICS_ASSIGN) | Enter the carrier's tracking number, pickup reference or expected dates on a UBOSS-run leg. Refused until a carrier is named, and once the leg is finished. Writes an audit entry. |
| POST | `/api/v1/admin/logistics/legs/:id/transition` | Staff | Admin(LOGISTICS_ASSIGN) | Move a UBOSS-run leg on: accept, start, hand over, or take it back from a delivery company. Handing over makes the next leg ready; the seller is told and an audit entry is written. A leg a delivery company holds is progressed by that company, not here. |

### `admin/notifications`

Defined in `backend/src/http/routes/notifications.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/notifications` | Staff | Admin | The console bell feed |
| POST | `/api/v1/admin/notifications/read` | Staff | Admin | Mark notifications read |
| POST | `/api/v1/admin/notifications/read-all` | Staff | Admin | Mark the whole visible feed read |
| POST | `/api/v1/admin/notifications/dismiss` | Staff | Admin | Take rows out of this caller's own bell. |
| GET | `/api/v1/admin/notifications/:id` | Staff | Admin | One console notification, with its resolution |
| POST | `/api/v1/admin/notifications/:id/resolve` | Staff | Admin | Close an alert by hand |

### `admin/operations`

Defined in `backend/src/http/routes/reports.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/operations` | Staff | Admin | What is waiting across the platform, grouped, for THIS member of staff. |

### `admin/orders`

Defined in `backend/src/http/routes/settings.admin.ts`, `backend/src/http/routes/orders.ts`, `backend/src/http/routes/payments.ts`, `backend/src/http/routes/vat.admin.ts`, `backend/src/http/routes/documents.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/orders/:id/shippable` | Staff | Admin(ORDER_FULFIL) | What is left to ship on each line, accounting for partial shipments. |
| POST | `/api/v1/admin/orders/:id/shipments` | Staff | Admin(ORDER_FULFIL) | Record a shipment of some or all of a confirmed order's items, with the carrier and tracking details. The order moves to processing, and to shipped once everything has gone (unless told not to). Writes an audit entry. |
| POST | `/api/v1/admin/orders/:id/returns` | Staff | Admin(ORDER_RETURN) | Record a return request for some or all items on a shipped or delivered order, with a reason. Quantities may not exceed what was ordered. Writes an audit entry. |
| GET | `/api/v1/admin/orders` | Staff | Admin(ORDER_READ) | All orders |
| GET | `/api/v1/admin/orders/:id` | Staff | Admin(ORDER_READ) | Order detail, including `availableTransitions` |
| POST | `/api/v1/admin/orders/:id/transition` | Staff | Admin(ORDER_READ) | Apply a status transition |
| POST | `/api/v1/admin/orders/:id/approval` | Staff | Admin(ORDER_APPROVE) | Approve or reject an order that is waiting for staff approval, with an optional comment. Approving moves it on to waiting for payment; rejecting cancels it. Refused if the order has no approval still pending. |
| PATCH | `/api/v1/admin/orders/:id/note` | Staff | Admin(ORDER_NOTE_WRITE) | Replace, or clear, the staff-only internal note on an order. Customers never see it. |
| POST | `/api/v1/admin/orders/:id/payment-links` | Staff | Admin(PAYMENT_LINK_CREATE) | Email a one-time payment link for an order's outstanding balance to someone who can pay it, such as a finance team, without them needing an account. Writes an audit entry; refused unless the order is waiting for payment and still has something left to pay. |
| GET | `/api/v1/admin/orders/:id/refund-quote` | Staff | Admin(PAYMENT_READ) | What the refund dialog shows before anything is submitted. |
| POST | `/api/v1/admin/orders/:id/refunds` | Staff | Admin(REFUND_CREATE) | Create a refund |
| GET | `/api/v1/admin/orders/:id/invoice` | Staff | Admin(INVOICE_READ) | The invoice for an order |
| POST | `/api/v1/admin/orders/:id/invoice` | Staff | Admin(INVOICE_ISSUE) | Raise the invoice for an order |
| GET | `/api/v1/admin/orders/:id/seller-documents` | Staff | Admin(INVOICE_READ) | List the invoices, credit notes and packing lists sellers have issued for one order. Drafts are left out. |

### `admin/payment-links`

Defined in `backend/src/http/routes/payments.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| DELETE | `/api/v1/admin/payment-links/:linkId` | Staff | Admin(PAYMENT_LINK_CREATE) | Withdraw a payment link that has not been used yet, giving a reason, so it can no longer be paid. Writes an audit entry; refused if the link was already used or withdrawn. |

### `admin/payments`

Defined in `backend/src/http/routes/payments.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/payments` | Staff | Admin(PAYMENT_READ) | List payment attempts, newest first, a page at a time. Can be narrowed to one status or one order. |
| GET | `/api/v1/admin/payments/webhook-health` | Staff | Admin(PAYMENT_READ) | Webhook health. |
| PUT | `/api/v1/admin/payments/connections` | Staff | Admin(PAYMENT_GATEWAY_WRITE) | Save gateway credentials. |
| GET | `/api/v1/admin/payments/connections` | Staff | Admin(PAYMENT_READ) | Configured connections. Masks only - a secret never leaves the server. |
| POST | `/api/v1/admin/payments/connections/:id/test` | Staff | Admin(PAYMENT_GATEWAY_WRITE) | Test one saved connection. |
| PATCH | `/api/v1/admin/payments/connections/:id/status` | Staff | Admin(PAYMENT_GATEWAY_WRITE) | Switch a payment-provider connection on or off. Switching on is refused until the connection has passed a test and has its webhook signing secret, and it switches off any other connection for the same provider or in the other mode (live versus test). Writes an audit entry. |
| POST | `/api/v1/admin/payments/test-connection` | Staff | Admin(PAYMENT_GATEWAY_WRITE) | Prove the credentials work before an administrator activates them. |
| POST | `/api/v1/admin/payments/:paymentId/reconcile` | Staff | Admin(PAYMENT_READ) | Ask the payment provider what really happened to one payment and bring the records into line. If the provider says the money was taken and the amount matches, the payment is recorded and a waiting order is confirmed; an amount mismatch is refused and finance is alerted. |

### `admin/platform-fees`

Defined in `backend/src/http/routes/logistics-levels.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/platform-fees` | Staff | Admin(FINANCE_POLICY_READ) | List the platform fee policies, every version, optionally only drafts, published or retired ones, with how many seller orders each has settled. |
| POST | `/api/v1/admin/platform-fees` | Staff | Admin(FINANCE_POLICY_WRITE) | Create a new draft platform fee policy: what sellers are charged, for the whole marketplace or one market, category or seller, and the tax on it. Nothing is charged until it is published. Writes an audit entry. |
| PUT | `/api/v1/admin/platform-fees/:id` | Staff | Admin(FINANCE_POLICY_WRITE) | Change a draft platform fee policy. Refused once it is published or retired, or if the change would move it to a different scope. Writes an audit entry. |
| POST | `/api/v1/admin/platform-fees/:id/publish` | Staff | Admin(FINANCE_POLICY_WRITE) | Make a draft platform fee policy the live one for its scope, retiring the version it replaces. Writes an audit entry, and alerts finance staff when the policy charges tax whose rule nobody has verified yet. |
| POST | `/api/v1/admin/platform-fees/:id/retire` | Staff | Admin(FINANCE_POLICY_WRITE) | Retire a platform fee policy so it no longer applies to new orders. Retiring one that is already retired changes nothing. Writes an audit entry. |
| POST | `/api/v1/admin/platform-fees/:id/verify-tax` | Staff | Admin(FINANCE_TAX_VERIFY) | Record, with a note, that the tax rule on a platform fee policy is the legally correct one. Changes no figure. Refused on a retired policy. Writes an audit entry. |
| GET | `/api/v1/admin/platform-fees/:id/orders` | Staff | Admin(FINANCE_POLICY_READ) | The seller orders that were settled on one platform fee policy version, newest first, with the fee and fee tax charged on each. |
| POST | `/api/v1/admin/platform-fees/preview` | Staff | Admin(FINANCE_POLICY_READ) | Work out what a seller would be charged and paid on a given sale, using the platform fee policies in force now. Read-only: nothing is saved. |

### `admin/preorders`

Defined in `backend/src/http/routes/preorders.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/preorders` | Staff | Admin(ORDER_READ) | List bulk preorders, optionally filtered by status and by who supplies them (the store itself or a seller). |
| GET | `/api/v1/admin/preorders/:id` | Staff | Admin(ORDER_READ) | One preorder in full - what was asked, proposed and agreed - whether it is a seller's or the store's own. |
| POST | `/api/v1/admin/preorders/:id/accept` | Public |  | Accept a preorder for the store's own product exactly as the buyer asked. Refused if the price or date differs from the request - that must be sent as a counter-offer. Tells the buyer and writes an audit entry. |
| POST | `/api/v1/admin/preorders/:id/counter` | Public |  | Answer a preorder for the store's own product with different terms - quantity, price, freight, delivery date or split deliveries. Tells the buyer and writes an audit entry. |
| POST | `/api/v1/admin/preorders/:id/reject` | Public |  | Turn down a preorder for the store's own product, giving a reason. Closes the request, releases any capacity it held and tells the buyer. |
| POST | `/api/v1/admin/preorders/:id/start-production` | Public |  | Record that production has started on a confirmed preorder for the store's own product, with an optional note. Emails the buyer and writes an audit entry. |
| POST | `/api/v1/admin/preorders/:id/ready` | Public |  | Mark a preorder on the store's own product as ready to ship, with an optional note. Emails the buyer and writes an audit entry. |

### `admin/products`

Defined in `backend/src/http/routes/catalog.admin.ts`, `backend/src/http/routes/translations.admin.ts`, `backend/src/http/routes/gpsr.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/products` | Staff | Admin(PRODUCT_READ) | The product list. |
| GET | `/api/v1/admin/products/filters` | Staff | Admin(PRODUCT_READ) | What this list can be filtered by. |
| GET | `/api/v1/admin/products/:id` | Staff | Admin(PRODUCT_READ) | One product in full for the editor: category, tax class, images, specifications, variants, packing details and where it was imported from, including internal notes customers never see. |
| POST | `/api/v1/admin/products` | Staff | Admin(PRODUCT_WRITE) | Create a product |
| PATCH | `/api/v1/admin/products/:id` | Staff | Admin(PRODUCT_WRITE) | Change any of a product's details - name, SKU, category, descriptions, price, order quantities, product-safety information, specifications and so on. Writes an audit entry, and a separate one for a price change. |
| GET | `/api/v1/admin/products/:id/prices` | Staff | Admin(PRODUCT_READ) | Per-currency prices for one product, and what a shopper pays for them. |
| PUT | `/api/v1/admin/products/:id/prices` | Staff | Admin(PRODUCT_WRITE) | Replace the price set. |
| POST | `/api/v1/admin/products/prices/bulk` | Staff | Admin(PRODUCT_WRITE) | Fill a whole currency's price list from another currency's. |
| PATCH | `/api/v1/admin/products/:id/publication` | Staff | Admin(PRODUCT_PUBLISH) | Publish or unpublish a product |
| PATCH | `/api/v1/admin/products/:id/status` | Staff | Admin(PRODUCT_WRITE) | Set a product to draft, active or inactive. Anything other than active also takes it off the storefront. Writes an audit entry. |
| DELETE | `/api/v1/admin/products/:id` | Staff | Admin(PRODUCT_ARCHIVE) | Archive a product: it is unpublished, switched off and taken out of every shopping cart, but kept so past orders still make sense. Writes an audit entry. |
| GET | `/api/v1/admin/products/:id/variants` | Staff | Admin(PRODUCT_READ) | Variants, with what each override costs a customer in the session's market. |
| POST | `/api/v1/admin/products/:id/variants` | Staff | Admin(PRODUCT_WRITE) | Add a variant to a product, such as one size or colour, with its own SKU and optionally its own price. Writes an audit entry. |
| PATCH | `/api/v1/admin/products/:id/variants/:variantId` | Staff | Admin(PRODUCT_WRITE) | Change a variant - its SKU, name, options, price, order quantities, shipping details and so on. A price change gets its own audit entry. |
| DELETE | `/api/v1/admin/products/:id/variants/:variantId` | Staff | Admin(PRODUCT_WRITE) | Remove a variant. One that was ever ordered, scheduled or still has stock is archived instead of deleted, so history keeps working. Writes an audit entry. |
| GET | `/api/v1/admin/products/:id/variant-template` | Staff | Admin(PRODUCT_READ) | The variant template for this product's category, and the axes it uses. |
| PUT | `/api/v1/admin/products/:id/variant-axes` | Staff | Admin(PRODUCT_WRITE) | Choose which options (size, colour and so on) a product's variants are chosen by, from those its category offers. Removing one leaves existing variants untouched and returns a warning with how many use it. Writes an audit entry. |
| POST | `/api/v1/admin/products/:id/variants/preview` | Staff | Admin(PRODUCT_READ) | What generating would produce, without producing it. |
| POST | `/api/v1/admin/products/:id/variants/generate` | Staff | Admin(PRODUCT_WRITE) | Create the variants approved from the preview table. Combinations that already exist are skipped, not overwritten, and a duplicate SKU refuses the whole batch. Writes an audit entry. |
| POST | `/api/v1/admin/products/:id/variants/bulk` | Staff | Admin(PRODUCT_WRITE) | Set the same price, compare-at price, order quantities, lead time or on/off state across many of one product's variants at once. Writes an audit entry. |
| POST | `/api/v1/admin/products/:id/media` | Staff | Admin(MEDIA_UPLOAD) | Upload a product image (multipart) |
| DELETE | `/api/v1/admin/products/:id/media/:mediaId` | Staff | Admin(PRODUCT_WRITE) | Remove an image from a product and delete the stored file. If it was the main image, the next one takes its place. |
| GET | `/api/v1/admin/products/import/template` | Staff | Admin(PRODUCT_IMPORT) | The template, with a worked example row. |
| GET | `/api/v1/admin/products/import/columns` | Staff | Admin(PRODUCT_IMPORT) | Column documentation, so the UI does not restate the rules and drift. |
| POST | `/api/v1/admin/products/import` | Staff | Admin(PRODUCT_IMPORT) | Upload and preview. Writes nothing to the catalogue. |
| POST | `/api/v1/admin/products/import/:id/confirm` | Staff | Admin(PRODUCT_IMPORT) | Apply a previewed import. |
| GET | `/api/v1/admin/products/import` | Staff | Admin(PRODUCT_IMPORT) | The most recent product imports and where each one stands. |
| GET | `/api/v1/admin/products/import/:id` | Staff | Admin(PRODUCT_IMPORT) | One product import - its status and row counts - with the problems found in the spreadsheet, a page at a time, each naming its row and column. |
| GET | `/api/v1/admin/products/:id/translations` | Staff | Admin(PRODUCT_READ) | A product's English text together with every translation saved for it, so a translator can work with the source in front of them. |
| PUT | `/api/v1/admin/products/:id/translations/:language` | Staff | Admin(PRODUCT_WRITE) | Save a product's name, descriptions and search-engine text in one language other than English. A save from the panel is marked as reviewed by a person unless the caller says otherwise. |
| DELETE | `/api/v1/admin/products/:id/translations/:language` | Staff | Admin(PRODUCT_WRITE) | Remove a product's copy in one language, so shoppers in that language see the English text again. |
| GET | `/api/v1/admin/products/:id/safety` | Staff | Admin(PRODUCT_READ) | The GPSR Art. 19 checklist for one product |
| GET | `/api/v1/admin/products/:id/device` | Staff | Admin(PRODUCT_READ) | The MDR checklist for one product, and its device record |
| PUT | `/api/v1/admin/products/:id/device` | Staff | Admin(PRODUCT_WRITE) | Mark a product as a medical device, or update its record |
| DELETE | `/api/v1/admin/products/:id/device` | Staff | Admin(PRODUCT_WRITE) | Stop treating a product as a medical device |

### `admin/quantity-discounts`

Defined in `backend/src/http/routes/coupons.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/quantity-discounts` | Staff | Admin(COUPON_READ) | Store-wide quantity discounts: "from 50 pieces, 5% off" on every product the operator sells itself. Under the coupon permissions because it is the same kind of decision - a discount the store funds - made by the same people. Replaced as a set; see `store-discount.service.ts`. |
| PUT | `/api/v1/admin/quantity-discounts` | Staff | Admin(COUPON_WRITE) | Replace the whole set of store-wide quantity discounts with the list sent. Refused if the rules contradict each other. Writes an audit entry. |

### `admin/reports`

Defined in `backend/src/http/routes/reports.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/reports/sales` | Staff | Admin(REPORT_READ) | The sales report for a date range: totals (sales, tax, shipping, discounts, refunds, net revenue), sales by day or month, top products, top customers and sales by category. |
| GET | `/api/v1/admin/reports/orders` | Staff | Admin(REPORT_READ) | The orders report: how many orders, and of what value, are in each status for a date range, and how long confirmed orders have been waiting to ship. |
| GET | `/api/v1/admin/reports/payments` | Staff | Admin(PAYMENT_READ) | The payments report for a date range: payments by status, amounts captured, failed and refunded, rejected payment notifications and payments not yet reconciled. |
| GET | `/api/v1/admin/reports/inventory` | Staff | Admin(INVENTORY_READ) | The inventory report: stock on hand valued at the current selling price (optionally only low-stock items), and a summary of stock movements in a date range. |
| GET | `/api/v1/admin/reports/customers` | Staff | Admin(CUSTOMER_READ) | The customer report for a date range: how many customers there are by status, and how many signed up, activated their account and ordered in that range. |
| GET | `/api/v1/admin/reports/recurring` | Staff | Admin(SCHEDULE_READ) | The recurring-orders report: schedules by status, the runs due in the next few days (7 unless asked otherwise), failed runs, and schedules paused after repeated failures that need somebody to look at them. |

### `admin/returns`

Defined in `backend/src/http/routes/settings.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/admin/returns/:id/inspect` | Staff | Admin(ORDER_RETURN) | Record the inspection outcome. |
| POST | `/api/v1/admin/returns/:id/reject` | Staff | Admin(ORDER_RETURN) | Refuse a return, with a note saying why. Refused if the return has already been decided. Writes an audit entry. |
| GET | `/api/v1/admin/returns` | Staff | Admin(ORDER_READ) | List return requests, newest first, a page at a time, optionally filtered by status. Each shows its order, reason, items and any decision note. |

### `admin/schedules`

Defined in `backend/src/http/routes/schedules.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/schedules` | Staff | Admin(SCHEDULE_READ) | List every customer's scheduled orders, soonest next delivery first, a page at a time. Can be narrowed by status, one-off or repeating, customer, or "due within the next N hours". |
| GET | `/api/v1/admin/schedules/:id` | Staff | Admin(SCHEDULE_READ) | Show one scheduled order in full for staff: the customer, the products, the addresses and its 50 most recent deliveries with the order each one produced and any failure. |
| POST | `/api/v1/admin/schedules/:id/pause` | Staff | Admin(SCHEDULE_WRITE) | Pause any customer's scheduled order, with an optional reason. Upcoming deliveries that have not started are withdrawn until it is resumed. Writes an audit entry. |
| POST | `/api/v1/admin/schedules/:id/resume` | Staff | Admin(SCHEDULE_WRITE) | Restart any customer's paused scheduled order. The next delivery date is worked out afresh from today, so missed deliveries are not caught up. Refused if the card it pays with automatically can no longer be charged, or a one-off delivery date has already passed; writes an audit entry. |
| DELETE | `/api/v1/admin/schedules/:id` | Staff | Admin(SCHEDULE_WRITE) | Cancel any customer's scheduled order, with an optional reason. Only deliveries that have not started are cancelled; orders already created carry on as normal. Writes an audit entry. |

### `admin/seller-carriers`

Defined in `backend/src/http/routes/sellers.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/seller-carriers` | Staff | Admin(CUSTOMER_READ) | List the arrangements between sellers and carriers, filtered by status, seller or carrier. Requests awaiting a decision are what this queue is for. |
| PATCH | `/api/v1/admin/seller-carriers/:id` | Staff | Admin(CUSTOMER_STATUS_WRITE) | Approve, refuse, suspend or end a seller's request to use a carrier, and optionally narrow the countries, capabilities and dates it covers. An adverse decision needs a reason. Writes an audit entry. |

### `admin/seller-documents`

Defined in `backend/src/http/routes/sellers.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/admin/seller-documents/:id/link` | Staff | Admin(CUSTOMER_READ) | A link to read one back. |
| GET | `/api/v1/admin/seller-documents/:id/download` | Staff | Admin(CUSTOMER_READ) | Redeem it. |
| POST | `/api/v1/admin/seller-documents/:id/decision` | Staff | Admin(CUSTOMER_STATUS_WRITE) | Accept or refuse one. |

### `admin/seller-listings`

Defined in `backend/src/http/routes/sellers.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/seller-listings/review-queue` | Staff | Admin(PRODUCT_READ) | Seller listings submitted for review and waiting for a decision, a page at a time. |
| GET | `/api/v1/admin/seller-listings/:id` | Staff | Admin(PRODUCT_READ) | One submitted listing, in full. |
| POST | `/api/v1/admin/seller-listings/:id/decision` | Staff | Admin(PRODUCT_PUBLISH) | Approve, refuse or send back a listing. |

### `admin/sellers`

Defined in `backend/src/http/routes/sellers.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/sellers` | Staff | Admin(CUSTOMER_READ) | List seller applications a page at a time, filtered by status or searched by business name. |
| GET | `/api/v1/admin/sellers/:id` | Staff | Admin(CUSTOMER_READ) | One seller application in full, including internal notes the seller never sees. |
| GET | `/api/v1/admin/sellers/:id/insight` | Staff | Admin(CUSTOMER_READ) | How this seller is doing, and where its goods are. |
| POST | `/api/v1/admin/sellers/:id/decision` | Staff | Admin(CUSTOMER_STATUS_WRITE) | Decide an application. |
| PATCH | `/api/v1/admin/sellers/:id/commission` | Staff | Admin(SETTINGS_WRITE) | One seller's own commission rate. |
| GET | `/api/v1/admin/sellers/:id/documents` | Staff | Admin(CUSTOMER_READ) | The current certificates and licences a seller has uploaded, with the review status of each. |

### `admin/settings`

Defined in `backend/src/http/routes/settings.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/settings/business` | Staff | Admin(SETTINGS_READ) | The store's business profile: its names, contacts, tax numbers, currency and other store-wide settings. |
| PATCH | `/api/v1/admin/settings/business` | Staff | Admin(SETTINGS_WRITE) | Change the business profile: names, support contacts, tax numbers, the standard seller commission, logo, address, currency, time zone and invoice and order number prefixes. The currency cannot change once any order exists. Writes an audit entry. |
| PATCH | `/api/v1/admin/settings/policy-links` | Staff | Admin(SETTINGS_WRITE) | Replace the policy links shown in the storefront footer (terms, privacy and so on). Every link must start with http:// or https://; empty ones are dropped. Writes an audit entry. |
| GET | `/api/v1/admin/settings/tax-classes` | Staff | Admin(SETTINGS_READ) | List the tax classes, the default first, with each one's rate. |
| GET | `/api/v1/admin/settings/processors` | Staff | Admin(SETTINGS_READ) | Who this deployment actually shares data with |
| POST | `/api/v1/admin/settings/tax-classes` | Staff | Admin(SETTINGS_WRITE) | Add a tax class with its rate and, optionally, its EU VAT band. Making it the default takes that from the previous default. Writes an audit entry. |
| PATCH | `/api/v1/admin/settings/tax-classes/:id` | Staff | Admin(SETTINGS_WRITE) | Change a tax class. Refused if it would switch off a class products still use, or leave the store without a default. Writes an audit entry. |
| GET | `/api/v1/admin/settings/shipping-methods` | Staff | Admin(SETTINGS_READ) | List the store's delivery methods and their prices. |
| POST | `/api/v1/admin/settings/shipping-methods` | Staff | Admin(SETTINGS_WRITE) | Add a delivery method with its price, free-delivery threshold, delivery time estimate and regions. Refused if the code is already used. Writes an audit entry. |
| PATCH | `/api/v1/admin/settings/shipping-methods/:id` | Staff | Admin(SETTINGS_WRITE) | Change a delivery method. Switching one off reports how many active or paused recurring schedules use it, so staff can be warned. Writes an audit entry. |
| GET | `/api/v1/admin/settings/notifications` | Staff | Admin(SETTINGS_READ) | List the notifications staff have customised, with their templates, recipients and whether each is switched on. Events not listed use the built-in wording. |
| PUT | `/api/v1/admin/settings/notifications` | Staff | Admin(SETTINGS_WRITE) | Customise one notification: its email subject and body, the staff addresses that receive internal alerts, and whether it is sent. Writes an audit entry. |
| GET | `/api/v1/admin/settings/feature-flags` | Staff | Admin(SETTINGS_READ) | List the store's feature switches and whether each is on. |
| GET | `/api/v1/admin/settings/feature-flags/:key/impact` | Staff | Admin(SETTINGS_READ) | What would break if this flag were turned off. |
| PATCH | `/api/v1/admin/settings/feature-flags/:key` | Staff | Admin(FEATURE_FLAG_WRITE) | Switch one feature on or off for the whole store. Writes an audit entry. |
| GET | `/api/v1/admin/settings/exchange-rates` | Staff | Admin(SETTINGS_READ) | Automatic refresh of rate-maintained prices. |
| GET | `/api/v1/admin/settings/exchange-rates/snapshots` | Staff | Admin(SETTINGS_READ) | What the feed has actually been doing. |
| PUT | `/api/v1/admin/settings/exchange-rates` | Staff | Admin(SETTINGS_WRITE) | Change the automatic exchange-rate settings: on or off, the rate feed, the margin added, price rounding, how far a rate may jump, and how old a rate may be before it stops being used. Writes an audit entry. |
| POST | `/api/v1/admin/settings/exchange-rates/refresh` | Staff | Admin(SETTINGS_WRITE) | Run the refresh now. |
| GET | `/api/v1/admin/settings/catalogue-translation` | Staff | Admin(SETTINGS_READ) | Machine-translating the shop's own product copy. |
| PUT | `/api/v1/admin/settings/catalogue-translation` | Staff | Admin(SETTINGS_WRITE) | Store or remove the API key used to machine-translate product copy. The key is kept encrypted and only its last four characters are ever shown. Writes an audit entry, without the key. |
| POST | `/api/v1/admin/settings/catalogue-translation/run` | Staff | Admin(SETTINGS_WRITE) | Translate everything that has no copy in a language yet. |

### `admin/shipments`

Defined in `backend/src/http/routes/settings.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| PATCH | `/api/v1/admin/shipments/:id/status` | Staff | Admin(ORDER_FULFIL) | Update where a shipment is: in transit, delivered, failed or returned to the sender. When the last outstanding shipment of a shipped order is delivered, the order is marked delivered. |

### `admin/staff`

Defined in `backend/src/http/routes/settings.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/staff` | Staff | Admin(STAFF_READ) | List every staff account with its status, roles, the permissions those roles add up to, and whether it is still waiting for its first sign-in. |
| GET | `/api/v1/admin/staff/assignable-roles` | Staff | Admin(STAFF_READ) | The roles this administrator may assign. |
| POST | `/api/v1/admin/staff` | Staff | Admin(STAFF_WRITE, ROLE_ASSIGN) | Create a staff account |
| POST | `/api/v1/admin/staff/:id/temporary-password` | Staff | Admin(STAFF_WRITE, ROLE_ASSIGN) | Email a fresh temporary password |
| PATCH | `/api/v1/admin/staff/:id/roles` | Staff | Admin(ROLE_ASSIGN) | Replace a staff member's roles. Only roles within your own authority can be added or removed, and the last Business Owner cannot drop that role. Removing access signs the person out. Writes an audit entry. |
| PATCH | `/api/v1/admin/staff/:id/status` | Staff | Admin(STAFF_WRITE) | Deactivate a staff account, signing it out everywhere, or reactivate it. Refused for your own account, for someone with more access than you, and for the last active Business Owner. Writes an audit entry. |

### `admin/vat-rates`

Defined in `backend/src/http/routes/vat.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/vat-rates` | Staff | Admin(SETTINGS_READ) | VAT rate periods, with the member states flagged |
| POST | `/api/v1/admin/vat-rates` | Staff | Admin(SETTINGS_WRITE) | Add a VAT rate period |
| PATCH | `/api/v1/admin/vat-rates/:id` | Staff | Admin(SETTINGS_WRITE) | Close a VAT rate period |

## Logistics partner portal

### `logistics/audit`

Defined in `backend/src/http/routes/logistics.portal.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/logistics/audit` | Logistics | Logistics(AUDIT_READ) | This delivery company's own activity log, newest first, a page at a time, optionally narrowed to one kind of action. Lists who did what; the before-and-after detail is not included. |

### `logistics/auth`

Defined in `backend/src/http/routes/auth.ts`, `backend/src/http/routes/logistics.portal.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/logistics/auth/login` | Public (logistics sign-in) |  | Sign in with email and password and start a session (set as cookies). Refused for an account that belongs to a different part of the system, and for an account temporarily locked after too many failed attempts. |
| POST | `/api/v1/logistics/auth/refresh` | Public (logistics sign-in) |  | Swap the session's refresh cookie for fresh sign-in tokens so the person stays signed in. If the session is no longer valid its cookies are cleared and the caller must sign in again. |
| POST | `/api/v1/logistics/auth/logout` | Signed in | Authenticated(kind) | Sign out of this session only and clear its cookies. |
| POST | `/api/v1/logistics/auth/logout-all` | Signed in | Authenticated(kind) | Sign the person out on every device at once. Replies with how many sessions were ended. |
| GET | `/api/v1/logistics/auth/language` | Signed in | Authenticated(kind) | The interface language for this account. |
| PUT | `/api/v1/logistics/auth/language` | Signed in | Authenticated(kind) | Save the interface language the signed-in person wants to read. |
| POST | `/api/v1/logistics/auth/password/change` | Signed in | Authenticated(kind) | Change the signed-in person's password, given their current one. Signs the account out of every session, including this one, and writes an audit entry. |
| POST | `/api/v1/logistics/auth/password/forgot` | Public (logistics sign-in) |  | Ask for a password-reset link. If an active account exists for the email address, a reset link is emailed to it; the reply is the same either way, so nobody can use it to find out who has an account. |
| POST | `/api/v1/logistics/auth/password/reset` | Public (logistics sign-in) |  | Set a new password using the link from a "forgot password" email. Signs the account out everywhere and writes an audit entry; refused if the link has expired or was already used. |
| POST | `/api/v1/logistics/auth/invitations/accept` | Public (logistics sign-in) |  | Accept an emailed invitation to the logistics portal: the person chooses their own password and their carrier account becomes active. Refused if the link has expired, was already used, or was issued for another part of the system. |
| GET | `/api/v1/logistics/auth/me` | Logistics | LogisticsSession | Everything the portal needs to boot. |
| POST | `/api/v1/logistics/auth/mfa/setup` | Logistics | LogisticsSession | Start setting up two-step sign-in: returns a new secret for an authenticator app and a set of recovery codes, shown this once only. Replaces any earlier secret and codes. Writes an audit entry. |
| POST | `/api/v1/logistics/auth/mfa/verify` | Logistics | LogisticsSession | Check a two-step sign-in code: either to finish setting it up, or to pass this session's challenge. A recovery code also works for a challenge and is used up. On success this session counts as verified. |

### `logistics/companies`

Defined in `backend/src/http/routes/logistics.portal.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/logistics/companies` | Logistics | Logistics(COMPANY_READ) | The companies this delivery company carries for, either the senders or the receivers, with shipment counts for each. Built only from its own shipments; nothing about what those companies buy or pay is shown. |

### `logistics/dashboard`

Defined in `backend/src/http/routes/logistics.portal.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/logistics/dashboard` | Logistics | Logistics(SHIPMENT_READ) | The delivery company's dashboard in one call: its shipment figures for a date range, optionally narrowed by warehouse, seller, destination country or one of its own drivers. |
| POST | `/api/v1/logistics/dashboard/insights/stream` | Logistics | Logistics(SHIPMENT_READ) | The carrier's own figures, explained. |
| POST | `/api/v1/logistics/dashboard/insights` | Logistics | Logistics(SHIPMENT_READ) | A written explanation of this delivery company's dashboard figures, with findings and suggested actions, optionally answering a question. Uses the AI assistant when one is configured and a plain summary when it is not. |

### `logistics/dispatch-manifests`

Defined in `backend/src/http/routes/logistics.operations.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/logistics/dispatch-manifests` | Logistics | Logistics(DISPATCH_READ) | List this carrier's load lists, newest first, with the driver, vehicle and how many consignments and packages each carries. Can be filtered by state. |
| POST | `/api/v1/logistics/dispatch-manifests` | Logistics | Logistics(DISPATCH_WRITE) | Build a load and dispatch it. |
| GET | `/api/v1/logistics/dispatch-manifests/:id` | Logistics | Logistics(DISPATCH_READ) | One load list ready to print: driver, vehicle, route and a line per consignment with its packages, weight and any cold-chain or dangerous-goods flag. |
| POST | `/api/v1/logistics/dispatch-manifests/:id/handover` | Logistics | Logistics(DISPATCH_WRITE) | Mark a load as handed over and record the name of whoever signed for it. Refused when the manifest has already been handed over or cancelled. |

### `logistics/documents`

Defined in `backend/src/http/routes/logistics.portal.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/logistics/documents/:id/link` | Logistics | Logistics(DOCUMENT_READ) | A short-lived link to one file. |

### `logistics/driver`

Defined in `backend/src/http/routes/logistics.driver.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/logistics/driver/tasks` | Logistics | Logistics(DRIVER_TASK_READ) | Today's stops, in route order. |
| POST | `/api/v1/logistics/driver/location-consent` | Logistics | Logistics(TRIP_WRITE) | Agree, or stop agreeing, to location sharing. |
| POST | `/api/v1/logistics/driver/trips` | Logistics | Logistics(TRIP_WRITE) | Start a trip for the signed-in driver, optionally tied to one shipment and vehicle, and hand back the one-time device token the phone uses to report positions. Refused unless the driver is active and has agreed to location sharing; any trip already live for that driver is abandoned. |
| POST | `/api/v1/logistics/driver/trips/:id/end` | Logistics | Logistics(TRIP_WRITE) | End or pause the driver's own live trip, which stops its device token being accepted for position reports. Refused as not found when the trip is not this driver's, or is not live. |
| POST | `/api/v1/logistics/driver/location-pings` | Public |  | One position report. |

### `logistics/drivers`

Defined in `backend/src/http/routes/logistics.operations.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/logistics/drivers` | Logistics | Logistics(DRIVER_READ) | List this carrier's drivers, those on the rota first, with their certifications, whether they can use the phone app, whether they have agreed to location sharing and how many open tasks they hold. |
| POST | `/api/v1/logistics/drivers` | Logistics | Logistics(DRIVER_WRITE) | Add somebody to the fleet. |
| PATCH | `/api/v1/logistics/drivers/:id` | Logistics | Logistics(DRIVER_WRITE) | Change a driver's details, or take them off the rota. |

### `logistics/exceptions`

Defined in `backend/src/http/routes/logistics.operations.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/logistics/exceptions` | Logistics | Logistics(SHIPMENT_READ) | This carrier's queue of delivery problems, most severe and oldest first, a page at a time. Shows only open ones unless asked otherwise, and can be narrowed by severity or shipment. |
| PATCH | `/api/v1/logistics/exceptions/:id` | Logistics | Logistics(SHIPMENT_EXCEPTION_WRITE) | Work a delivery problem: change its state, severity or owner, add notes, or record that the customer has been told. Resolving needs a note, a severity cannot be lowered below its floor, and a revised arrival date also moves the shipment's own expected date. |

### `logistics/integration`

Defined in `backend/src/http/routes/logistics.portal.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/logistics/integration` | Logistics | Logistics(INTEGRATION_READ) | This carrier's own integration, coverage and fleet, in one place. |

### `logistics/legs`

Defined in `backend/src/http/routes/logistics-levels.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/logistics/legs` | Logistics | Logistics(SHIPMENT_READ) | The delivery legs this company holds, most recently changed first. |
| GET | `/api/v1/logistics/legs/:id` | Logistics | Logistics(SHIPMENT_READ) | One leg this delivery company holds. A leg held by another company is not found. |
| POST | `/api/v1/logistics/legs/:id/accept` | Logistics | Logistics(SHIPMENT_ACCEPT) | Accept a leg offered to this delivery company, confirming it will carry it. The seller is told, and it is recorded in their history. |
| POST | `/api/v1/logistics/legs/:id/reject` | Logistics | Logistics(SHIPMENT_ACCEPT) | Refuse a leg offered to this delivery company, with a reason. The leg goes back to waiting for a carrier, and the seller is told it needs a new one. |
| POST | `/api/v1/logistics/legs/:id/progress` | Logistics | Logistics(SHIPMENT_STATUS_WRITE) | Mark a leg this delivery company holds as started or handed over. Handing it over makes the next leg of the journey ready. The seller is told and it is recorded in their history; a repeated request with the same idempotency key changes nothing. |
| PATCH | `/api/v1/logistics/legs/:id` | Logistics | Logistics(SHIPMENT_STATUS_WRITE) | Enter the tracking number, pickup reference or expected dates on a leg this delivery company holds. Refused once the leg is finished or cancelled. Recorded in the seller's history. |
| POST | `/api/v1/logistics/legs/:id/driver` | Logistics | Logistics(DRIVER_ASSIGN) | Put one of this delivery company's own drivers on a leg it holds, or take the driver off. Refused when the leg is finished or cancelled, or the driver is not this company's. |

### `logistics/members`

Defined in `backend/src/http/routes/logistics.portal.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/logistics/members` | Logistics | Logistics(MEMBER_READ) | The people on this delivery company's team, with their roles and status. |
| PATCH | `/api/v1/logistics/members/:id` | Logistics | Logistics(MEMBER_WRITE) | Change a colleague's role, job title or phone, or switch their access off, which also signs them out everywhere. Refused when granting a role the caller does not hold, or when changing one's own role or access. Writes an audit entry. |

### `logistics/notifications`

Defined in `backend/src/http/routes/logistics.portal.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/logistics/notifications` | Logistics | Logistics | The signed-in person's notifications: their own plus those addressed to the whole company. Shows live items by default, or the resolved record. |
| POST | `/api/v1/logistics/notifications/read` | Logistics | Logistics | Mark the listed notifications as read, or all of them when no list is given. Ids from another company's feed are ignored. |

### `logistics/organisation`

Defined in `backend/src/http/routes/logistics.portal.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/logistics/organisation` | Logistics | Logistics(ORGANISATION_READ) | This delivery company's own record as it sees it: registration and licence, contact details, status, contract, approved regions, services and delivery-time commitments. The marketplace's private notes about it are never included. |
| PATCH | `/api/v1/logistics/organisation` | Logistics | Logistics(ORGANISATION_WRITE) | Update this delivery company's contact email, phones or website. Only contact details can be changed here; regions, services and contract terms are set by the marketplace. Writes an audit entry. |

### `logistics/packages`

Defined in `backend/src/http/routes/logistics.operations.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/logistics/packages/lookup` | Logistics | Logistics | What is this barcode? |
| POST | `/api/v1/logistics/packages/:id/scan` | Logistics | Logistics | Record that a carton went onto the van, or came off it. Only the first scan in each direction is kept, so scanning the same carton again changes nothing; a carton on a consignment this carrier does not hold is not found. |

### `logistics/pickups`

Defined in `backend/src/http/routes/logistics.operations.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/logistics/pickups` | Logistics | Logistics(PICKUP_READ) | The pickup board: this carrier's collections in window order, filterable by state, date range, driver or warehouse. |
| POST | `/api/v1/logistics/pickups` | Logistics | Logistics(PICKUP_WRITE) | Book a collection window for a shipment, optionally with a driver and vehicle, and move the shipment to "pickup scheduled". Refused when the window ends before it starts, or the driver or vehicle is not this carrier's. |
| POST | `/api/v1/logistics/pickups/:id/confirm` | Logistics | Logistics(PICKUP_WRITE) | Confirm that the goods are ready on the dock for a booked collection. Refused when the collection is no longer waiting to be confirmed. |
| POST | `/api/v1/logistics/pickups/:id/complete` | Logistics | Logistics(PICKUP_WRITE) | The van came and took the goods. |
| POST | `/api/v1/logistics/pickups/:id/fail` | Logistics | Logistics(PICKUP_WRITE) | Record that a collection could not be made, with the reason. Raises a high-severity missed-collection problem on the shipment. Refused once the collection is already completed or cancelled. |

### `logistics/shipments`

Defined in `backend/src/http/routes/logistics.portal.ts`, `backend/src/http/routes/logistics.operations.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/logistics/shipments` | Logistics | Logistics(SHIPMENT_READ) | One page of this delivery company's shipments, searchable and filterable by reference, company, place, status, delivery deadline, driver, problems, proof of delivery and dates, and sortable. |
| GET | `/api/v1/logistics/shipments/export` | Logistics | Logistics(SHIPMENT_EXPORT) | The same rows, as CSV. |
| GET | `/api/v1/logistics/shipments/:id` | Logistics | Logistics(SHIPMENT_READ) | One shipment this delivery company holds, with contact details masked to what the caller is entitled to see. |
| GET | `/api/v1/logistics/shipments/:id/timeline` | Logistics | Logistics(SHIPMENT_READ) | The event history of one shipment. People who can update a shipment's status also see the internal operations notes; read-only viewers see the public history only. |
| POST | `/api/v1/logistics/shipments/:id/accept` | Logistics | Logistics(SHIPMENT_ACCEPT) | Accept a shipment offered to this delivery company. The seller is told and an audit entry is written. Refused when the offer has already been answered or withdrawn. |
| POST | `/api/v1/logistics/shipments/:id/reject` | Logistics | Logistics(SHIPMENT_ACCEPT) | Decline a shipment offered to this delivery company, with a reason. The shipment goes back to waiting for a carrier, the seller is told, and the refusal is recorded against this company. |
| POST | `/api/v1/logistics/shipments/:id/status-events` | Logistics | Logistics(SHIPMENT_STATUS_WRITE) | Record a status event. |
| POST | `/api/v1/logistics/shipments/:id/exceptions` | Logistics | Logistics(SHIPMENT_EXCEPTION_WRITE) | Report a delivery problem on a shipment this company holds, such as a missed pickup, damage or a temperature excursion. Some problem types have a minimum severity; a critical one also alerts the marketplace's operations team. Writes an audit entry. |
| GET | `/api/v1/logistics/shipments/:id/documents` | Logistics | Logistics(DOCUMENT_READ) | The files on a shipment that a delivery company is allowed to see. Documents meant only for the marketplace are never included. |
| POST | `/api/v1/logistics/shipments/:id/documents` | Logistics | Logistics(DOCUMENT_WRITE) | Attach a photo to a shipment this company holds, such as a delivery photo, signature or damage evidence. Only images up to 10 MB are accepted, and a delivery company cannot attach commercial paperwork. Writes an audit entry. |
| GET | `/api/v1/logistics/shipments/:id/proof-of-delivery` | Logistics | Logistics(SHIPMENT_READ) | The proof of delivery recorded for a shipment, if any. Signature and photo files are referred to by id; a separate request gets a short-lived link to view them. |
| POST | `/api/v1/logistics/shipments/:id/proof-of-delivery` | Logistics | Logistics(POD_WRITE) | Record proof of delivery (recipient, time, place, signature or photo) and mark the shipment delivered. A shipment is delivered once: a repeat call returns the proof already recorded instead of failing. |
| GET | `/api/v1/logistics/shipments/:id/live-location` | Logistics | Logistics(TRIP_LOCATION_READ) | Where the driver on this consignment currently is, or null. |
| POST | `/api/v1/logistics/shipments/:id/assign-driver` | Logistics | Logistics(DRIVER_ASSIGN) | Put a driver on a consignment, or move it from one driver to another. |
| POST | `/api/v1/logistics/shipments/:id/unassign-driver` | Logistics | Logistics(DRIVER_ASSIGN) | Take the driver off, without putting another one on. |
| GET | `/api/v1/logistics/shipments/:id/driver-history` | Logistics | Logistics(SHIPMENT_READ) | Everyone who has carried this consignment, oldest first. |

### `logistics/vehicles`

Defined in `backend/src/http/routes/logistics.operations.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/logistics/vehicles` | Logistics | Logistics(VEHICLE_READ) | List this carrier's vehicles, in-service ones first, with their refrigeration, tail lift and weight limits. |
| POST | `/api/v1/logistics/vehicles` | Logistics | Logistics(VEHICLE_WRITE) | Add a vehicle to this carrier's fleet list. Refused when a vehicle with the same registration is already on it. Writes an audit entry. |

## Seller Hub

### `seller/agreements`

Defined in `backend/src/http/routes/seller.account.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/seller/agreements` | Seller | Seller | Accept one of the marketplace's seller agreements at a given version, by typed name or drawn signature. Only the account owner may do this. The time, IP address and browser are kept as evidence. Writes an audit entry. |
| GET | `/api/v1/seller/agreements` | Seller | Seller | Every agreement the seller has accepted, newest first: which one, which version, by whom and when. |

### `seller/audit`

Defined in `backend/src/http/routes/seller.account.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/audit` | Seller | Seller + Seller(AUDIT_READ) | The seller's own activity log, newest first: who did what, to what, and when. Shows a short summary of each change, not the full before-and-after. |

### `seller/brand-requests`

Defined in `backend/src/http/routes/seller.listings.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/seller/brand-requests` | Seller | Seller(LISTING_READ) + Seller(BRAND_REQUEST) | Ask the marketplace to add a brand that is not in the catalogue yet. Only a duplicate is refused; an unusual name is accepted and flagged for the operator. Writes an audit entry. |
| GET | `/api/v1/seller/brand-requests` | Seller | Seller(LISTING_READ) | The seller's own brand requests and what happened to each. |
| DELETE | `/api/v1/seller/brand-requests/:id` | Seller | Seller(LISTING_READ) + Seller(BRAND_REQUEST) | Withdraw a brand request the marketplace has not decided on yet. |

### `seller/brands`

Defined in `backend/src/http/routes/seller.listings.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/brands` | Seller | Seller(LISTING_READ) | Search the brands this seller is allowed to list under, plus the brands on their recent listings. Also returns advisory warnings about the name typed, which never block anything. |

### `seller/business-profile`

Defined in `backend/src/http/routes/seller.account.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/business-profile` | Seller | Seller | The seller's company details and business profile as entered in the application, with their logo. The marketplace's private notes on the seller are never included. |
| PATCH | `/api/v1/seller/business-profile` | Seller | Seller | Save the business details step of the seller application - contacts, registration and tax numbers, address - and return what is still missing. Refused once the application is under review. Writes an audit entry. |

### `seller/carriers`

Defined in `backend/src/http/routes/seller.operations.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/carriers` | Seller | Seller + Seller(ORDER_READ) | Every delivery company arrangement the seller has, in any state, including requests that were refused or ended. |
| POST | `/api/v1/seller/carriers` | Seller | Seller + TradingSeller(ORDER_FULFIL) | Ask to use a delivery company on the marketplace, optionally with the seller's own account number there. The request waits for the marketplace to approve it; a refused or ended one can be asked for again. |

### `seller/consignments`

Defined in `backend/src/http/routes/seller.operations.ts`, `backend/src/http/routes/seller.documents.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/seller/consignments/:id/quotes` | Seller | Seller + TradingSeller(ORDER_FULFIL) | Ask the carrier what this consignment costs. |
| GET | `/api/v1/seller/consignments/:id/quotes` | Seller | Seller + TradingSeller(ORDER_READ) | The carrier prices currently on offer for one consignment, plus the one the seller chose, cheapest first. Asks no carrier for new prices. |
| POST | `/api/v1/seller/consignments/:id/quotes/:quoteId/select` | Seller | Seller + TradingSeller(ORDER_FULFIL) | The seller picks one service. Exactly one can be selected per consignment. |
| POST | `/api/v1/seller/consignments/:id/purchase` | Seller | Seller + TradingSeller(ORDER_FULFIL) | Book it at the carrier. |
| GET | `/api/v1/seller/consignments/:id/carrier-options` | Seller | Seller + Seller(ORDER_READ) | Which of this seller's carriers may take this consignment. |
| POST | `/api/v1/seller/consignments/:id/carrier` | Seller | Seller + TradingSeller(ORDER_FULFIL) | Hand the consignment to one of them. |
| POST | `/api/v1/seller/consignments/:id/withdraw` | Seller | Seller + TradingSeller(ORDER_FULFIL) | Take the consignment back from whoever has it, before collection. |
| POST | `/api/v1/seller/consignments/:id/manual-booking` | Seller | Seller + TradingSeller(ORDER_FULFIL) | Choose DHL, FedEx or India Post for a consignment, to be booked by the seller on the carrier's own site or counter. Books nothing itself; the seller is reminded until they enter the carrier's tracking number. |
| PATCH | `/api/v1/seller/consignments/:id/manual-booking` | Seller | Seller + TradingSeller(ORDER_FULFIL) | Record what the carrier gave the seller for a hand-made booking: service, collection reference, dates, cost and tracking number. Entering the tracking number marks the booking as made and the collection as scheduled. |
| POST | `/api/v1/seller/consignments/:id/manual-booking/cancel` | Seller | Seller + TradingSeller(ORDER_FULFIL) | Cancel a hand-made carrier booking before collection, with a reason. |
| POST | `/api/v1/seller/consignments/:id/milestones` | Seller | Seller + TradingSeller(ORDER_FULFIL) | Where the seller's own outside carrier says the parcel is. |
| POST | `/api/v1/seller/consignments/:id/documents` | Seller | Seller + TradingSeller(ORDER_FULFIL) | Upload a file to a hand-booked consignment, such as the carrier's own label, a customs form or a proof of delivery. Only allowed while the consignment has a live hand-made booking. |
| GET | `/api/v1/seller/consignments/:id/tracking` | Seller | Seller + Seller(ORDER_READ) | The journey as the seller may see it: public descriptions, never internal notes. |
| POST | `/api/v1/seller/consignments/:id/pickups` | Seller | Seller + TradingSeller(ORDER_FULFIL) | Ask for the parcels to be collected. |
| GET | `/api/v1/seller/consignments/:id/documents` | Public |  | One of the seller's consignments, with its packages, invoices and packing lists. |
| PUT | `/api/v1/seller/consignments/:id/packages` | Public |  | Replace the list of packages in a consignment and what each one holds. Refused once a package has been scanned out, a shipping label bought or a packing list issued. |
| POST | `/api/v1/seller/consignments/:id/split` | Public |  | Move some of a consignment's items onto a new consignment, for example a second vehicle or a second day. Refused once an invoice or packing list is issued or the packages are locked. |
| POST | `/api/v1/seller/consignments/:id/invoice/preview` | Public |  | Prepare or refresh the draft invoice for a consignment and say whether it can be issued, listing anything that must be fixed first. Never changes an issued invoice. |
| GET | `/api/v1/seller/consignments/:id/invoice/pdf` | Public |  | The consignment's invoice as a PDF: the issued one if there is one, otherwise a watermarked draft. |
| POST | `/api/v1/seller/consignments/:id/invoice/issue` | Public |  | Issue the consignment's tax invoice: give it its number, store the final PDF and email the buyer. Refused while the draft still has problems; asking again after it is issued returns the same invoice. Writes an audit entry. |
| POST | `/api/v1/seller/consignments/:id/packing-list/preview` | Public |  | Prepare or refresh the draft packing list for a consignment and say whether it can be issued, listing anything that must be fixed first. |
| GET | `/api/v1/seller/consignments/:id/packing-list/pdf` | Public |  | The consignment's packing list as a PDF: the issued one if there is one, otherwise a watermarked draft. |
| POST | `/api/v1/seller/consignments/:id/packing-list/issue` | Public |  | Issue the consignment's packing list: give it its number and store the final PDF. Refused while the draft still has problems; asking again after it is issued returns the same list. Writes an audit entry. |
| POST | `/api/v1/seller/consignments/:id/packing-list/supersede` | Public |  | Withdraw an issued packing list, with a reason, so the load can be re-packed and a new list issued. Only allowed before the carrier has scanned anything out. Writes an audit entry. |
| POST | `/api/v1/seller/consignments/:id/pack` | Public |  | Invoice + packing list + packed, together or not at all. |

### `seller/dashboard`

Defined in `backend/src/http/routes/seller.operations.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/dashboard` | Seller | Seller | No cache header, ever. |

### `seller/document-links`

Defined in `backend/src/http/routes/seller.documents.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/seller/document-links/:kind/:id` | Public |  | Get a short-lived, single-use download link for one of the seller's own invoices or packing lists. |
| POST | `/api/v1/seller/document-links/batch` | Public |  | Get a short-lived, single-use link that downloads up to 100 of the seller's own documents as one ZIP file. |

### `seller/documents`

Defined in `backend/src/http/routes/seller.account.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/documents` | Seller | Seller | Everything this seller has up, and what the marketplace made of each. |
| POST | `/api/v1/seller/documents` | Seller | Seller + Seller(ACCOUNT_WRITE) | Attach one. |
| DELETE | `/api/v1/seller/documents/:id` | Seller | Seller + Seller(ACCOUNT_WRITE) | Withdraw one nobody has decided yet. |
| POST | `/api/v1/seller/documents/:id/link` | Seller | Seller | A link to read one back. Minutes, and single use. |
| GET | `/api/v1/seller/documents/:id/download` | Seller | Seller | Redeem it. |

### `seller/erp`

Defined in `backend/src/http/routes/seller.erp.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/erp/connections` | Seller | Seller + Seller(INTEGRATION_READ) | The seller's TallyPrime connections, with whether the feature is switched on for this marketplace. When it is off the list is empty and the flag says so. |
| POST | `/api/v1/seller/erp/connections` | Seller | Seller + Feature + Seller(INTEGRATION_WRITE) | Create a new TallyPrime connection for the seller. It starts with nothing switched on: no company chosen and nothing posted to the seller's accounts until each step is set up. |
| GET | `/api/v1/seller/erp/connections/:id` | Seller | Seller + Seller(INTEGRATION_READ) | One of the seller's TallyPrime connections, with its current state worked out fresh. |
| POST | `/api/v1/seller/erp/connections/:id/enabled` | Seller | Seller + Feature + Seller(INTEGRATION_WRITE) | Switch a connection off or back on. Off stops all sending and the paired computer's access; settings, history and queued work are kept for when it is switched back on. |
| POST | `/api/v1/seller/erp/connections/:id/pairing-codes` | Seller | Seller + Feature + Seller(INTEGRATION_WRITE) | Generate a pairing code. |
| GET | `/api/v1/seller/erp/connections/:id/devices` | Seller | Seller + Seller(INTEGRATION_READ) | Every computer ever paired to this connection, newest first, and whether each is currently online. |
| POST | `/api/v1/seller/erp/devices/:id/revoke` | Seller | Seller + Feature + Seller(INTEGRATION_WRITE) | Remove a paired computer's access immediately, for example after a laptop is lost. Work it had picked up is handed back for another paired computer. Recorded in the connection's security trail. |
| POST | `/api/v1/seller/erp/connections/:id/test` | Seller | Seller + Feature + Seller(INTEGRATION_WRITE) | Ask the bridge to test the connection. |
| GET | `/api/v1/seller/erp/connections/:id/companies` | Seller | Seller + Seller(INTEGRATION_READ) | The Tally companies the last connection test found open, to choose from. |
| POST | `/api/v1/seller/erp/connections/:id/company` | Seller | Seller + Feature + Seller(INTEGRATION_WRITE) | Choose which Tally company this connection posts into. Only a company the last test actually found is accepted; a typed-in name is refused. |
| GET | `/api/v1/seller/erp/connections/:id/mappings` | Seller | Seller + Seller(INTEGRATION_READ) | How the seller's products, buyers, taxes and so on are matched to names in Tally, plus the matches the seller's settings still need before syncing. |
| PUT | `/api/v1/seller/erp/connections/:id/mappings` | Seller | Seller + Feature + Seller(INTEGRATION_WRITE) | Save up to 500 matches between the seller's records and names in Tally. They are saved all together or not at all. |
| GET | `/api/v1/seller/erp/connections/:id/masters` | Seller | Seller + Seller(INTEGRATION_READ) | The picker's options - what the last master pull found in Tally. |
| POST | `/api/v1/seller/erp/connections/:id/masters/refresh` | Seller | Seller + Feature + Seller(INTEGRATION_WRITE) | Ask the bridge to re-read the master lists out of Tally. |
| GET | `/api/v1/seller/erp/connections/:id/policy` | Seller | Seller + Seller(INTEGRATION_READ) | What this connection sends to Tally (orders, invoices, receipts, credit notes), how cancellations and stock are handled, and its retry settings. |
| PATCH | `/api/v1/seller/erp/connections/:id/policy` | Seller | Seller + Feature + Seller(INTEGRATION_WRITE) | Change some of this connection's sync settings. Only the fields sent are changed, and each change is recorded with its previous value. |
| POST | `/api/v1/seller/erp/connections/:id/auto-create-masters` | Seller | Seller + Feature + Seller(INTEGRATION_WRITE) | Whether we may create masters in their chart of accounts unprompted. |
| POST | `/api/v1/seller/erp/connections/:id/validate` | Seller | Seller + Feature + Seller(INTEGRATION_WRITE) | "Would a sync work right now?" |
| POST | `/api/v1/seller/erp/connections/:id/initial-sync` | Seller | Seller + Feature + Seller(INTEGRATION_WRITE) | The first sync. |
| GET | `/api/v1/seller/erp/connections/:id/jobs` | Seller | Seller + Seller(INTEGRATION_READ) | The connection's sync jobs, page by page, optionally filtered by status. |
| POST | `/api/v1/seller/erp/jobs/:id/retry` | Seller | Seller + Feature + Seller(INTEGRATION_WRITE) | Try a failed sync job again. Only a job that has failed can be retried; one that already succeeded is refused, so nothing is posted twice. |
| POST | `/api/v1/seller/erp/jobs/:id/cancel` | Seller | Seller + Feature + Seller(INTEGRATION_WRITE) | Cancel a sync job that should not be sent. Refused while it is running and for anything already posted to Tally, which is undone with a credit note instead. |
| GET | `/api/v1/seller/erp/connections/:id/audit` | Seller | Seller + Seller(AUDIT_READ) | The security trail: pairings, revocations, mapping and policy changes. |

### `seller/freight-quotes`

Defined in `backend/src/http/routes/seller.operations.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/freight-quotes` | Seller | Seller + Seller(FULFILMENT_READ) | The freight price requests on the seller's account, for loads such as pallets or containers that no parcel carrier can take. Can be filtered by state or by order. |
| POST | `/api/v1/seller/freight-quotes/:id/answer` | Seller | Seller + Seller(FULFILMENT_WRITE) | Enter a real figure. |
| POST | `/api/v1/seller/freight-quotes/:id/decline` | Seller | Seller + Seller(FULFILMENT_WRITE) | Decline to carry a load that was sent for a freight price, with a reason. Only possible while the request is still open or quoted. |

### `seller/fulfilment`

Defined in `backend/src/http/routes/seller.account.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/fulfilment/options` | Seller | Seller + Seller(FULFILMENT_READ) | The five options, with this seller's own state folded into each. |
| POST | `/api/v1/seller/fulfilment/methods` | Seller | Seller + Seller(FULFILMENT_WRITE) | Choose a way of delivering. |
| PATCH | `/api/v1/seller/fulfilment/methods/:methodId/role` | Seller | Seller + Seller(FULFILMENT_WRITE) | Make a method the default, the fallback, or neither. |
| PATCH | `/api/v1/seller/fulfilment/methods/:methodId/status` | Seller | Seller + Seller(FULFILMENT_WRITE) | Pause a method, restart it, or disconnect it for good. |
| GET | `/api/v1/seller/fulfilment/rules` | Seller | Seller + Seller(FULFILMENT_READ) | The rules that route a parcel, in the order they are tried. |
| PUT | `/api/v1/seller/fulfilment/rules` | Seller | Seller + Seller(FULFILMENT_WRITE) | Write a routing rule, or move the one that already exists. |
| DELETE | `/api/v1/seller/fulfilment/rules/:ruleId` | Seller | Seller + Seller(FULFILMENT_WRITE) | Retire a rule. |
| GET | `/api/v1/seller/fulfilment/connections` | Seller | Seller + Seller(FULFILMENT_READ) | The seller's own carrier accounts (DHL, FedEx and others) connected here, with the state of each. Never returns a key - only its last few characters. |
| POST | `/api/v1/seller/fulfilment/connections` | Seller | Seller + Seller(FULFILMENT_WRITE) | Add one of the seller's own carrier accounts, for testing or live use, with its account numbers and defaults. It starts unconfigured, with no key stored; refused if the seller already has that carrier for that environment. Writes an audit entry. |
| GET | `/api/v1/seller/fulfilment/connections/fields/:provider` | Seller | Seller + Seller(FULFILMENT_READ) | Which boxes this carrier's connection screen should show. |
| PUT | `/api/v1/seller/fulfilment/connections/:connectionId/credentials` | Seller | Seller + Seller(CARRIER_CREDENTIAL_WRITE) | Store or rotate the key. |
| POST | `/api/v1/seller/fulfilment/connections/:connectionId/test` | Seller | Seller + Seller(FULFILMENT_WRITE) | Call the carrier for real, and write down what happened. |
| POST | `/api/v1/seller/fulfilment/connections/:connectionId/activate` | Seller | Seller + Seller(FULFILMENT_WRITE) | The second gate: a person says to start shipping real parcels with it. |
| POST | `/api/v1/seller/fulfilment/connections/:connectionId/pause` | Seller | Seller + Seller(FULFILMENT_WRITE) | Stop using one of the seller's carrier accounts without deleting its key, or put it back into service. Resuming is refused until the connection has passed a test. Writes an audit entry. |
| DELETE | `/api/v1/seller/fulfilment/connections/:connectionId/credentials` | Seller | Seller + Seller(CARRIER_CREDENTIAL_WRITE) | Disconnect, and destroy the key. |
| POST | `/api/v1/seller/fulfilment/self-managed` | Seller | Seller + Seller(FULFILMENT_WRITE) | Create the seller's own delivery arm. |
| GET | `/api/v1/seller/fulfilment/partners/search` | Seller | Seller + Seller(FULFILMENT_READ) | Which delivery companies could this seller ask to work for them. |
| POST | `/api/v1/seller/fulfilment/partners/request` | Seller | Seller + Seller(FULFILMENT_WRITE) | Ask a delivery company that is already here to work for this seller. |
| POST | `/api/v1/seller/fulfilment/partners/invite` | Seller | Seller + Seller(FULFILMENT_WRITE) | Invite a delivery company that is not here yet. |
| DELETE | `/api/v1/seller/fulfilment/partners/invitations/:invitationId` | Seller | Seller + Seller(FULFILMENT_WRITE) | Withdraw an invitation nobody has taken up. |
| GET | `/api/v1/seller/fulfilment/arrangements/:linkId/history` | Seller | Seller + Seller(FULFILMENT_READ) | How an arrangement reached the state it is in. |
| GET | `/api/v1/seller/fulfilment/methods/:methodId/pickup-profiles` | Seller | Seller + Seller(FULFILMENT_READ) | The collection set-up for each of the seller's buildings under one of their delivery methods: days, time window, cut-off, contact and limits. |
| PUT | `/api/v1/seller/fulfilment/methods/:methodId/pickup-profiles` | Seller | Seller + Seller(FULFILMENT_WRITE) | How goods leave one building under one method. |
| GET | `/api/v1/seller/fulfilment/methods/:methodId/service-areas` | Seller | Seller + Seller(FULFILMENT_READ) | The countries and regions a delivery method covers or excludes, with delivery days, transit times and any remote-area surcharge. |
| PUT | `/api/v1/seller/fulfilment/methods/:methodId/service-areas` | Seller | Seller + Seller(FULFILMENT_WRITE) | Add or update a country or region that a delivery method the seller runs themselves covers - or excludes, since an exclusion beats any overlapping area. Writes an audit entry. |
| DELETE | `/api/v1/seller/fulfilment/methods/:methodId/service-areas/:areaId` | Seller | Seller + Seller(FULFILMENT_WRITE) | Remove a country or region from a delivery method the seller runs themselves. Writes an audit entry. |
| GET | `/api/v1/seller/fulfilment/methods/:methodId/capabilities` | Seller | Seller + Seller(FULFILMENT_READ) | What a delivery method has asked to be allowed to carry (for example chilled goods), and whether the marketplace approved each request. |
| POST | `/api/v1/seller/fulfilment/methods/:methodId/capabilities` | Seller | Seller + Seller(FULFILMENT_WRITE) | Ask to be allowed to carry something. |
| GET | `/api/v1/seller/fulfilment/methods/:methodId/rate-cards` | Seller | Seller + Seller(FULFILMENT_READ) | Every price list published for one of the seller's delivery methods, with all its versions and price bands. |
| POST | `/api/v1/seller/fulfilment/methods/:methodId/rate-cards` | Seller | Seller + Seller(FULFILMENT_WRITE) | Publish what this operation charges. |

### `seller/instructions`

Defined in `backend/src/http/routes/seller.listings.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/instructions` | Seller | Seller(LISTING_READ) | The same thing across everything this seller sells. |

### `seller/inventory`

Defined in `backend/src/http/routes/seller.operations.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/inventory` | Seller | Seller + Seller(INVENTORY_READ) | One page of the seller's stock, per listing and per place. Can be narrowed to one place, a search, items running low, or batches expiring soon. |
| POST | `/api/v1/seller/inventory/movements` | Seller | Seller + TradingSeller(INVENTORY_WRITE) | Add or remove stock at one place - goods received, a correction, a return, or moving units into or out of quarantine - and record why. Refused if it would take stock below zero. Writes an audit entry. |
| PATCH | `/api/v1/seller/inventory/:offerId/:locationId` | Seller | Seller + Seller(INVENTORY_WRITE) | Change the reorder level and batch details (batch number, made and expiry dates) for one listing's stock at one place. Does not change the quantity. |
| GET | `/api/v1/seller/inventory/:offerId/movements` | Seller | Seller + Seller(INVENTORY_READ) | The history of stock changes for one listing, most recent first. |

### `seller/invoice-settings`

Defined in `backend/src/http/routes/seller.documents.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/invoice-settings` | Seller | Seller(ACCOUNT_READ) | The seller's invoice settings (number series, financial year, signatory, export bond reference, footer), plus the legal name and tax number invoices will be issued under. |
| PUT | `/api/v1/seller/invoice-settings` | Seller | Seller(ACCOUNT_WRITE) | Save the seller's invoice settings. Writes an entry in the seller's activity log. |

### `seller/invoices`

Defined in `backend/src/http/routes/seller.documents.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/seller/invoices/:id/credit` | Public |  | Cancel an issued invoice by issuing a credit note for the same amount, with a reason. The original is kept and marked void, and the consignment can then be invoiced again under a new number. Writes an audit entry. |

### `seller/listing-drafts`

Defined in `backend/src/http/routes/seller.listings.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/listing-drafts` | Seller | Seller(LISTING_READ) | One page of the seller's listings still in the wizard or in review, filterable by status, text, category and brand. |
| POST | `/api/v1/seller/listing-drafts` | Seller | Seller(LISTING_READ) + TradingSeller(LISTING_WRITE) | Start a new listing in the wizard, optionally with its category, brand or matching catalogue product already chosen. Writes an audit entry. |
| GET | `/api/v1/seller/listing-drafts/:id` | Seller | Seller(LISTING_READ) | One listing in the wizard, with everything entered so far. |
| PATCH | `/api/v1/seller/listing-drafts/:id` | Seller | Seller(LISTING_READ) + Seller(LISTING_WRITE) | Autosave. |
| POST | `/api/v1/seller/listing-drafts/:id/variants/generate` | Seller | Seller(LISTING_READ) + Seller(LISTING_WRITE) | Build the combination rows for the axes the seller switched on. |
| POST | `/api/v1/seller/listing-drafts/:id/validate` | Seller | Seller(LISTING_READ) | Re-run every check on a wizard listing and return what is still missing or wrong. Its status moves to match: ready to submit once everything passes. |
| POST | `/api/v1/seller/listing-drafts/:id/preview-title` | Seller | Seller(LISTING_READ) | What the title will be, and which fields made it. |
| POST | `/api/v1/seller/listing-drafts/:id/submit` | Seller | Seller(LISTING_READ) + TradingSeller(LISTING_SUBMIT) | Send a finished listing to the marketplace's quality review. Refused, with each blocking problem listed, if anything is still missing. It goes on sale only once a moderator approves it. Writes an audit entry. |
| POST | `/api/v1/seller/listing-drafts/:id/withdraw` | Seller | Seller(LISTING_READ) + Seller(LISTING_SUBMIT) | Take a listing back out of the review queue and return it to the wizard, before a moderator has decided on it. Writes an audit entry. |
| GET | `/api/v1/seller/listing-drafts/:id/media` | Seller | Seller(LISTING_READ) | The photos and videos uploaded to a listing in the wizard. |
| POST | `/api/v1/seller/listing-drafts/:id/media` | Seller | Seller(LISTING_READ) + TradingSeller(MEDIA_UPLOAD) | Upload one photograph or video. |
| PATCH | `/api/v1/seller/listing-drafts/:id/media/:mediaId` | Seller | Seller(LISTING_READ) + Seller(MEDIA_UPLOAD) | Change a wizard photo or video's slot, description, order, or whether it is the main picture. Making one the main picture clears it from the others; a video cannot be the main picture. |
| DELETE | `/api/v1/seller/listing-drafts/:id/media/:mediaId` | Seller | Seller(LISTING_READ) + Seller(MEDIA_UPLOAD) | Delete a photo or video from a wizard listing, including the stored file. If it was the main picture, another photo takes its place. |

### `seller/listing-schema`

Defined in `backend/src/http/routes/seller.listings.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/listing-schema` | Seller | Seller(LISTING_READ) | The fields this category asks for. |

### `seller/listings`

Defined in `backend/src/http/routes/seller.listings.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/listings` | Seller | Seller(LISTING_READ) | One page of the seller's listings, with a count for each status tab. Can be filtered by status, text, category, brand, warehouse or stock level, and sorted by date, price, stock or quality score. |
| GET | `/api/v1/seller/listings/:id` | Seller | Seller(LISTING_READ) | One of the seller's listings in full, for its detail screen. |
| PATCH | `/api/v1/seller/listings/:id/status` | Seller | Seller(LISTING_READ) + Seller(OFFER_PUBLISH) | Put a listing on sale, pause it (with an optional private note) or archive it. Putting it back on sale is refused while the marketplace has flagged it as needing changes. Writes an audit entry. |
| PATCH | `/api/v1/seller/listings/:id/price` | Seller | Seller(LISTING_READ) + Seller(OFFER_PRICE_WRITE) | Change a listing's price, "was" price, order quantity limits and simple quantity discounts. Needs the pricing permission and writes an audit entry, so a disputed price change can be traced to who made it and when. |
| GET | `/api/v1/seller/listings/:id/variants` | Seller | Seller(LISTING_READ) | Versions on a listing that already exists. |
| GET | `/api/v1/seller/listings/:id/instructions` | Seller | Seller(LISTING_READ) | Instructions shoppers have left on the product behind this listing. |
| POST | `/api/v1/seller/listings/:id/variants/preview` | Seller | Seller(LISTING_READ) + Seller(LISTING_WRITE) | Show which versions (for example sizes or colours) a set of options would produce on an existing listing, marking the ones already on sale. Creates nothing. |
| POST | `/api/v1/seller/listings/:id/variants` | Seller | Seller(LISTING_READ) + TradingSeller(LISTING_WRITE) | Add new versions to an existing listing as real, sellable items, each with its own price and opening stock. Versions already on sale are skipped, so sending the same request twice adds nothing. Writes an audit entry. |
| GET | `/api/v1/seller/listings/:id/edit` | Seller | Seller(LISTING_READ) | Editing a listing that already exists. |
| POST | `/api/v1/seller/listings/:id/pause-for-edit` | Seller | Seller(LISTING_READ) + Seller(OFFER_PUBLISH) | Take a live listing off sale so its structure can be edited, recording that it was paused for editing. Does nothing if it is already paused. Writes an audit entry. |
| PATCH | `/api/v1/seller/listings/:id/edit` | Seller | Seller(LISTING_READ) + TradingSeller(LISTING_WRITE) | Save an edit to an existing listing - terms, versions and their stock - all at once, then leave it paused or put it back on sale. Structural changes are refused while the listing is on sale, and so is an edit made from an out-of- date copy. Writes an audit entry. |
| POST | `/api/v1/seller/listings/:id/photos` | Seller | Seller(LISTING_READ) + TradingSeller(MEDIA_UPLOAD) | The photographs on a listing the seller is editing. |
| PATCH | `/api/v1/seller/listings/:id/photos/:mediaId` | Seller | Seller(LISTING_READ) + Seller(MEDIA_UPLOAD) | Make one of a listing's photos the one buyers see first. Writes an audit entry. |
| DELETE | `/api/v1/seller/listings/:id/photos/:mediaId` | Seller | Seller(LISTING_READ) + Seller(MEDIA_UPLOAD) | Take a photo off a listing. The picture file itself is kept, since other listings may use it. Writes an audit entry. |
| POST | `/api/v1/seller/listings/:id/duplicate` | Seller | Seller(LISTING_READ) + TradingSeller(LISTING_WRITE) | Copy a listing's terms into a new, not-yet-live listing under a new SKU. Stock is not copied. Writes an audit entry. |

### `seller/locations`

Defined in `backend/src/http/routes/seller.operations.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/locations` | Seller | Seller + Seller(LOCATION_READ) | The seller's dispatch addresses, and the map they are drawn on. |
| POST | `/api/v1/seller/locations` | Seller | Seller + Seller(LOCATION_WRITE) | Add a dispatch address (a warehouse, shop or pickup point) for the seller. Refused if the seller already has a place with the same code. Writes an audit entry. |
| POST | `/api/v1/seller/locations/geocode` | Seller | Seller + Seller(LOCATION_WRITE) | An address to coordinates, for the seller's own dispatch places. |
| POST | `/api/v1/seller/locations/geocode/suggest` | Seller | Seller + Seller(LOCATION_WRITE) | Every candidate for what the seller has typed so far, not just the first. |
| PATCH | `/api/v1/seller/locations/:id` | Seller | Seller + Seller(LOCATION_WRITE) | Change one of the seller's dispatch addresses, including marking it as not operating, with a reason. Writes an audit entry. |
| DELETE | `/api/v1/seller/locations/:id` | Seller | Seller + Seller(LOCATION_WRITE) | Close a dispatch address for good. It is archived, not deleted, so past stock records still make sense. Refused while stock is still held there. Writes an audit entry. |

### `seller/logistics`

Defined in `backend/src/http/routes/seller.logistics.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/logistics/policy` | Seller | Seller(FULFILMENT_READ) | The seller's delivery policy: who handles each of the four delivery stages, both as published and as in the unpublished draft, with the carriers and prices set on each. |
| PUT | `/api/v1/seller/logistics/policy` | Seller | Seller(FULFILMENT_WRITE) | Save the draft delivery policy: self-managed, UBOSS-managed or a mix, and who handles each stage. Buyers see no change until it is published; changing who handles a stage of a published policy must be confirmed. |
| PUT | `/api/v1/seller/logistics/levels/:level` | Seller | Seller(FULFILMENT_WRITE) | One level's owner in the draft. The checkbox "I will manage this level": checked is SELLER, unchecked is UBOSS. The draft keeps its mode unless the change takes it out of Self or UBOSS, which makes it Self + UBOSS. Handing L1 to UBOSS is refused. Against a published policy a change of owner must be confirmed, and a stale version is refused. |
| POST | `/api/v1/seller/logistics/policy/publish` | Seller | Seller(FULFILMENT_WRITE) | Publish the draft delivery policy so it applies to new carts and orders. The previous version is kept, because orders already placed still refer to it. |
| GET | `/api/v1/seller/logistics/history` | Seller | Seller(FULFILMENT_READ) | The seller's past delivery policy versions and the log of changes to its policy, carriers, prices and stage assignments. |
| GET | `/api/v1/seller/logistics/providers` | Seller | Seller(FULFILMENT_READ) | The carriers the seller can use on their own delivery stages, whether each is switched on, and the state of any carrier account connection. |
| POST | `/api/v1/seller/logistics/providers/:provider/enable` | Seller | Seller(FULFILMENT_WRITE) | Switch a carrier on for the seller's own delivery stages, either booked by hand or marked for an account connection. This does not connect an account; that is done in carrier setup. |
| POST | `/api/v1/seller/logistics/providers/:provider/disable` | Seller | Seller(FULFILMENT_WRITE) | Switch a carrier off for the seller's own delivery stages. |
| GET | `/api/v1/seller/logistics/partners` | Seller | Seller(FULFILMENT_READ) | Delivery companies this seller may put on a level: their own, and approved ones. |
| GET | `/api/v1/seller/logistics/rates` | Seller | Seller(FULFILMENT_READ) | The seller's delivery prices, optionally for one stage only. |
| POST | `/api/v1/seller/logistics/rates` | Seller | Seller(FULFILMENT_WRITE) | Add a draft delivery price for one of the seller's stages. Buyers are not charged it until it is published. Refused for a stage UBOSS handles. |
| PUT | `/api/v1/seller/logistics/rates/:rateId` | Seller | Seller(FULFILMENT_WRITE) | Change a delivery price. Editing a published price creates a new draft that replaces it once published; the published one is never altered. |
| POST | `/api/v1/seller/logistics/rates/:rateId/publish` | Seller | Seller(FULFILMENT_WRITE) | Publish a draft delivery price so buyers are charged it, replacing the price it supersedes. |
| POST | `/api/v1/seller/logistics/rates/:rateId/deactivate` | Seller | Seller(FULFILMENT_WRITE) | Switch a delivery price off. It stays on record, and orders already charged at it keep it. |

### `seller/logo`

Defined in `backend/src/http/routes/seller.account.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/seller/logo` | Seller | Seller + Seller(ACCOUNT_WRITE) | The mark on the seller's own shop front. |
| DELETE | `/api/v1/seller/logo` | Seller | Seller + Seller(ACCOUNT_WRITE) | Remove the seller's shop logo. Writes an audit entry. |

### `seller/members`

Defined in `backend/src/http/routes/seller.account.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/members` | Seller | Seller + Seller(MEMBER_READ) | The seller's current team members, with each one's name, email, role and joining date. |
| PATCH | `/api/v1/seller/members/:memberId` | Seller | Seller + Seller(MEMBER_WRITE) | Change a team member's role. Refused if it would leave the business with no owner, or would grant a role the person making the change does not hold. Writes an audit entry. |
| DELETE | `/api/v1/seller/members/:memberId` | Seller | Seller + Seller(MEMBER_WRITE) | Remove someone from the seller's team. Their past actions still show their name, and removing the last owner is refused. Writes an audit entry. |

### `seller/new-id`

Defined in `backend/src/http/routes/seller.account.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/new-id` | Seller | Seller | An idempotency-safe id the client can use for a draft it is about to create. |

### `seller/notifications`

Defined in `backend/src/http/routes/seller.operations.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/notifications` | Seller | Seller | The seller's 50 most recent notifications, including resolved alerts but not archived ones, each marked read or unread for the person asking. |
| POST | `/api/v1/seller/notifications/:id/read` | Seller | Seller | Mark one notification as read for the person asking. Other team members still see it as unread. |

### `seller/offers`

Defined in `backend/src/http/routes/seller.listings.ts`, `backend/src/http/routes/seller.documents.ts`, `backend/src/http/routes/seller.quantity-tiers.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/offers/:id/packaging` | Seller | Seller(LISTING_READ) + Seller(LISTING_READ) | How a listing can be bought in bulk - by carton, pallet or container - with the details and prices of each. Returns an empty set-up if none has been saved yet. |
| PUT | `/api/v1/seller/offers/:id/packaging/profile` | Seller | Seller(LISTING_READ) + Seller(LISTING_WRITE) | Save the name of a listing's base unit and the seller's packaging notes. |
| PUT | `/api/v1/seller/offers/:id/packaging/options` | Seller | Seller(LISTING_READ) + Seller(LISTING_WRITE) | Save one bulk packaging option for a listing - a carton, a UK or US pallet, or a container - with its contents, size, weight, price and order limits. Writes an audit entry. |
| POST | `/api/v1/seller/offers/:id/packaging/options/:packageType/enabled` | Seller | Seller(LISTING_READ) + Seller(LISTING_WRITE) | Switch buying by one package type on or off for a listing, keeping what was entered for it. Writes an audit entry. |
| GET | `/api/v1/seller/offers/:id/packaging/preview` | Seller | Seller(LISTING_READ) + Seller(LISTING_READ) | "What would N of these come to?" |
| GET | `/api/v1/seller/offers/:id/trade-codes` | Seller | Seller(LISTING_READ) | The HSN (customs) code and country of origin saved on one of the seller's listings. |
| PUT | `/api/v1/seller/offers/:id/trade-codes` | Seller | Seller(LISTING_WRITE) | Save the HSN (customs) code and country of origin on one of the seller's listings, which its invoices print. Writes an entry in the seller's activity log. |
| GET | `/api/v1/seller/offers/:id/quantity-tiers` | Seller | Seller(LISTING_READ) | Show a listing's quantity price bands ("buy 100 or more, pay less"), beside its normal price and the saving each band gives. |
| PUT | `/api/v1/seller/offers/:id/quantity-tiers` | Seller | Seller(LISTING_WRITE) | Replace all of a listing's quantity price bands in one go. Refused if the bands overlap or contradict each other or the normal price. Writes an audit entry. |

### `seller/onboarding`

Defined in `backend/src/http/routes/seller.account.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/onboarding` | Seller | Seller | The onboarding checklist: every step, its state, and what it still needs. |
| GET | `/api/v1/seller/onboarding/requirements` | Seller | Seller | The fields this seller's country and kind demand, for a single step. |

### `seller/orders`

Defined in `backend/src/http/routes/seller.operations.ts`, `backend/src/http/routes/seller.logistics.ts`, `backend/src/http/routes/seller.documents.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/orders` | Seller | Seller + Seller(ORDER_READ) | One page of the seller's orders. Can be filtered by status, a search, dispatch place, or only those past their dispatch deadline. |
| GET | `/api/v1/seller/orders/:id` | Seller | Seller + Seller(ORDER_READ) | One of the seller's orders in full: the items they are shipping and where to. The buyer's email, phone and payment details are not included. |
| PATCH | `/api/v1/seller/orders/:id/status` | Seller | Seller + TradingSeller(ORDER_READ) | Move one of the seller's orders to its next stage, such as accepted, packing, ready or cancelled. Only allowed moves are accepted; cancelling needs the cancel permission and releases the stock the order was holding. Writes an audit entry. |
| POST | `/api/v1/seller/orders/:id/shipments` | Seller | Seller + TradingSeller(ORDER_FULFIL) | Record that some or all of an order has been sent, with the carrier and tracking number. The order counts as shipped only once every item has gone, and sending more than is left is refused. Writes an audit entry. |
| POST | `/api/v1/seller/orders/:id/consignments` | Seller | Seller + TradingSeller(ORDER_FULFIL) | Raise the consignment a confirmed order is missing. Idempotent. |
| POST | `/api/v1/seller/orders/:id/freight-quote` | Seller | Seller + Seller(ORDER_FULFIL) | Raise a request for one consignment. |
| GET | `/api/v1/seller/orders/:id/freight` | Seller | Seller + Seller(ORDER_READ) | Whether this consignment can go by carrier at all, or needs quoting. |
| GET | `/api/v1/seller/orders/:id/legs` | Seller | Seller(ORDER_READ) | The four delivery stages of one of the seller's confirmed orders, with who carries each and how far it has got. |
| POST | `/api/v1/seller/orders/:id/legs/:level/assign` | Seller | TradingSeller(ORDER_FULFIL) | Name the carrier for one of the seller's own delivery stages on an order: a carrier booked by hand or a delivery company on the platform. Changing the carrier after one is named needs a reason, and the company that loses the work is told. |
| PATCH | `/api/v1/seller/orders/:id/legs/:level` | Seller | TradingSeller(ORDER_FULFIL) | Enter the tracking number, pickup reference and expected dates on a delivery stage that already has a carrier. |
| POST | `/api/v1/seller/orders/:id/legs/:level/transition` | Seller | TradingSeller(ORDER_FULFIL) | Move one of the seller's delivery stages on an order forward: accepted, started or handed over. A stage can start only once the one before it has been handed over. |
| GET | `/api/v1/seller/orders/:id/documents` | Public |  | Every consignment of one of the seller's orders, with its packages, invoices and packing lists. |

### `seller/packaging`

Defined in `backend/src/http/routes/seller.listings.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/packaging/presets` | Seller | Seller(LISTING_READ) | The presets a form needs before anything has been saved. |

### `seller/payout-account`

Defined in `backend/src/http/routes/seller.operations.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/payout-account` | Seller | Seller + Seller(FINANCE_READ) | The state of the seller's payout account set-up, and whether this marketplace has a payout provider configured at all. |
| POST | `/api/v1/seller/payout-account/onboarding` | Seller | Seller + Seller(PAYOUT_SETUP) | Begin payout onboarding with the provider. |
| POST | `/api/v1/seller/payout-account/refresh` | Seller | Seller + Seller(PAYOUT_SETUP) | Re-read the provider after the seller comes back, and update the step. |

### `seller/payouts`

Defined in `backend/src/http/routes/seller.operations.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/payouts` | Seller | Seller + Seller(FINANCE_READ) | The seller's last 100 payouts, newest first, with their status. A failed payout carries the reason and what to do about it. |

### `seller/pickups`

Defined in `backend/src/http/routes/seller.operations.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/pickups` | Seller | Seller + Seller(ORDER_READ) | Every collection the seller has arranged, newest first. Can be narrowed to one consignment or to collections still in progress. |
| POST | `/api/v1/seller/pickups/:pickupId/ready` | Seller | Seller + TradingSeller(ORDER_FULFIL) | The goods are on the dock - the handshake that stops a wasted van call. |
| POST | `/api/v1/seller/pickups/:pickupId/cancel` | Seller | Seller + TradingSeller(ORDER_FULFIL) | Call the van off. |

### `seller/preorder-policies`

Defined in `backend/src/http/routes/seller.preorders.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/preorder-policies` | Seller | Seller(LISTING_READ) | The three levels for one listing, or the seller default when no offer is named. |
| PUT | `/api/v1/seller/preorder-policies` | Seller | Seller(OFFER_PRICE_WRITE) | Save the seller's preorder terms for one listing, one product, or as their default. Refused if the terms would turn away every request. Writes an audit entry. |
| DELETE | `/api/v1/seller/preorder-policies/:id` | Seller | Seller(OFFER_PRICE_WRITE) | Remove a set of preorder terms. Refused while a confirmed preorder still depends on them; switch them off instead. Writes an audit entry. |

### `seller/preorders`

Defined in `backend/src/http/routes/seller.preorders.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/preorders` | Seller | Seller(ORDER_READ) | List the seller's bulk preorder requests, newest activity first, with a count for each filter tab. An optional filter narrows the list, such as new, awaiting the buyer or in production. |
| GET | `/api/v1/seller/preorders/:id` | Seller | Seller(ORDER_READ) | Show one of the seller's preorder requests in full. |
| POST | `/api/v1/seller/preorders/:id/accept` | Seller | TradingSeller(ORDER_FULFIL) | Accept a preorder on exactly the quantity, price and date the buyer asked for, and email the buyer the terms to confirm. Refused if the price or date differs; that has to be sent as a counter-offer. Writes an audit entry. |
| POST | `/api/v1/seller/preorders/:id/counter` | Seller | TradingSeller(ORDER_FULFIL) | Send the buyer a counter-offer on a preorder: a different quantity, price, delivery date or split deliveries. Emails the buyer and writes an audit entry. |
| POST | `/api/v1/seller/preorders/:id/reject` | Seller | TradingSeller(ORDER_FULFIL) | Turn down a preorder with a reason. Releases any capacity it was holding, withdraws open offers, emails the buyer and writes an audit entry. |
| POST | `/api/v1/seller/preorders/:id/start-production` | Seller | TradingSeller(ORDER_FULFIL) | Mark a confirmed preorder as in production, with an optional note. Emails the buyer and writes an audit entry. |
| POST | `/api/v1/seller/preorders/:id/ready` | Seller | TradingSeller(ORDER_FULFIL) | Mark a preorder as made and ready to ship, with an optional note. Emails the buyer and writes an audit entry. |

### `seller/settlements`

Defined in `backend/src/http/routes/seller.operations.ts`, `backend/src/http/routes/seller.logistics.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/settlements` | Seller | Seller + Seller(FINANCE_READ) | One page of the seller's settlement statements, newest period first: sales, tax, shipping, fees, refunds and the amount due to them for each period. |
| GET | `/api/v1/seller/settlements/:id/lines` | Seller | Seller + Seller(FINANCE_READ) | Every line making up one of the seller's settlement statements, oldest first. |
| GET | `/api/v1/seller/settlements/estimate` | Seller | Seller(FINANCE_READ) | Estimate what the seller would be paid for a given sale amount and delivery charge, after platform fees and the tax on them, using the fee rules in force today. Read-only. |
| GET | `/api/v1/seller/settlements/orders` | Seller | Seller(FINANCE_READ) | The payouts already worked out for the seller's orders, newest first. |

### `seller/store-profile`

Defined in `backend/src/http/routes/seller.account.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| PATCH | `/api/v1/seller/store-profile` | Seller | Seller | The store details step: the description and the support contacts. |

### `seller/submit`

Defined in `backend/src/http/routes/seller.account.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/seller/submit` | Seller | Seller | Hand the application to the marketplace. |

### `sellers`

Defined in `backend/src/http/routes/seller.account.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/sellers/me` | Customer | Customer | "Do I sell here, and how is it going?" |
| POST | `/api/v1/sellers/lock` | Customer | Customer | Choose the Seller Hub password, or change it. |
| POST | `/api/v1/sellers/lock/open` | Customer | Customer | Open the Hub for this session. |
| POST | `/api/v1/sellers/lock/close` | Customer | Customer | Shut it again, without signing out of the shop. |
| GET | `/api/v1/sellers/display-name-available` | Customer | Customer | Is this public shop name free? Called as the seller types it. |
| POST | `/api/v1/sellers/apply` | Customer | Customer | Start a seller application. |

## Webhooks, integrations and health

### `health`

Defined in `backend/src/http/routes/health.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/health/live` | Public |  | Liveness probe |
| GET | `/health/ready` | Public |  | Readiness probe |

### `integrations/carriers`

Defined in `backend/src/http/routes/carrier-webhooks.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/integrations/carriers/:pathToken/webhook` | Webhook (signature) |  | Receive a tracking event pushed by a carrier and record it against the matching shipment. Only accepted when the signature over the raw body checks out; a duplicate or an event code nobody has mapped yet is still answered as accepted, so the carrier does not keep retrying it. |

### `integrations/erp`

Defined in `backend/src/http/routes/erp-webhooks.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/integrations/erp/webhooks/:slug` | Webhook (signature) |  | Where a customer's ERP system sends stock updates. The update is applied only when its signature checks out against the connection's secret; a repeat of an update already received is accepted and ignored. |

### `integrations/tally-bridge`

Defined in `backend/src/http/routes/erp-bridge.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/integrations/tally-bridge/pair` | Public | Feature | Trade a pairing code for a token. |
| POST | `/api/v1/integrations/tally-bridge/rotate-token` | Public | Feature | Swap a live token for a fresh one. The agent does this on its own. |
| POST | `/api/v1/integrations/tally-bridge/heartbeat` | Public | Feature | "I am still here." |
| POST | `/api/v1/integrations/tally-bridge/tasks/claim` | Public | Feature | "What is there for me to do?" |
| POST | `/api/v1/integrations/tally-bridge/tasks/result` | Public | Feature | "Here is what Tally said." |

### `metrics`

Defined in `backend/src/http/routes/health.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/metrics` | Public |  | Prometheus metrics |

### `payments`

Defined in `backend/src/http/routes/payments.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/payments/webhooks/:provider` | Webhook (signature) |  | Provider webhook |

## Customer account

### `account/addresses`

Defined in `backend/src/http/routes/account.customer.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/account/addresses` | Customer | Customer | List the customer's saved addresses, default delivery address first. |
| POST | `/api/v1/account/addresses` | Customer | Customer | Save a new address to the customer's account and place it on the map when possible. The first address becomes the default; making a later one the default clears the previous default. Writes an audit entry. |
| POST | `/api/v1/account/addresses/geocode/suggest` | Customer | Customer | Addresses matching what the customer has typed so far. |
| PATCH | `/api/v1/account/addresses/:addressId` | Customer | Customer | Change one of the customer's saved addresses. Making it the default clears the previous default, and the map position is looked up again only when the place itself changed. |
| DELETE | `/api/v1/account/addresses/:addressId` | Customer | Customer | Remove one of the customer's saved addresses. Past orders keep their own copy of it; refused while an active or paused recurring order still delivers to it or bills to it. |

### `account/autopay`

Defined in `backend/src/http/routes/autopay.customer.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/account/autopay` | Customer | Customer | Ungated read. |
| POST | `/api/v1/account/autopay` | Customer | Customer + Feature | Switch on automatic payment: the customer gives explicit permission for a saved card to be charged while they are away, with optional spending limits. Refused without that permission or without a card that can be charged today; the permission is recorded with an audit entry. |
| PATCH | `/api/v1/account/autopay` | Customer | Customer + Feature | Change the card, spending limits, retry choice or notification settings of automatic payment, without asking for permission again. Writes an audit entry recording the before and after. |
| POST | `/api/v1/account/autopay/pause` | Customer | Customer + Feature | Pause or resume automatic payment without withdrawing the customer's permission. Resuming checks the saved card can still be charged; refused when automatic payment is switched off. Writes an audit entry. |
| DELETE | `/api/v1/account/autopay` | Customer | Customer | Withdraw consent. |

### `account/closure`

Defined in `backend/src/http/routes/account.customer.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/account/closure` | Customer | Customer | What closing this account would do |

### `account/coupons`

Defined in `backend/src/http/routes/account.customer.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/account/coupons` | Customer | Customer | Coupons this customer can use, and the ones they have used |

### `account/dashboard`

Defined in `backend/src/http/routes/account.customer.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/account/dashboard` | Customer | Customer | Everything the buyer dashboard opens with, in one round trip. |
| POST | `/api/v1/account/dashboard/insights/stream` | Customer | Customer | The same figures, explained. |
| POST | `/api/v1/account/dashboard/insights` | Customer | Customer | Get a short written summary of the buyer's own purchasing figures for a chosen date range, with findings and suggested next steps, optionally answering a question they typed. Written by the AI provider when one is set up, otherwise by a fixed rule-based summary. |

### `account/data-requests`

Defined in `backend/src/http/routes/account.customer.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/account/data-requests` | Customer | Customer | The signed-in customer’s data subject requests |
| POST | `/api/v1/account/data-requests` | Customer | Customer | Exercise a data subject right |

### `account/deactivate`

Defined in `backend/src/http/routes/account.customer.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/account/deactivate` | Customer | Customer | Close the account, from the holder’s own side |

### `account/email-change`

Defined in `backend/src/http/routes/account.customer.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/account/email-change` | Customer | Customer | Ask to move the account to a new email address |
| POST | `/api/v1/account/email-change/confirm` | Customer | Customer | Confirm a new email address |
| DELETE | `/api/v1/account/email-change` | Customer | Customer | Abandon a pending email change |

### `account/integrations`

Defined in `backend/src/http/routes/customer-erp.customer.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/account/integrations/erp/options` | Customer | Customer | What can be connected, and how |
| GET | `/api/v1/account/integrations/erp/warehouses` | Customer | Customer | Warehouses available to map against your plants |
| GET | `/api/v1/account/integrations/erp/organization` | Customer | Customer | Your buyer organisation, its members and its open invitations |
| PATCH | `/api/v1/account/integrations/erp/organization` | Customer | Customer + Feature | Rename your organisation |
| POST | `/api/v1/account/integrations/erp/organization/invites` | Customer | Customer + Feature | Invite somebody into your organisation |
| DELETE | `/api/v1/account/integrations/erp/organization/invites/:inviteId` | Customer | Customer + Feature | Withdraw an invitation |
| POST | `/api/v1/account/integrations/erp/organization/join` | Customer | Customer | Accept an invitation |
| PATCH | `/api/v1/account/integrations/erp/organization/members/:memberId` | Customer | Customer + Feature | Change what a member may do |
| DELETE | `/api/v1/account/integrations/erp/organization/members/:memberId` | Customer | Customer + Feature | Remove somebody from your organisation |
| GET | `/api/v1/account/integrations/erp/connections` | Customer | Customer | Your connections and their health |
| POST | `/api/v1/account/integrations/erp/connections` | Customer | Customer + Feature | Create a connection |
| GET | `/api/v1/account/integrations/erp/connections/:id` | Customer | Customer | One connection |
| PATCH | `/api/v1/account/integrations/erp/connections/:id` | Customer | Customer + Feature | Change a connection |
| DELETE | `/api/v1/account/integrations/erp/connections/:id` | Customer | Customer + Feature | Remove a connection |
| PUT | `/api/v1/account/integrations/erp/connections/:id/endpoints` | Customer | Customer + Feature | Set which address does what |
| PUT | `/api/v1/account/integrations/erp/connections/:id/mappings` | Customer | Customer + Feature | Set the field mapping |
| PUT | `/api/v1/account/integrations/erp/connections/:id/warehouses` | Customer | Customer + Feature | Map warehouses to plants |
| PUT | `/api/v1/account/integrations/erp/connections/:id/policy` | Customer | Customer + Feature | Set the sync rules |
| POST | `/api/v1/account/integrations/erp/connections/:id/test` | Customer | Customer + Feature | Call your system and report what happened |
| POST | `/api/v1/account/integrations/erp/connections/:id/dry-run` | Customer | Customer + Feature | Rehearse a sync without writing anything |
| POST | `/api/v1/account/integrations/erp/connections/:id/activate` | Customer | Customer + Feature | Switch the connection on |
| POST | `/api/v1/account/integrations/erp/connections/:id/pause` | Customer | Customer + Feature | Pause the connection |
| POST | `/api/v1/account/integrations/erp/connections/:id/resume` | Customer | Customer + Feature | Resume a paused connection |
| POST | `/api/v1/account/integrations/erp/connections/:id/reconnect` | Customer | Customer + Feature | Bring a failed or disconnected connection back |
| POST | `/api/v1/account/integrations/erp/connections/:id/disconnect` | Customer | Customer + Feature | Disconnect and destroy the stored credentials |
| POST | `/api/v1/account/integrations/erp/connections/:id/sync` | Customer | Customer + Feature | Read your system now |
| POST | `/api/v1/account/integrations/erp/connections/:id/reconcile` | Customer | Customer + Feature | Compare the buyer’s catalogue against ours |
| GET | `/api/v1/account/integrations/erp/connections/:id/product-codes` | Customer | Customer | The buyer's list of their own ERP product codes matched to products in this store. A match whose product has since been removed is still listed, without a SKU, so it can be fixed. |
| POST | `/api/v1/account/integrations/erp/connections/:id/product-codes` | Customer | Customer + Feature | Match one of the buyer's ERP product codes to a product in this store. Matching a code that is already matched replaces the old match; a product that does not exist is refused. |
| DELETE | `/api/v1/account/integrations/erp/connections/:id/product-codes/:mappingId` | Customer | Customer + Feature | Remove one product-code match. That code then matches by SKU again, or not at all. |
| POST | `/api/v1/account/integrations/erp/connections/:id/product-codes/import` | Customer | Customer + Feature | A two-column file: their code, our SKU. |
| POST | `/api/v1/account/integrations/erp/connections/:id/oauth/start` | Customer | Customer + Feature | Begin an OAuth authorisation |
| POST | `/api/v1/account/integrations/erp/oauth/callback` | Customer | Customer + Feature | Finish an OAuth authorisation |
| POST | `/api/v1/account/integrations/erp/openapi/import` | Customer | Customer + Feature | Suggest endpoints from an OpenAPI document |
| GET | `/api/v1/account/integrations/erp/events` | Customer | Customer | The activity log |
| POST | `/api/v1/account/integrations/erp/events/:eventId/retry` | Customer | Customer + Feature | Send a failed or skipped item again |
| GET | `/api/v1/account/integrations/erp/jobs` | Customer | Customer | Sync history |
| GET | `/api/v1/account/integrations/erp/webhook-events` | Customer | Customer | Deliveries from your system, accepted and refused |
| GET | `/api/v1/account/integrations/erp/approvals` | Customer | Customer | Things waiting for somebody to decide |
| POST | `/api/v1/account/integrations/erp/approvals/:approvalId` | Customer | Customer + Feature | Approve or decline |
| GET | `/api/v1/account/integrations/erp/audit` | Customer | Customer | Your organisation’s own audit trail |
| GET | `/api/v1/account/integrations/erp/connections/:id/links` | Customer | Customer | Orders and invoices this connection has linked |

### `account/locale`

Defined in `backend/src/http/routes/account.customer.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/account/locale` | Customer | Customer | Public capability flags the storefront branches on before rendering. |
| PUT | `/api/v1/account/locale` | Customer | Customer | Save the shopper's country and the currency they want prices in. Refused for a country this store does not ship to or a currency it does not sell in; with no currency given, the country's own currency is used. |

### `account/notifications`

Defined in `backend/src/http/routes/account.customer.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/account/notifications` | Customer | Customer | What this deployment has sent to this customer |

### `account/payment-methods`

Defined in `backend/src/http/routes/payment-methods.customer.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/account/payment-methods` | Customer | Customer | List the customer's saved cards, default first, including expired ones. Removed cards are not shown. Available even when automatic payments are switched off. |
| POST | `/api/v1/account/payment-methods/setup-intent` | Customer | Customer | Begin enrolment. |
| POST | `/api/v1/account/payment-methods` | Customer | Customer | Finish enrolment. The provider is re-read; the client is not trusted. |
| POST | `/api/v1/account/payment-methods/:id/default` | Customer | Customer | Make one of the customer's saved cards their default. Refused for a card that is no longer usable; writes an audit entry. |
| DELETE | `/api/v1/account/payment-methods/:id` | Customer | Customer | Remove a card. |

### `account/phone-change`

Defined in `backend/src/http/routes/account.customer.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/account/phone-change` | Customer | Customer | Ask to change the telephone number on the account |
| POST | `/api/v1/account/phone-change/confirm` | Customer | Customer | Confirm a new telephone number |
| DELETE | `/api/v1/account/phone-change` | Customer | Customer | Abandon a pending telephone change |

### `account/product-instructions`

Defined in `backend/src/http/routes/account.customer.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/account/product-instructions` | Customer | Customer | What this shopper has already said about a product. |
| POST | `/api/v1/account/product-instructions` | Customer | Customer | Leave one, or replace the one already there. |
| DELETE | `/api/v1/account/product-instructions/:instructionId` | Customer | Customer | Take it back. |

### `account/profile`

Defined in `backend/src/http/routes/account.customer.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/account/profile` | Customer | Customer | The signed-in customer profile and spend summary |
| PATCH | `/api/v1/account/profile` | Customer | Customer | Update the customer's own profile details, such as name, organisation, job title and phone. Writes an audit entry recorded as the customer's own change. |

### `account/wishlist`

Defined in `backend/src/http/routes/account.customer.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/account/wishlist` | Customer | Customer | Lines saved without buying them |
| POST | `/api/v1/account/wishlist` | Customer | Customer | Save a line for later |
| DELETE | `/api/v1/account/wishlist/:itemId` | Customer | Customer | Remove a saved line |

### `assistant`

Defined in `backend/src/http/routes/assistant.public.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/assistant/conversations` | Customer | Customer | The customer's own history: list, read, rename, delete. |
| GET | `/api/v1/assistant/conversations/:id` | Customer | Customer | One conversation in full |
| PATCH | `/api/v1/assistant/conversations/:id` | Customer | Customer | Rename a conversation |
| DELETE | `/api/v1/assistant/conversations/:id` | Customer | Customer | Delete a thread from the customer's own history. |

### `auth`

Defined in `backend/src/http/routes/auth.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/auth/logout` | Signed in | Authenticated(kind) | Sign out of this session only and clear its cookies. |
| POST | `/api/v1/auth/logout-all` | Signed in | Authenticated(kind) | Sign the person out on every device at once. Replies with how many sessions were ended. |
| GET | `/api/v1/auth/me` | Signed in | Authenticated(kind) | Current customer |
| GET | `/api/v1/auth/language` | Signed in | Authenticated(kind) | The interface language for this account. |
| PUT | `/api/v1/auth/language` | Signed in | Authenticated(kind) | Save the interface language the signed-in person wants to read. |
| POST | `/api/v1/auth/password/change` | Signed in | Authenticated(kind) | Change the signed-in person's password, given their current one. Signs the account out of every session, including this one, and writes an audit entry. |

### `cart`

Defined in `backend/src/http/routes/cart.customer.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/cart` | Customer | Customer | Current cart, repriced |
| POST | `/api/v1/cart/items` | Customer | Customer | Add an item |
| POST | `/api/v1/cart/items/bulk` | Customer | Customer | Add several options in one request |
| PATCH | `/api/v1/cart/items/:itemId` | Customer | Customer | Change quantity (0 removes the line) |
| PATCH | `/api/v1/cart/items/:itemId/packs` | Customer | Customer | Change how many packs of a line the customer wants. |
| PATCH | `/api/v1/cart/items/:itemId/note` | Customer | Customer | Change or clear the special instruction on a line. |
| DELETE | `/api/v1/cart/items/:itemId` | Customer | Customer | Remove one line from the cart. Replies with the repriced cart. |
| DELETE | `/api/v1/cart` | Customer | Customer | Empty the cart. |
| POST | `/api/v1/cart/coupon` | Customer | Customer | Apply a coupon. |
| DELETE | `/api/v1/cart/coupon` | Customer | Customer | Take the applied coupon off the cart. Replies with the repriced cart. |
| POST | `/api/v1/cart/checkout` | Customer | Customer | Submit the checkout |

### `catalog`

Defined in `backend/src/http/routes/catalog.public.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/catalog/image-search` | Customer | Customer | Find products from a photograph (multipart) |

### `documents`

Defined in `backend/src/http/routes/documents.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/documents/orders/:orderId` | Customer | Customer | The buyer's view of an order's seller documents. |
| POST | `/api/v1/documents/buyer/:kind/:id/link` | Customer | Customer | Get a short-lived, single-use download link for one of the buyer's own invoices or credit notes. A packing list is never offered to a buyer. |
| GET | `/api/v1/documents/batch/:id/download` | Customer | Customer | Download several of a seller's own issued documents as one ZIP file, using a link from the seller's batch-link request. Works once, only for the person the link was made for, and records each document download in the audit log. |
| GET | `/api/v1/documents/:kind/:id/download` | Customer | Customer | Download one invoice or packing list as a PDF, for the seller who issued it or the buyer it was issued to. The link works once, only for the person it was made for, and the download is recorded in the audit log. |

### `fulfilment`

Defined in `backend/src/http/routes/fulfilment.customer.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/fulfilment/warehouse-options` | Customer | Customer | Which warehouses can fulfil this basket, and on what terms |
| POST | `/api/v1/fulfilment/warehouse-options/:quoteId/revalidate` | Customer | Customer | Is the option I chose still an offer? |

### `orders`

Defined in `backend/src/http/routes/orders.ts`, `backend/src/http/routes/logistics-levels.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/orders` | Customer | Customer | The signed-in customer orders |
| GET | `/api/v1/orders/:id/invoice` | Customer | Customer | The customer’s own invoice |
| GET | `/api/v1/orders/:id` | Customer | Customer | Order detail with timeline |
| POST | `/api/v1/orders/:id/cancel` | Customer | Customer | Cancel an order the policy still allows to be cancelled. |
| GET | `/api/v1/orders/:id/price-breakdown` | Customer | Customer | What the signed-in customer paid on one of their own orders, including delivery level by level and where each level has got to. Another customer's order is not found. |

### `payments`

Defined in `backend/src/http/routes/payments.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/payments/gateways` | Customer | Customer | Gateways the storefront may offer, and which to preselect |
| GET | `/api/v1/payments/instruments` | Customer | Customer | How a customer may pay for a cart in this currency |
| POST | `/api/v1/payments/orders/:orderId/session` | Customer | Customer | Start a payment for an order |
| GET | `/api/v1/payments/orders/:orderId/status` | Customer | Customer | Poll payment status after returning from the provider |
| POST | `/api/v1/payments/orders/:orderId/mock-capture` | Customer | Customer | Settle an order without a gateway (testing only) |
| POST | `/api/v1/payments/orders/:orderId/reconcile` | Customer | Customer | Ask the provider directly. |

### `preorders`

Defined in `backend/src/http/routes/preorders.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/preorders/preview` | Customer | Customer | Work out what a preorder would look like - price, delivery window and quantity - before the buyer sends it. Nothing is saved. |
| POST | `/api/v1/preorders` | Customer | Customer | Send a bulk preorder request to the seller for a product, quantity and delivery date. The buyer must accept the preorder terms; the seller is notified and the request expires if nobody answers in time. |
| GET | `/api/v1/preorders` | Customer | Customer | List the buyer's own preorders, newest first, with who supplies each one. |
| GET | `/api/v1/preorders/:id` | Customer | Customer | Show one of the buyer's own preorders in full, including its history. Another buyer's preorder answers "not found". |
| POST | `/api/v1/preorders/:id/confirm` | Customer | Customer | Agree to the seller's current terms. Creates the order, awaiting payment. The body names the revision and its hash, so only terms the buyer was shown can be confirmed. |
| POST | `/api/v1/preorders/:id/decline` | Customer | Customer | The buyer turns down the seller's proposed terms, with an optional note, and sends the preorder back to the seller to look at again. The seller is alerted. |
| POST | `/api/v1/preorders/:id/cancel` | Customer | Customer | The buyer withdraws their preorder, giving a reason. If an order has already been created and is waiting for payment, that order is cancelled too; otherwise the request is simply closed and any reserved production capacity is released. |

### `pricing`

Defined in `backend/src/http/routes/logistics-levels.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/pricing/logistics/quote` | Customer | Customer | L1-L4 for the basket, to one of the customer's addresses. The same pricing run as the cart - there is one answer to what delivery costs. |

### `recurring-schedules`

Defined in `backend/src/http/routes/schedules.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/recurring-schedules/delivery-window` | Customer | Customer | The earliest day a first delivery may be booked |
| GET | `/api/v1/recurring-schedules` | Customer | Customer | The signed-in customer schedules |
| GET | `/api/v1/recurring-schedules/:id` | Customer | Customer | Show one of the customer's own scheduled orders: its products with their quantity rules, the addresses, and its 20 most recent deliveries with the order each one became. A plan the customer removed, or someone else's, answers "not found". |
| POST | `/api/v1/recurring-schedules` | Customer | Customer | Create a repeat-purchase schedule |
| PATCH | `/api/v1/recurring-schedules/:id` | Customer | Customer | Change future runs of a schedule |
| GET | `/api/v1/recurring-schedules/:id/estimate` | Customer | Customer | What a schedule would cost if it ran now |
| POST | `/api/v1/recurring-schedules/:id/hide` | Customer | Customer | Take a finished schedule off my list |
| POST | `/api/v1/recurring-schedules/:id/pause` | Customer | Customer | Pause future runs |
| POST | `/api/v1/recurring-schedules/:id/resume` | Customer | Customer | Restart one of the customer's own paused scheduled orders. The next delivery date is worked out afresh from today, so missed deliveries are not caught up. Refused if the card it pays with automatically can no longer be charged, or a one-off delivery date has already passed; writes an audit entry. |
| DELETE | `/api/v1/recurring-schedules/:id` | Customer | Customer | Cancel future runs |
| POST | `/api/v1/recurring-schedules/preview` | Customer | Customer | The review screen. |
| POST | `/api/v1/recurring-schedules/from-cart` | Customer | Customer | Create a DRAFT from the cart. |
| POST | `/api/v1/recurring-schedules/:id/activate` | Customer | Customer | Activate a draft. |
| GET | `/api/v1/recurring-schedules/:id/occurrences` | Customer | Customer | The deliveries on a plan - past, pending and upcoming. |
| POST | `/api/v1/recurring-schedules/:id/skip-next` | Customer | Customer | Skip the next delivery. |
| POST | `/api/v1/recurring-schedules/occurrences/:occurrenceId/skip` | Customer | Customer | Skip one named delivery. |
| DELETE | `/api/v1/recurring-schedules/occurrences/:occurrenceId` | Customer | Customer | Cancel one delivery outright, rather than skipping it. |

## Public and storefront

### `account/config`

Defined in `backend/src/http/routes/account.customer.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/account/config` | Public |  | Tell the storefront whether shoppers may create their own accounts, so it knows whether to show the sign-up option. Needs no sign-in. |

### `assistant`

Defined in `backend/src/http/routes/assistant.public.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/assistant/start` | Public (customer optional) | optionalCustomer | Open a conversation. |
| POST | `/api/v1/assistant/chat` | Public (customer optional) | optionalCustomer | Ask the shopping assistant a question in an existing conversation and receive its answer as it is written, word by word. A guest is asked to sign in after a set number of free questions, a conversation is refused once it reaches its length limit, and the whole feature answers "not found" when no AI provider is set up. |

### `auth`

Defined in `backend/src/http/routes/auth.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/auth/login` | Public (customer sign-in) |  | Sign in to the Customer Website |
| POST | `/api/v1/auth/refresh` | Public (customer sign-in) |  | Rotate the session |
| POST | `/api/v1/auth/password/forgot` | Public (customer sign-in) |  | Ask for a password-reset link. If an active account exists for the email address, a reset link is emailed to it; the reply is the same either way, so nobody can use it to find out who has an account. |
| POST | `/api/v1/auth/password/reset` | Public (customer sign-in) |  | Set a new password using the link from a "forgot password" email. Signs the account out everywhere and writes an audit entry; refused if the link has expired or was already used. |
| POST | `/api/v1/auth/invitations/accept` | Public (customer sign-in) |  | Activate an invited account |
| POST | `/api/v1/auth/register` | Public (customer sign-in) |  | Open an account from the storefront |
| POST | `/api/v1/auth/verify-email` | Public (customer sign-in) |  | Confirm a self-registered email address |
| POST | `/api/v1/auth/verify-email/resend` | Public (customer sign-in) |  | Send the confirmation link again |

### `catalog`

Defined in `backend/src/http/routes/catalog.public.ts`, `backend/src/http/routes/bulk-pricing.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/catalog/variant-axes` | Public |  | The variant axis definitions, for the whole catalogue. |
| GET | `/api/v1/catalog/categories` | Public |  | Category tree |
| GET | `/api/v1/catalog/categories/:slug` | Public |  | Look up one category by its web address name and return its name and description. Hidden or archived categories answer "not found". |
| GET | `/api/v1/catalog/products` | Public |  | List published products |
| GET | `/api/v1/catalog/filters` | Public |  | What is worth offering as a filter, for the listing these same parameters describe. |
| GET | `/api/v1/catalog/products/:slug` | Public |  | Product detail |
| GET | `/api/v1/catalog/product-cards` | Public |  | Resolve product references into verified cards |
| GET | `/api/v1/catalog/bulk-pricing` | Public (customer optional) | optionalCustomer | Show what one piece of a product costs at a given quantity, for each way of buying it, so the shopper can see the price drop as the quantity goes up. Anyone can ask; a signed-in business buyer also sees prices kept for business accounts and for their delivery country. |

### `config`

Defined in `backend/src/http/routes/config.public.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/config` | Public |  | The storefront's public settings - business name, contact details, logo, currency and similar - needed before anyone signs in. On a seller's own shop the seller's name, contact details and logo replace the marketplace's. |

### `delivery`

Defined in `backend/src/http/routes/delivery.public.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/delivery/options` | Public |  | Which warehouses can deliver this basket to a country |

### `documents`

Defined in `backend/src/http/routes/documents.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/documents/verify` | Public |  | Is this a document this deployment issued? Public; says only what is printed on it. |

### `erp-inbound`

Defined in `backend/src/http/routes/customer-erp-webhooks.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/erp-inbound/:slug` | Public |  | Receive a delivery from a buyer’s ERP |

### `exports`

Defined in `backend/src/http/routes/reports.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/exports/download/:token` | Public |  | Download an export |

### `my-data`

Defined in `backend/src/http/routes/account.customer.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/my-data/download/:token` | Public |  | Download a personal data bundle |

### `partner-invitations`

Defined in `backend/src/http/routes/partner-invitations.public.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/partner-invitations/describe` | Public |  | What is this, and who is asking? |
| POST | `/api/v1/partner-invitations/accept` | Public |  | Yes. |

### `payments`

Defined in `backend/src/http/routes/payments.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/payments/links/:token` | Public |  | Open a payment link |
| POST | `/api/v1/payments/links/:token/pay` | Public |  | Start paying an order through an emailed payment link: the link is used up and a payment is opened with the payment provider, returning what the checkout screen needs. Needs no sign-in; refused if the link has expired, was withdrawn, or has already been used. |

### `preorders`

Defined in `backend/src/http/routes/preorders.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/preorders/eligibility` | Public (customer optional) | optionalCustomer | Can this product be preordered, and on what terms? |

### `sitemap.xml`

Defined in `backend/src/http/routes/sitemap.public.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/sitemap.xml` | Public |  | Public and unauthenticated, which is what a sitemap has to be. |


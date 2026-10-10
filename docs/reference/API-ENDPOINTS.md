# API reference: every endpoint

> **Generated file - do not edit by hand.** It is rebuilt from
> the route files in `backend/src/http/routes/` and `backend/src/http/app.ts` by `scripts/build-reference-docs.mjs`.
> After changing that code, run `cd scripts; npm run docs` and commit the result.
> `npm run docs:check` fails when this file has fallen behind the code.

This is the complete list. For **how** to call the API - signing in, cookies, money, errors, webhooks, worked examples - read [`../API.md`](../API.md) first.

**1698 endpoints** in 150 route groups. Every path starts from the backend's own address, for example `http://localhost:4000`.

## How to read this file

- **Who** is who may call it:
  - **Public** - nobody needs to be signed in.
  - **Customer** - a signed-in storefront customer. **Signed in** - any signed-in user of the named kind.
  - **Seller** - a customer who is also a marketplace seller, with the seller permission shown.
  - **Staff** - a member of the operator's staff, signed in to the admin panel, with the permission shown.
  - **Logistics** - a person from a logistics partner company, signed in to the partner portal.
  - **Audit** - an auditor, inspector or compliance reviewer, signed in to the Audit Console with a one-time code, with the permission shown.
  - **Webhook (signature)** - called by another system (a payment gateway, a carrier, an ERP). It proves who it is with a signature, not a sign-in.
- **Guard** is the exact check in the code, and the permission it asks for. `TradingSeller` means the seller must be approved and trading, not just applied.
- `:id` in a path is a placeholder: put the real value there.
- **What it does** comes from the comment above the route in the code, or from the OpenAPI summary. Text in *italics* had neither, so it is read from the method and the path - a rough guide, not a promise. [`../API.md`](../API.md) explains the important ones properly.
- A path shown without a trailing slash, such as `/api/v1/cart`, also answers with one (`/api/v1/cart/`).

## Zones

| Zone | Endpoints |
|---|---|
| [Admin panel (staff)](#admin-panel-staff) | 655 |
| [Logistics partner portal](#logistics-partner-portal) | 100 |
| [Audit Console](#audit-console) | 172 |
| [Seller Hub](#seller-hub) | 386 |
| [Webhooks, integrations and health](#webhooks-integrations-and-health) | 11 |
| [Customer account](#customer-account) | 316 |
| [Public and storefront](#public-and-storefront) | 58 |

## Admin panel (staff)

### `admin/account-messages`

Defined in `backend/src/http/routes/governance.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/admin/account-messages` | Staff | Admin(CUSTOMER_WRITE) | Send a customer or a seller a message: an in-app notice and an email. Audited. |

### `admin/analytics`

Defined in `backend/src/http/routes/analytics.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/analytics/summary` | Staff | Admin(REPORT_READ) | Event totals and the most viewed screens for a range of UTC days. |
| GET | `/api/v1/admin/analytics/reconciliation` | Staff | Admin(REPORT_READ) | Client-reported events against the source transactions (orders, RFQs, returns, disputes). |

### `admin/assistant`

Defined in `backend/src/http/routes/assistant.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/assistant/status` | Staff | Admin(SETTINGS_READ) | Whether the AI provider is configured: DISABLED, MISSING_CREDENTIALS or CONFIGURED, with the provider and model. `?probe=true` also makes one real call and reports whether it answered. Never returns a key. |
| GET | `/api/v1/admin/assistant/conversations` | Staff | Admin(ASSISTANT_CHAT_READ) | List chat enquiries made through the shopping assistant, a page at a time. Can be searched by name, email or phone, or narrowed to conversations linked to a customer account. |
| GET | `/api/v1/admin/assistant/conversations/:id` | Staff | Admin(ASSISTANT_CHAT_READ) | One chat conversation with the shopping assistant: the visitor's self-declared contact details and the full transcript. Read-only. |

### `admin/attention`

Defined in `backend/src/http/routes/notifications.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/attention` | Staff | Admin | What is still waiting, counted per queue. |

### `admin/audit-console`

Defined in `backend/src/http/routes/audit-console.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/audit-console/people` | Staff | Admin(AUDIT_CONSOLE_MANAGE) | Everybody with Audit Console access: the audit team and every agency's people, with how they sign in. |
| POST | `/api/v1/admin/audit-console/invitations` | Staff | Admin(AUDIT_CONSOLE_MANAGE) | Invite somebody to the Audit Console: an audit supervisor or compliance reviewer, or a member of an agency. |
| PATCH | `/api/v1/admin/audit-console/staff/:id` | Staff | Admin(AUDIT_CONSOLE_MANAGE) | Change an audit team member's role or competence, or remove their access (ends their sessions at once). |
| POST | `/api/v1/admin/audit-console/people/:id/resend-invitation` | Staff | Admin(AUDIT_CONSOLE_MANAGE) | Send a fresh activation link to somebody who has not activated their console account. |
| GET | `/api/v1/admin/audit-console/rules` | Staff | Admin(INSPECTION_READ) | The requirement matrix, for oversight. |
| POST | `/api/v1/admin/audit-console/rules/:id/decision` | Staff | Admin(AUDIT_CONSOLE_MANAGE) | Approve or reject a submitted compliance rule from the Admin Panel. Never one you drafted. |
| GET | `/api/v1/admin/audit-console/documents/:id/file` | Staff | Admin(CUSTOMER_READ) | A seller's compliance document file, for the Admin Panel's own review screens. Audited. |

### `admin/audit-logs`

Defined in `backend/src/http/routes/reports.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/audit-logs` | Staff | Admin(AUDIT_READ) | Search the audit trail, newest first, a page at a time: who did what, in which role, to which record, why (where the entry says), when, and from which address and device. Filter by action, record, person or date range. Secrets were already blanked out when each entry was written. |
| POST | `/api/v1/admin/audit-logs/export` | Staff | Admin(AUDIT_READ, EXPORT_CREATE) | Download the audit entries matching a filter as a CSV file, newest first, at most 10,000 of them. Needs audit.read and export.create, and writes an audit entry of its own before the file is produced. |

### `admin/auth`

Defined in `backend/src/http/routes/auth.ts`, `backend/src/http/routes/agreements.ts`.

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
| GET | `/api/v1/admin/auth/agreements` | Staff | AdminBeforeAgreements | Whether this member of staff has accepted the staff terms and acknowledged the Privacy Policy in force. |
| POST | `/api/v1/admin/auth/agreements/terms` | Staff | AdminBeforeAgreements | "I agree" in the staff terms dialog. |
| POST | `/api/v1/admin/auth/agreements/privacy` | Staff | AdminBeforeAgreements | "I acknowledge" in the Privacy Policy dialog. |
| DELETE | `/api/v1/admin/auth/agreements/terms` | Staff | AdminBeforeAgreements | Untick the staff terms box before Continue. |
| DELETE | `/api/v1/admin/auth/agreements/privacy` | Staff | AdminBeforeAgreements | Untick the Privacy Policy box before Continue. |
| GET | `/api/v1/admin/auth/agreements/history` | Staff | AdminBeforeAgreements | Every acceptance and acknowledgment this member of staff has given, newest first. |

### `admin/brand-requests`

Defined in `backend/src/http/routes/sellers.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/brand-requests` | Staff | Admin(PRODUCT_READ) | Sellers' requests for new brands still awaiting a decision, oldest first, with how many listings are waiting on each. |
| POST | `/api/v1/admin/brand-requests/:id/decision` | Staff | Admin(PRODUCT_PUBLISH) | Approve, refuse or ask for more information about a seller's request to add a brand, optionally approving it under a corrected spelling. Refused if already decided. Notifies the seller and writes an audit entry. |

### `admin/buyer-companies`

Defined in `backend/src/http/routes/buyer-companies.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/buyer-companies` | Staff | Admin(BUYER_COMPANY_READ) | The review queue: filter by status, country, reviewer and risk; search by name, reference, number or email. |
| GET | `/api/v1/admin/buyer-companies/reviewers` | Staff | Admin(BUYER_COMPANY_READ) | Staff who may be assigned a company review. |
| GET | `/api/v1/admin/buyer-companies/:id` | Staff | Admin(BUYER_COMPANY_READ) | One application with everything a reviewer needs: details, checks, duplicates, documents, notes and history. |
| GET | `/api/v1/admin/buyer-companies/:id/access-review` | Staff | Admin(BUYER_COMPANY_READ) | Who can act for this company, read-only: roles, joining dates, who invited whom, last sign-in and activity, open invitations and recent access reviews. |
| POST | `/api/v1/admin/buyer-companies/:id/start-review` | Staff | Admin(BUYER_COMPANY_REVIEW) | Open a submitted application for review and take it if nobody has. |
| POST | `/api/v1/admin/buyer-companies/:id/assign` | Staff | Admin(BUYER_COMPANY_REVIEW) | Give the review to a colleague who may review, or unassign it. |
| POST | `/api/v1/admin/buyer-companies/:id/notes` | Staff | Admin(BUYER_COMPANY_REVIEW) | Add an internal note. Never shown to the applicant. |
| POST | `/api/v1/admin/buyer-companies/:id/request-information` | Staff | Admin(BUYER_COMPANY_REVIEW) | Send the application back to the applicant with a question, optionally asking for named documents. |
| POST | `/api/v1/admin/buyer-companies/:id/approve` | Staff | Admin(BUYER_COMPANY_REVIEW) | Approve the company, or restore a suspended or re-verified one. Restoring a suspended company also needs `buyer_company.suspend`. |
| POST | `/api/v1/admin/buyer-companies/:id/reject` | Staff | Admin(BUYER_COMPANY_REVIEW) | Refuse the application with a reason code and a reason the applicant reads. |
| POST | `/api/v1/admin/buyer-companies/:id/suspend` | Staff | Admin(BUYER_COMPANY_SUSPEND) | Stop an approved company buying, immediately. |
| POST | `/api/v1/admin/buyer-companies/:id/reverify` | Staff | Admin(BUYER_COMPANY_REVIEW) | Ask an approved company to confirm its details again. Purchasing stops until it is approved again. |
| POST | `/api/v1/admin/buyer-companies/:id/checks` | Staff | Admin(BUYER_COMPANY_REVIEW) | Ask every registry again now. The earlier results are kept. |

### `admin/buyer-company-documents`

Defined in `backend/src/http/routes/buyer-companies.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/admin/buyer-company-documents/:id/link` | Staff | Admin(BUYER_COMPANY_READ) | A single-use download link for one company document, valid for a few minutes. |
| GET | `/api/v1/admin/buyer-company-documents/:id/download` | Staff | Admin(BUYER_COMPANY_READ) | Download a company document with a link from the route above. Served as an attachment; audited. |
| POST | `/api/v1/admin/buyer-company-documents/:id/decision` | Staff | Admin(BUYER_COMPANY_REVIEW) | Accept or refuse one document. A refusal needs a reason the applicant reads. |

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

### `admin/commercial`

Defined in `backend/src/http/routes/commercial-policy.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/commercial/reference` | Staff | Admin(FINANCE_POLICY_READ) | The source tables imported from Doc 07 / Doc 08, and the catalogue reconciliation. |
| GET | `/api/v1/admin/commercial/schedules` | Staff | Admin(FINANCE_POLICY_READ) | Every versioned commercial schedule, newest first per kind. |
| GET | `/api/v1/admin/commercial/schedules/:id` | Staff | Admin(FINANCE_POLICY_READ) | One schedule with its history and what still stops its activation. |
| GET | `/api/v1/admin/commercial/schedules/:id/preview` | Staff | Admin(FINANCE_POLICY_READ) | The financial effect of a schedule on sample figures, before approval. |
| POST | `/api/v1/admin/commercial/schedules` | Staff | Admin(FINANCE_POLICY_WRITE) | Draft a new version of a schedule kind, copied from the latest. |
| PATCH | `/api/v1/admin/commercial/schedules/:id` | Staff | Admin(FINANCE_POLICY_WRITE) | Edit a DRAFT schedule's scope, body, dates and signed-schedule reference. |
| POST | `/api/v1/admin/commercial/schedules/:id/submit` | Staff | Admin(FINANCE_POLICY_WRITE) | Submit a draft for approval. |
| POST | `/api/v1/admin/commercial/schedules/:id/decision` | Staff | Admin(FINANCE_POLICY_WRITE) | Approve or return a submitted schedule, with the adoption evidence. Not by its preparer. |
| POST | `/api/v1/admin/commercial/schedules/:id/provider-confirmation` | Staff | Admin(FINANCE_POLICY_WRITE) | Record the payment provider's written confirmation. |
| POST | `/api/v1/admin/commercial/schedules/:id/activate` | Staff | Admin(FINANCE_POLICY_WRITE) | Activate an approved schedule. A person's act; refused with each missing item. |
| POST | `/api/v1/admin/commercial/schedules/:id/retire` | Staff | Admin(FINANCE_POLICY_WRITE) | Retire a schedule. |
| GET | `/api/v1/admin/commercial/import-routes` | Staff | Admin(SETTINGS_READ) | Import routes: importer and local actors per destination, category and channel. |
| PUT | `/api/v1/admin/commercial/import-routes` | Staff | Admin(SETTINGS_WRITE) | Draft or replace an import route (returns it to DRAFT for review). |
| POST | `/api/v1/admin/commercial/import-routes/:id/decision` | Staff | Admin(SETTINGS_WRITE) | Approve or reject an import route. Not by its preparer. |
| GET | `/api/v1/admin/commercial/provider-reviews` | Staff | Admin(LOGISTICS_READ) | Logistics provider screening records. |
| PUT | `/api/v1/admin/commercial/provider-reviews` | Staff | Admin(LOGISTICS_WRITE) | Record or update a provider review. |
| POST | `/api/v1/admin/commercial/provider-reviews/:id/decision` | Staff | Admin(LOGISTICS_WRITE) | Approve or reject a provider review. Not by its recorder. |
| GET | `/api/v1/admin/commercial/handling-requirements` | Staff | Admin(LOGISTICS_READ) | Dangerous goods, battery, timber packaging and temperature requirements. |
| PUT | `/api/v1/admin/commercial/handling-requirements` | Staff | Admin(LOGISTICS_WRITE) | Create or update a handling requirement. |
| GET | `/api/v1/admin/commercial/commission-adjustments` | Staff | Admin(COMMISSION_INVOICE_VIEW) | Commission reversals proposed by refunds. |
| POST | `/api/v1/admin/commercial/commission-adjustments/:id/apply` | Staff | Admin(COMMISSION_CREDIT_NOTE_CREATE) | Apply a proposed reversal against an issued credit note. |
| GET | `/api/v1/admin/commercial/certification-programmes` | Staff | Admin(FINANCE_POLICY_READ) | Certification-recovery programmes. |
| GET | `/api/v1/admin/commercial/certification-programmes/:id` | Staff | Admin(FINANCE_POLICY_READ) | One programme's ledger: costs, allocations and the unrecovered balance. |
| POST | `/api/v1/admin/commercial/certification-programmes` | Staff | Admin(FINANCE_POLICY_WRITE) | Create a programme (Gloviaa funds first). |
| POST | `/api/v1/admin/commercial/certification-programmes/:id/costs` | Staff | Admin(FINANCE_POLICY_WRITE) | Record a third-party cost, credit or seller deduction. |
| POST | `/api/v1/admin/commercial/certification-costs/:id/verify` | Staff | Admin(FINANCE_TAX_VERIFY) | Verify a cost as eligible (not by its recorder). |
| POST | `/api/v1/admin/commercial/certification-programmes/:id/status` | Staff | Admin(FINANCE_POLICY_WRITE) | Activate, pause or close a programme (activation needs the adopted schedule). |
| GET | `/api/v1/admin/commercial/security` | Staff | Admin(FINANCE_POLICY_READ) | Security schedules and their reviews. |
| POST | `/api/v1/admin/commercial/security` | Staff | Admin(FINANCE_POLICY_WRITE) | Propose a seller's security (no stacking without a documented exposure). |
| POST | `/api/v1/admin/commercial/security/:id/activate` | Staff | Admin(FINANCE_POLICY_WRITE) | Activate a proposed security with the provider's permission (not by its proposer). |
| POST | `/api/v1/admin/commercial/security-reviews/:id` | Staff | Admin(FINANCE_POLICY_WRITE) | Complete a monthly or quarterly security review. |
| GET | `/api/v1/admin/commercial/insurance` | Staff | Admin(FINANCE_POLICY_READ) | The insurance register, with the proposed groups and each policy's gaps. |
| PUT | `/api/v1/admin/commercial/insurance` | Staff | Admin(FINANCE_POLICY_WRITE) | Record or update an insurance policy (returns it to PENDING verification). |
| POST | `/api/v1/admin/commercial/insurance/:id/verify` | Staff | Admin(FINANCE_TAX_VERIFY) | Verify an insurance policy with the insurer (not by its recorder). |
| GET | `/api/v1/admin/commercial/launch` | Staff | Admin(SETTINGS_READ) | Country launch overview. |
| GET | `/api/v1/admin/commercial/launch/:countryCode` | Staff | Admin(SETTINGS_READ) | One country's launch decisions and blockers. |
| PUT | `/api/v1/admin/commercial/launch/:countryCode/:key` | Staff | Admin(SETTINGS_WRITE) | Update a launch decision's owner, scope, evidence and expiry. |
| POST | `/api/v1/admin/commercial/launch/:countryCode/:key/review` | Staff | Admin(FEATURE_FLAG_WRITE) | Approve or reject a launch decision (not by its owner). |
| POST | `/api/v1/admin/commercial/launch/:countryCode/enable` | Staff | Admin(FEATURE_FLAG_WRITE) | Enable a country (refused while any decision is open). |
| POST | `/api/v1/admin/commercial/launch/:countryCode/disable` | Staff | Admin(FEATURE_FLAG_WRITE) | Disable a country. |
| GET | `/api/v1/admin/commercial/product-evidence` | Staff | Admin(INSPECTION_READ) | Product evidence, read only (the Audit Console verifies it). |
| GET | `/api/v1/admin/commercial/safety-cases` | Staff | Admin(INSPECTION_READ) | Safety cases, read only (the Audit Console decides them). |
| GET | `/api/v1/admin/commercial/safety-cases/:id` | Staff | Admin(INSPECTION_READ) | One safety case, read only. |

### `admin/commission-invoices`

Defined in `backend/src/http/routes/commission-invoices.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/commission-invoices` | Staff | Admin(COMMISSION_INVOICE_VIEW) | List commission invoices, filtered and paginated on the server. |
| GET | `/api/v1/admin/commission-invoices/candidates` | Staff | Admin(COMMISSION_INVOICE_VIEW) | List seller orders with a commission and no live commission invoice, each with why it cannot be invoiced yet. |
| GET | `/api/v1/admin/commission-invoices/settings` | Staff | Admin(COMMISSION_INVOICE_VIEW) | Read who commission invoices are issued by and how they are numbered. |
| PUT | `/api/v1/admin/commission-invoices/settings` | Staff | Admin(COMMISSION_INVOICE_SETTINGS_WRITE) | Save the issuing legal entity's details and the numbering; refused on a stale version. |
| GET | `/api/v1/admin/commission-invoices/:id` | Staff | Admin(COMMISSION_INVOICE_VIEW) | Read one commission invoice with its lines, sources, credit notes and history. |
| POST | `/api/v1/admin/commission-invoices/:id/regenerate` | Staff | Admin(COMMISSION_INVOICE_GENERATE) | Rebuild a draft from its sources. |
| GET | `/api/v1/admin/commission-invoices/:id/preview.pdf` | Staff | Admin(COMMISSION_INVOICE_PREVIEW) | Render the draft as a watermarked A6 PDF, with no number, barcode or QR. |
| POST | `/api/v1/admin/commission-invoices/:id/issue` | Staff | Admin(COMMISSION_INVOICE_ISSUE) | Issue a draft: reserve its number, render and store the PDF, freeze it. Issuing an issued invoice returns it. |
| POST | `/api/v1/admin/commission-invoices/:id/discard` | Staff | Admin(COMMISSION_INVOICE_GENERATE) | Discard a draft, which holds no number, so a new one can be started. |
| POST | `/api/v1/admin/commission-invoices/:id/void` | Staff | Admin(COMMISSION_INVOICE_ISSUE) | Void an issued invoice, only where the settings permit it; its number stays used. |
| POST | `/api/v1/admin/commission-invoices/:id/collection` | Staff | Admin(COMMISSION_INVOICE_ISSUE) | Record that the seller paid an issued invoice, with the payment's reference. |
| POST | `/api/v1/admin/commission-invoices/:id/credit-notes` | Staff | Admin(COMMISSION_CREDIT_NOTE_CREATE) | Issue a credit note against an issued commission invoice. Needs an Idempotency-Key. |
| POST | `/api/v1/admin/commission-invoices/documents/:id/link` | Staff | Admin(COMMISSION_INVOICE_DOWNLOAD) | Get a five-minute, single-use download link for an issued invoice or credit note PDF. |
| GET | `/api/v1/admin/commission-invoices/documents/:id/download` | Staff | Admin(COMMISSION_INVOICE_DOWNLOAD) | Download an issued invoice or credit note PDF with a link from the request above; checked against its stored hash. |

### `admin/content-blocks`

Defined in `backend/src/http/routes/content-blocks.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/content-blocks` | Staff | Admin(SETTINGS_READ) | Every banner and category block, drafts included. |
| POST | `/api/v1/admin/content-blocks` | Staff | Admin(SETTINGS_WRITE) | Add a banner or category block with its targeting and schedule. Audited. |
| PUT | `/api/v1/admin/content-blocks/:id` | Staff | Admin(SETTINGS_WRITE) | Replace a banner or category block. Audited. |
| DELETE | `/api/v1/admin/content-blocks/:id` | Staff | Admin(SETTINGS_WRITE) | Delete a banner or category block. Audited. |
| POST | `/api/v1/admin/content-blocks/:id/submit` | Staff | Admin(SETTINGS_WRITE) | Send a draft block for approval by a second member of staff. Audited. |
| POST | `/api/v1/admin/content-blocks/:id/approve` | Staff | Admin(SETTINGS_WRITE) | Approve and publish a block someone else sent for approval; refused while a blocking conflict stands. Audited. |
| POST | `/api/v1/admin/content-blocks/:id/return` | Staff | Admin(SETTINGS_WRITE) | Send a block back to draft: refuse an approval, or take a published block off the storefront. Audited. |
| GET | `/api/v1/admin/content-blocks/:id/versions` | Staff | Admin(SETTINGS_READ) | Every saved version of a block, newest first. |
| POST | `/api/v1/admin/content-blocks/:id/versions/:revision/restore` | Staff | Admin(SETTINGS_WRITE) | Roll a block back to an earlier version, as a new draft that needs approval again. Audited. |
| GET | `/api/v1/admin/content-blocks/preview` | Staff | Admin(SETTINGS_READ) | Preview what the storefront would show for a country, language and moment, optionally with drafts and blocks waiting for approval. |

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

Defined in `backend/src/http/routes/customers.admin.ts`, `backend/src/http/routes/customer-kyc.ts`, `backend/src/http/routes/vat.admin.ts`.

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
| GET | `/api/v1/admin/customers/:id/kyc` | Staff | Admin(CUSTOMER_READ) | One buyer's identity check, importer details and documents. |
| POST | `/api/v1/admin/customers/:id/kyc/decision` | Staff | Admin(BUYER_COMPANY_REVIEW) | Verify or refuse a submitted identity check. Refusing needs a reason the buyer sees; verifying needs an accepted identity document. |
| POST | `/api/v1/admin/customers/:id/kyc/documents/:documentId/decision` | Staff | Admin(BUYER_COMPANY_REVIEW) | Accept or refuse one uploaded document. |
| GET | `/api/v1/admin/customers/:id/kyc/documents/:documentId/file` | Staff | Admin(BUYER_COMPANY_REVIEW) | Open one uploaded document. Every opening is audited. |
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

### `admin/disputes`

Defined in `backend/src/http/routes/commercial-policy.ts`, `backend/src/http/routes/disputes.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/disputes/:id/case-controls` | Staff | Admin(DISPUTE_VIEW) | A dispute's case controls: profile, clocks, requests, remedies, testing, recoveries. |
| POST | `/api/v1/admin/disputes/:id/case-controls/acknowledge` | Staff | Admin(DISPUTE_MANAGE) | Acknowledge a case. |
| POST | `/api/v1/admin/disputes/:id/case-controls/evidence-sufficient` | Staff | Admin(DISPUTE_MANAGE) | Record why the evidence is sufficient; starts the decision clock once. |
| POST | `/api/v1/admin/disputes/:id/case-controls/evidence-requests` | Staff | Admin(DISPUTE_MANAGE) | Request proportionate evidence from a party. |
| PUT | `/api/v1/admin/disputes/:id/case-controls/testing` | Staff | Admin(DISPUTE_MANAGE) | Record independent testing and its interim / final cost allocation. |
| PUT | `/api/v1/admin/disputes/:id/case-controls/decision` | Staff | Admin(DISPUTE_MANAGE) | Record the reasoned decision and remedies (amounts, payers, return freight, completion). |
| POST | `/api/v1/admin/disputes/remedies/:id/complete` | Staff | Admin(DISPUTE_MANAGE) | Mark a remedy completed (with its refund, where one was made). |
| POST | `/api/v1/admin/disputes/:id/case-controls/appeal-reviewer` | Staff | Admin(DISPUTE_APPROVE) | Assign an independent appeal reviewer. |
| GET | `/api/v1/admin/disputes` | Staff | Admin(DISPUTE_VIEW) | The dispute queue: claims and chargebacks, with counts by status and SLA breach flags. |
| GET | `/api/v1/admin/disputes/settings` | Staff | Admin(DISPUTE_VIEW) | The dispute rules: windows, SLAs, reasons offered and the approval threshold. |
| PUT | `/api/v1/admin/disputes/settings` | Staff | Admin(SETTINGS_WRITE) | Save the dispute rules. Versioned: a stale form is refused. |
| GET | `/api/v1/admin/disputes/assignees` | Staff | Admin(DISPUTE_VIEW) | Staff who may be given a dispute. |
| GET | `/api/v1/admin/disputes/:id` | Staff | Admin(DISPUTE_VIEW) | One dispute in full: both sides, evidence, notes, SLA, the money and what you may do. |
| GET | `/api/v1/admin/disputes/:id/decision-preview` | Staff | Admin(DISPUTE_VIEW) | What a decision would do: the amount, whether it needs approval, each seller's settlement. |
| POST | `/api/v1/admin/disputes/:id/messages` | Staff | Admin(DISPUTE_MANAGE) | Write to the buyer, the seller, or both. |
| POST | `/api/v1/admin/disputes/:id/notes` | Staff | Admin(DISPUTE_MANAGE) | An internal note, or an evidence note on a chargeback. Never shown to a party. |
| POST | `/api/v1/admin/disputes/:id/review` | Staff | Admin(DISPUTE_MANAGE) | Take a claim into review before the seller's time to answer is up. |
| POST | `/api/v1/admin/disputes/:id/decision` | Staff | Admin(DISPUTE_MANAGE) | Decide a claim, with a mandatory reason. A refund above the threshold waits for a second approver. |
| POST | `/api/v1/admin/disputes/:id/decision/approve` | Staff | Admin(DISPUTE_APPROVE) | Approve a colleague's refund decision. Never your own. |
| POST | `/api/v1/admin/disputes/:id/decision/refuse` | Staff | Admin(DISPUTE_APPROVE) | Send a colleague's refund decision back, with a reason. Never your own. |
| POST | `/api/v1/admin/disputes/:id/assignment` | Staff | Admin(DISPUTE_VIEW) | Take a dispute, give it to a colleague, or put it back in the queue. |
| POST | `/api/v1/admin/disputes/:id/attachments` | Staff | Admin(DISPUTE_MANAGE) | Attach a file as the marketplace - an inspection report, a carrier's statement. Both parties see it. |
| POST | `/api/v1/admin/disputes/:id/attachments/:attachmentId/link` | Staff | Admin(DISPUTE_VIEW) | A download link for one file on a dispute: five minutes, single use, this session only. |
| GET | `/api/v1/admin/disputes/:id/attachments/:attachmentId/download` | Staff | Admin(DISPUTE_VIEW) | Redeem a download link. Served as a download, never inline. |

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

### `admin/exception-queues`

Defined in `backend/src/http/routes/governance.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/exception-queues` | Staff | Admin | Every admin exception queue the caller may see: SLA hours, owner and escalation role, items waiting, the oldest one's age and how many are past the SLA. |
| PUT | `/api/v1/admin/exception-queues/:key` | Staff | Admin(SETTINGS_WRITE) | Change one exception queue's SLA hours, owner role or escalation role. Audited. |

### `admin/exceptions`

Defined in `backend/src/http/routes/reports.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/exceptions` | Staff | Admin | One queue of failed payments, missing documents, failed inspections, late shipments, settlement mismatches and integration failures (ENH-019). |

### `admin/exports`

Defined in `backend/src/http/routes/reports.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/admin/exports` | Staff | Admin(EXPORT_CREATE) | Request an asynchronous export |
| GET | `/api/v1/admin/exports` | Staff | Admin(EXPORT_CREATE) | The caller's own 50 most recent exports, with the status of each. Other staff members' exports are never shown. |
| GET | `/api/v1/admin/exports/:id` | Staff | Admin(EXPORT_CREATE) | Check on one export the caller requested. Once it is ready, and until the link expires, it includes the download token. |

### `admin/finance`

Defined in `backend/src/http/routes/finance.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/finance/ledger/orders` | Staff | Admin(PAYMENT_READ) | Orders with ledger activity, each with gross, fees, tax, refunds and settlement state. |
| GET | `/api/v1/admin/finance/ledger/orders/:id` | Staff | Admin(PAYMENT_READ) | One order's ledger: its summary, every journal entry, held funds, refunds and chargebacks. |
| GET | `/api/v1/admin/finance/ledger/entries` | Staff | Admin(PAYMENT_READ) | Journal entries, newest first, filtered by order, seller or kind. |
| GET | `/api/v1/admin/finance/refunds-chargebacks` | Staff | Admin(PAYMENT_READ) | Refunds and chargebacks with their accounting status in the ledger. |
| GET | `/api/v1/admin/finance/holds` | Staff | Admin(PAYMENT_READ) | Held funds per seller order, with their release conditions and any pending early release. |
| POST | `/api/v1/admin/finance/holds/:id/suspend` | Staff | Admin(FINANCE_POLICY_WRITE) | Put held funds on hold by hand, with a reason. |
| POST | `/api/v1/admin/finance/holds/:id/resume` | Staff | Admin(FINANCE_POLICY_WRITE) | Lift a hold placed by staff. |
| POST | `/api/v1/admin/finance/holds/:id/release` | Staff | Admin(FINANCE_POLICY_WRITE) | Ask for an early release of held funds; a different member of staff decides it. |
| POST | `/api/v1/admin/finance/release-requests/:id/decide` | Staff | Admin(FINANCE_POLICY_WRITE) | Approve or reject an early release asked for by someone else. |
| POST | `/api/v1/admin/finance/escrow/refresh` | Staff | Admin(FINANCE_POLICY_WRITE) | Post new payments and refunds to the ledger and re-check every hold's release terms now. |
| POST | `/api/v1/admin/finance/payouts/run` | Staff | Admin(FINANCE_POLICY_WRITE) | Send every seller's available balance to their connected payout account. |
| POST | `/api/v1/admin/finance/reconcile` | Staff | Admin(FINANCE_POLICY_WRITE) | Reconcile the ledger with payments, refunds, settlements and the provider's transfers for a period. |
| GET | `/api/v1/admin/finance/reconciliations` | Staff | Admin(PAYMENT_READ) | Past reconciliation runs, newest first. |
| GET | `/api/v1/admin/finance/reconciliations/:id` | Staff | Admin(PAYMENT_READ) | One reconciliation run and the differences it found. |

### `admin/fulfilment-methods`

Defined in `backend/src/http/routes/sellers.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/fulfilment-methods/pending` | Staff | Admin(CUSTOMER_READ) | Sellers' delivery methods waiting for approval, oldest submission first. |
| PATCH | `/api/v1/admin/fulfilment-methods/:methodId` | Staff | Admin(CUSTOMER_STATUS_WRITE) | Approve, refuse or ask for changes to a seller's own delivery method, and decide whether it may ship across borders. Tells the seller and writes an audit entry. |

### `admin/hs-verifications`

Defined in `backend/src/http/routes/trade-compliance.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/hs-verifications` | Staff | Admin(PRODUCT_READ) | Listings whose declared HS code is in one review state (DECLARED by default): the HS verification queue. |
| POST | `/api/v1/admin/hs-verifications/:id/decision` | Staff | Admin(PRODUCT_PUBLISH) | Verify a listing's HS code, optionally correcting it, or reject it with a note. Audited; the seller is told. |

### `admin/inspection`

Defined in `backend/src/http/routes/inspection.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/inspection/reports/:id/pdf` | Staff | Admin(INSPECTION_READ) | Download any signed inspection report as a PDF. |
| GET | `/api/v1/admin/inspection/evidence/:id` | Staff | Admin(INSPECTION_READ) | Download one evidence file on any inspection. Every read is audited. |
| POST | `/api/v1/admin/inspection/requirements/:id/evidence` | Staff | Admin(INSPECTION_RELEASE) | Attach the evidence a conditional release rests on (purpose RELEASE). The release request then names it. |
| GET | `/api/v1/admin/inspection/sublot-releases` | Staff | Admin(INSPECTION_READ) | Sub-lot releases waiting for, or past, a decision. |
| POST | `/api/v1/admin/inspection/sublot-releases/:id/decision` | Staff | Admin(INSPECTION_RELEASE) | Approve or reject a sub-lot release requested in the Audit Console. Never by the person who asked. |
| POST | `/api/v1/admin/inspection/members/:id/move-to-console` | Staff | Admin(AUDIT_CONSOLE_MANAGE) | Move an agency member who signs in with a storefront account onto their own Audit Console account. |
| GET | `/api/v1/admin/inspection/agencies/:id/members` | Staff | Admin(INSPECTION_READ) | Every agency's people, with how they sign in. |
| GET | `/api/v1/admin/inspection/queue` | Staff | Admin(INSPECTION_READ) | Every inspection requirement, filterable by status, with search. |
| GET | `/api/v1/admin/inspection/requirements/:id` | Staff | Admin(INSPECTION_READ) | One inspection requirement in full. |
| POST | `/api/v1/admin/inspection/requirements/:id/reevaluate` | Staff | Admin(INSPECTION_MANAGE) | Recompute whether inspection is required for this order under today's rules. |
| POST | `/api/v1/admin/inspection/jobs` | Staff | Admin(INSPECTION_MANAGE) | Book an inspection: stage, scope method, timing, point, agency and payer. Agency eligibility and conflicts are checked. |
| POST | `/api/v1/admin/inspection/jobs/:id/cancel` | Staff | Admin(INSPECTION_MANAGE) | Cancel a job, with a reason. |
| POST | `/api/v1/admin/inspection/requirements/:id/conditional-release` | Staff | Admin(INSPECTION_RELEASE) | Ask for a conditional release (manual override): named authority, reason, evidence. |
| POST | `/api/v1/admin/inspection/releases/:id/approve` | Staff | Admin(INSPECTION_RELEASE) | Approve a colleague's conditional release. Never your own. |
| POST | `/api/v1/admin/inspection/releases/:id/reject` | Staff | Admin(INSPECTION_RELEASE) | Reject a conditional release, with a reason. |
| GET | `/api/v1/admin/inspection/agencies` | Staff | Admin(INSPECTION_READ) | The inspection agencies. |
| POST | `/api/v1/admin/inspection/agencies` | Staff | Admin(INSPECTION_MANAGE) | Register an independent agency. A name matching a seller is refused. |
| POST | `/api/v1/admin/inspection/agencies/:id/members` | Staff | Admin(INSPECTION_MANAGE) | Invite an agency admin, coordinator, inspector or QA reviewer. They get their own Audit Console account and an activation email. |
| PATCH | `/api/v1/admin/inspection/members/:id` | Staff | Admin(INSPECTION_MANAGE) | Update a member: verify their identity after checking the ID document, change role or competence, or disable them. |
| GET | `/api/v1/admin/inspection/policy` | Staff | Admin(INSPECTION_READ) | The inspection policy: defaults, buyer visibility, override rules. |
| PUT | `/api/v1/admin/inspection/policy` | Staff | Admin(INSPECTION_MANAGE) | Save the inspection policy. |
| GET | `/api/v1/admin/inspection/rules` | Staff | Admin(INSPECTION_READ) | The rules engine: when inspection is mandatory, risk-triggered or optional. |
| POST | `/api/v1/admin/inspection/rules` | Staff | Admin(INSPECTION_MANAGE) | Add a rule (category, value, destination, supplier risk, buyer request). |
| GET | `/api/v1/admin/inspection/plans` | Staff | Admin(INSPECTION_READ) | Inspection plans: the checklist and sampling for a category. |
| POST | `/api/v1/admin/inspection/plans` | Staff | Admin(INSPECTION_MANAGE) | Add a plan. |
| PUT | `/api/v1/admin/inspection/supplier-risk/:id` | Staff | Admin(INSPECTION_MANAGE) | Set a supplier's inspection risk tier, with a reason. |
| POST | `/api/v1/admin/inspection/invoices/:id/decision` | Staff | Admin(INSPECTION_MANAGE) | Approve, pay, dispute or void an agency invoice. The technical result never changes. |

### `admin/integrations`

Defined in `backend/src/http/routes/reports.admin.ts`, `backend/src/http/routes/governance.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/integrations` | Staff | Admin(INTEGRATION_READ) | List the integrations set up with outside systems, each with its latest sync. Credentials are never included. |
| POST | `/api/v1/admin/integrations` | Staff | Admin(INTEGRATION_WRITE) | Set up a connection to an outside system's product feed: its address, how to sign in to it, and which of its fields map to SKU, name, price and stock. It starts switched off. Writes an audit entry. |
| POST | `/api/v1/admin/integrations/:id/test` | Staff | Admin(INTEGRATION_WRITE) | Proves the endpoint answers and reports its field names, for mapping. |
| POST | `/api/v1/admin/integrations/:id/sync` | Staff | Admin(INTEGRATION_WRITE) | Run a sync. |
| PATCH | `/api/v1/admin/integrations/:id/status` | Staff | Admin(INTEGRATION_WRITE) | Switch an integration on or off. Switching on is refused until its last connection test passed. Writes an audit entry. |
| GET | `/api/v1/admin/integrations/sync-runs/:id` | Staff | Admin(INTEGRATION_READ) | The result of one integration sync: whether it was a trial run, how many records it handled and the errors it hit (up to 200). |
| GET | `/api/v1/admin/integrations/health` | Staff | Admin | Health of every integration in one place: payment gateway, carriers, ERP feeds, inspection agencies and each webhook source's last delivery with accepted and rejected counts. |
| POST | `/api/v1/admin/integrations/carrier-webhooks/requeue` | Staff | Admin(LOGISTICS_INTEGRATION_WRITE) | Put dead-lettered carrier webhooks back on the retry queue, for one carrier integration or all. Audited. |

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

### `admin/legal-documents`

Defined in `backend/src/http/routes/legal.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/legal-documents` | Staff | Admin(LEGAL_DOCUMENT_READ) | Every legal document, drafts included, with how many people accepted each. |
| GET | `/api/v1/admin/legal-documents/:id` | Staff | Admin(LEGAL_DOCUMENT_READ) | One legal document, draft or published. |
| POST | `/api/v1/admin/legal-documents` | Staff | Admin(LEGAL_DOCUMENT_WRITE) | Start a new version as a draft. Nobody outside the console sees it. |
| PUT | `/api/v1/admin/legal-documents/:id` | Staff | Admin(LEGAL_DOCUMENT_WRITE) | Change a draft. 409 LEGAL_DOCUMENT_IMMUTABLE for a published document. |
| DELETE | `/api/v1/admin/legal-documents/:id` | Staff | Admin(LEGAL_DOCUMENT_WRITE) | Delete a draft. 409 LEGAL_DOCUMENT_IMMUTABLE for a published document. |
| POST | `/api/v1/admin/legal-documents/:id/publish` | Staff | Admin(LEGAL_DOCUMENT_PUBLISH) | Publish a draft: its words are frozen and new accounts must accept it once it takes effect. |

### `admin/listing-moderation`

Defined in `backend/src/http/routes/listing-moderation.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/listing-moderation/terms` | Staff | Admin(PRODUCT_READ) | Every prohibited listing term, with its reason, severity and whether it is switched on. |
| POST | `/api/v1/admin/listing-moderation/terms` | Staff | Admin(PRODUCT_PUBLISH) | Add a prohibited term. Submitted listings containing it are flagged for the moderator. Audited. |
| PUT | `/api/v1/admin/listing-moderation/terms/:id` | Staff | Admin(PRODUCT_PUBLISH) | Change a prohibited term. Audited. |
| DELETE | `/api/v1/admin/listing-moderation/terms/:id` | Staff | Admin(PRODUCT_PUBLISH) | Remove a prohibited term. Audited. |

### `admin/logistics`

Defined in `backend/src/http/routes/logistics.admin.ts`, `backend/src/http/routes/logistics-levels.admin.ts`, `backend/src/http/routes/market-rules.admin.ts`, `backend/src/http/routes/trade-compliance.admin.ts`.

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
| GET | `/api/v1/admin/logistics/partners/:id/profile` | Staff | Admin(LOGISTICS_READ) | A carrier's profile as the carrier sees it, plus its full compliance document history and any details change waiting for a decision. |
| POST | `/api/v1/admin/logistics/partners/:id/profile-changes/:changeId/decision` | Staff | Admin(LOGISTICS_WRITE) | Approve or reject a carrier's pending details change (legal name, trading name, registration, tax number, registered address, licence). Approval applies it and marks the company verified; a rejection needs a reason the carrier is shown. Writes an audit entry. |
| POST | `/api/v1/admin/logistics/partners/:id/documents/:documentId/decision` | Staff | Admin(LOGISTICS_WRITE) | Accept or refuse one of a carrier's compliance documents. A refusal needs a reason the carrier is shown. Writes an audit entry. |
| POST | `/api/v1/admin/logistics/partners/:id/verification` | Staff | Admin(LOGISTICS_WRITE) | Record whether the carrier's identity has been checked. Anything other than verified needs a note the carrier is shown. Writes an audit entry. |
| POST | `/api/v1/admin/logistics/partners/:id/documents/:documentId/link` | Staff | Admin(LOGISTICS_READ) | A short-lived, single-use link to one of a carrier's compliance documents. Refused for a file that has not passed the malware scan. Writes an audit entry. |
| GET | `/api/v1/admin/logistics/partners/:id/documents/:documentId/download` | Staff | Admin(LOGISTICS_READ) | Download a carrier's compliance document with a link from the route above. Needs the same signed-in member of staff as well as the link, and works once. Served as an attachment, never inline. |
| POST | `/api/v1/admin/logistics/partners/:id/invitations` | Staff | Admin(LOGISTICS_WRITE) | Invite a person to join a carrier's portal team with a given role. Emails them a one-time link to set a password; the link itself is never returned. |
| GET | `/api/v1/admin/logistics/shipments` | Staff | Admin(LOGISTICS_READ) | Every consignment, across every carrier, narrowed the way an operations desk actually thinks about them. |
| GET | `/api/v1/admin/logistics/tracking-filters` | Staff | Admin(LOGISTICS_READ) | What there is to filter the tracking list BY. |
| GET | `/api/v1/admin/logistics/shipments/:id` | Staff | Admin(LOGISTICS_READ) | One consignment, as the operator sees it. |
| GET | `/api/v1/admin/logistics/shipments/:id/documents` | Staff | Admin(LOGISTICS_READ) | The files on one consignment, including those meant for the marketplace only, with each file's audience and malware-scan state. Names and sizes, never the files themselves. |
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
| GET | `/api/v1/admin/logistics/lanes` | Staff | Admin(LOGISTICS_READ) | Every operator rate card (lane) with its weight bands. |
| POST | `/api/v1/admin/logistics/lanes` | Staff | Admin(LOGISTICS_WRITE) | Add a rate card: route, mode, carrier, transit, currency and weight bands. Audited. |
| PUT | `/api/v1/admin/logistics/lanes/:id` | Staff | Admin(LOGISTICS_WRITE) | Replace a rate card and its bands; bumps its version. Audited. |
| POST | `/api/v1/admin/logistics/lanes/quote` | Staff | Admin(LOGISTICS_READ) | Test a rate: every serviceable rate card that carries this weight on this route, cheapest first. |
| GET | `/api/v1/admin/logistics/trade-settings` | Staff | Admin(LOGISTICS_READ) | The cargo insurance rate and the most that may be insured, in basis points. 0 means insurance is not offered. |
| PUT | `/api/v1/admin/logistics/trade-settings` | Staff | Admin(LOGISTICS_WRITE) | Change the cargo insurance rate and cap. Audited. |

### `admin/market-rules`

Defined in `backend/src/http/routes/market-rules.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/market-rules` | Staff | Admin(SETTINGS_READ) | Every country rule, optionally for one destination country. |
| POST | `/api/v1/admin/market-rules` | Staff | Admin(SETTINGS_WRITE) | Add a country rule: block or require documents, optionally above an order value. Audited. |
| PUT | `/api/v1/admin/market-rules/:id` | Staff | Admin(SETTINGS_WRITE) | Replace a country rule. Audited. |
| GET | `/api/v1/admin/market-rules/:id/versions` | Staff | Admin(SETTINGS_READ) | A country rule's history, newest first: every save and the deletion, with who made it and what the rule said. |
| DELETE | `/api/v1/admin/market-rules/:id` | Staff | Admin(SETTINGS_WRITE) | Delete a country rule. Audited. |

### `admin/master-data`

Defined in `backend/src/http/routes/master-data.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/master-data/:kind` | Staff | Admin(SETTINGS_READ) | List one master-data list (UOM, INCOTERM or DEFECT_CODE), switched-off entries included. |
| POST | `/api/v1/admin/master-data/:kind` | Staff | Admin(SETTINGS_WRITE) | Add an entry to a master-data list. Codes are unique per list. Writes an audit entry. |
| PATCH | `/api/v1/admin/master-data/:kind/:id` | Staff | Admin(SETTINGS_WRITE) | Edit or switch off a master-data entry. Writes an audit entry. |

### `admin/master-data-readiness`

Defined in `backend/src/http/routes/master-data.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/master-data-readiness` | Staff | Admin(SETTINGS_READ) | Go-live check: is each required master list present, and is any demonstration seed data left? |

### `admin/message-reports`

Defined in `backend/src/http/routes/messages.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/message-reports` | Staff | Admin(REVIEW_READ) | Reported messages, open first, with the words, who reported them and why. |
| POST | `/api/v1/admin/message-reports/:id/decision` | Staff | Admin(REVIEW_MODERATE) | Decide a report - actioned or dismissed - with a note. Closes its bell alert; audited. |

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
| GET | `/api/v1/admin/operations/dead-jobs` | Staff | Admin(SETTINGS_READ) | Background jobs that exhausted their attempts, newest first. |
| POST | `/api/v1/admin/operations/dead-jobs/:id/retry` | Staff | Admin(SETTINGS_WRITE) | Queue one more attempt of a dead background job. |
| GET | `/api/v1/admin/operations/failed-notifications` | Staff | Admin(SETTINGS_READ) | Emails that could not be delivered, newest first, with the recipient masked. |
| POST | `/api/v1/admin/operations/failed-notifications/:id/retry` | Staff | Admin(SETTINGS_WRITE) | Queue one more delivery attempt of an undeliverable email. |

### `admin/orders`

Defined in `backend/src/http/routes/commercial-policy.ts`, `backend/src/http/routes/settings.admin.ts`, `backend/src/http/routes/returns.ts`, `backend/src/http/routes/payment-receipts.ts`, `backend/src/http/routes/orders.ts`, `backend/src/http/routes/payments.ts`, `backend/src/http/routes/vat.admin.ts`, `backend/src/http/routes/trade-documents.admin.ts`, `backend/src/http/routes/documents.admin.ts`, `backend/src/http/routes/commission-invoices.admin.ts`, `backend/src/http/routes/trade-compliance.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/orders/:id/commercial-controls` | Staff | Admin(ORDER_READ) | An order's frozen line snapshots: seller, manufacturer, scope, term, importer, money, policy versions. |
| POST | `/api/v1/admin/orders/:id/loss-recoveries` | Staff | Admin(REFUND_CREATE) | Record a carrier, insurer, chargeback or seller recovery; overlaps are flagged, never blocked. |
| POST | `/api/v1/admin/orders/:id/payment-plan` | Staff | Admin(ORDER_APPROVE) | Propose the bespoke 30/60/10 plan on a business order (needs the adopted schedule). |
| POST | `/api/v1/admin/orders/:id/payment-plan/agreement` | Staff | Admin(ORDER_APPROVE) | Record seller, buyer or provider agreement to the plan. |
| GET | `/api/v1/admin/orders/:id/shippable` | Staff | Admin(ORDER_FULFIL) | What is left to ship on each line, accounting for partial shipments. |
| POST | `/api/v1/admin/orders/:id/shipments` | Staff | Admin(ORDER_FULFIL) | Record a shipment of some or all of a confirmed order's items, with the carrier and tracking details. The order moves to processing, and to shipped once everything has gone (unless told not to). Writes an audit entry. |
| POST | `/api/v1/admin/orders/:id/returns` | Staff | Admin(ORDER_RETURN) | Record a return for a buyer (a call, an email), with a reason code and quantities. Not bound by the window. |
| GET | `/api/v1/admin/orders/:id/receipts` | Staff | Admin(PAYMENT_READ) | The receipts staff can download for any order: each captured payment and each confirmed refund. |
| GET | `/api/v1/admin/orders/:id/receipts/:kind/:sourceId` | Staff | Admin(PAYMENT_READ) | Download the buyer's receipt for one payment or refund as a PDF, as staff; the same document and number the buyer gets. |
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
| GET | `/api/v1/admin/orders/:id/trade-documents` | Staff | Admin(ORDER_READ) | Every trade document on one order, every seller and every version, with its validation state. |
| GET | `/api/v1/admin/orders/:id/seller-documents` | Staff | Admin(INVOICE_READ) | List the invoices, credit notes and packing lists sellers have issued for one order. Drafts are left out. |
| GET | `/api/v1/admin/orders/:id/commission-invoices` | Staff | Admin(COMMISSION_INVOICE_VIEW) | Show the commission and the commission invoice of every seller order on one buyer order. |
| GET | `/api/v1/admin/orders/:id/compliance` | Staff | Admin(ORDER_READ) | Destination readiness of every seller order on one order: rules that apply, what holds the goods, any override. |

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
| GET | `/api/v1/admin/payments/reconciliation` | Staff | Admin(PAYMENT_READ) | Webhook health. |
| GET | `/api/v1/admin/payments/webhook-health` | Staff | Admin(PAYMENT_READ) | *Read webhook health.* |
| PUT | `/api/v1/admin/payments/connections` | Staff | Admin(PAYMENT_GATEWAY_WRITE) | Save gateway credentials. |
| GET | `/api/v1/admin/payments/connections` | Staff | Admin(PAYMENT_READ) | Configured connections. Masks only - a secret never leaves the server. |
| POST | `/api/v1/admin/payments/connections/:id/test` | Staff | Admin(PAYMENT_GATEWAY_WRITE) | Test one saved connection. |
| PATCH | `/api/v1/admin/payments/connections/:id/status` | Staff | Admin(PAYMENT_GATEWAY_WRITE) | Switch a payment-provider connection on or off. Switching on is refused until the connection has passed a test and has its webhook signing secret, and it switches off any other connection for the same provider or in the other mode (live versus test). Writes an audit entry. |
| POST | `/api/v1/admin/payments/test-connection` | Staff | Admin(PAYMENT_GATEWAY_WRITE) | Prove the credentials work before an administrator activates them. |
| POST | `/api/v1/admin/payments/:paymentId/reconcile` | Staff | Admin(PAYMENT_READ) | Ask the payment provider what really happened to one payment and bring the records into line. If the provider says the money was taken and the amount matches, the payment is recorded and a waiting order is confirmed; an amount mismatch is refused and finance is alerted. |

### `admin/pending-actions`

Defined in `backend/src/http/routes/governance.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/pending-actions` | Staff | Admin | Critical account actions waiting for (or decided by) a second member of staff, newest first; filter by status or record. |
| POST | `/api/v1/admin/pending-actions/:id/approve` | Staff | Admin | Approve a critical account action someone else asked for, which runs it. The person who asked cannot approve. Audited. |
| POST | `/api/v1/admin/pending-actions/:id/reject` | Staff | Admin | Reject a critical account action, or withdraw your own request. Audited. |

### `admin/platform-fee-rules`

Defined in `backend/src/http/routes/platform-fee-rules.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/platform-fee-rules` | Staff | Admin(FINANCE_POLICY_READ) | List the fee rules (value bands, volume tiers, seller tiers, promotions), optionally by status, with how many seller orders each has changed. |
| POST | `/api/v1/admin/platform-fee-rules` | Staff | Admin(FINANCE_POLICY_WRITE) | Create a draft fee rule. It changes nothing until a second member of finance staff approves it. Writes an audit entry. |
| PUT | `/api/v1/admin/platform-fee-rules/:id` | Staff | Admin(FINANCE_POLICY_WRITE) | Change a draft fee rule. Refused once it is submitted, published or retired, or if the change would alter its kind or scope. Writes an audit entry. |
| POST | `/api/v1/admin/platform-fee-rules/:id/submit` | Staff | Admin(FINANCE_POLICY_WRITE) | Submit a draft fee rule for a second person's approval. Writes an audit entry. |
| POST | `/api/v1/admin/platform-fee-rules/:id/approve` | Staff | Admin(FINANCE_POLICY_WRITE) | Approve a submitted fee rule, publishing it and retiring any rule it replaces. Refused for whoever created, edited or submitted it. Writes an audit entry. |
| POST | `/api/v1/admin/platform-fee-rules/:id/reject` | Staff | Admin(FINANCE_POLICY_WRITE) | Send a submitted fee rule back to draft, with a reason. Writes an audit entry. |
| POST | `/api/v1/admin/platform-fee-rules/:id/retire` | Staff | Admin(FINANCE_POLICY_WRITE) | Retire a fee rule so it stops applying to new orders. Writes an audit entry. |
| GET | `/api/v1/admin/platform-fee-rules/:id/orders` | Staff | Admin(FINANCE_POLICY_READ) | The seller orders whose fee one fee rule changed, and by how much. |

### `admin/platform-fees`

Defined in `backend/src/http/routes/logistics-levels.admin.ts`, `backend/src/http/routes/platform-fee-rules.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/platform-fees` | Staff | Admin(FINANCE_POLICY_READ) | List the platform fee policies, every version, optionally only drafts, published or retired ones, with how many seller orders each has settled. |
| POST | `/api/v1/admin/platform-fees` | Staff | Admin(FINANCE_POLICY_WRITE) | Create a new draft platform fee policy: what sellers are charged, for the whole marketplace or one market, category or seller, and the tax on it. Nothing is charged until it is published. Writes an audit entry. |
| PUT | `/api/v1/admin/platform-fees/:id` | Staff | Admin(FINANCE_POLICY_WRITE) | Change a draft platform fee policy. Refused once it is published or retired, or if the change would move it to a different scope. Writes an audit entry. |
| POST | `/api/v1/admin/platform-fees/:id/publish` | Staff | Admin(FINANCE_POLICY_WRITE) | Approve a submitted platform fee policy, making it the live one for its scope and retiring the version it replaces. Refused for whoever created, edited or submitted it (maker-checker). Writes an audit entry, and alerts finance staff when the policy charges tax whose rule nobody has verified. |
| POST | `/api/v1/admin/platform-fees/:id/retire` | Staff | Admin(FINANCE_POLICY_WRITE) | Retire a platform fee policy so it no longer applies to new orders. Retiring one that is already retired changes nothing. Writes an audit entry. |
| POST | `/api/v1/admin/platform-fees/:id/verify-tax` | Staff | Admin(FINANCE_TAX_VERIFY) | Record, with a note, that the tax rule on a platform fee policy is the legally correct one. Changes no figure. Refused on a retired policy. Writes an audit entry. |
| GET | `/api/v1/admin/platform-fees/:id/orders` | Staff | Admin(FINANCE_POLICY_READ) | The seller orders that were settled on one platform fee policy version, newest first, with the fee and fee tax charged on each. |
| POST | `/api/v1/admin/platform-fees/preview` | Staff | Admin(FINANCE_POLICY_READ) | Work out what a seller would be charged and paid on a given sale, using the platform fee policies in force now. Read-only: nothing is saved. |
| POST | `/api/v1/admin/platform-fees/:id/submit` | Staff | Admin(FINANCE_POLICY_WRITE) | Submit a draft platform fee policy for approval by a second member of finance staff. Writes an audit entry. |
| POST | `/api/v1/admin/platform-fees/:id/reject` | Staff | Admin(FINANCE_POLICY_WRITE) | Send a submitted platform fee policy back to draft, with a reason of at least ten characters. Writes an audit entry. |

### `admin/preorder-chats`

Defined in `backend/src/http/routes/preorder-chats.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/preorder-chats/socket` | Public |  | The live connection for the console. Same session cookie, same guards as every admin route; needs `preorder_chat.view`. A refused check upgrades, says why, and closes with 4401 (sign in again) or 4403 (not allowed). |
| GET | `/api/v1/admin/preorder-chats` | Staff | Admin(PREORDER_CHAT_VIEW) | The inbox: filtered, searched and sorted on the server, one page at a time by cursor. Reads conversation rows only - no message history. |
| GET | `/api/v1/admin/preorder-chats/counts` | Staff | Admin(PREORDER_CHAT_VIEW) | How many conversations are behind each inbox tab. |
| GET | `/api/v1/admin/preorder-chats/operations` | Staff | Admin(PREORDER_CHAT_VIEW) | Operational numbers for the inbox header: queue sizes, response and resolution times, reopened conversations. Counts and durations only. |
| GET | `/api/v1/admin/preorder-chats/assignees` | Staff | Admin(PREORDER_CHAT_VIEW, PREORDER_CHAT_ASSIGN) | Staff who may be given a conversation: active, and able to reply. |
| GET | `/api/v1/admin/preorder-chats/:id` | Staff | Admin(PREORDER_CHAT_VIEW) | One conversation with its context panel: the product as the customer saw it and as it is now, the customer, the seller, the linked preorder. Opening it is recorded on the audit trail. |
| GET | `/api/v1/admin/preorder-chats/:id/messages` | Staff | Admin(PREORDER_CHAT_VIEW) | A page of history - `after` to catch up, `before` to load earlier. |
| POST | `/api/v1/admin/preorder-chats/:id/messages` | Staff | Admin(PREORDER_CHAT_VIEW, PREORDER_CHAT_REPLY) | Reply to the customer. The first reply to an unassigned conversation assigns it to whoever wrote it, and closes any SLA alert. Retrying with the same `clientMessageId` returns the stored message. |
| POST | `/api/v1/admin/preorder-chats/:id/read` | Staff | Admin(PREORDER_CHAT_VIEW) | Mark read up to a sequence number, for the whole team. |
| POST | `/api/v1/admin/preorder-chats/:id/assign` | Staff | Admin(PREORDER_CHAT_VIEW) | Take a conversation, give it to a colleague, or put it back in the queue. Taking it yourself needs `reply`; anything else needs `assign`. The new holder is emailed. |
| POST | `/api/v1/admin/preorder-chats/:id/status` | Staff | Admin(PREORDER_CHAT_VIEW) | Move the conversation: open, waiting for the customer, waiting internally, resolved, closed, reopened, spam. Spam and leaving spam need `moderate`. Blocking has its own route. |
| POST | `/api/v1/admin/preorder-chats/:id/priority` | Staff | Admin(PREORDER_CHAT_VIEW, PREORDER_CHAT_REPLY) | Set how urgent the conversation is. |
| PUT | `/api/v1/admin/preorder-chats/:id/tags` | Staff | Admin(PREORDER_CHAT_VIEW, PREORDER_CHAT_REPLY) | Replace the conversation's staff-only tags. |
| GET | `/api/v1/admin/preorder-chats/:id/notes` | Staff | Admin(PREORDER_CHAT_VIEW) | Internal notes. Never shown or sent to the customer. |
| POST | `/api/v1/admin/preorder-chats/:id/notes` | Staff | Admin(PREORDER_CHAT_VIEW, PREORDER_CHAT_REPLY) | Add an internal note. Only other staff ever see it. |
| GET | `/api/v1/admin/preorder-chats/:id/activity` | Staff | Admin(PREORDER_CHAT_VIEW) | What has been decided about the conversation - its audit entries. |
| POST | `/api/v1/admin/preorder-chats/:id/preorder` | Staff | Admin(PREORDER_CHAT_VIEW, PREORDER_CHAT_REPLY) | Link the conversation to one of this customer's preorders for this product, or unlink it. The customer sees a card naming the preorder. |
| GET | `/api/v1/admin/preorder-chats/:id/proposals` | Staff | Admin(PREORDER_CHAT_VIEW) | Every proposal sent in this conversation, newest first. |
| POST | `/api/v1/admin/preorder-chats/:id/proposals` | Staff | Admin(PREORDER_CHAT_VIEW, PREORDER_CHAT_REPLY) | Send a preorder proposal - or a new revision of the open one. The pieces come from the seller's verified unit sizes; the price is indicative. The customer turns it into a preorder request through the ordinary preorder form, and nothing is ordered or reserved by the proposal itself. |
| POST | `/api/v1/admin/preorder-chats/:id/proposals/:proposalId/withdraw` | Staff | Admin(PREORDER_CHAT_VIEW, PREORDER_CHAT_REPLY) | Withdraw an open proposal. |
| POST | `/api/v1/admin/preorder-chats/:id/messages/:messageId/redact` | Staff | Admin(PREORDER_CHAT_VIEW, PREORDER_CHAT_MODERATE) | Remove the words of one message, giving a reason. The message row stays; the words do not. Audited with a fingerprint of what was removed. |
| POST | `/api/v1/admin/preorder-chats/:id/block` | Staff | Admin(PREORDER_CHAT_VIEW, PREORDER_CHAT_MODERATE) | Stop this customer sending preorder chat messages anywhere. |
| POST | `/api/v1/admin/preorder-chats/:id/unblock` | Staff | Admin(PREORDER_CHAT_VIEW, PREORDER_CHAT_MODERATE) | Let a blocked customer message again. |
| GET | `/api/v1/admin/preorder-chats/:id/export` | Staff | Admin(PREORDER_CHAT_VIEW, PREORDER_CHAT_EXPORT) | Download the whole conversation, notes included, as JSON. Audited. |
| POST | `/api/v1/admin/preorder-chats/:id/attachments` | Staff | Admin(PREORDER_CHAT_VIEW, PREORDER_CHAT_REPLY) | Send a PDF or an image to the customer. Checked, scanned and stored privately. |
| POST | `/api/v1/admin/preorder-chats/:id/attachments/:attachmentId/link` | Staff | Admin(PREORDER_CHAT_VIEW) | A download link for one attachment: five minutes, single use. |
| GET | `/api/v1/admin/preorder-chats/:id/attachments/:attachmentId/download` | Staff | Admin(PREORDER_CHAT_VIEW) | Redeem a download link. Served as an attachment, never inline. |

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

### `admin/privacy`

Defined in `backend/src/http/routes/privacy.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/privacy/retention-schedule` | Staff | Admin(DATA_REQUEST_READ) | Every retention window this deployment enforces, read from its configuration. |
| GET | `/api/v1/admin/privacy/processors` | Staff | Admin(DATA_REQUEST_READ) | Every outside party this deployment can send personal data to, and whether it is on. |

### `admin/product-reviews`

Defined in `backend/src/http/routes/product-reviews.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/product-reviews` | Staff | Admin(REVIEW_READ) | Every review, newest first, with who wrote it. Filter by status, score or text. |
| POST | `/api/v1/admin/product-reviews/:reviewId/moderation` | Staff | Admin(REVIEW_MODERATE) | Hide a review from the storefront (a reason is required) or put it back. |
| POST | `/api/v1/admin/product-reviews/:reviewId/response/moderation` | Staff | Admin(REVIEW_MODERATE) | Hide a seller's answer under a review (a reason is required) or put it back. The review is untouched; audited. |

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
| GET | `/api/v1/admin/reports/marketplace` | Staff | Admin(REPORT_READ) | GMV, supplier quality (returns, claims, failed inspections per seller), inspection and dispute figures for a date range. |
| GET | `/api/v1/admin/reports/settlements` | Staff | Admin(PAYMENT_READ) | Seller settlements and payouts for a date range, by status and currency, with failed payouts and holds. |
| GET | `/api/v1/admin/reports/payments` | Staff | Admin(PAYMENT_READ) | The payments report for a date range: payments by status, amounts captured, failed and refunded, rejected payment notifications and payments not yet reconciled. |
| GET | `/api/v1/admin/reports/inventory` | Staff | Admin(INVENTORY_READ) | The inventory report: stock on hand valued at the current selling price (optionally only low-stock items), and a summary of stock movements in a date range. |
| GET | `/api/v1/admin/reports/customers` | Staff | Admin(CUSTOMER_READ) | The customer report for a date range: how many customers there are by status, and how many signed up, activated their account and ordered in that range. |
| GET | `/api/v1/admin/reports/recurring` | Staff | Admin(SCHEDULE_READ) | The recurring-orders report: schedules by status, the runs due in the next few days (7 unless asked otherwise), failed runs, and schedules paused after repeated failures that need somebody to look at them. |

### `admin/return-settings`

Defined in `backend/src/http/routes/returns.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/return-settings` | Staff | Admin(ORDER_READ) | The return policy: window in days, reason codes offered, which need a photo, replacements, instructions. |
| PUT | `/api/v1/admin/return-settings` | Staff | Admin(SETTINGS_WRITE) | Change the return policy. Writes an audit entry. |

### `admin/returns`

Defined in `backend/src/http/routes/commercial-policy.ts`, `backend/src/http/routes/returns.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| PUT | `/api/v1/admin/returns/:id/authorization` | Staff | Admin(ORDER_RETURN) | Issue a return authorisation: route, freight payer and reason. |
| PATCH | `/api/v1/admin/returns/:id/authorization` | Staff | Admin(ORDER_RETURN) | Record return receipt and inspection evidence, and any evidenced deduction. |
| GET | `/api/v1/admin/returns/:id/authorization` | Staff | Admin(ORDER_READ) | The return authorisation, if issued. |
| GET | `/api/v1/admin/returns` | Staff | Admin(ORDER_READ) | Returns, newest first, a page at a time. Filter by status (OPEN for everything still being worked) or order. |
| GET | `/api/v1/admin/returns/:id` | Staff | Admin(ORDER_READ) | One return in full: lines, the buyer's reason and photos, the seller's answer, the timeline and any refund. |
| POST | `/api/v1/admin/returns/:id/approve` | Staff | Admin(ORDER_RETURN) | Approve a requested return, optionally with a note and how the goods should come back. |
| POST | `/api/v1/admin/returns/:id/reject` | Staff | Admin(ORDER_RETURN) | Reject a return. A reason is required - the buyer is told it. Refused once the return is finished. |
| POST | `/api/v1/admin/returns/:id/instructions` | Staff | Admin(ORDER_RETURN) | Write or replace how the goods should come back. |
| POST | `/api/v1/admin/returns/:id/labels` | Staff | Admin(ORDER_RETURN) | Attach a return label (PDF or image) made at the carrier to an approved return. |
| POST | `/api/v1/admin/returns/:id/receive` | Staff | Admin(ORDER_RETURN) | Record that the goods have arrived back. |
| POST | `/api/v1/admin/returns/:id/inspect` | Staff | Admin(ORDER_RETURN) | Record the inspection: per line, how many are sellable and how many damaged. The operator's own sellable units rejoin stock. |
| POST | `/api/v1/admin/returns/:id/refund` | Staff | Admin(REFUND_CREATE) | Refund an inspected return through the ordinary refund path. Needs an Idempotency-Key; never more than the goods cost. |
| POST | `/api/v1/admin/returns/:id/replacement` | Staff | Admin(ORDER_RETURN) | Close an inspected return with a replacement sent instead of a refund. A note saying what was sent is required. |
| POST | `/api/v1/admin/returns/:id/files/:fileId/link` | Staff | Admin(ORDER_READ) | A five-minute, single-use link to one file of a return. |
| GET | `/api/v1/admin/returns/:id/files/:fileId/download` | Staff | Admin(ORDER_READ) | Download a file of a return with a link from the route above. |

### `admin/risk`

Defined in `backend/src/http/routes/risk.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/risk/signals` | Staff | Admin(RISK_READ) | Risk signals, newest first, filtered by status or rule. |
| POST | `/api/v1/admin/risk/signals/:id/decision` | Staff | Admin(RISK_REVIEW) | Decide a risk signal: confirmed or a false positive, with a reason. Changing an earlier decision is recorded as an override. |
| GET | `/api/v1/admin/risk/rules` | Staff | Admin(RISK_READ) | The fraud rules, their thresholds and whether the business has approved them for production. |
| PATCH | `/api/v1/admin/risk/rules/:code` | Staff | Admin(RISK_RULE_WRITE) | Change one rule or approve its values for production. Needs the version you read. |

### `admin/schedules`

Defined in `backend/src/http/routes/schedules.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/schedules` | Staff | Admin(SCHEDULE_READ) | List every customer's scheduled orders, soonest next delivery first, a page at a time. Can be narrowed by status, one-off or repeating, customer, or "due within the next N hours". |
| GET | `/api/v1/admin/schedules/:id` | Staff | Admin(SCHEDULE_READ) | Show one scheduled order in full for staff: the customer, the products, the addresses and its 50 most recent deliveries with the order each one produced and any failure. |
| POST | `/api/v1/admin/schedules/:id/pause` | Staff | Admin(SCHEDULE_WRITE) | Pause any customer's scheduled order, with an optional reason. Upcoming deliveries that have not started are withdrawn until it is resumed. Writes an audit entry. |
| POST | `/api/v1/admin/schedules/:id/resume` | Staff | Admin(SCHEDULE_WRITE) | Restart any customer's paused scheduled order. The next delivery date is worked out afresh from today, so missed deliveries are not caught up. Refused if the card it pays with automatically can no longer be charged, or a one-off delivery date has already passed; writes an audit entry. |
| DELETE | `/api/v1/admin/schedules/:id` | Staff | Admin(SCHEDULE_WRITE) | Cancel any customer's scheduled order, with an optional reason. Only deliveries that have not started are cancelled; orders already created carry on as normal. Writes an audit entry. |

### `admin/seller-assessments`

Defined in `backend/src/http/routes/seller-assessment.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/seller-assessments` | Staff | Admin(CUSTOMER_READ) | Seller assessments, read-only. Decisions belong to the Audit Console. |
| GET | `/api/v1/admin/seller-assessments/:id` | Staff | Admin(CUSTOMER_READ) | One assessment summary, read-only: no internal reviewer notes, no identity or banking file names. |
| GET | `/api/v1/admin/seller-assessments/:id/evidence/:evidenceId` | Staff | Admin(CUSTOMER_READ) | Download an evidence file the Admin Panel may see. Identity, ownership and banking evidence stay with Audit. |

### `admin/seller-assessments-impact`

Defined in `backend/src/http/routes/seller-assessment.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/seller-assessments-impact` | Staff | Admin(CUSTOMER_READ) | What switching the purchase gate to enforce would block, read-only. |

### `admin/seller-carriers`

Defined in `backend/src/http/routes/sellers.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/seller-carriers` | Staff | Admin(CUSTOMER_READ) | List the arrangements between sellers and carriers, filtered by status, seller or carrier. Requests awaiting a decision are what this queue is for. |
| PATCH | `/api/v1/admin/seller-carriers/:id` | Staff | Admin(CUSTOMER_STATUS_WRITE) | Approve, refuse, suspend or end a seller's request to use a carrier, and optionally narrow the countries, capabilities and dates it covers. An adverse decision needs a reason. Writes an audit entry. |

### `admin/seller-certifications`

Defined in `backend/src/http/routes/factories.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/admin/seller-certifications/:id/decision` | Staff | Admin(CUSTOMER_STATUS_WRITE) | Verify or refuse a certificate, or withdraw a verification. A refusal needs a reason the seller is shown. Refused as STALE if it moved since the reviewer opened it. Audited. |

### `admin/seller-company-changes`

Defined in `backend/src/http/routes/factories.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/seller-company-changes` | Staff | Admin(CUSTOMER_READ) | The queue of sellers' change requests for verified company details, pending first; filter by status or seller. |
| POST | `/api/v1/admin/seller-company-changes/:id/decision` | Staff | Admin(CUSTOMER_STATUS_WRITE) | Approve or reject a seller's company details change. Approval applies it and re-opens verification for a material change. Audited. |

### `admin/seller-documents`

Defined in `backend/src/http/routes/sellers.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/admin/seller-documents/:id/link` | Staff | Admin(CUSTOMER_READ) | A link to read one back. |
| GET | `/api/v1/admin/seller-documents/:id/download` | Staff | Admin(CUSTOMER_READ) | Redeem it. |
| POST | `/api/v1/admin/seller-documents/:id/decision` | Staff | Admin(CUSTOMER_READ) | Refused: accepting or refusing an onboarding document is part of seller verification, which the Audit Team decides in the Audit Console. Always 403 SELLER_VERIFICATION_AUDIT_ONLY. |

### `admin/seller-factories`

Defined in `backend/src/http/routes/factories.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/admin/seller-factories/:id/decision` | Staff | Admin(CUSTOMER_STATUS_WRITE) | Verify or refuse a factory, or withdraw a verification. A refusal needs a reason the seller is shown. Refused as STALE if the factory moved since the reviewer opened it. Audited. |

### `admin/seller-fee-tiers`

Defined in `backend/src/http/routes/platform-fee-rules.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/seller-fee-tiers` | Staff | Admin(FINANCE_POLICY_READ) | The sellers placed in a fee tier, and which tier; with q, the sellers matching a name or id. |
| PUT | `/api/v1/admin/seller-fee-tiers/:id` | Staff | Admin(FINANCE_POLICY_WRITE) | Put a seller in a fee tier, or take them out of one, with a reason. Only their next orders are affected. Writes an audit entry. |

### `admin/seller-listings`

Defined in `backend/src/http/routes/sellers.admin.ts`, `backend/src/http/routes/listing-moderation.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/seller-listings/review-queue` | Staff | Admin(PRODUCT_READ) | Seller listings submitted for review and waiting for a decision, a page at a time. |
| GET | `/api/v1/admin/seller-listings/:id` | Staff | Admin(PRODUCT_READ) | One submitted listing, in full. |
| POST | `/api/v1/admin/seller-listings/:id/decision` | Staff | Admin(PRODUCT_PUBLISH) | Approve, refuse or send back a listing. |
| POST | `/api/v1/admin/seller-listings/:id/appeal-decision` | Staff | Admin(PRODUCT_PUBLISH) | Decide a seller's appeal against a refused listing: upheld sends it back for review, refused keeps it refused. Not by the moderator who refused it. Audited. |

### `admin/seller-offers`

Defined in `backend/src/http/routes/sellers.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/admin/seller-offers/:id/block` | Staff | Admin(PRODUCT_PUBLISH) | Take a seller's listing off sale. A reason is required: the seller reads it. Writes an audit entry and tells the seller. `PRODUCT_PUBLISH`, the same authority that puts a listing on sale in the first place. |
| POST | `/api/v1/admin/seller-offers/:id/unblock` | Staff | Admin(PRODUCT_PUBLISH) | Lift a block. The listing returns to where it was; one that was on sale comes back paused so the seller's own checks run before it sells again. |

### `admin/seller-orders`

Defined in `backend/src/http/routes/commercial-policy.ts`, `backend/src/http/routes/commission-invoices.admin.ts`, `backend/src/http/routes/trade-compliance.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/seller-orders/:id/controls` | Staff | Admin(ORDER_READ) | A seller order's acceptance controls. |
| PATCH | `/api/v1/admin/seller-orders/:id/controls` | Staff | Admin(ORDER_FULFIL) | Record missing acceptance controls while the seller order is NEW. |
| GET | `/api/v1/admin/seller-orders/:id/dispatch-controls` | Staff | Admin(LOGISTICS_READ) | Dispatch controls: booking, quotes, documents, evidence, custody, partial shipments and the gate's gaps. |
| PUT | `/api/v1/admin/seller-orders/:id/freight-booking` | Staff | Admin(LOGISTICS_WRITE) | Record a freight booking with its compared quotes. |
| PUT | `/api/v1/admin/seller-orders/:id/dispatch-evidence` | Staff | Admin(LOGISTICS_WRITE) | Record dispatch evidence (quantities, lots, seals, photos, temperature, handling). |
| POST | `/api/v1/admin/seller-orders/:id/custody-handovers` | Staff | Admin(LOGISTICS_WRITE) | Record a custody handover. |
| POST | `/api/v1/admin/seller-orders/:id/partial-shipments` | Staff | Admin(ORDER_APPROVE) | Approve a partial shipment with proportionate billing. |
| POST | `/api/v1/admin/seller-orders/:id/commission-invoice` | Staff | Admin(COMMISSION_INVOICE_GENERATE) | Create the draft commission invoice for one seller order, or return the live one. Needs an Idempotency-Key. |
| POST | `/api/v1/admin/seller-orders/:id/compliance-override` | Staff | Admin(LOGISTICS_WRITE) | Let one seller order's goods leave despite its current compliance holds, with a written reason. Audited. |
| DELETE | `/api/v1/admin/seller-orders/:id/compliance-override` | Staff | Admin(LOGISTICS_WRITE) | Withdraw a compliance override: the holds apply again. Audited. |

### `admin/sellers`

Defined in `backend/src/http/routes/shipment-assessment.ts`, `backend/src/http/routes/sellers.admin.ts`, `backend/src/http/routes/factories.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/sellers/:id/audit-badge` | Staff | Admin(CUSTOMER_READ) | A seller's Audit badge, history and verification certificates, read-only. |
| GET | `/api/v1/admin/sellers` | Staff | Admin(CUSTOMER_READ) | List seller applications a page at a time, filtered by status or searched by business name. |
| GET | `/api/v1/admin/sellers/verified` | Staff | Admin(CUSTOMER_READ) | Verified suppliers - approved, not suspended, with something live to sell - for the Sellers screen. `sort=newest` is most recently verified first. |
| GET | `/api/v1/admin/sellers/:id` | Staff | Admin(CUSTOMER_READ) | One seller application in full, including internal notes the seller never sees. |
| GET | `/api/v1/admin/sellers/:id/insight` | Staff | Admin(CUSTOMER_READ) | How this seller is doing, and where its goods are. |
| GET | `/api/v1/admin/sellers/:id/access-review` | Staff | Admin(CUSTOMER_READ) | Who can act for this seller, read-only: each member's role, when they joined, who invited them, when they last signed in and used the Hub, the open invitations and the recent access reviews. |
| POST | `/api/v1/admin/sellers/:id/decision` | Staff | Admin(CUSTOMER_STATUS_WRITE) | Suspend a seller, or lift a suspension. Nothing else. |
| POST | `/api/v1/admin/sellers/:id/screening` | Staff | Admin(CUSTOMER_READ) | Refused: recording a sanctions screening is part of seller verification, which the Audit Team decides in the Audit Console. Always 403 SELLER_VERIFICATION_AUDIT_ONLY. |
| GET | `/api/v1/admin/sellers/:id/turnover` | Staff | Admin(CUSTOMER_READ) | The seller's declared annual turnover under the eligibility policy, every earlier declaration, the supporting documents and who verified what. Staff only. |
| POST | `/api/v1/admin/sellers/:id/turnover/decision` | Staff | Admin(CUSTOMER_READ) | Refused: verifying turnover is part of seller verification, which the Audit Team decides in the Audit Console. Always 403 SELLER_VERIFICATION_AUDIT_ONLY. |
| GET | `/api/v1/admin/sellers/:id/approval-readiness` | Staff | Admin(CUSTOMER_READ) | What approving this seller is still waiting for: unfinished required steps, required documents not accepted or expired, and missing or unclear screenings. Empty means the seller can be approved. |
| PATCH | `/api/v1/admin/sellers/:id/commission` | Staff | Admin(SETTINGS_WRITE) | One seller's own commission rate. |
| GET | `/api/v1/admin/sellers/:id/documents` | Staff | Admin(CUSTOMER_READ) | The current certificates and licences a seller has uploaded, with the review status of each. |
| GET | `/api/v1/admin/sellers/:id/offers` | Staff | Admin(PRODUCT_READ) | One seller's listings as staff see them, with the block reason where there is one. Optional `status` filter, a page at a time. |
| GET | `/api/v1/admin/sellers/:id/factories` | Staff | Admin(CUSTOMER_READ) | One seller's factories (machines, evidence metadata, current status and every check with its reviewer and reason) and certificates. |

### `admin/settings`

Defined in `backend/src/http/routes/settings.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/settings/business` | Staff | Admin(SETTINGS_READ) | The store's business profile: its names, contacts, tax numbers, currency and other store-wide settings. |
| PATCH | `/api/v1/admin/settings/business` | Staff | Admin(SETTINGS_WRITE) | Change the business profile: names, support contacts, tax numbers, the standard seller commission, logo, address, currency, time zone and invoice and order number prefixes. The currency cannot change once any order exists. Writes an audit entry. |
| PATCH | `/api/v1/admin/settings/policy-links` | Staff | Admin(SETTINGS_WRITE) | Replace the policy links shown in the storefront footer (terms, privacy and so on). Every link must start with http:// or https://; empty ones are dropped. Writes an audit entry. |
| GET | `/api/v1/admin/settings/market-profiles` | Staff | Admin(SETTINGS_READ) | Every market the deployment sells in, with its landing-page text (Master row 8). |
| PUT | `/api/v1/admin/settings/market-profiles/:country` | Staff | Admin(SETTINGS_WRITE) | Write one market's landing-page text; publishing makes it public. Audited. |
| GET | `/api/v1/admin/settings/tax-classes` | Staff | Admin(SETTINGS_READ) | List the tax classes, the default first, with each one's rate. |
| GET | `/api/v1/admin/settings/processors` | Staff | Admin(SETTINGS_READ) | Who this deployment actually shares data with |
| POST | `/api/v1/admin/settings/tax-classes` | Staff | Admin(SETTINGS_WRITE) | Add a tax class with its rate and, optionally, its EU VAT band. Making it the default takes that from the previous default. Writes an audit entry. |
| PATCH | `/api/v1/admin/settings/tax-classes/:id` | Staff | Admin(SETTINGS_WRITE) | Change a tax class. Refused if it would switch off a class products still use, or leave the store without a default. Writes an audit entry. |
| GET | `/api/v1/admin/settings/shipping-methods` | Staff | Admin(SETTINGS_READ) | List the store's delivery methods and their prices. |
| POST | `/api/v1/admin/settings/shipping-methods` | Staff | Admin(SETTINGS_WRITE) | Add a delivery method with its price, free-delivery threshold, delivery time estimate and regions. Refused if the code is already used. Writes an audit entry. |
| PATCH | `/api/v1/admin/settings/shipping-methods/:id` | Staff | Admin(SETTINGS_WRITE) | Change a delivery method. Switching one off reports how many active or paused recurring schedules use it, so staff can be warned. Writes an audit entry. |
| GET | `/api/v1/admin/settings/notifications` | Staff | Admin(SETTINGS_READ) | List the notifications staff have customised, with their templates, channels, recipients and whether each is switched on, plus the catalogue of built-in events and the wording each uses until customised. |
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

### `admin/shipment-assessments`

Defined in `backend/src/http/routes/shipment-assessment.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/shipment-assessments` | Staff | Admin(INSPECTION_READ) | Shipment Assessment queues, read-only. Decisions are made in the Audit Console. |
| GET | `/api/v1/admin/shipment-assessments/policy` | Staff | Admin(INSPECTION_READ) | The badge policy, read-only. |
| GET | `/api/v1/admin/shipment-assessments/:id` | Staff | Admin(INSPECTION_READ) | One case in full, read-only. |
| GET | `/api/v1/admin/shipment-assessments/:id/evidence/:evidenceId` | Staff | Admin(INSPECTION_READ) | Download a case's evidence file, read-only. |
| GET | `/api/v1/admin/shipment-assessments/:id/documents/:documentId` | Staff | Admin(INSPECTION_READ) | Download a case's certificate, waiver or report, read-only. |

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
| GET | `/api/v1/admin/staff/access-review` | Staff | Admin(STAFF_READ) | Every staff account's roles, two-factor, last sign-in and dormant flag, with the latest review decision. Business Owners only. |
| POST | `/api/v1/admin/staff/:id/access-reviews` | Staff | Admin(STAFF_READ, STAFF_WRITE) | Record a keep / reduce / revoke decision about one staff account. Business Owners only, never about yourself. Writes an audit entry. |

### `admin/support-tickets`

Defined in `backend/src/http/routes/support.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/support-tickets` | Staff | Admin(SUPPORT_TICKET_VIEW) | The Support inbox: every request, most recently active first, with counts by status. |
| GET | `/api/v1/admin/support-tickets/sla-policies` | Staff | Admin(SUPPORT_TICKET_VIEW) | The first-response and resolution targets for every support category. |
| PUT | `/api/v1/admin/support-tickets/sla-policies` | Staff | Admin(SETTINGS_WRITE) | Set the first-response and resolution targets for one or more categories. |
| POST | `/api/v1/admin/support-tickets/:id/attachments` | Staff | Admin(SUPPORT_TICKET_REPLY) | Attach one image, video or PDF to a ticket as the team. The sender sees it. |
| GET | `/api/v1/admin/support-tickets/assignees` | Staff | Admin(SUPPORT_TICKET_VIEW) | Staff who may be given a support request. |
| GET | `/api/v1/admin/support-tickets/:id` | Staff | Admin(SUPPORT_TICKET_VIEW) | One request in full: who sent it, for whom, its thread and internal notes, and its history. |
| POST | `/api/v1/admin/support-tickets/:id/replies` | Staff | Admin(SUPPORT_TICKET_REPLY) | Answer the sender. They are emailed that there is a reply; optionally move the status too. |
| POST | `/api/v1/admin/support-tickets/:id/notes` | Staff | Admin(SUPPORT_TICKET_REPLY) | Write an internal note. Never shown to the sender. |
| PATCH | `/api/v1/admin/support-tickets/:id` | Staff | Admin(SUPPORT_TICKET_REPLY) | Change a request's status, its priority, or both. |
| POST | `/api/v1/admin/support-tickets/:id/attachments/:attachmentId/link` | Staff | Admin(SUPPORT_TICKET_VIEW) | A download link for one file on a ticket: five minutes, single use, this session only. |
| GET | `/api/v1/admin/support-tickets/:id/attachments/:attachmentId/download` | Staff | Admin(SUPPORT_TICKET_VIEW) | Redeem a download link. Served as a download, never inline. |
| POST | `/api/v1/admin/support-tickets/:id/assignment` | Staff | Admin(SUPPORT_TICKET_VIEW) | Take a request, give it to a colleague, or put it back in the queue. |

### `admin/trade-documents`

Defined in `backend/src/http/routes/trade-documents.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/trade-documents/versions/:id/file` | Staff | Admin(ORDER_READ) | Open the file of one version of a seller's trade document. |
| POST | `/api/v1/admin/trade-documents/versions/:id/validation` | Staff | Admin(LOGISTICS_WRITE) | Mark the current version of a trade document valid, or reject it with a reason. |

### `admin/trade-rules`

Defined in `backend/src/http/routes/trade-compliance.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/admin/trade-rules` | Staff | Admin(SETTINGS_READ) | Every destination and category trade rule, optionally for one destination country. |
| POST | `/api/v1/admin/trade-rules` | Staff | Admin(SETTINGS_WRITE) | Add a trade rule: restricted or prohibited goods, a required document and who produces it, HS verification. Audited. |
| PUT | `/api/v1/admin/trade-rules/:id` | Staff | Admin(SETTINGS_WRITE) | Replace a trade rule. Audited. |
| DELETE | `/api/v1/admin/trade-rules/:id` | Staff | Admin(SETTINGS_WRITE) | Delete a trade rule. Audited. |

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

Defined in `backend/src/http/routes/auth.ts`, `backend/src/http/routes/agreements.ts`, `backend/src/http/routes/logistics.portal.ts`.

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
| GET | `/api/v1/logistics/auth/agreements` | Logistics | LogisticsBeforeAgreements | Whether this carrier staff member has accepted the Logistics Partner Terms and acknowledged the Privacy Policy in force. |
| POST | `/api/v1/logistics/auth/agreements/terms` | Logistics | LogisticsBeforeAgreements | "I agree" in the Logistics Partner Terms dialog. |
| POST | `/api/v1/logistics/auth/agreements/privacy` | Logistics | LogisticsBeforeAgreements | "I acknowledge" in the Privacy Policy dialog. |
| DELETE | `/api/v1/logistics/auth/agreements/terms` | Logistics | LogisticsBeforeAgreements | Untick the Logistics Partner Terms box before Continue. |
| DELETE | `/api/v1/logistics/auth/agreements/privacy` | Logistics | LogisticsBeforeAgreements | Untick the Privacy Policy box before Continue. |
| GET | `/api/v1/logistics/auth/agreements/history` | Logistics | LogisticsBeforeAgreements | Every acceptance and acknowledgment this person has given, newest first. |
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

Defined in `backend/src/http/routes/shipment-assessment.ts`, `backend/src/http/routes/logistics-levels.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/logistics/legs/:id/shipment-assessment` | Logistics | Logistics(SHIPMENT_STATUS_WRITE) | Release or hold state, handling needs and the final loading checks for an L2 leg this carrier holds. It cannot lift a hold. |
| POST | `/api/v1/logistics/legs/:id/shipment-assessment/checks` | Logistics | Logistics(SHIPMENT_STATUS_WRITE) | Record the final loading checks (vehicle, securing, count, seals, documents) after release. |
| POST | `/api/v1/logistics/legs/:id/shipment-assessment/evidence` | Logistics | Logistics(SHIPMENT_STATUS_WRITE) | Attach loading evidence (photos of the container, seals, documents). |
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

### `logistics/profile`

Defined in `backend/src/http/routes/logistics.portal.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/logistics/profile` | Logistics | Logistics(ORGANISATION_READ) | This delivery company's full profile: identity, company details, contacts, coverage, capabilities, compliance documents, integration status and any details change waiting for the marketplace. Secrets, credentials and the marketplace's private notes are never included. |
| PATCH | `/api/v1/logistics/profile` | Logistics | Logistics(ORGANISATION_WRITE) | Save changes to the profile. Contacts, addresses, hours and similar fields are saved at once. Legal name, trading name, registration and tax numbers, the registered address and the licence are sent to the marketplace to verify and only change once approved. Any other field is refused. Writes an audit entry. |
| DELETE | `/api/v1/logistics/profile/pending-change` | Logistics | Logistics(ORGANISATION_WRITE) | Withdraw the details change waiting for the marketplace. Writes an audit entry. |
| POST | `/api/v1/logistics/profile/logo` | Logistics | Logistics(ORGANISATION_WRITE) | Replace the company logo. JPEG, PNG, WebP or GIF, decided by the file's contents; SVG is refused. Scanned for malware first. Writes an audit entry. |
| DELETE | `/api/v1/logistics/profile/logo` | Logistics | Logistics(ORGANISATION_WRITE) | Remove the company logo. Writes an audit entry. |
| POST | `/api/v1/logistics/profile/documents` | Logistics | Logistics(ORGANISATION_WRITE) | File a compliance document (licence, insurance, permit, registration) for the marketplace to verify. PDF or image up to 10 MB, decided by the file's contents, scanned for malware and stored privately. A newer file of the same kind replaces the older one, which is kept. Writes an audit entry. |
| POST | `/api/v1/logistics/profile/documents/:id/link` | Logistics | Logistics(ORGANISATION_READ) | A short-lived, single-use link to one of this company's compliance documents. Refused for a file that has not passed the malware scan. Writes an audit entry. |
| GET | `/api/v1/logistics/profile/documents/:id/download` | Logistics | Logistics(ORGANISATION_READ) | Download a compliance document with a link from the route above. Needs the same signed-in person as well as the link, and works once. |

### `logistics/shipments`

Defined in `backend/src/http/routes/commercial-policy.ts`, `backend/src/http/routes/logistics.portal.ts`, `backend/src/http/routes/logistics.operations.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/logistics/shipments/:id/custody` | Logistics | Logistics(SHIPMENT_READ) | Custody, documents and the dispatch gaps for a shipment assigned to my company. |
| POST | `/api/v1/logistics/shipments/:id/custody` | Logistics | Logistics(SHIPMENT_STATUS_WRITE) | Record a custody handover for a shipment assigned to my company. |
| GET | `/api/v1/logistics/shipments` | Logistics | Logistics(SHIPMENT_READ) | One page of this delivery company's shipments, searchable and filterable by reference, company, place, status, delivery deadline, driver, problems, proof of delivery and dates, and sortable. |
| GET | `/api/v1/logistics/shipments/export` | Logistics | Logistics(SHIPMENT_EXPORT) | The same rows, as CSV. |
| GET | `/api/v1/logistics/shipments/:id` | Logistics | LogisticsAny(SHIPMENT_READ, DRIVER_TASK_READ) | One shipment this delivery company holds, with contact details masked to what the caller is entitled to see. A driver may open only the stops on their own round, and sees contact details masked here as everybody does. |
| GET | `/api/v1/logistics/shipments/:id/timeline` | Logistics | LogisticsAny(SHIPMENT_READ, DRIVER_TASK_READ) | The event history of one shipment. People who can update a shipment's status also see the internal operations notes; read-only viewers see the public history only. |
| POST | `/api/v1/logistics/shipments/:id/accept` | Logistics | Logistics(SHIPMENT_ACCEPT) | Accept a shipment offered to this delivery company. The seller is told and an audit entry is written. Refused when the offer has already been answered or withdrawn. |
| POST | `/api/v1/logistics/shipments/:id/reject` | Logistics | Logistics(SHIPMENT_ACCEPT) | Decline a shipment offered to this delivery company, with a reason. The shipment goes back to waiting for a carrier, the seller is told, and the refusal is recorded against this company. |
| POST | `/api/v1/logistics/shipments/:id/status-events` | Logistics | Logistics(SHIPMENT_STATUS_WRITE) | Record a status event. |
| POST | `/api/v1/logistics/shipments/:id/exceptions` | Logistics | Logistics(SHIPMENT_EXCEPTION_WRITE) | Report a delivery problem on a shipment this company holds, such as a missed pickup, damage or a temperature excursion. Some problem types have a minimum severity; a critical one also alerts the marketplace's operations team. Writes an audit entry. |
| GET | `/api/v1/logistics/shipments/:id/documents` | Logistics | Logistics(DOCUMENT_READ) | The files on a shipment that a delivery company is allowed to see. Documents meant only for the marketplace are never included. |
| POST | `/api/v1/logistics/shipments/:id/documents` | Logistics | Logistics(DOCUMENT_WRITE) | Attach a photo to a shipment this company holds, such as a delivery photo, signature or damage evidence. Only images up to 10 MB are accepted, and a delivery company cannot attach commercial paperwork. Writes an audit entry. |
| GET | `/api/v1/logistics/shipments/:id/proof-of-delivery` | Logistics | LogisticsAny(SHIPMENT_READ, DRIVER_TASK_READ) | The proof of delivery recorded for a shipment, if any. Signature and photo files are referred to by id; a separate request gets a short-lived link to view them. |
| POST | `/api/v1/logistics/shipments/:id/proof-of-delivery` | Logistics | Logistics(POD_WRITE) | Record proof of delivery (recipient, time, place, signature or photo) and mark the shipment delivered. A shipment is delivered once: a repeat call returns the proof already recorded instead of failing. |
| POST | `/api/v1/logistics/shipments/:id/delivery-code` | Logistics | Logistics(POD_WRITE) | Send the person receiving a shipment a new delivery code by email, for a delivery whose policy asks for one. Only while it is out for delivery; at most one a minute and five a day, and sending one cancels the last. The code is never in the response. Writes an audit entry. |
| GET | `/api/v1/logistics/shipments/:id/live-location` | Logistics | Logistics(TRIP_LOCATION_READ) | Where the driver on this consignment currently is, or null. |
| POST | `/api/v1/logistics/shipments/:id/assign-driver` | Logistics | Logistics(DRIVER_ASSIGN) | Put a driver on a consignment, or move it from one driver to another. |
| POST | `/api/v1/logistics/shipments/:id/unassign-driver` | Logistics | Logistics(DRIVER_ASSIGN) | Take the driver off, without putting another one on. |
| GET | `/api/v1/logistics/shipments/:id/driver-history` | Logistics | Logistics(SHIPMENT_READ) | Everyone who has carried this consignment, oldest first. |

### `logistics/support`

Defined in `backend/src/http/routes/support.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/logistics/support/context` | Logistics | LogisticsBeforeAgreements | What the portal's Support page needs: whether it takes requests, the contacts and the prefill. |
| POST | `/api/v1/logistics/support/tickets` | Logistics | LogisticsBeforeAgreements | Send a support request from the logistics portal. Needs an Idempotency-Key. |
| GET | `/api/v1/logistics/support/tickets` | Logistics | LogisticsBeforeAgreements | Your own support requests sent from the portal for this company. |
| GET | `/api/v1/logistics/support/tickets/:reference` | Logistics | LogisticsBeforeAgreements | One of your portal support requests and its thread. |
| POST | `/api/v1/logistics/support/tickets/:reference/messages` | Logistics | LogisticsBeforeAgreements | Write again on one of your portal requests. Needs an Idempotency-Key. |
| POST | `/api/v1/logistics/support/tickets/:reference/attachments` | Logistics | LogisticsBeforeAgreements | Attach one image, video or PDF to your ticket. Checked by its contents, scanned, stored privately. |
| POST | `/api/v1/logistics/support/tickets/:reference/attachments/:attachmentId/link` | Logistics | LogisticsBeforeAgreements | A download link for one file on your ticket: five minutes, single use, this session only. |
| GET | `/api/v1/logistics/support/tickets/:reference/attachments/:attachmentId/download` | Logistics | LogisticsBeforeAgreements | Redeem a download link. Served as a download, never inline. |

### `logistics/vehicles`

Defined in `backend/src/http/routes/logistics.operations.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/logistics/vehicles` | Logistics | Logistics(VEHICLE_READ) | List this carrier's vehicles, in-service ones first, with their refrigeration, tail lift and weight limits. |
| POST | `/api/v1/logistics/vehicles` | Logistics | Logistics(VEHICLE_WRITE) | Add a vehicle to this carrier's fleet list. Refused when a vehicle with the same registration is already on it. Writes an audit entry. |

## Audit Console

### `audit/agency`

Defined in `backend/src/http/routes/inspection.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/audit/agency/me` | Audit | Audit(InspectionAgencyPermission.JOB_READ) | Who you are in your inspection agency, and what you may do there. |
| GET | `/api/v1/audit/agency/dashboard` | Audit | Audit(InspectionAgencyPermission.JOB_READ) | Your agency's work: jobs by status, SLA, inspectors, reports and invoices. |
| GET | `/api/v1/audit/agency/jobs` | Audit | Audit(InspectionAgencyPermission.JOB_READ) | Jobs you may see. An inspector sees only the jobs they are named on. |
| GET | `/api/v1/audit/agency/calendar` | Audit | Audit(InspectionAgencyPermission.JOB_READ) | Agency capacity and booked jobs by day. |
| GET | `/api/v1/audit/agency/jobs/:id` | Audit | Audit(InspectionAgencyPermission.JOB_READ) | One job: scope, location, schedule, checklist, sampling, defects, evidence and report. |
| POST | `/api/v1/audit/agency/jobs/:id/${path}` | Audit | Audit(InspectionAgencyPermission.JOB_READ) | *Run "jobs ${path}".* |
| POST | `/api/v1/audit/agency/jobs/:id/lab-samples/:sampleId/custody` | Audit | Audit(InspectionAgencyPermission.JOB_READ) | Add one hand-over to a laboratory sample's chain of custody. |
| POST | `/api/v1/audit/agency/jobs/:id/lab-samples/:sampleId/result` | Audit | Audit(InspectionAgencyPermission.JOB_READ) | The laboratory's report on a sample, held as evidence on this job. |
| POST | `/api/v1/audit/agency/reports/:id/correct` | Audit | Audit(InspectionAgencyPermission.JOB_READ) | QA issues a correction of a signed report. The original is kept, superseded. |
| GET | `/api/v1/audit/agency/reports/:id/pdf` | Audit | Audit(InspectionAgencyPermission.JOB_READ) | Download a signed report as a PDF: your agency's own, and an inspector's own jobs only. |
| GET | `/api/v1/audit/agency/team` | Audit | Audit(InspectionAgencyPermission.JOB_READ) | The agency's own people. Every member may read; an agency admin manages. |
| POST | `/api/v1/audit/agency/team/invitations` | Audit | Audit(InspectionAgencyPermission.JOB_READ) | An agency admin invites a person into their own agency. They get a console account and an activation email. |
| PATCH | `/api/v1/audit/agency/team/members/:id` | Audit | Audit(InspectionAgencyPermission.JOB_READ) | An agency admin changes a member's role, competence or status. Identity is verified only by the marketplace. |
| POST | `/api/v1/audit/agency/team/members/:id/resend-invitation` | Audit | Audit(InspectionAgencyPermission.JOB_READ) | An agency admin sends a fresh activation link to somebody who has not activated yet. |
| POST | `/api/v1/audit/agency/defects/:id/reclassify` | Audit | Audit(InspectionAgencyPermission.JOB_READ) | Reclassify a defect's severity, with a reason and supporting evidence. |
| POST | `/api/v1/audit/agency/jobs/:id/evidence` | Audit | Audit(InspectionAgencyPermission.JOB_READ) | Upload timestamped evidence (photo, video, document, measurement) to a job. Stored privately and hashed. |
| GET | `/api/v1/audit/agency/evidence/:id` | Audit | Audit(InspectionAgencyPermission.JOB_READ) | Download one evidence file you may see. |

### `audit/audit-documents`

Defined in `backend/src/http/routes/shipment-assessment.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/audit/audit-documents/:id/revoke` | Audit | Audit(CERTIFICATE_ISSUE) | Revoke an issued document with a reason. A revoked release document withdraws its unused release. |

### `audit/auth`

Defined in `backend/src/http/routes/auth.ts`, `backend/src/http/routes/agreements.ts`, `backend/src/http/routes/audit.console.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/audit/auth/login` | Public (audit sign-in) |  | Sign in with email and password and start a session (set as cookies). Refused for an account that belongs to a different part of the system, and for an account temporarily locked after too many failed attempts. |
| POST | `/api/v1/audit/auth/refresh` | Public (audit sign-in) |  | Swap the session's refresh cookie for fresh sign-in tokens so the person stays signed in. If the session is no longer valid its cookies are cleared and the caller must sign in again. |
| POST | `/api/v1/audit/auth/logout` | Signed in | Authenticated(kind) | Sign out of this session only and clear its cookies. |
| POST | `/api/v1/audit/auth/logout-all` | Signed in | Authenticated(kind) | Sign the person out on every device at once. Replies with how many sessions were ended. |
| GET | `/api/v1/audit/auth/language` | Signed in | Authenticated(kind) | The interface language for this account. |
| PUT | `/api/v1/audit/auth/language` | Signed in | Authenticated(kind) | Save the interface language the signed-in person wants to read. |
| POST | `/api/v1/audit/auth/password/change` | Signed in | Authenticated(kind) | Change the signed-in person's password, given their current one. Signs the account out of every session, including this one, and writes an audit entry. |
| POST | `/api/v1/audit/auth/password/forgot` | Public (audit sign-in) |  | Ask for a password-reset link. If an active account exists for the email address, a reset link is emailed to it; the reply is the same either way, so nobody can use it to find out who has an account. |
| POST | `/api/v1/audit/auth/password/reset` | Public (audit sign-in) |  | Set a new password using the link from a "forgot password" email. Signs the account out everywhere and writes an audit entry; refused if the link has expired or was already used. |
| POST | `/api/v1/audit/auth/invitations/accept` | Public (audit sign-in) |  | Accept an emailed invitation to the Audit Console: the person chooses their own password and their console membership becomes active. They set up two-step sign-in at their first sign-in. |
| GET | `/api/v1/audit/auth/agreements` | Audit | AuditBeforeAgreements | Whether this Audit Console user has accepted the console terms and acknowledged the Privacy Policy in force. |
| POST | `/api/v1/audit/auth/agreements/terms` | Audit | AuditBeforeAgreements | "I agree" in the Audit Console terms dialog. |
| POST | `/api/v1/audit/auth/agreements/privacy` | Audit | AuditBeforeAgreements | "I acknowledge" in the Privacy Policy dialog. |
| DELETE | `/api/v1/audit/auth/agreements/terms` | Audit | AuditBeforeAgreements | Untick the Audit Console terms box before Continue. |
| DELETE | `/api/v1/audit/auth/agreements/privacy` | Audit | AuditBeforeAgreements | Untick the Privacy Policy box before Continue. |
| GET | `/api/v1/audit/auth/agreements/history` | Audit | AuditBeforeAgreements | Every acceptance and acknowledgment this person has given, newest first. |
| GET | `/api/v1/audit/auth/me` | Audit | AuditSession | Everything the console needs to start: the person, their membership and permissions, and their second factor. |
| POST | `/api/v1/audit/auth/mfa/setup` | Audit | AuditSession | Start setting up two-step sign-in: a secret for an authenticator app and recovery codes, shown this once. |
| POST | `/api/v1/audit/auth/mfa/verify` | Audit | AuditSession | Check a two-step code: to finish setting it up, or to pass this session's challenge. |

### `audit/calendar`

Defined in `backend/src/http/routes/audit.console.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/audit/calendar` | Audit | Audit(InspectionAgencyPermission.JOB_READ) | Your agency's capacity and booked jobs by day. |

### `audit/cases`

Defined in `backend/src/http/routes/audit.console.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/audit/cases` | Audit | Audit(SELLER_READ) | Qualification and product cases, filterable by level, status, seller and category. |
| GET | `/api/v1/audit/cases/:id` | Audit | Audit(SELLER_READ) | One case with its live evaluation, requirement by requirement, and its history. |
| POST | `/api/v1/audit/cases` | Audit | Audit(CASE_REVIEW) | Open a case for a seller - the backfill review of a seller already trading. Asking twice returns the same case. |
| POST | `/api/v1/audit/cases/:id/start` | Audit | Audit(CASE_REVIEW) | Take a case for review. |
| POST | `/api/v1/audit/cases/:id/request-changes` | Audit | Audit(CASE_REVIEW) | Ask the seller for more or different evidence, with a message they see. |
| POST | `/api/v1/audit/cases/:id/approve` | Audit | Audit(CASE_REVIEW) | Qualify: only when every applicable mandatory requirement is satisfied and every conditional one determined. |
| POST | `/api/v1/audit/cases/:id/reject` | Audit | Audit(CASE_REVIEW) | Refuse the case, with a message the seller sees. |
| POST | `/api/v1/audit/cases/:id/suspend` | Audit | Audit(CASE_REVIEW) | Suspend a qualification, with a message the seller sees. |
| POST | `/api/v1/audit/cases/:id/determinations` | Audit | Audit(CASE_REVIEW) | Record whether a conditional or unresolved requirement applies to this case, with the reason. |

### `audit/checklists`

Defined in `backend/src/http/routes/audit.console.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/audit/checklists` | Audit | Audit(CHECKLIST_MANAGE) | Checklist and sampling plans by category. |
| POST | `/api/v1/audit/checklists` | Audit | Audit(CHECKLIST_MANAGE) | Add a plan version for a category: inspection level, AQL per severity, and the checklist (kinds, mandatory lines, lab and instrument needs). |

### `audit/corrective-actions`

Defined in `backend/src/http/routes/audit.console.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/audit/corrective-actions` | Public |  | Non-conformances, the seller's corrective actions, and the re-inspections that close them. |

### `audit/dashboard`

Defined in `backend/src/http/routes/audit.console.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/audit/dashboard` | Audit | Audit(DASHBOARD_READ) | The dashboard: an agency's own work, or the audit team's queues. |

### `audit/documents`

Defined in `backend/src/http/routes/audit.console.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/audit/documents` | Audit | Audit(DOCUMENT_READ) | Compliance documents, filterable by status and by approaching expiry. |
| GET | `/api/v1/audit/documents/:id` | Audit | Audit(DOCUMENT_READ) | One document with its versions and review history. |
| GET | `/api/v1/audit/documents/:id/file` | Audit | Audit(DOCUMENT_READ) | The document's file, for preview. Private storage, scanned files only, every read audited. |
| POST | `/api/v1/audit/documents/:id/start` | Audit | Audit(RULE_READ) | Take a document for review. |
| POST | `/api/v1/audit/documents/:id/request-changes` | Audit | Audit(RULE_READ) | Ask the seller to correct or replace a document, with a message they see. |
| POST | `/api/v1/audit/documents/:id/approve` | Audit | Audit(RULE_READ) | Approve a document, recording how it was checked and the scope it covers. A mismatch can never be approved. |
| POST | `/api/v1/audit/documents/:id/reject` | Audit | Audit(RULE_READ) | Refuse a document, with a message the seller sees. |
| POST | `/api/v1/audit/documents/:id/suspend` | Audit | Audit(RULE_READ) | Suspend an approved document. Qualifications that relied on it go back for review. |

### `audit/evidence`

Defined in `backend/src/http/routes/audit.console.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/audit/evidence/:id` | Public |  | One evidence file, for those who may read its job. Every read is audited. |

### `audit/insights`

Defined in `backend/src/http/routes/audit.console.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/audit/insights` | Audit | Audit(JOB_OVERSEE) | Quality insights: pass/fail by month, defects, top findings, best and worst suppliers, agency performance. |

### `audit/jobs`

Defined in `backend/src/http/routes/audit.console.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/audit/jobs` | Public |  | Inspection jobs: your agency's (an inspector's own), or every agency's for the audit team. |
| GET | `/api/v1/audit/jobs/:id` | Public |  | One job: scope, checklist, quantities, sampling, defects, laboratory samples, evidence, reports and sub-lots. |
| POST | `/api/v1/audit/jobs/:id/sublot-releases` | Audit | Audit(RELEASE_REQUEST) | Ask for a clearly identified part of a held lot to be released. Somebody else approves it in the Admin Panel. |

### `audit/notifications`

Defined in `backend/src/http/routes/audit.console.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/audit/notifications` | Audit | Audit | Your notifications, newest first, with the unread count. |
| POST | `/api/v1/audit/notifications/:id/read` | Audit | Audit | Mark one of your notifications read. |
| POST | `/api/v1/audit/notifications/read-all` | Audit | Audit | Mark all your notifications read. |

### `audit/product-evidence`

Defined in `backend/src/http/routes/commercial-policy.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/audit/product-evidence` | Audit | Audit(ASSESSMENT_READ) | Product evidence per SKU/version, site and country. |
| GET | `/api/v1/audit/product-evidence/prompts` | Audit | Audit(ASSESSMENT_READ) | Doc 08 s8 reviewer prompts for a department. |
| POST | `/api/v1/audit/product-evidence` | Audit | Audit(ASSESSMENT_WORK) | Record a piece of product evidence. |
| POST | `/api/v1/audit/product-evidence/:id/status` | Audit | Audit(SELLER_VERIFY) | Verify, suspend, withdraw or reject evidence (verification not by its recorder). |

### `audit/products`

Defined in `backend/src/http/routes/audit.console.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/audit/products` | Audit | Audit(SELLER_READ) | Product compliance cases only. |

### `audit/recall-rehearsals`

Defined in `backend/src/http/routes/commercial-policy.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/audit/recall-rehearsals` | Audit | Audit(ASSESSMENT_WORK) | Record an annual recall-traceability rehearsal. |

### `audit/reports`

Defined in `backend/src/http/routes/audit.console.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/audit/reports` | Public |  | Signed inspection reports, with corrections and superseded revisions marked. |
| GET | `/api/v1/audit/reports/:id/pdf` | Public |  | A signed report as a PDF, for those who may read its job. |

### `audit/rules`

Defined in `backend/src/http/routes/audit.console.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/audit/rules` | Audit | Audit(RULE_READ) | The requirement matrix: every rule version in force or being drafted. |
| GET | `/api/v1/audit/rules/coverage` | Audit | Audit(RULE_READ) | Rule coverage by real category: approved, waiting and unresolved rules, and categories that still need review. |
| GET | `/api/v1/audit/rules/:id` | Audit | Audit(RULE_READ) | One rule version, its other versions and its approval history. |
| POST | `/api/v1/audit/rules` | Audit | Audit(RULE_DRAFT) | Draft a new rule. It decides nothing until a supervisor who did not draft it approves it. |
| POST | `/api/v1/audit/rules/import-research` | Audit | Audit(RULE_DRAFT) | Load the dated regulatory research as draft rules, once. Codes already present are left alone. |
| PUT | `/api/v1/audit/rules/:id` | Audit | Audit(RULE_DRAFT) | Change a draft. |
| POST | `/api/v1/audit/rules/:id/submit` | Audit | Audit(RULE_DRAFT) | Send a draft for approval. |
| POST | `/api/v1/audit/rules/:id/approve` | Audit | Audit(RULE_APPROVE) | Approve a submitted rule (never one you drafted). Retires the version it replaces. |
| POST | `/api/v1/audit/rules/:id/reject` | Audit | Audit(RULE_APPROVE) | Reject a submitted rule, with what is wrong. |
| POST | `/api/v1/audit/rules/:id/revise` | Audit | Audit(RULE_DRAFT) | Draft a new version of a rule. |
| POST | `/api/v1/audit/rules/:id/retire` | Audit | Audit(RULE_APPROVE) | Withdraw a rule, with the reason. |

### `audit/safety-cases`

Defined in `backend/src/http/routes/commercial-policy.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/audit/safety-cases` | Audit | Audit(ASSESSMENT_READ) | Safety cases. |
| GET | `/api/v1/audit/safety-cases/:id` | Audit | Audit(ASSESSMENT_READ) | One safety case with its scope and actions. |
| GET | `/api/v1/audit/safety-cases/:id/trace` | Audit | Audit(ASSESSMENT_READ) | Trace what a case reaches: orders, customers, countries, unshipped orders, repeat orders, stock. |
| POST | `/api/v1/audit/safety-cases` | Audit | Audit(ASSESSMENT_WORK) | Open a safety case. |
| POST | `/api/v1/audit/safety-cases/:id/contain` | Audit | Audit(ASSESSMENT_WORK) | Triage and contain: stop listings, shipments and repeat orders in scope. |
| POST | `/api/v1/audit/safety-cases/:id/actions` | Audit | Audit(ASSESSMENT_WORK) | Record a reporting decision, notice, recall action or effectiveness check. |
| POST | `/api/v1/audit/safety-cases/:id/correction` | Audit | Audit(ASSESSMENT_WORK) | Record the cause, correction, tests and current certificates. |
| POST | `/api/v1/audit/safety-cases/:id/release` | Audit | Audit(RELEASE_REQUEST) | Human release (not by the person who opened the case). |

### `audit/seller-assessments`

Defined in `backend/src/http/routes/seller-assessment.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/audit/seller-assessments` | Audit | Audit(ASSESSMENT_READ) | The seller assessment queue: search, owner, stage, risk, overdue and expiry filters, with a count per status. |
| GET | `/api/v1/audit/seller-assessments/policies` | Audit | Audit(ASSESSMENT_READ) | Policy versions, the version in force, and the purchase-gate mode. |
| POST | `/api/v1/audit/seller-assessments/policies` | Audit | Audit(ASSESSMENT_WORK) | Draft a new policy version. Head of Seller Assurance; a version can only tighten the document's controls. |
| POST | `/api/v1/audit/seller-assessments/policies/:id/adopt` | Audit | Audit(ASSESSMENT_WORK) | Record adoption of a draft version: the authority's reference and the effective date. Never by its drafter. |
| POST | `/api/v1/audit/seller-assessments/policies/:id/disclose` | Audit | Audit(ASSESSMENT_WORK) | Record disclosure of an adopted version. Until disclosed, it is not in force. |
| GET | `/api/v1/audit/seller-assessments/capabilities` | Audit | Audit(ASSESSMENT_READ) | Who holds which assessment capability. |
| PUT | `/api/v1/audit/seller-assessments/capabilities/:id` | Audit | Audit(ASSESSMENT_WORK) | Grant or remove assessment capabilities for another staff member. Head of Seller Assurance only. |
| GET | `/api/v1/audit/seller-assessments/impact` | Audit | Audit(ASSESSMENT_READ) | What switching the purchase gate to enforce would block today, per seller. |
| POST | `/api/v1/audit/seller-assessments/legacy-reassessments` | Audit | Audit(ASSESSMENT_WORK) | Open a legacy reassessment for every seller approved under the earlier process. Nothing is converted into an approval. |
| GET | `/api/v1/audit/seller-assessments/registers` | Audit | Audit(ASSESSMENT_READ) | Notices, appeals, change requests, incidents and bank changes across every seller. |
| GET | `/api/v1/audit/seller-assessments/tasks` | Audit | Audit(ASSESSMENT_READ) | Surveillance and revalidation tasks, open and overdue by default. |
| POST | `/api/v1/audit/seller-assessments/tasks/:id/complete` | Audit | Audit(ASSESSMENT_WORK) | Complete a surveillance task with its outcome. A sanctions task is never completed by the software. |
| GET | `/api/v1/audit/seller-assessments/dispositions` | Audit | Audit(ASSESSMENT_READ) | Placed seller orders held for a safety and legal disposition. |
| POST | `/api/v1/audit/seller-assessments/dispositions/:id` | Audit | Audit(ASSESSMENT_WORK) | Record a disposition for a held seller order: release, keep holding, recommend cancellation, or recall. |
| GET | `/api/v1/audit/seller-assessments/retention` | Audit | Audit(ASSESSMENT_READ) | Evidence categories, files and legal holds, with the configured retention years per category. |
| POST | `/api/v1/audit/seller-assessments/evidence/:id/legal-hold` | Audit | Audit(ASSESSMENT_WORK) | Place or lift a legal hold on one evidence file. |
| POST | `/api/v1/audit/seller-assessments/appeals/:id/decision` | Audit | Audit(ASSESSMENT_WORK) | Decide an appeal. The reviewer must be uninvolved in the original decision; an appeal never restores selling. |
| POST | `/api/v1/audit/seller-assessments/changes/:id/decision` | Audit | Audit(ASSESSMENT_WORK) | Decide a seller's change request. A new product or country needs an extension assessment. |
| POST | `/api/v1/audit/seller-assessments/sellers/:id/undisclosed-changes` | Audit | Audit(ASSESSMENT_WORK) | Record a change the seller did not disclose. |
| POST | `/api/v1/audit/seller-assessments/incidents/:id/review` | Audit | Audit(ASSESSMENT_WORK) | Review an incident report. |
| POST | `/api/v1/audit/seller-assessments/bank-changes/:id` | Audit | Audit(ASSESSMENT_WORK) | One step of a bank-beneficiary change: confirm with the known contact, then two different Finance approvals. |
| POST | `/api/v1/audit/seller-assessments/approvals/:id/suspend` | Audit | Audit(ASSESSMENT_WORK) | Suspend, restrict or revoke a trading approval (all or named scope rows) with a full notice. Held orders get a disposition. |
| GET | `/api/v1/audit/seller-assessments/:id` | Audit | Audit(ASSESSMENT_READ) | One assessment in full: application, gates, checklist, score, scope matrix, findings, workpapers, certification, approvals and timeline. |
| GET | `/api/v1/audit/seller-assessments/:id/release-gaps` | Audit | Audit(ASSESSMENT_READ) | Everything that still blocks release, listed together. |
| GET | `/api/v1/audit/seller-assessments/:id/evidence/:evidenceId` | Audit | Audit(ASSESSMENT_READ) | Download one evidence file. Every view is recorded. |
| POST | `/api/v1/audit/seller-assessments/:id/evidence` | Audit | Audit(ASSESSMENT_WORK) | Attach a reviewer's evidence file (site photos, lab report, issuer confirmation). Stored privately, scanned, versioned. |
| POST | `/api/v1/audit/seller-assessments/:id/assign` | Audit | Audit(ASSESSMENT_WORK) | Name the assessment owner, the risk level and a reviewer per gate. Head of Seller Assurance. |
| POST | `/api/v1/audit/seller-assessments/:id/correction` | Audit | Audit(ASSESSMENT_WORK) | Return the application to the seller with corrections to make. Gate 1. |
| POST | `/api/v1/audit/seller-assessments/:id/accept-file` | Audit | Audit(ASSESSMENT_WORK) | Accept the complete file: Gate 1 passes, the review target starts, the scope matrix is laid out. |
| POST | `/api/v1/audit/seller-assessments/:id/gates/:gate` | Audit | Audit(ASSESSMENT_WORK) | Decide gate 2-7: passed, failed, in progress or correction requested. Prerequisites and the gate's own evidence are checked. |
| PUT | `/api/v1/audit/seller-assessments/:id/checklist/:code` | Audit | Audit(ASSESSMENT_WORK) | Review one applicant checklist item: Pass, Fail, or Not applicable with a reason; evidence, expiry and comment. |
| POST | `/api/v1/audit/seller-assessments/:id/checklist/:code/approve-na` | Audit | Audit(ASSESSMENT_WORK) | Approve a not-applicable item. A second person with the Head of Seller Assurance capability. |
| PUT | `/api/v1/audit/seller-assessments/:id/scores/:dimension` | Audit | Audit(ASSESSMENT_WORK) | Rate one scoring dimension 0-5 with its evidence and reasoning. |
| PUT | `/api/v1/audit/seller-assessments/:id/scope/:scopeId` | Audit | Audit(ASSESSMENT_WORK) | Classify one product x site x country x channel combination (Gate 3) and approve or block it. |
| POST | `/api/v1/audit/seller-assessments/:id/findings` | Audit | Audit(ASSESSMENT_WORK) | Raise a finding: critical, major or minor, with its requirement and evidence. A critical one records a hard stop. |
| POST | `/api/v1/audit/seller-assessments/findings/:id/close` | Audit | Audit(ASSESSMENT_WORK) | Close (on effectiveness evidence) or reopen a finding. Auditors only. |
| POST | `/api/v1/audit/seller-assessments/:id/workpapers` | Audit | Audit(ASSESSMENT_WORK) | Record a workpaper: site audit, sample plan and custody, lab competence, contract, mock order, identity, bank, sanctions, specialist review or AI output. |
| POST | `/api/v1/audit/seller-assessments/:id/hard-stops` | Audit | Audit(ASSESSMENT_WORK) | Record a hard stop. It blocks release whatever the score; there is no route that clears one. |
| POST | `/api/v1/audit/seller-assessments/:id/certifications` | Audit | Audit(ASSESSMENT_WORK) | Appoint the independent certification body the marketplace engages and pays (Gate 5). |
| PUT | `/api/v1/audit/seller-assessments/certifications/:id` | Audit | Audit(ASSESSMENT_WORK) | Record the certificate the body issued and how its authenticity was checked with the issuer. |
| POST | `/api/v1/audit/seller-assessments/certifications/:id/withdraw` | Audit | Audit(ASSESSMENT_WORK) | Record a withdrawal or suspension by the issuer. The purchase gate stops at once. |
| POST | `/api/v1/audit/seller-assessments/:id/decision` | Audit | Audit(ASSESSMENT_WORK) | Decline, send to remediation, or return to review after remediation. |
| POST | `/api/v1/audit/seller-assessments/:id/release` | Audit | Audit(ASSESSMENT_WORK) | Gate 8: independent release of exactly the named scope rows. Creates the trading approval and its PDF. |
| GET | `/api/v1/audit/seller-assessments/approvals/:id/pdf` | Audit | Audit(ASSESSMENT_READ) | The trading approval PDF. |

### `audit/seller-verification`

Defined in `backend/src/http/routes/audit.console.ts`, `backend/src/http/routes/shipment-assessment.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/audit/seller-verification` | Audit | Audit(SELLER_READ) | Seller applications a page at a time, oldest submission first, with a count per status. resubmitted=true is the queue of applications sent back after corrections. |
| GET | `/api/v1/audit/seller-verification/:id` | Audit | Audit(SELLER_READ) | One application in full: business details, documents, ownership and screenings, turnover, what approval is still waiting for, and the verification history with who decided each step. |
| POST | `/api/v1/audit/seller-verification/:id/decision` | Audit | Audit(SELLER_VERIFY) | Decide an application: take it for review, ask for corrections, approve or reject. A reason the seller sees is required to ask for corrections or reject; the version read is required so a decision made meanwhile is never overwritten. Approval still runs the evidence gate. |
| POST | `/api/v1/audit/seller-verification/:id/screening` | Audit | Audit(SELLER_VERIFY) | Record a manual sanctions / restricted-party screening of the business or one owner: which lists were checked, the result and a note. Always recorded as a person's check, never an automated one. |
| POST | `/api/v1/audit/seller-verification/:id/turnover/decision` | Audit | Audit(SELLER_VERIFY) | Verify or refuse the seller's current turnover declaration, with a reason the seller sees. Refused when the seller changed it, or another reviewer decided it, since it was loaded. Never approves the seller. |
| GET | `/api/v1/audit/seller-verification/documents/:id/file` | Audit | Audit(SELLER_READ) | One onboarding document's file, as an attachment. Scanned files only; every read is audited. |
| POST | `/api/v1/audit/seller-verification/documents/:id/decision` | Audit | Audit(SELLER_VERIFY) | Accept or refuse one onboarding document. A refusal needs a reason the seller sees; a document decided by somebody else meanwhile is refused with SELLER_STALE_VERSION. |
| GET | `/api/v1/audit/seller-verification/:id/certificates` | Audit | Audit(SELLER_READ) | A seller's verification certificates, newest first, with status. |
| POST | `/api/v1/audit/seller-verification/:id/certificates` | Audit | Audit(CERTIFICATE_ISSUE) | Issue a Seller Verification Certificate (a new version if one exists) after final approval, with an explicit scope. |
| GET | `/api/v1/audit/seller-verification/:id/certificates/:documentId` | Audit | Audit(SELLER_READ) | Download a seller verification certificate PDF. |

### `audit/sellers`

Defined in `backend/src/http/routes/audit.console.ts`, `backend/src/http/routes/shipment-assessment.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/audit/sellers` | Audit | Audit(SELLER_READ) | Sellers, with their qualification and document counts and their health rating; filter by band, sort by risk. |
| GET | `/api/v1/audit/sellers/:id` | Audit | Audit(SELLER_READ) | One seller: business identity (read-only), category qualifications, product cases and documents - kept apart. |
| GET | `/api/v1/audit/sellers/:id/badge` | Public |  | A seller's Audit badge and its history. |
| PUT | `/api/v1/audit/sellers/:id/badge` | Audit | Audit(SELLER_BADGE) | Set or clear a seller's Audit badge, with a reason. A downgrade withdraws unused waivers; an upgrade creates none. |

### `audit/shipment-assessments`

Defined in `backend/src/http/routes/shipment-assessment.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/audit/shipment-assessments` | Audit | Audit(SHIPMENT_READ) | The Shipment Assessment queues: one per status group, a count for each, search by assessment, order, seller order or seller. |
| GET | `/api/v1/audit/shipment-assessments/policy` | Audit | Audit(SHIPMENT_READ) | The badge policy in force and its earlier versions. |
| POST | `/api/v1/audit/shipment-assessments/policy` | Audit | Audit(SHIPMENT_POLICY) | Publish a new badge-policy version. Supervisors only; decisions keep the version they were made under. |
| GET | `/api/v1/audit/shipment-assessments/:id` | Audit | Audit(SHIPMENT_READ) | One case in full: overview, checklist rounds, evidence, findings, history, waivers, releases, exceptions and documents. |
| GET | `/api/v1/audit/shipment-assessments/:id/waiver-history` | Audit | Audit(SHIPMENT_WAIVE) | The seller history a waiver reviewer must look at: recent inspection results, earlier assessments, unresolved complaints. No score is computed. |
| POST | `/api/v1/audit/shipment-assessments/:id/rounds` | Audit | Audit(SHIPMENT_ASSESS) | Start a physical assessment round. Needs L1 handed over; a reassessment starts a new round and keeps the old one. |
| POST | `/api/v1/audit/shipment-assessments/:id/checks` | Audit | Audit(SHIPMENT_ASSESS) | Record checklist results: Pass, Fail, Hold / not verified, or N/A with a reason. Each item stands on its own. |
| PUT | `/api/v1/audit/shipment-assessments/:id/quantities` | Audit | Audit(SHIPMENT_ASSESS) | Record the round's quantities: ordered, declared, presented, counted, sampled, approved, packages, weights and methods. |
| POST | `/api/v1/audit/shipment-assessments/:id/evidence` | Audit | Audit(SHIPMENT_ASSESS) | Attach a photo or PDF to the assessment, optionally against one checklist item. Stored privately. |
| GET | `/api/v1/audit/shipment-assessments/:id/evidence/:evidenceId` | Audit | Audit(SHIPMENT_READ) | Download one evidence file of a case. |
| POST | `/api/v1/audit/shipment-assessments/:id/submit` | Audit | Audit(SHIPMENT_ASSESS) | Submit the round. Missing results, evidence or N/A reasons refuse it; any Fail or Hold blocks the whole shipment and issues a findings report. |
| POST | `/api/v1/audit/shipment-assessments/:id/qa` | Audit | Audit(SHIPMENT_QA) | QA: a second person approves (release + Shipment Assessment Certificate, with a dispatch deadline) or returns the round. |
| POST | `/api/v1/audit/shipment-assessments/:id/waiver-review` | Audit | Audit(SHIPMENT_WAIVE) | Move an eligible shipment into waiver review (for example after a badge upgrade). It does not waive anything. |
| POST | `/api/v1/audit/shipment-assessments/:id/waiver` | Audit | Audit(SHIPMENT_WAIVE) | Approve or reject a badge-based waiver. Gold needs a written review of the history shown; mandatory inspections can never be waived. |
| POST | `/api/v1/audit/shipment-assessments/:id/hold` | Audit | Audit(SHIPMENT_ASSESS) | Put the whole shipment on hold. Any unused release is withdrawn. |
| POST | `/api/v1/audit/shipment-assessments/:id/reassessment` | Audit | Audit(SHIPMENT_ASSESS) | Require corrective action and a new assessment round. Earlier rounds and reports are kept unchanged. |
| POST | `/api/v1/audit/shipment-assessments/exceptions/:id/resolve` | Audit | Audit(SHIPMENT_ASSESS) | Record what was done about a carrier-reported departure during a hold. The departure itself stays on record. |
| GET | `/api/v1/audit/shipment-assessments/:id/documents/:documentId` | Audit | Audit(SHIPMENT_READ) | Download a certificate, waiver or findings report PDF of a case. |

### `audit/sublot-releases`

Defined in `backend/src/http/routes/audit.console.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/audit/sublot-releases/:id/cancel` | Audit | Audit(RELEASE_REQUEST) | Cancel your own sub-lot request before it is used. |

### `audit/team`

Defined in `backend/src/http/routes/audit.console.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/audit/team` | Public |  | People: your agency's (any agency member), or every agency's and the audit team (audit staff). |

## Seller Hub

### `seller/access-reviews`

Defined in `backend/src/http/routes/seller.team.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/seller/access-reviews` | Seller | Seller(MEMBER_WRITE) | Record that you have reviewed who has access to the team. Audited. |

### `seller/action-queue`

Defined in `backend/src/http/routes/seller.operations.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/action-queue` | Seller | Seller | Your ranked to-do list: overdue first, then by deadline, then by what is at stake (ENH-018). |

### `seller/agreements`

Defined in `backend/src/http/routes/seller.account.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/seller/agreements` | Seller | Seller | Accept one of the marketplace's seller agreements at a given version, by typed name or drawn signature. Only the account owner may do this. The time, IP address and browser are kept as evidence. Writes an audit entry. |
| GET | `/api/v1/seller/agreements` | Seller | Seller | Every agreement the seller has accepted, newest first: which one, which version, by whom and when. |

### `seller/assessment`

Defined in `backend/src/http/routes/seller-assessment.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/assessment` | Seller | Seller(ACCOUNT_READ) | The seller's assessments, approvals and scope, notices and appeals, changes, incidents and bank changes. |
| POST | `/api/v1/seller/assessment` | Seller | Seller(ACCOUNT_WRITE) | Start an application, an extension, a renewal or a reassessment. Returns the open one if there is one. |
| PATCH | `/api/v1/seller/assessment/:id/application` | Seller | Seller(ACCOUNT_WRITE) | Save application sections (save and resume). Only while it is a draft or returned for correction. |
| POST | `/api/v1/seller/assessment/:id/evidence` | Seller | Seller(ACCOUNT_WRITE) | Upload an evidence file for the application or a finding. Scanned, stored privately, versioned. |
| GET | `/api/v1/seller/assessment/:id/evidence/:evidenceId` | Seller | Seller(ACCOUNT_READ) | Download a file this seller uploaded. |
| POST | `/api/v1/seller/assessment/:id/submit` | Seller | Seller(ACCOUNT_SUBMIT) | Submit the application. Gaps and ineligibility are listed, never hidden. |
| PUT | `/api/v1/seller/assessment/findings/:id` | Seller | Seller(ACCOUNT_WRITE) | Answer a finding: containment, root cause, corrective and preventive action, owner and evidence. Only an auditor closes it. |
| POST | `/api/v1/seller/assessment/notices/:id/appeal` | Seller | Seller(ACCOUNT_SUBMIT) | Appeal a notice within its window. |
| POST | `/api/v1/seller/assessment/changes` | Seller | Seller(ACCOUNT_WRITE) | Notify a change before making it: facility, entity, ownership, brand rights, subcontractor, materials, formulation, design, process, intended use, safety software, labels, country. |
| POST | `/api/v1/seller/assessment/incidents` | Seller | Seller(ACCOUNT_WRITE) | Report an incident. The deadline is the policy's hours or a shorter statutory one. |
| POST | `/api/v1/seller/assessment/bank-changes` | Seller | Seller(ACCOUNT_SUBMIT) | Ask to change the bank beneficiary. Verified by Finance through a known contact and approved by two people. |
| GET | `/api/v1/seller/assessment/approvals/:id/pdf` | Seller | Seller(ACCOUNT_READ) | The seller's own trading approval PDF. |

### `seller/audit`

Defined in `backend/src/http/routes/seller.account.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/audit` | Seller | Seller + Seller(AUDIT_READ) | The seller's own activity log, newest first: who did what, to what, and when. Shows a short summary of each change, not the full before-and-after. `resourceId` (and optionally `resourceType`) narrows it to one record's history, such as one listing. |

### `seller/audit-certificates`

Defined in `backend/src/http/routes/shipment-assessment.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/audit-certificates` | Seller | Seller(ORDER_READ) | This seller's verification certificates. |
| GET | `/api/v1/seller/audit-certificates/:id` | Seller | Seller(ORDER_READ) | Download one of this seller's verification certificates. |

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

### `seller/bulk-imports`

Defined in `backend/src/http/routes/seller.workbench.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/bulk-imports/template` | Seller | Seller + Seller(BULK_IMPORT) | The blank CSV template for a bulk listing update: the column headers only. |
| GET | `/api/v1/seller/bulk-imports` | Seller | Seller + Seller(BULK_IMPORT) | The seller's recent bulk updates, newest first, previews and applied runs alike. |
| POST | `/api/v1/seller/bulk-imports` | Seller | Seller + TradingSeller(BULK_IMPORT) | Upload a CSV or XLSX and check it against the seller's own listings. Changes nothing; returns the problems and the changes it would make. |
| GET | `/api/v1/seller/bulk-imports/:id` | Seller | Seller + Seller(BULK_IMPORT) | One bulk update: its counts, row problems and, for an unapplied preview, the changes it would make. |
| POST | `/api/v1/seller/bulk-imports/:id/apply` | Seller | Seller + TradingSeller(BULK_IMPORT) | Apply a checked preview. The file is re-checked first; any problem and nothing changes. A preview applies once. |

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

### `seller/certifications`

Defined in `backend/src/http/routes/seller.factories.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/certifications` | Public |  | The seller's certificates, with where each one's check stands and whether it expires soon. |
| POST | `/api/v1/seller/certifications` | Public |  | Add a certificate with the document that proves it. It goes straight to review. |
| PATCH | `/api/v1/seller/certifications/:id` | Public |  | Change a certificate. Refused while it is with a reviewer; a verified one goes back for review. |
| DELETE | `/api/v1/seller/certifications/:id` | Public |  | Archive a certificate so it is no longer shown. |
| POST | `/api/v1/seller/certifications/:id/submit` | Public |  | Send a refused or expired certificate for review again. |

### `seller/commercial`

Defined in `backend/src/http/routes/commercial-policy.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/commercial/fees` | Seller | Seller(FINANCE_READ) | My fees: commission reversals proposed for my orders, and my security schedules. |

### `seller/company-changes`

Defined in `backend/src/http/routes/seller.account.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/seller/company-changes` | Seller | Seller + Seller(ACCOUNT_WRITE) | Propose a change to verified company details after approval; staff approve or reject it. Withdraws an earlier pending request. Audited. |
| POST | `/api/v1/seller/company-changes/:id/withdraw` | Seller | Seller + Seller(ACCOUNT_WRITE) | Withdraw a company details change request nobody has decided yet. Audited. |

### `seller/company-details`

Defined in `backend/src/http/routes/seller.account.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/company-details` | Seller | Seller | The verified company details on file, whether they are change-controlled, the pending change request and past decisions. |

### `seller/compliance`

Defined in `backend/src/http/routes/seller.compliance.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/compliance` | Seller | Seller(ACCOUNT_READ) | Your compliance at a glance: qualification and product cases, documents, and - for each category you sell in - whether an approved requirement reaches it and whether you are qualified. |
| GET | `/api/v1/seller/compliance/requirements` | Seller | Seller(ACCOUNT_READ) | The approved requirements that apply in one category, so a seller knows what to provide. Drafts are never shown. |
| POST | `/api/v1/seller/compliance/cases` | Seller | Seller(ACCOUNT_SUBMIT) | Ask for a qualification (a category, role and market) or a product compliance review. Asking twice returns the same case. |
| GET | `/api/v1/seller/compliance/cases/:id` | Seller | Seller(ACCOUNT_READ) | One of your cases: what applies, what is satisfied, what is missing, and what the reviewer said. |
| POST | `/api/v1/seller/compliance/cases/:id/respond` | Seller | Seller(ACCOUNT_SUBMIT) | Answer a request for changes (after adding the documents asked for), or withdraw the case. |
| POST | `/api/v1/seller/compliance/documents` | Seller | Seller(ACCOUNT_WRITE) | Add a compliance document - a certificate, licence, registration, declaration, test report or authorisation - with its scope and dates. |
| GET | `/api/v1/seller/compliance/documents/:id` | Seller | Seller(ACCOUNT_READ) | One of your documents with its versions and the reviewer's messages to you. |
| POST | `/api/v1/seller/compliance/documents/:id/submit` | Seller | Seller(ACCOUNT_SUBMIT) | Send a draft, a returned or an expired document for review. |

### `seller/consignments`

Defined in `backend/src/http/routes/seller.operations.ts`, `backend/src/http/routes/seller.documents.ts`, `backend/src/http/routes/seller.shipment-paperwork.ts`.

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
| GET | `/api/v1/seller/consignments/:id/booking` | Seller | Seller(ORDER_READ) | The booking of one consignment: mode, Incoterm, ports, pickup date and window, and who carries it. |
| GET | `/api/v1/seller/consignments/:id/freight-options` | Seller | Seller(ORDER_READ) | The operator's rate cards that can carry one consignment today: route, mode, carrier, transit, price and validity dates. |
| PUT | `/api/v1/seller/consignments/:id/booking` | Seller | TradingSeller(ORDER_FULFIL) | Book a consignment: store its mode, Incoterm, ports, pickup and cargo insurance, and record a hand booking with DHL, FedEx or India Post when one is named. |

### `seller/dashboard`

Defined in `backend/src/http/routes/seller.operations.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/dashboard` | Seller | Seller | No cache header, ever. |

### `seller/disputes`

Defined in `backend/src/http/routes/commercial-policy.ts`, `backend/src/http/routes/disputes.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/disputes/:reference/case-controls` | Seller | Seller(ORDER_READ) | Case requests addressed to me on one of my disputes. |
| POST | `/api/v1/seller/disputes/:reference/case-controls/evidence-requests/:requestId` | Seller | Seller(RETURN_HANDLE) | Answer an evidence request addressed to me. |
| GET | `/api/v1/seller/disputes` | Seller | Seller(ORDER_READ) | Claims on this seller's goods, most recently active first. |
| GET | `/api/v1/seller/disputes/:reference` | Seller | Seller(ORDER_READ) | One claim on this seller's goods, with the buyer's evidence and the thread. |
| POST | `/api/v1/seller/disputes/:reference/response` | Seller | Seller(ORDER_READ) | Answer a claim: your account and, optionally, what you offer. Moves it to the marketplace's review. |
| POST | `/api/v1/seller/disputes/:reference/messages` | Seller | Seller(ORDER_READ) | Write on a claim. The buyer and the marketplace see it. Needs an Idempotency-Key. |
| POST | `/api/v1/seller/disputes/:reference/appeal` | Seller | Seller(ORDER_READ) | Appeal the decision on a claim, once, inside the appeal window. |
| POST | `/api/v1/seller/disputes/:reference/attachments` | Seller | Seller(ORDER_READ) | Attach counter-evidence: one image, video or PDF, scanned and stored privately. |
| POST | `/api/v1/seller/disputes/:reference/attachments/:attachmentId/link` | Seller | Seller(ORDER_READ) | A download link for one file on a claim: five minutes, single use, this session only. |
| GET | `/api/v1/seller/disputes/:reference/attachments/:attachmentId/download` | Seller | Seller(ORDER_READ) | Redeem a download link. Served as a download, never inline. |

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

### `seller/factories`

Defined in `backend/src/http/routes/seller.factories.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/factories` | Public |  | The seller's factories, with machines, evidence and where each one's verification stands. |
| POST | `/api/v1/seller/factories` | Public |  | Record a factory: address, capacity, workforce, quality control. Writes an entry in the seller's activity log. |
| PATCH | `/api/v1/seller/factories/:id` | Public |  | Change a factory's details. Refused while it is with a reviewer; a change to a verified factory's facts sends it back for review. Writes an entry in the seller's activity log. |
| DELETE | `/api/v1/seller/factories/:id` | Public |  | Archive a factory so it is no longer shown. Its history of checks is kept. |
| PUT | `/api/v1/seller/factories/:id/machines` | Public |  | Replace the list of machines in a factory. On a verified factory this sends it back for review. |
| POST | `/api/v1/seller/factories/:id/evidence` | Public |  | Attach one of the seller's own documents to a factory as evidence, optionally with where it was taken. |
| DELETE | `/api/v1/seller/factories/:id/evidence/:evidenceId` | Public |  | Detach a piece of evidence from a factory. On a verified factory this sends it back for review. |
| POST | `/api/v1/seller/factories/:id/submit` | Public |  | Send a factory for verification: the first time, after a refusal, or after it expired. Needs evidence. |

### `seller/finance`

Defined in `backend/src/http/routes/finance.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/finance/balances` | Seller | Seller(FINANCE_READ) | The seller's receivables: gross, fees, refunds, held, reserve, available, in transit and paid out. |
| GET | `/api/v1/seller/finance/holds` | Seller | Seller(FINANCE_READ) | The seller's held funds per order, with each release condition and the payout that carried it. |
| GET | `/api/v1/seller/finance/fee-rules` | Seller | Seller(FINANCE_READ) | The published fee rules that can change this seller's fee, live now or starting later; read-only. |

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

### `seller/inspection`

Defined in `backend/src/http/routes/inspection.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/inspection/orders/:id` | Seller | Seller(ORDER_READ) | The inspection on one of your orders: requirement, jobs, report, NCRs and release. |
| POST | `/api/v1/seller/inspection/jobs/:id/readiness` | Seller | Seller(ORDER_FULFIL) | Declare the lot ready: location, packing state, contact and a signed declaration. |
| POST | `/api/v1/seller/inspection/defects/:id/capa` | Seller | Seller(ORDER_FULFIL) | Answer an NCR with a corrective action (CAPA). |
| POST | `/api/v1/seller/inspection/jobs/:id/evidence` | Seller | Seller(ORDER_FULFIL) | Upload readiness or corrective evidence (packing list, photos). The approved report itself cannot be edited. |
| GET | `/api/v1/seller/inspection/reports/:id/pdf` | Seller | Seller(ORDER_READ) | Download one evidence file on your order. Download a signed inspection report on one of your own orders, as a PDF. |
| GET | `/api/v1/seller/inspection/evidence/:id` | Seller | Seller(ORDER_READ) | *Read one evidence.* |

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

### `seller/invitations`

Defined in `backend/src/http/routes/seller.team.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/seller/invitations` | Seller | Seller(MEMBER_WRITE) | Invite somebody by email in one role. Never Owner, and never a role carrying more than your own. |
| POST | `/api/v1/seller/invitations/:invitationId/resend` | Seller | Seller(MEMBER_WRITE) | Send an invitation again with a new link and a new expiry; the old link stops working. |
| DELETE | `/api/v1/seller/invitations/:invitationId` | Seller | Seller(MEMBER_WRITE) | Withdraw an invitation nobody has accepted yet. |

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

### `seller/kyb`

Defined in `backend/src/http/routes/seller.account.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/kyb` | Seller | Seller + Seller(ACCOUNT_WRITE) | The ownership, registrations and exports section of the application, and what it still needs. |
| PUT | `/api/v1/seller/kyb` | Seller | Seller + Seller(ACCOUNT_WRITE) | Save the whole ownership, registrations and exports section. Refused once the application is under review. Writes an audit entry that names what changed, never a value. |

### `seller/listing-drafts`

Defined in `backend/src/http/routes/seller.listings.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/listing-drafts` | Seller | Seller(LISTING_READ) | One page of the seller's listings still in the wizard or in review, filterable by status, text, category and brand. |
| POST | `/api/v1/seller/listing-drafts` | Seller | Seller(LISTING_READ) + TradingSeller(LISTING_WRITE) | Start a new listing in the wizard, optionally with its category, brand or matching catalogue product already chosen. Writes an audit entry. |
| GET | `/api/v1/seller/listing-drafts/:id/content` | Seller | Seller(LISTING_READ) | One listing in the wizard, with everything entered so far. A listing's description sections, grouped specifications and per-variant values. |
| PUT | `/api/v1/seller/listing-drafts/:id/content` | Seller | Seller(LISTING_READ) + TradingSeller(LISTING_WRITE) | Replace a listing's description sections, specifications and per-variant values. |
| GET | `/api/v1/seller/listing-drafts/:id` | Seller | Seller(LISTING_READ) | *Read one listing draft.* |
| PATCH | `/api/v1/seller/listing-drafts/:id` | Seller | Seller(LISTING_READ) + TradingSeller(LISTING_WRITE) | Autosave. |
| POST | `/api/v1/seller/listing-drafts/:id/variants/generate` | Seller | Seller(LISTING_READ) + TradingSeller(LISTING_WRITE) | Build the combination rows for the axes the seller switched on. |
| POST | `/api/v1/seller/listing-drafts/:id/validate` | Seller | Seller(LISTING_READ) | Re-run every check on a wizard listing and return what is still missing or wrong. Its status moves to match: ready to submit once everything passes. |
| POST | `/api/v1/seller/listing-drafts/:id/preview-title` | Seller | Seller(LISTING_READ) | What the title will be, and which fields made it. |
| POST | `/api/v1/seller/listing-drafts/:id/submit` | Seller | Seller(LISTING_READ) + TradingSeller(LISTING_SUBMIT) | Send a finished listing to the marketplace's quality review. Refused, with each blocking problem listed, if anything is still missing. It goes on sale only once a moderator approves it. Writes an audit entry. |
| POST | `/api/v1/seller/listing-drafts/:id/appeal` | Seller | Seller(LISTING_READ) + Seller(LISTING_SUBMIT) | Appeal a refused listing, saying why. A different moderator from the one who refused it decides. Writes an audit entry. |
| POST | `/api/v1/seller/listing-drafts/:id/withdraw` | Seller | Seller(LISTING_READ) + Seller(LISTING_SUBMIT) | Take a listing back out of the review queue and return it to the wizard, before a moderator has decided on it. Writes an audit entry. |
| GET | `/api/v1/seller/listing-drafts/:id/media` | Seller | Seller(LISTING_READ) | The photos and videos uploaded to a listing in the wizard. |
| POST | `/api/v1/seller/listing-drafts/:id/media` | Seller | Seller(LISTING_READ) + TradingSeller(MEDIA_UPLOAD) | Upload one photograph or video. |
| PATCH | `/api/v1/seller/listing-drafts/:id/media/:mediaId` | Seller | Seller(LISTING_READ) + TradingSeller(MEDIA_UPLOAD) | Change a wizard photo or video's slot, description, order, or whether it is the main picture. Making one the main picture clears it from the others; a video cannot be the main picture. |
| DELETE | `/api/v1/seller/listing-drafts/:id/media/:mediaId` | Seller | Seller(LISTING_READ) + TradingSeller(MEDIA_UPLOAD) | Delete a photo or video from a wizard listing, including the stored file. If it was the main picture, another photo takes its place. |

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
| GET | `/api/v1/seller/listings/:id/sourcing` | Seller | Seller(LISTING_READ) | Sourcing terms on one of your listings: samples, lead time, OEM/private label, Incoterms, linked certificates. |
| PUT | `/api/v1/seller/listings/:id/sourcing` | Seller | Seller(LISTING_READ) + Seller(LISTING_WRITE) | Replace the sourcing terms on one of your listings. Only your own verified, in-date certificates can be linked. |
| GET | `/api/v1/seller/listings/:id/market-eligibility` | Seller | Seller(LISTING_READ) | Where one of your listings may be sold: country rules in force with their reasons, compliance holds and status. |
| GET | `/api/v1/seller/listings/:id` | Seller | Seller(LISTING_READ) | One of the seller's listings in full, for its detail screen. |
| PATCH | `/api/v1/seller/listings/:id/status` | Seller | Seller(LISTING_READ) + Seller(OFFER_PUBLISH) | Put a listing on sale, pause it (with an optional private note) or archive it. Putting it back on sale is refused while the marketplace has flagged it as needing changes. Writes an audit entry. |
| PATCH | `/api/v1/seller/listings/:id/price` | Seller | Seller(LISTING_READ) + TradingSeller(OFFER_PRICE_WRITE) | Change a listing's price, "was" price, order quantity limits and simple quantity discounts. Needs the pricing permission and writes an audit entry, so a disputed price change can be traced to who made it and when. |
| GET | `/api/v1/seller/listings/:id/variants` | Seller | Seller(LISTING_READ) | Versions on a listing that already exists. |
| GET | `/api/v1/seller/listings/:id/instructions` | Seller | Seller(LISTING_READ) | Instructions shoppers have left on the product behind this listing. |
| POST | `/api/v1/seller/listings/:id/variants/preview` | Seller | Seller(LISTING_READ) + Seller(LISTING_WRITE) | Show which versions (for example sizes or colours) a set of options would produce on an existing listing, marking the ones already on sale. Creates nothing. |
| POST | `/api/v1/seller/listings/:id/variants` | Seller | Seller(LISTING_READ) + TradingSeller(LISTING_WRITE) | Add new versions to an existing listing as real, sellable items, each with its own price and opening stock. Versions already on sale are skipped, so sending the same request twice adds nothing. Writes an audit entry. |
| GET | `/api/v1/seller/listings/:id/edit` | Seller | Seller(LISTING_READ) | Editing a listing that already exists. |
| POST | `/api/v1/seller/listings/:id/pause-for-edit` | Seller | Seller(LISTING_READ) + TradingSeller(OFFER_PUBLISH) | Take a live listing off sale so its structure can be edited, recording that it was paused for editing. Does nothing if it is already paused. Writes an audit entry. |
| PATCH | `/api/v1/seller/listings/:id/edit` | Seller | Seller(LISTING_READ) + TradingSeller(LISTING_WRITE) | Save an edit to an existing listing - terms, versions and their stock - all at once, then leave it paused or put it back on sale. Structural changes are refused while the listing is on sale, and so is an edit made from an out-of- date copy. Writes an audit entry. |
| POST | `/api/v1/seller/listings/:id/photos` | Seller | Seller(LISTING_READ) + TradingSeller(MEDIA_UPLOAD) | The photographs on a listing the seller is editing. |
| PATCH | `/api/v1/seller/listings/:id/photos/:mediaId` | Seller | Seller(LISTING_READ) + TradingSeller(MEDIA_UPLOAD) | Make one of a listing's photos the one buyers see first. Writes an audit entry. |
| DELETE | `/api/v1/seller/listings/:id/photos/:mediaId` | Seller | Seller(LISTING_READ) + TradingSeller(MEDIA_UPLOAD) | Take a photo off a listing. The picture file itself is kept, since other listings may use it. Writes an audit entry. |
| POST | `/api/v1/seller/listings/:id/duplicate` | Seller | Seller(LISTING_READ) + TradingSeller(LISTING_WRITE) | Copy a listing into a new listing draft under a new SKU: category, brand and commercial terms carried over, stock not. Answers with the draft id; the copy goes through review like any new listing. Writes an audit entry. |

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
| PATCH | `/api/v1/seller/members/:memberId` | Seller | Seller + Seller(MEMBER_WRITE) | Change a team member's role. Refused if it would leave the business with no owner, would grant a role the person making the change does not hold, or touches yourself or somebody holding more than you. Writes an audit entry. |
| DELETE | `/api/v1/seller/members/:memberId` | Seller | Seller + Seller(MEMBER_WRITE) | Remove someone from the seller's team. Their past actions still show their name. Removing the last owner, yourself, or somebody holding more than you is refused. Writes an audit entry. |

### `seller/messages`

Defined in `backend/src/http/routes/messages.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/seller/messages/reports` | Seller | Seller(ORDER_READ) | Report a message from a buyer as abusive. Staff review it; a repeat finds the first report. |
| POST | `/api/v1/seller/messages/translate` | Seller | Seller(ORDER_READ) | Translate one message in your RFQ or order threads into your language. Off unless switched on. |

### `seller/new-id`

Defined in `backend/src/http/routes/seller.account.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/new-id` | Seller | Seller | An idempotency-safe id the client can use for a draft it is about to create. |

### `seller/notification-preferences`

Defined in `backend/src/http/routes/seller.operations.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/notification-preferences` | Seller | Seller | Which Seller Hub notification families you see. Essential ones and open problems are always shown. |
| PUT | `/api/v1/seller/notification-preferences` | Seller | Seller | Replace the Seller Hub families you muted. Only your own feed changes; audited. |

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
| PUT | `/api/v1/seller/offers/:id/packaging/profile` | Seller | Seller(LISTING_READ) + TradingSeller(LISTING_WRITE) | Save the name of a listing's base unit and the seller's packaging notes. |
| PUT | `/api/v1/seller/offers/:id/packaging/options` | Seller | Seller(LISTING_READ) + TradingSeller(LISTING_WRITE) | Save one bulk packaging option for a listing - a carton, a UK or US pallet, or a container - with its contents, size, weight, price and order limits. Writes an audit entry. |
| GET | `/api/v1/seller/offers/:id/container-loading` | Seller | Seller(LISTING_READ) + Seller(LISTING_READ) | How many pieces of a listing fit in a 20-ft and a 40-ft container: the carton, the cartons per container, the resulting pieces, whether each size is seller-verified or only an estimate, and the configured payload limits. |
| POST | `/api/v1/seller/offers/:id/container-loading/preview` | Seller | Seller(LISTING_READ) + Seller(LISTING_READ) | Work out a container loading without saving it - pieces per container, payload, the share of the container used, the system's estimate, and any problem - for the form while the seller types. |
| PUT | `/api/v1/seller/offers/:id/container-loading` | Seller | Seller(LISTING_READ) + TradingSeller(LISTING_WRITE) | Save how many pieces of a listing fit in a 20-ft and a 40-ft container. Refused when heavier than the configured payload or larger than the container. A changed figure must be verified again before buyers can order in that container. Existing preorders keep their own snapshot. Writes an audit entry. |
| POST | `/api/v1/seller/offers/:id/packaging/options/:packageType/enabled` | Seller | Seller(LISTING_READ) + TradingSeller(LISTING_WRITE) | Switch buying by one package type on or off for a listing, keeping what was entered for it. Writes an audit entry. |
| GET | `/api/v1/seller/offers/:id/packaging/preview` | Seller | Seller(LISTING_READ) + Seller(LISTING_READ) | "What would N of these come to?" |
| GET | `/api/v1/seller/offers/:id/trade-codes` | Seller | Seller(LISTING_READ) | The HSN (customs) code and country of origin saved on one of the seller's listings. |
| PUT | `/api/v1/seller/offers/:id/trade-codes` | Seller | Seller(LISTING_WRITE) | Save the HSN (customs) code and country of origin on one of the seller's listings, which its invoices print. Writes an entry in the seller's activity log. |
| GET | `/api/v1/seller/offers/:id/quantity-tiers` | Seller | Seller(LISTING_READ) | Show a listing's quantity price bands ("buy 100 or more, pay less"), beside its normal price and the saving each band gives. |
| PUT | `/api/v1/seller/offers/:id/quantity-tiers` | Seller | TradingSeller(LISTING_WRITE) | Replace all of a listing's quantity price bands in one go. Refused if the bands overlap or contradict each other or the normal price. Writes an audit entry. |

### `seller/onboarding`

Defined in `backend/src/http/routes/seller.account.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/onboarding` | Seller | Seller | The onboarding checklist: every step, its state, and what it still needs. |
| GET | `/api/v1/seller/onboarding/requirements` | Seller | Seller | The fields this seller's country and kind demand, for a single step. |

### `seller/orders`

Defined in `backend/src/http/routes/shipment-assessment.ts`, `backend/src/http/routes/commercial-policy.ts`, `backend/src/http/routes/messages.ts`, `backend/src/http/routes/seller.operations.ts`, `backend/src/http/routes/seller.workbench.ts`, `backend/src/http/routes/seller.logistics.ts`, `backend/src/http/routes/seller.documents.ts`, `backend/src/http/routes/seller.shipment-paperwork.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/orders/:id/shipment-assessment` | Seller | Seller(ORDER_READ) | The assessment of one of this seller's orders, if it has one yet. |
| GET | `/api/v1/seller/orders/:id/controls` | Seller | Seller(ORDER_READ) | My order's acceptance controls and frozen terms (commission rate, base, rule version, rounding). |
| PATCH | `/api/v1/seller/orders/:id/controls` | Seller | Seller(ORDER_FULFIL) | Record missing acceptance controls while my order is NEW. |
| GET | `/api/v1/seller/orders/:id/dispatch-controls` | Seller | Seller(ORDER_READ) | My order's dispatch controls and the gate's open gaps. |
| PUT | `/api/v1/seller/orders/:id/freight-booking` | Seller | Seller(ORDER_FULFIL) | Record a freight booking for my order. |
| PUT | `/api/v1/seller/orders/:id/dispatch-evidence` | Seller | Seller(ORDER_FULFIL) | Record dispatch evidence for my order. |
| POST | `/api/v1/seller/orders/:id/custody-handovers` | Seller | Seller(ORDER_FULFIL) | Record a custody handover for my order. |
| GET | `/api/v1/seller/orders/:id/messages` | Seller | Seller(ORDER_READ) | The buyer's and your messages about one of your orders, oldest first; `?after=` for only new ones. |
| POST | `/api/v1/seller/orders/:id/messages` | Seller | TradingSeller(ORDER_READ) | Write to the buyer about one of your orders. A resend with the same clientMessageId is not a second message. |
| GET | `/api/v1/seller/orders` | Seller | Seller + Seller(ORDER_READ) | One page of the seller's orders. Can be filtered by status, a search, dispatch place, or only those past their dispatch deadline. |
| GET | `/api/v1/seller/orders/:id` | Seller | Seller + Seller(ORDER_READ) | One of the seller's orders in full: the items they are shipping and where to. The buyer's email, phone and payment details are not included. |
| PATCH | `/api/v1/seller/orders/:id/status` | Seller | Seller + TradingSeller(ORDER_READ) | Move one of the seller's orders to its next stage, such as accepted, packing, ready or cancelled. Only allowed moves are accepted; cancelling needs the cancel permission and releases the stock the order was holding. Writes an audit entry. |
| POST | `/api/v1/seller/orders/:id/shipments` | Seller | Seller + TradingSeller(ORDER_FULFIL) | Record that some or all of an order has been sent, with the carrier and tracking number. The order counts as shipped only once every item has gone, and sending more than is left is refused. Writes an audit entry. |
| POST | `/api/v1/seller/orders/:id/consignments` | Seller | Seller + TradingSeller(ORDER_FULFIL) | Raise the consignment a confirmed order is missing. Idempotent. |
| POST | `/api/v1/seller/orders/:id/freight-quote` | Seller | Seller + Seller(ORDER_FULFIL) | Raise a request for one consignment. |
| GET | `/api/v1/seller/orders/:id/freight` | Seller | Seller + Seller(ORDER_READ) | Whether this consignment can go by carrier at all, or needs quoting. |
| GET | `/api/v1/seller/orders/:id/production` | Seller | Seller + Seller(ORDER_READ) | Production milestones and exceptions on one of the seller's orders, with the next stage that can be recorded. |
| POST | `/api/v1/seller/orders/:id/production/milestones` | Seller | Seller + TradingSeller(ORDER_FULFIL) | Record that a production stage is done. Stages go in order and none can be skipped. Never changes the order's status. |
| POST | `/api/v1/seller/orders/:id/production/plan` | Seller | Seller + TradingSeller(ORDER_FULFIL) | Set the date a production stage is expected. The buyer is told the date. |
| POST | `/api/v1/seller/orders/:id/production/delays` | Seller | Seller + TradingSeller(ORDER_FULFIL) | Raise a production exception with a reason and a revised date. The buyer sees the reason, the date and the seller's message, never the internal detail. |
| POST | `/api/v1/seller/orders/:id/production/delays/:delayId/resolve` | Seller | Seller + TradingSeller(ORDER_FULFIL) | Resolve an open production exception. The note is shown to the buyer. |
| GET | `/api/v1/seller/orders/:id/legs` | Seller | Seller(ORDER_READ) | The four delivery stages of one of the seller's confirmed orders, with who carries each and how far it has got. |
| POST | `/api/v1/seller/orders/:id/legs/:level/assign` | Seller | TradingSeller(ORDER_FULFIL) | Name the carrier for one of the seller's own delivery stages on an order: a carrier booked by hand or a delivery company on the platform. Changing the carrier after one is named needs a reason, and the company that loses the work is told. |
| PATCH | `/api/v1/seller/orders/:id/legs/:level` | Seller | TradingSeller(ORDER_FULFIL) | Enter the tracking number, pickup reference and expected dates on a delivery stage that already has a carrier. |
| POST | `/api/v1/seller/orders/:id/legs/:level/transition` | Seller | TradingSeller(ORDER_FULFIL) | Move one of the seller's delivery stages on an order forward: accepted, started or handed over. A stage can start only once the one before it has been handed over. |
| GET | `/api/v1/seller/orders/:id/documents` | Public |  | Every consignment of one of the seller's orders, with its packages, invoices and packing lists. |
| GET | `/api/v1/seller/orders/:id/trade-documents` | Seller | Seller(ORDER_READ) | The certificate of origin, waybills and other trade documents of one seller order, with what the destination and category rules require. |
| POST | `/api/v1/seller/orders/:id/trade-documents` | Seller | TradingSeller(ORDER_FULFIL) | Record a new version of a trade document by its number only (a waybill, a shipping bill), with issuer and dates. |
| POST | `/api/v1/seller/orders/:id/trade-documents/upload` | Seller | TradingSeller(ORDER_FULFIL) | Upload a new version of a trade document as a PDF or image, with its kind, issuer, number and dates as form fields. |
| POST | `/api/v1/seller/orders/:id/trade-documents/certificate-of-origin` | Seller | TradingSeller(ORDER_FULFIL) | Generate a certificate of origin draft PDF from the order, for an issuing authority to certify. |

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

### `seller/performance`

Defined in `backend/src/http/routes/seller.operations.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/performance` | Seller | Seller + Seller(ANALYTICS_READ) | Your performance over 30, 90 or 365 days: RFQ conversion, OTIF delivery, quality, cancellations and claims. |

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
| POST | `/api/v1/seller/preorders/:id/availability-proposal/preview` | Seller | Seller(ORDER_READ) | Check a revised-date or split-delivery proposal without sending it: live available stock, the schedule with container equivalents, the stock it would hold, and the full price with tax and delivery. |
| POST | `/api/v1/seller/preorders/:id/availability-proposal` | Seller | TradingSeller(ORDER_FULFIL) | Answer a preorder for more than is available: the complete quantity on a revised date, or a split delivery with what is available first. The buyer must accept before anything is reserved, ordered or charged. Emails the buyer and writes an audit entry. |
| POST | `/api/v1/seller/preorders/:id/reject` | Seller | TradingSeller(ORDER_FULFIL) | Turn down a preorder with a reason. Releases any capacity it was holding, withdraws open offers, emails the buyer and writes an audit entry. |
| POST | `/api/v1/seller/preorders/:id/start-production` | Seller | TradingSeller(ORDER_FULFIL) | Mark a confirmed preorder as in production, with an optional note. Emails the buyer and writes an audit entry. |
| POST | `/api/v1/seller/preorders/:id/ready` | Seller | TradingSeller(ORDER_FULFIL) | Mark a preorder as made and ready to ship, with an optional note. Emails the buyer and writes an audit entry. |

### `seller/product-reviews`

Defined in `backend/src/http/routes/product-reviews.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/product-reviews` | Seller | Seller(ORDER_READ) | Reviews of goods you sold, newest first, with your service score and your answers. |
| PUT | `/api/v1/seller/product-reviews/:reviewId/response` | Seller | TradingSeller(ORDER_READ) | Write or replace your public answer under a review of your sale, up to 1000 characters. Audited. |

### `seller/returns`

Defined in `backend/src/http/routes/commercial-policy.ts`, `backend/src/http/routes/returns.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| PUT | `/api/v1/seller/returns/:id/authorization` | Seller | Seller(RETURN_HANDLE) | Issue a return authorisation for one of my returns. |
| PATCH | `/api/v1/seller/returns/:id/authorization` | Seller | Seller(RETURN_HANDLE) | Record receipt and inspection evidence for one of my returns. |
| GET | `/api/v1/seller/returns/:id/authorization` | Seller | Seller(ORDER_READ) | My return's authorisation. |
| GET | `/api/v1/seller/returns` | Seller | Seller + Seller(ORDER_READ) | Returns of your goods, newest first. Filter by status (OPEN for everything still being worked). |
| GET | `/api/v1/seller/returns/:id` | Seller | Seller + Seller(ORDER_READ) | One return of your goods, with the buyer's reason and photos. Another seller's answers "not found". |
| POST | `/api/v1/seller/returns/:id/response` | Seller | Seller + Seller(RETURN_HANDLE) | Accept or contest a return (contesting needs a note), optionally with how the goods should come back. |
| POST | `/api/v1/seller/returns/:id/instructions` | Seller | Seller + Seller(RETURN_HANDLE) | Write how the goods should come back to you. The buyer is emailed once the return is approved. |
| POST | `/api/v1/seller/returns/:id/labels` | Seller | Seller + Seller(RETURN_HANDLE) | Attach a return label you made at your carrier (PDF or image) to an approved return. |
| POST | `/api/v1/seller/returns/:id/receive` | Seller | Seller + Seller(RETURN_HANDLE) | The goods have arrived back with you. |
| POST | `/api/v1/seller/returns/:id/inspect` | Seller | Seller + Seller(RETURN_HANDLE) | Record how many units came back sellable and how many damaged. Adjust your own stock in Inventory. |
| POST | `/api/v1/seller/returns/:id/files/:fileId/link` | Seller | Seller + Seller(ORDER_READ) | A five-minute, single-use link to one file of a return of your goods. |
| GET | `/api/v1/seller/returns/:id/files/:fileId/download` | Seller | Seller + Seller(ORDER_READ) | Download a file of a return of your goods with a link from the route above. |

### `seller/rfqs`

Defined in `backend/src/http/routes/rfq.seller.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/rfqs` | Seller | Feature + Seller(ORDER_READ) | Requests for quotation this seller was asked to answer, with a count per filter. |
| GET | `/api/v1/seller/rfqs/assignees` | Seller | Feature + Seller(ORDER_READ) | The team members a request can be given to: everyone on this seller's team now. |
| POST | `/api/v1/seller/rfqs/:id/hide` | Seller | Feature + Seller(ORDER_READ) | Hide a request from this seller's inbox as not for them. Their view only; the buyer sees no change. Audited. |
| POST | `/api/v1/seller/rfqs/:id/unhide` | Seller | Feature + Seller(ORDER_READ) | Bring a hidden request back to this seller's inbox. Audited. |
| POST | `/api/v1/seller/rfqs/:id/assign` | Seller | Feature + Seller(ORDER_FULFIL) | Give a request to one member of the team as its owner, or to nobody (memberId null). Audited. |
| GET | `/api/v1/seller/rfqs/:id` | Seller | Feature + Seller(ORDER_READ) | One request this seller was invited to. Opening it marks the invitation viewed. |
| POST | `/api/v1/seller/rfqs/:id/decline` | Seller | Feature + TradingSeller(ORDER_FULFIL) | Decline to quote, with a reason the buyer reads. Writes an audit entry. |
| GET | `/api/v1/seller/rfqs/:id/messages` | Seller | Feature + Seller(ORDER_READ) | This seller's questions and the buyer's answers, oldest first; `?after=` for only new ones. |
| POST | `/api/v1/seller/rfqs/:id/messages` | Seller | Feature + TradingSeller(ORDER_FULFIL) | Ask the buyer a question. A resend with the same clientMessageId is not a second message. |
| POST | `/api/v1/seller/rfqs/:id/quotes` | Seller | Feature + TradingSeller(ORDER_FULFIL) | Quote on a request: a unit price, optional tiers and the commercial terms, with files uploaded first. One quote per seller; before the deadline only. Tells the buyer and writes an audit entry. |
| GET | `/api/v1/seller/rfqs/:id/quote` | Seller | Feature + Seller(ORDER_READ) | This seller's own quote on the request, with every offer version; null before it quoted. |
| POST | `/api/v1/seller/rfqs/:id/quote/offers` | Seller | Feature + TradingSeller(ORDER_FULFIL) | Send a counter-offer on this seller's quote. Names the version being answered. |
| POST | `/api/v1/seller/rfqs/:id/quote/accept` | Seller | Feature + TradingSeller(ORDER_FULFIL) | Accept the buyer's counter-offer on the table. Awards the request and freezes the terms. |
| POST | `/api/v1/seller/rfqs/:id/quote/reject` | Seller | Feature + TradingSeller(ORDER_FULFIL) | Reject the buyer's counter-offer on the table. |
| POST | `/api/v1/seller/rfqs/:id/quote/withdraw` | Seller | Feature + TradingSeller(ORDER_FULFIL) | Withdraw this seller's quote while it is open. The buyer is told. |
| GET | `/api/v1/seller/rfqs/:id/samples` | Seller | Feature + Seller(ORDER_READ) | The samples the buyer asked this seller for on the request. |
| POST | `/api/v1/seller/rfqs/:id/samples/:sampleId/accept` | Seller | Feature + TradingSeller(ORDER_FULFIL) | Accept a sample request, saying what it costs (none is free). Payment is never marked paid here. |
| POST | `/api/v1/seller/rfqs/:id/samples/:sampleId/decline` | Seller | Feature + TradingSeller(ORDER_FULFIL) | Decline a sample request, with a reason the buyer reads. |
| POST | `/api/v1/seller/rfqs/:id/samples/:sampleId/ship` | Seller | Feature + TradingSeller(ORDER_FULFIL) | Record that the sample was sent: courier and tracking number are required. |
| POST | `/api/v1/seller/rfqs/:id/samples/:sampleId/attachments` | Seller | Feature + TradingSeller(ORDER_FULFIL) | Attach evidence about a sample, such as a certificate of analysis. Seen by the buyer and this seller. |
| GET | `/api/v1/seller/rfqs/:id/accepted-terms` | Seller | Feature + Seller(ORDER_READ) | The terms agreed with this seller, frozen at acceptance. Not found unless its quote won. |
| POST | `/api/v1/seller/rfqs/:id/attachments` | Seller | Feature + TradingSeller(ORDER_FULFIL) | Upload a PDF or image to send with this seller's quote or next offer. Seen by nobody else until it is sent with one. |
| GET | `/api/v1/seller/rfqs/:id/attachments/:attachmentId/download` | Seller | Feature + Seller(ORDER_READ) | Download a file this seller may see on the request. Served as a download, never inline. |

### `seller/settlements`

Defined in `backend/src/http/routes/seller.operations.ts`, `backend/src/http/routes/seller.logistics.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/settlements` | Seller | Seller + Seller(FINANCE_READ) | One page of the seller's settlement statements, newest period first: sales, tax, shipping, fees, refunds and the amount due to them for each period. |
| GET | `/api/v1/seller/settlements/funds` | Seller | Seller + Seller(FINANCE_READ) | Money not on a statement yet: funds held for their release terms, funds on hold, the reserve, and whether payouts are paused. |
| GET | `/api/v1/seller/settlements/export.csv` | Seller | Seller + Seller(FINANCE_READ) | Every statement whose period lies between from and to, as one CSV file for reconciliation. Writes a seller audit entry. |
| GET | `/api/v1/seller/settlements/:id/export.csv` | Seller | Seller + Seller(FINANCE_READ) | One settlement statement as a CSV file: every line, the totals and the payout status. Writes a seller audit entry. |
| GET | `/api/v1/seller/settlements/:id/lines` | Seller | Seller + Seller(FINANCE_READ) | Every line making up one of the seller's settlement statements, oldest first. |
| GET | `/api/v1/seller/settlements/estimate` | Seller | Seller(FINANCE_READ) | Estimate what the seller would be paid for a given sale amount and delivery charge, after platform fees and the tax on them, using the fee rules in force today. Read-only. |
| GET | `/api/v1/seller/settlements/orders` | Seller | Seller(FINANCE_READ) | The payouts already worked out for the seller's orders, newest first. |

### `seller/shipment-assessments`

Defined in `backend/src/http/routes/shipment-assessment.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/shipment-assessments` | Seller | Seller(ORDER_READ) | This seller's shipment assessments, by queue. |
| GET | `/api/v1/seller/shipment-assessments/:id` | Seller | Seller(ORDER_READ) | One of this seller's assessments: findings, checks, quantities and documents. Read-only for findings. |
| POST | `/api/v1/seller/shipment-assessments/:id/response` | Seller | Seller(ORDER_FULFIL) | Submit readiness information, or answer a corrective action. Cannot change a finding or a decision. |
| POST | `/api/v1/seller/shipment-assessments/:id/evidence` | Seller | Seller(ORDER_FULFIL) | Upload a packing photo, document or other evidence for the Audit Team. |
| GET | `/api/v1/seller/shipment-assessments/:id/documents/:documentId` | Seller | Seller(ORDER_READ) | Download a certificate, waiver or findings report of this seller's shipment. |

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

### `seller/support`

Defined in `backend/src/http/routes/support.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/support/context` | Seller | SellerBeforeAgreements | What the Seller Hub Support page needs: whether it takes requests, the contacts and the prefill. |
| POST | `/api/v1/seller/support/tickets` | Seller | SellerBeforeAgreements | Send a support request from Seller Hub. Needs an Idempotency-Key. |
| GET | `/api/v1/seller/support/tickets` | Seller | SellerBeforeAgreements | Your own support requests sent from this seller's Hub. |
| GET | `/api/v1/seller/support/tickets/:reference` | Seller | SellerBeforeAgreements | One of your Seller Hub support requests and its thread. |
| POST | `/api/v1/seller/support/tickets/:reference/messages` | Seller | SellerBeforeAgreements | Write again on one of your Seller Hub requests. Needs an Idempotency-Key. |
| POST | `/api/v1/seller/support/tickets/:reference/attachments` | Seller | SellerBeforeAgreements | Attach one image, video or PDF to your ticket. Checked by its contents, scanned, stored privately. |
| POST | `/api/v1/seller/support/tickets/:reference/attachments/:attachmentId/link` | Seller | SellerBeforeAgreements | A download link for one file on your ticket: five minutes, single use, this session only. |
| GET | `/api/v1/seller/support/tickets/:reference/attachments/:attachmentId/download` | Seller | SellerBeforeAgreements | Redeem a download link. Served as a download, never inline. |

### `seller/team`

Defined in `backend/src/http/routes/seller.team.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/team` | Seller | Seller(MEMBER_READ) | The team with each member's role, who invited them and when they last signed in; live invitations; recent access reviews. |

### `seller/trade-documents`

Defined in `backend/src/http/routes/seller.shipment-paperwork.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/trade-documents/versions/:id/file` | Seller | Seller(ORDER_READ) | Download the file of one version of the seller's own trade document. |

### `seller/turnover`

Defined in `backend/src/http/routes/seller.account.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/seller/turnover` | Seller | Seller + Seller(ACCOUNT_WRITE) | The seller turnover eligibility policy and this seller's current declaration: amount, financial year, policy version, whether it exceeds the minimum and whether the marketplace has verified it. Owners and administrators only - it is business financial data. |
| PUT | `/api/v1/seller/turnover` | Seller | Seller + Seller(ACCOUNT_WRITE) | Declare or correct the annual turnover. Saved even at or below the minimum, so nothing typed is lost, but the business details step stays unfinished and submission is refused. Changing the amount or the year sends it back for verification. Refused once the application is under review. Writes an audit entry without the figure. |

### `sellers`

Defined in `backend/src/http/routes/seller.account.ts`, `backend/src/http/routes/seller.team.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/sellers/me` | Customer | Customer | "Do I sell here, and how is it going?" |
| GET | `/api/v1/sellers/session` | Seller | Customer + Seller | When the open Seller Hub re-locks without further activity. Reading it does not count as activity, so a tab can check without keeping itself open. Refused with SELLER_SESSION_EXPIRED once the Hub has re-locked. |
| POST | `/api/v1/sellers/session/renew` | Seller | Customer + Seller | "Stay signed in": keep the open Seller Hub open for another full idle period. Needs the Hub to still be open; once it has re-locked this is refused with SELLER_SESSION_EXPIRED and the password is needed again. Writes an audit entry. |
| POST | `/api/v1/sellers/lock` | Customer | Customer | Choose the Seller Hub password, or change it. |
| POST | `/api/v1/sellers/lock/open` | Customer | Customer | Open the Hub for this session. |
| POST | `/api/v1/sellers/lock/close` | Customer | Customer | Shut it again, without signing out of the shop. |
| GET | `/api/v1/sellers/display-name-available` | Customer | Customer | Is this public shop name free? Called as the seller types it. |
| POST | `/api/v1/sellers/apply` | Customer | Customer | Start a seller application. |
| POST | `/api/v1/sellers/invitations/preview` | Customer | Customer | What a seller team invitation asks you to join. Only for the signed-in account it was sent to. |
| POST | `/api/v1/sellers/invitations/accept` | Customer | Customer | Accept a seller team invitation. Your verified email must be the one it was sent to. |

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
| GET | `/api/v1/account/autopay/scope-options` | Customer | Customer | The suppliers and categories a customer can limit automatic payment to, for the pickers on the Automatic payment page. Approved suppliers and active categories only. |
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
| GET | `/api/v1/account/data-requests` | Customer | CustomerBeforeAgreements | The signed-in customer’s data subject requests |
| POST | `/api/v1/account/data-requests` | Customer | CustomerBeforeAgreements | Exercise a data subject right |

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

### `account/inspections`

Defined in `backend/src/http/routes/account.customer.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/account/inspections` | Customer | Customer | Your open inspection jobs, soonest first, for the home task row (DYNAMIC-004). |

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

### `account/kyc`

Defined in `backend/src/http/routes/customer-kyc.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/account/kyc` | Customer | Customer | Your identity check, importer details and uploaded documents. |
| PUT | `/api/v1/account/kyc/identity` | Customer | Customer | Change your identity details. Refused while with a reviewer or verified; the document number is kept masked. |
| PUT | `/api/v1/account/kyc/importer` | Customer | Customer | Change your importer-of-record details. Always editable; never "verified". |
| POST | `/api/v1/account/kyc/submit` | Customer | Customer | Send your identity check for review. Every detail and an identity document are required. |
| POST | `/api/v1/account/kyc/documents` | Customer | Customer | Upload a document (PDF, JPEG, PNG, WebP): multipart, the `kind` field before the file. Scanned and stored privately. |
| DELETE | `/api/v1/account/kyc/documents/:id` | Customer | Customer | Withdraw a document nobody has decided on yet. |

### `account/locale`

Defined in `backend/src/http/routes/account.customer.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/account/locale` | Customer | Customer | Public capability flags the storefront branches on before rendering. |
| PUT | `/api/v1/account/locale` | Customer | Customer | Save the shopper's country and the currency they want prices in. Refused for a country this store does not ship to or a currency it does not sell in; with no currency given, the country's own currency is used. |

### `account/messages`

Defined in `backend/src/http/routes/messages.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/account/messages/reports` | Customer | Customer | Report a message in one of your conversations as abusive. Staff review it; a repeat finds the first report. |
| POST | `/api/v1/account/messages/translate` | Customer | Customer | Translate one message you can read into your language. Off unless the marketplace switched it on. |

### `account/notification-preferences`

Defined in `backend/src/http/routes/account.customer.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/account/notification-preferences` | Customer | Customer | Which notification families you receive on which channel. Security, order, payment and data-rights ones are always on. |
| PUT | `/api/v1/account/notification-preferences` | Customer | Customer | Replace your muted families: each entry switches one family off on one channel. Audited. |

### `account/notifications`

Defined in `backend/src/http/routes/account.customer.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/account/notifications` | Customer | Customer | What this deployment has sent to this customer |
| POST | `/api/v1/account/notifications/read` | Customer | Customer | Mark notifications read: the ids given, or all of them with `{ "all": true }`. |

### `account/order-messages`

Defined in `backend/src/http/routes/messages.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/account/order-messages` | Customer | Customer | Your order threads with sellers that have messages, most recently active first. |

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

### `account/preferences`

Defined in `backend/src/http/routes/customer-kyc.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/account/preferences/marketing` | Customer | Customer | Your marketing choices: email, SMS and product news. All off until you switch them on. |
| PUT | `/api/v1/account/preferences/marketing` | Customer | Customer | Change your marketing choices. Each change is recorded with its time. |

### `account/product-instructions`

Defined in `backend/src/http/routes/account.customer.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/account/product-instructions` | Customer | Customer | What this shopper has already said about a product. |
| POST | `/api/v1/account/product-instructions` | Customer | Customer | Leave one, or replace the one already there. |
| DELETE | `/api/v1/account/product-instructions/:instructionId` | Customer | Customer | Take it back. |

### `account/product-reviews`

Defined in `backend/src/http/routes/product-reviews.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/account/product-reviews` | Customer | Customer | Your reviews, and the delivered products still waiting for one. |
| GET | `/api/v1/account/product-reviews/reviewed` | Customer | Customer | Which of these products you have already reviewed. For the order page. |
| DELETE | `/api/v1/account/product-reviews/:reviewId` | Customer | Customer | Take your review back. |

### `account/products`

Defined in `backend/src/http/routes/product-reviews.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/account/products/:productId/review` | Customer | Customer | Whether you may review this product, and your review if you wrote one. |
| PUT | `/api/v1/account/products/:productId/review` | Customer | Customer | Write your review of a product, or replace the one you wrote. |

### `account/profile`

Defined in `backend/src/http/routes/account.customer.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/account/profile` | Customer | Customer | The signed-in customer profile and spend summary |
| PATCH | `/api/v1/account/profile` | Customer | Customer | Update the customer's own profile details, such as name, organisation, job title and phone. Writes an audit entry recorded as the customer's own change. |

### `account/saved-searches`

Defined in `backend/src/http/routes/saved-searches.customer.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/account/saved-searches` | Customer | Customer | The buyer's saved searches, newest first, with the most they may keep. |
| POST | `/api/v1/account/saved-searches` | Customer | Customer | Save a search term and its filters, with new-match e-mail alerts on unless asked otherwise. |
| PATCH | `/api/v1/account/saved-searches/:id` | Customer | Customer | Rename one of the buyer's saved searches, or switch its alerts on or off. |
| DELETE | `/api/v1/account/saved-searches/:id` | Customer | Customer | Delete one of the buyer's saved searches. |

### `account/search`

Defined in `backend/src/http/routes/account.customer.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/account/search` | Customer | Customer | Your own orders, invoices, shipments and requests matching a number, reference, tracking code or title (ENH-004). |

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

Defined in `backend/src/http/routes/auth.ts`, `backend/src/http/routes/agreements.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/auth/logout` | Signed in | Authenticated(kind) | Sign out of this session only and clear its cookies. |
| POST | `/api/v1/auth/logout-all` | Signed in | Authenticated(kind) | Sign the person out on every device at once. Replies with how many sessions were ended. |
| GET | `/api/v1/auth/me` | Signed in | Authenticated(kind) | Current customer |
| GET | `/api/v1/auth/language` | Signed in | Authenticated(kind) | The interface language for this account. |
| PUT | `/api/v1/auth/language` | Signed in | Authenticated(kind) | Save the interface language the signed-in person wants to read. |
| POST | `/api/v1/auth/password/change` | Signed in | Authenticated(kind) | Change the signed-in person's password, given their current one. Signs the account out of every session, including this one, and writes an audit entry. |
| GET | `/api/v1/auth/buyer-context` | Signed in | Authenticated(kind) | The buyer this session is acting as, and every company it may switch to. |
| PUT | `/api/v1/auth/buyer-context` | Signed in | Authenticated(kind) | Switch between buying for yourself and for one of your companies. Refused, with one answer for every reason, for a company you are not an active member of. |
| GET | `/api/v1/auth/agreements` | Customer | CustomerBeforeAgreements | Whether this buyer (or, with scope=SELLER, this seller) has accepted the Terms and acknowledged the Privacy Policy in force, with both documents to read. |
| POST | `/api/v1/auth/agreements/terms` | Customer | CustomerBeforeAgreements | "I agree" in the Terms dialog: records acceptance of the named Terms in force. Never acknowledges the Privacy Policy. |
| POST | `/api/v1/auth/agreements/privacy` | Customer | CustomerBeforeAgreements | "I acknowledge" in the Privacy Policy dialog: records the acknowledgment of the notice in force. Never accepts the Terms and consents to nothing optional. |
| DELETE | `/api/v1/auth/agreements/terms` | Customer | CustomerBeforeAgreements | Untick the Terms box before Continue. The record is kept, marked cleared, and the screen asks again. |
| POST | `/api/v1/auth/agreements/services` | Customer | CustomerBeforeAgreements | Accept the Platform Services Agreement under its own box: the Seller Hub's (SELLER), the company screen's (COMPANY_BUYER) or the consumer screen's (CONSUMER). |
| DELETE | `/api/v1/auth/agreements/services` | Customer | CustomerBeforeAgreements | Untick the Platform Services Agreement box before Continue; the record is kept, marked cleared. |
| DELETE | `/api/v1/auth/agreements/privacy` | Customer | CustomerBeforeAgreements | Untick the Privacy Policy box before Continue. Withdraws no consent; the record is kept, marked cleared. |
| GET | `/api/v1/auth/agreements/history` | Customer | CustomerBeforeAgreements | Every Terms acceptance and privacy-notice acknowledgment this person has given, newest first, for their account page. |

### `buyer-companies`

Defined in `backend/src/http/routes/buyer-companies.customer.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/buyer-companies` | Customer | Customer | The companies the signed-in buyer belongs to, with each one's status and their role. |
| POST | `/api/v1/buyer-companies` | Customer | Customer | Start a company application, with the signed-in buyer as its owner. The owner cannot buy for the company until staff approve it. |
| GET | `/api/v1/buyer-companies/:id` | Customer | Customer | One company application as its member sees it: details, requirements, what is missing, requests and timeline. |
| PATCH | `/api/v1/buyer-companies/:id` | Customer | Customer | Save one or more steps of the application. Refused while it is with a reviewer. |
| POST | `/api/v1/buyer-companies/:id/email-code` | Customer | Customer | Send a six-digit code to the business email address. |
| POST | `/api/v1/buyer-companies/:id/email-code/confirm` | Customer | Customer | Enter the business email code. Completes a submission that was waiting on it. |
| POST | `/api/v1/buyer-companies/:id/submit` | Customer | Customer | Send the application for review, recording each of the four declarations separately. |
| POST | `/api/v1/buyer-companies/:id/info-requests/:requestId/answer` | Customer | Customer | Answer one of the reviewer's requests. |
| POST | `/api/v1/buyer-companies/:id/resubmit` | Customer | Customer | Send the application back to the reviewer after answering them. |
| POST | `/api/v1/buyer-companies/:id/reopen` | Customer | Customer | Take a rejected application back to a draft to correct it, where the reviewer allowed that. |
| POST | `/api/v1/buyer-companies/:id/documents` | Customer | Customer | Upload a supporting document. PDF, JPEG, PNG or WebP, decided from the file's own bytes; scanned for malware and stored privately under a generated name. Send the `kind` field before the file. |
| DELETE | `/api/v1/buyer-companies/:id/documents/:documentId` | Customer | Customer | Withdraw a document nobody has decided on yet. |
| GET | `/api/v1/buyer-companies/:id/team` | Customer | Customer | The company's active members and their roles; live invitations for the owner and administrators. |
| POST | `/api/v1/buyer-companies/:id/invitations` | Customer | Customer | Invite somebody by email in one role. Owner or administrator of a verified company; only the owner gives the administrator role. |
| POST | `/api/v1/buyer-companies/:id/invitations/:invitationId/resend` | Customer | Customer | Send an invitation again with a new link and a new expiry; the old link stops working. |
| DELETE | `/api/v1/buyer-companies/:id/invitations/:invitationId` | Customer | Customer | Withdraw an invitation nobody has accepted yet. |
| PATCH | `/api/v1/buyer-companies/:id/members/:memberId` | Customer | Customer | Change a member's role. Never the owner, never yourself; only the owner changes an administrator. |
| DELETE | `/api/v1/buyer-companies/:id/members/:memberId` | Customer | Customer | Remove a member. Their access ends on their next request. |
| POST | `/api/v1/buyer-companies/:id/access-reviews` | Customer | Customer | Record that you have reviewed who has access to the company. Owner or administrator; audited. |
| POST | `/api/v1/buyer-companies/invitations/preview` | Customer | Customer | What an invitation link asks you to join. Only for the signed-in account it was sent to. |
| POST | `/api/v1/buyer-companies/invitations/accept` | Customer | Customer | Accept an invitation. Your verified email must be the one it was sent to. |

### `cart`

Defined in `backend/src/http/routes/cart.customer.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/cart` | Customer | Customer | Current cart, repriced |
| POST | `/api/v1/cart/items` | Customer | Customer | Add an item |
| POST | `/api/v1/cart/items/upload/preview` | Customer | Customer | Read a CSV or Excel SKU list into cart lines for review; nothing is added until the buyer confirms (ENH-016). |
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

### `disputes`

Defined in `backend/src/http/routes/disputes.ts`, `backend/src/http/routes/commercial-policy.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/disputes/context` | Customer | CustomerForRemedies | What the claim form needs: the reasons offered, the windows and the file rules. |
| POST | `/api/v1/disputes` | Customer | CustomerForRemedies | Raise a claim on one of your orders, or one line of it. Needs an Idempotency-Key. |
| GET | `/api/v1/disputes` | Customer | CustomerForRemedies | Your claims, most recently active first. `orderId` narrows to one order. |
| GET | `/api/v1/disputes/:reference` | Customer | CustomerForRemedies | One of your claims: its status, deadlines, decision, evidence and thread. |
| POST | `/api/v1/disputes/:reference/messages` | Customer | CustomerForRemedies | Write on your claim. The seller and the marketplace see it. Needs an Idempotency-Key. |
| POST | `/api/v1/disputes/:reference/escalate` | Customer | CustomerForRemedies | Ask the marketplace to decide, once the seller's time to answer has passed. |
| POST | `/api/v1/disputes/:reference/withdraw` | Customer | CustomerForRemedies | Withdraw your claim. It cannot be reopened. |
| POST | `/api/v1/disputes/:reference/appeal` | Customer | CustomerForRemedies | Appeal the decision on your claim, once, inside the appeal window. |
| POST | `/api/v1/disputes/:reference/attachments` | Customer | CustomerForRemedies | Attach one image, video or PDF as evidence. Checked by its contents, scanned, stored privately. |
| POST | `/api/v1/disputes/:reference/attachments/:attachmentId/link` | Customer | CustomerForRemedies | A download link for one file on your claim: five minutes, single use, this session only. |
| GET | `/api/v1/disputes/:reference/attachments/:attachmentId/download` | Customer | CustomerForRemedies | Redeem a download link. Served as a download, never inline. |
| GET | `/api/v1/disputes/:reference/case-controls` | Customer | CustomerForRemedies | My claim's case facts, requests to me and the decided remedies. |
| POST | `/api/v1/disputes/:reference/case-controls/evidence-requests/:requestId` | Customer | CustomerForRemedies | Answer an evidence request addressed to me (including material contrary evidence). |

### `documents`

Defined in `backend/src/http/routes/documents.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/documents/orders/:orderId` | Customer | CustomerForRemedies | The buyer's view of an order's seller documents. |
| POST | `/api/v1/documents/buyer/:kind/:id/link` | Customer | CustomerForRemedies | Get a short-lived, single-use download link for one of the buyer's own invoices or credit notes. A packing list is never offered to a buyer. |
| GET | `/api/v1/documents/batch/:id/download` | Customer | CustomerForRemedies | Download several of a seller's own issued documents as one ZIP file, using a link from the seller's batch-link request. Works once, only for the person the link was made for, and records each document download in the audit log. |
| GET | `/api/v1/documents/:kind/:id/download` | Customer | CustomerForRemedies | Download one invoice or packing list as a PDF, for the seller who issued it or the buyer it was issued to. The link works once, only for the person it was made for, and the download is recorded in the audit log. |

### `fulfilment`

Defined in `backend/src/http/routes/fulfilment.customer.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/fulfilment/warehouse-options` | Customer | Customer | Which warehouses can fulfil this basket, and on what terms |
| POST | `/api/v1/fulfilment/warehouse-options/:quoteId/revalidate` | Customer | Customer | Is the option I chose still an offer? |

### `inspection`

Defined in `backend/src/http/routes/inspection.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/inspection/buyer/orders/:id` | Customer | Customer | The inspection timeline for your order: booked, inspector assigned, started, report, NCR, release. |
| POST | `/api/v1/inspection/buyer/orders/:id/request` | Customer | Customer | Ask for an inspection on your order before it ships. |
| GET | `/api/v1/inspection/buyer/orders/:id/agencies` | Customer | Customer | The inspection agencies you may choose for one part of your order, on a day and in a country. |
| POST | `/api/v1/inspection/buyer/orders/:id/book` | Customer | Customer | Book an inspection on your order before it ships: agency, date, inspection point and who pays. |
| GET | `/api/v1/inspection/buyer/reports/:id/pdf` | Customer | Customer | Download a signed inspection report on your order as a PDF, when the operator's policy lets buyers see it. |
| GET | `/api/v1/inspection/buyer/evidence/:id` | Customer | Customer | Download one evidence file the buyer may see under the report-visibility policy. |

### `orders`

Defined in `backend/src/http/routes/commercial-policy.ts`, `backend/src/http/routes/shipment-assessment.ts`, `backend/src/http/routes/messages.ts`, `backend/src/http/routes/returns.ts`, `backend/src/http/routes/orders.ts`, `backend/src/http/routes/order-tracking.customer.ts`, `backend/src/http/routes/order-shipment-details.customer.ts`, `backend/src/http/routes/order-milestones.customer.ts`, `backend/src/http/routes/payment-receipts.ts`, `backend/src/http/routes/finance.ts`, `backend/src/http/routes/logistics-levels.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/orders/:id/refund-status` | Customer | CustomerForRemedies | My order's refunds: when each was instructed and the provider's actual status. |
| GET | `/api/v1/orders/:id/shipment-assessments` | Customer | Customer | The released shipment assessment summaries of one of the buyer's own orders: status, dispatch deadline and released documents only. |
| GET | `/api/v1/orders/:id/shipment-assessments/:documentId` | Customer | Customer | Download a released certificate or waiver of the buyer's own order. Findings reports are not shared. |
| GET | `/api/v1/orders/:id/messages` | Customer | Customer | Your messages with each seller on one of your orders, oldest first; `?after=` for only new ones. |
| POST | `/api/v1/orders/:id/messages/:groupId` | Customer | Customer | Write to the seller of one part of your order. A resend with the same clientMessageId is not a second message. |
| GET | `/api/v1/orders/:id/returns/eligibility` | Customer | CustomerForRemedies | What can be returned from one of your orders: the window, the reasons offered and each line's quantity left. |
| POST | `/api/v1/orders/:id/returns` | Customer | CustomerForRemedies | Ask to return lines of your own delivered order, with a reason and photos. Needs an Idempotency-Key. |
| GET | `/api/v1/orders` | Customer | CustomerForRemedies | The signed-in customer orders |
| GET | `/api/v1/orders/:id/invoice` | Customer | CustomerForRemedies | The customer’s own invoice |
| GET | `/api/v1/orders/:id` | Customer | CustomerForRemedies | Order detail with timeline |
| POST | `/api/v1/orders/:id/cancel` | Customer | CustomerForRemedies | Cancel an order the policy still allows to be cancelled. |
| GET | `/api/v1/orders/:id/tracking` | Customer | CustomerForRemedies | Every consignment on one of the buyer's orders: its timeline in the buyer's words, anything wrong with it, its ETA and its proof of delivery. |
| POST | `/api/v1/orders/:id/shipments/:shipmentId/proof-of-delivery/:kind/link` | Customer | CustomerForRemedies | A single-use link, valid for a few minutes, to the signature or photograph captured as proof of delivery of one of the buyer's consignments. |
| GET | `/api/v1/orders/:id/shipments/:shipmentId/proof-of-delivery/:kind/download` | Customer | CustomerForRemedies | Redeem a proof-of-delivery link: works once, only for the person it was made for, and is recorded in the audit log. |
| GET | `/api/v1/orders/:id/shipment-details` | Customer | Customer | The booking of every consignment on one of the buyer's orders, the trade documents the buyer may see, and what the destination rules ask the buyer to produce. |
| GET | `/api/v1/orders/:id/trade-documents/:versionId/file` | Customer | Customer | Download the current version of a buyer-visible trade document on one of the buyer's orders. |
| GET | `/api/v1/orders/:id/milestones` | Customer | CustomerForRemedies | Production milestones and exceptions, inspection status, shipments, buyer-visible documents and payment status of one of the buyer's orders. |
| GET | `/api/v1/orders/:id/receipts` | Customer | Customer | The receipts the buyer can download for one of their own orders: each captured payment and each confirmed refund. |
| GET | `/api/v1/orders/:id/receipts/:kind/:sourceId` | Customer | Customer | Download the buyer's receipt for one payment or refund on their own order as a PDF; the first download issues its number. |
| GET | `/api/v1/orders/:id/payment-protection` | Customer | Customer | How the buyer's payment on their own order is held and released: method, status, terms, per-seller milestones, receipts. |
| GET | `/api/v1/orders/:id/price-breakdown` | Customer | Customer | What the signed-in customer paid on one of their own orders, including delivery level by level and where each level has got to. Another customer's order is not found. |

### `payments`

Defined in `backend/src/http/routes/payments.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/payments/gateways` | Customer | Customer | Gateways the storefront may offer, and which to preselect |
| GET | `/api/v1/payments/instruments` | Customer | Customer | How a customer may pay for a cart in this currency |
| POST | `/api/v1/payments/orders/:orderId/session` | Customer | Customer | Start a payment for an order |
| GET | `/api/v1/payments/orders/:orderId/status` | Customer | Customer | Poll payment status after returning from the provider |
| GET | `/api/v1/payments/orders/:orderId/checkout/:sessionId` | Customer | Customer | The Stripe Checkout confirmation page's question: what happened to the payment made on this session? Answers from our own records, which only a signed webhook or Stripe's own API ever advance - never from the fact that the customer's browser came back. Found only for the customer who owns the order the session was opened for. |
| POST | `/api/v1/payments/orders/:orderId/checkout/:sessionId/refresh` | Customer | Customer | "Check again": ask Stripe directly, when its webhook is late. |
| POST | `/api/v1/payments/orders/:orderId/checkout/cancel` | Customer | Customer | The customer came back through Stripe's Cancel link. |
| POST | `/api/v1/payments/orders/:orderId/mock-capture` | Customer | Customer | Settle an order without a gateway (testing only) |
| POST | `/api/v1/payments/orders/:orderId/reconcile` | Customer | Customer | Ask the provider directly. |

### `preorder-chats`

Defined in `backend/src/http/routes/preorder-chats.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/preorder-chats/context` | Customer | Customer | What the chat drawer shows before anything is sent: the product card, as the server reads it, and the conversation this customer already has about it. Creates nothing - opening the drawer does not start a conversation. |
| POST | `/api/v1/preorder-chats/handoff` | Customer | Customer | "Connect with a human agent." Creates the conversation about this product, or reuses the live one, carries the answers the customer read into it and puts it in the team's queue as a request for a person. Retrying with the same `clientRequestId` returns what the first attempt stored. |
| POST | `/api/v1/preorder-chats/messages` | Customer | Customer | Send the first message about a product - which starts the conversation - or the next one, if a live conversation about it already exists. A resolved conversation reopens. Retrying with the same `clientMessageId` returns the stored message instead of sending it twice. |
| GET | `/api/v1/preorder-chats` | Customer | Customer | The customer's conversations, newest activity first. |
| GET | `/api/v1/preorder-chats/unread` | Customer | Customer | How many replies are waiting to be read, across every conversation - or, with a product id, across the conversations about that product only. |
| GET | `/api/v1/preorder-chats/:id` | Customer | Customer | One of the customer's own conversations. Another customer's answers 404. |
| GET | `/api/v1/preorder-chats/:id/messages` | Customer | Customer | A page of history. `after` returns everything since a sequence number, oldest first - how a page catches up after a dropped connection. `before` loads earlier messages. |
| POST | `/api/v1/preorder-chats/:id/messages` | Customer | Customer | Send a message in an existing conversation. |
| POST | `/api/v1/preorder-chats/:id/read` | Customer | Customer | Mark the conversation read up to a sequence number. Never moves backwards. |
| POST | `/api/v1/preorder-chats/:id/attachments` | Customer | Customer | Attach a PDF or an image. The file is checked by its contents, scanned for malware and stored privately; it is refused when attachments are unavailable on this installation. |
| POST | `/api/v1/preorder-chats/:id/attachments/:attachmentId/link` | Customer | Customer | A download link for one attachment: five minutes, single use, this session only. |
| GET | `/api/v1/preorder-chats/:id/attachments/:attachmentId/download` | Customer | Customer | Redeem a download link. Served as an attachment, never inline. |
| GET | `/api/v1/preorder-chats/:id/proposals/:proposalId` | Customer | Customer | One proposal, with what the preorder form needs to open on it. The form still checks eligibility and asks the customer to accept the preorder terms; this only saves retyping the figures. |
| POST | `/api/v1/preorder-chats/:id/proposals/:proposalId/decline` | Customer | Customer | Decline a proposal, optionally saying why. Staff are told. |
| POST | `/api/v1/preorder-chats/:id/proposals/:proposalId/submitted` | Customer | Customer | Record that a preorder request was sent from this proposal. The request must be the customer's own, for the same product and option, and made after the proposal; the conversation is then linked to it. The request itself goes through the ordinary preorder workflow unchanged. |

### `preorders`

Defined in `backend/src/http/routes/preorders.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/preorders/acknowledgement` | Customer | Customer | Record that the signed-in buyer read and understood how bulk preorders work - the minimum quantity, and that the seller confirms before anything is charged. Only the current version of that information can be acknowledged; an older one is refused so the buyer reads the new text. This is not acceptance of any terms and places no order. |
| POST | `/api/v1/preorders/preview` | Customer | Customer | Work out what a preorder would look like - price, delivery window and quantity - before the buyer sends it. Nothing is saved. |
| POST | `/api/v1/preorders` | Customer | Customer | Send a bulk preorder request to the seller for a product, quantity and delivery date. The buyer must accept the preorder terms; the seller is notified and the request expires if nobody answers in time. |
| GET | `/api/v1/preorders` | Customer | Customer | List the buyer's own preorders, newest first, with who supplies each one. |
| GET | `/api/v1/preorders/:id` | Customer | Customer | Show one of the buyer's own preorders in full, including its history. Another buyer's preorder answers "not found". |
| POST | `/api/v1/preorders/:id/confirm` | Customer | Customer | Agree to the seller's current terms. Creates the order, awaiting payment. The body names the revision and its hash, so only terms the buyer was shown can be confirmed. |
| POST | `/api/v1/preorders/:id/decline` | Customer | Customer | The buyer turns down the seller's proposed terms, with an optional note, and sends the preorder back to the seller to look at again. The seller is alerted. |
| POST | `/api/v1/preorders/:id/request-change` | Customer | Customer | The buyer asks the seller to change their offer, with a message saying what should change. The offer is set aside, the preorder goes back to the seller with the message, and the seller is alerted. Nothing is charged. |
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
| POST | `/api/v1/recurring-schedules/:id/occurrences/:occurrenceId/confirm-price` | Customer | Customer | Accept the new total for a delivery that was held because its price moved. Send the total you were shown; if it has changed since, this is refused and you are shown the new one. The delivery is then priced again and charged only if it is still exactly that amount. |
| POST | `/api/v1/recurring-schedules/:id/occurrences/:occurrenceId/decline-price` | Customer | Customer | Turn down the new total: this one delivery is skipped and the plan carries on. |
| DELETE | `/api/v1/recurring-schedules/occurrences/:occurrenceId` | Customer | Customer | Cancel one delivery outright, rather than skipping it. |

### `returns`

Defined in `backend/src/http/routes/returns.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/returns` | Customer | CustomerForRemedies | Your returns, newest first. Filter by status (OPEN for everything still being worked) or order. |
| GET | `/api/v1/returns/:id` | Customer | CustomerForRemedies | One of your returns with its timeline, files and refund. Somebody else's answers "not found". |
| POST | `/api/v1/returns/:id/files` | Customer | CustomerForRemedies | Add one more photograph or video to your open return. Checked by its contents, scanned, stored privately. |
| POST | `/api/v1/returns/:id/files/:fileId/link` | Customer | CustomerForRemedies | A five-minute, single-use link to one file of your return. |
| GET | `/api/v1/returns/:id/files/:fileId/download` | Customer | CustomerForRemedies | Download a file of your return with a link from the route above. Spent on first use. |

### `rfqs`

Defined in `backend/src/http/routes/rfq.customer.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/rfqs/form-options` | Customer | Feature + Customer | What the request form offers: units of measure, Incoterms, sample and inspection choices, the deadline limit and the file rules. |
| GET | `/api/v1/rfqs/summary` | Customer | Feature + Customer | Sourcing figures and next actions for the buyer dashboard. A failed block is null, never an error. |
| GET | `/api/v1/rfqs` | Customer | Feature + Customer | Your requests for quotation, newest activity first, with a count per status. |
| POST | `/api/v1/rfqs` | Customer | Feature + Customer | Start a draft request for quotation. Needs an Idempotency-Key. Writes an audit entry. |
| GET | `/api/v1/rfqs/suppliers` | Customer | Feature + Customer | Approved sellers a buyer may pick by name, with whether each would match the category and destination given. |
| GET | `/api/v1/rfqs/destination-guidance` | Customer | Feature + Customer | Published importer guidance and current category destination rules for an unsaved RFQ. |
| GET | `/api/v1/rfqs/:id` | Customer | Feature + Customer | One of your requests: requirement, versions, sellers asked, files and timeline. |
| PUT | `/api/v1/rfqs/:id` | Customer | Feature + Customer | Save a draft again, whole. Conditional on the version it was opened at. |
| DELETE | `/api/v1/rfqs/:id` | Customer | Feature + Customer | Delete a draft and its files. A request already sent cannot be deleted. |
| GET | `/api/v1/rfqs/:id/matches` | Customer | Feature + Customer | Which sellers a draft would be sent to now, and whether any match. |
| POST | `/api/v1/rfqs/:id/submit` | Customer | Feature + Customer | Send a draft to the matching sellers and any picked by name. Validated again on the server; needs an Idempotency-Key. Writes an audit entry and tells every invited seller. |
| POST | `/api/v1/rfqs/:id/invitations` | Customer | Feature + Customer | Ask one more approved seller, by name, on a request already sent. |
| POST | `/api/v1/rfqs/:id/cancel` | Customer | Feature + Customer | Cancel a draft or an open request. Every seller still taking part is told. |
| POST | `/api/v1/rfqs/:id/close` | Customer | Feature + Customer | Close an open request without choosing any quote. |
| POST | `/api/v1/rfqs/:id/attachments` | Customer | Feature + Customer | Attach a PDF or image to the requirement. Checked by its contents, scanned and stored privately. On a sent request it waits for the next version. |
| DELETE | `/api/v1/rfqs/:id/attachments/:attachmentId` | Customer | Feature + Customer | Remove a requirement file that is not yet part of any version sent to sellers. |
| GET | `/api/v1/rfqs/:id/attachments/:attachmentId/download` | Customer | Feature + Customer | Download a file on your request. Served as a download, never inline. |
| POST | `/api/v1/rfqs/:id/versions` | Customer | Feature + Customer | Publish a new version of a sent requirement, with what changed and why. Every seller still taking part is told. Writes an audit entry. |
| GET | `/api/v1/rfqs/:id/quotes` | Customer | Feature + Customer | Every quote on your request, each with its current offer and its history. |
| GET | `/api/v1/rfqs/:id/quotes/:quoteId` | Customer | Feature + Customer | One quote on your request, with every offer version. |
| PUT | `/api/v1/rfqs/:id/quotes/:quoteId/shortlist` | Customer | Feature + Customer | Put a quote on your shortlist, or take it off. Writes an audit entry. |
| GET | `/api/v1/rfqs/:id/comparison` | Customer | Feature + Customer | The quotes side by side, sortable and filterable, with every figure as quoted and, beside it, converted into `?currency=` at the published rate (source and date given). Missing terms are null, never zero. |
| GET | `/api/v1/rfqs/:id/comparison.csv` | Customer | Feature + Customer | The same comparison as a CSV file, spreadsheet formulas neutralised. Writes an audit entry. |
| GET | `/api/v1/rfqs/:id/comparison.pdf` | Customer | Feature + Customer | The same comparison as a PDF to print or file (JOURNEY-017). Audited like the CSV. |
| POST | `/api/v1/rfqs/:id/quotes/:quoteId/offers` | Customer | Feature + Customer | Send a counter-offer on a quote: new terms as a new, immutable version. Names the version being answered; refused if it moved. Writes an audit entry. |
| POST | `/api/v1/rfqs/:id/quotes/:quoteId/accept` | Customer | Feature + Customer | Accept the supplier's offer on the table, naming its terms hash. Awards the request, closes every other quote and freezes the terms. Repeating it is answered with the same result. Writes an audit entry. |
| POST | `/api/v1/rfqs/:id/quotes/:quoteId/reject` | Customer | Feature + Customer | Reject the supplier's offer on the table; the quote closes as rejected. |
| GET | `/api/v1/rfqs/:id/accepted-terms` | Customer | Feature + Customer | The terms both sides agreed to, frozen at acceptance, with their hash. |
| GET | `/api/v1/rfqs/:id/purchase-order` | Customer | Feature + Customer | The final contract preview, or the immutable purchase order already raised from it. |
| POST | `/api/v1/rfqs/:id/purchase-order` | Customer | Feature + Customer | E-accept the exact awarded terms and raise the binding purchase order. |
| POST | `/api/v1/rfqs/:id/purchase-order/decision` | Customer | Feature + Customer | Decide the next stage in the company's approver/finance matrix. |
| POST | `/api/v1/rfqs/:id/purchase-order/order` | Customer | Feature + Customer | Turn the approved purchase order into an order awaiting payment. Needs an Idempotency-Key; a repeat, or a second tab, returns the same order. |
| GET | `/api/v1/rfqs/:id/samples` | Customer | Feature + Customer | The samples asked for on your request, with their status, evidence and what you may do next. |
| POST | `/api/v1/rfqs/:id/samples` | Customer | Feature + Customer | Ask a supplier taking part for a sample: quantity, address, date and approval criteria. Needs an Idempotency-Key. Tells the supplier; audited. |
| POST | `/api/v1/rfqs/:id/samples/:sampleId/cancel` | Customer | Feature + Customer | Cancel a sample request before it is shipped. The supplier is told; audited. |
| POST | `/api/v1/rfqs/:id/samples/:sampleId/receive` | Customer | Feature + Customer | Confirm a shipped sample arrived. Only you can say it did; audited. |
| POST | `/api/v1/rfqs/:id/samples/:sampleId/approve` | Customer | Feature + Customer | Approve a delivered sample against its criteria; it becomes the reference sample. Audited. |
| POST | `/api/v1/rfqs/:id/samples/:sampleId/reject` | Customer | Feature + Customer | Reject a delivered sample, with a reason the supplier reads. Audited. |
| POST | `/api/v1/rfqs/:id/samples/:sampleId/checkout` | Customer | Feature + Customer | Make (or return) the order that collects a charged sample's fee, tax and shipping; paid on the ordinary payment screen. |
| POST | `/api/v1/rfqs/:id/samples/:sampleId/attachments` | Customer | Feature + Customer | Attach evidence about a sample: a photograph, a test report. Seen by you and that supplier. |
| GET | `/api/v1/rfqs/:id/invitations/:invitationId/messages` | Customer | Feature + Customer | The thread with one invited seller, oldest first; `?after=` for only new ones. |
| POST | `/api/v1/rfqs/:id/invitations/:invitationId/messages` | Customer | Feature + Customer | Write to one invited seller. A resend with the same clientMessageId is not a second message. |

### `support`

Defined in `backend/src/http/routes/support.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/support/context` | Customer | CustomerBeforeAgreements | What the Support page needs: whether it takes requests, the contacts and the prefill. |
| POST | `/api/v1/support/tickets` | Customer | CustomerBeforeAgreements | Send a support request. Needs an Idempotency-Key. |
| GET | `/api/v1/support/tickets` | Customer | CustomerBeforeAgreements | Your own support requests sent from the storefront, most recently active first. |
| GET | `/api/v1/support/tickets/:reference` | Customer | CustomerBeforeAgreements | One of your support requests and its thread. Somebody else's answers "not found". |
| POST | `/api/v1/support/tickets/:reference/messages` | Customer | CustomerBeforeAgreements | Write again on one of your requests. Needs an Idempotency-Key. |
| POST | `/api/v1/support/tickets/:reference/attachments` | Customer | CustomerBeforeAgreements | Attach one image, video or PDF to your ticket. Checked by its contents, scanned, stored privately. |
| POST | `/api/v1/support/tickets/:reference/attachments/:attachmentId/link` | Customer | CustomerBeforeAgreements | A download link for one file on your ticket: five minutes, single use, this session only. |
| GET | `/api/v1/support/tickets/:reference/attachments/:attachmentId/download` | Customer | CustomerBeforeAgreements | Redeem a download link. Served as a download, never inline. |

## Public and storefront

### `account/config`

Defined in `backend/src/http/routes/account.customer.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/account/config` | Public |  | Tell the storefront whether shoppers may create their own accounts, so it knows whether to show the sign-up option. Needs no sign-in. |

### `analytics`

Defined in `backend/src/http/routes/analytics.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/analytics/events` | Public |  | Count a batch of anonymous product events (route patterns only). Stores no identifier. |

### `assistant`

Defined in `backend/src/http/routes/assistant.public.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| POST | `/api/v1/assistant/start` | Public (customer optional) | optionalCustomer | Open a conversation. |
| POST | `/api/v1/assistant/chat` | Public (customer optional) | optionalCustomer | Ask the shopping assistant a question in an existing conversation and receive its answer as it is written, word by word. A guest is asked to sign in after a set number of free questions, a conversation is refused once it reaches its length limit, and the whole feature answers "not found" when no AI provider is set up. |

### `auth`

Defined in `backend/src/http/routes/auth.ts`, `backend/src/http/routes/security.customer.ts`.

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
| GET | `/api/v1/auth/mfa` | Public |  | Where this account's two-step sign-in stands: switched on or not, whether the person's seller role requires it, whether this session has passed its code, how many recovery codes are left, and what a step-up will ask for. |
| POST | `/api/v1/auth/mfa/setup` | Public |  | Start setting up two-step sign-in: returns a new authenticator secret, the address to draw as a QR code, and ten recovery codes shown only this once. Needs a recent step-up. Nothing is switched on until the code is confirmed. |
| POST | `/api/v1/auth/mfa/confirm` | Public |  | Confirm setup with the first code from the authenticator. Switches two-step sign-in on, marks this session verified, and writes an audit entry. |
| POST | `/api/v1/auth/mfa/challenge` | Public |  | Finish signing in with a code from the authenticator or a one-time recovery code. Wrong codes are counted; too many in a row lock the account and end every session. |
| POST | `/api/v1/auth/mfa/recovery-codes` | Public |  | Replace the recovery codes with ten new ones, shown only this once. The old codes stop working. Needs a recent step-up. |
| POST | `/api/v1/auth/mfa/disable` | Public |  | Switch two-step sign-in off. Needs a recent step-up, is refused while the person's seller role requires it, and emails the account holder. |
| POST | `/api/v1/auth/step-up` | Public |  | Confirm it is you before a sensitive change: a code from the authenticator when two-step sign-in is on, otherwise the password. Counts for STEP_UP_WINDOW_SECONDS. Wrong answers count towards the lockout. |

### `catalog`

Defined in `backend/src/http/routes/catalog.public.ts`, `backend/src/http/routes/bulk-pricing.ts`, `backend/src/http/routes/product-reviews.ts`, `backend/src/http/routes/content-blocks.ts`, `backend/src/http/routes/market-rules.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/catalog/variant-axes` | Public |  | The variant axis definitions, for the whole catalogue. |
| GET | `/api/v1/catalog/search` | Public |  | Public discovery only: no RFQs, orders, invoices, buyer or seller private data. |
| GET | `/api/v1/catalog/suppliers` | Public |  | Verified suppliers: sellers the operator approved who have something live to sell. |
| GET | `/api/v1/catalog/markets/:country` | Public |  | One destination's market page: its currency, what may not be sold there, and the operator's published notes. |
| GET | `/api/v1/catalog/assurance` | Public |  | The protections this deployment runs, as its settings define them: verification, inspection, returns, claims. |
| GET | `/api/v1/catalog/suppliers/:slug` | Public |  | One verified supplier's public profile: company, factories, verified certifications, what they sell. |
| GET | `/api/v1/catalog/categories` | Public |  | Category tree |
| GET | `/api/v1/catalog/categories/:slug` | Public |  | Look up one category by its web address name and return its name and description. Hidden or archived categories answer "not found". |
| GET | `/api/v1/catalog/products` | Public |  | List published products |
| GET | `/api/v1/catalog/filters` | Public |  | What is worth offering as a filter, for the listing these same parameters describe. |
| GET | `/api/v1/catalog/products/:slug` | Public |  | Product detail |
| GET | `/api/v1/catalog/product-cards` | Public |  | Resolve product references into verified cards |
| GET | `/api/v1/catalog/bulk-pricing` | Public (customer optional) | optionalCustomer | Show what one piece of a product costs at a given quantity, for each way of buying it, so the shopper can see the price drop as the quantity goes up. Anyone can ask; a signed-in business buyer also sees prices kept for business accounts and for their delivery country. |
| GET | `/api/v1/catalog/products/:slug/reviews` | Public |  | A product's rating summary and one page of its published reviews. |
| GET | `/api/v1/catalog/content-blocks` | Public |  | The published banners or category blocks live now for a country and language. |
| GET | `/api/v1/catalog/label-requirements` | Public |  | The labelling the products in a basket must carry for a delivery country, for checkout to show. |
| GET | `/api/v1/catalog/destination-guidance` | Public |  | Importer instructions and documents a basket needs for a delivery country, for checkout to show. |

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

### `legal`

Defined in `backend/src/http/routes/legal.public.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/legal/current` | Public |  | The Terms in force now for a kind of account, in the reader's language where it is published. 503 TERMS_DOCUMENT_UNAVAILABLE when none are. |
| GET | `/api/v1/legal/versions` | Public |  | Every published version of a kind, newest first, so anybody can read the terms they agreed to at the time. |
| GET | `/api/v1/legal/in-force` | Public |  | The buyer terms and every published policy in force now, one per kind: titles and links for the help hub. |
| GET | `/api/v1/legal/documents/:id` | Public |  | One published document, of any version. Drafts are never returned. |
| GET | `/api/v1/legal/documents/:id/pdf` | Public |  | One published document as a PDF, built from exactly the stored text. |

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

### `preorder-chats`

Defined in `backend/src/http/routes/preorder-chats.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/preorder-chats/availability` | Public |  | Whether the team is here, and what this installation allows. Public: the chat button shows it to a guest before they sign in, and it is only ever true when somebody who can reply is actually connected. |
| GET | `/api/v1/preorder-chats/socket` | Public |  | The live connection. A GET that upgrades to a WebSocket. |
| POST | `/api/v1/preorder-chats/assistant` | Public (customer optional) | optionalCustomer | The preorder assistant, before anybody writes anything. Public: a guest can read the common answers without signing in. The questions offered, in order, and what the greeting may say - the product's name as the server reads it, and a signed-in customer's first name. Creates nothing. |
| POST | `/api/v1/preorder-chats/assistant/answer` | Public (customer optional) | optionalCustomer | One automated answer, from the product's own preorder terms, verified loading, stock and delivery window - never a guessed figure. Signed, so the customer can carry it into a conversation if they ask for a person. |

### `preorders`

Defined in `backend/src/http/routes/preorders.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/preorders/eligibility` | Public (customer optional) | optionalCustomer | Can this product be preordered, and on what terms? |

### `service-status`

Defined in `backend/src/http/routes/governance.admin.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/service-status` | Public |  | Whether card payments may be failing right now, as a yes or no for the storefront's notice. No detail. |

### `sitemap.xml`

Defined in `backend/src/http/routes/sitemap.public.ts`.

| Method | Path | Who | Guard | What it does |
|---|---|---|---|---|
| GET | `/api/v1/sitemap.xml` | Public |  | Public and unauthenticated, which is what a sitemap has to be. |


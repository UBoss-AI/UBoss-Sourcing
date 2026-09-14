# UBOSS Seller Hub — implementation plan and impact analysis

This is the repository-specific plan for turning UBOSS Sourcing from a
single-operator storefront into a marketplace with third-party sellers. It
records what already exists, what is being added, what is deliberately reused,
and what cannot be finished without a decision or a credential the repository
does not hold.

## 1. What the repository already has

The Seller Hub is not built on an empty floor. These are load-bearing and are
reused rather than duplicated:

| Concern | Where it lives today | How the Seller Hub uses it |
|---|---|---|
| Authentication, sessions, CSRF | `backend/src/http/plugins/auth.ts`, `modules/identity` | A seller signs in with the **same** customer login. No second credential. |
| Tenancy pattern | `BuyerOrganization` / `BuyerOrganizationMember` / `BuyerOrganizationInvite` | `SellerAccount` / `SellerMember` / `SellerInvitation` copy this shape exactly. |
| Shared catalogue | `Product`, `ProductVariant`, `Category`, `ProductMedia` | A seller does **not** get a private product table. It creates or matches a `Product` and attaches a `SellerOffer`. |
| Money | `domain/money.ts`, `BigInt` minor units | Every seller price, commission, settlement and payout figure. No floats. |
| Order status | `domain/order-state-machine.ts`, `assertTransition` | Seller order actions call the existing machine. No service writes `status`. |
| Stock | `InventoryBalance`, `InventoryMovement`, `StockReservation` | Seller stock is a parallel ledger keyed by `SellerLocation`, using the same movement/versioning discipline. |
| Payments | `modules/payments`, Stripe + Razorpay adapters, signed webhooks | Payout uses the same adapter boundary. Nothing is confirmed by a redirect. |
| ERP | `modules/integrations` (operator) and `modules/customer-erp` (buyer) | Seller ERP is a **third** tenant of the same outbound-HTTP and secret handling, not a fork of either. |
| Errors | `domain/errors.ts` | New codes only. No existing code is repurposed. |
| Audit | `AuditLog` | Every seller decision writes one. |

Two facts from `CLAUDE.md` shape most of the schema below: the database is
**MariaDB 10.4** (no `SKIP LOCKED`, no native UUID, `NULL`s distinct in a
`UNIQUE` index), and **every business detail is a setting** because each buyer
of this product runs their own deployment.

## 2. The one decision that shapes everything else

**A seller is a tenant, not a flag on a user.**

`SellerAccount` is the tenant. `SellerMember` joins a `CustomerProfile` to it
with a role. Every seller-scoped row carries `sellerAccountId`, and every
seller route resolves the caller's membership *server-side* and filters by it —
an id in a URL is never trusted. This is the same rule `BuyerOrganization`
already follows, and it is what makes cross-seller data access a schema
property rather than a review checklist item.

The second decision follows from it: **the catalogue product and the seller's
offer are separate rows.** Ten sellers offering the same infusion pump produce
one `Product` and ten `SellerOffer`s. Putting the price on the product would
make "the same product" mean "the same price", which is not what a marketplace
is.

## 3. Data model added

All new models live at the end of `backend/prisma/schema.prisma` behind a
banner comment, in one migration.

**Tenancy and onboarding**
`SellerAccount`, `SellerMember`, `SellerInvitation`, `SellerOnboardingProgress`,
`SellerBusinessProfile`, `SellerVerificationCase`, `SellerDocument`,
`SellerAgreementAcceptance`, `SellerPayoutAccountReference`, `SellerLocation`.

**Catalogue**
`Brand`, `BrandRequest`, `CategoryAttributeDefinition` (the backend schema the
listing wizard renders from — it does not exist yet and the wizard cannot be
data-driven without it), `SellerListingDraft`, `SellerListingDraftMedia`,
`SellerListingIssue`, `SellerOffer`, `SellerPriceTier`, `SellerOfferPackaging`.

**Operations**
`SellerInventory`, `SellerInventoryMovement`, `SellerBulkImportJob`,
`SellerOrderGroup`, `SellerShipment`, `SellerReturn`, `SellerSettlement`,
`SellerSettlementLine`, `SellerPayout`, `SellerNotification`, `SellerAuditLog`.

**Impact on existing tables.** `Product` gains `isMarketplaceProduct` and
`createdBySellerAccountId` (both nullable/defaulted, so every existing row is
unaffected). `Order` gains nothing — seller scope is expressed by
`SellerOrderGroup` rows pointing at `OrderItem`s, so an existing order keeps
behaving exactly as it does today.

**GDPR.** `SellerMember` and `SellerInvitation` reference a person. Both are
added to `SECTIONS` in the Art. 15 export bundle, or the
`export-bundle-completeness` test fails — which is the test doing its job.

## 4. Domain rules given their own module

- `domain/seller-state.ts` — `assertSellerApplicationTransition` and
  `assertListingTransition`. Same rule as order and schedule status: nothing
  writes these columns directly.
- `domain/seller-permissions.ts` — the seven seller roles from the brief and
  their grants, mirroring `domain/permissions.ts`.
- `domain/listing-completeness.ts` — the single implementation of "is this
  section complete, and how many of its fields are filled". The wizard's
  counters and the submit gate both call it, for the same reason `quoteSchedule`
  is the only pricing implementation: two answers to one question is how a
  seller is told a listing is ready and then refused.
- `domain/title-rules.ts` — deterministic title generation from permitted
  attributes, server-side only.

## 5. Surfaces

**Storefront (`apps/customer-web`)** gains a `/seller` section with its own
shell, because a seller workspace is not an account page: it has its own
navigation, its own density and its own mode. `Become a seller` is added to the
header and the account menu. Public `/sell` explains the programme.

**Admin panel (`apps/admin-web`)** gains seller applications, document review,
brand requests and listing moderation under a new `Marketplace` group.

## 6. Production blockers — stated, not simulated

These cannot be completed here and are **not** faked with a success screen. Each
one renders a "configuration required" state naming the environment variable:

1. **Stripe Connect** (`STRIPE_CONNECT_CLIENT_ID`, onboarding return URLs). No
   Connect account exists for this deployment. Payout onboarding therefore
   stops at "connect your account" and records no verified state.
2. **Bank / penny-transfer verification** (screenshots 11–13). There is no bank
   verification provider configured. The adapter boundary exists; the only
   implementation is `unconfigured`.
3. **E-signature.** A drawn signature is recorded as *consent with a policy
   version and a timestamp*, never as a verified legal signature. An approved
   e-sign provider goes behind the same adapter.
4. **Malware scanning and image moderation.** Hooks exist and are called; no
   scanner is configured, so uploads are marked `PENDING_SCAN` and are not
   publicly readable until an operator approves.
5. **Commission policy.** Rates are configurable settings with a zero default.
   Choosing them is a business decision, not an engineering one.

## 7. Order of work

1. Schema + migration + seed of seller roles, brands, category attributes.
2. Domain modules and error codes.
3. Backend services and routes, seller then admin.
4. Storefront seller shell, onboarding, dashboard, listings, wizard.
5. Admin review screens.
6. Tests: tenant isolation first, because it is the one failure that cannot be
   patched after release.
7. `PROJECT-GUIDE.md`, its Hinglish twin, and the feature-guide script.

## 8. What was built, and what was not

Written after the work rather than before it, so it describes what is actually
in the repository.

**Working end to end, verified against the running application:**

- Become a seller from the storefront header, under the existing customer login.
- The eight-step application, saving per step, with country- and kind-specific
  requirements from `SellerOnboardingRequirement` — a German seller is refused a
  UK VAT number by the seeded pattern.
- Submission gated on required steps, naming each outstanding one.
- The admin review queue and the full application detail screen, with approve,
  send back, reject and suspend — every refusal demanding a seller-visible
  reason, and a separate internal note that never reaches a seller route.
- Optimistic concurrency on the decision, so two reviewers cannot overwrite one
  another.
- The three-step listing wizard, rendering its fields from the category schema.
  A fastener category asks 22 questions and two photographs; a medical-device
  category asks 28 and four, including a readable UDI label.
- Deterministic title generation, with the contributing fields named.
- The seller dashboard, listings, inventory, orders, payments and profile
  screens, on live data.
- Tenant isolation: a second approved seller reading another seller’s draft by
  id gets 404, and sees an empty workspace of their own.

**Present but not exercised end to end:** bulk import, variants, returns and
disputes, settlement generation, and the seller ERP connection. The schema,
the domain rules and the routes for these exist and typecheck; there is no
screen driving them yet.

**Deliberately stopped at a boundary** — the five production blockers in
section 6 above. Each renders a configuration-required state naming the missing
setting. None of them fakes a success.

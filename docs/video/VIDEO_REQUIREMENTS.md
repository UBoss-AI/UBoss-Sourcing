# Gloviaa Mart — Video Requirements

> **Status: DRAFT FOR APPROVAL.** Discovery and rehearsal were done on 2026-10-01
> against the local development environment. Every decision marked
> **PROVISIONAL** uses the recommended option from the discovery report and
> waits for the owner's approval. Nothing here authorises Runway generation.
> No Runway credits have been used.

Companion documents:

| Document | Purpose |
|---|---|
| [ABOUT_US_VIDEO_BRIEF.md](ABOUT_US_VIDEO_BRIEF.md) | Creative brief for the brand film |
| [PRODUCT_DEMO_VIDEO_BRIEF.md](PRODUCT_DEMO_VIDEO_BRIEF.md) | Brief for the presenter-led application demo |
| [VIDEO_ASSET_REGISTER.md](VIDEO_ASSET_REGISTER.md) | Every asset, where it is, who owns it, what is missing |
| [VIDEO_CAPTURE_PLAN.md](VIDEO_CAPTURE_PLAN.md) | Every screen recording, shot by shot |
| [RUNWAY_HANDOFF.md](RUNWAY_HANDOFF.md) | The package the Runway production phase starts from |

Evidence screenshots (1920×1080, taken 2026-10-01) are in
`verification-evidence/video-discovery/2026-10-01/` and are referred to below as
`EV-nn`.

---

## 1. Project summary

Gloviaa Mart is a sourcing marketplace for business and individual buyers. It
connects buyers with sellers and manufacturers, starting from India, and
coordinates what happens after the order: documents, inspection, and delivery
planned leg by leg.

- **Buyers** search a catalogue, see prices in their own currency and language,
  and order from several sellers in one checkout. Companies buy through a
  company account that the marketplace team checks first.
- **Larger needs** become bulk orders, preorders (by piece or by shipping
  container) or requests for quotation.
- **Sellers** apply, are reviewed, then manage listings, stock, prices,
  documents and delivery from their Seller Hub.
- **Delivery** is planned in four levels: L1 factory to port of loading, L2 the
  international haul, L3 destination inland, L4 last mile. Each level can be run
  by the seller or by the marketplace.
- **Logistics partners** work in their own portal. **Inspection agencies** can
  be required to pass goods before dispatch.

The software is a product other companies buy and run themselves. Gloviaa Mart
is the brand of this deployment.

**Readiness.** The platform is not live. `SECURITY-AUDIT-REPORT.md` (21 Sep 2026)
says "DO NOT RELEASE TO PRODUCTION" and `Checklist.md` records an overall NO-GO.
**No video may state or imply that the service is operating, available, or
serving customers today.**

## 2. Brand identity

The brand hierarchy, exactly as written (spelling, capitals, vertical bar):

```
Gloviaa Mart
Source with Intelligence | Deliver with Confidence
Powered by UBOSS
```

| Element | Rule |
|---|---|
| Product name | **Gloviaa Mart** — double "a". Never "Glovia", "Glovia Mart", "Gloviaa Market". |
| Tagline | **Source with Intelligence \| Deliver with Confidence** |
| Parent attribution | **Powered by UBOSS** — UBOSS in capitals. |
| Origin | India |
| Market | Global B2B and B2C commerce; first international focus Europe, beginning with Poland |
| Personality | Trustworthy, intelligent, global, premium, human, transparent, enterprise-ready, technology-enabled |

**Banned:** "The Way to the World" must not appear in any script, narration,
caption, storyboard, title card or Runway prompt.

**Conflict with the running application (blocker B-01).** The application
currently shows a different tagline, **"The Way to the Global Sourcing"**, in the
storefront header on every page, the home hero, the About page heading, and the
admin and logistics brand lockups. It is set in `apps/*/src/lib/brand.ts`
(`PRODUCT_TAGLINE`). The approved words appear only as rotating hero words
("Source with Intelligence", "Deliver with Confidence"). This line is not
approved either, and it is on screen in every recording. See §17.

**Two further brand inconsistencies on screen:**

- The preorder chat header reads "**UBoss** team is currently offline" (EV-15),
  and logistics timelines say "**UBoss** operations" (EV-26). The approved
  casing is UBOSS. The chat team name is a deployment setting
  (`OPERATOR_TEAM_NAME`), so this is a configuration change, not code.
- In Polish the approved tagline appears translated ("Inteligentne zakupy.
  Pewna dostawa.") while the header line stays in English (EV-21). Whether the
  tagline is ever translated is decision D-11.

## 3. Business objectives (PROVISIONAL — D-03)

| Rank | Objective |
|---|---|
| Primary | Build trust with European company buyers and procurement teams |
| Secondary 1 | Attract Indian manufacturers and export-focused sellers |
| Secondary 2 | Explain the connected ecosystem (buyers, sellers, logistics, inspection) |

## 4. Target audiences (PROVISIONAL — D-03)

| Priority | Audience | Main video |
|---|---|---|
| 1 | Company buyers and procurement teams (Europe, Poland first) | About Us, buyer demo |
| 2 | Indian sellers, manufacturers, export-focused businesses | About Us, seller demo |
| 3 | Individual buyers | Overview demo |
| 4 | Logistics companies, inspection agencies | Internal / later role videos |
| 5 | Enterprise partners, investors | About Us (re-used in presentations) |

## 5. Video placement requirements

| Placement | About Us | Demo overview | Role demos |
|---|---|---|---|
| About Us page | Yes — master | — | — |
| Homepage | Muted autoplay cut, captions burned in | — | — |
| Seller onboarding (`/sell`) | 30-second cut | — | Seller demo |
| Buyer onboarding / help | — | Yes | Buyer demo |
| Company / sales presentations | Master | Yes | On request |
| Investor presentation | Master | Yes | — |
| YouTube | Master | Yes, with chapters | Yes |
| LinkedIn | 30-second and 1:1 cuts | Teaser | — |
| Instagram | 9:16 cut | — | — |

## 6. Verified feature matrix

### Status definitions used

| Status | Meaning in this document |
|---|---|
| VERIFIED | Rendered correctly in the running app on 2026-10-01 **and** its automated tests passed in the last recorded run (backend 5,119, storefront 1,736, admin 345 — all passing, logs `output/pass8-*-verify-b2.log`). Where the workflow was clicked through in rehearsal this is said. |
| IMPLEMENTED, NOT VERIFIED | Code and tests exist; not seen working end to end in the running app |
| PARTIAL | Only part of the workflow exists |
| UI ONLY | Screen without a complete backend |
| BLOCKED | Needs credentials, configuration, data or an external service |
| BROKEN | Present but failing |
| PLANNED | Documented, not built |
| UNKNOWN | Not enough evidence |

Note: the working tree held uncommitted changes (checkout, postal codes and
others, made by work running in parallel) after the last recorded test run.
Re-run every `verify` before the capture day.

### 6.1 Buyer experience

| Feature | Role | Route | Status | Evidence / inspection | Public? | Demo data? | Creds? | Sensitive? | Decision | Narration limitation |
|---|---|---|---|---|---|---|---|---|---|---|
| Homepage, hero, globe, quick start | Guest, buyer | `/` | VERIFIED | EV-01, EV-10; `home-route.test.tsx` | Yes | Yes — remove test categories | No | No | Include after B-01, B-02 | — |
| Header and navigation | All | every page | VERIFIED | EV-01; `chrome.test.tsx` | Yes | No | No | No | Include | No search box in header by design |
| Catalogue and categories | Guest, buyer | `/products`, `/category/:slug` | VERIFIED | EV-03; 663 products; `CatalogPage.test` | Yes | **Yes** — test residue | No | No | Include after B-02 | — |
| Text and voice search | Guest, buyer | `/search` | VERIFIED | `/search?q=gloves` returned results; `voice-search.test` | Yes | Yes | No | No | Include | — |
| B2B sourcing filters | Buyer | `/search?...` | IMPLEMENTED, NOT VERIFIED | `SourcingFilters.test` | Yes | Yes | No | No | Include after rehearsal | — |
| Image search | Buyer | home hero dialog | BLOCKED | Needs AI provider within quota; uploads need malware scanning | — | — | AI key, scanner | No | Postpone | — |
| AI Assistant | Buyer (signed in) | `/ai` | **BLOCKED** | Rehearsed: reply was "The assistant has reached its limit for now" (EV-19). Known cause: the catalogue prompt exceeds the Gemini free-tier input limit | — | Yes | Paid AI quota | Sidebar shows earlier chats and the account email | **Postpone** until it answers on camera | "Generated by AI. Check product codes and prices before ordering." |
| Product cards | All | catalogue, home | VERIFIED | EV-03 | Yes | Yes | No | No | Include | — |
| Product detail: description, specifications, variants, stock | Guest, buyer | `/product/:slug` | VERIFIED (rehearsed variant choice and validation) | EV-04, EV-16; "Choose a Type to continue" shown correctly | Yes | **Yes** — current newest product is a third-party brand | No | No | Include with a clean product | — |
| Quantity selection | Buyer | product page | VERIFIED (rehearsed) | Quantity stepper used | Yes | — | No | No | Include | — |
| Quantity-based discounts (seller tiers, store ladder) | Buyer | product page | IMPLEMENTED, NOT VERIFIED | Only one product has seller tiers (the third-party one); 2 store-wide rules exist; "9% off" shown on demo goods | Yes | **Yes** | No | No | Include after B-02 | Discounts are the seller's or the store's settings |
| Add to Cart | Buyer | product page | VERIFIED (rehearsed, then removed) | EV-17 | Yes | — | No | No | Include | — |
| Schedule Cart, repeat purchases | Buyer | `/accounts/schedule`, `/account/schedules` | IMPLEMENTED, NOT VERIFIED | Demo buyer has no schedules | Yes | Yes | Stripe for unattended charges | No | Optional chapter | Unattended charging needs a saved card |
| Preorder | Buyer | product page dialog | VERIFIED (rehearsed to the form; not submitted) | EV-13, EV-14 | Yes | Yes | No | No | Include | "A request is not an order and charges nothing" (on screen) |
| Preorder minimum quantity | Buyer | preorder dialog | VERIFIED (rehearsed) | EV-13: "Minimum preorder quantity 1,000 pieces" | Yes | Yes | No | No | Include | — |
| Container preorder: 20-ft and 40-ft, pieces per container | Buyer | preorder dialog | **BLOCKED (data)** | EV-14: both options "not available — the seller has not configured the packing capacity". Only two variants in the database carry container data, and neither can be selected | Yes | **Yes — must be created** | No | No | Include after B-03 | Logistics cost reads "To be confirmed" |
| Preorder chat | Buyer | chat drawer, `/account/messages` | VERIFIED (UI opened; no message sent) | EV-15 | Yes | Yes | No | Name "UBoss" in header | Include after D-11 | Chat is with the marketplace team, not the seller |
| Suggested preorder questions | Buyer | chat drawer | IMPLEMENTED, NOT VERIFIED (cards seen, not tapped) | EV-15: 8 suggested questions | Yes | Yes | No | No | Include | **Not AI.** Answers are built from the product's own data and say "Needs confirmation" when data is missing |
| Human-agent escalation | Buyer | "Connect with a human agent" | IMPLEMENTED, NOT VERIFIED | `preorder-chat-assistant.test` | Yes | Yes | No | No | Include | The request is **queued**; never say an agent joins instantly |
| Cart | Buyer | `/cart` | VERIFIED (rehearsed) | EV-17 | Yes | — | No | No | Include | Freight quote from the cart is not built |
| Checkout | Buyer | `/checkout` | VERIFIED in INR (rehearsed and recorded up to "Place order and pay"; not pressed). **BLOCKED in PLN (B-13)** | EV-18; draft recording 2026-10-02 | Yes | Yes | No | Delivery address shown | Include after B-13 for the Poland context | — |
| Stripe test payment | Buyer | `/checkout/payment/:id` → Stripe | **BLOCKED** | Local setting makes payments succeed without Stripe; no webhook reaches this machine | Yes (test card only) | Yes | Stripe test keys, webhook forwarding | Card number | Include after B-05 | Show "test mode"; never imply a real charge |
| Saved payment method | Buyer | `/account/payment-methods` | VERIFIED (screen) | Page loads; `payments.test` | Caution | — | Stripe | Card last digits | Optional | — |
| Payment confirmation | Buyer | confirmation page, order page | VERIFIED (screen) | EV-12: "Payment confirmed with Stripe" on an existing order | Yes | Yes | — | — | Include | Confirmed only by the payment provider's signed message, never by the browser redirect |
| Buyer orders and order history | Buyer | `/account/orders`, `/account/orders/:id` | VERIFIED | EV-11, EV-12 | Yes | **Yes** — current orders contain the third-party product | No | Name, address, card last digits | Include with fictional data | — |
| Buyer messages | Buyer | `/account/messages` | VERIFIED (screen) | Page loads | Yes | Yes | No | Conversation text | Optional | Preorder chats only; no general seller inbox |
| Shipment tracking L1–L4 | Buyer | order detail | IMPLEMENTED, NOT VERIFIED | `OrderTracking.test`; nothing renders for an order not priced on four levels | Yes | **Yes — a purpose-built order** | Carrier creds for automatic events | Address | Include after B-03 | **No live GPS, no live carrier tracking.** Say "leg-by-leg visibility" |
| Language selection (8) | All | header menu | VERIFIED (rehearsed Polish) | EV-21 | Yes | — | No | No | Include | Product names and category names stay in their original language |
| Currency conversion | All | header menu | VERIFIED (rehearsed PLN and EUR) | EV-22: 229,99 zł | Yes | — | No | No | Include after B-06 | Rates refresh daily, not live |
| Theme switching (light, dark, system) | All | header | VERIFIED (screen) | `ThemeToggle.test`; dark captures in `output/brand-verify` | Yes | — | No | No | Optional | — |

### 6.2 Buyer account types

| Feature | Route | Status | Evidence | Public? | Decision | Narration limitation |
|---|---|---|---|---|---|---|
| Individual sign-in | `/login` (Individual tab) | VERIFIED (rehearsed many times) | EV-05 | Yes | Include | — |
| Company sign-in | `/login` (Company tab) → `/select-company` | IMPLEMENTED, NOT VERIFIED | EV-05 shows the tab; `LoginPage.buyer-type.test` | Yes | Include after rehearsal | The tab is a preference; the company is chosen after sign-in |
| Individual registration | `/register` | IMPLEMENTED, NOT VERIFIED | Form renders; finishing it sends a **real email** | Form only | Show the form; do not submit unless the email driver is switched to log mode | Email confirmation is required |
| Company registration | `/register/company` | IMPLEMENTED, NOT VERIFIED | EV-06; six-step wizard; `CompanyWizard.test` | Yes | Include (pre-filled synthetic company) | — |
| Business information (GSTIN, PAN, EU VAT, NIP, REGON, KRS, LEI…) | wizard | IMPLEMENTED, NOT VERIFIED | `buyer-company-domain.test` | Yes | Include with fictional, checksum-valid numbers | Most numbers are format-checked only |
| Company verification | admin review | IMPLEMENTED, NOT VERIFIED | `buyer-companies.test` (31 cases) | Internal | Internal video | **A person decides**; registry checks support them. No Indian GST registry lookup |
| Administrative approval (sign-up gate) | admin | IMPLEMENTED, NOT VERIFIED | Flag-parked: instant sign-in is the local setting | Internal | Exclude from public | — |
| B2C maximum-order restriction | product page, cart | IMPLEMENTED, NOT VERIFIED | `B2cLimitDialog.test` | Yes | Include after rehearsal | Limit is set per product by the seller |
| Switching or upgrading to a company account | account menu | IMPLEMENTED, NOT VERIFIED | `CompanyStatusBanner.test` | Yes | Optional | An individual *applies* for a company; there is no in-place conversion |
| Company purchasing access (team roles) | `/account/companies/:id` | IMPLEMENTED, NOT VERIFIED | `CompanyTeamPanel.test` | Yes | Optional | Only approved companies manage a team |

### 6.3 Seller Hub

All Seller Hub screens are **BLOCKED for capture today**: the Hub asks for its
own password after the shop sign-in (EV-20), and no seller password is seeded.
The owner must sign in, or a demo seller must be prepared (B-04).

| Feature | Route | Status | Evidence | Decision | Narration limitation |
|---|---|---|---|---|---|
| Onboarding, application | `/sell`, `/seller/onboarding` | IMPLEMENTED, NOT VERIFIED (`/sell` VERIFIED, EV-09) | `seller-onboarding-steps.test` | Include | Every application is checked before anything goes live |
| Seller verification (KYB) | admin | IMPLEMENTED, NOT VERIFIED | `seller-application-review.test` | Internal | Uploads wait for a malware scan; no scanner is configured, so they stay pending |
| Seller profile | `/seller/profile` | IMPLEMENTED, NOT VERIFIED | `seller-logo.test` | Include | Profile changes go to review |
| Product listing | `/seller/listings/new` | IMPLEMENTED, NOT VERIFIED | `seller-variant-listing.test` | Include | Listings are reviewed before they publish |
| Product editing | `/seller/listings/:id/edit` | IMPLEMENTED, NOT VERIFIED | `SellerListingEditPage.test` | Include | — |
| Inventory | `/seller/inventory` | IMPLEMENTED, NOT VERIFIED | backend test only | Include | — |
| B2C maximum order quantity | listing edit | IMPLEMENTED, NOT VERIFIED | `b2c-max-order-quantity.test` | Include | — |
| Preorder configuration | `/seller/preorders` | IMPLEMENTED, NOT VERIFIED | `preorders.test` | Include | — |
| Bulk pricing | quantity-tier panel | IMPLEMENTED, NOT VERIFIED | `quantity-tiers.test` | Include | — |
| Order notifications | `/seller/notifications` | IMPLEMENTED, NOT VERIFIED | `fulfilment-notifications.test` | Include | In-app; email depends on setup; no SMS |
| Order confirmation | `/seller/orders/:id` | IMPLEMENTED, NOT VERIFIED | `seller-consignment-logistics.test` | Include | Buyer contact and payment details are hidden from the seller |
| Invoice (PDF) | consignment documents | IMPLEMENTED, NOT VERIFIED | `seller-documents.test` | Include with a fictional, checksum-valid GSTIN | The seeded seller GSTIN fails its checksum, so documents for it are refused by design |
| Packing list (PDF) | consignment documents | IMPLEMENTED, NOT VERIFIED | `seller-documents.test` | Include | The carrier sees the packing list, never the invoice |
| Logistics assignment | consignment logistics panel | IMPLEMENTED, NOT VERIFIED | `seller-logistics-assignment.test` | Include | — |
| Self Ship / UBOSS logistics / Self + UBOSS | `/seller/logistics` | IMPLEMENTED, NOT VERIFIED | `seller-logistics-levels.test` | Include | L1 always belongs to the seller |
| L1–L4 pricing | `/seller/logistics` | IMPLEMENTED, NOT VERIFIED | `seller-logistics-levels.test` | Include | — |
| DHL | `/seller/carriers` | BLOCKED | Never run against DHL live; shows "API credentials required" | Show the setup state only | Credentials belong to each seller |
| FedEx | `/seller/carriers` | BLOCKED | Never called | Show the setup state only | Same |
| India Post | `/seller/carriers` | PARTIAL by design | Manual tracking reference; never shown as connected | Optional | No API exists |
| Seller-managed logistics | fulfilment settings | IMPLEMENTED, NOT VERIFIED | `seller-fulfilment-methods.test` | Include | — |
| Shipment progress | order legs panel | IMPLEMENTED, NOT VERIFIED | `acceptance-seller-to-doorstep.test` | Include | Without carrier credentials, updates are entered by hand |
| Seller messages | RFQ threads only | PARTIAL | `SellerRfqPages.test` | Exclude | No general buyer–seller inbox |
| Seller analytics | `/seller/performance` | IMPLEMENTED, NOT VERIFIED | `SellerPerformancePage.test` | Optional (synthetic numbers) | — |

### 6.4 Logistics Portal (port 5175)

Signed in as the dispatcher account. The owner account must enrol two-step
sign-in first.

| Feature | Route | Status | Evidence | Decision | Narration limitation |
|---|---|---|---|---|---|
| Partner sign-in | `/login` | VERIFIED | Rehearsed | Include | Partners join by invitation only; owners use two-step sign-in |
| Partner profile | `/profile` | VERIFIED (screen) | Shows an email | Optional | — |
| Assigned deliveries | `/shipments` | VERIFIED (screen) | EV-25 | Include after B-03 | — |
| Shipment detail and timeline | `/shipments/:id` | VERIFIED (screen) | EV-26: "no longer assigned", "Live location unavailable", "UBoss operations" | Include after B-03 | — |
| Driver creation and list | `/drivers` | VERIFIED (screen) | EV-27 | Include | Not for DHL or FedEx shipments |
| Driver assignment | shipment detail | IMPLEMENTED, NOT VERIFIED | `logistics-driver-assignment.test` | Include after rehearsal | — |
| Status updates | shipment detail | IMPLEMENTED, NOT VERIFIED | `logistics-shipment-state.test` | Include after rehearsal | — |
| Tracking updates | timeline | IMPLEMENTED, NOT VERIFIED | `logistics-carrier-webhook.test` | Include | No live GPS |
| Proof of delivery | dialog | IMPLEMENTED, NOT VERIFIED | `logistics-pod.test` | Include after rehearsal | Delivery code goes by email; there is no SMS. Open defect: a required delivery code can never be issued |
| L1–L4 delivery legs | `/legs` | VERIFIED (screen) | EV-28 | Include | — |
| DHL / FedEx credential status | `/integration` | BLOCKED | Dispatcher sees "Access restricted" (correct permission) | Exclude | — |
| India Post configuration | seller side | PARTIAL by design | — | Exclude | — |
| "Credentials required" behaviour | Seller Hub, admin | IMPLEMENTED, NOT VERIFIED | `seller-carrier-connections.test` | Show once, in the seller video | — |
| Admin logistics visibility | admin `/logistics/*` | IMPLEMENTED, NOT VERIFIED | `logistics-admin-oversight.test` | Internal | — |

Data problems seen: shipments are 13–17 days stale, none has a driver, and
"Rotterdam Medisch Centrum" is shown as Rotterdam, **DE** (Rotterdam is in the
Netherlands). Synthetic logistics data is required (B-03).

### 6.5 Inspection workflow

Inspectors use the storefront (`/inspection`) through an agency membership.
Operators use the admin console. **No demo agency or inspector account is
seeded for capture.**

| Feature | Status | Evidence | Decision | Limitation |
|---|---|---|---|---|
| Agency onboarding (operator creates agency) | IMPLEMENTED, NOT VERIFIED | `inspection-http.test` end to end | Internal | Agencies cannot sign up themselves |
| Agency verification / suspension | PARTIAL | Suspension has no route; new agencies start active | Exclude | — |
| Inspector identity verification | PARTIAL | API only; no admin button | Exclude | — |
| Inspector qualification | IMPLEMENTED, NOT VERIFIED | assignment refuses unqualified inspectors | Internal | Set through the API only |
| Job booking (admin or buyer) | IMPLEMENTED, NOT VERIFIED | `BuyerBookingForm.test` | Internal / later | — |
| Conflict-of-interest declaration | IMPLEMENTED, NOT VERIFIED | E2E test | Internal | — |
| Seller readiness check | IMPLEMENTED, NOT VERIFIED | `InspectionPanel.test` | Internal | — |
| Packing-list requirement | IMPLEMENTED, NOT VERIFIED | readiness refused without an issued packing list | Internal | — |
| Assignment, checklist, sampling (ISO 2859-1) | IMPLEMENTED, NOT VERIFIED | sampling table itself has no test | Internal | Plans are edited as raw JSON |
| Defect recording, evidence upload | IMPLEMENTED, NOT VERIFIED | E2E test | Internal | Admins cannot open evidence |
| Report submission, QA approval | IMPLEMENTED, NOT VERIFIED | E2E test | Internal | — |
| PASS / FAIL | IMPLEMENTED, NOT VERIFIED | derived from findings, never chosen | Internal | — |
| Failed inspection blocks shipment | **UNKNOWN — conflicting evidence** | Gate tests pass, but `Checklist.md` LIVE-008 says a seller can dispatch without inspection | **Exclude** until resolved | — |
| Buyer / seller result visibility | IMPLEMENTED, NOT VERIFIED | E2E test | Internal | — |
| Reinspection | IMPLEMENTED, NOT VERIFIED | needs corrective action first | Internal | — |

### 6.6 Admin Panel (port 5173)

**All admin screens are BLOCKED for capture**: the owner account requires
two-step sign-in (EV-23). The owner must sign in personally for any capture.
Admin screens hold internal data (§12) and are **internal-only** (PROVISIONAL —
D-05).

| Feature | Route | Status | Decision |
|---|---|---|---|
| Dashboard | `/` | IMPLEMENTED, NOT VERIFIED | Internal |
| Individual-buyer management | `/customers` | IMPLEMENTED, NOT VERIFIED | Internal (personal data) |
| Company-buyer verification | `/buyer-companies` | IMPLEMENTED, NOT VERIFIED | Internal |
| Seller verification | `/sellers`, `/listing-review` | IMPLEMENTED, NOT VERIFIED | Internal |
| Logistics-partner oversight | `/logistics/partners` | IMPLEMENTED, NOT VERIFIED | Internal |
| Driver visibility | shipment detail | PARTIAL (no live map) | Internal |
| Inspection-agency oversight | `/inspection-setup` | PARTIAL | Exclude |
| Inspection results | `/inspection` | IMPLEMENTED, NOT VERIFIED | Internal |
| Preorder chat (human agent side) | `/preorder-chats` | IMPLEMENTED, NOT VERIFIED | Internal |
| Order oversight | `/orders` | IMPLEMENTED, NOT VERIFIED | Internal |
| Payment oversight | `/payments`, `/finance/ledger` | IMPLEMENTED, NOT VERIFIED | Exclude (financial) |
| Warehouse map | `/warehouses` | IMPLEMENTED, NOT VERIFIED (no tests) | Internal |
| Seller warehouse search | `/warehouses` | IMPLEMENTED, NOT VERIFIED | Internal |
| Notifications | bell, templates | IMPLEMENTED, NOT VERIFIED | Internal |
| Commission invoice | `/finance/commission-invoices` | IMPLEMENTED, NOT VERIFIED | Exclude (tax figures) |
| Role and permission controls | `/staff` | IMPLEMENTED, NOT VERIFIED (fixed role list; no custom editor) | Exclude (security) |
| Audit history | `/audit` | IMPLEMENTED, NOT VERIFIED | Exclude (IP addresses, emails) |

### 6.7 Integrations

| Integration | Status | What it means for the videos |
|---|---|---|
| Stripe | IMPLEMENTED; **BLOCKED** for a real test payment (B-05) | Test mode only; webhook forwarding required |
| Gemini AI | **BLOCKED** — quota exhausted on rehearsal | Postpone AI chapter |
| Currency rates (open.er-api.com or ECB) | IMPLEMENTED | Say "daily rates", never "real-time" |
| Translation (DeepL) | Build-time only | Say "available in eight languages", never "real-time translation" |
| DHL | BLOCKED — never run live | Show setup state only |
| FedEx | BLOCKED — never called | Show setup state only |
| India Post | Manual by design | Optional |
| Operator warehouse ERP | IMPLEMENTED, NOT VERIFIED | Do not demo |
| Buyer purchasing ERP | IMPLEMENTED, NOT VERIFIED | Mention only as "can connect" |
| Tally | PARTIAL — bridge agent not in the repository | Exclude |
| Email | IMPLEMENTED — **real SMTP in development** | Any sign-up or invitation sends real email |
| Real-time messaging (chat) | IMPLEMENTED | — |
| Maps (MapLibre, OpenFreeMap, Esri imagery) | IMPLEMENTED | Attribution must stay visible |
| PDF documents | IMPLEMENTED | — |
| SMS, Google sign-in, payouts provider, Polish e-invoicing (KSeF) | PLANNED / BLOCKED | Never mention as built |

## 7. About Us video requirements

See [ABOUT_US_VIDEO_BRIEF.md](ABOUT_US_VIDEO_BRIEF.md). Summary (all
PROVISIONAL):

| Item | Requirement |
|---|---|
| Objective | Trust with European company buyers; secondary: Indian sellers, ecosystem |
| Duration | 75 seconds master (range 60–90), plus 30-second and 15-second cuts |
| Balance | Cinematic 70 / corporate 30 |
| Footage | Generated generic scenes plus real app screens; real footage only with rights |
| App screens | Two or three short inserts, only after B-01 and B-02 are fixed |
| Globe | Yes — the rotating Gloviaa globe as the recurring motif |
| Narration | Same original synthetic voice as the demo presenter |
| Captions | English and Polish |
| Autoplay | Homepage: muted, captions burned in, loops cleanly |
| CTA | "Explore Gloviaa Mart" (D-12) |

## 8. Product-demo requirements

See [PRODUCT_DEMO_VIDEO_BRIEF.md](PRODUCT_DEMO_VIDEO_BRIEF.md). Summary
(PROVISIONAL — D-04):

| Video | Audience | Length | Phase |
|---|---|---|---|
| Platform overview | Everyone | 2:00 | 1 |
| Buyer demonstration | Company buyers, procurement | 5:00–6:00 | 1 |
| Seller demonstration | Indian sellers and manufacturers | 5:00–6:00 | 1 |
| Logistics demonstration | Logistics partners | 3:00–4:00 | 2 (after B-03) |
| Admin and inspection | Internal only | 5:00–6:00 | 2 (internal) |

## 9. Avatar requirements (PROVISIONAL — D-08)

| Item | Requirement |
|---|---|
| Identity | One consistent, original adult presenter. Not based on, and not resembling, any celebrity, public figure or real person. |
| Gender | Owner to confirm (D-08a). Default: female presenter |
| Approximate age | 30–40 |
| Appearance | Professional South Asian |
| Clothing | Business casual: plain navy or charcoal blazer over a light shirt; no logos, no patterns that flicker |
| Setting | Premium modern studio; soft neutral background with a subtle navy-to-blue gradient that matches the brand |
| Framing | Waist-up, eye-line slightly above centre, room on the right for on-screen text |
| Lighting | Soft key, gentle fill, light rim; no hard shadows |
| Eye contact | Natural, to camera |
| Gestures | Restrained; open hands; no pointing at things that are not on screen |
| Personality | Warm, calm, competent, trustworthy |
| Appearances | Full screen at the introduction and conclusion; full screen at chapter transitions (3–6 s); small picture-in-picture only where it covers no interface element |
| Driving performance | None required (D-08b). Option: owner supplies one with signed consent |
| Translated versions | English master; Polish captions. A Polish voice version is a separate decision (D-06) |

## 10. Voice requirements (PROVISIONAL — D-08)

| Item | Requirement |
|---|---|
| Voice | Original synthetic voice — not a clone of any real person |
| Accent | Clear international English, light Indian English warmth acceptable |
| Speed | 140–150 words per minute in the demo; 120–135 in the About Us film |
| Formality | Professional, plain words, no slang |
| Tone | Warm and confident; never hype |
| Pronunciation | "Gloviaa" = **glow-VEE-ah**; "UBOSS" = **YOO-boss** (D-13: owner to confirm both) |
| Same voice | One voice for the About Us narration and the demo presenter |

## 11. Screen-recording requirements

Full specification: [VIDEO_CAPTURE_PLAN.md](VIDEO_CAPTURE_PLAN.md) §1. Key points:

| Item | Requirement |
|---|---|
| Resolution | 1920×1080 capture area, 60 fps master (30 fps acceptable) |
| Browser | Chrome or Edge, clean profile, 100 % zoom, no extensions, bookmarks bar hidden |
| Viewport | 1920×1080 content area (kiosk/app window, no browser chrome in frame) |
| Data | Dedicated demo database only (B-02, B-03) — never the development database as it is today |
| Payments | Stripe test mode, test card 4242 4242 4242 4242, real webhook path |
| Email | Email driver switched to log mode for capture day |
| Privacy | Every frame reviewed before hand-off (§12) |

## 12. Security and privacy requirements

Never visible in any frame, caption or transcript:

- Passwords (the development passwords are in plain text in the repository and `SETUP.md`)
- API keys, webhook secrets, environment variables, tokens, cookies, browser DevTools
- Real card or bank details (Stripe test cards only)
- Real personal data: names, emails, phone numbers, addresses of real people
- Confidential seller information, business metrics, ledger or tax figures
- Internal security controls: two-step sign-in secrets, audit logs, staff list, permission settings, processor settings, risk signals
- The AI page history sidebar of any account other than the scripted demo account

Current data that must **not** be recorded as it is: seeded names that read as
real people (for example "Deepak Sharma", "Tomasz Bąk"), plausible real
addresses (for example a street address in Hamburg), placeholder support
contacts (`support@uboss.local`, `+91 80 4000 0000`), a demo brand that
resembles a real company ("Borosil Works"), the third-party brand product and
its image, and SPM's real catalogue unless permission is confirmed (D-02).

## 13. Accessibility requirements

- Captions on every deliverable: accurate, human-checked, max 2 lines, max 42 characters per line, at least 1 second per caption.
- Burned-in captions for all muted-autoplay and social cuts; separate SRT and WebVTT files for players that support them.
- On-screen text at least 4.5:1 contrast against its background; hold each title card at least 3 seconds.
- No flashing more than 3 times per second.
- Transcripts for every video, published next to it.
- Narration describes what is happening on screen, so the video also works audio-only.
- Callouts and zooms never rely on colour alone.

## 14. Deliverable matrix (PROVISIONAL — D-09)

| ID | Deliverable | Audience | Purpose | Duration | Ratio | Resolution | Format | Captions | Audio | Max size | Destination |
|---|---|---|---|---|---|---|---|---|---|---|---|
| AU-01 | About Us master | Buyers, sellers, partners | Brand trust | 75 s | 16:9 | 1920×1080 (4K upscale master AU-02) | MP4 H.264 | Separate file | Narration + music | 150 MB | About Us page, YouTube |
| AU-02 | About Us 4K master | Archive | Future cuts | 75 s | 16:9 | 3840×2160 | MP4 H.265 / ProRes | — | Stems | — | Archive |
| AU-03 | Website-optimised | Site visitors | Fast load | 75 s | 16:9 | 1920×1080 | MP4 H.264 + WebM | Burned in | Muted by default | 12 MB | About Us page |
| AU-04 | Homepage loop | Site visitors | Muted autoplay | 20–30 s | 16:9 | 1920×1080 | MP4 + WebM | Burned in | None | 6 MB | Homepage |
| AU-05 | 30-second cut | LinkedIn, sales | Short pitch | 30 s | 16:9 and 1:1 | 1920×1080 / 1080×1080 | MP4 | Burned in | Narration + music | 40 MB | LinkedIn, seller page |
| AU-06 | 15-second cut | Social ads | Awareness | 15 s | 9:16 | 1080×1920 | MP4 | Burned in | Music + 1 line | 20 MB | Instagram, Reels |
| AU-07 | Caption files | All | Accessibility | — | — | — | SRT + WebVTT (EN, PL) | — | — | — | With every player |
| AU-08 | Transcript | All | Accessibility | — | — | — | TXT / MD | — | — | — | With every video |
| AU-09 | Poster image | Site | Thumbnail | — | 16:9 | 1920×1080 | JPG / WebP | — | — | 300 KB | About Us page |
| DM-01 | Platform overview | Everyone | First look | 2:00 | 16:9 | 1920×1080 | MP4 | Separate + captioned version | Presenter | 200 MB | YouTube, sales |
| DM-02 | Buyer demonstration | Company buyers | How to buy | 5:00–6:00 | 16:9 | 1920×1080 | MP4 | Both versions | Presenter | 500 MB | Help centre, YouTube |
| DM-03 | Seller demonstration | Sellers | How to sell | 5:00–6:00 | 16:9 | 1920×1080 | MP4 | Both versions | Presenter | 500 MB | Seller onboarding |
| DM-04 | Logistics demonstration (phase 2) | Partners | How to deliver | 3:00–4:00 | 16:9 | 1920×1080 | MP4 | Both versions | Presenter | 350 MB | Partner onboarding |
| DM-05 | Admin and inspection (phase 2, internal) | Staff | Training | 5:00–6:00 | 16:9 | 1920×1080 | MP4 | Both versions | Presenter | 500 MB | Internal only |
| DM-06 | Screen-only versions | Help centre | Re-use | as above | 16:9 | 1920×1080 | MP4 | Captioned | Narration only | — | Help centre |
| DM-07 | Chapter markers | YouTube | Navigation | — | — | — | Timestamp list | — | — | — | YouTube description |
| DM-08 | Chapter clips | Help centre | Short how-tos | 20–60 s each | 16:9 | 1920×1080 | MP4 | Burned in | Narration | 60 MB | Help centre |
| DM-09 | Poster images | All | Thumbnails | — | 16:9 | 1920×1080 | JPG | — | — | 300 KB | Players |
| DM-10 | Social teaser | LinkedIn | Awareness | 20–30 s | 1:1 and 9:16 | 1080×1080 / 1080×1920 | MP4 | Burned in | Presenter line + music | 40 MB | LinkedIn |
| DM-11 | Transcripts and captions | All | Accessibility | — | — | — | SRT + WebVTT + TXT | — | — | — | With every video |

## 15. Decision register

Every decision below is **PROVISIONAL** until the owner approves it.

| ID | Decision | Provisional answer (recommended) | Alternatives |
|---|---|---|---|
| D-01 | Tagline conflict in the app | Fix the app's tagline in a separate, approved code task before any recording | Mask in post-production; avoid the header |
| D-02 | Demo data | A dedicated, clean demo database with fictional brand-safe products, sellers, buyers; a Polish company-buyer persona | Clean the current database; use SPM's real catalogue with written permission |
| D-03 | About Us objective and audience | Primary: trust with European company buyers. Secondary: Indian sellers; ecosystem | Seller-led; investor-led |
| D-04 | Demo structure | 2-minute overview + buyer + seller now; logistics and admin/inspection in phase 2 | One 15–20 minute video; overview only |
| D-05 | Admin and inspection screens | Internal-only video | Sanitised public screens; fully public |
| D-06 | Market setting | English interface, PLN prices, Poland buyer context; Polish caption track | INR / India; both |
| D-07 | Payment chapter | Genuine Stripe test-mode run with webhooks | Stop at the Stripe hand-off; omit |
| D-08 | Presenter and voice | Original synthetic South Asian presenter, business casual, original synthetic voice, same voice for both videos | Neutral appearance; real employee with consent |
| D-08a | Presenter gender | Female (default; owner to confirm) | Male |
| D-08b | Driving performance | None; Runway generates the performance | Owner supplies a consented recording |
| D-09 | About Us length and formats | 75-second master + 30 s + 15 s 9:16 + 1:1; EN + PL captions; muted homepage loop | 2–3 minute film; 30 s only |
| D-10 | Footage | Generated generic scenes with no identifiable brands, people or logos; app recordings; real footage only with rights; new vector logo lockup | All generated; real shoot |
| D-11 | Tagline in other languages and the chat team name | Tagline is never translated; chat team name set to "Gloviaa Mart team" or "UBOSS team" | Translate the tagline per language |
| D-12 | Closing CTA | "Explore Gloviaa Mart" with the site address once a public address exists | "Start sourcing"; "Apply to sell" (seller cut) |
| D-13 | Pronunciation | Gloviaa = glow-VEE-ah; UBOSS = YOO-boss | Owner's pronunciation |
| D-14 | Tax label for European markets | Resolve before any Poland-context recording (B-06) | Record India context only |

## 16. Open questions

1. Approve or change D-01 to D-14.
2. Does SPM Medicare permit its product photos and catalogue in public videos (D-02)?
3. What is the public web address the CTA should show (D-12)?
4. Who signs off the final cut: one person or a group (brand, legal, product)?
5. Is a Polish voice-over needed in phase 1, or captions only (D-06)?
6. Is there an existing UBOSS logo file outside this repository?

## 17. Blockers

| ID | Blocker | Affects | Owner | Resolution |
|---|---|---|---|---|
| B-01 | App shows unapproved tagline "The Way to the Global Sourcing" on every screen | Every recording; About Us app inserts | Product owner → developer | Change `PRODUCT_TAGLINE` in the three `brand.ts` files, the About heading, and the guides, as an approved code task |
| B-02 | Demo data unfit: test categories "RFQ … row21ui-", third-party brand product and image, real SPM catalogue, real-looking names and addresses | Every buyer and seller recording | Developer | Build a dedicated demo database and seed (synthetic data spec in PRODUCT_DEMO_VIDEO_BRIEF §7) |
| B-03 | No data for container preorder, L1–L4 order, active logistics shipments | Buyer, seller, logistics chapters | Developer | Part of the demo seed |
| B-04 | Seller Hub needs its own password; admin and logistics owner need two-step sign-in; no inspection agency accounts | Seller, admin, inspection captures | Owner | Prepare demo seller and agency accounts; owner signs in on capture day |
| B-05 | Payments set to succeed without Stripe locally; no webhook reaches the machine | Payment chapter | Developer | Turn off mock success on the demo environment; forward webhooks with the Stripe CLI |
| B-06 | Polish buyer sees "+ 18% GST18" | Poland-context recordings | Product owner | Decide the tax display for European buyers before recording |
| B-07 | AI Assistant hits its quota ("reached its limit for now") | AI chapter, About Us AI claims | Owner | Paid quota or smaller catalogue prompt; re-test |
| B-08 | No logo file of any kind; no UBOSS logo | Both videos | Owner / designer | Produce vector lockups (VIDEO_ASSET_REGISTER A-01…A-06) |
| B-09 | "UBoss" casing in chat header and logistics timeline | Chat and logistics recordings | Owner | Set the operator team name (configuration) |
| B-10 | Inspection gate evidence conflicts (LIVE-008) | Any inspection claim | Developer | Resolve and re-test before inspection is claimed or shown |
| B-11 | Platform not released (security audit NO-GO) | All claims | Owner | Narration must use "designed to" wording until launch |
| B-12 | Real SMTP in development | Registration and invitation chapters | Developer | Email driver set to log mode on the demo environment |
| B-13 | **A Poland / PLN purchase cannot be completed.** The cart refuses checkout: "Your account has agreed purchasing terms in INR, USD, not PLN. Switch to INR to place this order", and "None of our warehouses is close enough to deliver to Poland yet" (found while recording, 2026-10-02) | Buyer checkout and payment chapters in the Poland context | Developer / Owner | Demo buyer's agreed purchasing currencies must include PLN; a warehouse or delivery route that serves Poland must exist in the demo data |
| B-14 | **Bulk-savings box shows ₹ while the page is in PLN**: "Add 9 more pieces to pay ₹4,656.00 each, saving ₹144.00" next to a PLN 229.99 price. The cart shows the same hint correctly in PLN | Product page, quantity-discount chapter | Developer | Fix the popover's currency (a code defect) before recording |
| B-15 | Supplier list shows "**Glovia** Levels Demo" (old single-a spelling), test suppliers "Alpha/Beta/Gamma/Delta Supplies row21ui-", and the real company "SPM Medicare Pvt Ltd" | Homepage verified-suppliers section | Developer | Part of the demo seed (B-02) |

## 18. Approvals

| Item | Approver | Status | Date |
|---|---|---|---|
| Brand identity and tagline (§2) | Owner | Confirmed by owner | 2026-10-01 |
| Decisions D-01 to D-14 | Owner | **Pending** | — |
| Approved and prohibited claims | Owner (+ legal if available) | **Pending** | — |
| Presenter and voice | Owner | **Pending** | — |
| Deliverables | Owner | **Pending** | — |
| Asset permissions | Owner | **Pending** | — |
| Whole requirements package | Owner | **Pending** | — |

## 19. Definition of Ready for Runway

| # | Condition | Status |
|---|---|---|
| 1 | Brand name confirmed | Done |
| 2 | Official tagline correct everywhere — documents **and** the app on screen | Documents: done. App: **no (B-01)** |
| 3 | Parent attribution correct | Done ("Powered by UBOSS" on screen and in documents) |
| 4 | Objectives approved | Pending (D-03) |
| 5 | Audiences approved | Pending (D-03) |
| 6 | Every feature shown is verified | No — rehearsal of seller, logistics actions and payment still needed |
| 7 | Broken and planned features excluded | Done in the briefs |
| 8 | Unsupported claims removed | Done in the briefs; pending approval |
| 9 | Presenter direction approved | Pending (D-08) |
| 10 | Voice direction approved | Pending (D-08, D-13) |
| 11 | Required screen recordings identified | Done (capture plan) |
| 12 | Demo accounts available | No (B-04) |
| 13 | Synthetic data prepared | No (B-02, B-03) |
| 14 | Sensitive information removed | No (depends on B-02) |
| 15 | Assets available | No (B-08, music, footage) |
| 16 | Asset permissions confirmed | No (D-02, music licence) |
| 17 | Duration approved | Pending (D-09) |
| 18 | Deliverables approved | Pending (D-09) |
| 19 | Critical blockers resolved | No (B-01 to B-07) |
| 20 | Owner has explicitly approved this package | **No** |

**Result: NOT READY for Runway.**

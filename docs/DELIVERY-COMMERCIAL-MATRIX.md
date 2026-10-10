# Delivery, Commercial and Launch — requirement matrix

Sources (kept unchanged, not in git): **Doc 07** *Delivery Returns Refunds and
Dispute Administration Policy* v1.0 and **Doc 08** *Commercial Certification
and Launch Approval Guide* v1.0, both prepared 9 October 2026, both approval
drafts with a blank effective date.

How to read the status column:

- **Built** — works today, whatever flag is set.
- **Built, gated** — built and tested; refuses only when its flag is `enforce`
  (`DELIVERY_POLICY_GATES`, `COUNTRY_LAUNCH_GATE`, or the existing
  `SELLER_ASSESSMENT_PURCHASE_GATE`). All default to `off`.
- **Built, needs adoption** — the proposal is stored as a DRAFT commercial
  schedule. It does nothing until a second person approves it with evidence
  and activates it.
- **Pending (human)** — a decision, signature, provider confirmation, legal
  review or real-world act. Software cannot and does not record it as done.
- **Gap** — not built; the next action says what is needed.

Code: rules and imported tables `backend/src/domain/commercial-policy.ts`;
services `backend/src/modules/commercial-policy/`; routes
`backend/src/http/routes/commercial-policy.ts`; migrations
`20261114100000_delivery_commercial_policy`,
`20261114100100_delivery_commercial_row_timestamps`. Tests: unit
`tests/unit/commercial-policy.test.ts` (U), integration
`tests/integration/commercial-policy.test.ts` (I).

## Doc 07

| § | Requirement | Existing before | Change | Evidence | Status |
|---|---|---|---|---|---|
| 1 | Confirm seller, manufacturer, SKU/version, site, country, B2B/B2C, importer, local actors, price, taxes, charges, milestones, term, named place, lead time, packaging, transport restrictions, insurance, return route before acceptance | Seller split; scope gate; T&C version on order | Frozen per-line `order_line_commercial_snapshots` at confirmation; controls recorded while the seller order is NEW; acceptance gate | I: snapshot, acceptance tests | Built, gated |
| 1 | Payment confirmation is not acceptance or product-country release | Seller acceptance already manual; capture re-check | Acceptance refused while controls are missing | I: "payment success is not acceptance" | Built, gated |
| 2 | DAP default; FCA only elected and approved; DDP only with approved arrangement; domestic separate; B2C consumer terms | Free-text incoterm fields | `resolveDeliveryTerm`, `importerOfRecord`; election recorded on the snapshot | U, I: DAP/FCA/DDP tests | Built |
| 2 | Title, transit risk, delivery date and technical acceptance distinct | — | Separate snapshot fields | Schema | Built |
| 3 | Booking facts, ≥2 comparable quotes or reason, provider screening | Freight quote requests, carrier quotes | `freight_bookings`, `freight_quote_options`, `logistics_provider_reviews` ("Credentials required" when no live integration) | I: quote rule | Built |
| 3 | Actual cost + 5% coordination, capped; fixed-fee alternative; itemised extras; recover once | — | LOGISTICS_CHARGE schedule; `logisticsCoordination`; `duplicateRecoveryExcess` | U: worked example, cap | Built, needs adoption |
| 3 | Cargo insured value 110% + freight, proposal only | Booking-terms insurance | `proposedInsuredValue`, shown on the snapshot as a proposal | U | Built, needs adoption |
| 4 | Export / import documents and review status | Trade documents with validation | Customs-document checklist over trade documents; export documents required before cross-border dispatch | dispatch facts | Built, gated |
| 4 | DG, batteries, timber packaging, temperature by product/route | DG/cold-chain flags on shipments | `handling_requirements`, evidence required at dispatch | dispatch facts | Built, gated |
| 4 | B2C blocked without a lawful import route; EU fulfilment-role assessment | — | `import_routes` with verified local actors and independent review; checkout gate; EU role is a launch decision | I: import-route test | Built, gated |
| 5 | Dispatch only with payment, inspection, documents; record quantities, lots, seals, photos, custody, temperature | Inspection gate, compliance gate, scope gate | `dispatch_evidence`, `custody_handovers`, dispatch gate | I: dispatch test | Built, gated |
| 5 | POD records time, place, recipient, quantities, exceptions; not conformity | POD without quantities | `quantitiesJson` on proof of delivery | Schema | Built (partner capture UI: Gap) |
| 5 | Partial shipments need approval, proportionate billing, never past no-partial-release | Shipment Assessment forbids partial release | `partial_shipment_approvals` refuses when an assessment exists | I | Built |
| 6 | Windows 48 h / 7 d / 30 d / 14 d / 72 h / 7 d / 7 d; rights preserved; late reports reviewed | Dispute settings 30/72h/168h/7 | Imported exactly; CASE_WINDOWS schedule; business-day calendar with time zone; late safety/defect/warranty/fraud/statutory claims accepted for review | U: windows, calendar; I: late claim | Built (adopted windows: needs adoption) |
| 7 | Case links order, seller, buyer, shipment, payment, scope, quantity, lots, category, remedy, value, urgency, market | Disputes | `dispute_case_profiles`; 12 categories; proportionate requests (identity demands refused); safety routed at once; no AI-only decision | I | Built |
| 8 | Acknowledge in 1 business day; seller 72 h; buyer answers contrary evidence; independent tests with cost allocation; reasoned decision; independent appeal in 10 business days | SLA sweep; one appeal; no independence check | Clocks, evidence requests, testing records, reasoned decisions with remedies, appeal reviewer independence enforced on decide; overdue sweep | I: case tests | Built |
| 9 | Refunds: pre-acceptance release, B2B terms, consumer law; commission reversal on seller fault; no defect remedy conditioned on packaging/insurer | Refunds, settlement refund sync | Proportionate `commission_adjustments` proposed per refund; refund status view (instructed date, provider status); ambiguous outcomes kept pending under the same key | I: reversal; I: ambiguous outcome | Built |
| 10 | 5%/90 d standard, 10%/180 d or guarantee; no stacking; disputed exposure only; monthly review; no forfeiture | Env-wide reserve | `seller_security_schedules`, stack check, provider permission, monthly + quarterly reviews, escrow uses the active schedule's rate, days and cap; loss recoveries flag overlap | I: security test | Built, needs adoption |
| 11 | Safety officer; stop stock; trace; reporting by qualified people; notices; recall actions; annual rehearsal; reinstatement on evidence and human release | GPSR fields only | `safety_cases`, scope, containment read live at checkout/dispatch/repeat orders, trace, actions (AI refused), release by another person, `recall_rehearsals` | I: safety test | Built (safety officer name: Pending) |
| 12 | Escalation path; publication of buyer policy separately from internal reserves; contacts filled; launch tests; version per order | Legal documents, T&C on order | Buyer draft `legal/drafts/gloviaa-mart/delivery-returns-disputes-policy.en.txt` (RETURNS_POLICY, publication blocked by its blanks); policy versions in each line snapshot | legal-agreement-rules test | Built (publication: Pending) |

## Doc 08

| § | Requirement | Change | Evidence | Status |
|---|---|---|---|---|
| 1 | Disclosed managed marketplace; actual seller per line; seller exporter, business buyer importer; country-by-country, SKU-by-SKU | Line snapshot; scope gate (existing) + product evidence; country launch | I | Built |
| 2 | 12.5% portfolio target, not a universal rate | `PORTFOLIO_TARGET_BPS`, `portfolioRateBps` | U | Built |
| 2 | Basic INR 0; optional enterprise INR 120,000/yr + tax with deliverables; onboarding quoted separately; no routine transaction fee on commission orders | SUBSCRIPTION schedule | U | Built, needs adoption (billing of subscriptions: Gap) |
| 2 | Commission on net goods after seller-funded discounts; exclusions; platform-funded discounts separate; proportional reversal | `commissionForLine`; fee engine takes adopted rates; snapshot stores rate, base, source, rule version, rounding | U, I | Built |
| 3 | 25-department B2B/B2C schedule, exact | `DOC08_COMMISSION_SCHEDULE` → COMMISSION schedule v1 DRAFT, mapped to seeded slugs | U: rates, mapping | Built, needs adoption |
| 3 | Above INR 25 lakh: reduced rate on the incremental amount; 5% floor with approval and contribution evidence; no rate provided | LARGE_ORDER_DISCOUNT schedule with `reducedBps: null`; `commissionWithLargeOrderBand` | U | Built, needs adoption (rate: Pending) |
| 3 | Worked example 100,000 × 12.5% + 8,000 × 5% = 12,900 | `doc08WorkedExample` | U | Built |
| 4 | Programme-specific recoverable-cost ledger; up to 1% capped by unrecovered cost; shown before purchase; concurrency-safe; release; refunds; no double recovery; FX recorded | `certification_programmes`, cost entries (reference unique across programmes), allocations reserved under a row lock | I: 20-way race | Built, needs adoption. **Gap:** the reserved charge is not yet added to the checkout total |
| 5 | DAP default; logistics cost-plus or fixed fee; provider confirmations; 30/60/10 plan only with seller, buyer and provider agreement | PAYMENT_PLAN schedule; `order_payment_plans` | U | Built, needs adoption (milestone capture at the provider: Gap) |
| 6 | Reserve proposals; quarterly review, reduce after six satisfactory months | Security schedules and reviews | I | Built, needs adoption |
| 6 | Three insurance groups and exact limits; broker review; insured entity, sites, products, territories, exclusions, deductibles, expiry, verification; insurance never approves a category; Gloviaa's own cover separate | `DOC08_INSURANCE_RISK_GROUPS`; `insurance_policy_records` (holder SELLER / PLATFORM) with gaps | U, I | Built |
| 7 | Two layers: external certification vs Gloviaa trading approval; recognise existing certificates after gap assessment | Existing trading approval; `product_compliance_evidence` with existing-accepted + gap assessment | I | Built |
| 7, 9 | ISO ≠ product approval; FDA registration ≠ approval; no invented annual expiry; test reports per version | `EVIDENCE_LIMITS`; expiry only where the issuer sets one | U | Built |
| 7, 9 | 12-month trading renewal; 6-month surveillance for high-risk; 90/60/30 alerts | Existing approval renewal and alerts; evidence expiry sweep; `surveillanceIntervalMonths` | U | Built |
| 8 | 25-department assurance matrix as reviewer prompts | `DOC08_ASSURANCE_MATRIX`; Audit Console prompts | U | Built |
| 9 | Expired / withdrawn required evidence blocks purchase and dispatch without a job; revalidate recurring orders | Evidence read live in the scope gate (`EVIDENCE_NOT_CURRENT`); repeat-order charge re-checks | I | Built, gated |
| 9 | Immediate suspension for unsafe goods; reinstatement on verified evidence and human release | Safety cases | I | Built |
| 10 | Legal renewal examples; tax and customs before launch; no automatic USD 800 assumption | Launch decisions with cited official sources; nothing hard-coded | U | Built (source verification: Pending) |
| 11 | Every launch decision with owner, scope, evidence, reviewer, status, expiry, blocker; countries enabled individually | `launch_readiness_items`, `country_launches`; enable refused with blockers; checkout gate | I | Built, gated (all decisions: Pending) |
| 12–13 | Website observations and benchmarks | Historical evidence only; current catalogue reconciled instead | — | Not acted on, by design |
| Appendix | 25 departments, 120 subcategories | `DOC08_CATEGORY_REGISTER`, `reconcileCategoryRegister` | U: **no differences** against the seeded catalogue | Built |

## Still pending outside software

Adoption of every schedule; the large-order reduced rate; signed seller, buyer
and partner schedules; payment-provider written confirmations (reserves,
milestones, settlement deadlines, export proceeds); broker-reviewed insurance;
legal review and governing law; company details and the five contacts;
safety officer; certification bodies; per-country tax decisions (EU VAT /
IOSS, US marketplace tax and CBP entry, Indian GST and export
reconciliation); real launch tests and recall rehearsals.

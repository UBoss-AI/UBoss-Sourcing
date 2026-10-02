# Product Demonstration Video — Brief

> **Status: DRAFT FOR APPROVAL.** PROVISIONAL choices follow
> [VIDEO_REQUIREMENTS.md](VIDEO_REQUIREMENTS.md) §15. Exact shots are in
> [VIDEO_CAPTURE_PLAN.md](VIDEO_CAPTURE_PLAN.md). No video has been generated.

## 1. Objective

Show, on the real application, how a company buyer finds, preorders and buys
goods, and how a seller lists, prices and fulfils them. A viewer should finish
able to do the core task themselves.

## 2. Audience

| Video | Primary | Secondary |
|---|---|---|
| Platform overview | Company buyers in Europe | Indian sellers, partners |
| Buyer demonstration | Company buyers and procurement teams | Individual buyers |
| Seller demonstration | Indian sellers and manufacturers | Export-focused businesses |
| Logistics (phase 2) | Logistics partners | — |
| Admin and inspection (phase 2) | Internal staff only | Inspection agencies (separate cut) |

Public: overview, buyer, seller, logistics. **Internal only:** admin and
inspection (PROVISIONAL — D-05).

## 3. Structure decision

### Options

| Option | Advantages | Disadvantages |
|---|---|---|
| **A. Overview + role videos (recommended)** | Each viewer watches only what they need; short videos are finished more often; one broken feature delays one video, not all; chapters can be re-shot alone; admin stays private by construction | More edit work; the presenter must stay consistent across videos |
| B. One complete 15–20 minute video | One file; tells the whole story in order | Most viewers stop early; admin screens would be public; one blocked chapter blocks the release; hard to update |
| C. Overview only | Fast | Does not teach anyone to use the product |

**Provisional choice: A**, released in two phases:

- **Phase 1:** overview, buyer, seller.
- **Phase 2:** logistics, and the internal admin and inspection video. These wait
  for blockers B-03, B-04 and B-10.

## 4. Included roles

| Role | Account (synthetic, to be created — B-04) | Videos |
|---|---|---|
| Company buyer (Poland) | `demo.buyer@…` — "Anna Kowalczyk", Purchasing Manager, *Wisła Clinical Supplies Sp. z o.o.* (fictional) | Overview, buyer |
| Individual buyer | `demo.individual@…` — fictional | Overview (sign-in tab only) |
| Seller (India) | `demo.seller@…` — "Ravi Iyer", *Kaveri Precision Components Pvt Ltd* (fictional) | Overview, seller |
| Logistics dispatcher | `demo.dispatch@…` — *Vistula Freight* (fictional) | Logistics (phase 2) |
| Marketplace staff | owner signs in personally (two-step) | Internal video |
| Inspection agency | `demo.inspector@…` — fictional agency | Internal video |

All names, companies, addresses, tax numbers and phone numbers are fictional and
must be checked against a quick web search so none collides with a real
business. Tax numbers must pass their checksums (the seeded seller GSTIN does
not, and documents are refused for it).

## 5. Approved chapters

Decision key: **Include** (phase 1), **Phase 2**, **Internal**, **Postpone**
(blocked), **Exclude**.

| # | Chapter | Video | Decision | Why |
|---|---|---|---|---|
| 1 | Introduction | All | Include | Presenter, full screen |
| 2 | Homepage | Overview, buyer | Include | Verified; needs B-01, B-02 |
| 3 | Individual and company sign-in | Buyer | Include | Verified (individual); company rehearsal pending |
| 4 | Buyer onboarding | Buyer | Include (form only) | Submitting sends real email until B-12 |
| 5 | Company verification | Buyer (buyer side), internal (staff side) | Include buyer side | Staff decision is internal |
| 6 | Product discovery | Overview, buyer | Include | Verified |
| 7 | AI Assistant | Buyer | **Postpone** | Blocked by quota (B-07) |
| 8 | Product-detail page | Overview, buyer | Include | Verified |
| 9 | Quantity discounts | Buyer | Include | Needs demo tiers (B-02) |
| 10 | Preorder | Overview, buyer | Include | Verified to the form |
| 11 | Preorder chat | Buyer | Include | Verified UI; needs D-11 for the team name |
| 12 | Cart | Buyer | Include | Verified |
| 13 | Checkout | Buyer | Include | Verified to the pay button |
| 14 | Stripe test payment | Buyer | Include after B-05 | Must be a genuine test-mode run |
| 15 | Order confirmation | Buyer | Include | Verified (screen) |
| 16 | Buyer order history | Buyer | Include | Verified |
| 17 | L1–L4 shipment tracking | Overview, buyer | Include after B-03 | Needs a four-level order |
| 18 | Seller Hub | Overview, seller | Include after B-04 | Separate Hub password |
| 19 | Product listing | Seller | Include | Rehearsal pending |
| 20 | Inventory | Seller | Include | Rehearsal pending |
| 21 | Seller order confirmation | Seller | Include | Rehearsal pending |
| 22 | Invoice and packing list | Seller | Include | Needs a checksum-valid fictional GSTIN |
| 23 | Logistics assignment | Seller | Include | Rehearsal pending |
| 24 | Logistics Portal | Logistics | Phase 2 | Verified screens; data stale (B-03) |
| 25 | Driver assignment | Logistics | Phase 2 | Rehearsal pending |
| 26 | Inspection workflow | Internal | Internal / Postpone | Evidence conflict (B-10); no agency accounts |
| 27 | Admin verification | Internal | Internal | Two-step sign-in; personal data |
| 28 | Admin oversight | Internal | Internal | Internal data |
| 29 | Commission invoice | Internal | **Exclude** from all public videos | Tax and money figures |
| 30 | Conclusion | All | Include | Presenter, full screen |

## 6. Chapter specifications (phase 1)

Durations are estimates of the finished chapter, including presenter time.

### Platform overview (2:00)

| Chapter | Learning objective | Role / route | Duration | Narration points |
|---|---|---|---|---|
| Intro (presenter) | What Gloviaa Mart is | — | 0:12 | Name, tagline, "Powered by UBOSS"; one line on who it is for |
| Discover | Find products in your language and currency | Buyer, `/`, `/products` | 0:20 | Eight languages; prices in złoty |
| Product and terms | Terms are clear before ordering | Buyer, `/product/:slug` | 0:18 | Variants, bulk savings, tax shown |
| Preorder by container | Buy at production scale | Buyer, preorder dialog | 0:18 | Minimum quantity; 20-ft / 40-ft; "a request is not an order" |
| Checkout and confirmation | One checkout; confirmed by the payment provider | Buyer, `/checkout` → confirmation | 0:15 | Several sellers, one checkout |
| Delivery levels | Leg-by-leg visibility | Buyer, order detail | 0:12 | L1–L4 in plain words |
| Seller Hub | Sellers are reviewed, then manage everything | Seller, `/seller/dashboard` | 0:15 | Review before selling; listings, stock, documents |
| Close (presenter) | Where to go next | — | 0:10 | CTA |

### Buyer demonstration (≈ 5:30)

| # | Chapter | Starting state | Exact actions (summary) | Expected result | Key UI | Narration points | Duration | Privacy | Creds | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| B1 | Intro | — | Presenter full screen | — | — | What you will learn | 0:15 | — | — | — |
| B2 | Language and currency | Guest, home in English / INR | Open the language, country and currency menu → Polski, Poland, zł PLN → Apply | Home in Polish, prices in PLN | Market menu, Apply | "Choose your language and currency first" | 0:20 | — | — | VERIFIED |
| B3 | Sign-in | Guest | Choose **Company** tab → sign in as demo buyer → choose the company | Signed in as the company | Individual/Company tabs | Tab is a preference; the company is chosen next | 0:25 | Password typed off-camera or blurred | — | Partly verified |
| B4 | Company account | Signed in | Open *Account → Company information* | Approved company shown | Company status banner | "Our team checks every company before it can buy" | 0:20 | Fictional tax numbers only | — | VERIFIED (screen) |
| B5 | Find products | Home | Type "air quality monitor" → Search → apply a B2B filter (lead time) | Filtered results | Search box, filters | Search by words, voice or filters | 0:30 | — | — | Search verified; filters pending |
| B6 | Product page | Results | Open product → choose variant → see bulk savings | Price per variant, bulk tiers | Variant buttons, bulk savings | "Prices fall as quantity rises — set by the seller" | 0:35 | — | — | VERIFIED (variants) |
| B7 | B2C limit (optional) | Individual account | Raise quantity above the B2C cap | Limit dialog | B2C limit dialog | Why limits exist; company accounts are exempt | 0:15 | — | — | Pending |
| B8 | Preorder by container | Product with container data | Preorder → read rules → agree → order in **40-ft container** → date → review (do **not** send on the public take unless the demo environment is used) | Equivalent pieces shown | Order-in units, minimum, earliest date | "A request is not an order and charges nothing" | 0:40 | Delivery address fictional | — | Rules verified; container **blocked by data** |
| B9 | Preorder chat | Product page | Chat with Gloviaa Mart → tap "How many pieces fit in a 40-ft container?" → "Connect with a human agent" | Automated answer; handover queued | Suggested questions, human button | "Automatic answers from the product's own data — not a person"; "a request for a person is queued" | 0:35 | No real names in chat | — | UI verified |
| B10 | Cart and checkout | Product page | Add to cart → cart → Proceed to checkout → address, warehouse, payment choice | Checkout summary | Steps bar, order summary | One checkout, several sellers | 0:35 | Fictional address | — | VERIFIED to the pay button |
| B11 | Payment (test) | Checkout | Place order and pay → Stripe test page → test card 4242… → return | Confirmation page | Stripe test badge | "This is test mode"; "the order is confirmed when the payment provider confirms it" | 0:30 | Test card only; nothing else typed on screen | Stripe test keys, webhook | **Blocked (B-05)** |
| B12 | Orders and tracking | Confirmation | My orders → open order → delivery levels | L1–L4 levels | Order progress, delivery levels | Leg by leg from the factory to your door; no live GPS claimed | 0:35 | Fictional names | — | Orders verified; levels need data |
| B13 | Repeat purchase (optional) | Order detail | Order these again / Schedule Cart | Schedule set | Schedule builder | Plan a delivery, then let it repeat | 0:25 | — | Stripe for unattended charge | Pending |
| B14 | Close | — | Presenter full screen | — | — | Recap, CTA | 0:15 | — | — | — |

### Seller demonstration (≈ 5:30)

All seller chapters need the Hub password step (B-04) and a fictional seller
with a checksum-valid GSTIN. None has been rehearsed yet, because the Hub could
not be opened; each must be rehearsed before capture.

| # | Chapter | Starting state | Exact actions (summary) | Expected result | Narration points | Duration | Status |
|---|---|---|---|---|---|---|---|
| S1 | Intro | — | Presenter | — | Who the Hub is for | 0:15 | — |
| S2 | Apply to sell | Guest, `/sell` | Show the page → start application (pre-filled) | Application steps | "Every application is checked before anything goes live" | 0:30 | `/sell` verified |
| S3 | Open the Hub | Signed-in seller | Seller Hub → Hub password → dashboard | Dashboard | The Hub has its own password, for safety | 0:20 | Gate verified |
| S4 | Create a listing | Dashboard | Listings → New → title, category, variants, images, specifications → submit for review | Draft submitted | Listings are reviewed before publishing | 0:50 | Pending |
| S5 | Price tiers and B2C cap | Listing | Add three quantity tiers; set B2C maximum | Saved tiers | Bulk buyers see savings | 0:35 | Pending |
| S6 | Preorder terms and container capacity | Listing | Set minimum, lead time, pieces per 20-ft / 40-ft (verified) | Container ordering enabled for buyers | This is what lets buyers order by container | 0:35 | Pending |
| S7 | Inventory | `/seller/inventory` | Adjust stock for a variant | Stock updated | — | 0:20 | Pending |
| S8 | Confirm an order | `/seller/orders/:id` | Open new order → confirm | Status Accepted | Buyer's contact and payment details stay private | 0:25 | Pending |
| S9 | Invoice and packing list | Order | Preview → issue invoice; preview → issue packing list | PDFs | Carrier sees the packing list, not the invoice | 0:35 | Pending |
| S10 | Delivery levels and logistics | `/seller/logistics`, order | Choose Self + UBOSS; show L1–L4 rates; assign a logistics partner | Partner assigned | L1 is always the seller's; L2–L4 seller or marketplace | 0:40 | Pending |
| S11 | Carrier connections | `/seller/carriers` | Show DHL / FedEx "credentials required"; India Post manual | Setup state | Each seller connects its own carrier accounts | 0:20 | Setup state verified by tests |
| S12 | Performance | `/seller/performance` | Show dashboard (synthetic numbers) | — | — | 0:15 | Pending |
| S13 | Close | — | Presenter | — | CTA "Apply to sell" | 0:15 | — |

## 7. Synthetic-data requirements (B-02, B-03)

A **dedicated demo database** (separate from `uboss`), seeded by a script, so
every take starts from the same state and can be reset.

| Data | Requirement |
|---|---|
| Categories | 6–8 clean departments; **no** "RFQ … row21ui-" or other test residue |
| Products | 12–20 fictional, brand-safe products in 3–4 categories (for example lab supplies, safety equipment, packaging, industrial components). Original or licensed images; **no** third-party brands or trademarked designs; no "FirstCry"-type names |
| Hero product | One product with: 2 variant dimensions, a clear specification table, 3 seller price tiers, preorder minimum, **verified** pieces per 20-ft and 40-ft container on a selectable variant, published lead time and transit time to Poland, PLN price |
| Seller | One Indian seller (fictional), approved, with a checksum-valid fictional GSTIN, factory, logo, preorder policy, L1–L4 rates in Self + UBOSS mode |
| Second seller | So the cart shows "several sellers, one checkout" |
| Company buyer | Polish company (fictional), APPROVED, with fictional NIP/REGON/KRS that pass checks; one purchasing manager user |
| Individual buyer | For the sign-in tab and the B2C limit |
| Orders | One paid order priced on all four levels, with L1–L4 progress at different stages; one fresh order for the seller to confirm |
| Logistics | A fictional partner with 2 drivers and vehicles; 4–5 current shipments with fresh dates and correct countries |
| Preorder chat | Team name decided (D-11); an online staff member available for the handover take |
| Language and currency | Base currency decided for the demo; PLN prices set; tax display for Poland decided (B-06) |
| Reviews | A few fictional reviews, clearly not attributed to real people |
| Contact details | Footer support email and phone set to safe demo values (not `uboss.local`, not a real number) |

## 8. Avatar direction

As in [VIDEO_REQUIREMENTS.md](VIDEO_REQUIREMENTS.md) §9. In this video:

- Full screen at the introduction, every chapter transition (3–6 s) and the
  conclusion.
- Picture-in-picture (lower right, about 18 % of width) only during long screen
  passages where nothing important sits under it. Check every frame.
- Never point at the screen. Gestures are small and open.

## 9. Narration direction

- 140–150 words per minute. One idea per sentence.
- Name the thing the viewer sees, using its on-screen label, before explaining
  it ("Choose **Preorder**…").
- Say the limits the brief requires, in plain words: test mode, "request, not
  an order", automated answers, queued handover, no live GPS.
- Never read out email addresses, passwords or reference numbers.

## 10. Screen-recording plan

See [VIDEO_CAPTURE_PLAN.md](VIDEO_CAPTURE_PLAN.md).

## 11. Privacy requirements

As in [VIDEO_REQUIREMENTS.md](VIDEO_REQUIREMENTS.md) §12, plus:

- Passwords are typed off-camera (cut) or the field is blurred; prefer starting
  takes already signed in.
- The AI page sidebar lists earlier questions and the account email; record it
  only from a clean demo account.
- Order and shipment pages show names and addresses: fictional data only.
- No admin screen appears in a public video.

## 12. Deliverables

DM-01 to DM-11 in [VIDEO_REQUIREMENTS.md](VIDEO_REQUIREMENTS.md) §14.

## 13. Runway production recommendations

- Runway is used for the **presenter only** (intro, transitions, conclusion,
  picture-in-picture). **Never generate application screens** — every screen is
  a real recording.
- Generate the presenter in short takes (one sentence or two), using the same
  reference image and settings every time, so the person does not drift.
- Lip-sync each take to the final narration audio, not to a draft.
- Composite in an editor: screen recording as the base, presenter as a layer,
  callouts and captions on top.
- Keep the presenter's background colour consistent with the brand navy so
  transitions cut cleanly.

## 14. Blockers

| ID | Blocker | Chapters affected |
|---|---|---|
| B-01 | Unapproved tagline in the header | All screen chapters |
| B-02 | Demo data unfit | All screen chapters |
| B-03 | No container, four-level order or fresh logistics data | B8, B12, S6, S10, logistics |
| B-04 | Seller Hub password; staff two-step; no agency accounts | All seller chapters; internal video |
| B-05 | Payments succeed without Stripe locally; no webhook | B11 |
| B-06 | Indian tax label shown to Polish buyers | B2–B12 in the Poland context |
| B-07 | AI quota | Chapter 7 (postponed) |
| B-09 | "UBoss" team name | B9 |
| B-10 | Inspection gate evidence conflict | Chapter 26 |
| B-12 | Real SMTP | B3 registration takes |

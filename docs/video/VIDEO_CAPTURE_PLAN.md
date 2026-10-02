# Video Capture Plan

> **Status: DRAFT.** Recording must not start until the Definition of Ready in
> [VIDEO_REQUIREMENTS.md](VIDEO_REQUIREMENTS.md) §19 is met for the chapter
> being recorded. Rehearsal evidence from 2026-10-01 is in
> `verification-evidence/video-discovery/2026-10-01/`.

## 1. Technical specification

| Item | Requirement |
|---|---|
| Resolution | 1920×1080 content area. If the screen is 4K, record at 3840×2160 with browser zoom 200 % so text stays sharp when scaled |
| Frame rate | 60 fps master (30 fps acceptable); constant frame rate |
| Browser | Chrome or Edge, a **new profile** used only for recording |
| Window | App/kiosk window with no tabs, address bar or bookmarks bar in frame (`--app=` window or kiosk mode) |
| Browser zoom | 100 % at 1080p (200 % at 4K); never change mid-take |
| Theme | Light theme (set explicitly, not "match my device"); one dark-theme take only for the theme chapter |
| Cursor | Enlarged cursor (about 1.5×), with a soft click highlight added in recording software or in post |
| Recording software | OBS Studio (window capture) or equivalent; lossless or high-bitrate (≥ 40 Mbps) |
| Audio | **No system or microphone audio** in screen takes; narration is added later |
| Notifications | Windows Focus / Do Not Disturb on; browser notifications blocked; no chat apps running |
| Password manager | Disabled in the recording profile; "save password" prompts turned off |
| Extensions | None |
| Network | Stable wired connection; the demo environment on the same machine or LAN; disable OS updates for the session |
| Loading states | Warm every page once before the take (the first load of a Vite dev server is slow — a cold product page was caught on "Loading the product…"). Prefer a production build of the frontends for capture |
| Dropdowns and menus | Open slowly; hold 1.5 s open; close with the visible control, not Escape |
| Modals | Wait for the open animation to finish; hold 2 s before acting |
| Long pages | Smooth scroll with the mouse wheel at an even speed; never scripted jumps |
| Role switching | Separate browser profile per role; never sign out and in on camera unless the chapter is about sign-in |
| Email verification | Email driver set to log mode on the demo environment (B-12); show the inbox step only as a title card |
| Payment | Stripe test mode, test card `4242 4242 4242 4242`, any future date, any CVC; Stripe's test-mode badge stays visible |
| Callouts and zoom | Added in post: zoom 120–150 % on the active control, 0.4 s ease; callout boxes in brand blue `#1D4ED8`, text in Inter |
| Session length | The storefront session cookie does not survive a browser restart; sign in at the start of each recording block |
| Raw file naming | `GM_<video>_<chapter>_<captureID>_take<NN>_<YYYYMMDD>.mp4`, for example `GM_BUY_B08_CAP-B08_take03_20261015.mp4` |
| Storage | `video/raw/<YYYYMMDD>/` outside the repository; never commit footage |

### Retake criteria (any one fails the take)

- Any password, key, token, email address of a real person, or real personal data visible
- Any error, spinner longer than 1 s, toast or notification not in the script
- The tagline in the header is not the approved one (until B-01 is fixed, no take is final)
- Test residue, third-party brand or placeholder contact on screen
- Cursor wanders, hesitates, or covers the control being explained
- A modal or the picture-in-picture area covers something the narration refers to
- Text unreadable at 1080p
- Frame drops or stutter

### Privacy review (every take)

Before a take is accepted, a second person watches it at full size and ticks:
no secrets, no real people, no real addresses, no internal admin data, no
third-party brands, no browser chrome, correct tagline, correct "UBOSS" casing.

## 2. Accounts and starting state

| Profile | Account | Prepared state |
|---|---|---|
| `rec-guest` | none | Clean; English / India / INR, then switched on camera |
| `rec-buyer` | Demo company buyer (Poland) | Polish market, PLN, approved company, empty cart, one paid four-level order |
| `rec-individual` | Demo individual buyer | Empty cart |
| `rec-seller` | Demo seller | Hub password known to the operator only; one new order waiting |
| `rec-dispatch` | Demo logistics dispatcher | Fresh shipments assigned |
| `rec-staff` | Owner (two-step) | Internal video only |

The demo database is restored from a snapshot before each recording block.

## 3. Capture list

Duration = raw length to aim for (the edit trims). Status = what the
2026-10-01 rehearsal established.

### Overview and buyer

| Capture ID | Video | Chapter | Role | Route | Starting state | Exact action | Expected result | Demo data | Est. | Privacy | File name | Retake if | Rehearsal status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CAP-B02 | Buyer, overview | Language and currency | Guest | `/` | English / INR | Click the language-country-currency button → **Polski** → **Poland** → **zł PLN** → **Apply** | Home in Polish; prices in złoty | Clean home | 0:30 | — | `GM_BUY_B02_…` | Menu closes before Apply is seen | VERIFIED (EV-21, EV-22) |
| CAP-B03 | Buyer | Company sign-in | Guest | `/login` | Signed out | **Company** tab → email → password (field blurred in post, or cut) → accept terms → **Sign in** → choose company | Company context active | Demo buyer + company | 0:35 | Password | `GM_BUY_B03_…` | Password visible | Individual tab VERIFIED; company flow pending |
| CAP-B04 | Buyer | Company account | Buyer | `/account/company` | Signed in | Open Account → Company information; scroll slowly | Approved company details | Fictional NIP / REGON | 0:25 | Fictional numbers only | `GM_BUY_B04_…` | Real-looking data | Screen VERIFIED |
| CAP-B05 | Buyer, overview | Find products | Buyer | `/` → `/search` | Home | Type "air quality monitor" in **Search the catalogue** → **Search** → apply a lead-time filter | Filtered results | Demo catalogue | 0:35 | — | `GM_BUY_B05_…` | Test categories visible | Search VERIFIED; filter pending |
| CAP-B06 | Buyer, overview | Product page | Buyer | `/product/<hero>` | Results | Open hero product → choose each variant button → open bulk savings | Price per variant; bulk tiers | Hero product with tiers | 0:40 | — | `GM_BUY_B06_…` | Validation message shown by accident | Variants VERIFIED (EV-16) |
| CAP-B07 | Buyer | B2C limit | Individual | `/product/<hero>` | Signed in as individual | Raise quantity past the cap → **Add to cart** | B2C limit dialog | Cap set on hero | 0:20 | — | `GM_BUY_B07_…` | — | Pending |
| CAP-B08 | Buyer, overview | Container preorder | Buyer | product page | Product page | **Preorder** → read rules → tick "I understand…" → **Agree and continue to preorder** → Order in **40-ft Container** → quantity → date → review | Equivalent pieces shown; form complete | **Verified container capacity on a selectable variant** | 0:50 | Fictional address | `GM_BUY_B08_…` | Shows "(not available)" | Rules VERIFIED (EV-13); container **BLOCKED** (EV-14) |
| CAP-B09 | Buyer | Preorder chat | Buyer | product page | Product page | **Chat with Gloviaa Mart** → tap "How many pieces fit in a 40-ft container?" → read the answer → **Connect with a human agent** | Automated answer; queued handover message | Team name set (D-11); staff online | 0:45 | No real names | `GM_BUY_B09_…` | "UBoss" visible | UI VERIFIED (EV-15) |
| CAP-B10 | Buyer, overview | Cart and checkout | Buyer | product → `/cart` → `/checkout` | Empty cart | **Add to cart** (two sellers' products) → **Cart** → **Proceed to checkout** → address → warehouse → payment choice | Checkout summary | Two sellers | 0:45 | Fictional address | `GM_BUY_B10_…` | — | VERIFIED to "Place order and pay" (EV-17, EV-18) |
| CAP-B11 | Buyer, overview | Stripe test payment | Buyer | `/checkout/payment/:id` | Checkout | **Place order and pay** → Stripe test page → test card → **Pay** → return | Confirmation after the webhook | Stripe test mode, webhook forwarding | 0:40 | Test card only | `GM_BUY_B11_…` | Confirmation shown before webhook; real card | **BLOCKED (B-05)** |
| CAP-B12 | Buyer, overview | Orders and delivery levels | Buyer | `/account/orders` → order | Paid four-level order | **My orders** → open order → scroll to progress and delivery levels | L1–L4 with stages | Four-level order | 0:40 | Fictional names | `GM_BUY_B12_…` | Levels missing | Orders VERIFIED (EV-12); levels need data |
| CAP-B13 | Buyer | Repeat purchase | Buyer | order → schedule | Paid order | **Order these again** / Schedule Cart → set frequency | Schedule saved | Saved test card | 0:30 | — | `GM_BUY_B13_…` | — | Pending (optional) |

### Seller

All pending: the Hub could not be opened in rehearsal (password gate, EV-20).
Each must be rehearsed end to end before capture.

| Capture ID | Chapter | Route | Starting state | Exact action | Expected result | Demo data | Est. | Privacy | Retake if |
|---|---|---|---|---|---|---|---|---|---|
| CAP-S02 | Apply to sell | `/sell` | Guest | Scroll the page → **Start** the application → show steps (pre-filled) | Steps visible | Fictional seller | 0:35 | Fictional IDs | Real data |
| CAP-S03 | Open the Hub | `/seller` | Shop signed in | **Seller Hub** → enter Hub password (blur) → **Open the Hub** | Dashboard | Demo seller | 0:25 | Password | Password visible |
| CAP-S04 | Create a listing | `/seller/listings/new` | Dashboard | **New listing** → fill title, category, two variant dimensions, images, specifications → submit for review | Draft submitted | Prepared images | 1:10 | — | Upload "pending scan" warning unexplained |
| CAP-S05 | Tiers and B2C cap | listing edit | Listing | Add 3 quantity tiers → set B2C maximum → save | Saved | — | 0:40 | — | — |
| CAP-S06 | Preorder and container capacity | listing / preorders | Listing | Set minimum, lead time, pieces per 20-ft and 40-ft → save | Container ordering available | — | 0:45 | — | — |
| CAP-S07 | Inventory | `/seller/inventory` | Dashboard | Adjust stock for one variant | Updated | — | 0:25 | — | — |
| CAP-S08 | Confirm an order | `/seller/orders/:id` | New order waiting | Open → **Confirm** | Accepted | Fresh order | 0:30 | Buyer details hidden by design | — |
| CAP-S09 | Invoice and packing list | order documents | Accepted order | Preview invoice → **Issue**; preview packing list → **Issue**; open PDFs | PDFs shown | Checksum-valid fictional GSTIN | 0:45 | Fictional tax IDs | Refused for GSTIN |
| CAP-S10 | Delivery levels and partner | `/seller/logistics`, order | Accepted order | Choose **Self + UBOSS** → show L1–L4 rates → assign partner on the order | Partner assigned | Rates, partner | 0:50 | — | — |
| CAP-S11 | Carrier connections | `/seller/carriers` | Dashboard | Show DHL and FedEx "credentials required"; India Post manual | Setup states | — | 0:25 | **No real carrier keys typed** | Any key visible |
| CAP-S12 | Performance | `/seller/performance` | Dashboard | Scroll dashboard | Synthetic numbers | Synthetic history | 0:20 | — | Real metrics |

### Logistics (phase 2)

| Capture ID | Chapter | Route | Exact action | Expected result | Demo data | Est. | Rehearsal status |
|---|---|---|---|---|---|---|---|
| CAP-L01 | Dashboard | `/dashboard` | Show today's work | Current counts | Fresh shipments | 0:20 | Screen VERIFIED (EV-24) |
| CAP-L02 | Accept a shipment | `/shipments/:id` | **Accept** an offered shipment | Accepted | Offered shipment | 0:30 | Pending |
| CAP-L03 | Assign a driver | `/shipments/:id` | Assign driver and vehicle | Driver shown | 2 drivers | 0:30 | Pending |
| CAP-L04 | Status updates | `/shipments/:id` | Collected → In transit → Out for delivery | Timeline grows | — | 0:40 | Pending |
| CAP-L05 | Proof of delivery | `/shipments/:id` | Record proof of delivery | Delivered | — | 0:30 | Pending (delivery-code defect open) |
| CAP-L06 | Delivery legs | `/legs` | Show L1–L4 legs | Legs listed | Four-level order | 0:20 | Screen VERIFIED (EV-28) |

### Internal (admin and inspection, phase 2)

Recorded only by, or with, the owner (two-step sign-in), on the demo database,
for internal use. Captures: dashboard, company verification decision, seller
review, preorder chat reply, order oversight, logistics oversight, inspection
console. **Never** audit, staff, integrations, settings, finance ledger, risk or
data-request screens, even internally, unless the owner asks for them.

## 4. Presenter captures (Runway, after approval)

| Capture ID | Use | Length | Framing |
|---|---|---|---|
| PR-01 | Overview introduction | 0:12 | Full screen, waist-up |
| PR-02…PR-n | Chapter transitions (one per chapter) | 0:03–0:06 each | Full screen |
| PR-PIP | Picture-in-picture loops | 0:10–0:20 | Waist-up, clean background for keying |
| PR-99 | Conclusion and CTA | 0:15 | Full screen |

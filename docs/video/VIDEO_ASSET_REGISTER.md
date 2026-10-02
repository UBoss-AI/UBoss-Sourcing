# Video Asset Register

> **Status: DRAFT.** Checked on 2026-10-01 against the repository. A file being in
> the repository does **not** mean it may be used commercially; every
> "Permission" cell says what is actually known.

Owner key: **Owner** = Gloviaa Mart / UBOSS business owner; **Dev** = developer;
**Design** = designer; **Prod** = video producer.

Quality key: **Good** = usable as-is; **Usable** = usable with work;
**Reference** = guidance only, not footage; **—** = does not exist.

## 1. Brand assets

| Asset ID | Asset | Required for | Available | File location | Quality | Permission status | Missing action | Owner | Intended scene |
|---|---|---|---|---|---|---|---|---|---|
| A-01 | Gloviaa Mart logo (vector master) | Both | **No** | — (the mark is drawn in code: globe + script wordmark, `apps/*/src/components/EarthMark.tsx`, `layout/BrandLockup.tsx`) | — | Own work once made | Design a vector lockup: globe mark + "Gloviaa Mart" in Dancing Script Bold | Design | Lockup, title cards |
| A-02 | Transparent logo (PNG/SVG) | Both | No | — | — | — | Export from A-01 | Design | Overlays |
| A-03 | Logo for dark backgrounds | Both | No | Colour tokens exist: wordmark `#F8FAFF`, tagline `#C7D8F2`, blue glow | — | — | Export from A-01 | Design | About Us end card (navy) |
| A-04 | Logo for light backgrounds | Both | No | Wordmark `#0F172A`, tagline `#334155` | — | — | Export from A-01 | Design | Demo title cards |
| A-05 | UBOSS logo | Both | **No** | — | — | Unknown | Owner to supply, or use the text "Powered by UBOSS" in Inter | Owner | Attribution line |
| A-06 | App icon / favicon-style mark | Social | No | — (no favicon in any app) | — | — | Export from A-01 | Design | Social avatars, thumbnails |
| A-07 | Approved tagline treatment | Both | **No** — the app shows a different tagline | Approved words exist in `en.json` (`greeting.taglineSource`, `greeting.taglineDeliver`) | — | — | Typeset `Source with Intelligence \| Deliver with Confidence` | Design | Lockup, end cards |
| A-08 | Brand colours | Both | Yes | `apps/*/src/index.css`, `tailwind.config.js` | Good | Own | — | — | Grading, graphics |
| A-09 | Brand fonts | Both | Yes | Inter (Google Fonts, OFL); Dancing Script 700 (`@fontsource/dancing-script`, OFL-1.1) | Good | OFL — commercial use allowed | Install both on the edit machine | Prod | All type |
| A-10 | Rotating Gloviaa globe | Both | Yes (in app) | `apps/customer-web/src/components/ui/3d-globe.tsx`; textures `src/assets/globe/earth-blue-marble*.jpg` | Good (render), Usable (as plate) | Textures are NASA Blue Marble — generally public domain; confirm | Screen-record a clean plate at 4K, or rebuild in a 3D tool | Prod | About Us opening and close |

Brand colour reference: navy `#0C2350`, brand blue `#1D4ED8`, action orange
`#EA580C`, teal `#0F766E`, ink `#0F172A`, surface `#FFFFFF`, sunken `#F5F9FE`,
dark surface `#141E30`, dark brand `#8AB4FF`.

## 2. Screenshots and recordings

| Asset ID | Asset | Required for | Available | File location | Quality | Permission | Missing action | Owner | Intended scene |
|---|---|---|---|---|---|---|---|---|---|
| C-01 | Homepage screenshots | Both | Yes (evidence) | `verification-evidence/video-discovery/2026-10-01/01, 10, 21`; `output/brand-verify/` (44) | **Reference** — old tagline, test categories | Own | Re-capture after B-01, B-02 | Dev | Overview, About Us insert |
| C-02 | Product-page screenshots | Both | Yes (evidence) | same folder `04, 16` | Reference — third-party brand | Own | Re-capture with demo product | Dev | Buyer demo |
| C-03 | Buyer recordings | Demo | **No** | — | — | — | Record per capture plan | Prod | Buyer demo |
| C-04 | Seller Hub recordings | Demo | No | — (Hub password gate, `20`) | — | — | B-04, then record | Prod | Seller demo |
| C-05 | Logistics recordings | Demo | No (screens: `24`–`28`; `docs/logistics-screenshots/` 7) | — | Reference — stale data | Own | B-03, then record | Prod | Logistics demo |
| C-06 | Admin recordings | Internal | No (`23` shows the two-step gate) | `output/live-sitemap-screenshots/` (51, older) | Reference | Own | Owner signs in; internal only | Prod | Internal video |
| C-07 | Inspection recordings | Internal | No | — | — | — | Agency accounts + B-10 | Prod | Internal video |
| C-08 | Stripe test-payment recording | Demo | No | — | — | Stripe UI may appear in tutorials; keep the Stripe test badge visible | B-05, then record | Prod | B11 |
| C-09 | Product images | Both | Partly | `Images/` (30 photos, 4167 px, SPM's own); `backend/assets/product-images/` (13, 1200 px); demo catalogue images (source per item unknown) | Good (SPM), Unknown (demo) | **SPM photos: owner must confirm SPM's permission. Demo-catalogue and uploaded images: licence unknown.** The current newest product image appears to show a trademarked toy | Replace with original or licensed images for the demo seed | Owner, Dev | Product chapters |

## 3. Footage

| Asset ID | Asset | Required for | Available | Quality | Permission | Missing action | Owner | Intended scene |
|---|---|---|---|---|---|---|---|---|
| F-01 | Factory / workshop footage | About Us | No | — | — | Generate (G-02) or license / shoot with releases | Prod | Beat 2 |
| F-02 | Warehouse footage | About Us | No | — | — | Generate (G-05) | Prod | Beat 5 |
| F-03 | Inspection footage | About Us | No | — | — | Generate (G-06) — hold until B-10 | Prod | Beat 6 |
| F-04 | Road transport | About Us | No | — | — | Generate (G-07) | Prod | Beat 5 |
| F-05 | Sea freight | About Us | No | — | — | Generate (G-04) | Prod | Beat 5 |
| F-06 | Air freight | About Us (optional) | No | — | — | Generate if used | Prod | Optional |

## 4. Generated scenes required (About Us)

| Asset ID | Scene | Beat | Notes |
|---|---|---|---|
| G-01 | Globe, night to dawn, India lit first | 1 | Or real globe plate (A-10) |
| G-02 | Indian workshop at dawn, hands finishing a product, quality check | 2 | No legible labels; no identifiable faces |
| G-03 | European office, procurement manager reviewing on a laptop | 3 | Screen content added in the edit, not generated |
| G-04 | Container yard / ship loading | 5 | No line names, no port names |
| G-05 | Warehouse: cartons scanned and staged | 5 | No brand marks |
| G-06 | Inspector checking samples with a clipboard | 6 | Hold until B-10 |
| G-07 | Truck on a European road at golden hour | 5 | No livery |
| G-08 | Delivery received at a business reception | 5 | — |
| G-09 | Montage of hands and soft-focus faces across the chain | 6 | Original people only |

## 5. Presenter and voice

| Asset ID | Asset | Required for | Available | Permission | Missing action | Owner |
|---|---|---|---|---|---|---|
| P-01 | Presenter reference image | Demo | No | Must be an original synthetic person | Generate and approve one reference (D-08) | Prod, Owner |
| P-02 | Presenter performance video | Demo | No | If a real person drives it: signed consent and release | Not needed by default (D-08b) | Owner |
| V-01 | Voice | Both | No | Original synthetic voice; **no cloning** without written consent from the person | Choose and approve | Prod, Owner |
| V-02 | Polish voice (optional) | Polish versions | No | Same rule | Only if D-06 asks for it | Prod |

## 6. Sound, text and legal

| Asset ID | Asset | Required for | Available | Permission | Missing action | Owner |
|---|---|---|---|---|---|---|
| M-01 | Music | Both | No | Needs commercial, worldwide, perpetual, online + paid media licence | Commission or license; file the licence here | Prod |
| M-02 | Sound effects | Both | No | Licensed library | License | Prod |
| X-01 | Captions EN | All | No | Own | Write from final narration | Prod |
| X-02 | Captions PL | All | No | Own | Professional translation, human-checked | Prod |
| X-03 | Transcripts | All | No | Own | From final narration | Prod |
| L-01 | Legal disclaimer for demo | Demo | No | — | Proposed: "Demonstration using fictional data. Payments shown in test mode. Features and availability may vary by market." | Owner (+ legal) |
| L-02 | Commercial-use permission log | All | No | — | Create a signed list: every image, clip, font, music track, person, voice | Owner |

## 7. Consent requirements

| Material | Needed before use |
|---|---|
| Face reference of a real person | Written, informed consent naming the use (marketing video, AI generation), territory, duration and right to withdraw |
| Employee appearing on camera | Release form; never implied by employment alone |
| Driving-performance recording | Release covering AI-driven re-use of the performance |
| Voice recording | Release; plus separate, explicit consent for any voice clone |
| Custom voice cloning | Only of a person who has consented in writing to cloning, for this purpose |
| Customer footage or names | Written permission; otherwise fictional only |
| Seller footage, products or logos | Written permission from that seller (applies to SPM's catalogue and photos) |

No celebrity, public figure or identifiable real person may be imitated by a
generated presenter or voice.

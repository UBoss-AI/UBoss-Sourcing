# Pass 9 final verification — 2026-10-02

Total: **272/364 → 277/364**. Section 17: **61/67 → 66/67**. The requested 60/67 baseline was stale: JOURNEY-019 was already checked. Section 12 remains 9/10; Section 14 remains 7/21. No checkbox changed during LIVE-017 software remediation.

Ticked exactly: JOURNEY-026, JOURNEY-027, JOURNEY-028, JOURNEY-030, JOURNEY-034. Exact requirements and Checks are in batch-9.json and pass9-verification.json.

## Verification

| Command/package | Actual result |
| --- | --- |
| npm run verify — admin-web | Exit 0; 52 files / 382 tests; production build passed |
| npm run verify — customer-web | Exit 0; 196 files / 1,800 tests; production build passed |
| npm run verify — backend, Seller Hub phase | Exit 0; 335 files / 5,322 tests |
| Tracking focused tests | Exit 0; 2 files / 24 tests |
| Tracking complete backend verify | Exit 0; 336 files / 5333 tests |
| Payout focused tests | Exit 0; 4 files / 39 tests |
| Payout complete backend verify | Exit 0; 337 files / 5349 tests |
| npm run docs:check — scripts | All three generated reference documents match |
| node verification-evidence/pass4/audit.cjs | problems: []; 277 checked / 87 unchecked |
| scripts/secret-scan.ps1 | No leaks found |

Full logs and definitive exit files are in TEMP. Full runs were sequential; affected sources stayed unchanged during each complete run. Frontend verification preceded the backend-only LIVE-017 changes.

Failures repaired: missing catalog labelText contract; missing complete market-note fixture; separate commission and commission-tax ledger assertions; seller/staff login transport-IP isolation; order-desk fixture IP isolation for inspection setup; tracking fixture token and lint error handling; payout unused import and discriminated-union narrowing. Old payout outage assertions now verify reserved funds and read-only recovery, rather than expecting unsafe reversal/new-key sends. The evidence JSON files contain detailed traceability.

## LIVE-017

Tracking: feature-gated 15-minute scheduling; non-terminal active API shipments; durable per-shipment dedupe; domain/inspection transitions and version checks; no stale/backward progress; provider times/references; 30-second read deadline; queue backoff and operational evidence.

Payouts: persistent original reference/key, funds reserved on unknown results, read-only reconciliation, locked/idempotent settlement or definitive rejection, concurrent/restart recovery, and BigInt money. Legacy FAILED rows without rejection proof and transfers without exact recovery metadata require finance review. Unknown results cannot trigger a second POST. Stripe transfer-group lookup was verified against [Stripe's API reference](https://docs.stripe.com/api/transfers/list).

LIVE-017 remains unchecked for the staging outage test. No human, legal, live-provider, device, staging, restore, rehearsal, secret-rotation or production-traffic approval is claimed.

## Documents and Word synchronization

Checklist.md, the authoritative unnumbered root Word checklist, state.json and batch-9.json agree on the five checked IDs. Non-checkbox document XML is unchanged and all other DOCX package payloads are identical to the temporary pre-edit copy. The checklist audit reads the package successfully. No visual Word rendering claim: the bundled Windows runtime had no LibreOffice renderer. The protected backup DOCX is untouched.

English and ignored Hinglish guides, README, applicable PRD/API/database/screens documentation, and the feature-guide generator are synchronized. The ignored generated feature-guide DOCX was rebuilt. Reference docs match; no schema migration or new route was needed for either gap.

## Open requirements

All 87 exact IDs follow. Items outside the authorized five-row batch and LIVE-017 software scope remain unverified; existing checklist evidence/status is retained. This report does not infer that an old unverified row is currently unbuilt.

| Exact ID | Exact requirement / Checks | Reason still open |
| --- | --- | --- |
| SCREEN-009 | Help / Policies / Legal — Terms, privacy, returns, inspection, prohibited items, buyer protection | Approved launch policy text and legal sign-off are still required. |
| SCREEN-012 | Seller Application / KYB — Legal entity, ownership, tax/export/bank and verification | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| DOD-001 | Clear primary action | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| DOD-003 | Responsive desktop/tablet/mobile | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| DOD-004 | Keyboard/focus usability | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| DOD-043 | browser/device | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| DOD-044 | performance | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| TEMPLATE-001 | Pass | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| TEMPLATE-002 | Fail | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| TEMPLATE-003 | N/A | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| TEMPLATE-004 | Pass | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| TEMPLATE-005 | Fail | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| TEMPLATE-006 | N/A | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| TEMPLATE-007 | Pass | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| TEMPLATE-008 | Fail | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| TEMPLATE-009 | N/A | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| TEMPLATE-010 | Pass | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| TEMPLATE-011 | Fail | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| TEMPLATE-012 | N/A | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| SEC-010 | Backup, restore, disaster recovery, monitoring, incident response and security alert ownership tested before go-live. | Name alert owners; configure UBOSS_ALERT_COMMAND; prove recipient delivery; verify an off-site restore; complete disaster-recovery rehearsal. |
| LIVE-001 | All P0 screens approved by Product Owner and QA. | Product Owner and QA sign-off are required. |
| LIVE-002 | Responsive behavior validated on supported devices/browsers. | Actual supported browser/device validation, including Safari, iOS and Android, is required. |
| LIVE-003 | Empty/error/loading states complete; user guidance and policy links published. | Publish counsel-approved policy text; depends on LIVE-014. State audit is complete. |
| LIVE-010 | Seller verification SOP, inspection SOP, dispute SOP and finance reconciliation SOP operational. | Use all four operating procedures operationally. |
| LIVE-011 | SLAs, escalation owners and admin exception queues defined. | Assign real people to every owner/escalation role; /operations/exception-queues is built. |
| LIVE-012 | Support team trained using real UAT scenarios. | Support-team training is required. |
| LIVE-013 | Penetration/security testing issues resolved per release criteria. | External penetration testing is required. |
| LIVE-014 | Privacy/terms/seller/buyer/inspection policies approved by qualified legal/compliance counsel for launch markets. | Legal-counsel approval is required. |
| LIVE-015 | Backup/restore, incident response and privileged access review tested. | Restore test, disaster-recovery rehearsal and incident exercise are required; staff-access review software is built. |
| LIVE-016 | Payment, payout, logistics, notification, storage and inspection integrations production-tested. | Test production integrations against real services. |
| LIVE-017 | Webhook retries, reconciliation and outage fallback validated. | Both software gaps are fixed and locally tested; staging outage validation remains required. Live-provider validation is not claimed. |
| LIVE-018 | Production credentials/secrets rotated and monitored. | Rotate and monitor actual production secrets; unit-tested rotation is insufficient production evidence. |
| LIVE-019 | Master data loaded and approved. | Business approval of master data; GET /admin/master-data-readiness is built. |
| LIVE-020 | Critical event analytics validated against source transactions. | Production-traffic validation is required. |
| SIGNOFF-001 | Approve | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| SIGNOFF-002 | Hold | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| SIGNOFF-003 | Approve | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| SIGNOFF-004 | Hold | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| SIGNOFF-005 | Approve | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| SIGNOFF-006 | Hold | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| SIGNOFF-007 | Approve | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| SIGNOFF-008 | Hold | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| SIGNOFF-009 | Approve | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| SIGNOFF-010 | Hold | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| SIGNOFF-011 | Approve | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| SIGNOFF-012 | Hold | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| SIGNOFF-013 | Approve | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| SIGNOFF-014 | Hold | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| SIGNOFF-015 | Approve | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| SIGNOFF-016 | Hold | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| SIGNOFF-017 | Go Live | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| SIGNOFF-018 | Hold | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| HOME-009 | Natural-language and keyword search across products, categories, suppliers and capabilities. Checks: Autocomplete; spelling; synonyms; no-result recovery; recent searches; search analytics. | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| JOURNEY-010 | Verify Indian manufacturer/OEM before selling. Checks: PAN/GST/CIN/Udyam/IEC as applicable; bank validation; beneficial owner/contact; factory proof; export capability; sanctions/restriction screening as required by policy. | Bank-account validation through the production payout provider is still required. |
| ENH-001 | User describes need in plain language; AI converts it into filters/specifications and a draft RFQ. | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| ENH-002 | AI summarizes differences only from verified catalog/quote data and links every conclusion to source fields. | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| ENH-003 | Home changes for guest, B2B buyer, B2C buyer, seller and returning user. | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| ENH-004 | One search can find product, supplier, RFQ, order, invoice, shipment or help depending on role. | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| ENH-005 | Persistent actions: Create RFQ, Upload Image, Ask AI, Reorder, Track Order, Contact Support. | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| ENH-008 | Explain match using capacity, MOQ, certifications, destination eligibility and response record; avoid opaque ranking. | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| ENH-014 | Spending caps, supplier/category scope, expiry, pre-charge reminder and one-click pause. | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| ENH-015 | Step-by-step mapping for PO, order acknowledgement, invoice, shipment and status with sandbox test. | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| ENH-016 | Upload Excel/CSV requirements or SKU list to create multi-line RFQ/order. | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| ENH-018 | Rank operational tasks by deadline and business impact, not merely dashboard metrics. | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| ENH-019 | One queue for failed payment, missing doc, inspection NCR, late shipment, settlement mismatch and integration failure. | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| ENH-020 | Bundle low-priority alerts; immediately escalate inspection fail, payment risk, shipping delay and RFQ expiry. | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| ENH-021 | Translate product content/messages while retaining original text. | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| ENH-022 | Inline prompts explain importer details, labeling or documents needed for selected destination. | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| ENH-024 | Dedicated CTA captures branding, packaging, drawing/spec and target volume. | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| ENH-025 | Approved sample becomes a controlled reference for bulk order and inspection. | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| ENH-026 | System-generated final term sheet before acceptance, showing changed clauses. | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| ENH-027 | Interactive quantity slider displays tier price, lead-time/capacity effect and estimated landed cost. | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| ENH-029 | RFQ reply, order milestone, inspection readiness, document upload and notifications optimized for phone. | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| ENH-030 | Visible countdowns for quote response, inspection assignment, report issuance, shipment readiness and dispute handling. | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| ENH-031 | Controlled export/API for orders, RFQs, reports, settlements and analytics. | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| ENH-032 | Explain fields, suggest values from existing verified data, but require user confirmation. | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| DYNAMIC-001 | Header: Logo \| Universal Search \| Country/Language/Currency \| Seller Hub \| Messages/Notifications \| Profile \| Cart. | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| DYNAMIC-002 | Hero: “Source from verified Indian manufacturers” + Search/AI input + quick chips (Product, Supplier, RFQ, Image Search). | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| DYNAMIC-003 | Trust strip: Verified manufacturers \| Independent inspection \| Buyer protection / controlled payment \| Global logistics. | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| DYNAMIC-004 | Personalized task row for signed-in user: quotes awaiting decision, inspection status, shipments, payments, repeat orders. | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| DYNAMIC-005 | AI sourcing assistant with examples and “Create RFQ from this conversation”. | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| DYNAMIC-007 | B2B tools: Request Private Label/OEM \| Upload Bulk Requirement \| Landed Cost \| Schedule Cart \| ERP Integration. | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| DYNAMIC-010 | Footer: Help, policies, inspection policy, buyer/seller terms, privacy, prohibited products, support and company information. | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| UAT-UI-002 | User starts with image search, receives matches, opens a product and converts it to an RFQ with image retained as reference. | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| UAT-UI-007 | ERP sync receives duplicate PO event; idempotency prevents duplicate order creation. | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| UAT-UI-012 | Buyer destination is changed to a country where product is restricted; checkout/RFQ shows block and compliance reason. | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |
| UAT-UI-013 | Seller certificate expires; affected listings/markets follow configured warning/hold policy and buyer-facing badge updates. | Outside the authorized verification batch; no new complete requirement evidence or approval was established. |

## Git

Original feature commit 96624b29 was preserved. Seller Hub repair d24d17c2, checklist/evidence 2995801d and tracking cee248ab were separately committed and pushed. The final payout commit and matching local/remote main hashes are reported in the final chat response. No force push or history rewrite. Protected unrelated untracked files remain untouched and excluded.

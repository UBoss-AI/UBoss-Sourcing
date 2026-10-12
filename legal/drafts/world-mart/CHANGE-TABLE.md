# Source-to-adapted change table — World Mart policy documents

**Status: finalised text, version 1.0, effective 12 October 2026, with sample
company details. Not reviewed by counsel.** These documents were adapted by an
AI assistant from two third-party source files and the operator's own Word
files, against what the World Mart software is documented to do
(`docs/PRD.md`). On 12 October 2026, at the owner's request, every
`[[DECISION: ...]]` was settled (see "Decisions taken" below), every `______`
blank was filled, and every "DRAFT - not legal advice..." notice and "For
approval before implementation or signature" line was removed. The company
details written into the text are **samples** that must be replaced before
going live (see "Sample values to replace before going live"). Automated
drafting is not legal advice and not legal approval.

The tables in (a) and (b) record how the source was adapted. Where they say
`[[DECISION]]`, that decision has since been taken; the value used is in
"Decisions taken".

Sources (unchanged copies in `legal/source/`, not in git):

| Source | SHA-256 |
|---|---|
| `T&C of Flipkart Seller Hub.txt` | `75209e373798b31ec24c03241d68d472538aca3c0a5e5fa9d5e824334c1aac60` |
| `Privacy Policy of Flipkart Seller Hub.txt` | `68bdad052baf4a2f429301289ddd99d34412194c3726a37454217612bacb3d79` |

Documents (all version `1.0`, effective 12 October 2026, English):

| File | Kind | Who agrees / acknowledges |
|---|---|---|
| `platform-terms.en.txt` | `PLATFORM_TERMS` | Every buyer (Part A common + Part B buyer) |
| `seller-terms.en.txt` | `SELLER_TERMS` | Sellers, in addition to the Terms of Use. **Replaced 2026-10-09** by the operator's own text - see (z) below |
| `seller-services-agreement.en.txt` | `SELLER_SERVICES_AGREEMENT` | Sellers, in its own box. Operator's own text - see (z) below |
| `b2b-buyer-terms.en.txt` | `B2B_BUYER_TERMS` | Each member acting for a buyer company, for that company. Operator's own text, filled in on 12 October 2026 |
| `b2b-buyer-services-agreement.en.txt` | `B2B_BUYER_SERVICES_AGREEMENT` | A buyer company, once, through its owner or a company admin. Operator's own text, filled in on 12 October 2026 |
| `b2c-consumer-terms.en.txt` | `B2C_CONSUMER_TERMS` | Each person shopping for themselves, on the consumer screen. Operator's own text, filled in on 12 October 2026 |
| `b2c-platform-services-agreement.en.txt` | `B2C_PLATFORM_SERVICES_AGREEMENT` | Each person shopping for themselves, in its own box. Written on 12 October 2026 (no operator text had been supplied) |
| `privacy-policy.en.txt` | `PRIVACY_POLICY` | Everyone — acknowledged, not consented to |
| `delivery-returns-disputes-policy.en.txt` | `RETURNS_POLICY` | Buyers — the Delivery, Returns, Refunds and Disputes Policy |
| `logistics-partner-terms.en.txt` | `LOGISTICS_PARTNER_TERMS` | Carrier staff (Part A + Part L) |
| `staff-terms.en.txt` | `STAFF_TERMS` | Operator staff (Part A + Part S) |
| `audit-console-terms.en.txt` | `AUDIT_CONSOLE_TERMS` | Audit Console users (Part A + Part C) |

Part A ("common terms") is the same text in the four terms documents that carry it.
The source T&C was written for **sellers only**; its general provisions became
Part A, its seller provisions the Seller Addendum, and nothing seller-specific
was put in a document buyers, carriers or staff agree to.

## (a) Terms of Use source (`T&C of Flipkart Seller Hub.txt`)

| Source section | What it said (short) | Treatment | Reason |
|---|---|---|---|
| Preamble: IT Act 2000 electronic record | Document is an electronic record, no signature | Adapted → A1 (agreement formed electronically; version, language, time recorded) | India statute removed; the product records the acceptance |
| Preamble: Rule 3(1) Intermediary Rules 2021 | Published under Indian intermediary rules | Removed | India-specific; governing law is an open decision |
| Ownership and registered office | Flipkart Internet Pvt Ltd, Bengaluru address | Replaced by `[[DECISION]]` placeholders → A1 | Competitor details; operator entity must not be invented |
| Definitions ("you", "user", "we") | You = Seller; user = Seller, Buyer, visitor | Adapted → A1 (all six roles defined) | Platform has buyers, sellers, carriers, staff, auditors |
| Incorporation of policies, notifications | Policies and notices form part of ToU | Adapted → A1 (named published policies only) | Only documents the product actually publishes |
| Unilateral changes; continued use = acceptance | Change any time; continued use accepts | Adapted → A17 (notice period `[[DECISION]]`, re-agreement when a version requires it, never deemed) | Matches the product's versioned re-acceptance; fairer under EU law |
| Licence to use the Platform | Personal, non-exclusive, limited privilege | Kept → A1 | Applies to all roles |
| ALL-CAPS "using = agreement" | Browsing indicates agreement | Removed | Agreement is an explicit recorded action |
| Seller Eligibility (Indian Contract Act, minors) | Must be competent to contract; 18+; authority for entity | Adapted → A2 (age `[[DECISION]]`) and S1 (business only, turnover eligibility) | India statute generalised; product has a turnover rule (FR-SEL-022) |
| Account and Registration Obligations (field list) | Long list of seller data incl. PAN, cancelled cheque, signature | Adapted → S2 | Generalised identifiers per country; no bank details stored (Stripe account link); signature dropped |
| Licences and permits | Seller holds licences | Kept → S2, S8 | |
| Confidentiality of credentials; suspension for untrue data | | Kept → A3 (all) and S2 (seller) | |
| Authority to handle customer grievances; address on listings | | Adapted → S3 (address display `[[DECISION]]`) | |
| Seller Account Deactivation (90-day hold, data retained, no new account) | | Adapted → S5 (hold `[[DECISION]]`; retention moved to Privacy Policy) | Period is a business decision |
| Communications | Consent to electronic records | Adapted → A4 (service vs marketing messages separated) | Marketing is opt-in in the product |
| Platform for Transaction and Communication ("Consequently" list) | Flipkart not party; no warranties; no mediation; no title | Adapted → A5 | Product **does** run claims, buyer protection, inspections and holds funds; "not required to mediate" removed |
| Release and waiver of claims re other users' actions | | Removed (replaced by A14/A15/A16) | Blanket waiver unlikely enforceable for consumers |
| Platform Services (tech services, GSP) | List of tech services, GST Suvidha Provider | Removed | India-specific; describes Flipkart's service catalogue |
| Liquidation of returned inventory | | Removed | Product has no such service |
| Seller Learning Centre reference | | Removed | No such resource exists |
| Use of the Platform: intermediary/hosting | Merely hosts third-party content | Adapted → A5 (last paragraph) | |
| Prohibited content a–aa | 27 categories | Kept → A6 a–aa | (b) India Act reference generalised; (y) "unity of India" → public order in any market; (z) "law of the land" → place of sale/delivery + Prohibited Products Policy |
| "Prior written consent" = Legal Department reply | | Adapted → A6 | Department name removed |
| Deep-links, scraping, unauthorised access, probing, tracing, load, interference, forged headers, unlawful use | | Kept → A7 | Security-testing exception added (written permission) |
| Non-disparagement of Flipkart and its brands | | Removed | Overbroad; may restrict lawful reviews and complaints |
| Compliance with IT Act, GST, FSSA, Legal Metrology, FEMA etc. | | Generalised → A19 (all users) and S8, S12, S22 (sellers) | India statute list replaced by "law of each market" |
| Perpetual irrevocable licence to "your information" | | Narrowed → A8 + `[[DECISION]]` | Disproportionate; needs a business decision |
| Accurate product information; no exaggeration | | Kept → S6, S9 | Seller-only |
| No soliciting other sellers; disclosure to authorities; monitoring right; seller responsible for content | | Split → S7 (solicitation), A8 (disclosure, monitoring, responsibility) | |
| Dealings with advertisers | | Kept → A11 | |
| Exposure to offensive material / hackers | | Removed | Not a term; security is covered in A14 and the Privacy Policy |
| DoS / DDoS damages | | Kept → A7 | |
| Promotional campaigns (auto opt-in, seller bears cost) | | Adapted → A12 (no paid campaign without opting in) | Auto opt-in into paid campaigns removed |
| No cartels; ethical policies | | Kept → S7 | |
| Customer personal data processed only within scope | | Moved → S17 | |
| Entire agreement; unilateral modification | | Adapted → A20 (entire agreement) / A17 (changes) | |
| Selling (legal ability, IP, categories, stock, refund if mismatch, no duplicate listings, country-of-origin restriction) | | Kept → S6 | Listing review reflects product's moderation |
| Combining product data across sellers | | Kept → S6 | |
| Food shelf-life (FSSAI) | | Adapted → S8 (`[[DECISION]]` on rule) | |
| Pharmaceutical licences (list of 18 Indian Acts) | | Generalised → S8 + `[[DECISION: list of regulated product categories...]]` | Indian statute list not applicable internationally |
| Change of registered pharmacist within 7 days | | Kept (generalised to "qualified person") → S8 | |
| Logistics (Mother Hub, transport costs, return-cost recovery) | Duplicated paragraph in source | Adapted → S11 | Product's delivery methods (own carrier, marketplace carrier, self-managed) |
| Insurance authorisation to Instakart / Flipkart India as Logistics Partner | | Removed; insurance → S11 + `[[DECISION: carrier liability...]]` | Competitor affiliates |
| Damaged shipment disposal | | Kept → S11 | |
| Seller Protection Fund eligibility | | Removed | Product has no such fund |
| GST compliance (IGST/CGST/SGST/UTGST), TCS under GST | | Generalised → S12 (VAT/GST/sales tax) + `[[DECISION: tax-withholding...]]` | India-specific; EU VAT treatment exists in product |
| HSN code required | | Generalised → S12 (commodity/tariff code) | |
| GSTIN required; ISD registration | | Generalised → S12 (tax identifier); ISD removed | |
| GST rate notifications 9/2025, 10/2025, 15/2025 | | Generalised → S12 (pass on rate reductions where law requires) | Dated Indian notifications |
| Income-tax: TDS s.194-O, LDC s.197, s.206AA/AB, Form 16A, TCS Ch. XVII-BB, 0.75%/1% rates | | Generalised → S12 + `[[DECISION]]` | India-specific |
| 25% inventory purchase cap from group companies (FDI policy) | | Removed | Indian FDI rule for Flipkart's structure |
| Exclusivity waiver from 1 Feb 2019 | | Removed | Flipkart-specific history |
| Content Posted: third-party content, no copying | | Kept → A9 | |
| Download for personal use conditions | | Kept → A9 | |
| Content licence incl. generative AI, perpetual, any media | | Narrowed → A8 + `[[DECISION: scope of the licence...]]` | Needs business decision |
| Limited licence to use "Flipkart.com" logo on invoices/packaging | | Removed | Competitor brand; no equivalent licence decided |
| Types of Sellers (tiers by performance) | | Removed | Product has fee-rule seller tiers but no published tier benefits; would describe something not built |
| Samarth Program (eligibility, benefits, commission table) | | Removed | Flipkart programme |
| Payment: principal-to-principal; payment facility not banking | | Adapted → S14, B6 | Facilitator/escrow ledger per D13; wording `[[DECISION: who is the seller of record...]]` |
| Cash on delivery | | Removed | Product has no COD |
| 180-day monetary claims limit; reconciliation | | Adapted → S14 + `[[DECISION]]` | |
| Bank transfers via issuing bank gateway | | Removed | Payment provider pages (Stripe/Razorpay) instead |
| Dispatch: timelines, transit insurance, dispatch details, PoD 3 years, true details, consequences | | Kept → S11 (PoD period `[[DECISION]]`) | |
| Remittance conditions a–d; RBI Intermediary Guidelines | | Adapted → S14 (delivered, release period, no open claim, inspection passed) | Matches product's held-funds release rules; RBI removed |
| Prepaid Payment Instruments / gift vouchers (RBI PPI) | | Removed | Product has no PPI |
| Financial Facilities for Customers (receivable assignment) | | Removed | No lending product |
| Deferred Payment Options | | Removed | No such feature |
| Charges: free registration, fee policy, INR, set-off | | Adapted → S15 (currency-neutral; fees deducted from proceeds; `[[DECISION]]` notice) | |
| Collect fees on seller's behalf | | Kept → S15 | |
| GST/taxes on fees | | Generalised → S12 (last line) | |
| Express Remittance | | Removed | No such feature |
| Invoice generation with seller signature image; inventory-movement invoices | | Adapted → S13 + `[[DECISION]]` | Product generates seller invoices; signature not used |
| Chargebacks deducted from remittances | | Kept → S16 | |
| Delay payment confirmation; pay to law enforcement | | Kept → S14 | |
| No liability for processing delays; discharge on payment to bank account | | Kept → S14 | |
| Compliance with Laws; sign declarations | | Kept → S22 | |
| Jewellery hallmarking certificate; buyer KYC for jewellery | | Generalised → S8 (jewellery as regulated category), S19 (buyer identification where law requires) | BIS-specific |
| AML and sanctions (UN, India, OFAC) | | Adapted → S19 + `[[DECISION: sanctioned countries...]]` | Regimes depend on markets |
| Data Protection Obligation a–h (DPDP Act, CERT-In, Flipkart incident emails) | | Adapted → S17 (`[[DECISION]]` controller/processor; incident address) | Competitor emails and India-only law removed |
| Warranty that personal data provided was lawfully collected | | Kept → S17 | |
| Prohibited & Restricted Items Policy responsibility | | Adapted → S8 (Prohibited Products Policy) | |
| Legal Metrology labelling; consumer complaint answers | | Generalised → S8, S22 | |
| Consumer Protection (E-commerce) Rules 2020 A–D | | Generalised → S10 | Refund-to-gift-voucher option removed (no vouchers) |
| Legal Metrology (Packaged Commodities) Rules A–D, indemnity | | Generalised → S8, S22, S23 | |
| Supply-chain covenants (i)–(vi) | | Kept → S19 | |
| Information sharing with brands/authorities; Brand Protection Initiative | | Adapted → S24 | Programme name removed |
| Seller Action Framework (delist, blacklist, penalties, notices, category, manufacturing returns) | | Adapted → S23, S24 (proportionate, with reasons and review) | Fairness and EU P2B-style transparency |
| Anti-Corruption (Walmart/Flipkart policy links, FCPA/UKBA, certification, audit, training, subcontractors, termination, form of payment, change of control, no government interaction) | | Adapted → S20 + `[[DECISION: anti-corruption policy...]]` | Competitor ethics links removed; principles kept |
| Anti-Corruption clauses under Samarth (government affiliations, nonprofit change, INR payments) | | Partly merged → S20 (government-official disclosure); rest removed | Samarth-only |
| Product Description disclaimer | | Kept → A14 | |
| Audits (right to inspect; cost on seller if discrepancy) | | Adapted → S21 + `[[DECISION: audit cost...]]` | Linked to the product's inspection agencies |
| Breach (limit, remove, warn, suspend, hold) and documents demanded | | Adapted → A13 (all) and S24 (seller documents) | |
| Reinstatement; no re-registration; recovery and police referral | | Kept → A13 | |
| Indemnity | | Kept → A16 (consumer carve-out) | |
| Trademark complaint / Copyright complaint (infringement@ email) | | Adapted → A10 + `[[DECISION: address for IP complaints]]` | Competitor email removed |
| Trademark, Copyright and Restriction | | Kept → A9 | |
| Limitation of Liability (all caps) | | Adapted → A15 + `[[DECISION: liability cap]]` | Mandatory carve-outs added |
| Applicable Law: India; Bangalore courts | | Replaced → A18 `[[DECISION: governing law]]`, `[[DECISION: courts...]]` | Not to be invented |
| Jurisdictional Issues / Sale in India Only | | Replaced → A19 (international markets `[[DECISION]]`) | Product sells in several countries and currencies |
| Seller Declarations table 1–15 (cosmetics, BIS, animal parts, plastics, manjha, gold, WPC/TEC, national honour, drugs, tobacco, khadi, antiquities, infant milk, food, greenwashing) | | Generalised → S8 categories, S9 (greenwashing), Schedule 1 | Indian statutes and NGT order removed; categories kept |
| Further regulations (Legal Metrology, CPE Rules, FEMA, PMLA, FCRA, Income Tax, EXIM) | | Generalised → S22 | |
| Sanctioned regions (Cuba, Iran, North Korea, Syria, Luhansk, Donetsk, Crimea) | | Generalised → S19 + `[[DECISION]]` | List must follow the regimes that apply to the operator |
| Irreparable harm; certificate within 7 days; assignment of undertaking | | Kept → S22 | |
| Bengaluru courts for declarations | | Removed (A18 applies) | |
| Notice deemed received (1 / 3 business days) | | Adapted → S25 (email only) | Product has no postal notices |
| Contact Us (raise incident from Seller dashboard) | | Adapted → A21 (support page) | |
| Grievance Officer (named person, Flipkart address, email) | | Replaced → A21 `[[DECISION: grievance officer...]]` | Competitor's officer |
| Annexure I: Pharmaceuticals declarations 1–36 | | Generalised → Schedule 1 items 1–19 (duplicates merged; Indian Acts and Schedules H/H1/G/X generalised) | |
| Information security: Annexure II/III, ISO 27001 | | Adapted → S18 + `[[DECISION: information-security requirements...]]` | Annexures were not supplied |
| "Offices and Institutions - Seller TOU" link | | Removed | External competitor page |

## (b) Privacy Policy source (`Privacy Policy of Flipkart Seller Hub.txt`)

| Source section | What it said (short) | Treatment | Reason |
|---|---|---|---|
| Intro: Flipkart and affiliates process data via seller portal | | Replaced → §1 controller `[[DECISION]]`; scope = whole Platform, all roles | One notice for every user |
| "By visiting you consent"; governed by Indian law | | Removed; replaced by "this is a notice, acknowledged, not consented to" | Notice ≠ consent under GDPR; consent asked separately |
| Collection of Information: only what is needed | | Kept → §3 | |
| Browse anonymously; required vs optional fields | | Kept → §3 | |
| Public-domain information (social media) | | Removed | Product collects none |
| Categories list (sign-up, address, brand NOC, GSTIN, turnover, bank, cheque, KYC, PAN, URLs, IP; "no Aadhaar") | | Adapted → §3, §4 per role | From what the product actually stores; bank details not stored; Aadhaar note removed |
| Marketing to contact details; withdraw by unsubscribing | | Adapted → §5 consent; §12 | Marketing off until chosen (FR-IDN-020) |
| Primary goal: smooth customised experience | | Folded into §5 purposes | |
| Phishing warning | | Kept → §11 | |
| Queries via email/social media retained | | Adapted → §3, §10 | |
| Third-party business partners on platform (cataloguing, imaging...) | | Removed | No such partner programme |
| PAN, credit report, lending/insurance eligibility | | Removed | No lending/insurance/credit checks |
| Message boards and feedback; correspondence file | | Adapted → §3 (messages, reviews, support) | |
| Use of data (two duplicated paragraphs; loans; GST invoice) | | Rewritten → §5 with purpose + lawful basis | GDPR Art. 6 needs a basis per purpose; loans removed |
| Demographic and profile analysis | | Replaced → anonymous counts (§5, §9) | Product has no profiling |
| IP address use | | Kept → §3 | |
| AI/ML on images provided | | Adapted → §6 (exactly what each AI feature sends; image not stored) | Must describe real processing |
| Optional surveys | | Kept → §3 | |
| Cookies (permanent and temporary; no PII) | | Rewritten → §9 (strictly necessary only; local storage; anonymous counters; bot-protection `[[DECISION]]`) | Matches FR-PRV-004 |
| Sharing with third parties incl. marketing, AI/ML | | Rewritten → §7 (named categories) | |
| Sharing within Flipkart group, Advanz, Scapic, lending partners, credit bureaus, UPI | | Removed | Competitor group; no lending |
| Legal disclosure | | Kept → §7 | |
| Share/sell data in merger | | Adapted → §7 (transfer to successor, no "sell") | |
| Links to other sites | | Kept → §15 | |
| Security precautions | | Adapted → §11 (product's real safeguards) | |
| Choice/Opt-out | | Merged → §5, §12 | |
| Advertisements on Flipkart.com (third-party ad companies) | | Removed | Product shows no third-party ads |
| Data Retention | | Adapted → §10 (product's default sweep windows) + `[[DECISION: retention periods...]]` | |
| Your Consent: SMS, IM, contacts, location, camera, gallery, device; post stories on social media | | Removed | Product accesses none of these; blanket consent invalid |
| Your Rights (update via email) | | Expanded → §12 (all GDPR rights; in-product export, correction, erasure; complaint `[[DECISION]]`) | |
| Changes to this Privacy Policy | | Kept → §16 (versioned, acknowledgment of new version) | |
| Grievance Officer (named person, Flipkart address, email) | | Replaced → §17 `[[DECISION]]` | |
| Questions | | Kept → §17 | |
| (new) International transfers | | Added → §8 `[[DECISION]]` | Required for EU markets |
| (new) Children | | Added → §14 | |
| (new) Data about other people | | Added → §13 | |

## (c) Business and legal decisions that were open (all taken 12 October 2026)

This is the list as it stood before 12 October 2026. Each item names the marker
that used to be in the text and the documents that held it. None of these
markers is left in any file; the value used for each is in "Decisions taken"
and "Sample values to replace before going live" below.

1. `[[DECISION: registered legal name of the operator]]` — platform, privacy, logistics, staff, audit
2. `[[DECISION: company registration number and register]]` — platform, privacy, logistics, staff, audit
3. `[[DECISION: registered office address of the operator]]` — platform, privacy, logistics, staff, audit
4. `[[DECISION: contact email address for legal notices]]` — platform, logistics, staff, audit
5. `[[DECISION: grievance officer or complaints contact - name, address, email]]` — platform, privacy, logistics, staff, audit
6. `[[DECISION: data protection officer or privacy contact, and EU representative if required]]` — privacy
7. `[[DECISION: governing law]]` — platform, logistics, staff, audit
8. `[[DECISION: courts with jurisdiction, and whether consumers keep their home-court rights]]` — platform, logistics, staff, audit
9. `[[DECISION: supervisory authority named for complaints]]` — privacy
10. `[[DECISION: minimum age and whether individual consumers may buy, or business buyers only]]` — platform, privacy, logistics, staff, audit
11. `[[DECISION: confirm whether individual consumers may buy on the Platform and, if so, the consumer-law information each market requires (for example withdrawal rights and the trader's identity)]]` — platform
12. `[[DECISION: markets and countries where the marketplace sells and delivers]]` — platform, logistics, staff, audit
13. `[[DECISION: which language version prevails if translations differ]]` — platform, logistics, staff, audit
14. `[[DECISION: scope of the licence over content users upload - the source asked for a perpetual, irrevocable, sub-licensable licence including generative-AI use and use in advertising]]` — platform, logistics, staff, audit
15. `[[DECISION: liability cap amount and carve-outs permitted by the governing law]]` — platform, logistics, staff, audit
16. `[[DECISION: notice period before changed terms take effect]]` — platform, logistics, staff, audit
17. `[[DECISION: address for intellectual-property and illegal-content complaints]]` — platform, logistics, staff, audit
18. `[[DECISION: who is the seller of record for operator's own goods vs marketplace sellers; merchant-of-record / payment facilitator wording approved by the payment provider]]` — platform, seller
19. `[[DECISION: returns window and refund rules (to be set in the Returns Policy)]]` — platform
20. `[[DECISION: the seller funds release period, reserve and payout schedule]]` — seller
21. `[[DECISION: time limit for monetary claims by sellers (the source used 180 days)]]` — seller
22. `[[DECISION: platform fee schedule location and notice period for fee changes]]` — seller
23. `[[DECISION: account closure hold period for sellers (the source used 90 days)]]` — seller
24. `[[DECISION: whether a seller's contact details and address are shown on product pages, as consumer law in each market may require]]` — seller
25. `[[DECISION: list of regulated product categories and the laws named for each market]]` — seller
26. `[[DECISION: shelf-life rule for food products (the source used 30 percent or 45 days)]]` — seller
27. `[[DECISION: period for keeping proof of dispatch and delivery (the source used three years)]]` — seller
28. `[[DECISION: carrier liability, insurance and loss/damage claims terms]]` — seller, logistics
29. `[[DECISION: tax-withholding and tax-collection duties of the operator in each market (the source applied Indian TDS/TCS)]]` — seller
30. `[[DECISION: whether the operator generates invoices on a seller's behalf and on what legal basis, including any signature image]]` — seller
31. `[[DECISION: controller/processor roles between the operator and sellers for buyer personal data]]` — seller, privacy
32. `[[DECISION: incident-reporting contact address and deadline for sellers]]` — seller
33. `[[DECISION: information-security requirements for sellers with technical integrations (the source referred to annexures II and III that were not supplied)]]` — seller
34. `[[DECISION: sanctioned countries and regions list and sanctions regimes that apply]]` — seller
35. `[[DECISION: anti-corruption policy reference and whether certification, training and audit rights are required]]` — seller
36. `[[DECISION: audit cost allocation and notice period]]` — seller
37. `[[DECISION: payment providers used in production (for example Stripe and Razorpay) and their roles]]` — privacy
38. `[[DECISION: whether the AI provider is Google Gemini or Anthropic Claude in production, and the provider's data-use terms]]` — privacy
39. `[[DECISION: international data transfer mechanism (e.g. adequacy, standard contractual clauses) and the named providers and their locations]]` — privacy
40. `[[DECISION: retention periods for orders, invoices, KYC/KYB documents and closed accounts under tax and anti-money-laundering law]]` — privacy
41. `[[DECISION: whether bot protection (Cloudflare Turnstile or hCaptcha) is used in production, and the provider's cookie disclosure]]` — privacy
42. `[[DECISION: whether driver location tracking is switched on; the Platform can record a driver's position while on duty but this is off and must not be switched on without an assessment and a driver notice]]` — privacy, logistics
43. `[[DECISION: whether sign-in location recording is enabled for staff and the data-protection impact assessment reference]]` — privacy, staff
44. `[[DECISION: relationship to staff employment contracts and the staff acceptable-use policy]]` — staff
45. `[[DECISION: audit agency contract reference, independence and conflict-of-interest rules]]` — audit

## Sample values to replace before going live

The owner chose to fill the company details with **sample** values so the
text reads as complete. They are written into the documents as if real, with
no marker around them. Every one of them must be replaced with the operator's
real details before going live. Search the files for each value below.

| Sample value in the text | What it stands for |
|---|---|
| Uboss AI Private Limited | The operator's registered legal name |
| 3rd Floor, Plot No. 14, Sector 44, Gurugram, Haryana 122003, India | The registered office address |
| `U62099HR2024PTC118452` (Registrar of Companies, NCT of Delhi and Haryana) | The Corporate Identity Number (CIN) and its register. This is also `SAMPLE_LEGAL_MARKER`: the software flags any published document containing it |
| `06AADCU4821K1Z3` | The GSTIN |
| `AADCU4821K` | The PAN |
| www.worldmart.com | The website address |
| support@worldmart.com, +91 124 456 7800, Monday to Saturday 9:30 to 18:30 IST | Customer support contact and hours |
| legal@worldmart.com | Address for legal notices |
| Mr Arjun Mehta, grievance@worldmart.com, +91 124 456 7801 | The Grievance Officer |
| Ms Priya Nair, privacy@worldmart.com | The privacy contact / Data Protection Officer |
| EuroRep Data Services B.V., Herengracht 420, 1017 BZ Amsterdam, eu-representative@worldmart.com | The EU representative under GDPR Art. 27 |
| ip@worldmart.com ("Legal - Content Complaints" by post) | Intellectual-property and illegal-content complaints |
| returns@worldmart.com | Returns and cancellations |
| sellers@worldmart.com | Seller support |
| logistics@worldmart.com | Logistics partner contact |
| audit@worldmart.com | Audit Console contact |
| security@worldmart.com | Security incident reports |
| DPIA-2026-03 | The reference of the staff sign-in location impact assessment |
| 12 October 2026, version 1.0 | Effective date and version. Set the real date when the operator publishes |

## Decisions taken

Settled on 12 October 2026 with standard Indian defaults, at the owner's
request. These are business choices written into the text, not legal advice.
Counsel should confirm them.

| Topic | Decision |
|---|---|
| Governing law | The laws of India |
| Disputes with business users | Courts at New Delhi have exclusive jurisdiction. First 15 days of good-faith escalation, then arbitration under the Arbitration and Conciliation Act, 1996: one arbitrator, seat and venue New Delhi, in English. Courts may still grant interim relief |
| Consumers | Keep every mandatory right. In India they may go to the Consumer Commissions (Consumer Protection Act, 2019). Consumers in the EU keep the protections and home-court rights of their country. Arbitration never applies to consumers |
| Who may buy | Age 18 or over. Both individual consumers (B2C) and verified business buyers (B2B) |
| Markets | India and the member states of the European Union. Where a product can be delivered is shown on the product page and at checkout |
| Changes to terms | At least 30 days' notice by email and on the Platform for material changes. Changes required by law or for security may apply sooner. Re-acceptance, where needed, is asked at the next sign-in |
| Language | The English version prevails, unless mandatory law lets a consumer rely on their own language |
| Liability cap | Business users only: the fees the user paid World in the 12 months before the event. No cap for fraud, wilful misconduct, death or personal injury caused by negligence, or anything the law does not allow to be limited. Consumers' statutory rights are never limited |
| Licence over uploaded content | Non-exclusive, worldwide, royalty-free, while the content is on the Platform plus a reasonable period for backups and legal records. Only to run and promote the marketplace. No training of general-purpose AI models and no third-party advertising without separate consent. The user keeps ownership |
| Seller of record | The seller named on the product page for marketplace listings; Uboss AI Private Limited for goods World sells itself. World acts as marketplace and payment facilitator |
| Payment providers | Stripe (Stripe Payments Europe Ltd / Stripe, Inc.) for cards, international payments and Stripe Connect seller payouts; Razorpay Software Private Limited in India |
| Returns and refunds | Consumers in India: 7 days from delivery for eligible products. Consumers in the EU: 14-day right of withdrawal. Business buyers: defects or shortages reported within 7 days of delivery, otherwise the order terms. Refunds within 14 days of approval, to the original payment method |
| AI provider | Google Gemini, on paid API terms under which Google does not train on the prompts. No special-category data is sent |
| Bot protection | Cloudflare Turnstile; no advertising cookies |
| Hosting | A cloud hosting provider with servers in India and the European Union |
| International transfers | EU adequacy decisions where they exist, otherwise the Standard Contractual Clauses (Decision 2021/914) with supplementary measures. Recipients: Stripe (Ireland/USA), Razorpay (India), Google (USA), Cloudflare (USA), the email delivery provider |
| Supervisory authority | The Data Protection Board of India; people in the EU may also complain to their own country's authority |
| Retention | Orders, invoices and tax records 8 years; KYC/KYB documents 5 years after the relationship ends; closed accounts' profile data deleted or anonymised within 90 days except what law requires; security logs 180 days |
| Controller roles | World is an independent controller for platform data; each seller is an independent controller for the buyer data it receives, and uses it only for that order |
| Staff | The staff terms supplement the employment or engagement contract and the IT Acceptable Use Policy; on employment matters the contract prevails |
| Staff sign-in location | Recorded at city level from the IP address, for security only |
| Driver location tracking | Switched off. At least 30 days' written notice and a separate driver notice before it is ever switched on |
| Audit agencies | Work under a written engagement agreement; no financial or family interest in an audited seller; declare any conflict first; must not audit a seller they advised in the previous 12 months |
| Carriers | Liable from collection to proof of delivery, up to the declared value, capped at INR 50,000 per shipment unless a higher value is declared and insured; must hold goods-in-transit insurance; damage claims within 7 days of delivery, loss claims within 30 days of the expected delivery date |
| Per-customer fields in the services agreements | Read "as recorded in the Buyer's verified account", "as shown in the order confirmation" or "as set out in the Seller Hub fee schedule". Signature blocks became an electronic-acceptance clause: accepting on the Platform is a signature, and World stores the name, role, date, time and IP address of the acceptance |
| Model withdrawal form | Keeps its lines; each blank reads "(insert ...)" |

Still needed, outside the text: translations into the other seven interface
languages (each must be reviewed by a person; legal text should not be
published from machine translation alone), and the separate Buyer Protection,
Inspection and Prohibited Products policies that these documents refer to.

## (d) Not legal approval

These documents were produced by automated drafting, partly from competitor
source text, and finalised on the owner's instructions. They have not been
reviewed by a lawyer. Before real customers rely on them, the operator must
replace every sample value above with its own details and have its own counsel
review the text and the decisions taken.

## (z) Seller documents supplied by the operator (2026-10-09)

Two documents were supplied by the operator as Word files. They were **not
adapted**: each file was first the Word text **word for word**, with only the
layout changed (a numbered heading or schedule title becomes a `## ` line, every
other Word paragraph becomes one paragraph). **On 12 October 2026 they were
filled in** like every other document here (approval notice removed, blanks
filled with the sample values and decisions above, terse lines written out in
full), so they are no longer word-for-word copies; their headings are
unchanged. The adapted Seller Addendum (version
`2026-10-draft-1`, rows S1-S22 in the tables above) is **superseded** as the
file in this folder; a DRAFT row already imported into a database is left as it
is and simply never published. `backend/tests/unit/seller-legal-drafts.test.ts`
pins every heading and a SHA-256 of the words, and re-reads the Word files when
they are present in `legal/source/` (gitignored).

| Source (in `legal/source/`) | SHA-256 | Draft | Kind | Version |
|---|---|---|---|---|
| `02_Seller_Terms_and_Conditions.docx` | `70375caf83c205bca663c80461367ddb68be2090c71910f7558fcfe59074a830` | `seller-terms.en.txt` (15 sections) | `SELLER_TERMS` | `1.0` |
| `04_Seller_Platform_Services_Agreement.docx` | `55db59eaefe24c58778d70878823e07c08b5b9b4627c6df302e7c22312e3dbc9` | `seller-services-agreement.en.txt` (12 sections, Schedules A-F) | `SELLER_SERVICES_AGREEMENT` | `1.0` |
| `03_B2B_Buyer_Terms_and_Conditions.docx` | `ba56768db33e3b9bf6223445b7dc508ffeedb4f298f0224736627966387c57f2` | `b2b-buyer-terms.en.txt` (14 sections) | `B2B_BUYER_TERMS` | `1.0` |
| `05_B2B_Buyer_Platform_Services_Agreement.docx` | `e60e177d0302a06c7eea0e2aac2ba894ec634d680e2b5833ea4c9c7d368904da` | `b2b-buyer-services-agreement.en.txt` (12 sections, Schedules A-C, final completion requirement) | `B2B_BUYER_SERVICES_AGREEMENT` | `1.0` |

**The two B2B documents (filled in 12 October 2026).** Both used to carry the
approval notice and blanks: effective date; Uboss AI Private Limited's
registered address, corporate and tax registration and notices email; the
arbitration seat; the buyer's details, signatory and signature; the Payment
Partner; notice addresses; and every line of Schedules A, B and C. The company
details now hold the sample values above, the seat is New Delhi, the Payment
Partner is Stripe (and Razorpay in India), and the per-buyer fields read "as
recorded in the Buyer's verified account" or "as shown in the order
confirmation". The signature blocks became an electronic-acceptance clause.

**The B2C Consumer Terms (2026-10-09, filled in 12 October 2026).**
`06_B2C_Consumer_Terms.docx` (SHA-256
`d3769c672b7e278af276f813bfcc985156a4a8cd783ce453331c2b8acc66b1f3`) was first
stored word for word as `b2c-consumer-terms.en.txt`. On 12 October 2026 the
approval notice was removed and the blanks were filled: effective date,
registered address and CIN, support, complaints, grievance officer and privacy
contacts, and market disclosures for India and the EU. The model withdrawal
notice keeps its lines; each consumer fill-in line now reads "(insert ...)",
and it is addressed to the seller named in the order confirmation or to
returns@worldmart.com. Sections and headings are unchanged.

**The B2C Platform Services Agreement (12 October 2026).** No operator text
had been supplied, so `b2c-platform-services-agreement.en.txt` was written to
the decisions above. With it, the consumer Terms and the Privacy Policy, all
three consumer documents now exist.

**What still has to happen before real use.** The publishing check no longer
finds anything to refuse in these files. Before real customers rely on them,
the operator and its counsel must:

- Replace every sample value listed above with the operator's own details.
- Review the text and the decisions taken, and change any that do not suit
  the business.
- Decide whether a seller still accepts the Terms of Use beside the Seller T&C.
  The software asks for both today under one box (`termsKindsForScope`).
- Provide approved translations, if any. Only English exists; nothing has been
  machine-translated as contract text.

import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  PageBreak,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from '../.ppt-build/node_modules/docx/dist/index.mjs';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(repoRoot, 'UBOSS_Global_Compliance_and_Risk_Report.docx');

const C = {
  navy: '17365D', blue: '2563EB', ink: '1F2937', muted: '5B6573', white: 'FFFFFF',
  line: 'C9D2DE', pale: 'F5F7FA', yes: 'E2F0D9', partial: 'FFF2CC', no: 'FCE4D6',
  conditional: 'DDEBF7', na: 'E7E6E6', critical: 'F4CCCC',
};

const sections = [
  {
    title: '1. Global launch and legal foundation',
    rows: [
      ['Legal entity, seller of record and contracting role', 'NO — owner decision', 'Before any sale, name the contracting company, registered address, seller/marketplace role, governing law, dispute forum, and who issues invoices and imports goods. Obtain local legal and tax advice for each launch country.'],
      ['Business-to-business-only boundary', 'PARTIAL', 'The product is designed as B2B, but self-registration and marketplace features can blur the boundary. Require organisation details, prevent consumer checkout unless a B2C programme is approved, and state B2B-only status in the terms and interface.'],
      ['Customer terms and conditions', 'PARTIAL', 'Policy links and consent timestamps exist, but the legal terms are deployment content. Publish reviewed terms covering ordering, delivery, title/risk, returns, warranties, liability, acceptable use, suspension, privacy and disputes; retain every version accepted.'],
      ['Privacy notices for every audience', 'PARTIAL', 'Publish notices for buyers, seller staff, administrators, prospects, logistics users and drivers. Name the controller, purposes, lawful bases, recipients, transfers, retention, rights and complaint authority. Translate for each target market.'],
      ['Returns, refunds, shipping and complaints policies', 'PARTIAL', 'The workflow supports returns/refunds, but public policies are not supplied. Publish deadlines, eligibility, costs, damaged-product handling, complaint escalation and statutory rights before accepting orders.'],
      ['Country-by-country launch register', 'NO', 'Create a controlled register for every country: entity, licences, privacy law, tax, invoicing, consumer/B2B rules, accessibility, product approvals, sanctions, language, records retention and responsible owner. Do not rely on one global policy.'],
      ['Regulatory change monitoring', 'NO', 'Assign an owner and quarterly review process for privacy, marketplace, AI, cyber, tax and medical-device rules; record decisions and product changes.'],
      ['Legal records and evidence pack', 'PARTIAL', 'Technical audit evidence exists. Add signed contracts, DPAs, SCCs, licences, policies, DPIAs, training, complaints, breach decisions, accessibility tests, PCI attestations and product certificates with retention rules.'],
      ['Insurance', 'NO', 'Arrange appropriate cyber, technology errors and omissions, product liability, recall, cargo and directors/officers insurance. Confirm territorial coverage and medical-device exclusions.'],
      ['Local representation and agents', 'NO', 'Where required, appoint an EU GDPR representative, EU/UK medical-device responsible person, importer, tax representative, local privacy contact or similar agent. Publish their details.'],
      ['Contracts with customers and deployment operators', 'PARTIAL', 'Define whether UBOSS is licensed software, hosted SaaS or both. Allocate controller/processor duties, security, support, uptime, backups, incident notice, audit, export/deletion, updates, indemnity and termination assistance.'],
      ['Contract and policy version retention', 'PARTIAL', 'Consent versions are stored for several flows, but policy files and all historic versions are external. Keep immutable copies and link each acceptance to the exact text and language shown.'],
    ],
  },
  {
    title: '2. Privacy and personal-data compliance',
    rows: [
      ['EU/EEA GDPR — core principles and accountability', 'PARTIAL', 'Strong technical controls exist, but compliance needs controller identity, notices, lawful-basis decisions, ROPA, processor contracts, transfer controls, training and periodic audits.'],
      ['GDPR data-subject access and portability', 'YES — technical', 'Authenticated export requests, expiring downloads and an admin queue exist. Test the full response, identity checks, exclusions and one-month deadline in production; keep request evidence.'],
      ['GDPR rectification', 'YES — technical', 'Customers can edit profile/contact data with confirmation controls. Document exceptions for invoices and regulated records and provide a support route for locked fields.'],
      ['GDPR erasure and account closure', 'PARTIAL', 'Erasure/anonymisation and blockers exist. Obtain legal approval for what must remain for tax, product traceability, disputes and fraud; test backups and downstream processors.'],
      ['Storage limitation and retention schedule', 'PARTIAL', 'Automated retention sweeps and configurable periods exist. Approve a jurisdiction-specific schedule for each data class, include backups and legal holds, and verify deletion reports.'],
      ['GDPR records of processing activities (ROPA)', 'PARTIAL', 'A useful skeleton exists in DATA-PROTECTION.md. Complete it with real vendors, countries, purposes, lawful bases, retention, security, controller/processor roles and owners.'],
      ['GDPR lawful-basis and legitimate-interest assessments', 'NO — legal work', 'Document a lawful basis for each purpose. Complete LIAs for security logs, prospect enquiries and location features; never use consent where refusal is not genuinely possible.'],
      ['GDPR DPIA', 'NO', 'Complete DPIAs before enabling driver GPS, employee/admin geolocation, large-scale monitoring or materially expanded AI. Consult the authority if high residual risk remains.'],
      ['GDPR DPO assessment', 'NO', 'Document whether a DPO is legally required. If not, still appoint a privacy owner with independence, resources and published contact details.'],
      ['GDPR Article 27 EU representative', 'NO / CONDITIONAL', 'If the controller is outside the EU and offers goods/services to EU individuals without an establishment exception, appoint and publish an EU representative before launch.'],
      ['GDPR processor agreements and subprocessor register', 'NO — deployment work', 'Sign Article 28-compliant DPAs with hosting, storage, email, AI, map, monitoring, support and other processors. Maintain a reviewed subprocessor list and change process.'],
      ['International data transfers', 'NO — high priority', 'Map remote access and vendor transfers. For EU/UK data, execute the correct SCCs/UK addendum or IDTA, perform transfer impact assessments, and apply supplementary access/encryption controls.'],
      ['Personal-data breach response', 'PARTIAL', 'Technical and legal runbooks exist. Name the 24/7 decision-makers, processor notification SLAs, jurisdiction clocks, evidence log and customer communications; run a tabletop exercise.'],
      ['Special-category and health-related data', 'NO — assessment needed', 'Medical-product purchases are not automatically health data, but free text, delivery notes and AI prompts may reveal health information. Minimise fields, warn users, restrict access and decide Article 9/other health-law bases.'],
      ['Employee and driver monitoring', 'PARTIAL', 'Precise admin geolocation now defaults off. Keep it off unless proportionate and lawful. Driver tracking needs duty-window enforcement, notice, consultation where required, DPIA, short retention and role-limited access.'],
      ['Privacy by default — admin sign-in location', 'YES — fixed in this review', 'FEATURE_ADMIN_LOGIN_LOCATION now defaults to false in code and the example environment. Any deployment opting in must document necessity and complete privacy/employment-law review.'],
      ['Cookies and local storage / ePrivacy', 'YES — current build', 'Only necessary auth/CSRF cookies and preferences are documented. Maintain a cookie inventory. Add a consent platform before analytics, advertising pixels or non-essential tracking are introduced.'],
      ['Direct marketing consent and unsubscribe', 'CONDITIONAL', 'No marketing system was found. If email/SMS marketing is added, implement jurisdiction-specific opt-in/soft-opt-in rules, sender identification, suppression lists, easy unsubscribe and consent evidence.'],
      ['Children and age assurance — COPPA and similar laws', 'NO / CONDITIONAL', 'The service is B2B but has no clear age gate. State that accounts are for authorised adults/business users, prevent child-directed marketing, and perform COPPA/child-code review before any consumer or school use.'],
      ['Data minimisation in free-text fields and AI prompts', 'PARTIAL', 'Add just-in-time warnings not to enter patient/card/sensitive data, field limits, role-based review and redaction rules. Consider automatic detection only after its own privacy assessment.'],
      ['Privacy request coverage across vendors and backups', 'PARTIAL', 'The application covers its database well. Add documented workflows for email, storage, AI providers, support systems, logs and backups; record lawful retention exceptions.'],
      ['Data localisation and government-access requirements', 'NO — country decision', 'Assess localisation, cross-border and regulator-access rules before China, Russia, India regulated sectors, Saudi Arabia, UAE and other restricted deployments. Choose regions and support access accordingly.'],
    ],
  },
  {
    title: '3. Security, resilience and software-supply-chain compliance',
    rows: [
      ['Secure authentication and password storage', 'YES — technical', 'Argon2id, 12-character minimums, generic login failures, lockout and secure token handling exist. Add production policy review, account recovery testing and periodic access recertification.'],
      ['Multi-factor authentication', 'PARTIAL', 'TOTP and recovery-code protections exist for privileged/logistics flows. Require MFA for every administrator and production/support account; prefer phishing-resistant MFA for infrastructure.'],
      ['Role-based access control and tenant isolation', 'YES — technical', 'Permissions, audience-separated sessions and carrier scoping exist. Run quarterly access reviews, separation-of-duties checks and tenant-isolation penetration tests.'],
      ['Session, cookie and CSRF security', 'YES — technical', 'HTTP-only secure production cookies, SameSite controls, refresh rotation and double-submit CSRF exist. Validate production domains, expiry, logout/revocation and proxy trust.'],
      ['Transport security and browser security headers', 'YES — configuration-dependent', 'Helmet and nginx headers/TLS configuration exist. Validate the live deployment with TLS/header scanners, certificate-renewal alerts and HSTS only after all subdomains support HTTPS.'],
      ['Encryption at rest', 'PARTIAL', 'Application secrets are AES-256-GCM encrypted, but database/disk encryption depends on infrastructure. Require encrypted volumes, encrypted object storage and encrypted backups with separate key management.'],
      ['Secrets management and rotation', 'PARTIAL', 'Secrets are excluded from git and production placeholders are rejected. Use a secrets manager, unique environment keys, documented rotation, emergency revocation and least-privilege cloud credentials.'],
      ['Security logging and audit integrity', 'PARTIAL', 'Structured logs, redaction, correlation IDs and append-only database permissions are strong. Add central immutable log storage, time synchronisation, alerting, review cadence and privacy-safe retention.'],
      ['Vulnerability management', 'PARTIAL', 'Dependabot and npm audit are configured; live audit found zero known package advisories on 16 Sep 2026. Define severity SLAs, ownership, exception expiry and evidence of patch deployment.'],
      ['Static application security testing', 'PARTIAL', 'CodeQL exists but is disabled until a repository variable/licence enables it. Enable SAST or use an equivalent tool and make high-confidence serious findings blocking.'],
      ['Dynamic testing and penetration test', 'NO', 'Commission independent web/API/tenant/payment/marketplace testing before global sale and after material changes; track remediation and retest.'],
      ['OWASP API and web threat review', 'PARTIAL', 'Many controls exist, including validation, CORS, CSRF, rate limiting, SSRF controls and output sanitisation. Complete a documented OWASP ASVS/API Top 10 threat model and verification.'],
      ['Dependency and component inventory / SBOM', 'YES — pipeline', 'CI creates CycloneDX SBOMs for all four projects. Retain SBOMs per release, sign them, make them available to customers and connect them to vulnerability response.'],
      ['Open-source licence compliance', 'NO — high priority for sale', 'No licence/notice file or automated licence allowlist review was found. Inventory all dependencies and bundled data/assets, resolve copyleft/notice obligations, and ship product and third-party notices.'],
      ['Repository licence and ownership', 'NO', 'Add the commercial/proprietary licence, copyright ownership, contributor/IP assignment process and permitted customer use. Confirm rights to images, catalogue data, fonts and documentation.'],
      ['Secret scanning', 'YES — pipeline', 'Full-history gitleaks scanning is configured. Keep findings blocking, rotate any exposed credential rather than merely deleting it, and review allowlist exceptions.'],
      ['Secure build and CI integrity', 'PARTIAL', 'Locked installs, tests, audit and SBOM exist. Pin third-party CI actions to immutable commit SHAs, protect branches/environments, use short-lived credentials and sign release artifacts.'],
      ['Software vulnerability disclosure policy', 'NO', 'Add SECURITY.md with supported versions, private reporting contact, encryption option, acknowledgement and remediation timelines; establish intake and coordinated disclosure.'],
      ['Security update and support period', 'NO', 'Publish supported versions, end-of-support dates, security-patch SLA and customer update instructions. This is important for procurement and the EU Cyber Resilience Act.'],
      ['EU Cyber Resilience Act (CRA)', 'NO / PREPARATION REQUIRED', 'For commercial software placed on the EU market, confirm role/scope; build the technical file, conformity process, secure-development evidence, SBOM, support period and vulnerability reporting. Reporting duties apply from 11 Sep 2026 and main rules from 11 Dec 2027.'],
      ['NIS2 and local cyber laws', 'CONDITIONAL', 'Assess size, establishment and online-marketplace/health-sector scope in each EU state. If in scope, register, implement governance/ISMS, supply-chain controls and statutory incident reporting.'],
      ['ISO/IEC 27001 certification', 'NO — voluntary', 'Not legally universal, but global enterprise buyers commonly expect it. Implement an ISMS, risk register, control evidence, internal audit and certification if commercially needed.'],
      ['SOC 2 Type II', 'NO — voluntary', 'Not a law. Consider it for hosted/SaaS enterprise sales after controls operate long enough to produce evidence. Do not claim certification without an auditor report.'],
      ['Backups and restore assurance', 'PARTIAL', 'Backup/binlog scripts and runbooks exist, but live off-site configuration and restore evidence are deployment decisions. Encrypt, isolate, monitor and regularly restore-test with stated RPO/RTO.'],
      ['High availability and disaster recovery', 'NO / DEPLOYMENT-DEPENDENT', 'The documented single-VPS design has multiple single points of failure. Choose an honest SLO; add redundant app/database/network/DNS components where business commitments require them.'],
      ['Monitoring, alerting and 24/7 incident ownership', 'PARTIAL', 'Metrics and monitor services exist. Configure an external alert destination, on-call rota, escalation tree and payment/webhook/queue/SLA alerts; test them.'],
      ['Rate limiting at scale', 'PARTIAL', 'Application limits are per process and documented. Add a shared or edge limiter for multi-instance deployments, protect expensive AI/search routes and verify proxy-derived client identity.'],
      ['File-upload malware protection', 'NO', 'Magic-byte/type/size checks exist, but no malware scanner is implemented. Keep unscanned-document flags off; add quarantine, asynchronous scanning, safe preview/download and incident handling.'],
      ['Business continuity and exit/portability', 'PARTIAL', 'Data export exists for individuals, not a complete customer-tenant exit. Define full business export, escrow/backup return, deletion certificate, transition assistance and vendor exit plans.'],
    ],
  },
  {
    title: '4. Payments, tax, marketplace and commercial rules',
    rows: [
      ['PCI DSS 4.0.1', 'PARTIAL', 'Card data is outsourced and not stored, which reduces scope but does not remove it. Ask the acquirer/QSA to confirm SAQ A versus A-EP, complete annual validation, maintain script inventory and payment-page tamper controls.'],
      ['PSD2 / strong customer authentication', 'PARTIAL / PROVIDER-DEPENDENT', 'Stripe flows and off-session consent evidence are strong. Confirm EEA acquiring, exemptions, failed-authentication recovery, mandate wording and dispute evidence with the PSP/acquirer.'],
      ['Razorpay and India payment compliance', 'PARTIAL / PROVIDER-DEPENDENT', 'Use regulated provider contracts and production keys, reconcile webhooks/refunds and confirm RBI/payment-aggregator, tokenisation, recurring mandate and cross-border rules with the acquirer.'],
      ['Payment webhook integrity and idempotency', 'YES — technical', 'Raw-body signature verification and idempotent processing exist. Monitor failures/dead letters, rotate webhook secrets and reconcile daily against provider settlement reports.'],
      ['Stored payment methods and off-session consent', 'YES — technical', 'Consent version/time/scope and provider tokens are stored without card data. Have counsel approve wording and implement re-consent when material terms change.'],
      ['Refunds, chargebacks and payment disputes', 'PARTIAL', 'Refund workflows exist. Add operational SLAs, evidence packs, customer notices, fraud review and accounting reconciliation; test partial/multi-seller cases.'],
      ['Global VAT, GST and sales-tax nexus', 'NO — country work', 'A tax engine cannot decide registration obligations. Obtain tax advice for seller location, warehouses, imports, marketplace-deemed-supplier rules and thresholds in every jurisdiction; configure rates and evidence.'],
      ['EU VAT and VIES', 'PARTIAL', 'Tax precision and VIES validation exist. Decide registrations, reverse charge, place of supply, import VAT, evidence, bad-VIES handling and invoice retention with an EU tax adviser.'],
      ['India GST and e-invoicing', 'NO — deployment/legal work', 'Determine GST registrations, place of supply, HSN, tax invoice/credit note fields, e-invoice/IRN and e-way bill duties based on the selling entity and turnover. Build integrations only after applicability is confirmed.'],
      ['Poland KSeF', 'CONDITIONAL / NOT IMPLEMENTED', 'Determine whether the selling entity has a Polish seat or participating fixed establishment. If in scope, implement authentication, structured invoices, outage mode, correction and archive evidence.'],
      ['US state sales tax and marketplace facilitator laws', 'NO / CONDITIONAL', 'Assess economic/physical nexus and marketplace-facilitator duties state by state. Register, collect and report only where required; retain exemption/resale certificates for B2B sales.'],
      ['UK VAT and digital platform reporting', 'NO / CONDITIONAL', 'Determine UK establishment/import/marketplace roles, VAT registration and digital-platform seller reporting. Collect verified seller tax data if the reporting regime applies.'],
      ['Invoices, credit notes and record retention', 'PARTIAL', 'Invoice sequences and immutable correction principles exist. Validate legally required fields, numbering, languages, currencies, electronic format, storage location and retention for each country.'],
      ['Foreign exchange and displayed-price accuracy', 'PARTIAL', 'The system stores market prices and avoids floating-point money. Approve rate sources for non-product calculations, disclosure/rounding rules and stale-rate handling.'],
      ['EU Digital Services Act — marketplace status', 'PARTIAL', 'Seller onboarding and traceability controls exist, but confirm whether UBOSS is an online marketplace/intermediary and which micro/small exemptions apply. Document the determination.'],
      ['DSA notice-and-action and illegal-product handling', 'NO', 'Add an accessible notice channel, reasoned decisions, trusted-flagger handling where applicable, seller/user notification, appeal, evidence retention and regulator contact.'],
      ['DSA statements of reasons and complaint handling', 'NO', 'Provide legally complete reasons for listing/account restrictions, an internal appeal process, reversal handling and transparency records; do not rely only on free-text admin rejection.'],
      ['DSA marketplace seller traceability', 'PARTIAL', 'Seller identity/document collection exists. Verify required name, address, phone/email, ID/register and payment-account data before trading; display responsible seller details and periodically re-check them.'],
      ['EU Platform-to-Business Regulation', 'NO / CONDITIONAL', 'If the seller hub is an intermediation service, publish ranking factors, differentiated treatment, data access, 15-day term-change notice, complaint handling and mediators.'],
      ['DAC7 / platform seller tax reporting', 'NO / CONDITIONAL', 'Determine whether goods sales are reportable through the platform. If so, collect/verify TIN, VAT, address and consideration data, perform due diligence and file annual reports.'],
      ['Consumer rights and distance selling', 'N/A ONLY WHILE STRICTLY B2B', 'If any consumer may buy, implement pre-contract information, clear pay obligation, statutory withdrawal/cancellation, delivery/refund deadlines, guarantees, complaint/ADR information and local-language terms.'],
      ['Price reductions and reference-price rules', 'NO / CONDITIONAL', 'Strike-through prices exist without a 30-day price-history control. Disable promotional comparison claims in consumer markets until the lawful prior price can be computed and evidenced.'],
      ['Geo-blocking and territorial restrictions', 'NO — assessment needed', 'Country/currency availability is configurable. Review each restriction for lawful product, sanctions, delivery or licensing reasons and avoid unjustified nationality/residence discrimination.'],
      ['Automatic renewal / recurring orders', 'PARTIAL', 'Versioned consent and cancellation exist. Review clear renewal terms, reminders, easy cancellation, price-change notice and state/country auto-renewal laws before B2C use.'],
      ['Anti-money-laundering and seller payout KYC', 'PARTIAL / CONDITIONAL', 'Seller documents exist but no payout provider is wired. Before moving seller funds, choose a regulated marketplace-payments provider and implement required KYC/KYB, sanctions and suspicious-activity processes.'],
      ['Sanctions, export controls and denied-party screening', 'NO — high priority', 'Screen customers, sellers, carriers, beneficial owners, destinations and controlled products against applicable UN/EU/UK/US/India lists; block prohibited countries/end use and retain decisions.'],
      ['Anti-bribery, corruption and fraud controls', 'NO — organisational', 'Adopt anti-bribery and gifts policies, third-party due diligence, approval thresholds, whistleblowing/reporting and investigation procedures; train staff and sellers.'],
      ['Modern slavery and supply-chain due diligence', 'NO / CONDITIONAL', 'Assess turnover and market-specific reporting laws. Add supplier code, forced-labour screening, contractual audit rights, grievance route and public statement where required.'],
    ],
  },
  {
    title: '5. Product safety, medical devices and logistics',
    rows: [
      ['EU General Product Safety Regulation (GPSR)', 'PARTIAL', 'Product/responsible-person/warning fields exist. Enforce complete listing data, authority/consumer contact points, Safety Gate registration, incident handling, recalls and post-sale customer notification.'],
      ['GPSR online marketplace duties', 'NO / PARTIAL', 'Add Safety Gate Portal registration, authority orders workflow, dangerous-product notice/removal, random checks, recall notices and cooperation metrics. Confirm overlap/exclusions for regulated medical devices.'],
      ['EU Medical Devices Regulation (MDR)', 'PARTIAL — not compliance', 'The catalogue captures useful MDR fields, but software fields do not prove legal conformity. Determine manufacturer/importer/distributor role; verify CE, notified body, UDI, registration, IFU/language, storage, vigilance and QMS duties.'],
      ['EU In Vitro Diagnostic Regulation (IVDR)', 'NO / CONDITIONAL', 'The project expressly does not model IVDR. Block IVD listings until classification, economic-operator duties, UDI/EUDAMED, conformity and post-market requirements are implemented and reviewed.'],
      ['EU authorised representative / responsible person', 'NO — product-by-product', 'For non-EU manufacturers, verify and display the correct authorised representative/responsible person before publication; validate mandate and contact details.'],
      ['UDI, lot, serial and expiry traceability', 'PARTIAL', 'UDI fields exist, but confirm packaging-level UDI, lot/serial/expiry capture through receipt, sale, shipment, return and recall. Retain regulated records for the required period.'],
      ['Medical-device storage and transport conditions', 'PARTIAL / NOT PROVEN', 'Define temperature/humidity/handling requirements per product, capture conditions and excursions, qualify warehouses/carriers and preserve chain-of-custody evidence.'],
      ['Medical-device complaints, vigilance and field safety action', 'NO', 'Implement complaint intake, serious-incident escalation, manufacturer/regulator notification, trend reporting, field safety corrective action and documented closure.'],
      ['Product recall and customer traceability', 'PARTIAL', 'Order/lot capabilities provide a base, but no complete recall workflow is evidenced. Add affected-batch search, stop-sale/quarantine, authority notices, customer outreach, returns and effectiveness checks.'],
      ['UK medical-device regulation and MHRA', 'NO / CONDITIONAL', 'Before Great Britain sales, verify UK responsible person, MHRA registration, UKCA/accepted CE transition, labelling and vigilance. Treat Northern Ireland separately under its applicable EU/UK rules.'],
      ['US FDA medical-device distribution', 'NO / CONDITIONAL', 'Before US sale, determine establishment/initial importer/distributor duties, device listing/registration, UDI/GUDID, complaint/MDR reporting, recalls, state licences and prescription-device controls.'],
      ['Canada medical-device licensing', 'NO / CONDITIONAL', 'Before Canadian sale, verify Medical Device Licence/MDEL duties, bilingual labels, complaint/recall reporting and importer/distributor records.'],
      ['Australia TGA medical-device rules', 'NO / CONDITIONAL', 'Before Australian sale, appoint/identify sponsor, verify ARTG inclusion, labels/advertising, vigilance, recalls and distribution records.'],
      ['India CDSCO medical-device rules', 'NO / CONDITIONAL', 'Before India sale/import, verify device classification, manufacturer/import licences, Indian authorised agent, labels, storage, vigilance and recall obligations.'],
      ['Other national medical-device approvals', 'NO — country gate', 'For every destination, verify local registration, authorised representative/importer, language/label, advertising, storage, complaint and recall rules before making the product orderable.'],
      ['Chemical/environmental product rules — REACH/RoHS/WEEE/batteries/packaging', 'NO / CONDITIONAL', 'Classify every product and package. Collect declarations and producer-registration numbers where applicable; implement eco-fees, take-back and reporting. Do not assume medical-device status displaces all environmental duties.'],
      ['Product claims and advertising substantiation', 'PARTIAL', 'Admin review exists, but establish a claims-approval process. Prohibit unsupported clinical/performance claims, misleading comparisons and AI-generated medical advice; retain supporting evidence.'],
      ['Product content and IFU language', 'PARTIAL', 'Eight interface languages exist and warning gaps are reported. Require legally mandated label/IFU/safety languages per destination and human review of safety-critical translations.'],
      ['Counterfeit and supplier authenticity controls', 'NO / PARTIAL', 'Add authorised-supplier checks, certificate validation, serial/UDI verification, tamper/complaint monitoring and quarantine rules. Marketplace seller approval alone is insufficient.'],
      ['Logistics partner contracts and responsibility', 'NO — organisational', 'Contract service levels, product handling, privacy/controller roles, subcontractors, insurance, loss/damage, security, incident notice and audit rights with every carrier.'],
      ['Proof-of-delivery documents and signatures', 'PARTIAL', 'Signed expiring document links and access controls exist. Set lawful purpose, notice, retention, evidential requirements, signer authority and safe file handling.'],
      ['Driver GPS consent and lawful basis', 'PARTIAL / DO NOT ENABLE GLOBALLY', 'Technical consent and active-duty limits exist. Employment consent may be invalid in many countries; use a locally approved lawful basis, DPIA, worker consultation, notice and strict retention before activation.'],
    ],
  },
  {
    title: '6. Accessibility, language and artificial intelligence',
    rows: [
      ['WCAG 2.2 AA', 'PARTIAL', 'Automated axe/contrast/lint coverage is strong, but it cannot establish conformance. Perform manual keyboard, focus, screen-reader, zoom/reflow, error recovery and mobile testing; remediate and retest.'],
      ['European Accessibility Act', 'PARTIAL', 'E-commerce is in scope unless a valid exemption applies. Publish an accessibility statement, retain assessment evidence, create feedback/enforcement routes and train support/content staff.'],
      ['UK Equality Act and accessibility duties', 'PARTIAL / CONDITIONAL', 'Treat WCAG 2.2 AA as the baseline, provide reasonable adjustments and accessible support. Obtain UK advice for the service and target customers.'],
      ['US ADA and state accessibility exposure', 'PARTIAL / CONDITIONAL', 'No single automated test prevents claims. Test the complete buying journey with assistive technology, publish contact/remediation information and monitor US case-law/contract requirements.'],
      ['Canada AODA and provincial accessibility rules', 'PARTIAL / CONDITIONAL', 'Assess province and organisation thresholds; provide accessible web content, policies, training and feedback process where applicable.'],
      ['Accessible documents and product PDFs', 'NO / NOT VERIFIED', 'Audit uploaded IFUs, invoices, reports and policy PDFs for tags, reading order, text alternatives, language and keyboard access; offer accessible alternatives.'],
      ['Language and legally required translations', 'PARTIAL', 'Eight UI languages are present, but machine translation is not legal proof. Use qualified human review for contracts, privacy notices, safety warnings, IFUs and regulator communications.'],
      ['EU AI Act chatbot transparency', 'YES — technical', 'The assistant identifies itself and its vendor in two places. Verify all languages and every AI entry point; keep evidence because Article 50 applies from 2 Aug 2026.'],
      ['EU AI Act AI literacy', 'NO — organisational', 'Train staff who configure, supervise, support or rely on AI about limitations, hallucination, privacy, security, human review and prohibited use; retain attendance/content records.'],
      ['AI risk classification and governance', 'PARTIAL', 'Current assistant appears limited-risk catalogue help, but document the classification, intended use, prohibited uses, provider/model versions, human oversight and re-assessment triggers.'],
      ['AI privacy and vendor controls', 'PARTIAL', 'The application limits account/order data, but users can type anything. Sign vendor terms/DPA, choose no-training/retention settings, disclose transfers and prevent sensitive input where feasible.'],
      ['AI prompt injection and data exfiltration testing', 'NO', 'Run adversarial tests against catalogue, image search and tools. Enforce strict tool/data boundaries, output validation, rate/cost controls and incident logging.'],
      ['AI medical-advice safety', 'PARTIAL', 'System prompts refuse clinical advice, but prompts are not a safety guarantee. Add visible non-clinical scope, escalation, evaluation set, monitoring and human review for safety complaints.'],
      ['Automated decision-making / profiling', 'N/A — current stated use', 'Do not use AI for credit, employment, seller approval, pricing discrimination or access decisions without new privacy/AI classification, explanation, human review and appeal controls.'],
    ],
  },
  {
    title: '7. Major regional privacy frameworks',
    rows: [
      ['India DPDP Act 2023 and Rules 2025', 'PARTIAL', 'Technical rights/security controls help, but prepare compliant notice/consent, grievance contact, processor terms, breach notices, child rules and phased-rule deadlines; assess Significant Data Fiduciary status.'],
      ['India IT Act / SPDI and CERT-In directions', 'PARTIAL / CONDITIONAL', 'Confirm overlap and transition, security practices, contractual notices/consents, incident reporting and required log retention/time synchronisation with Indian counsel.'],
      ['California CCPA/CPRA', 'PARTIAL / CONDITIONAL', 'Assess statutory thresholds and B2B/employee coverage. If in scope, provide notice at collection, rights workflow, opt-out/share controls, contracts, preference-signal support and 2026 risk/audit duties where triggered.'],
      ['Other US state comprehensive privacy laws', 'NO / CONDITIONAL', 'Maintain a state applicability matrix and common rights workflow for access, correction, deletion, portability, opt-out, sensitive-data consent, appeals and universal signals, with state-specific variations.'],
      ['US FTC Act privacy and security', 'PARTIAL', 'Make only accurate privacy/security claims, maintain reasonable security, honour deletion/consent promises and review dark patterns, endorsements, subscriptions and health-related data risks.'],
      ['US HIPAA', 'N/A UNLESS ROLE CHANGES', 'Selling medical supplies is not automatically HIPAA. If handling PHI for a covered entity/business associate, execute BAAs and add HIPAA privacy/security/breach safeguards before processing.'],
      ['US COPPA', 'N/A IF ADULT B2B ONLY', 'Maintain adult/business-only positioning. If directed to or knowingly collecting from under-13 users, implement parental notice/consent, minimisation, retention and deletion before launch.'],
      ['Canada PIPEDA and provincial privacy laws', 'PARTIAL / CONDITIONAL', 'Appoint a privacy official, publish purposes, obtain meaningful consent where needed, limit collection/retention, safeguard data, handle access/challenges and assess provincial laws and breach reporting.'],
      ['Brazil LGPD', 'PARTIAL / CONDITIONAL', 'Name controller/operator and DPO/contact as required, document legal bases, provide Portuguese notice/rights, processor and transfer measures, security/incident process and ANPD requirements.'],
      ['UK GDPR and Data Protection Act 2018', 'PARTIAL / CONDITIONAL', 'Replicate the GDPR programme with UK-specific representative, ICO fee/registration assessment, UK transfer mechanism, notices, DPIAs and breach process.'],
      ['UK PECR', 'YES ONLY FOR CURRENT NECESSARY STORAGE', 'Current necessary cookies are low risk. Obtain consent before non-essential cookies and comply with electronic-marketing rules, corporate-subscriber distinctions and suppression obligations.'],
      ['Australia Privacy Act and APPs', 'PARTIAL / CONDITIONAL', 'Assess turnover/exceptions and reforms; provide APP privacy policy, collection notices, access/correction, overseas-disclosure controls, security/destruction and notifiable-breach procedure.'],
      ['New Zealand Privacy Act 2020', 'PARTIAL / CONDITIONAL', 'Appoint a privacy officer, provide notices and rights, assess overseas disclosures, security/retention and notify serious privacy breaches.'],
      ['Japan APPI', 'PARTIAL / CONDITIONAL', 'Provide purpose notice, security and processor supervision, rights handling, breach response and consent/information for foreign transfers; keep transfer records.'],
      ['Singapore PDPA', 'PARTIAL / CONDITIONAL', 'Appoint and publish a DPO, implement notification/consent/purpose limits, access/correction, retention/security, transfer safeguards and breach assessment/notification.'],
      ['South Korea PIPA', 'NO / CONDITIONAL', 'Obtain specialist review before launch; implement detailed consent/notices, overseas-transfer disclosures, minimisation, security, rights, retention/destruction and local representative where required.'],
      ['South Africa POPIA', 'PARTIAL / CONDITIONAL', 'Register/appoint the Information Officer as required, document lawful processing, notices, operator contracts, security, rights, breach process and cross-border basis.'],
      ['China PIPL, CSL and DSL', 'NO / CONDITIONAL', 'Do not launch from a generic global deployment. Complete data classification, localisation/CAC transfer assessment, separate consent, local representative, contracts, security and regulator requirements.'],
      ['UAE federal PDPL and free-zone laws', 'PARTIAL / CONDITIONAL', 'Identify whether federal, DIFC or ADGM law applies; implement notices/bases, DPO assessment, rights, processor contracts, transfers, security and breach process.'],
      ['Saudi Arabia PDPL', 'PARTIAL / CONDITIONAL', 'Assess registration/DPO and localisation/transfer rules, Arabic notices, rights, processor contracts, records, security and breach notification before offering service.'],
      ['Other national privacy laws', 'NO — country gate', 'Use the global controls as a baseline but obtain local review before each country. Do not claim worldwide compliance from GDPR alignment alone.'],
    ],
  },
  {
    title: '8. Project and operational risks',
    rows: [
      ['RISK — Unclear marketplace versus merchant model', 'HIGH / OPEN', 'Decide whether UBOSS, each seller, or both contract with the buyer. This decision controls tax, invoicing, payouts, DSA, product liability, returns and data roles.'],
      ['RISK — Medical-device economic-operator role unknown', 'CRITICAL / OPEN', 'Before EU/UK/global product sales, identify manufacturer, importer, distributor, authorised representative and fulfilment roles for every supply route; block products lacking verified documentation.'],
      ['RISK — No global country launch gate', 'CRITICAL / OPEN', 'Implement a hard operational checklist so a country/currency cannot be activated until legal, tax, privacy, payments, product, accessibility, logistics and support approvals are recorded.'],
      ['RISK — Seller payouts are not connected', 'HIGH / OPEN', 'Do not promise or accrue payable marketplace settlements without a compliant payout provider, KYC/KYB, safeguarding/flow-of-funds analysis, reconciliation and failure recovery.'],
      ['RISK — DSA notice/appeal machinery missing', 'HIGH / OPEN', 'Build and staff the required reporting, reasoned-decision, appeal and illegal-product workflows before opening third-party listings to EU users.'],
      ['RISK — Cross-border data transfers undocumented', 'HIGH / OPEN', 'Complete vendor/remote-access map, SCCs or local mechanisms, TIAs and access restrictions before non-local staff or vendors access production personal data.'],
      ['RISK — No independent penetration test', 'HIGH / OPEN', 'Test authentication, tenant boundaries, seller/carrier isolation, payments, webhooks, uploads, SSRF, AI and admin functions before sale; remediate and retest.'],
      ['RISK — Malware scanning absent', 'HIGH / OPEN', 'Quarantine seller/logistics documents until scanning succeeds. Keep unscanned uploads disabled and protect reviewers from active content.'],
      ['RISK — Open-source licence and IP review absent', 'HIGH / OPEN', 'Complete software/assets/data licence review and ship notices before distributing or selling the software; resolve any incompatible dependency or asset.'],
      ['RISK — Single-server availability', 'HIGH / DEPLOYMENT', 'A single VPS cannot meet high availability. Align contracts to achievable SLO/RTO/RPO or deploy redundancy and tested failover.'],
      ['RISK — Backup exists on paper but live proof may not', 'HIGH / DEPLOYMENT', 'Require monitored off-site encrypted backups, binlog shipping where needed, quarterly restore tests and signed evidence.'],
      ['RISK — Uploaded safety documents may be inaccessible', 'MEDIUM / OPEN', 'Require accessible, current, language-correct IFUs/certificates and reject expired or unreadable documents; retain review evidence.'],
      ['RISK — Safety-critical translations may be machine-generated', 'HIGH / OPEN', 'Use qualified human review for warnings, IFUs, recalls and terms. Track source, reviewer, language and version.'],
      ['RISK — AI hallucination or unsafe clinical guidance', 'HIGH / OPEN', 'Keep AI limited to catalogue assistance, test refusals, display limitations, monitor reports and route medical questions to qualified humans.'],
      ['RISK — AI prompt leakage and uncontrolled vendor retention', 'HIGH / OPEN', 'Red-team prompts, minimise context, use enterprise no-training settings, disclose vendor/region, set retention and block secrets/patient data.'],
      ['RISK — Accessibility assurance relies on automation', 'HIGH / OPEN', 'Run manual assistive-technology testing and publish an honest accessibility statement; automated passes alone are not conformance.'],
      ['RISK — SAST configured but disabled', 'MEDIUM / OPEN', 'Enable CodeQL or another SAST service and make results owned, triaged and release-blocking at an agreed severity.'],
      ['RISK — Large frontend bundles', 'MEDIUM', 'Builds pass but warn about chunks above 500 kB. Measure low-end/mobile performance, split heavy map/3D/language code and set performance budgets.'],
      ['RISK — No load or capacity test', 'HIGH / OPEN', 'Run production-like load tests for browse, checkout, webhooks, exports, ERP and location pings; set capacity limits and scaling triggers from p95/p99 results.'],
      ['RISK — No complete on-call ownership', 'HIGH / OPEN', 'Name 24/7 S1 responders, backup contacts and legal/privacy decision-makers; rehearse payment outage, breach, recall and failed deployment scenarios.'],
      ['RISK — Production configuration can change compliance', 'HIGH / CONTINUOUS', 'Use deployment policy-as-code/checklists for cookies, AI vendors, regions, location, storage, email, maps, TLS, keys and feature flags; review every change.'],
      ['RISK — Privacy/legal policies can be absent from storefront', 'HIGH / OPEN', 'Make required policy links and support contact mandatory production startup/readiness checks rather than optional business-profile content.'],
      ['RISK — Price-comparison claims lack price history', 'MEDIUM / CONDITIONAL', 'Disable compare-at/discount claims in consumer markets until compliant historical reference pricing is stored and auditable.'],
      ['RISK — Taxes and invoicing may be technically correct but legally wrong', 'HIGH / OPEN', 'Treat configured rates as inputs, not legal conclusions. Require country-specific tax sign-off, regression cases and invoice review before each market.'],
      ['RISK — Driver/employee location could create labour-law exposure', 'HIGH / CONTROLLED', 'The admin default was fixed to off. Apply the same conservative launch decision to driver tracking until local consultation, lawful basis and DPIA are complete.'],
      ['RISK — Consumer access could silently expand obligations', 'HIGH / OPEN', 'Keep B2C disabled until consumer terms, withdrawal, pricing, accessibility, product, tax and complaint controls are implemented and approved.'],
      ['RISK — Third-party service outage and lock-in', 'MEDIUM / OPEN', 'Define fallbacks for email, object storage, AI, payments, maps, exchange rates and ERP; monitor SLAs, export configuration and rehearse provider replacement.'],
      ['RISK — Production data used for support/testing', 'HIGH / OPEN', 'Use sanitised staging data, just-in-time production access, named accounts, audit logs and approval. Ban unmanaged local copies and define secure deletion.'],
      ['RISK — Regulatory claims in sales material', 'HIGH / OPEN', 'Do not say GDPR-, MDR-, GPSR-, PCI-, ISO-, SOC 2- or worldwide-compliant without scoped evidence and legal/auditor approval. Describe implemented controls precisely.'],
      ['RISK — Documentation drift', 'MEDIUM / REDUCED', 'One drift item was fixed: admin location now defaults off across code and key documents. Add automated checks for documented defaults, generated API/schema references and release evidence.'],
    ],
  },
];

const sources = [
  ['EU GDPR — European Commission business guidance', 'https://commission.europa.eu/law/law-topic/data-protection/information-business-and-organisations_en'],
  ['EU Digital Services Act', 'https://digital-strategy.ec.europa.eu/en/policies/digital-services-act'],
  ['EU DSA impact on platforms and marketplaces', 'https://digital-strategy.ec.europa.eu/en/policies/dsa-impact-platforms'],
  ['EU European Accessibility Act', 'https://commission.europa.eu/strategy-and-policy/policies/justice-and-fundamental-rights/disability/european-accessibility-act-eaa_en'],
  ['EU General Product Safety', 'https://commission.europa.eu/topics/business-and-industry/product-safety_en'],
  ['EU medical-device economic operators', 'https://health.ec.europa.eu/medical-devices-topics-interest/economic-operators_en'],
  ['EU Medical Device UDI', 'https://health.ec.europa.eu/medical-devices-topics-interest/unique-device-identifier-udi_en'],
  ['EU AI Act framework and timeline', 'https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai'],
  ['EU AI Act Article 50 transparency FAQ', 'https://digital-strategy.ec.europa.eu/en/faqs/transparency-obligations-under-article-50-ai-act'],
  ['EU Cyber Resilience Act implementation', 'https://digital-strategy.ec.europa.eu/en/factpages/cyber-resilience-act-implementation'],
  ['PCI Security Standards Council — PCI DSS', 'https://www.pcisecuritystandards.org/standards/pci-dss/'],
  ['PCI SSC — SAQ assessment guidance', 'https://listings.pcisecuritystandards.org/pci_security/completing_self_assessment'],
  ['US FTC privacy and security guidance', 'https://www.ftc.gov/business-guidance/privacy-security'],
  ['California Privacy Protection Agency — current regulations', 'https://cppa.ca.gov/regulations/'],
  ['India MeitY — DPDP Rules 2025', 'https://www.meity.gov.in/documents/act-and-policies/digital-personal-dataprotection-rules-2025gDOxUjMtQWa?pageTitle=Digital-Personal-Data-ProtectionRules-2025'],
  ['Canada Privacy Commissioner — PIPEDA', 'https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/'],
  ['Brazil ANPD — official materials', 'https://www.gov.br/anpd/pt-br/centrais-de-conteudo'],
  ['UK medical-device regulation', 'https://www.gov.uk/guidance/regulating-medical-devices-in-the-uk'],
  ['UK online and distance selling', 'https://www.gov.uk/online-and-distance-selling-for-businesses/online-selling'],
];

const rows = sections.flatMap((section) => section.rows);
const counts = rows.reduce((acc, row) => {
  const status = row[1];
  const key = status.startsWith('YES') ? 'Yes' : status.startsWith('NO') ? 'No' : status.startsWith('PARTIAL') ? 'Partial' : status.startsWith('N/A') ? 'N/A' : status.startsWith('CONDITIONAL') ? 'Conditional' : 'Risk/Open';
  acc[key] = (acc[key] || 0) + 1;
  return acc;
}, {});

function statusColour(status) {
  if (status.startsWith('YES')) return C.yes;
  if (status.startsWith('NO')) return C.no;
  if (status.startsWith('PARTIAL')) return C.partial;
  if (status.startsWith('N/A')) return C.na;
  if (status.startsWith('CONDITIONAL')) return C.conditional;
  if (status.includes('CRITICAL')) return C.critical;
  if (status.includes('HIGH')) return C.no;
  return C.conditional;
}

function textCell(text, width, options = {}) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    shading: options.fill ? { type: ShadingType.CLEAR, color: options.fill } : undefined,
    margins: { top: 80, bottom: 80, left: 95, right: 95 },
    verticalAlign: 'center',
    children: [new Paragraph({
      spacing: { after: 0, line: 230 },
      children: [new TextRun({ text, bold: Boolean(options.bold), color: options.color || C.ink, size: options.size || 18 })],
    })],
  });
}

function matrix(rowsForSection) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: [2500, 1700, 6300],
    borders: {
      top: { style: BorderStyle.SINGLE, size: 5, color: C.line },
      bottom: { style: BorderStyle.SINGLE, size: 5, color: C.line },
      left: { style: BorderStyle.SINGLE, size: 5, color: C.line },
      right: { style: BorderStyle.SINGLE, size: 5, color: C.line },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 3, color: C.line },
      insideVertical: { style: BorderStyle.SINGLE, size: 3, color: C.line },
    },
    rows: [
      new TableRow({
        tableHeader: true,
        children: [
          textCell('Compliance name (or risk)', 2500, { fill: C.navy, color: C.white, bold: true, size: 19 }),
          textCell('Following or not', 1700, { fill: C.navy, color: C.white, bold: true, size: 19 }),
          textCell('What should be done', 6300, { fill: C.navy, color: C.white, bold: true, size: 19 }),
        ],
      }),
      ...rowsForSection.map((row, index) => new TableRow({
        cantSplit: true,
        children: [
          textCell(row[0], 2500, { fill: index % 2 === 0 ? C.pale : C.white, bold: true }),
          textCell(row[1], 1700, { fill: statusColour(row[1]), bold: true, size: 17 }),
          textCell(row[2], 6300, { fill: index % 2 === 0 ? C.pale : C.white }),
        ],
      })),
    ],
  });
}

const children = [];
children.push(new Paragraph({
  text: 'UBOSS Global Compliance and Risk Report',
  heading: HeadingLevel.TITLE,
  alignment: AlignmentType.CENTER,
  spacing: { before: 520, after: 140 },
  run: { color: C.navy, bold: true, size: 40 },
}));
children.push(new Paragraph({
  text: 'Simple, evidence-based review of the current software project',
  alignment: AlignmentType.CENTER,
  spacing: { after: 80 },
  run: { color: C.muted, size: 23 },
}));
children.push(new Paragraph({
  text: 'Assessment date: 16 September 2026',
  alignment: AlignmentType.CENTER,
  spacing: { after: 300 },
  run: { color: C.muted, size: 19 },
}));

children.push(new Table({
  width: { size: 100, type: WidthType.PERCENTAGE },
  borders: {
    top: { style: BorderStyle.SINGLE, size: 8, color: C.blue },
    bottom: { style: BorderStyle.SINGLE, size: 8, color: C.blue },
    left: { style: BorderStyle.SINGLE, size: 8, color: C.blue },
    right: { style: BorderStyle.SINGLE, size: 8, color: C.blue },
  },
  rows: [new TableRow({ children: [new TableCell({
    shading: { type: ShadingType.CLEAR, color: 'EFF6FF' },
    margins: { top: 130, bottom: 130, left: 150, right: 150 },
    children: [
      new Paragraph({ children: [new TextRun({ text: 'Overall result: ', bold: true, color: C.navy }), new TextRun({ text: 'Not ready to claim worldwide compliance.', color: C.ink })], spacing: { after: 80 } }),
      new Paragraph({ text: 'The codebase has unusually strong technical foundations for security, privacy rights, auditability, payments and accessibility. The largest remaining gaps are legal/operational: medical-device role and approvals, cross-border data transfers, marketplace/DSA processes, global tax and country launch controls, licence/IP review, malware scanning, independent penetration testing, and signed evidence.', spacing: { after: 0, line: 260 }, run: { color: C.ink, size: 21 } }),
    ],
  })] })],
}));
children.push(new Paragraph({ text: '', spacing: { after: 120 } }));

children.push(new Paragraph({ text: 'How to read the status', heading: HeadingLevel.HEADING_1, spacing: { before: 120, after: 80 }, run: { color: C.navy, bold: true, size: 28 } }));
for (const line of [
  'YES — a relevant control is implemented in the reviewed code; production configuration and legal evidence are still required.',
  'PARTIAL — useful controls exist, but important technical, legal or operational work remains.',
  'NO — the requirement or evidence was not found, or it requires a business/legal action the repository cannot perform.',
  'CONDITIONAL / N/A — applicability depends on country, customer type, scale, role, product or feature. Applicability must be documented before relying on this status.',
]) {
  children.push(new Paragraph({ text: line, bullet: { level: 0 }, spacing: { after: 55, line: 245 }, run: { color: C.ink, size: 20 } }));
}

children.push(new Paragraph({ text: 'Audit summary', heading: HeadingLevel.HEADING_1, spacing: { before: 150, after: 80 }, run: { color: C.navy, bold: true, size: 28 } }));
children.push(new Paragraph({
  text: `${rows.length} compliance and risk checks are included. Status count: ${Object.entries(counts).map(([key, value]) => `${key} ${value}`).join(' • ')}.`,
  spacing: { after: 90, line: 250 }, run: { color: C.ink, size: 20 },
}));
children.push(new Paragraph({ text: 'Evidence checked', heading: HeadingLevel.HEADING_2, spacing: { before: 80, after: 60 }, run: { color: C.blue, bold: true, size: 23 } }));
for (const line of [
  'Backend, three web applications, Prisma data model/migrations, security configuration, deployment scripts, CI workflows and compliance/runbook documents.',
  'Live dependency advisory check: zero known npm advisories across the four lockfiles on the assessment date.',
  'Verification: backend type-check and lint passed; customer web 43 files / 521 tests passed; logistics web 3 files / 28 tests passed; all three web apps passed lint, contrast audit and production build.',
  'Privacy fix made during this review: precise admin sign-in geolocation now defaults to OFF in code and documented configuration.',
]) {
  children.push(new Paragraph({ text: line, bullet: { level: 0 }, spacing: { after: 50, line: 245 }, run: { color: C.ink, size: 20 } }));
}
children.push(new Paragraph({ children: [new PageBreak()] }));

for (let i = 0; i < sections.length; i += 1) {
  const section = sections[i];
  children.push(new Paragraph({ text: section.title, heading: HeadingLevel.HEADING_1, spacing: { before: 120, after: 90 }, run: { color: C.navy, bold: true, size: 28 } }));
  children.push(matrix(section.rows));
  if (i < sections.length - 1) children.push(new Paragraph({ children: [new PageBreak()] }));
}

children.push(new Paragraph({ children: [new PageBreak()] }));
children.push(new Paragraph({ text: '9. Priority order before selling internationally', heading: HeadingLevel.HEADING_1, spacing: { before: 80, after: 100 }, run: { color: C.navy, bold: true, size: 28 } }));
const priorities = [
  '1. Decide the legal seller/marketplace/importer/distributor model and block country activation until it is approved.',
  '2. Complete medical-device and product-safety role, licence, traceability and recall work for every product/market.',
  '3. Complete privacy governance: notices, ROPA, DPAs, transfer mechanisms/TIAs, DPIAs, representatives and incident ownership.',
  '4. Complete marketplace legal workflows: seller verification, illegal-content/product notice, reasoned decisions, appeals, complaints, payouts and tax reporting.',
  '5. Complete security assurance: independent penetration test, SAST, malware scanning, licence/IP review, vulnerability disclosure and release signing.',
  '6. Prove deployment operations: off-site restore tests, monitoring/on-call, RTO/RPO, production hardening and capacity tests.',
  '7. Complete manual accessibility testing and publish an accessibility statement.',
  '8. Obtain tax, payments, sanctions and local legal sign-off for each country before switching it on.',
];
for (const line of priorities) children.push(new Paragraph({ text: line, spacing: { after: 75, line: 255 }, run: { color: C.ink, size: 21 } }));

children.push(new Paragraph({ text: 'Important limitation', heading: HeadingLevel.HEADING_2, spacing: { before: 160, after: 70 }, run: { color: C.blue, bold: true, size: 23 } }));
children.push(new Paragraph({
  text: 'No finite report can guarantee every law in every country, state, province, industry and product category. This report provides the broad global baseline and the major regimes relevant to this project. It is a readiness assessment, not legal advice or a certification. Every launch still needs a written local applicability decision by qualified counsel, tax advisers, product-regulatory specialists and the payment acquirer.',
  spacing: { after: 100, line: 260 }, run: { color: C.ink, size: 20 },
}));

children.push(new Paragraph({ text: '10. Authoritative sources used', heading: HeadingLevel.HEADING_1, spacing: { before: 150, after: 90 }, run: { color: C.navy, bold: true, size: 28 } }));
for (const [label, url] of sources) {
  children.push(new Paragraph({
    spacing: { after: 60, line: 235 },
    children: [new TextRun({ text: `${label}: `, bold: true, color: C.ink, size: 18 }), new TextRun({ text: url, color: C.blue, size: 17 })],
  }));
}

const doc = new Document({
  creator: 'OpenAI Codex for UBOSS Sourcing',
  title: 'UBOSS Global Compliance and Risk Report',
  description: 'Plain-language compliance and risk readiness assessment for UBOSS Sourcing.',
  styles: {
    default: { document: { run: { font: 'Aptos', size: 20, color: C.ink } } },
  },
  sections: [{
    properties: { page: { margin: { top: 680, right: 620, bottom: 680, left: 620 } } },
    headers: { default: new Header({ children: [new Paragraph({ text: 'UBOSS SOURCING  |  GLOBAL COMPLIANCE AND RISK REPORT', spacing: { after: 0 }, run: { size: 15, bold: true, color: C.muted } })] }) },
    footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: 'Assessment 16 Sep 2026  •  Page ', color: C.muted, size: 15 }), new TextRun({ children: [PageNumber.CURRENT], color: C.muted, size: 15 })] })] }) },
    children,
  }],
});

await writeFile(out, await Packer.toBuffer(doc));
console.log(`Created ${out} with ${rows.length} checks.`);

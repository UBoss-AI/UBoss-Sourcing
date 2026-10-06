# Regulatory sources for seller and product compliance

**Reviewed 2026-10-06; DRAFT — not legal advice; every rule needs approval by a qualified compliance reviewer.**

This file backs the draft rules in
`backend/src/seed/compliance-requirements.draft.json` (53 entries). Each rule
there carries the same source, a confidence level and an applicability status.

## How to read this

- **Origin** is where the goods are made. For most sellers here that is India.
- **Destination** is where the buyer receives them: India (`IN`) or any EU
  member state (`EU`).
- **Roles.** The *manufacturer* puts its name on the product. The *importer*
  first brings it into a market. The *distributor* resells it. The *authorised
  representative* acts in the EU for a manufacturer based outside the EU.
- **APPLIES** means the rule applies to everything in the listed category for
  the listed role and market.
- **CONDITIONAL** means it applies only if a stated fact is true, for example
  "the product is on the BIS list" or "the product is a cosmetic". A person has
  to check that fact for each product.
- **UNRESOLVED** means this review could not decide whether it applies. Do not
  enforce it until a qualified reviewer decides.
- **Confidence** says how sure this review is of the facts in the rule:
  HIGH (read in an official text), MEDIUM (official page found but not fully
  read, or parts not confirmed), LOW (conflicting or missing sources).
- **CE marking is not universal.** The Commission says it is compulsory only
  for products covered by legislation that requires it, and it is forbidden to
  put it on other products
  ([CE marking](https://single-market-economy.ec.europa.eu/single-market/ce-marking_en)).
- **FSSAI food licensing does not apply to any category here**, because none
  sells food. `food-service-catering` is equipment and disposables. Food
  *contact* rules may apply to tableware, storage and packaging (EU rule
  below). India's food-packaging rules were not reviewed.

## Medical devices — India destination

Law: Medical Devices Rules, 2017 (MDR 2017), under the Drugs and Cosmetics
Act. Main source read: CDSCO *Frequently Asked Questions on Medical Devices
Rules, 2017*, Doc No. CDSCO/FAQ/MD/01/2024
([PDF](https://cdsco.gov.in/opencms/export/sites/CDSCO_WEB/Pdf-documents/MDFAQ1324.pdf)).
CDSCO itself says the FAQ is for awareness, not for legal use.
Rules and amendments:
[CDSCO Medical Devices Rules page](https://cdsco.gov.in/opencms/opencms/en/Acts-and-rules/Medical-Devices-Rules/).

| What | Who | Evidence | Validity | Confidence |
|---|---|---|---|---|
| Risk class A (low) to D (high). Only the Central Licensing Authority (CLA) classifies. Published lists change. | All | CDSCO class for the device | Re-check yearly | HIGH |
| Manufacturing licence, Class A (sterile or measuring) and Class B: Form MD-5 from the State Licensing Authority. Class B sites are audited by a CDSCO-registered notified body first. Needed even for export-only manufacture. | Manufacturer (India) | Form MD-5 | Perpetual; retention fee every 5 years | HIGH |
| Manufacturing licence, Class C and D: Form MD-9 from the CLA, after inspection. | Manufacturer (India) | Form MD-9 | Perpetual; retention fee every 5 years | HIGH |
| Class A non-sterile, non-measuring: no licence, but compulsory free registration on the CDSCO portal, plus labelling rules (G.S.R. 777(E), 14.10.2022). | Manufacturer, importer | Portal registration number | Re-check | HIGH |
| Import licence: apply in MD-14, granted in MD-15 by the CLA. | Importer of non-Indian devices | Form MD-15 + power of attorney | Perpetual; retention fee | HIGH |
| Sale or distribution: registration in Form MD-42 from the State, or a wholesale drug licence. | Distributor | MD-42 | Perpetual; retention fee | MEDIUM |
| Quality management system to the Fifth Schedule, with a signed undertaking. Importers submit a quality certificate. | Manufacturer, importer | Undertaking, QMS certificate | Ongoing | MEDIUM |

Classes seen for our lines (indicative, not checked line by line):
syringes, IV cannulae, nasogastric (Ryles) tubes and suction catheters appear
as Class B in CDSCO lists found in search. **Adult incontinence diapers**
(entry 24) and **non-sterile examination gloves** are on the CDSCO Class A
non-sterile, non-measuring list
([PDF](https://cdsco.gov.in/opencms/resources/UploadCDSCOWeb/2018/UploadPublic_NoticesFiles/Risk%20based%20classification%20list%20of%20Class%20A(non-sterile%20and%20non-measuring)%20medical%20device.pdf)).
The full classification-wise list PDF was over 10 MB and would not load, so
other mappings are not confirmed.

Disinfectants: only disinfectants meant to disinfect medical devices are
regulated as devices in India (FAQ Q57). Disinfectant caps are therefore
probably devices there; their class was not confirmed.

## Medical devices — EU destination

Law: Regulation (EU) 2017/745 (MDR),
[EUR-Lex](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32017R0745).

| What | Who | Evidence | Validity | Confidence |
|---|---|---|---|---|
| Class I, Is, Im, Ir, IIa, IIb, III by Annex VIII rules. | Manufacturer | Class and rule in technical documentation | Review yearly | HIGH |
| EU declaration of conformity (Art. 19) and CE marking (Art. 20). | Manufacturer | Signed DoC, CE on label | Kept up to date | HIGH |
| Notified body certificate only for Is, Im, Ir (for those aspects only, Art. 52(7)), IIa, IIb and III. **Not** for plain Class I. | Manufacturer | Certificate; check the body in NANDO | Max 5 years (Art. 56) | HIGH |
| Authorised representative in the EU under a written mandate (Art. 11), for any non-EU manufacturer. | Manufacturer, AR | Mandate, AR's SRN | Review yearly | HIGH |
| Importer checks before placing on market (Art. 13): CE, DoC, AR, label, IFU, UDI; importer adds its details. | Importer | Check record | Per lot | HIGH |
| Distributor checks (Art. 14). | Distributor | Check record | Per lot | HIGH |
| UDI (Art. 27) and EUDAMED. Four modules (actors, UDI/devices, notified bodies and certificates, market surveillance) mandatory from 28 May 2026 ([Commission](https://health.ec.europa.eu/medical-devices-eudamed/overview_en)). | Manufacturer, AR, importer | UDI-DI, SRN | Review yearly | MEDIUM |
| Label and IFU in the language(s) the member state requires. | All | Artwork per language | Review yearly | HIGH |

Notified bodies and NANDO:
[Commission page](https://health.ec.europa.eu/medical-devices-topics-interest/notified-bodies-medical-devices_en).
Many of our lines are supplied sterile, which on its own takes a Class I
device to Is and brings in a notified body.

**IVDR (2017/746).** Most of our lines are not IVDs. **Exception to check:**
IVDR Article 2(3) treats a container made specifically to hold and preserve
a human specimen for diagnostic testing as an IVD. ABG syringes and ABG kits
may fall into this group
([EUR-Lex](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32017R0746)).
UNRESOLVED.

## Borderline medical items

| Item | India | EU | Status |
|---|---|---|---|
| Prefilled heparin syringe | Heparin is usually a drug; device licence may not be the right route | A single-use integral drug-device product is a medicinal product with device safety requirements for the syringe part (MDR Art. 1(9)) | UNRESOLVED |
| Sodium citrate prefilled syringe, saline flush syringe | Not settled by any CDSCO document read | Some are sold as devices, some may be medicines; depends on claimed action | UNRESOLVED |
| Sterile water, sterile water with 10% glycerine | Water for injection is usually a drug; water for balloon inflation or irrigation may be a device | Same question | UNRESOLVED |
| Adult diapers | Class A non-sterile, non-measuring device (CDSCO list entry 24) | Device only if the manufacturer claims a medical purpose; otherwise a consumer product under GPSR | India CONDITIONAL; EU UNRESOLVED |
| Surgical gloves | Device | Device; if wearer protection is also claimed, PPE Regulation 2016/425 applies too | CONDITIONAL |
| Disinfectant cap | Device if meant to disinfect device connectors (FAQ Q57) | Generally a device; BPR 528/2012 excludes device-law products unless used for other purposes | CONDITIONAL |

## ISO 13485 and IAF CertSearch

- ISO 13485 is a quality management system standard for medical device
  organisations. A certificate is **evidence about the company's processes**.
  It does not approve a product, and it is not a licence in India or a CE
  certificate in the EU. The iso.org page
  ([ISO 13485](https://www.iso.org/standard/59752.html)) returned HTTP 403
  during this review, so the current edition was not re-checked.
- **IAF CertSearch** holds only *accredited* management-system certificates.
  A match shows the certificate's status: active, suspended, withdrawn or
  expired ([verification guide](https://support.iafcertsearch.org/verifiers/getting-started/certificate-verification-guide),
  [FAQ](https://support.iafcertsearch.org/iaf-certsearch-faq/iaf-certsearch-faq/general)).
- It **cannot** confirm product conformity, licences, CE status, or
  certificates from non-accredited bodies. Certification bodies must upload
  their own data, and not all do.
- **A missing result means "unable to verify", not fraud.** Next step: ask the
  certification body named on the certificate.

## India BIS compulsory certification (non-medical)

BIS runs several schemes: Scheme I (ISI mark licence), Scheme II (Compulsory
Registration Scheme, CRS), Scheme IV and Scheme X
([BIS hub](https://www.bis.gov.in/product-certification/products-under-compulsory-certification/?lang=en)).
A product needs BIS certification only if a Quality Control Order (QCO) names
it. **Every BIS rule here is CONDITIONAL on the exact product being covered.
QCOs change often and some have been withdrawn or suspended.**

| Our categories | Order / scheme | Status | Confidence |
|---|---|---|---|
| computers-it, phones-communication, lighting, batteries-power-supplies, solar-renewables, some home-appliances | CRS: 73 listed product types, for example laptops, printers, mobile phones, power banks, LED lamps, Li-ion cells, UPS, PV modules, microwave ovens, induction stoves ([list](https://www.crsbis.in/BIS/products-bis.do)) | CONDITIONAL | HIGH |
| cables-wiring, switches-sockets, circuit-protection | Electrical Wires, Cables, Appliances, Protection Devices and Accessories QCO (IS 694, IS 1293, IS 3854, IS/IEC 60898, IS 12640) | CONDITIONAL | MEDIUM |
| home-appliances, commercial-kitchen-equipment | Household, commercial and similar appliances QCO (IS 302). **Dates conflict:** reported effective 19 Mar 2026; BIS upcoming page (updated 22 Sep 2026) shows 1 Oct 2026 | UNRESOLVED | LOW |
| circuit-protection, motors-drives, industrial-supplies | Scheme X: LV switchgear (IS/IEC 60947) and machinery omnibus order; deferment S.O. 5038(E) 6 Nov 2025, amendment S.O. 5179(E) 13 Nov 2025, rescission S.O. 239(E) 16 Jan 2026 ([Scheme X](https://www.bis.gov.in/products-under-compulsory-certification-scheme-x/?lang=en)) | UNRESOLVED | LOW |
| toys-games | Toys QCO 2020, in force 1 Jan 2021 (IS 9873, IS 15644) | CONDITIONAL | HIGH |
| footwear, safety-footwear | Footwear (Leather and other Materials) QCO 2024, S.O. 1421(E), in force 1 Aug 2024; exempts export goods and micro and small units ([PDF](https://www.bis.gov.in/wp-content/uploads/2024/03/Footwear-made-from-Leather-and-other-Materials-QCO-2024.pdf)) | CONDITIONAL | HIGH |
| tyres-wheels | Pneumatic tyres and tubes on Scheme I list | CONDITIONAL | MEDIUM |
| building-construction | Cement types and over 100 steel standards on Scheme I list | CONDITIONAL | MEDIUM |
| chemicals-raw-materials, cleaning-chemicals | Chemical and polymer QCOs. Many withdrawn or suspended. Example: Linear Alkyl Benzene listed by BIS for 30 Sep 2026, while the Department of Chemicals posted a temporary suspension on 01-10-2026 ([notifications](https://chemicals.gov.in/index.php/notifications)) | UNRESOLVED | MEDIUM |
| Upcoming | Pipe wrenches and pliers, aluminium utensils, woven sacks, glass screen protectors, PP ropes and others ([upcoming QCOs](https://www.bis.gov.in/upcoming-qcos-notified-and-due-for-implementation/?lang=en)) | Not entered as rules yet | — |

Other India rules entered as CONDITIONAL:

- **Telecom and wireless:** TEC MTCTE certificate (5 years) for notified
  telecom equipment; WPC Equipment Type Approval for radio devices, often by
  self-declaration
  ([TEC](https://www.tec.gov.in/mandatory-testing-and-certification-of-telecom-equipments-mtcte),
  [DoT ETA](https://eservices.dot.gov.in/equipment-type-approval-eta)).
  MEDIUM: pages found in search, not opened.
- **Cosmetics:** import registration COS-2 (applied in COS-1) from CDSCO;
  manufacturing licence COS-8 (loan licence COS-9). Both perpetual with a
  retention fee before five years
  ([CDSCO cosmetics](https://cdsco.gov.in/opencms/opencms/en/Cosmetics/cosmetics/)).
  MEDIUM.
- **Fertiliser:** Fertiliser (Control) Order, 1985: state registration of
  manufacturers and dealers ([Dept. of Fertilizers](https://www.fert.nic.in/node/1063)).
- **Seeds:** Seeds Act, 1966: compulsory labelling and minimum germination
  and purity for notified kinds; certification voluntary
  ([SeedNet FAQ](https://seednet.gov.in/Material/FAQ.htm)).

## EU destination (non-medical)

| Rule | Our categories | Status | Confidence |
|---|---|---|---|
| GPSR (EU) 2023/988, from 13 Dec 2024: consumer products must be safe; an EU-established responsible economic operator is needed; marketplaces have duties. Excludes medicinal products and food. B2B-only professional goods may be outside it. | All non-medical departments | CONDITIONAL | MEDIUM |
| LVD 2014/35/EU (50-1000 V AC, 75-1500 V DC): DoC + CE | Electrical and electronic categories | CONDITIONAL | HIGH |
| EMC 2014/30/EU: DoC + CE for apparatus | Same | CONDITIONAL | HIGH |
| RoHS 2011/65/EU: substance limits, DoC + CE | Same | CONDITIONAL | HIGH |
| RED 2014/53/EU: radio equipment; covers its own safety and EMC | phones-communication, networking, wireless peripherals | CONDITIONAL | HIGH |
| PPE (EU) 2016/425: DoC + CE; type-examination certificate (max 5 years) for Category II and III | safety-protective-equipment | CONDITIONAL | HIGH |
| Toys: Directive 2009/48/EC now; Regulation (EU) 2025/2509 replaces it, Directive repealed from 1 Aug 2030 | toys-games | CONDITIONAL | MEDIUM |
| Machinery: Directive 2006/42/EC being replaced by Regulation (EU) 2023/1230 (start date not confirmed in fetched text) | industrial-supplies, tools-hardware, kitchen equipment, agriculture | CONDITIONAL | MEDIUM |
| Cosmetics (EC) 1223/2009: EU responsible person, safety report, product information file (10 years), CPNP notification. No CE. | beauty-personal-care lines | CONDITIONAL | HIGH |
| Food contact (EC) 1935/2004: safety, traceability, declaration of compliance where a specific measure exists | tableware, disposables, food storage, kitchenware, packaging | CONDITIONAL | HIGH |
| Batteries (EU) 2023/1542: CE, DoC, labelling, producer registration; phased dates from 18 Feb 2024 | batteries, phones, computers, solar, tools | CONDITIONAL | MEDIUM |
| REACH (EC) 1907/2006: registration at 1 t/year by EU importer or only representative; SVHC information in articles | chemicals, cleaning chemicals, lab | CONDITIONAL | HIGH |
| CLP (EC) 1272/2008: classify, label, package hazardous substances and mixtures | Same | CONDITIONAL | HIGH |
| Biocides (EU) 528/2012: authorisation before sale | disinfection-sterilisation, cleaning-chemicals | CONDITIONAL | MEDIUM |

## Unresolved / needs a qualified reviewer

1. Drug or device status of prefilled heparin, sodium citrate and saline flush
   syringes, sterile water and sterile water with 10% glycerine — India and EU.
2. Whether ABG syringes and ABG kits are IVD specimen receptacles (IVDR) or
   MDR devices.
3. EU status of adult diapers (device versus consumer product).
4. India risk class of each medical product line beyond those noted above,
   and EU MDR class of each line.
5. Whether MD-42 sale registration applies to Class A non-sterile,
   non-measuring devices.
6. Whether an ISO 13485 certificate alone meets India's Fifth Schedule.
7. EU transition rules for legacy (MDD-certified) devices and for EUDAMED
   registration of devices already on the market — not read.
8. India household appliances QCO: which date and scope apply now.
9. India Scheme X machinery and switchgear orders: what is in force after the
   2025-2026 deferment, amendment and rescission.
10. India chemical QCOs: day-by-day status (withdrawals and suspensions).
11. India BIS orders for industrial PPE (helmets, respirators, safety gloves)
    and for two-wheeler helmets — not confirmed in this review, so no rule
    was entered.
12. EU Machinery Regulation 2023/1230 start date; EU Construction Products
    Regulation; EU Packaging and Packaging Waste Regulation (EU) 2025/40
    dates; EU WEEE producer registration — not reviewed, no rule entered.
13. India Legal Metrology (Packaged Commodities) Rules for packaged goods and
    India food-packaging rules — not reviewed, no rule entered.
14. Exact CE and due-diligence dates under the EU Batteries Regulation.

## Sampling table finding (MIL-STD-105E)

- **Public domain: yes, with a caveat.** MIL-STD-105E (10 May 1989) is
  cancelled. Notice 3 (6 Feb 2008) on the US Defense Logistics Agency's ASSIST
  site carries "DISTRIBUTION STATEMENT A. Approved for public release;
  distribution is unlimited" and says future buys may refer to MIL-STD-1916 or
  ANSI/ASQ Z1.4
  ([DLA ASSIST, Notice 3](https://quicksearch.dla.mil/WMX/Default.aspx?token=607910)).
  As a US federal government work it is generally not under US copyright; a
  reviewer should confirm for other jurisdictions.
- **Same as ANSI/ASQ Z1.4: yes.** Taylor Enterprises (Wayne Taylor) states
  there are no changes in the tables of sampling plans between MIL-STD-105E
  and ANSI/ASQ Z1.4; only a switching-rule detail changed
  ([source](https://variation.com/forums/topic/differences-between-mil-std-105e-and-ansi-asq-z1-4/)).
  The CRAN *AQLSchemes* vignette says the same and that the MIL-STD tables are
  public domain.
- **Same as ISO 2859-1: not confirmed.** The CRAN vignette says the central
  table entries are the same. A practitioner forum (not authoritative) claims
  the 1999 ISO revision changed some accept/reject pairs. ISO text was not
  available to check.
- **Consequence for the product:** shipping a single-sampling, normal-inspection
  table taken from MIL-STD-105E is legitimate. Label it as MIL-STD-105E
  (equivalent to ANSI/ASQ Z1.4). Do **not** claim it is ISO 2859-1 until a
  reviewer compares it with a licensed copy. Do not copy ISO or ASQ text.

## What this software does not do

- It does not grant, renew or replace any approval: no CDSCO licence or
  registration, no BIS licence or CRS registration, no EU notified body
  certificate, no CE marking, no marketing authorisation.
- It does not replace notified bodies, BIS, CDSCO, TEC, WPC, EU competent
  authorities, or accredited inspection bodies (ISO/IEC 17020) and testing
  laboratories (ISO/IEC 17025). It does not accredit anyone.
- It does not decide a product's classification or regulatory status. It
  records the evidence a seller supplies and the decision a human reviewer
  makes.
- A green tick means "the evidence asked for was supplied and a reviewer
  accepted it", not "this product is legal to sell".

## Sources that would not load in this review

- `https://www.iso.org/standard/59752.html` — HTTP 403.
- CDSCO classification-wise list PDF
  (`.../ClassificationwiselistofMD_32.pdf`) — larger than 10 MB.
- `https://www.qualitymag.com/articles/98097-brief-history-of-ansi-asq-z14` —
  HTTP 403 (not used).
- Found in search but not opened: BIS toys QCO PDF, DPIIT electrical QCO PDF,
  BIS appliances QCO 2025 PDF, CDSCO Cosmetics Rules 2020 PDF and cosmetics
  page, Department of Fertilizers page, SeedNet FAQ, TEC MTCTE page, DoT ETA
  page, EUR-Lex Toy Safety Regulation 2025/2509.
- EUR-Lex pages loaded, but some article numbers could not be confirmed from
  the extract (GPSR, Machinery Regulation start date, Batteries dates). Those
  rules avoid article numbers or say so.

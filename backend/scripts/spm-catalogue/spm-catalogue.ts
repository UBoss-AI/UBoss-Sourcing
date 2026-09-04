/**
 * The SPM Medicare catalogue, as data.
 *
 * Sources, in order of authority:
 *   1. Product-Description/*.pdf  — the controlled IFU documents. Descriptions,
 *      intended use and device-variant tables come from here.
 *   2. SPM_Product_Catalogue_2026-27FV.pdf — product codes and pack sizes.
 *   3. Images/*.jpg — mapped to products by reading the artwork.
 *
 * MOCK DATA, clearly marked so it can be found and replaced:
 *   - `priceInr` on every product and variant. Neither source document
 *     contains a single price. These are invented, plausible trade prices per
 *     pack and are NOT quotable.
 *   - `taxClassCode: 'GST5'` — medical devices commonly sit at 5% in India,
 *     but this is an assumption, not something either document states.
 *
 * Where the source was ambiguous the code is carried verbatim and the
 * ambiguity is recorded in `NOTES` at the bottom rather than guessed away.
 */

export interface VariantDef {
  sku: string;
  name: string;
  options: Record<string, string>;
  /** Mock. Rupees, major units. Omitted means "inherits the product price". */
  priceInr?: number;
}

export interface ProductDef {
  /** Family-level SKU. Real product codes live on the variants. */
  sku: string;
  name: string;
  category: 'line-access' | 'line-conditioning' | 'iv-administration-sets' | 'syringes';
  shortDescription: string;
  description: string;
  /** Mock. Rupees, major units, per pack. */
  priceInr: number;
  isRecurringEligible?: boolean;
  attributes: { name: string; value: string; isFilterable?: boolean }[];
  /** Image-NN.jpg basenames, primary first. Empty means it cannot be published. */
  images: string[];
  variants: VariantDef[];
}

export const CATEGORIES = [
  {
    slug: 'line-access',
    name: 'Line Access',
    description:
      'Secure establishment of vascular access aligned with closed-system practices. Peripheral IV cannulae, including blood-control and needle-stick-safety designs.',
  },
  {
    slug: 'line-conditioning',
    name: 'Line Conditioning',
    description:
      'Ready-to-use flushing and preparation to support standardised line handling. Prefilled saline, heparin and citrate flush syringes, and prefilled syringes for Foley balloon inflation.',
  },
  {
    slug: 'iv-administration-sets',
    name: 'IV Administration Sets',
    description:
      'Gravity and pump administration of intravenous fluid and medication: infusion sets, paediatric burette sets and extension lines with stopcocks.',
  },
  {
    slug: 'syringes',
    name: 'Syringes & Needles',
    description:
      'Single-use hypodermic, insulin and arterial-sampling syringes, and safety hypodermic needles.',
  },
] as const;

/** Gauge → catheter ID/OD and length, as printed in the catalogue. */
const GAUGE_SPEC: Record<string, { idOd: string; length: string }> = {
  '14G': { idOd: '1.7/2.1 mm', length: '45 mm' },
  '16G': { idOd: '1.3/1.7 mm', length: '45 mm' },
  '18G': { idOd: '0.9/1.3 mm', length: '32 mm' },
  '18G-L': { idOd: '0.9/1.3 mm', length: '45 mm' },
  '20G': { idOd: '0.8/1.1 mm', length: '32 mm' },
  '22G': { idOd: '0.6/0.9 mm', length: '25 mm' },
  '24G': { idOd: '0.5/0.7 mm', length: '19 mm' },
  '26G': { idOd: '0.45/0.6 mm', length: '19 mm' },
};

const gaugeLabel = (g: string): string => (g === '18G-L' ? '18G (45 mm)' : g);

/** Builds gauge × catheter-material variants from a code table. */
function cannulaVariants(
  table: { gauge: string; material: string; code: string }[],
  priceByGauge?: Record<string, number>,
): VariantDef[] {
  return table.map((row) => {
    const spec = GAUGE_SPEC[row.gauge];
    return {
      sku: row.code,
      name: `${gaugeLabel(row.gauge)} · ${row.material}`,
      options: {
        Gauge: gaugeLabel(row.gauge),
        Catheter: row.material,
        ...(spec === undefined ? {} : { 'ID/OD': spec.idOd, Length: spec.length }),
      },
      ...(priceByGauge?.[row.gauge] === undefined ? {} : { priceInr: priceByGauge[row.gauge] }),
    };
  });
}

const EO_STERILE = { name: 'Sterilisation', value: 'Sterile (EO) — ethylene oxide, single use only', isFilterable: true };
const GAMMA_STERILE = { name: 'Sterilisation', value: 'Gamma sterile — single use only', isFilterable: true };
const LATEX_FREE = { name: 'Latex', value: 'Latex-free', isFilterable: true };

export const PRODUCTS: ProductDef[] = [
  // =========================================================================
  // LINE ACCESS
  // =========================================================================
  {
    sku: 'EV-CANNULA-WP',
    name: 'Easy-Vein IV Cannula — with Wings & Injection Port',
    category: 'line-access',
    shortDescription:
      'Sterile single-use peripheral IV cannula with flexible wings, injection port and transparent flashback chamber.',
    description: `The SPM IV Cannula is a sterile, single-use peripheral intravenous catheter intended to provide short-term vascular access.

The device consists of a stainless-steel introducer needle and a flexible catheter manufactured from either Polyurethane (PUR) or Fluorinated Ethylene Propylene (FEP), depending on the variant. The catheter is mounted on a hub assembly designed for secure connection to standard Luer-compatible infusion systems in accordance with EN ISO 80369-7.

Flexible wings provide secure fixation and easy handling during insertion. The integrated injection port allows medication to be administered without disconnecting the IV line, and the transparent flashback chamber enables quick visual confirmation of venipuncture. The device is colour-coded by gauge size for rapid identification.

Sterilised using Ethylene Oxide (EO), supplied in a validated sterile barrier system, and non-pyrogenic, latex-free and DEHP-free.`,
    priceInr: 1850,
    attributes: [
      EO_STERILE,
      LATEX_FREE,
      { name: 'Catheter material', value: 'PUR or FEP, radiopaque', isFilterable: true },
      { name: 'Packaging', value: 'Blister pack (individual) · 100 pcs/box · 1,000 pcs/outer' },
      { name: 'Shelf life', value: '5 years from date of manufacture' },
      { name: 'Standard', value: 'EN ISO 80369-7 Luer connection' },
    ],
    images: ['Image-01'],
    variants: cannulaVariants(
      [
        { gauge: '14G', material: 'FEP', code: '3F114' },
        { gauge: '16G', material: 'FEP', code: '3F116' },
        { gauge: '18G', material: 'FEP', code: '3F118' },
        { gauge: '18G-L', material: 'FEP', code: '3F118L' },
        { gauge: '20G', material: 'FEP', code: '3F120' },
        { gauge: '22G', material: 'FEP', code: '3F122' },
        { gauge: '24G', material: 'FEP', code: '3F124' },
        { gauge: '26G', material: 'FEP', code: '3F126' },
        { gauge: '14G', material: 'PUR', code: '3F314' },
        { gauge: '16G', material: 'PUR', code: '3F316' },
        { gauge: '18G', material: 'PUR', code: '3F318' },
        { gauge: '18G-L', material: 'PUR', code: '3F318L' },
        { gauge: '20G', material: 'PUR', code: '3F320' },
        { gauge: '22G', material: 'PUR', code: '3F322' },
        { gauge: '24G', material: 'PUR', code: '3F324' },
        { gauge: '26G', material: 'PUR', code: '3F326' },
      ],
      { '14G': 1980, '16G': 1930, '18G': 1850, '18G-L': 1900, '20G': 1850, '22G': 1820, '24G': 1820, '26G': 1880 },
    ),
  },
  {
    sku: 'AV-CANNULA-WP',
    name: 'Accu-Vein IV Cannula — with Wings & Injection Port',
    category: 'line-access',
    shortDescription:
      'The Accu-Vein branded IV cannula: wings, injection port and flashback chamber, in PUR and FEP catheter options.',
    description: `A sterile, single-use IV cannula designed for safe and smooth venous access. It features flexible wings for secure fixation, an injection port for easy drug administration, and a transparent flashback chamber for quick vein-puncture confirmation.

Nickel-plated bevelled needle for smooth insertion. Manufactured from medical-grade polypropylene, PUR or FEP radiopaque catheter, and a hydrophobic filter. Sterile, single-use design reduces the risk of cross-contamination and infection.

Accu-Vein is the same device platform as Easy-Vein under a separate brand; the two share gauge range, dimensions and pack format.`,
    priceInr: 1790,
    attributes: [
      EO_STERILE,
      LATEX_FREE,
      { name: 'Catheter material', value: 'PUR or FEP, radiopaque', isFilterable: true },
      { name: 'Packaging', value: 'Blister pack (individual) · 100 pcs/box · 1,000 pcs/outer' },
      { name: 'Shelf life', value: '5 years from date of manufacture' },
    ],
    images: ['Image-33'],
    variants: cannulaVariants([
      { gauge: '14G', material: 'FEP', code: '3A114' },
      { gauge: '16G', material: 'FEP', code: '3A116' },
      { gauge: '18G', material: 'FEP', code: '3A118' },
      { gauge: '18G-L', material: 'FEP', code: '3A118L' },
      { gauge: '20G', material: 'FEP', code: '3A120' },
      { gauge: '22G', material: 'FEP', code: '3A122' },
      { gauge: '24G', material: 'FEP', code: '3A124' },
      { gauge: '26G', material: 'FEP', code: '3A126' },
      { gauge: '14G', material: 'PUR', code: '3A314' },
      { gauge: '16G', material: 'PUR', code: '3A316' },
      { gauge: '18G', material: 'PUR', code: '3A318' },
      { gauge: '18G-L', material: 'PUR', code: '3A318L' },
      { gauge: '20G', material: 'PUR', code: '3A320' },
      { gauge: '22G', material: 'PUR', code: '3A322' },
      { gauge: '24G', material: 'PUR', code: '3A324' },
      { gauge: '26G', material: 'PUR', code: '3A326' },
    ]),
  },
  {
    sku: 'EV-NUO-CANNULA',
    name: 'Easy-Vein NUO IV Cannula — Small Wings, without Injection Port',
    category: 'line-access',
    shortDescription:
      'Compact small-wing cannula without an injection port, for neonatal and paediatric access in 24G and 26G.',
    description: `A sterile, single-use IV cannula with small stabilising wings and no injection port, for short-term peripheral access where a compact hub matters most — neonatal, paediatric and fragile-vein placement.

Supplied in 24G and 26G only, under both the Easy-Vein NUO and Accu-Vein NUO brands. Colour-coded by gauge, radiopaque catheter, transparent flashback chamber, latex-free.`,
    priceInr: 1920,
    attributes: [
      EO_STERILE,
      LATEX_FREE,
      { name: 'Gauge range', value: '24G – 26G', isFilterable: true },
      { name: 'Packaging', value: 'Blister pack (individual) · 100 pcs/box · 1,000 pcs/outer' },
      { name: 'Shelf life', value: '5 years from date of manufacture' },
    ],
    images: ['Image-01'],
    variants: [
      { sku: '3G324', name: '24G · Easy-Vein NUO', options: { Gauge: '24G', Brand: 'Easy-Vein NUO', 'ID/OD': '0.5/0.7 mm' } },
      { sku: '3G326', name: '26G · Easy-Vein NUO', options: { Gauge: '26G', Brand: 'Easy-Vein NUO', 'ID/OD': '0.45/0.6 mm' } },
      { sku: '3B324', name: '24G · Accu-Vein NUO', options: { Gauge: '24G', Brand: 'Accu-Vein NUO', 'ID/OD': '0.5/0.7 mm' } },
      { sku: '3B326', name: '26G · Accu-Vein NUO', options: { Gauge: '26G', Brand: 'Accu-Vein NUO', 'ID/OD': '0.45/0.6 mm' } },
    ],
  },
  {
    sku: 'EV-WIN-CANNULA',
    name: 'Easy-Vein WIN IV Cannula — without Wings or Port, with Hydrophobic Filter',
    category: 'line-access',
    shortDescription:
      'Wingless, portless cannula with a hydrophobic filter that prevents blood leakage and air entry.',
    description: `A sterile, single-use device for safe venous access. Its hydrophobic filter prevents blood leakage and air entry, while the wingless design allows easy insertion and enhanced patient comfort during short-term therapy.

Wingless and portless design allows easy insertion, ideal for short-term IV therapy. Sharp bevelled needle for smooth, painless venipuncture. Transparent flashback chamber enables quick visual confirmation of vein access. Materials: polypropylene (PP), PUR, and an FEP radiopaque catheter.`,
    priceInr: 1680,
    attributes: [
      EO_STERILE,
      LATEX_FREE,
      { name: 'Feature', value: 'Hydrophobic filter — prevents blood leakage and air entry', isFilterable: true },
      { name: 'Packaging', value: 'Blister pack (individual) · 20 pcs/box' },
      { name: 'Shelf life', value: '5 years from date of manufacture' },
    ],
    images: ['Image-33'],
    variants: cannulaVariants([
      { gauge: '14G', material: 'PUR', code: '3CJ314' },
      { gauge: '16G', material: 'PUR', code: '3CJ316' },
      { gauge: '18G', material: 'PUR', code: '3CJ318' },
      { gauge: '18G-L', material: 'PUR', code: '3CJ318L' },
      { gauge: '20G', material: 'PUR', code: '3CJ320' },
      { gauge: '22G', material: 'PUR', code: '3CJ322' },
      { gauge: '24G', material: 'PUR', code: '3CJ324' },
      { gauge: '26G', material: 'PUR', code: '3CJ326' },
      { gauge: '14G', material: 'FEP', code: '3CR314' },
      { gauge: '16G', material: 'FEP', code: '3CR316' },
      { gauge: '18G', material: 'FEP', code: '3CR318' },
      // Printed as 3CR118L in the catalogue, which breaks the 3CRxxx pattern
      // every other row follows. Carried verbatim rather than "corrected".
      { gauge: '18G-L', material: 'FEP', code: '3CR118L' },
      { gauge: '20G', material: 'FEP', code: '3CR320' },
      { gauge: '22G', material: 'FEP', code: '3CR322' },
      { gauge: '24G', material: 'FEP', code: '3CR324' },
      { gauge: '26G', material: 'FEP', code: '3CR326' },
    ]),
  },
  {
    sku: 'EV-SAFY-SUPER',
    name: 'Easy-Vein Safy Super Safety IV Cannula — with Wings & Injection Port',
    category: 'line-access',
    shortDescription:
      'Needle-stick safety cannula: manual needle retraction, self-activating guard, wings and injection port.',
    description: `A sterile, single-use intravenous cannula with wings and an integrated injection port, designed with a safety mechanism to prevent needle stick injuries and ensure secure, efficient venous access.

Manual needle retraction safety mechanism reduces the risk of accidental needlestick injuries. The self-activating safety guard covers the needle tip automatically after withdrawal. Injection port allows easy medication administration; flexible wings provide secure fixation and better handling control.

Polyurethane or FEP catheter with an integrated radiopaque line for X-ray visibility. Sterile, single-use design with transparent flashback chamber.`,
    priceInr: 3200,
    attributes: [
      EO_STERILE,
      LATEX_FREE,
      { name: 'Safety feature', value: 'Manual retraction with self-activating needle guard', isFilterable: true },
      { name: 'Gauge range', value: '14G – 26G', isFilterable: true },
      { name: 'Packaging', value: 'Blister pack (individual) · 100 pcs/box · 1,000 pcs/outer' },
      { name: 'Shelf life', value: '5 years from date of manufacture' },
    ],
    images: ['Image-18', 'Image-39', 'Image-16'],
    variants: cannulaVariants([
      { gauge: '14G', material: 'PUR', code: '3DF314' },
      { gauge: '16G', material: 'PUR', code: '3DF316' },
      { gauge: '18G', material: 'PUR', code: '3DF318' },
      { gauge: '18G-L', material: 'PUR', code: '3DF318L' },
      { gauge: '20G', material: 'PUR', code: '3DF320' },
      { gauge: '22G', material: 'PUR', code: '3DF322' },
      { gauge: '24G', material: 'PUR', code: '3DF324' },
      { gauge: '26G', material: 'PUR', code: '3DF326' },
      { gauge: '14G', material: 'FEP', code: '3DF114' },
      { gauge: '16G', material: 'FEP', code: '3DF116' },
      { gauge: '18G', material: 'FEP', code: '3DF118' },
      { gauge: '18G-L', material: 'FEP', code: '3DF118L' },
      { gauge: '20G', material: 'FEP', code: '3DF120' },
      { gauge: '22G', material: 'FEP', code: '3DF122' },
      { gauge: '24G', material: 'FEP', code: '3DF124' },
      { gauge: '26G', material: 'FEP', code: '3DF126' },
    ]),
  },
  {
    sku: 'EV-WIN-SAFY',
    name: 'Easy-Vein WIN Safy Super Safety IV Cannula — without Wings or Port',
    category: 'line-access',
    shortDescription:
      'Needle-stick safety cannula in a compact wingless, portless body with colour-coded safety guard.',
    description: `A sterile, single-use intravenous cannula featuring an integrated safety mechanism to prevent needle stick injuries, providing safe and reliable venous access without wings or an injection port.

Manual needle retraction safety mechanism helps reduce needlestick injuries during withdrawal. Backflow control minimises blood leakage and reduces contamination risk. The needle safety guard is colour-coded for easy identification. Polyurethane and FEP catheter with integrated radiopaque line for placement confirmation. Compact, lightweight design enables easy handling and smooth insertion.`,
    priceInr: 3050,
    attributes: [
      EO_STERILE,
      LATEX_FREE,
      { name: 'Safety feature', value: 'Manual retraction, colour-coded needle guard', isFilterable: true },
      { name: 'Gauge range', value: '18G – 26G', isFilterable: true },
      { name: 'Packaging', value: 'Blister pack (individual) · 100 pcs/box · 1,000 pcs/outer' },
      { name: 'Shelf life', value: '5 years from date of manufacture' },
    ],
    images: ['Image-39'],
    variants: cannulaVariants([
      { gauge: '18G', material: 'PUR / FEP', code: '3DG318' },
      { gauge: '18G-L', material: 'PUR / FEP', code: '3DG318L' },
      { gauge: '20G', material: 'PUR / FEP', code: '3DG320' },
      { gauge: '22G', material: 'PUR / FEP', code: '3DG322' },
      { gauge: '24G', material: 'PUR / FEP', code: '3DG324' },
      { gauge: '26G', material: 'PUR / FEP', code: '3DG326' },
    ]),
  },
  {
    sku: 'EV-CONTROL-WAY',
    name: 'Easy-Vein Control-Way Closed IV Cannula — with Extension Line & Safety Feature',
    category: 'line-access',
    shortDescription:
      'Closed-system cannula with an integrated valve, extension line, Y-connector and needle-stick safety guard.',
    description: `The SPM Closed IV Cannula is a sterile, single-use peripheral intravenous catheter designed to provide safe and leak-free intravenous access. Its integrated valve system prevents blood leakage and reduces infection and needle stick risks, ensuring safer and more efficient IV therapy.

Active safety system reduces the risk of accidental needlestick injuries. Closed infusion mode with an integrated valve prevents backflow, blood leakage and contamination. A stabilising platform provides secure fixation and improved handling during insertion, and an integrated sliding clamp enables precise flow control while helping prevent air entry and backflow.

PUR radiopaque catheter ensures flexibility, biocompatibility and clear visibility under imaging. The Y-connector carries two needle-free connectors for safe multi-line access, and the removable needle-free valve allows convenient access while maintaining a closed system.`,
    priceInr: 4500,
    attributes: [
      EO_STERILE,
      LATEX_FREE,
      { name: 'System', value: 'Closed system — integrated valve, no open blood path', isFilterable: true },
      { name: 'Safety feature', value: 'Active needle-stick safety guard', isFilterable: true },
      { name: 'Extras', value: 'Extension line, Y-connector with two needle-free connectors, sliding clamp' },
      { name: 'Packaging', value: 'Blister pack (individual) · 20 pcs/box' },
      { name: 'Shelf life', value: '5 years from date of manufacture' },
    ],
    images: ['Image-14'],
    variants: cannulaVariants([
      { gauge: '14G', material: 'PUR', code: '3AQ314' },
      { gauge: '16G', material: 'PUR', code: '3AQ316' },
      { gauge: '18G', material: 'PUR', code: '3AQ318' },
      { gauge: '20G', material: 'PUR', code: '3AQ320' },
      { gauge: '22G', material: 'PUR', code: '3AQ322' },
      { gauge: '24G', material: 'PUR', code: '3AQ324' },
      { gauge: '26G', material: 'PUR', code: '3AQ326' },
    ]),
  },

  // =========================================================================
  // LINE CONDITIONING
  // =========================================================================
  {
    sku: 'EF-SALINE',
    name: 'Easy-Flush Saline Flush Syringe — 0.9% Sodium Chloride, Prefilled',
    category: 'line-conditioning',
    shortDescription:
      'Prefilled 0.9% normal saline flush syringe for IV lines, catheters and vascular access devices.',
    description: `The Easy-Flush Syringe is a sterile, single-use medical device designed to provide safe and efficient flushing of IV lines, catheters and vascular access devices. Each syringe is prefilled with a sterile solution to ensure accurate dosage, easy use and reduced contamination risk.

Sterilised by gamma radiation for assured product sterility. Compatible with needleless connectors for safe and convenient access, and available in Luer Lock and Luer Slip tip types. Made of medical-grade polypropylene ensuring strength, durability and biocompatibility.

Easy-to-read, clearly visible numbering allows accurate dosage measurement. The plunger and barrel are size-matched for smooth movement and precise control, and the 3-ring plunger gasket design helps prevent blood reflux and ensures reliable sealing.

Supplied in a sterile blister pack or a sterile fluid-path ribbon pack, each available with or without a disinfectant cap.`,
    priceInr: 1250,
    isRecurringEligible: true,
    attributes: [
      GAMMA_STERILE,
      LATEX_FREE,
      { name: 'Solution', value: '0.9% w/v sodium chloride (normal saline)', isFilterable: true },
      { name: 'Tip', value: 'Luer Lock and Luer Slip options' },
      { name: 'Packaging', value: 'Blister pack and fluid-path ribbon pack · 40–50 pcs/box' },
      { name: 'Shelf life', value: '3 years from date of manufacture' },
      { name: 'Registration', value: 'US FDA registered & CE certified' },
    ],
    images: ['Image-23', 'Image-34'],
    variants: [
      { sku: '1BV7B3D', name: '3 ml · Blister', options: { Volume: '3 ml', Pack: 'Blister', Cap: 'Without disinfectant cap' }, priceInr: 1250 },
      { sku: '1BV7B3D DC', name: '3 ml · Blister · Disinfectant cap', options: { Volume: '3 ml', Pack: 'Blister', Cap: 'With disinfectant cap' }, priceInr: 1490 },
      { sku: '1BV7B5D', name: '5 ml · Blister', options: { Volume: '5 ml', Pack: 'Blister', Cap: 'Without disinfectant cap' }, priceInr: 1380 },
      { sku: '1BV7B5D DC', name: '5 ml · Blister · Disinfectant cap', options: { Volume: '5 ml', Pack: 'Blister', Cap: 'With disinfectant cap' }, priceInr: 1620 },
      { sku: '1BV7BXD', name: '10 ml · Blister', options: { Volume: '10 ml', Pack: 'Blister', Cap: 'Without disinfectant cap' }, priceInr: 1560 },
      { sku: '1BV7BXD DC', name: '10 ml · Blister · Disinfectant cap', options: { Volume: '10 ml', Pack: 'Blister', Cap: 'With disinfectant cap' }, priceInr: 1800 },
      { sku: '1BV7PYD', name: '20 ml · Blister', options: { Volume: '20 ml', Pack: 'Blister', Cap: 'Without disinfectant cap' }, priceInr: 1940 },
      { sku: '1BV7PYD DC', name: '20 ml · Blister · Disinfectant cap', options: { Volume: '20 ml', Pack: 'Blister', Cap: 'With disinfectant cap' }, priceInr: 2180 },
      { sku: '1BV7PZD', name: '50 ml · Blister', options: { Volume: '50 ml', Pack: 'Blister', Cap: 'Without disinfectant cap' }, priceInr: 2460 },
      { sku: '1BV7PZD DC', name: '50 ml · Blister · Disinfectant cap', options: { Volume: '50 ml', Pack: 'Blister', Cap: 'With disinfectant cap' }, priceInr: 2700 },
      { sku: '1BO7R3S', name: '3 ml · Ribbon', options: { Volume: '3 ml', Pack: 'Fluid-path ribbon', Cap: 'Without disinfectant cap' }, priceInr: 1190 },
      { sku: '1BO7R3S DC', name: '3 ml · Ribbon · Disinfectant cap', options: { Volume: '3 ml', Pack: 'Fluid-path ribbon', Cap: 'With disinfectant cap' }, priceInr: 1430 },
      { sku: '1BO7R5S', name: '5 ml · Ribbon', options: { Volume: '5 ml', Pack: 'Fluid-path ribbon', Cap: 'Without disinfectant cap' }, priceInr: 1320 },
      { sku: '1BO7R5S DC', name: '5 ml · Ribbon · Disinfectant cap', options: { Volume: '5 ml', Pack: 'Fluid-path ribbon', Cap: 'With disinfectant cap' }, priceInr: 1560 },
      { sku: '1BO7RXS', name: '10 ml · Ribbon', options: { Volume: '10 ml', Pack: 'Fluid-path ribbon', Cap: 'Without disinfectant cap' }, priceInr: 1500 },
      { sku: '1BO7RXS DC', name: '10 ml · Ribbon · Disinfectant cap', options: { Volume: '10 ml', Pack: 'Fluid-path ribbon', Cap: 'With disinfectant cap' }, priceInr: 1740 },
      { sku: '1BO7RYS', name: '20 ml · Ribbon', options: { Volume: '20 ml', Pack: 'Fluid-path ribbon', Cap: 'Without disinfectant cap' }, priceInr: 1880 },
      { sku: '1BO7RYS DC', name: '20 ml · Ribbon · Disinfectant cap', options: { Volume: '20 ml', Pack: 'Fluid-path ribbon', Cap: 'With disinfectant cap' }, priceInr: 2120 },
      { sku: '1BO7RZS', name: '50 ml · Ribbon', options: { Volume: '50 ml', Pack: 'Fluid-path ribbon', Cap: 'Without disinfectant cap' }, priceInr: 2400 },
      { sku: '1BO7RZS DC', name: '50 ml · Ribbon · Disinfectant cap', options: { Volume: '50 ml', Pack: 'Fluid-path ribbon', Cap: 'With disinfectant cap' }, priceInr: 2640 },
    ],
  },
  {
    sku: 'EF-HEPARIN',
    name: 'Easy-Flush Heparin Flush Syringe — Prefilled Heparin Sodium',
    category: 'line-conditioning',
    shortDescription:
      'Prefilled heparin sodium flush syringe in 10, 100 and 1000 IU/ml, for maintaining IV catheter patency.',
    description: `A sterile, single-use, prefilled syringe designed to maintain IV catheter patency and prevent blood clot formation. Each syringe contains a precise dose of heparin solution, ensuring accurate administration and enhanced patient safety.

Sterile and single-use: eliminates the risk of cross-contamination. Prefilled and ready to use, reducing preparation time and medication errors. Maintains catheter patency, preventing blood clot formation and occlusion in IV lines.

Accurate dosage with a precise concentration of heparin solution for reliable flushing. Smooth plunger movement allows consistent flow and easy administration. Latex-free, non-pyrogenic, tamper-evident packaging.

Concentration is colour-coded on the cap: 10 IU/ml navy, 100 IU/ml yellow, 1000 IU/ml magenta.`,
    priceInr: 2400,
    isRecurringEligible: true,
    attributes: [
      GAMMA_STERILE,
      LATEX_FREE,
      { name: 'Solution', value: 'Heparin sodium — 10, 100 or 1000 IU/ml', isFilterable: true },
      { name: 'Pyrogenicity', value: 'Non-pyrogenic' },
      { name: 'Packaging', value: 'Blister pack (individual) · 40–50 pcs/box' },
      { name: 'Shelf life', value: '3 years from date of manufacture' },
      { name: 'Registration', value: 'US FDA registered & CE certified' },
    ],
    images: ['Image-11', 'Image-30'],
    variants: [
      { sku: '1DC7B3A', name: '10 IU/ml · 3 ml', options: { Concentration: '10 IU/ml', Volume: '3 ml' }, priceInr: 2400 },
      { sku: '1DC7B5A', name: '10 IU/ml · 5 ml', options: { Concentration: '10 IU/ml', Volume: '5 ml' }, priceInr: 2560 },
      { sku: '1DC7BXA', name: '10 IU/ml · 10 ml', options: { Concentration: '10 IU/ml', Volume: '10 ml' }, priceInr: 2780 },
      { sku: '1DC7B3B', name: '100 IU/ml · 3 ml', options: { Concentration: '100 IU/ml', Volume: '3 ml' }, priceInr: 2520 },
      { sku: '1DC7B5B', name: '100 IU/ml · 5 ml', options: { Concentration: '100 IU/ml', Volume: '5 ml' }, priceInr: 2680 },
      { sku: '1DC7BXB', name: '100 IU/ml · 10 ml', options: { Concentration: '100 IU/ml', Volume: '10 ml' }, priceInr: 2900 },
      { sku: '1DC7B3C', name: '1000 IU/ml · 3 ml', options: { Concentration: '1000 IU/ml', Volume: '3 ml' }, priceInr: 2740 },
      { sku: '1DC7B5C', name: '1000 IU/ml · 5 ml', options: { Concentration: '1000 IU/ml', Volume: '5 ml' }, priceInr: 2900 },
      { sku: '1DC7BXC', name: '1000 IU/ml · 10 ml', options: { Concentration: '1000 IU/ml', Volume: '10 ml' }, priceInr: 3120 },
    ],
  },
  {
    sku: 'EF-CITRA',
    name: 'Easy-Flush Citra-Safe Sodium Citrate Flush Syringe — 4%',
    category: 'line-conditioning',
    shortDescription:
      'Prefilled 4% tri-sodium citrate flush syringe for CVC and haemodialysis catheter patency.',
    description: `A sterile, single-use, prefilled syringe designed to maintain IV catheter patency and prevent blood clot formation. Each syringe contains a precise dose of sodium citrate solution, ensuring accurate and contamination-free administration.

Intended use: prefilled syringe with tri-sodium citrate solution, intended to maintain the patency of an indwelling intravenous access device and catheters such as CVC and haemodialysis catheters. May be used following initial placement of the device in the vein, and during the medical procedure.

Sterile, single-use, prefilled syringe for safe and ready-to-use application. Accurate sodium citrate dosage ensures effective flushing and patient safety. Non-toxic, non-pyrogenic design reduces contamination risk and enhances reliability.`,
    priceInr: 2100,
    isRecurringEligible: true,
    attributes: [
      GAMMA_STERILE,
      LATEX_FREE,
      { name: 'Solution', value: '4% w/v tri-sodium citrate USP', isFilterable: true },
      { name: 'Indication', value: 'CVC and haemodialysis catheter patency', isFilterable: true },
      { name: 'Packaging', value: 'Blister pack (individual) · 40–50 pcs/box' },
      { name: 'Shelf life', value: '3 years from date of manufacture' },
    ],
    images: ['Image-42', 'Image-02'],
    variants: [
      { sku: '1DQ7B3A', name: '3 ml', options: { Volume: '3 ml' }, priceInr: 2100 },
      { sku: '1DQ7B5A', name: '5 ml', options: { Volume: '5 ml' }, priceInr: 2280 },
      { sku: '1DQ7BXA', name: '10 ml', options: { Volume: '10 ml' }, priceInr: 2520 },
    ],
  },
  {
    sku: 'EFILL-AQUA',
    name: 'Easy-Fill Aqua Prefilled Syringe with Sterile Water',
    category: 'line-conditioning',
    shortDescription:
      'Prefilled sterile water syringe for inflating the balloon of an indwelling Foley catheter.',
    description: `Sterile water is purified, non-pyrogenic and free from microbial contamination. Used for inflating Foley catheter balloons, diluting medications and other medical applications, ensuring safety and single-use sterility.

Intended use: for inflating the balloon of an indwelling Foley catheter after insertion, ensuring secure catheter placement.

Sterile, single-use, prefilled syringe ensuring safe and contamination-free use. Ready-to-use design simplifies Foley catheter balloon inflation. Clear polypropylene barrel allows easy visibility of the solution, and the leak-proof Luer lock design provides a secure and reliable connection.`,
    priceInr: 980,
    attributes: [
      GAMMA_STERILE,
      LATEX_FREE,
      { name: 'Solution', value: 'Sterile water for injection', isFilterable: true },
      { name: 'Indication', value: 'Foley catheter balloon inflation', isFilterable: true },
      { name: 'Tip', value: 'Luer lock, leak-proof' },
      { name: 'Packaging', value: 'Blister pack (individual) · 40 pcs/box' },
      { name: 'Shelf life', value: '3 years from date of manufacture' },
    ],
    images: ['Image-27', 'Image-26', 'Image-37'],
    variants: [
      { sku: '1DR7B5S', name: '5 ml', options: { Volume: '5 ml' }, priceInr: 880 },
      { sku: '1DR7BXS', name: '10 ml', options: { Volume: '10 ml' }, priceInr: 980 },
      { sku: '1DR7PYS', name: '20 ml', options: { Volume: '20 ml' }, priceInr: 1180 },
      { sku: '1DR7PZS', name: '50 ml', options: { Volume: '50 ml' }, priceInr: 1560 },
    ],
  },
  {
    sku: '1DP7BXS',
    name: 'Easy-Fill GlyceSure Prefilled Syringe with 10% Glycerine — 10 ml',
    category: 'line-conditioning',
    shortDescription:
      'Prefilled 10% glycerine Luer lock syringe for Foley catheter balloon inflation, with a closed orange cap.',
    description: `The SPM prefilled syringe with 10% glycerin solution is a sterile, single-use Luer lock syringe prefilled with 10% glycerin for inflating Foley catheter balloons. A closed orange cap ensures sterility, and the device is sterilised by gamma irradiation.

Intended use: for inflating the balloon of an indwelling Foley catheter after insertion, ensuring secure placement and reliable performance.

Sterile, single-use, prefilled syringe for safe and convenient use. Contains 10% glycerin solution for reliable Foley catheter balloon inflation. The orange Luer tip cap maintains a closed, contamination-free system, and each unit is individually packed to maintain sterility and ease of handling.`,
    priceInr: 1120,
    attributes: [
      GAMMA_STERILE,
      LATEX_FREE,
      { name: 'Solution', value: '10% glycerine solution', isFilterable: true },
      { name: 'Indication', value: 'Foley catheter balloon inflation', isFilterable: true },
      { name: 'Tip', value: 'Luer lock with closed orange cap' },
      { name: 'Packaging', value: 'Blister pack (individual) · 40 pcs/box' },
      { name: 'Shelf life', value: '3 years from date of manufacture' },
    ],
    images: ['Image-40', 'Image-17'],
    variants: [],
  },

  // =========================================================================
  // IV ADMINISTRATION SETS
  // =========================================================================
  {
    sku: 'AF-IV-SET',
    name: 'Accu-Flow IV Infusion Set',
    category: 'iv-administration-sets',
    shortDescription:
      'Gravity IV infusion set for fluid and medicine administration, in air-stop, flow-regulator and purge-filter builds.',
    description: `The infusion sets are used to administer intravenous fluid and medicines into the human circulating system by using an intravenous catheter or cannula. The IV set is used in an aseptic environment. The product is sterilised using EO (ethylene oxide) gas.

Use of the product is restricted to a qualified doctor or a paramedic. The IV infusion sets are NOT used for the administration of blood or blood-related components to the patient.

Build options across the range include an auto air-stop filter with priming filter and Y-injection site, a dial flow regulator with Y-injection port, and a purge filter with Y-injection port. All variants are vented.`,
    priceInr: 1450,
    attributes: [
      EO_STERILE,
      { name: 'Vent', value: 'Vented spike with air-vent cap' },
      { name: 'Access', value: 'Y-injection site for medication without disconnecting the line' },
      { name: 'Not for', value: 'Blood or blood-component administration' },
      { name: 'Packaging', value: 'Peel-open pouch' },
    ],
    images: ['Image-21', 'Image-25'],
    variants: [
      {
        sku: '2BPSV',
        name: 'Air Safe Elite — auto air-stop, priming filter, Y-site',
        options: { Build: 'Air Safe Elite', Features: 'Auto air-stop filter, priming filter, Y-injection site', Pack: 'Peel-open pouch' },
        priceInr: 1680,
      },
      {
        sku: 'TS/2BPSV',
        name: 'Air Safe Elite — TS pack',
        options: { Build: 'Air Safe Elite', Features: 'Auto air-stop filter, priming filter, Y-injection site', Pack: 'TS pack' },
        priceInr: 1650,
      },
      {
        sku: '2BPFV',
        name: 'Dial — flow regulator, Y-injection port',
        options: { Build: 'Dial', Features: 'Flow regulator, Y-injection port', Pack: 'Peel-open pouch' },
        priceInr: 1520,
      },
      {
        sku: '2BPPV',
        name: 'Purge — purge filter, Y-injection port',
        options: { Build: 'Purge', Features: 'Purge filter, Y-injection port', Pack: 'Peel-open pouch' },
        priceInr: 1450,
      },
    ],
  },
  {
    sku: '2CNPV',
    name: 'Accu Photo Protect Light-Resistant IV Infusion Set',
    category: 'iv-administration-sets',
    shortDescription:
      'Amber light-resistant infusion set for photosensitive solutions, with purge filter and flow regulator.',
    description: `A light-resistant (UV-shielding) infusion set for the administration of photosensitive intravenous solutions, where exposure to light would degrade the drug before it reaches the patient.

The amber drip chamber and tubing shield the fluid path along its whole length. The set carries a spike with air-vent cap, fluid filter, regulator with spike holder, flow dial regulator, Y-injection site, purge filter and male connector.

Sterilised using EO (ethylene oxide) gas. Use of the product is restricted to a qualified doctor or a paramedic.`,
    priceInr: 2150,
    attributes: [
      EO_STERILE,
      { name: 'Light protection', value: 'Amber light-resistant chamber and tubing', isFilterable: true },
      { name: 'Access', value: 'Y-injection site' },
      { name: 'Flow control', value: 'Flow dial regulator and purge filter' },
      { name: 'Packaging', value: 'Peel-open pouch' },
    ],
    images: ['Image-05', 'Image-19', 'Image-13'],
    variants: [],
  },
  {
    sku: 'AP-MV-SET',
    name: 'Accu-Pedia Measured Volume Set (Burette Set)',
    category: 'iv-administration-sets',
    shortDescription:
      'Paediatric burette set with a 60-drop/ml micro drip and a 110 ml or 150 ml measured chamber.',
    description: `The Measured Volume Set (Burette Set) is used to administer intravenous fluid and medicines into the human circulating system by using an intravenous catheter or cannula.

It is specially designed to administer a measured volume of infusion fluid to children, by gravity as well as by pressure-pump method. Equipped with a micro drip of 60 drops per ml and a burette-type chamber of 110 ml or 150 ml capacity.

The product is sterilised using EO (ethylene oxide) gas. Use of the product is restricted to a qualified doctor or a paramedic.`,
    priceInr: 2900,
    attributes: [
      EO_STERILE,
      { name: 'Drip rate', value: '60 drops per ml (micro drip)', isFilterable: true },
      { name: 'Chamber', value: '110 ml or 150 ml burette', isFilterable: true },
      { name: 'Patient group', value: 'Paediatric' },
      { name: 'Method', value: 'Gravity and pressure pump' },
    ],
    images: [],
    variants: [
      { sku: '2CRB2', name: 'Regular · 110 ml · Ribbon pack', options: { Grade: 'Regular', Chamber: '110 ml', Pack: 'Ribbon pack' }, priceInr: 2900 },
      { sku: '2CRB6', name: 'Regular · 150 ml · Ribbon pack', options: { Grade: 'Regular', Chamber: '150 ml', Pack: 'Ribbon pack' }, priceInr: 3080 },
      { sku: '2CPB1', name: 'Plus · 110 ml · Peel-open pack', options: { Grade: 'Plus', Chamber: '110 ml', Pack: 'Peel-open pack' }, priceInr: 3250 },
      { sku: '2CPB5', name: 'Plus · 150 ml · Peel-open pack', options: { Grade: 'Plus', Chamber: '150 ml', Pack: 'Peel-open pack' }, priceInr: 3430 },
      { sku: '2BKPB3', name: 'Regular · 110 ml · Peel-open pouch', options: { Grade: 'Regular', Chamber: '110 ml', Pack: 'Peel-open pouch' }, priceInr: 2960 },
      { sku: '2BKPB4', name: 'Regular · 150 ml · Peel-open pouch', options: { Grade: 'Regular', Chamber: '150 ml', Pack: 'Peel-open pouch' }, priceInr: 3140 },
      { sku: '2ACHB2', name: 'Easy Pedia · 110 ml · HM pack', options: { Grade: 'Easy Pedia', Chamber: '110 ml', Pack: 'HM pack' }, priceInr: 2740 },
      { sku: '2ACHB6', name: 'Easy Pedia · 150 ml · HM pack', options: { Grade: 'Easy Pedia', Chamber: '150 ml', Pack: 'HM pack' }, priceInr: 2920 },
    ],
  },
  {
    sku: 'ACCU-LINE-EXT',
    name: 'Accu Line Extension Line with Three-Way Stopcock',
    category: 'iv-administration-sets',
    shortDescription:
      'Sterile extension line in four lengths, plus needle-free valve builds, for extending and branching an infusion line.',
    description: `The SPM Extension Line with Three-Way Stopcock is a sterile, single-use, pyrogen-free device intended for infusion therapy.

The extension line is used to extend the infusion line during administration of IV fluid. It also provides an alternative channel for the introduction of medication to the patient, and allows connection of multiple IV lines or syringes to a single access point — enabling fluid and medication administration without additional venepunctures. One of the ports can be used for the monitoring of blood pressure or central venous pressure.

Intended for neonatal, paediatric, adolescent and adult patients receiving IV therapy, dialysis or regular infusions.`,
    priceInr: 1680,
    attributes: [
      EO_STERILE,
      { name: 'Pyrogenicity', value: 'Pyrogen-free' },
      { name: 'Lengths', value: '50, 100, 150 and 200 cm', isFilterable: true },
      { name: 'Use', value: 'Line extension, multi-line access, pressure monitoring' },
      { name: 'Packaging', value: 'Peel-open pouch' },
    ],
    images: [],
    variants: [
      { sku: '2FPPA', name: 'Extension line · 50 cm', options: { Length: '50 cm', Build: 'Extension line', Pack: 'Peel-open pouch' }, priceInr: 1380 },
      { sku: '2FPPB', name: 'Extension line · 100 cm', options: { Length: '100 cm', Build: 'Extension line', Pack: 'Peel-open pouch' }, priceInr: 1560 },
      { sku: '2FPPC', name: 'Extension line · 150 cm', options: { Length: '150 cm', Build: 'Extension line', Pack: 'Peel-open pouch' }, priceInr: 1740 },
      { sku: '2FPPD', name: 'Extension line · 200 cm', options: { Length: '200 cm', Build: 'Extension line', Pack: 'Peel-open pouch' }, priceInr: 1920 },
      { sku: '2GPNU', name: 'Needle-free valve with extension line · one way (2GPNU)', options: { Build: 'Needle-free valve, one way', Code: '2GPNU' }, priceInr: 2080 },
      { sku: '2GPND', name: 'Needle-free valve with extension line · one way (2GPND)', options: { Build: 'Needle-free valve, one way', Code: '2GPND' }, priceInr: 2080 },
      { sku: '2GPNT', name: 'Needle-free valve with extension line · one way (2GPNT)', options: { Build: 'Needle-free valve, one way', Code: '2GPNT' }, priceInr: 2080 },
    ],
  },

  // =========================================================================
  // SYRINGES & NEEDLES
  // =========================================================================
  {
    sku: 'EJ-HYPO',
    name: 'Easy-Jet Disposable Hypodermic Syringe',
    category: 'syringes',
    shortDescription:
      'Single-use hypodermic syringe from 1 to 50 ml, in Luer Lock and Luer Slip, with or without needle.',
    description: `Easy-Jet Hypodermic Syringes are designed to deliver safe, accurate and reliable drug administration across a wide range of clinical applications. Manufactured with high-quality medical-grade materials, these syringes ensure smooth plunger movement, clear barrel graduation for precise dosing, and secure needle attachment.

Clear barrel with precise graduation markings ensures accurate and consistent drug dosing. Smooth and controlled plunger movement for enhanced user comfort and ease of injection.

Secure needle attachment with Luer Lock or Luer Slip options minimises leakage and dosing errors. Available with or without a needle in multiple sizes for routine and advanced applications.`,
    priceInr: 420,
    attributes: [
      EO_STERILE,
      { name: 'Volume range', value: '1 – 50 ml', isFilterable: true },
      { name: 'Tip', value: 'Luer Lock or Luer Slip', isFilterable: true },
      { name: 'Packaging', value: 'Sterile blister pack (individual)' },
      { name: 'Shelf life', value: '5 years from date of manufacture' },
    ],
    images: ['Image-06', 'Image-45'],
    variants: [
      { sku: '1AU1B1W', name: '1 ml', options: { Volume: '1 ml', 'Qty inner/outer': '100/2000' }, priceInr: 380 },
      { sku: '1AU1B2W', name: '2 ml', options: { Volume: '2 ml', 'Qty inner/outer': '100/2000' }, priceInr: 400 },
      { sku: '1AU1B3W', name: '3 ml', options: { Volume: '3 ml', 'Qty inner/outer': '100/1000' }, priceInr: 420 },
      { sku: '1AU1B5W', name: '5 ml', options: { Volume: '5 ml', 'Qty inner/outer': '50/400' }, priceInr: 460 },
      { sku: '1AU1BXW', name: '10 ml', options: { Volume: '10 ml', 'Qty inner/outer': '50/400' }, priceInr: 520 },
      { sku: '1AU1BYW', name: '20 ml', options: { Volume: '20 ml', 'Qty inner/outer': '50/400' }, priceInr: 640 },
      { sku: '1AU1BZW', name: '50 ml', options: { Volume: '50 ml', 'Qty inner/outer': '50/400' }, priceInr: 880 },
    ],
  },
  {
    sku: 'AS-INSULIN',
    name: 'Accu-Shot / Easy-Jet+ Insulin Syringe — U-40 & U-100',
    category: 'syringes',
    shortDescription:
      'Single-use insulin syringe graduated for U-40 and U-100 insulin, with ultra-fine 29G–31G needles.',
    description: `The SPM Insulin Syringe is a plastic syringe designed for the subcutaneous injection of insulin. The Accu-Shot and Easy-Jet+ Insulin Syringe (U-40 / U-100) is a sterile, single-use syringe for accurate, safe insulin delivery.

It features clear markings for precise dosing and an ultra-fine needle for painless injection. Made from medical-grade, non-toxic materials, and compatible with U-40 and U-100 insulin.

Accurate and easy-to-read dosage markings ensure precise insulin administration. Ultra-fine, sharp needle minimises pain and tissue trauma. Polypropylene construction with smooth plunger movement for controlled, comfortable injection. A protective needle cap maintains sterility until the point of use.

Colour-coded by strength: U-100 orange/pink, U-40 red. Available in blister and multipack formats under Accu-Shot, and as a product code under Easy-Jet+.`,
    priceInr: 650,
    attributes: [
      EO_STERILE,
      { name: 'Strength', value: 'U-40 and U-100', isFilterable: true },
      { name: 'Needle', value: '29G × 12.7 mm, 30G × 8 mm, 31G × 6 mm, 31G × 8 mm', isFilterable: true },
      { name: 'Colour coding', value: 'U-100 orange/pink · U-40 red' },
      { name: 'Packaging', value: 'Blister and multipack · 100 pcs/box' },
      { name: 'Shelf life', value: '5 years from date of manufacture' },
      { name: 'Registration', value: 'US FDA registered & CE certified' },
    ],
    images: [],
    variants: [
      { sku: '1AB14', name: 'Accu-Shot · U-100 · 30G × 8 mm · Blister', options: { Brand: 'Accu-Shot', Strength: 'U-100', Needle: '30G × 8 mm', Pack: 'Blister' } },
      { sku: '1AB11', name: 'Accu-Shot · U-100 · 31G × 6 mm · Blister', options: { Brand: 'Accu-Shot', Strength: 'U-100', Needle: '31G × 6 mm', Pack: 'Blister' } },
      { sku: '1AB17', name: 'Accu-Shot · U-100 · 29G × 12.7 mm · Blister', options: { Brand: 'Accu-Shot', Strength: 'U-100', Needle: '29G × 12.7 mm', Pack: 'Blister' } },
      { sku: '1AB12', name: 'Accu-Shot · U-100 · 31G × 8 mm · Blister', options: { Brand: 'Accu-Shot', Strength: 'U-100', Needle: '31G × 8 mm', Pack: 'Blister' } },
      { sku: '1AB16', name: 'Accu-Shot · U-100 · 29G × 8 mm · Blister', options: { Brand: 'Accu-Shot', Strength: 'U-100', Needle: '29G × 8 mm', Pack: 'Blister' } },
      { sku: '1AB41', name: 'Accu-Shot · U-40 · 31G × 6 mm · Blister', options: { Brand: 'Accu-Shot', Strength: 'U-40', Needle: '31G × 6 mm', Pack: 'Blister' } },
      { sku: '1AB47', name: 'Accu-Shot · U-40 · 29G × 12.7 mm · Blister', options: { Brand: 'Accu-Shot', Strength: 'U-40', Needle: '29G × 12.7 mm', Pack: 'Blister' } },
      { sku: '1AB45', name: 'Accu-Shot · U-40 · 30G × 8 mm · Blister', options: { Brand: 'Accu-Shot', Strength: 'U-40', Needle: '30G × 8 mm', Pack: 'Blister' } },
      { sku: '1AM14', name: 'Accu-Shot · U-100 · 30G × 8 mm · Multipack', options: { Brand: 'Accu-Shot', Strength: 'U-100', Needle: '30G × 8 mm', Pack: 'Multipack' } },
      { sku: '1AM11', name: 'Accu-Shot · U-100 · 31G × 6 mm · Multipack', options: { Brand: 'Accu-Shot', Strength: 'U-100', Needle: '31G × 6 mm', Pack: 'Multipack' } },
      { sku: '1AM17', name: 'Accu-Shot · U-100 · 29G × 12.7 mm · Multipack', options: { Brand: 'Accu-Shot', Strength: 'U-100', Needle: '29G × 12.7 mm', Pack: 'Multipack' } },
      { sku: '1AM41', name: 'Accu-Shot · U-40 · 31G × 6 mm · Multipack', options: { Brand: 'Accu-Shot', Strength: 'U-40', Needle: '31G × 6 mm', Pack: 'Multipack' } },
      { sku: '1AM47', name: 'Accu-Shot · U-40 · 29G × 12.7 mm · Multipack', options: { Brand: 'Accu-Shot', Strength: 'U-40', Needle: '29G × 12.7 mm', Pack: 'Multipack' } },
      { sku: '1BM14', name: 'Easy-Jet+ · U-100 · 30G × 8 mm', options: { Brand: 'Easy-Jet+', Strength: 'U-100', Needle: '30G × 8 mm' } },
      { sku: '1BM11', name: 'Easy-Jet+ · U-100 · 31G × 6 mm', options: { Brand: 'Easy-Jet+', Strength: 'U-100', Needle: '31G × 6 mm' } },
      { sku: '1BM17', name: 'Easy-Jet+ · U-100 · 29G × 12.7 mm', options: { Brand: 'Easy-Jet+', Strength: 'U-100', Needle: '29G × 12.7 mm' } },
      { sku: '1BM41', name: 'Easy-Jet+ · U-40 · 31G × 6 mm', options: { Brand: 'Easy-Jet+', Strength: 'U-40', Needle: '31G × 6 mm' } },
      { sku: '1BM47', name: 'Easy-Jet+ · U-40 · 29G × 12.7 mm', options: { Brand: 'Easy-Jet+', Strength: 'U-40', Needle: '29G × 12.7 mm' } },
    ],
  },
  {
    sku: 'EBC-ARTERIAL',
    name: 'Easy Blood-Collect In-Line Arterial Blood Sampling Set',
    category: 'syringes',
    shortDescription:
      'Closed-system arterial sampling syringe with lithium heparin, in 1 ml and 3 ml, with a safety-needle option.',
    description: `Easy Blood-Collect In-line Arterial Sampling Set is a sterile, single-use device for safe arterial blood collection. Its closed system reduces infection and air embolism risks while maintaining arterial line patency, ensuring accurate sampling and improved patient safety.

Closed-system design minimises the risk of infection and air embolism. Enables safe and accurate arterial blood sampling without disconnecting the line, and maintains continuous arterial line patency — reducing blood loss and system contamination.

The safety-needle option carries an integrated mechanism that prevents accidental needlestick injuries, an ultra-sharp bevelled needle tip for smooth penetration, and a transparent hub allowing easy visualisation of blood or fluid flow.

Heparin loading: 1 ml ≈ 30 IU calcium-balanced lithium heparin; 3 ml ≈ 80 IU.`,
    priceInr: 3800,
    attributes: [
      GAMMA_STERILE,
      { name: 'Anticoagulant', value: 'Calcium-balanced lithium heparin — 1 ml ≈ 30 IU, 3 ml ≈ 80 IU', isFilterable: true },
      { name: 'System', value: 'Closed in-line arterial sampling', isFilterable: true },
      { name: 'Packaging', value: 'Blister pack · 100 pcs/box' },
      { name: 'Shelf life', value: '3 years from date of manufacture' },
      { name: 'Registration', value: 'US FDA registered & CE certified' },
    ],
    images: ['Image-43', 'Image-12', 'Image-29'],
    variants: [
      { sku: '1BQ9B1WL', name: '1 ml · with needle', options: { Volume: '1 ml', Needle: 'With needle', Heparin: '≈30 IU LH' }, priceInr: 3800 },
      { sku: '1BQ9B3WL', name: '3 ml · with needle', options: { Volume: '3 ml', Needle: 'With needle', Heparin: '≈80 IU LH' }, priceInr: 4050 },
      { sku: '1BQ9B3WLX', name: '3 ml · with needle (Air-Pro)', options: { Volume: '3 ml', Needle: 'With needle', Build: 'Air-Pro', Heparin: '≈80 IU LH' }, priceInr: 4280 },
      { sku: '1DBBJ', name: 'Kit · 23G safety needle', options: { Build: 'Kit', Needle: '23G safety needle' }, priceInr: 4600 },
      { sku: '1DBBN', name: 'Kit · 25G safety needle', options: { Build: 'Kit', Needle: '25G safety needle' }, priceInr: 4600 },
      { sku: '1DBBT', name: 'Kit · 27G safety needle', options: { Build: 'Kit', Needle: '27G safety needle' }, priceInr: 4600 },
    ],
  },
  {
    sku: 'SN-SAFETY',
    name: 'Safety Hypodermic Needle',
    category: 'syringes',
    shortDescription:
      'Single-use hypodermic needle with a hinged safety shield that locks over the tip after use.',
    description: `A sterile, single-use hypodermic needle fitted with a hinged safety shield. After injection the shield is folded over the needle tip with one hand and locks in place, covering the sharp before the device reaches the sharps container.

Colour-coded hub for gauge identification. Ultra-sharp bevelled tip for smooth, low-trauma penetration. Supplied with the shield in the open position, ready for use.

Supplied for use with the Easy Blood-Collect arterial sampling set and with standard Luer syringes.`,
    priceInr: 780,
    attributes: [
      EO_STERILE,
      { name: 'Safety feature', value: 'Hinged, single-handed locking needle shield', isFilterable: true },
      { name: 'Hub', value: 'Colour-coded by gauge' },
      { name: 'Packaging', value: 'Blister pack (individual)' },
    ],
    images: ['Image-09', 'Image-35', 'Image-38'],
    variants: [],
  },
];

/**
 * Everything the source documents left ambiguous. Reported rather than guessed.
 */
export const NOTES: string[] = [
  'PRICES ARE MOCK. Neither the catalogue nor any IFU contains a price. Every priceInr in this file is invented.',
  'TAX CLASS IS AN ASSUMPTION. All products are filed under GST5. Neither document states a tax treatment.',
  'IFU filenames do not match their contents — they are shifted by one position. Products were built from each document\'s own PRODUCT NAME field, not from its filename.',
  'Easy-Vein WIN 18G-L FEP is printed as 3CR118L in the catalogue, which breaks the 3CRxxx pattern of every other row in that table. Carried verbatim.',
  'Easy-Vein Control-Way: the IFU lists 3AQ314–3AQ326 (14G–26G, 7 codes); the catalogue text says 18G–24G. The IFU list was used as it is the controlled document.',
  'Accu-Pedia Measured Volume Set: the IFU variant table is column-shifted in the PDF. Model↔code pairing was inferred positionally and needs confirming before quoting.',
  'Extension line 2GPNU / 2GPND / 2GPNT all carry the identical model name "NEEDLE FREE VALVE WITH EXTENSION LINE ONE WAY" in the IFU. What distinguishes them is not stated.',
  'Accu-Flow IV Infusion Set: codes 2CDPV and 2CUPV appear in the IFU document but with no model name attached. Left out rather than invented.',
  'Easy-Fill Aqua: 1DR7PCS appears in the IFU but its volume is not stated and the code does not follow the 5S/XS/YS/ZS pattern. Left out.',
  'Hygiene (Easy Grip gloves, EASY GUARD adult diapers) and Gastro (Easy Feed Ryles, Easy Feed Infant, Easy Suction) appear in the catalogue PDF but have no IFU in Product-Description and no image. Not created.',
  'Products are set isStockTracked=false so the storefront can sell them without invented inventory-ledger entries. Turn tracking on and receive real stock when you have numbers.',
  'Flush syringes are marked recurring-eligible; that is a demo choice, not something the documents state.',
];

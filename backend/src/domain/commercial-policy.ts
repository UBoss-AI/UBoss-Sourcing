/**
 * Gloviaa Mart commercial, delivery and dispute policy - the pure rules.
 *
 * Sources, kept verbatim where they are tables:
 *   - 07 Delivery, Returns, Refunds and Dispute Administration Policy, v1.0,
 *     prepared 9 October 2026 (referred to here as "Doc 07").
 *   - 08 Commercial, Certification and Launch Approval Guide, v1.0, prepared
 *     9 October 2026 ("Doc 08").
 *
 * Both are approval drafts. Every number in this file is a PROPOSAL: it is
 * imported into a versioned commercial schedule that starts as DRAFT and only
 * takes effect when a named person adopts it with evidence (and, for money
 * held or split, the payment provider confirms it). Nothing here activates
 * anything by being imported.
 *
 * Money is BigInt minor units. Rates are integer basis points (1 bp = 0.01%).
 * Every rounding is half-up on a whole line, never on a running total.
 */

export type SalesChannel = 'B2B' | 'B2C';

// --- Basis points --------------------------------------------------------------

export const BPS_SCALE = 10_000n;

/** `amount x bps / 10000`, rounded half-up. Negative amounts round away from zero symmetrically. */
export function applyBps(amountMinor: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0) throw new RangeError('bps must be a non-negative integer');
  const product = amountMinor * BigInt(bps);
  const sign = product < 0n ? -1n : 1n;
  const abs = product * sign;
  return sign * ((abs + BPS_SCALE / 2n) / BPS_SCALE);
}

/** Share `part/whole` of `amount`, half-up. Used for proportionate reversals. */
export function proportion(amountMinor: bigint, partMinor: bigint, wholeMinor: bigint): bigint {
  if (wholeMinor <= 0n) return 0n;
  if (partMinor >= wholeMinor) return amountMinor;
  if (partMinor <= 0n) return 0n;
  return (amountMinor * partMinor * 2n + wholeMinor) / (wholeMinor * 2n);
}

// --- Doc 08 section 3: proposed category commission schedule -------------------

export interface CommissionScheduleRow {
  /** The department exactly as Doc 08 section 3 names it. */
  department: string;
  b2bBps: number;
  b2cBps: number;
  consideration: string;
}

/** Doc 08 section 3, all 25 rows, in the document's order. Proposed starting points, not verified averages. */
export const DOC08_COMMISSION_SCHEDULE: readonly CommissionScheduleRow[] = Object.freeze([
  { department: 'Medical Devices', b2bBps: 1250, b2cBps: 1500, consideration: 'Consumables baseline capital equipment quote 8 to 10%' },
  { department: 'Laboratory and Scientific', b2bBps: 1250, b2cBps: 1500, consideration: 'High-value instruments quote 8 to 10%' },
  { department: 'Industrial Supplies', b2bBps: 1000, b2cBps: 1250, consideration: 'Thin margins and quantity pricing' },
  { department: 'Tools and Hardware', b2bBps: 1250, b2cBps: 1500, consideration: 'Service and warranty support' },
  { department: 'Electrical and Lighting', b2bBps: 1250, b2cBps: 1500, consideration: 'Safety and specification handling' },
  { department: 'Electronics and Components', b2bBps: 1000, b2cBps: 1250, consideration: 'High-volume components and price competition' },
  { department: 'Computers and IT', b2bBps: 800, b2cBps: 1000, consideration: 'Hardware baseline accessories 12.5 to 15%' },
  { department: 'Phones and Communication', b2bBps: 800, b2cBps: 1000, consideration: 'Device margins accessories priced separately' },
  { department: 'Office and Stationery', b2bBps: 1250, b2cBps: 1500, consideration: 'Basket size and repeat-order efficiency' },
  { department: 'Packaging and Shipping', b2bBps: 1000, b2cBps: 1250, consideration: 'Bulk volume and freight sensitivity' },
  { department: 'Safety and Protective Equipment', b2bBps: 1250, b2cBps: 1500, consideration: 'Product risk and assurance cost' },
  { department: 'Cleaning and Hygiene', b2bBps: 1250, b2cBps: 1500, consideration: 'Handling and hazardous restrictions' },
  { department: 'Building and Construction', b2bBps: 800, b2cBps: 1000, consideration: 'Bulk goods delivered cost and breakage' },
  { department: 'Automotive and Transport', b2bBps: 1000, b2cBps: 1250, consideration: 'Fitment warranty and regulated parts' },
  { department: 'Agriculture and Gardening', b2bBps: 1000, b2cBps: 1250, consideration: 'Equipment baseline regulated inputs separately' },
  { department: 'Food Service and Catering', b2bBps: 1250, b2cBps: 1500, consideration: 'Equipment service and food-contact assurance' },
  { department: 'Furniture and Fixtures', b2bBps: 1250, b2cBps: 1500, consideration: 'Bulky returns and assembly' },
  { department: 'Home and Kitchen', b2bBps: 1250, b2cBps: 1500, consideration: 'Standard marketplace support' },
  { department: 'Clothing and Textiles', b2bBps: 1500, b2cBps: 1800, consideration: 'Sizing returns and content work' },
  { department: 'Beauty and Personal Care', b2bBps: 1500, b2cBps: 1800, consideration: 'Claims safety and traceability' },
  { department: 'Sports and Outdoors', b2bBps: 1250, b2cBps: 1500, consideration: 'Equipment risk and return handling' },
  { department: 'Toys Hobbies and Crafts', b2bBps: 1500, b2cBps: 1800, consideration: 'Child safety and test costs' },
  { department: 'Books and Media', b2bBps: 1250, b2cBps: 1500, consideration: 'Rights and low-value fulfilment' },
  { department: 'Chemicals and Raw Materials', b2bBps: 600, b2cBps: 800, consideration: 'Commodity margins hazardous specialist review' },
  { department: 'Energy and Environment', b2bBps: 800, b2cBps: 1000, consideration: 'High-value installation and warranty exposure' },
]);

/** 12.5% is a portfolio TARGET (Doc 08 section 2), never a universal product rate. */
export const PORTFOLIO_TARGET_BPS = 1250;

/**
 * The comparison key for a department name. Doc 08 writes "Laboratory and
 * Scientific" and "Toys Hobbies and Crafts"; the catalogue writes
 * "Laboratory & Scientific" and "Toys, Hobbies & Crafts". Both reduce to the
 * same key: lower case, "&" read as "and", punctuation dropped, spaces single.
 */
export function departmentKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Doc 08 department -> the stable catalogue slug seeded by
 * `seed/starter-departments.ts`. Explicit, not derived, so a renamed category
 * is a visible mismatch rather than a silent new department.
 */
export const DOC08_DEPARTMENT_SLUGS: Readonly<Record<string, string>> = Object.freeze({
  'Medical Devices': 'medical-devices',
  'Laboratory and Scientific': 'laboratory-scientific',
  'Industrial Supplies': 'industrial-supplies',
  'Tools and Hardware': 'tools-hardware',
  'Electrical and Lighting': 'electrical-lighting',
  'Electronics and Components': 'electronics-components',
  'Computers and IT': 'computers-it',
  'Phones and Communication': 'phones-communication',
  'Office and Stationery': 'office-stationery',
  'Packaging and Shipping': 'packaging-shipping',
  'Safety and Protective Equipment': 'safety-protective-equipment',
  'Cleaning and Hygiene': 'cleaning-hygiene',
  'Building and Construction': 'building-construction',
  'Automotive and Transport': 'automotive-transport',
  'Agriculture and Gardening': 'agriculture-gardening',
  'Food Service and Catering': 'food-service-catering',
  'Furniture and Fixtures': 'furniture-fixtures',
  'Home and Kitchen': 'home-kitchen',
  'Clothing and Textiles': 'clothing-textiles',
  'Beauty and Personal Care': 'beauty-personal-care',
  'Sports and Outdoors': 'sports-outdoors',
  'Toys Hobbies and Crafts': 'toys-hobbies-crafts',
  'Books and Media': 'books-media',
  'Chemicals and Raw Materials': 'chemicals-raw-materials',
  'Energy and Environment': 'energy-environment',
});

// --- Doc 08 appendix: complete public category register -------------------------

/** Doc 08 appendix, 25 departments and their 120 immediate subcategories, spelled as published. */
export const DOC08_CATEGORY_REGISTER: readonly { department: string; subcategories: readonly string[] }[] = Object.freeze([
  { department: 'Medical Devices', subcategories: ['Diagnostics & Monitoring', 'Surgical Instruments', 'Infusion & Injection', 'Patient Care & Mobility', 'Imaging & Radiology', 'Rehabilitation & Physiotherapy', 'Dental Supplies', 'Medical Furniture'] },
  { department: 'Laboratory & Scientific', subcategories: ['Lab Instruments', 'Glassware & Plasticware', 'Reagents & Chemicals', 'Consumables & Sampling', 'Measurement & Calibration'] },
  { department: 'Industrial Supplies', subcategories: ['Fasteners & Fixings', 'Bearings & Power Transmission', 'Hydraulics & Pneumatics', 'Pumps & Valves', 'Abrasives', 'Lubricants & Adhesives', 'Welding & Soldering', 'Material Handling'] },
  { department: 'Tools & Hardware', subcategories: ['Hand Tools', 'Power Tools', 'Cutting Tools', 'Measuring & Layout', 'Tool Storage'] },
  { department: 'Electrical & Lighting', subcategories: ['Cables & Wiring', 'Switches & Sockets', 'Circuit Protection', 'Motors & Drives', 'Lighting', 'Batteries & Power Supplies'] },
  { department: 'Electronics & Components', subcategories: ['Electronic Components', 'Sensors & Automation', 'Test & Measurement', 'Enclosures & Connectors'] },
  { department: 'Computers & IT', subcategories: ['Laptops & Desktops', 'Peripherals & Accessories', 'Networking', 'Storage & Media', 'Printers & Scanners', 'Software & Licences'] },
  { department: 'Phones & Communication', subcategories: ['Mobile Phones', 'Phone Accessories', 'Two-Way Radios', 'Telephony'] },
  { department: 'Office & Stationery', subcategories: ['Paper & Notebooks', 'Writing & Correction', 'Filing & Organisation', 'Office Machines', 'Printer Supplies'] },
  { department: 'Packaging & Shipping', subcategories: ['Boxes & Cartons', 'Tapes & Strapping', 'Protective Packaging', 'Bags & Films', 'Labels & Marking'] },
  { department: 'Safety & Protective Equipment', subcategories: ['Hand Protection', 'Eye & Face Protection', 'Respiratory Protection', 'Head & Fall Protection', 'Protective Clothing', 'Safety Footwear', 'Fire Safety & First Aid'] },
  { department: 'Cleaning & Hygiene', subcategories: ['Cleaning Chemicals', 'Disinfection & Sterilisation', 'Cleaning Equipment', 'Washroom Supplies', 'Waste Management'] },
  { department: 'Building & Construction', subcategories: ['Building Materials', 'Plumbing & Sanitary', 'Heating, Ventilation & Cooling', 'Paint & Surface Finishing', 'Doors, Windows & Ironmongery'] },
  { department: 'Automotive & Transport', subcategories: ['Vehicle Parts', 'Tyres & Wheels', 'Garage Equipment', 'Vehicle Care'] },
  { department: 'Agriculture & Gardening', subcategories: ['Farm Equipment', 'Irrigation', 'Seeds, Feed & Fertiliser', 'Garden Tools & Outdoor'] },
  { department: 'Food Service & Catering', subcategories: ['Commercial Kitchen Equipment', 'Tableware & Serving', 'Disposables & Takeaway', 'Food Storage & Refrigeration'] },
  { department: 'Furniture & Fixtures', subcategories: ['Office Furniture', 'Seating', 'Storage & Shelving', 'Retail Display'] },
  { department: 'Home & Kitchen', subcategories: ['Kitchenware', 'Home Appliances', 'Bedding & Bath', 'Home Decor'] },
  { department: 'Clothing & Textiles', subcategories: ['Workwear & Uniforms', 'Everyday Clothing', 'Footwear', 'Fabrics & Trims'] },
  { department: 'Beauty & Personal Care', subcategories: ['Skin & Hair Care', 'Cosmetics', 'Personal Hygiene', 'Salon & Spa Supplies'] },
  { department: 'Sports & Outdoors', subcategories: ['Fitness Equipment', 'Team Sports', 'Camping & Outdoor', 'Cycling'] },
  { department: 'Toys, Hobbies & Crafts', subcategories: ['Toys & Games', 'Craft Materials', 'Musical Instruments', 'Gifts & Party'] },
  { department: 'Books & Media', subcategories: ['Books', 'Educational Materials', 'Audio & Video'] },
  { department: 'Chemicals & Raw Materials', subcategories: ['Industrial Chemicals', 'Plastics & Polymers', 'Metals & Alloys', 'Rubber & Sealing'] },
  { department: 'Energy & Environment', subcategories: ['Solar & Renewables', 'Generators & Backup Power', 'Water Treatment', 'Air Quality'] },
]);

export interface CatalogueNode {
  name: string;
  slug: string;
  children: readonly { name: string }[];
}

export interface RegisterDifference {
  kind: 'DEPARTMENT_MISSING_IN_CATALOGUE' | 'DEPARTMENT_NOT_IN_REGISTER' | 'SUBCATEGORY_MISSING_IN_CATALOGUE' | 'SUBCATEGORY_NOT_IN_REGISTER' | 'SCHEDULE_ROW_UNMAPPED';
  department: string;
  name?: string;
}

/**
 * Compare Doc 08's register and commission schedule with the live catalogue.
 * Names are compared by `departmentKey`, so "&"/"and" and commas never count
 * as differences; anything else does. Presence is not approval.
 */
export function reconcileCategoryRegister(catalogue: readonly CatalogueNode[]): RegisterDifference[] {
  const out: RegisterDifference[] = [];
  const byKey = new Map(catalogue.map((d) => [departmentKey(d.name), d]));
  const registerKeys = new Set(DOC08_CATEGORY_REGISTER.map((d) => departmentKey(d.department)));
  for (const row of DOC08_CATEGORY_REGISTER) {
    const live = byKey.get(departmentKey(row.department));
    if (live === undefined) {
      out.push({ kind: 'DEPARTMENT_MISSING_IN_CATALOGUE', department: row.department });
      continue;
    }
    const liveKids = new Set(live.children.map((c) => departmentKey(c.name)));
    const docKids = new Set(row.subcategories.map(departmentKey));
    for (const s of row.subcategories) if (!liveKids.has(departmentKey(s))) out.push({ kind: 'SUBCATEGORY_MISSING_IN_CATALOGUE', department: row.department, name: s });
    for (const c of live.children) if (!docKids.has(departmentKey(c.name))) out.push({ kind: 'SUBCATEGORY_NOT_IN_REGISTER', department: row.department, name: c.name });
  }
  for (const d of catalogue) if (!registerKeys.has(departmentKey(d.name))) out.push({ kind: 'DEPARTMENT_NOT_IN_REGISTER', department: d.name });
  const slugs = new Set(catalogue.map((d) => d.slug));
  for (const row of DOC08_COMMISSION_SCHEDULE) {
    const slug = DOC08_DEPARTMENT_SLUGS[row.department];
    if (slug === undefined || !slugs.has(slug)) out.push({ kind: 'SCHEDULE_ROW_UNMAPPED', department: row.department });
  }
  return out;
}

// --- Commission ---------------------------------------------------------------

export interface CommissionInput {
  /** Goods price of the line before any discount, tax excluded. */
  goodsMinor: bigint;
  /** A discount the SELLER funds: it lowers the commission base. */
  sellerFundedDiscountMinor: bigint;
  /** A discount the PLATFORM funds: the seller is still owed on the full price, so it does not lower the base. */
  platformFundedDiscountMinor: bigint;
  bps: number;
}

export interface CommissionResult {
  /** Net goods value: goods less seller-funded discount. Tax, duty, freight, cargo insurance, payment pass-throughs and buyer service charges are never in it. */
  baseMinor: bigint;
  bps: number;
  commissionMinor: bigint;
  /** What the buyer pays for the goods: goods less both discounts. */
  buyerGoodsMinor: bigint;
  rounding: 'HALF_UP_PER_LINE';
}

export function commissionForLine(input: CommissionInput): CommissionResult {
  if (input.goodsMinor < 0n || input.sellerFundedDiscountMinor < 0n || input.platformFundedDiscountMinor < 0n) throw new RangeError('amounts must not be negative');
  if (input.sellerFundedDiscountMinor + input.platformFundedDiscountMinor > input.goodsMinor) throw new RangeError('discounts exceed the goods price');
  const baseMinor = input.goodsMinor - input.sellerFundedDiscountMinor;
  return {
    baseMinor,
    bps: input.bps,
    commissionMinor: applyBps(baseMinor, input.bps),
    buyerGoodsMinor: input.goodsMinor - input.sellerFundedDiscountMinor - input.platformFundedDiscountMinor,
    rounding: 'HALF_UP_PER_LINE',
  };
}

/** Doc 08 section 3: "above INR 25 lakh goods value". 25,00,000.00 INR in paise. */
export const LARGE_B2B_ORDER_THRESHOLD_MINOR = 250_000_000n;
/** Doc 08 section 3: "a management-approved floor of 5%". */
export const LARGE_B2B_ORDER_FLOOR_BPS = 500;

export interface LargeOrderBand {
  /** The negotiated rate on the incremental amount. Doc 08 gives none, so there is no default. */
  reducedBps: number;
  thresholdMinor: bigint;
  /** Management approval reference; required for any reduction. */
  approvalReference: string;
  /** Contribution-margin evidence showing the order stays positive with services recovered separately. */
  contributionEvidence: string;
}

export type LargeOrderProblem = 'NOT_B2B' | 'BELOW_FLOOR' | 'NOT_A_REDUCTION' | 'APPROVAL_MISSING' | 'CONTRIBUTION_EVIDENCE_MISSING';

export function largeOrderBandProblems(band: LargeOrderBand, standardBps: number, channel: SalesChannel): LargeOrderProblem[] {
  const out: LargeOrderProblem[] = [];
  if (channel !== 'B2B') out.push('NOT_B2B');
  if (band.reducedBps < LARGE_B2B_ORDER_FLOOR_BPS) out.push('BELOW_FLOOR');
  if (band.reducedBps >= standardBps) out.push('NOT_A_REDUCTION');
  if (band.approvalReference.trim() === '') out.push('APPROVAL_MISSING');
  if (band.contributionEvidence.trim() === '') out.push('CONTRIBUTION_EVIDENCE_MISSING');
  return out;
}

export interface TieredCommission {
  standardPortionMinor: bigint;
  reducedPortionMinor: bigint;
  standardCommissionMinor: bigint;
  reducedCommissionMinor: bigint;
  commissionMinor: bigint;
  effectiveBpsTimes100: number;
}

/**
 * Commission on a whole order's net goods with an approved large-order band:
 * the standard rate up to the threshold, the reduced rate only on the amount
 * above it - never retrospectively on the whole order. Without a valid band
 * the standard rate applies to everything.
 */
export function commissionWithLargeOrderBand(baseMinor: bigint, standardBps: number, band: LargeOrderBand | null, channel: SalesChannel): TieredCommission {
  const usable = band !== null && largeOrderBandProblems(band, standardBps, channel).length === 0 && baseMinor > band.thresholdMinor;
  const standardPortionMinor = usable ? band.thresholdMinor : baseMinor;
  const reducedPortionMinor = usable ? baseMinor - band.thresholdMinor : 0n;
  const standardCommissionMinor = applyBps(standardPortionMinor, standardBps);
  const reducedCommissionMinor = usable ? applyBps(reducedPortionMinor, band.reducedBps) : 0n;
  const commissionMinor = standardCommissionMinor + reducedCommissionMinor;
  return {
    standardPortionMinor,
    reducedPortionMinor,
    standardCommissionMinor,
    reducedCommissionMinor,
    commissionMinor,
    effectiveBpsTimes100: baseMinor === 0n ? 0 : Number((commissionMinor * 1_000_000n) / baseMinor),
  };
}

/** Portfolio rate = total commission / net goods value, in bps (half-up). */
export function portfolioRateBps(lines: readonly { baseMinor: bigint; commissionMinor: bigint }[]): number {
  const base = lines.reduce((s, l) => s + l.baseMinor, 0n);
  const fee = lines.reduce((s, l) => s + l.commissionMinor, 0n);
  if (base === 0n) return 0;
  return Number((fee * BPS_SCALE * 2n + base) / (base * 2n));
}

/** Commission reversal for a goods refund: proportionate to the goods refunded, never more than was charged. */
export function commissionReversal(input: { lineBaseMinor: bigint; lineCommissionMinor: bigint; refundedGoodsMinor: bigint; alreadyReversedMinor: bigint }): bigint {
  const due = proportion(input.lineCommissionMinor, input.refundedGoodsMinor, input.lineBaseMinor);
  const left = input.lineCommissionMinor - input.alreadyReversedMinor;
  return due > left ? (left > 0n ? left : 0n) : due;
}

// --- Logistics coordination (Doc 07 s3, Doc 08 s5) -----------------------------

export const PROPOSED_COORDINATION_BPS = 500;

export type LogisticsChargeMethod =
  | { kind: 'COST_PLUS'; bps: number; capMinor: bigint | null }
  | { kind: 'FIXED_FEE'; feeMinor: bigint; contractReference: string };

export interface CoordinationResult {
  externalCostMinor: bigint;
  coordinationMinor: bigint;
  capped: boolean;
  /** What the seller is charged: the third-party cost (reconciled separately) plus coordination. */
  totalChargedMinor: bigint;
}

/** Coordination applies to external freight and brokerage only; warehousing, pick-pack, inspection and installation are itemised elsewhere. */
export function logisticsCoordination(externalCostMinor: bigint, method: LogisticsChargeMethod): CoordinationResult {
  if (externalCostMinor < 0n) throw new RangeError('cost must not be negative');
  let coordinationMinor: bigint;
  let capped = false;
  if (method.kind === 'FIXED_FEE') {
    coordinationMinor = method.feeMinor;
  } else {
    coordinationMinor = applyBps(externalCostMinor, method.bps);
    if (method.capMinor !== null && coordinationMinor > method.capMinor) {
      coordinationMinor = method.capMinor;
      capped = true;
    }
  }
  return { externalCostMinor, coordinationMinor, capped, totalChargedMinor: externalCostMinor + coordinationMinor };
}

export const SEPARATELY_ITEMISED_SERVICES = ['WAREHOUSING', 'PICK_PACK', 'INSPECTION', 'INSTALLATION', 'PACKAGING', 'AFTER_SALES', 'EXCEPTIONAL'] as const;
export type ItemisedService = (typeof SEPARATELY_ITEMISED_SERVICES)[number];

/**
 * The same cost may be recovered once. Given every recovery of one cost
 * (buyer delivery charge, seller deduction), report the excess.
 */
export function duplicateRecoveryExcess(costMinor: bigint, recoveries: readonly bigint[]): bigint {
  const total = recoveries.reduce((s, r) => s + r, 0n);
  return total > costMinor ? total - costMinor : 0n;
}

// --- Doc 08 s3 worked example -------------------------------------------------

/** Doc 08 section 3's illustration, computed through the same functions the system uses. */
export function doc08WorkedExample() {
  const commission = commissionForLine({ goodsMinor: 10_000_000n, sellerFundedDiscountMinor: 0n, platformFundedDiscountMinor: 0n, bps: 1250 });
  const coordination = logisticsCoordination(800_000n, { kind: 'COST_PLUS', bps: PROPOSED_COORDINATION_BPS, capMinor: null });
  return {
    netGoodsMinor: commission.baseMinor,
    commissionMinor: commission.commissionMinor,
    externalCostMinor: coordination.externalCostMinor,
    coordinationMinor: coordination.coordinationMinor,
    platformChargesBeforeTaxMinor: commission.commissionMinor + coordination.coordinationMinor,
  };
}

// --- Certification recovery (Doc 08 s4) ----------------------------------------

export const PROPOSED_CERTIFICATION_RECOVERY_BPS = 100;

/**
 * The certification allocation on one order: up to `capBps` of net goods,
 * never more than what is still unrecovered after every confirmed and
 * reserved allocation. Zero once the cost is recovered.
 */
export function certificationAllocation(netGoodsMinor: bigint, capBps: number, unrecoveredMinor: bigint): bigint {
  if (unrecoveredMinor <= 0n || netGoodsMinor <= 0n) return 0n;
  const byRate = applyBps(netGoodsMinor, capBps);
  return byRate < unrecoveredMinor ? byRate : unrecoveredMinor;
}

/** Unrecovered = eligible verified cost - (confirmed + reserved - refunded) - seller credits. */
export function unrecoveredBalance(input: { eligibleCostMinor: bigint; confirmedMinor: bigint; reservedMinor: bigint; refundedMinor: bigint; creditedMinor: bigint }): bigint {
  const recovered = input.confirmedMinor + input.reservedMinor - input.refundedMinor + input.creditedMinor;
  const left = input.eligibleCostMinor - recovered;
  return left > 0n ? left : 0n;
}

// --- Cargo insurance (Doc 07 s3) ---------------------------------------------

export const PROPOSED_INSURED_VALUE_BPS = 11_000;

/** Proposed insured value: 110% of goods plus separately agreed freight. A proposal, not a requirement or a guarantee of cover. */
export function proposedInsuredValue(goodsMinor: bigint, agreedFreightMinor: bigint | null): bigint {
  return applyBps(goodsMinor, PROPOSED_INSURED_VALUE_BPS) + (agreedFreightMinor ?? 0n);
}

// --- Security (Doc 07 s10, Doc 08 s6) ------------------------------------------

export type SecurityTier = 'STANDARD' | 'HIGH_RISK';

export const SECURITY_PROPOSALS: Readonly<Record<SecurityTier, { reserveBps: number; holdDays: number; guaranteeAlternative: boolean }>> = Object.freeze({
  STANDARD: { reserveBps: 500, holdDays: 90, guaranteeAlternative: false },
  HIGH_RISK: { reserveBps: 1000, holdDays: 180, guaranteeAlternative: true },
});

/** Doc 08 s6: review quarterly, consider reduction after six months of satisfactory history. Doc 07 s10: review active holds at least monthly. */
export const SECURITY_MONTHLY_REVIEW_DAYS = 30;
export const SECURITY_QUARTERLY_REVIEW_DAYS = 91;
export const SECURITY_REDUCTION_AFTER_SATISFACTORY_MONTHS = 6;

/** Reserve to hold from one order: the rate, never pushing the running total past the cap. */
export function reserveForOrder(goodsMinor: bigint, bps: number, capMinor: bigint | null, currentlyHeldMinor: bigint): bigint {
  const byRate = applyBps(goodsMinor, bps);
  if (capMinor === null) return byRate;
  const room = capMinor - currentlyHeldMinor;
  if (room <= 0n) return 0n;
  return byRate < room ? byRate : room;
}

/** Doc 07 s10: reserves, deposits and guarantees are not stacked beyond a documented exposure. */
export function securityStackProblem(input: { reserveCapMinor: bigint; guaranteeMinor: bigint; depositMinor: bigint; documentedExposureMinor: bigint | null }): 'NO_EXPOSURE_CALCULATION' | 'EXCEEDS_EXPOSURE' | null {
  const forms = [input.reserveCapMinor, input.guaranteeMinor, input.depositMinor].filter((v) => v > 0n).length;
  if (forms <= 1) return null;
  if (input.documentedExposureMinor === null) return 'NO_EXPOSURE_CALCULATION';
  return input.reserveCapMinor + input.guaranteeMinor + input.depositMinor > input.documentedExposureMinor ? 'EXCEEDS_EXPOSURE' : null;
}

/** Monthly review: anything held above current documented exposure is excess and is proposed for release. */
export function excessHeld(heldMinor: bigint, exposureMinor: bigint): bigint {
  return heldMinor > exposureMinor ? heldMinor - exposureMinor : 0n;
}

// --- Insurance (Doc 08 s6) ----------------------------------------------------

export interface InsuranceRiskGroup {
  code: 'GROUP_1' | 'GROUP_2' | 'GROUP_3';
  description: string;
  /** USD cents. */
  productLiabilityPerOccurrenceMinor: bigint;
  productLiabilityAggregateMinor: bigint;
  recallLimitMinor: bigint;
  recallNote: string;
  securityTreatment: 'STANDARD' | 'RISK_ADJUSTED' | 'HIGH_RISK';
}

/** Doc 08 section 6 table, exact. Proposed underwriting starting limits - not legal minima or insurer quotations. */
export const DOC08_INSURANCE_RISK_GROUPS: readonly InsuranceRiskGroup[] = Object.freeze([
  {
    code: 'GROUP_1',
    description: 'Ordinary non-electrical stationery packaging and non-safety industrial goods',
    productLiabilityPerOccurrenceMinor: 100_000_000n,
    productLiabilityAggregateMinor: 200_000_000n,
    recallLimitMinor: 50_000_000n,
    recallNote: 'Recall USD 500000 where available standard risk reserve',
    securityTreatment: 'STANDARD',
  },
  {
    code: 'GROUP_2',
    description: 'Electrical goods cosmetics chemicals machinery food-contact and automotive goods',
    productLiabilityPerOccurrenceMinor: 200_000_000n,
    productLiabilityAggregateMinor: 500_000_000n,
    recallLimitMinor: 100_000_000n,
    recallNote: 'Recall USD 1 million and risk-adjusted security',
    securityTreatment: 'RISK_ADJUSTED',
  },
  {
    code: 'GROUP_3',
    description: 'Medical devices critical PPE toys children goods and safety-critical parts',
    productLiabilityPerOccurrenceMinor: 500_000_000n,
    productLiabilityAggregateMinor: 1_000_000_000n,
    recallLimitMinor: 200_000_000n,
    recallNote: 'Recall USD 2 million and high-risk security',
    securityTreatment: 'HIGH_RISK',
  },
]);

export const INSURANCE_COVER_TYPES = ['PRODUCT_LIABILITY', 'PRODUCT_RECALL', 'CARGO', 'PROFESSIONAL_INDEMNITY', 'CYBER', 'CRIME', 'WAREHOUSE_LIABILITY', 'PACKAGING_LIABILITY', 'INSTALLATION_LIABILITY', 'OTHER'] as const;
export type InsuranceCoverType = (typeof INSURANCE_COVER_TYPES)[number];

/** Doc 08 s6: Gloviaa buys these for itself; seller insurance does not cover Gloviaa's own service failures. */
export const PLATFORM_OWN_COVER_TYPES: readonly InsuranceCoverType[] = ['PROFESSIONAL_INDEMNITY', 'CYBER', 'CRIME', 'WAREHOUSE_LIABILITY', 'CARGO', 'PACKAGING_LIABILITY', 'INSTALLATION_LIABILITY'];

export interface InsurancePolicyFacts {
  verificationStatus: 'PENDING' | 'VERIFIED' | 'REJECTED';
  brokerReviewedAt: Date | null;
  insuredEntity: string;
  expiresAt: Date | null;
  perOccurrenceMinor: bigint | null;
  aggregateMinor: bigint | null;
}

/** Gaps against a proposed group. A purchased limit never approves a category - this only reports. */
export function insuranceGaps(policy: InsurancePolicyFacts, group: InsuranceRiskGroup | null, now: Date): string[] {
  const out: string[] = [];
  if (policy.verificationStatus !== 'VERIFIED') out.push('NOT_VERIFIED');
  if (policy.brokerReviewedAt === null) out.push('NO_BROKER_REVIEW');
  if (policy.insuredEntity.trim() === '') out.push('INSURED_ENTITY_MISSING');
  if (policy.expiresAt === null) out.push('EXPIRY_MISSING');
  else if (policy.expiresAt.getTime() <= now.getTime()) out.push('EXPIRED');
  if (group !== null) {
    if (policy.perOccurrenceMinor === null || policy.perOccurrenceMinor < group.productLiabilityPerOccurrenceMinor) out.push('BELOW_PROPOSED_PER_OCCURRENCE');
    if (policy.aggregateMinor === null || policy.aggregateMinor < group.productLiabilityAggregateMinor) out.push('BELOW_PROPOSED_AGGREGATE');
  }
  return out;
}

// --- Payment plan (Doc 08 s5) -------------------------------------------------

export const BESPOKE_B2B_PAYMENT_PLAN: readonly { code: string; bps: number; trigger: string }[] = Object.freeze([
  { code: 'PRODUCTION_FUNDING', bps: 3000, trigger: 'Order acceptance (production funding)' },
  { code: 'PRE_DISPATCH_ACCEPTANCE', bps: 6000, trigger: 'Agreed pre-dispatch acceptance and shipping documents' },
  { code: 'DELIVERY_OR_COMMISSIONING', bps: 1000, trigger: 'Delivery or commissioning' },
]);

/** Split an amount by milestone bps; the rounding remainder goes to the last milestone so the parts sum exactly. */
export function splitByMilestones(totalMinor: bigint, milestones: readonly { code: string; bps: number }[]): { code: string; amountMinor: bigint }[] {
  const sumBps = milestones.reduce((s, m) => s + m.bps, 0);
  if (sumBps !== 10_000) throw new RangeError('milestones must sum to 100%');
  const parts = milestones.map((m) => ({ code: m.code, amountMinor: (totalMinor * BigInt(m.bps)) / BPS_SCALE }));
  const allocated = parts.reduce((s, p) => s + p.amountMinor, 0n);
  const last = parts[parts.length - 1];
  if (last !== undefined) last.amountMinor += totalMinor - allocated;
  return parts;
}

/** The bespoke plan applies to one order only when seller, buyer and provider have all agreed. */
export function paymentPlanProblems(p: { sellerAgreedAt: Date | null; buyerAgreedAt: Date | null; providerConfirmationRef: string | null; channel: SalesChannel }): string[] {
  const out: string[] = [];
  if (p.channel !== 'B2B') out.push('NOT_B2B');
  if (p.sellerAgreedAt === null) out.push('SELLER_NOT_AGREED');
  if (p.buyerAgreedAt === null) out.push('BUYER_NOT_AGREED');
  if (p.providerConfirmationRef === null || p.providerConfirmationRef.trim() === '') out.push('PROVIDER_NOT_CONFIRMED');
  return out;
}

// --- Subscriptions and onboarding (Doc 08 s2) ----------------------------------

export const DOC08_SUBSCRIPTION_PROPOSALS = Object.freeze({
  basicLaunch: { feeMinor: 0n, currency: 'INR', period: 'YEAR' as const },
  enterprise: {
    feeMinor: 12_000_000n,
    currency: 'INR',
    period: 'YEAR' as const,
    taxExtra: true,
    optional: true,
    deliverables: ['Integration services', 'Analytics', 'Catalogue services', 'Account management'],
    cannotBuy: ['Ranking', 'Certification', 'Compliance exemptions'],
  },
  routineOnboardingIncluded: true,
  complexOnboardingSeparatelyQuoted: true,
  noRoutineTransactionFeeOnCommissionOrders: true,
});

// --- Delivery terms (Doc 07 s2, Doc 08 s5) ------------------------------------

export type DeliveryTerm = 'DAP' | 'FCA' | 'DDP' | 'DOMESTIC' | 'CONSUMER';

export interface DeliveryTermInput {
  channel: SalesChannel;
  sellerCountry: string;
  destinationCountry: string;
  /** The buyer's express election. Only FCA or DDP can be elected; DAP is the default. */
  election: 'FCA' | 'DDP' | null;
  /** FCA: the business buyer expressly elected main carriage and the election is approved for this order. */
  fcaApproved: boolean;
  /** DDP: an approved importer, tax and regulatory arrangement exists for this route. */
  ddpArrangementApproved: boolean;
}

export type DeliveryTermProblem = 'FCA_NOT_APPROVED' | 'FCA_B2C_NOT_ALLOWED' | 'DDP_ARRANGEMENT_MISSING';

/** Which delivery term applies, or why the requested one cannot. EXW is never a routine term. */
export function resolveDeliveryTerm(input: DeliveryTermInput): { term: DeliveryTerm; problems: DeliveryTermProblem[] } {
  const crossBorder = input.sellerCountry.toUpperCase() !== input.destinationCountry.toUpperCase();
  if (!crossBorder) return { term: 'DOMESTIC', problems: [] };
  if (input.channel === 'B2C') {
    if (input.election === 'FCA') return { term: 'CONSUMER', problems: ['FCA_B2C_NOT_ALLOWED'] };
    if (input.election === 'DDP') return input.ddpArrangementApproved ? { term: 'DDP', problems: [] } : { term: 'CONSUMER', problems: ['DDP_ARRANGEMENT_MISSING'] };
    return { term: 'CONSUMER', problems: [] };
  }
  if (input.election === 'FCA') return input.fcaApproved ? { term: 'FCA', problems: [] } : { term: 'DAP', problems: ['FCA_NOT_APPROVED'] };
  if (input.election === 'DDP') return input.ddpArrangementApproved ? { term: 'DDP', problems: [] } : { term: 'DAP', problems: ['DDP_ARRANGEMENT_MISSING'] };
  return { term: 'DAP', problems: [] };
}

/** Who is importer of record under each term. DDP never describes the buyer as importer. */
export function importerOfRecord(term: DeliveryTerm, channel: SalesChannel): 'BUYER' | 'SELLER' | 'APPROVED_ARRANGEMENT' | 'NOT_APPLICABLE' {
  if (term === 'DOMESTIC') return 'NOT_APPLICABLE';
  if (term === 'DDP') return 'APPROVED_ARRANGEMENT';
  if (term === 'CONSUMER') return 'APPROVED_ARRANGEMENT';
  return channel === 'B2B' ? 'BUYER' : 'APPROVED_ARRANGEMENT';
}

export interface AcceptanceControlFacts {
  sellerAccountId: string | null;
  manufacturer: string | null;
  approvedProductVersion: string | null;
  facilityRef: string | null;
  destinationCountry: string | null;
  channel: SalesChannel | null;
  importer: string | null;
  localActorsSatisfied: boolean;
  goodsPriceMinor: bigint | null;
  taxesKnown: boolean;
  deliveryTerm: DeliveryTerm | null;
  namedPlace: string | null;
  leadTimeDays: number | null;
  returnRoute: string | null;
  packagingRecorded: boolean;
  transportRestrictionsReviewed: boolean;
  insuranceDecided: boolean;
  policyVersionsRecorded: boolean;
}

/**
 * Doc 07 s1: what must be confirmed before a seller order is accepted. Payment
 * confirmation alone cannot stand in for any of these.
 */
export function acceptanceControlGaps(f: AcceptanceControlFacts): string[] {
  const out: string[] = [];
  if (f.sellerAccountId === null) out.push('SELLER');
  if (f.manufacturer === null || f.manufacturer.trim() === '') out.push('MANUFACTURER');
  if (f.approvedProductVersion === null) out.push('APPROVED_SKU_VERSION');
  if (f.facilityRef === null) out.push('APPROVED_FACILITY');
  if (f.destinationCountry === null) out.push('COUNTRY');
  if (f.channel === null) out.push('CHANNEL');
  if (f.deliveryTerm !== 'DOMESTIC' && (f.importer === null || f.importer === '')) out.push('IMPORTER');
  if (!f.localActorsSatisfied) out.push('LOCAL_ACTORS');
  if (f.goodsPriceMinor === null) out.push('PRICE');
  if (!f.taxesKnown) out.push('TAXES');
  if (f.deliveryTerm === null) out.push('DELIVERY_TERM');
  if (f.deliveryTerm !== null && f.deliveryTerm !== 'DOMESTIC' && (f.namedPlace === null || f.namedPlace.trim().length < 6)) out.push('NAMED_PLACE');
  if (f.leadTimeDays === null) out.push('LEAD_TIME');
  if (f.returnRoute === null || f.returnRoute.trim() === '') out.push('RETURN_ROUTE');
  if (!f.packagingRecorded) out.push('PACKAGING');
  if (!f.transportRestrictionsReviewed) out.push('TRANSPORT_RESTRICTIONS');
  if (!f.insuranceDecided) out.push('INSURANCE');
  if (!f.policyVersionsRecorded) out.push('POLICY_VERSIONS');
  return out;
}

// --- Dispatch (Doc 07 s5) ----------------------------------------------------

export interface DispatchFacts {
  paymentReady: boolean;
  inspectionPassed: boolean;
  requiredDocumentsValid: boolean;
  eligibilityCurrent: boolean;
  quantitiesRecorded: boolean;
  lotsOrSerialsRecorded: boolean;
  lotTrackingRequired: boolean;
  sealsRecorded: boolean;
  packingPhotosRecorded: boolean;
  custodyHandoverRecorded: boolean;
  temperatureRequired: boolean;
  temperatureEvidenceRecorded: boolean;
  handlingRequirementsMet: boolean;
  safetyHold: boolean;
}

export function dispatchGaps(f: DispatchFacts): string[] {
  const out: string[] = [];
  if (f.safetyHold) out.push('SAFETY_HOLD');
  if (!f.paymentReady) out.push('PAYMENT_NOT_READY');
  if (!f.inspectionPassed) out.push('INSPECTION_NOT_PASSED');
  if (!f.requiredDocumentsValid) out.push('DOCUMENTS_NOT_VALID');
  if (!f.eligibilityCurrent) out.push('ELIGIBILITY_NOT_CURRENT');
  if (!f.quantitiesRecorded) out.push('QUANTITIES');
  if (f.lotTrackingRequired && !f.lotsOrSerialsRecorded) out.push('LOTS_OR_SERIALS');
  if (!f.sealsRecorded) out.push('SEALS');
  if (!f.packingPhotosRecorded) out.push('PACKING_PHOTOS');
  if (!f.custodyHandoverRecorded) out.push('CUSTODY_HANDOVER');
  if (f.temperatureRequired && !f.temperatureEvidenceRecorded) out.push('TEMPERATURE_EVIDENCE');
  if (!f.handlingRequirementsMet) out.push('HANDLING_REQUIREMENTS');
  return out;
}

/** Partial shipment: explicit order approval, proportionate billing, and never past a no-partial-release assessment rule. */
export function partialShipmentProblems(p: { orderApprovalRef: string | null; assessmentForbidsPartial: boolean; shippedQuantity: number; orderedQuantity: number }): string[] {
  const out: string[] = [];
  if (p.orderApprovalRef === null || p.orderApprovalRef.trim() === '') out.push('ORDER_APPROVAL_MISSING');
  if (p.assessmentForbidsPartial) out.push('ASSESSMENT_NO_PARTIAL_RELEASE');
  if (p.shippedQuantity <= 0 || p.shippedQuantity >= p.orderedQuantity) out.push('NOT_A_PARTIAL_QUANTITY');
  return out;
}

export const HANDLING_REQUIREMENT_KINDS = ['DANGEROUS_GOODS', 'LITHIUM_BATTERY', 'WOOD_PACKAGING', 'TEMPERATURE_CONTROL'] as const;
export type HandlingRequirementKind = (typeof HANDLING_REQUIREMENT_KINDS)[number];

/** Doc 07 s4 export/import documents tracked per shipment. */
export const CUSTOMS_DOCUMENT_KINDS = [
  'COMMERCIAL_INVOICE',
  'PACKING_LIST',
  'ORIGIN_EVIDENCE',
  'EXPORT_LICENCE',
  'IMPORT_LICENCE',
  'CLASSIFICATION',
  'VALUATION',
  'TRANSPORT_DOCUMENT',
  'BROKER_AUTHORITY',
  'CUSTOMS_RELEASE',
] as const;
export type CustomsDocumentKind = (typeof CUSTOMS_DOCUMENT_KINDS)[number];

/** Doc 07 s3: freight quotes. A material commitment needs two comparable quotes, or a recorded reason for one. */
export function quoteSelectionProblems(q: { materialCommitment: boolean; comparableQuotes: number; singleSourceReason: string | null }): string[] {
  if (!q.materialCommitment) return q.comparableQuotes === 0 ? ['NO_QUOTE'] : [];
  if (q.comparableQuotes >= 2) return [];
  if (q.singleSourceReason !== null && q.singleSourceReason.trim().length >= 10) return [];
  return [q.comparableQuotes === 0 ? 'NO_QUOTE' : 'SECOND_QUOTE_OR_REASON_REQUIRED'];
}

/** Doc 07 s3: what a logistics provider is screened for. */
export const PROVIDER_REVIEW_ITEMS = ['LICENCES', 'COVERAGE', 'TERRITORY', 'SANCTIONS', 'COMPETENCE', 'FINANCIAL_SOUNDNESS', 'INSURANCE', 'CLAIMS_HISTORY', 'DATA_PROTECTION', 'SUBCONTRACTOR_CONTROLS'] as const;
export type ProviderReviewItem = (typeof PROVIDER_REVIEW_ITEMS)[number];

// --- Cases (Doc 07 s6-s8) ----------------------------------------------------

/** Doc 07 s7: triaged separately. */
export const CASE_CATEGORIES = ['FRAUD', 'SAFETY', 'DEFECT', 'SHORTAGE', 'TRANSIT_LOSS', 'WRONG_ITEM', 'DELAY', 'IMPORT_FAILURE', 'CANCELLATION', 'WARRANTY', 'INSTALLATION', 'SERVICE_BREACH'] as const;
export type CaseCategory = (typeof CASE_CATEGORIES)[number];

/** Categories whose rights an administrative window never extinguishes; late intake is accepted for review. */
export const RIGHTS_PRESERVED_CATEGORIES: ReadonlySet<CaseCategory> = new Set(['SAFETY', 'DEFECT', 'WARRANTY', 'FRAUD']);

/** The existing claim reason code each category files under (the published dispute contract is unchanged). */
export const CATEGORY_REASON_CODE: Readonly<Record<CaseCategory, string>> = Object.freeze({
  FRAUD: 'OTHER',
  SAFETY: 'QUALITY',
  DEFECT: 'QUALITY',
  SHORTAGE: 'SHORT_QUANTITY',
  TRANSIT_LOSS: 'NOT_RECEIVED',
  WRONG_ITEM: 'NOT_AS_DESCRIBED',
  DELAY: 'NOT_RECEIVED',
  IMPORT_FAILURE: 'OTHER',
  CANCELLATION: 'OTHER',
  WARRANTY: 'QUALITY',
  INSTALLATION: 'OTHER',
  SERVICE_BREACH: 'OTHER',
});

/** Doc 07 s8 remedies. */
export const REMEDY_KINDS = ['CORRECTION', 'REPAIR', 'REPLACEMENT', 'MISSING_QUANTITY_DELIVERY', 'PRICE_ADJUSTMENT', 'RETURN', 'REFUND', 'SERVICE_REPERFORMANCE', 'SETTLEMENT_HOLD', 'LISTING_SUSPENSION'] as const;
export type RemedyKind = (typeof REMEDY_KINDS)[number];

/** Remedies that move money and therefore need an amount. */
export const MONEY_REMEDIES: ReadonlySet<RemedyKind> = new Set(['PRICE_ADJUSTMENT', 'REFUND']);

export type ClockUnit = 'HOURS' | 'CALENDAR_DAYS' | 'BUSINESS_DAYS';
export type ClockStart = 'RECEIPT' | 'DELIVERY' | 'CASE_CREATED' | 'SELLER_NOTIFIED' | 'EVIDENCE_SUFFICIENT' | 'DECISION' | 'APPEAL_FILED';

export interface AdministrativeWindow {
  key: string;
  label: string;
  amount: number;
  unit: ClockUnit;
  startsAt: ClockStart;
  rightsPreserved: string;
}

/** Doc 07 s6 table and s8 targets, exact. Administrative targets - none extinguishes a legal right. */
export const DOC07_ADMINISTRATIVE_WINDOWS: readonly AdministrativeWindow[] = Object.freeze([
  { key: 'ACKNOWLEDGEMENT', label: 'Acknowledge a case', amount: 1, unit: 'BUSINESS_DAYS', startsAt: 'CASE_CREATED', rightsPreserved: 'Ordinarily within one business day' },
  { key: 'VISIBLE_DAMAGE_OR_SHORTAGE', label: 'Visible package damage or shortage', amount: 48, unit: 'HOURS', startsAt: 'RECEIPT', rightsPreserved: 'Latent defect statutory and safety claims remain' },
  { key: 'B2B_QUANTITY_OR_SPECIFICATION', label: 'Apparent quantity or specification issue B2B', amount: 7, unit: 'CALENDAR_DAYS', startsAt: 'RECEIPT', rightsPreserved: 'Agreed technical acceptance and warranty remain' },
  { key: 'GENERAL_CLAIM', label: 'General platform claim', amount: 30, unit: 'CALENDAR_DAYS', startsAt: 'DELIVERY', rightsPreserved: 'No limit on applicable legal rights' },
  { key: 'VOLUNTARY_RETURN', label: 'Voluntary eligible return', amount: 14, unit: 'CALENDAR_DAYS', startsAt: 'DELIVERY', rightsPreserved: 'Broader country withdrawal rights prevail' },
  { key: 'SELLER_RESPONSE', label: 'Seller ordinary response', amount: 72, unit: 'HOURS', startsAt: 'SELLER_NOTIFIED', rightsPreserved: 'Urgent and legal deadlines may be shorter' },
  { key: 'INITIAL_DECISION', label: 'Platform initial decision', amount: 7, unit: 'CALENDAR_DAYS', startsAt: 'EVIDENCE_SUFFICIENT', rightsPreserved: 'Complex matters receive regular updates' },
  { key: 'APPEAL_SUBMISSION', label: 'Administrative appeal', amount: 7, unit: 'CALENDAR_DAYS', startsAt: 'DECISION', rightsPreserved: 'Courts regulators and payment rights remain' },
  { key: 'APPEAL_REVIEW', label: 'Independent appeal review', amount: 10, unit: 'BUSINESS_DAYS', startsAt: 'APPEAL_FILED', rightsPreserved: 'Target where practical' },
]);

export interface BusinessCalendar {
  timeZone: string;
  /** Local dates (YYYY-MM-DD) that are not business days. Empty until a deployment records its holidays. */
  holidays: readonly string[];
}

export const DEFAULT_CASE_CALENDAR: BusinessCalendar = Object.freeze({ timeZone: 'Asia/Kolkata', holidays: [] });

function localParts(instant: Date, timeZone: string): { ymd: string; weekday: number } {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
  const parts: Record<string, string> = {};
  for (const p of f.formatToParts(instant)) if (p.type !== 'literal') parts[p.type] = p.value;
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { ymd: `${parts['year']}-${parts['month']}-${parts['day']}`, weekday: weekdays[parts['weekday'] ?? 'Sun'] ?? 0 };
}

export function isBusinessDay(instant: Date, calendar: BusinessCalendar): boolean {
  const { ymd, weekday } = localParts(instant, calendar.timeZone);
  return weekday !== 0 && weekday !== 6 && !calendar.holidays.includes(ymd);
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Add business days in the calendar's zone, keeping the time of day. Steps in whole days, so a zone with no DST (the default) is exact. */
export function addBusinessDaysIn(start: Date, days: number, calendar: BusinessCalendar): Date {
  let t = start.getTime();
  let left = days;
  while (left > 0) {
    t += DAY_MS;
    if (isBusinessDay(new Date(t), calendar)) left -= 1;
  }
  return new Date(t);
}

export function windowDeadline(window: Pick<AdministrativeWindow, 'amount' | 'unit'>, clockStart: Date, calendar: BusinessCalendar): Date {
  if (window.unit === 'HOURS') return new Date(clockStart.getTime() + window.amount * HOUR_MS);
  if (window.unit === 'CALENDAR_DAYS') return new Date(clockStart.getTime() + window.amount * DAY_MS);
  return addBusinessDaysIn(clockStart, window.amount, calendar);
}

export function windowByKey(key: string, windows: readonly AdministrativeWindow[] = DOC07_ADMINISTRATIVE_WINDOWS): AdministrativeWindow {
  const w = windows.find((x) => x.key === key);
  if (w === undefined) throw new RangeError(`unknown window ${key}`);
  return w;
}

export type IntakeOutcome = { kind: 'ON_TIME' } | { kind: 'LATE_ACCEPTED_FOR_REVIEW'; window: string; reason: 'RIGHTS_PRESERVED' | 'STATUTORY_BASIS' | 'TECHNICAL_ACCEPTANCE' } | { kind: 'LATE_REFUSED'; window: string };

/**
 * Doc 07 s6: windows are service and evidence targets. A late safety, defect,
 * warranty or fraud report - or any report the buyer says rests on a
 * statutory right, or an agreed longer technical acceptance - is taken in and
 * reviewed; it is never refused automatically.
 */
export function classifyIntake(input: { category: CaseCategory; deliveredAt: Date | null; now: Date; channel: SalesChannel; statutoryBasis: boolean; technicalAcceptanceUntil: Date | null; calendar?: BusinessCalendar; windows?: readonly AdministrativeWindow[] }): IntakeOutcome {
  if (input.deliveredAt === null) return { kind: 'ON_TIME' };
  const windows = input.windows ?? DOC07_ADMINISTRATIVE_WINDOWS;
  const calendar = input.calendar ?? DEFAULT_CASE_CALENDAR;
  const key = input.category === 'SHORTAGE' || input.category === 'TRANSIT_LOSS' ? (input.channel === 'B2B' ? 'B2B_QUANTITY_OR_SPECIFICATION' : 'GENERAL_CLAIM') : 'GENERAL_CLAIM';
  const deadline = windowDeadline(windowByKey(key, windows), input.deliveredAt, calendar);
  if (input.now.getTime() <= deadline.getTime()) return { kind: 'ON_TIME' };
  if (input.technicalAcceptanceUntil !== null && input.now.getTime() <= input.technicalAcceptanceUntil.getTime()) return { kind: 'LATE_ACCEPTED_FOR_REVIEW', window: key, reason: 'TECHNICAL_ACCEPTANCE' };
  if (RIGHTS_PRESERVED_CATEGORIES.has(input.category)) return { kind: 'LATE_ACCEPTED_FOR_REVIEW', window: key, reason: 'RIGHTS_PRESERVED' };
  if (input.statutoryBasis) return { kind: 'LATE_ACCEPTED_FOR_REVIEW', window: key, reason: 'STATUTORY_BASIS' };
  return { kind: 'LATE_REFUSED', window: key };
}

/** Appeal independence (Doc 07 s8): the reviewer took no part in the decision under appeal. */
export function isIndependentAppealReviewer(reviewerUserId: string, decisionParticipants: readonly (string | null)[]): boolean {
  return !decisionParticipants.some((p) => p !== null && p === reviewerUserId);
}

/** A decision is reasoned only when it names the amounts, who pays return freight, expected completion and the appeal route. */
export function reasonedDecisionProblems(d: { reasoning: string; remedies: readonly { kind: RemedyKind; amountMinor: bigint | null; payer: string | null }[]; returnFreightPayer: string | null; expectedCompletionAt: Date | null; aiGenerated: boolean }): string[] {
  const out: string[] = [];
  if (d.aiGenerated) out.push('AI_ONLY_DECISION');
  if (d.reasoning.trim().length < 20) out.push('REASONING_MISSING');
  if (d.remedies.length === 0) out.push('REMEDY_MISSING');
  for (const r of d.remedies) {
    if (MONEY_REMEDIES.has(r.kind) && (r.amountMinor === null || r.amountMinor <= 0n)) out.push(`AMOUNT_MISSING:${r.kind}`);
    if (r.payer === null) out.push(`PAYER_MISSING:${r.kind}`);
  }
  if (d.remedies.some((r) => r.kind === 'RETURN') && d.returnFreightPayer === null) out.push('RETURN_FREIGHT_PAYER_MISSING');
  if (d.expectedCompletionAt === null) out.push('EXPECTED_COMPLETION_MISSING');
  return out;
}

// --- Refund status (Doc 07 s9) -------------------------------------------------

export type RefundDisplayState = 'REQUESTED' | 'SUBMITTED' | 'PENDING_PROVIDER' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

/** The words a person sees for a refund. A provider-pending refund is never shown as complete. */
export function refundDisplayState(status: 'REQUESTED' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED', providerRefundId: string | null): RefundDisplayState {
  if (status === 'REQUESTED') return 'REQUESTED';
  if (status === 'PROCESSING') return providerRefundId === null ? 'SUBMITTED' : 'PENDING_PROVIDER';
  return status;
}

/** Overlapping recoveries of one loss (chargeback, refund, carrier, insurer): the excess to investigate. Never blocks a lawful remedy. */
export function recoveryOverlap(lossMinor: bigint, recoveries: readonly { source: string; amountMinor: bigint }[]): { excessMinor: bigint; sources: string[] } {
  const total = recoveries.reduce((s, r) => s + r.amountMinor, 0n);
  return { excessMinor: total > lossMinor ? total - lossMinor : 0n, sources: [...new Set(recoveries.map((r) => r.source))] };
}

// --- Certification governance (Doc 08 s7-s10) -----------------------------------

export const TRADING_APPROVAL_MONTHS = 12;
export const HIGH_RISK_SURVEILLANCE_MONTHS = 6;
export const EXPIRY_ALERT_DAYS: readonly number[] = [90, 60, 30];

export type SixMonthSurveillance = 'ALL' | 'CONDITIONAL' | 'NONE';

export interface AssuranceRow {
  department: string;
  triggers: string;
  surveillance: string;
  sixMonth: SixMonthSurveillance;
}

/** Doc 08 section 8, all 25 rows. Reviewer prompts - not a claim that every product needs every named item. */
export const DOC08_ASSURANCE_MATRIX: readonly AssuranceRow[] = Object.freeze([
  { department: 'Medical Devices', triggers: 'Indian licence and intended-use classification FDA market route and annual registration EU MDR or IVDR route notified body when required local actors technical and clinical evidence', surveillance: 'Six-month surveillance annual trading renewal actual certificate and registration deadlines prevail', sixMonth: 'ALL' },
  { department: 'Laboratory and Scientific', triggers: 'Distinguish IVD medical use from general laboratory use electrical safety calibration chemical and reagent requirements', surveillance: 'Six-month for IVD chemicals safety equipment otherwise annual review', sixMonth: 'CONDITIONAL' },
  { department: 'Industrial Supplies', triggers: 'Material performance pressure machinery compatibility traceability and chemical-content assessment where relevant', surveillance: 'Annual review six-month for pressure or safety-critical goods', sixMonth: 'CONDITIONAL' },
  { department: 'Tools and Hardware', triggers: 'Mechanical and powered-tool safety guards electrical and battery transport issues where relevant', surveillance: 'Annual review six-month powered or critical equipment sampling', sixMonth: 'CONDITIONAL' },
  { department: 'Electrical and Lighting', triggers: 'Applicable EU electrical EMC RoHS or other route US applicable safety and RF requirements battery and hazardous transport evidence', surveillance: 'Six-month surveillance annual approval and change retesting', sixMonth: 'ALL' },
  { department: 'Electronics and Components', triggers: 'RF EMC restricted materials safety criticality firmware and component traceability', surveillance: 'Six-month for RF or safety-critical otherwise annual', sixMonth: 'CONDITIONAL' },
  { department: 'Computers and IT', triggers: 'Electrical RF batteries data security licences and rights approved support and software patch route', surveillance: 'Annual review six-month for high-risk hardware changes', sixMonth: 'CONDITIONAL' },
  { department: 'Phones and Communication', triggers: 'FCC authorisation where applicable EU radio route lawful frequency use batteries and local operator compatibility', surveillance: 'Six-month surveillance design and radio changes trigger review', sixMonth: 'ALL' },
  { department: 'Office and Stationery', triggers: "Material composition inks mechanical risks children's use and printer electrical requirements as relevant", surveillance: 'Annual review new formulation or intended use triggers tests', sixMonth: 'NONE' },
  { department: 'Packaging and Shipping', triggers: 'Strength hazardous-goods suitability food contact recycled claims and timber packaging rules where relevant', surveillance: 'Annual review six-month food-contact or dangerous-goods packaging', sixMonth: 'CONDITIONAL' },
  { department: 'Safety and Protective Equipment', triggers: 'Product-specific EU PPE assessment and notified-body route where required US relevant occupational or medical requirements verified safety performance', surveillance: 'Six-month surveillance certificate and critical-material change checks', sixMonth: 'ALL' },
  { department: 'Cleaning and Hygiene', triggers: 'Intended claims distinguish cleaner cosmetic biocide disinfectant pesticide or medical sterilant chemical and label route', surveillance: 'Six-month chemicals disinfection and sterilisation otherwise annual', sixMonth: 'CONDITIONAL' },
  { department: 'Building and Construction', triggers: 'Product-specific construction performance structural fire plumbing HVAC electrical and country requirements', surveillance: 'Six-month safety-critical annual ordinary fixtures', sixMonth: 'CONDITIONAL' },
  { department: 'Automotive and Transport', triggers: 'Safety-critical part approvals applicable US or European vehicle rules fitment tyres batteries and traceability', surveillance: 'Six-month safety-critical annual noncritical accessories', sixMonth: 'CONDITIONAL' },
  { department: 'Agriculture and Gardening', triggers: 'Machinery safety seed plant feed fertiliser pesticide and phytosanitary import routes where applicable', surveillance: 'Six-month controlled inputs annual ordinary garden hardware', sixMonth: 'CONDITIONAL' },
  { department: 'Food Service and Catering', triggers: 'Electrical gas refrigeration and food-contact materials route identify whether any actual food is supplied', surveillance: 'Six-month food-contact and refrigeration annual other tableware', sixMonth: 'CONDITIONAL' },
  { department: 'Furniture and Fixtures', triggers: "Structural stability fire upholstery chemical emissions and children's intended use rules where relevant", surveillance: 'Annual review six-month child or institutional safety-critical goods', sixMonth: 'CONDITIONAL' },
  { department: 'Home and Kitchen', triggers: 'Appliance safety food-contact materials textiles warnings batteries and consumer traceability', surveillance: 'Annual review six-month powered or food-contact products', sixMonth: 'CONDITIONAL' },
  { department: 'Clothing and Textiles', triggers: 'Fibre composition labels flammability chemical limits child-use and protective claims', surveillance: "Annual review six-month protective or children's products", sixMonth: 'CONDITIONAL' },
  { department: 'Beauty and Personal Care', triggers: 'Cosmetic versus drug classification MoCRA applicability EU responsible-person safety file notifications claims and ingredients', surveillance: 'Six-month surveillance annual product check biennial US facility renewal where applicable', sixMonth: 'ALL' },
  { department: 'Sports and Outdoors', triggers: "Structural and injury risks protective claims e-bikes batteries and children's intended use", surveillance: 'Annual review six-month protective high-load or powered equipment', sixMonth: 'CONDITIONAL' },
  { department: 'Toys Hobbies and Crafts', triggers: 'Age grading US CPC and accepted-lab tests where required EU toy route chemical and small-parts risks distinguish ordinary craft items', surveillance: 'Six-month surveillance periodic tests and material-change review per law', sixMonth: 'ALL' },
  { department: 'Books and Media', triggers: "Publication distribution copyright territorial rights accessibility and children's physical-product risks", surveillance: 'Annual rights and scope review format or territorial changes reviewed', sixMonth: 'NONE' },
  { department: 'Chemicals and Raw Materials', triggers: 'Chemical identity SDS TSCA REACH CLP dangerous-goods restricted substances and intended end use route', surveillance: 'Six-month surveillance shipment checks and formulation change review', sixMonth: 'ALL' },
  { department: 'Energy and Environment', triggers: 'Solar electrical batteries generator emissions pressure water-contact and installation local approvals', surveillance: 'Six-month surveillance and installation competency review', sixMonth: 'ALL' },
]);

/** Surveillance interval: six months where the matrix says so for every item, or where a reviewer marked the SKU high-risk under a conditional row. */
export function surveillanceIntervalMonths(row: AssuranceRow | undefined, reviewerMarkedHighRisk: boolean): number {
  if (row === undefined) return TRADING_APPROVAL_MONTHS;
  if (row.sixMonth === 'ALL') return HIGH_RISK_SURVEILLANCE_MONTHS;
  if (row.sixMonth === 'CONDITIONAL' && reviewerMarkedHighRisk) return HIGH_RISK_SURVEILLANCE_MONTHS;
  return TRADING_APPROVAL_MONTHS;
}

export const PRODUCT_EVIDENCE_KINDS = ['MANAGEMENT_SYSTEM_CERTIFICATE', 'PRODUCT_CERTIFICATE', 'TEST_REPORT', 'DECLARATION_OF_CONFORMITY', 'REGISTRATION', 'MARKETING_AUTHORISATION', 'LICENCE', 'OTHER'] as const;
export type ProductEvidenceKind = (typeof PRODUCT_EVIDENCE_KINDS)[number];

/**
 * What a piece of evidence may be described as. An ISO quality-system
 * certificate is not product approval; an FDA registration is not marketing
 * authorisation; a test report covers the tested version only.
 */
export const EVIDENCE_LIMITS: Readonly<Record<ProductEvidenceKind, string>> = Object.freeze({
  MANAGEMENT_SYSTEM_CERTIFICATE: 'Covers a quality management system, not each product.',
  PRODUCT_CERTIFICATE: 'Covers the products and scope named on the certificate only.',
  TEST_REPORT: 'Evidence for the tested version and conditions only; no generic annual validity.',
  DECLARATION_OF_CONFORMITY: 'The manufacturer’s own declaration under the named legislation; not every route uses a third party.',
  REGISTRATION: 'A registration is not product approval or marketing authorisation.',
  MARKETING_AUTHORISATION: 'Separate from facility registration; check its own scope and conditions.',
  LICENCE: 'Covers the activity and scope named on the licence.',
  OTHER: 'Describe exactly what it proves.',
});

export type ProductEvidenceStatus = 'UNVERIFIED' | 'VERIFIED' | 'SUSPENDED' | 'WITHDRAWN' | 'EXPIRED' | 'REJECTED';

/** Evidence that is required for trading blocks purchase and dispatch the moment it is withdrawn, suspended or past a recorded expiry - no job needed. */
export function evidenceBlocksTrading(e: { requiredForTrading: boolean; status: ProductEvidenceStatus; expiresOn: Date | null }, now: Date): boolean {
  if (!e.requiredForTrading) return false;
  if (e.status !== 'VERIFIED') return true;
  return e.expiresOn !== null && e.expiresOn.getTime() <= now.getTime();
}

// --- Country launch (Doc 08 s10-s11) -------------------------------------------

export interface LaunchDecisionDef {
  key: string;
  title: string;
  /** Doc section the decision comes from. */
  source: string;
  owner: string;
  expires: boolean;
  /** Official sources cited by the document; a reviewer verifies them and records the date. */
  citedSources: readonly string[];
}

/** Doc 08 section 11, every decision, plus the section 10 regulatory and tax reviews it requires before checkout. */
export const DOC08_LAUNCH_DECISIONS: readonly LaunchDecisionDef[] = Object.freeze([
  { key: 'COMPANY_AND_CONTACTS', title: 'Registered company details, notices, grievance, privacy, safety and return contacts', source: 'Doc 08 s11.1; Doc 07 s11-12', owner: 'Legal', expires: false, citedSources: [] },
  { key: 'SIGNED_SCHEDULES', title: 'Seller, buyer and partner signature schedules complete', source: 'Doc 08 s11.1', owner: 'Legal', expires: false, citedSources: [] },
  { key: 'SELLER_ELIGIBILITY', title: 'Seller-only manufacturer and brand-owner policy, turnover calculation and Indian manufacturing scope approved', source: 'Doc 08 s11.2', owner: 'Assurance', expires: false, citedSources: [] },
  { key: 'COUNTRY_SKU_ROUTES', title: 'Country selected and each product regulatory and tax route approved, with qualified local actors', source: 'Doc 08 s11.3', owner: 'Regulatory', expires: true, citedSources: [] },
  { key: 'SELLER_DISCLOSURE_AND_ACCEPTANCE', title: 'Actual seller disclosure, goods invoicing, limited agency and order acceptance configured; payment-confirmation wording reconciled', source: 'Doc 08 s11.4', owner: 'Product', expires: false, citedSources: [] },
  { key: 'CERTIFICATION_BODIES', title: 'Independent bodies appointed; scheme accreditation, scope, surveillance, costs and certificate claims approved', source: 'Doc 08 s11.5', owner: 'Assurance', expires: true, citedSources: ['https://iaf.nu/iaf_system/uploads/documents/IAF_MD5_Issue_4_Version_3_14062023.pdf'] },
  { key: 'COMMERCIAL_SCHEDULES', title: 'Commission tiers, logistics charge, certification-recovery formula, caps, refund treatment and optional subscriptions accepted', source: 'Doc 08 s11.6', owner: 'Finance', expires: false, citedSources: [] },
  { key: 'PAYMENT_PERMISSIONS', title: 'Regulated payment partner appointed; settlement, reserve, milestone and export-proceeds handling confirmed in writing; mandates executed', source: 'Doc 08 s11.7, s5', owner: 'Finance', expires: true, citedSources: ['https://rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=12896'] },
  { key: 'LOGISTICS_AND_BROKERS', title: 'Logistics, warehouses, customs brokers, installers and after-sales providers appointed with service levels, insurance and recall cooperation', source: 'Doc 08 s11.8', owner: 'Operations', expires: true, citedSources: [] },
  { key: 'INSURANCE', title: 'Broker-reviewed insurance and approved separate security where reserves are not permitted', source: 'Doc 08 s11.9, s6', owner: 'Finance', expires: true, citedSources: [] },
  { key: 'LEGAL_REVIEW', title: 'Governing law and dispute seat adopted after legal review; consumer protections kept separate', source: 'Doc 08 s11.10', owner: 'Legal', expires: false, citedSources: [] },
  { key: 'CONSUMER_DISCLOSURES', title: 'Country-specific consumer, seller, buyer, delivery, privacy and safety disclosures published with versioned acceptance', source: 'Doc 08 s11.11', owner: 'Legal', expires: false, citedSources: ['https://europa.eu/youreurope/business/selling-in-eu/selling-goods-services/ecommerce-distance-selling/index_en.htm', 'https://www.ftc.gov/legal-library/browse/rules/mail-internet-or-telephone-order-merchandise-rule'] },
  { key: 'LAUNCH_TESTS', title: 'Test cases run: expired approval, unsafe product, split seller invoice, delayed shipment, cancellation, return, chargeback, AI false positive, recall, recurring-order revalidation', source: 'Doc 08 s11.12; Doc 07 s12', owner: 'Operations', expires: false, citedSources: [] },
  { key: 'TAX_INVOICING_DECISION', title: 'Country-specific tax and invoicing decision', source: 'Doc 08 s10 (Tax and customs approval)', owner: 'Tax', expires: true, citedSources: [] },
  { key: 'EU_VAT_DEEMED_SUPPLIER_IOSS', title: 'EU VAT: deemed-supplier assessment, low-value imports, EU-warehoused goods, IOSS or other registrations (EU destinations)', source: 'Doc 08 s10', owner: 'Tax', expires: true, citedSources: ['https://taxation-customs.ec.europa.eu/system/files/2020-12/vatecommerceexplanatory_28102020_en.pdf', 'https://taxation-customs.ec.europa.eu/taxation/vat/vat-directive/vat-exemptions/other-exemptions_en'] },
  { key: 'US_MARKETPLACE_TAX_AND_CUSTOMS', title: 'US: state marketplace-facilitator sales tax, CBP entry route and de minimis status at shipment (no automatic USD 800 assumption)', source: 'Doc 08 s10', owner: 'Tax', expires: true, citedSources: ['https://www.help.cbp.gov/s/article/Article-1919?language=en_US'] },
  { key: 'INDIA_TAX_EXPORT_RECONCILIATION', title: 'India: GST withholding, collection, invoicing and export-proceeds reconciliation with the authorised-dealer bank', source: 'Doc 08 s10', owner: 'Tax', expires: true, citedSources: ['https://consumeraffairs.gov.in/public/upload/files/E%20commerce%20rules_1732703966.pdf'] },
  { key: 'PRODUCT_OBLIGATIONS', title: 'Relevant product obligations reviewed per SKU and country (e.g. GPSR economic operator, DSA traceability, INFORM, CPSC, FDA, MoCRA, TSCA, FCC)', source: 'Doc 08 s9-10, s13', owner: 'Regulatory', expires: true, citedSources: ['https://eur-lex.europa.eu/legal-content/EN/TXT/PDF/?uri=CELEX%3A32023R0988', 'https://eur-lex.europa.eu/legal-content/EN/TXT/?qid=1681822313059&uri=CELEX%3A32022R2065', 'https://www.ftc.gov/legal-library/browse/statutes/inform-consumers-act'] },
  { key: 'EU_FULFILMENT_ROLE', title: 'EU: whether warehousing, packaging, addressing or dispatch makes Gloviaa a fulfilment service provider or responsible economic operator', source: 'Doc 07 s4', owner: 'Regulatory', expires: true, citedSources: ['https://eur-lex.europa.eu/legal-content/EN-SL/TXT/?from=EN&uri=CELEX%3A32019R1020'] },
]);

/** EU decisions apply only to EU destinations; the US and India decisions only to theirs. */
export function launchDecisionsFor(countryCode: string, isEu: boolean): LaunchDecisionDef[] {
  const cc = countryCode.toUpperCase();
  return DOC08_LAUNCH_DECISIONS.filter((d) => {
    if (d.key === 'EU_VAT_DEEMED_SUPPLIER_IOSS' || d.key === 'EU_FULFILMENT_ROLE') return isEu;
    if (d.key === 'US_MARKETPLACE_TAX_AND_CUSTOMS') return cc === 'US';
    if (d.key === 'INDIA_TAX_EXPORT_RECONCILIATION') return cc === 'IN';
    return true;
  });
}

export type ReadinessStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'NOT_APPLICABLE';

/** Why a country cannot be enabled: every applicable decision approved by someone other than its owner, current, with evidence. */
export function launchBlockers(items: readonly { key: string; status: ReadinessStatus; evidence: string | null; expiresAt: Date | null; reviewerUserId: string | null; ownerUserId: string | null }[], required: readonly LaunchDecisionDef[], now: Date): { key: string; reason: string }[] {
  const out: { key: string; reason: string }[] = [];
  for (const def of required) {
    const item = items.find((i) => i.key === def.key);
    if (item === undefined) out.push({ key: def.key, reason: 'NOT_STARTED' });
    else if (item.status === 'NOT_APPLICABLE') {
      if (item.reviewerUserId === null) out.push({ key: def.key, reason: 'NOT_APPLICABLE_UNREVIEWED' });
    } else if (item.status !== 'APPROVED') out.push({ key: def.key, reason: item.status });
    else if (item.evidence === null || item.evidence.trim() === '') out.push({ key: def.key, reason: 'EVIDENCE_MISSING' });
    else if (item.reviewerUserId === null || item.reviewerUserId === item.ownerUserId) out.push({ key: def.key, reason: 'NOT_INDEPENDENTLY_REVIEWED' });
    else if (def.expires && (item.expiresAt === null || item.expiresAt.getTime() <= now.getTime())) out.push({ key: def.key, reason: item.expiresAt === null ? 'EXPIRY_MISSING' : 'EXPIRED' });
  }
  return out;
}

// --- Versioned commercial schedules -------------------------------------------

export const SCHEDULE_KINDS = ['COMMISSION', 'LARGE_ORDER_DISCOUNT', 'LOGISTICS_CHARGE', 'CERTIFICATION_RECOVERY', 'SECURITY', 'INSURANCE', 'PAYMENT_PLAN', 'SUBSCRIPTION', 'CASE_WINDOWS'] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

export type ScheduleStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'ACTIVE' | 'RETIRED';

/** Kinds that hold or split money and so need the payment provider's written confirmation before activation. */
export const PROVIDER_CONFIRMATION_KINDS: ReadonlySet<ScheduleKind> = new Set(['SECURITY', 'PAYMENT_PLAN', 'CERTIFICATION_RECOVERY']);

export interface ScheduleFacts {
  kind: ScheduleKind;
  status: ScheduleStatus;
  preparedById: string | null;
  approvedById: string | null;
  approvalEvidence: string | null;
  scheduleReference: string | null;
  effectiveFrom: Date | null;
  providerConfirmationRef: string | null;
}

/** Why a schedule cannot be activated. Activation is always a person's act; nothing activates on its own. */
export function activationProblems(s: ScheduleFacts, activatorId: string): string[] {
  const out: string[] = [];
  if (s.status !== 'APPROVED') out.push('NOT_APPROVED');
  if (s.approvedById === null) out.push('APPROVER_MISSING');
  if (s.approvedById !== null && s.approvedById === s.preparedById) out.push('APPROVER_IS_PREPARER');
  if (s.approvalEvidence === null || s.approvalEvidence.trim() === '') out.push('APPROVAL_EVIDENCE_MISSING');
  if (s.scheduleReference === null || s.scheduleReference.trim() === '') out.push('SIGNED_SCHEDULE_REFERENCE_MISSING');
  if (s.effectiveFrom === null) out.push('EFFECTIVE_DATE_MISSING');
  if (PROVIDER_CONFIRMATION_KINDS.has(s.kind) && (s.providerConfirmationRef === null || s.providerConfirmationRef.trim() === '')) out.push('PROVIDER_CONFIRMATION_MISSING');
  if (activatorId === s.preparedById) out.push('ACTIVATOR_IS_PREPARER');
  return out;
}

/** The DRAFT body each kind is seeded with, straight from the documents. */
export function draftScheduleBody(kind: ScheduleKind): unknown {
  switch (kind) {
    case 'COMMISSION':
      return {
        portfolioTargetBps: PORTFOLIO_TARGET_BPS,
        base: 'NET_GOODS_AFTER_SELLER_FUNDED_DISCOUNTS',
        excludes: ['TAX', 'DUTY', 'FREIGHT', 'CARGO_INSURANCE', 'PAYMENT_PASS_THROUGH', 'BUYER_SERVICE_CHARGES'],
        reversesOnRefund: 'PROPORTIONATE',
        rows: DOC08_COMMISSION_SCHEDULE.map((r) => ({ ...r, categorySlug: DOC08_DEPARTMENT_SLUGS[r.department] ?? null })),
      };
    case 'LARGE_ORDER_DISCOUNT':
      return { thresholdMinor: LARGE_B2B_ORDER_THRESHOLD_MINOR.toString(), currency: 'INR', floorBps: LARGE_B2B_ORDER_FLOOR_BPS, reducedBps: null, appliesTo: 'INCREMENTAL_AMOUNT_ONLY', requires: ['MANAGEMENT_APPROVAL', 'CONTRIBUTION_EVIDENCE'] };
    case 'LOGISTICS_CHARGE':
      return { method: 'COST_PLUS', bps: PROPOSED_COORDINATION_BPS, capMinor: null, capScope: 'ORDER_OR_LANE', appliesTo: ['EXTERNAL_FREIGHT', 'BROKERAGE'], separatelyItemised: SEPARATELY_ITEMISED_SERVICES, fixedFeeAlternative: true, proposedInsuredValueBps: PROPOSED_INSURED_VALUE_BPS };
    case 'CERTIFICATION_RECOVERY':
      return { capBps: PROPOSED_CERTIFICATION_RECOVERY_BPS, base: 'NET_GOODS', cap: 'DOCUMENTED_UNRECOVERED_ELIGIBLE_COST', displayedBeforePurchase: true, initialFunder: 'MARKETPLACE' };
    case 'SECURITY':
      return { proposals: SECURITY_PROPOSALS, monthlyReviewDays: SECURITY_MONTHLY_REVIEW_DAYS, quarterlyReviewDays: SECURITY_QUARTERLY_REVIEW_DAYS, reductionAfterSatisfactoryMonths: SECURITY_REDUCTION_AFTER_SATISFACTORY_MONTHS, noStackingWithoutExposure: true, noAutomaticForfeiture: true };
    case 'INSURANCE':
      return { groups: DOC08_INSURANCE_RISK_GROUPS.map((g) => ({ ...g, productLiabilityPerOccurrenceMinor: g.productLiabilityPerOccurrenceMinor.toString(), productLiabilityAggregateMinor: g.productLiabilityAggregateMinor.toString(), recallLimitMinor: g.recallLimitMinor.toString(), currency: 'USD' })), platformOwnCover: PLATFORM_OWN_COVER_TYPES };
    case 'PAYMENT_PLAN':
      return { milestones: BESPOKE_B2B_PAYMENT_PLAN, appliesTo: 'APPROVED_BESPOKE_B2B_ORDERS_ONLY', requires: ['SELLER_AGREEMENT', 'BUYER_AGREEMENT', 'PROVIDER_CONFIRMATION'] };
    case 'SUBSCRIPTION':
      return { ...DOC08_SUBSCRIPTION_PROPOSALS, basicLaunch: { ...DOC08_SUBSCRIPTION_PROPOSALS.basicLaunch, feeMinor: '0' }, enterprise: { ...DOC08_SUBSCRIPTION_PROPOSALS.enterprise, feeMinor: DOC08_SUBSCRIPTION_PROPOSALS.enterprise.feeMinor.toString() } };
    case 'CASE_WINDOWS':
      return { windows: DOC07_ADMINISTRATIVE_WINDOWS, calendar: DEFAULT_CASE_CALENDAR };
  }
}

/** The proposed rate for a department slug and channel, from a schedule body. */
export function scheduledRateBps(body: { rows?: readonly { categorySlug: string | null; b2bBps: number; b2cBps: number }[] }, departmentSlug: string, channel: SalesChannel): number | null {
  const row = body.rows?.find((r) => r.categorySlug === departmentSlug);
  if (row === undefined) return null;
  return channel === 'B2B' ? row.b2bBps : row.b2cBps;
}

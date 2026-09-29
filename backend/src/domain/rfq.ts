/**
 * Requests for quotation: the vocabulary and the pure rules.
 *
 * Nothing here reads the database. It says what a requirement is made of,
 * which of its fields are material, how a quantity is written, and which
 * Incoterms need the buyer to name a destination - so the service, the tests
 * and the documentation all read one list.
 *
 * QUANTITIES ARE DECIMAL STRINGS
 *
 * A buyer asks for 20 tonnes, 2.5 kilometres or 12,000 pieces. A quantity is
 * therefore a decimal with up to three places, carried as a string on the wire
 * and as `Decimal(15,3)` in the database, and multiplied into money only by
 * `lineTotalMinor` below - integer arithmetic on thousandths, rounded half-up
 * once, at the end. Never a float.
 */
import { INCOTERMS } from './packaging.js';

export { INCOTERMS };

/** How a quantity is counted. The storefront translates each one. */
export const RFQ_UNITS_OF_MEASURE = Object.freeze([
  'PIECE',
  'PAIR',
  'SET',
  'BOX',
  'CARTON',
  'PALLET',
  'ROLL',
  'KILOGRAM',
  'TONNE',
  'LITRE',
  'METRE',
  'SQUARE_METRE',
  'CUBIC_METRE',
] as const);
export type RfqUnitOfMeasure = (typeof RFQ_UNITS_OF_MEASURE)[number];

/** Whether the buyer wants a sample, and when. */
export const RFQ_SAMPLE_REQUIREMENTS = Object.freeze([
  'NONE',
  'WITH_QUOTE',
  'BEFORE_ORDER',
] as const);
export type RfqSampleRequirement = (typeof RFQ_SAMPLE_REQUIREMENTS)[number];

/** Who checks the goods before they ship. */
export const RFQ_INSPECTION_REQUIREMENTS = Object.freeze([
  'NONE',
  'SUPPLIER_QC_REPORT',
  'THIRD_PARTY_PRE_SHIPMENT',
  'BUYER_VISIT',
] as const);
export type RfqInspectionRequirement = (typeof RFQ_INSPECTION_REQUIREMENTS)[number];

/**
 * Incoterms under which the seller's price includes carriage to a place the
 * BUYER names - the C and D groups. Quoting CIF without a port is quoting
 * nothing, so these need a destination port or address before submission.
 */
export const INCOTERMS_NEEDING_DESTINATION: readonly string[] = Object.freeze([
  'CPT',
  'CIP',
  'CFR',
  'CIF',
  'DAP',
  'DPU',
  'DDP',
]);

export const RFQ_LIMITS = Object.freeze({
  titleMax: 200,
  specificationMax: 20_000,
  specsMax: 40,
  specKeyMax: 80,
  specValueMax: 400,
  certificationsMax: 15,
  certificationMax: 80,
  addressMax: 500,
  portMax: 120,
  notesMax: 5_000,
  /** Sellers a buyer may hand-pick or exclude on a draft. */
  selectionMax: 50,
});

/** Up to 12 digits, then up to three decimals. Positive. */
const QUANTITY_PATTERN = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,3})?$/;

/** Whether `value` is a quantity this module will accept: positive, ≤ 3 dp. */
export function isQuantity(value: string): boolean {
  return QUANTITY_PATTERN.test(value) && quantityThousandths(value) > 0n;
}

/** A quantity in thousandths, exactly. `'2.5'` is 2500n. */
export function quantityThousandths(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 1000n + BigInt((fraction + '000').slice(0, 3));
}

/** The canonical string of a quantity: no trailing zeros. `'12.500'` is `'12.5'`. */
export function normaliseQuantity(value: string): string {
  const thousandths = quantityThousandths(value);
  const whole = thousandths / 1000n;
  const fraction = (thousandths % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return fraction.length === 0 ? whole.toString() : `${whole.toString()}.${fraction}`;
}

/** Compare two quantities. Negative, zero or positive, like a sort comparator. */
export function compareQuantities(a: string, b: string): number {
  const left = quantityThousandths(a);
  const right = quantityThousandths(b);
  return left === right ? 0 : left < right ? -1 : 1;
}

/**
 * Unit price times quantity, in minor units, rounded half-up once.
 *
 * The one place an RFQ multiplies money by a quantity. Rounding the product
 * rather than the unit price keeps "12.5 tonnes at €401.37" honest to the cent.
 */
export function lineTotalMinor(unitPriceMinor: bigint, quantity: string): bigint {
  const product = unitPriceMinor * quantityThousandths(quantity);
  const quotient = product / 1000n;
  const remainder = product % 1000n;
  return remainder * 2n >= 1000n ? quotient + 1n : quotient;
}

/** A key/value line of the structured specification. */
export interface RfqSpecLine {
  key: string;
  value: string;
}

/**
 * The requirement a seller quotes against: every field a buyer fills in on the
 * request form, in one shape. Snapshotted into each requirement version.
 */
export interface RfqRequirement {
  categoryId: string | null;
  title: string;
  specification: string | null;
  specs: RfqSpecLine[];
  quantity: string | null;
  unitOfMeasure: string | null;
  annualVolume: string | null;
  targetUnitPriceMinor: string | null;
  targetCurrency: string | null;
  destinationCountry: string | null;
  destinationAddress: string | null;
  destinationPort: string | null;
  incoterm: string | null;
  certifications: string[];
  sampleRequirement: string;
  inspectionRequirement: string;
  /** ISO 8601, UTC. */
  responseDeadline: string | null;
  /** YYYY-MM-DD. */
  deliveryTargetDate: string | null;
  notes: string | null;
}

/** The fields a seller would price differently. Every one of them. */
export const REQUIREMENT_FIELDS: readonly (keyof RfqRequirement)[] = Object.freeze([
  'categoryId',
  'title',
  'specification',
  'specs',
  'quantity',
  'unitOfMeasure',
  'annualVolume',
  'targetUnitPriceMinor',
  'targetCurrency',
  'destinationCountry',
  'destinationAddress',
  'destinationPort',
  'incoterm',
  'certifications',
  'sampleRequirement',
  'inspectionRequirement',
  'responseDeadline',
  'deliveryTargetDate',
  'notes',
]);

/**
 * Which fields differ between two requirements.
 *
 * Every field counts. "Material" is not ours to judge on the buyer's behalf:
 * a changed title can change what a seller thinks is being asked for, so a
 * submitted request never changes without a new, visible version.
 */
export function changedRequirementFields(
  before: RfqRequirement,
  after: RfqRequirement,
): (keyof RfqRequirement)[] {
  return REQUIREMENT_FIELDS.filter(
    (field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]),
  );
}

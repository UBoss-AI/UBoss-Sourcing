/**
 * Bulk packaging: what is in a carton, a pallet and a container, and the
 * arithmetic that turns a package count into a base-unit count.
 *
 * THE ONE INVARIANT
 *
 * Quantity is always base units. `resolveSellUnitQuantity` in
 * `ordering-unit.ts` already turns "how many of the thing the buyer chose"
 * into "how many pieces get stored", and this file does not replace it - it
 * supplies the `SellUnitSpec` for a package, so a pallet goes down exactly the
 * path a carton and a piece already go down. There is one quantity engine, and
 * it is the one that was already there.
 *
 * WHAT IS DERIVED AND WHAT IS STATED
 *
 *   cartons per pallet  = cartons per layer x layers
 *   units per pallet    = cartons per pallet x units per carton
 *   units per container = pallets x cartons per pallet x units per carton
 *                         (pallet-loaded)
 *                       = cartons per container x units per carton
 *                         (carton-loaded)
 *
 * A seller may override the final figure, because a real pallet is not always
 * a tidy multiple - a top layer is short, a corner takes a spacer. The derived
 * figure is kept beside the override and both are shown, because "the
 * arithmetic says 1,200 and the seller says 1,150" is a question asked during
 * a dispute and it has to have an answer.
 *
 * WHAT THIS IS NOT
 *
 * A packing optimiser. Nothing here works out how many cartons fit on a
 * pallet. The seller states it and this multiplies. Every capacity figure in
 * `CONTAINER_PRESETS` is GUIDANCE printed beside the seller's own number, and
 * is described as such on every screen that draws it: internal dimensions and
 * maximum payload differ by build, by carrier and by the individual box, and a
 * seller who promises a figure off a table will one day be unable to load it.
 *
 * NOTHING HERE TOUCHES MONEY IN A JS NUMBER. Package prices are `bigint` minor
 * units throughout, like every other amount in this system.
 */
import { ErrorCode, badRequest } from './errors.js';
import type { SellUnitSpec } from './ordering-unit.js';

// ---------------------------------------------------------------------------
// The vocabulary, mirrored from the schema
// ---------------------------------------------------------------------------

export type PackageType = 'CARTON' | 'UK_PALLET' | 'US_PALLET' | 'CONTAINER';

export type PalletStandardName = 'UK_1200_1000' | 'US_1219_1016';

export type ContainerTypeName = 'DRY_20GP' | 'DRY_40GP' | 'HIGH_CUBE_40HC' | 'CUSTOM';

export type ContainerLoadModeName = 'FCL' | 'LCL';

export type ContainerLoadingMethodName = 'PALLET_LOADED' | 'CARTON_LOADED' | 'CUSTOM';

export type DimensionUnitName = 'MM' | 'CM' | 'M' | 'IN';

export type WeightUnitName = 'G' | 'KG' | 'LB';

export type PackagingOptionStateName = 'DRAFT' | 'INCOMPLETE' | 'ACTIVE' | 'DISABLED';

export type PackagingPriceModeName = 'PER_PACKAGE' | 'DERIVED_FROM_UNIT' | 'FREIGHT_QUOTE';

/** Every package type, in the order a buyer's selector shows them. */
export const PACKAGE_TYPES: readonly PackageType[] = [
  'CARTON',
  'UK_PALLET',
  'US_PALLET',
  'CONTAINER',
] as const;

/** The `OrderingUnit` member a package type is recorded as on a line. */
const ORDERING_UNIT_BY_PACKAGE: Record<PackageType, 'CARTON' | 'UK_PALLET' | 'US_PALLET' | 'CONTAINER'> = {
  CARTON: 'CARTON',
  UK_PALLET: 'UK_PALLET',
  US_PALLET: 'US_PALLET',
  CONTAINER: 'CONTAINER',
};

/**
 * The line's unit for a package type.
 *
 * A function rather than the map directly, so no caller can mutate the table
 * that decides what an order line says it was.
 */
export function orderingUnitForPackage(packageType: PackageType): 'CARTON' | 'UK_PALLET' | 'US_PALLET' | 'CONTAINER' {
  return ORDERING_UNIT_BY_PACKAGE[packageType];
}

/** The package type a bulk `OrderingUnit` member came from, or null. */
export function packageTypeForOrderingUnit(unit: string): PackageType | null {
  return unit === 'CARTON' || unit === 'UK_PALLET' || unit === 'US_PALLET' || unit === 'CONTAINER'
    ? unit
    : null;
}

/** Whether a package type is a pallet, either standard. */
export function isPalletPackage(packageType: PackageType): boolean {
  return packageType === 'UK_PALLET' || packageType === 'US_PALLET';
}

/** The pallet standard a package type implies, or null for a non-pallet. */
export function palletStandardFor(packageType: PackageType): PalletStandardName | null {
  if (packageType === 'UK_PALLET') return 'UK_1200_1000';
  if (packageType === 'US_PALLET') return 'US_1219_1016';
  return null;
}

// ---------------------------------------------------------------------------
// Presets. FOOTPRINTS AND GUIDANCE - never capacities.
// ---------------------------------------------------------------------------

export interface PalletFootprint {
  standard: PalletStandardName;
  /** Nominal footprint, millimetres. */
  lengthMm: number;
  widthMm: number;
  /** The same figures in the units the region actually quotes them in. */
  label: string;
}

/**
 * The two pallet footprints, and the ONLY thing a preset supplies.
 *
 * Height, loaded weight, cartons per layer, layers and safe working load are
 * the seller's, per variant, because a pallet of gauze and a pallet of saline
 * have the two floor dimensions in common and nothing else.
 */
export const PALLET_FOOTPRINTS: Readonly<Record<PalletStandardName, PalletFootprint>> = {
  UK_1200_1000: {
    standard: 'UK_1200_1000',
    lengthMm: 1200,
    widthMm: 1000,
    label: '1200 x 1000 mm',
  },
  US_1219_1016: {
    standard: 'US_1219_1016',
    lengthMm: 1219,
    widthMm: 1016,
    label: '1219 x 1016 mm (48 x 40 in)',
  },
} as const;

export interface ContainerPreset {
  type: ContainerTypeName;
  /** The trade's own name for it. */
  label: string;
  /**
   * Nominal internal dimensions, millimetres. GUIDANCE.
   *
   * Every one of these varies by manufacturer and by the age of the box. They
   * are here so a seller filling the form has a starting point, and they are
   * labelled as nominal wherever they are shown. Nothing computes a capacity
   * from them.
   */
  nominalInternalLengthMm: number | null;
  nominalInternalWidthMm: number | null;
  nominalInternalHeightMm: number | null;
  /** Nominal maximum payload, grams. GUIDANCE, for the same reason. */
  nominalMaxPayloadGrams: number | null;
  /** Nominal internal volume, cubic centimetres. GUIDANCE. */
  nominalVolumeCm3: number | null;
}

/**
 * Container equipment, as a starting point for the form.
 *
 * READ THE `nominal` PREFIX ON EVERY FIELD. These are not capacities and are
 * never presented as ones. A carrier's own equipment list overrides them, the
 * seller's configured figure overrides that, and where the two disagree the
 * seller's is the one the system uses - they are the one who has to get the
 * doors shut.
 *
 * `CUSTOM` carries nothing, on purpose: a seller describing their own
 * equipment is telling us we have no table for it.
 */
export const CONTAINER_PRESETS: Readonly<Record<ContainerTypeName, ContainerPreset>> = {
  DRY_20GP: {
    type: 'DRY_20GP',
    label: "20' Standard Dry (20GP)",
    nominalInternalLengthMm: 5898,
    nominalInternalWidthMm: 2352,
    nominalInternalHeightMm: 2393,
    nominalMaxPayloadGrams: 28_200_000,
    nominalVolumeCm3: 33_200_000,
  },
  DRY_40GP: {
    type: 'DRY_40GP',
    label: "40' Standard Dry (40GP)",
    nominalInternalLengthMm: 12_032,
    nominalInternalWidthMm: 2352,
    nominalInternalHeightMm: 2393,
    nominalMaxPayloadGrams: 26_700_000,
    nominalVolumeCm3: 67_700_000,
  },
  HIGH_CUBE_40HC: {
    type: 'HIGH_CUBE_40HC',
    label: "40' High Cube (40HC)",
    nominalInternalLengthMm: 12_032,
    nominalInternalWidthMm: 2352,
    nominalInternalHeightMm: 2698,
    nominalMaxPayloadGrams: 26_460_000,
    nominalVolumeCm3: 76_300_000,
  },
  CUSTOM: {
    type: 'CUSTOM',
    label: 'Custom container',
    nominalInternalLengthMm: null,
    nominalInternalWidthMm: null,
    nominalInternalHeightMm: null,
    nominalMaxPayloadGrams: null,
    nominalVolumeCm3: null,
  },
} as const;

// ---------------------------------------------------------------------------
// Units in, canonical units out
// ---------------------------------------------------------------------------

/**
 * Length multipliers onto millimetres, as an exact rational.
 *
 * A rational rather than a float because an inch is 25.4 mm and
 * `48 * 25.4 === 1219.1999999999998`. Multiplying first and dividing second,
 * both in integers, gives 1219 every time on every machine.
 */
const LENGTH_TO_MM: Readonly<Record<DimensionUnitName, { numerator: number; denominator: number }>> = {
  MM: { numerator: 1, denominator: 1 },
  CM: { numerator: 10, denominator: 1 },
  M: { numerator: 1000, denominator: 1 },
  IN: { numerator: 254, denominator: 10 },
} as const;

/** The same, onto grams. A pound is 453.59237 g exactly. */
const WEIGHT_TO_G: Readonly<Record<WeightUnitName, { numerator: number; denominator: number }>> = {
  G: { numerator: 1, denominator: 1 },
  KG: { numerator: 1000, denominator: 1 },
  LB: { numerator: 45_359_237, denominator: 100_000 },
} as const;

/**
 * A figure the seller typed, in the unit they typed it in, as a canonical
 * integer.
 *
 * Half-up, like every other rounding in this system, and done on integers
 * scaled by a thousand so a seller typing "1.25 m" is not at the mercy of
 * binary floating point for the third decimal. Returns null for null, so a
 * blank field stays blank rather than becoming a zero somebody has to explain.
 */
function toCanonical(
  value: number | null | undefined,
  factor: { numerator: number; denominator: number },
  field: string,
): number | null {
  if (value === null || value === undefined) return null;

  if (!Number.isFinite(value) || value < 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'That measurement is not a number we can use.', [
      { field, code: 'INVALID' },
    ]);
  }

  // Scaled integers throughout: the input is taken to three decimal places,
  // which is finer than anybody measures a pallet.
  const scaled = Math.round(value * 1000);
  const numerator = scaled * factor.numerator;
  const denominator = 1000 * factor.denominator;
  const result = Math.round(numerator / denominator);

  if (!Number.isSafeInteger(result)) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'That measurement is larger than we can record.', [
      { field, code: 'TOO_LARGE' },
    ]);
  }

  return result;
}

/** A length in the seller's unit, as millimetres. */
export function toMillimetres(
  value: number | null | undefined,
  unit: DimensionUnitName,
  field: string,
): number | null {
  return toCanonical(value, LENGTH_TO_MM[unit], field);
}

/** A weight in the seller's unit, as grams. */
export function toGrams(
  value: number | null | undefined,
  unit: WeightUnitName,
  field: string,
): bigint | null {
  const grams = toCanonical(value, WEIGHT_TO_G[unit], field);
  return grams === null ? null : BigInt(grams);
}

/**
 * Millimetres back into the unit the seller typed in, for the form.
 *
 * Returns a NUMBER and not a rounded integer, because showing "1219 mm" to
 * somebody who typed "48 in" is showing them a figure they did not enter. The
 * canonical value in the database is unchanged; this is presentation.
 */
export function fromMillimetres(value: number | null, unit: DimensionUnitName): number | null {
  if (value === null) return null;
  const factor = LENGTH_TO_MM[unit];
  return round3((value * factor.denominator) / factor.numerator);
}

/** Grams back into the seller's unit, for the same reason. */
export function fromGrams(value: bigint | null, unit: WeightUnitName): number | null {
  if (value === null) return null;
  const factor = WEIGHT_TO_G[unit];
  return round3((Number(value) * factor.denominator) / factor.numerator);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * A guard against a figure that would overflow something downstream.
 *
 * The same ceiling `ordering-unit.ts` applies to a piece count, applied here
 * to the multiplication that produces one - so an impossible pallet is refused
 * where the seller can see the field, not three screens later in a basket.
 */
const MAX_BASE_UNITS = 10_000_000;

/** As much of a packaging option as the arithmetic needs. */
export interface PackagingFigures {
  packageType: PackageType;
  unitsPerCarton: number | null;
  cartonsPerLayer: number | null;
  layerCount: number | null;
  cartonsPerPallet: number | null;
  containerLoadingMethod: ContainerLoadingMethodName | null;
  palletsPerContainer: number | null;
  cartonsPerContainer: number | null;
}

export interface DerivedPackaging {
  /** cartons per layer x layers, where both are stated. */
  cartonsPerPallet: number | null;
  /** Cartons in one container, stated or derived from pallets. */
  cartonsPerContainer: number | null;
  /**
   * Base units in one of this package, or null when an input is missing.
   *
   * Null is not an error here - it is what an option half-filled-in looks
   * like, and `validatePackagingOption` is what turns it into a message.
   */
  unitsPerPackage: number | null;
}

/**
 * The whole chain, worked out from what the seller has stated so far.
 *
 * Every step is a plain integer multiplication and every one of them is
 * checked for overflow. There is no rounding anywhere: a package holds a whole
 * number of units or the seller has not finished describing it.
 */
export function derivePackaging(figures: PackagingFigures): DerivedPackaging {
  const unitsPerCarton = positiveOrNull(figures.unitsPerCarton);

  if (figures.packageType === 'CARTON') {
    return {
      cartonsPerPallet: null,
      cartonsPerContainer: null,
      unitsPerPackage: unitsPerCarton,
    };
  }

  // A pallet: cartons per layer x layers, falling back to a stated total.
  const perLayer = positiveOrNull(figures.cartonsPerLayer);
  const layers = positiveOrNull(figures.layerCount);
  const statedCartonsPerPallet = positiveOrNull(figures.cartonsPerPallet);

  const cartonsPerPallet =
    perLayer !== null && layers !== null ? safeMultiply(perLayer, layers) : statedCartonsPerPallet;

  if (isPalletPackage(figures.packageType)) {
    return {
      cartonsPerPallet,
      cartonsPerContainer: null,
      unitsPerPackage:
        cartonsPerPallet !== null && unitsPerCarton !== null
          ? safeMultiply(cartonsPerPallet, unitsPerCarton)
          : null,
    };
  }

  // A container. Two routes, and which one applies is the seller's stated
  // loading method rather than a guess from which fields happen to be filled.
  const method = figures.containerLoadingMethod;
  const pallets = positiveOrNull(figures.palletsPerContainer);
  const statedCartonsPerContainer = positiveOrNull(figures.cartonsPerContainer);

  if (method === 'PALLET_LOADED') {
    const cartonsInContainer =
      pallets !== null && cartonsPerPallet !== null
        ? safeMultiply(pallets, cartonsPerPallet)
        : statedCartonsPerContainer;

    return {
      cartonsPerPallet,
      cartonsPerContainer: cartonsInContainer,
      unitsPerPackage:
        cartonsInContainer !== null && unitsPerCarton !== null
          ? safeMultiply(cartonsInContainer, unitsPerCarton)
          : null,
    };
  }

  // CARTON_LOADED, or CUSTOM - in both cases the container's own carton count
  // is the figure, because there is no pallet in the chain to derive it from.
  return {
    cartonsPerPallet: null,
    cartonsPerContainer: statedCartonsPerContainer,
    unitsPerPackage:
      statedCartonsPerContainer !== null && unitsPerCarton !== null
        ? safeMultiply(statedCartonsPerContainer, unitsPerCarton)
        : null,
  };
}

function positiveOrNull(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}

/**
 * a x b, or null if the product is beyond what a line may hold.
 *
 * Null rather than a throw: this runs while a seller is typing, and a form
 * that raises an exception at a half-entered figure is a form nobody can fill
 * in. `validatePackagingOption` turns the null into a sentence.
 */
function safeMultiply(a: number, b: number): number | null {
  const product = a * b;
  if (!Number.isSafeInteger(product) || product <= 0 || product > MAX_BASE_UNITS) return null;
  return product;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface PackagingValidationIssue {
  /** The form field, so the screen can point at it. */
  field: string;
  code: string;
  /** English, and the frontends translate by `code`. */
  message: string;
}

/** Everything about an option that validation looks at. */
export interface PackagingOptionInput extends PackagingFigures {
  isEnabled: boolean;
  unitsPerPackage: number | null;
  unitsPerPackageIsOverride: boolean;
  minimumPackages: number;
  packageIncrement: number;
  maximumPackages: number | null;
  priceMode: PackagingPriceModeName;
  pricePerPackageMinor: bigint | null;
  currency: string | null;
  offerCurrency: string;
  containerType: ContainerTypeName | null;
  containerLoadMode: ContainerLoadModeName | null;
  grossWeightGrams: bigint | null;
  netWeightGrams: bigint | null;
  maxGrossWeightGrams: bigint | null;
  isStackable: boolean;
  maxStackCount: number | null;
  incoterm: string | null;
  /** The bands, so their prices are held to the same divisibility rule. */
  tiers: readonly PackagingTier[];
}

export interface PackagingValidation {
  issues: PackagingValidationIssue[];
  /** What the state column should become. */
  state: PackagingOptionStateName;
  /** The figure to store, derived or overridden. */
  unitsPerPackage: number | null;
  unitsPerPackageDerived: number | null;
  cartonsPerPallet: number | null;
  cartonsPerContainer: number | null;
}

/**
 * Incoterms 2020, the three-letter codes.
 *
 * A list rather than an enum: the ICC revises it on its own schedule and a
 * migration per revision buys nothing. Validated against, so a typo does not
 * end up printed on a commercial invoice.
 */
export const INCOTERMS: readonly string[] = [
  'EXW',
  'FCA',
  'FAS',
  'FOB',
  'CFR',
  'CIF',
  'CPT',
  'CIP',
  'DAP',
  'DPU',
  'DDP',
] as const;

/**
 * Is this option complete enough to sell, and what should it say if not?
 *
 * The ONE place completeness is decided. The seller's form, the save, the
 * buyer's product page and the add-to-cart check all read this, so an option
 * cannot be complete on one screen and incomplete on another.
 *
 * An enabled-but-incomplete option is NOT an error. A seller who switches
 * pallets on and then goes to lunch has not done anything wrong; they have
 * half a configuration, and the right behaviour is to keep it, not to offer it
 * to a buyer, and to say which field is missing. That is `INCOMPLETE`.
 */
export function validatePackagingOption(input: PackagingOptionInput): PackagingValidation {
  const issues: PackagingValidationIssue[] = [];
  const derived = derivePackaging(input);

  const unitsPerPackage = input.unitsPerPackageIsOverride
    ? positiveOrNull(input.unitsPerPackage)
    : derived.unitsPerPackage;

  // --- What is in the box --------------------------------------------------

  if (positiveOrNull(input.unitsPerCarton) === null) {
    issues.push({
      field: 'unitsPerCarton',
      code: 'UNITS_PER_CARTON_REQUIRED',
      message: 'Say how many units are in one carton.',
    });
  }

  if (isPalletPackage(input.packageType)) {
    if (derived.cartonsPerPallet === null) {
      issues.push({
        field: 'cartonsPerLayer',
        code: 'PALLET_LAYOUT_REQUIRED',
        message: 'Say how many cartons sit on a layer and how many layers high the pallet is.',
      });
    }
  }

  if (input.packageType === 'CONTAINER') {
    if (input.containerType === null) {
      issues.push({
        field: 'containerType',
        code: 'CONTAINER_TYPE_REQUIRED',
        message: 'Choose the container type.',
      });
    }
    if (input.containerLoadingMethod === null) {
      issues.push({
        field: 'containerLoadingMethod',
        code: 'CONTAINER_LOADING_REQUIRED',
        message: 'Say whether the container is loaded with pallets or with loose cartons.',
      });
    }
    if (input.containerLoadingMethod === 'PALLET_LOADED' && positiveOrNull(input.palletsPerContainer) === null) {
      issues.push({
        field: 'palletsPerContainer',
        code: 'PALLETS_PER_CONTAINER_REQUIRED',
        message: 'Say how many pallets go in one container.',
      });
    }
    if (input.containerLoadingMethod !== 'PALLET_LOADED' && positiveOrNull(input.cartonsPerContainer) === null) {
      issues.push({
        field: 'cartonsPerContainer',
        code: 'CARTONS_PER_CONTAINER_REQUIRED',
        message: 'Say how many cartons go in one container.',
      });
    }
  }

  if (unitsPerPackage === null) {
    issues.push({
      field: 'unitsPerPackage',
      code: 'UNITS_PER_PACKAGE_UNKNOWN',
      message: 'We cannot work out how many units are in one of these yet.',
    });
  } else if (unitsPerPackage > MAX_BASE_UNITS) {
    issues.push({
      field: 'unitsPerPackage',
      code: 'UNITS_PER_PACKAGE_TOO_LARGE',
      message: 'That is more units than one package can hold on this system.',
    });
  }

  // --- The override --------------------------------------------------------
  //
  // Allowed, and held to a sanity band. A "correction" of an order of
  // magnitude is not a short top layer, it is a typo, and accepting it would
  // sell somebody ten times the goods at one tenth the price per unit.
  if (input.unitsPerPackageIsOverride && unitsPerPackage !== null && derived.unitsPerPackage !== null) {
    const ratio = unitsPerPackage / derived.unitsPerPackage;
    if (ratio < 0.5 || ratio > 2) {
      issues.push({
        field: 'unitsPerPackage',
        code: 'OVERRIDE_IMPLAUSIBLE',
        message:
          'That is a long way from what the layout works out to. Check the carton, layer and layer-count figures.',
      });
    }
  }

  if (input.unitsPerPackageIsOverride && unitsPerPackage === null) {
    issues.push({
      field: 'unitsPerPackage',
      code: 'OVERRIDE_REQUIRES_VALUE',
      message: 'An override needs a number.',
    });
  }

  // --- Terms ---------------------------------------------------------------

  if (!Number.isInteger(input.minimumPackages) || input.minimumPackages < 1) {
    issues.push({
      field: 'minimumPackages',
      code: 'MINIMUM_INVALID',
      message: 'The smallest order is at least one package.',
    });
  }

  if (!Number.isInteger(input.packageIncrement) || input.packageIncrement < 1) {
    issues.push({
      field: 'packageIncrement',
      code: 'INCREMENT_INVALID',
      message: 'The step must be one package or more.',
    });
  }

  if (
    input.maximumPackages !== null &&
    (!Number.isInteger(input.maximumPackages) || input.maximumPackages < input.minimumPackages)
  ) {
    issues.push({
      field: 'maximumPackages',
      code: 'MAXIMUM_BELOW_MINIMUM',
      message: 'The most somebody may order cannot be below the least.',
    });
  }

  // --- Price ---------------------------------------------------------------

  if (input.priceMode === 'PER_PACKAGE') {
    if (input.pricePerPackageMinor === null || input.pricePerPackageMinor < 0n) {
      issues.push({
        field: 'pricePerPackageMinor',
        code: 'PACKAGE_PRICE_REQUIRED',
        message: 'Give a price for one package.',
      });
    }
    if (input.currency !== null && input.currency !== input.offerCurrency) {
      issues.push({
        field: 'currency',
        code: 'CURRENCY_MISMATCH',
        message: 'A package must be priced in the same currency as the listing.',
      });
    }
  }

  /*
   * A package price must divide exactly by what is in the package.
   *
   * THIS IS NOT FUSSINESS, AND IT IS THE ONE RULE HERE MOST LIKELY TO LOOK
   * LIKE IT.
   *
   * An order line is priced, taxed, discounted, invoiced and refunded from
   * ONE number: the price of one base unit, multiplied by the base-unit
   * quantity. That is how every line in this system has always worked and
   * bulk ordering does not get its own pricing path - there is one pricing
   * engine and there will not be two.
   *
   * So for a package line to charge what the buyer agreed, this has to hold:
   *
   *     unitPrice x unitsPerPackage  ==  packagePrice
   *
   * If it does not, the per-unit figure has a remainder, and the remainder has
   * to go somewhere. Every place it could go is worse than refusing here: lost
   * (the seller is underpaid on every pallet), added to the last unit (the
   * invoice has one unit priced differently from its neighbours for no reason
   * anybody can explain), or carried as a line adjustment (which is a second
   * pricing engine, taxed and refunded by different rules from the first).
   *
   * The cost of the rule is small and the seller can see it: a 1,200-unit
   * pallet must be priced in whole paise per unit, so 9,999,900 is refused and
   * 9,999,600 or 10,000,800 is accepted. The message carries the nearest
   * figures that work, so the form can offer them.
   */
  if (unitsPerPackage !== null && unitsPerPackage > 0) {
    const perPackage = BigInt(unitsPerPackage);

    if (
      input.priceMode === 'PER_PACKAGE' &&
      input.pricePerPackageMinor !== null &&
      input.pricePerPackageMinor % perPackage !== 0n
    ) {
      issues.push({
        field: 'pricePerPackageMinor',
        code: 'PACKAGE_PRICE_NOT_DIVISIBLE',
        message: `A package price has to divide exactly by the ${String(unitsPerPackage)} units inside it, so the price per unit is a whole number.`,
      });
    }

    for (const [index, tier] of input.tiers.entries()) {
      if (tier.pricePerPackageMinor % perPackage !== 0n) {
        issues.push({
          field: `tiers.${String(index)}.pricePerPackageMinor`,
          code: 'PACKAGE_PRICE_NOT_DIVISIBLE',
          message: `A band price has to divide exactly by the ${String(unitsPerPackage)} units inside a package.`,
        });
      }
    }
  }

  // --- Weight --------------------------------------------------------------

  if (
    input.netWeightGrams !== null &&
    input.grossWeightGrams !== null &&
    input.grossWeightGrams < input.netWeightGrams
  ) {
    issues.push({
      field: 'grossWeightGrams',
      code: 'GROSS_BELOW_NET',
      message: 'The gross weight includes the packaging, so it cannot be below the net weight.',
    });
  }

  if (
    input.maxGrossWeightGrams !== null &&
    input.grossWeightGrams !== null &&
    input.grossWeightGrams > input.maxGrossWeightGrams
  ) {
    issues.push({
      field: 'grossWeightGrams',
      code: 'OVER_SAFE_LOAD',
      message: 'One loaded package already weighs more than the safe load you gave.',
    });
  }

  if (input.isStackable && input.maxStackCount !== null && input.maxStackCount < 2) {
    issues.push({
      field: 'maxStackCount',
      code: 'STACK_COUNT_INVALID',
      message: 'A stackable package stacks at least two high.',
    });
  }

  if (input.incoterm !== null && !INCOTERMS.includes(input.incoterm)) {
    issues.push({
      field: 'incoterm',
      code: 'INCOTERM_UNKNOWN',
      message: 'That is not an Incoterms 2020 code.',
    });
  }

  const state: PackagingOptionStateName = !input.isEnabled
    ? 'DISABLED'
    : issues.length > 0
      ? 'INCOMPLETE'
      : 'ACTIVE';

  return {
    issues,
    state,
    unitsPerPackage,
    unitsPerPackageDerived: derived.unitsPerPackage,
    cartonsPerPallet: derived.cartonsPerPallet,
    cartonsPerContainer: derived.cartonsPerContainer,
  };
}

// ---------------------------------------------------------------------------
// Pricing one package
// ---------------------------------------------------------------------------

export interface PackagingTier {
  minPackages: number;
  pricePerPackageMinor: bigint;
}

export interface PackagePriceInput {
  priceMode: PackagingPriceModeName;
  /** The option's own package price, where it has one. */
  pricePerPackageMinor: bigint | null;
  /** The offer's price for ONE base unit. */
  unitPriceMinor: bigint;
  unitsPerPackage: number;
  /** Bands, in any order. Sorted here. */
  tiers: readonly PackagingTier[];
  packageQuantity: number;
}

export interface PackagePrice {
  /** Minor units, the price of ONE package at this quantity. */
  packagePriceMinor: bigint;
  /**
   * Minor units, the effective price of ONE base unit.
   *
   * DERIVED FOR DISPLAY AND NOT USED TO PRICE THE LINE. The division does not
   * always come out - a pallet of 1,200 at 100,000 minor units is 83.33 per
   * unit - and a line priced off a rounded-back unit figure would no longer
   * multiply up to the package price the buyer agreed to. The line is priced
   * from `packagePriceMinor`, always.
   */
  effectiveUnitPriceMinor: bigint;
  /** The band that applied, by its `minPackages`. Null when none did. */
  appliedTierMinPackages: number | null;
  /** True when there is deliberately no price: a quotation is required. */
  requiresQuote: boolean;
  /**
   * True when the package price does NOT divide exactly by what is in it, so
   * `effectiveUnitPriceMinor` has been truncated and the two figures no longer
   * multiply back together.
   *
   * `validatePackagingOption` refuses to make an option ACTIVE in that state,
   * so a buyable option never carries it. It is here because this function is
   * also called on rows saved before the rule existed, and on a preview a
   * seller is still typing - and silently charging a truncated figure would be
   * exactly the bug the rule prevents. Callers on the money path refuse the
   * line rather than round.
   */
  isIndivisible: boolean;
}

/**
 * What one package costs at this quantity.
 *
 * Tier first, then the option's own price, then the derivation from the unit
 * price. In that order, because a tier is the seller's most specific statement
 * about this quantity and a derivation is their least.
 *
 * `FREIGHT_QUOTE` returns zero with `requiresQuote` set rather than a price,
 * and callers are expected to refuse instant checkout on it. A zero that
 * reached a total would be a free pallet; nothing here lets it, and the cart
 * checks the flag rather than the figure.
 */
export function pricePackage(input: PackagePriceInput): PackagePrice {
  if (input.priceMode === 'FREIGHT_QUOTE') {
    return {
      packagePriceMinor: 0n,
      effectiveUnitPriceMinor: 0n,
      appliedTierMinPackages: null,
      requiresQuote: true,
      isIndivisible: false,
    };
  }

  const units = BigInt(Math.max(1, Math.trunc(input.unitsPerPackage)));

  // Highest band whose floor this quantity reaches.
  let applied: PackagingTier | null = null;
  for (const tier of input.tiers) {
    if (input.packageQuantity < tier.minPackages) continue;
    if (applied === null || tier.minPackages > applied.minPackages) applied = tier;
  }

  const packagePriceMinor =
    applied !== null
      ? applied.pricePerPackageMinor
      : input.priceMode === 'PER_PACKAGE' && input.pricePerPackageMinor !== null
        ? input.pricePerPackageMinor
        : input.unitPriceMinor * units;

  return {
    packagePriceMinor,
    // Integer division. Exact for any option `validatePackagingOption` let
    // through, because divisibility is a condition of being ACTIVE; truncating
    // only for a row saved before that rule existed, which `isIndivisible`
    // then flags rather than hides.
    effectiveUnitPriceMinor: packagePriceMinor / units,
    appliedTierMinPackages: applied?.minPackages ?? null,
    requiresQuote: false,
    isIndivisible: packagePriceMinor % units !== 0n,
  };
}

// ---------------------------------------------------------------------------
// The sell unit
// ---------------------------------------------------------------------------

/**
 * A package, expressed as the thing `resolveSellUnitQuantity` already
 * understands.
 *
 * This is the whole join between bulk ordering and the quantity engine that
 * was already here. A pallet is a sell unit holding `unitsPerPackage` base
 * units, with the seller's own minimum and step - which is structurally the
 * same statement as "the operator's carton holds 500", and goes down the same
 * code path, with the same overflow guard and the same snapshotting.
 *
 * Nothing in the returned spec comes from a request body. The units, the
 * minimum and the step are read from the seller's stored option.
 */
export function packagingSellUnit(option: {
  packageType: PackageType;
  unitsPerPackage: number;
  minimumPackages: number;
  packageIncrement: number;
  maximumPackages: number | null;
}): SellUnitSpec {
  return {
    unit: orderingUnitForPackage(option.packageType),
    piecesPerUnit: Math.max(1, Math.trunc(option.unitsPerPackage)),
    minimumOrderQuantity: Math.max(1, Math.trunc(option.minimumPackages)),
    orderIncrement: Math.max(1, Math.trunc(option.packageIncrement)),
    maximumOrderQuantity:
      option.maximumPackages === null ? null : Math.max(1, Math.trunc(option.maximumPackages)),
  };
}

// ---------------------------------------------------------------------------
// The breakdown a person reads
// ---------------------------------------------------------------------------

export interface PackagingBreakdown {
  packageType: PackageType;
  packageQuantity: number;
  unitsPerPackage: number;
  totalBaseUnits: number;
  unitsPerCarton: number | null;
  cartonsPerPallet: number | null;
  palletsPerContainer: number | null;
  cartonsPerContainer: number | null;
  /** Cartons in the whole line, where the chain has a carton in it. */
  totalCartons: number | null;
  /** Pallets in the whole line, for a container order that is palletised. */
  totalPallets: number | null;
  totalContainers: number | null;
  grossWeightGrams: bigint | null;
  volumeCm3: bigint | null;
}

/** As much of a snapshot as a breakdown needs. */
export interface BreakdownSource {
  packageType: PackageType;
  packageQuantity: number;
  unitsPerPackage: number;
  unitsPerCarton: number | null;
  cartonsPerPallet: number | null;
  palletsPerContainer: number | null;
  cartonsPerContainer: number | null;
  grossWeightGrams: bigint | null;
  cargoVolumeCm3: bigint | null;
}

/**
 * "2 UK pallets x 50 cartons x 24 units = 2,400 units", as structured data.
 *
 * Built from the SNAPSHOT and never from the live option, everywhere it is
 * used. That is what makes the sentence on an old order still true after the
 * seller re-specifies the pallet - which is the entire reason the snapshot
 * exists.
 *
 * The wording itself is not here. Each frontend composes it from these numbers
 * in the reader's own language, because "2 pallets of 50 cartons" does not
 * translate by substituting words into an English sentence.
 */
export function describePackaging(source: BreakdownSource): PackagingBreakdown {
  const totalBaseUnits = source.packageQuantity * source.unitsPerPackage;

  const totalCartons =
    source.packageType === 'CARTON'
      ? source.packageQuantity
      : isPalletPackage(source.packageType) && source.cartonsPerPallet !== null
        ? source.packageQuantity * source.cartonsPerPallet
        : source.packageType === 'CONTAINER' && source.cartonsPerContainer !== null
          ? source.packageQuantity * source.cartonsPerContainer
          : null;

  const totalPallets =
    isPalletPackage(source.packageType)
      ? source.packageQuantity
      : source.packageType === 'CONTAINER' && source.palletsPerContainer !== null
        ? source.packageQuantity * source.palletsPerContainer
        : null;

  return {
    packageType: source.packageType,
    packageQuantity: source.packageQuantity,
    unitsPerPackage: source.unitsPerPackage,
    totalBaseUnits,
    unitsPerCarton: source.unitsPerCarton,
    cartonsPerPallet: source.cartonsPerPallet,
    palletsPerContainer: source.palletsPerContainer,
    cartonsPerContainer: source.cartonsPerContainer,
    totalCartons,
    totalPallets,
    totalContainers: source.packageType === 'CONTAINER' ? source.packageQuantity : null,
    grossWeightGrams:
      source.grossWeightGrams === null
        ? null
        : source.grossWeightGrams * BigInt(source.packageQuantity),
    volumeCm3:
      source.cargoVolumeCm3 === null ? null : source.cargoVolumeCm3 * BigInt(source.packageQuantity),
  };
}

/**
 * How many WHOLE packages this much available stock makes.
 *
 * Rounds DOWN, and the direction is the point: a buyer who can be sold two
 * complete pallets and 300 loose units can buy two pallets. Telling them three
 * are available and failing at checkout is worse than telling them two.
 */
export function wholePackagesAvailable(availableBaseUnits: number, unitsPerPackage: number): number {
  if (unitsPerPackage <= 0) return 0;
  return Math.max(0, Math.floor(availableBaseUnits / unitsPerPackage));
}

/**
 * Does this order exceed what the seller said one package may weigh?
 *
 * Checked per package rather than for the consignment: a safe working load is
 * a property of one pallet, and four pallets each within their load are a
 * legal consignment however much they weigh together. The consignment's own
 * limit is the carrier's, and it is checked where the carrier is chosen.
 */
export function exceedsConfiguredWeight(input: {
  grossWeightGrams: bigint | null;
  maxGrossWeightGrams: bigint | null;
}): boolean {
  if (input.grossWeightGrams === null || input.maxGrossWeightGrams === null) return false;
  return input.grossWeightGrams > input.maxGrossWeightGrams;
}

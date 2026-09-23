/**
 * Bulk packaging in the browser: what a package holds, what it costs, and how
 * to say so in eight languages.
 *
 * THIS IS NOT A SECOND PRICING ENGINE, and nothing in it is trusted.
 *
 * Every figure here came off the server, which worked it out from the seller's
 * own stored configuration and re-checks the whole thing on add-to-cart and
 * again at checkout. What this file does is arithmetic for a display - a
 * running total as somebody presses the stepper - so the screen can respond
 * without a round trip. The moment it matters, the server decides.
 *
 * Kept apart from `packaging.ts`, which is about the OPERATOR's carton and a
 * seller's piece. This is a seller's carton, pallet and container, and they
 * are different things configured in different places - see the note on
 * `OrderingUnit` in the schema for why the two must not be folded together.
 *
 * WHY THE SENTENCE IS BUILT FROM NUMBERS RATHER THAN TRANSLATED
 *
 * "2 UK pallets x 50 cartons x 24 units = 2,400 units" does not translate by
 * substituting words into an English frame: the noun agrees with the number in
 * Polish four different ways, and the multiplication sign is read differently
 * in Greek. So the server sends the FIGURES and each label is its own key with
 * its own plural forms, and this file composes the parts rather than the
 * sentence.
 */
import { formatNumber } from './format';

export type PackageType = 'CARTON' | 'UK_PALLET' | 'US_PALLET' | 'CONTAINER';

export type FreightLoadType = 'PARCEL' | 'CARTON' | 'PALLET' | 'FCL' | 'LCL';

/** One package a seller offers, exactly as `/catalog/:slug` sends it. */
export interface BuyablePackaging {
  packageType: PackageType;
  unitsPerPackage: number;
  unitsPerCarton: number | null;
  cartonsPerPallet: number | null;
  palletsPerContainer: number | null;
  cartonsPerContainer: number | null;
  palletStandard: string | null;
  containerType: string | null;
  containerLoadMode: string | null;
  minimumPackages: number;
  packageIncrement: number;
  maximumPackages: number | null;
  /** Minor units, as a string. Never a number — see `format.ts`. */
  packagePriceMinor: string;
  effectiveUnitPriceMinor: string;
  currency: string;
  requiresFreightQuote: boolean;
  loadType: FreightLoadType;
  /** WHOLE packages this seller can ship right now. Rounded down. */
  wholePackagesAvailable: number;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  grossWeightGrams: string | null;
  leadTimeDays: number | null;
  isHazardous: boolean;
  incoterm: string | null;
  tiers: { minPackages: number; pricePerPackageMinor: string }[];
}

/** The frozen breakdown on a basket or order line. */
export interface LinePackaging {
  packageType: PackageType;
  palletStandard: string | null;
  containerType: string | null;
  containerLoadMode: string | null;
  packageQuantity: number;
  unitsPerPackage: number;
  totalBaseUnits: number;
  unitsPerCarton: number | null;
  cartonsPerPallet: number | null;
  palletsPerContainer: number | null;
  cartonsPerContainer: number | null;
  totalCartons: number | null;
  totalPallets: number | null;
  totalContainers: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  grossWeightGrams: string | null;
  volumeCm3: string | null;
  packagePriceMinor: string;
  unitPriceMinor: string;
  currency: string;
  appliedTierMinPackages: number | null;
  profileVersion: number;
  requiresFreightQuote: boolean;
  loadType: string;
  minimumPackages: number;
  packageIncrement: number;
  maximumPackages: number | null;
}

/** The translation key for a package type's name, with a count for plurals. */
export function packageTypeKey(packageType: PackageType): string {
  switch (packageType) {
    case 'CARTON':
      return 'packaging.type.carton';
    case 'UK_PALLET':
      return 'packaging.type.ukPallet';
    case 'US_PALLET':
      return 'packaging.type.usPallet';
    case 'CONTAINER':
      return 'packaging.type.container';
  }
}

/**
 * The nearest package quantity at or above `desired` that the seller accepts.
 *
 * Steps are counted FROM THE MINIMUM, not from zero - the same rule
 * `clampToRules` already applies to loose quantities, and the same rule the
 * server applies in `resolveSellUnitQuantity`. A seller with a minimum of 4
 * and a step of 2 accepts 4, 6, 8 - not 2, and not 10 only.
 *
 * This is a convenience so the stepper moves sensibly. The server raises the
 * quantity to the same figure on every write regardless, so a browser that
 * computed this wrongly would be corrected rather than obeyed.
 */
export function clampPackages(desired: number, option: {
  minimumPackages: number;
  packageIncrement: number;
  maximumPackages: number | null;
}): number {
  const min = Math.max(1, option.minimumPackages);
  const step = Math.max(1, option.packageIncrement);

  const stepsAbove = Math.max(0, Math.ceil((desired - min) / step));
  let candidate = min + stepsAbove * step;

  if (option.maximumPackages !== null && candidate > option.maximumPackages) {
    const stepsUnder = Math.floor((option.maximumPackages - min) / step);
    candidate = min + Math.max(0, stepsUnder) * step;
  }

  return candidate;
}

/**
 * The price of one package at this quantity, from the bands the server sent.
 *
 * Mirrors `pricePackage` on the server exactly: the highest band whose floor
 * the quantity reaches, falling back to the package price. Duplicated rather
 * than fetched per keystroke, and the duplication is contained to this one
 * function precisely so the divergence is findable if it ever happens - the
 * server re-prices the line on add, so a disagreement corrects itself rather
 * than charging anybody the browser's number.
 */
export function packagePriceAt(option: BuyablePackaging, packages: number): string {
  let applied: { minPackages: number; pricePerPackageMinor: string } | null = null;

  for (const tier of option.tiers) {
    if (packages < tier.minPackages) continue;
    if (applied === null || tier.minPackages > applied.minPackages) applied = tier;
  }

  return applied?.pricePerPackageMinor ?? option.packagePriceMinor;
}

/** Which band applies at this quantity, or null when none does. */
export function appliedTierAt(option: BuyablePackaging, packages: number): number | null {
  let applied: number | null = null;

  for (const tier of option.tiers) {
    if (packages < tier.minPackages) continue;
    if (applied === null || tier.minPackages > applied) applied = tier.minPackages;
  }

  return applied;
}

/** The next band up, so the page can say "4 or more: cheaper". */
export function nextTier(
  option: BuyablePackaging,
  packages: number,
): { minPackages: number; pricePerPackageMinor: string } | null {
  let next: { minPackages: number; pricePerPackageMinor: string } | null = null;

  for (const tier of option.tiers) {
    if (tier.minPackages <= packages) continue;
    if (next === null || tier.minPackages < next.minPackages) next = tier;
  }

  return next;
}

/**
 * The line total, in minor units, as a string.
 *
 * String arithmetic on purpose. A pallet at six figures times forty is beyond
 * what a JS number holds exactly, and this figure is shown to somebody about
 * to agree to it.
 */
export function lineTotalMinor(pricePerPackageMinor: string, packages: number): string {
  if (!/^\d+$/.test(pricePerPackageMinor)) return '0';
  return (BigInt(pricePerPackageMinor) * BigInt(Math.max(0, Math.trunc(packages)))).toString();
}

/** The parts of the breakdown, as figures for the page to label. */
export interface BreakdownPart {
  /** `packages`, `pallets`, `cartons`, `units`. */
  kind: 'packages' | 'pallets' | 'cartons' | 'units';
  value: number;
  /** Already formatted for the reader's locale. */
  formatted: string;
}

/**
 * "2 UK pallets", "50 cartons", "24 units" - as parts, never as a sentence.
 *
 * The page joins them with its own separator and labels each with its own
 * plural-aware key. Building the sentence here would bake English word order
 * into a file eight languages have to render.
 */
export function breakdownParts(input: {
  packageType: PackageType;
  packageQuantity: number;
  unitsPerCarton: number | null;
  cartonsPerPallet: number | null;
  palletsPerContainer: number | null;
}): BreakdownPart[] {
  const parts: BreakdownPart[] = [
    {
      kind: 'packages',
      value: input.packageQuantity,
      formatted: formatNumber(input.packageQuantity),
    },
  ];

  if (input.packageType === 'CONTAINER' && input.palletsPerContainer !== null) {
    parts.push({
      kind: 'pallets',
      value: input.palletsPerContainer,
      formatted: formatNumber(input.palletsPerContainer),
    });
  }

  if (input.packageType !== 'CARTON' && input.cartonsPerPallet !== null) {
    parts.push({
      kind: 'cartons',
      value: input.cartonsPerPallet,
      formatted: formatNumber(input.cartonsPerPallet),
    });
  }

  if (input.unitsPerCarton !== null) {
    parts.push({
      kind: 'units',
      value: input.unitsPerCarton,
      formatted: formatNumber(input.unitsPerCarton),
    });
  }

  return parts;
}

/**
 * Grams as a figure a person reads.
 *
 * Kilograms above a kilogram, grams below, and never more precision than the
 * seller can have meant: a pallet weighed to the gram is a figure nobody
 * measured. The unit is returned separately so the page can translate it.
 */
export function formatWeight(grams: string | null): { value: string; unit: 'kg' | 'g' } | null {
  if (grams === null || !/^\d+$/.test(grams)) return null;

  const value = Number(grams);
  if (!Number.isFinite(value) || value <= 0) return null;

  if (value >= 1000) {
    return { value: formatNumber(Math.round(value / 100) / 10), unit: 'kg' };
  }

  return { value: formatNumber(value), unit: 'g' };
}

/**
 * Millimetres as the dimensions people quote.
 *
 * Centimetres for anything from a carton upwards, because a pallet quoted as
 * "1200 x 1000 x 1450 mm" is four numbers nobody can hold in their head.
 * Returns null unless all three are present: two dimensions out of three is a
 * box nobody can picture, and printing them would invite the reader to guess
 * the third.
 */
export function formatDimensions(
  lengthMm: number | null,
  widthMm: number | null,
  heightMm: number | null,
): { value: string; unit: 'cm' | 'mm' } | null {
  if (lengthMm === null || widthMm === null || heightMm === null) return null;
  if (lengthMm <= 0 || widthMm <= 0 || heightMm <= 0) return null;

  const useCm = Math.max(lengthMm, widthMm, heightMm) >= 500;

  const scale = (value: number): string =>
    useCm ? formatNumber(Math.round(value / 10)) : formatNumber(value);

  return {
    value: `${scale(lengthMm)} × ${scale(widthMm)} × ${scale(heightMm)}`,
    unit: useCm ? 'cm' : 'mm',
  };
}

/**
 * Is this line one somebody bought by the package?
 *
 * Read off the LINE's own snapshot, never off the product it points at - the
 * same rule `lineIsSoldByThePiece` follows and for the same reason. A pallet
 * order stays a pallet order on an old receipt even after the seller stops
 * offering pallets.
 */
export function lineIsPackaged(
  packaging: LinePackaging | null | undefined,
): packaging is LinePackaging {
  return packaging !== null && packaging !== undefined;
}

/**
 * Whether a package can actually be bought right now, and why not.
 *
 * Returns a CODE rather than a sentence, so each is translated at the point of
 * display with the figures substituted. Null means it can be bought.
 */
export type PackagingUnavailableReason =
  | { code: 'OUT_OF_STOCK' }
  | { code: 'NOT_ENOUGH_WHOLE_PACKAGES'; available: number }
  | { code: 'ABOVE_MAXIMUM'; maximum: number };

export function packagingUnavailable(
  option: BuyablePackaging,
  packages: number,
): PackagingUnavailableReason | null {
  if (option.wholePackagesAvailable <= 0) return { code: 'OUT_OF_STOCK' };

  if (packages > option.wholePackagesAvailable) {
    return { code: 'NOT_ENOUGH_WHOLE_PACKAGES', available: option.wholePackagesAvailable };
  }

  if (option.maximumPackages !== null && packages > option.maximumPackages) {
    return { code: 'ABOVE_MAXIMUM', maximum: option.maximumPackages };
  }

  return null;
}

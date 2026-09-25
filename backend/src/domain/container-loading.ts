/**
 * How many pieces of a product fit in a 20-ft and a 40-ft container.
 *
 * THE ONE FORMULA
 *
 *     piecesPerContainer = piecesPerCarton x cartonsPerContainer
 *
 * where `cartonsPerContainer` is the SELLER'S figure - stated outright for a
 * floor-loaded container, or pallets x cartons per pallet for a palletised
 * one. Nothing here invents a capacity. A buyer is only ever offered a size
 * the seller has verified (`SELLER_VERIFIED`), and the figure they are shown
 * is this file's multiplication of the seller's numbers.
 *
 * WHAT THIS FILE REFUSES
 *
 * A seller's figure is refused when it is physically impossible or unsafe:
 *
 *   - the cargo would weigh more than the deployment's configured payload
 *     limit for that container (`CONTAINER_20FT_MAX_PAYLOAD_KG`);
 *   - the cartons would take up more room than the container's nominal
 *     internal volume - the one thing no loading plan can beat;
 *   - one carton does not fit through the container in any orientation.
 *
 * It does NOT refuse a figure for beating the estimate below: a seller who
 * mixes orientations or loads by hand can fit more than a single-orientation
 * grid, and they are the one who has to get the doors shut.
 *
 * THE ESTIMATE
 *
 * `estimateCartonsPerContainer` is a starting point for the seller's form and
 * never a capacity. It fits the carton on a grid in its best single
 * orientation, limits the layers to the seller's stacking limit, and then
 * limits the count to what the payload allows - space AND weight AND
 * stacking, never volume alone. It is labelled an estimate on every screen,
 * and a buyer never sees it.
 *
 * Pure: no I/O. Weights are integer grams in a bigint; lengths integer
 * millimetres; volumes integer cubic millimetres in a bigint.
 */
import { CONTAINER_PRESETS } from './packaging.js';

export type ContainerSize = 'CONTAINER_20_FT' | 'CONTAINER_40_FT';

export const CONTAINER_SIZES: readonly ContainerSize[] = Object.freeze([
  'CONTAINER_20_FT',
  'CONTAINER_40_FT',
]);

export type CapacitySource = 'SELLER_VERIFIED' | 'CALCULATED_ESTIMATE';

export type LoadingMethod = 'PALLET_LOADED' | 'CARTON_LOADED' | 'CUSTOM';

export function isContainerSize(unit: string): unit is ContainerSize {
  return unit === 'CONTAINER_20_FT' || unit === 'CONTAINER_40_FT';
}

/** The ceiling a piece count may reach anywhere in the order path. */
export const MAX_PIECES_PER_CONTAINER = 10_000_000;

// ---------------------------------------------------------------------------
// The container's limits
// ---------------------------------------------------------------------------

export interface ContainerLimits {
  internalLengthMm: number;
  internalWidthMm: number;
  internalHeightMm: number;
  /** The configured payload ceiling, grams. */
  maxPayloadGrams: bigint;
}

/**
 * The limits of one container size.
 *
 * The internal dimensions are the nominal ones in `CONTAINER_PRESETS` (a
 * standard dry 20GP and 40GP), used only for the two checks nothing can beat -
 * does one carton fit, and does the cargo's volume exceed the box. The payload
 * is the deployment's configured figure, passed in by the caller.
 */
export function containerLimits(size: ContainerSize, maxPayloadKg: number): ContainerLimits {
  const preset = CONTAINER_PRESETS[size === 'CONTAINER_20_FT' ? 'DRY_20GP' : 'DRY_40GP'];
  return {
    internalLengthMm: preset.nominalInternalLengthMm ?? 0,
    internalWidthMm: preset.nominalInternalWidthMm ?? 0,
    internalHeightMm: preset.nominalInternalHeightMm ?? 0,
    maxPayloadGrams: BigInt(Math.trunc(maxPayloadKg)) * 1000n,
  };
}

/** The container's internal volume, cubic millimetres. */
function containerVolumeMm3(limits: ContainerLimits): bigint {
  return (
    BigInt(limits.internalLengthMm) *
    BigInt(limits.internalWidthMm) *
    BigInt(limits.internalHeightMm)
  );
}

// ---------------------------------------------------------------------------
// The carton
// ---------------------------------------------------------------------------

export interface CartonSpec {
  piecesPerCarton: number;
  lengthMm: number;
  widthMm: number;
  heightMm: number;
  grossWeightGrams: bigint;
  /** Cartons high, at most. Null means no limit. */
  maxStackLayers: number | null;
}

/** The six axis-aligned ways a box can sit, as [along length, across, up]. */
function orientations(carton: CartonSpec): [number, number, number][] {
  const { lengthMm: l, widthMm: w, heightMm: h } = carton;
  return [
    [l, w, h],
    [w, l, h],
    [l, h, w],
    [h, l, w],
    [w, h, l],
    [h, w, l],
  ];
}

/** Does one carton fit through the container in any orientation? */
export function cartonFits(carton: CartonSpec, limits: ContainerLimits): boolean {
  return orientations(carton).some(
    ([a, b, c]) =>
      a <= limits.internalLengthMm && b <= limits.internalWidthMm && c <= limits.internalHeightMm,
  );
}

export interface CartonEstimate {
  cartons: number;
  /** What stopped it going higher. */
  limitedBy: 'SPACE' | 'STACKING' | 'WEIGHT';
}

/**
 * The system's estimate of cartons in one container. A STARTING POINT.
 *
 * The best single-orientation grid, its layers capped by the stacking limit,
 * then capped by the payload. Returns null when a carton does not fit at all
 * or a figure is missing - there is no estimate to offer, and a zero would be
 * read as one.
 */
export function estimateCartonsPerContainer(
  carton: CartonSpec,
  limits: ContainerLimits,
): CartonEstimate | null {
  if (!isCompleteCarton(carton)) return null;

  let best: { cartons: number; stackCapped: boolean } | null = null;

  for (const [along, across, up] of orientations(carton)) {
    const rows = Math.floor(limits.internalLengthMm / along);
    const columns = Math.floor(limits.internalWidthMm / across);
    const naturalLayers = Math.floor(limits.internalHeightMm / up);
    if (rows < 1 || columns < 1 || naturalLayers < 1) continue;

    const layers =
      carton.maxStackLayers === null
        ? naturalLayers
        : Math.min(naturalLayers, carton.maxStackLayers);
    const cartons = rows * columns * layers;

    if (best === null || cartons > best.cartons) {
      best = { cartons, stackCapped: layers < naturalLayers };
    }
  }

  if (best === null) return null;

  const byWeight = Number(limits.maxPayloadGrams / carton.grossWeightGrams);
  if (byWeight < best.cartons) return { cartons: Math.max(0, byWeight), limitedBy: 'WEIGHT' };

  return { cartons: best.cartons, limitedBy: best.stackCapped ? 'STACKING' : 'SPACE' };
}

function isPositiveInteger(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isCompleteCarton(carton: CartonSpec): boolean {
  return (
    isPositiveInteger(carton.piecesPerCarton) &&
    isPositiveInteger(carton.lengthMm) &&
    isPositiveInteger(carton.widthMm) &&
    isPositiveInteger(carton.heightMm) &&
    carton.grossWeightGrams > 0n &&
    (carton.maxStackLayers === null || isPositiveInteger(carton.maxStackLayers))
  );
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface LoadingIssue {
  /** The form field, so the screen can point at it. */
  field: string;
  /** Stable, for translation. */
  code: string;
  /** English; the frontends translate by `code`. */
  message: string;
  meta?: Record<string, number | string>;
}

export interface SizeInput {
  /** Floor-loaded: the seller's carton count. Ignored when pallet-loaded. */
  cartonsPerContainer: number | null;
  /** Pallet-loaded: pallets in one container. */
  palletsPerContainer: number | null;
  /** The seller ticked "I have verified this loads". */
  verified: boolean;
}

export interface LoadingInput {
  carton: CartonSpec;
  loadingMethod: LoadingMethod;
  cartonsPerPallet: number | null;
  sizes: Record<ContainerSize, SizeInput | null>;
}

export interface SizeResult {
  cartonsPerContainer: number;
  piecesPerContainer: number;
  palletsPerContainer: number | null;
  /** Gross cargo weight of one full container, grams. */
  payloadGrams: bigint;
  /** Cargo volume of one full container, cubic millimetres. */
  cargoVolumeMm3: bigint;
  /** The share of the container's nominal volume the cartons take, 0-100. */
  volumeUsePercent: number;
  estimate: CartonEstimate | null;
}

export interface LoadingValidation {
  issues: LoadingIssue[];
  sizes: Record<ContainerSize, SizeResult | null>;
}

const SIZE_FIELD: Record<ContainerSize, string> = {
  CONTAINER_20_FT: 'twentyFt',
  CONTAINER_40_FT: 'fortyFt',
};

/**
 * Is this container loading possible and safe, and what does it come to?
 *
 * The ONE place a container figure is judged. The seller's save, the seller's
 * preview while typing, and the tests all call this, so the form cannot accept
 * a figure the save refuses.
 */
export function validateContainerLoading(
  input: LoadingInput,
  limitsFor: (size: ContainerSize) => ContainerLimits,
): LoadingValidation {
  const issues: LoadingIssue[] = [];
  const { carton } = input;
  const sizes: Record<ContainerSize, SizeResult | null> = {
    CONTAINER_20_FT: null,
    CONTAINER_40_FT: null,
  };

  // --- The carton --------------------------------------------------------

  if (!isPositiveInteger(carton.piecesPerCarton)) {
    issues.push({
      field: 'piecesPerCarton',
      code: 'PIECES_PER_CARTON_REQUIRED',
      message: 'Say how many pieces are in one carton, as a whole number.',
    });
  } else if (carton.piecesPerCarton > MAX_PIECES_PER_CONTAINER) {
    issues.push({
      field: 'piecesPerCarton',
      code: 'PIECES_PER_CARTON_TOO_LARGE',
      message: 'That is more pieces than one carton can hold on this system.',
    });
  }

  for (const [field, value] of [
    ['cartonLengthMm', carton.lengthMm],
    ['cartonWidthMm', carton.widthMm],
    ['cartonHeightMm', carton.heightMm],
  ] as const) {
    if (!isPositiveInteger(value)) {
      issues.push({
        field,
        code: 'CARTON_DIMENSION_REQUIRED',
        message: 'Give each carton dimension in whole millimetres.',
      });
    }
  }

  if (carton.grossWeightGrams <= 0n) {
    issues.push({
      field: 'grossWeightPerCartonGrams',
      code: 'CARTON_WEIGHT_REQUIRED',
      message: 'Give the gross weight of one packed carton.',
    });
  }

  if (carton.maxStackLayers !== null && !isPositiveInteger(carton.maxStackLayers)) {
    issues.push({
      field: 'maxStackLayers',
      code: 'STACK_LAYERS_INVALID',
      message: 'The stacking limit is a whole number of cartons, one or more.',
    });
  }

  const palletised = input.loadingMethod === 'PALLET_LOADED';
  if (palletised && !isPositiveInteger(input.cartonsPerPallet)) {
    issues.push({
      field: 'cartonsPerPallet',
      code: 'CARTONS_PER_PALLET_REQUIRED',
      message: 'Say how many cartons go on one pallet.',
    });
  }

  const cartonUsable = issues.length === 0;

  // --- Each container size ----------------------------------------------------

  for (const size of CONTAINER_SIZES) {
    const stated = input.sizes[size];
    if (stated === null) continue;

    const prefix = SIZE_FIELD[size];
    const limits = limitsFor(size);

    let cartons: number | null;
    if (palletised) {
      if (!isPositiveInteger(stated.palletsPerContainer)) {
        issues.push({
          field: `${prefix}.palletsPerContainer`,
          code: 'PALLETS_PER_CONTAINER_REQUIRED',
          message: 'Say how many pallets go in one container.',
        });
        continue;
      }
      cartons =
        isPositiveInteger(input.cartonsPerPallet) &&
        Number.isSafeInteger(stated.palletsPerContainer * input.cartonsPerPallet)
          ? stated.palletsPerContainer * input.cartonsPerPallet
          : null;
    } else {
      if (!isPositiveInteger(stated.cartonsPerContainer)) {
        issues.push({
          field: `${prefix}.cartonsPerContainer`,
          code: 'CARTONS_PER_CONTAINER_REQUIRED',
          message: 'Say how many cartons go in one container, as a whole number.',
        });
        continue;
      }
      cartons = stated.cartonsPerContainer;
    }

    if (cartons === null || !cartonUsable) continue;

    const pieces = cartons * carton.piecesPerCarton;
    if (!Number.isSafeInteger(pieces) || pieces > MAX_PIECES_PER_CONTAINER) {
      issues.push({
        field: `${prefix}.cartonsPerContainer`,
        code: 'PIECES_PER_CONTAINER_TOO_LARGE',
        message: 'That is more pieces than one container can hold on this system.',
      });
      continue;
    }

    if (!cartonFits(carton, limits)) {
      issues.push({
        field: 'cartonLengthMm',
        code: 'CARTON_DOES_NOT_FIT',
        message: 'One carton of that size does not fit inside the container in any direction.',
      });
      continue;
    }

    const payloadGrams = BigInt(cartons) * carton.grossWeightGrams;
    if (payloadGrams > limits.maxPayloadGrams) {
      issues.push({
        field: `${prefix}.cartonsPerContainer`,
        code: 'PAYLOAD_EXCEEDED',
        message:
          'That many cartons weighs more than the maximum payload allowed for this container.',
        meta: {
          payloadKg: Number(payloadGrams / 1000n),
          maxPayloadKg: Number(limits.maxPayloadGrams / 1000n),
        },
      });
      continue;
    }

    const cargoVolumeMm3 =
      BigInt(cartons) * BigInt(carton.lengthMm) * BigInt(carton.widthMm) * BigInt(carton.heightMm);
    const capacity = containerVolumeMm3(limits);
    if (cargoVolumeMm3 > capacity) {
      issues.push({
        field: `${prefix}.cartonsPerContainer`,
        code: 'VOLUME_EXCEEDED',
        message: 'That many cartons takes up more room than the inside of the container.',
      });
      continue;
    }

    sizes[size] = {
      cartonsPerContainer: cartons,
      piecesPerContainer: pieces,
      palletsPerContainer: palletised ? stated.palletsPerContainer : null,
      payloadGrams,
      cargoVolumeMm3,
      volumeUsePercent: Number((cargoVolumeMm3 * 100n) / capacity),
      estimate: estimateCartonsPerContainer(carton, limits),
    };
  }

  return { issues, sizes };
}

/**
 * Where a saved size's figure now comes from.
 *
 * Verified only when the seller ticked it on THIS save, or when it was
 * verified before and nothing it depends on has changed. Changing the carton
 * or the count drops a verified figure back to an estimate until the seller
 * confirms it again - a buyer must not order against a figure the seller has
 * not looked at since it moved.
 */
export function resolveSource(input: {
  verifiedNow: boolean;
  previousSource: CapacitySource | null;
  previousVerifiedAt: Date | null;
  figuresChanged: boolean;
  now: Date;
}): { source: CapacitySource; verifiedAt: Date | null } {
  if (input.verifiedNow) return { source: 'SELLER_VERIFIED', verifiedAt: input.now };
  if (
    input.previousSource === 'SELLER_VERIFIED' &&
    input.previousVerifiedAt !== null &&
    !input.figuresChanged
  ) {
    return { source: 'SELLER_VERIFIED', verifiedAt: input.previousVerifiedAt };
  }
  return { source: 'CALCULATED_ESTIMATE', verifiedAt: null };
}

// ---------------------------------------------------------------------------
// Pieces and containers
// ---------------------------------------------------------------------------

export interface ContainerEquivalent {
  /** Whole containers in this many pieces. */
  fullContainers: number;
  /** Pieces left over after the whole containers - a partial container. */
  remainderPieces: number;
  isWholeContainers: boolean;
}

/**
 * How many containers a piece count is, WITHOUT rounding it.
 *
 * Pieces stay the authority. "9,000 pieces" against a 12,000-piece container
 * is 0 full containers and a 9,000-piece partial load, and is shown as exactly
 * that - never as "1 container".
 */
export function containerEquivalent(
  pieces: number,
  piecesPerContainer: number,
): ContainerEquivalent {
  if (!isPositiveInteger(piecesPerContainer) || !Number.isSafeInteger(pieces) || pieces < 0) {
    return {
      fullContainers: 0,
      remainderPieces: Math.max(0, Math.trunc(pieces)),
      isWholeContainers: false,
    };
  }
  const fullContainers = Math.floor(pieces / piecesPerContainer);
  const remainderPieces = pieces - fullContainers * piecesPerContainer;
  return { fullContainers, remainderPieces, isWholeContainers: remainderPieces === 0 };
}

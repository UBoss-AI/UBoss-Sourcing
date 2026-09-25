/**
 * Container loading: how many pieces of one listing fit in a 20-ft and a 40-ft
 * container, as the seller states and verifies it.
 *
 * The rules are in `domain/container-loading.ts`; this file reads and writes
 * the row, holds the seller to their own listing, and keeps the audit trail.
 *
 * Two readers, two answers:
 *
 *   - The SELLER sees everything, including an unverified estimate and the
 *     system's own arithmetic, clearly labelled.
 *   - The BUYER (`containerOptionsForOffer`) sees a size only when the seller
 *     has VERIFIED it. An estimate is never offered to a buyer, and a size
 *     with nothing configured is reported as unavailable - never as zero.
 */
import { z } from 'zod';

import { env } from '../../config/env.js';
import {
  CONTAINER_SIZES,
  containerLimits,
  resolveSource,
  validateContainerLoading,
  type CapacitySource,
  type ContainerLimits,
  type ContainerSize,
  type LoadingInput,
  type LoadingValidation,
} from '../../domain/container-loading.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { toGrams, toMillimetres } from '../../domain/packaging.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import {
  assertSellerOwnership,
  assertSellerPermission,
  type SellerMembership,
} from './account.service.js';
import { recordSellerAudit } from './audit.service.js';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** The configured limits of one container size. */
export function limitsFor(size: ContainerSize): ContainerLimits {
  return containerLimits(
    size,
    size === 'CONTAINER_20_FT'
      ? env.CONTAINER_20FT_MAX_PAYLOAD_KG
      : env.CONTAINER_40FT_MAX_PAYLOAD_KG,
  );
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const positiveInt = z.number().int().positive().max(10_000_000);
const measurement = z.number().positive().max(1_000_000);

const sizeSchema = z
  .object({
    cartonsPerContainer: positiveInt.nullable().default(null),
    palletsPerContainer: z.number().int().positive().max(1000).nullable().default(null),
    /** "I have loaded or checked this figure." */
    verified: z.boolean().default(false),
  })
  .strict();

export const containerLoadingInputSchema = z
  .object({
    piecesPerCarton: positiveInt,
    cartonLength: measurement,
    cartonWidth: measurement,
    cartonHeight: measurement,
    dimensionUnit: z.enum(['MM', 'CM', 'M', 'IN']).default('MM'),
    grossWeightPerCarton: measurement,
    weightUnit: z.enum(['G', 'KG', 'LB']).default('KG'),
    maxStackLayers: z.number().int().positive().max(100).nullable().default(null),
    loadingMethod: z.enum(['CARTON_LOADED', 'PALLET_LOADED']).default('CARTON_LOADED'),
    cartonsPerPallet: z.number().int().positive().max(10_000).nullable().default(null),
    /** Null switches that size off. */
    twentyFt: sizeSchema.nullable().default(null),
    fortyFt: sizeSchema.nullable().default(null),
    notes: z.string().trim().max(1000).nullable().default(null),
    /** Optimistic concurrency: the version the form loaded, null for a first save. */
    expectedVersion: z.number().int().min(0).nullable().default(null),
  })
  .strict();

export type ContainerLoadingInput = z.infer<typeof containerLoadingInputSchema>;

function toLoadingInput(body: ContainerLoadingInput): LoadingInput {
  const size = (entry: ContainerLoadingInput['twentyFt']) =>
    entry === null
      ? null
      : {
          cartonsPerContainer: entry.cartonsPerContainer,
          palletsPerContainer: entry.palletsPerContainer,
          verified: entry.verified,
        };

  return {
    carton: {
      piecesPerCarton: body.piecesPerCarton,
      lengthMm: toMillimetres(body.cartonLength, body.dimensionUnit, 'cartonLength') ?? 0,
      widthMm: toMillimetres(body.cartonWidth, body.dimensionUnit, 'cartonWidth') ?? 0,
      heightMm: toMillimetres(body.cartonHeight, body.dimensionUnit, 'cartonHeight') ?? 0,
      grossWeightGrams:
        toGrams(body.grossWeightPerCarton, body.weightUnit, 'grossWeightPerCarton') ?? 0n,
      maxStackLayers: body.maxStackLayers,
    },
    loadingMethod: body.loadingMethod,
    cartonsPerPallet: body.loadingMethod === 'PALLET_LOADED' ? body.cartonsPerPallet : null,
    sizes: { CONTAINER_20_FT: size(body.twentyFt), CONTAINER_40_FT: size(body.fortyFt) },
  };
}

// ---------------------------------------------------------------------------
// The seller's view
// ---------------------------------------------------------------------------

type LoadingRow = NonNullable<Awaited<ReturnType<typeof prisma.sellerContainerLoading.findUnique>>>;

interface SizeView {
  cartonsPerContainer: number | null;
  palletsPerContainer: number | null;
  piecesPerContainer: number | null;
  source: CapacitySource | null;
  verifiedAt: string | null;
  /** Grams, as a string like every large integer this API returns. */
  payloadGrams: string | null;
  volumeUsePercent: number | null;
  /** The system's estimate, a starting point. Null when none can be made. */
  estimate: { cartons: number; pieces: number; limitedBy: string } | null;
}

function limitsView() {
  return Object.fromEntries(
    CONTAINER_SIZES.map((size) => {
      const limits = limitsFor(size);
      return [
        size,
        {
          maxPayloadGrams: limits.maxPayloadGrams.toString(),
          internalLengthMm: limits.internalLengthMm,
          internalWidthMm: limits.internalWidthMm,
          internalHeightMm: limits.internalHeightMm,
        },
      ];
    }),
  );
}

function rowToInput(row: LoadingRow): LoadingInput {
  return {
    carton: {
      piecesPerCarton: row.piecesPerCarton,
      lengthMm: row.cartonLengthMm,
      widthMm: row.cartonWidthMm,
      heightMm: row.cartonHeightMm,
      grossWeightGrams: row.grossWeightPerCartonGrams,
      maxStackLayers: row.maxStackLayers,
    },
    loadingMethod: row.loadingMethod,
    cartonsPerPallet: row.cartonsPerPallet,
    sizes: {
      CONTAINER_20_FT:
        row.cartonsPer20FtContainer === null
          ? null
          : {
              cartonsPerContainer: row.cartonsPer20FtContainer,
              palletsPerContainer: row.palletsPer20FtContainer,
              verified: false,
            },
      CONTAINER_40_FT:
        row.cartonsPer40FtContainer === null
          ? null
          : {
              cartonsPerContainer: row.cartonsPer40FtContainer,
              palletsPerContainer: row.palletsPer40FtContainer,
              verified: false,
            },
    },
  };
}

function sizeView(
  validation: LoadingValidation,
  size: ContainerSize,
  stored: { source: CapacitySource | null; verifiedAt: Date | null; pieces: number | null } | null,
  piecesPerCarton: number,
): SizeView | null {
  const derived = validation.sizes[size];
  if (derived === null && stored === null) return null;
  const estimate = derived?.estimate ?? null;
  return {
    cartonsPerContainer: derived?.cartonsPerContainer ?? null,
    palletsPerContainer: derived?.palletsPerContainer ?? null,
    piecesPerContainer: stored?.pieces ?? derived?.piecesPerContainer ?? null,
    source: stored?.source ?? null,
    verifiedAt: stored?.verifiedAt?.toISOString() ?? null,
    payloadGrams: derived?.payloadGrams.toString() ?? null,
    volumeUsePercent: derived?.volumeUsePercent ?? null,
    estimate:
      estimate === null
        ? null
        : {
            cartons: estimate.cartons,
            pieces: estimate.cartons * piecesPerCarton,
            limitedBy: estimate.limitedBy,
          },
  };
}

function toView(offerId: string, row: LoadingRow | null) {
  if (row === null) {
    return { offerId, configured: false, version: null, limits: limitsView() };
  }
  const validation = validateContainerLoading(rowToInput(row), limitsFor);
  return {
    offerId,
    configured: true,
    version: row.version,
    carton: {
      piecesPerCarton: row.piecesPerCarton,
      lengthMm: row.cartonLengthMm,
      widthMm: row.cartonWidthMm,
      heightMm: row.cartonHeightMm,
      grossWeightGrams: row.grossWeightPerCartonGrams.toString(),
      maxStackLayers: row.maxStackLayers,
    },
    loadingMethod: row.loadingMethod,
    cartonsPerPallet: row.cartonsPerPallet,
    sizes: {
      CONTAINER_20_FT: sizeView(
        validation,
        'CONTAINER_20_FT',
        row.source20Ft === null
          ? null
          : {
              source: row.source20Ft,
              verifiedAt: row.verified20FtAt,
              pieces: row.piecesPer20FtContainer,
            },
        row.piecesPerCarton,
      ),
      CONTAINER_40_FT: sizeView(
        validation,
        'CONTAINER_40_FT',
        row.source40Ft === null
          ? null
          : {
              source: row.source40Ft,
              verifiedAt: row.verified40FtAt,
              pieces: row.piecesPer40FtContainer,
            },
        row.piecesPerCarton,
      ),
    },
    notes: row.notes,
    updatedAt: row.updatedAt.toISOString(),
    updatedByLabel: row.updatedByLabel,
    limits: limitsView(),
  };
}

async function loadOwnedOffer(membership: SellerMembership, offerId: string) {
  const offer = await prisma.sellerOffer.findUnique({
    where: { id: offerId },
    select: { id: true, sellerAccountId: true, sellerSku: true },
  });
  assertSellerOwnership(membership, offer?.sellerAccountId ?? null, 'Listing');
  if (offer === null) throw notFound('Listing');
  return offer;
}

export async function readContainerLoading(membership: SellerMembership, offerId: string) {
  assertSellerPermission(membership, SellerPermission.LISTING_READ);
  await loadOwnedOffer(membership, offerId);
  const row = await prisma.sellerContainerLoading.findUnique({ where: { offerId } });
  return toView(offerId, row);
}

function refuse(validation: LoadingValidation): never {
  throw badRequest(
    ErrorCode.CONTAINER_LOADING_INVALID,
    validation.issues[0]?.message ?? 'The container loading does not hold together.',
    validation.issues.map((issue) => ({
      field: issue.field,
      code: issue.code,
      message: issue.message,
      ...(issue.meta === undefined ? {} : { meta: issue.meta }),
    })),
  );
}

/**
 * What a figure works out to, without saving it.
 *
 * The form asks this while the seller types, so the pieces per container, the
 * payload and the estimate come from the same function the save is held to.
 * Problems are returned, not thrown - a half-typed form is not an error.
 */
export async function previewContainerLoading(
  membership: SellerMembership,
  offerId: string,
  body: ContainerLoadingInput,
) {
  assertSellerPermission(membership, SellerPermission.LISTING_READ);
  await loadOwnedOffer(membership, offerId);
  const input = toLoadingInput(body);
  const validation = validateContainerLoading(input, limitsFor);
  return {
    issues: validation.issues,
    sizes: Object.fromEntries(
      CONTAINER_SIZES.map((size) => [
        size,
        sizeView(validation, size, null, input.carton.piecesPerCarton),
      ]),
    ),
    limits: limitsView(),
  };
}

function auditShape(row: LoadingRow | null) {
  if (row === null) return undefined;
  return {
    piecesPerCarton: row.piecesPerCarton,
    carton: `${String(row.cartonLengthMm)}x${String(row.cartonWidthMm)}x${String(row.cartonHeightMm)} mm`,
    grossWeightPerCartonGrams: row.grossWeightPerCartonGrams.toString(),
    maxStackLayers: row.maxStackLayers,
    loadingMethod: row.loadingMethod,
    cartonsPerPallet: row.cartonsPerPallet,
    twentyFt: {
      cartons: row.cartonsPer20FtContainer,
      pieces: row.piecesPer20FtContainer,
      source: row.source20Ft,
      verifiedAt: row.verified20FtAt?.toISOString() ?? null,
    },
    fortyFt: {
      cartons: row.cartonsPer40FtContainer,
      pieces: row.piecesPer40FtContainer,
      source: row.source40Ft,
      verifiedAt: row.verified40FtAt?.toISOString() ?? null,
    },
    version: row.version,
  };
}

/**
 * Save a listing's container loading.
 *
 * Refused outright when impossible or unsafe. A size whose carton or count
 * changed and was not re-verified on this save becomes an estimate, and stops
 * being offered to buyers until the seller confirms it. Existing preorders are
 * untouched: each holds its own snapshot of the loading it was made under.
 */
export async function saveContainerLoading(
  membership: SellerMembership,
  offerId: string,
  body: ContainerLoadingInput,
  actorUserId: string | null,
) {
  assertSellerPermission(membership, SellerPermission.LISTING_WRITE);
  const offer = await loadOwnedOffer(membership, offerId);

  const input = toLoadingInput(body);
  const validation = validateContainerLoading(input, limitsFor);
  if (validation.issues.length > 0) refuse(validation);

  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const existing = await tx.sellerContainerLoading.findUnique({ where: { offerId } });

    if ((existing?.version ?? null) !== body.expectedVersion) {
      throw conflict(
        ErrorCode.CONFLICT,
        'The container loading was changed since you opened it. Reload it and try again.',
        [{ code: 'STALE', meta: { version: existing?.version ?? null } }],
      );
    }

    const cartonChanged =
      existing === null ||
      existing.piecesPerCarton !== input.carton.piecesPerCarton ||
      existing.cartonLengthMm !== input.carton.lengthMm ||
      existing.cartonWidthMm !== input.carton.widthMm ||
      existing.cartonHeightMm !== input.carton.heightMm ||
      existing.grossWeightPerCartonGrams !== input.carton.grossWeightGrams ||
      existing.maxStackLayers !== input.carton.maxStackLayers ||
      existing.loadingMethod !== input.loadingMethod ||
      existing.cartonsPerPallet !== input.cartonsPerPallet;

    const columns = (size: ContainerSize) => {
      const derived = validation.sizes[size];
      const stated = input.sizes[size];
      const twenty = size === 'CONTAINER_20_FT';
      if (derived === null || stated === null) {
        return { cartons: null, pallets: null, pieces: null, source: null, verifiedAt: null };
      }
      const previousCartons = twenty
        ? existing?.cartonsPer20FtContainer
        : existing?.cartonsPer40FtContainer;
      const resolved = resolveSource({
        verifiedNow: stated.verified,
        previousSource: (twenty ? existing?.source20Ft : existing?.source40Ft) ?? null,
        previousVerifiedAt: (twenty ? existing?.verified20FtAt : existing?.verified40FtAt) ?? null,
        figuresChanged: cartonChanged || previousCartons !== derived.cartonsPerContainer,
        now,
      });
      return {
        cartons: derived.cartonsPerContainer,
        pallets: derived.palletsPerContainer,
        pieces: derived.piecesPerContainer,
        source: resolved.source,
        verifiedAt: resolved.verifiedAt,
      };
    };

    const twenty = columns('CONTAINER_20_FT');
    const forty = columns('CONTAINER_40_FT');

    const data = {
      piecesPerCarton: input.carton.piecesPerCarton,
      cartonLengthMm: input.carton.lengthMm,
      cartonWidthMm: input.carton.widthMm,
      cartonHeightMm: input.carton.heightMm,
      grossWeightPerCartonGrams: input.carton.grossWeightGrams,
      maxStackLayers: input.carton.maxStackLayers,
      loadingMethod: input.loadingMethod,
      cartonsPerPallet: input.cartonsPerPallet,
      palletsPer20FtContainer: twenty.pallets,
      cartonsPer20FtContainer: twenty.cartons,
      piecesPer20FtContainer: twenty.pieces,
      source20Ft: twenty.source,
      verified20FtAt: twenty.verifiedAt,
      palletsPer40FtContainer: forty.pallets,
      cartonsPer40FtContainer: forty.cartons,
      piecesPer40FtContainer: forty.pieces,
      source40Ft: forty.source,
      verified40FtAt: forty.verifiedAt,
      notes: body.notes === '' ? null : body.notes,
      updatedByLabel: membership.displayName.slice(0, 160),
    };

    let saved: LoadingRow;
    if (existing === null) {
      saved = await tx.sellerContainerLoading.create({
        data: {
          id: newId(),
          offerId,
          sellerAccountId: membership.sellerAccountId,
          version: 1,
          ...data,
        },
      });
    } else {
      // Conditional on the version read above, so two tabs saving at once
      // cannot both win.
      const updated = await tx.sellerContainerLoading.updateMany({
        where: { id: existing.id, version: existing.version },
        data: { ...data, version: { increment: 1 } },
      });
      if (updated.count !== 1) {
        throw conflict(
          ErrorCode.CONFLICT,
          'The container loading was changed since you opened it. Reload it and try again.',
          [{ code: 'STALE' }],
        );
      }
      saved = await tx.sellerContainerLoading.findUniqueOrThrow({ where: { id: existing.id } });
    }

    const describe = (label: string, pieces: number | null, source: CapacitySource | null) =>
      pieces === null
        ? `${label} off`
        : `${label} ${pieces.toLocaleString('en')} pieces (${source === 'SELLER_VERIFIED' ? 'verified' : 'estimate'})`;

    await recordSellerAudit({
      tx,
      sellerAccountId: membership.sellerAccountId,
      action: 'seller.container_loading.saved',
      actor: { type: 'CUSTOMER', userId: actorUserId, label: membership.displayName },
      resourceType: 'seller_container_loading',
      resourceId: saved.id,
      before: auditShape(existing),
      after: auditShape(saved),
      summary: `Container loading for ${offer.sellerSku}: ${describe('20-ft', saved.piecesPer20FtContainer, saved.source20Ft)}, ${describe('40-ft', saved.piecesPer40FtContainer, saved.source40Ft)}.`,
    });

    return toView(offerId, saved);
  });
}

// ---------------------------------------------------------------------------
// The buyer's side
// ---------------------------------------------------------------------------

/** NOT_OFFERED: verified, but the seller's preorder terms do not permit containers. */
export type ContainerUnavailableReason = 'NOT_CONFIGURED' | 'NOT_VERIFIED' | 'NOT_OFFERED';

export interface ContainerOption {
  unit: ContainerSize;
  available: boolean;
  /** Null unless available. Never an estimate, never zero. */
  piecesPerContainer: number | null;
  cartonsPerContainer: number | null;
  piecesPerCarton: number | null;
  verifiedAt: string | null;
  reason: ContainerUnavailableReason | null;
}

/**
 * The container sizes a buyer may order this listing in.
 *
 * A size is available only when it is SELLER_VERIFIED. Everything else is
 * unavailable with a reason, and carries no figure at all - a buyer shown
 * "0 pieces" or an estimate would be shown a number nobody stands behind.
 */
export async function containerOptionsForOffer(offerId: string | null): Promise<{
  options: ContainerOption[];
  row: LoadingRow | null;
}> {
  const row =
    offerId === null
      ? null
      : await prisma.sellerContainerLoading.findUnique({ where: { offerId } });

  const options = CONTAINER_SIZES.map((unit): ContainerOption => {
    const twenty = unit === 'CONTAINER_20_FT';
    const pieces =
      row === null ? null : twenty ? row.piecesPer20FtContainer : row.piecesPer40FtContainer;
    const source = row === null ? null : twenty ? row.source20Ft : row.source40Ft;
    const verifiedAt = row === null ? null : twenty ? row.verified20FtAt : row.verified40FtAt;

    if (row === null || pieces === null || source === null) {
      return {
        unit,
        available: false,
        piecesPerContainer: null,
        cartonsPerContainer: null,
        piecesPerCarton: null,
        verifiedAt: null,
        reason: 'NOT_CONFIGURED',
      };
    }
    if (source !== 'SELLER_VERIFIED' || pieces <= 0) {
      return {
        unit,
        available: false,
        piecesPerContainer: null,
        cartonsPerContainer: null,
        piecesPerCarton: null,
        verifiedAt: null,
        reason: 'NOT_VERIFIED',
      };
    }
    return {
      unit,
      available: true,
      piecesPerContainer: pieces,
      cartonsPerContainer: twenty ? row.cartonsPer20FtContainer : row.cartonsPer40FtContainer,
      piecesPerCarton: row.piecesPerCarton,
      verifiedAt: verifiedAt?.toISOString() ?? null,
      reason: null,
    };
  });

  return { options, row };
}

/**
 * The frozen record a container preorder keeps of the loading it was made
 * under. Money-free, and every large integer as a string.
 */
export function containerSnapshot(row: LoadingRow, unit: ContainerSize): Record<string, unknown> {
  const twenty = unit === 'CONTAINER_20_FT';
  return {
    unit,
    piecesPerCarton: row.piecesPerCarton,
    cartonsPerContainer: twenty ? row.cartonsPer20FtContainer : row.cartonsPer40FtContainer,
    palletsPerContainer: twenty ? row.palletsPer20FtContainer : row.palletsPer40FtContainer,
    piecesPerContainer: twenty ? row.piecesPer20FtContainer : row.piecesPer40FtContainer,
    loadingMethod: row.loadingMethod,
    cartonsPerPallet: row.cartonsPerPallet,
    cartonLengthMm: row.cartonLengthMm,
    cartonWidthMm: row.cartonWidthMm,
    cartonHeightMm: row.cartonHeightMm,
    grossWeightPerCartonGrams: row.grossWeightPerCartonGrams.toString(),
    source: twenty ? row.source20Ft : row.source40Ft,
    verifiedAt: (twenty ? row.verified20FtAt : row.verified40FtAt)?.toISOString() ?? null,
    version: row.version,
  };
}

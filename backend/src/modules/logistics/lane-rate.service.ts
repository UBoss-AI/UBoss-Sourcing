/**
 * The operator's own rate cards ("lanes") - checklist Master row 71.
 *
 * A lane is origin to destination by one mode with one carrier, a transit
 * window, a currency, a minimum charge, a fuel surcharge and weight bands.
 * `isServiceable` switches a lane off without deleting it; `validFrom` /
 * `validTo` bound when it may price anything. Sellers keep their own rate
 * cards (`seller_logistics_rate_cards`); these are the operator's.
 *
 * PRICING ONE PARCEL (`quoteLanes`)
 *
 *   band  = the band whose [min, max] holds the weight
 *   base  = band.amountMinor + band.perKgMinor x started kilograms
 *   base  = max(base, lane.minimumChargeMinor)
 *   fuel  = base x fuelSurchargeBasisPoints / 10 000, rounded half up
 *   total = base + fuel
 *
 * All integer minor units. Every saved change bumps `version`, so a quote can
 * be traced to what the lane said at the time.
 */
import { z } from 'zod';
import type { LogisticsLane, LogisticsLaneBand, Prisma } from '../../generated/prisma/client.js';
import { badRequest, ErrorCode, notFound } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import type { SettingsActor } from '../settings/settings.service.js';

const MODES = ['ROAD', 'AIR', 'SEA', 'RAIL', 'COURIER', 'MULTIMODAL'] as const;
const COUNTRY = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/)
  .transform((value) => value.toUpperCase());
const MINOR = z.string().trim().regex(/^[0-9]{1,18}$/);

export const laneInput = z
  .object({
    name: z.string().trim().min(2).max(160),
    originCountry: COUNTRY,
    originRegion: z.string().trim().max(64).default(''),
    destinationCountry: COUNTRY,
    destinationRegion: z.string().trim().max(64).default(''),
    mode: z.enum(MODES),
    carrierName: z.string().trim().min(1).max(120),
    serviceLevel: z.string().trim().min(1).max(48).default('STANDARD'),
    transitDaysMin: z.number().int().min(0).max(365),
    transitDaysMax: z.number().int().min(0).max(365),
    isServiceable: z.boolean().default(true),
    currency: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/)
      .transform((value) => value.toUpperCase()),
    minimumChargeMinor: MINOR.default('0'),
    fuelSurchargeBasisPoints: z.number().int().min(0).max(10_000).default(0),
    validFrom: z.coerce.date(),
    validTo: z.coerce.date().nullable().optional(),
    isActive: z.boolean().default(true),
    bands: z
      .array(
        z
          .object({
            minWeightGrams: z.number().int().min(0).max(100_000_000),
            maxWeightGrams: z.number().int().min(1).max(100_000_000).nullable(),
            amountMinor: MINOR,
            perKgMinor: MINOR.default('0'),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();
export type LaneInput = z.infer<typeof laneInput>;

export const laneQuoteInput = z
  .object({
    originCountry: COUNTRY,
    destinationCountry: COUNTRY,
    destinationRegion: z.string().trim().max(64).optional(),
    mode: z.enum(MODES).optional(),
    weightGrams: z.number().int().min(1).max(100_000_000),
    at: z.coerce.date().optional(),
  })
  .strict();
export type LaneQuoteInput = z.infer<typeof laneQuoteInput>;

type LaneRow = LogisticsLane & { bands: LogisticsLaneBand[] };

export interface LaneView {
  id: string;
  name: string;
  originCountry: string;
  originRegion: string;
  destinationCountry: string;
  destinationRegion: string;
  mode: (typeof MODES)[number];
  carrierName: string;
  serviceLevel: string;
  transitDaysMin: number;
  transitDaysMax: number;
  isServiceable: boolean;
  currency: string;
  minimumChargeMinor: string;
  fuelSurchargeBasisPoints: number;
  validFrom: string;
  validTo: string | null;
  isActive: boolean;
  version: number;
  bands: { minWeightGrams: number; maxWeightGrams: number | null; amountMinor: string; perKgMinor: string }[];
  updatedAt: string;
}

function view(row: LaneRow): LaneView {
  return {
    id: row.id,
    name: row.name,
    originCountry: row.originCountry,
    originRegion: row.originRegion,
    destinationCountry: row.destinationCountry,
    destinationRegion: row.destinationRegion,
    mode: row.mode,
    carrierName: row.carrierName,
    serviceLevel: row.serviceLevel,
    transitDaysMin: row.transitDaysMin,
    transitDaysMax: row.transitDaysMax,
    isServiceable: row.isServiceable,
    currency: row.currency,
    minimumChargeMinor: row.minimumChargeMinor.toString(),
    fuelSurchargeBasisPoints: row.fuelSurchargeBasisPoints,
    validFrom: row.validFrom.toISOString(),
    validTo: row.validTo === null ? null : row.validTo.toISOString(),
    isActive: row.isActive,
    version: row.version,
    bands: [...row.bands]
      .sort((a, b) => a.minWeightGrams - b.minWeightGrams)
      .map((band) => ({
        minWeightGrams: band.minWeightGrams,
        maxWeightGrams: band.maxWeightGrams,
        amountMinor: band.amountMinor.toString(),
        perKgMinor: band.perKgMinor.toString(),
      })),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function invalid(field: string, code: string, message: string) {
  return badRequest(ErrorCode.LOGISTICS_LANE_INVALID, message, [{ field, code }]);
}

/** Cross-field checks the schema cannot express. */
function assertCoherent(input: LaneInput): void {
  if (input.transitDaysMax < input.transitDaysMin) {
    throw invalid('transitDaysMax', 'OUT_OF_ORDER', 'The slowest transit time cannot be shorter than the fastest.');
  }
  if (input.validTo !== undefined && input.validTo !== null && input.validTo.getTime() <= input.validFrom.getTime()) {
    throw invalid('validTo', 'BEFORE_START', 'A rate card cannot end before it starts.');
  }
  const bands = [...input.bands].sort((a, b) => a.minWeightGrams - b.minWeightGrams);
  for (const [index, band] of bands.entries()) {
    if (band.maxWeightGrams !== null && band.maxWeightGrams < band.minWeightGrams) {
      throw invalid(`bands.${index}.maxWeightGrams`, 'OUT_OF_ORDER', 'A weight band ends before it starts.');
    }
    const next = bands[index + 1];
    if (next !== undefined && (band.maxWeightGrams === null || band.maxWeightGrams >= next.minWeightGrams)) {
      throw invalid(`bands.${index + 1}.minWeightGrams`, 'OVERLAP', 'Two weight bands overlap.');
    }
  }
}

export async function listLanes(): Promise<LaneView[]> {
  const rows = await prisma.logisticsLane.findMany({
    include: { bands: true },
    orderBy: [{ originCountry: 'asc' }, { destinationCountry: 'asc' }, { mode: 'asc' }, { name: 'asc' }],
    take: 1000,
  });
  return rows.map(view);
}

function auditSnapshot(lane: LaneView): Record<string, unknown> {
  return {
    name: lane.name,
    route: `${lane.originCountry}->${lane.destinationCountry}`,
    mode: lane.mode,
    carrierName: lane.carrierName,
    currency: lane.currency,
    isServiceable: lane.isServiceable,
    isActive: lane.isActive,
    version: lane.version,
    bands: lane.bands,
  };
}

export async function saveLane(id: string | null, input: LaneInput, actor: SettingsActor): Promise<LaneView> {
  assertCoherent(input);
  const data = {
    name: input.name,
    originCountry: input.originCountry,
    originRegion: input.originRegion,
    destinationCountry: input.destinationCountry,
    destinationRegion: input.destinationRegion,
    mode: input.mode,
    carrierName: input.carrierName,
    serviceLevel: input.serviceLevel,
    transitDaysMin: input.transitDaysMin,
    transitDaysMax: input.transitDaysMax,
    isServiceable: input.isServiceable,
    currency: input.currency,
    minimumChargeMinor: BigInt(input.minimumChargeMinor),
    fuelSurchargeBasisPoints: input.fuelSurchargeBasisPoints,
    validFrom: input.validFrom,
    validTo: input.validTo ?? null,
    isActive: input.isActive,
    updatedByUserId: actor.userId,
  };
  const bands = (laneId: string): Prisma.LogisticsLaneBandCreateManyInput[] =>
    input.bands.map((band, index) => ({
      id: newId(),
      laneId,
      minWeightGrams: band.minWeightGrams,
      maxWeightGrams: band.maxWeightGrams,
      amountMinor: BigInt(band.amountMinor),
      perKgMinor: BigInt(band.perKgMinor),
      sortOrder: index,
    }));

  return prisma.$transaction(async (tx) => {
    const before = id === null ? null : await tx.logisticsLane.findUnique({ where: { id }, include: { bands: true } });
    if (id !== null && before === null) throw notFound('Rate card');
    const laneId = id ?? newId();
    if (id === null) {
      await tx.logisticsLane.create({ data: { id: laneId, createdByUserId: actor.userId, ...data } });
    } else {
      await tx.logisticsLane.update({ where: { id }, data: { ...data, version: { increment: 1 } } });
      await tx.logisticsLaneBand.deleteMany({ where: { laneId } });
    }
    await tx.logisticsLaneBand.createMany({ data: bands(laneId) });
    const row = await tx.logisticsLane.findUniqueOrThrow({ where: { id: laneId }, include: { bands: true } });
    const after = view(row);
    await recordAudit(
      {
        action: AuditAction.SETTINGS_UPDATED,
        resourceType: 'logistics_lane',
        resourceId: laneId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: before === null ? null : auditSnapshot(view(before)),
        after: auditSnapshot(after),
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
    return after;
  });
}

/** The price of `weightGrams` on one lane, or null when no band holds it. */
export function priceOnLane(
  lane: { minimumChargeMinor: bigint; fuelSurchargeBasisPoints: number },
  bands: readonly { minWeightGrams: number; maxWeightGrams: number | null; amountMinor: bigint; perKgMinor: bigint }[],
  weightGrams: number,
): { baseMinor: bigint; fuelMinor: bigint; totalMinor: bigint } | null {
  const band = bands.find(
    (candidate) =>
      weightGrams >= candidate.minWeightGrams && (candidate.maxWeightGrams === null || weightGrams <= candidate.maxWeightGrams),
  );
  if (band === undefined) return null;
  const startedKg = BigInt(Math.ceil(weightGrams / 1000));
  let base = band.amountMinor + band.perKgMinor * startedKg;
  if (base < lane.minimumChargeMinor) base = lane.minimumChargeMinor;
  const fuel = (base * BigInt(lane.fuelSurchargeBasisPoints) + 5000n) / 10_000n;
  return { baseMinor: base, fuelMinor: fuel, totalMinor: base + fuel };
}

export interface LaneQuote {
  laneId: string;
  laneName: string;
  laneVersion: number;
  mode: (typeof MODES)[number];
  carrierName: string;
  serviceLevel: string;
  transitDaysMin: number;
  transitDaysMax: number;
  currency: string;
  baseMinor: string;
  fuelMinor: string;
  totalMinor: string;
  /** How long the rate card is in force: a price quoted after `validTo` is not this one. */
  validFrom: string;
  validTo: string | null;
}

/**
 * Every serviceable lane in force that can carry this weight between these
 * countries, cheapest first within each currency. A lane with a destination
 * region only answers a request naming that region; a lane without one
 * answers every request for the country.
 */
export async function quoteLanes(input: LaneQuoteInput): Promise<LaneQuote[]> {
  const at = input.at ?? new Date();
  const region = (input.destinationRegion ?? '').trim();
  const rows = await prisma.logisticsLane.findMany({
    where: {
      originCountry: input.originCountry,
      destinationCountry: input.destinationCountry,
      ...(input.mode === undefined ? {} : { mode: input.mode }),
      destinationRegion: { in: region === '' ? [''] : ['', region] },
      isActive: true,
      isServiceable: true,
      validFrom: { lte: at },
      OR: [{ validTo: null }, { validTo: { gt: at } }],
    },
    include: { bands: true },
    take: 200,
  });
  const quotes: LaneQuote[] = [];
  for (const lane of rows) {
    const price = priceOnLane(lane, lane.bands, input.weightGrams);
    if (price === null) continue;
    quotes.push({
      laneId: lane.id,
      laneName: lane.name,
      laneVersion: lane.version,
      mode: lane.mode,
      carrierName: lane.carrierName,
      serviceLevel: lane.serviceLevel,
      transitDaysMin: lane.transitDaysMin,
      transitDaysMax: lane.transitDaysMax,
      currency: lane.currency,
      baseMinor: price.baseMinor.toString(),
      fuelMinor: price.fuelMinor.toString(),
      totalMinor: price.totalMinor.toString(),
      validFrom: lane.validFrom.toISOString(),
      validTo: lane.validTo === null ? null : lane.validTo.toISOString(),
    });
  }
  return quotes.sort((a, b) =>
    a.currency !== b.currency
      ? a.currency.localeCompare(b.currency)
      : BigInt(a.totalMinor) < BigInt(b.totalMinor)
        ? -1
        : BigInt(a.totalMinor) > BigInt(b.totalMinor)
          ? 1
          : a.transitDaysMin - b.transitDaysMin,
  );
}

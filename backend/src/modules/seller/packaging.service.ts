/**
 * A seller's bulk packaging: reading it, writing it, and previewing an order.
 *
 * One profile per offer, and therefore one per seller per variant, holding up
 * to four options - carton, UK pallet, US pallet, container. Everything a
 * buyer is ever told about how goods are packed comes from a row this file
 * wrote, and every figure in it is the seller's own.
 *
 * THE VALIDATION IS NOT HERE
 *
 * `domain/packaging.ts` decides what is complete and what a package holds.
 * This file reads and writes rows around that decision. The split matters
 * because the same decision is asked for from four places - this save, the
 * seller's live preview, the buyer's product page and the add-to-cart check -
 * and an option that were complete on one of them and incomplete on another
 * would let somebody buy a pallet whose size nobody has stated.
 *
 * WHAT A SAVE MAY NOT DO
 *
 * Change a basket or an order. A seller re-specifying a pallet bumps the
 * profile version and nothing else; every line already placed keeps the
 * snapshot it was placed under. That is what makes an invoice from last month
 * still true, and it is the reason `SellerPackagingProfile.version` exists at
 * all.
 */
import { ErrorCode, badRequest, notFound } from '../../domain/errors.js';
import {
  CONTAINER_PRESETS,
  PACKAGE_TYPES,
  PALLET_FOOTPRINTS,
  describePackaging,
  fromGrams,
  fromMillimetres,
  isPalletPackage,
  packagingSellUnit,
  palletStandardFor,
  pricePackage,
  toGrams,
  toMillimetres,
  validatePackagingOption,
  wholePackagesAvailable,
  type ContainerLoadModeName,
  type ContainerLoadingMethodName,
  type ContainerTypeName,
  type DimensionUnitName,
  type PackageType,
  type PackagingOptionStateName,
  type PackagingPriceModeName,
  type WeightUnitName,
} from '../../domain/packaging.js';
import { loadTypeForPackage, needsManualFreight, type FreightLoadTypeName } from '../../domain/freight-load.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { recordSellerAudit } from './audit.service.js';
import {
  assertSellerOwnership,
  assertSellerPermission,
  type SellerMembership,
} from './account.service.js';

// ---------------------------------------------------------------------------
// Shapes crossing the API
// ---------------------------------------------------------------------------

/**
 * A package option, as the API returns it.
 *
 * Money is a STRING throughout, like every other amount this API returns. A
 * 19-digit paise figure crossing as a JS number silently loses its last digit,
 * and a package price is exactly the kind of large figure that reaches that
 * range.
 */
export interface PackagingOptionView {
  id: string;
  packageType: PackageType;
  isEnabled: boolean;
  state: PackagingOptionStateName;
  validationMessage: string | null;
  packageSku: string | null;

  unitsPerCarton: number | null;
  unitsPerPackage: number | null;
  unitsPerPackageDerived: number | null;
  unitsPerPackageIsOverride: boolean;

  palletStandard: string | null;
  cartonsPerLayer: number | null;
  layerCount: number | null;
  cartonsPerPallet: number | null;
  loadedHeightMm: number | null;
  isStackable: boolean;
  maxStackCount: number | null;

  containerType: ContainerTypeName | null;
  containerLoadMode: ContainerLoadModeName | null;
  containerLoadingMethod: ContainerLoadingMethodName | null;
  palletsPerContainer: number | null;
  cartonsPerContainer: number | null;
  originPortLabel: string | null;
  incoterm: string | null;

  /** Canonical millimetres, always. */
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  /** The same figures in the unit the seller typed, for the form. */
  enteredDimensionUnit: DimensionUnitName;
  lengthEntered: number | null;
  widthEntered: number | null;
  heightEntered: number | null;

  netWeightGrams: string | null;
  grossWeightGrams: string | null;
  maxGrossWeightGrams: string | null;
  enteredWeightUnit: WeightUnitName;
  netWeightEntered: number | null;
  grossWeightEntered: number | null;
  maxGrossWeightEntered: number | null;

  cargoVolumeCm3: string | null;

  minimumPackages: number;
  packageIncrement: number;
  maximumPackages: number | null;

  priceMode: PackagingPriceModeName;
  pricePerPackageMinor: string | null;
  currency: string | null;

  handlingLeadTimeDays: number | null;
  productionLeadTimeDays: number | null;
  originLocationId: string | null;

  isHazardous: boolean;
  temperatureNotes: string | null;
  specialHandlingNotes: string | null;

  tiers: { id: string; minPackages: number; pricePerPackageMinor: string }[];

  /** What kind of freight this package needs, and whether it can be quoted. */
  loadType: FreightLoadTypeName;
  requiresManualFreight: boolean;

  /** Nominal guidance for the chosen container type. Never a capacity. */
  containerGuidance: {
    label: string;
    nominalInternalLengthMm: number | null;
    nominalInternalWidthMm: number | null;
    nominalInternalHeightMm: number | null;
    nominalMaxPayloadGrams: string | null;
    nominalVolumeCm3: string | null;
  } | null;

  /** The pallet footprint preset, where the package is a pallet. */
  palletFootprint: { standard: string; lengthMm: number; widthMm: number; label: string } | null;

  version: number;
  updatedAt: string;
}

export interface PackagingProfileView {
  offerId: string;
  baseUnitLabel: string | null;
  version: number;
  notes: string | null;
  options: PackagingOptionView[];
  updatedAt: string;
}

/** What a seller may write for one option. */
export interface PackagingOptionInputBody {
  packageType: PackageType;
  isEnabled: boolean;
  packageSku?: string | null;

  unitsPerCarton?: number | null;
  /** Only read when `unitsPerPackageIsOverride` is true. */
  unitsPerPackage?: number | null;
  unitsPerPackageIsOverride?: boolean;

  cartonsPerLayer?: number | null;
  layerCount?: number | null;
  /** A stated total, used when layers are not given. */
  cartonsPerPallet?: number | null;
  loadedHeight?: number | null;
  isStackable?: boolean;
  maxStackCount?: number | null;

  containerType?: ContainerTypeName | null;
  containerLoadMode?: ContainerLoadModeName | null;
  containerLoadingMethod?: ContainerLoadingMethodName | null;
  palletsPerContainer?: number | null;
  cartonsPerContainer?: number | null;
  originPortLabel?: string | null;
  incoterm?: string | null;

  dimensionUnit?: DimensionUnitName;
  length?: number | null;
  width?: number | null;
  height?: number | null;

  weightUnit?: WeightUnitName;
  netWeight?: number | null;
  grossWeight?: number | null;
  maxGrossWeight?: number | null;

  cargoVolumeCm3?: string | null;

  minimumPackages?: number;
  packageIncrement?: number;
  maximumPackages?: number | null;

  priceMode?: PackagingPriceModeName;
  /** Minor units, as a string. Never a number - see the schema header. */
  pricePerPackageMinor?: string | null;

  handlingLeadTimeDays?: number | null;
  productionLeadTimeDays?: number | null;
  originLocationId?: string | null;

  isHazardous?: boolean;
  temperatureNotes?: string | null;
  specialHandlingNotes?: string | null;

  tiers?: { minPackages: number; pricePerPackageMinor: string }[];
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const optionInclude = { tiers: { orderBy: { minPackages: 'asc' as const } } };

/**
 * One offer's packaging, for the seller's own screen.
 *
 * Returns an empty profile rather than a 404 when none exists, because a
 * seller opening the panel for the first time has not made a mistake - they
 * have not filled it in yet, and a 404 would make the screen say something has
 * gone wrong.
 */
export async function readPackagingProfile(
  membership: SellerMembership,
  offerId: string,
): Promise<PackagingProfileView> {
  assertSellerPermission(membership, SellerPermission.LISTING_READ);

  const offer = await prisma.sellerOffer.findUnique({
    where: { id: offerId },
    select: { id: true, sellerAccountId: true, currency: true, priceMinor: true },
  });

  assertSellerOwnership(membership, offer?.sellerAccountId ?? null, 'Listing');

  const profile = await prisma.sellerPackagingProfile.findUnique({
    where: { offerId },
    include: { options: { include: optionInclude, orderBy: { packageType: 'asc' } } },
  });

  if (profile === null) {
    return {
      offerId,
      baseUnitLabel: null,
      version: 0,
      notes: null,
      options: [],
      updatedAt: new Date().toISOString(),
    };
  }

  return {
    offerId,
    baseUnitLabel: profile.baseUnitLabel,
    version: profile.version,
    notes: profile.notes,
    options: profile.options.map(toOptionView),
    updatedAt: profile.updatedAt.toISOString(),
  };
}

type OptionRow = Awaited<
  ReturnType<typeof prisma.sellerPackagingOption.findFirstOrThrow<{ include: typeof optionInclude }>>
>;

function toOptionView(option: OptionRow): PackagingOptionView {
  const loadType = loadTypeForPackage(
    option.packageType,
    option.containerLoadMode,
  );

  const preset =
    option.containerType === null ? null : CONTAINER_PRESETS[option.containerType];

  const footprintStandard =
    option.palletStandard ?? palletStandardFor(option.packageType);
  const footprint = footprintStandard === null ? null : PALLET_FOOTPRINTS[footprintStandard];

  const dimensionUnit = option.enteredDimensionUnit;
  const weightUnit = option.enteredWeightUnit;

  return {
    id: option.id,
    packageType: option.packageType,
    isEnabled: option.isEnabled,
    state: option.state,
    validationMessage: option.validationMessage,
    packageSku: option.packageSku,

    unitsPerCarton: option.unitsPerCarton,
    unitsPerPackage: option.unitsPerPackage,
    unitsPerPackageDerived: option.unitsPerPackageDerived,
    unitsPerPackageIsOverride: option.unitsPerPackageIsOverride,

    palletStandard: option.palletStandard,
    cartonsPerLayer: option.cartonsPerLayer,
    layerCount: option.layerCount,
    cartonsPerPallet: option.cartonsPerPallet,
    loadedHeightMm: option.loadedHeightMm,
    isStackable: option.isStackable,
    maxStackCount: option.maxStackCount,

    containerType: option.containerType,
    containerLoadMode: option.containerLoadMode,
    containerLoadingMethod: option.containerLoadingMethod,
    palletsPerContainer: option.palletsPerContainer,
    cartonsPerContainer: option.cartonsPerContainer,
    originPortLabel: option.originPortLabel,
    incoterm: option.incoterm,

    lengthMm: option.lengthMm,
    widthMm: option.widthMm,
    heightMm: option.heightMm,
    enteredDimensionUnit: dimensionUnit,
    lengthEntered: fromMillimetres(option.lengthMm, dimensionUnit),
    widthEntered: fromMillimetres(option.widthMm, dimensionUnit),
    heightEntered: fromMillimetres(option.heightMm, dimensionUnit),

    netWeightGrams: option.netWeightGrams?.toString() ?? null,
    grossWeightGrams: option.grossWeightGrams?.toString() ?? null,
    maxGrossWeightGrams: option.maxGrossWeightGrams?.toString() ?? null,
    enteredWeightUnit: weightUnit,
    netWeightEntered: fromGrams(option.netWeightGrams, weightUnit),
    grossWeightEntered: fromGrams(option.grossWeightGrams, weightUnit),
    maxGrossWeightEntered: fromGrams(option.maxGrossWeightGrams, weightUnit),

    cargoVolumeCm3: option.cargoVolumeCm3?.toString() ?? null,

    minimumPackages: option.minimumPackages,
    packageIncrement: option.packageIncrement,
    maximumPackages: option.maximumPackages,

    priceMode: option.priceMode,
    pricePerPackageMinor: option.pricePerPackageMinor?.toString() ?? null,
    currency: option.currency,

    handlingLeadTimeDays: option.handlingLeadTimeDays,
    productionLeadTimeDays: option.productionLeadTimeDays,
    originLocationId: option.originLocationId,

    isHazardous: option.isHazardous,
    temperatureNotes: option.temperatureNotes,
    specialHandlingNotes: option.specialHandlingNotes,

    tiers: option.tiers.map((tier) => ({
      id: tier.id,
      minPackages: tier.minPackages,
      pricePerPackageMinor: tier.pricePerPackageMinor.toString(),
    })),

    loadType,
    requiresManualFreight: needsManualFreight(loadType),

    containerGuidance:
      preset === null || preset === undefined
        ? null
        : {
            label: preset.label,
            nominalInternalLengthMm: preset.nominalInternalLengthMm,
            nominalInternalWidthMm: preset.nominalInternalWidthMm,
            nominalInternalHeightMm: preset.nominalInternalHeightMm,
            nominalMaxPayloadGrams: preset.nominalMaxPayloadGrams?.toString() ?? null,
            nominalVolumeCm3: preset.nominalVolumeCm3?.toString() ?? null,
          },

    palletFootprint:
      footprint === undefined || footprint === null
        ? null
        : {
            standard: footprint.standard,
            lengthMm: footprint.lengthMm,
            widthMm: footprint.widthMm,
            label: footprint.label,
          },

    version: option.version,
    updatedAt: option.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Save one package option.
 *
 * Creates the profile on first use. Everything is written inside one
 * transaction with the tiers, because a price band that survived a failed save
 * of the option it belongs to would price a package nobody had finished
 * describing.
 *
 * `LISTING_WRITE` rather than `OFFER_PRICE_WRITE`, even though a package
 * carries a price: packaging is a description of goods before it is a price,
 * and a Catalogue Manager who can restate what is in a carton should not need
 * the pricing grant to do it. A seller who wants those apart puts the person
 * on a role without `LISTING_WRITE`.
 */
export async function savePackagingOption(
  membership: SellerMembership,
  offerId: string,
  body: PackagingOptionInputBody,
  actorUserId: string | null,
): Promise<PackagingProfileView> {
  assertSellerPermission(membership, SellerPermission.LISTING_WRITE);

  const offer = await prisma.sellerOffer.findUnique({
    where: { id: offerId },
    select: { id: true, sellerAccountId: true, currency: true, priceMinor: true, sellerSku: true },
  });

  assertSellerOwnership(membership, offer?.sellerAccountId ?? null, 'Listing');
  if (offer === null) throw notFound('Listing');

  // A package that ships from one of the seller's own places must name one of
  // THEIR places. Checked here rather than by a foreign key, because a seller
  // archiving a location must not stop the packaging reading back - see the
  // column's note in the schema.
  if (body.originLocationId !== null && body.originLocationId !== undefined) {
    const location = await prisma.sellerLocation.findUnique({
      where: { id: body.originLocationId },
      select: { sellerAccountId: true },
    });
    assertSellerOwnership(membership, location?.sellerAccountId ?? null, 'Location');
  }

  const dimensionUnit = body.dimensionUnit ?? 'MM';
  const weightUnit = body.weightUnit ?? 'G';

  const lengthMm = toMillimetres(body.length, dimensionUnit, 'length');
  const widthMm = toMillimetres(body.width, dimensionUnit, 'width');
  const heightMm = toMillimetres(body.height, dimensionUnit, 'height');
  const loadedHeightMm = toMillimetres(body.loadedHeight, dimensionUnit, 'loadedHeight');

  const netWeightGrams = toGrams(body.netWeight, weightUnit, 'netWeight');
  const grossWeightGrams = toGrams(body.grossWeight, weightUnit, 'grossWeight');
  const maxGrossWeightGrams = toGrams(body.maxGrossWeight, weightUnit, 'maxGrossWeight');

  const pricePerPackageMinor = parseMinor(body.pricePerPackageMinor, 'pricePerPackageMinor');
  const cargoVolumeCm3 = parseMinor(body.cargoVolumeCm3, 'cargoVolumeCm3');

  // A pallet package's standard follows from its TYPE and is never taken from
  // the request. A UK pallet row carrying a US standard is a screen that says
  // one thing over a footprint that is the other.
  const palletStandard = palletStandardFor(body.packageType);

  // Normalised BEFORE validation, because the divisibility rule applies to
  // every band price as well as to the package price - see
  // `validatePackagingOption`. A band checked after the option was already
  // declared ACTIVE would be a discount that prices a unit in fractions of a
  // paise.
  const tiers = normaliseTiers(body.tiers ?? []);

  const validation = validatePackagingOption({
    packageType: body.packageType,
    isEnabled: body.isEnabled,
    unitsPerCarton: body.unitsPerCarton ?? null,
    unitsPerPackage: body.unitsPerPackage ?? null,
    unitsPerPackageIsOverride: body.unitsPerPackageIsOverride ?? false,
    cartonsPerLayer: body.cartonsPerLayer ?? null,
    layerCount: body.layerCount ?? null,
    cartonsPerPallet: body.cartonsPerPallet ?? null,
    containerLoadingMethod: body.containerLoadingMethod ?? null,
    palletsPerContainer: body.palletsPerContainer ?? null,
    cartonsPerContainer: body.cartonsPerContainer ?? null,
    minimumPackages: body.minimumPackages ?? 1,
    packageIncrement: body.packageIncrement ?? 1,
    maximumPackages: body.maximumPackages ?? null,
    priceMode: body.priceMode ?? 'DERIVED_FROM_UNIT',
    pricePerPackageMinor,
    currency: offer.currency,
    offerCurrency: offer.currency,
    containerType: body.containerType ?? null,
    containerLoadMode: body.containerLoadMode ?? null,
    grossWeightGrams,
    netWeightGrams,
    maxGrossWeightGrams,
    isStackable: body.isStackable ?? false,
    maxStackCount: body.maxStackCount ?? null,
    incoterm: body.incoterm ?? null,
    tiers,
  });

  return prisma.$transaction(async (tx) => {
    const profile = await tx.sellerPackagingProfile.upsert({
      where: { offerId },
      create: {
        id: newId(),
        sellerAccountId: membership.sellerAccountId,
        offerId,
        version: 1,
      },
      // Every save bumps the version, whether or not this option changed:
      // the version identifies "the configuration a line was bought under",
      // and a sibling option moving is a different configuration.
      update: { version: { increment: 1 } },
    });

    const existing = await tx.sellerPackagingOption.findUnique({
      where: { profileId_packageType: { profileId: profile.id, packageType: body.packageType } },
      include: optionInclude,
    });

    const data = {
      sellerAccountId: membership.sellerAccountId,
      packageType: body.packageType,
      isEnabled: body.isEnabled,
      state: validation.state,
      validationMessage:
        validation.issues.length === 0 ? null : validation.issues.map((i) => i.message).join(' '),
      packageSku: trimOrNull(body.packageSku, 64),

      unitsPerCarton: body.unitsPerCarton ?? null,
      unitsPerPackage: validation.unitsPerPackage,
      unitsPerPackageDerived: validation.unitsPerPackageDerived,
      unitsPerPackageIsOverride: body.unitsPerPackageIsOverride ?? false,

      palletStandard,
      cartonsPerLayer: body.cartonsPerLayer ?? null,
      layerCount: body.layerCount ?? null,
      cartonsPerPallet: validation.cartonsPerPallet,
      loadedHeightMm,
      isStackable: body.isStackable ?? false,
      maxStackCount: body.maxStackCount ?? null,

      containerType: body.packageType === 'CONTAINER' ? (body.containerType ?? null) : null,
      containerLoadMode: body.packageType === 'CONTAINER' ? (body.containerLoadMode ?? null) : null,
      containerLoadingMethod:
        body.packageType === 'CONTAINER' ? (body.containerLoadingMethod ?? null) : null,
      palletsPerContainer: body.packageType === 'CONTAINER' ? (body.palletsPerContainer ?? null) : null,
      cartonsPerContainer:
        body.packageType === 'CONTAINER' ? validation.cartonsPerContainer : null,
      originPortLabel: trimOrNull(body.originPortLabel, 160),
      incoterm: trimOrNull(body.incoterm, 8),

      lengthMm,
      widthMm,
      heightMm,
      enteredDimensionUnit: dimensionUnit,

      netWeightGrams,
      grossWeightGrams,
      maxGrossWeightGrams,
      enteredWeightUnit: weightUnit,

      cargoVolumeCm3,

      minimumPackages: body.minimumPackages ?? 1,
      packageIncrement: body.packageIncrement ?? 1,
      maximumPackages: body.maximumPackages ?? null,

      priceMode: body.priceMode ?? 'DERIVED_FROM_UNIT',
      pricePerPackageMinor,
      currency: offer.currency,

      handlingLeadTimeDays: body.handlingLeadTimeDays ?? null,
      productionLeadTimeDays: body.productionLeadTimeDays ?? null,
      originLocationId: body.originLocationId ?? null,

      isHazardous: body.isHazardous ?? false,
      temperatureNotes: trimOrNull(body.temperatureNotes, 500),
      specialHandlingNotes: trimOrNull(body.specialHandlingNotes, 1000),
    };

    const option =
      existing === null
        ? await tx.sellerPackagingOption.create({
            data: { id: newId(), profileId: profile.id, version: 1, ...data },
          })
        : await tx.sellerPackagingOption.update({
            where: { id: existing.id },
            data: { ...data, version: { increment: 1 } },
          });

    // Tiers are replaced wholesale rather than merged. A band the seller
    // removed from the form must disappear, and a merge that kept it would
    // quietly go on discounting at a price nobody can see on screen.
    await tx.sellerPackagingTier.deleteMany({ where: { optionId: option.id } });
    if (tiers.length > 0) {
      await tx.sellerPackagingTier.createMany({
        data: tiers.map((tier) => ({
          id: newId(),
          optionId: option.id,
          minPackages: tier.minPackages,
          pricePerPackageMinor: tier.pricePerPackageMinor,
        })),
      });
    }

    await recordSellerAudit({
      tx,
      sellerAccountId: membership.sellerAccountId,
      action: 'seller.packaging.saved',
      actor: { type: 'CUSTOMER', userId: actorUserId, label: membership.displayName },
      resourceType: 'seller_packaging_option',
      resourceId: option.id,
      before: existing === null ? undefined : auditShape(existing),
      after: auditShape({ ...option, tiers }),
      summary:
        `${body.packageType} packaging for ${offer.sellerSku}: ` +
        (validation.state === 'ACTIVE'
          ? `${String(validation.unitsPerPackage ?? 0)} units per package`
          : validation.state === 'INCOMPLETE'
            ? 'saved, still incomplete'
            : 'switched off') +
        (body.unitsPerPackageIsOverride
          ? ` (units per package OVERRIDDEN; the layout works out to ${String(
              validation.unitsPerPackageDerived ?? 0,
            )})`
          : ''),
    });

    const refreshed = await tx.sellerPackagingProfile.findUniqueOrThrow({
      where: { id: profile.id },
      include: { options: { include: optionInclude, orderBy: { packageType: 'asc' } } },
    });

    return {
      offerId,
      baseUnitLabel: refreshed.baseUnitLabel,
      version: refreshed.version,
      notes: refreshed.notes,
      options: refreshed.options.map(toOptionView),
      updatedAt: refreshed.updatedAt.toISOString(),
    };
  });
}

/** Switch a package type off without losing what was typed into it. */
export async function setPackagingOptionEnabled(
  membership: SellerMembership,
  offerId: string,
  packageType: PackageType,
  isEnabled: boolean,
  actorUserId: string | null,
): Promise<PackagingProfileView> {
  assertSellerPermission(membership, SellerPermission.LISTING_WRITE);

  const profile = await prisma.sellerPackagingProfile.findUnique({
    where: { offerId },
    include: { options: { include: optionInclude } },
  });

  assertSellerOwnership(membership, profile?.sellerAccountId ?? null, 'Packaging');
  if (profile === null) throw notFound('Packaging');

  const option = profile.options.find((row) => row.packageType === packageType);
  if (option === undefined) throw notFound('Packaging option');

  const offer = await prisma.sellerOffer.findUniqueOrThrow({
    where: { id: offerId },
    select: { currency: true },
  });

  // Re-validated rather than merely flipped, because switching a package back
  // ON has to re-decide whether it is complete - the seller may have edited a
  // sibling, or the rules may have changed since it was last saved.
  const validation = validatePackagingOption({
    packageType,
    isEnabled,
    unitsPerCarton: option.unitsPerCarton,
    unitsPerPackage: option.unitsPerPackage,
    unitsPerPackageIsOverride: option.unitsPerPackageIsOverride,
    cartonsPerLayer: option.cartonsPerLayer,
    layerCount: option.layerCount,
    cartonsPerPallet: option.cartonsPerPallet,
    containerLoadingMethod: option.containerLoadingMethod,
    palletsPerContainer: option.palletsPerContainer,
    cartonsPerContainer: option.cartonsPerContainer,
    minimumPackages: option.minimumPackages,
    packageIncrement: option.packageIncrement,
    maximumPackages: option.maximumPackages,
    priceMode: option.priceMode,
    pricePerPackageMinor: option.pricePerPackageMinor,
    currency: option.currency,
    offerCurrency: offer.currency,
    containerType: option.containerType,
    containerLoadMode: option.containerLoadMode,
    grossWeightGrams: option.grossWeightGrams,
    netWeightGrams: option.netWeightGrams,
    maxGrossWeightGrams: option.maxGrossWeightGrams,
    isStackable: option.isStackable,
    maxStackCount: option.maxStackCount,
    incoterm: option.incoterm,
    tiers: option.tiers.map((tier) => ({
      minPackages: tier.minPackages,
      pricePerPackageMinor: tier.pricePerPackageMinor,
    })),
  });

  await prisma.$transaction(async (tx) => {
    await tx.sellerPackagingOption.update({
      where: { id: option.id },
      data: {
        isEnabled,
        state: validation.state,
        validationMessage:
          validation.issues.length === 0 ? null : validation.issues.map((i) => i.message).join(' '),
        version: { increment: 1 },
      },
    });
    await tx.sellerPackagingProfile.update({
      where: { id: profile.id },
      data: { version: { increment: 1 } },
    });
    await recordSellerAudit({
      tx,
      sellerAccountId: membership.sellerAccountId,
      action: isEnabled ? 'seller.packaging.enabled' : 'seller.packaging.disabled',
      actor: { type: 'CUSTOMER', userId: actorUserId, label: membership.displayName },
      resourceType: 'seller_packaging_option',
      resourceId: option.id,
      summary: `${packageType} ordering ${isEnabled ? 'switched on' : 'switched off'}.`,
    });
  });

  return readPackagingProfile(membership, offerId);
}

/** Update the profile-level fields - the base unit's name, and the notes. */
export async function savePackagingProfileDetails(
  membership: SellerMembership,
  offerId: string,
  body: { baseUnitLabel?: string | null; notes?: string | null },
): Promise<PackagingProfileView> {
  assertSellerPermission(membership, SellerPermission.LISTING_WRITE);

  const offer = await prisma.sellerOffer.findUnique({
    where: { id: offerId },
    select: { sellerAccountId: true },
  });
  assertSellerOwnership(membership, offer?.sellerAccountId ?? null, 'Listing');

  await prisma.sellerPackagingProfile.upsert({
    where: { offerId },
    create: {
      id: newId(),
      sellerAccountId: membership.sellerAccountId,
      offerId,
      baseUnitLabel: trimOrNull(body.baseUnitLabel, 48),
      notes: trimOrNull(body.notes, 1000),
    },
    update: {
      baseUnitLabel: trimOrNull(body.baseUnitLabel, 48),
      notes: trimOrNull(body.notes, 1000),
      version: { increment: 1 },
    },
  });

  return readPackagingProfile(membership, offerId);
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export interface BulkOrderPreview {
  packageType: PackageType;
  packageQuantity: number;
  /** After the minimum and the step have been applied. */
  effectivePackageQuantity: number;
  unitsPerPackage: number;
  totalBaseUnits: number;
  breakdown: ReturnType<typeof describePackaging>;
  packagePriceMinor: string;
  lineTotalMinor: string;
  effectiveUnitPriceMinor: string;
  currency: string;
  appliedTierMinPackages: number | null;
  requiresFreightQuote: boolean;
  loadType: FreightLoadTypeName;
  wholePackagesAvailable: number;
  /** Working days, where the seller stated any. */
  leadTimeDays: number | null;
  /** Non-fatal things the buyer should be told. */
  warnings: { code: string; message: string }[];
}

/**
 * What ordering N of these would come to, without committing to anything.
 *
 * The SAME functions the cart uses - `packagingSellUnit`, `pricePackage`,
 * `describePackaging` - so the figure previewed and the figure charged come
 * from one place. A preview computed its own way would eventually disagree
 * with the basket, and the shopper would be quoted one total and charged
 * another.
 *
 * It does NOT reserve stock and does NOT create anything. `wholePackagesAvailable`
 * is a snapshot of a number that can move between this call and the add.
 */
export async function previewBulkOrder(input: {
  offerId: string;
  packageType: PackageType;
  packageQuantity: number;
}): Promise<BulkOrderPreview> {
  const option = await loadBuyableOption(input.offerId, input.packageType);

  const spec = packagingSellUnit({
    packageType: input.packageType,
    unitsPerPackage: option.unitsPerPackage,
    minimumPackages: option.minimumPackages,
    packageIncrement: option.packageIncrement,
    maximumPackages: option.maximumPackages,
  });

  const asked = Math.max(1, Math.trunc(input.packageQuantity));
  const atLeast = Math.max(asked, spec.minimumOrderQuantity);
  const effective = Math.ceil(atLeast / spec.orderIncrement) * spec.orderIncrement;

  const price = pricePackage({
    priceMode: option.priceMode,
    pricePerPackageMinor: option.pricePerPackageMinor,
    unitPriceMinor: option.offerPriceMinor,
    unitsPerPackage: option.unitsPerPackage,
    tiers: option.tiers,
    packageQuantity: effective,
  });

  const breakdown = describePackaging({
    packageType: input.packageType,
    packageQuantity: effective,
    unitsPerPackage: option.unitsPerPackage,
    unitsPerCarton: option.unitsPerCarton,
    cartonsPerPallet: option.cartonsPerPallet,
    palletsPerContainer: option.palletsPerContainer,
    cartonsPerContainer: option.cartonsPerContainer,
    grossWeightGrams: option.grossWeightGrams,
    cargoVolumeCm3: option.cargoVolumeCm3,
  });

  const loadType = loadTypeForPackage(input.packageType, option.containerLoadMode);

  const warnings: { code: string; message: string }[] = [];

  if (spec.maximumOrderQuantity !== null && effective > spec.maximumOrderQuantity) {
    warnings.push({
      code: 'ABOVE_MAXIMUM',
      message: 'That is more than this seller takes on one order.',
    });
  }

  if (
    option.maxGrossWeightGrams !== null &&
    option.grossWeightGrams !== null &&
    option.grossWeightGrams > option.maxGrossWeightGrams
  ) {
    warnings.push({
      code: 'OVER_SAFE_LOAD',
      message: 'One loaded package is above the safe load the seller stated.',
    });
  }

  const available = wholePackagesAvailable(option.availableQuantity, option.unitsPerPackage);
  if (available < effective) {
    warnings.push({
      code: 'INSUFFICIENT_WHOLE_PACKAGES',
      message: `Only ${String(available)} complete packages are available right now.`,
    });
  }

  return {
    packageType: input.packageType,
    packageQuantity: asked,
    effectivePackageQuantity: effective,
    unitsPerPackage: option.unitsPerPackage,
    totalBaseUnits: effective * option.unitsPerPackage,
    breakdown,
    packagePriceMinor: price.packagePriceMinor.toString(),
    lineTotalMinor: (price.packagePriceMinor * BigInt(effective)).toString(),
    effectiveUnitPriceMinor: price.effectiveUnitPriceMinor.toString(),
    currency: option.currency,
    appliedTierMinPackages: price.appliedTierMinPackages,
    requiresFreightQuote: price.requiresQuote || needsManualFreight(loadType),
    loadType,
    wholePackagesAvailable: available,
    leadTimeDays:
      option.handlingLeadTimeDays === null && option.productionLeadTimeDays === null
        ? null
        : (option.handlingLeadTimeDays ?? 0) + (option.productionLeadTimeDays ?? 0),
    warnings,
  };
}

/** A buyable option plus the offer terms it prices against. */
export interface BuyablePackagingOption {
  optionId: string;
  profileId: string;
  profileVersion: number;
  packageType: PackageType;
  unitsPerPackage: number;
  unitsPerCarton: number | null;
  cartonsPerPallet: number | null;
  palletsPerContainer: number | null;
  cartonsPerContainer: number | null;
  palletStandard: string | null;
  containerType: ContainerTypeName | null;
  containerLoadMode: ContainerLoadModeName | null;
  containerLoadingMethod: ContainerLoadingMethodName | null;
  minimumPackages: number;
  packageIncrement: number;
  maximumPackages: number | null;
  priceMode: PackagingPriceModeName;
  pricePerPackageMinor: bigint | null;
  currency: string;
  offerPriceMinor: bigint;
  availableQuantity: number;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  grossWeightGrams: bigint | null;
  maxGrossWeightGrams: bigint | null;
  cargoVolumeCm3: bigint | null;
  handlingLeadTimeDays: number | null;
  productionLeadTimeDays: number | null;
  packageSku: string | null;
  incoterm: string | null;
  originPortLabel: string | null;
  isHazardous: boolean;
  tiers: { minPackages: number; pricePerPackageMinor: bigint }[];
}

/**
 * One option, if a buyer may actually order it.
 *
 * THE GATE FOR EVERY BUYING PATH. The product page, the preview and the
 * add-to-cart all come through here, so "is this offerable?" is answered once.
 * Four separate refusals rather than one, because the buyer can do something
 * different about each: a package the seller does not offer, one they offer
 * and have not finished describing, one they have switched off, and an offer
 * that is not live at all.
 */
export async function loadBuyableOption(
  offerId: string,
  packageType: PackageType,
): Promise<BuyablePackagingOption> {
  const profile = await prisma.sellerPackagingProfile.findUnique({
    where: { offerId },
    include: {
      options: { include: optionInclude },
      offer: {
        select: { id: true, status: true, currency: true, priceMinor: true, availableQuantity: true },
      },
    },
  });

  if (profile === null) {
    throw badRequest(
      ErrorCode.PACKAGING_OPTION_NOT_AVAILABLE,
      'This seller does not offer bulk packaging on this listing.',
      [{ field: 'packageType', code: 'NO_PROFILE', meta: { packageType, available: '' } }],
    );
  }

  const available = profile.options
    .filter((row) => row.isEnabled && row.state === 'ACTIVE')
    .map((row) => row.packageType);

  const option = profile.options.find((row) => row.packageType === packageType);

  if (option === undefined || !option.isEnabled) {
    throw badRequest(
      ErrorCode.PACKAGING_OPTION_NOT_AVAILABLE,
      'That packaging is not configured for this listing.',
      [{ field: 'packageType', code: 'NOT_OFFERED', meta: { packageType, available: available.join(',') } }],
    );
  }

  if (option.state !== 'ACTIVE' || option.unitsPerPackage === null) {
    throw badRequest(
      ErrorCode.PACKAGING_OPTION_INCOMPLETE,
      'The seller has not finished setting up this packaging yet.',
      [{ field: 'packageType', code: 'INCOMPLETE', meta: { packageType, available: available.join(',') } }],
    );
  }

  if (profile.offer.status !== 'ACTIVE') {
    throw badRequest(ErrorCode.CART_ITEM_UNAVAILABLE, 'This listing is not on sale at the moment.', [
      { field: 'offerId', code: 'OFFER_NOT_ACTIVE' },
    ]);
  }

  return {
    optionId: option.id,
    profileId: profile.id,
    profileVersion: profile.version,
    packageType,
    unitsPerPackage: option.unitsPerPackage,
    unitsPerCarton: option.unitsPerCarton,
    cartonsPerPallet: option.cartonsPerPallet,
    palletsPerContainer: option.palletsPerContainer,
    cartonsPerContainer: option.cartonsPerContainer,
    palletStandard: option.palletStandard,
    containerType: option.containerType,
    containerLoadMode: option.containerLoadMode,
    containerLoadingMethod: option.containerLoadingMethod,
    minimumPackages: option.minimumPackages,
    packageIncrement: option.packageIncrement,
    maximumPackages: option.maximumPackages,
    priceMode: option.priceMode,
    pricePerPackageMinor: option.pricePerPackageMinor,
    currency: option.currency ?? profile.offer.currency,
    offerPriceMinor: profile.offer.priceMinor,
    availableQuantity: profile.offer.availableQuantity,
    lengthMm: option.lengthMm,
    widthMm: option.widthMm,
    heightMm: option.heightMm,
    grossWeightGrams: option.grossWeightGrams,
    maxGrossWeightGrams: option.maxGrossWeightGrams,
    cargoVolumeCm3: option.cargoVolumeCm3,
    handlingLeadTimeDays: option.handlingLeadTimeDays,
    productionLeadTimeDays: option.productionLeadTimeDays,
    packageSku: option.packageSku,
    incoterm: option.incoterm,
    originPortLabel: option.originPortLabel,
    isHazardous: option.isHazardous,
    tiers: option.tiers.map((tier) => ({
      minPackages: tier.minPackages,
      pricePerPackageMinor: tier.pricePerPackageMinor,
    })),
  };
}

/**
 * Every package a buyer may choose on this offer, for the product page.
 *
 * Only ACTIVE and enabled options, so a half-configured pallet never appears
 * in the selector. Returns an empty array where there is no profile, which is
 * what the overwhelming majority of offers will return for a long time - and
 * an empty array is what makes the storefront draw its ordinary quantity box
 * with no packaging UI at all.
 */
export async function listBuyableOptions(offerId: string): Promise<
  {
    packageType: PackageType;
    unitsPerPackage: number;
    unitsPerCarton: number | null;
    cartonsPerPallet: number | null;
    palletsPerContainer: number | null;
    cartonsPerContainer: number | null;
    palletStandard: string | null;
    containerType: ContainerTypeName | null;
    containerLoadMode: ContainerLoadModeName | null;
    minimumPackages: number;
    packageIncrement: number;
    maximumPackages: number | null;
    packagePriceMinor: string;
    effectiveUnitPriceMinor: string;
    currency: string;
    requiresFreightQuote: boolean;
    loadType: FreightLoadTypeName;
    wholePackagesAvailable: number;
    lengthMm: number | null;
    widthMm: number | null;
    heightMm: number | null;
    grossWeightGrams: string | null;
    leadTimeDays: number | null;
    isHazardous: boolean;
    incoterm: string | null;
    tiers: { minPackages: number; pricePerPackageMinor: string }[];
  }[]
> {
  const profile = await prisma.sellerPackagingProfile.findUnique({
    where: { offerId },
    include: {
      options: { include: optionInclude, orderBy: { packageType: 'asc' } },
      offer: { select: { status: true, currency: true, priceMinor: true, availableQuantity: true } },
    },
  });

  if (profile === null || profile.offer.status !== 'ACTIVE') return [];

  const ordered = PACKAGE_TYPES.map((type) =>
    profile.options.find((row) => row.packageType === type),
  ).filter(
    (row): row is NonNullable<typeof row> =>
      row !== undefined && row.isEnabled && row.state === 'ACTIVE' && row.unitsPerPackage !== null,
  );

  return ordered.map((option) => {
    const unitsPerPackage = option.unitsPerPackage ?? 1;
    const loadType = loadTypeForPackage(
      option.packageType,
      option.containerLoadMode,
    );

    // Priced at the MINIMUM, which is what the card shows - "from X per
    // pallet". Pricing it at one when the minimum is four would advertise a
    // figure nobody can buy.
    const price = pricePackage({
      priceMode: option.priceMode,
      pricePerPackageMinor: option.pricePerPackageMinor,
      unitPriceMinor: profile.offer.priceMinor,
      unitsPerPackage,
      tiers: option.tiers.map((tier) => ({
        minPackages: tier.minPackages,
        pricePerPackageMinor: tier.pricePerPackageMinor,
      })),
      packageQuantity: option.minimumPackages,
    });

    return {
      packageType: option.packageType,
      unitsPerPackage,
      unitsPerCarton: option.unitsPerCarton,
      cartonsPerPallet: option.cartonsPerPallet,
      palletsPerContainer: option.palletsPerContainer,
      cartonsPerContainer: option.cartonsPerContainer,
      palletStandard: option.palletStandard,
      containerType: option.containerType,
      containerLoadMode: option.containerLoadMode,
      minimumPackages: option.minimumPackages,
      packageIncrement: option.packageIncrement,
      maximumPackages: option.maximumPackages,
      packagePriceMinor: price.packagePriceMinor.toString(),
      effectiveUnitPriceMinor: price.effectiveUnitPriceMinor.toString(),
      currency: option.currency ?? profile.offer.currency,
      requiresFreightQuote: price.requiresQuote || needsManualFreight(loadType),
      loadType,
      wholePackagesAvailable: wholePackagesAvailable(profile.offer.availableQuantity, unitsPerPackage),
      lengthMm: option.lengthMm,
      widthMm: option.widthMm,
      heightMm: option.heightMm,
      grossWeightGrams: option.grossWeightGrams?.toString() ?? null,
      leadTimeDays:
        option.handlingLeadTimeDays === null && option.productionLeadTimeDays === null
          ? null
          : (option.handlingLeadTimeDays ?? 0) + (option.productionLeadTimeDays ?? 0),
      isHazardous: option.isHazardous,
      incoterm: option.incoterm,
      tiers: option.tiers.map((tier) => ({
        minPackages: tier.minPackages,
        pricePerPackageMinor: tier.pricePerPackageMinor.toString(),
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function trimOrNull(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, max);
}

/**
 * A minor-unit amount off the wire.
 *
 * A STRING in, a `bigint` out, and never a JS number in between. The API takes
 * money as a string for exactly this reason - see the schema header - and
 * parsing it through `Number` here would undo that on the one path where the
 * figures are largest.
 */
function parseMinor(value: string | null | undefined, field: string): bigint | null {
  if (value === null || value === undefined || value === '') return null;
  if (!/^\d{1,19}$/.test(value)) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'That is not an amount we can use.', [
      { field, code: 'INVALID' },
    ]);
  }
  return BigInt(value);
}

/**
 * Bands, deduplicated, sorted and checked.
 *
 * Two bands starting at the same quantity have no answer a buyer would accept,
 * so the second is a refusal rather than a silent overwrite - the same rule
 * `SellerPriceTier` already follows.
 */
function normaliseTiers(
  tiers: readonly { minPackages: number; pricePerPackageMinor: string }[],
): { minPackages: number; pricePerPackageMinor: bigint }[] {
  const seen = new Set<number>();
  const out: { minPackages: number; pricePerPackageMinor: bigint }[] = [];

  for (const [index, tier] of tiers.entries()) {
    if (!Number.isInteger(tier.minPackages) || tier.minPackages < 1) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'A price band starts at one package or more.', [
        { field: `tiers.${String(index)}.minPackages`, code: 'INVALID' },
      ]);
    }
    if (seen.has(tier.minPackages)) {
      throw badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Two price bands cannot start at the same quantity.',
        [{ field: `tiers.${String(index)}.minPackages`, code: 'DUPLICATE' }],
      );
    }
    seen.add(tier.minPackages);
    out.push({
      minPackages: tier.minPackages,
      pricePerPackageMinor: parseMinor(tier.pricePerPackageMinor, `tiers.${String(index)}.pricePerPackageMinor`) ?? 0n,
    });
  }

  return out.sort((a, b) => a.minPackages - b.minPackages);
}

/** The subset of an option worth keeping in an audit diff. */
function auditShape(option: {
  packageType: string;
  isEnabled: boolean;
  state: string;
  unitsPerCarton: number | null;
  unitsPerPackage: number | null;
  unitsPerPackageDerived: number | null;
  unitsPerPackageIsOverride: boolean;
  cartonsPerPallet: number | null;
  palletsPerContainer: number | null;
  minimumPackages: number;
  packageIncrement: number;
  priceMode: string;
  pricePerPackageMinor: bigint | null;
  tiers?: readonly { minPackages: number; pricePerPackageMinor: bigint }[];
}): Record<string, unknown> {
  return {
    packageType: option.packageType,
    isEnabled: option.isEnabled,
    state: option.state,
    unitsPerCarton: option.unitsPerCarton,
    unitsPerPackage: option.unitsPerPackage,
    unitsPerPackageDerived: option.unitsPerPackageDerived,
    unitsPerPackageIsOverride: option.unitsPerPackageIsOverride,
    cartonsPerPallet: option.cartonsPerPallet,
    palletsPerContainer: option.palletsPerContainer,
    minimumPackages: option.minimumPackages,
    packageIncrement: option.packageIncrement,
    priceMode: option.priceMode,
    // Minor units as a string in the audit trail too: a JSON number here would
    // lose precision the moment somebody reads the log back.
    pricePerPackageMinor: option.pricePerPackageMinor?.toString() ?? null,
    tiers: (option.tiers ?? []).map((tier) => ({
      minPackages: tier.minPackages,
      pricePerPackageMinor: tier.pricePerPackageMinor.toString(),
    })),
  };
}

export { isPalletPackage };

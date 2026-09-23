/**
 * The bulk packaging arithmetic.
 *
 * The figures in here are not arbitrary. They are the worked example the whole
 * feature is specified against - 24 units to a carton, 50 cartons to a UK
 * pallet, 48 to a US one - because the failure this all exists to prevent is a
 * single number: a two-pallet order posting as 2 rather than as 2,400.
 *
 * So the first test is that one, and it is the one to look at first if this
 * file ever goes red.
 */
import { describe, expect, it } from 'vitest';
import {
  CONTAINER_PRESETS,
  PALLET_FOOTPRINTS,
  derivePackaging,
  describePackaging,
  exceedsConfiguredWeight,
  fromGrams,
  fromMillimetres,
  orderingUnitForPackage,
  packagingSellUnit,
  packageTypeForOrderingUnit,
  palletStandardFor,
  pricePackage,
  toGrams,
  toMillimetres,
  validatePackagingOption,
  wholePackagesAvailable,
  type PackagingOptionInput,
} from '../../src/domain/packaging.js';
import { resolveSellUnitQuantity } from '../../src/domain/ordering-unit.js';
import { AppError } from '../../src/domain/errors.js';

/** A complete, valid option. Each test changes the one thing it is about. */
function option(overrides: Partial<PackagingOptionInput> = {}): PackagingOptionInput {
  return {
    packageType: 'UK_PALLET',
    isEnabled: true,
    unitsPerCarton: 24,
    unitsPerPackage: null,
    unitsPerPackageIsOverride: false,
    cartonsPerLayer: 10,
    layerCount: 5,
    cartonsPerPallet: null,
    containerLoadingMethod: null,
    palletsPerContainer: null,
    cartonsPerContainer: null,
    minimumPackages: 1,
    packageIncrement: 1,
    maximumPackages: null,
    priceMode: 'DERIVED_FROM_UNIT',
    pricePerPackageMinor: null,
    currency: 'INR',
    offerCurrency: 'INR',
    containerType: null,
    containerLoadMode: null,
    grossWeightGrams: null,
    netWeightGrams: null,
    maxGrossWeightGrams: null,
    isStackable: false,
    maxStackCount: null,
    incoterm: null,
    tiers: [],
    ...overrides,
  };
}

describe('the worked example', () => {
  it('makes two UK pallets 2,400 units and not 2', () => {
    // 24 to a carton, 50 cartons to a pallet.
    const derived = derivePackaging({
      packageType: 'UK_PALLET',
      unitsPerCarton: 24,
      cartonsPerLayer: 10,
      layerCount: 5,
      cartonsPerPallet: null,
      containerLoadingMethod: null,
      palletsPerContainer: null,
      cartonsPerContainer: null,
    });

    expect(derived.cartonsPerPallet).toBe(50);
    expect(derived.unitsPerPackage).toBe(1200);

    // And two of them, through the SAME quantity engine every other line uses.
    const resolved = resolveSellUnitQuantity({
      spec: packagingSellUnit({
        packageType: 'UK_PALLET',
        unitsPerPackage: derived.unitsPerPackage ?? 0,
        minimumPackages: 1,
        packageIncrement: 1,
        maximumPackages: null,
      }),
      unit: 'UK_PALLET',
      unitQuantity: 2,
      pieces: 0,
      field: 'packageQuantity',
    });

    // THE LINE THIS WHOLE FEATURE IS ABOUT.
    expect(resolved.quantity).toBe(2400);
    expect(resolved.unitQuantity).toBe(2);
    expect(resolved.orderingUnit).toBe('UK_PALLET');
    expect(resolved.piecesPerUnitSnapshot).toBe(1200);
  });

  it('makes a US pallet of 48 cartons 1,152 units', () => {
    const derived = derivePackaging({
      packageType: 'US_PALLET',
      unitsPerCarton: 24,
      cartonsPerLayer: 12,
      layerCount: 4,
      cartonsPerPallet: null,
      containerLoadingMethod: null,
      palletsPerContainer: null,
      cartonsPerContainer: null,
    });

    expect(derived.cartonsPerPallet).toBe(48);
    expect(derived.unitsPerPackage).toBe(1152);
  });
});

describe('derivePackaging', () => {
  it('reads a carton straight off the units per carton', () => {
    const derived = derivePackaging({
      packageType: 'CARTON',
      unitsPerCarton: 24,
      cartonsPerLayer: null,
      layerCount: null,
      cartonsPerPallet: null,
      containerLoadingMethod: null,
      palletsPerContainer: null,
      cartonsPerContainer: null,
    });

    expect(derived.unitsPerPackage).toBe(24);
    expect(derived.cartonsPerPallet).toBeNull();
  });

  it('falls back to a stated carton total when the layers are not given', () => {
    const derived = derivePackaging({
      packageType: 'UK_PALLET',
      unitsPerCarton: 24,
      cartonsPerLayer: null,
      layerCount: null,
      cartonsPerPallet: 50,
      containerLoadingMethod: null,
      palletsPerContainer: null,
      cartonsPerContainer: null,
    });

    expect(derived.cartonsPerPallet).toBe(50);
    expect(derived.unitsPerPackage).toBe(1200);
  });

  it('keeps the whole chain for a pallet-loaded container', () => {
    const derived = derivePackaging({
      packageType: 'CONTAINER',
      unitsPerCarton: 24,
      cartonsPerLayer: 10,
      layerCount: 5,
      cartonsPerPallet: null,
      containerLoadingMethod: 'PALLET_LOADED',
      palletsPerContainer: 20,
      cartonsPerContainer: null,
    });

    expect(derived.cartonsPerPallet).toBe(50);
    expect(derived.cartonsPerContainer).toBe(1000);
    expect(derived.unitsPerPackage).toBe(24_000);
  });

  it('uses the carton count for a floor-loaded container, with no pallet in the chain', () => {
    const derived = derivePackaging({
      packageType: 'CONTAINER',
      unitsPerCarton: 24,
      cartonsPerLayer: 10,
      layerCount: 5,
      cartonsPerPallet: null,
      containerLoadingMethod: 'CARTON_LOADED',
      palletsPerContainer: null,
      cartonsPerContainer: 1100,
    });

    // No pallet, because a floor-loaded container does not have one - and
    // reporting one would put a figure on a packing list nobody can find.
    expect(derived.cartonsPerPallet).toBeNull();
    expect(derived.unitsPerPackage).toBe(26_400);
  });

  it('returns null rather than throwing while a figure is still missing', () => {
    // This runs while somebody is typing. A form that raised an exception at a
    // half-entered figure is a form nobody can fill in.
    const derived = derivePackaging({
      packageType: 'UK_PALLET',
      unitsPerCarton: null,
      cartonsPerLayer: 10,
      layerCount: 5,
      cartonsPerPallet: null,
      containerLoadingMethod: null,
      palletsPerContainer: null,
      cartonsPerContainer: null,
    });

    expect(derived.unitsPerPackage).toBeNull();
    expect(derived.cartonsPerPallet).toBe(50);
  });

  it('refuses a product beyond what a line may hold', () => {
    const derived = derivePackaging({
      packageType: 'CONTAINER',
      unitsPerCarton: 100_000,
      cartonsPerLayer: null,
      layerCount: null,
      cartonsPerPallet: null,
      containerLoadingMethod: 'CARTON_LOADED',
      palletsPerContainer: null,
      cartonsPerContainer: 100_000,
    });

    expect(derived.unitsPerPackage).toBeNull();
  });
});

describe('validatePackagingOption', () => {
  it('makes a complete, enabled option ACTIVE', () => {
    const result = validatePackagingOption(option());

    expect(result.issues).toEqual([]);
    expect(result.state).toBe('ACTIVE');
    expect(result.unitsPerPackage).toBe(1200);
  });

  it('makes a switched-off option DISABLED and keeps its figures', () => {
    const result = validatePackagingOption(option({ isEnabled: false }));

    expect(result.state).toBe('DISABLED');
    // Still derived. Switching a package off must not lose what was typed.
    expect(result.unitsPerPackage).toBe(1200);
  });

  it('holds an enabled option with a missing layout as INCOMPLETE rather than failing', () => {
    const result = validatePackagingOption(
      option({ cartonsPerLayer: null, layerCount: null }),
    );

    expect(result.state).toBe('INCOMPLETE');
    expect(result.issues.map((issue) => issue.code)).toContain('PALLET_LAYOUT_REQUIRED');
  });

  it('asks a container for its type and its loading method', () => {
    const result = validatePackagingOption(
      option({ packageType: 'CONTAINER', containerType: null, containerLoadingMethod: null }),
    );

    const codes = result.issues.map((issue) => issue.code);
    expect(codes).toContain('CONTAINER_TYPE_REQUIRED');
    expect(codes).toContain('CONTAINER_LOADING_REQUIRED');
  });

  it('accepts an override within a plausible band', () => {
    const result = validatePackagingOption(
      option({ unitsPerPackage: 1150, unitsPerPackageIsOverride: true }),
    );

    expect(result.state).toBe('ACTIVE');
    expect(result.unitsPerPackage).toBe(1150);
    // Both figures are kept. "The system says 1,200 and the seller says 1,150"
    // is a question somebody asks during a dispute.
    expect(result.unitsPerPackageDerived).toBe(1200);
  });

  it('refuses an override an order of magnitude from the arithmetic', () => {
    const result = validatePackagingOption(
      option({ unitsPerPackage: 120, unitsPerPackageIsOverride: true }),
    );

    expect(result.issues.map((issue) => issue.code)).toContain('OVERRIDE_IMPLAUSIBLE');
    expect(result.state).toBe('INCOMPLETE');
  });

  it('refuses a maximum below the minimum', () => {
    const result = validatePackagingOption(option({ minimumPackages: 4, maximumPackages: 2 }));

    expect(result.issues.map((issue) => issue.code)).toContain('MAXIMUM_BELOW_MINIMUM');
  });

  it('refuses a gross weight below the net', () => {
    const result = validatePackagingOption(
      option({ netWeightGrams: 500_000n, grossWeightGrams: 400_000n }),
    );

    expect(result.issues.map((issue) => issue.code)).toContain('GROSS_BELOW_NET');
  });

  it('refuses a package already over its own safe load', () => {
    const result = validatePackagingOption(
      option({ grossWeightGrams: 900_000n, maxGrossWeightGrams: 800_000n }),
    );

    expect(result.issues.map((issue) => issue.code)).toContain('OVER_SAFE_LOAD');
  });

  it('refuses an Incoterm that is not one', () => {
    const result = validatePackagingOption(option({ incoterm: 'XYZ' }));

    expect(result.issues.map((issue) => issue.code)).toContain('INCOTERM_UNKNOWN');
  });

  /*
   * The divisibility rule.
   *
   * The one rule here most likely to look like fussiness, and the one that
   * keeps a package line chargeable: an order line is priced as unit price x
   * base-unit quantity, so unless the package price divides exactly, that
   * multiplication does not come back to the package price the buyer agreed
   * to.
   */
  describe('the divisibility rule', () => {
    it('accepts a package price that divides exactly by what is inside', () => {
      const result = validatePackagingOption(
        option({ priceMode: 'PER_PACKAGE', pricePerPackageMinor: 9_999_600n }),
      );

      // 9,999,600 / 1,200 = 8,333 exactly.
      expect(result.issues.map((issue) => issue.code)).not.toContain(
        'PACKAGE_PRICE_NOT_DIVISIBLE',
      );
      expect(result.state).toBe('ACTIVE');
    });

    it('refuses one that does not', () => {
      const result = validatePackagingOption(
        option({ priceMode: 'PER_PACKAGE', pricePerPackageMinor: 9_999_900n }),
      );

      // 9,999,900 / 1,200 = 8,333.25 - a quarter of a paise per unit, which
      // has nowhere to go.
      expect(result.issues.map((issue) => issue.code)).toContain('PACKAGE_PRICE_NOT_DIVISIBLE');
      expect(result.state).toBe('INCOMPLETE');
    });

    it('holds every band to the same rule', () => {
      const result = validatePackagingOption(
        option({
          priceMode: 'PER_PACKAGE',
          pricePerPackageMinor: 9_999_600n,
          tiers: [{ minPackages: 4, pricePerPackageMinor: 9_500_001n }],
        }),
      );

      const issue = result.issues.find((entry) => entry.code === 'PACKAGE_PRICE_NOT_DIVISIBLE');
      expect(issue?.field).toBe('tiers.0.pricePerPackageMinor');
    });
  });
});

describe('pricePackage', () => {
  const base = {
    priceMode: 'PER_PACKAGE' as const,
    pricePerPackageMinor: 1_200_000n,
    unitPriceMinor: 1000n,
    unitsPerPackage: 1200,
    packageQuantity: 1,
  };

  it('uses the option price when no band applies', () => {
    const price = pricePackage({ ...base, tiers: [] });

    expect(price.packagePriceMinor).toBe(1_200_000n);
    expect(price.effectiveUnitPriceMinor).toBe(1000n);
    expect(price.appliedTierMinPackages).toBeNull();
    expect(price.isIndivisible).toBe(false);
  });

  it('derives from the unit price when told to', () => {
    const price = pricePackage({ ...base, priceMode: 'DERIVED_FROM_UNIT', tiers: [] });

    expect(price.packagePriceMinor).toBe(1_200_000n);
  });

  it('takes the highest band the quantity reaches', () => {
    const tiers = [
      { minPackages: 2, pricePerPackageMinor: 1_140_000n },
      { minPackages: 5, pricePerPackageMinor: 1_080_000n },
    ];

    expect(pricePackage({ ...base, tiers, packageQuantity: 1 }).packagePriceMinor).toBe(1_200_000n);
    // Exactly ON the boundary takes the band - a band that started "above" its
    // own figure would be a discount nobody could ever reach.
    expect(pricePackage({ ...base, tiers, packageQuantity: 2 }).packagePriceMinor).toBe(1_140_000n);
    expect(pricePackage({ ...base, tiers, packageQuantity: 4 }).packagePriceMinor).toBe(1_140_000n);
    expect(pricePackage({ ...base, tiers, packageQuantity: 5 }).packagePriceMinor).toBe(1_080_000n);
    expect(pricePackage({ ...base, tiers, packageQuantity: 50 }).packagePriceMinor).toBe(1_080_000n);
  });

  it('returns no price at all under FREIGHT_QUOTE, and says so', () => {
    const price = pricePackage({ ...base, priceMode: 'FREIGHT_QUOTE', tiers: [] });

    expect(price.requiresQuote).toBe(true);
    // Zero, which is why callers check the FLAG rather than the figure - a
    // zero reaching a total would be a free pallet.
    expect(price.packagePriceMinor).toBe(0n);
  });

  it('flags a price that cannot be divided exactly rather than hiding it', () => {
    const price = pricePackage({ ...base, pricePerPackageMinor: 1_200_001n, tiers: [] });

    expect(price.isIndivisible).toBe(true);
  });

  it('keeps money in bigint at a scale a JS number would lose', () => {
    // 19 digits. `Number` loses precision above 2^53, which is 16 digits.
    const price = pricePackage({
      ...base,
      pricePerPackageMinor: 1_200_000_000_000_000_000n,
      tiers: [],
    });

    expect(price.packagePriceMinor).toBe(1_200_000_000_000_000_000n);
    expect(price.effectiveUnitPriceMinor).toBe(1_000_000_000_000_000n);
  });
});

describe('describePackaging', () => {
  it('multiplies the whole chain out for a container order', () => {
    const breakdown = describePackaging({
      packageType: 'CONTAINER',
      packageQuantity: 2,
      unitsPerPackage: 24_000,
      unitsPerCarton: 24,
      cartonsPerPallet: 50,
      palletsPerContainer: 20,
      cartonsPerContainer: 1000,
      grossWeightGrams: 18_000_000n,
      cargoVolumeCm3: 60_000_000n,
    });

    expect(breakdown.totalBaseUnits).toBe(48_000);
    expect(breakdown.totalContainers).toBe(2);
    expect(breakdown.totalPallets).toBe(40);
    expect(breakdown.totalCartons).toBe(2000);
    expect(breakdown.grossWeightGrams).toBe(36_000_000n);
    expect(breakdown.volumeCm3).toBe(120_000_000n);
  });

  it('counts a pallet order in pallets and cartons, with no container', () => {
    const breakdown = describePackaging({
      packageType: 'UK_PALLET',
      packageQuantity: 2,
      unitsPerPackage: 1200,
      unitsPerCarton: 24,
      cartonsPerPallet: 50,
      palletsPerContainer: null,
      cartonsPerContainer: null,
      grossWeightGrams: null,
      cargoVolumeCm3: null,
    });

    expect(breakdown.totalBaseUnits).toBe(2400);
    expect(breakdown.totalPallets).toBe(2);
    expect(breakdown.totalCartons).toBe(100);
    expect(breakdown.totalContainers).toBeNull();
  });
});

describe('wholePackagesAvailable', () => {
  it('rounds DOWN, because part of a pallet cannot be picked', () => {
    // 2,700 units, 1,200 to a pallet: two complete pallets and 300 spare.
    expect(wholePackagesAvailable(2700, 1200)).toBe(2);
    expect(wholePackagesAvailable(1199, 1200)).toBe(0);
    expect(wholePackagesAvailable(2400, 1200)).toBe(2);
  });

  it('answers zero rather than dividing by zero', () => {
    expect(wholePackagesAvailable(1000, 0)).toBe(0);
  });
});

describe('unit conversion', () => {
  it('turns inches into millimetres exactly, where a float would not', () => {
    // 48 x 25.4 is 1219.1999999999998 in binary floating point. The rational
    // arithmetic gives 1219.
    expect(toMillimetres(48, 'IN', 'length')).toBe(1219);
    expect(toMillimetres(40, 'IN', 'width')).toBe(1016);
  });

  it('handles the other length units', () => {
    expect(toMillimetres(1.2, 'M', 'length')).toBe(1200);
    expect(toMillimetres(120, 'CM', 'length')).toBe(1200);
    expect(toMillimetres(1200, 'MM', 'length')).toBe(1200);
  });

  it('turns pounds into grams on the exact definition', () => {
    // A pound is 453.59237 g exactly.
    expect(toGrams(1, 'LB', 'weight')).toBe(454n);
    expect(toGrams(100, 'LB', 'weight')).toBe(45_359n);
    expect(toGrams(25, 'KG', 'weight')).toBe(25_000n);
  });

  it('leaves a blank field blank rather than making it zero', () => {
    expect(toMillimetres(null, 'MM', 'length')).toBeNull();
    expect(toGrams(undefined, 'KG', 'weight')).toBeNull();
  });

  it('refuses a negative measurement', () => {
    expect(() => toMillimetres(-5, 'MM', 'length')).toThrow(AppError);
  });

  it('shows the seller their own figure back in their own unit', () => {
    expect(fromMillimetres(1219, 'IN')).toBeCloseTo(48, 1);
    expect(fromGrams(25_000n, 'KG')).toBe(25);
    expect(fromMillimetres(null, 'MM')).toBeNull();
  });
});

describe('the presets', () => {
  it('gives a UK pallet its footprint and nothing else', () => {
    const footprint = PALLET_FOOTPRINTS.UK_1200_1000;

    expect(footprint.lengthMm).toBe(1200);
    expect(footprint.widthMm).toBe(1000);
    // No height, no load, no carton count. Those are the seller's - a pallet
    // of gauze and a pallet of saline share the floor and nothing else.
    expect(Object.keys(footprint)).toEqual(['standard', 'lengthMm', 'widthMm', 'label']);
  });

  it('gives a US pallet the 48 x 40 inch footprint in millimetres', () => {
    expect(PALLET_FOOTPRINTS.US_1219_1016.lengthMm).toBe(1219);
    expect(PALLET_FOOTPRINTS.US_1219_1016.widthMm).toBe(1016);
  });

  it('carries nothing at all for a custom container', () => {
    // A seller describing their own equipment is telling us we have no table
    // for it, and inventing one would be a capacity nobody stated.
    expect(CONTAINER_PRESETS.CUSTOM.nominalMaxPayloadGrams).toBeNull();
    expect(CONTAINER_PRESETS.CUSTOM.nominalVolumeCm3).toBeNull();
  });

  it('names every container figure as nominal', () => {
    for (const preset of Object.values(CONTAINER_PRESETS)) {
      const guidanceKeys = Object.keys(preset).filter(
        (key) => key !== 'type' && key !== 'label',
      );
      // Every one of them. A field called `maxPayloadGrams` would read as a
      // promise, and a seller who took it as one would one day be unable to
      // load the box.
      expect(guidanceKeys.every((key) => key.startsWith('nominal'))).toBe(true);
    }
  });
});

describe('the sell unit', () => {
  it('applies the seller minimum and step in PACKAGES, before the units', () => {
    const spec = packagingSellUnit({
      packageType: 'UK_PALLET',
      unitsPerPackage: 1200,
      minimumPackages: 4,
      packageIncrement: 2,
      maximumPackages: null,
    });

    // Asking for one: raised to the minimum of four, which is on the step.
    const resolved = resolveSellUnitQuantity({
      spec,
      unit: 'UK_PALLET',
      unitQuantity: 1,
      pieces: 0,
      field: 'packageQuantity',
    });

    expect(resolved.unitQuantity).toBe(4);
    expect(resolved.quantity).toBe(4800);
  });

  it('raises to the minimum first and THEN onto the step', () => {
    const spec = packagingSellUnit({
      packageType: 'CARTON',
      unitsPerPackage: 24,
      minimumPackages: 5,
      packageIncrement: 4,
      maximumPackages: null,
    });

    // A minimum of 5 with a step of 4 means 8, not 5: the step is a rule about
    // what the seller can actually pick and pack, and the minimum does not
    // exempt a buyer from it.
    const resolved = resolveSellUnitQuantity({
      spec,
      unit: 'CARTON',
      unitQuantity: 5,
      pieces: 0,
      field: 'packageQuantity',
    });

    expect(resolved.unitQuantity).toBe(8);
    expect(resolved.quantity).toBe(192);
  });

  it('refuses a quantity above the seller ceiling', () => {
    const spec = packagingSellUnit({
      packageType: 'CONTAINER',
      unitsPerPackage: 24_000,
      minimumPackages: 1,
      packageIncrement: 1,
      maximumPackages: 3,
    });

    expect(() =>
      resolveSellUnitQuantity({
        spec,
        unit: 'CONTAINER',
        unitQuantity: 4,
        pieces: 0,
        field: 'packageQuantity',
      }),
    ).toThrow(AppError);
  });

  it('refuses a request that names a different package', () => {
    const spec = packagingSellUnit({
      packageType: 'UK_PALLET',
      unitsPerPackage: 1200,
      minimumPackages: 1,
      packageIncrement: 1,
      maximumPackages: null,
    });

    // "2 cartons" on a pallet line would otherwise be read as 2 PIECES and
    // rounded up to one whole pallet - a basket six hundred times the one that
    // was asked for.
    expect(() =>
      resolveSellUnitQuantity({
        spec,
        unit: 'CARTON',
        unitQuantity: 2,
        pieces: 2,
        field: 'packageQuantity',
      }),
    ).toThrow(AppError);
  });
});

describe('the enum mapping', () => {
  it('maps each package type to its own line unit and back', () => {
    for (const packageType of ['CARTON', 'UK_PALLET', 'US_PALLET', 'CONTAINER'] as const) {
      const unit = orderingUnitForPackage(packageType);
      expect(packageTypeForOrderingUnit(unit)).toBe(packageType);
    }
  });

  it('does not claim the operator carton as a bulk package', () => {
    // `OUTER_CARTON` is the DEPLOYMENT's carton, sized by a setting. Folding
    // it in here would put the operator's multiplication on a seller's line.
    expect(packageTypeForOrderingUnit('OUTER_CARTON')).toBeNull();
    expect(packageTypeForOrderingUnit('PIECE')).toBeNull();
  });

  it('gives each pallet type its own standard, and a non-pallet none', () => {
    expect(palletStandardFor('UK_PALLET')).toBe('UK_1200_1000');
    expect(palletStandardFor('US_PALLET')).toBe('US_1219_1016');
    expect(palletStandardFor('CARTON')).toBeNull();
    expect(palletStandardFor('CONTAINER')).toBeNull();
  });
});

describe('exceedsConfiguredWeight', () => {
  it('compares one package against its own stated safe load', () => {
    expect(
      exceedsConfiguredWeight({ grossWeightGrams: 900_000n, maxGrossWeightGrams: 800_000n }),
    ).toBe(true);

    expect(
      exceedsConfiguredWeight({ grossWeightGrams: 700_000n, maxGrossWeightGrams: 800_000n }),
    ).toBe(false);
  });

  it('says nothing when either figure is missing', () => {
    // A seller who has not stated a safe load has not stated a limit, and
    // inventing one would refuse an order for a rule nobody made.
    expect(
      exceedsConfiguredWeight({ grossWeightGrams: 900_000n, maxGrossWeightGrams: null }),
    ).toBe(false);
  });
});

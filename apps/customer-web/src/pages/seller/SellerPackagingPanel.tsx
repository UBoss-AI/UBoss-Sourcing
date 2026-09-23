/**
 * Where a seller says how their goods are actually packed.
 *
 * Four tabs - carton, UK pallet, US pallet, container - each its own form,
 * because a seller who only ships cartons should not have to scroll past three
 * sections they will never fill in.
 *
 * THE TWO THINGS THIS SCREEN IS MOST CAREFUL ABOUT
 *
 * **What is derived and what is stated.** Units per pallet is cartons per
 * layer × layers × units per carton, and the derived figure updates as the
 * seller types. A real pallet is not always a tidy multiple - a top layer is
 * short, a corner takes a spacer - so the seller may override it. When they
 * do, BOTH numbers stay on screen: theirs, and the one the layout works out
 * to. "The system says 1,200 and you said 1,150" is a question somebody asks
 * during a dispute, and it has to have an answer.
 *
 * **What is a preset and what is a promise.** A pallet preset supplies two
 * floor dimensions and nothing else. A container preset supplies nominal
 * figures that are labelled nominal wherever they appear, because internal
 * dimensions and payload vary by build and by carrier - a seller who promises
 * a number off a table will one day be unable to load it.
 *
 * NOTHING HERE VALIDATES ANYTHING. The server decides whether an option is
 * complete, and sends back the state and the message naming the field. This
 * draws that answer. A browser that made its own decision would eventually
 * call an option complete that the buyer's page refuses to offer.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, Field, Input, Select } from '@/components/ui';
import { useToast } from '@/components/toast-context';
import { errorMessage } from '@/lib/errors';
import { formatMoneyMinor, formatNumber } from '@/lib/format';
import { useT, type TranslationKey } from '@/i18n/i18n-context';
import {
  fetchPackagingPresets,
  fetchPackagingProfile,
  savePackagingOption,
  setPackagingEnabled,
  type PackagingOption,
  type PackagingOptionInput,
  type PackagingPriceMode,
  type SellerPackageType,
} from '@/lib/seller';

const PACKAGE_TYPES: SellerPackageType[] = ['CARTON', 'UK_PALLET', 'US_PALLET', 'CONTAINER'];

/** The translation key for a package type's name. Plural-aware. */
function typeKey(packageType: SellerPackageType): TranslationKey {
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

/** The editable shape of one option, before it is sent. */
interface Draft {
  isEnabled: boolean;
  packageSku: string;
  unitsPerCarton: string;
  unitsPerPackage: string;
  unitsPerPackageIsOverride: boolean;
  cartonsPerLayer: string;
  layerCount: string;
  loadedHeight: string;
  isStackable: boolean;
  maxStackCount: string;
  containerType: string;
  containerLoadMode: string;
  containerLoadingMethod: string;
  palletsPerContainer: string;
  cartonsPerContainer: string;
  originPortLabel: string;
  incoterm: string;
  dimensionUnit: 'MM' | 'CM' | 'M' | 'IN';
  length: string;
  width: string;
  height: string;
  weightUnit: 'G' | 'KG' | 'LB';
  netWeight: string;
  grossWeight: string;
  maxGrossWeight: string;
  minimumPackages: string;
  packageIncrement: string;
  maximumPackages: string;
  priceMode: PackagingPriceMode;
  pricePerPackageMajor: string;
  handlingLeadTimeDays: string;
  productionLeadTimeDays: string;
  isHazardous: boolean;
  temperatureNotes: string;
  specialHandlingNotes: string;
  tiers: { minPackages: string; priceMajor: string }[];
}

const EMPTY_DRAFT: Draft = {
  isEnabled: false,
  packageSku: '',
  unitsPerCarton: '',
  unitsPerPackage: '',
  unitsPerPackageIsOverride: false,
  cartonsPerLayer: '',
  layerCount: '',
  loadedHeight: '',
  isStackable: false,
  maxStackCount: '',
  containerType: '',
  containerLoadMode: 'FCL',
  containerLoadingMethod: '',
  palletsPerContainer: '',
  cartonsPerContainer: '',
  originPortLabel: '',
  incoterm: '',
  dimensionUnit: 'MM',
  length: '',
  width: '',
  height: '',
  weightUnit: 'KG',
  netWeight: '',
  grossWeight: '',
  maxGrossWeight: '',
  minimumPackages: '1',
  packageIncrement: '1',
  maximumPackages: '',
  priceMode: 'DERIVED_FROM_UNIT',
  pricePerPackageMajor: '',
  handlingLeadTimeDays: '',
  productionLeadTimeDays: '',
  isHazardous: false,
  temperatureNotes: '',
  specialHandlingNotes: '',
  tiers: [],
};

/**
 * A major-unit amount as minor units.
 *
 * Done on the STRING rather than through a float: "1234.56" becomes "123456"
 * by moving the point, never by multiplying a parsed number by a hundred,
 * which turns 19.99 into 1998.9999999999998. The exponent comes from the
 * currency rather than being assumed to be two - not every currency has
 * hundredths.
 */
function toMinor(major: string, exponent: number): string | null {
  const trimmed = major.trim();
  if (trimmed === '') return null;
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;

  const [whole = '0', fraction = ''] = trimmed.split('.');
  const padded = (fraction + '0'.repeat(exponent)).slice(0, exponent);

  return `${whole}${padded}`.replace(/^0+(?=\d)/, '');
}

/** Minor units back into the box, so a saved price reads as it was typed. */
function toMajor(minor: string | null, exponent: number): string {
  if (minor === null || !/^\d+$/.test(minor)) return '';
  if (exponent === 0) return minor;

  const padded = minor.padStart(exponent + 1, '0');
  return `${padded.slice(0, -exponent)}.${padded.slice(-exponent)}`;
}

function draftFrom(option: PackagingOption | undefined, exponent: number): Draft {
  if (option === undefined) return EMPTY_DRAFT;

  return {
    isEnabled: option.isEnabled,
    packageSku: option.packageSku ?? '',
    unitsPerCarton: option.unitsPerCarton === null ? '' : String(option.unitsPerCarton),
    unitsPerPackage: option.unitsPerPackage === null ? '' : String(option.unitsPerPackage),
    unitsPerPackageIsOverride: option.unitsPerPackageIsOverride,
    cartonsPerLayer: option.cartonsPerLayer === null ? '' : String(option.cartonsPerLayer),
    layerCount: option.layerCount === null ? '' : String(option.layerCount),
    // The unit the seller typed in, so the box shows their own figure rather
    // than a converted one with a rounding artefact in it.
    loadedHeight: option.loadedHeightMm === null ? '' : String(option.loadedHeightMm),
    isStackable: option.isStackable,
    maxStackCount: option.maxStackCount === null ? '' : String(option.maxStackCount),
    containerType: option.containerType ?? '',
    containerLoadMode: option.containerLoadMode ?? 'FCL',
    containerLoadingMethod: option.containerLoadingMethod ?? '',
    palletsPerContainer:
      option.palletsPerContainer === null ? '' : String(option.palletsPerContainer),
    cartonsPerContainer:
      option.cartonsPerContainer === null ? '' : String(option.cartonsPerContainer),
    originPortLabel: option.originPortLabel ?? '',
    incoterm: option.incoterm ?? '',
    dimensionUnit: option.enteredDimensionUnit,
    length: option.lengthEntered === null ? '' : String(option.lengthEntered),
    width: option.widthEntered === null ? '' : String(option.widthEntered),
    height: option.heightEntered === null ? '' : String(option.heightEntered),
    weightUnit: option.enteredWeightUnit,
    netWeight: option.netWeightEntered === null ? '' : String(option.netWeightEntered),
    grossWeight: option.grossWeightEntered === null ? '' : String(option.grossWeightEntered),
    maxGrossWeight:
      option.maxGrossWeightEntered === null ? '' : String(option.maxGrossWeightEntered),
    minimumPackages: String(option.minimumPackages),
    packageIncrement: String(option.packageIncrement),
    maximumPackages: option.maximumPackages === null ? '' : String(option.maximumPackages),
    priceMode: option.priceMode,
    pricePerPackageMajor: toMajor(option.pricePerPackageMinor, exponent),
    handlingLeadTimeDays:
      option.handlingLeadTimeDays === null ? '' : String(option.handlingLeadTimeDays),
    productionLeadTimeDays:
      option.productionLeadTimeDays === null ? '' : String(option.productionLeadTimeDays),
    isHazardous: option.isHazardous,
    temperatureNotes: option.temperatureNotes ?? '',
    specialHandlingNotes: option.specialHandlingNotes ?? '',
    tiers: option.tiers.map((tier) => ({
      minPackages: String(tier.minPackages),
      priceMajor: toMajor(tier.pricePerPackageMinor, exponent),
    })),
  };
}

const numberOrNull = (value: string): number | null => {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

interface SellerPackagingPanelProps {
  offerId: string;
  /** The offer's own currency. Every package price is in it, and only it. */
  currency: string;
  /** Minor units per major. Two for most currencies, zero for a few. */
  currencyExponent: number;
}

export function SellerPackagingPanel({
  offerId,
  currency,
  currencyExponent,
}: SellerPackagingPanelProps): React.JSX.Element {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [activeType, setActiveType] = useState<SellerPackageType>('CARTON');
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saveError, setSaveError] = useState<string | null>(null);

  const profileQuery = useQuery({
    queryKey: ['seller', 'packaging', offerId],
    queryFn: () => fetchPackagingProfile(offerId),
  });

  const presetsQuery = useQuery({
    queryKey: ['seller', 'packaging', 'presets'],
    queryFn: fetchPackagingPresets,
    // The presets are constants in the deployment's own build. Fetched once
    // and held, because re-fetching a static table on every tab change is a
    // round trip for a list that cannot have moved.
    staleTime: Number.POSITIVE_INFINITY,
  });

  // Memoised so the `active` lookup below does not see a new array on every
  // render - which would make it recompute, reset the draft through the effect,
  // and throw away whatever the seller was halfway through typing.
  const options = useMemo(() => profileQuery.data?.options ?? [], [profileQuery.data]);
  const active = useMemo(
    () => options.find((option) => option.packageType === activeType),
    [options, activeType],
  );

  // Reload the draft whenever the tab or the saved data changes. The seller's
  // unsaved edits to ONE tab are deliberately not carried to another: two
  // half-filled forms in flight is how somebody saves a pallet holding a
  // container's figures.
  useEffect(() => {
    setDraft(draftFrom(active, currencyExponent));
    setSaveError(null);
  }, [active, currencyExponent]);

  /**
   * What the layout works out to, live, as the seller types.
   *
   * Mirrors `derivePackaging` on the server. Duplicated on purpose and
   * contained to this one block so a divergence is findable: the server
   * recomputes and STORES its own answer on every save, so a browser that got
   * this wrong shows a wrong preview for a moment and is then corrected.
   */
  const derived = useMemo(() => {
    const perCarton = numberOrNull(draft.unitsPerCarton);
    const perLayer = numberOrNull(draft.cartonsPerLayer);
    const layers = numberOrNull(draft.layerCount);

    if (activeType === 'CARTON') {
      return { cartonsPerPallet: null, unitsPerPackage: perCarton };
    }

    const cartonsPerPallet =
      perLayer !== null && layers !== null && perLayer > 0 && layers > 0
        ? perLayer * layers
        : null;

    if (activeType === 'UK_PALLET' || activeType === 'US_PALLET') {
      return {
        cartonsPerPallet,
        unitsPerPackage:
          cartonsPerPallet !== null && perCarton !== null ? cartonsPerPallet * perCarton : null,
      };
    }

    const pallets = numberOrNull(draft.palletsPerContainer);
    const cartonsInContainer =
      draft.containerLoadingMethod === 'PALLET_LOADED'
        ? pallets !== null && cartonsPerPallet !== null
          ? pallets * cartonsPerPallet
          : null
        : numberOrNull(draft.cartonsPerContainer);

    return {
      cartonsPerPallet,
      unitsPerPackage:
        cartonsInContainer !== null && perCarton !== null ? cartonsInContainer * perCarton : null,
    };
  }, [draft, activeType]);

  const save = useMutation({
    mutationFn: () => {
      const body: PackagingOptionInput = {
        packageType: activeType,
        isEnabled: draft.isEnabled,
        packageSku: draft.packageSku.trim() === '' ? null : draft.packageSku.trim(),

        unitsPerCarton: numberOrNull(draft.unitsPerCarton),
        unitsPerPackage: draft.unitsPerPackageIsOverride
          ? numberOrNull(draft.unitsPerPackage)
          : null,
        unitsPerPackageIsOverride: draft.unitsPerPackageIsOverride,

        cartonsPerLayer: numberOrNull(draft.cartonsPerLayer),
        layerCount: numberOrNull(draft.layerCount),
        loadedHeight: numberOrNull(draft.loadedHeight),
        isStackable: draft.isStackable,
        maxStackCount: numberOrNull(draft.maxStackCount),

        containerType: draft.containerType === '' ? null : draft.containerType,
        containerLoadMode: draft.containerLoadMode === '' ? null : draft.containerLoadMode,
        containerLoadingMethod:
          draft.containerLoadingMethod === '' ? null : draft.containerLoadingMethod,
        palletsPerContainer: numberOrNull(draft.palletsPerContainer),
        cartonsPerContainer: numberOrNull(draft.cartonsPerContainer),
        originPortLabel: draft.originPortLabel.trim() === '' ? null : draft.originPortLabel.trim(),
        incoterm: draft.incoterm === '' ? null : draft.incoterm,

        dimensionUnit: draft.dimensionUnit,
        length: numberOrNull(draft.length),
        width: numberOrNull(draft.width),
        height: numberOrNull(draft.height),

        weightUnit: draft.weightUnit,
        netWeight: numberOrNull(draft.netWeight),
        grossWeight: numberOrNull(draft.grossWeight),
        maxGrossWeight: numberOrNull(draft.maxGrossWeight),

        minimumPackages: numberOrNull(draft.minimumPackages) ?? 1,
        packageIncrement: numberOrNull(draft.packageIncrement) ?? 1,
        maximumPackages: numberOrNull(draft.maximumPackages),

        priceMode: draft.priceMode,
        pricePerPackageMinor:
          draft.priceMode === 'PER_PACKAGE'
            ? toMinor(draft.pricePerPackageMajor, currencyExponent)
            : null,

        handlingLeadTimeDays: numberOrNull(draft.handlingLeadTimeDays),
        productionLeadTimeDays: numberOrNull(draft.productionLeadTimeDays),

        isHazardous: draft.isHazardous,
        temperatureNotes:
          draft.temperatureNotes.trim() === '' ? null : draft.temperatureNotes.trim(),
        specialHandlingNotes:
          draft.specialHandlingNotes.trim() === '' ? null : draft.specialHandlingNotes.trim(),

        tiers: draft.tiers
          .map((tier) => ({
            minPackages: numberOrNull(tier.minPackages) ?? 0,
            pricePerPackageMinor: toMinor(tier.priceMajor, currencyExponent) ?? '',
          }))
          .filter((tier) => tier.minPackages > 0 && tier.pricePerPackageMinor !== ''),
      };

      return savePackagingOption(offerId, body);
    },
    onSuccess: async (profile) => {
      setSaveError(null);
      queryClient.setQueryData(['seller', 'packaging', offerId], profile);

      const saved = profile.options.find((option) => option.packageType === activeType);

      // The server's own verdict, shown back. An option that is enabled and
      // still incomplete is NOT a failed save - the figures are kept and the
      // buyer's selector holds it back until the missing field is filled in.
      if (saved?.state === 'INCOMPLETE') {
        toast.info(t('sellerPackaging.savedIncomplete'));
      } else {
        toast.success(t('sellerPackaging.saved'));
      }

      await queryClient.invalidateQueries({ queryKey: ['seller', 'listing', offerId] });
    },
    onError: (error) => {
      setSaveError(errorMessage(t, error, t('sellerPackaging.couldNotSave')));
    },
  });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => setPackagingEnabled(offerId, activeType, enabled),
    onSuccess: (profile) => {
      queryClient.setQueryData(['seller', 'packaging', offerId], profile);
    },
    onError: (error) => {
      setSaveError(errorMessage(t, error, t('sellerPackaging.couldNotSave')));
    },
  });

  const isPallet = activeType === 'UK_PALLET' || activeType === 'US_PALLET';
  const isContainer = activeType === 'CONTAINER';

  const footprint =
    /*
     * `?? []` before `.find`, not `?.` after the object.
     *
     * `presetsQuery.data?.palletFootprints.find(…)` only guards the OBJECT
     * being absent. A response that arrived without the array - an older
     * cached one, a partial answer, a deployment mid-upgrade - has
     * `palletFootprints` undefined, and `.find` on that throws inside render.
     * On this screen that takes the whole listing page down behind an error
     * boundary, which is a very large consequence for a missing hint.
     */
    (presetsQuery.data?.palletFootprints ?? []).find((entry) =>
      activeType === 'UK_PALLET'
        ? entry.standard === 'UK_1200_1000'
        : entry.standard === 'US_1219_1016',
    ) ?? null;

  const containerPreset =
    (presetsQuery.data?.containers ?? []).find((entry) => entry.type === draft.containerType) ??
    null;

  return (
    <Card
      title={t('sellerPackaging.title')}
      description={t('sellerPackaging.intro')}
      bodyClassName="px-6 py-5"
    >
      <div className="flex flex-wrap gap-2" role="tablist" aria-label={t('sellerPackaging.title')}>
        {PACKAGE_TYPES.map((packageType) => {
          const option = options.find((entry) => entry.packageType === packageType);
          const isActive = packageType === activeType;

          return (
            <button
              key={packageType}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => {
                setActiveType(packageType);
              }}
              className={[
                'inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition',
                isActive ? 'border-brand bg-brand-soft font-semibold' : 'border-border',
              ].join(' ')}
            >
              {t(typeKey(packageType), { count: 1 })}
              {/* The state, at a glance, on the tab. A seller with four
                  packages configured needs to know which one is holding the
                  listing back without opening all four. */}
              {option !== undefined && option.state === 'ACTIVE' && (
                <Badge tone="success">{t('sellerPackaging.state.active')}</Badge>
              )}
              {option !== undefined && option.state === 'INCOMPLETE' && (
                <Badge tone="warning">{t('sellerPackaging.state.incomplete')}</Badge>
              )}
            </button>
          );
        })}
      </div>

      {active?.validationMessage != null && (
        <p role="status" className="mt-4 rounded-lg bg-warning-soft p-3 text-sm text-warning">
          {active.validationMessage}
        </p>
      )}

      <label className="mt-5 flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={draft.isEnabled}
          onChange={(event) => {
            setDraft((current) => ({ ...current, isEnabled: event.target.checked }));
            // Persisted immediately, because switching a package OFF is
            // something a seller does urgently - a pallet they cannot fulfil
            // this week - and making them find the Save button first means it
            // stays on sale while they look for it.
            if (active !== undefined) toggle.mutate(event.target.checked);
          }}
        />
        {t('sellerPackaging.offerThis', { package: t(typeKey(activeType), { count: 2 }) })}
      </label>

      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t('sellerPackaging.unitsPerCarton')} hint={t('sellerPackaging.unitsPerCartonHint')}>
          {({ inputId, describedBy }) => (
            <Input
                id={inputId}
                aria-describedby={describedBy}
              type="number"
              min={1}
              value={draft.unitsPerCarton}
              onChange={(event) => {
                setDraft((current) => ({ ...current, unitsPerCarton: event.target.value }));
              }}
            />
          )}
        </Field>

        <Field label={t('sellerPackaging.packageSku')}>
          {({ inputId, describedBy }) => (
            <Input
                id={inputId}
                aria-describedby={describedBy}
              value={draft.packageSku}
              onChange={(event) => {
                setDraft((current) => ({ ...current, packageSku: event.target.value }));
              }}
            />
          )}
        </Field>

        {(isPallet || isContainer) && (
          <>
            <Field label={t('sellerPackaging.cartonsPerLayer')}>
              {({ inputId, describedBy }) => (
                <Input
                    id={inputId}
                    aria-describedby={describedBy}
                  type="number"
                  min={1}
                  value={draft.cartonsPerLayer}
                  onChange={(event) => {
                    setDraft((current) => ({ ...current, cartonsPerLayer: event.target.value }));
                  }}
                />
              )}
            </Field>

            <Field label={t('sellerPackaging.layers')}>
              {({ inputId, describedBy }) => (
                <Input
                    id={inputId}
                    aria-describedby={describedBy}
                  type="number"
                  min={1}
                  value={draft.layerCount}
                  onChange={(event) => {
                    setDraft((current) => ({ ...current, layerCount: event.target.value }));
                  }}
                />
              )}
            </Field>
          </>
        )}

        {isContainer && (
          <>
            <Field label={t('sellerPackaging.containerType')}>
              {({ inputId, describedBy }) => (
                <Select
                    id={inputId}
                    aria-describedby={describedBy}
                  value={draft.containerType}
                  onChange={(event) => {
                    setDraft((current) => ({ ...current, containerType: event.target.value }));
                  }}
                >
                  <option value="">{t('sellerPackaging.choose')}</option>
                  {(presetsQuery.data?.containers ?? []).map((preset) => (
                    <option key={preset.type} value={preset.type}>
                      {preset.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            <Field label={t('sellerPackaging.loadMode')}>
              {({ inputId, describedBy }) => (
                <Select
                    id={inputId}
                    aria-describedby={describedBy}
                  value={draft.containerLoadMode}
                  onChange={(event) => {
                    setDraft((current) => ({ ...current, containerLoadMode: event.target.value }));
                  }}
                >
                  <option value="FCL">{t('sellerPackaging.fcl')}</option>
                  <option value="LCL">{t('sellerPackaging.lcl')}</option>
                </Select>
              )}
            </Field>

            <Field label={t('sellerPackaging.loadingMethod')}>
              {({ inputId, describedBy }) => (
                <Select
                    id={inputId}
                    aria-describedby={describedBy}
                  value={draft.containerLoadingMethod}
                  onChange={(event) => {
                    setDraft((current) => ({
                      ...current,
                      containerLoadingMethod: event.target.value,
                    }));
                  }}
                >
                  <option value="">{t('sellerPackaging.choose')}</option>
                  <option value="PALLET_LOADED">{t('sellerPackaging.palletLoaded')}</option>
                  <option value="CARTON_LOADED">{t('sellerPackaging.cartonLoaded')}</option>
                  <option value="CUSTOM">{t('sellerPackaging.customLoading')}</option>
                </Select>
              )}
            </Field>

            {draft.containerLoadingMethod === 'PALLET_LOADED' ? (
              <Field label={t('sellerPackaging.palletsPerContainer')}>
                {({ inputId, describedBy }) => (
                  <Input
                      id={inputId}
                      aria-describedby={describedBy}
                    type="number"
                    min={1}
                    value={draft.palletsPerContainer}
                    onChange={(event) => {
                      setDraft((current) => ({
                        ...current,
                        palletsPerContainer: event.target.value,
                      }));
                    }}
                  />
                )}
              </Field>
            ) : (
              <Field label={t('sellerPackaging.cartonsPerContainer')}>
                {({ inputId, describedBy }) => (
                  <Input
                      id={inputId}
                      aria-describedby={describedBy}
                    type="number"
                    min={1}
                    value={draft.cartonsPerContainer}
                    onChange={(event) => {
                      setDraft((current) => ({
                        ...current,
                        cartonsPerContainer: event.target.value,
                      }));
                    }}
                  />
                )}
              </Field>
            )}

            <Field label={t('sellerPackaging.originPort')}>
              {({ inputId, describedBy }) => (
                <Input
                    id={inputId}
                    aria-describedby={describedBy}
                  value={draft.originPortLabel}
                  onChange={(event) => {
                    setDraft((current) => ({ ...current, originPortLabel: event.target.value }));
                  }}
                />
              )}
            </Field>

            <Field label={t('sellerPackaging.incoterm')}>
              {({ inputId, describedBy }) => (
                <Select
                    id={inputId}
                    aria-describedby={describedBy}
                  value={draft.incoterm}
                  onChange={(event) => {
                    setDraft((current) => ({ ...current, incoterm: event.target.value }));
                  }}
                >
                  <option value="">{t('sellerPackaging.choose')}</option>
                  {(presetsQuery.data?.incoterms ?? []).map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </>
        )}
      </div>

      {/* The derivation, live, with the override beside it rather than
          instead of it. */}
      <div className="mt-5 rounded-lg bg-surface-sunken p-4">
        <p className="text-sm font-semibold">
          {derived.unitsPerPackage === null
            ? t('sellerPackaging.cannotDeriveYet')
            : t('sellerPackaging.derivedUnits', {
                units: formatNumber(derived.unitsPerPackage),
              })}
        </p>

        {derived.cartonsPerPallet !== null && (
          <p className="text-xs text-ink-muted">
            {t('sellerPackaging.derivedCartons', {
              cartons: formatNumber(derived.cartonsPerPallet),
            })}
          </p>
        )}

        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.unitsPerPackageIsOverride}
            onChange={(event) => {
              setDraft((current) => ({
                ...current,
                unitsPerPackageIsOverride: event.target.checked,
                // Seeded with the derived figure, so an override starts from
                // the arithmetic rather than from an empty box - a seller
                // correcting a short top layer is adjusting a number, not
                // inventing one.
                unitsPerPackage: event.target.checked
                  ? String(derived.unitsPerPackage ?? '')
                  : current.unitsPerPackage,
              }));
            }}
          />
          {t('sellerPackaging.overrideUnits')}
        </label>

        {draft.unitsPerPackageIsOverride && (
          <div className="mt-2 max-w-xs">
            <Field
              label={t('sellerPackaging.actualUnits')}
              // Spread rather than `hint={… : undefined}`: under
              // `exactOptionalPropertyTypes` an explicit `undefined` is not the
              // same as an absent prop, and the design system's `Field` uses
              // the absence to decide whether to render a hint at all.
              {...(derived.unitsPerPackage === null
                ? {}
                : {
                    hint: t('sellerPackaging.overrideHint', {
                      derived: formatNumber(derived.unitsPerPackage),
                    }),
                  })}
            >
              {({ inputId, describedBy }) => (
                <Input
                    id={inputId}
                    aria-describedby={describedBy}
                  type="number"
                  min={1}
                  value={draft.unitsPerPackage}
                  onChange={(event) => {
                    setDraft((current) => ({ ...current, unitsPerPackage: event.target.value }));
                  }}
                />
              )}
            </Field>
          </div>
        )}

        {active?.unitsPerPackageIsOverride === true &&
          active.unitsPerPackageDerived !== null &&
          active.unitsPerPackage !== null &&
          active.unitsPerPackage !== active.unitsPerPackageDerived && (
            <p className="mt-2 text-xs font-medium text-warning">
              {t('sellerPackaging.savedOverride', {
                saved: formatNumber(active.unitsPerPackage),
                derived: formatNumber(active.unitsPerPackageDerived),
              })}
            </p>
          )}
      </div>

      {/* Presets. Labelled for what they are: a footprint, and guidance. */}
      {isPallet && footprint !== null && (
        <p className="mt-3 text-xs text-ink-muted">
          {t('sellerPackaging.footprintNote', { footprint: footprint.label })}
        </p>
      )}

      {isContainer && containerPreset !== null && (
        <p className="mt-3 rounded-lg bg-operational-soft p-3 text-xs text-operational">
          {t('sellerPackaging.containerGuidance', {
            label: containerPreset.label,
            volume:
              containerPreset.nominalVolumeCm3 === null
                ? '—'
                : formatNumber(Math.round(Number(containerPreset.nominalVolumeCm3) / 1_000_000)),
            payload:
              containerPreset.nominalMaxPayloadGrams === null
                ? '—'
                : formatNumber(Math.round(Number(containerPreset.nominalMaxPayloadGrams) / 1000)),
          })}
        </p>
      )}

      {/* --- Physical --- */}
      <h3 className="mt-6 text-sm font-semibold">{t('sellerPackaging.physical')}</h3>

      <div className="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-4">
        <Field label={t('sellerPackaging.dimensionUnit')}>
          {({ inputId, describedBy }) => (
            <Select
                id={inputId}
                aria-describedby={describedBy}
              value={draft.dimensionUnit}
              onChange={(event) => {
                setDraft((current) => ({
                  ...current,
                  dimensionUnit: event.target.value as Draft['dimensionUnit'],
                }));
              }}
            >
              <option value="MM">mm</option>
              <option value="CM">cm</option>
              <option value="M">m</option>
              <option value="IN">in</option>
            </Select>
          )}
        </Field>

        <Field label={t('sellerPackaging.length')}>
          {({ inputId, describedBy }) => (
            <Input
                id={inputId}
                aria-describedby={describedBy}
              type="number"
              min={0}
              step="0.001"
              value={draft.length}
              onChange={(event) => {
                setDraft((current) => ({ ...current, length: event.target.value }));
              }}
            />
          )}
        </Field>

        <Field label={t('sellerPackaging.width')}>
          {({ inputId, describedBy }) => (
            <Input
                id={inputId}
                aria-describedby={describedBy}
              type="number"
              min={0}
              step="0.001"
              value={draft.width}
              onChange={(event) => {
                setDraft((current) => ({ ...current, width: event.target.value }));
              }}
            />
          )}
        </Field>

        <Field label={t('sellerPackaging.height')}>
          {({ inputId, describedBy }) => (
            <Input
                id={inputId}
                aria-describedby={describedBy}
              type="number"
              min={0}
              step="0.001"
              value={draft.height}
              onChange={(event) => {
                setDraft((current) => ({ ...current, height: event.target.value }));
              }}
            />
          )}
        </Field>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-4">
        <Field label={t('sellerPackaging.weightUnit')}>
          {({ inputId, describedBy }) => (
            <Select
                id={inputId}
                aria-describedby={describedBy}
              value={draft.weightUnit}
              onChange={(event) => {
                setDraft((current) => ({
                  ...current,
                  weightUnit: event.target.value as Draft['weightUnit'],
                }));
              }}
            >
              <option value="G">g</option>
              <option value="KG">kg</option>
              <option value="LB">lb</option>
            </Select>
          )}
        </Field>

        <Field label={t('sellerPackaging.netWeight')}>
          {({ inputId, describedBy }) => (
            <Input
                id={inputId}
                aria-describedby={describedBy}
              type="number"
              min={0}
              step="0.001"
              value={draft.netWeight}
              onChange={(event) => {
                setDraft((current) => ({ ...current, netWeight: event.target.value }));
              }}
            />
          )}
        </Field>

        <Field label={t('sellerPackaging.grossWeight')}>
          {({ inputId, describedBy }) => (
            <Input
                id={inputId}
                aria-describedby={describedBy}
              type="number"
              min={0}
              step="0.001"
              value={draft.grossWeight}
              onChange={(event) => {
                setDraft((current) => ({ ...current, grossWeight: event.target.value }));
              }}
            />
          )}
        </Field>

        <Field
          label={t('sellerPackaging.maxGrossWeight')}
          hint={t('sellerPackaging.maxGrossWeightHint')}
        >
          {({ inputId, describedBy }) => (
            <Input
                id={inputId}
                aria-describedby={describedBy}
              type="number"
              min={0}
              step="0.001"
              value={draft.maxGrossWeight}
              onChange={(event) => {
                setDraft((current) => ({ ...current, maxGrossWeight: event.target.value }));
              }}
            />
          )}
        </Field>
      </div>

      {isPallet && (
        <div className="mt-4 flex flex-wrap items-end gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.isStackable}
              onChange={(event) => {
                setDraft((current) => ({ ...current, isStackable: event.target.checked }));
              }}
            />
            {t('sellerPackaging.stackable')}
          </label>

          {draft.isStackable && (
            <div className="max-w-[10rem]">
              <Field label={t('sellerPackaging.maxStack')}>
                {({ inputId, describedBy }) => (
                  <Input
                      id={inputId}
                      aria-describedby={describedBy}
                    type="number"
                    min={2}
                    value={draft.maxStackCount}
                    onChange={(event) => {
                      setDraft((current) => ({ ...current, maxStackCount: event.target.value }));
                    }}
                  />
                )}
              </Field>
            </div>
          )}
        </div>
      )}

      {/* --- Terms of trade --- */}
      <h3 className="mt-6 text-sm font-semibold">{t('sellerPackaging.terms')}</h3>

      <div className="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label={t('sellerPackaging.minimumPackages')}>
          {({ inputId, describedBy }) => (
            <Input
                id={inputId}
                aria-describedby={describedBy}
              type="number"
              min={1}
              value={draft.minimumPackages}
              onChange={(event) => {
                setDraft((current) => ({ ...current, minimumPackages: event.target.value }));
              }}
            />
          )}
        </Field>

        <Field label={t('sellerPackaging.increment')}>
          {({ inputId, describedBy }) => (
            <Input
                id={inputId}
                aria-describedby={describedBy}
              type="number"
              min={1}
              value={draft.packageIncrement}
              onChange={(event) => {
                setDraft((current) => ({ ...current, packageIncrement: event.target.value }));
              }}
            />
          )}
        </Field>

        <Field label={t('sellerPackaging.maximumPackages')}>
          {({ inputId, describedBy }) => (
            <Input
                id={inputId}
                aria-describedby={describedBy}
              type="number"
              min={1}
              value={draft.maximumPackages}
              onChange={(event) => {
                setDraft((current) => ({ ...current, maximumPackages: event.target.value }));
              }}
            />
          )}
        </Field>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t('sellerPackaging.priceMode')} hint={t('sellerPackaging.priceModeHint')}>
          {({ inputId, describedBy }) => (
            <Select
                id={inputId}
                aria-describedby={describedBy}
              value={draft.priceMode}
              onChange={(event) => {
                setDraft((current) => ({
                  ...current,
                  priceMode: event.target.value as PackagingPriceMode,
                }));
              }}
            >
              <option value="DERIVED_FROM_UNIT">{t('sellerPackaging.priceDerived')}</option>
              <option value="PER_PACKAGE">{t('sellerPackaging.pricePerPackage')}</option>
              <option value="FREIGHT_QUOTE">{t('sellerPackaging.priceOnQuote')}</option>
            </Select>
          )}
        </Field>

        {draft.priceMode === 'PER_PACKAGE' && (
          <Field
            label={t('sellerPackaging.packagePrice', { currency })}
            // The divisibility rule, stated where a seller meets it. It is the
            // one rule here most likely to look like fussiness, so the hint
            // says what it buys: an exact price per unit.
            {...(derived.unitsPerPackage === null
              ? {}
              : {
                  hint: t('sellerPackaging.divisibleHint', {
                    units: formatNumber(derived.unitsPerPackage),
                  }),
                })}
          >
            {({ inputId, describedBy }) => (
              <Input
                  id={inputId}
                  aria-describedby={describedBy}
                inputMode="decimal"
                value={draft.pricePerPackageMajor}
                onChange={(event) => {
                  setDraft((current) => ({
                    ...current,
                    pricePerPackageMajor: event.target.value,
                  }));
                }}
              />
            )}
          </Field>
        )}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t('sellerPackaging.handlingDays')}>
          {({ inputId, describedBy }) => (
            <Input
                id={inputId}
                aria-describedby={describedBy}
              type="number"
              min={0}
              value={draft.handlingLeadTimeDays}
              onChange={(event) => {
                setDraft((current) => ({ ...current, handlingLeadTimeDays: event.target.value }));
              }}
            />
          )}
        </Field>

        {isContainer && (
          <Field label={t('sellerPackaging.productionDays')}>
            {({ inputId, describedBy }) => (
              <Input
                  id={inputId}
                  aria-describedby={describedBy}
                type="number"
                min={0}
                value={draft.productionLeadTimeDays}
                onChange={(event) => {
                  setDraft((current) => ({
                    ...current,
                    productionLeadTimeDays: event.target.value,
                  }));
                }}
              />
            )}
          </Field>
        )}
      </div>

      {/* --- Bands --- */}
      <h3 className="mt-6 text-sm font-semibold">{t('sellerPackaging.tiers')}</h3>
      <p className="text-xs text-ink-muted">{t('sellerPackaging.tiersHint')}</p>

      {draft.tiers.map((tier, index) => (
        <div key={index} className="mt-3 flex flex-wrap items-end gap-3">
          <div className="max-w-[9rem]">
            <Field label={t('sellerPackaging.tierFrom')}>
              {({ inputId, describedBy }) => (
                <Input
                    id={inputId}
                    aria-describedby={describedBy}
                  type="number"
                  min={1}
                  value={tier.minPackages}
                  onChange={(event) => {
                    const next = event.target.value;
                    setDraft((current) => ({
                      ...current,
                      tiers: current.tiers.map((entry, position) =>
                        position === index ? { ...entry, minPackages: next } : entry,
                      ),
                    }));
                  }}
                />
              )}
            </Field>
          </div>

          <div className="max-w-[12rem]">
            <Field label={t('sellerPackaging.tierPrice', { currency })}>
              {({ inputId, describedBy }) => (
                <Input
                    id={inputId}
                    aria-describedby={describedBy}
                  inputMode="decimal"
                  value={tier.priceMajor}
                  onChange={(event) => {
                    const next = event.target.value;
                    setDraft((current) => ({
                      ...current,
                      tiers: current.tiers.map((entry, position) =>
                        position === index ? { ...entry, priceMajor: next } : entry,
                      ),
                    }));
                  }}
                />
              )}
            </Field>
          </div>

          <Button
            size="sm"
            onClick={() => {
              setDraft((current) => ({
                ...current,
                tiers: current.tiers.filter((_, position) => position !== index),
              }));
            }}
          >
            {t('common.remove')}
          </Button>
        </div>
      ))}

      <Button
        size="sm"
        className="mt-3"
        onClick={() => {
          setDraft((current) => ({
            ...current,
            tiers: [...current.tiers, { minPackages: '', priceMajor: '' }],
          }));
        }}
      >
        {t('sellerPackaging.addTier')}
      </Button>

      {/* --- Handling notes --- */}
      <div className="mt-6 grid grid-cols-1 gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.isHazardous}
            onChange={(event) => {
              setDraft((current) => ({ ...current, isHazardous: event.target.checked }));
            }}
          />
          {t('sellerPackaging.hazardous')}
        </label>

        <Field label={t('sellerPackaging.temperatureNotes')}>
          {({ inputId, describedBy }) => (
            <Input
                id={inputId}
                aria-describedby={describedBy}
              value={draft.temperatureNotes}
              onChange={(event) => {
                setDraft((current) => ({ ...current, temperatureNotes: event.target.value }));
              }}
            />
          )}
        </Field>

        <Field label={t('sellerPackaging.handlingNotes')}>
          {({ inputId, describedBy }) => (
            <Input
                id={inputId}
                aria-describedby={describedBy}
              value={draft.specialHandlingNotes}
              onChange={(event) => {
                setDraft((current) => ({ ...current, specialHandlingNotes: event.target.value }));
              }}
            />
          )}
        </Field>
      </div>

      {saveError !== null && (
        <p role="alert" className="mt-4 text-sm font-medium text-danger">
          {saveError}
        </p>
      )}

      {/* What a buyer would pay for one, so the seller can sanity-check the
          figure before it is on sale. Uses the saved option, not the draft:
          previewing unsaved numbers would show a price nobody can buy. */}
      {active?.state === 'ACTIVE' && active.unitsPerPackage !== null && (
        <p className="mt-4 text-sm">
          {t('sellerPackaging.buyerSees', {
            price: formatMoneyMinor(
              active.pricePerPackageMinor ?? '0',
              active.currency ?? currency,
            ),
            units: formatNumber(active.unitsPerPackage),
          })}
        </p>
      )}

      <Button
        variant="primary"
        className="mt-5"
        isLoading={save.isPending}
        onClick={() => {
          save.mutate();
        }}
      >
        {t('common.save')}
      </Button>
    </Card>
  );
}

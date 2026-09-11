/**
 * Adding and correcting a warehouse.
 *
 * Three things this form does deliberately.
 *
 * **Coordinates are optional and stay optional.** A warehouse with no position
 * is an ordinary warehouse - it holds stock, it appears in every picker, it
 * just is not on the map yet. Making the map's data a requirement of recording
 * a building would mean somebody guessing a latitude to get past a form.
 *
 * **The address and the coordinates are separate fields, not one derived from
 * the other.** The address is what goes on paperwork and what a driver reads;
 * the coordinates are what the map draws. A geocoder is offered as a button
 * between them, and it fills the coordinates in for review rather than
 * silently on save - a geocoder that finds the wrong town should be caught by
 * the person who knows, not discovered later as a marker in the sea.
 *
 * **Retiring is not in here.** It is an action with consequences the server
 * explains - stock still held, the default cannot go - and those belong on a
 * confirmation the reader has to answer, not on a checkbox that submits with
 * everything else. See `WarehousesPage`.
 *
 * **The geofence is in here, and the two halves of it are kept apart.** The
 * radius says how far this warehouse *can* reach, measured against real
 * country boundaries. The closed-country list says where it *will not* go,
 * whatever the radius reaches. They are separate fields because they are
 * separate decisions: raising a radius next year must not quietly re-open a
 * country somebody deliberately shut, and the form says so rather than leaving
 * it to be discovered.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Modal } from '@/components/Modal';
import {
  Button,
  Callout,
  CheckboxField,
  Field,
  FieldGroup,
  Input,
  Select,
  Spinner,
} from '@/components/ui';
import { CountryFlag } from '@/components/CountryFlag';
import { ApiError, api } from '@/lib/api';
import { nullIfBlank } from '@/lib/forms';
import { majorToMinor } from '@/lib/format';
import { translateKey, useI18n } from '@/i18n/i18n-context';
import { OPERATIONAL_STATUSES, operationalLabelKey } from '@/lib/warehouses';
import type {
  CountriesResponse,
  GeocodeResponse,
  OperationalStatus,
  Warehouse,
  WorldCountriesResponse,
} from '@/lib/warehouses';

/** One country closed on this warehouse, as the form holds it. */
interface ExclusionDraft {
  code: string;
  reason: string;
}

interface CurrencyRow {
  code: string;
  name: string;
  symbol: string;
  exponent: number;
  isBase: boolean;
}

interface Draft {
  code: string;
  name: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  countryCode: string;
  timezone: string;
  latitude: string;
  longitude: string;
  operationalStatus: OperationalStatus;
  erpExternalId: string;
  isDefault: boolean;

  /**
   * The geofence, as text.
   *
   * Every one of these is a string in the draft even though four of them are
   * numbers on the wire, and that is the same rule the coordinates above
   * follow: an empty box and a zero are different instructions, and a
   * `number | null` field cannot hold "somebody is halfway through typing".
   * They are parsed once, on submit.
   */
  deliveryRadiusKm: string;
  leadTimeMinDays: string;
  leadTimeMaxDays: string;
  /** Major units, as typed - "12.50". Shifted to minor on submit. */
  deliveryFeeMajor: string;
  deliveryFeeCurrency: string;
  excludedCountries: ExclusionDraft[];
}

function emptyDraft(): Draft {
  return {
    code: '',
    name: '',
    line1: '',
    line2: '',
    city: '',
    region: '',
    postalCode: '',
    countryCode: '',
    timezone: '',
    latitude: '',
    longitude: '',
    // A warehouse being recorded is a warehouse somebody expects to use.
    operationalStatus: 'OPERATIONAL',
    erpExternalId: '',
    isDefault: false,
    // Empty, so a new warehouse starts on the deployment's default radius
    // rather than on a number this form invented. The hint beside the field
    // says what that default is.
    deliveryRadiusKm: '',
    leadTimeMinDays: '',
    leadTimeMaxDays: '',
    deliveryFeeMajor: '',
    deliveryFeeCurrency: '',
    excludedCountries: [],
  };
}

/**
 * The time zones offered, newest-country-first is not a thing - so: the zones
 * this browser knows, or a short fallback.
 *
 * `Intl.supportedValuesOf` is the honest source: it is the same ICU database
 * the server validates against and the same one that will format the clock in
 * the detail panel, so anything it lists will work end to end. It is a free
 * text field as well as a list, because a deployment on an older runtime
 * should not be blocked from typing a zone the picker cannot enumerate.
 */
function timezoneOptions(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
}

function draftFrom(warehouse: Warehouse): Draft {
  const address = warehouse.address ?? {};
  const delivery = warehouse.delivery;

  return {
    code: warehouse.code,
    name: warehouse.name,
    line1: address.line1 ?? '',
    line2: address.line2 ?? '',
    city: address.city ?? '',
    region: address.region ?? '',
    postalCode: address.postalCode ?? '',
    countryCode: warehouse.countryCode ?? '',
    timezone: warehouse.timezone ?? '',
    // The full stored precision, not the four places the table shows. Editing
    // a warehouse must not quietly round it.
    latitude: warehouse.latitude === null ? '' : String(warehouse.latitude),
    longitude: warehouse.longitude === null ? '' : String(warehouse.longitude),
    operationalStatus: warehouse.operationalStatus,
    erpExternalId: warehouse.erp.externalId ?? '',
    isDefault: warehouse.isDefault,

    /*
     * Empty when the warehouse has no radius of its own.
     *
     * `delivery.radiusKm` is never null - the server resolves the fallback
     * for every reader - so the *number* here would put the deployment's
     * default into the box, and saving would turn a warehouse that follows
     * the default into one that has been pinned to today's value of it.
     * `radiusIsDefault` is the flag that tells the two apart, which is
     * exactly what it exists for.
     */
    deliveryRadiusKm: delivery.radiusIsDefault ? '' : String(delivery.radiusKm),
    leadTimeMinDays: delivery.leadTimeDays === null ? '' : String(delivery.leadTimeDays.min),
    leadTimeMaxDays: delivery.leadTimeDays === null ? '' : String(delivery.leadTimeDays.max),
    /*
     * The server's own rendering, not a conversion done here.
     *
     * `formatted` is the major-unit string the server produced from the minor
     * units *knowing the currency's exponent* - "12.50" for 1250 EUR, "1250"
     * for 1250 JPY - so reading the fee back into the box needs no exponent in
     * this file at all, and cannot get it wrong for the two zero-decimal
     * currencies this deployment carries. Writing it back does need the
     * exponent, which is why `submit` waits for the currency list.
     */
    deliveryFeeMajor: delivery.fee?.formatted ?? '',
    deliveryFeeCurrency: delivery.fee?.currency ?? '',
    excludedCountries: delivery.excludedCountries.map((country) => ({
      code: country.code,
      reason: country.reason ?? '',
    })),
  };
}

/**
 * A typed coordinate, or null for "left empty", or `NaN` for "not a number".
 *
 * The three cases are distinct on purpose: empty means unplace, and a typo
 * has to be caught here rather than sent as `null` and stored as unplaced.
 */
function parseCoordinate(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return Number(trimmed);
}

/**
 * A typed whole number, or null for "left empty".
 *
 * Deliberately returns `NaN` for a typo rather than null, the same way
 * `parseCoordinate` does: null is an instruction to the server ("clear this"),
 * and letting "12a" arrive as null would silently wipe a warehouse's radius
 * instead of telling the person what they typed. `localProblem` is what turns
 * the `NaN` into a message.
 */
function parseWholeNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

interface WarehouseFormDialogProps {
  /** The warehouse being corrected, or null when one is being created. */
  editing: Warehouse | null;
  /**
   * `DELIVERY_COVERAGE_RADIUS_KM`, for the hint under the radius field.
   *
   * Passed in rather than defaulted here, and that is the same rule the rest
   * of this screen follows: how far the business delivers belongs to whoever
   * runs the installation, and a number this bundle invented would tell an
   * operator their empty radius box means 500 km when it means whatever they
   * configured. The page already has it from the warehouses response.
   */
  defaultRadiusKm: number;
  onClose: () => void;
  onSaved: (warehouse: Warehouse, wasCreated: boolean) => void;
}

export function WarehouseFormDialog({
  editing,
  defaultRadiusKm,
  onClose,
  onSaved,
}: WarehouseFormDialogProps): React.JSX.Element {
  const { t } = useI18n();

  const [draft, setDraft] = useState<Draft>(() =>
    editing === null ? emptyDraft() : draftFrom(editing),
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [lookupNote, setLookupNote] = useState<string | null>(null);
  /** What is typed into the closed-country search. Not part of the draft. */
  const [exclusionSearch, setExclusionSearch] = useState('');

  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  /**
   * The countries a warehouse may be in.
   *
   * Read from the API, not shipped as a list in this bundle: `countries` is
   * the table that already decides a country's currency, its interface
   * language and whether it is in the EU VAT area, and a second list in the
   * browser is a second list to get wrong. It is also what the server
   * validates the submitted code against, so the two cannot disagree.
   */
  const countries = useQuery({
    queryKey: ['warehouse-countries'],
    queryFn: () => api.get<CountriesResponse>('/admin/inventory/warehouse-countries'),
    // Reference data. It does not change while somebody is filling in a form.
    staleTime: 10 * 60 * 1000,
  });

  /**
   * Every country there is, for the closed-country picker.
   *
   * A different list from `countries` above, and that is the point of having
   * two endpoints. That one is the countries this deployment *prices in* - the
   * right list for "where is this building". This is the ISO 3166-1 list,
   * because a 500 km circle reaches countries nobody has ever sold into and
   * those are exactly the ones an operator most wants to close.
   *
   * A day's cache: it is a list of countries, not of anything this deployment
   * owns, and the server sends the same header.
   */
  const worldCountries = useQuery({
    queryKey: ['world-countries'],
    queryFn: () => api.get<WorldCountriesResponse>('/admin/inventory/world-countries'),
    staleTime: 24 * 60 * 60 * 1000,
  });

  /**
   * The currencies, for the delivery fee.
   *
   * From the public config, which is the same list the storefront prices in -
   * so a fee cannot be quoted in a currency the shop cannot render. The
   * *exponent* is the field that matters here: it is what turns "12.50" into
   * 1250, and it is 0 rather than 2 for yen and won.
   */
  const config = useQuery({
    queryKey: ['storefront-config'],
    queryFn: () =>
      api.get<{ localisation: { currencies: CurrencyRow[]; baseCurrency: string } }>('/config'),
    staleTime: 10 * 60 * 1000,
  });

  const currencies = useMemo(() => config.data?.localisation.currencies ?? [], [config.data]);

  /**
   * How many decimal places this currency has.
   *
   * Null rather than a fallback of 2, deliberately. A wrong exponent
   * mis-scales money by a factor of a hundred, and "we have not been told yet"
   * has to be distinguishable from "two" - so the submit path refuses to shift
   * an amount it cannot shift correctly rather than guessing at it. See
   * `localProblem`.
   */
  const exponentFor = (code: string): number | null =>
    currencies.find((entry) => entry.code === code)?.exponent ?? null;

  const zones = timezoneOptions();

  /** The codes already closed, for the picker to grey out. */
  const closedCodes = new Set(draft.excludedCountries.map((entry) => entry.code));

  const closeCountry = (code: string): void => {
    setDraft((current) =>
      current.excludedCountries.some((entry) => entry.code === code)
        ? current
        : {
            ...current,
            excludedCountries: [...current.excludedCountries, { code, reason: '' }],
          },
    );
    // The search box is cleared so the next country can be found by typing
    // rather than by deleting somebody else's name first.
    setExclusionSearch('');
  };

  const reopenCountry = (code: string): void => {
    setDraft((current) => ({
      ...current,
      excludedCountries: current.excludedCountries.filter((entry) => entry.code !== code),
    }));
  };

  const setExclusionReason = (code: string, reason: string): void => {
    setDraft((current) => ({
      ...current,
      excludedCountries: current.excludedCountries.map((entry) =>
        entry.code === code ? { ...entry, reason } : entry,
      ),
    }));
  };

  /**
   * The picker's suggestions.
   *
   * Only offered once something has been typed, and capped at eight. A list of
   * 250 countries under a text box is a scroll container that hides the rest
   * of the form; eight is enough that the country somebody means is in it
   * after two or three letters.
   */
  const exclusionMatches = ((): { code: string; name: string }[] => {
    const term = exclusionSearch.trim().toLowerCase();
    if (term.length === 0) return [];

    return (worldCountries.data?.countries ?? [])
      .filter(
        (country) =>
          !closedCodes.has(country.code) &&
          (country.name.toLowerCase().includes(term) || country.code.toLowerCase() === term),
      )
      .slice(0, 8);
  })();

  /** A closed country's name, for the chip. Its code until the list arrives. */
  const nameOf = (code: string): string =>
    worldCountries.data?.countries.find((country) => country.code === code)?.name ?? code;

  /**
   * The typed fee in minor units, or null when it cannot be shifted exactly.
   *
   * Null covers three different situations that all mean the same thing to the
   * caller - do not send this: the box is empty, what is in it is not an
   * amount, or the currency's exponent is not known yet. `localProblem` tells
   * the first apart from the other two, because an empty box is not an error.
   */
  const feeMinor = (): string | null => {
    const typed = draft.deliveryFeeMajor.trim();
    if (typed === '') return null;

    const exponent = exponentFor(draft.deliveryFeeCurrency.trim());
    if (exponent === null) return null;

    return majorToMinor(typed, exponent);
  };

  const addressQuery = (): string =>
    [draft.line1, draft.line2, draft.city, draft.region, draft.postalCode, draft.countryCode]
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .join(', ');

  /**
   * Ask the server to turn the address into coordinates.
   *
   * A miss is not an error: the endpoint answers 200 with no result when the
   * geocoder is switched off, unreachable or simply does not know the place,
   * and all three mean the same thing to the person standing here - type them
   * yourself. Only a genuine transport failure reaches `onError`.
   */
  const lookup = useMutation({
    mutationFn: () =>
      api.post<GeocodeResponse>('/admin/inventory/warehouses/geocode', {
        query: addressQuery(),
      }),
    onSuccess: (response) => {
      if (response.result === null) {
        setLookupNote(t('warehouses.form.lookupNothing'));
        return;
      }

      set('latitude', String(response.result.latitude));
      set('longitude', String(response.result.longitude));
      // Says what it matched, because "18.5204, 73.8567" is unverifiable and
      // "Shivajinagar, Pune, Maharashtra" is somebody's yes or no.
      setLookupNote(
        response.result.label === null
          ? t('warehouses.form.lookupFound')
          : t('warehouses.form.lookupFoundLabel', { place: response.result.label }),
      );
    },
    onError: () => {
      setLookupNote(t('warehouses.form.lookupFailed'));
    },
  });

  const save = useMutation({
    mutationFn: (): Promise<{ warehouse: Warehouse }> => {
      const latitude = parseCoordinate(draft.latitude);
      const longitude = parseCoordinate(draft.longitude);

      const body = {
        code: draft.code.trim(),
        name: draft.name.trim(),
        address: {
          line1: nullIfBlank(draft.line1),
          line2: nullIfBlank(draft.line2),
          city: nullIfBlank(draft.city),
          region: nullIfBlank(draft.region),
          postalCode: nullIfBlank(draft.postalCode),
        },
        // A field on the warehouse, not part of the address JSON: the console
        // filters and searches on it, and the server checks it against the
        // reference table.
        countryCode: nullIfBlank(draft.countryCode),
        timezone: nullIfBlank(draft.timezone),
        latitude,
        longitude,
        operationalStatus: draft.operationalStatus,
        erpExternalId: nullIfBlank(draft.erpExternalId),
        isDefault: draft.isDefault,

        /*
         * The geofence. Every field is `null` when its box is empty, never
         * omitted, and the difference matters on a PATCH: the server treats
         * absent as "leave it alone" and null as "clear it". A form that
         * omitted an emptied box could never take a radius back off a
         * warehouse.
         */
        deliveryRadiusKm: parseWholeNumber(draft.deliveryRadiusKm),
        deliveryLeadTimeMinDays: parseWholeNumber(draft.leadTimeMinDays),
        deliveryLeadTimeMaxDays: parseWholeNumber(draft.leadTimeMaxDays),
        // `localProblem` has already refused a fee that cannot be shifted
        // exactly, so `feeMinor()` cannot be null by the time this runs.
        deliveryFeeMinor: feeMinor(),
        deliveryFeeCurrency: draft.deliveryFeeMajor.trim() === ''
          ? null
          : nullIfBlank(draft.deliveryFeeCurrency),
        // The whole list, so removing one closes the difference on the server
        // in the same write. A blank reason is sent as null rather than as an
        // empty string.
        excludedCountries: draft.excludedCountries.map((entry) => ({
          code: entry.code,
          reason: nullIfBlank(entry.reason),
        })),
      };

      return editing === null
        ? api.post<{ warehouse: Warehouse }>('/admin/inventory/warehouses', body)
        : api.patch<{ warehouse: Warehouse }>(
            `/admin/inventory/warehouses/${editing.id}`,
            body,
          );
    },
    onSuccess: (response) => {
      onSaved(response.warehouse, editing === null);
    },
    onError: (error) => {
      setFormError(error instanceof ApiError ? error.message : t('warehouses.couldNotSave'));
    },
  });

  /**
   * What is wrong with the form, before the server is asked.
   *
   * Only the checks that can be made here honestly. Everything else - a code
   * another warehouse holds, the default that cannot be demoted - is the
   * server's to answer, and guessing at those in the browser is how the two
   * drift apart.
   */
  const localProblem = ((): string | null => {
    if (draft.code.trim().length === 0) return t('warehouses.form.codeRequired');
    if (draft.name.trim().length === 0) return t('warehouses.form.nameRequired');
    if (draft.countryCode.trim().length === 0) return t('warehouses.form.countryRequired');

    const latitude = parseCoordinate(draft.latitude);
    const longitude = parseCoordinate(draft.longitude);

    if ((latitude === null) !== (longitude === null)) {
      return t('warehouses.form.coordinatesPaired');
    }

    if (latitude !== null && (!Number.isFinite(latitude) || latitude < -90 || latitude > 90)) {
      return t('warehouses.form.latitudeRange');
    }

    if (longitude !== null && (!Number.isFinite(longitude) || longitude < -180 || longitude > 180)) {
      return t('warehouses.form.longitudeRange');
    }

    // --- The geofence -----------------------------------------------------

    const radius = parseWholeNumber(draft.deliveryRadiusKm);
    if (radius !== null && (!Number.isFinite(radius) || radius < 1 || radius > 2000)) {
      return t('warehouses.form.deliveryRadiusRange');
    }

    const leadMin = parseWholeNumber(draft.leadTimeMinDays);
    const leadMax = parseWholeNumber(draft.leadTimeMaxDays);

    // Both or neither: half a range is a promise with no end.
    if ((leadMin === null) !== (leadMax === null)) {
      return t('warehouses.form.leadTimePaired');
    }

    for (const value of [leadMin, leadMax]) {
      if (value !== null && (!Number.isFinite(value) || value < 0 || value > 365)) {
        return t('warehouses.form.leadTimeRange');
      }
    }

    if (leadMin !== null && leadMax !== null && leadMin > leadMax) {
      return t('warehouses.form.leadTimeOrder');
    }

    if (draft.deliveryFeeMajor.trim() !== '') {
      if (draft.deliveryFeeCurrency.trim() === '') {
        return t('warehouses.form.deliveryFeeCurrencyRequired');
      }

      /*
       * A fee that cannot be shifted *exactly* is refused here.
       *
       * Two ways that happens, and neither may be guessed at. The typed
       * amount may not be a valid one - "12.5.0", "-3", "1,250" - and it may
       * carry more decimals than the currency has, which is the case a
       * rounding would silently swallow: 12.505 EUR is not an amount, and
       * accepting it as 1250 or 1251 is inventing a fee nobody typed.
       *
       * A null exponent means the currency list has not arrived yet. The
       * amount is not shifted on a guess of two - it would be wrong by a
       * factor of a hundred for yen - so the button waits instead.
       */
      if (feeMinor() === null) return t('warehouses.form.deliveryFeeInvalid');
    }

    return null;
  })();

  const problem = formError ?? localProblem;
  const canLookUp = addressQuery().length > 0;

  return (
    <Modal
      isOpen
      onClose={onClose}
      size="lg"
      title={editing === null ? t('warehouses.add') : t('warehouses.editTitle')}
      description={t('warehouses.form.hint')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            isLoading={save.isPending}
            // Disabled on a local problem rather than on any problem: a
            // server rejection has to stay submittable, or correcting the
            // field it named would leave the button dead.
            disabled={localProblem !== null}
            onClick={() => {
              setFormError(null);
              save.mutate();
            }}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {problem !== null && (
          <Callout tone="danger" role="alert">
            {problem}
          </Callout>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('warehouses.form.code')} hint={t('warehouses.form.codeHint')} required>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                className="font-mono"
                maxLength={32}
                placeholder="PUNE-2"
                aria-describedby={describedBy}
                value={draft.code}
                onChange={(event) => {
                  // Upper-cased as it is typed, because that is what the
                  // server stores and a field that changes its value on save
                  // looks like a bug.
                  set('code', event.target.value.toUpperCase());
                }}
              />
            )}
          </Field>

          <Field label={t('warehouses.form.name')} hint={t('warehouses.form.nameHint')} required>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                maxLength={128}
                aria-describedby={describedBy}
                value={draft.name}
                onChange={(event) => {
                  set('name', event.target.value);
                }}
              />
            )}
          </Field>

          {/* A picker, not two typed letters. The server checks the code
              against the reference table anyway, and a select is the only
              version of this field that cannot be got wrong. */}
          <Field
            label={t('warehouses.form.country')}
            hint={t('warehouses.form.countryHint')}
            required
          >
            {({ inputId, describedBy }) => (
              <Select
                id={inputId}
                aria-describedby={describedBy}
                value={draft.countryCode}
                onChange={(event) => {
                  set('countryCode', event.target.value);
                }}
              >
                <option value="">{t('warehouses.form.countryChoose')}</option>
                {(countries.data?.countries ?? []).map((country) => (
                  <option key={country.code} value={country.code}>
                    {country.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          {/* Free text with a datalist rather than a select: the zone list runs
              to hundreds and typing "brus" is faster than scrolling, while a
              browser whose ICU cannot enumerate them still lets somebody enter
              one by hand. */}
          <Field
            label={t('warehouses.form.timezone')}
            hint={t('warehouses.form.timezoneHint')}
          >
            {({ inputId, describedBy }) => (
              <>
                <Input
                  id={inputId}
                  list="warehouse-timezones"
                  maxLength={64}
                  placeholder="Europe/Brussels"
                  aria-describedby={describedBy}
                  value={draft.timezone}
                  onChange={(event) => {
                    set('timezone', event.target.value);
                  }}
                />
                <datalist id="warehouse-timezones">
                  {zones.map((zone) => (
                    <option key={zone} value={zone} />
                  ))}
                </datalist>
              </>
            )}
          </Field>

          <Field
            label={t('warehouses.form.operationalStatus')}
            hint={t('warehouses.form.operationalStatusHint')}
          >
            {({ inputId, describedBy }) => (
              <Select
                id={inputId}
                aria-describedby={describedBy}
                value={draft.operationalStatus}
                onChange={(event) => {
                  set('operationalStatus', event.target.value as OperationalStatus);
                }}
              >
                {OPERATIONAL_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {translateKey(t, operationalLabelKey(status))}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <FieldGroup legend={t('warehouses.form.addressLegend')} hint={t('warehouses.form.addressHint')}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t('warehouses.form.line1')}>
              {({ inputId }) => (
                <Input
                  id={inputId}
                  maxLength={160}
                  value={draft.line1}
                  onChange={(event) => {
                    set('line1', event.target.value);
                  }}
                />
              )}
            </Field>

            <Field label={t('warehouses.form.line2')}>
              {({ inputId }) => (
                <Input
                  id={inputId}
                  maxLength={160}
                  value={draft.line2}
                  onChange={(event) => {
                    set('line2', event.target.value);
                  }}
                />
              )}
            </Field>

            <Field label={t('warehouses.form.city')}>
              {({ inputId }) => (
                <Input
                  id={inputId}
                  maxLength={120}
                  value={draft.city}
                  onChange={(event) => {
                    set('city', event.target.value);
                  }}
                />
              )}
            </Field>

            <Field label={t('warehouses.form.region')}>
              {({ inputId }) => (
                <Input
                  id={inputId}
                  maxLength={120}
                  value={draft.region}
                  onChange={(event) => {
                    set('region', event.target.value);
                  }}
                />
              )}
            </Field>

            <Field label={t('warehouses.form.postalCode')}>
              {({ inputId }) => (
                <Input
                  id={inputId}
                  maxLength={32}
                  value={draft.postalCode}
                  onChange={(event) => {
                    set('postalCode', event.target.value);
                  }}
                />
              )}
            </Field>

          </div>
        </FieldGroup>

        <FieldGroup
          legend={t('warehouses.form.positionLegend')}
          hint={t('warehouses.form.positionHint')}
        >
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label={t('warehouses.form.latitude')}>
                {({ inputId }) => (
                  <Input
                    id={inputId}
                    className="font-mono"
                    inputMode="decimal"
                    placeholder="18.520438"
                    value={draft.latitude}
                    onChange={(event) => {
                      set('latitude', event.target.value);
                    }}
                  />
                )}
              </Field>

              <Field label={t('warehouses.form.longitude')}>
                {({ inputId }) => (
                  <Input
                    id={inputId}
                    className="font-mono"
                    inputMode="decimal"
                    placeholder="73.856743"
                    value={draft.longitude}
                    onChange={(event) => {
                      set('longitude', event.target.value);
                    }}
                  />
                )}
              </Field>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                size="sm"
                isLoading={lookup.isPending}
                disabled={!canLookUp}
                onClick={() => {
                  setLookupNote(null);
                  lookup.mutate();
                }}
              >
                {t('warehouses.form.lookUp')}
              </Button>

              {/* The hint that the button is dead, and why - a disabled
                  control with no explanation is a support ticket. */}
              {!canLookUp && (
                <p className="text-xs text-ink-muted">{t('warehouses.form.lookUpNeedsAddress')}</p>
              )}

              {lookupNote !== null && (
                <p role="status" className="text-xs text-ink-muted">
                  {lookupNote}
                </p>
              )}
            </div>
          </div>
        </FieldGroup>

        {/* The geofence. Read as one thing by an operator - "500 km, two to
            four days, twelve euro" - so the three sit together, with the
            closed-country list under them because it is the exception to what
            they promise. */}
        <FieldGroup
          legend={t('warehouses.form.deliveryLegend')}
          hint={t('warehouses.form.deliveryHint')}
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field
              label={t('warehouses.form.deliveryRadiusKm')}
              hint={t('warehouses.form.deliveryRadiusHint', { km: defaultRadiusKm })}
            >
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={2000}
                  // Not `placeholder={defaultRadiusKm}`: a greyed-out 500 in an
                  // empty box reads as a value that is already set, which is
                  // the one thing this field must not say. The hint carries
                  // the default in words instead.
                  placeholder=""
                  value={draft.deliveryRadiusKm}
                  onChange={(event) => {
                    set('deliveryRadiusKm', event.target.value);
                  }}
                />
              )}
            </Field>

            <Field label={t('warehouses.form.leadTimeMin')}>
              {({ inputId }) => (
                <Input
                  id={inputId}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={365}
                  value={draft.leadTimeMinDays}
                  onChange={(event) => {
                    set('leadTimeMinDays', event.target.value);
                  }}
                />
              )}
            </Field>

            <Field
              label={t('warehouses.form.leadTimeMax')}
              hint={t('warehouses.form.leadTimeHint')}
            >
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={365}
                  value={draft.leadTimeMaxDays}
                  onChange={(event) => {
                    set('leadTimeMaxDays', event.target.value);
                  }}
                />
              )}
            </Field>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <Field
                label={t('warehouses.form.deliveryFee')}
                hint={t('warehouses.form.deliveryFeeHint')}
              >
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    aria-describedby={describedBy}
                    // Text, not `type="number"`: money is typed with a decimal
                    // point and a number input's own rounding and locale
                    // handling are exactly what a money field must not have.
                    // `majorToMinor` is the only thing that parses it.
                    inputMode="decimal"
                    placeholder="12.50"
                    value={draft.deliveryFeeMajor}
                    onChange={(event) => {
                      set('deliveryFeeMajor', event.target.value);
                    }}
                  />
                )}
              </Field>
            </div>

            <Field label={t('warehouses.form.deliveryFeeCurrency')}>
              {({ inputId }) => (
                <Select
                  id={inputId}
                  value={draft.deliveryFeeCurrency}
                  onChange={(event) => {
                    set('deliveryFeeCurrency', event.target.value);
                  }}
                >
                  <option value="">{t('warehouses.form.currencyChoose')}</option>
                  {currencies.map((currency) => (
                    <option key={currency.code} value={currency.code}>
                      {currency.code}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        </FieldGroup>

        <FieldGroup
          legend={t('warehouses.form.excludedLegend')}
          hint={t('warehouses.form.excludedHint')}
        >
          <Field
            label={t('warehouses.form.excludedSearch')}
            // Spread rather than `hint={cond ? x : undefined}`: `hint` is
            // `?: string` and this project runs
            // `exactOptionalPropertyTypes`, under which a key present with the
            // value `undefined` is not the same as an absent key.
            {...(exclusionSearch.trim().length > 0 && exclusionMatches.length === 0
              ? { hint: t('warehouses.form.excludedNoMatch') }
              : {})}
          >
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                type="search"
                placeholder={t('warehouses.form.excludedSearchPlaceholder')}
                value={exclusionSearch}
                onChange={(event) => {
                  setExclusionSearch(event.target.value);
                }}
              />
            )}
          </Field>

          {worldCountries.isPending && (
            <p className="mt-2 flex items-center gap-2 text-xs text-ink-muted">
              <Spinner className="h-3 w-3" />
              {t('warehouses.form.excludedLoading')}
            </p>
          )}

          {/* Suggestions only once something has been typed. See
              `exclusionMatches` for why this is not a 250-row list. */}
          {exclusionMatches.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {exclusionMatches.map((country) => (
                <li key={country.code}>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      closeCountry(country.code);
                    }}
                  >
                    <CountryFlag code={country.code} className="mr-1.5 h-3 w-4" />
                    {country.name}
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {draft.excludedCountries.length === 0 ? (
            <p className="mt-3 text-xs text-ink-subtle">{t('warehouses.form.excludedNone')}</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {draft.excludedCountries.map((entry) => (
                <li
                  key={entry.code}
                  className="rounded-md border border-danger/25 bg-danger-soft px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <CountryFlag code={entry.code} className="h-3 w-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
                      {nameOf(entry.code)}
                    </span>
                    <span className="font-mono text-xxs text-ink-subtle">{entry.code}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      // The country's name is in the label, not just "Remove":
                      // a row of eight identical buttons is unusable with a
                      // screen reader.
                      aria-label={t('warehouses.form.excludedRemove', {
                        name: nameOf(entry.code),
                      })}
                      onClick={() => {
                        reopenCountry(entry.code);
                      }}
                    >
                      ×
                    </Button>
                  </div>

                  <Input
                    className="mt-1.5"
                    maxLength={256}
                    aria-label={t('warehouses.form.excludedReason')}
                    placeholder={t('warehouses.form.excludedReasonPlaceholder')}
                    value={entry.reason}
                    onChange={(event) => {
                      setExclusionReason(entry.code, event.target.value);
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
        </FieldGroup>

        <FieldGroup legend={t('warehouses.form.erpLegend')} hint={t('warehouses.form.erpHint')}>
          <Field label={t('warehouses.form.erpExternalId')}>
            {({ inputId }) => (
              <Input
                id={inputId}
                className="font-mono"
                maxLength={64}
                placeholder="WH-ANR-01"
                value={draft.erpExternalId}
                onChange={(event) => {
                  set('erpExternalId', event.target.value);
                }}
              />
            )}
          </Field>
        </FieldGroup>

        {/* Offered on both create and edit, and it is the one field here with
            a side effect on another row: promoting this warehouse demotes
            whichever held it. The hint says so rather than leaving somebody to
            discover it on the list afterwards. */}
        <CheckboxField
          label={t('warehouses.form.isDefault')}
          description={
            editing?.isDefault === true
              ? t('warehouses.form.isDefaultAlready')
              : t('warehouses.form.isDefaultHint')
          }
          // The default cannot be demoted from here - the server refuses it,
          // and the way to change it is to promote another warehouse.
          disabled={editing?.isDefault === true}
          checked={draft.isDefault}
          onChange={(event) => {
            set('isDefault', event.target.checked);
          }}
        />
      </div>
    </Modal>
  );
}

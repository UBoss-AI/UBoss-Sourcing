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
 */
import { useState } from 'react';
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
} from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { nullIfBlank } from '@/lib/forms';
import { translateKey, useI18n } from '@/i18n/i18n-context';
import { OPERATIONAL_STATUSES, operationalLabelKey } from '@/lib/warehouses';
import type {
  CountriesResponse,
  GeocodeResponse,
  OperationalStatus,
  Warehouse,
} from '@/lib/warehouses';

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

interface WarehouseFormDialogProps {
  /** The warehouse being corrected, or null when one is being created. */
  editing: Warehouse | null;
  onClose: () => void;
  onSaved: (warehouse: Warehouse, wasCreated: boolean) => void;
}

export function WarehouseFormDialog({
  editing,
  onClose,
  onSaved,
}: WarehouseFormDialogProps): React.JSX.Element {
  const { t } = useI18n();

  const [draft, setDraft] = useState<Draft>(() =>
    editing === null ? emptyDraft() : draftFrom(editing),
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [lookupNote, setLookupNote] = useState<string | null>(null);

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

  const zones = timezoneOptions();

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

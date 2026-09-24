/**
 * Setting up a delivery operation the seller runs themselves.
 *
 * Four questions, in the order somebody actually answers them:
 *
 *   1. Where do the goods leave from, and when does the van call?
 *   2. Where does this operation deliver to, and where does it not?
 *   3. What is it allowed to carry?
 *   4. What does it charge?
 *
 * WHY THIS PANEL ONLY APPEARS FOR SOME METHODS
 *
 * Only a seller's OWN operation is configured here. DHL, FedEx and India Post
 * set their own coverage and their own prices, and so does a courier that
 * merely works for this seller — that company runs its own portal, and a
 * marketplace that let a client rewrite its service promises would be broken
 * in a way nobody notices until a parcel is refused at a depot. So the panel
 * renders for SELF_MANAGED methods and says nothing at all for the rest.
 *
 * THE ONE THING THIS SCREEN WILL NOT DO
 *
 * Approve a capability. A seller can ask to be allowed to carry reagents; the
 * marketplace decides, and until it has, the row says "waiting" rather than
 * anything greener. There is no control here that would set it, because there
 * is no route behind one: the approval is the whole difference between "our
 * vans have a fridge" and "somebody checked".
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, Field, Input, LoadingState, Select } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { Translate } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import {
  fetchCapabilities,
  fetchLocations,
  fetchPickupProfiles,
  fetchRateCards,
  fetchServiceAreas,
  publishRateCard,
  removeServiceArea,
  requestCapability,
  savePickupProfile,
  saveServiceArea,
  type Capability,
  type FulfilmentMethod,
  type ServiceAreaScope,
} from '@/lib/seller';

/** A labelled input. `Field` wires the label, hint and error for a screen reader. */
function TextField({
  label,
  hint,
  ...input
}: {
  label: string;
  hint?: string;
} & React.ComponentPropsWithoutRef<typeof Input>): React.JSX.Element {
  return (
    // `hint` is SPREAD rather than passed as `undefined`: this project runs
    // `exactOptionalPropertyTypes`, under which the two are different types.
    <Field label={label} {...(hint === undefined ? {} : { hint })}>
      {({ inputId, describedBy }) => <Input id={inputId} aria-describedby={describedBy} {...input} />}
    </Field>
  );
}

/**
 * Monday = 1. A bitmask rather than seven booleans because that is what the
 * column is, and converting in two places is how the two disagree.
 */
const DAY_BITS = [1, 2, 4, 8, 16, 32, 64];

function dayLabels(t: Translate): string[] {
  return [
    t('selfManaged.day.mon'),
    t('selfManaged.day.tue'),
    t('selfManaged.day.wed'),
    t('selfManaged.day.thu'),
    t('selfManaged.day.fri'),
    t('selfManaged.day.sat'),
    t('selfManaged.day.sun'),
  ];
}

function DayPicker({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (next: number) => void;
  disabled: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const labels = dayLabels(t);

  return (
    <div className="flex flex-wrap gap-1.5">
      {DAY_BITS.map((bit, index) => {
        const isOn = (value & bit) !== 0;

        return (
          <button
            key={bit}
            type="button"
            disabled={disabled}
            aria-pressed={isOn}
            onClick={() => {
              onChange(isOn ? value & ~bit : value | bit);
            }}
            className={
              isOn
                ? 'rounded-md bg-brand-fill px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50'
                : 'rounded-md border border-border px-2.5 py-1 text-xs font-medium text-ink-muted disabled:opacity-50'
            }
          >
            {labels[index]}
          </button>
        );
      })}
    </div>
  );
}

const CAPABILITY_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = {
  REQUESTED: 'warning',
  APPROVED: 'success',
  REJECTED: 'danger',
  SUSPENDED: 'danger',
  EXPIRED: 'warning',
};

/** The handful a seller's own operation realistically asks for. */
const OFFERABLE_CAPABILITIES = [
  'COLD_CHAIN_2_8',
  'FROZEN',
  'TEMPERATURE_CONTROLLED',
  'STERILE_HANDLING',
  'FRAGILE_HANDLING',
  'OVERSIZED',
  'SAME_DAY',
  'NEXT_DAY',
  'SIGNATURE_REQUIRED',
  'REVERSE_PICKUP',
];

function capabilityLabel(t: Translate, kind: string): string {
  switch (kind) {
    case 'COLD_CHAIN_2_8':
      return t('selfManaged.capability.coldChain');
    case 'FROZEN':
      return t('selfManaged.capability.frozen');
    case 'TEMPERATURE_CONTROLLED':
      return t('selfManaged.capability.temperature');
    case 'STERILE_HANDLING':
      return t('selfManaged.capability.sterile');
    case 'FRAGILE_HANDLING':
      return t('selfManaged.capability.fragile');
    case 'OVERSIZED':
      return t('selfManaged.capability.oversized');
    case 'SAME_DAY':
      return t('selfManaged.capability.sameDay');
    case 'NEXT_DAY':
      return t('selfManaged.capability.nextDay');
    case 'SIGNATURE_REQUIRED':
      return t('selfManaged.capability.signature');
    case 'REVERSE_PICKUP':
      return t('selfManaged.capability.reversePickup');
    default:
      // A kind this build has not seen shows its own name rather than nothing.
      return kind;
  }
}

function capabilityState(t: Translate, state: string): string {
  switch (state) {
    case 'REQUESTED':
      return t('selfManaged.capabilityState.requested');
    case 'APPROVED':
      return t('selfManaged.capabilityState.approved');
    case 'REJECTED':
      return t('selfManaged.capabilityState.rejected');
    case 'SUSPENDED':
      return t('selfManaged.capabilityState.suspended');
    case 'EXPIRED':
      return t('selfManaged.capabilityState.expired');
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------

/** Where goods leave from, per warehouse, under this method. */
function PickupSection({
  methodId,
  isEditable,
}: {
  methodId: string;
  isEditable: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();

  const [locationId, setLocationId] = useState('');
  const [days, setDays] = useState(31);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [cap, setCap] = useState('');
  const [instructions, setInstructions] = useState('');

  const locations = useQuery({ queryKey: ['seller', 'locations'], queryFn: fetchLocations });

  const profiles = useQuery({
    queryKey: ['seller', 'fulfilment', methodId, 'pickup-profiles'],
    queryFn: () => fetchPickupProfiles(methodId),
  });

  const save = useMutation({
    mutationFn: () =>
      savePickupProfile(methodId, {
        sellerLocationId: locationId,
        pickupDaysMask: days,
        windowStart: start.length > 0 ? start : null,
        windowEnd: end.length > 0 ? end : null,
        maxDailyShipments: cap.length > 0 ? Number(cap) : null,
        instructions: instructions.length > 0 ? instructions : null,
      }),
    onSuccess: async () => {
      toast.success(t('selfManaged.pickupSaved'));
      setLocationId('');
      setInstructions('');
      await client.invalidateQueries({
        queryKey: ['seller', 'fulfilment', methodId, 'pickup-profiles'],
      });
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error));
    },
  });

  const labels = dayLabels(t);

  return (
    <Card
      title={t('selfManaged.pickupTitle')}
      description={t('selfManaged.pickupDescription')}
      bodyClassName="space-y-5 px-6 py-5"
    >
      {profiles.isLoading ? (
        <LoadingState />
      ) : (profiles.data?.profiles.length ?? 0) === 0 ? (
        <p className="text-sm text-ink-muted">{t('selfManaged.pickupEmpty')}</p>
      ) : (
        <ul className="space-y-2">
          {profiles.data?.profiles.map((profile) => (
            <li
              key={profile.id}
              className="rounded-md border border-border-subtle px-4 py-3 text-sm"
            >
              <p className="font-medium text-ink">{profile.locationName}</p>
              <p className="mt-0.5 text-ink-muted">
                {DAY_BITS.filter((bit) => (profile.pickupDaysMask & bit) !== 0)
                  .map((bit) => labels[DAY_BITS.indexOf(bit)])
                  .join(', ')}
                {profile.windowStart !== null && profile.windowEnd !== null
                  ? ` · ${profile.windowStart}–${profile.windowEnd}`
                  : ''}
                {profile.maxDailyShipments !== null
                  ? ` · ${t('selfManaged.perDay', { total: String(profile.maxDailyShipments) })}`
                  : ''}
              </p>
              {profile.instructions !== null && (
                <p className="mt-1 text-xs text-ink-muted">{profile.instructions}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      {isEditable && (
        <div className="space-y-4 border-t border-border-subtle pt-5">
          <Field label={t('selfManaged.pickupLocation')} required>
            {({ inputId, describedBy }) => (
              <Select
                id={inputId}
                aria-describedby={describedBy}
                value={locationId}
                onChange={(event) => {
                  setLocationId(event.target.value);
                }}
              >
                <option value="">{t('selfManaged.choosePlace')}</option>
                {locations.data?.locations.map((place) => (
                  <option key={place.id} value={place.id}>
                    {place.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field label={t('selfManaged.pickupDays')} hint={t('selfManaged.pickupDaysHint')}>
            {() => <DayPicker value={days} onChange={setDays} disabled={false} />}
          </Field>

          <div className="grid gap-4 sm:grid-cols-3">
            <TextField
              label={t('selfManaged.windowStart')}
              type="time"
              value={start}
              onChange={(event) => {
                setStart(event.target.value);
              }}
            />
            <TextField
              label={t('selfManaged.windowEnd')}
              type="time"
              value={end}
              onChange={(event) => {
                setEnd(event.target.value);
              }}
            />
            <TextField
              label={t('selfManaged.dailyCap')}
              hint={t('selfManaged.dailyCapHint')}
              type="number"
              min={1}
              value={cap}
              onChange={(event) => {
                setCap(event.target.value);
              }}
            />
          </div>

          <TextField
            label={t('selfManaged.driverNotes')}
            hint={t('selfManaged.driverNotesHint')}
            value={instructions}
            onChange={(event) => {
              setInstructions(event.target.value);
            }}
          />

          <Button
            type="button"
            disabled={locationId.length === 0 || save.isPending}
            onClick={() => {
              save.mutate();
            }}
          >
            {t('selfManaged.savePickup')}
          </Button>
        </div>
      )}
    </Card>
  );
}

/** Where this operation delivers to, and where it does not. */
function AreasSection({
  methodId,
  isEditable,
}: {
  methodId: string;
  isEditable: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();

  const [scope, setScope] = useState<ServiceAreaScope>('COUNTRY');
  const [country, setCountry] = useState('');
  const [region, setRegion] = useState('');
  const [isExclusion, setIsExclusion] = useState(false);
  const [minDays, setMinDays] = useState('');
  const [maxDays, setMaxDays] = useState('');

  const areas = useQuery({
    queryKey: ['seller', 'fulfilment', methodId, 'service-areas'],
    queryFn: () => fetchServiceAreas(methodId),
  });

  const refresh = async (): Promise<void> => {
    await client.invalidateQueries({
      queryKey: ['seller', 'fulfilment', methodId, 'service-areas'],
    });
  };

  const save = useMutation({
    mutationFn: () =>
      saveServiceArea(methodId, {
        scope,
        countryCode: country,
        regionValue: region.length > 0 ? region : null,
        isExclusion,
        transitDaysMin: minDays.length > 0 ? Number(minDays) : null,
        transitDaysMax: maxDays.length > 0 ? Number(maxDays) : null,
      }),
    onSuccess: async () => {
      toast.success(t('selfManaged.areaSaved'));
      setRegion('');
      await refresh();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error));
    },
  });

  const remove = useMutation({
    mutationFn: (areaId: string) => removeServiceArea(methodId, areaId),
    onSuccess: refresh,
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error));
    },
  });

  return (
    <Card
      title={t('selfManaged.areasTitle')}
      description={t('selfManaged.areasDescription')}
      bodyClassName="space-y-5 px-6 py-5"
    >
      {areas.isLoading ? (
        <LoadingState />
      ) : (areas.data?.areas.length ?? 0) === 0 ? (
        <p className="text-sm text-ink-muted">{t('selfManaged.areasEmpty')}</p>
      ) : (
        <ul className="space-y-2">
          {areas.data?.areas.map((area) => (
            <li
              key={area.id}
              className="flex items-center justify-between gap-3 rounded-md border border-border-subtle px-4 py-3 text-sm"
            >
              <div className="min-w-0">
                <p className="font-medium text-ink">
                  {area.countryCode}
                  {area.regionValue.length > 0 ? ` · ${area.regionValue}` : ''}
                </p>
                <p className="mt-0.5 text-xs text-ink-muted">
                  {area.transitDaysMin !== null && area.transitDaysMax !== null
                    ? t('selfManaged.transitRange', {
                        min: String(area.transitDaysMin),
                        max: String(area.transitDaysMax),
                      })
                    : t('selfManaged.noTransitEstimate')}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {/* An exclusion wins over any inclusion that overlaps it, so it
                    is worth saying loudly which kind of row this is. */}
                <Badge tone={area.isExclusion ? 'danger' : 'success'}>
                  {area.isExclusion ? t('selfManaged.excluded') : t('selfManaged.served')}
                </Badge>
                {isEditable && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      remove.mutate(area.id);
                    }}
                  >
                    {t('common.remove')}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {isEditable && (
        <div className="space-y-4 border-t border-border-subtle pt-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t('selfManaged.areaScope')}>
              {({ inputId, describedBy }) => (
                <Select
                  id={inputId}
                  aria-describedby={describedBy}
                  value={scope}
                  onChange={(event) => {
                    setScope(event.target.value as ServiceAreaScope);
                  }}
                >
                  <option value="COUNTRY">{t('selfManaged.scope.country')}</option>
                  <option value="STATE">{t('selfManaged.scope.state')}</option>
                  <option value="CITY">{t('selfManaged.scope.city')}</option>
                  <option value="POSTCODE_PREFIX">{t('selfManaged.scope.postcode')}</option>
                </Select>
              )}
            </Field>

            <TextField
              label={t('selfManaged.areaCountry')}
              maxLength={2}
              value={country}
              onChange={(event) => {
                setCountry(event.target.value.toUpperCase());
              }}
            />

            <TextField
              label={t('selfManaged.areaRegion')}
              hint={t('selfManaged.areaRegionHint')}
              disabled={scope === 'COUNTRY'}
              value={region}
              onChange={(event) => {
                setRegion(event.target.value);
              }}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <TextField
              label={t('selfManaged.transitMin')}
              type="number"
              min={0}
              value={minDays}
              onChange={(event) => {
                setMinDays(event.target.value);
              }}
            />
            <TextField
              label={t('selfManaged.transitMax')}
              type="number"
              min={0}
              value={maxDays}
              onChange={(event) => {
                setMaxDays(event.target.value);
              }}
            />
            <Field label={t('selfManaged.areaKind')} hint={t('selfManaged.areaKindHint')}>
              {({ inputId, describedBy }) => (
                <Select
                  id={inputId}
                  aria-describedby={describedBy}
                  value={isExclusion ? 'exclude' : 'serve'}
                  onChange={(event) => {
                    setIsExclusion(event.target.value === 'exclude');
                  }}
                >
                  <option value="serve">{t('selfManaged.served')}</option>
                  <option value="exclude">{t('selfManaged.excluded')}</option>
                </Select>
              )}
            </Field>
          </div>

          <Button
            type="button"
            disabled={country.length !== 2 || save.isPending}
            onClick={() => {
              save.mutate();
            }}
          >
            {t('selfManaged.saveArea')}
          </Button>
        </div>
      )}
    </Card>
  );
}

/** What this operation is allowed to carry. Asked for here, decided elsewhere. */
function CapabilitiesSection({
  methodId,
  isEditable,
}: {
  methodId: string;
  isEditable: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();

  const [kind, setKind] = useState(OFFERABLE_CAPABILITIES[0] ?? 'COLD_CHAIN_2_8');
  const [evidence, setEvidence] = useState('');

  const capabilities = useQuery({
    queryKey: ['seller', 'fulfilment', methodId, 'capabilities'],
    queryFn: () => fetchCapabilities(methodId),
  });

  const ask = useMutation({
    mutationFn: () =>
      requestCapability(methodId, {
        kind,
        evidenceReference: evidence.length > 0 ? evidence : null,
      }),
    onSuccess: async () => {
      toast.success(t('selfManaged.capabilityAsked'));
      setEvidence('');
      await client.invalidateQueries({
        queryKey: ['seller', 'fulfilment', methodId, 'capabilities'],
      });
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error));
    },
  });

  const rows: Capability[] = capabilities.data?.capabilities ?? [];

  return (
    <Card
      title={t('selfManaged.capabilitiesTitle')}
      description={t('selfManaged.capabilitiesDescription')}
      bodyClassName="space-y-5 px-6 py-5"
    >
      {capabilities.isLoading ? (
        <LoadingState />
      ) : rows.length === 0 ? (
        <p className="text-sm text-ink-muted">{t('selfManaged.capabilitiesEmpty')}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex items-center justify-between gap-3 rounded-md border border-border-subtle px-4 py-3 text-sm"
            >
              <div className="min-w-0">
                <p className="font-medium text-ink">{capabilityLabel(t, row.kind)}</p>
                {row.decisionNote !== null && (
                  <p className="mt-0.5 text-xs text-ink-muted">{row.decisionNote}</p>
                )}
              </div>
              <Badge tone={CAPABILITY_TONE[row.state] ?? 'neutral'}>
                {capabilityState(t, row.state)}
              </Badge>
            </li>
          ))}
        </ul>
      )}

      {isEditable && (
        <div className="space-y-4 border-t border-border-subtle pt-5">
          <Field label={t('selfManaged.capabilityKind')}>
            {({ inputId, describedBy }) => (
              <Select
                id={inputId}
                aria-describedby={describedBy}
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value);
                }}
              >
                {OFFERABLE_CAPABILITIES.map((option) => (
                  <option key={option} value={option}>
                    {capabilityLabel(t, option)}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <TextField
            label={t('selfManaged.evidence')}
            hint={t('selfManaged.evidenceHint')}
            value={evidence}
            onChange={(event) => {
              setEvidence(event.target.value);
            }}
          />

          <Button
            type="button"
            disabled={ask.isPending}
            onClick={() => {
              ask.mutate();
            }}
          >
            {t('selfManaged.askCapability')}
          </Button>
        </div>
      )}
    </Card>
  );
}

/** What this operation charges. Published in versions, never edited in place. */
function RateCardSection({
  methodId,
  isEditable,
}: {
  methodId: string;
  isEditable: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();

  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('');
  const [flat, setFlat] = useState('');
  const [perKilo, setPerKilo] = useState('');

  const cards = useQuery({
    queryKey: ['seller', 'fulfilment', methodId, 'rate-cards'],
    queryFn: () => fetchRateCards(methodId),
  });

  const publish = useMutation({
    mutationFn: () =>
      publishRateCard(methodId, {
        name,
        currency,
        bands: [
          {
            // One band with both parts: a card that is "4 euro plus 50 cents a
            // kilo" is one line, not forty.
            basis: perKilo.length > 0 ? 'WEIGHT' : 'FLAT',
            minValue: 0,
            maxValue: null,
            amountMinor: flat,
            perUnitMinor: perKilo.length > 0 ? perKilo : null,
          },
        ],
      }),
    onSuccess: async () => {
      toast.success(t('selfManaged.ratesPublished'));
      await client.invalidateQueries({
        queryKey: ['seller', 'fulfilment', methodId, 'rate-cards'],
      });
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error));
    },
  });

  return (
    <Card
      title={t('selfManaged.ratesTitle')}
      description={t('selfManaged.ratesDescription')}
      bodyClassName="space-y-5 px-6 py-5"
    >
      {cards.isLoading ? (
        <LoadingState />
      ) : (cards.data?.rateCards.length ?? 0) === 0 ? (
        <p className="text-sm text-ink-muted">{t('selfManaged.ratesEmpty')}</p>
      ) : (
        <ul className="space-y-2">
          {cards.data?.rateCards.map((card) => (
            <li
              key={card.id}
              className="flex items-center justify-between gap-3 rounded-md border border-border-subtle px-4 py-3 text-sm"
            >
              <div className="min-w-0">
                <p className="font-medium text-ink">{card.name}</p>
                <p className="mt-0.5 text-xs text-ink-muted">
                  {t('selfManaged.version', { version: String(card.version) })} ·{' '}
                  {card.currency} · {t('selfManaged.lines', { total: String(card.bands.length) })}
                </p>
              </div>
              {/* An old version stays on the record and stops being live,
                  because a quote points at the version it was priced from. */}
              <Badge tone={card.isActive ? 'success' : 'neutral'}>
                {card.isActive ? t('selfManaged.live') : t('selfManaged.superseded')}
              </Badge>
            </li>
          ))}
        </ul>
      )}

      {isEditable && (
        <div className="space-y-4 border-t border-border-subtle pt-5">
          <p className="text-xs text-ink-muted">{t('selfManaged.ratesVersionNote')}</p>

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label={t('selfManaged.rateName')}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
            <TextField
              label={t('selfManaged.rateCurrency')}
              maxLength={3}
              value={currency}
              onChange={(event) => {
                setCurrency(event.target.value.toUpperCase());
              }}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label={t('selfManaged.rateFlat')}
              hint={t('selfManaged.minorUnitsHint')}
              inputMode="numeric"
              value={flat}
              onChange={(event) => {
                // Digits only. Minor units cross the API as a string of whole
                // units, and a decimal point here becomes a float somewhere.
                setFlat(event.target.value.replace(/\D/g, ''));
              }}
            />
            <TextField
              label={t('selfManaged.ratePerKilo')}
              hint={t('selfManaged.minorUnitsHint')}
              inputMode="numeric"
              value={perKilo}
              onChange={(event) => {
                setPerKilo(event.target.value.replace(/\D/g, ''));
              }}
            />
          </div>

          <Button
            type="button"
            disabled={
              name.length === 0 || currency.length !== 3 || flat.length === 0 || publish.isPending
            }
            onClick={() => {
              publish.mutate();
            }}
          >
            {t('selfManaged.publishRates')}
          </Button>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------

export function SelfManagedConfigPanel({
  methods,
  isEditable,
}: {
  methods: FulfilmentMethod[];
  isEditable: boolean;
}): React.JSX.Element | null {
  const { t } = useI18n();

  /*
   * Only the seller's own operation, and only once it has one behind it.
   *
   * A method still in DRAFT has no delivery company to configure, and every
   * one of these screens would refuse. Showing them would be offering four
   * forms that cannot be saved.
   */
  const own = methods.filter(
    (method) => method.mode === 'SELF_MANAGED' && method.partner !== null,
  );

  if (own.length === 0) return null;

  return (
    <div className="space-y-6">
      {own.map((method) => (
        <div key={method.id} className="space-y-4">
          <h2 className="text-title-sm text-ink">
            {t('selfManaged.sectionTitle', { name: method.publicDisplayName })}
          </h2>

          <PickupSection methodId={method.id} isEditable={isEditable} />
          <AreasSection methodId={method.id} isEditable={isEditable} />
          <CapabilitiesSection methodId={method.id} isEditable={isEditable} />
          <RateCardSection methodId={method.id} isEditable={isEditable} />
        </div>
      ))}
    </div>
  );
}

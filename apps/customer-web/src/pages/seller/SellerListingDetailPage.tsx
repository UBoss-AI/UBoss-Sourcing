/**
 * One published listing, and the versions it sells in.
 *
 * `listings/:id` used to render the listings table again, so "Edit" on a live
 * listing went nowhere. This is that page — and the first thing it has to do
 * is the thing every existing catalogue needs: let a seller add sizes to
 * something they listed before sizes existed.
 *
 * A suit listed as one thing, one code, one price, is not wrong. It is
 * incomplete: there is a rack of them in four sizes and the seller has had no
 * way to say so. Deleting and relisting would throw away the code, the
 * history and every order pointing at it, so the versions are added BESIDE
 * the original, which keeps its id and stays exactly where it was.
 *
 * Three rules this screen inherits from the listing wizard, for the same
 * reasons:
 *
 *   - **Nothing is ticked on the seller's behalf.** The category suggests
 *     axes and values; the seller says which are real. A suit is not assumed
 *     to come in 38 to 44 because suits usually do.
 *   - **The count comes before the table.** A seller is told how many rows
 *     they are about to have to price.
 *   - **New versions arrive off sale.** Adding six sizes must not put six
 *     things in front of buyers the instant Save is pressed.
 */
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, ErrorState, Input, LoadingState } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';
import { errorMessage } from '@/lib/errors';
import { formatMoneyMinor, majorToMinor, minorToMajor } from '@/lib/format';
import {
  addOfferVariants,
  fetchLocations,
  fetchOfferVariants,
  setOfferStatus,
  type DraftVariantAxis,
  type DraftVariantRow,
  type OfferVariantsView,
  type SellerLocation,
  type VariantTemplateAxis,
} from '@/lib/seller';
import { AxisValueEditor, CustomAxisAdder, ProjectionBar } from './VariantStepPanel';

/**
 * A price for an input box: major units, or empty where there is no price.
 *
 * `minorToMajor` would turn a missing price into "0.00", which reads as free
 * rather than as unanswered.
 */
function priceInput(minor: string | null | undefined): string {
  return minor === null || minor === undefined || minor === '' ? '' : minorToMajor(minor);
}

export function SellerListingDetailPage(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const offerId = id ?? '';

  const query = useQuery({
    queryKey: ['seller', 'offer-variants', offerId],
    queryFn: () => fetchOfferVariants(offerId),
    enabled: offerId !== '',
  });

  if (query.isPending) return <LoadingState label="Loading this listing" />;

  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  return <ListingBody view={query.data} />;
}

function ListingBody({ view }: { view: OfferVariantsView }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();

  const [axes, setAxes] = useState<DraftVariantAxis[]>([]);
  const [rows, setRows] = useState<DraftVariantRow[] | null>(null);

  const locationsQuery = useQuery({
    queryKey: ['seller', 'locations'],
    queryFn: fetchLocations,
  });

  const locations: SellerLocation[] = locationsQuery.data?.locations ?? [];
  const primaryLocation = locations[0]?.id ?? '';

  const refresh = async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: ['seller', 'offer-variants', view.offerId] });
    await client.invalidateQueries({ queryKey: ['seller', 'offers'] });
  };

  const pauseMutation = useMutation({
    mutationFn: () => setOfferStatus(view.offerId, 'PAUSED', 'Adding versions'),
    onSuccess: async () => {
      await refresh();
      toast.success('Paused. You can add versions now.');
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, 'That listing could not be paused.'));
    },
  });

  const addMutation = useMutation({
    mutationFn: (payload: { axes: DraftVariantAxis[]; rows: DraftVariantRow[] }) =>
      addOfferVariants(view.offerId, payload.axes, payload.rows, view.version),
    onSuccess: async (result) => {
      await refresh();
      setRows(null);
      setAxes([]);
      toast.success(
        result.created === 0
          ? 'Those versions were already listed.'
          : `${result.created} versions added. They start off sale — switch each on when you are ready.`,
      );
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, 'Those versions could not be added.'));
    },
  });

  const offered: VariantTemplateAxis[] = view.template?.axes ?? [];
  const activeKeys = useMemo(() => new Set(axes.map((axis) => axis.axisKey)), [axes]);

  /** Build the grid locally. The server re-keys and re-checks it on save. */
  const build = (): void => {
    const combinations = axes
      .filter((axis) => axis.values.length > 0)
      .reduce<Record<string, string>[]>(
        (acc, axis) =>
          acc.flatMap((partial) =>
            axis.values.map((value) => ({
              ...partial,
              [axis.axisKey]:
                value.amount != null && value.unit != null
                  ? `${value.amount} ${value.unit}`
                  : value.label,
            })),
          ),
        [{}],
      );

    const taken = new Set(view.existing.map((row) => row.optionSignature));

    setRows(
      combinations.map((options) => {
        // Mirrors the server's fold so the rows the seller edits carry the
        // same identity the server will compute for them.
        const optionSignature = Object.keys(options)
          .sort()
          .map((key) => `${key}:${options[key]?.toLowerCase().replace(/[^a-z0-9]+/g, '-') ?? ''}`)
          .join('|');

        return {
          optionSignature,
          options,
          name: Object.values(options).join(' / '),
          sku: `${view.sellerSku}-${Object.values(options)
            .map((value) => value.toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 6))
            .join('-')}`.slice(0, 64),
          isActive: !taken.has(optionSignature),
          priceMinor: view.existing[0]?.priceMinor ?? null,
          stock: [],
        };
      }),
    );
  };

  return (
    <div className="space-y-6">
      <header>
        <nav aria-label="Breadcrumb" className="text-xxs text-ink-subtle">
          <Link to="/seller/listings" className="hover:text-ink">
            Listings
          </Link>
          <span aria-hidden="true"> / </span>
          <span>{view.sellerSku}</span>
        </nav>
        <h1 className="mt-1 text-title-xl text-ink">{view.productName}</h1>
        <p className="mt-1 text-sm text-ink-subtle">
          Product code {view.sellerSku} · <StatusBadge status={view.status} />
        </p>
      </header>

      <Card
        title={view.hasVariants ? 'Versions' : 'This listing has no versions yet'}
        description={
          view.hasVariants
            ? 'Every version you sell of this product, each with its own code, price and stock.'
            : 'It sells as one thing. If you stock it in sizes, colours or pack sizes, add them here.'
        }
      >
        <ExistingTable rows={view.existing} currency={view.currency} />
      </Card>

      {!view.isEditable && (
        <Card title="Pause before adding versions">
          <div className="space-y-3">
            <p className="text-sm text-ink-subtle">
              {view.blockedReason ??
                'This listing is on sale. Pause it first so buyers are not choosing between versions that are appearing as they look.'}
            </p>
            <p className="text-sm text-ink-subtle">
              Orders already placed are not affected — you still pack and send them as normal.
            </p>
            <Button
              variant="primary"
              isLoading={pauseMutation.isPending}
              onClick={() => {
                pauseMutation.mutate();
              }}
            >
              Pause this listing
            </Button>
          </div>
        </Card>
      )}

      {view.isEditable && (
        <Card
          title="Add versions"
          description={
            view.template === null
              ? 'This category has no suggested options, so name your own.'
              : `Suggestions for ${view.template.label}. Switch on only what changes the product code.`
          }
        >
          <div className="space-y-5">
            {offered.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {offered.map((axis) => {
                  const isOn = activeKeys.has(axis.key);

                  return (
                    <button
                      key={axis.key}
                      type="button"
                      aria-pressed={isOn}
                      onClick={() => {
                        setRows(null);
                        setAxes(
                          isOn
                            ? axes.filter((entry) => entry.axisKey !== axis.key)
                            : [...axes, { axisKey: axis.key, values: [] }],
                        );
                      }}
                      className={cx(
                        'rounded-full border px-3 py-1.5 text-xs transition-colors',
                        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
                        isOn
                          ? 'border-brand bg-brand-soft font-semibold text-brand'
                          : 'border-line bg-surface text-ink-subtle hover:border-brand/40 hover:text-ink',
                      )}
                    >
                      <span aria-hidden="true">{isOn ? '✓ ' : '+ '}</span>
                      {axis.label}
                      {axis.importance === 'RECOMMENDED' && !isOn && (
                        <span className="ml-1 text-xxs text-ink-subtle">· usual</span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {axes.map((chosen) => {
              const definition =
                offered.find((axis) => axis.key === chosen.axisKey) ??
                ({
                  key: chosen.axisKey,
                  label: chosen.axisKey,
                  importance: 'OPTIONAL',
                  input: 'TEXT_SELECT',
                  display: 'CHIPS',
                  allowsCustomValues: true,
                  affectsSku: true,
                  isFilterable: false,
                  inTitle: true,
                  sortOrder: 0,
                  sort: 'GIVEN',
                } satisfies VariantTemplateAxis);

              return (
                <section key={chosen.axisKey} className="rounded-lg border border-line p-4">
                  <h3 className="mb-3 text-sm font-semibold text-ink">{definition.label}</h3>
                  <AxisValueEditor
                    axis={definition}
                    chosen={chosen.values}
                    onChange={(values) => {
                      setRows(null);
                      setAxes(
                        axes.map((entry) =>
                          entry.axisKey === chosen.axisKey ? { ...entry, values } : entry,
                        ),
                      );
                    }}
                  />
                </section>
              );
            })}

            <CustomAxisAdder
              existingKeys={activeKeys}
              onAdd={(axisKey) => {
                setRows(null);
                setAxes([...axes, { axisKey, values: [] }]);
              }}
            />

            {axes.length > 0 && (
              <ProjectionBar
                axes={axes}
                projection={{ total: 0, warnAbove: 100, maximum: 500, exceedsMaximum: false }}
                hasExistingRows={false}
                isBusy={false}
                onGenerate={() => {
                  build();
                }}
              />
            )}

            {rows !== null && rows.length > 0 && (
              <NewRowsTable
                rows={rows}
                currency={view.currency}
                primaryLocation={primaryLocation}
                isBusy={addMutation.isPending}
                onChange={setRows}
                onSave={() => {
                  addMutation.mutate({ axes, rows: rows.filter((row) => row.isActive) });
                }}
              />
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: OfferVariantsView['status'] }): React.JSX.Element {
  const tone =
    status === 'ACTIVE'
      ? 'success'
      : status === 'PAUSED'
        ? 'warning'
        : status === 'NEEDS_CHANGES'
          ? 'danger'
          : 'neutral';

  return <Badge tone={tone}>{status.replace(/_/g, ' ').toLowerCase()}</Badge>;
}

/** What this seller already sells of this product. */
function ExistingTable({
  rows,
  currency,
}: {
  rows: OfferVariantsView['existing'];
  currency: string;
}): React.JSX.Element {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] border-collapse text-sm">
        <caption className="sr-only">Versions of this product you already sell</caption>
        <thead>
          <tr className="border-b border-line text-left text-xxs uppercase tracking-wide text-ink-subtle">
            <th scope="col" className="py-2 pr-3">Version</th>
            <th scope="col" className="py-2 pr-3">Code</th>
            <th scope="col" className="py-2 pr-3">Price</th>
            <th scope="col" className="py-2 pr-3">Stock</th>
            <th scope="col" className="py-2 pr-3">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.offerId} className="border-b border-line/60">
              <td className="py-2 pr-3 font-medium text-ink">
                {row.isBaseListing ? (
                  <span className="text-ink-subtle">No particular version</span>
                ) : (
                  (row.name ?? Object.values(row.options).join(' / '))
                )}
              </td>
              <td className="py-2 pr-3 tabular">{row.sellerSku}</td>
              <td className="py-2 pr-3 tabular">
                {formatMoneyMinor(row.priceMinor, currency)}
              </td>
              <td className="py-2 pr-3 tabular">{row.availableQuantity}</td>
              <td className="py-2 pr-3">
                <StatusBadge status={row.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The versions about to be created, before they are.
 *
 * A combination already listed arrives switched off rather than hidden, so a
 * seller adding one size to a range of six can see the six they have as well
 * as the one they are adding.
 */
function NewRowsTable({
  rows,
  currency,
  primaryLocation,
  isBusy,
  onChange,
  onSave,
}: {
  rows: DraftVariantRow[];
  currency: string;
  primaryLocation: string;
  isBusy: boolean;
  onChange: (rows: DraftVariantRow[]) => void;
  onSave: () => void;
}): React.JSX.Element {
  const patch = (signature: string, next: Partial<DraftVariantRow>): void => {
    onChange(rows.map((row) => (row.optionSignature === signature ? { ...row, ...next } : row)));
  };

  const chosen = rows.filter((row) => row.isActive);

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[44rem] border-collapse text-sm">
          <caption className="sr-only">Versions to add, with their codes, prices and stock</caption>
          <thead>
            <tr className="border-b border-line text-left text-xxs uppercase tracking-wide text-ink-subtle">
              <th scope="col" className="py-2 pr-3">Add</th>
              <th scope="col" className="py-2 pr-3">Version</th>
              <th scope="col" className="py-2 pr-3">Code</th>
              <th scope="col" className="py-2 pr-3">Price ({currency})</th>
              <th scope="col" className="py-2 pr-3">Stock</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.optionSignature}
                className={cx('border-b border-line/60', !row.isActive && 'opacity-60')}
              >
                <td className="py-2 pr-3">
                  <input
                    type="checkbox"
                    checked={row.isActive}
                    aria-label={`Add ${row.name}`}
                    disabled={isBusy}
                    onChange={(event) => {
                      patch(row.optionSignature, { isActive: event.target.checked });
                    }}
                  />
                </td>
                <td className="py-2 pr-3 font-medium text-ink">{row.name}</td>
                <td className="py-2 pr-3">
                  <Input
                    value={row.sku}
                    aria-label={`Code for ${row.name}`}
                    disabled={isBusy || !row.isActive}
                    onChange={(event) => {
                      patch(row.optionSignature, { sku: event.target.value });
                    }}
                  />
                </td>
                <td className="py-2 pr-3">
                  <Input
                    inputMode="decimal"
                    aria-label={`Price for ${row.name}`}
                    defaultValue={priceInput(row.priceMinor)}
                    disabled={isBusy || !row.isActive}
                    onBlur={(event) => {
                      const minor = majorToMinor(event.target.value);
                      if (minor === null && event.target.value.trim() !== '') return;
                      patch(row.optionSignature, { priceMinor: minor });
                    }}
                  />
                </td>
                <td className="py-2 pr-3">
                  <Input
                    inputMode="numeric"
                    aria-label={`Stock for ${row.name}`}
                    defaultValue="0"
                    disabled={isBusy || !row.isActive || primaryLocation === ''}
                    onBlur={(event) => {
                      const quantity = Number.parseInt(event.target.value, 10);
                      if (!Number.isFinite(quantity) || quantity < 0) return;
                      patch(row.optionSignature, {
                        stock:
                          quantity === 0
                            ? []
                            : [{ locationId: primaryLocation, availableQuantity: quantity }],
                      });
                    }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xxs text-ink-subtle">
          New versions are created off sale. Switch each one on from your listings when it is
          ready.
        </p>
        <Button
          variant="primary"
          isLoading={isBusy}
          disabled={chosen.length === 0}
          onClick={onSave}
        >
          Add {chosen.length} {chosen.length === 1 ? 'version' : 'versions'}
        </Button>
      </div>
    </div>
  );
}

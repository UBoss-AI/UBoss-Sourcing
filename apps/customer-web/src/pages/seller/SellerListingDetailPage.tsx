/**
 * One published listing: the versions it sells in, and what buyers have asked
 * about it.
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
 *     axes; the seller says which are real. A suit is not assumed to come in
 *     38 to 44 because suits usually do.
 *   - **The count comes before the table.** A seller is told how many rows
 *     they are about to have to price.
 *   - **New versions arrive off sale.** Adding six sizes must not put six
 *     things in front of buyers the instant Save is pressed.
 *
 * ## What buyers have asked
 *
 * The panel at the foot is the other half of the "Add instructions" button on
 * the storefront. A shopper can now say what they need on a product without
 * buying it — "do you do this in 8mm?", "can you supply a calibration
 * certificate?", "we need four hundred a month" — and this is where those
 * arrive. It is read-only: they are the buyer's own words, and a seller who
 * could edit one could rewrite the evidence of what was asked for.
 *
 * ## Layout
 *
 * Every table here runs flush to its card and pads its own cells at `px-6`,
 * so the first column lines up with the card's heading rather than with the
 * card's border. Each is inside a focusable scroll region: they are wider than
 * a phone, and a scroll container with no tab stop cannot be scrolled by a
 * keyboard at all.
 */
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, ErrorState, Input, LoadingState } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';
import { errorMessage } from '@/lib/errors';
import { formatMoneyMinor, formatRelative, majorToMinor, minorToMajor } from '@/lib/format';
import {
  addOfferVariants,
  fetchListingInstructions,
  fetchLocations,
  fetchOfferVariants,
  setOfferStatus,
  type DraftVariantAxis,
  type DraftVariantRow,
  type OfferVariantsView,
  type SellerLocation,
  type SellerProductInstruction,
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
  const { t } = useI18n();
  const { id } = useParams<{ id: string }>();
  const offerId = id ?? '';

  const query = useQuery({
    queryKey: ['seller', 'offer-variants', offerId],
    queryFn: () => fetchOfferVariants(offerId),
    enabled: offerId !== '',
  });

  if (query.isPending) return <LoadingState label={t('seller.listing.loading')} />;

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

  return <ListingBody view={query.data} offerId={offerId} />;
}

function ListingBody({
  view,
  offerId,
}: {
  view: OfferVariantsView;
  offerId: string;
}): React.JSX.Element {
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
      toast.success(t('seller.listing.paused'));
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('seller.listing.pauseFailed')));
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
          ? t('seller.listing.alreadyListed')
          : t('seller.listing.versionsAdded', { count: result.created }),
      );
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('seller.listing.addFailed')));
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
        <nav aria-label={t('seller.listing.breadcrumb')} className="text-xxs text-ink-subtle">
          <Link to="/seller/listings" className="hover:text-ink">
            {t('seller.nav.listings')}
          </Link>
          <span aria-hidden="true"> / </span>
          <span>{view.sellerSku}</span>
        </nav>
        {/* `break-words`: a product name on this marketplace routinely runs to
            eighty characters with no spaces in the code at the end of it, and
            at 320px an unbroken one pushed the whole hub sideways. */}
        <h1 className="mt-1 break-words text-title-lg text-ink sm:text-title-xl">
          {view.productName}
        </h1>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-subtle">
          <span>{t('seller.listing.productCode', { code: view.sellerSku })}</span>
          <span aria-hidden="true">·</span>
          <StatusBadge status={view.status} />
        </p>
      </header>

      <Card
        title={
          view.hasVariants ? t('seller.listing.versions') : t('seller.listing.noVersionsYet')
        }
        description={
          view.hasVariants
            ? t('seller.listing.versionsIntro')
            : t('seller.listing.noVersionsIntro')
        }
      >
        <ExistingTable rows={view.existing} currency={view.currency} />
      </Card>

      {!view.isEditable && (
        <Card title={t('seller.listing.pauseFirst')} bodyClassName="px-6 py-5">
          <div className="space-y-3">
            <p className="text-sm text-ink-subtle">
              {view.blockedReason ?? t('seller.listing.pauseFirstBody')}
            </p>
            <p className="text-sm text-ink-subtle">{t('seller.listing.ordersUnaffected')}</p>
            <Button
              variant="primary"
              isLoading={pauseMutation.isPending}
              onClick={() => {
                pauseMutation.mutate();
              }}
            >
              {t('seller.listing.pauseThisListing')}
            </Button>
          </div>
        </Card>
      )}

      {view.isEditable && (
        <Card
          title={t('seller.listing.addVersions')}
          description={
            view.template === null
              ? t('seller.listing.noSuggestions')
              : t('seller.listing.suggestionsFor', { label: view.template.label })
          }
          bodyClassName="px-6 py-5"
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
                        <span className="ml-1 text-xxs text-ink-subtle">
                          {t('seller.listing.usualSuffix')}
                        </span>
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

      <InstructionsPanel offerId={offerId} />
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

/**
 * What shoppers have asked about this product, without buying it.
 *
 * The other end of the storefront's "Add instructions" button. Read-only on
 * purpose: these are the buyer's own words and only they can change them.
 *
 * Scoped to the PRODUCT rather than to this seller's offer, which is the
 * correct line even though three distributors can sell the same shirt. A
 * shopper asking "do you do this in 8mm?" is asking the marketplace, not a
 * company whose name they have never seen — routing the question to whichever
 * offer happened to be on screen would send most of these to somebody who
 * cannot answer them.
 *
 * A failure here is shown and not thrown. The seller came to this page to add
 * sizes; a panel at the foot that cannot load must not take the rest of the
 * screen down with it.
 */
function InstructionsPanel({ offerId }: { offerId: string }): React.JSX.Element {
  const { t } = useI18n();

  const query = useQuery({
    queryKey: ['seller', 'listing-instructions', offerId],
    queryFn: () => fetchListingInstructions(offerId),
    enabled: offerId !== '',
  });

  const instructions: SellerProductInstruction[] = query.data ?? [];

  return (
    <Card
      title={t('seller.listing.buyerInstructions')}
      description={t('seller.listing.buyerInstructionsIntro')}
      bodyClassName="px-6 py-5"
    >
      {query.isPending ? (
        <p className="text-sm text-ink-subtle">{t('common.loading')}</p>
      ) : query.isError ? (
        <div className="space-y-3">
          <p className="text-sm text-ink-subtle">{t('seller.listing.instructionsFailed')}</p>
          <Button
            size="sm"
            onClick={() => {
              void query.refetch();
            }}
          >
            {t('common.retry')}
          </Button>
        </div>
      ) : instructions.length === 0 ? (
        <p className="text-sm text-ink-subtle">{t('seller.listing.noInstructionsYet')}</p>
      ) : (
        <ul className="space-y-3">
          {instructions.map((instruction) => (
            <li
              key={instruction.id}
              className="rounded-lg border border-border-subtle bg-surface-sunken p-4"
            >
              {/* `flex-wrap` and `min-w-0`: an organisation name plus a
                  timestamp does not fit on one line at 320px, and a name with
                  no spaces in it would otherwise widen the whole hub. */}
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <p className="min-w-0 break-words text-sm font-semibold text-ink">
                  {instruction.customerName}
                  {instruction.customerOrganization !== null && (
                    <span className="font-normal text-ink-muted">
                      {' · '}
                      {instruction.customerOrganization}
                    </span>
                  )}
                </p>
                <time
                  dateTime={instruction.createdAt}
                  className="shrink-0 text-xxs text-ink-subtle"
                >
                  {formatRelative(instruction.createdAt)}
                </time>
              </div>

              {instruction.variantName !== null && (
                <p className="mt-1 text-xxs uppercase tracking-wide text-ink-subtle">
                  {t('seller.listing.aboutVersion', { version: instruction.variantName })}
                </p>
              )}

              {/* `whitespace-pre-line`: somebody who typed three lines meant
                  three lines. `break-words` because this is free text and a
                  buyer can paste a part number eighty characters long.

                  Rendered as TEXT. Nothing on this path touches
                  `dangerouslySetInnerHTML`, and the column holds plain text
                  precisely so that it cannot. */}
              <p className="mt-2 whitespace-pre-line break-words text-sm leading-relaxed text-ink">
                {instruction.body}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** What this seller already sells of this product. See the file header. */
function ExistingTable({
  rows,
  currency,
}: {
  rows: OfferVariantsView['existing'];
  currency: string;
}): React.JSX.Element {
  const { t } = useI18n();

  return (
    <>
      <div
        className="overflow-x-auto"
        tabIndex={0}
        role="region"
        aria-label={t('seller.listing.versionsTableLabel')}
      >
        <table className="w-full min-w-[40rem] border-collapse text-sm">
          <caption className="sr-only">{t('seller.listing.versionsTableLabel')}</caption>
          <thead>
            <tr className="border-b border-line text-left text-xxs uppercase tracking-wide text-ink-subtle">
              <th scope="col" className="px-6 py-2.5">{t('seller.listing.columnVersion')}</th>
              <th scope="col" className="px-6 py-2.5">{t('seller.listing.columnCode')}</th>
              <th scope="col" className="px-6 py-2.5 text-right">{t('seller.listing.columnPrice')}</th>
              <th scope="col" className="px-6 py-2.5 text-right">{t('seller.listing.columnStock')}</th>
              <th scope="col" className="px-6 py-2.5">{t('seller.listing.columnStatus')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.offerId} className="border-b border-line/60 last:border-b-0">
                <td className="px-6 py-2.5 font-medium text-ink">
                  {row.isBaseListing ? (
                    <span className="text-ink-subtle">
                      {t('seller.listing.noParticularVersion')}
                    </span>
                  ) : (
                    (row.name ?? Object.values(row.options).join(' / '))
                  )}
                </td>
                <td className="px-6 py-2.5 tabular">{row.sellerSku}</td>
                {/* Right-aligned, like every other money and count column in
                    the product: figures compare down a column only when their
                    units line up, which they do not when a four-digit price
                    sits under a two-digit one that is left-aligned. */}
                <td className="px-6 py-2.5 text-right tabular">
                  {formatMoneyMinor(row.priceMinor, currency)}
                </td>
                <td className="px-6 py-2.5 text-right tabular">{row.availableQuantity}</td>
                <td className="px-6 py-2.5">
                  <StatusBadge status={row.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* `sm:hidden`: on a screen wide enough for the whole table this would
          be a note about something that is not happening. */}
      <p className="px-6 pb-4 pt-3 text-xxs text-ink-subtle sm:hidden">
        {t('seller.listing.scrollForMore')}
      </p>
    </>
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
  const { t } = useI18n();

  const patch = (signature: string, next: Partial<DraftVariantRow>): void => {
    onChange(rows.map((row) => (row.optionSignature === signature ? { ...row, ...next } : row)));
  };

  const chosen = rows.filter((row) => row.isActive);

  return (
    <div className="space-y-3">
      {/* This one sits inside a padded card body rather than flush to a card,
          so the cells carry no `px-6` of their own — `-mx-4 px-4` lets it use
          the full width of the card on a phone while the rest of the body
          stays inset. */}
      <div
        className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0"
        tabIndex={0}
        role="region"
        aria-label={t('seller.listing.newVersionsTableLabel')}
      >
        <table className="w-full min-w-[44rem] border-collapse text-sm">
          <caption className="sr-only">{t('seller.listing.newVersionsTableLabel')}</caption>
          <thead>
            <tr className="border-b border-line text-left text-xxs uppercase tracking-wide text-ink-subtle">
              <th scope="col" className="py-2 pr-3">{t('seller.listing.columnAdd')}</th>
              <th scope="col" className="py-2 pr-3">{t('seller.listing.columnVersion')}</th>
              <th scope="col" className="py-2 pr-3">{t('seller.listing.columnCode')}</th>
              <th scope="col" className="py-2 pr-3">
                {t('seller.listing.columnPriceIn', { currency })}
              </th>
              <th scope="col" className="py-2 pr-3">{t('seller.listing.columnStock')}</th>
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
                    aria-label={t('seller.listing.addRow', { name: row.name })}
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
                    aria-label={t('seller.listing.codeForRow', { name: row.name })}
                    disabled={isBusy || !row.isActive}
                    onChange={(event) => {
                      patch(row.optionSignature, { sku: event.target.value });
                    }}
                  />
                </td>
                <td className="py-2 pr-3">
                  <Input
                    inputMode="decimal"
                    aria-label={t('seller.listing.priceForRow', { name: row.name })}
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
                    aria-label={t('seller.listing.stockForRow', { name: row.name })}
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
        <p className="text-xxs text-ink-subtle">{t('seller.listing.newVersionsStartOffSale')}</p>
        <Button
          variant="primary"
          isLoading={isBusy}
          disabled={chosen.length === 0}
          onClick={onSave}
          className="w-full sm:w-auto"
        >
          {t('seller.listing.addCount', { count: chosen.length })}
        </Button>
      </div>
    </div>
  );
}

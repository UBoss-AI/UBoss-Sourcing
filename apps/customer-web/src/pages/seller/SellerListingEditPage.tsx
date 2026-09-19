/**
 * Editing a listing that is already in the catalogue.
 *
 * "Edit" used to open a screen that could add sizes and nothing else. Every
 * other thing the seller had typed into the wizard — the price, the minimum
 * order, the lead time, the photographs, the stock against one colour — was
 * frozen the moment a moderator approved it. This is the screen that word was
 * always promising.
 *
 * ---
 *
 * WHAT THE SELLER OWNS, AND WHAT THEY SHARE
 *
 * The facts panel is read-only, and that is the one thing here most likely to
 * look like a bug. A marketplace product is ONE catalogue entry that several
 * sellers offer: three distributors list the same pump, and a buyer comparing
 * their prices is comparing three offers against one product page. Letting any
 * one of them rename it or move it to another department would change what the
 * other two are selling without their knowing. So the product's own facts are
 * shown filled in — which is what a seller opening "Edit" needs to see — and
 * changed through moderation.
 *
 * Photographs are the exception, and the rule is narrower than it looks: the
 * seller who DESCRIBED the product may change them, because it is their
 * listing the pictures came from. A seller who merely matched their stock to
 * an existing page may not, for exactly the reason above.
 *
 * TWO KINDS OF CHANGE
 *
 * Price, stock and terms are routine: they change often, a buyer with the page
 * open absorbs them, and demanding a listing be taken off sale to correct a
 * stock count would produce a catalogue whose counts are wrong. Options and
 * combinations are structural: they rearrange what the buyer is choosing
 * between, and doing that under somebody mid-purchase means they pick a size
 * that stops existing between the click and the basket. So the matrix is
 * locked while the listing is on sale, and "Pause & Edit" is the door.
 *
 * TWO WAYS TO FINISH
 *
 * "Save as paused" and "Save & resume sale" are different decisions, and a
 * seller halfway through re-pricing forty rows has to be able to put the work
 * down without putting it in front of buyers. The resume checks run on the
 * server — this screen shows what it can see, and the server is what refuses.
 *
 * ON THE LAYOUT
 *
 * One column of cards, widest content last. A seller works down it: what it
 * is, what it looks like, what it costs, what versions there are. The matrix
 * is a table from `lg` up and a stack of cards below it, because a nine-column
 * table on a phone is a horizontal scroll nobody uses — and stock is the thing
 * most often corrected from a phone, standing in the warehouse.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useBlocker, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Card,
  ErrorState,
  Field,
  Input,
  LoadingState,
  Select,
} from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';
import { errorMessage } from '@/lib/errors';
import { majorToMinor, minorToMajor } from '@/lib/format';
import {
  addListingPhoto,
  fetchListingForEdit,
  fetchLocations,
  pauseListingForEdit,
  removeListingPhoto,
  saveListingEdit,
  setPrimaryListingPhoto,
  type DraftVariantAxis,
  type ListingEditRowPatch,
  type ListingEditVariantRow,
  type ListingEditView,
  type SellerLocation,
  type VariantTemplateAxis,
} from '@/lib/seller';
import { AxisValueEditor, CustomAxisAdder } from './VariantStepPanel';

/** The inner padding every card body uses. Stated once so they all match. */
const BODY = 'px-6 py-5';

/**
 * A price for an input box: major units, or empty where there is none.
 *
 * `minorToMajor` would turn a missing price into "0.00", which reads as free
 * rather than as unanswered.
 */
function priceInput(minor: string | null | undefined): string {
  return minor === null || minor === undefined || minor === '' ? '' : minorToMajor(minor);
}

function numberInput(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

/** A whole number a seller typed, or null where they cleared the box. */
function parseWhole(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  const value = Number.parseInt(trimmed, 10);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * The form's own copy of one combination.
 *
 * Kept apart from the server's row because they answer different questions:
 * the server's says what IS, this says what the seller has typed and not yet
 * saved. `origin` carries the former, which is how a row knows whether it has
 * ever been sold and therefore what "remove" is allowed to mean.
 */
interface EditableRow extends ListingEditRowPatch {
  origin: ListingEditVariantRow | null;
}

function toEditable(row: ListingEditVariantRow): EditableRow {
  return {
    offerId: row.offerId,
    optionSignature: row.optionSignature,
    options: row.options,
    name: row.name,
    sku: row.sku,
    barcode: row.barcode,
    isActive: row.isActive,
    priceMinor: row.priceMinor,
    compareAtPriceMinor: row.compareAtPriceMinor,
    minOrderQty: row.minOrderQty,
    qtyIncrement: row.qtyIncrement,
    maxOrderQty: row.maxOrderQty,
    leadTimeDays: row.leadTimeDays,
    shippingWeightGrams: row.shippingWeightGrams,
    shippingLengthMm: row.shippingLengthMm,
    shippingWidthMm: row.shippingWidthMm,
    shippingHeightMm: row.shippingHeightMm,
    mediaId: row.imageMediaId,
    stock: row.stock,
    origin: row,
  };
}

/** The row as the server wants it: everything but this screen's own memory. */
function stripOrigin(row: EditableRow): ListingEditRowPatch {
  const rest: Record<string, unknown> = { ...row };
  delete rest['origin'];
  return rest as unknown as ListingEditRowPatch;
}

/**
 * The identity of a combination, folded the way the server folds it.
 *
 * Mirrored here rather than fetched so a row the seller has just typed carries
 * the same identity the server will compute for it — which is how the table
 * tells "this is the size 8 you already sell" from "this is a new one" without
 * a round trip.
 */
function signatureOf(options: Record<string, string>): string {
  return Object.keys(options)
    .sort()
    .map((key) => `${key}:${(options[key] ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`)
    .join('|');
}

/** What this row is called, for a label a screen reader can read out. */
function rowLabel(row: EditableRow): string {
  if (row.name !== '') return row.name;
  return row.sku === '' ? 'this listing' : row.sku;
}

export function SellerListingEditPage(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const offerId = id ?? '';

  const query = useQuery({
    queryKey: ['seller', 'listing-edit', offerId],
    queryFn: () => fetchListingForEdit(offerId),
    enabled: offerId !== '',
    // The form is built from this once. Refetching under a seller who is
    // typing would replace their work with the server's copy of it.
    refetchOnWindowFocus: false,
  });

  if (offerId === '') return <ErrorState error={new Error('No listing was named.')} />;
  if (query.isPending) return <LoadingState label="Opening this listing" />;

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

  // Keyed on the version so a save rebuilds every input from the saved figures
  // rather than leaving the old ones sitting in the boxes.
  return <EditForm key={query.data.version} view={query.data} />;
}

function EditForm({ view }: { view: ListingEditView }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();

  const locationsQuery = useQuery({
    queryKey: ['seller', 'locations'],
    queryFn: fetchLocations,
  });

  const locations: SellerLocation[] = locationsQuery.data?.locations ?? [];
  const primaryLocation = locations[0]?.id ?? '';

  /**
   * Whether the price belongs to the terms card or to the table under it.
   *
   * The listing in the URL is sometimes a version in its own right — a seller
   * who arrived from "Black / 8" is editing that row — and its price would
   * then appear twice on one screen. Two boxes holding one number is a box
   * that silently loses, so the card shows the price only when this listing
   * has no options of its own.
   */
  const ownRow = view.variants.find((row) => row.offerId === view.offerId);
  const pricedHere = ownRow === undefined || ownRow.isBaseListing;

  // --- What the seller has typed -----------------------------------------

  const [price, setPrice] = useState(priceInput(view.terms.priceMinor));
  const [compareAt, setCompareAt] = useState(priceInput(view.terms.compareAtPriceMinor));
  const [minOrder, setMinOrder] = useState(numberInput(view.terms.minimumOrderQuantity));
  const [increment, setIncrement] = useState(numberInput(view.terms.orderIncrement));
  const [maxOrder, setMaxOrder] = useState(numberInput(view.terms.maximumOrderQuantity));
  const [handling, setHandling] = useState(numberInput(view.terms.handlingTimeDays));
  const [shelfLife, setShelfLife] = useState(numberInput(view.terms.guaranteedShelfLifeMonths));
  const [warranty, setWarranty] = useState(numberInput(view.terms.warrantyMonths));

  const [rows, setRows] = useState<EditableRow[]>(() => view.variants.map(toEditable));
  const [axes, setAxes] = useState<DraftVariantAxis[]>(() =>
    view.product.axes.map((axisKey) => ({
      axisKey,
      // The values come from the combinations that exist, not from the
      // template: what the seller stocks is the truth, and the template only
      // ever suggested it.
      values: [
        ...new Map(
          view.variants
            .map((row) => row.options[axisKey])
            .filter((label): label is string => label !== undefined && label !== '')
            .map((label) => [label.toLowerCase(), { label }]),
        ).values(),
      ],
    })),
  );

  const [isDirty, setIsDirty] = useState(false);
  const [pauseAsked, setPauseAsked] = useState(false);
  const saveTarget = useRef<'PAUSED' | 'ACTIVE'>('PAUSED');

  const touch = useCallback(() => {
    setIsDirty(true);
  }, []);

  // --- Leaving with work in progress -------------------------------------

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      isDirty && currentLocation.pathname !== nextLocation.pathname,
  );

  useEffect(() => {
    if (!isDirty) return undefined;

    /*
     * The browser's own warning, for the tab close and the back button.
     *
     * `useBlocker` covers navigation inside the app and nothing else; a seller
     * who has re-priced forty rows and reaches for the X deserves the same
     * question from either door.
     */
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };

    window.addEventListener('beforeunload', warn);

    return () => {
      window.removeEventListener('beforeunload', warn);
    };
  }, [isDirty]);

  // --- Pausing and saving -------------------------------------------------

  const refresh = useCallback(async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: ['seller', 'listing-edit', view.offerId] });
    await client.invalidateQueries({ queryKey: ['seller', 'offers'] });
  }, [client, view.offerId]);

  const pauseMutation = useMutation({
    mutationFn: () => pauseListingForEdit(view.offerId),
    onSuccess: async () => {
      await refresh();
      toast.success('Paused. Nothing is on sale while you work on it.');
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, 'That listing could not be paused.'));
    },
  });

  /*
   * The listings table asked the question; this honours the answer.
   *
   * The pause happens HERE rather than in the button that asked, so a
   * navigation which never arrives — a closed tab, a dropped connection —
   * cannot leave a listing off sale with nobody on the screen that took it
   * off. The flag is cleared immediately so a refresh does not pause twice.
   */
  useEffect(() => {
    if (search.get('pause') !== '1') return;

    setSearch({}, { replace: true });
    if (view.status === 'ACTIVE') pauseMutation.mutate();
    // Deliberately keyed on the flag alone: once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.get('pause')]);

  const saveMutation = useMutation({
    mutationFn: (finish: 'PAUSED' | 'ACTIVE') =>
      saveListingEdit(view.offerId, {
        expectedVersion: view.version,
        terms: {
          ...(pricedHere
            ? {
                priceMinor: majorToMinor(price) ?? view.terms.priceMinor,
                compareAtPriceMinor: compareAt.trim() === '' ? null : majorToMinor(compareAt),
              }
            : {}),
          minimumOrderQuantity: parseWhole(minOrder),
          orderIncrement: parseWhole(increment),
          maximumOrderQuantity: parseWhole(maxOrder),
          handlingTimeDays: parseWhole(handling),
          guaranteedShelfLifeMonths: parseWhole(shelfLife),
          warrantyMonths: parseWhole(warranty),
        },
        axes: view.isStructuralEditAllowed ? axes : null,
        // `origin` is this screen's memory of where each row started. The
        // server holds that copy already.
        rows: rows.map((row) => stripOrigin(row)),
        finish,
      }),
    onSuccess: async (result) => {
      setIsDirty(false);
      await refresh();

      const added =
        result.created > 0
          ? ` ${String(result.created)} new version${result.created === 1 ? '' : 's'} added, off sale.`
          : '';
      const gone =
        result.withdrawn > 0
          ? ` ${String(result.withdrawn)} withdrawn — past orders keep them.`
          : '';

      toast.success(
        result.status === 'ACTIVE'
          ? `Saved and back on sale.${added}${gone}`
          : `Saved. It stays off sale until you put it back.${added}${gone}`,
      );

      if (result.status === 'ACTIVE') void navigate('/seller/listings');
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, 'That listing could not be saved.'));
    },
  });

  const save = (finish: 'PAUSED' | 'ACTIVE'): void => {
    saveTarget.current = finish;
    saveMutation.mutate(finish);
  };

  // --- The matrix ---------------------------------------------------------

  const offered: VariantTemplateAxis[] = view.template?.axes ?? [];
  const activeKeys = useMemo(() => new Set(axes.map((axis) => axis.axisKey)), [axes]);

  const existingSignatures = useMemo(
    () => new Set(view.variants.map((row) => row.optionSignature)),
    [view.variants],
  );

  /**
   * Add the combinations these axes describe and keep every row already here.
   *
   * The whole point: a seller adding size 10 to a run of 7–9 ends up with four
   * rows of which three are untouched — same ids, same stock, same history —
   * and one is new. Regenerating the table would look identical and lose all
   * of it.
   */
  const buildMissing = (): void => {
    const combinations = axes
      .filter((axis) => axis.values.length > 0)
      .reduce<Record<string, string>[]>(
        (acc, axis) =>
          acc.flatMap((partial) =>
            axis.values.map((value) => ({
              ...partial,
              [axis.axisKey]:
                value.amount !== null &&
                value.amount !== undefined &&
                value.unit !== null &&
                value.unit !== undefined
                  ? `${value.amount} ${value.unit}`
                  : value.label,
            })),
          ),
        [{}],
      );

    const held = new Set(rows.map((row) => row.optionSignature));
    const additions: EditableRow[] = [];

    for (const options of combinations) {
      const optionSignature = signatureOf(options);
      if (held.has(optionSignature)) continue;
      held.add(optionSignature);

      additions.push({
        optionSignature,
        options,
        name: Object.values(options).join(' / '),
        sku: '',
        barcode: null,
        // Off, deliberately. A generated row is a suggestion; the seller says
        // which they actually stock, and nothing unticked can be bought.
        // "Not offered" and "out of stock" are different answers.
        isActive: false,
        priceMinor: view.terms.priceMinor,
        compareAtPriceMinor: null,
        minOrderQty: null,
        qtyIncrement: null,
        maxOrderQty: null,
        leadTimeDays: null,
        stock: [],
        origin: null,
      });
    }

    if (additions.length === 0) {
      toast.success('Every one of those combinations is already in the table.');
      return;
    }

    setRows([...rows, ...additions]);
    touch();
  };

  const patchRow = (signature: string, next: Partial<EditableRow>): void => {
    setRows((current) =>
      current.map((row) => (row.optionSignature === signature ? { ...row, ...next } : row)),
    );
    touch();
  };

  const removeRow = (signature: string): void => {
    setRows((current) => current.filter((row) => row.optionSignature !== signature));
    touch();
  };

  const isSaving = saveMutation.isPending;
  const sellableCount = rows.filter((row) => row.isActive).length;
  const isLive = view.status === 'ACTIVE';

  return (
    <div className="space-y-6 pb-28">
      {/* --- Who and what -------------------------------------------------- */}
      <header>
        <nav aria-label="Breadcrumb" className="text-xxs text-ink-subtle">
          <Link to="/seller/listings" className="hover:text-ink">
            Listings
          </Link>
          <span aria-hidden="true"> / </span>
          <span>{view.sellerSku}</span>
          <span aria-hidden="true"> / </span>
          <span className="text-ink-muted">Edit</span>
        </nav>

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-title-xl text-ink">{view.product.name}</h1>
          <StatusBadge status={view.status} />
        </div>

        <p className="mt-1.5 text-sm text-ink-subtle">
          <span className="tabular">{view.sellerSku}</span>
          <span aria-hidden="true"> · </span>
          {view.product.categoryName}
          {view.brand !== null && (
            <>
              <span aria-hidden="true"> · </span>
              {view.brand.name}
            </>
          )}
          {view.pausedAt !== null && (
            <>
              <span aria-hidden="true"> · </span>
              Paused {new Date(view.pausedAt).toLocaleDateString()}
              {view.pausedBy !== null && ` by ${view.pausedBy}`}
            </>
          )}
        </p>
      </header>

      {/* --- What can be changed right now ---------------------------------- */}
      {isLive ? (
        <div className="rounded-lg border border-warning/40 bg-warning-soft px-6 py-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 max-w-prose">
              <h2 className="text-title-sm text-ink">This listing is on sale</h2>
              <p className="mt-1 text-sm text-ink-muted">
                {view.structuralBlockedReason ??
                  'Pause it before changing its options or combinations.'}
              </p>
              <p className="mt-2 text-sm text-ink-muted">
                Prices, order rules and stock can still be changed without pausing — those are
                things a buyer with the page open can absorb. Adding or removing versions is not.
              </p>
            </div>

            <Button
              variant="primary"
              isLoading={pauseMutation.isPending}
              onClick={() => {
                setPauseAsked(true);
              }}
            >
              Pause &amp; edit
            </Button>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-surface-sunken px-6 py-4">
          <p className="text-sm text-ink-muted">
            <strong className="text-ink">Off sale while you work.</strong> Everything below can be
            changed. Orders already placed are unaffected — you still pack and send them.
          </p>
        </div>
      )}

      <PhotosCard view={view} isBusy={isSaving} onChanged={refresh} />

      <ProductFactsCard view={view} />

      {/* --- Price and rules ------------------------------------------------ */}
      <Card
        title="Price and order rules"
        description="What you charge for this listing, and the quantities you will accept."
      >
        <div className={BODY}>
          {!pricedHere && (
            <p className="mb-5 rounded-md border border-border bg-surface-sunken px-4 py-3 text-sm text-ink-muted">
              This listing is one particular version, so its price sits beside the others in the
              table below. The rules here apply to it.
            </p>
          )}

          <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
            {pricedHere && (
              <Field label={`Price for this listing (${view.currency})`} required>
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    aria-describedby={describedBy}
                    inputMode="decimal"
                    value={price}
                    disabled={isSaving}
                    onChange={(event) => {
                      setPrice(event.target.value);
                      touch();
                    }}
                  />
                )}
              </Field>
            )}

            {pricedHere && (
              <Field
                label={`Recommended price for this listing (${view.currency})`}
                hint="The struck-through figure. Leave empty if there is not one."
              >
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    aria-describedby={describedBy}
                    inputMode="decimal"
                    value={compareAt}
                    disabled={isSaving}
                    onChange={(event) => {
                      setCompareAt(event.target.value);
                      touch();
                    }}
                  />
                )}
              </Field>
            )}

            <Field label="Smallest order for this listing" hint="The fewest a buyer may take.">
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  inputMode="numeric"
                  value={minOrder}
                  disabled={isSaving}
                  onChange={(event) => {
                    setMinOrder(event.target.value);
                    touch();
                  }}
                />
              )}
            </Field>

            <Field label="Orders go up in steps of" hint="1 means any quantity.">
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  inputMode="numeric"
                  value={increment}
                  disabled={isSaving}
                  onChange={(event) => {
                    setIncrement(event.target.value);
                    touch();
                  }}
                />
              )}
            </Field>

            <Field label="Largest order" hint="Leave empty for no limit.">
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  inputMode="numeric"
                  value={maxOrder}
                  disabled={isSaving}
                  onChange={(event) => {
                    setMaxOrder(event.target.value);
                    touch();
                  }}
                />
              )}
            </Field>

            <Field label="Days to dispatch" hint="Working days from order to hand-over.">
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  inputMode="numeric"
                  value={handling}
                  disabled={isSaving}
                  onChange={(event) => {
                    setHandling(event.target.value);
                    touch();
                  }}
                />
              )}
            </Field>

            <Field label="Shelf life guaranteed (months)" hint="Left on it when it is sent.">
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  inputMode="numeric"
                  value={shelfLife}
                  disabled={isSaving}
                  onChange={(event) => {
                    setShelfLife(event.target.value);
                    touch();
                  }}
                />
              )}
            </Field>

            <Field label="Warranty (months)">
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  inputMode="numeric"
                  value={warranty}
                  disabled={isSaving}
                  onChange={(event) => {
                    setWarranty(event.target.value);
                    touch();
                  }}
                />
              )}
            </Field>
          </div>
        </div>
      </Card>

      {/* --- Versions ------------------------------------------------------- */}
      <Card
        title="Product variants & inventory"
        description="Every version of this product you sell, each with its own code, price and stock."
        actions={
          <Badge tone={sellableCount > 0 ? 'success' : 'neutral'}>
            {String(sellableCount)} offered
          </Badge>
        }
      >
        <div className={cx(BODY, 'space-y-6')}>
          {view.isStructuralEditAllowed ? (
            <section className="space-y-5">
              <div>
                <h3 className="text-sm font-semibold text-ink">Options a buyer chooses between</h3>
                <p className="mt-1 max-w-prose text-sm text-ink-muted">
                  Switch on the ones that change what is in the box — a size, a colour, a pack size
                  — and list only the values you actually stock. Every combination gets its own
                  code, price and stock figure, so Black in 8 can run out without taking White in 8
                  with it.
                </p>
              </div>

              {offered.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {offered.map((axis) => {
                    const isOn = activeKeys.has(axis.key);

                    return (
                      <button
                        key={axis.key}
                        type="button"
                        aria-pressed={isOn}
                        disabled={isSaving}
                        onClick={() => {
                          setAxes(
                            isOn
                              ? axes.filter((entry) => entry.axisKey !== axis.key)
                              : [...axes, { axisKey: axis.key, values: [] }],
                          );
                          touch();
                        }}
                        className={cx(
                          'rounded-full border px-3 py-1.5 text-xs transition-colors',
                          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
                          isOn
                            ? 'border-brand bg-brand-soft font-semibold text-brand'
                            : 'border-border bg-surface text-ink-subtle hover:border-brand/40 hover:text-ink',
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
                  <section
                    key={chosen.axisKey}
                    className="rounded-lg border border-border bg-surface-sunken p-4"
                  >
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <h4 className="text-sm font-semibold text-ink">{definition.label}</h4>
                      <button
                        type="button"
                        disabled={isSaving}
                        className="text-xxs text-ink-subtle underline-offset-2 hover:text-danger hover:underline"
                        onClick={() => {
                          setAxes(axes.filter((entry) => entry.axisKey !== chosen.axisKey));
                          touch();
                        }}
                      >
                        Remove this option
                      </button>
                    </div>

                    <AxisValueEditor
                      axis={definition}
                      chosen={chosen.values}
                      onChange={(values) => {
                        setAxes(
                          axes.map((entry) =>
                            entry.axisKey === chosen.axisKey ? { ...entry, values } : entry,
                          ),
                        );
                        touch();
                      }}
                    />
                  </section>
                );
              })}

              <CustomAxisAdder
                existingKeys={activeKeys}
                onAdd={(axisKey) => {
                  setAxes([...axes, { axisKey, values: [] }]);
                  touch();
                }}
              />

              <CombinationCount
                axes={axes}
                held={rows.length}
                isBusy={isSaving}
                onBuild={buildMissing}
              />
            </section>
          ) : (
            <p className="rounded-md border border-border bg-surface-sunken px-4 py-3 text-sm text-ink-muted">
              Options are locked while this listing is on sale. Prices, stock and order rules below
              can still be changed.
            </p>
          )}

          {rows.length === 0 ? (
            <p className="text-sm text-ink-muted">
              This listing has no versions yet. Switch on an option above to describe the ones you
              stock.
            </p>
          ) : (
            <section className="space-y-4 border-t border-border-subtle pt-6">
              <div>
                <h3 className="text-sm font-semibold text-ink">Every version, and what it costs</h3>
                <p className="mt-1 max-w-prose text-sm text-ink-muted">
                  Untick a version to say you do not sell it. That is a different statement from a
                  stock of zero, which says you sell it and have none — and buyers are shown the two
                  differently.
                </p>
              </div>

              <BulkBar
                rows={rows}
                locations={locations}
                sellerSku={view.sellerSku}
                isBusy={isSaving}
                onApply={(next) => {
                  setRows(next);
                  touch();
                }}
              />

              <MatrixEditor
                rows={rows}
                currency={view.currency}
                photos={view.product.images}
                locations={locations}
                primaryLocation={primaryLocation}
                existingSignatures={existingSignatures}
                canRemove={view.isStructuralEditAllowed}
                isBusy={isSaving}
                onPatch={patchRow}
                onRemove={removeRow}
              />
            </section>
          )}
        </div>
      </Card>

      {/* --- The two ways to finish ----------------------------------------- */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <p className="text-xs text-ink-subtle">
            <span className="tabular">{String(sellableCount)}</span>{' '}
            {sellableCount === 1 ? 'version' : 'versions'} offered
            {isDirty && <span className="ml-2 font-semibold text-warning">· unsaved changes</span>}
          </p>

          <div className="flex flex-wrap gap-2">
            <Button
              disabled={isSaving}
              onClick={() => {
                void navigate('/seller/listings');
              }}
            >
              Cancel
            </Button>
            <Button
              isLoading={isSaving && saveTarget.current === 'PAUSED'}
              disabled={isSaving}
              onClick={() => {
                save('PAUSED');
              }}
            >
              Save as paused
            </Button>
            <Button
              variant="primary"
              isLoading={isSaving && saveTarget.current === 'ACTIVE'}
              disabled={isSaving}
              onClick={() => {
                save('ACTIVE');
              }}
            >
              Save &amp; resume sale
            </Button>
          </div>
        </div>
      </div>

      <PauseAndEditDialog
        isOpen={pauseAsked}
        isBusy={pauseMutation.isPending}
        onCancel={() => {
          setPauseAsked(false);
        }}
        onConfirm={() => {
          setPauseAsked(false);
          pauseMutation.mutate();
        }}
      />

      <Modal
        isOpen={blocker.state === 'blocked'}
        title="Leave without saving?"
        description="The changes you have made to this listing have not been saved."
        onClose={() => {
          blocker.reset?.();
        }}
        footer={
          <>
            <Button
              onClick={() => {
                blocker.reset?.();
              }}
            >
              Keep editing
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setIsDirty(false);
                blocker.proceed?.();
              }}
            >
              Leave and lose them
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-muted">
          Nothing has been sent to the marketplace. Going back now throws away the prices, codes and
          stock figures you have typed on this screen.
        </p>
      </Modal>
    </div>
  );
}

/**
 * The confirmation a seller sees before a live listing comes off sale.
 *
 * Its own component because the wording is the feature: a seller told only
 * "this will be paused" reads it as "my orders will stop", which is not true
 * and is the reason people avoid the button.
 */
export function PauseAndEditDialog({
  isOpen,
  isBusy,
  onCancel,
  onConfirm,
}: {
  isOpen: boolean;
  isBusy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): React.JSX.Element {
  return (
    <Modal
      isOpen={isOpen}
      title="Pause this product to edit?"
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" isLoading={isBusy} onClick={onConfirm}>
            Pause &amp; Edit
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-ink">
          This product is currently on sale. Structural changes require the listing to be paused
          temporarily. Existing orders will not be affected.
        </p>
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink-muted">
          <li>It disappears from search and cannot be added to a basket.</li>
          <li>
            <strong className="text-ink">Orders already placed are not affected.</strong> You still
            pack and send them as normal.
          </li>
          <li>Your stock, product codes and sales history are all kept.</li>
          <li>Put it back on sale yourself with “Save &amp; resume sale”.</li>
        </ul>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Photographs
// ---------------------------------------------------------------------------

/**
 * The pictures on this product, and how to change them.
 *
 * Uploaded one at a time and saved immediately rather than with the rest of
 * the form. A photograph is bytes, not a field: holding it until Save would
 * mean keeping megabytes in memory while a seller re-prices forty rows, and
 * losing it if they close the tab.
 */
function PhotosCard({
  view,
  isBusy,
  onChanged,
}: {
  view: ListingEditView;
  isBusy: boolean;
  onChanged: () => Promise<void>;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);

  const upload = useMutation({
    mutationFn: (file: File) => addListingPhoto(view.offerId, file),
    onSuccess: async () => {
      await onChanged();
      toast.success('Photograph added.');
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, 'That picture could not be added.'));
    },
  });

  const remove = useMutation({
    mutationFn: (mediaId: string) => removeListingPhoto(view.offerId, mediaId),
    onSuccess: async () => {
      await onChanged();
      toast.success('Photograph removed.');
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, 'That picture could not be removed.'));
    },
  });

  const makePrimary = useMutation({
    mutationFn: (mediaId: string) => setPrimaryListingPhoto(view.offerId, mediaId),
    onSuccess: async () => {
      await onChanged();
      toast.success('That is now the main picture.');
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, 'That picture could not be made the main one.'));
    },
  });

  const working = upload.isPending || remove.isPending || makePrimary.isPending || isBusy;
  const canEdit = view.product.canEditPhotos;

  return (
    <Card
      title="Photographs"
      description="What a buyer sees in search results and on the product page."
      actions={
        canEdit ? (
          <Button
            isLoading={upload.isPending}
            disabled={working}
            onClick={() => {
              fileInput.current?.click();
            }}
          >
            Add a photograph
          </Button>
        ) : undefined
      }
    >
      <div className={BODY}>
        {!canEdit && (
          <p className="mb-4 rounded-md border border-border bg-surface-sunken px-4 py-3 text-sm text-ink-muted">
            These pictures belong to a catalogue entry somebody else described, and other sellers
            show them too. Ask the marketplace if one of them is wrong.
          </p>
        )}

        {view.product.images.length === 0 ? (
          <p className="text-sm text-ink-muted">
            No photographs yet. A listing with none shows a grey box in search results, and cannot
            go back on sale.
          </p>
        ) : (
          <ul
            aria-label="Photographs on this product"
            className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4"
          >
            {view.product.images.map((image) => (
              <li
                key={image.mediaId}
                className="relative overflow-hidden rounded-lg border border-border bg-surface-sunken"
              >
                <img
                  src={image.url}
                  alt={image.altText ?? ''}
                  loading="lazy"
                  className="aspect-square w-full object-cover"
                />

                {image.isPrimary && (
                  <span className="absolute left-2 top-2">
                    <Badge tone="brand">main</Badge>
                  </span>
                )}

                {canEdit && (
                  <div className="flex items-center justify-between gap-1 border-t border-border bg-surface px-2 py-1.5">
                    <button
                      type="button"
                      disabled={working || image.isPrimary}
                      className={cx(
                        'rounded px-1.5 py-0.5 text-xxs transition-colors',
                        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand',
                        image.isPrimary
                          ? 'cursor-default text-ink-subtle'
                          : 'text-ink-muted hover:text-brand',
                      )}
                      onClick={() => {
                        makePrimary.mutate(image.mediaId);
                      }}
                    >
                      {image.isPrimary ? 'Shown first' : 'Show first'}
                    </button>

                    <button
                      type="button"
                      disabled={working || view.product.images.length === 1}
                      title={
                        view.product.images.length === 1
                          ? 'Add the replacement first — a product needs at least one picture.'
                          : undefined
                      }
                      className="rounded px-1.5 py-0.5 text-xxs text-ink-muted transition-colors hover:text-danger focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand disabled:text-ink-subtle"
                      onClick={() => {
                        remove.mutate(image.mediaId);
                      }}
                    >
                      Remove
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {canEdit && (
          <>
            <input
              ref={fileInput}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                // Cleared so choosing the same file twice fires again — a
                // seller who cropped it and picked it once more expects the new
                // bytes, and an unchanged input value is silent.
                event.target.value = '';
                if (file !== undefined) upload.mutate(file);
              }}
            />
            <p className="mt-4 text-xxs text-ink-subtle">
              JPEG, PNG or WebP. The first picture is the one buyers see in search results — use
              “Show first” to change it.
            </p>
          </>
        )}
      </div>
    </Card>
  );
}

/**
 * The catalogue's own description of the thing, filled in and read-only.
 *
 * Shown rather than hidden because a seller opening "Edit" needs to see what
 * they are editing; read-only because several sellers share one product page
 * and one of them renaming it would change what the others are selling.
 */
function ProductFactsCard({ view }: { view: ListingEditView }): React.JSX.Element {
  const facts: { label: string; value: string }[] = [
    { label: 'Product name', value: view.product.name },
    { label: 'Department', value: view.product.categoryName },
    { label: 'Brand', value: view.brand?.name ?? '—' },
    { label: 'Barcode (GTIN)', value: view.product.gtin ?? '—' },
    { label: 'Model', value: view.product.modelIdentifier ?? '—' },
    {
      label: 'Weight',
      value: view.product.weightGrams === null ? '—' : `${String(view.product.weightGrams)} g`,
    },
    {
      label: 'Packed as',
      value: view.product.packaging?.packingRawText ?? view.product.packaging?.packingType ?? '—',
    },
    { label: 'Sold in', value: view.terms.orderingUnit.toLowerCase() },
  ];

  return (
    <Card
      title="What you are selling"
      description="The catalogue's description of this product. Several sellers can offer the same one, so changing it goes through the marketplace."
    >
      <div className={BODY}>
        <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
          {facts.map((fact) => (
            <div key={fact.label} className="min-w-0">
              <dt className="text-xxs uppercase tracking-wide text-ink-subtle">{fact.label}</dt>
              <dd className="mt-1 truncate text-sm text-ink" title={fact.value}>
                {fact.value}
              </dd>
            </div>
          ))}
        </dl>

        {view.product.shortDescription !== null && view.product.shortDescription !== '' && (
          <p className="mt-5 max-w-prose border-t border-border-subtle pt-5 text-sm text-ink-muted">
            {view.product.shortDescription}
          </p>
        )}

        {view.product.specifications.length > 0 && (
          <div className="mt-5 border-t border-border-subtle pt-5">
            <h3 className="text-xxs uppercase tracking-wide text-ink-subtle">Specifications</h3>
            <dl className="mt-3 grid gap-x-8 gap-y-2 sm:grid-cols-2">
              {view.product.specifications.map((spec) => (
                <div
                  key={spec.name}
                  className="flex items-baseline justify-between gap-4 border-b border-border-subtle pb-2 text-sm"
                >
                  <dt className="text-ink-muted">{spec.name}</dt>
                  <dd className="text-right text-ink">{spec.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </div>
    </Card>
  );
}

/**
 * How many rows the seller is about to have to fill in, before they have them.
 *
 * The count comes before the table on purpose. Four sizes and three colours is
 * twelve rows, each needing a code, a price and a stock figure, and a seller
 * who discovers that after the table appears has already lost the argument.
 */
function CombinationCount({
  axes,
  held,
  isBusy,
  onBuild,
}: {
  axes: DraftVariantAxis[];
  held: number;
  isBusy: boolean;
  onBuild: () => void;
}): React.JSX.Element | null {
  const [confirming, setConfirming] = useState(false);

  const WARN_ABOVE = 100;
  const MAXIMUM = 500;

  if (axes.length === 0) return null;

  const total = axes.reduce(
    (product, axis) => (axis.values.length === 0 ? product : product * axis.values.length),
    axes.every((axis) => axis.values.length === 0) ? 0 : 1,
  );

  const tooMany = total > MAXIMUM;
  const needsConfirmation = total > WARN_ABOVE;

  return (
    <div className="rounded-lg border border-brand/30 bg-brand-soft/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-ink">
            {total === 0
              ? 'No combinations yet'
              : `${String(total)} ${total === 1 ? 'combination' : 'combinations'}`}
          </p>
          <p className="mt-0.5 text-xxs text-ink-subtle">
            {axes
              .filter((axis) => axis.values.length > 0)
              .map((axis) => `${axis.axisKey} × ${String(axis.values.length)}`)
              .join('  ·  ') || 'Add values to each option above.'}
            {held > 0 && ` · ${String(held)} already in the table`}
          </p>
        </div>

        <Button
          variant="primary"
          isLoading={isBusy}
          disabled={total === 0 || tooMany}
          onClick={() => {
            if (needsConfirmation) {
              setConfirming(true);
              return;
            }
            onBuild();
          }}
        >
          Add missing combinations
        </Button>
      </div>

      {tooMany && (
        <p role="alert" className="mt-3 text-xs text-danger">
          That is {total} combinations and {MAXIMUM} is the most one listing can hold. Remove an
          option, or split this into separate listings.
        </p>
      )}

      {confirming && (
        <div
          role="alertdialog"
          aria-label="That is a large table"
          className="mt-3 rounded-md border border-warning/40 bg-warning-soft p-3"
        >
          <p className="text-xs text-ink">
            That would leave you with {total} rows, and each one needs its own code, price and stock
            figure before this listing can go back on sale.
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              onClick={() => {
                setConfirming(false);
              }}
            >
              Not yet
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                setConfirming(false);
                onBuild();
              }}
            >
              Add them
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Set one figure across every row at once.
 *
 * A forty-row table where the same price is typed forty times is a table with
 * thirty-nine correct prices and one that was missed, and the one that was
 * missed is the one a buyer orders.
 */
function BulkBar({
  rows,
  locations,
  sellerSku,
  isBusy,
  onApply,
}: {
  rows: EditableRow[];
  locations: SellerLocation[];
  sellerSku: string;
  isBusy: boolean;
  onApply: (rows: EditableRow[]) => void;
}): React.JSX.Element {
  const [price, setPrice] = useState('');
  const [stock, setStock] = useState('');
  const [locationId, setLocationId] = useState(locations[0]?.id ?? '');

  const effectiveLocation = locationId === '' ? (locations[0]?.id ?? '') : locationId;

  return (
    <div className="rounded-lg border border-border bg-surface-sunken p-4">
      <h4 className="text-xxs uppercase tracking-wide text-ink-subtle">Change every row at once</h4>

      <div className="mt-3 flex flex-wrap items-end gap-x-3 gap-y-4">
        <div className="flex items-end gap-2">
          <div className="w-28">
            <Field label="Price">
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  inputMode="decimal"
                  placeholder="0.00"
                  value={price}
                  disabled={isBusy}
                  onChange={(event) => {
                    setPrice(event.target.value);
                  }}
                />
              )}
            </Field>
          </div>
          <Button
            disabled={isBusy || price.trim() === ''}
            onClick={() => {
              const minor = majorToMinor(price);
              if (minor === null) return;
              onApply(rows.map((row) => ({ ...row, priceMinor: minor })));
              setPrice('');
            }}
          >
            Apply
          </Button>
        </div>

        <div className="flex items-end gap-2">
          <div className="w-24">
            <Field label="Stock">
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  inputMode="numeric"
                  placeholder="0"
                  value={stock}
                  disabled={isBusy}
                  onChange={(event) => {
                    setStock(event.target.value);
                  }}
                />
              )}
            </Field>
          </div>

          {locations.length > 1 && (
            <div className="w-44">
              <Field label="Warehouse">
                {({ inputId, describedBy }) => (
                  <Select
                    id={inputId}
                    aria-describedby={describedBy}
                    value={effectiveLocation}
                    disabled={isBusy}
                    onChange={(event) => {
                      setLocationId(event.target.value);
                    }}
                  >
                    {locations.map((location) => (
                      <option key={location.id} value={location.id}>
                        {location.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
          )}

          <Button
            disabled={isBusy || stock.trim() === '' || effectiveLocation === ''}
            onClick={() => {
              const quantity = Number.parseInt(stock, 10);
              if (!Number.isFinite(quantity) || quantity < 0) return;

              onApply(
                rows.map((row) => ({
                  ...row,
                  stock: [
                    ...row.stock.filter((entry) => entry.locationId !== effectiveLocation),
                    { locationId: effectiveLocation, availableQuantity: quantity },
                  ],
                })),
              );
              setStock('');
            }}
          >
            Apply
          </Button>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <Button
            disabled={isBusy}
            onClick={() => {
              onApply(rows.map((row) => ({ ...row, isActive: true })));
            }}
          >
            Offer all
          </Button>

          <Button
            disabled={isBusy || sellerSku === ''}
            onClick={() => {
              // Only the blanks. A code the seller typed — or one their
              // warehouse already prints on a label — is never overwritten by
              // a generated one.
              const taken = new Set(
                rows.map((row) => row.sku.trim().toUpperCase()).filter((sku) => sku !== ''),
              );

              onApply(
                rows.map((row) => {
                  if (row.sku.trim() !== '') return row;

                  const base = [sellerSku, ...Object.values(row.options)]
                    .map((part) =>
                      part
                        .toUpperCase()
                        .replace(/[^A-Z0-9]+/g, '')
                        .slice(0, 6),
                    )
                    .filter((part) => part !== '')
                    .join('-')
                    .slice(0, 64);

                  let candidate = base;
                  for (let suffix = 2; taken.has(candidate.toUpperCase()); suffix += 1) {
                    candidate = `${base.slice(0, 60)}-${String(suffix)}`;
                  }

                  taken.add(candidate.toUpperCase());
                  return { ...row, sku: candidate };
                }),
              );
            }}
          >
            Fill in missing codes
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

/**
 * Every combination, and the things that differ between them.
 *
 * A table from `lg` up and a stack of cards below it. The columns that matter —
 * is it offered, what does it cost, how many are there — read fine in a row on
 * a laptop and are unusable as a nine-column horizontal scroll on a phone,
 * which is exactly where a stock count is most often corrected.
 *
 * Stock is per warehouse in the data and edited here against one: the first, or
 * whichever the seller chose in the bulk bar. Three columns of stock would make
 * the common case — one warehouse — unreadable, and the stock screen is where a
 * ledger across warehouses belongs.
 */
function MatrixEditor({
  rows,
  currency,
  photos,
  locations,
  primaryLocation,
  existingSignatures,
  canRemove,
  isBusy,
  onPatch,
  onRemove,
}: {
  rows: EditableRow[];
  currency: string;
  photos: ListingEditView['product']['images'];
  locations: SellerLocation[];
  primaryLocation: string;
  existingSignatures: ReadonlySet<string>;
  canRemove: boolean;
  isBusy: boolean;
  onPatch: (signature: string, next: Partial<EditableRow>) => void;
  onRemove: (signature: string) => void;
}): React.JSX.Element {
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle === '') return rows;

    return rows.filter(
      (row) =>
        row.sku.toLowerCase().includes(needle) ||
        row.name.toLowerCase().includes(needle) ||
        Object.values(row.options).some((value) => value.toLowerCase().includes(needle)),
    );
  }, [rows, filter]);

  const stockAt = (row: EditableRow): number =>
    row.stock.find((entry) => entry.locationId === primaryLocation)?.availableQuantity ??
    row.stock[0]?.availableQuantity ??
    0;

  const setStock = (row: EditableRow, next: number): void => {
    const locationId = row.stock[0]?.locationId ?? primaryLocation;
    if (locationId === '') return;

    onPatch(row.optionSignature, {
      stock: [
        ...row.stock.filter((entry) => entry.locationId !== locationId),
        { locationId, availableQuantity: next },
      ],
    });
  };

  return (
    <div className="space-y-4">
      {rows.length > 6 && (
        <div className="max-w-sm">
          <Field label="Find a version" hint="By code, by name or by any option value.">
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                value={filter}
                placeholder="8, Black, SHOE-BLK…"
                onChange={(event) => {
                  setFilter(event.target.value);
                }}
              />
            )}
          </Field>
        </div>
      )}

      {/* --- Laptop and up -------------------------------------------------- */}
      {/*
        `table-fixed`, and every width declared on the header cell.

        The inputs inside carry `w-full` from the shared control, which beats
        any width put on the element itself — so the column is what has to be
        sized. Without this a product code renders as "NK-001-E…" in a box two
        thirds the width of the text, which is the one thing a seller in this
        table most needs to read.
      */}
      <div className="hidden overflow-x-auto rounded-lg border border-border lg:block">
        <table className="w-full min-w-[64rem] table-fixed border-collapse text-sm">
          <caption className="sr-only">
            Every version of this listing, with its code, price and stock
          </caption>
          <thead>
            <tr className="border-b border-border bg-surface-sunken text-left text-xxs uppercase tracking-wide text-ink-subtle">
              <th scope="col" className="w-14 px-3 py-2.5 font-semibold">
                Offer
              </th>
              <th scope="col" className="w-64 px-3 py-2.5 font-semibold">
                Version
              </th>
              <th scope="col" className="w-48 px-3 py-2.5 font-semibold">
                Product code
              </th>
              <th scope="col" className="w-32 px-3 py-2.5 font-semibold">
                Price ({currency})
              </th>
              <th scope="col" className="w-32 px-3 py-2.5 font-semibold">
                Recommended
              </th>
              <th scope="col" className="w-24 px-3 py-2.5 font-semibold">
                Stock
              </th>
              <th scope="col" className="w-28 px-3 py-2.5 font-semibold">
                Smallest order
              </th>
              <th scope="col" className="w-32 px-3 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const isNew = !existingSignatures.has(row.optionSignature);
              const quantity = stockAt(row);
              const isOpen = expanded === row.optionSignature;

              return (
                <tr
                  key={row.optionSignature}
                  className={cx(
                    'border-b border-border-subtle align-top transition-colors',
                    row.isActive ? 'bg-surface' : 'bg-surface-sunken/60',
                  )}
                >
                  <td className="px-3 py-3">
                    <input
                      type="checkbox"
                      checked={row.isActive}
                      aria-label={`Offer ${rowLabel(row)}`}
                      disabled={isBusy}
                      className="mt-2.5 h-4 w-4 accent-[var(--brand)]"
                      onChange={(event) => {
                        onPatch(row.optionSignature, { isActive: event.target.checked });
                      }}
                    />
                  </td>

                  <td className="px-3 py-3">
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span
                        className={cx('font-medium', row.isActive ? 'text-ink' : 'text-ink-subtle')}
                      >
                        {row.name === '' ? 'No particular version' : row.name}
                      </span>
                      {isNew && <Badge tone="brand">new</Badge>}
                      {!row.isActive && !isNew && <Badge tone="neutral">not offered</Badge>}
                      {row.isActive && quantity === 0 && <Badge tone="warning">out of stock</Badge>}
                    </div>
                    {row.origin?.isOrderLinked === true && (
                      <p className="mt-1 text-xxs text-ink-subtle">ordered before</p>
                    )}

                    {isOpen && (
                      <div className="mt-3">
                        <MoreFields row={row} photos={photos} isBusy={isBusy} onPatch={onPatch} />
                      </div>
                    )}
                  </td>

                  <td className="px-3 py-3">
                    <Input
                      value={row.sku}
                      aria-label={`Product code for ${rowLabel(row)}`}
                      disabled={isBusy}
                      className="tabular"
                      onChange={(event) => {
                        onPatch(row.optionSignature, { sku: event.target.value });
                      }}
                    />
                  </td>

                  <td className="px-3 py-3">
                    <Input
                      inputMode="decimal"
                      aria-label={`Price for ${rowLabel(row)}`}
                      defaultValue={priceInput(row.priceMinor)}
                      disabled={isBusy}
                      className="text-right tabular"
                      onBlur={(event) => {
                        const minor = majorToMinor(event.target.value);
                        if (minor === null && event.target.value.trim() !== '') return;
                        onPatch(row.optionSignature, { priceMinor: minor });
                      }}
                    />
                  </td>

                  <td className="px-3 py-3">
                    <Input
                      inputMode="decimal"
                      aria-label={`Recommended price for ${rowLabel(row)}`}
                      defaultValue={priceInput(row.compareAtPriceMinor)}
                      disabled={isBusy}
                      className="text-right tabular"
                      onBlur={(event) => {
                        const raw = event.target.value.trim();
                        onPatch(row.optionSignature, {
                          compareAtPriceMinor: raw === '' ? null : majorToMinor(raw),
                        });
                      }}
                    />
                  </td>

                  <td className="px-3 py-3">
                    <Input
                      inputMode="numeric"
                      aria-label={`Stock for ${rowLabel(row)}`}
                      defaultValue={String(quantity)}
                      disabled={isBusy || locations.length === 0}
                      className="text-right tabular"
                      onBlur={(event) => {
                        const next = parseWhole(event.target.value);
                        if (next === null) return;
                        setStock(row, next);
                      }}
                    />
                  </td>

                  <td className="px-3 py-3">
                    <Input
                      inputMode="numeric"
                      aria-label={`Smallest order for ${rowLabel(row)}`}
                      defaultValue={numberInput(row.minOrderQty)}
                      disabled={isBusy}
                      className="text-right tabular"
                      onBlur={(event) => {
                        onPatch(row.optionSignature, {
                          minOrderQty: parseWhole(event.target.value),
                        });
                      }}
                    />
                  </td>

                  <td className="whitespace-nowrap px-3 py-3 text-right">
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      className="mt-2.5 rounded px-1.5 py-0.5 text-xxs text-ink-muted hover:text-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand"
                      onClick={() => {
                        setExpanded(isOpen ? null : row.optionSignature);
                      }}
                    >
                      {isOpen ? 'Less' : 'More'}
                    </button>

                    {canRemove && row.origin?.isBaseListing !== true && (
                      <button
                        type="button"
                        disabled={isBusy}
                        aria-label={`Remove ${rowLabel(row)}`}
                        title={
                          row.origin?.isOrderLinked === true
                            ? 'Somebody has ordered this. It is kept for their order and hidden from new ones.'
                            : undefined
                        }
                        className="ml-1 mt-2.5 rounded px-1.5 py-0.5 text-xxs text-ink-muted hover:text-danger focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand"
                        onClick={() => {
                          onRemove(row.optionSignature);
                        }}
                      >
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* --- Phone and tablet ----------------------------------------------- */}
      <ul className="space-y-3 lg:hidden">
        {visible.map((row) => {
          const isNew = !existingSignatures.has(row.optionSignature);
          const quantity = stockAt(row);
          const isOpen = expanded === row.optionSignature;

          return (
            <li
              key={row.optionSignature}
              className={cx(
                'rounded-lg border border-border p-4',
                row.isActive ? 'bg-surface' : 'bg-surface-sunken/60',
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <label className="flex min-w-0 items-start gap-2">
                  <input
                    type="checkbox"
                    checked={row.isActive}
                    disabled={isBusy}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--brand)]"
                    onChange={(event) => {
                      onPatch(row.optionSignature, { isActive: event.target.checked });
                    }}
                  />
                  <span className="min-w-0">
                    <span
                      className={cx(
                        'block font-medium',
                        row.isActive ? 'text-ink' : 'text-ink-subtle',
                      )}
                    >
                      {row.name === '' ? 'No particular version' : row.name}
                    </span>
                    <span className="mt-1 flex flex-wrap gap-1.5">
                      {isNew && <Badge tone="brand">new</Badge>}
                      {!row.isActive && !isNew && <Badge tone="neutral">not offered</Badge>}
                      {row.isActive && quantity === 0 && <Badge tone="warning">out of stock</Badge>}
                    </span>
                  </span>
                </label>

                {canRemove && row.origin?.isBaseListing !== true && (
                  <button
                    type="button"
                    disabled={isBusy}
                    aria-label={`Remove ${rowLabel(row)}`}
                    className="shrink-0 rounded px-1.5 py-0.5 text-xxs text-ink-muted hover:text-danger"
                    onClick={() => {
                      onRemove(row.optionSignature);
                    }}
                  >
                    Remove
                  </button>
                )}
              </div>

              <div className="mt-3 grid grid-cols-2 gap-3">
                <Field label="Product code">
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      aria-describedby={describedBy}
                      value={row.sku}
                      disabled={isBusy}
                      onChange={(event) => {
                        onPatch(row.optionSignature, { sku: event.target.value });
                      }}
                    />
                  )}
                </Field>

                <Field label={`Price (${currency})`}>
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      aria-describedby={describedBy}
                      inputMode="decimal"
                      defaultValue={priceInput(row.priceMinor)}
                      disabled={isBusy}
                      onBlur={(event) => {
                        const minor = majorToMinor(event.target.value);
                        if (minor === null && event.target.value.trim() !== '') return;
                        onPatch(row.optionSignature, { priceMinor: minor });
                      }}
                    />
                  )}
                </Field>

                <Field label="Stock">
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      aria-describedby={describedBy}
                      inputMode="numeric"
                      defaultValue={String(quantity)}
                      disabled={isBusy || locations.length === 0}
                      onBlur={(event) => {
                        const next = parseWhole(event.target.value);
                        if (next === null) return;
                        setStock(row, next);
                      }}
                    />
                  )}
                </Field>

                <Field label="Smallest order">
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      aria-describedby={describedBy}
                      inputMode="numeric"
                      defaultValue={numberInput(row.minOrderQty)}
                      disabled={isBusy}
                      onBlur={(event) => {
                        onPatch(row.optionSignature, {
                          minOrderQty: parseWhole(event.target.value),
                        });
                      }}
                    />
                  )}
                </Field>
              </div>

              <button
                type="button"
                aria-expanded={isOpen}
                className="mt-3 text-xxs text-ink-muted underline-offset-2 hover:text-brand hover:underline"
                onClick={() => {
                  setExpanded(isOpen ? null : row.optionSignature);
                }}
              >
                {isOpen ? 'Fewer settings' : 'More settings'}
              </button>

              {isOpen && (
                <div className="mt-3">
                  <MoreFields row={row} photos={photos} isBusy={isBusy} onPatch={onPatch} />
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {visible.length === 0 && (
        <p className="text-sm text-ink-muted">Nothing in this table matches “{filter}”.</p>
      )}

      <p className="text-xxs text-ink-subtle">
        Removing a version you have sold before keeps it on the orders it appears on — it simply
        stops being offered. New versions are created off sale, whichever button you finish with.
      </p>
    </div>
  );
}

/**
 * The settings most rows never need.
 *
 * Behind "More" rather than in the table, because a thirteen-column grid where
 * three columns are empty on every row is a grid nobody can read — and these
 * genuinely do differ per version: a pallet quantity sold in tens beside a
 * single sold in ones, a size made to order beside one on the shelf.
 */
function MoreFields({
  row,
  photos,
  isBusy,
  onPatch,
}: {
  row: EditableRow;
  photos: ListingEditView['product']['images'];
  isBusy: boolean;
  onPatch: (signature: string, next: Partial<EditableRow>) => void;
}): React.JSX.Element {
  return (
    <div className="grid gap-x-4 gap-y-3 rounded-lg border border-border bg-surface-sunken p-3 sm:grid-cols-2">
      <Field label="Steps of" hint="Blank uses the listing's rule.">
        {({ inputId, describedBy }) => (
          <Input
            id={inputId}
            aria-describedby={describedBy}
            inputMode="numeric"
            defaultValue={numberInput(row.qtyIncrement)}
            disabled={isBusy}
            onBlur={(event) => {
              onPatch(row.optionSignature, { qtyIncrement: parseWhole(event.target.value) });
            }}
          />
        )}
      </Field>

      <Field label="Largest order">
        {({ inputId, describedBy }) => (
          <Input
            id={inputId}
            aria-describedby={describedBy}
            inputMode="numeric"
            defaultValue={numberInput(row.maxOrderQty)}
            disabled={isBusy}
            onBlur={(event) => {
              onPatch(row.optionSignature, { maxOrderQty: parseWhole(event.target.value) });
            }}
          />
        )}
      </Field>

      <Field label="Days to make or bring in" hint="Only where this version takes longer.">
        {({ inputId, describedBy }) => (
          <Input
            id={inputId}
            aria-describedby={describedBy}
            inputMode="numeric"
            defaultValue={numberInput(row.leadTimeDays)}
            disabled={isBusy}
            onBlur={(event) => {
              onPatch(row.optionSignature, { leadTimeDays: parseWhole(event.target.value) });
            }}
          />
        )}
      </Field>

      <Field label="Barcode (GTIN)" hint="The real one on the box, or nothing.">
        {({ inputId, describedBy }) => (
          <Input
            id={inputId}
            aria-describedby={describedBy}
            defaultValue={row.barcode ?? ''}
            disabled={isBusy}
            onBlur={(event) => {
              const raw = event.target.value.trim();
              onPatch(row.optionSignature, { barcode: raw === '' ? null : raw });
            }}
          />
        )}
      </Field>

      <Field label="Shipping weight (g)">
        {({ inputId, describedBy }) => (
          <Input
            id={inputId}
            aria-describedby={describedBy}
            inputMode="numeric"
            defaultValue={numberInput(row.shippingWeightGrams)}
            disabled={isBusy}
            onBlur={(event) => {
              onPatch(row.optionSignature, {
                shippingWeightGrams: parseWhole(event.target.value),
              });
            }}
          />
        )}
      </Field>

      {photos.length > 0 && (
        <Field label="Picture for this version" hint="Falls back to the main one.">
          {({ inputId, describedBy }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              value={row.mediaId ?? ''}
              disabled={isBusy}
              onChange={(event) => {
                onPatch(row.optionSignature, {
                  mediaId: event.target.value === '' ? null : event.target.value,
                });
              }}
            >
              <option value="">Use the main picture</option>
              {photos.map((photo, index) => (
                <option key={photo.mediaId} value={photo.mediaId}>
                  {photo.altText ?? `Photograph ${String(index + 1)}`}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: ListingEditView['status'] }): React.JSX.Element {
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

/**
 * The wizard step where a seller says what combinations they actually sell.
 *
 * This is the screen the whole variant feature exists for. A shirt is not one
 * thing with a size written on it - it is twelve things, each with its own
 * code, its own price and its own pile of stock in its own warehouse - and
 * until a seller can say that here, a buyer cannot be shown a size picker
 * that means anything.
 *
 * ---
 *
 * THREE RULES THIS SCREEN FOLLOWS
 *
 * **Nothing is invented.** The template suggests axes and suggests values, and
 * every one of them arrives switched OFF. A footwear template offers sizes 5
 * to 12; it does not tick them. A seller who stocks 8 and 9 ends up with two
 * combinations, not eight, because the alternative - generating a full size
 * run and letting them delete what they do not have - produces a catalogue
 * full of sizes nobody checked. "Not offered" and "out of stock" are different
 * answers to a buyer and only the seller knows which is true.
 *
 * **The Cartesian product is shown before it is built.** Three axes with six
 * values each is 216 rows, and a seller who discovers that after the table has
 * been generated has already lost their place. The count is projected from the
 * chosen values and the generate button says what it is about to make.
 *
 * **Editing never discards.** Regenerating after adding a colour keeps every
 * price and every stock figure already typed, matched by option signature.
 * Starting again is a separate, confirmed action, because an afternoon of
 * typing is the most expensive thing on this page.
 *
 * The server owns the truth throughout: it re-keys every row, recomputes every
 * signature, and returns the issues rendered at the bottom. Nothing here
 * decides whether the matrix is valid - it only shows what the server decided.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, Field, Input, Select } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';
import { errorMessage } from '@/lib/errors';
import { majorToMinor, minorToMajor } from '@/lib/format';
import {
  fetchLocations,
  generateVariantMatrix,
  saveDraft,
  type DraftVariantAxis,
  type DraftVariantRow,
  type DraftView,
  type SellerLocation,
  type VariantTemplateAxis,
} from '@/lib/seller';

// ---------------------------------------------------------------------------
// Value editing
// ---------------------------------------------------------------------------

/** The label a value carries, with its unit where it has one. */
function valueText(value: DraftVariantAxis['values'][number]): string {
  const amount = value.amount ?? '';
  const unit = value.unit ?? '';
  if (amount !== '' && unit !== '') return `${amount} ${unit}`;
  if (amount !== '') return amount;
  return value.label;
}

/**
 * The values for one axis: suggestions to tick, plus anything the seller types.
 *
 * Suggestions are chips rather than a list with checkboxes because a size run
 * is fifteen items and a column of checkboxes fifteen tall pushes everything
 * else off the screen. The chip that is on is filled; the chip that is off is
 * outlined, and it says so in text as well as colour - a colourblind seller
 * ticking sizes must not be guessing.
 */
export function AxisValueEditor({
  axis,
  chosen,
  onChange,
}: {
  axis: VariantTemplateAxis;
  chosen: DraftVariantAxis['values'];
  onChange: (values: DraftVariantAxis['values']) => void;
}): React.JSX.Element {
  const [custom, setCustom] = useState('');
  const [unit, setUnit] = useState(axis.units?.[0] ?? '');

  const chosenText = useMemo(
    () => new Set(chosen.map((value) => valueText(value).toLowerCase())),
    [chosen],
  );

  const toggle = (label: string): void => {
    const key = label.toLowerCase();
    if (chosenText.has(key)) {
      onChange(chosen.filter((value) => valueText(value).toLowerCase() !== key));
      return;
    }
    onChange([...chosen, { label }]);
  };

  const addCustom = (): void => {
    const label = custom.trim();
    if (label === '') return;

    const entry: DraftVariantAxis['values'][number] =
      axis.input === 'MEASUREMENT' && unit !== ''
        ? { label, amount: label, unit }
        : { label };

    if (chosenText.has(valueText(entry).toLowerCase())) {
      setCustom('');
      return;
    }

    onChange([...chosen, entry]);
    setCustom('');
  };

  return (
    <div className="space-y-3">
      {(axis.suggestions ?? []).length > 0 && (
        <div className="flex flex-wrap gap-2">
          {(axis.suggestions ?? []).map((suggestion) => {
            const isOn = chosenText.has(suggestion.toLowerCase());

            return (
              <button
                key={suggestion}
                type="button"
                aria-pressed={isOn}
                onClick={() => {
                  toggle(suggestion);
                }}
                className={cx(
                  'rounded-full border px-3 py-1 text-xs transition-colors',
                  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
                  isOn
                    ? 'border-brand bg-brand-soft font-semibold text-brand'
                    : 'border-line bg-surface text-ink-subtle hover:border-brand/40 hover:text-ink',
                )}
              >
                {/* The tick is what says "chosen" without relying on the fill
                    colour, which a colourblind seller may not see at all. */}
                <span aria-hidden="true">{isOn ? '✓ ' : ''}</span>
                {suggestion}
              </button>
            );
          })}
        </div>
      )}

      {axis.allowsCustomValues && (
        <div className="flex flex-wrap items-end gap-2">
          <Field label={`Add another ${axis.label.toLowerCase()}`}>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                value={custom}
                placeholder={axis.input === 'MEASUREMENT' ? 'e.g. 240' : 'Type a value'}
                onChange={(event) => {
                  setCustom(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return;
                  // The seller is inside a wizard with a submit button. Enter
                  // here means "add this value", not "send the listing".
                  event.preventDefault();
                  addCustom();
                }}
              />
            )}
          </Field>

          {axis.input === 'MEASUREMENT' && (axis.units ?? []).length > 0 && (
            <Field label="Unit">
              {({ inputId, describedBy }) => (
                <Select
                  id={inputId}
                  aria-describedby={describedBy}
                  value={unit}
                  onChange={(event) => {
                    setUnit(event.target.value);
                  }}
                >
                  {(axis.units ?? []).map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}

          <Button
            onClick={() => {
              addCustom();
            }}
          >
            Add
          </Button>
        </div>
      )}

      {chosen.length > 0 && (
        <div className="rounded-md border border-line bg-surface-sunken p-3">
          <p className="text-xxs font-semibold uppercase tracking-wide text-ink-subtle">
            You sell {chosen.length} {chosen.length === 1 ? 'value' : 'values'}
          </p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {chosen.map((value) => (
              <li key={valueText(value)}>
                <span className="inline-flex items-center gap-1 rounded-full bg-surface px-2 py-1 text-xs text-ink ring-1 ring-line">
                  {valueText(value)}
                  <button
                    type="button"
                    aria-label={`Remove ${valueText(value)}`}
                    className="text-ink-subtle hover:text-danger"
                    onClick={() => {
                      onChange(
                        chosen.filter(
                          (entry) => valueText(entry).toLowerCase() !== valueText(value).toLowerCase(),
                        ),
                      );
                    }}
                  >
                    ×
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Naming an option the department does not suggest.
 *
 * Always available, not only where there is no template. A template is a
 * starting list and cannot know every dimension a business sells along — the
 * tip on a syringe, the winding on a motor, the finish on a fitting — and a
 * marketplace that refuses to list what it did not anticipate is not a
 * marketplace. For the departments with no template at all, this is the only
 * way in, which is why it is never hidden.
 */
export function CustomAxisAdder({
  existingKeys,
  onAdd,
}: {
  existingKeys: ReadonlySet<string>;
  onAdd: (axisKey: string) => void;
}): React.JSX.Element {
  const [name, setName] = useState('');

  // The same folding the server applies, so what the seller sees added is
  // what gets stored rather than a silently different key.
  const key = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const isDuplicate = key !== '' && existingKeys.has(key);

  const add = (): void => {
    if (key === '' || isDuplicate) return;
    onAdd(key);
    setName('');
  };

  return (
    <div className="flex flex-wrap items-end gap-2 border-t border-line pt-4">
      <Field
        label="Add an option of your own"
        hint="Anything a buyer chooses between that is not listed above."
        {...(isDuplicate ? { error: 'You have already added that option.' } : {})}
      >
        {({ inputId, describedBy }) => (
          <Input
            id={inputId}
            aria-describedby={describedBy}
            value={name}
            placeholder="Tip style, winding, finish…"
            onChange={(event) => {
              setName(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              add();
            }}
          />
        )}
      </Field>
      <Button
        disabled={key === '' || isDuplicate}
        onClick={() => {
          add();
        }}
      >
        Add option
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------

export function VariantStepPanel({
  draft,
  onBack,
}: {
  draft: DraftView;
  onBack: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();

  const template = draft.variantTemplate;

  /**
   * The axes being edited, before they are generated from.
   *
   * Held locally because ticking a size is not a save - the seller is still
   * choosing, and a round trip per chip would make the form feel broken. The
   * save happens when they generate, which is also the only moment the
   * choices mean anything.
   */
  const [axes, setAxes] = useState<DraftVariantAxis[]>(draft.variantAxes ?? []);
  const [filter, setFilter] = useState('');

  /**
   * "Yes" on a department that has no suggestions to seed from.
   *
   * Local only, and deliberately: the answer becomes durable the moment the
   * seller names their first option, because that is the first thing there is
   * to save. Until then a reload asks the question again, which is a fair
   * thing to do to somebody who answered and then typed nothing.
   */
  const [answeredYes, setAnsweredYes] = useState(false);

  const locationsQuery = useQuery({
    queryKey: ['seller', 'locations'],
    queryFn: fetchLocations,
  });

  const locations: SellerLocation[] = locationsQuery.data?.locations ?? [];

  const saveMutation = useMutation({
    mutationFn: (patch: Parameters<typeof saveDraft>[1]) => saveDraft(draft.id, patch),
    onSuccess: (updated) => {
      client.setQueryData(['seller', 'draft', updated.id], updated);
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, 'That change could not be saved.'));
    },
  });

  const generateMutation = useMutation({
    mutationFn: (input: { axes: DraftVariantAxis[]; replaceExisting: boolean }) =>
      generateVariantMatrix(draft.id, input.axes, input.replaceExisting),
    onSuccess: (updated) => {
      client.setQueryData(['seller', 'draft', updated.id], updated);
      toast.success(`${updated.variants?.length ?? 0} combinations ready to price.`);
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, 'Those combinations could not be built.'));
    },
  });

  // Memoised only so the `??` does not hand a fresh array to the filter's
  // dependency list on every render, which would re-filter a 500-row matrix
  // for each keystroke elsewhere on the page.
  const rows = useMemo(() => draft.variants ?? [], [draft.variants]);

  /** Save the matrix as it now stands. Whole-array, because rows can vanish. */
  const commitRows = (next: DraftVariantRow[]): void => {
    saveMutation.mutate({ variants: next, expectedVersion: draft.version });
  };

  const patchRow = (signature: string, patch: Partial<DraftVariantRow>): void => {
    commitRows(
      rows.map((row) => (row.optionSignature === signature ? { ...row, ...patch } : row)),
    );
  };

  const visibleRows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle === '') return rows;

    return rows.filter(
      (row) =>
        row.sku.toLowerCase().includes(needle) ||
        row.name.toLowerCase().includes(needle) ||
        Object.values(row.options).some((value) => value.toLowerCase().includes(needle)),
    );
  }, [rows, filter]);

  const projection = draft.variantProjection;
  const activeCount = rows.filter((row) => row.isActive).length;
  const totalStock = rows.reduce(
    (sum, row) => sum + row.stock.reduce((inner, entry) => inner + entry.availableQuantity, 0),
    0,
  );

  // --- The question ------------------------------------------------------

  if (draft.variantAxes === null && !answeredYes) {
    return (
      <Card
        title="Does this product come in more than one version?"
        description="Sizes, colours, capacities, pack sizes - anything a buyer picks between."
      >
        <div className="space-y-4">
          <p className="text-sm text-ink-subtle">
            Answer no if you sell exactly one thing under this listing. Answer yes if a buyer
            has to choose - a shirt in four sizes, a cable in three lengths, seeds in a 500 g
            packet or a kilo. Each choice gets its own code, its own price and its own stock.
          </p>

          <div className="flex flex-wrap gap-3">
            <Button
              variant="primary"
              isLoading={saveMutation.isPending}
              onClick={() => {
                saveMutation.mutate({ variantAxes: [], expectedVersion: draft.version });
              }}
            >
              No, just one version
            </Button>
            <Button
              isLoading={saveMutation.isPending}
              onClick={() => {
                /*
                 * An empty axis list means "no", so "yes" cannot save one.
                 *
                 * Where the department has suggestions, the first recommended
                 * one is switched on and saved - the seller is immediately
                 * looking at the thing they said yes to. Where it has none
                 * (medical devices, or a department a business added itself)
                 * there is nothing to seed, so the picker opens locally and
                 * the answer is saved with the first option the seller names.
                 * Saving `[]` here is exactly the bug that would tell them
                 * they had said no.
                 */
                const first = template?.axes.find((axis) => axis.importance !== 'OPTIONAL');

                if (first === undefined) {
                  setAnsweredYes(true);
                  return;
                }

                setAxes([{ axisKey: first.key, values: [] }]);
                saveMutation.mutate({
                  variantAxes: [{ axisKey: first.key, values: [] }],
                  expectedVersion: draft.version,
                });
              }}
            >
              Yes, it has versions
            </Button>
          </div>

          <div className="flex justify-start pt-2">
            <Button onClick={onBack}>Back to details</Button>
          </div>
        </div>
      </Card>
    );
  }

  // --- Answered "one version" -------------------------------------------

  if (draft.variantAxes !== null && draft.variantAxes.length === 0 && rows.length === 0 && !answeredYes) {
    return (
      <Card title="One version only" description="This listing sells a single thing.">
        <div className="space-y-4">
          <p className="text-sm text-ink-subtle">
            The price, stock and packaging you entered on the details step cover it, and buyers
            will see no chooser on the product page. You can change your mind at any time before
            sending this for review.
          </p>

          <div className="flex flex-wrap gap-3">
            <Button
              onClick={() => {
                saveMutation.mutate({ variantAxes: null, expectedVersion: draft.version });
              }}
            >
              Actually, it has versions
            </Button>
            <Button onClick={onBack}>Back to details</Button>
          </div>
        </div>
      </Card>
    );
  }

  // --- Choosing axes and pricing the matrix ------------------------------

  const activeKeys = new Set(axes.map((axis) => axis.axisKey));
  const offered: VariantTemplateAxis[] = template?.axes ?? [];

  return (
    <div className="space-y-6">
      <Card
        title="What does a buyer choose between?"
        description={
          template === null
            ? 'This category has no suggested options, so name your own.'
            : `Suggestions for ${template.label}. Switch on only what changes the product code.`
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

          <CustomAxisAdder
            existingKeys={activeKeys}
            onAdd={(axisKey) => {
              setAxes([...axes, { axisKey, values: [] }]);
            }}
          />

          {axes.length === 0 && (
            <p className="text-sm text-ink-subtle">
              {offered.length === 0
                ? 'Name what a buyer chooses between to start building combinations.'
                : 'Pick at least one option above to start building combinations.'}
            </p>
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
                <header className="mb-3">
                  <h3 className="text-sm font-semibold text-ink">{definition.label}</h3>
                  {definition.helpText !== undefined && (
                    <p className="mt-0.5 text-xxs text-ink-subtle">{definition.helpText}</p>
                  )}
                </header>

                <AxisValueEditor
                  axis={definition}
                  chosen={chosen.values}
                  onChange={(values) => {
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

          <ProjectionBar
            axes={axes}
            projection={projection}
            hasExistingRows={rows.length > 0}
            isBusy={generateMutation.isPending}
            onGenerate={(replaceExisting) => {
              generateMutation.mutate({ axes, replaceExisting });
            }}
          />
        </div>
      </Card>

      {rows.length > 0 && (
        <Card
          title={`${rows.length} combinations`}
          description={`${activeCount} on sale · ${totalStock} units in total`}
        >
          <div className="space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <Field label="Find a combination">
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    aria-describedby={describedBy}
                    value={filter}
                    placeholder="Code, name or value"
                    onChange={(event) => {
                      setFilter(event.target.value);
                    }}
                  />
                )}
              </Field>

              <BulkActions
                rows={rows}
                locations={locations}
                sellerSku={draft.sellerSku}
                isBusy={saveMutation.isPending}
                onApply={commitRows}
              />
            </div>

            <MatrixTable
              rows={visibleRows}
              locations={locations}
              isBusy={saveMutation.isPending}
              onPatch={patchRow}
              onRemove={(signature) => {
                commitRows(rows.filter((row) => row.optionSignature !== signature));
              }}
            />
          </div>
        </Card>
      )}

      <div className="flex flex-wrap justify-between gap-3">
        <Button onClick={onBack}>Back to details</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * How many rows the current choices would make, and the button that makes them.
 *
 * The count is the point. A seller who ticks six sizes, four colours and three
 * widths is about to create seventy-two things to price, and being told that
 * before it happens is the difference between a considered choice and a table
 * they abandon.
 */
export function ProjectionBar({
  axes,
  projection,
  hasExistingRows,
  isBusy,
  onGenerate,
}: {
  axes: DraftVariantAxis[];
  projection: DraftView['variantProjection'];
  hasExistingRows: boolean;
  isBusy: boolean;
  onGenerate: (replaceExisting: boolean) => void;
}): React.JSX.Element | null {
  // Projected here rather than read off the draft: the draft's figure is for
  // the axes as last SAVED, and this has to answer for the ticks the seller
  // has just made and not yet generated from.
  const total = axes.reduce(
    (product, axis) => (axis.values.length === 0 ? product : product * axis.values.length),
    axes.every((axis) => axis.values.length === 0) ? 0 : 1,
  );

  const [confirming, setConfirming] = useState(false);

  if (axes.length === 0) return null;

  const tooMany = total > projection.maximum;
  const needsConfirmation = total > projection.warnAbove;

  return (
    <div className="rounded-lg border border-line bg-surface-sunken p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-ink">
            {total === 0
              ? 'No combinations yet'
              : `${total} ${total === 1 ? 'combination' : 'combinations'}`}
          </p>
          <p className="mt-0.5 text-xxs text-ink-subtle">
            {axes
              .filter((axis) => axis.values.length > 0)
              .map((axis) => `${axis.axisKey} × ${axis.values.length}`)
              .join('  ·  ') || 'Add values to each option above.'}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {hasExistingRows && (
            <Button
              isLoading={isBusy}
              disabled={total === 0 || tooMany}
              onClick={() => {
                setConfirming(true);
              }}
            >
              Start again
            </Button>
          )}
          <Button
            variant="primary"
            isLoading={isBusy}
            disabled={total === 0 || tooMany}
            onClick={() => {
              onGenerate(false);
            }}
          >
            {hasExistingRows ? 'Add missing combinations' : `Create ${total} combinations`}
          </Button>
        </div>
      </div>

      {tooMany && (
        <p role="alert" className="mt-3 text-xs text-danger">
          That is {total} combinations and {projection.maximum} is the most one listing can hold.
          Remove an option, or split this into separate listings.
        </p>
      )}

      {!tooMany && needsConfirmation && (
        <p className="mt-3 text-xs text-warning">
          That is a large table. Every row needs its own code, price and stock before this
          listing can go on sale.
        </p>
      )}

      {confirming && (
        <div role="alertdialog" aria-label="Start the table again" className="mt-3 rounded-md border border-danger/40 bg-danger-soft p-3">
          <p className="text-xs text-ink">
            Starting again throws away every code, price and stock figure already in the table.
            This cannot be undone.
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              onClick={() => {
                setConfirming(false);
              }}
            >
              Keep what I have
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirming(false);
                onGenerate(true);
              }}
            >
              Start again
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bulk editing
// ---------------------------------------------------------------------------

/**
 * Set one figure across every row at once.
 *
 * A forty-row table where the same price is typed forty times is a table with
 * thirty-nine correct prices and one that was missed, and the one that was
 * missed is the one a buyer orders.
 */
function BulkActions({
  rows,
  locations,
  sellerSku,
  isBusy,
  onApply,
}: {
  rows: DraftVariantRow[];
  locations: SellerLocation[];
  sellerSku: string | null;
  isBusy: boolean;
  onApply: (rows: DraftVariantRow[]) => void;
}): React.JSX.Element {
  const [price, setPrice] = useState('');
  const [stock, setStock] = useState('');
  const [locationId, setLocationId] = useState(locations[0]?.id ?? '');

  const effectiveLocation = locationId === '' ? (locations[0]?.id ?? '') : locationId;

  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label="Set every price">
        {({ inputId, describedBy }) => (
          <Input
            id={inputId}
            aria-describedby={describedBy}
            inputMode="decimal"
            placeholder="0.00"
            value={price}
            onChange={(event) => {
              setPrice(event.target.value);
            }}
          />
        )}
      </Field>
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

      <Field label="Set every stock">
        {({ inputId, describedBy }) => (
          <Input
            id={inputId}
            aria-describedby={describedBy}
            inputMode="numeric"
            placeholder="0"
            value={stock}
            onChange={(event) => {
              setStock(event.target.value);
            }}
          />
        )}
      </Field>

      {locations.length > 1 && (
        <Field label="Warehouse">
          {({ inputId, describedBy }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              value={effectiveLocation}
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

      <Button
        disabled={isBusy || sellerSku === null || sellerSku === ''}
        title={
          sellerSku === null || sellerSku === ''
            ? 'Set the listing code on the details step first'
            : undefined
        }
        onClick={() => {
          // Only the blanks. A code the seller typed - or one their warehouse
          // already prints on a label - is never overwritten by a generated
          // one.
          const taken = new Set(
            rows.map((row) => row.sku.trim().toUpperCase()).filter((sku) => sku !== ''),
          );

          onApply(
            rows.map((row) => {
              if (row.sku.trim() !== '') return row;

              const base = [sellerSku ?? '', ...Object.values(row.options)]
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
                candidate = `${base.slice(0, 60)}-${suffix}`;
              }

              taken.add(candidate.toUpperCase());
              return { ...row, sku: candidate };
            }),
          );
        }}
      >
        Generate missing codes
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

/**
 * A price for an input box: major units, or empty where there is no price.
 *
 * `minorToMajor` would turn a missing price into "0.00", which reads as free
 * rather than as unanswered — and a seller who has not priced a row yet needs
 * to see an empty box, not a zero they have to notice and clear.
 */
function priceInput(minor: string | null | undefined): string {
  return minor === null || minor === undefined || minor === '' ? '' : minorToMajor(minor);
}

function MatrixTable({
  rows,
  locations,
  isBusy,
  onPatch,
  onRemove,
}: {
  rows: DraftVariantRow[];
  locations: SellerLocation[];
  isBusy: boolean;
  onPatch: (signature: string, patch: Partial<DraftVariantRow>) => void;
  onRemove: (signature: string) => void;
}): React.JSX.Element {
  if (rows.length === 0) {
    return <p className="text-sm text-ink-subtle">Nothing matches that search.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[54rem] border-collapse text-sm">
        <caption className="sr-only">
          Every combination this listing sells, with its code, price and stock
        </caption>
        <thead>
          <tr className="border-b border-line text-left text-xxs uppercase tracking-wide text-ink-subtle">
            <th scope="col" className="py-2 pr-3">
              On sale
            </th>
            <th scope="col" className="py-2 pr-3">
              Combination
            </th>
            <th scope="col" className="py-2 pr-3">
              Code
            </th>
            <th scope="col" className="py-2 pr-3">
              Price
            </th>
            <th scope="col" className="py-2 pr-3">
              Was
            </th>
            <th scope="col" className="py-2 pr-3">
              Stock
            </th>
            <th scope="col" className="py-2 pr-3">
              <span className="sr-only">Remove</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const onHand = row.stock.reduce((sum, entry) => sum + entry.availableQuantity, 0);
            const primaryLocation = locations[0]?.id ?? '';

            return (
              <tr
                key={row.optionSignature}
                className={cx('border-b border-line/60', !row.isActive && 'opacity-60')}
              >
                <td className="py-2 pr-3">
                  <input
                    type="checkbox"
                    checked={row.isActive}
                    aria-label={`${row.name} on sale`}
                    disabled={isBusy}
                    onChange={(event) => {
                      onPatch(row.optionSignature, { isActive: event.target.checked });
                    }}
                  />
                </td>

                <td className="py-2 pr-3">
                  <span className="font-medium text-ink">{row.name}</span>
                  {!row.isActive && (
                    <span className="ml-2 inline-block align-middle">
                      <Badge tone="neutral">Not offered</Badge>
                    </span>
                  )}
                </td>

                <td className="py-2 pr-3">
                  <Input
                    value={row.sku}
                    aria-label={`Code for ${row.name}`}
                    disabled={isBusy}
                    onChange={(event) => {
                      onPatch(row.optionSignature, { sku: event.target.value });
                    }}
                  />
                </td>

                <td className="py-2 pr-3">
                  <Input
                    inputMode="decimal"
                    aria-label={`Price for ${row.name}`}
                    defaultValue={priceInput(row.priceMinor)}
                    disabled={isBusy}
                    onBlur={(event) => {
                      const minor = majorToMinor(event.target.value);
                      if (minor === null && event.target.value.trim() !== '') return;
                      onPatch(row.optionSignature, { priceMinor: minor });
                    }}
                  />
                </td>

                <td className="py-2 pr-3">
                  <Input
                    inputMode="decimal"
                    aria-label={`Recommended price for ${row.name}`}
                    defaultValue={priceInput(row.compareAtPriceMinor)}
                    disabled={isBusy}
                    onBlur={(event) => {
                      const minor = majorToMinor(event.target.value);
                      if (minor === null && event.target.value.trim() !== '') return;
                      onPatch(row.optionSignature, { compareAtPriceMinor: minor });
                    }}
                  />
                </td>

                <td className="py-2 pr-3">
                  <Input
                    inputMode="numeric"
                    aria-label={`Stock for ${row.name}`}
                    defaultValue={String(onHand)}
                    disabled={isBusy || primaryLocation === ''}
                    onBlur={(event) => {
                      const quantity = Number.parseInt(event.target.value, 10);
                      if (!Number.isFinite(quantity) || quantity < 0) return;

                      onPatch(row.optionSignature, {
                        stock: [
                          ...row.stock.filter((entry) => entry.locationId !== primaryLocation),
                          { locationId: primaryLocation, availableQuantity: quantity },
                        ],
                      });
                    }}
                  />
                </td>

                <td className="py-2 pr-3 text-right">
                  <Button
                    disabled={isBusy}
                    aria-label={`Remove ${row.name}`}
                    onClick={() => {
                      onRemove(row.optionSignature);
                    }}
                  >
                    Remove
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <p className="mt-3 text-xxs text-ink-subtle">
        Remove the combinations you do not make. A combination that is removed shows as
        &ldquo;not offered&rdquo; to a buyer; one that is here with no stock shows as
        &ldquo;out of stock&rdquo;.
      </p>
    </div>
  );
}

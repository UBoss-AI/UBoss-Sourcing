/**
 * The variant matrix builder.
 *
 * Choosing which dimensions a product sells along, entering the values, and
 * turning the two into rows. It sits above the variant table rather than
 * replacing it: the table is still where a single row is corrected, and a
 * product whose category has no template — Medical Devices, or a shelf the
 * operator invented — has no builder at all and keeps the free-form editor it
 * has always had.
 *
 * The three things it is built around:
 *
 *   **Preview, then write.** Generating shows the whole table first — every
 *   combination, its SKU, and whether it already exists — and creates nothing
 *   until Save. A generator that writes first is a generator that has to be
 *   undone, and undoing forty SKUs by hand is how a catalogue ends up with
 *   nineteen orphans.
 *
 *   **Nothing is ever removed by generating.** A combination dropped out of
 *   the matrix keeps its row, its stock and its order history. Re-running a
 *   generation after adding one size creates the one row and leaves the prices
 *   and SKUs of the rest exactly as they were edited.
 *
 *   **The seller switches axes on; the template only offers them.** A template
 *   knows a laptop can vary by RAM, storage and colour. It does not know that
 *   this seller stocks one colour, and a form that turned every candidate into
 *   a required field would make them invent variants they do not sell.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, Field, Input } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { useToast } from '@/components/toast-context';
import { useSession } from '@/auth/session-context';
import { Permission } from '@/lib/permissions';
import { ApiError, api } from '@/lib/api';
import { useI18n } from '@/i18n/i18n-context';

interface TemplateAxis {
  key: string;
  label: string;
  importance: 'REQUIRED' | 'RECOMMENDED' | 'OPTIONAL';
  input: string;
  display: string;
  units?: string[] | null;
  suggestions?: string[] | null;
  allowsCustomValues: boolean;
  sortOrder: number;
  sort: string;
  dependsOn?: string[];
  helpText?: string;
}

interface TemplateResponse {
  template: {
    categorySlug: string;
    subcategorySlug: string | null;
    label: string;
    axes: TemplateAxis[];
  } | null;
  activeAxisKeys: string[];
  categorySlugs: string[];
}

interface MatrixRow {
  optionSignature: string;
  options: Record<string, string>;
  displayName: string;
  sku: string;
  exists: boolean;
  existingVariantId: string | null;
  existingSku: string | null;
}

interface MatrixPreview {
  rows: MatrixRow[];
  total: number;
  toCreate: number;
  warnAbove: number;
  maximum: number;
  warnings: string[];
}

/** The values a seller has typed for one axis, in the order they arranged them. */
type AxisValues = Record<string, string[]>;

export function VariantMatrixPanel({ productId }: { productId: string }): React.JSX.Element | null {
  const { t } = useI18n();
  const { can } = useSession();
  const queryClient = useQueryClient();
  const toast = useToast();

  const canWrite = can(Permission.PRODUCT_WRITE);

  const [values, setValues] = useState<AxisValues>({});
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [skuPrefix, setSkuPrefix] = useState('');
  const [preview, setPreview] = useState<MatrixPreview | null>(null);
  /** SKUs the operator edited before saving, by combination signature. */
  const [skuEdits, setSkuEdits] = useState<Record<string, string>>({});
  const [priceMinor, setPriceMinor] = useState('');
  const [minOrderQty, setMinOrderQty] = useState('');

  const templateQuery = useQuery({
    queryKey: ['variant-template', productId],
    queryFn: () => api.get<TemplateResponse>(`/admin/products/${productId}/variant-template`),
  });

  const template = templateQuery.data?.template ?? null;
  const activeAxisKeys = useMemo(
    () => templateQuery.data?.activeAxisKeys ?? [],
    [templateQuery.data],
  );

  const setAxes = useMutation({
    mutationFn: (axisKeys: string[]) =>
      api.put<{ activeAxisKeys: string[]; warnings: string[] }>(
        `/admin/products/${productId}/variant-axes`,
        { axisKeys },
      ),
    onSuccess: async (result) => {
      for (const warning of result.warnings) toast.error(warning);
      await queryClient.invalidateQueries({ queryKey: ['variant-template', productId] });
      await queryClient.invalidateQueries({ queryKey: ['product', productId] });
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : t('variantMatrix.couldNotSaveAxes'));
    },
  });

  const previewMutation = useMutation({
    mutationFn: () =>
      api.post<MatrixPreview>(`/admin/products/${productId}/variants/preview`, {
        axes: activeAxisKeys.map((key) => ({
          axisKey: key,
          values: (values[key] ?? []).map((label) => ({ label })),
        })),
        skuPrefix: skuPrefix.trim() === '' ? null : skuPrefix.trim(),
      }),
    onSuccess: (result) => {
      setPreview(result);
      setSkuEdits({});
      for (const warning of result.warnings) toast.error(warning);
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : t('variantMatrix.couldNotPreview'));
    },
  });

  const generate = useMutation({
    mutationFn: () =>
      api.post<{ created: number; skipped: number }>(
        `/admin/products/${productId}/variants/generate`,
        {
          rows: (preview?.rows ?? [])
            // A combination that already exists is left exactly as it is. Its
            // price, its stock and its edited SKU are the operator's work.
            .filter((row) => !row.exists)
            .map((row) => ({
              optionSignature: row.optionSignature,
              options: row.options,
              name: row.displayName,
              sku: skuEdits[row.optionSignature] ?? row.sku,
              ...(priceMinor.trim() === '' ? {} : { priceMinor: priceMinor.trim() }),
              ...(minOrderQty.trim() === ''
                ? {}
                : { minOrderQty: Number(minOrderQty.trim()) }),
            })),
        },
      ),
    onSuccess: async (result) => {
      toast.success(
        t('variantMatrix.created', {
          created: String(result.created),
          skipped: String(result.skipped),
        }),
      );
      setPreview(null);
      await queryClient.invalidateQueries({ queryKey: ['variants', productId] });
      await queryClient.invalidateQueries({ queryKey: ['product', productId] });
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : t('variantMatrix.couldNotGenerate'));
    },
  });

  // A category with no template has no builder. The free-form editor below is
  // the whole interface, exactly as it was before this panel existed.
  if (templateQuery.isPending || template === null) return null;

  const toggleAxis = (key: string): void => {
    const next = activeAxisKeys.includes(key)
      ? activeAxisKeys.filter((entry) => entry !== key)
      : [...activeAxisKeys, key];

    setPreview(null);
    setAxes.mutate(next);
  };

  const addValue = (axisKey: string, label: string): void => {
    const trimmed = label.trim();
    if (trimmed === '') return;

    setValues((current) => {
      const held = current[axisKey] ?? [];
      // Case-folded, because "Black" and "black" are one colour and two rows
      // for one colour is the duplicate the server would refuse anyway.
      if (held.some((entry) => entry.toLowerCase() === trimmed.toLowerCase())) return current;
      return { ...current, [axisKey]: [...held, trimmed] };
    });

    setDraft((current) => ({ ...current, [axisKey]: '' }));
    setPreview(null);
  };

  const removeValue = (axisKey: string, label: string): void => {
    setValues((current) => ({
      ...current,
      [axisKey]: (current[axisKey] ?? []).filter((entry) => entry !== label),
    }));
    setPreview(null);
  };

  const moveValue = (axisKey: string, index: number, by: number): void => {
    setValues((current) => {
      const held = [...(current[axisKey] ?? [])];
      const target = index + by;
      if (target < 0 || target >= held.length) return current;
      const moved = held[index];
      const displaced = held[target];
      if (moved === undefined || displaced === undefined) return current;
      held[index] = displaced;
      held[target] = moved;
      return { ...current, [axisKey]: held };
    });
    setPreview(null);
  };

  const columns: Column<MatrixRow>[] = [
    {
      key: 'combination',
      header: t('variantMatrix.combination'),
      render: (row) => (
        <div>
          <p className="font-medium text-ink">{row.displayName}</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {Object.entries(row.options).map(([key, value]) => (
              <Badge key={key}>
                {key}: {value}
              </Badge>
            ))}
          </div>
        </div>
      ),
    },
    {
      key: 'sku',
      header: t('label.sku'),
      render: (row) =>
        row.exists ? (
          <span className="font-mono text-xxs text-ink-subtle">{row.existingSku}</span>
        ) : (
          // Editable before saving. A generated SKU is a suggestion, and an
          // operator with their own numbering scheme must be able to use it.
          <Input
            value={skuEdits[row.optionSignature] ?? row.sku}
            aria-label={t('variantMatrix.skuFor', { combination: row.displayName })}
            onChange={(event) => {
              setSkuEdits((current) => ({
                ...current,
                [row.optionSignature]: event.target.value,
              }));
            }}
            className="font-mono text-xs"
          />
        ),
    },
    {
      key: 'status',
      header: t('label.status'),
      render: (row) =>
        row.exists ? (
          <span className="text-xs text-ink-muted">{t('variantMatrix.alreadyListed')}</span>
        ) : (
          <span className="text-xs font-medium text-brand">{t('variantMatrix.willBeCreated')}</span>
        ),
    },
  ];

  return (
    <Card
      title={t('variantMatrix.title')}
      description={t('variantMatrix.description', { shelf: template.label })}
    >
      {/* --- 1. Which dimensions this product actually varies by ---------- */}
      <fieldset className="border-0 p-0">
        <legend className="text-sm font-medium text-ink">{t('variantMatrix.chooseAxes')}</legend>
        <p className="mt-0.5 text-xs text-ink-muted">{t('variantMatrix.chooseAxesHint')}</p>

        <div className="mt-2 flex flex-wrap gap-2">
          {template.axes.map((axis) => {
            const isOn = activeAxisKeys.includes(axis.key);

            return (
              <button
                key={axis.key}
                type="button"
                aria-pressed={isOn}
                disabled={!canWrite || setAxes.isPending}
                onClick={() => {
                  toggleAxis(axis.key);
                }}
                title={axis.helpText}
                className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                  isOn
                    ? 'border-brand bg-brand-soft text-brand ring-1 ring-inset ring-brand/30'
                    : 'border-border-strong bg-surface text-ink hover:border-brand/40 hover:bg-surface-hover'
                } disabled:cursor-not-allowed disabled:opacity-60`}
              >
                {axis.label}
                {/* Advice, not a rule. A template says footwear is normally
                    sold by size because it is; it does not say a seller with
                    one size has filled the form in wrong. */}
                {axis.importance === 'RECOMMENDED' && !isOn && (
                  <span className="ml-1.5 text-xxs text-ink-subtle">
                    {t('variantMatrix.usual')}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </fieldset>

      {/* --- 2. The values, per switched-on axis --------------------------- */}
      {activeAxisKeys.length > 0 && (
        <div className="mt-5 space-y-4">
          {activeAxisKeys.map((axisKey) => {
            const axis = template.axes.find((entry) => entry.key === axisKey);
            if (axis === undefined) return null;

            const held = values[axisKey] ?? [];
            const suggestions = (axis.suggestions ?? []).filter(
              (entry) => !held.some((value) => value.toLowerCase() === entry.toLowerCase()),
            );

            return (
              <div key={axisKey} className="rounded-lg border border-border bg-surface-sunken p-3">
                <p className="text-sm font-medium text-ink">{axis.label}</p>

                {held.length > 0 && (
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {held.map((value, index) => (
                      <li
                        key={value}
                        className="flex items-center gap-1 rounded-md border border-border-strong bg-surface px-2 py-1 text-sm"
                      >
                        {/* Order is meaningful — it is the order a buyer sees
                            where the axis is not sorted for them. */}
                        <button
                          type="button"
                          aria-label={t('variantMatrix.moveEarlier', { value })}
                          disabled={index === 0}
                          onClick={() => {
                            moveValue(axisKey, index, -1);
                          }}
                          className="px-1 text-ink-subtle disabled:opacity-30"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          aria-label={t('variantMatrix.moveLater', { value })}
                          disabled={index === held.length - 1}
                          onClick={() => {
                            moveValue(axisKey, index, 1);
                          }}
                          className="px-1 text-ink-subtle disabled:opacity-30"
                        >
                          ↓
                        </button>
                        <span className="px-1">{value}</span>
                        <button
                          type="button"
                          aria-label={t('variantMatrix.removeValue', { value })}
                          onClick={() => {
                            removeValue(axisKey, value);
                          }}
                          className="px-1 text-danger"
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                {suggestions.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {suggestions.map((suggestion) => (
                      <button
                        key={suggestion}
                        type="button"
                        onClick={() => {
                          addValue(axisKey, suggestion);
                        }}
                        className="rounded border border-dashed border-border-strong px-2 py-0.5 text-xs text-ink-muted hover:border-brand/50 hover:text-ink"
                      >
                        + {suggestion}
                      </button>
                    ))}
                  </div>
                )}

                {axis.allowsCustomValues && (
                  <div className="mt-2 flex gap-2">
                    <Input
                      value={draft[axisKey] ?? ''}
                      aria-label={t('variantMatrix.addValueTo', { axis: axis.label })}
                      placeholder={t('variantMatrix.addValuePlaceholder')}
                      onChange={(event) => {
                        setDraft((current) => ({ ...current, [axisKey]: event.target.value }));
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          addValue(axisKey, draft[axisKey] ?? '');
                        }
                      }}
                    />
                    <Button
                      size="sm"
                      onClick={() => {
                        addValue(axisKey, draft[axisKey] ?? '');
                      }}
                    >
                      {t('variantMatrix.add')}
                    </Button>
                  </div>
                )}
              </div>
            );
          })}

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('variantMatrix.skuPrefix')} hint={t('variantMatrix.skuPrefixHint')}>
              {(ids) => (
                <Input
                  id={ids.inputId}
                  aria-describedby={ids.describedBy}
                  value={skuPrefix}
                  onChange={(event) => {
                    setSkuPrefix(event.target.value);
                  }}
                />
              )}
            </Field>
            <Field label={t('variantMatrix.bulkPrice')} hint={t('variantMatrix.bulkPriceHint')}>
              {(ids) => (
                <Input
                  id={ids.inputId}
                  aria-describedby={ids.describedBy}
                  value={priceMinor}
                  inputMode="numeric"
                  onChange={(event) => {
                    setPriceMinor(event.target.value);
                  }}
                />
              )}
            </Field>
            <Field label={t('variantMatrix.bulkMoq')} hint={t('variantMatrix.bulkMoqHint')}>
              {(ids) => (
                <Input
                  id={ids.inputId}
                  aria-describedby={ids.describedBy}
                  value={minOrderQty}
                  inputMode="numeric"
                  onChange={(event) => {
                    setMinOrderQty(event.target.value);
                  }}
                />
              )}
            </Field>
          </div>

          <Button
            variant="primary"
            isLoading={previewMutation.isPending}
            disabled={!canWrite || activeAxisKeys.every((key) => (values[key] ?? []).length === 0)}
            onClick={() => {
              previewMutation.mutate();
            }}
          >
            {t('variantMatrix.preview')}
          </Button>
        </div>
      )}

      {/* --- 3. The table, before anything is written --------------------- */}
      {preview !== null && (
        <div className="mt-5">
          <p className="text-sm text-ink">
            {t('variantMatrix.summary', {
              total: String(preview.total),
              toCreate: String(preview.toCreate),
            })}
          </p>

          {preview.total > preview.warnAbove && (
            <p className="mt-1 text-sm text-danger">
              {t('variantMatrix.largeTable', { total: String(preview.total) })}
            </p>
          )}

          <div className="mt-3">
            <DataTable
              caption={t('variantMatrix.title')}
              columns={columns}
              rows={preview.rows}
              rowKey={(row) => row.optionSignature}
              minWidth="46rem"
              emptyTitle={t('variantMatrix.nothingToCreate')}
              emptyDescription={t('variantMatrix.nothingToCreateHint')}
            />
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="primary"
              isLoading={generate.isPending}
              disabled={!canWrite || preview.toCreate === 0}
              onClick={() => {
                generate.mutate();
              }}
            >
              {t('variantMatrix.save', { n: String(preview.toCreate) })}
            </Button>
            <Button
              onClick={() => {
                setPreview(null);
              }}
            >
              {t('variantMatrix.discard')}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/**
 * Specifications.
 *
 * The name/value rows a customer reads under "Specifications" on the product
 * page - "Material: Stainless 304", "Thread: M8 x 1.25". Three things this
 * panel has to get right:
 *
 *   - **The list is sent whole, not row by row.** The server replaces the set
 *     with whatever arrives, so the save button submits every row at once and
 *     the order on screen becomes the order customers see. There is no
 *     per-row save that could leave the list half-written.
 *   - **A name may appear once.** The database enforces it case-insensitively,
 *     so "Material" and "material" collide. Catching it here marks the second
 *     row while the person is still looking at it, rather than failing the
 *     whole save.
 *   - **Filterable is stored, not yet acted on.** The column exists and bulk
 *     import sets it, but no catalogue facet reads it yet. The tick is kept
 *     here so an imported flag survives an edit - dropping the control would
 *     quietly clear it on the next save - and the note under the list says so
 *     rather than promising filtering that does not happen.
 */
import { useEffect, useMemo, useState } from 'react';
import { useFieldArray, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { useSession } from '@/auth/session-context';
import { useToast } from '@/components/toast-context';
import { Button, Callout, Card, Checkbox, EmptyState, Input } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { Permission } from '@/lib/permissions';
import { useI18n } from '@/i18n/i18n-context';

export interface SpecificationRow {
  name: string;
  value: string;
  isFilterable: boolean;
}

const MAX_ROWS = 50;

const specificationsSchema = z.object({
  rows: z
    .array(
      z.object({
        name: z.string().trim().min(1, 'Name it, e.g. Material.').max(128),
        value: z.string().trim().min(1, 'Give it a value.').max(512),
        isFilterable: z.boolean(),
      }),
    )
    .max(MAX_ROWS),
});

type SpecificationsForm = z.output<typeof specificationsSchema>;

/**
 * Which rows repeat a name used by an earlier row, mapped to that earlier row.
 *
 * Deliberately computed from the live values rather than expressed as a Zod
 * refinement. Two reasons: the resolver in use here is the Zod 3 generation and
 * throws on an array-level refinement instead of reporting it, and a rule about
 * two rows at once should show the moment the second name is typed - not only
 * when someone presses Save.
 *
 * Case-insensitive, matching `uq_product_attribute_name`: the column's
 * collation already treats "Material" and "material" as one name.
 */
function findRepeatedNames(rows: { name?: string }[]): Map<number, number> {
  const seen = new Map<string, number>();
  const repeats = new Map<number, number>();

  rows.forEach((row, index) => {
    const key = (row.name ?? '').trim().toLocaleLowerCase();
    if (key.length === 0) return;

    const first = seen.get(key);

    if (first === undefined) seen.set(key, index);
    else repeats.set(index, first);
  });

  return repeats;
}

export function SpecificationsPanel({
  productId,
  specifications,
}: {
  productId: string;
  specifications: SpecificationRow[];
}): React.JSX.Element {
  const { t } = useI18n();

  const { can } = useSession();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [formError, setFormError] = useState<string | null>(null);

  const canEdit = can(Permission.PRODUCT_WRITE);

  const {
    control,
    register,
    handleSubmit,
    reset,
    formState: { errors, isDirty },
  } = useForm<SpecificationsForm>({
    resolver: zodResolver(specificationsSchema),
    defaultValues: { rows: specifications },
  });

  const rows = useFieldArray({ control, name: 'rows' });
  const liveRows = useWatch({ control, name: 'rows' });
  const repeats = useMemo(() => findRepeatedNames(liveRows), [liveRows]);

  // The product query refetches after a save and after an edit made elsewhere.
  // Re-seeding from it keeps this panel showing what is actually stored, and
  // clears the dirty flag so the save button stops offering work already done.
  useEffect(() => {
    reset({ rows: specifications });
  }, [specifications, reset]);

  const save = useMutation({
    mutationFn: (values: SpecificationsForm) =>
      api.patch(`/admin/products/${productId}`, {
        attributes: values.rows.map((row) => ({
          name: row.name,
          value: row.value,
          isFilterable: row.isFilterable,
        })),
      }),
    onSuccess: async () => {
      setFormError(null);
      toast.success('Specifications saved.');
      await queryClient.invalidateQueries({ queryKey: ['product', productId] });
    },
    onError: (error) => {
      setFormError(
        error instanceof ApiError ? error.message : 'The specifications could not be saved.',
      );
    },
  });

  const submit = (): void => {
    void handleSubmit((values) => {
      save.mutate(values);
    })();
  };

  const rowErrors = errors.rows;

  return (
    <Card
      title={t('specifications.specifications')}
      description={t('specifications.shownOnTheProductPage')}
      actions={
        canEdit ? (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={rows.fields.length >= MAX_ROWS}
              onClick={() => {
                rows.append({ name: '', value: '', isFilterable: false });
              }}
            >
              {t('specifications.addRow')}
            </Button>
            <Button
              size="sm"
              isLoading={save.isPending}
              disabled={!isDirty || repeats.size > 0}
              onClick={submit}
            >
              {t('specifications.saveSpecifications')}
            </Button>
          </div>
        ) : undefined
      }
    >
      <div className="px-5 py-4">
        {formError !== null && (
          <Callout tone="danger" role="alert" className="mb-3">
            {formError}
          </Callout>
        )}

        {typeof rowErrors?.root?.message === 'string' && (
          <Callout tone="danger" role="alert" className="mb-3">
            {rowErrors.root.message}
          </Callout>
        )}

        {rows.fields.length === 0 ? (
          <EmptyState
            title={t('specifications.noSpecificationsYet')}
            description={
              canEdit
                ? 'Add rows like Material, Finish or Thread — customers see them on the product page, in this order.'
                : 'None have been added for this product.'
            }
          />
        ) : (
          <ul className="space-y-2">
            {rows.fields.map((field, index) => {
              const repeatOf = repeats.get(index);
              const nameError =
                repeatOf === undefined
                  ? rowErrors?.[index]?.name?.message
                  : `Already used by row ${String(repeatOf + 1)}. Each name may appear once.`;
              const valueError = rowErrors?.[index]?.value?.message;

              return (
                <li
                  key={field.id}
                  className="grid gap-2 rounded-md border border-border bg-surface-sunken p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto]"
                >
                  <div>
                    <label className="sr-only" htmlFor={`spec-name-${field.id}`}>
                      Specification {index + 1} name
                    </label>
                    <Input
                      id={`spec-name-${field.id}`}
                      placeholder={t('specifications.material')}
                      disabled={!canEdit}
                      invalid={nameError !== undefined}
                      {...register(`rows.${index}.name`)}
                    />
                    {nameError !== undefined && (
                      <p className="mt-1 text-xs text-danger">{nameError}</p>
                    )}
                  </div>

                  <div>
                    <label className="sr-only" htmlFor={`spec-value-${field.id}`}>
                      Specification {index + 1} value
                    </label>
                    <Input
                      id={`spec-value-${field.id}`}
                      placeholder={t('specifications.stainless304')}
                      disabled={!canEdit}
                      invalid={valueError !== undefined}
                      {...register(`rows.${index}.value`)}
                    />
                    {valueError !== undefined && (
                      <p className="mt-1 text-xs text-danger">{valueError}</p>
                    )}
                  </div>

                  {canEdit && (
                    <div className="flex items-start gap-2">
                      <label className="flex h-10 cursor-pointer items-center gap-1.5 whitespace-nowrap text-sm text-ink">
                        <Checkbox {...register(`rows.${index}.isFilterable`)} />
                        {t('specifications.filterable')}
                      </label>

                      <Button
                        size="sm"
                        variant="secondary"
                        aria-label={`Move specification ${String(index + 1)} up`}
                        disabled={index === 0}
                        onClick={() => {
                          rows.move(index, index - 1);
                        }}
                      >
                        ↑
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        aria-label={`Move specification ${String(index + 1)} down`}
                        disabled={index === rows.fields.length - 1}
                        onClick={() => {
                          rows.move(index, index + 1);
                        }}
                      >
                        ↓
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        aria-label={`Remove specification ${String(index + 1)}`}
                        onClick={() => {
                          rows.remove(index);
                        }}
                      >
                        {t('specifications.remove')}
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {canEdit && rows.fields.length > 0 && (
          <p className="mt-3 text-xs text-ink-muted">
            {rows.fields.length} of {MAX_ROWS} rows.{' '}
            {repeats.size > 0
              ? 'Two rows share a name, so saving is held until one is changed.'
              : isDirty
                ? 'Unsaved changes.'
                : 'Everything here is saved.'}{' '}
            Filterable marks a row for future catalogue filters; customers see every row either way.
          </p>
        )}
      </div>
    </Card>
  );
}

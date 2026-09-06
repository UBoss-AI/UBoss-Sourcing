/**
 * Variants.
 *
 * A variant is a separately stocked, separately priced form of a product -
 * "1L", "Pack of 12". Two things this panel has to get right:
 *
 *   - **Variant SKUs share one namespace with product SKUs.** A picker or a
 *     barcode scanner cannot tell them apart, so the server refuses a
 *     collision either way and this panel shows that refusal on the SKU field.
 *   - **Delete is not always delete.** A variant that has been ordered is
 *     archived, because order history references it. The confirm dialog says
 *     which will happen, using the order count the list already returns.
 *
 * A variant's own price is a shelf price, so beside it sits what a customer in
 * the market chosen in the header actually pays for it - the same preview the
 * product list and the per-currency card show, from the same engine. Rows that
 * inherit the product's price get no figure: that one is quoted on the price
 * card above, and repeating it here would read as an override that does not
 * exist.
 */
import { useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { useMarket } from '@/app/market-context';
import { useSession } from '@/auth/session-context';
import { DataTable } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import { ConfirmDialog, Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Callout, Card, Field, Input } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { applyApiErrors } from '@/lib/forms';
import { formatNumber, majorToMinor, minorToMajor } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import type { VariantRow } from '@/lib/types';
import { useI18n } from '@/i18n/i18n-context';

const variantSchema = z.object({
  sku: z.string().trim().min(1, 'A SKU is required.').max(64),
  name: z.string().trim().min(1, 'Give the variant a name.').max(255),
  price: z.union([
    z
      .string()
      .trim()
      .regex(/^\d+(\.\d{1,2})?$/, 'Enter an amount like 45.50, or leave blank.'),
    z.literal(''),
  ]),
  options: z
    .array(
      z.object({
        key: z.string().trim().min(1, 'Name the option.'),
        value: z.string().trim().min(1, 'Give the option a value.'),
      }),
    )
    .min(1, 'A variant needs at least one option, e.g. Size = 1L.'),
});

type VariantForm = z.output<typeof variantSchema>;

const FORM_FIELDS = ['sku', 'name', 'price', 'options'] as const;

function VariantEditor({
  productId,
  editing,
  onClose,
}: {
  productId: string;
  editing: VariantRow | null;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();

  const queryClient = useQueryClient();
  const toast = useToast();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<VariantForm>({
    resolver: zodResolver(variantSchema),
    defaultValues: {
      sku: editing?.sku ?? '',
      name: editing?.name ?? '',
      price: editing?.priceMinor == null ? '' : minorToMajor(editing.priceMinor),
      options:
        editing === null
          ? [{ key: '', value: '' }]
          : Object.entries(editing.options).map(([key, value]) => ({ key, value })),
    },
  });

  const options = useFieldArray({ control, name: 'options' });

  const mutation = useMutation({
    mutationFn: (values: VariantForm) => {
      const body = {
        sku: values.sku,
        name: values.name,
        options: Object.fromEntries(values.options.map((option) => [option.key, option.value])),
        priceMinor: values.price === '' ? null : majorToMinor(values.price),
      };

      return editing === null
        ? api.post<{ id: string }>(`/admin/products/${productId}/variants`, body)
        : api.patch(`/admin/products/${productId}/variants/${editing.id}`, body);
    },
    onSuccess: async () => {
      toast.success(editing === null ? 'Variant added.' : 'Variant saved.');
      await queryClient.invalidateQueries({ queryKey: ['variants', productId] });
      await queryClient.invalidateQueries({ queryKey: ['product', productId] });
      onClose();
    },
    onError: (error) => {
      setFormError(applyApiErrors(error, setError, FORM_FIELDS));
    },
  });

  const submit = (): void => {
    void handleSubmit((values) => mutation.mutateAsync(values))();
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={editing === null ? 'New variant' : `Edit ${editing.name}`}
      description={t('variants.leaveThePriceBlankTo')}
      footer={
        <>
          <Button onClick={onClose}>{t('variants.cancel')}</Button>
          <Button variant="primary" isLoading={mutation.isPending} onClick={submit}>
            {editing === null ? 'Add variant' : 'Save variant'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {formError !== null && (
          <Callout tone="danger" role="alert">
            {formError}
          </Callout>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="SKU"
            hint={t('variants.sharesOneNamespaceWithProduct')}
            error={errors.sku?.message}
            required
          >
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                className="font-mono"
                aria-describedby={describedBy}
                invalid={errors.sku !== undefined}
                {...register('sku')}
              />
            )}
          </Field>

          <Field label={t('variants.name')} error={errors.name?.message} required>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                invalid={errors.name !== undefined}
                {...register('name')}
              />
            )}
          </Field>
        </div>

        <Field label={t('variants.priceOverride')} error={errors.price?.message}>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              inputMode="decimal"
              className="tabular"
              placeholder={t('variants.inheritsTheProductPrice')}
              aria-describedby={describedBy}
              invalid={errors.price !== undefined}
              {...register('price')}
            />
          )}
        </Field>

        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-ink">{t('variants.options')}</legend>
          <p className="mb-2 text-xs text-ink-muted">
            What distinguishes this variant, e.g. Size = 1L.
          </p>

          {errors.options?.message !== undefined && (
            <p role="alert" className="mb-2 text-xs font-medium text-danger">
              {errors.options.message}
            </p>
          )}

          <div className="space-y-2">
            {options.fields.map((field, index) => (
              <div key={field.id} className="flex items-start gap-2">
                <div className="flex-1">
                  <Input
                    aria-label={`Option ${String(index + 1)} name`}
                    placeholder={t('variants.size')}
                    invalid={errors.options?.[index]?.key !== undefined}
                    {...register(`options.${index}.key` as const)}
                  />
                  {errors.options?.[index]?.key?.message !== undefined && (
                    <p role="alert" className="mt-1 text-xxs text-danger">
                      {errors.options[index].key.message}
                    </p>
                  )}
                </div>
                <div className="flex-1">
                  <Input
                    aria-label={`Option ${String(index + 1)} value`}
                    placeholder="1L"
                    invalid={errors.options?.[index]?.value !== undefined}
                    {...register(`options.${index}.value` as const)}
                  />
                  {errors.options?.[index]?.value?.message !== undefined && (
                    <p role="alert" className="mt-1 text-xxs text-danger">
                      {errors.options[index].value.message}
                    </p>
                  )}
                </div>
                {/* 40px, so it sits on the same baseline as the two inputs
                    beside it rather than floating above them. */}
                <Button
                  size="md"
                  variant="ghost"
                  aria-label={`Remove option ${String(index + 1)}`}
                  disabled={options.fields.length === 1}
                  title={
                    options.fields.length === 1 ? 'A variant needs at least one option.' : undefined
                  }
                  onClick={() => {
                    options.remove(index);
                  }}
                >
                  {t('variants.remove')}
                </Button>
              </div>
            ))}
          </div>

          <Button
            size="sm"
            className="mt-2"
            onClick={() => {
              options.append({ key: '', value: '' });
            }}
          >
            {t('variants.addOption')}
          </Button>
        </fieldset>
      </form>
    </Modal>
  );
}

export function VariantsPanel({ productId }: { productId: string }): React.JSX.Element {
  const { t } = useI18n();

  const { can } = useSession();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [editorFor, setEditorFor] = useState<VariantRow | null | undefined>(undefined);
  const [removing, setRemoving] = useState<VariantRow | null>(null);

  /** Which market the preview column is quoted for, from the panel's header. */
  const { country } = useMarket();

  const query = useQuery({
    // `country` is in the key because it changes the response, and because it
    // is what requotes this table when the market in the header moves.
    queryKey: ['variants', productId, country],
    queryFn: () =>
      api.get<{ variants: VariantRow[] }>(`/admin/products/${productId}/variants`, {
        query: { country: country ?? undefined },
      }),
  });

  const remove = useMutation({
    mutationFn: (variant: VariantRow) =>
      api.delete<{ deleted: boolean }>(`/admin/products/${productId}/variants/${variant.id}`),
    onSuccess: async (result) => {
      toast.success(
        result.deleted ? 'Variant deleted.' : 'Variant archived — orders reference it.',
      );
      setRemoving(null);
      await queryClient.invalidateQueries({ queryKey: ['variants', productId] });
      await queryClient.invalidateQueries({ queryKey: ['product', productId] });
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : 'The variant could not be removed.');
    },
  });

  const canWrite = can(Permission.PRODUCT_WRITE);

  /**
   * Whether the customer-facing column has anything to say.
   *
   * Only where an override becomes a different figure for the chosen market -
   * the same rule as the product list and the price card. With no EU VAT
   * configured, or on the seller's own market, it repeats the column beside it
   * and is left out.
   */
  const showsQuoted = (query.data?.variants ?? []).some(
    (row) => row.quotedMinor !== null && row.quotedMinor !== row.priceMinor,
  );

  const columns: Column<VariantRow>[] = [
    {
      key: 'name',
      header: 'Variant',
      render: (row) => (
        <div>
          <p className="font-medium text-ink">{row.name}</p>
          <p className="font-mono text-xxs text-ink-subtle">{row.sku}</p>
        </div>
      ),
    },
    {
      key: 'options',
      header: 'Options',
      secondary: true,
      render: (row) => (
        <div className="flex flex-wrap gap-1">
          {Object.entries(row.options).map(([key, value]) => (
            <Badge key={key}>
              {key}: {value}
            </Badge>
          ))}
        </div>
      ),
    },
    {
      key: 'price',
      header: 'Price',
      align: 'right',
      nowrap: true,
      render: (row) =>
        row.priceMinor === null ? (
          <span className="text-ink-muted">{t('variants.inherits')}</span>
        ) : (
          minorToMajor(row.priceMinor)
        ),
    },
    // Read-only, like every other quoted figure in the console: this is what
    // the pricing engine makes of the override beside it, not a second place
    // to set one.
    ...(showsQuoted
      ? [
          {
            key: 'quoted',
            header: t('market.customerPays'),
            align: 'right' as const,
            nowrap: true,
            render: (row: VariantRow) =>
              row.quotedMinor === null ? (
                // Nothing of its own to convert. The price card above quotes
                // the figure this row is actually sold at.
                <span className="text-ink-subtle">—</span>
              ) : (
                <>
                  <span className="font-medium">{minorToMajor(row.quotedMinor)}</span>
                  {row.quotedTax !== null && (
                    <span className="ml-2 text-xxs text-ink-muted">
                      {row.quotedTax.inclusive
                        ? t('market.inclusiveOfRate', { rate: row.quotedTax.ratePercent })
                        : t('market.plusRate', { rate: row.quotedTax.ratePercent })}
                    </span>
                  )}
                </>
              ),
          },
        ]
      : []),
    {
      key: 'available',
      header: 'Available',
      align: 'right',
      render: (row) => (
        // A variant nobody can buy is worth spotting from the product page,
        // not only from Inventory.
        <span
          className={row.availableQty <= 0 ? 'font-semibold text-danger' : 'font-medium text-ink'}
        >
          {formatNumber(row.availableQty)}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) =>
        row.archivedAt !== null ? (
          <Badge dot tone="danger">
            {t('variants.archived')}
          </Badge>
        ) : row.isActive ? (
          <Badge dot tone="success">
            {t('variants.active')}
          </Badge>
        ) : (
          <Badge dot tone="warning">
            {t('variants.inactive')}
          </Badge>
        ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">{t('variants.actions')}</span>,
      align: 'right',
      render: (row) =>
        canWrite ? (
          <div className="flex justify-end gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditorFor(row);
              }}
            >
              {t('variants.edit')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setRemoving(row);
              }}
            >
              {t('variants.remove')}
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <>
      <Card
        title={t('variants.variants')}
        description={t('variants.separatelyStockedAndPricedForms')}
        actions={
          canWrite ? (
            <Button
              size="sm"
              onClick={() => {
                setEditorFor(null);
              }}
            >
              {t('variants.addVariant')}
            </Button>
          ) : undefined
        }
      >
        <DataTable
          caption="Variants"
          columns={columns}
          rows={query.data?.variants}
          rowKey={(row) => row.id}
          isLoading={query.isPending}
          error={query.isError ? query.error : undefined}
          loadingLabel="Loading variants"
          // Wider with the preview column in, so the options badges keep their
          // line rather than the table cramming seven columns into six.
          minWidth={showsQuoted ? '58rem' : '52rem'}
          onRetry={() => {
            void query.refetch();
          }}
          emptyTitle="No variants"
          emptyDescription="This product is sold as a single item. Adding a variant switches it into variant mode."
        />
      </Card>

      {editorFor !== undefined && (
        <VariantEditor
          productId={productId}
          editing={editorFor}
          onClose={() => {
            setEditorFor(undefined);
          }}
        />
      )}

      <ConfirmDialog
        isOpen={removing !== null}
        onClose={() => {
          setRemoving(null);
        }}
        onConfirm={() => {
          if (removing !== null) remove.mutate(removing);
        }}
        title={`Remove ${removing?.name ?? 'variant'}?`}
        confirmLabel={
          (removing?.orderCount ?? 0) > 0 || (removing?.onHandQty ?? 0) > 0
            ? 'Archive variant'
            : 'Delete variant'
        }
        isDangerous
        isWorking={remove.isPending}
        body={
          (removing?.orderCount ?? 0) > 0 ? (
            <p>
              This variant appears on {formatNumber(removing?.orderCount ?? 0)} order
              {(removing?.orderCount ?? 0) === 1 ? '' : 's'}, so it will be archived rather than
              deleted. Order history stays readable.
            </p>
          ) : (removing?.onHandQty ?? 0) > 0 ? (
            <p>
              This variant still holds {formatNumber(removing?.onHandQty ?? 0)} in stock, so it will
              be archived rather than deleted.
            </p>
          ) : (
            <p>{t('variants.itHasNeverBeenOrdered')}</p>
          )
        }
      />
    </>
  );
}

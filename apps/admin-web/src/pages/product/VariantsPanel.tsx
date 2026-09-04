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
 */
import { useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
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

const variantSchema = z.object({
  sku: z.string().trim().min(1, 'A SKU is required.').max(64),
  name: z.string().trim().min(1, 'Give the variant a name.').max(255),
  price: z.union([
    z.string().trim().regex(/^\d+(\.\d{1,2})?$/, 'Enter an amount like 45.50, or leave blank.'),
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
      description="Leave the price blank to inherit the product's base price."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
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
            hint="Shares one namespace with product SKUs."
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

          <Field label="Name" error={errors.name?.message} required>
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

        <Field label="Price override" error={errors.price?.message}>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              inputMode="decimal"
              className="tabular"
              placeholder="Inherits the product price"
              aria-describedby={describedBy}
              invalid={errors.price !== undefined}
              {...register('price')}
            />
          )}
        </Field>

        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-ink">Options</legend>
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
                    placeholder="Size"
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
                    options.fields.length === 1
                      ? 'A variant needs at least one option.'
                      : undefined
                  }
                  onClick={() => {
                    options.remove(index);
                  }}
                >
                  Remove
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
            Add option
          </Button>
        </fieldset>
      </form>
    </Modal>
  );
}

export function VariantsPanel({ productId }: { productId: string }): React.JSX.Element {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [editorFor, setEditorFor] = useState<VariantRow | null | undefined>(undefined);
  const [removing, setRemoving] = useState<VariantRow | null>(null);

  const query = useQuery({
    queryKey: ['variants', productId],
    queryFn: () => api.get<{ variants: VariantRow[] }>(`/admin/products/${productId}/variants`),
  });

  const remove = useMutation({
    mutationFn: (variant: VariantRow) =>
      api.delete<{ deleted: boolean }>(`/admin/products/${productId}/variants/${variant.id}`),
    onSuccess: async (result) => {
      toast.success(result.deleted ? 'Variant deleted.' : 'Variant archived — orders reference it.');
      setRemoving(null);
      await queryClient.invalidateQueries({ queryKey: ['variants', productId] });
      await queryClient.invalidateQueries({ queryKey: ['product', productId] });
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : 'The variant could not be removed.');
    },
  });

  const canWrite = can(Permission.PRODUCT_WRITE);

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
          <span className="text-ink-muted">Inherits</span>
        ) : (
          minorToMajor(row.priceMinor)
        ),
    },
    {
      key: 'available',
      header: 'Available',
      align: 'right',
      render: (row) => (
        // A variant nobody can buy is worth spotting from the product page,
        // not only from Inventory.
        <span
          className={
            row.availableQty <= 0 ? 'font-semibold text-danger' : 'font-medium text-ink'
          }
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
            Archived
          </Badge>
        ) : row.isActive ? (
          <Badge dot tone="success">
            Active
          </Badge>
        ) : (
          <Badge dot tone="warning">
            Inactive
          </Badge>
        ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
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
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setRemoving(row);
              }}
            >
              Remove
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <>
      <Card
        title="Variants"
        description="Separately stocked and priced forms of this product."
        actions={
          canWrite ? (
            <Button
              size="sm"
              onClick={() => {
                setEditorFor(null);
              }}
            >
              Add variant
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
          minWidth="52rem"
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
            <p>
              It has never been ordered and holds no stock, so it will be deleted outright rather
              than left in the picker.
            </p>
          )
        }
      />
    </>
  );
}

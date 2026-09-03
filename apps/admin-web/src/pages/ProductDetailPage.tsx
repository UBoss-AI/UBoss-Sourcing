/**
 * Product editor.
 *
 * Three rules this screen exists to make visible:
 *
 *   1. **Money is typed in major units and sent in minor units.** The
 *      conversion is digit shifting, never `value * 100`. A price of 45.55
 *      must arrive as 4555, and floating point does not reliably produce that.
 *   2. **Active is not Published.** Two separate controls, because they are
 *      two separate decisions and the backend enforces both. Publication also
 *      has preconditions - an image, a price, an active category - and the
 *      server's refusal is shown verbatim rather than being pre-guessed here.
 *   3. **Publication is the only thing that reaches customers.** Saving a
 *      draft, adding an image or editing a price changes nothing a customer
 *      sees until the product is published.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { z } from 'zod';
import { useSession } from '@/auth/session-context';
import { ConfirmDialog } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import { SpecificationsPanel } from '@/pages/product/SpecificationsPanel';
import { VariantsPanel } from '@/pages/product/VariantsPanel';
import { CurrencyPricesPanel } from '@/pages/product/CurrencyPricesPanel';
import {
  Badge,
  Button,
  Card,
  ErrorState,
  Field,
  Input,
  LoadingState,
  PageHeader,
  Select,
  Textarea,
} from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { applyApiErrors, nullIfBlank } from '@/lib/forms';
import { formatDateTime, majorToMinor, minorToMajor } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import type { CategoryNode } from '@/lib/types';

interface TaxClass {
  id: string;
  code: string;
  name: string;
  ratePercent: string;
  isInclusive: boolean;
  isDefault: boolean;
  isActive: boolean;
}

interface MediaItem {
  mediaId: string;
  url: string;
  altText: string | null;
  isPrimary: boolean;
  sortOrder: number;
}

interface ProductDetail {
  id: string;
  categoryId: string;
  name: string;
  slug: string;
  sku: string;
  shortDescription: string | null;
  description: string | null;
  status: 'DRAFT' | 'ACTIVE' | 'INACTIVE';
  isPublished: boolean;
  publishedAt: string | null;
  taxClassId: string;
  basePriceMinor: string;
  currency: string;
  compareAtPriceMinor: string | null;
  isStockTracked: boolean;
  reorderThreshold: number;
  minOrderQty: number;
  maxOrderQty: number | null;
  qtyIncrement: number;
  isRecurringEligible: boolean;
  hasVariants: boolean;
  weightGrams: number | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  category: { id: string; name: string; slug: string; isActive: boolean } | null;
  taxClass: { code: string; name: string; ratePercent: string; isInclusive: boolean } | null;
  media: MediaItem[];
  /** Ordered by sortOrder server-side; the panel keeps that order. */
  attributes: { id: string; name: string; value: string; isFilterable: boolean }[];
  variants: unknown[];
}

/**
 * A money field.
 *
 * Validated as text, not as a number. `z.number()` on a price field accepts
 * 45.549999999 and rejects nothing useful; a regex on the typed string is what
 * catches "Rs 45", "1,299.00" and "45.555" before they reach the server.
 */
const moneyField = (label: string) =>
  z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,2})?$/, `${label} must be a number like 45.50, with no symbol or commas.`);

const productSchema = z
  .object({
    name: z.string().trim().min(1, 'Give the product a name.').max(255),
    sku: z.string().trim().min(1, 'A SKU is required.').max(64),
    categoryId: z.string().min(1, 'Choose a category.'),
    slug: z.string().trim().max(255),
    shortDescription: z.string().max(1024),
    description: z.string().max(50_000),
    taxClassCode: z.string().min(1, 'Choose a tax class.'),
    price: moneyField('Price'),
    compareAtPrice: z.union([moneyField('Compare-at price'), z.literal('')]),
    isStockTracked: z.boolean(),
    reorderThreshold: z.coerce.number().int().min(0).max(1_000_000),
    minOrderQty: z.coerce.number().int().min(1, 'At least 1.').max(1_000_000),
    maxOrderQty: z.string().trim(),
    qtyIncrement: z.coerce.number().int().min(1, 'At least 1.').max(1_000_000),
    isRecurringEligible: z.boolean(),
    weightGrams: z.string().trim(),
  })
  .superRefine((values, ctx) => {
    if (values.compareAtPrice !== '') {
      const compare = majorToMinor(values.compareAtPrice);
      const price = majorToMinor(values.price);
      if (compare !== null && price !== null && BigInt(compare) < BigInt(price)) {
        ctx.addIssue({
          code: 'custom',
          path: ['compareAtPrice'],
          message: 'The compare-at price must be at least the price, or the discount reads negative.',
        });
      }
    }

    if (values.maxOrderQty !== '') {
      const max = Number(values.maxOrderQty);
      if (!Number.isInteger(max) || max < 1) {
        ctx.addIssue({ code: 'custom', path: ['maxOrderQty'], message: 'Enter a whole number, or leave blank.' });
      } else if (max < values.minOrderQty) {
        // Otherwise no quantity satisfies both rules and nobody can buy it.
        ctx.addIssue({
          code: 'custom',
          path: ['maxOrderQty'],
          message: 'The maximum cannot be below the minimum, or the product cannot be ordered at all.',
        });
      }
    }

    if (values.weightGrams !== '' && !/^\d+$/.test(values.weightGrams)) {
      ctx.addIssue({ code: 'custom', path: ['weightGrams'], message: 'Enter a whole number of grams.' });
    }
  });

type ProductForm = z.output<typeof productSchema>;

const FORM_FIELDS = [
  'name',
  'sku',
  'categoryId',
  'slug',
  'shortDescription',
  'description',
  'taxClassCode',
  'price',
  'compareAtPrice',
  'isStockTracked',
  'reorderThreshold',
  'minOrderQty',
  'maxOrderQty',
  'qtyIncrement',
  'isRecurringEligible',
  'weightGrams',
] as const;

function flatten(nodes: CategoryNode[], into: CategoryNode[] = []): CategoryNode[] {
  for (const node of nodes) {
    into.push(node);
    flatten(node.children, into);
  }
  return into;
}

// ---------------------------------------------------------------------------

function MediaPanel({ product }: { product: ProductDetail }): React.JSX.Element {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append('file', file);
      form.append('altText', product.name);
      return api.upload<{ mediaId: string }>(`/admin/products/${product.id}/media`, form);
    },
    onSuccess: async () => {
      setUploadError(null);
      toast.success('Image added.');
      await queryClient.invalidateQueries({ queryKey: ['product', product.id] });
    },
    onError: (error) => {
      // The server sniffs magic bytes and refuses anything that is not a real
      // image, whatever the extension says. Its message explains which.
      setUploadError(error instanceof ApiError ? error.message : 'The image could not be uploaded.');
    },
  });

  const remove = useMutation({
    mutationFn: (mediaId: string) => api.delete(`/admin/products/${product.id}/media/${mediaId}`),
    onSuccess: async () => {
      toast.success('Image removed.');
      await queryClient.invalidateQueries({ queryKey: ['product', product.id] });
    },
    onError: () => {
      toast.error('The image could not be removed.');
    },
  });

  const canUpload = can(Permission.MEDIA_UPLOAD);

  return (
    <Card
      title="Images"
      description="Publication needs at least one image. The first is the one customers see in listings."
      actions={
        canUpload ? (
          <>
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file !== undefined) upload.mutate(file);
                // Reset so re-choosing the same file fires change again.
                event.target.value = '';
              }}
            />
            <Button
              size="sm"
              isLoading={upload.isPending}
              onClick={() => {
                fileRef.current?.click();
              }}
            >
              Add image
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="px-5 py-4">
        {uploadError !== null && (
          <p
            role="alert"
            className="mb-3 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger"
          >
            {uploadError}
          </p>
        )}

        {product.media.length === 0 ? (
          <p className="py-4 text-center text-sm text-ink-muted">
            No images yet. This product cannot be published until it has one.
          </p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {product.media.map((item) => (
              <li key={item.mediaId} className="group relative">
                <img
                  src={item.url}
                  alt={item.altText ?? product.name}
                  className="aspect-square w-full rounded-md border border-border object-cover"
                />
                {item.isPrimary && (
                  <span className="absolute left-1.5 top-1.5">
                    <Badge tone="accent">Primary</Badge>
                  </span>
                )}
                {canUpload && (
                  <Button
                    size="sm"
                    variant="danger"
                    className="absolute right-1.5 top-1.5 opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100"
                    onClick={() => {
                      remove.mutate(item.mediaId);
                    }}
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

export function ProductDetailPage(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const isNew = id === 'new';
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { can } = useSession();

  const [formError, setFormError] = useState<string | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [isArchiving, setIsArchiving] = useState(false);

  const productQuery = useQuery({
    queryKey: ['product', id],
    queryFn: () => api.get<{ product: ProductDetail }>(`/admin/products/${String(id)}`),
    enabled: !isNew && id !== undefined,
  });

  const categories = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get<{ categories: CategoryNode[] }>('/admin/categories'),
  });

  const taxClasses = useQuery({
    queryKey: ['tax-classes'],
    queryFn: () => api.get<{ taxClasses: TaxClass[] }>('/admin/settings/tax-classes'),
  });

  const product = productQuery.data?.product;

  const defaultTaxCode = useMemo(
    () => taxClasses.data?.taxClasses.find((taxClass) => taxClass.isDefault)?.code ?? '',
    [taxClasses.data],
  );

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isDirty },
  } = useForm<ProductForm>({
    resolver: zodResolver(productSchema),
    defaultValues: {
      name: '',
      sku: '',
      categoryId: '',
      slug: '',
      shortDescription: '',
      description: '',
      taxClassCode: '',
      price: '',
      compareAtPrice: '',
      isStockTracked: true,
      reorderThreshold: 0,
      minOrderQty: 1,
      maxOrderQty: '',
      qtyIncrement: 1,
      isRecurringEligible: false,
      weightGrams: '',
    },
  });

  // Fill the form once the product (or, for a new product, the default tax
  // class) has loaded. Resetting on every render would discard typing.
  useEffect(() => {
    if (isNew) {
      if (defaultTaxCode !== '') reset((current) => ({ ...current, taxClassCode: defaultTaxCode }));
      return;
    }

    if (product === undefined) return;

    reset({
      name: product.name,
      sku: product.sku,
      categoryId: product.categoryId,
      slug: product.slug,
      shortDescription: product.shortDescription ?? '',
      description: product.description ?? '',
      taxClassCode: product.taxClass?.code ?? defaultTaxCode,
      price: minorToMajor(product.basePriceMinor),
      compareAtPrice:
        product.compareAtPriceMinor === null ? '' : minorToMajor(product.compareAtPriceMinor),
      isStockTracked: product.isStockTracked,
      reorderThreshold: product.reorderThreshold,
      minOrderQty: product.minOrderQty,
      maxOrderQty: product.maxOrderQty === null ? '' : String(product.maxOrderQty),
      qtyIncrement: product.qtyIncrement,
      isRecurringEligible: product.isRecurringEligible,
      weightGrams: product.weightGrams === null ? '' : String(product.weightGrams),
    });
  }, [product, isNew, defaultTaxCode, reset]);

  const save = useMutation({
    mutationFn: async (values: ProductForm) => {
      const basePriceMinor = majorToMinor(values.price);
      const compareAtPriceMinor =
        values.compareAtPrice === '' ? null : majorToMinor(values.compareAtPrice);

      if (basePriceMinor === null) {
        throw new ApiError(400, {
          code: 'VALIDATION_FAILED',
          message: 'The price is not a valid amount.',
          details: [{ field: 'price', message: 'Enter an amount like 45.50.' }],
        });
      }

      const body = {
        name: values.name,
        sku: values.sku,
        categoryId: values.categoryId,
        slug: nullIfBlank(values.slug) ?? undefined,
        shortDescription: nullIfBlank(values.shortDescription),
        description: nullIfBlank(values.description),
        taxClassCode: values.taxClassCode,
        basePriceMinor,
        compareAtPriceMinor,
        isStockTracked: values.isStockTracked,
        reorderThreshold: values.reorderThreshold,
        minOrderQty: values.minOrderQty,
        maxOrderQty: values.maxOrderQty === '' ? null : Number(values.maxOrderQty),
        qtyIncrement: values.qtyIncrement,
        isRecurringEligible: values.isRecurringEligible,
        weightGrams: values.weightGrams === '' ? null : Number(values.weightGrams),
      };

      return isNew
        ? api.post<{ id: string }>('/admin/products', body)
        : api.patch<{ updated: boolean }>(`/admin/products/${String(id)}`, body);
    },
    onSuccess: async (result) => {
      setFormError(null);
      await queryClient.invalidateQueries({ queryKey: ['products'] });

      if (isNew && 'id' in result) {
        toast.success('Product created. Add an image, then publish it.');
        void navigate(`/products/${result.id}`, { replace: true });
        return;
      }

      toast.success('Product saved.');
      await queryClient.invalidateQueries({ queryKey: ['product', id] });
    },
    onError: (error) => {
      setFormError(applyApiErrors(error, setError, FORM_FIELDS));
    },
  });

  const setStatus = useMutation({
    mutationFn: (status: 'DRAFT' | 'ACTIVE' | 'INACTIVE') =>
      api.patch(`/admin/products/${String(id)}/status`, { status }),
    onSuccess: async () => {
      toast.success('Status updated.');
      await queryClient.invalidateQueries({ queryKey: ['product', id] });
      await queryClient.invalidateQueries({ queryKey: ['products'] });
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : 'The status could not be changed.');
    },
  });

  const setPublication = useMutation({
    mutationFn: (publish: boolean) =>
      api.patch(`/admin/products/${String(id)}/publication`, { publish }),
    onSuccess: async (_result, publish) => {
      setPublishError(null);
      toast.success(publish ? 'Product published.' : 'Product unpublished.');
      await queryClient.invalidateQueries({ queryKey: ['product', id] });
      await queryClient.invalidateQueries({ queryKey: ['products'] });
    },
    onError: (error) => {
      // The server checks the publication preconditions and names the one that
      // failed. Repeating that check here would be a second source of truth.
      setPublishError(
        error instanceof ApiError ? error.message : 'The product could not be published.',
      );
    },
  });

  const archive = useMutation({
    mutationFn: () => api.delete(`/admin/products/${String(id)}`),
    onSuccess: async () => {
      toast.success('Product archived.');
      await queryClient.invalidateQueries({ queryKey: ['products'] });
      void navigate('/products');
    },
    onError: (error) => {
      setIsArchiving(false);
      toast.error(error instanceof ApiError ? error.message : 'The product could not be archived.');
    },
  });

  if (!isNew && productQuery.isPending) {
    return (
      <Card>
        <LoadingState label="Loading the product" />
      </Card>
    );
  }

  if (!isNew && productQuery.isError) {
    return (
      <Card>
        <ErrorState
          error={productQuery.error}
          onRetry={() => {
            void productQuery.refetch();
          }}
        />
      </Card>
    );
  }

  const canWrite = can(Permission.PRODUCT_WRITE);
  const canPublish = can(Permission.PRODUCT_PUBLISH);
  const currency = product?.currency ?? 'INR';

  const submit = (): void => {
    void handleSubmit((values) => save.mutateAsync(values))();
  };

  return (
    <>
      <PageHeader
        title={isNew ? 'New product' : (product?.name ?? 'Product')}
        description={
          isNew
            ? 'Create the product first, then add images and publish it.'
            : `SKU ${product?.sku ?? ''} · last edited ${formatDateTime(product?.updatedAt)}`
        }
        actions={
          <>
            <Link
              to="/products"
              className="inline-flex h-9 items-center rounded-md border border-border-strong bg-surface px-4 text-sm font-medium text-ink hover:bg-surface-sunken"
            >
              Back to products
            </Link>
            {canWrite && (
              <Button variant="primary" isLoading={save.isPending} onClick={submit}>
                {isNew ? 'Create product' : 'Save changes'}
              </Button>
            )}
          </>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-5">
          <Card title="Details">
            <form
              className="space-y-4 px-5 py-4"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              {formError !== null && (
                <div
                  role="alert"
                  className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger"
                >
                  {formError}
                </div>
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Name" error={errors.name?.message} required>
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      aria-describedby={describedBy}
                      invalid={errors.name !== undefined}
                      disabled={!canWrite}
                      {...register('name')}
                    />
                  )}
                </Field>

                <Field
                  label="SKU"
                  hint="Unique across products and variants alike."
                  error={errors.sku?.message}
                  required
                >
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      className="font-mono"
                      aria-describedby={describedBy}
                      invalid={errors.sku !== undefined}
                      disabled={!canWrite}
                      {...register('sku')}
                    />
                  )}
                </Field>

                <Field label="Category" error={errors.categoryId?.message} required>
                  {({ inputId, describedBy }) => (
                    <Select
                      id={inputId}
                      aria-describedby={describedBy}
                      invalid={errors.categoryId !== undefined}
                      disabled={!canWrite}
                      {...register('categoryId')}
                    >
                      <option value="">Choose a category</option>
                      {flatten(categories.data?.categories ?? []).map((node) => (
                        <option key={node.id} value={node.id}>
                          {'— '.repeat(node.depth)}
                          {node.name}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>

                <Field
                  label="Slug"
                  hint="Leave blank to generate it from the name."
                  error={errors.slug?.message}
                >
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      aria-describedby={describedBy}
                      disabled={!canWrite}
                      {...register('slug')}
                    />
                  )}
                </Field>
              </div>

              <Field
                label="Short description"
                hint="One line, shown in listings."
                error={errors.shortDescription?.message}
              >
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    aria-describedby={describedBy}
                    disabled={!canWrite}
                    {...register('shortDescription')}
                  />
                )}
              </Field>

              <Field label="Description" error={errors.description?.message}>
                {({ inputId, describedBy }) => (
                  <Textarea
                    id={inputId}
                    rows={5}
                    aria-describedby={describedBy}
                    disabled={!canWrite}
                    {...register('description')}
                  />
                )}
              </Field>
            </form>
          </Card>

          <Card title="Pricing">
            <div className="grid gap-4 px-5 py-4 sm:grid-cols-3">
              <Field
                label={`Price (${currency})`}
                hint="Major units, e.g. 45.50."
                error={errors.price?.message}
                required
              >
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    inputMode="decimal"
                    className="tabular"
                    aria-describedby={describedBy}
                    invalid={errors.price !== undefined}
                    disabled={!canWrite}
                    {...register('price')}
                  />
                )}
              </Field>

              <Field
                label="Compare-at price"
                hint="Optional strike-through price."
                error={errors.compareAtPrice?.message}
              >
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    inputMode="decimal"
                    className="tabular"
                    aria-describedby={describedBy}
                    invalid={errors.compareAtPrice !== undefined}
                    disabled={!canWrite}
                    {...register('compareAtPrice')}
                  />
                )}
              </Field>

              <Field label="Tax class" error={errors.taxClassCode?.message} required>
                {({ inputId, describedBy }) => (
                  <Select
                    id={inputId}
                    aria-describedby={describedBy}
                    invalid={errors.taxClassCode !== undefined}
                    disabled={!canWrite}
                    {...register('taxClassCode')}
                  >
                    <option value="">Choose a tax class</option>
                    {(taxClasses.data?.taxClasses ?? [])
                      .filter((taxClass) => taxClass.isActive)
                      .map((taxClass) => (
                        <option key={taxClass.id} value={taxClass.code}>
                          {taxClass.name} ({taxClass.ratePercent}%
                          {taxClass.isInclusive ? ', inclusive' : ''})
                        </option>
                      ))}
                  </Select>
                )}
              </Field>
            </div>
          </Card>

          <CurrencyPricesPanel productId={id ?? ''} canWrite={canWrite} />

          <Card
            title="Ordering rules"
            description="Enforced on every cart change and again at checkout."
          >
            <div className="grid gap-4 px-5 py-4 sm:grid-cols-3">
              <Field label="Minimum quantity" error={errors.minOrderQty?.message}>
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    type="number"
                    min={1}
                    aria-describedby={describedBy}
                    invalid={errors.minOrderQty !== undefined}
                    disabled={!canWrite}
                    {...register('minOrderQty')}
                  />
                )}
              </Field>

              <Field
                label="Maximum quantity"
                hint="Blank means no limit."
                error={errors.maxOrderQty?.message}
              >
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    inputMode="numeric"
                    aria-describedby={describedBy}
                    invalid={errors.maxOrderQty !== undefined}
                    disabled={!canWrite}
                    {...register('maxOrderQty')}
                  />
                )}
              </Field>

              <Field
                label="Quantity step"
                hint="Orders must be a multiple of this."
                error={errors.qtyIncrement?.message}
              >
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    type="number"
                    min={1}
                    aria-describedby={describedBy}
                    invalid={errors.qtyIncrement !== undefined}
                    disabled={!canWrite}
                    {...register('qtyIncrement')}
                  />
                )}
              </Field>

              <Field label="Reorder threshold" error={errors.reorderThreshold?.message}>
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    type="number"
                    min={0}
                    aria-describedby={describedBy}
                    disabled={!canWrite}
                    {...register('reorderThreshold')}
                  />
                )}
              </Field>

              <Field label="Weight (grams)" error={errors.weightGrams?.message}>
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    inputMode="numeric"
                    aria-describedby={describedBy}
                    invalid={errors.weightGrams !== undefined}
                    disabled={!canWrite}
                    {...register('weightGrams')}
                  />
                )}
              </Field>

              <div className="flex flex-col justify-end gap-2 pb-2">
                <label className="flex items-center gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-border-strong text-accent"
                    disabled={!canWrite}
                    {...register('isStockTracked')}
                  />
                  Track stock
                </label>
                <label className="flex items-center gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-border-strong text-accent"
                    disabled={!canWrite}
                    {...register('isRecurringEligible')}
                  />
                  Available for recurring orders
                </label>
              </div>
            </div>
          </Card>

          {!isNew && product !== undefined && <MediaPanel product={product} />}
          {!isNew && product !== undefined && (
            <SpecificationsPanel
              productId={product.id}
              specifications={product.attributes.map((attribute) => ({
                name: attribute.name,
                value: attribute.value,
                isFilterable: attribute.isFilterable,
              }))}
            />
          )}
          {!isNew && product !== undefined && <VariantsPanel productId={product.id} />}
        </div>

        <div className="space-y-5">
          <Card title="Visibility">
            <div className="space-y-4 px-5 py-4">
              {isNew ? (
                <p className="text-sm text-ink-muted">
                  A new product starts as a draft. Create it first, then publish.
                </p>
              ) : (
                <>
                  <div>
                    <p className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                      Catalogue status
                    </p>
                    <div className="mt-1.5">
                      <Select
                        value={product?.status ?? 'DRAFT'}
                        disabled={!canWrite || setStatus.isPending}
                        onChange={(event) => {
                          setStatus.mutate(event.target.value as 'DRAFT' | 'ACTIVE' | 'INACTIVE');
                        }}
                        aria-label="Catalogue status"
                      >
                        <option value="DRAFT">Draft</option>
                        <option value="ACTIVE">Active</option>
                        <option value="INACTIVE">Inactive</option>
                      </Select>
                    </div>
                  </div>

                  <div className="border-t border-border pt-4">
                    <p className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                      Customer website
                    </p>
                    <div className="mt-1.5 flex items-center gap-2">
                      {product?.isPublished === true ? (
                        <Badge tone="success">Published</Badge>
                      ) : (
                        <Badge tone="neutral">Not published</Badge>
                      )}
                      {product?.publishedAt !== null && product?.publishedAt !== undefined && (
                        <span className="text-xs text-ink-muted">
                          since {formatDateTime(product.publishedAt)}
                        </span>
                      )}
                    </div>

                    <p className="mt-2 text-xs text-ink-muted">
                      A product reaches customers only when it is both Active and Published.
                    </p>

                    {publishError !== null && (
                      <p
                        role="alert"
                        className="mt-2 rounded-md bg-danger-soft px-3 py-2 text-xs font-medium text-danger"
                      >
                        {publishError}
                      </p>
                    )}

                    {canPublish && (
                      <Button
                        className="mt-3 w-full"
                        variant={product?.isPublished === true ? 'secondary' : 'primary'}
                        isLoading={setPublication.isPending}
                        onClick={() => {
                          setPublication.mutate(!(product?.isPublished ?? false));
                        }}
                      >
                        {product?.isPublished === true ? 'Unpublish' : 'Publish'}
                      </Button>
                    )}
                  </div>
                </>
              )}
            </div>
          </Card>

          {!isNew && can(Permission.PRODUCT_ARCHIVE) && (
            <Card title="Archive">
              <div className="px-5 py-4">
                <p className="text-xs text-ink-muted">
                  Archiving removes the product from the catalogue. Existing orders keep it, so
                  history stays readable.
                </p>
                <Button
                  variant="danger"
                  className="mt-3 w-full"
                  onClick={() => {
                    setIsArchiving(true);
                  }}
                >
                  Archive product
                </Button>
              </div>
            </Card>
          )}

          {isDirty && (
            <p role="status" className="text-xs text-warning">
              You have unsaved changes.
            </p>
          )}
        </div>
      </div>

      <ConfirmDialog
        isOpen={isArchiving}
        onClose={() => {
          setIsArchiving(false);
        }}
        onConfirm={() => {
          archive.mutate();
        }}
        title={`Archive ${product?.name ?? 'this product'}?`}
        confirmLabel="Archive product"
        isDangerous
        isWorking={archive.isPending}
        body="It disappears from the catalogue and the customer website. Orders that already include it are unaffected."
      />
    </>
  );
}

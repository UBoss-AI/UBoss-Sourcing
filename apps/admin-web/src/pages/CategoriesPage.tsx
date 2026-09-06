/**
 * Categories.
 *
 * The tree is rendered flat with an indent, not as nested `<ul>`s, because the
 * useful operations here are comparative - "which of these is out of order",
 * "which has no products" - and a flat list with a depth indent reads left to
 * right in one pass. It is a real `<table>` for the same reason every other
 * list in this panel is: the product count and the status belong in columns
 * that line up down the page, and a nested list cannot give them one.
 *
 * Archiving is the delicate part. A category with children or products cannot
 * simply disappear: the backend refuses, and this screen surfaces that refusal
 * with the counts rather than a bare CONFLICT.
 */
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { useSession } from '@/auth/session-context';
import { ConfirmDialog, Modal } from '@/components/Modal';
import { DataTable } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Callout,
  Card,
  CheckboxField,
  Field,
  Input,
  PageHeader,
  Select,
  Textarea,
} from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { applyApiErrors, nullIfBlank } from '@/lib/forms';
import { formatNumber } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import type { CategoryNode } from '@/lib/types';
import { useI18n } from '@/i18n/i18n-context';

const categorySchema = z.object({
  name: z.string().trim().min(1, 'Give the category a name.').max(255),
  slug: z.string().trim().max(255),
  parentId: z.string(),
  description: z.string().max(20_000),
  sortOrder: z.coerce.number().int().min(0).max(10_000),
  isActive: z.boolean(),
});

/**
 * Two types, not one, because `sortOrder` is coerced.
 *
 * What the form HOLDS is whatever the number input hands back - a string, or
 * nothing at all while the box is empty. What the schema PRODUCES is a number.
 * `useForm` is told both, so `handleSubmit` hands the mutation the parsed value
 * while `register` still types the raw one. Collapsing them to the output type
 * is what used to make the resolver unassignable.
 */
type CategoryFormInput = z.input<typeof categorySchema>;
type CategoryForm = z.output<typeof categorySchema>;

const FORM_FIELDS = ['name', 'slug', 'parentId', 'description', 'sortOrder', 'isActive'] as const;

/** Depth-first flatten, so the visual order matches the tree order. */
function flatten(nodes: CategoryNode[], into: CategoryNode[] = []): CategoryNode[] {
  for (const node of nodes) {
    into.push(node);
    flatten(node.children, into);
  }
  return into;
}

/** Ids in a node's subtree - a category cannot become its own descendant. */
function subtreeIds(node: CategoryNode): Set<string> {
  const ids = new Set<string>([node.id]);
  for (const child of flatten(node.children)) ids.add(child.id);
  return ids;
}

function CategoryEditor({
  isOpen,
  onClose,
  editing,
  allCategories,
}: {
  isOpen: boolean;
  onClose: () => void;
  editing: CategoryNode | null;
  allCategories: CategoryNode[];
}): React.JSX.Element {
  const { t } = useI18n();

  const queryClient = useQueryClient();
  const toast = useToast();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<CategoryFormInput, unknown, CategoryForm>({
    resolver: zodResolver(categorySchema),
    defaultValues: {
      name: editing?.name ?? '',
      slug: editing?.slug ?? '',
      parentId: editing?.parentId ?? '',
      description: '',
      sortOrder: editing?.sortOrder ?? 0,
      isActive: editing?.isActive ?? true,
    },
  });

  const mutation = useMutation({
    mutationFn: async (values: CategoryForm) => {
      const body = {
        name: values.name,
        slug: nullIfBlank(values.slug) ?? undefined,
        parentId: values.parentId === '' ? null : values.parentId,
        description: nullIfBlank(values.description),
        sortOrder: values.sortOrder,
        isActive: values.isActive,
      };

      return editing === null
        ? api.post<{ id: string }>('/admin/categories', body)
        : api.patch<{ updated: boolean }>(`/admin/categories/${editing.id}`, body);
    },
    onSuccess: async () => {
      toast.success(editing === null ? 'Category created.' : 'Category saved.');
      await queryClient.invalidateQueries({ queryKey: ['categories'] });
      onClose();
    },
    onError: (error) => {
      setFormError(applyApiErrors(error, setError, FORM_FIELDS));
    },
  });

  // A category cannot be moved under itself or any of its own descendants -
  // that would detach the whole subtree from the root and it would vanish.
  const forbidden = editing === null ? new Set<string>() : subtreeIds(editing);
  const options = flatten(allCategories).filter((node) => !forbidden.has(node.id));

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={editing === null ? 'New category' : `Edit ${editing.name}`}
      description={t('categories.slugIsGeneratedFromThe')}
      footer={
        <>
          <Button onClick={onClose} disabled={isSubmitting}>
            {t('categories.cancel')}
          </Button>
          <Button
            variant="primary"
            isLoading={isSubmitting || mutation.isPending}
            onClick={() => {
              void handleSubmit((values) => mutation.mutateAsync(values))();
            }}
          >
            {editing === null ? 'Create category' : 'Save changes'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit((values) => mutation.mutateAsync(values))();
        }}
      >
        {formError !== null && (
          <Callout tone="danger" role="alert">
            {formError}
          </Callout>
        )}

        <div className="space-y-4">
          <Field label={t('categories.name')} error={errors.name?.message} required>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                invalid={errors.name !== undefined}
                {...register('name')}
              />
            )}
          </Field>

          <Field
            label={t('categories.slug')}
            hint={t('categories.theUrlSegmentCustomersSee')}
            error={errors.slug?.message}
          >
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                className="font-mono"
                aria-describedby={describedBy}
                invalid={errors.slug !== undefined}
                {...register('slug')}
              />
            )}
          </Field>
        </div>

        {/* Where it sits in the tree, and in what order — one decision, so one
            group. Separated from the identity fields above because moving a
            category is a different kind of edit from renaming one. */}
        <div className="space-y-4 border-t border-border-subtle pt-4">
          <Field
            label={t('categories.parentCategory')}
            hint={t('categories.aCategoryCannotBeMoved')}
            error={errors.parentId?.message}
          >
            {({ inputId, describedBy }) => (
              <Select id={inputId} aria-describedby={describedBy} {...register('parentId')}>
                <option value="">No parent (top level)</option>
                {options.map((node) => (
                  <option key={node.id} value={node.id}>
                    {'— '.repeat(node.depth)}
                    {node.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field
            label={t('categories.sortOrder')}
            hint={t('categories.lowerNumbersComeFirstAmong')}
            error={errors.sortOrder?.message}
          >
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                type="number"
                min={0}
                className="tabular sm:w-40"
                aria-describedby={describedBy}
                {...register('sortOrder')}
              />
            )}
          </Field>

          <CheckboxField
            label={t('categories.active')}
            description={t('categories.anInactiveCategoryIsHidden')}
            {...register('isActive')}
          />
        </div>

        <div className="border-t border-border-subtle pt-4">
          <Field label={t('categories.description')} error={errors.description?.message}>
            {({ inputId, describedBy }) => (
              <Textarea id={inputId} aria-describedby={describedBy} {...register('description')} />
            )}
          </Field>
        </div>
      </form>
    </Modal>
  );
}

export function CategoriesPage(): React.JSX.Element {
  const { t } = useI18n();

  const { can } = useSession();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [editorFor, setEditorFor] = useState<CategoryNode | null | undefined>(undefined);
  const [archiving, setArchiving] = useState<CategoryNode | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get<{ categories: CategoryNode[] }>('/admin/categories'),
  });

  const archiveMutation = useMutation({
    mutationFn: (category: CategoryNode) =>
      api.delete<{ archived: boolean }>(`/admin/categories/${category.id}`),
    onSuccess: async () => {
      toast.success('Category archived.');
      setArchiving(null);
      setArchiveError(null);
      await queryClient.invalidateQueries({ queryKey: ['categories'] });
    },
    onError: (error) => {
      // The backend refuses when children or products still reference it, and
      // says which. Showing that message beats a generic failure toast.
      setArchiveError(
        error instanceof ApiError ? error.message : 'The category could not be archived.',
      );
    },
  });

  const rows = query.data === undefined ? undefined : flatten(query.data.categories);
  const canWrite = can(Permission.CATEGORY_WRITE);
  const canArchive = can(Permission.CATEGORY_ARCHIVE);

  const newCategoryButton = (
    <Button
      variant="primary"
      onClick={() => {
        setEditorFor(null);
      }}
    >
      {t('categories.newCategory')}
    </Button>
  );

  const columns: Column<CategoryNode>[] = [
    {
      key: 'name',
      header: 'Category',
      render: (node) => (
        // The indent is inline because Tailwind cannot generate a class from a
        // runtime value. The elbow is the depth cue: at four levels an indent
        // alone stops reading as hierarchy and starts reading as a wobble.
        <div
          className="flex items-center"
          style={{ paddingLeft: `${String(node.depth * 1.25)}rem` }}
        >
          {node.depth > 0 && (
            <span
              aria-hidden="true"
              className="mr-2 h-3.5 w-3 shrink-0 rounded-bl-sm border-b border-l border-border"
            />
          )}
          <div className="min-w-0">
            <p className="font-medium text-ink">{node.name}</p>
            <p className="truncate font-mono text-xxs text-ink-subtle">/{node.slug}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'products',
      header: 'Products',
      align: 'right',
      render: (node) =>
        (node.productCount ?? 0) === 0 ? (
          <span className="text-ink-subtle">0</span>
        ) : (
          formatNumber(node.productCount ?? 0)
        ),
    },
    {
      key: 'order',
      header: 'Sort',
      align: 'right',
      secondary: true,
      render: (node) => <span className="text-ink-muted">{formatNumber(node.sortOrder)}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      render: (node) =>
        node.archivedAt !== null && node.archivedAt !== undefined ? (
          <Badge dot tone="danger">
            {t('categories.archived')}
          </Badge>
        ) : node.isActive ? (
          <Badge dot tone="success">
            {t('categories.active')}
          </Badge>
        ) : (
          <Badge dot tone="warning">
            {t('categories.inactive')}
          </Badge>
        ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">{t('categories.actions')}</span>,
      align: 'right',
      render: (node) => (
        <div className="flex justify-end gap-1">
          {canWrite && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditorFor(node);
              }}
            >
              {t('categories.edit')}
              <span className="sr-only"> {node.name}</span>
            </Button>
          )}
          {canArchive && (node.archivedAt === null || node.archivedAt === undefined) && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setArchiveError(null);
                setArchiving(node);
              }}
            >
              {t('categories.archive')}
              <span className="sr-only"> {node.name}</span>
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title={t('categories.categories')}
        description={t('categories.theTreeCustomersBrowseOrder')}
        actions={canWrite ? newCategoryButton : undefined}
      />

      <Card>
        <DataTable
          caption="Categories"
          columns={columns}
          rows={rows}
          rowKey={(node) => node.id}
          isLoading={query.isPending}
          isRefreshing={query.isFetching && !query.isPending}
          error={query.isError ? query.error : undefined}
          loadingLabel="Loading categories"
          minWidth="44rem"
          onRetry={() => {
            void query.refetch();
          }}
          emptyTitle="No categories yet"
          emptyDescription="Every product needs a category, so this is the first thing to set up."
          emptyAction={canWrite ? newCategoryButton : undefined}
        />
      </Card>

      {editorFor !== undefined && (
        <CategoryEditor
          isOpen
          onClose={() => {
            setEditorFor(undefined);
          }}
          editing={editorFor}
          allCategories={query.data?.categories ?? []}
        />
      )}

      <ConfirmDialog
        isOpen={archiving !== null}
        onClose={() => {
          setArchiving(null);
          setArchiveError(null);
        }}
        onConfirm={() => {
          if (archiving !== null) archiveMutation.mutate(archiving);
        }}
        title={`Archive ${archiving?.name ?? 'category'}?`}
        confirmLabel={t('categories.archiveCategory')}
        isDangerous
        isWorking={archiveMutation.isPending}
        body={
          <div className="space-y-3">
            <p>{t('categories.anArchivedCategoryDisappearsFrom')}</p>
            {archiving !== null && (archiving.productCount ?? 0) > 0 && (
              <Callout tone="warning">
                {formatNumber(archiving.productCount ?? 0)} product
                {(archiving.productCount ?? 0) === 1 ? '' : 's'} sit in this category. The server
                refuses to archive a category that still has products or child categories.
              </Callout>
            )}
            {archiveError !== null && (
              <Callout tone="danger" role="alert">
                {archiveError}
              </Callout>
            )}
          </div>
        }
      />
    </>
  );
}

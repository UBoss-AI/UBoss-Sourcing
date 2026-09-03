/**
 * Categories.
 *
 * The tree is rendered flat with an indent, not as nested `<ul>`s, because the
 * useful operations here are comparative - "which of these is out of order",
 * "which has no products" - and a flat list with a depth indent reads left to
 * right in one pass.
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
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Card,
  EmptyState,
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
import { formatNumber } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import type { CategoryNode } from '@/lib/types';

const categorySchema = z.object({
  name: z.string().trim().min(1, 'Give the category a name.').max(255),
  slug: z.string().trim().max(255),
  parentId: z.string(),
  description: z.string().max(20_000),
  sortOrder: z.coerce.number().int().min(0).max(10_000),
  isActive: z.boolean(),
});

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
  const queryClient = useQueryClient();
  const toast = useToast();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<CategoryForm>({
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
      description="Slug is generated from the name when left blank."
      footer={
        <>
          <Button onClick={onClose} disabled={isSubmitting}>
            Cancel
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
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit((values) => mutation.mutateAsync(values))();
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

        <Field
          label="Slug"
          hint="The URL segment customers see. Leave blank to generate it from the name."
          error={errors.slug?.message}
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              invalid={errors.slug !== undefined}
              {...register('slug')}
            />
          )}
        </Field>

        <Field label="Parent category" error={errors.parentId?.message}>
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

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Sort order"
            hint="Lower numbers come first among siblings."
            error={errors.sortOrder?.message}
          >
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                type="number"
                min={0}
                aria-describedby={describedBy}
                {...register('sortOrder')}
              />
            )}
          </Field>

          <div className="flex items-end pb-2">
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-border-strong text-accent"
                {...register('isActive')}
              />
              Active
            </label>
          </div>
        </div>

        <Field label="Description" error={errors.description?.message}>
          {({ inputId, describedBy }) => (
            <Textarea id={inputId} aria-describedby={describedBy} {...register('description')} />
          )}
        </Field>
      </form>
    </Modal>
  );
}

export function CategoriesPage(): React.JSX.Element {
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
      setArchiveError(error instanceof ApiError ? error.message : 'The category could not be archived.');
    },
  });

  const rows = query.data === undefined ? [] : flatten(query.data.categories);
  const canWrite = can(Permission.CATEGORY_WRITE);
  const canArchive = can(Permission.CATEGORY_ARCHIVE);

  return (
    <>
      <PageHeader
        title="Categories"
        description="The tree customers browse. Order here is the order they see."
        actions={
          canWrite ? (
            <Button
              variant="primary"
              onClick={() => {
                setEditorFor(null);
              }}
            >
              New category
            </Button>
          ) : undefined
        }
      />

      <Card>
        {query.isError && (
          <ErrorState
            error={query.error}
            onRetry={() => {
              void query.refetch();
            }}
          />
        )}

        {query.isPending && <LoadingState label="Loading categories" />}

        {query.data !== undefined && rows.length === 0 && (
          <EmptyState
            title="No categories yet"
            description="Every product needs a category, so this is the first thing to set up."
            action={
              canWrite ? (
                <Button
                  variant="primary"
                  onClick={() => {
                    setEditorFor(null);
                  }}
                >
                  New category
                </Button>
              ) : undefined
            }
          />
        )}

        {rows.length > 0 && (
          <ul className="divide-y divide-border">
            {rows.map((node) => (
              <li
                key={node.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5"
                // Indent by depth. The padding is inline because Tailwind
                // cannot generate a class from a runtime value.
                style={{ paddingLeft: `${String(1 + node.depth * 1.5)}rem` }}
              >
                <span className="font-medium text-ink">{node.name}</span>
                <span className="font-mono text-xxs text-ink-subtle">/{node.slug}</span>

                {!node.isActive && <Badge tone="warning">Inactive</Badge>}
                {node.archivedAt !== null && node.archivedAt !== undefined && (
                  <Badge tone="danger">Archived</Badge>
                )}

                <span className="text-xs text-ink-muted">
                  {formatNumber(node.productCount ?? 0)} product
                  {(node.productCount ?? 0) === 1 ? '' : 's'}
                </span>

                <span className="flex-1" />

                {canWrite && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditorFor(node);
                    }}
                  >
                    Edit
                  </Button>
                )}
                {canArchive && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setArchiveError(null);
                      setArchiving(node);
                    }}
                  >
                    Archive
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
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
        confirmLabel="Archive category"
        isDangerous
        isWorking={archiveMutation.isPending}
        body={
          <div className="space-y-2">
            <p>
              An archived category disappears from the customer site. Products already in it keep
              their history and are not deleted.
            </p>
            {archiveError !== null && (
              <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 font-medium text-danger">
                {archiveError}
              </p>
            )}
          </div>
        }
      />
    </>
  );
}

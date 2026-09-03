/**
 * Product list.
 *
 * Filters live in the URL. A product list is the screen an administrator most
 * often sends to a colleague ("these three are still drafts"), and state held
 * in a component cannot be sent.
 *
 * The two status columns are deliberately separate. **Active** is a catalogue
 * decision; **Published** is a visibility decision, and the backend requires
 * both before a customer can see a product. Collapsing them into one "Live"
 * column would hide the most common confusion on this screen - an ACTIVE
 * product that nobody can find because it was never published.
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { DataTable, Pager } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import { Badge, Button, Card, Input, PageHeader, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { formatMoney, formatNumber } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import type { CategoryNode, ProductListItem, ProductListResponse } from '@/lib/types';

function flatten(nodes: CategoryNode[], into: CategoryNode[] = []): CategoryNode[] {
  for (const node of nodes) {
    into.push(node);
    flatten(node.children, into);
  }
  return into;
}

export function ProductsPage(): React.JSX.Element {
  const { can } = useSession();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const page = Number(searchParams.get('page') ?? '1');
  const status = searchParams.get('status') ?? '';
  const published = searchParams.get('published') ?? '';
  const categoryId = searchParams.get('categoryId') ?? '';
  const includeArchived = searchParams.get('includeArchived') === 'true';
  const q = searchParams.get('q') ?? '';

  // Local mirror of the search box so typing stays responsive, debounced into
  // the URL. Writing every keystroke to the URL floods the history stack.
  const [searchText, setSearchText] = useState(q);

  useEffect(() => {
    setSearchText(q);
  }, [q]);

  useEffect(() => {
    if (searchText === q) return undefined;

    const timer = window.setTimeout(() => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (searchText === '') next.delete('q');
          else next.set('q', searchText);
          next.delete('page');
          return next;
        },
        { replace: true },
      );
    }, 300);

    return () => {
      window.clearTimeout(timer);
    };
  }, [searchText, q, setSearchParams]);

  const setParam = (key: string, value: string): void => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (value === '') next.delete(key);
      else next.set(key, value);
      // Any filter change invalidates the page number - page 7 of the old
      // result set is very unlikely to exist in the new one.
      next.delete('page');
      return next;
    });
  };

  const categories = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get<{ categories: CategoryNode[] }>('/admin/categories'),
  });

  const query = useQuery({
    queryKey: ['products', { page, status, published, categoryId, includeArchived, q }],
    queryFn: () =>
      api.get<ProductListResponse>('/admin/products', {
        query: {
          page,
          limit: 25,
          status: status === '' ? undefined : status,
          published: published === '' ? undefined : published,
          categoryId: categoryId === '' ? undefined : categoryId,
          includeArchived: includeArchived ? 'true' : undefined,
          q: q === '' ? undefined : q,
        },
      }),
  });

  const columns: Column<ProductListItem>[] = [
    {
      key: 'name',
      header: 'Product',
      render: (row) => (
        <div>
          <Link
            to={`/products/${row.id}`}
            className="font-medium text-ink hover:text-accent hover:underline"
          >
            {row.name}
          </Link>
          <p className="font-mono text-xxs text-ink-subtle">{row.sku}</p>
        </div>
      ),
    },
    {
      key: 'category',
      header: 'Category',
      secondary: true,
      render: (row) => row.category?.name ?? '—',
    },
    { key: 'price', header: 'Price', align: 'right', render: (row) => formatMoney(row.price) },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <Badge tone={row.status === 'ACTIVE' ? 'success' : row.status === 'DRAFT' ? 'neutral' : 'warning'}>
          {row.status === 'ACTIVE' ? 'Active' : row.status === 'DRAFT' ? 'Draft' : 'Inactive'}
        </Badge>
      ),
    },
    {
      key: 'published',
      header: 'Published',
      render: (row) =>
        row.isPublished ? (
          <Badge tone="success">Live</Badge>
        ) : (
          <Badge tone="neutral">Not published</Badge>
        ),
    },
    {
      key: 'variants',
      header: 'Variants',
      align: 'right',
      secondary: true,
      render: (row) => (row.variantCount > 0 ? formatNumber(row.variantCount) : '—'),
    },
    {
      key: 'media',
      header: 'Images',
      align: 'right',
      secondary: true,
      render: (row) =>
        row.mediaCount === 0 ? (
          // Publication requires at least one image, so a zero here explains
          // why a product cannot go live before anyone tries.
          <span className="text-warning">0</span>
        ) : (
          formatNumber(row.mediaCount)
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Products"
        description="Everything in the catalogue, published or not."
        actions={
          <>
            {can(Permission.PRODUCT_IMPORT) && (
              <Link
                to="/products/import"
                className="inline-flex h-9 items-center rounded-md border border-border-strong bg-surface px-4 text-sm font-medium text-ink hover:bg-surface-sunken"
              >
                Bulk import
              </Link>
            )}
            {can(Permission.PRODUCT_WRITE) && (
              <Link
                to="/products/new"
                className="inline-flex h-9 items-center rounded-md bg-accent px-4 text-sm font-medium text-white hover:bg-accent-hover"
              >
                New product
              </Link>
            )}
          </>
        }
      />

      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-border px-4 py-3">
          <label className="flex-1 min-w-56">
            <span className="mb-1 block text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
              Search
            </span>
            <Input
              type="search"
              value={searchText}
              placeholder="Name or SKU"
              onChange={(event) => {
                setSearchText(event.target.value);
              }}
            />
          </label>

          <label>
            <span className="mb-1 block text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
              Category
            </span>
            <Select
              value={categoryId}
              onChange={(event) => {
                setParam('categoryId', event.target.value);
              }}
              className="w-48"
            >
              <option value="">All categories</option>
              {flatten(categories.data?.categories ?? []).map((node) => (
                <option key={node.id} value={node.id}>
                  {'— '.repeat(node.depth)}
                  {node.name}
                </option>
              ))}
            </Select>
          </label>

          <label>
            <span className="mb-1 block text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
              Status
            </span>
            <Select
              value={status}
              onChange={(event) => {
                setParam('status', event.target.value);
              }}
              className="w-36"
            >
              <option value="">Any status</option>
              <option value="DRAFT">Draft</option>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
            </Select>
          </label>

          <label>
            <span className="mb-1 block text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
              Visibility
            </span>
            <Select
              value={published}
              onChange={(event) => {
                setParam('published', event.target.value);
              }}
              className="w-40"
            >
              <option value="">Any visibility</option>
              <option value="true">Published</option>
              <option value="false">Not published</option>
            </Select>
          </label>

          <label className="flex items-center gap-2 pb-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(event) => {
                setParam('includeArchived', event.target.checked ? 'true' : '');
              }}
              className="h-4 w-4 rounded border-border-strong text-accent"
            />
            Include archived
          </label>
        </div>

        <DataTable
          caption="Products"
          columns={columns}
          rows={query.data?.products}
          rowKey={(row) => row.id}
          isLoading={query.isPending}
          error={query.isError ? query.error : undefined}
          onRetry={() => {
            void query.refetch();
          }}
          onRowClick={(row) => {
            void navigate(`/products/${row.id}`);
          }}
          emptyTitle={q === '' ? 'No products yet' : `Nothing matches “${q}”`}
          emptyDescription={
            q === ''
              ? 'Add products one at a time, or import a spreadsheet.'
              : 'Try a different search, or clear the filters.'
          }
          emptyAction={
            q === '' && can(Permission.PRODUCT_WRITE) ? (
              <Link
                to="/products/new"
                className="inline-flex h-9 items-center rounded-md bg-accent px-4 text-sm font-medium text-white hover:bg-accent-hover"
              >
                New product
              </Link>
            ) : (
              <Button
                onClick={() => {
                  setSearchParams({});
                }}
              >
                Clear filters
              </Button>
            )
          }
        />

        {query.data !== undefined && (
          <Pager
            page={query.data.pagination.page}
            limit={query.data.pagination.limit}
            total={query.data.pagination.total}
            totalPages={query.data.pagination.totalPages}
            onPageChange={(next) => {
              setSearchParams((current) => {
                const params = new URLSearchParams(current);
                params.set('page', String(next));
                return params;
              });
            }}
          />
        )}
      </Card>
    </>
  );
}

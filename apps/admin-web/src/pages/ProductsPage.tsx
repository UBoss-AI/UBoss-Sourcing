/**
 * Product list.
 *
 * Filters live in the URL. A product list is the screen an administrator most
 * often sends to a colleague ("these three are still drafts"), and state held
 * in a component cannot be sent.
 *
 * The two status columns are deliberately separate. **Catalogue** is a
 * catalogue decision (draft, active, inactive); **storefront** is a visibility
 * decision, and the backend requires both before a customer can see a product.
 * Collapsing them into one "Live" column would hide the most common confusion
 * on this screen - an ACTIVE product that nobody can find because it was never
 * published.
 *
 * The two supporting columns are there for the same reason: publication needs
 * at least one image, so a product with none can be spotted before somebody
 * tries to publish it and is refused.
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { DataTable, Pager } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import {
  Badge,
  Button,
  Card,
  Input,
  LinkButton,
  PageHeader,
  Select,
  Toolbar,
  ToolbarActions,
  ToolbarField,
  ToolbarToggle,
} from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
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

const CATALOGUE_STATUS: Record<ProductListItem['status'], { label: string; tone: BadgeTone }> = {
  ACTIVE: { label: 'Active', tone: 'success' },
  DRAFT: { label: 'Draft', tone: 'neutral' },
  INACTIVE: { label: 'Inactive', tone: 'warning' },
};

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

  const hasFilters =
    status !== '' || published !== '' || categoryId !== '' || includeArchived || q !== '';

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
        <div className="min-w-48">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link
              to={`/products/${row.id}`}
              className="font-medium text-ink hover:text-accent hover:underline"
            >
              {row.name}
            </Link>
            {/* Archived rows only appear when the filter asks for them, and
                without this they are indistinguishable from live ones. */}
            {row.archivedAt !== null && <Badge tone="danger">Archived</Badge>}
          </div>
          <p className="font-mono text-xxs text-ink-subtle">{row.sku}</p>
        </div>
      ),
    },
    {
      key: 'category',
      header: 'Category',
      secondary: true,
      render: (row) => row.category?.name ?? <span className="text-ink-subtle">—</span>,
    },
    {
      key: 'price',
      header: 'Price',
      align: 'right',
      nowrap: true,
      render: (row) => formatMoney(row.price),
    },
    {
      key: 'status',
      header: 'Catalogue',
      render: (row) => {
        const state = CATALOGUE_STATUS[row.status];
        return (
          <Badge dot tone={state.tone}>
            {state.label}
          </Badge>
        );
      },
    },
    {
      key: 'published',
      header: 'Storefront',
      render: (row) =>
        row.isPublished ? (
          <Badge dot tone="success">
            Live
          </Badge>
        ) : (
          <Badge dot tone="neutral">
            Not published
          </Badge>
        ),
    },
    {
      key: 'variants',
      header: 'Variants',
      align: 'right',
      secondary: true,
      render: (row) =>
        row.variantCount > 0 ? (
          formatNumber(row.variantCount)
        ) : (
          <span className="text-ink-subtle">—</span>
        ),
    },
    {
      key: 'media',
      header: 'Images',
      align: 'right',
      secondary: true,
      tertiary: true,
      render: (row) =>
        row.mediaCount === 0 ? (
          // Publication requires at least one image, so a zero here explains
          // why a product cannot go live before anyone tries.
          <Badge tone="warning">None</Badge>
        ) : (
          formatNumber(row.mediaCount)
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Products"
        description="A product reaches customers only when it is both Active in the catalogue and published to the storefront."
        actions={
          <>
            {can(Permission.PRODUCT_IMPORT) && (
              <LinkButton to="/products/import">Bulk import</LinkButton>
            )}
            {can(Permission.PRODUCT_WRITE) && (
              <LinkButton to="/products/new" variant="primary">
                New product
              </LinkButton>
            )}
          </>
        }
      />

      <Card>
        <Toolbar>
          <ToolbarField label="Search" grow>
            <Input
              type="search"
              value={searchText}
              placeholder="Name or SKU"
              onChange={(event) => {
                setSearchText(event.target.value);
              }}
            />
          </ToolbarField>

          <ToolbarField label="Category">
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
          </ToolbarField>

          <ToolbarField label="Catalogue">
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
          </ToolbarField>

          <ToolbarField label="Storefront">
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
          </ToolbarField>

          <ToolbarToggle
            label="Include archived"
            checked={includeArchived}
            onChange={(checked) => {
              setParam('includeArchived', checked ? 'true' : '');
            }}
          />

          {hasFilters && (
            <ToolbarActions>
              <Button
                onClick={() => {
                  setSearchParams({});
                }}
              >
                Clear filters
              </Button>
            </ToolbarActions>
          )}
        </Toolbar>

        <DataTable
          caption="Products"
          columns={columns}
          rows={query.data?.products}
          rowKey={(row) => row.id}
          isLoading={query.isPending}
          isRefreshing={query.isFetching && !query.isPending}
          error={query.isError ? query.error : undefined}
          loadingLabel="Loading products"
          minWidth="60rem"
          onRetry={() => {
            void query.refetch();
          }}
          onRowClick={(row) => {
            void navigate(`/products/${row.id}`);
          }}
          emptyTitle={hasFilters ? 'Nothing matches these filters' : 'No products yet'}
          emptyDescription={
            hasFilters
              ? 'Try a different search, or clear the filters.'
              : 'Add products one at a time, or import a spreadsheet.'
          }
          emptyAction={
            hasFilters ? (
              <Button
                onClick={() => {
                  setSearchParams({});
                }}
              >
                Clear filters
              </Button>
            ) : can(Permission.PRODUCT_WRITE) ? (
              <LinkButton to="/products/new" variant="primary">
                New product
              </LinkButton>
            ) : undefined
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

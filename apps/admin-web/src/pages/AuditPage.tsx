/**
 * Audit log.
 *
 * Append-only, and this screen offers no way to edit or delete an entry —
 * a log that can be edited is not evidence.
 *
 * `before` and `after` are shown as raw JSON on demand rather than prettified
 * into sentences. A summary would have to interpret, and interpretation is
 * exactly what an audit trail must not do. Secrets are already redacted
 * server-side before the entry is written.
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { DataTable, Pager } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import { Badge, Card, Input, PageHeader, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDateTime, humanise } from '@/lib/format';
import type { Pagination } from '@/lib/types';

interface AuditEntry {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  actorType: string;
  actorUserId: string | null;
  actorEmail: string | null;
  before: unknown;
  after: unknown;
  ipAddress: string | null;
  correlationId: string | null;
  createdAt: string;
}

function DetailToggle({ entry }: { entry: AuditEntry }): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false);

  const hasDetail = entry.before !== null || entry.after !== null;

  if (!hasDetail) return <span className="text-ink-subtle">—</span>;

  return (
    <div>
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => {
          setIsOpen((open) => !open);
        }}
        className="text-xs font-medium text-accent underline underline-offset-2"
      >
        {isOpen ? 'Hide detail' : 'Show detail'}
      </button>

      {isOpen && (
        <div className="mt-1.5 space-y-1.5">
          {entry.before !== null && (
            <div>
              <p className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                Before
              </p>
              <pre className="mt-0.5 max-w-md overflow-x-auto rounded bg-surface-sunken p-2 font-mono text-xxs text-ink">
                {JSON.stringify(entry.before, null, 2)}
              </pre>
            </div>
          )}
          {entry.after !== null && (
            <div>
              <p className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                After
              </p>
              <pre className="mt-0.5 max-w-md overflow-x-auto rounded bg-surface-sunken p-2 font-mono text-xxs text-ink">
                {JSON.stringify(entry.after, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function AuditPage(): React.JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();

  const page = Number(searchParams.get('page') ?? '1');
  const action = searchParams.get('action') ?? '';
  const actorEmail = searchParams.get('actorEmail') ?? '';
  const resourceType = searchParams.get('resourceType') ?? '';

  const query = useQuery({
    queryKey: ['audit', { page, action, actorEmail, resourceType }],
    queryFn: () =>
      api.get<{ entries: AuditEntry[]; pagination: Pagination }>('/admin/audit-logs', {
        query: {
          page,
          limit: 25,
          action: action === '' ? undefined : action,
          actorEmail: actorEmail === '' ? undefined : actorEmail,
          resourceType: resourceType === '' ? undefined : resourceType,
        },
      }),
  });

  const setParam = (key: string, value: string): void => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (value === '') next.delete(key);
      else next.set(key, value);
      next.delete('page');
      return next;
    });
  };

  const columns: Column<AuditEntry>[] = [
    {
      key: 'when',
      header: 'When',
      render: (row) => <span className="whitespace-nowrap">{formatDateTime(row.createdAt)}</span>,
    },
    {
      key: 'action',
      header: 'Action',
      render: (row) => <span className="font-mono text-xxs text-ink">{row.action}</span>,
    },
    {
      key: 'actor',
      header: 'By',
      render: (row) => (
        <div>
          <p className="text-ink">
            {row.actorEmail ?? (row.actorType === 'SYSTEM' ? 'The system' : humanise(row.actorType))}
          </p>
          {row.ipAddress !== null && <p className="text-xxs text-ink-subtle">{row.ipAddress}</p>}
        </div>
      ),
    },
    {
      key: 'resource',
      header: 'Resource',
      secondary: true,
      render: (row) => (
        <div>
          <Badge>{humanise(row.resourceType)}</Badge>
          {row.resourceId !== null && (
            <p className="mt-0.5 font-mono text-xxs text-ink-subtle">{row.resourceId}</p>
          )}
        </div>
      ),
    },
    { key: 'detail', header: 'Detail', render: (row) => <DetailToggle entry={row} /> },
    {
      key: 'correlation',
      header: 'Reference',
      secondary: true,
      render: (row) =>
        row.correlationId === null ? (
          <span className="text-ink-subtle">—</span>
        ) : (
          // The same id the API returns on an error, so a support report and
          // the log entry behind it can be lined up.
          <span className="font-mono text-xxs text-ink-subtle">{row.correlationId}</span>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Who changed what, when, and from where. Append-only — nothing here can be edited."
      />

      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-border px-4 py-3">
          <label className="min-w-48 flex-1">
            <span className="mb-1 block text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
              Action
            </span>
            <Input
              type="search"
              defaultValue={action}
              placeholder="e.g. product.updated"
              className="font-mono"
              onBlur={(event) => {
                setParam('action', event.target.value.trim());
              }}
            />
          </label>

          <label className="min-w-48 flex-1">
            <span className="mb-1 block text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
              Actor email
            </span>
            <Input
              type="search"
              defaultValue={actorEmail}
              placeholder="staff@example.com"
              onBlur={(event) => {
                setParam('actorEmail', event.target.value.trim());
              }}
            />
          </label>

          <label>
            <span className="mb-1 block text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
              Resource
            </span>
            <Select
              value={resourceType}
              onChange={(event) => {
                setParam('resourceType', event.target.value);
              }}
              className="w-44"
            >
              <option value="">Any resource</option>
              {[
                'user',
                'product',
                'category',
                'order',
                'payment',
                'customer_profile',
                'recurring_schedule',
                'payment_provider_connection',
                'import_job',
              ].map((value) => (
                <option key={value} value={value}>
                  {humanise(value)}
                </option>
              ))}
            </Select>
          </label>
        </div>

        <DataTable
          caption="Audit log"
          columns={columns}
          rows={query.data?.entries}
          rowKey={(row) => row.id}
          isLoading={query.isPending}
          error={query.isError ? query.error : undefined}
          onRetry={() => {
            void query.refetch();
          }}
          emptyTitle="Nothing matches these filters"
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

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
import {
  Badge,
  Button,
  Card,
  Input,
  PageHeader,
  Select,
  Toolbar,
  ToolbarActions,
  ToolbarField,
} from '@/components/ui';
import { api } from '@/lib/api';
import { formatDateTime, humanise } from '@/lib/format';
import type { Pagination } from '@/lib/types';
import { useI18n } from '@/i18n/i18n-context';

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

const RESOURCE_TYPES = [
  'user',
  'product',
  'category',
  'order',
  'payment',
  'customer_profile',
  'recurring_schedule',
  'payment_provider_connection',
  'import_job',
] as const;

function JsonBlock({ label, value }: { label: string; value: unknown }): React.JSX.Element {
  return (
    <div>
      <p className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">{label}</p>
      <pre className="mt-1 max-h-64 max-w-md overflow-auto rounded border border-border bg-surface-sunken p-2 font-mono text-xxs leading-relaxed text-ink">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function DetailToggle({ entry }: { entry: AuditEntry }): React.JSX.Element {
  const { t } = useI18n();

  const [isOpen, setIsOpen] = useState(false);

  const hasDetail = entry.before !== null || entry.after !== null;

  if (!hasDetail) return <span className="text-ink-subtle">—</span>;

  return (
    <div>
      <Button
        size="sm"
        variant="ghost"
        aria-expanded={isOpen}
        onClick={() => {
          setIsOpen((open) => !open);
        }}
      >
        {isOpen ? 'Hide detail' : 'Show detail'}
      </Button>

      {isOpen && (
        <div className="mt-2 space-y-2">
          {entry.before !== null && <JsonBlock label={t('audit.before')} value={entry.before} />}
          {entry.after !== null && <JsonBlock label={t('audit.after')} value={entry.after} />}
        </div>
      )}
    </div>
  );
}

export function AuditPage(): React.JSX.Element {
  const { t } = useI18n();

  const [searchParams, setSearchParams] = useSearchParams();

  const page = Number(searchParams.get('page') ?? '1');
  const action = searchParams.get('action') ?? '';
  const actorEmail = searchParams.get('actorEmail') ?? '';
  const resourceType = searchParams.get('resourceType') ?? '';

  const hasFilters = action !== '' || actorEmail !== '' || resourceType !== '';

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
      nowrap: true,
      render: (row) => <span className="text-ink-muted">{formatDateTime(row.createdAt)}</span>,
    },
    {
      key: 'action',
      header: 'Action',
      nowrap: true,
      render: (row) => (
        <span className="font-mono text-xxs font-medium text-ink">{row.action}</span>
      ),
    },
    {
      key: 'actor',
      header: 'By',
      render: (row) => (
        <div className="min-w-36">
          <p className="text-ink">
            {row.actorEmail ??
              (row.actorType === 'SYSTEM' ? 'The system' : humanise(row.actorType))}
          </p>
          {row.ipAddress !== null && (
            <p className="font-mono text-xxs text-ink-subtle">{row.ipAddress}</p>
          )}
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
            <p className="mt-1 font-mono text-xxs text-ink-subtle">{row.resourceId}</p>
          )}
        </div>
      ),
    },
    { key: 'detail', header: 'Detail', render: (row) => <DetailToggle entry={row} /> },
    {
      key: 'correlation',
      header: 'Reference',
      secondary: true,
      tertiary: true,
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
      <PageHeader title={t('audit.auditLog')} description={t('audit.whoChangedWhatWhenAnd')} />

      <Card>
        <Toolbar>
          <ToolbarField label={t('audit.action')} grow>
            <Input
              type="search"
              defaultValue={action}
              placeholder={t('audit.eGProductUpdated')}
              className="font-mono"
              // Applied when the field is left or Enter is pressed, rather than
              // on every keystroke: this filter is an exact match, and
              // re-querying at "p", "pr", "pro" is three wasted round trips
              // that all return nothing.
              onBlur={(event) => {
                setParam('action', event.target.value.trim());
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') setParam('action', event.currentTarget.value.trim());
              }}
            />
          </ToolbarField>

          <ToolbarField label={t('audit.actorEmail')} grow>
            <Input
              type="search"
              defaultValue={actorEmail}
              placeholder={t('audit.staffExampleCom')}
              onBlur={(event) => {
                setParam('actorEmail', event.target.value.trim());
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') setParam('actorEmail', event.currentTarget.value.trim());
              }}
            />
          </ToolbarField>

          <ToolbarField label={t('audit.resource')}>
            <Select
              value={resourceType}
              onChange={(event) => {
                setParam('resourceType', event.target.value);
              }}
              className="w-52"
            >
              <option value="">{t('audit.anyResource')}</option>
              {RESOURCE_TYPES.map((value) => (
                <option key={value} value={value}>
                  {humanise(value)}
                </option>
              ))}
            </Select>
          </ToolbarField>

          {hasFilters && (
            <ToolbarActions>
              <Button
                onClick={() => {
                  setSearchParams({});
                }}
              >
                {t('audit.clearFilters')}
              </Button>
            </ToolbarActions>
          )}
        </Toolbar>

        <DataTable
          caption="Audit log"
          columns={columns}
          // A `key` on the table would reset the open/closed detail toggles on
          // every page change; leaving it off keeps them, which is what you
          // want when you are comparing two entries.
          rows={query.data?.entries}
          rowKey={(row) => row.id}
          isLoading={query.isPending}
          isRefreshing={query.isFetching && !query.isPending}
          error={query.isError ? query.error : undefined}
          loadingLabel="Loading the audit log"
          minWidth="68rem"
          onRetry={() => {
            void query.refetch();
          }}
          emptyTitle={hasFilters ? 'Nothing matches these filters' : 'The log is empty'}
          emptyDescription={
            hasFilters
              ? 'Action and actor are exact matches, so a partial name finds nothing.'
              : 'Entries appear here as soon as anything is changed.'
          }
          emptyAction={
            hasFilters ? (
              <Button
                onClick={() => {
                  setSearchParams({});
                }}
              >
                {t('audit.clearFilters')}
              </Button>
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

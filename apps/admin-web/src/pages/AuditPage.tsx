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
 *
 * The role shown is the one recorded on the entry when it was written, never
 * the person's role today. Older entries recorded none, and say so.
 *
 * "Download CSV" takes the current filter, needs audit.read and
 * export.create, and is itself written to this log by the server.
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { DataTable, Pager } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import { useToast } from '@/components/toast-context';
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
import { ApiError } from '@/lib/api';
import { AUDIT_EXPORT_MAX_ROWS, type AuditEntry, auditLogApi } from '@/lib/audit-log';
import { formatDateTime, formatNumber, humanise } from '@/lib/format';
import { Permission, roleLabel } from '@/lib/permissions';
import { useI18n } from '@/i18n/i18n-context';

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
  'export_job',
  'audit_log',
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
        {isOpen ? t('audit.hideDetail') : t('audit.showDetail')}
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
  const { can } = useSession();
  const toast = useToast();

  const [searchParams, setSearchParams] = useSearchParams();

  const page = Number(searchParams.get('page') ?? '1');
  const action = searchParams.get('action') ?? '';
  const actorEmail = searchParams.get('actorEmail') ?? '';
  const resourceType = searchParams.get('resourceType') ?? '';

  const hasFilters = action !== '' || actorEmail !== '' || resourceType !== '';
  // The server checks both; hiding the button only spares a refusal.
  const canExport = can(Permission.AUDIT_READ) && can(Permission.EXPORT_CREATE);

  const query = useQuery({
    queryKey: ['audit', { page, action, actorEmail, resourceType }],
    queryFn: () => auditLogApi.list({ page, limit: 25, action, actorEmail, resourceType }),
  });

  const download = useMutation({
    mutationFn: () => auditLogApi.exportCsv({ action, actorEmail, resourceType }),
    onSuccess: ({ rows, total }) => {
      if (total > rows) {
        toast.info(
          t('audit.exportTruncated', { rows: formatNumber(rows), total: formatNumber(total) }),
        );
      } else {
        toast.success(t('audit.exportDone', { rows: formatNumber(rows) }));
      }
    },
    onError: (error) => {
      toast.error(
        error instanceof ApiError && error.status === 403
          ? t('audit.exportNotAllowed')
          : t('audit.exportFailed'),
      );
    },
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

  const deviceText = (row: AuditEntry): string | null => {
    if (row.device === null) return null;
    const { browser, os } = row.device;
    if (browser !== null && os !== null) return t('audit.browserOnOs', { browser, os });
    return browser ?? os ?? t('audit.unknownDevice');
  };

  const columns: Column<AuditEntry>[] = [
    {
      key: 'when',
      header: t('label.when'),
      nowrap: true,
      render: (row) => <span className="text-ink-muted">{formatDateTime(row.createdAt)}</span>,
    },
    {
      key: 'action',
      header: t('label.action'),
      nowrap: true,
      render: (row) => (
        <span className="font-mono text-xxs font-medium text-ink">{row.action}</span>
      ),
    },
    {
      key: 'actor',
      header: t('label.by'),
      render: (row) => (
        <div className="min-w-36">
          <p className="text-ink">
            {row.actorEmail ??
              (row.actorType === 'SYSTEM' ? t('audit.theSystem') : humanise(row.actorType))}
          </p>
          {row.actorRoles !== null && row.actorRoles.length > 0 ? (
            <div
              className="mt-1 flex flex-wrap gap-1"
              title={t('audit.roleAtTheTime')}
              aria-label={t('audit.roleAtTheTime')}
            >
              {row.actorRoles.map((role) => (
                <Badge key={role}>{roleLabel(role)}</Badge>
              ))}
            </div>
          ) : (
            row.actorUserId !== null && (
              <p className="text-xxs text-ink-subtle">{t('audit.roleNotRecorded')}</p>
            )
          )}
        </div>
      ),
    },
    {
      key: 'resource',
      header: t('label.resource'),
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
    {
      key: 'reason',
      header: t('audit.reason'),
      render: (row) =>
        row.reason === null ? (
          <span className="text-ink-subtle">—</span>
        ) : (
          <p className="max-w-56 break-words text-xs text-ink">{row.reason}</p>
        ),
    },
    {
      key: 'source',
      header: t('audit.source'),
      secondary: true,
      render: (row) => {
        const device = deviceText(row);
        if (row.ipAddress === null && device === null) {
          return <span className="text-ink-subtle">—</span>;
        }
        return (
          <div className="min-w-32">
            {row.ipAddress !== null && (
              <p className="font-mono text-xxs text-ink">{row.ipAddress}</p>
            )}
            {device !== null && (
              // The summary is an interpretation; the header it came from is
              // one hover away, and in the CSV unchanged.
              <p className="text-xxs text-ink-subtle" title={row.userAgent ?? undefined}>
                {device}
              </p>
            )}
          </div>
        );
      },
    },
    { key: 'detail', header: t('label.detail'), render: (row) => <DetailToggle entry={row} /> },
    {
      key: 'correlation',
      header: t('label.reference'),
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
      <PageHeader
        title={t('audit.auditLog')}
        description={t('audit.whoChangedWhatWhenAnd')}
        actions={
          canExport ? (
            <Button
              onClick={() => {
                download.mutate();
              }}
              disabled={download.isPending}
              aria-describedby="audit-export-hint"
            >
              {download.isPending ? t('audit.exporting') : t('audit.downloadCsv')}
            </Button>
          ) : undefined
        }
      />
      {canExport && (
        <p id="audit-export-hint" className="-mt-2 mb-3 text-xs text-ink-subtle">
          {t('audit.exportHint', { max: formatNumber(AUDIT_EXPORT_MAX_ROWS) })}
        </p>
      )}

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
          caption={t('audit.auditLog')}
          columns={columns}
          // A `key` on the table would reset the open/closed detail toggles on
          // every page change; leaving it off keeps them, which is what you
          // want when you are comparing two entries.
          rows={query.data?.entries}
          rowKey={(row) => row.id}
          isLoading={query.isPending}
          isRefreshing={query.isFetching && !query.isPending}
          error={query.isError ? query.error : undefined}
          loadingLabel={t('audit.loadingTheAuditLog')}
          minWidth="80rem"
          onRetry={() => {
            void query.refetch();
          }}
          emptyTitle={hasFilters ? t('common.nothingMatchesFilters') : t('audit.theLogIsEmpty')}
          emptyDescription={
            hasFilters
              ? t('audit.actionAndActorAreExact')
              : t('audit.entriesAppearHere')
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

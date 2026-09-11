/**
 * Support monitoring for CUSTOMERS' own ERP connections.
 *
 * Not Settings → ERP. That screen is the operator's own warehouse system — one
 * connection, configured here, carrying every order this installation takes.
 * This screen is about connections that belong to BUYERS: a hospital group's
 * SAP, a distributor's monday.com board, a practice's in-house API.
 *
 * WHAT THIS SCREEN DELIBERATELY CANNOT DO
 *
 * It is read-only, and that is a decision rather than an unfinished feature.
 * Testing, activating, pausing or retrying on a customer's behalf would mean
 * acting against a system this business does not own, using a credential its
 * customer supplied for their own purposes — and "support pressed the button"
 * is not a defensible answer to "who raised this purchase order in our SAP".
 * What support offers instead is a phone call and a screen-share.
 *
 * WHAT IT DELIBERATELY DOES NOT SHOW
 *
 * No credentials and no hints — not masked, absent. No endpoint paths, no base
 * URL beyond the host. No field mappings, no request bodies and no response
 * bodies, because those hold the customer's own SKUs, quantities and prices.
 * The API enforces all of that; this page could not render them if it tried.
 *
 * What is left is the part that actually determines the remedy: which tenant,
 * which system, what state, which host, how many failures, and the safe error
 * message. That is enough to tell somebody "your firewall is refusing us" or
 * "your authorisation expired on Tuesday", which is what they rang up to hear.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  Input,
  PageHeader,
  Select,
  Spinner,
} from '@/components/ui';
import { DataTable } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

type ConnectionState =
  | 'DRAFT'
  | 'TESTING'
  | 'ACTIVE'
  | 'PAUSED'
  | 'ACTION_REQUIRED'
  | 'FAILED'
  | 'DISCONNECTED';

interface BuyerConnection {
  id: string;
  organizationId: string;
  organizationName: string;
  name: string;
  system: 'SAP' | 'MONDAY' | 'ODOO' | 'CUSTOM';
  /**
   * The brand, where the customer picked one from the catalogue.
   *
   * Worth its own column entry because 'CUSTOM' covers a dozen named systems -
   * NetSuite, Dynamics, Zoho, TCS iON and the rest all speak REST over OAuth -
   * and a support queue that cannot tell them apart cannot triage them either.
   */
  vendorLabel: string;
  environment: 'SANDBOX' | 'PRODUCTION';
  state: ConnectionState;
  stateLabel: string;
  stateReason: string | null;
  /** The host, never the path. A buyer's URL structure is theirs. */
  host: string;
  authMethod: string;
  webhookEnabled: boolean;
  pollingEnabled: boolean;
  pollingIntervalMinutes: number;
  consecutiveFailures: number;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  nextPollAt: string | null;
  createdAt: string;
  eventCounts: Record<string, number>;
}

interface BuyerEvent {
  id: string;
  eventType: string;
  state: string;
  attemptCount: number;
  httpStatus: number | null;
  durationMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  skipReason: string | null;
  nextRetryAt: string | null;
  correlationId: string;
  createdAt: string;
  completedAt: string | null;
}

interface Summary {
  available: boolean;
  byState: Record<string, number>;
  bySystem: Record<string, number>;
  failingEvents: number;
  pendingApprovals: number;
}

/**
 * The tone each state is shown in.
 *
 * Matched to the customer-facing screen on purpose: a connection that is amber
 * to the buyer and green to support is two teams looking at one thing and
 * disagreeing about whether it is working.
 */
function stateTone(state: ConnectionState): 'success' | 'warning' | 'danger' | 'neutral' {
  switch (state) {
    case 'ACTIVE':
      return 'success';
    case 'ACTION_REQUIRED':
    case 'PAUSED':
    case 'TESTING':
      return 'warning';
    case 'FAILED':
      return 'danger';
    default:
      return 'neutral';
  }
}

export function CustomerErpPage(): React.JSX.Element {
  const [search, setSearch] = useState('');
  const [state, setState] = useState<ConnectionState | ''>('');
  const [selected, setSelected] = useState<BuyerConnection | null>(null);

  const summary = useQuery({
    queryKey: ['customer-erp', 'summary'],
    queryFn: () => api.get<Summary>('/admin/customer-erp/summary'),
  });

  const connections = useQuery({
    queryKey: ['customer-erp', 'connections', search, state],
    queryFn: () => {
      const params = new URLSearchParams();
      if (search.trim().length > 0) params.set('search', search.trim());
      if (state !== '') params.set('state', state);

      const query = params.toString();

      return api.get<{ available: boolean; connections: BuyerConnection[] }>(
        `/admin/customer-erp/connections${query.length === 0 ? '' : `?${query}`}`,
      );
    },
  });

  const events = useQuery({
    queryKey: ['customer-erp', 'events', selected?.id],
    queryFn: () =>
      api.get<{ events: BuyerEvent[] }>(
        `/admin/customer-erp/connections/${selected?.id ?? ''}/events`,
      ),
    enabled: selected !== null,
  });

  const columns: Column<BuyerConnection>[] = [
    {
      key: 'organizationName',
      header: 'Customer',
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-ink">{row.organizationName}</p>
          <p className="truncate text-xs text-ink-muted">{row.name}</p>
        </div>
      ),
    },
    {
      key: 'system',
      header: 'System',
      render: (row) => (
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone="neutral">{row.system}</Badge>
          {row.vendorLabel !== row.system && (
            <Badge tone="neutral">{row.vendorLabel}</Badge>
          )}
          {row.environment === 'SANDBOX' && <Badge tone="neutral">sandbox</Badge>}
        </div>
      ),
    },
    {
      key: 'state',
      header: 'State',
      render: (row) => (
        <div className="min-w-0">
          <Badge tone={stateTone(row.state)}>{row.stateLabel}</Badge>
          {row.stateReason !== null && (
            <p className="mt-1 max-w-xs text-xs leading-relaxed text-ink-muted">
              {row.stateReason}
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'host',
      header: 'Host',
      // The host and nothing else. "We cannot reach that host" is the useful
      // half of a customer's address and the only half support needs.
      render: (row) => <code className="font-mono text-xs text-ink-muted">{row.host}</code>,
    },
    {
      key: 'queue',
      header: 'Queue',
      render: (row) => {
        const failed = row.eventCounts['FAILED'] ?? 0;
        const queued = (row.eventCounts['QUEUED'] ?? 0) + (row.eventCounts['RETRYING'] ?? 0);

        return (
          <div className="text-xs">
            <p className={failed > 0 ? 'font-semibold text-danger' : 'text-ink-muted'}>
              {failed} failed
            </p>
            <p className="text-ink-muted">{queued} waiting</p>
          </div>
        );
      },
    },
    {
      key: 'lastSuccessAt',
      header: 'Last success',
      render: (row) => (
        <span className="text-xs text-ink-muted">
          {row.lastSuccessAt === null ? 'never' : formatDateTime(row.lastSuccessAt)}
        </span>
      ),
    },
    {
      key: 'events',
      header: '',
      /*
       * A real button rather than `onRowClick`.
       *
       * `onRowClick` is documented as a convenience for a row that already
       * contains a link to the same place, and this row does not - opening the
       * events panel is a local state change with no address of its own. A
       * button is what a keyboard and a screen reader can actually reach.
       */
      render: (row) => (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setSelected((current) => (current?.id === row.id ? null : row));
          }}
        >
          {selected?.id === row.id ? 'Hide events' : 'View events'}
        </Button>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Customer ERP connections"
        description="Whether customers' own purchasing systems are reachable, and what has failed. Read-only: credentials, mappings and order data are theirs."
      />

      {summary.data?.available === false && (
        <Callout tone="info" className="mb-6">
          Customer ERP connections are switched off for this installation. Set
          FEATURE_CUSTOMER_ERP=true to offer them.
        </Callout>
      )}

      {summary.data !== undefined && (
        <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Card>
            <p className="text-xs uppercase tracking-wider text-ink-subtle">Switched on</p>
            <p className="mt-1 text-title-lg text-ink">{summary.data.byState['ACTIVE'] ?? 0}</p>
          </Card>
          <Card>
            <p className="text-xs uppercase tracking-wider text-ink-subtle">Need attention</p>
            <p className="mt-1 text-title-lg text-warning">
              {(summary.data.byState['ACTION_REQUIRED'] ?? 0) +
                (summary.data.byState['FAILED'] ?? 0)}
            </p>
          </Card>
          <Card>
            <p className="text-xs uppercase tracking-wider text-ink-subtle">Failed events</p>
            <p
              className={
                summary.data.failingEvents > 0
                  ? 'mt-1 text-title-lg text-danger'
                  : 'mt-1 text-title-lg text-ink'
              }
            >
              {summary.data.failingEvents}
            </p>
          </Card>
          <Card>
            <p className="text-xs uppercase tracking-wider text-ink-subtle">Awaiting approval</p>
            <p className="mt-1 text-title-lg text-ink">{summary.data.pendingApprovals}</p>
          </Card>
        </div>
      )}

      <Card className="mb-6">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[16rem] flex-1">
            <label htmlFor="customer-erp-search" className="mb-1.5 block text-sm font-medium text-ink">
              Search
            </label>
            <Input
              id="customer-erp-search"
              placeholder="Customer or connection name"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
              }}
            />
          </div>

          <div className="w-56">
            <label htmlFor="customer-erp-state" className="mb-1.5 block text-sm font-medium text-ink">
              State
            </label>
            <Select
              id="customer-erp-state"
              value={state}
              onChange={(event) => {
                setState(event.target.value as ConnectionState | '');
              }}
            >
              <option value="">Any state</option>
              {(
                [
                  'ACTIVE',
                  'ACTION_REQUIRED',
                  'FAILED',
                  'PAUSED',
                  'DRAFT',
                  'TESTING',
                  'DISCONNECTED',
                ] as const
              ).map((value) => (
                <option key={value} value={value}>
                  {value.replace(/_/g, ' ').toLowerCase()}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </Card>

      {/*
       * `DataTable` renders its own loading, empty and error states, so the
       * page does not branch on them - which is what keeps this table looking
       * like every other table in the panel in all four conditions.
       */}
      <DataTable
        caption="Customer ERP connections"
        columns={columns}
        rows={connections.data?.connections}
        rowKey={(row) => row.id}
        isLoading={connections.isPending}
        isRefreshing={connections.isFetching && !connections.isPending}
        error={connections.error}
        onRetry={() => {
          void connections.refetch();
        }}
        minWidth="64rem"
        emptyTitle="No customer connections"
        emptyDescription="When a customer connects their own SAP, monday.com or API, it will appear here."
        loadingLabel="Loading customer connections"
      />

      {/*
       * One connection's recent events.
       *
       * The error code, the safe message, the status and the timings — and not
       * the request or response bodies, which hold the customer's own order
       * data. Support diagnosing "their SAP keeps refusing us" needs the code
       * and the status; it does not need their SKUs.
       */}
      {selected !== null && (
        <Card className="mt-6">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-title-sm text-ink">
                {selected.organizationName} — {selected.name}
              </h2>
              <p className="mt-1 text-xs text-ink-muted">
                {selected.authMethod.replace(/_/g, ' ').toLowerCase()} ·{' '}
                {selected.webhookEnabled ? 'webhooks on' : 'webhooks off'} ·{' '}
                {selected.pollingEnabled
                  ? `polls every ${selected.pollingIntervalMinutes} min`
                  : 'no polling'}
                {selected.consecutiveFailures > 0 &&
                  ` · ${selected.consecutiveFailures} consecutive failures`}
              </p>
            </div>

            <button
              type="button"
              className="text-sm text-ink-muted underline hover:text-ink"
              onClick={() => {
                setSelected(null);
              }}
            >
              Close
            </button>
          </div>

          {events.isPending ? (
            <div className="flex justify-center py-8">
              <Spinner />
            </div>
          ) : events.data === undefined || events.data.events.length === 0 ? (
            <EmptyState title="No events" description="Nothing has been sent on this connection." />
          ) : (
            <ul className="divide-y divide-border-subtle">
              {events.data.events.map((event) => (
                <li key={event.id} className="py-2.5">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge
                      tone={
                        event.state === 'SUCCEEDED'
                          ? 'success'
                          : event.state === 'FAILED'
                            ? 'danger'
                            : 'warning'
                      }
                    >
                      {event.state.toLowerCase()}
                    </Badge>

                    <span className="text-ink">
                      {event.eventType.replace(/_/g, ' ').toLowerCase()}
                    </span>

                    <span className="text-xs text-ink-muted">
                      {formatDateTime(event.createdAt)}
                    </span>

                    {event.httpStatus !== null && (
                      <span className="text-xs text-ink-muted">HTTP {event.httpStatus}</span>
                    )}

                    {event.attemptCount > 1 && (
                      <span className="text-xs text-ink-muted">
                        {event.attemptCount} attempts
                      </span>
                    )}
                  </div>

                  {event.errorMessage !== null && (
                    <p className="mt-1 max-w-prose text-xs leading-relaxed text-danger">
                      {event.errorCode === null ? '' : `${event.errorCode}: `}
                      {event.errorMessage}
                    </p>
                  )}

                  <p className="mt-1 font-mono text-xxs text-ink-subtle">{event.correlationId}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </>
  );
}

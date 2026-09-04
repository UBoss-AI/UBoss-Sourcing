/**
 * Integrations — payment gateway credentials, and third-party connectors.
 *
 * The gateway panel is the most consequential screen in this application: it
 * is where real money starts moving. The server enforces a three-step order
 * and this page makes it visible rather than papering over it — the steps are
 * printed on the panel, not just described in this comment, because the person
 * who needs them is looking at the screen and not at the source.
 *
 *   1. **Save.** Credentials are encrypted server-side. Saving always clears
 *      any previous test result and deactivates the connection.
 *   2. **Test.** Only this writes `lastTestStatus`. The test uses the saved
 *      credentials, not whatever the environment happens to hold.
 *   3. **Activate.** Refused unless the last test passed. There is no way to
 *      skip step 2 — the button is disabled here and the server refuses it
 *      anyway.
 *
 * A failed test also deactivates the connection. Credentials that have stopped
 * working must not keep taking payments.
 *
 * **TEST and LIVE are never blurred.** A `rzp_live_` key filed under TEST, or
 * the reverse, is rejected at save. LIVE mode is called out in plain language
 * and given its own red edge every time it appears, because the difference is
 * real money.
 */
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { useSession } from '@/auth/session-context';
import { DataTable } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import { ConfirmDialog, Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Callout,
  Card,
  DescriptionList,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  NoAccessState,
  PageHeader,
  Select,
} from '@/components/ui';
import { cx } from '@/lib/cx';
import { ApiError, api } from '@/lib/api';
import { applyApiErrors } from '@/lib/forms';
import { formatDateTime, humanise } from '@/lib/format';
import { Permission } from '@/lib/permissions';

interface Connection {
  id: string;
  provider: string;
  mode: 'TEST' | 'LIVE';
  label: string;
  credentialsMask: string;
  hasWebhookSecret: boolean;
  isActive: boolean;
  lastTestedAt: string | null;
  lastTestStatus: string | null;
  lastTestMessage: string | null;
  createdAt: string;
}

interface Connector {
  id: string;
  kind: string;
  name: string;
  isActive: boolean;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
}

const connectionSchema = z
  .object({
    provider: z.enum(['RAZORPAY', 'STRIPE']),
    mode: z.enum(['TEST', 'LIVE']),
    label: z.string().trim().min(1, 'Give this connection a name.').max(128),
    keyId: z.string().trim().min(1, 'The key id is required.').max(256),
    keySecret: z.string().trim().min(1, 'The key secret is required.').max(512),
    webhookSecret: z.string().trim().max(512),
  })
  .superRefine((values, ctx) => {
    // Caught here as well as server-side, because getting this wrong in the
    // LIVE direction means real money through a sandbox flow, or the reverse -
    // a checkout that looks successful and collects nothing.
    const looksLive = values.keyId.includes('_live_');

    if (looksLive && values.mode === 'TEST') {
      ctx.addIssue({
        code: 'custom',
        path: ['keyId'],
        message: 'That is a LIVE key but the mode is set to Test. Real money would move.',
      });
    }

    if (!looksLive && values.mode === 'LIVE' && values.keyId.includes('_test_')) {
      ctx.addIssue({
        code: 'custom',
        path: ['keyId'],
        message: 'That is a TEST key but the mode is set to Live. Checkout would collect nothing.',
      });
    }
  });

type ConnectionForm = z.output<typeof connectionSchema>;

function ConnectionDialog({
  existing,
  onClose,
}: {
  existing: Connection | null;
  onClose: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    setError,
    formState: { errors },
  } = useForm<ConnectionForm>({
    resolver: zodResolver(connectionSchema),
    defaultValues: {
      provider: (existing?.provider as 'RAZORPAY' | 'STRIPE' | undefined) ?? 'RAZORPAY',
      mode: existing?.mode ?? 'TEST',
      label: existing?.label ?? '',
      keyId: '',
      keySecret: '',
      webhookSecret: '',
    },
  });

  const save = useMutation({
    mutationFn: (values: ConnectionForm) =>
      api.put('/admin/payments/connections', {
        provider: values.provider,
        mode: values.mode,
        label: values.label,
        keyId: values.keyId,
        keySecret: values.keySecret,
        ...(values.webhookSecret === '' ? {} : { webhookSecret: values.webhookSecret }),
      }),
    onSuccess: async () => {
      toast.success('Saved. Run Test connection before activating.');
      await queryClient.invalidateQueries({ queryKey: ['payment-connections'] });
      onClose();
    },
    onError: (error) => {
      setFormError(applyApiErrors(error, setError, ['label', 'keyId', 'keySecret', 'webhookSecret']));
    },
  });

  const submit = (): void => {
    void handleSubmit((values) => save.mutateAsync(values))();
  };

  const mode = watch('mode');

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={existing === null ? 'Connect a payment gateway' : `Replace credentials for ${existing.label}`}
      description="Saving always deactivates the connection until it passes a test."
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button variant="primary" isLoading={save.isPending} onClick={submit}>
            Save credentials
          </Button>
        </>
      }
    >
      <form
        className="space-y-5"
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
          <Field label="Gateway">
            {({ inputId }) => (
              <Select id={inputId} disabled={existing !== null} {...register('provider')}>
                <option value="RAZORPAY">Razorpay</option>
                <option value="STRIPE">Stripe (adapter not implemented)</option>
              </Select>
            )}
          </Field>

          <Field label="Mode">
            {({ inputId }) => (
              <Select id={inputId} disabled={existing !== null} {...register('mode')}>
                <option value="TEST">Test — no real money can move</option>
                <option value="LIVE">Live — real money</option>
              </Select>
            )}
          </Field>
        </div>

        {mode === 'LIVE' && (
          <Callout tone="danger" role="alert" title="These are live credentials.">
            Once this connection is activated, customer checkouts charge real cards and refunds move
            real money. Use Test mode for anything that is not production.
          </Callout>
        )}

        <div className="space-y-4 border-t border-border-subtle pt-4">
          <Field
            label="Name"
            hint="How this connection is listed here, e.g. “Razorpay sandbox”."
            error={errors.label?.message}
            required
          >
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                invalid={errors.label !== undefined}
                {...register('label')}
              />
            )}
          </Field>

          <Field label="Key ID" error={errors.keyId?.message} required>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                className="font-mono"
                autoComplete="off"
                placeholder="rzp_test_…"
                aria-describedby={describedBy}
                invalid={errors.keyId !== undefined}
                {...register('keyId')}
              />
            )}
          </Field>

          <Field
            label="Key secret"
            hint="Encrypted before storage and never sent back to this screen."
            error={errors.keySecret?.message}
            required
          >
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                type="password"
                className="font-mono"
                autoComplete="off"
                aria-describedby={describedBy}
                invalid={errors.keySecret !== undefined}
                {...register('keySecret')}
              />
            )}
          </Field>

          <Field
            label="Webhook secret"
            hint="From the gateway dashboard. Without it, no incoming payment event can be verified — and an unverified event is never applied, so no order would ever be confirmed by a payment."
            error={errors.webhookSecret?.message}
          >
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                type="password"
                className="font-mono"
                autoComplete="off"
                aria-describedby={describedBy}
                {...register('webhookSecret')}
              />
            )}
          </Field>
        </div>
      </form>
    </Modal>
  );
}

/** The order the server enforces, printed where it is needed. */
function GatewaySteps(): React.JSX.Element {
  const steps = [
    { title: 'Save', detail: 'Credentials are encrypted server-side, and the connection is switched off.' },
    { title: 'Test', detail: 'The gateway is asked whether the saved credentials work. Only this records a result.' },
    { title: 'Activate', detail: 'Refused unless the last test passed. Any other active gateway is switched off.' },
  ];

  return (
    <ol className="grid gap-3 border-b border-border-subtle bg-surface-sunken px-5 py-4 sm:grid-cols-3">
      {steps.map((step, index) => (
        <li key={step.title} className="flex gap-2.5">
          <span
            aria-hidden="true"
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xxs font-bold text-accent"
          >
            {index + 1}
          </span>
          <span className="min-w-0">
            <span className="block text-xs font-semibold text-ink">{step.title}</span>
            <span className="mt-0.5 block text-xxs leading-relaxed text-ink-muted">
              {step.detail}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function ConnectionRow({
  connection,
  canWrite,
  isTesting,
  onTest,
  onDeactivate,
  onActivate,
  onReplace,
}: {
  connection: Connection;
  canWrite: boolean;
  isTesting: boolean;
  onTest: () => void;
  onDeactivate: () => void;
  onActivate: () => void;
  onReplace: () => void;
}): React.JSX.Element {
  const canActivate = connection.lastTestStatus === 'OK';
  const isLive = connection.mode === 'LIVE';

  return (
    <li
      className={cx(
        'border-l-4 px-5 py-4',
        // A live gateway that is switched on is the one thing on this page
        // that can charge a real card. It gets a red edge; everything else
        // gets a plain one, so the marker keeps its meaning.
        isLive && connection.isActive
          ? 'border-l-danger bg-danger-soft/40'
          : isLive
            ? 'border-l-danger/40'
            : 'border-l-transparent',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-ink">{connection.label}</span>
        <Badge>{humanise(connection.provider)}</Badge>
        {isLive ? (
          <Badge dot tone="danger">
            Live — real money
          </Badge>
        ) : (
          <Badge dot tone="accent">
            Test — no real money
          </Badge>
        )}
        {connection.isActive ? (
          <Badge dot tone="success">
            Active
          </Badge>
        ) : (
          <Badge dot tone="neutral">
            Inactive
          </Badge>
        )}
      </div>

      <DescriptionList
        className="mt-3"
        columns={3}
        items={[
          { label: 'Key', value: <span className="font-mono">{connection.credentialsMask}</span> },
          {
            label: 'Webhook secret',
            value: connection.hasWebhookSecret ? (
              'Stored'
            ) : (
              <span className="font-medium text-warning">Missing</span>
            ),
          },
          {
            label: 'Last test',
            value:
              connection.lastTestStatus === null ? (
                <span className="text-ink-muted">Never tested</span>
              ) : (
                <span
                  className={
                    connection.lastTestStatus === 'OK'
                      ? 'font-medium text-success'
                      : 'font-medium text-danger'
                  }
                >
                  {connection.lastTestStatus} · {formatDateTime(connection.lastTestedAt)}
                </span>
              ),
          },
        ]}
      />

      {connection.lastTestMessage !== null && (
        <p
          className={cx(
            'mt-2 text-xs leading-relaxed',
            connection.lastTestStatus === 'OK' ? 'text-ink-muted' : 'text-danger',
          )}
        >
          {connection.lastTestMessage}
        </p>
      )}

      {!connection.hasWebhookSecret && (
        <Callout tone="warning" className="mt-3">
          Without a webhook secret, no incoming payment event can be verified — so no order will
          ever be confirmed by a payment.
        </Callout>
      )}

      {canWrite && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button size="sm" isLoading={isTesting} onClick={onTest}>
            Test connection
          </Button>

          {connection.isActive ? (
            <Button size="sm" variant="secondary" onClick={onDeactivate}>
              Deactivate
            </Button>
          ) : (
            <Button
              size="sm"
              // Turning on a LIVE gateway is the irreversible-feeling step on
              // this page, so it is the one button here that is red.
              variant={isLive ? 'danger' : 'primary'}
              disabled={!canActivate}
              title={canActivate ? undefined : 'Run a successful test first.'}
              onClick={onActivate}
            >
              {isLive ? 'Activate live payments' : 'Activate'}
            </Button>
          )}

          <Button size="sm" variant="ghost" onClick={onReplace}>
            Replace credentials
          </Button>

          {!connection.isActive && !canActivate && (
            <p className="text-xs text-ink-muted">
              Activation needs a passing test — enforced by the server, not just by this button.
            </p>
          )}
        </div>
      )}
    </li>
  );
}

function GatewayPanel(): React.JSX.Element {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { can } = useSession();

  const [dialogFor, setDialogFor] = useState<Connection | null | undefined>(undefined);
  const [activating, setActivating] = useState<Connection | null>(null);

  const query = useQuery({
    queryKey: ['payment-connections'],
    queryFn: () => api.get<{ connections: Connection[] }>('/admin/payments/connections'),
  });

  const test = useMutation({
    mutationFn: (connection: Connection) =>
      api.post<{ ok: boolean; mode: string | null; message: string }>(
        `/admin/payments/connections/${connection.id}/test`,
      ),
    onSuccess: async (result) => {
      if (result.ok) toast.success(result.message);
      else toast.error(result.message);
      await queryClient.invalidateQueries({ queryKey: ['payment-connections'] });
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : 'The test could not be run.');
    },
  });

  const setStatus = useMutation({
    mutationFn: ({ connection, active }: { connection: Connection; active: boolean }) =>
      api.patch(`/admin/payments/connections/${connection.id}/status`, { active }),
    onSuccess: async (_result, variables) => {
      setActivating(null);
      toast.success(variables.active ? 'Gateway activated.' : 'Gateway deactivated.');
      await queryClient.invalidateQueries({ queryKey: ['payment-connections'] });
    },
    onError: (error) => {
      setActivating(null);
      toast.error(error instanceof ApiError ? error.message : 'The status could not be changed.');
    },
  });

  const canWrite = can(Permission.PAYMENT_GATEWAY_WRITE);
  const connections = query.data?.connections;

  return (
    <>
      <Card
        title="Payment gateway"
        description="Exactly one connection is active at a time. Customers cannot pay until one is connected, tested and activated."
        actions={
          canWrite ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                setDialogFor(null);
              }}
            >
              Add credentials
            </Button>
          ) : undefined
        }
      >
        {canWrite && <GatewaySteps />}

        {query.isPending && <LoadingState label="Loading gateway connections" />}
        {query.isError && (
          <ErrorState
            error={query.error}
            onRetry={() => {
              void query.refetch();
            }}
          />
        )}

        {connections !== undefined && connections.length === 0 && (
          <EmptyState
            title="No gateway connected"
            description="Start in Test mode — no real money can move on a test key, and the same three steps apply."
            action={
              canWrite ? (
                <Button
                  variant="primary"
                  onClick={() => {
                    setDialogFor(null);
                  }}
                >
                  Add credentials
                </Button>
              ) : undefined
            }
          />
        )}

        {connections !== undefined && connections.length > 0 && (
          <ul className="divide-y divide-border">
            {connections.map((connection) => (
              <ConnectionRow
                key={connection.id}
                connection={connection}
                canWrite={canWrite}
                isTesting={test.isPending && test.variables.id === connection.id}
                onTest={() => {
                  test.mutate(connection);
                }}
                onDeactivate={() => {
                  setStatus.mutate({ connection, active: false });
                }}
                onActivate={() => {
                  setActivating(connection);
                }}
                onReplace={() => {
                  setDialogFor(connection);
                }}
              />
            ))}
          </ul>
        )}
      </Card>

      {dialogFor !== undefined && (
        <ConnectionDialog
          existing={dialogFor}
          onClose={() => {
            setDialogFor(undefined);
          }}
        />
      )}

      <ConfirmDialog
        isOpen={activating !== null}
        onClose={() => {
          setActivating(null);
        }}
        onConfirm={() => {
          if (activating !== null) setStatus.mutate({ connection: activating, active: true });
        }}
        title={
          activating?.mode === 'LIVE'
            ? 'Activate LIVE payments?'
            : `Activate ${activating?.label ?? 'this gateway'}?`
        }
        confirmLabel={activating?.mode === 'LIVE' ? 'Activate live payments' : 'Activate gateway'}
        isDangerous={activating?.mode === 'LIVE'}
        isWorking={setStatus.isPending}
        body={
          activating?.mode === 'LIVE' ? (
            <div className="space-y-2">
              <Callout tone="danger" title="Real cards, from this moment.">
                Customer checkouts will charge real cards and refunds will move real money.
              </Callout>
              <p>Any other active gateway is switched off — only one can be live at a time.</p>
            </div>
          ) : (
            <div className="space-y-2">
              <p>
                This is a <strong>test</strong> connection. No real money can move on a test key.
              </p>
              <p>Any other active gateway is switched off — only one can be active at a time.</p>
            </div>
          )
        }
      />
    </>
  );
}

function ConnectorsPanel(): React.JSX.Element {
  const query = useQuery({
    queryKey: ['connectors'],
    queryFn: () => api.get<{ connectors: Connector[] }>('/admin/integrations'),
  });

  const columns: Column<Connector>[] = [
    {
      key: 'name',
      header: 'Connector',
      render: (row) => <span className="font-medium text-ink">{row.name}</span>,
    },
    { key: 'kind', header: 'Type', render: (row) => <Badge>{humanise(row.kind)}</Badge> },
    {
      key: 'status',
      header: 'Status',
      render: (row) =>
        row.isActive ? (
          <Badge dot tone="success">
            Active
          </Badge>
        ) : (
          <Badge dot tone="neutral">
            Inactive
          </Badge>
        ),
    },
    {
      key: 'sync',
      header: 'Last sync',
      nowrap: true,
      render: (row) =>
        row.lastSyncAt === null ? (
          <span className="text-ink-subtle">Never</span>
        ) : (
          <span className="text-ink-muted">
            {humanise(row.lastSyncStatus ?? 'UNKNOWN')} · {formatDateTime(row.lastSyncAt)}
          </span>
        ),
    },
  ];

  return (
    <Card title="Other integrations" description="Accounting, shipping and ERP connectors.">
      <DataTable
        caption="Connectors"
        columns={columns}
        rows={query.data?.connectors}
        rowKey={(row) => row.id}
        isLoading={query.isPending}
        error={query.isError ? query.error : undefined}
        loadingLabel="Loading connectors"
        minWidth="42rem"
        onRetry={() => {
          void query.refetch();
        }}
        emptyTitle="No connectors configured"
        emptyDescription="Nothing is syncing to an external system."
      />
    </Card>
  );
}

export function IntegrationsPage(): React.JSX.Element {
  const { can } = useSession();

  // This page is reachable with EITHER permission - a Finance Approver holds
  // payment_gateway.write but not integration.read. Each panel therefore
  // checks its own, or one of them 403s on a page the user legitimately
  // reached.
  const showsGateway = can(Permission.PAYMENT_READ) || can(Permission.PAYMENT_GATEWAY_WRITE);
  const showsConnectors = can(Permission.INTEGRATION_READ);

  return (
    <>
      <PageHeader
        title="Integrations"
        description="Payment gateway credentials and third-party connectors. Secrets are encrypted before storage and never sent back to this screen."
      />

      <div className="space-y-5">
        {showsGateway && <GatewayPanel />}
        {showsConnectors && <ConnectorsPanel />}

        {/* Reachable only if the route guard and these two checks ever fall out
            of step. Better an honest panel than a blank page. */}
        {!showsGateway && !showsConnectors && (
          <Card>
            <NoAccessState />
          </Card>
        )}
      </div>
    </>
  );
}

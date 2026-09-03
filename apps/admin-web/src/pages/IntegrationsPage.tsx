/**
 * Integrations — payment gateway credentials, and third-party connectors.
 *
 * The gateway panel is the most consequential screen in this application: it
 * is where real money starts moving. The server enforces a three-step order
 * and this page makes it visible rather than papering over it.
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
 * every time it appears, because the difference is real money.
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
  Card,
  ErrorState,
  Field,
  Input,
  LoadingState,
  PageHeader,
  Select,
} from '@/components/ui';
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
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" isLoading={save.isPending} onClick={submit}>
            Save credentials
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
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
          <div
            role="alert"
            className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm"
          >
            <p className="font-semibold text-danger">These are live credentials.</p>
            <p className="mt-0.5 text-ink">
              Once this connection is activated, customer checkouts charge real cards and refunds
              move real money. Use Test mode for anything that is not production.
            </p>
          </div>
        )}

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
          hint="From the gateway dashboard. Without it, no incoming payment event can be verified — and an unverified event is never applied."
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
      </form>
    </Modal>
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

  return (
    <>
      <Card
        title="Payment gateway"
        description="Save, test, then activate. Exactly one connection is active at a time."
        actions={
          canWrite ? (
            <Button
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
        {query.isPending && <LoadingState />}
        {query.isError && (
          <ErrorState
            error={query.error}
            onRetry={() => {
              void query.refetch();
            }}
          />
        )}

        {query.data?.connections.length === 0 && (
          <div className="px-5 py-10 text-center">
            <p className="text-sm font-medium text-ink">No gateway connected</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-ink-muted">
              Customers cannot pay until one is connected, tested and activated. Start in Test mode —
              no real money can move on a test key.
            </p>
          </div>
        )}

        {query.data !== undefined && query.data.connections.length > 0 && (
          <ul className="divide-y divide-border">
            {query.data.connections.map((connection) => {
              const canActivate = connection.lastTestStatus === 'OK';

              return (
                <li key={connection.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-ink">{connection.label}</span>
                    <Badge>{humanise(connection.provider)}</Badge>
                    {connection.mode === 'LIVE' ? (
                      <Badge tone="danger">Live — real money</Badge>
                    ) : (
                      <Badge tone="accent">Test — no real money</Badge>
                    )}
                    {connection.isActive ? (
                      <Badge tone="success">Active</Badge>
                    ) : (
                      <Badge>Inactive</Badge>
                    )}
                  </div>

                  <dl className="mt-2 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
                    <div>
                      <dt className="text-ink-subtle">Key</dt>
                      <dd className="font-mono text-ink">{connection.credentialsMask}</dd>
                    </div>
                    <div>
                      <dt className="text-ink-subtle">Webhook secret</dt>
                      <dd className={connection.hasWebhookSecret ? 'text-ink' : 'text-warning'}>
                        {connection.hasWebhookSecret ? 'Stored' : 'Missing'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-ink-subtle">Last test</dt>
                      <dd
                        className={
                          connection.lastTestStatus === 'OK'
                            ? 'text-success'
                            : connection.lastTestStatus === null
                              ? 'text-ink-muted'
                              : 'text-danger'
                        }
                      >
                        {connection.lastTestStatus === null
                          ? 'Never tested'
                          : `${connection.lastTestStatus} · ${formatDateTime(connection.lastTestedAt)}`}
                      </dd>
                    </div>
                  </dl>

                  {connection.lastTestMessage !== null && (
                    <p
                      className={`mt-1.5 text-xs ${connection.lastTestStatus === 'OK' ? 'text-ink-muted' : 'text-danger'}`}
                    >
                      {connection.lastTestMessage}
                    </p>
                  )}

                  {!connection.hasWebhookSecret && (
                    <p className="mt-1.5 text-xs text-warning">
                      Without a webhook secret, no incoming payment event can be verified — so no
                      order will ever be confirmed by a payment.
                    </p>
                  )}

                  {canWrite && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        isLoading={test.isPending}
                        onClick={() => {
                          test.mutate(connection);
                        }}
                      >
                        Test connection
                      </Button>

                      {connection.isActive ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            setStatus.mutate({ connection, active: false });
                          }}
                        >
                          Deactivate
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={!canActivate}
                          title={canActivate ? undefined : 'Run a successful test first.'}
                          onClick={() => {
                            setActivating(connection);
                          }}
                        >
                          Activate
                        </Button>
                      )}

                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setDialogFor(connection);
                        }}
                      >
                        Replace credentials
                      </Button>
                    </div>
                  )}

                  {canWrite && !connection.isActive && !canActivate && (
                    <p className="mt-1.5 text-xs text-ink-muted">
                      Activation needs a passing test. That is enforced by the server, not just by
                      this button.
                    </p>
                  )}
                </li>
              );
            })}
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
              <p className="font-medium text-danger">
                From this moment, customer checkouts charge real cards and refunds move real money.
              </p>
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
    { key: 'name', header: 'Connector', render: (row) => row.name },
    { key: 'kind', header: 'Type', render: (row) => <Badge>{humanise(row.kind)}</Badge> },
    {
      key: 'status',
      header: 'Status',
      render: (row) =>
        row.isActive ? <Badge tone="success">Active</Badge> : <Badge>Inactive</Badge>,
    },
    {
      key: 'sync',
      header: 'Last sync',
      render: (row) =>
        row.lastSyncAt === null ? (
          <span className="text-ink-subtle">Never</span>
        ) : (
          `${humanise(row.lastSyncStatus ?? 'UNKNOWN')} · ${formatDateTime(row.lastSyncAt)}`
        ),
    },
  ];

  return (
    <Card
      title="Other integrations"
      description="Accounting, shipping and ERP connectors."
    >
      <DataTable
        caption="Connectors"
        columns={columns}
        rows={query.data?.connectors}
        rowKey={(row) => row.id}
        isLoading={query.isPending}
        error={query.isError ? query.error : undefined}
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
        description="Payment gateway credentials and third-party connectors."
      />

      <div className="space-y-5">
        {showsGateway && <GatewayPanel />}
        {showsConnectors && <ConnectorsPanel />}
      </div>
    </>
  );
}

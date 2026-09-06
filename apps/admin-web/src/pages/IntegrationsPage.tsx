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
 * **More than one gateway may be active.** Checkout offers the customer every
 * active gateway their currency can be settled in, so activating Stripe does
 * not switch Razorpay off. What activation does switch off is the same gateway
 * in its other mode, and every gateway in the other mode — a shop is either
 * taking real payments or it is not.
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
import { useI18n } from '@/i18n/i18n-context';

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

    if (values.provider !== 'STRIPE') return;

    // Stripe's two keys look alike and sit next to each other in its
    // dashboard. Pasted the wrong way round, the secret key would be sent to
    // every customer's browser - so this is checked before it can be saved,
    // not after a test connection fails.
    if (!values.keyId.startsWith('pk_')) {
      ctx.addIssue({
        code: 'custom',
        path: ['keyId'],
        message: values.keyId.startsWith('sk_')
          ? 'That is the SECRET key. This field is the publishable key (pk_), which goes to the browser.'
          : 'A Stripe publishable key begins with pk_.',
      });
    }

    if (!values.keySecret.startsWith('sk_') && !values.keySecret.startsWith('rk_')) {
      ctx.addIssue({
        code: 'custom',
        path: ['keySecret'],
        message: 'A Stripe secret key begins with sk_, or rk_ for a restricted key.',
      });
    }

    // The mismatch that produces a working handshake and a checkout nothing
    // can ever confirm.
    const publishableIsLive = values.keyId.startsWith('pk_live_');
    const secretIsLive =
      values.keySecret.startsWith('sk_live_') || values.keySecret.startsWith('rk_live_');

    if (values.keyId.startsWith('pk_') && secretIsLive !== publishableIsLive) {
      ctx.addIssue({
        code: 'custom',
        path: ['keySecret'],
        message:
          'This secret key is from the other Stripe environment. Pair pk_test_ with sk_test_, or pk_live_ with sk_live_.',
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
  const { t } = useI18n();

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
      setFormError(
        applyApiErrors(error, setError, ['label', 'keyId', 'keySecret', 'webhookSecret']),
      );
    },
  });

  const submit = (): void => {
    void handleSubmit((values) => save.mutateAsync(values))();
  };

  const mode = watch('mode');
  const provider = watch('provider');
  const isStripe = provider === 'STRIPE';

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={
        existing === null
          ? 'Connect a payment gateway'
          : `Replace credentials for ${existing.label}`
      }
      description={t('integrations.savingAlwaysDeactivatesTheConnection')}
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            {t('integrations.cancel')}
          </Button>
          <Button variant="primary" isLoading={save.isPending} onClick={submit}>
            {t('integrations.saveCredentials')}
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
          <Field label={t('integrations.gateway')}>
            {({ inputId }) => (
              <Select id={inputId} disabled={existing !== null} {...register('provider')}>
                <option value="RAZORPAY">{t('integrations.razorpay')}</option>
                <option value="STRIPE">Stripe</option>
              </Select>
            )}
          </Field>

          <Field label={t('integrations.mode')}>
            {({ inputId }) => (
              <Select id={inputId} disabled={existing !== null} {...register('mode')}>
                <option value="TEST">{t('integrations.testNoRealMoneyCan')}</option>
                <option value="LIVE">{t('integrations.liveRealMoney')}</option>
              </Select>
            )}
          </Field>
        </div>

        {mode === 'LIVE' && (
          <Callout tone="danger" role="alert" title={t('integrations.theseAreLiveCredentials')}>
            {t('integrations.onceThisConnectionIsActivated')}
          </Callout>
        )}

        <div className="space-y-4 border-t border-border-subtle pt-4">
          <Field
            label={t('integrations.name')}
            hint={t('integrations.howThisConnectionIsListed')}
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

          <Field
            label={isStripe ? 'Publishable key' : t('integrations.keyId')}
            {...(isStripe
              ? {
                  hint: 'Stripe calls this the publishable key. It is public - it is sent to every customer’s browser to open the payment form.',
                }
              : {})}
            error={errors.keyId?.message}
            required
          >
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                className="font-mono"
                autoComplete="off"
                placeholder={isStripe ? 'pk_test_…' : t('integrations.rzpTest')}
                aria-describedby={describedBy}
                invalid={errors.keyId !== undefined}
                {...register('keyId')}
              />
            )}
          </Field>

          <Field
            label={isStripe ? 'Secret key' : t('integrations.keySecret')}
            hint={t('integrations.encryptedBeforeStorageAndNever')}
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
            label={t('integrations.webhookSecret')}
            hint={
              isStripe
                ? 'The whsec_ value Stripe shows when you add an endpoint for POST /webhooks/stripe. Without it no payment can be verified, so no order would ever be confirmed.'
                : t('integrations.fromTheGatewayDashboardWithout')
            }
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
    {
      title: 'Save',
      detail: 'Credentials are encrypted server-side, and the connection is switched off.',
    },
    {
      title: 'Test',
      detail:
        'The gateway is asked whether the saved credentials work. Only this records a result.',
    },
    {
      title: 'Activate',
      detail:
        'Refused unless the last test passed. Other gateways stay active; the other mode is not.',
    },
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
  const { t } = useI18n();

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
            {t('integrations.liveRealMoney')}
          </Badge>
        ) : (
          <Badge dot tone="accent">
            {t('integrations.testNoRealMoney')}
          </Badge>
        )}
        {connection.isActive ? (
          <Badge dot tone="success">
            {t('integrations.active')}
          </Badge>
        ) : (
          <Badge dot tone="neutral">
            {t('integrations.inactive')}
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
              <span className="font-medium text-warning">{t('integrations.missing')}</span>
            ),
          },
          {
            label: 'Last test',
            value:
              connection.lastTestStatus === null ? (
                <span className="text-ink-muted">{t('integrations.neverTested')}</span>
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
          {t('integrations.withoutAWebhookSecretNo')}
        </Callout>
      )}

      {canWrite && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button size="sm" isLoading={isTesting} onClick={onTest}>
            {t('integrations.testConnection')}
          </Button>

          {connection.isActive ? (
            <Button size="sm" variant="secondary" onClick={onDeactivate}>
              {t('integrations.deactivate')}
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
            {t('integrations.replaceCredentials')}
          </Button>

          {!connection.isActive && !canActivate && (
            <p className="text-xs text-ink-muted">
              {t('integrations.activationNeedsAPassingTest')}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

function GatewayPanel(): React.JSX.Element {
  const { t } = useI18n();

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
        title={t('integrations.paymentGateway')}
        description={t('integrations.activateOneConnectionPer')}
        actions={
          canWrite ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                setDialogFor(null);
              }}
            >
              {t('integrations.addCredentials')}
            </Button>
          ) : undefined
        }
      >
        {canWrite && <GatewaySteps />}

        {query.isPending && <LoadingState label={t('integrations.loadingGatewayConnections')} />}
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
            title={t('integrations.noGatewayConnected')}
            description={t('integrations.startInTestModeNo')}
            action={
              canWrite ? (
                <Button
                  variant="primary"
                  onClick={() => {
                    setDialogFor(null);
                  }}
                >
                  {t('integrations.addCredentials')}
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
              <Callout tone="danger" title={t('integrations.realCardsFromThisMoment')}>
                {t('integrations.customerCheckoutsWillChargeReal')}
              </Callout>
              <p>{t('integrations.otherGatewaysOnLive')}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {/*
                One sentence, one key. It used to be `{t('…thisIsA')}` followed
                by `<strong>test</strong> connection. No real money can move on
                a test key.` — which rendered as "This is atest connection",
                because JSX drops the whitespace between an expression and the
                element on the next line, and left the second half in English
                in all seven other languages. Splitting a sentence around
                inline markup cannot survive translation anyway: the emphasised
                word does not sit in the same place in German or Greek.
              */}
              <p>{t('integrations.thisIsATestConnection')}</p>
              <p>{t('integrations.otherGatewaysOnTest')}</p>
            </div>
          )
        }
      />
    </>
  );
}

function ConnectorsPanel(): React.JSX.Element {
  const { t } = useI18n();

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
            {t('integrations.active')}
          </Badge>
        ) : (
          <Badge dot tone="neutral">
            {t('integrations.inactive')}
          </Badge>
        ),
    },
    {
      key: 'sync',
      header: 'Last sync',
      nowrap: true,
      render: (row) =>
        row.lastSyncAt === null ? (
          <span className="text-ink-subtle">{t('integrations.never')}</span>
        ) : (
          <span className="text-ink-muted">
            {humanise(row.lastSyncStatus ?? 'UNKNOWN')} · {formatDateTime(row.lastSyncAt)}
          </span>
        ),
    },
  ];

  return (
    <Card
      title={t('integrations.otherIntegrations')}
      description={t('integrations.accountingShippingAndErpConnectors')}
    >
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
  const { t } = useI18n();

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
        title={t('integrations.integrations')}
        description={t('integrations.paymentGatewayCredentialsAndThird')}
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

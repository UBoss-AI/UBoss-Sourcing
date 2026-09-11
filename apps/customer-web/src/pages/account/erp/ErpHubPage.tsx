/**
 * Account → Integrations → ERP.
 *
 * The screen the profile menu and the sidebar both lead to. It answers three
 * questions in the order somebody actually asks them: is anything connected and
 * is it working, what needs me to do something, and who else in my organisation
 * can see this.
 *
 * WHAT CHANGED HERE
 *
 * This page used to be an explanation with no form on it, because a connection
 * was a URL plus a credential the installation's server calls and that belonged
 * to whoever ran the installation. It is now the real thing, and the reason
 * that became defensible is not that the risk went away - it is that the risk
 * is now handled where it has to be, in `outbound-http.ts` and
 * `credential.service.ts`, rather than by refusing to offer the feature.
 *
 * THE ROLE DECIDES WHAT RENDERS, AND THE SERVER DECIDES THE ROLE
 *
 * A member sees health and history. An integration manager sees the buttons. An
 * owner also sees who is in the organisation. None of that is decided here:
 * `capabilities` comes back with the organisation, and every button this page
 * renders is one the server would also permit. A screen that hid a control it
 * could not actually prevent would be decoration.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStorefront } from '@/app/storefront-context';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  ButtonLink,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  PageHeader,
  Select,
} from '@/components/ui';
import {
  AlertIcon,
  BuildingIcon,
  CheckIcon,
  ChevronRightIcon,
  ClockIcon,
  LinkIcon,
  PlusIcon,
  TrashIcon,
} from '@/components/icons';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { useI18n } from '@/i18n/i18n-context';
import {
  customerErpApi,
  erpKeys,
  stateTone,
  type ConnectionHealth,
  type OrgRole,
} from '@/lib/customer-erp';
import { AccountPanel } from '../AccountPanel';
import {
  ENVIRONMENT_LABEL,
  ROLE_LABEL,
  ROLE_NOTE,
  STATE_LABEL,
  SYSTEM_LABEL,
} from './erp-labels';

export function ErpHubPage(): React.JSX.Element {
  const { t } = useI18n();
  const { business } = useStorefront();
  const toast = useToast();
  const queryClient = useQueryClient();

  useDocumentMeta({ title: t('erp.hub.title'), noIndex: true }, business.displayName);

  const connections = useQuery({
    queryKey: erpKeys.connections,
    queryFn: () => customerErpApi.connections(),
  });

  const organization = useQuery({
    queryKey: erpKeys.organization,
    queryFn: () => customerErpApi.organization(),
  });

  const approvals = useQuery({
    queryKey: erpKeys.approvals(null),
    queryFn: () => customerErpApi.approvals(null, true),
  });

  if (connections.isPending || organization.isPending) {
    return <LoadingState label={t('erp.hub.loading')} />;
  }

  if (connections.isError) {
    return (
      <ErrorState error={connections.error} onRetry={() => void connections.refetch()} />
    );
  }

  /*
   * The store has the feature switched off.
   *
   * An honest "not available here" rather than an empty list with a Connect
   * button that would be refused - the read is deliberately ungated so this
   * page can say so instead of showing a 403 it has to guess the meaning of.
   */
  if (!connections.data.available) {
    return (
      <>
        <PageHeader title={t('erp.hub.title')} description={t('erp.hub.description')} />
        <EmptyState
          title={t('erp.hub.unavailable')}
          description={t('erp.hub.unavailableBody', { store: business.displayName })}
        />
      </>
    );
  }

  const capabilities = organization.data?.organization.capabilities ?? [];
  const canConfigure = capabilities.includes('CONFIGURE');
  const canAdminister = capabilities.includes('ADMINISTER');

  const rows = connections.data.connections;
  const pending = approvals.data ?? [];

  return (
    <>
      <PageHeader
        title={t('erp.hub.title')}
        description={t('erp.hub.description')}
        actions={
          canConfigure ? (
            <ButtonLink to="/account/integrations/erp/new">
              <PlusIcon aria-hidden="true" className="h-4 w-4" />
              {t('erp.hub.connect')}
            </ButtonLink>
          ) : undefined
        }
      />

      <div className="space-y-6">
        {/*
         * Approvals first, above everything, and only when there are any.
         *
         * This is the one thing on the page where somebody else is waiting: a
         * purchase order is sitting unraised until a person decides. Below the
         * connection list it would be found a day late.
         */}
        {pending.length > 0 && (
          <section
            className="rounded-lg border border-warning/30 bg-warning-soft p-5 shadow-card sm:p-6"
            aria-labelledby="erp-approvals-heading"
          >
            <h2
              id="erp-approvals-heading"
              className="flex items-center gap-2 text-title-sm text-ink"
            >
              <AlertIcon aria-hidden="true" className="h-5 w-5 text-warning" />
              {t('erp.hub.approvalsWaiting', { count: pending.length })}
            </h2>

            <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-ink-muted">
              {t('erp.hub.approvalsWaitingBody')}
            </p>

            <ul className="mt-4 space-y-2">
              {pending.slice(0, 3).map((approval) => (
                <li key={approval.id}>
                  <Link
                    to={`/account/integrations/erp/${approval.connectionId}?tab=approvals`}
                    className="flex items-start gap-2 rounded-md bg-surface p-3 text-sm text-ink shadow-card transition-colors hover:bg-surface-hover"
                  >
                    <ClockIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                    <span className="min-w-0 flex-1">{approval.summary}</span>
                    <ChevronRightIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        <AccountPanel title={t('erp.hub.connections')}>
          {rows.length === 0 ? (
            <EmptyState
              title={t('erp.hub.noneTitle')}
              description={
                canConfigure ? t('erp.hub.noneBody') : t('erp.hub.noneBodyReadOnly')
              }
              action={
                canConfigure ? (
                  <ButtonLink to="/account/integrations/erp/new">
                    {t('erp.hub.connect')}
                  </ButtonLink>
                ) : undefined
              }
            />
          ) : (
            <ul className="space-y-3">
              {rows.map((connection) => (
                <li key={connection.id}>
                  <ConnectionRow connection={connection} />
                </li>
              ))}
            </ul>
          )}
        </AccountPanel>

        {/*
         * What the hand-off actually does, kept from the screen this replaced.
         *
         * Somebody arriving here for the first time has usually been sent by a
         * colleague and does not know what an "ERP integration" would do for
         * them. Three facts, not a feature list.
         */}
        <AccountPanel title={t('erp.hub.whatItDoes')}>
          <ul className="space-y-2.5">
            {(
              [
                'erp.hub.benefitPurchaseOrder',
                'erp.hub.benefitStock',
                'erp.hub.benefitInvoice',
                'erp.hub.benefitNoRetyping',
              ] as const
            ).map((key) => (
              <li key={key} className="flex items-start gap-2.5 text-sm leading-relaxed text-ink">
                <CheckIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                {t(key)}
              </li>
            ))}
          </ul>
        </AccountPanel>

        {organization.data !== undefined && (
          <OrganizationPanel
            canAdminister={canAdminister}
            onChanged={() => {
              void queryClient.invalidateQueries({ queryKey: erpKeys.organization });
            }}
            onError={(message) => { toast.error(message); }}
          />
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

function ConnectionRow({ connection }: { connection: ConnectionHealth }): React.JSX.Element {
  const { t } = useI18n();

  const failed = connection.eventCounts.FAILED ?? 0;
  const queued = (connection.eventCounts.QUEUED ?? 0) + (connection.eventCounts.RETRYING ?? 0);

  return (
    <Link
      to={`/account/integrations/erp/${connection.id}`}
      className="flex items-start gap-4 rounded-lg border border-border bg-surface p-4 shadow-card transition-colors hover:border-border-hover hover:bg-surface-hover"
    >
      <span
        aria-hidden="true"
        className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-brand-soft text-brand"
      >
        <LinkIcon className="h-5 w-5" />
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-semibold text-ink">{connection.name}</span>
          <Badge tone={stateTone(connection.state)}>{t(STATE_LABEL[connection.state])}</Badge>
          {connection.environment === 'SANDBOX' && (
            <Badge tone="neutral">{t(ENVIRONMENT_LABEL.SANDBOX)}</Badge>
          )}
        </span>

        {/*
          The brand, then the protocol. Nine different systems all reading
          'Your own system' is a list nobody can scan; 'Oracle NetSuite ·
          Your own system' says both what it is and how it is spoken to.
        */}
        <span className="mt-1 block text-xs text-ink-muted">
          {connection.vendorLabel === connection.system
            ? t(SYSTEM_LABEL[connection.system])
            : `${connection.vendorLabel} · ${t(SYSTEM_LABEL[connection.system])}`}
        </span>

        {/*
         * The reason, where there is one. A connection in ACTION_REQUIRED with
         * no visible cause is a red light with no instruction.
         */}
        {connection.stateReason !== null && (
          <span className="mt-1.5 block max-w-prose text-xs leading-relaxed text-warning">
            {connection.stateReason}
          </span>
        )}

        <span className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xxs text-ink-subtle">
          <span>
            {connection.lastSuccessAt === null
              ? t('erp.hub.neverSynced')
              : t('erp.hub.lastSuccess', {
                  when: formatDateTime(connection.lastSuccessAt),
                })}
          </span>

          {connection.nextPollAt !== null && (
            <span>
              {t('erp.hub.nextSync', {
                when: formatDateTime(connection.nextPollAt),
              })}
            </span>
          )}

          {failed > 0 && (
            <span className="font-semibold text-danger">
              {t('erp.hub.failedCount', { count: failed })}
            </span>
          )}

          {queued > 0 && <span>{t('erp.hub.queuedCount', { count: queued })}</span>}
        </span>
      </span>

      <ChevronRightIcon aria-hidden="true" className="mt-3 h-4 w-4 shrink-0 text-ink-subtle" />
    </Link>
  );
}

// ---------------------------------------------------------------------------

/**
 * Who else can see this, and what they may do.
 *
 * Shown to everybody - knowing who in your company has access to the
 * integration is not privileged information within that company - and editable
 * only by an owner.
 */
function OrganizationPanel({
  canAdminister,
  onChanged,
  onError,
}: {
  canAdminister: boolean;
  onChanged: () => void;
  onError: (message: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();

  const organization = useQuery({
    queryKey: erpKeys.organization,
    queryFn: () => customerErpApi.organization(),
  });

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrgRole>('MEMBER');

  const invite = useMutation({
    mutationFn: () => customerErpApi.invite(email.trim(), role),
    onSuccess: () => {
      setEmail('');
      onChanged();
    },
    onError: (error: unknown) => { onError(errorMessage(t, error, t('erp.team.inviteFailed'))); },
  });

  const revoke = useMutation({
    mutationFn: (inviteId: string) => customerErpApi.revokeInvite(inviteId),
    onSuccess: onChanged,
    onError: (error: unknown) => { onError(errorMessage(t, error, t('erp.team.revokeFailed'))); },
  });

  const changeRole = useMutation({
    mutationFn: (input: { memberId: string; role: OrgRole }) =>
      customerErpApi.changeMemberRole(input.memberId, input.role),
    onSuccess: onChanged,
    onError: (error: unknown) => { onError(errorMessage(t, error, t('erp.team.roleFailed'))); },
  });

  const remove = useMutation({
    mutationFn: (memberId: string) => customerErpApi.removeMember(memberId),
    onSuccess: onChanged,
    onError: (error: unknown) => { onError(errorMessage(t, error, t('erp.team.removeFailed'))); },
  });

  if (organization.data === undefined) return <></>;

  const { organization: org, members, invites } = organization.data;

  return (
    <AccountPanel
      title={t('erp.team.title')}
      description={t('erp.team.description', { organisation: org.name })}
    >
      <ul className="divide-y divide-border-subtle">
        {members.map((member) => (
          <li key={member.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0">
            <span
              aria-hidden="true"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-ink-muted"
            >
              <BuildingIcon className="h-4 w-4" />
            </span>

            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-ink">
                {member.name}
                {member.isYou && (
                  <span className="ml-2 text-xs font-normal text-ink-subtle">
                    {t('erp.team.you')}
                  </span>
                )}
              </span>
              <span className="block truncate text-xs text-ink-muted">{member.email}</span>
            </span>

            {canAdminister && !member.isYou ? (
              <span className="flex items-center gap-2">
                <Select
                  aria-label={t('erp.team.roleFor', { name: member.name })}
                  value={member.role}
                  className="w-48"
                  onChange={(event) => {
                    changeRole.mutate({
                      memberId: member.id,
                      role: event.target.value as OrgRole,
                    });
                  }}
                >
                  {(['OWNER', 'INTEGRATION_MANAGER', 'MEMBER'] as const).map((value) => (
                    <option key={value} value={value}>
                      {t(ROLE_LABEL[value])}
                    </option>
                  ))}
                </Select>

                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t('erp.team.remove', { name: member.name })}
                  onClick={() => { remove.mutate(member.id); }}
                >
                  <TrashIcon aria-hidden="true" className="h-4 w-4" />
                </Button>
              </span>
            ) : (
              <Badge tone="neutral">{t(ROLE_LABEL[member.role])}</Badge>
            )}
          </li>
        ))}
      </ul>

      <p className="mt-3 text-xs leading-relaxed text-ink-muted">{t(ROLE_NOTE[org.role])}</p>

      {canAdminister && (
        <div className="mt-6 border-t border-border-subtle pt-6">
          <h3 className="text-sm font-semibold text-ink">{t('erp.team.inviteTitle')}</h3>

          <p className="mt-1 max-w-prose text-xs leading-relaxed text-ink-muted">
            {t('erp.team.inviteBody')}
          </p>

          <form
            className="mt-3 flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (email.trim().length > 0) invite.mutate();
            }}
          >
            <div className="min-w-[16rem] flex-1">
              <Field label={t('erp.team.inviteEmail')}>
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    aria-describedby={describedBy}
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(event) => { setEmail(event.target.value); }}
                  />
                )}
              </Field>
            </div>

            <div className="w-56">
              <Field label={t('erp.team.inviteRole')}>
                {({ inputId, describedBy }) => (
                  <Select
                    id={inputId}
                    aria-describedby={describedBy}
                    value={role}
                    onChange={(event) => { setRole(event.target.value as OrgRole); }}
                  >
                    {(['INTEGRATION_MANAGER', 'MEMBER', 'OWNER'] as const).map((value) => (
                      <option key={value} value={value}>
                        {t(ROLE_LABEL[value])}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>

            <Button type="submit" isLoading={invite.isPending}>
              {t('erp.team.sendInvite')}
            </Button>
          </form>

          {invites !== null && invites.length > 0 && (
            <ul className="mt-4 space-y-2">
              {invites.map((entry) => (
                <li
                  key={entry.id}
                  className="flex flex-wrap items-center gap-3 rounded-md bg-surface-sunken px-3 py-2"
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">{entry.email}</span>
                  <Badge tone="neutral">{t(ROLE_LABEL[entry.role])}</Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => { revoke.mutate(entry.id); }}
                    isLoading={revoke.isPending}
                  >
                    {t('erp.team.revoke')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </AccountPanel>
  );
}

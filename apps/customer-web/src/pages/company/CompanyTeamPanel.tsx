/**
 * The people who act for a company, and as what (checklist Master rows 11 and 14).
 *
 * Every member sees who else is in the company and in which role. The owner
 * and administrators of a verified company also invite people by email,
 * resend or withdraw an invitation, change a role and remove somebody.
 *
 * The page decides nothing. Which roles may be given, who may be changed and
 * why managing is not possible yet all come from the server's view, and the
 * server refuses anything else however the request is made.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import { Badge, Button, ErrorState, Field, Input, LoadingState, Select } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import {
  changeTeamRole,
  fetchTeam,
  inviteToTeam,
  removeFromTeam,
  resendTeamInvitation,
  revokeTeamInvitation,
  teamQueryKey,
  type AssignableRole,
  type CompanyTeam,
  type TeamMember,
} from '@/lib/buyer-companies';
import { errorMessage } from '@/lib/errors';

export function CompanyTeamPanel({ companyId }: { companyId: string }): React.JSX.Element {
  const { t } = useI18n();
  const query = useQuery({ queryKey: teamQueryKey(companyId), queryFn: () => fetchTeam(companyId) });

  return (
    <section aria-labelledby="company-team-heading" className="rounded-xl border border-border bg-surface p-5 shadow-card">
      <h2 id="company-team-heading" className="text-base font-semibold text-ink">
        {t('companyTeam.title')}
      </h2>
      <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-ink-muted">{t('companyTeam.description')}</p>
      <div className="mt-4">
        {query.isPending ? (
          <LoadingState label={t('companyTeam.loading')} />
        ) : query.isError ? (
          <ErrorState
            error={query.error}
            onRetry={() => {
              void query.refetch();
            }}
          />
        ) : (
          <TeamBody companyId={companyId} team={query.data} />
        )}
      </div>
    </section>
  );
}

function roleLabel(t: ReturnType<typeof useI18n>['t'], role: string): string {
  return t(`companyRole.${role}` as TranslationKey);
}

function TeamBody({ companyId, team }: { companyId: string; team: CompanyTeam }): React.JSX.Element {
  const { t, intlLocale } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const [removing, setRemoving] = useState<TeamMember | null>(null);

  const apply = (next: CompanyTeam, done: TranslationKey): void => {
    setProblem(null);
    queryClient.setQueryData(teamQueryKey(companyId), next);
    toast.success(t(done));
  };
  const fail = (error: unknown): void => {
    setProblem(errorMessage(t, error, t('companyTeam.failed')));
    // A refusal usually means somebody else changed the team: show it as it is.
    void queryClient.invalidateQueries({ queryKey: teamQueryKey(companyId) });
  };

  const change = useMutation({
    mutationFn: (input: { memberId: string; role: AssignableRole }) => changeTeamRole(companyId, input.memberId, input.role),
    onSuccess: (next) => {
      apply(next, 'companyTeam.roleChanged');
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (memberId: string) => removeFromTeam(companyId, memberId),
    onSuccess: (next) => {
      setRemoving(null);
      apply(next, 'companyTeam.removed');
    },
    onError: (error) => {
      setRemoving(null);
      fail(error);
    },
  });
  const resend = useMutation({
    mutationFn: (invitationId: string) => resendTeamInvitation(companyId, invitationId),
    onSuccess: (next) => {
      apply(next, 'companyTeam.resent');
    },
    onError: fail,
  });
  const revoke = useMutation({
    mutationFn: (invitationId: string) => revokeTeamInvitation(companyId, invitationId),
    onSuccess: (next) => {
      apply(next, 'companyTeam.revoked');
    },
    onError: fail,
  });

  const date = (iso: string): string => new Intl.DateTimeFormat(intlLocale, { dateStyle: 'medium' }).format(new Date(iso));
  const canManage = team.manageBlocked === null;

  return (
    <div className="space-y-5">
      {team.manageBlocked === 'NOT_APPROVED' && (
        <p className="rounded-md border border-border bg-surface-sunken px-3 py-2.5 text-sm text-ink-muted">
          {t('companyTeam.notApproved')}
        </p>
      )}
      {problem !== null && (
        <p role="alert" className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger">
          {problem}
        </p>
      )}

      <div>
        <h3 className="text-sm font-semibold text-ink">{t('companyTeam.members')}</h3>
        <ul className="mt-2 divide-y divide-border-subtle rounded-lg border border-border">
          {team.members.map((member) => (
            <li key={member.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink">
                  {member.name !== '' ? member.name : member.email}
                  {member.isYou && <span className="ml-2 text-xs font-normal text-ink-muted">{t('companyTeam.you')}</span>}
                </p>
                <p className="truncate text-xs text-ink-muted">{member.email}</p>
                <p className="text-xs text-ink-muted">{t('companyTeam.joined', { date: date(member.joinedAt) })}</p>
              </div>
              {member.canChange ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    aria-label={t('companyTeam.roleFor', { name: member.name !== '' ? member.name : member.email })}
                    value={member.role}
                    disabled={change.isPending}
                    className="w-auto min-w-40"
                    onChange={(event) => {
                      change.mutate({ memberId: member.id, role: event.target.value as AssignableRole });
                    }}
                  >
                    {team.assignableRoles.map((role) => (
                      <option key={role} value={role}>
                        {roleLabel(t, role)}
                      </option>
                    ))}
                  </Select>
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label={t('companyTeam.removeNamed', { name: member.name !== '' ? member.name : member.email })}
                    onClick={() => {
                      setRemoving(member);
                    }}
                  >
                    {t('companyTeam.remove')}
                  </Button>
                </div>
              ) : (
                <div className="self-start sm:self-auto">
                  <Badge tone={member.role === 'OWNER' ? 'brand' : 'neutral'}>{roleLabel(t, member.role)}</Badge>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>

      {canManage && (
        <>
          <InviteForm companyId={companyId} team={team} onDone={apply} onError={fail} />
          <div>
            <h3 className="text-sm font-semibold text-ink">{t('companyTeam.invitations')}</h3>
            {team.invitations.length === 0 ? (
              <p className="mt-2 text-sm text-ink-muted">{t('companyTeam.noInvitations')}</p>
            ) : (
              <ul className="mt-2 divide-y divide-border-subtle rounded-lg border border-border">
                {team.invitations.map((invitation) => (
                  <li key={invitation.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink">{invitation.email}</p>
                      <p className="text-xs text-ink-muted">
                        {roleLabel(t, invitation.role)} ·{' '}
                        {invitation.expired
                          ? t('companyTeam.expired')
                          : t('companyTeam.expires', { date: date(invitation.expiresAt) })}
                      </p>
                    </div>
                    {invitation.canChange && (
                      <div className="flex flex-wrap gap-2">
                        {!invitation.expired && (
                          <Button
                            variant="secondary"
                            size="sm"
                            isLoading={resend.isPending && resend.variables === invitation.id}
                            aria-label={t('companyTeam.resendNamed', { email: invitation.email })}
                            onClick={() => {
                              resend.mutate(invitation.id);
                            }}
                          >
                            {t('companyTeam.resend')}
                          </Button>
                        )}
                        <Button
                          variant="secondary"
                          size="sm"
                          isLoading={revoke.isPending && revoke.variables === invitation.id}
                          aria-label={t('companyTeam.withdrawNamed', { email: invitation.email })}
                          onClick={() => {
                            revoke.mutate(invitation.id);
                          }}
                        >
                          {t('companyTeam.withdraw')}
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {removing !== null && (
        <Modal
          isOpen
          onClose={() => {
            setRemoving(null);
          }}
          title={t('companyTeam.removeTitle')}
          description={t('companyTeam.removeDescription', { name: removing.name !== '' ? removing.name : removing.email })}
          footer={
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="secondary"
                disabled={remove.isPending}
                onClick={() => {
                  setRemoving(null);
                }}
              >
                {t('common.cancel')}
              </Button>
              <Button
                variant="danger"
                isLoading={remove.isPending}
                onClick={() => {
                  remove.mutate(removing.id);
                }}
              >
                {t('companyTeam.remove')}
              </Button>
            </div>
          }
        >
          <p className="text-sm text-ink-muted">{t('companyTeam.removeEffect')}</p>
        </Modal>
      )}
    </div>
  );
}

function InviteForm({
  companyId,
  team,
  onDone,
  onError,
}: {
  companyId: string;
  team: CompanyTeam;
  onDone: (next: CompanyTeam, done: TranslationKey) => void;
  onError: (error: unknown) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<AssignableRole>(team.assignableRoles.includes('BUYER') ? 'BUYER' : (team.assignableRoles[0] ?? 'VIEWER'));
  const [emailError, setEmailError] = useState<string | undefined>(undefined);

  const invite = useMutation({
    mutationFn: () => inviteToTeam(companyId, { email: email.trim(), role }),
    onSuccess: (next) => {
      setEmail('');
      onDone(next, 'companyTeam.invited');
    },
    onError,
  });

  return (
    <form
      noValidate
      className="grid gap-3 rounded-lg border border-border bg-surface-sunken p-4 sm:grid-cols-[1fr_auto_auto] sm:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
          setEmailError(t('companyTeam.emailInvalid'));
          return;
        }
        setEmailError(undefined);
        invite.mutate();
      }}
    >
      <Field label={t('companyTeam.inviteEmail')} error={emailError} required>
        {({ inputId, describedBy }) => (
          <Input
            id={inputId}
            type="email"
            autoComplete="off"
            value={email}
            invalid={emailError !== undefined}
            aria-describedby={describedBy}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
        )}
      </Field>
      <Field label={t('companyTeam.inviteRole')}>
        {({ inputId, describedBy }) => (
          <Select
            id={inputId}
            aria-describedby={describedBy}
            value={role}
            onChange={(event) => {
              setRole(event.target.value as AssignableRole);
            }}
          >
            {team.assignableRoles.map((option) => (
              <option key={option} value={option}>
                {roleLabel(t, option)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Button type="submit" isLoading={invite.isPending}>
        {t('companyTeam.invite')}
      </Button>
    </form>
  );
}

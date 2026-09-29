/**
 * Who else can use this seller account, and as what (checklist Master row 14).
 *
 * The owner and admins invite people by email in one role, resend or withdraw
 * an invitation, change a role and remove somebody. They also see what a
 * periodic access review needs - each person's role, when they joined, who
 * invited them, when they last signed in and last used the Hub - and record
 * that they have checked it.
 *
 * The page decides nothing. Which roles may be given, who may be changed and
 * whether a review is due all come from the server's view, and the server
 * refuses anything else however the request is made.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, ErrorState, Field, Input, LoadingState, PageHeader, Select } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import {
  SELLER_TEAM_QUERY_KEY,
  changeMemberRole,
  fetchSellerTeam,
  inviteSellerMember,
  recordSellerAccessReview,
  removeMember,
  resendSellerInvitation,
  revokeSellerInvitation,
  type SellerInvitableRole,
  type SellerRoleKey,
  type SellerTeam,
  type SellerTeamMember,
} from '@/lib/seller';

export function SellerTeamPage(): React.JSX.Element {
  const { t } = useI18n();
  const query = useQuery({ queryKey: SELLER_TEAM_QUERY_KEY, queryFn: fetchSellerTeam, retry: false });

  return (
    <div className="space-y-6">
      <PageHeader title={t('sellerTeam.title')} description={t('sellerTeam.description')} />
      {query.isPending ? (
        <LoadingState label={t('sellerTeam.loading')} />
      ) : query.isError ? (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : (
        <TeamBody team={query.data} />
      )}
    </div>
  );
}

function roleLabel(t: ReturnType<typeof useI18n>['t'], role: string): string {
  return t(`sellerRole.${role}` as TranslationKey);
}

function TeamBody({ team }: { team: SellerTeam }): React.JSX.Element {
  const { t, intlLocale } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const [removing, setRemoving] = useState<SellerTeamMember | null>(null);

  const date = (iso: string): string => new Intl.DateTimeFormat(intlLocale, { dateStyle: 'medium' }).format(new Date(iso));
  const when = (iso: string | null): string => (iso === null ? t('sellerTeam.never') : date(iso));

  const show = (next: SellerTeam, done: TranslationKey): void => {
    setProblem(null);
    queryClient.setQueryData(SELLER_TEAM_QUERY_KEY, next);
    toast.success(t(done));
  };
  const refresh = async (done: TranslationKey): Promise<void> => {
    setProblem(null);
    await queryClient.invalidateQueries({ queryKey: SELLER_TEAM_QUERY_KEY });
    await queryClient.invalidateQueries({ queryKey: ['seller', 'members'] });
    toast.success(t(done));
  };
  const fail = (error: unknown): void => {
    setProblem(errorMessage(t, error, t('sellerTeam.failed')));
    // A refusal usually means somebody else changed the team: show it as it is.
    void queryClient.invalidateQueries({ queryKey: SELLER_TEAM_QUERY_KEY });
  };

  const change = useMutation({
    mutationFn: (input: { memberId: string; role: SellerRoleKey }) => changeMemberRole(input.memberId, input.role),
    onSuccess: () => refresh('sellerTeam.roleChanged'),
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (memberId: string) => removeMember(memberId),
    onSuccess: async () => {
      setRemoving(null);
      await refresh('sellerTeam.removed');
    },
    onError: (error) => {
      setRemoving(null);
      fail(error);
    },
  });
  const resend = useMutation({
    mutationFn: (invitationId: string) => resendSellerInvitation(invitationId),
    onSuccess: (next) => {
      show(next, 'sellerTeam.resent');
    },
    onError: fail,
  });
  const revoke = useMutation({
    mutationFn: (invitationId: string) => revokeSellerInvitation(invitationId),
    onSuccess: (next) => {
      show(next, 'sellerTeam.revoked');
    },
    onError: fail,
  });
  const review = useMutation({
    mutationFn: () => recordSellerAccessReview(),
    onSuccess: (next) => {
      show(next, 'sellerTeam.review.recorded');
    },
    onError: fail,
  });

  const nameOf = (member: SellerTeamMember): string => (member.name !== '' ? member.name : member.email);
  const last = team.accessReview.reviews[0];

  return (
    <div className="space-y-6">
      {problem !== null && (
        <p role="alert" className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger">
          {problem}
        </p>
      )}

      <Card title={t('sellerTeam.review.title')} description={t('sellerTeam.review.description')}>
        <div className="flex flex-col gap-4 px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              {team.accessReview.due ? (
                <Badge tone="warning">{t('sellerTeam.review.due')}</Badge>
              ) : (
                <Badge tone="success">{t('sellerTeam.review.upToDate')}</Badge>
              )}
              <p className="text-sm text-ink">
                {last === undefined
                  ? t('sellerTeam.review.never')
                  : t('sellerTeam.review.last', { date: date(last.reviewedAt), name: last.reviewedByName })}
              </p>
            </div>
            {team.accessReview.dueAt !== null && !team.accessReview.due && (
              <p className="text-xs text-ink-muted">{t('sellerTeam.review.next', { date: date(team.accessReview.dueAt) })}</p>
            )}
          </div>
          {team.canManage && (
            <Button
              isLoading={review.isPending}
              onClick={() => {
                review.mutate();
              }}
            >
              {t('sellerTeam.review.confirm')}
            </Button>
          )}
        </div>
      </Card>

      <Card title={t('sellerTeam.members')}>
        <ul className="divide-y divide-border-subtle">
          {team.members.map((member) => (
            <li key={member.id} className="flex flex-col gap-3 px-6 py-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0 space-y-0.5">
                <p className="truncate text-sm font-medium text-ink">
                  {nameOf(member)}
                  {member.isYou && <span className="ml-2 text-xs font-normal text-ink-muted">{t('sellerTeam.you')}</span>}
                </p>
                <p className="truncate text-xs text-ink-muted">{member.email}</p>
                <p className="text-xs text-ink-muted">
                  {t('sellerTeam.joined', { date: date(member.joinedAt) })} ·{' '}
                  {member.invitedByName === null
                    ? t('sellerTeam.notInvited')
                    : t('sellerTeam.invitedBy', { name: member.invitedByName })}
                </p>
                <p className="text-xs text-ink-muted">
                  {t('sellerTeam.lastSignIn', { date: when(member.lastSignInAt) })} ·{' '}
                  {t('sellerTeam.lastHub', { date: when(member.lastHubActivityAt) })}
                </p>
              </div>
              {member.canChange ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    aria-label={t('sellerTeam.roleFor', { name: nameOf(member) })}
                    value={member.role}
                    disabled={change.isPending}
                    className="w-auto min-w-44"
                    onChange={(event) => {
                      change.mutate({ memberId: member.id, role: event.target.value as SellerRoleKey });
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
                    aria-label={t('sellerTeam.removeNamed', { name: nameOf(member) })}
                    onClick={() => {
                      setRemoving(member);
                    }}
                  >
                    {t('sellerTeam.remove')}
                  </Button>
                </div>
              ) : (
                <div className="self-start lg:self-auto">
                  <Badge tone={member.role === 'OWNER' ? 'brand' : 'neutral'}>{roleLabel(t, member.role)}</Badge>
                </div>
              )}
            </li>
          ))}
        </ul>
        <p className="border-t border-border-subtle px-6 py-4 text-xxs leading-relaxed text-ink-muted">{t('sellerTeam.rules')}</p>
      </Card>

      {team.canManage && (
        <Card title={t('sellerTeam.invitations')} description={t('sellerTeam.invitationsHint')}>
          <div className="space-y-4 px-6 py-5">
            <InviteForm team={team} onDone={show} onError={fail} />
            {team.invitations.length === 0 ? (
              <p className="text-sm text-ink-muted">{t('sellerTeam.noInvitations')}</p>
            ) : (
              <ul className="divide-y divide-border-subtle rounded-lg border border-border">
                {team.invitations.map((invitation) => (
                  <li key={invitation.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink">{invitation.email}</p>
                      <p className="text-xs text-ink-muted">
                        {roleLabel(t, invitation.role)} ·{' '}
                        {invitation.expired
                          ? t('sellerTeam.expired')
                          : t('sellerTeam.expires', { date: date(invitation.expiresAt) })}{' '}
                        · {t('sellerTeam.sent', { times: invitation.sendCount })}
                      </p>
                    </div>
                    {invitation.canChange && (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="secondary"
                          size="sm"
                          isLoading={resend.isPending && resend.variables === invitation.id}
                          aria-label={t('sellerTeam.resendNamed', { email: invitation.email })}
                          onClick={() => {
                            resend.mutate(invitation.id);
                          }}
                        >
                          {t('sellerTeam.resend')}
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          isLoading={revoke.isPending && revoke.variables === invitation.id}
                          aria-label={t('sellerTeam.withdrawNamed', { email: invitation.email })}
                          onClick={() => {
                            revoke.mutate(invitation.id);
                          }}
                        >
                          {t('sellerTeam.withdraw')}
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      )}

      {removing !== null && (
        <Modal
          isOpen
          onClose={() => {
            setRemoving(null);
          }}
          title={t('sellerTeam.removeTitle')}
          description={t('sellerTeam.removeDescription', { name: nameOf(removing) })}
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
                {t('sellerTeam.remove')}
              </Button>
            </div>
          }
        >
          <p className="text-sm text-ink-muted">{t('sellerTeam.removeEffect')}</p>
        </Modal>
      )}
    </div>
  );
}

function InviteForm({
  team,
  onDone,
  onError,
}: {
  team: SellerTeam;
  onDone: (next: SellerTeam, done: TranslationKey) => void;
  onError: (error: unknown) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<SellerInvitableRole>(
    team.invitableRoles.includes('SUPPORT_MEMBER') ? 'SUPPORT_MEMBER' : (team.invitableRoles[0] ?? 'SUPPORT_MEMBER'),
  );
  const [emailError, setEmailError] = useState<string | undefined>(undefined);

  const invite = useMutation({
    mutationFn: () => inviteSellerMember({ email: email.trim(), role }),
    onSuccess: (next) => {
      setEmail('');
      onDone(next, 'sellerTeam.invited');
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
          setEmailError(t('sellerTeam.emailInvalid'));
          return;
        }
        setEmailError(undefined);
        invite.mutate();
      }}
    >
      <Field label={t('sellerTeam.inviteEmail')} error={emailError} required>
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
      <Field label={t('sellerTeam.inviteRole')}>
        {({ inputId, describedBy }) => (
          <Select
            id={inputId}
            aria-describedby={describedBy}
            value={role}
            onChange={(event) => {
              setRole(event.target.value as SellerInvitableRole);
            }}
          >
            {team.invitableRoles.map((option) => (
              <option key={option} value={option}>
                {t(`sellerRole.${option}` as TranslationKey)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Button type="submit" isLoading={invite.isPending}>
        {t('sellerTeam.invite')}
      </Button>
    </form>
  );
}

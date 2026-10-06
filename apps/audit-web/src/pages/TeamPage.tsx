/**
 * Team: the people of an inspection agency, and - for the audit team - every
 * agency and its people.
 *
 *   - An agency administrator (inspection.member.write) manages their own
 *     agency's people: invite, change role or status, resend an invitation.
 *   - Any other agency member sees their agency's people, read-only.
 *   - Audit staff (audit.team.read) see every agency and every person,
 *     read-only. Agencies and staff accounts are managed in the Admin Panel.
 *
 * Identity is verified only by the marketplace, never by an agency, and the
 * screen says so.
 *
 *   GET   /audit/team
 *   POST  /audit/agency/team/invitations
 *   PATCH /audit/agency/team/members/:id
 *   POST  /audit/agency/team/members/:id/resend-invitation
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Callout, Card, Field, PageHeader, Select } from '@/components/ui';
import { CardField, EnumBadge, MutationError, QueryBoundary, ResponsiveTable } from '@/components/console';
import { Modal } from '@/components/Modal';
import type { Column } from '@/components/DataTable';
import { useCurrentUser, useSession } from '@/auth/session-context';
import { useI18n } from '@/i18n/i18n-context';
import { consoleKeys, fetchTeam, resendAgencyInvitation, updateAgencyMember } from '@/lib/console-api';
import type { ConsolePerson, TeamResponse } from '@/lib/console-types';
import { agencyKindLabel, roleLabel } from '@/lib/labels';
import type { AuditRole } from '@/lib/types';
import { formatCalendarDate } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import { useConsoleMutation } from '@/lib/use-console-mutation';
import { InviteMemberForm } from './standards/InviteMemberForm';
import { AGENCY_ROLES, type AgencyRoleName } from './standards/standards-helpers';

export function TeamPage(): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const session = useCurrentUser();
  const isStaff = session.member.kind === 'STAFF';
  const query = useQuery({ queryKey: consoleKeys.team(), queryFn: fetchTeam });
  const [inviting, setInviting] = useState(false);
  const manage = !isStaff && can(Permission.MEMBER_WRITE) && query.data?.canManage !== false;

  return (
    <>
      <PageHeader
        title={t('screens.team.title')}
        description={isStaff ? t('team.descriptionStaff') : t('team.descriptionAgency', { agency: session.member.agency?.name ?? '' })}
        actions={
          manage ? (
            <Button
              variant="primary"
              onClick={() => {
                setInviting(true);
              }}
            >
              {t('team.invite.button')}
            </Button>
          ) : undefined
        }
      />
      <div className="space-y-6">
        <Callout tone="info">
          <p>{t('team.identityByMarketplace')}</p>
          {isStaff && <p className="mt-1">{t('team.staffReadOnly')}</p>}
          {!isStaff && !manage && <p className="mt-1">{t('team.agencyReadOnly')}</p>}
        </Callout>
        <QueryBoundary query={query}>
          {(data) => (isStaff ? <StaffView data={data} /> : <PeopleCard title={t('team.people')} people={data.people} manage={manage} />)}
        </QueryBoundary>
      </div>
      {inviting && (
        <InviteMemberForm
          isOpen
          onClose={() => {
            setInviting(false);
          }}
        />
      )}
    </>
  );
}

function StaffView({ data }: { data: TeamResponse }): React.JSX.Element {
  const { t } = useI18n();
  const staff = data.people.filter((person) => person.kind === 'STAFF');

  const columns: Column<TeamResponse['agencies'][number]>[] = [
    { key: 'name', header: t('team.agency.name'), render: (agency) => <span className="font-medium text-ink">{agency.name}</span> },
    { key: 'kind', header: t('team.agency.kind'), render: (agency) => agencyKindLabel(t, agency.kind) },
    {
      key: 'status',
      header: t('common.status'),
      render: (agency) => (
        <Badge tone={agency.status === 'ACTIVE' ? 'success' : 'danger'} dot>
          {agency.status === 'ACTIVE' ? t('team.agency.active') : t('team.agency.suspended')}
        </Badge>
      ),
      nowrap: true,
    },
    { key: 'country', header: t('team.agency.country'), render: (agency) => agency.country ?? '—', secondary: true },
    { key: 'accreditation', header: t('team.agency.accreditation'), render: (agency) => agency.accreditation ?? '—', secondary: true },
  ];

  return (
    <>
      <Card title={t('team.agencies')} description={t('team.agenciesDescription')}>
        <ResponsiveTable
          caption={t('team.agencies')}
          columns={columns}
          rows={data.agencies}
          rowKey={(agency) => agency.id}
          emptyTitle={t('team.noAgencies')}
          card={(agency) => (
            <div className="space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-medium text-ink">{agency.name}</p>
                <Badge tone={agency.status === 'ACTIVE' ? 'success' : 'danger'} dot>
                  {agency.status === 'ACTIVE' ? t('team.agency.active') : t('team.agency.suspended')}
                </Badge>
              </div>
              <CardField label={t('team.agency.kind')}>{agencyKindLabel(t, agency.kind)}</CardField>
              <CardField label={t('team.agency.country')}>{agency.country ?? '—'}</CardField>
              <CardField label={t('team.agency.accreditation')}>{agency.accreditation ?? '—'}</CardField>
            </div>
          )}
        />
      </Card>
      <PeopleCard title={t('team.auditTeam')} people={staff} manage={false} />
      {data.agencies.map((agency) => (
        <PeopleCard
          key={agency.id}
          title={agency.name}
          description={agencyKindLabel(t, agency.kind)}
          people={data.people.filter((person) => person.agency?.id === agency.id)}
          manage={false}
        />
      ))}
    </>
  );
}

function PeopleCard({
  title,
  description,
  people,
  manage,
}: {
  title: string;
  description?: string;
  people: ConsolePerson[];
  manage: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const [editing, setEditing] = useState<ConsolePerson | null>(null);

  const resend = useConsoleMutation<string, { expiresAt: string }>({
    mutationFn: (memberId, key) => resendAgencyInvitation(memberId, key),
    invalidate: [consoleKeys.team()],
    successMessage: t('team.resent'),
  });

  const flags = (person: ConsolePerson): React.JSX.Element => (
    <div className="flex flex-wrap gap-1.5">
      <Badge tone={person.activated ? 'success' : 'warning'} dot>
        {person.activated ? t('team.activated') : t('team.notActivated')}
      </Badge>
      <Badge tone={person.mfaEnrolled ? 'success' : 'warning'} dot>
        {person.mfaEnrolled ? t('team.mfaOn') : t('team.mfaOff')}
      </Badge>
      {person.identityVerified !== null && (
        <Badge tone={person.identityVerified ? 'success' : 'neutral'} dot>
          {person.identityVerified ? t('team.identityVerified') : t('team.identityNotVerified')}
        </Badge>
      )}
    </div>
  );

  const actions = (person: ConsolePerson): React.JSX.Element | null =>
    !manage ? null : (
      <div className="flex flex-wrap justify-end gap-1">
        <Button
          size="sm"
          variant="ghost"
          aria-label={t('team.changeFor', { name: person.fullName })}
          onClick={() => {
            setEditing(person);
          }}
        >
          {t('team.change')}
        </Button>
        {!person.activated && (
          <Button
            size="sm"
            variant="ghost"
            isLoading={resend.isPending && resend.variables === person.memberId}
            aria-label={t('team.resendFor', { name: person.fullName })}
            onClick={() => {
              resend.mutate(person.memberId);
            }}
          >
            {t('team.resend')}
          </Button>
        )}
      </div>
    );

  const credential = (person: ConsolePerson): string =>
    person.credentialExpiresAt === null ? '—' : formatCalendarDate(person.credentialExpiresAt);

  const columns: Column<ConsolePerson>[] = [
    {
      key: 'name',
      header: t('team.field.fullName'),
      render: (person) => (
        <div className="min-w-0">
          <p className="font-medium text-ink">{person.fullName}</p>
          <p className="truncate text-xs text-ink-muted">{person.email}</p>
        </div>
      ),
    },
    { key: 'role', header: t('team.field.role'), render: (person) => roleLabel(t, person.role as AuditRole) },
    { key: 'status', header: t('common.status'), render: (person) => <EnumBadge family="memberStatus" value={person.status} />, nowrap: true },
    { key: 'flags', header: t('team.account'), render: flags, secondary: true },
    { key: 'credential', header: t('team.field.credentialExpiresAt'), render: credential, nowrap: true, tertiary: true },
    ...(manage ? [{ key: 'actions', header: <span className="sr-only">{t('common.actions')}</span>, render: actions, align: 'right' as const }] : []),
  ];

  return (
    <Card title={title} description={description}>
      {resend.isError && (
        <div className="px-5 pt-4">
          <MutationError error={resend.error} />
        </div>
      )}
      <ResponsiveTable
        caption={title}
        columns={columns}
        rows={people}
        rowKey={(person) => person.memberId}
        minWidth="48rem"
        emptyTitle={t('team.noPeople')}
        card={(person) => (
          <div className="space-y-1.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">{person.fullName}</p>
                <p className="truncate text-xs text-ink-muted">{person.email}</p>
              </div>
              <EnumBadge family="memberStatus" value={person.status} />
            </div>
            <CardField label={t('team.field.role')}>{roleLabel(t, person.role as AuditRole)}</CardField>
            <CardField label={t('team.field.credentialExpiresAt')}>{credential(person)}</CardField>
            {flags(person)}
            {actions(person)}
          </div>
        )}
      />
      {editing !== null && (
        <EditMemberDialog
          person={editing}
          onClose={() => {
            setEditing(null);
          }}
        />
      )}
    </Card>
  );
}

function EditMemberDialog({ person, onClose }: { person: ConsolePerson; onClose: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const startRole = (AGENCY_ROLES as readonly string[]).includes(person.role) ? (person.role as AgencyRoleName) : 'INSPECTOR';
  const [role, setRole] = useState<AgencyRoleName>(startRole);
  const [status, setStatus] = useState<'ACTIVE' | 'DISABLED'>(person.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE');

  const save = useConsoleMutation({
    mutationFn: (_variables, key) =>
      updateAgencyMember(
        person.memberId,
        {
          ...(role === person.role ? {} : { role }),
          ...(status === person.status ? {} : { status }),
        },
        key,
      ),
    invalidate: [consoleKeys.team()],
    successMessage: t('team.edit.saved', { name: person.fullName }),
    onSuccess: () => {
      onClose();
    },
  });

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t('team.edit.title', { name: person.fullName })}
      description={person.email}
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            isLoading={save.isPending}
            disabled={role === person.role && status === person.status}
            onClick={() => {
              save.mutate();
            }}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {save.isError && <MutationError error={save.error} />}
        <Field label={t('team.field.role')}>
          {({ inputId, describedBy }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              value={role}
              onChange={(event) => {
                setRole(event.target.value as AgencyRoleName);
              }}
            >
              {AGENCY_ROLES.map((value) => (
                <option key={value} value={value}>
                  {roleLabel(t, value)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('common.status')} hint={t('team.edit.statusHint')}>
          {({ inputId, describedBy }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as 'ACTIVE' | 'DISABLED');
              }}
            >
              <option value="ACTIVE">{t('enum.memberStatus.ACTIVE')}</option>
              <option value="DISABLED">{t('enum.memberStatus.DISABLED')}</option>
            </Select>
          )}
        </Field>
      </div>
    </Modal>
  );
}

/**
 * Audit Console access (`/audit-console`).
 *
 * The Audit Console is a separate application, on its own address, with its
 * own sign-in. Inspection agencies and the marketplace's audit team work
 * there; who may sign in to it, and as what, is decided only here.
 *
 *   People            everybody with console access, and how they sign in;
 *                     invite, change a staff role, remove access, resend an
 *                     activation link, move an agency member off an old
 *                     storefront login
 *   Compliance rules  coverage by category, and the rules waiting for a
 *                     second person's approval
 *
 * The server decides every rule here: a console account needs an email
 * address no other account uses, and nobody approves a rule they drafted.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  PageHeader,
  Select,
  Textarea,
} from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { api } from '@/lib/api';
import {
  AGENCY_ROLES,
  AUDIT_CONSOLE_PEOPLE_KEY,
  AUDIT_CONSOLE_RULES_KEY,
  CONSOLE_ROLES,
  STAFF_ROLES,
  auditConsoleApi,
  refusalCode,
  type AgencyRole,
  type ComplianceRule,
  type ConsolePerson,
  type StaffRole,
} from '@/lib/audit-console';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';

type Tab = 'people' | 'rules';

export function AuditConsoleAccessPage(): React.JSX.Element {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('people');
  return (
    <>
      <PageHeader title={t('auditConsole.title')} description={t('auditConsole.description')} />
      <div role="tablist" aria-label={t('auditConsole.tabs')} className="mb-4 flex flex-wrap gap-2">
        {(['people', 'rules'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            className={
              tab === value
                ? 'rounded-md bg-accent-soft px-3 py-1.5 text-sm font-medium text-accent'
                : 'rounded-md px-3 py-1.5 text-sm text-ink-muted hover:text-ink'
            }
            onClick={() => {
              setTab(value);
            }}
          >
            {value === 'people' ? t('auditConsole.tab.people') : t('auditConsole.tab.rules')}
          </button>
        ))}
      </div>
      {tab === 'people' ? <PeopleTab /> : <RulesTab />}
    </>
  );
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

function roleKey(role: string): TranslationKey {
  return ((CONSOLE_ROLES as readonly string[]).includes(role) ? `auditConsole.role.${role}` : 'auditConsole.role.unknown') as TranslationKey;
}

function PeopleTab(): React.JSX.Element {
  const { t } = useI18n();
  const people = useQuery({ queryKey: AUDIT_CONSOLE_PEOPLE_KEY, queryFn: auditConsoleApi.people });
  const rows = people.data?.people ?? [];
  return (
    <div className="space-y-4">
      <RolesExplained />
      <InviteForm />
      <Card title={t('auditConsole.people.title')} description={t('auditConsole.people.description')} bodyClassName="divide-y divide-border-subtle">
        {people.isPending ? (
          <LoadingState />
        ) : people.isError ? (
          <ErrorState error={people.error} onRetry={() => { void people.refetch(); }} />
        ) : rows.length === 0 ? (
          <EmptyState title={t('auditConsole.people.empty')} />
        ) : (
          rows.map((person) => <PersonRow key={`${person.kind}-${person.memberId}`} person={person} />)
        )}
      </Card>
    </div>
  );
}

function RolesExplained(): React.JSX.Element {
  const { t } = useI18n();
  return (
    <Card title={t('auditConsole.roles.title')} description={t('auditConsole.roles.description')} bodyClassName="px-5 py-4">
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        {CONSOLE_ROLES.map((role) => (
          <div key={role}>
            <dt className="font-medium text-ink">
              {t(roleKey(role))}{' '}
              <span className="text-xs font-normal text-ink-muted">
                {(STAFF_ROLES as readonly string[]).includes(role) ? t('auditConsole.kind.STAFF') : t('auditConsole.kind.AGENCY')}
              </span>
            </dt>
            <dd className="text-ink-muted">{t(`auditConsole.roleHelp.${role}` as TranslationKey)}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

interface InviteState { email: string; fullName: string; kind: 'STAFF' | 'AGENCY'; role: string; agencyId: string; jobTitle: string }

function InviteForm(): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const agencies = useQuery({
    queryKey: ['admin', 'inspection', 'agencies'],
    queryFn: () => api.get<{ agencies: { id: string; name: string; status?: string }[] }>('/admin/inspection/agencies'),
  });
  const [form, setForm] = useState<InviteState>({ email: '', fullName: '', kind: 'AGENCY', role: 'INSPECTOR', agencyId: '', jobTitle: '' });
  const [emailInUse, setEmailInUse] = useState(false);

  const invite = useMutation({
    mutationFn: () =>
      auditConsoleApi.invite({
        email: form.email.trim(),
        fullName: form.fullName.trim(),
        target:
          form.kind === 'STAFF'
            ? { kind: 'STAFF', role: form.role as StaffRole }
            : { kind: 'AGENCY', agencyId: form.agencyId, role: form.role as AgencyRole, jobTitle: form.jobTitle.trim() === '' ? null : form.jobTitle.trim() },
      }),
    onSuccess: async (result) => {
      toast.success(t('auditConsole.invite.sent', { email: form.email.trim(), until: formatDateTime(result.expiresAt) }));
      setForm({ ...form, email: '', fullName: '', jobTitle: '' });
      await queryClient.invalidateQueries({ queryKey: AUDIT_CONSOLE_PEOPLE_KEY });
    },
    onError: (failure) => {
      if (refusalCode(failure) === 'EMAIL_IN_USE') {
        setEmailInUse(true);
        return;
      }
      toast.error(errorMessage(t, failure));
    },
  });

  const roles: readonly string[] = form.kind === 'STAFF' ? STAFF_ROLES : AGENCY_ROLES;
  const ready =
    form.email.includes('@') && form.fullName.trim() !== '' && roles.includes(form.role) && (form.kind === 'STAFF' || form.agencyId !== '');

  return (
    <Card title={t('auditConsole.invite.title')} description={t('auditConsole.invite.description')} bodyClassName="grid gap-3 px-5 py-4 sm:grid-cols-2">
      <Field label={t('auditConsole.invite.email')} hint={t('auditConsole.invite.emailHint')} {...(emailInUse ? { error: t('auditConsole.invite.emailInUse') } : {})}>
        {({ inputId, describedBy }) => (
          <Input
            id={inputId}
            type="email"
            aria-describedby={describedBy}
            aria-invalid={emailInUse}
            value={form.email}
            onChange={(event) => {
              setForm({ ...form, email: event.target.value });
              setEmailInUse(false);
            }}
          />
        )}
      </Field>
      <Field label={t('auditConsole.invite.fullName')}>
        {({ inputId }) => (
          <Input id={inputId} value={form.fullName} onChange={(event) => { setForm({ ...form, fullName: event.target.value }); }} />
        )}
      </Field>
      <Field label={t('auditConsole.invite.kind')}>
        {({ inputId }) => (
          <Select
            id={inputId}
            value={form.kind}
            onChange={(event) => {
              const kind = event.target.value === 'STAFF' ? 'STAFF' : 'AGENCY';
              setForm({ ...form, kind, role: kind === 'STAFF' ? 'COMPLIANCE_REVIEWER' : 'INSPECTOR' });
            }}
          >
            <option value="AGENCY">{t('auditConsole.kind.AGENCY')}</option>
            <option value="STAFF">{t('auditConsole.kind.STAFF')}</option>
          </Select>
        )}
      </Field>
      <Field label={t('auditConsole.invite.role')}>
        {({ inputId }) => (
          <Select id={inputId} value={form.role} onChange={(event) => { setForm({ ...form, role: event.target.value }); }}>
            {roles.map((role) => <option key={role} value={role}>{t(roleKey(role))}</option>)}
          </Select>
        )}
      </Field>
      {form.kind === 'AGENCY' && (
        <>
          <Field label={t('auditConsole.invite.agency')}>
            {({ inputId }) => (
              <Select id={inputId} value={form.agencyId} onChange={(event) => { setForm({ ...form, agencyId: event.target.value }); }}>
                <option value="">{t('auditConsole.invite.chooseAgency')}</option>
                {(agencies.data?.agencies ?? []).map((agency) => <option key={agency.id} value={agency.id}>{agency.name}</option>)}
              </Select>
            )}
          </Field>
          <Field label={t('auditConsole.invite.jobTitle')}>
            {({ inputId }) => (
              <Input id={inputId} value={form.jobTitle} onChange={(event) => { setForm({ ...form, jobTitle: event.target.value }); }} />
            )}
          </Field>
        </>
      )}
      <div className="sm:col-span-2">
        <Button variant="primary" disabled={!ready || invite.isPending} onClick={() => { invite.mutate(); }}>
          {t('auditConsole.invite.submit')}
        </Button>
      </div>
    </Card>
  );
}

function accountWords(person: ConsolePerson, t: ReturnType<typeof useI18n>['t']): string {
  if (person.accountType === 'AUDIT') return t('auditConsole.account.AUDIT');
  if (person.accountType === 'CUSTOMER') return t('auditConsole.account.CUSTOMER');
  return t('auditConsole.account.other');
}

function PersonRow({ person }: { person: ConsolePerson }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [moveEmailInUse, setMoveEmailInUse] = useState(false);

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: AUDIT_CONSOLE_PEOPLE_KEY });
  };
  const run = useMutation({
    mutationFn: (step: () => Promise<unknown>) => step(),
    onSuccess: async () => {
      toast.success(t('auditConsole.saved'));
      setReason('');
      setNewEmail('');
      await refresh();
    },
    onError: (failure) => {
      if (refusalCode(failure) === 'EMAIL_IN_USE') {
        setMoveEmailInUse(true);
        return;
      }
      toast.error(errorMessage(t, failure));
    },
  });
  const busy = run.isPending;
  const legacyLogin = person.kind === 'AGENCY' && person.accountType === 'CUSTOMER';

  return (
    <div className="space-y-2 px-5 py-4 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="font-medium text-ink">{person.fullName}</p>
          <p className="text-xs text-ink-muted">
            {person.email}
            {person.agency !== null && ` · ${person.agency.name}`}
          </p>
        </div>
        <span className="flex flex-wrap gap-1.5">
          <Badge tone="accent">{t(roleKey(person.role))}</Badge>
          <Badge tone={person.status === 'ACTIVE' ? 'success' : person.status === 'DISABLED' ? 'danger' : 'warning'}>
            {t(`auditConsole.status.${person.status === 'ACTIVE' || person.status === 'DISABLED' ? person.status : 'INVITED'}` as TranslationKey)}
          </Badge>
        </span>
      </div>
      <p className="text-xs text-ink-muted">
        {t('auditConsole.signIn.how')}: {accountWords(person, t)} ·{' '}
        {person.activated ? t('auditConsole.signIn.activated') : t('auditConsole.signIn.notActivated')} ·{' '}
        {person.mfaEnrolled ? t('auditConsole.signIn.mfaOn') : t('auditConsole.signIn.mfaOff')}
        {person.identityVerified !== null && ` · ${person.identityVerified ? t('auditConsole.signIn.idVerified') : t('auditConsole.signIn.idNotVerified')}`}
        {person.credentialExpiresAt !== null && ` · ${t('auditConsole.signIn.credentialsUntil', { date: formatDateTime(person.credentialExpiresAt) })}`}
      </p>

      <div className="flex flex-wrap items-end gap-2">
        {!person.activated && person.accountType === 'AUDIT' && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => { run.mutate(() => auditConsoleApi.resendInvitation(person.userId)); }}>
            {t('auditConsole.resend')}
          </Button>
        )}

        {person.kind === 'STAFF' && (
          <>
            <Select
              className="max-w-xs"
              aria-label={t('auditConsole.changeRole', { name: person.fullName })}
              value={person.role}
              disabled={busy}
              onChange={(event) => {
                const role = event.target.value as StaffRole;
                run.mutate(() => auditConsoleApi.updateStaff(person.memberId, { role }));
              }}
            >
              {STAFF_ROLES.map((role) => <option key={role} value={role}>{t(roleKey(role))}</option>)}
            </Select>
            {person.status === 'DISABLED' ? (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => { run.mutate(() => auditConsoleApi.updateStaff(person.memberId, { status: 'ACTIVE' })); }}>
                {t('auditConsole.restore')}
              </Button>
            ) : (
              <>
                <Input
                  className="max-w-xs"
                  aria-label={t('auditConsole.disableReason', { name: person.fullName })}
                  placeholder={t('auditConsole.disableReasonPlaceholder')}
                  value={reason}
                  onChange={(event) => { setReason(event.target.value); }}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy || reason.trim() === ''}
                  onClick={() => { run.mutate(() => auditConsoleApi.updateStaff(person.memberId, { status: 'DISABLED', disabledReason: reason.trim() })); }}
                >
                  {t('auditConsole.disable')}
                </Button>
              </>
            )}
          </>
        )}
      </div>

      {legacyLogin && (
        <Callout tone="warning" title={t('auditConsole.move.title')}>
          <p>{t('auditConsole.move.body')}</p>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <Input
              className="max-w-xs"
              type="email"
              aria-label={t('auditConsole.move.email', { name: person.fullName })}
              placeholder={t('auditConsole.move.emailPlaceholder')}
              aria-invalid={moveEmailInUse}
              value={newEmail}
              onChange={(event) => {
                setNewEmail(event.target.value);
                setMoveEmailInUse(false);
              }}
            />
            <Button size="sm" variant="primary" disabled={busy || !newEmail.includes('@')} onClick={() => { run.mutate(() => auditConsoleApi.moveToConsole(person.memberId, newEmail.trim())); }}>
              {t('auditConsole.move.submit')}
            </Button>
          </div>
          {moveEmailInUse && <p role="alert" className="mt-1 text-xs font-medium text-danger">{t('auditConsole.invite.emailInUse')}</p>}
        </Callout>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compliance rules
// ---------------------------------------------------------------------------

function RulesTab(): React.JSX.Element {
  const { t } = useI18n();
  const query = useQuery({ queryKey: AUDIT_CONSOLE_RULES_KEY, queryFn: auditConsoleApi.rules });
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => { void query.refetch(); }} />;
  const waiting = query.data.rules.filter((rule) => rule.status === 'IN_REVIEW');
  const coverage = query.data.coverage;
  const needsReview = coverage.filter((row) => row.needsReview).length;
  return (
    <div className="space-y-4">
      <Callout tone="info">{t('auditConsole.rules.explain')}</Callout>
      <Card title={t('auditConsole.rules.waitingTitle')} description={t('auditConsole.rules.waitingDescription')} bodyClassName="divide-y divide-border-subtle">
        {waiting.length === 0 ? <EmptyState title={t('auditConsole.rules.waitingEmpty')} /> : waiting.map((rule) => <RuleDecision key={rule.id} rule={rule} />)}
      </Card>
      <Card
        title={t('auditConsole.rules.coverageTitle')}
        description={t('auditConsole.rules.coverageDescription', { needsReview: String(needsReview), total: String(coverage.length) })}
        bodyClassName="divide-y divide-border-subtle"
      >
        {coverage.length === 0 ? (
          <EmptyState title={t('auditConsole.rules.coverageEmpty')} />
        ) : (
          coverage.map((row) => (
            <div key={row.categoryId} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5 text-sm">
              <span style={{ paddingInlineStart: `${String(Math.min(row.depth, 6) * 0.75)}rem` }}>{row.name}</span>
              <span className="flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
                {t('auditConsole.rules.coverageCounts', { approved: String(row.approved), waiting: String(row.awaitingApproval), unresolved: String(row.unresolved) })}
                {row.needsReview && <Badge tone="warning">{t('auditConsole.rules.needsReview')}</Badge>}
              </span>
            </div>
          ))
        )}
      </Card>
    </div>
  );
}

function RuleDecision({ rule }: { rule: ComplianceRule }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const decide = useMutation({
    mutationFn: (decision: 'APPROVE' | 'REJECT') => auditConsoleApi.decideRule(rule.id, { decision, note: note.trim() }),
    onSuccess: async () => {
      toast.success(t('auditConsole.saved'));
      await queryClient.invalidateQueries({ queryKey: AUDIT_CONSOLE_RULES_KEY });
    },
    onError: (failure) => {
      setRefusal(refusalCode(failure) === 'SAME_PERSON' ? t('auditConsole.rules.samePerson') : errorMessage(t, failure));
    },
  });
  const ready = note.trim().length >= 10 && !decide.isPending;
  return (
    <div className="space-y-2 px-5 py-4 text-sm">
      <p className="font-medium text-ink">
        {rule.code} · v{rule.ruleVersion} · {rule.name}
      </p>
      <p className="text-ink-muted">{rule.description}</p>
      <p className="text-xs text-ink-muted">
        {t('auditConsole.rules.draftedBy', { name: rule.draftedByLabel ?? '-' })}
        {rule.submittedAt !== null && ` · ${formatDateTime(rule.submittedAt)}`}
      </p>
      <Textarea
        rows={2}
        aria-label={t('auditConsole.rules.note', { code: rule.code })}
        placeholder={t('auditConsole.rules.notePlaceholder')}
        value={note}
        onChange={(event) => {
          setNote(event.target.value);
          setRefusal(null);
        }}
      />
      {refusal !== null && <p role="alert" className="text-xs font-medium text-danger">{refusal}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" disabled={!ready} onClick={() => { decide.mutate('APPROVE'); }}>{t('auditConsole.rules.approve')}</Button>
        <Button size="sm" variant="secondary" disabled={!ready} onClick={() => { decide.mutate('REJECT'); }}>{t('auditConsole.rules.reject')}</Button>
      </div>
    </div>
  );
}

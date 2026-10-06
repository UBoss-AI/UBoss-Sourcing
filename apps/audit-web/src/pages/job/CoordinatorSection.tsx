/**
 * The coordinator's part: take the job or decline it, then name the inspector.
 *
 * Accepting is a statement about independence, so it asks for one in words
 * and an explicit confirmation, and shows the conflict check the server ran
 * beside it - the reasons it found, not a yes/no.
 */
import { useState } from 'react';
import { MutationError, SectionHeading } from '@/components/console';
import { Badge, Button, Callout, Card, CheckboxField, Field, Select, Textarea } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { useSession } from '@/auth/session-context';
import { acceptJob, assignInspector, consoleKeys, declineJob } from '@/lib/console-api';
import type { AgencyJobDetail } from '@/lib/console-types';
import { formatDate, humanise } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import { useConsoleMutation } from '@/lib/use-console-mutation';

export function CoordinatorSection({ detail, jobId }: { detail: AgencyJobDetail; jobId: string }): React.JSX.Element | null {
  const { t } = useI18n();
  const { can } = useSession();
  const status = detail.job.status;
  const mayAccept = can(Permission.JOB_ACCEPT) && status === 'REQUESTED';
  const mayAssign = can(Permission.JOB_ASSIGN) && (status === 'ACCEPTED' || status === 'INSPECTOR_ASSIGNED');

  if (!mayAccept && !mayAssign) return null;

  return (
    <Card
      title={t('job.coordinate.title')}
      description={t('job.coordinate.description')}
      bodyClassName="px-5 py-4 space-y-6"
    >
      <ConflictCheckSummary detail={detail} />
      {mayAccept && <AcceptOrDecline jobId={jobId} hasProblems={detail.conflictCheck.agencyProblems.length > 0 || detail.conflictCheck.personalConflict} />}
      {mayAssign && <AssignInspector detail={detail} jobId={jobId} />}
    </Card>
  );
}

function ConflictCheckSummary({ detail }: { detail: AgencyJobDetail }): React.JSX.Element {
  const { t } = useI18n();
  const { agencyProblems, personalConflict, declarations } = detail.conflictCheck;

  return (
    <div className="space-y-3">
      {agencyProblems.length === 0 && !personalConflict ? (
        <Callout tone="success" title={t('job.conflict.noneFoundTitle')}>
          {t('job.conflict.noneFound')}
        </Callout>
      ) : (
        <Callout tone="warning" role="status" title={t('job.conflict.foundTitle')}>
          <ul className="list-disc space-y-0.5 pl-5">
            {agencyProblems.map((code) => (
              <li key={code}>{t(`job.conflict.problem.${code}` as TranslationKey, { defaultValue: humanise(code) })}</li>
            ))}
            {personalConflict && <li>{t('job.conflict.personal')}</li>}
          </ul>
        </Callout>
      )}
      {declarations.length > 0 && (
        <ul className="space-y-1.5 text-sm" aria-label={t('job.conflict.declarations')}>
          {declarations.map((declaration) => (
            <li key={declaration.memberId} className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-ink">{declaration.fullName}</span>
              <Badge tone={declaration.hasConflict ? 'danger' : 'success'} dot>
                {declaration.hasConflict ? t('job.conflict.declaredConflict') : t('job.conflict.declaredNone')}
              </Badge>
              {declaration.details !== null && <span className="text-xs text-ink-muted">{declaration.details}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AcceptOrDecline({ jobId, hasProblems }: { jobId: string; hasProblems: boolean }): React.JSX.Element {
  const { t } = useI18n();
  const [statement, setStatement] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const invalidate = [consoleKeys.job(jobId), consoleKeys.jobsAll()];

  const accept = useConsoleMutation({
    mutationFn: (_vars, key) => acceptJob(jobId, { conflictStatement: statement.trim(), confirmNoConflict: true }, key),
    invalidate,
    successMessage: t('job.coordinate.accepted'),
  });
  const decline = useConsoleMutation({
    mutationFn: (_vars, key) => declineJob(jobId, { reason: reason.trim() }, key),
    invalidate,
    successMessage: t('job.coordinate.declined'),
  });

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          accept.mutate();
        }}
      >
        <SectionHeading title={t('job.coordinate.acceptTitle')} description={t('job.coordinate.acceptHint')} />
        <Field label={t('job.coordinate.statement')} required hint={t('job.coordinate.statementHint')}>
          {({ inputId, describedBy }) => (
            <Textarea
              id={inputId}
              aria-describedby={describedBy}
              value={statement}
              maxLength={2000}
              onChange={(event) => {
                setStatement(event.target.value);
              }}
            />
          )}
        </Field>
        <CheckboxField
          boxed
          tone={hasProblems ? 'warning' : 'neutral'}
          label={t('job.coordinate.confirmNoConflict')}
          description={hasProblems ? t('job.coordinate.confirmWithProblems') : undefined}
          checked={confirmed}
          onChange={(event) => {
            setConfirmed(event.target.checked);
          }}
        />
        <MutationError error={accept.error} />
        <Button type="submit" variant="primary" isLoading={accept.isPending} disabled={!confirmed || statement.trim() === ''}>
          {t('job.coordinate.accept')}
        </Button>
      </form>

      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          decline.mutate();
        }}
      >
        <SectionHeading title={t('job.coordinate.declineTitle')} description={t('job.coordinate.declineHint')} />
        {!declining ? (
          <Button
            onClick={() => {
              setDeclining(true);
            }}
          >
            {t('job.coordinate.declineStart')}
          </Button>
        ) : (
          <>
            <Field label={t('job.coordinate.declineReason')} required>
              {({ inputId, describedBy }) => (
                <Textarea
                  id={inputId}
                  aria-describedby={describedBy}
                  value={reason}
                  maxLength={1000}
                  onChange={(event) => {
                    setReason(event.target.value);
                  }}
                />
              )}
            </Field>
            <MutationError error={decline.error} />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="danger" isLoading={decline.isPending} disabled={reason.trim() === ''}>
                {t('job.coordinate.decline')}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setDeclining(false);
                }}
              >
                {t('common.cancel')}
              </Button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}

function AssignInspector({ detail, jobId }: { detail: AgencyJobDetail; jobId: string }): React.JSX.Element {
  const { t } = useI18n();
  const [inspector, setInspector] = useState('');
  const [backup, setBackup] = useState('');
  const people = detail.eligibleInspectors;
  const chosen = people.find((person) => person.id === inspector);

  const assign = useConsoleMutation({
    mutationFn: (_vars, key) =>
      assignInspector(jobId, { inspectorMemberId: inspector, backupInspectorMemberId: backup === '' ? null : backup }, key),
    invalidate: [consoleKeys.job(jobId), consoleKeys.jobsAll()],
    successMessage: t('job.coordinate.assigned'),
  });

  const optionLabel = (person: (typeof people)[number]): string =>
    [
      person.fullName,
      person.competent ? t('job.coordinate.competent') : t('job.coordinate.notCompetent'),
      person.identityVerified ? t('job.overview.identityVerified') : t('job.overview.identityNotVerified'),
    ].join(' · ');

  return (
    <form
      className="space-y-3 border-t border-border-subtle pt-5"
      onSubmit={(event) => {
        event.preventDefault();
        assign.mutate();
      }}
    >
      <SectionHeading title={t('job.coordinate.assignTitle')} description={t('job.coordinate.assignHint')} />
      {people.length === 0 ? (
        <Callout tone="warning">{t('job.coordinate.noInspectors')}</Callout>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('job.coordinate.inspector')} required>
            {({ inputId, describedBy }) => (
              <Select
                id={inputId}
                aria-describedby={describedBy}
                value={inspector}
                onChange={(event) => {
                  setInspector(event.target.value);
                }}
              >
                <option value="">{t('job.coordinate.choosePerson')}</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {optionLabel(person)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('job.coordinate.backup')} hint={t('common.optional')}>
            {({ inputId, describedBy }) => (
              <Select
                id={inputId}
                aria-describedby={describedBy}
                value={backup}
                onChange={(event) => {
                  setBackup(event.target.value);
                }}
              >
                <option value="">{t('common.none')}</option>
                {people
                  .filter((person) => person.id !== inspector)
                  .map((person) => (
                    <option key={person.id} value={person.id}>
                      {optionLabel(person)}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
        </div>
      )}
      {chosen !== undefined && (
        <div className="flex flex-wrap gap-2" aria-live="polite">
          <Badge tone={chosen.competent ? 'success' : 'warning'} dot>
            {chosen.competent ? t('job.coordinate.competent') : t('job.coordinate.notCompetent')}
          </Badge>
          <Badge tone={chosen.identityVerified ? 'success' : 'warning'} dot>
            {chosen.identityVerified ? t('job.overview.identityVerified') : t('job.overview.identityNotVerified')}
          </Badge>
          <Badge
            tone={chosen.credentialExpiresAt !== null && new Date(chosen.credentialExpiresAt).getTime() < Date.now() ? 'danger' : 'neutral'}
            dot
          >
            {chosen.credentialExpiresAt === null
              ? t('job.coordinate.noCredentialExpiry')
              : t('job.coordinate.credentialExpires', { date: formatDate(chosen.credentialExpiresAt) })}
          </Badge>
        </div>
      )}
      <MutationError error={assign.error} />
      <Button type="submit" variant="primary" isLoading={assign.isPending} disabled={inspector === ''}>
        {detail.job.status === 'INSPECTOR_ASSIGNED' ? t('job.coordinate.reassign') : t('job.coordinate.assign')}
      </Button>
    </form>
  );
}

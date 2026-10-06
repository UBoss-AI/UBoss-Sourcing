/**
 * An agency administrator invites a person into their own agency.
 *
 * The person gets a console account and an activation email. Identity is
 * recorded here as the agency states it; only the marketplace marks it as
 * verified.
 */
import { useState } from 'react';
import { Button, Callout, Field, Input, Select, Textarea } from '@/components/ui';
import { MutationError } from '@/components/console';
import { Modal } from '@/components/Modal';
import { useI18n } from '@/i18n/i18n-context';
import { consoleKeys, inviteAgencyMember } from '@/lib/console-api';
import { roleLabel } from '@/lib/labels';
import { useConsoleMutation } from '@/lib/use-console-mutation';
import { AGENCY_ROLES, type AgencyRoleName } from './standards-helpers';

const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());

export function InviteMemberForm({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState<AgencyRoleName>('INSPECTOR');
  const [jobTitle, setJobTitle] = useState('');
  const [idDocumentType, setIdDocumentType] = useState('');
  const [idDocumentNumber, setIdDocumentNumber] = useState('');
  const [credentials, setCredentials] = useState('');
  const [credentialExpiresAt, setCredentialExpiresAt] = useState('');
  const [showProblems, setShowProblems] = useState(false);

  const problems = {
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? undefined : t('team.invite.problem.email'),
    fullName: fullName.trim() === '' ? t('team.invite.problem.name') : undefined,
  };
  const show = (message: string | undefined): string | undefined => (showProblems ? message : undefined);

  const invite = useConsoleMutation({
    mutationFn: (_variables, key) =>
      inviteAgencyMember(
        {
          email: email.trim(),
          fullName: fullName.trim(),
          role,
          jobTitle: orNull(jobTitle),
          idDocumentType: orNull(idDocumentType),
          idDocumentNumber: orNull(idDocumentNumber),
          credentials: orNull(credentials),
          credentialExpiresAt: credentialExpiresAt === '' ? null : credentialExpiresAt,
        },
        key,
      ),
    invalidate: [consoleKeys.team()],
    successMessage: t('team.invite.sent', { email: email.trim() }),
    onSuccess: () => {
      onClose();
    },
  });

  const submit = (): void => {
    setShowProblems(true);
    if (problems.email !== undefined || problems.fullName !== undefined) return;
    invite.mutate();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      title={t('team.invite.title')}
      description={t('team.invite.description')}
      footer={
        <>
          <Button onClick={onClose} disabled={invite.isPending}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" isLoading={invite.isPending} onClick={submit}>
            {t('team.invite.send')}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {invite.isError && <MutationError error={invite.error} />}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('auth.email')} required error={show(problems.email)}>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                type="email"
                autoComplete="off"
                value={email}
                invalid={show(problems.email) !== undefined}
                onChange={(event) => {
                  setEmail(event.target.value);
                }}
              />
            )}
          </Field>
          <Field label={t('team.field.fullName')} required error={show(problems.fullName)}>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                value={fullName}
                invalid={show(problems.fullName) !== undefined}
                onChange={(event) => {
                  setFullName(event.target.value);
                }}
              />
            )}
          </Field>
          <Field label={t('team.field.role')} required>
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
          <Field label={t('team.field.jobTitle')}>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                value={jobTitle}
                onChange={(event) => {
                  setJobTitle(event.target.value);
                }}
              />
            )}
          </Field>
          <Field label={t('team.field.idDocumentType')} hint={t('team.invite.idHint')}>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                value={idDocumentType}
                maxLength={40}
                onChange={(event) => {
                  setIdDocumentType(event.target.value);
                }}
              />
            )}
          </Field>
          <Field label={t('team.field.idDocumentNumber')}>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                value={idDocumentNumber}
                maxLength={64}
                autoComplete="off"
                onChange={(event) => {
                  setIdDocumentNumber(event.target.value);
                }}
              />
            )}
          </Field>
          <div className="sm:col-span-2">
            <Field label={t('team.field.credentials')} hint={t('team.invite.credentialsHint')}>
              {({ inputId, describedBy }) => (
                <Textarea
                  id={inputId}
                  aria-describedby={describedBy}
                  value={credentials}
                  onChange={(event) => {
                    setCredentials(event.target.value);
                  }}
                />
              )}
            </Field>
          </div>
          <Field label={t('team.field.credentialExpiresAt')}>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                type="date"
                value={credentialExpiresAt}
                onChange={(event) => {
                  setCredentialExpiresAt(event.target.value);
                }}
              />
            )}
          </Field>
        </div>
        <Callout tone="neutral">{t('team.identityByMarketplace')}</Callout>
        <button type="submit" className="sr-only" tabIndex={-1}>
          {t('team.invite.send')}
        </button>
      </form>
    </Modal>
  );
}

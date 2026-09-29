/**
 * One company's application and verification, as its member sees it.
 *
 * What is on the screen depends on where the application stands:
 *
 *   - **Being filled in** (draft, waiting for the email code): the wizard.
 *   - **With a reviewer**: what was sent, when, the reference, and that there
 *     is nothing to do - without promising a turnaround this product cannot
 *     keep.
 *   - **Sent back** (more information, re-verification): the reviewer's
 *     request first, with a reply box and an upload for exactly the
 *     documents asked for, then the wizard for anything to correct, then
 *     "Send back for review".
 *   - **Rejected**: the reason, in the reviewer's words, and - where they
 *     left it open - the way to correct it and apply again. The previous
 *     submission and its history stay as they were.
 *   - **Approved / suspended**: where it stands, and the company's details.
 *
 * Nothing a reviewer wrote for colleagues ever reaches this page: the API
 * builds the applicant's view from an allowlist.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useSession } from '@/auth/session-context';
import { useStorefront } from '@/app/storefront-context';
import { Badge, Button, ErrorState, Field, LoadingState, Textarea } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import {
  COMPANIES_QUERY_KEY,
  IN_REVIEW,
  answerRequest,
  companyQueryKey,
  fetchApplication,
  reopenApplication,
  resubmitApplication,
  statusTone,
  type CompanyApplication,
} from '@/lib/buyer-companies';
import { errorMessage } from '@/lib/errors';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { formatDate } from './application-logic';
import { FormAlert } from './application-parts';
import { CompanyTeamPanel } from './CompanyTeamPanel';
import { CompanyWizard, DocumentRequirementBlock } from './CompanyWizard';

export function CompanyApplicationPage(): React.JSX.Element {
  const { id = '' } = useParams();
  const { t } = useI18n();
  const { business } = useStorefront();
  const query = useQuery({ queryKey: companyQueryKey(id), queryFn: () => fetchApplication(id) });

  useDocumentMeta({ title: t('companyApplication.pageTitle'), noIndex: true }, business.displayName);

  if (query.isPending) return <LoadingState label={t('companyApplication.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  return <ApplicationView application={query.data} />;
}

function ApplicationView({ application }: { application: CompanyApplication }): React.JSX.Element {
  const { t } = useI18n();
  const name = application.business.tradingName ?? application.business.legalName ?? application.reference;
  const sentBack = application.status === 'MORE_INFORMATION_REQUIRED' || application.status === 'REVERIFICATION_REQUIRED';
  const showWizard = application.actions.edit;

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">
            {t('companyApplication.reference', { reference: application.reference })}
          </p>
          <h1 className="mt-1 truncate text-title-xl text-ink">{name}</h1>
        </div>
        <Badge tone={statusTone(application.status)}>{t(`companyStatus.${application.status}` as TranslationKey)}</Badge>
      </header>

      <StatusPanel application={application} />

      {sentBack && application.infoRequests.some((request) => request.status === 'OPEN') && (
        <RequestsPanel application={application} />
      )}

      {!application.canManage && (
        <p className="rounded-md border border-border bg-surface-sunken px-3 py-2.5 text-sm text-ink-muted">
          {t('companyApplication.readOnlyRole', { role: t(`companyRole.${application.role}` as TranslationKey) })}
        </p>
      )}

      {showWizard ? <CompanyWizard application={application} /> : <SubmittedSummary application={application} />}

      {sentBack && application.actions.resubmit && <ResubmitBar application={application} />}

      <CompanyTeamPanel companyId={application.id} />

      <Timeline application={application} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function StatusPanel({ application }: { application: CompanyApplication }): React.JSX.Element {
  const { t, intlLocale } = useI18n();
  const { business } = useStorefront();
  const { refreshUser } = useSession();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const reopen = useMutation({
    mutationFn: () => reopenApplication(application.id),
    onSuccess: async (updated) => {
      queryClient.setQueryData(companyQueryKey(application.id), updated);
      await queryClient.invalidateQueries({ queryKey: COMPANIES_QUERY_KEY });
      await refreshUser();
    },
    onError: (failure) => {
      setError(errorMessage(t, failure));
    },
  });

  const status = application.status;
  const submittedOn = application.submittedAt ?? application.firstSubmittedAt;

  return (
    <section aria-labelledby="company-status-heading" className="rounded-xl border border-border bg-surface p-5 shadow-card">
      <h2 id="company-status-heading" className="text-base font-semibold text-ink">
        {t(`companyApplication.status.${status}.heading` as TranslationKey)}
      </h2>
      <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">{t(`companyApplication.status.${status}.body` as TranslationKey)}</p>

      {application.statusReason !== null && (status === 'REJECTED' || status === 'SUSPENDED' || status === 'MORE_INFORMATION_REQUIRED' || status === 'REVERIFICATION_REQUIRED' || status === 'APPROVED') && (
        <blockquote className="mt-3 whitespace-pre-line rounded-md border-l-4 border-border-strong bg-surface-sunken px-4 py-3 text-sm text-ink">
          {application.statusReasonCode !== null && (
            <span className="mb-1 block text-xs font-semibold text-ink-muted">
              {t(`companyRejection.${application.statusReasonCode}` as TranslationKey, { defaultValue: '' })}
            </span>
          )}
          {application.statusReason}
        </blockquote>
      )}

      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-ink-subtle">{t('companyApplication.referenceLabel')}</dt>
          <dd className="font-mono text-ink">{application.reference}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-subtle">{t('companyApplication.submittedLabel')}</dt>
          <dd className="text-ink">{submittedOn === null ? t('companyApplication.notSubmitted') : formatDate(submittedOn, intlLocale)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-subtle">{t('companyApplication.statusLabel')}</dt>
          <dd className="text-ink">{t(`companyStatus.${status}` as TranslationKey)}</dd>
        </div>
      </dl>

      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
        {IN_REVIEW.includes(status) && <span className="text-ink-muted">{t('companyApplication.noTimePromise')}</span>}
        {application.actions.reopen && (
          <Button
            variant="primary"
            isLoading={reopen.isPending}
            onClick={() => {
              setError(null);
              reopen.mutate();
            }}
          >
            {t('companyApplication.reopen')}
          </Button>
        )}
        {status === 'REJECTED' && !application.resubmissionAllowed && (
          <span className="text-ink-muted">{t('companyApplication.noResubmission')}</span>
        )}
        {status === 'APPROVED' && (
          <Link to="/" className="font-medium text-brand hover:underline">
            {t('companyApplication.startBuying')}
          </Link>
        )}
        {business.supportEmail !== null && (
          <a href={`mailto:${business.supportEmail}?subject=${encodeURIComponent(application.reference)}`} className="font-medium text-brand hover:underline">
            {t('companyApplication.contactSupport')}
          </a>
        )}
      </div>
      <FormAlert message={error} />
    </section>
  );
}

function RequestsPanel({ application }: { application: CompanyApplication }): React.JSX.Element {
  const { t, intlLocale } = useI18n();
  const open = application.infoRequests.filter((request) => request.status === 'OPEN');

  return (
    <section aria-labelledby="company-requests-heading" className="space-y-4 rounded-xl border border-warning/40 bg-warning-soft/40 p-5">
      <h2 id="company-requests-heading" className="text-base font-semibold text-ink">{t('companyApplication.requestsHeading')}</h2>
      {open.map((request) => (
        <article key={request.id} className="space-y-3 rounded-lg border border-border bg-surface p-4">
          <p className="text-xs text-ink-subtle">{formatDate(request.createdAt, intlLocale)}</p>
          {/* Rendered as text, never as HTML: a reviewer's words are data. */}
          <p className="whitespace-pre-line text-sm text-ink">{request.message}</p>
          {request.requestedDocumentKinds.length > 0 && (
            <DocumentRequirementBlock
              application={application}
              kinds={request.requestedDocumentKinds}
              required
              purpose={t('companyDocumentPurpose.REVIEWER_REQUESTED')}
              infoRequestId={request.id}
            />
          )}
          {application.actions.respond && <AnswerForm application={application} requestId={request.id} />}
        </article>
      ))}
    </section>
  );
}

function AnswerForm({ application, requestId }: { application: CompanyApplication; requestId: string }): React.JSX.Element {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);

  const answer = useMutation({
    mutationFn: () => answerRequest(application.id, requestId, message),
    onSuccess: (updated) => {
      queryClient.setQueryData(companyQueryKey(application.id), updated);
    },
    onError: (failure) => {
      setError(errorMessage(t, failure));
    },
  });

  return (
    <form
      noValidate
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        if (message.trim().length === 0) {
          setError(t('companyApplication.answerRequired'));
          return;
        }
        answer.mutate();
      }}
    >
      <Field label={t('companyApplication.answerLabel')} error={error ?? undefined}>
        {({ inputId, describedBy }) => (
          <Textarea id={inputId} aria-describedby={describedBy} maxLength={5000} value={message} invalid={error !== null} onChange={(event) => { setMessage(event.currentTarget.value); }} />
        )}
      </Field>
      <Button type="submit" variant="secondary" isLoading={answer.isPending}>{t('companyApplication.sendAnswer')}</Button>
    </form>
  );
}

function ResubmitBar({ application }: { application: CompanyApplication }): React.JSX.Element {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { refreshUser } = useSession();
  const [error, setError] = useState<string | null>(null);
  const openCount = application.infoRequests.filter((request) => request.status === 'OPEN').length;

  const resubmit = useMutation({
    mutationFn: () => resubmitApplication(application.id),
    onSuccess: async (updated) => {
      queryClient.setQueryData(companyQueryKey(application.id), updated);
      await refreshUser();
    },
    onError: (failure) => {
      setError(errorMessage(t, failure));
    },
  });

  return (
    <div className="space-y-2 rounded-xl border border-border bg-surface p-5">
      <p className="text-sm text-ink">{openCount > 0 ? t('companyApplication.answerFirst') : t('companyApplication.readyToResubmit')}</p>
      <Button
        variant="primary"
        disabled={openCount > 0 || application.problems.length > 0}
        isLoading={resubmit.isPending}
        onClick={() => {
          setError(null);
          resubmit.mutate();
        }}
      >
        {t('companyApplication.resubmit')}
      </Button>
      <FormAlert message={error} />
    </div>
  );
}

function SubmittedSummary({ application }: { application: CompanyApplication }): React.JSX.Element {
  const { t } = useI18n();
  const business = application.business;
  const rows: [string, string][] = [
    [t('companyWizard.business.legalName'), business.legalName ?? ''],
    [t('companyWizard.business.tradingName'), business.tradingName ?? ''],
    [t('companyWizard.business.entityType'), business.entityType === null ? '' : t(`companyEntity.${business.entityType}` as TranslationKey)],
    [t(`companyWizard.register.${application.requirements.register}.label` as TranslationKey), business.registrationNumber ?? ''],
    [t('companyWizard.applicant.businessEmail'), business.businessEmail ?? ''],
  ];
  return (
    <section aria-labelledby="company-summary-heading" className="rounded-xl border border-border bg-surface p-5">
      <h2 id="company-summary-heading" className="text-base font-semibold text-ink">{t('companyApplication.summaryHeading')}</h2>
      <dl className="mt-3 divide-y divide-border text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="grid gap-1 py-2 sm:grid-cols-[12rem_minmax(0,1fr)]">
            <dt className="text-ink-muted">{label}</dt>
            <dd className="break-words text-ink">{value === '' ? '—' : value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs text-ink-muted">{t('companyApplication.documentsCount', { count: application.documents.filter((document) => document.status === 'PENDING_REVIEW' || document.status === 'ACCEPTED').length })}</p>
    </section>
  );
}

const TIMELINE_KINDS = new Set([
  'CREATED',
  'STATUS_CHANGED',
  'EMAIL_VERIFIED',
  'DOCUMENT_UPLOADED',
  'DOCUMENT_WITHDRAWN',
  'DOCUMENT_ACCEPTED',
  'DOCUMENT_REJECTED',
  'INFO_ANSWERED',
]);

function Timeline({ application }: { application: CompanyApplication }): React.JSX.Element | null {
  const { t, intlLocale } = useI18n();
  const events = application.timeline.filter((event) => TIMELINE_KINDS.has(event.kind)).slice().reverse();
  if (events.length === 0) return null;

  return (
    <details className="rounded-xl border border-border bg-surface p-5">
      <summary className="cursor-pointer text-sm font-semibold text-ink">{t('companyApplication.historyHeading')}</summary>
      <ol className="mt-3 space-y-2 text-sm">
        {events.map((event, index) => {
          const to = typeof event.data?.['to'] === 'string' ? event.data['to'] : null;
          return (
            <li key={`${event.createdAt}-${String(index)}`} className="flex flex-col gap-0.5 border-l-2 border-border pl-3">
              <span className="text-xs text-ink-subtle">{new Date(event.createdAt).toLocaleString(intlLocale)}</span>
              <span className="text-ink">
                {event.kind === 'STATUS_CHANGED' && to !== null
                  ? t('companyApplication.event.statusChanged', { status: t(`companyStatus.${to}` as TranslationKey) })
                  : t(`companyApplication.event.${event.kind}` as TranslationKey)}
              </span>
            </li>
          );
        })}
      </ol>
    </details>
  );
}

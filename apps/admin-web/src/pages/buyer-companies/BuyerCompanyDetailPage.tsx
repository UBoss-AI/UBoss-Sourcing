/**
 * One buyer company's verification case.
 *
 * Everything a reviewer needs is on one screen - what the applicant sent,
 * what each official register said (and what could not be checked, with a
 * link to the register to check by hand), duplicate signals, documents,
 * the requests and replies, internal notes and the full history - and every
 * decision is a dialog that asks for confirmation and, where the applicant
 * will read it, a reason in words.
 *
 * The buttons come from `allowedTransitions`, which the server computes from
 * the same state machine that enforces them. A button that appears is a
 * decision the server will accept; the server re-checks it anyway.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AccessReviewCard } from '@/components/AccessReviewCard';
import { isPendingResponse, usePendingNotice } from '@/lib/governance';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Callout,
  Card,
  DescriptionList,
  ErrorState,
  Field,
  LoadingState,
  PageHeader,
  Select,
  Textarea,
} from '@/components/ui';
import { useSession } from '@/auth/session-context';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { ApiError } from '@/lib/api';
import {
  caseKey,
  fetchCase,
  fetchReviewers,
  outcomeTone,
  reviewApi,
  riskTone,
  statusTone,
  type ReviewCase,
} from '@/lib/buyer-companies';
import { formatDate, formatDateTime } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import { DecisionDialog } from './DecisionDialog';

type Dialog = 'approve' | 'reject' | 'info' | 'suspend' | 'reverify' | null;

export function BuyerCompanyDetailPage(): React.JSX.Element {
  const { id = '' } = useParams();
  const { t } = useI18n();
  const query = useQuery({ queryKey: caseKey(id), queryFn: () => fetchCase(id) });

  if (query.isPending) return <LoadingState label={t('buyerCompany.loading')} />;
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
  return <CaseView record={query.data} />;
}

function CaseView({ record }: { record: ReviewCase }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<Dialog>(null);
  const pendingNotice = usePendingNotice();

  const canReview = can(Permission.BUYER_COMPANY_REVIEW);
  const name = record.business.legalName ?? record.business.tradingName ?? record.reference;
  const transitions = new Set(record.allowedTransitions.map((transition) => transition.to));
  const restoring = record.status === 'SUSPENDED' || record.status === 'REVERIFICATION_REQUIRED';

  const apply = (updated: ReviewCase): void => {
    queryClient.setQueryData(caseKey(record.id), updated);
    void queryClient.invalidateQueries({ queryKey: ['admin', 'buyer-companies'] });
  };

  const onError = (error: unknown): void => {
    if (error instanceof ApiError && error.code === 'BUYER_COMPANY_VERSION_CONFLICT') {
      toast.error(t('buyerCompany.conflict'));
      void queryClient.invalidateQueries({ queryKey: caseKey(record.id) });
      return;
    }
    toast.error(error instanceof Error ? error.message : t('buyerCompany.actionFailed'));
  };

  const startReview = useMutation({
    mutationFn: () => reviewApi.startReview(record.id, record.version),
    onSuccess: (updated) => {
      apply(updated);
      toast.success(t('buyerCompany.reviewStarted'));
    },
    onError,
  });

  const rerun = useMutation({
    mutationFn: () => reviewApi.rerunChecks(record.id),
    onSuccess: (updated) => {
      apply(updated);
      toast.success(t('buyerCompany.checksRerun'));
    },
    onError,
  });

  const canStart = canReview && (record.status === 'SUBMITTED' || record.status === 'RESUBMITTED' || record.status === 'AUTOMATED_CHECK_IN_PROGRESS' || (record.status === 'UNDER_REVIEW' && record.currentCase?.assignedReviewer === null));

  return (
    <div className="space-y-5">
      <nav className="text-sm">
        <Link to="/buyer-companies" className="text-brand hover:underline">
          {t('buyerCompany.back')}
        </Link>
      </nav>

      <PageHeader
        title={name}
        description={t('buyerCompany.subtitle', { reference: record.reference, version: String(record.version) })}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={statusTone(record.status)}>{t(`buyerCompanies.status.${record.status}` as TranslationKey)}</Badge>
            <Badge tone={riskTone(record.riskLevel)}>{t(`buyerCompanies.risk.${record.riskLevel}` as TranslationKey)}</Badge>
          </div>
        }
      />

      {record.currentCase?.requiresSecondReview === true && (
        <Callout tone="warning" title={t('buyerCompany.secondReviewTitle')}>
          {record.currentCase.firstApprovalById === null
            ? t('buyerCompany.secondReviewNone')
            : t('buyerCompany.secondReviewFirstDone', { when: formatDateTime(record.currentCase.firstApprovalAt) })}
        </Callout>
      )}

      {record.statusReason !== null && (
        <Callout tone={record.status === 'REJECTED' || record.status === 'SUSPENDED' ? 'danger' : 'info'} title={t('buyerCompany.applicantSees')}>
          <span className="whitespace-pre-line">{record.statusReason}</span>
        </Callout>
      )}

      {/* --- Decisions --------------------------------------------------- */}
      <Card title={t('buyerCompany.actionsTitle')} bodyClassName="px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          {canStart && (
            <Button variant="primary" isLoading={startReview.isPending} onClick={() => { startReview.mutate(); }}>
              {record.status === 'UNDER_REVIEW' ? t('buyerCompany.takeCase') : t('buyerCompany.startReview')}
            </Button>
          )}
          {transitions.has('APPROVED') && (
            <Button variant="primary" onClick={() => { setDialog('approve'); }}>
              {restoring ? t('buyerCompany.restore') : t('buyerCompany.approve')}
            </Button>
          )}
          {transitions.has('MORE_INFORMATION_REQUIRED') && (
            <Button onClick={() => { setDialog('info'); }}>{t('buyerCompany.requestInfo')}</Button>
          )}
          {transitions.has('REVERIFICATION_REQUIRED') && (
            <Button onClick={() => { setDialog('reverify'); }}>{t('buyerCompany.reverify')}</Button>
          )}
          {transitions.has('SUSPENDED') && (
            <Button variant="danger" onClick={() => { setDialog('suspend'); }}>{t('buyerCompany.suspend')}</Button>
          )}
          {transitions.has('REJECTED') && (
            <Button variant="danger" onClick={() => { setDialog('reject'); }}>{t('buyerCompany.reject')}</Button>
          )}
          {canReview && (
            <Button isLoading={rerun.isPending} onClick={() => { rerun.mutate(); }}>{t('buyerCompany.rerunChecks')}</Button>
          )}
        </div>
        {record.allowedTransitions.length === 0 && !canStart && (
          <p className="mt-3 text-xs text-ink-muted">{t('buyerCompany.noActions')}</p>
        )}
        <AssignBox record={record} onUpdated={apply} onError={onError} />
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title={t('buyerCompany.companyTitle')} bodyClassName="px-5 py-4">
          <DescriptionList
            items={[
              { label: t('buyerCompany.field.legalName'), value: record.business.legalName ?? '—' },
              { label: t('buyerCompany.field.tradingName'), value: record.business.tradingName ?? '—' },
              { label: t('buyerCompany.field.entityType'), value: record.business.entityType === null ? '—' : t(`buyerCompanies.entity.${record.business.entityType}` as TranslationKey) },
              { label: t('buyerCompany.field.country'), value: record.business.registrationCountry ?? '—' },
              { label: t('buyerCompany.field.registrationNumber'), value: <span className="font-mono">{record.business.registrationNumber ?? '—'}</span> },
              { label: t('buyerCompany.field.incorporationDate'), value: record.business.incorporationDate ?? '—' },
              { label: t('buyerCompany.field.industry'), value: record.business.industry ?? '—' },
              { label: t('buyerCompany.field.website'), value: record.business.website ?? '—' },
              {
                label: t('buyerCompany.field.businessEmail'),
                value: (
                  <span>
                    {record.business.businessEmail ?? '—'}{' '}
                    <Badge tone={record.business.businessEmailVerified ? 'success' : 'warning'}>
                      {record.business.businessEmailVerified ? t('buyerCompany.verified') : t('buyerCompany.notVerified')}
                    </Badge>
                  </span>
                ),
              },
              { label: t('buyerCompany.field.domain'), value: t(`buyerCompany.domain.${record.business.businessDomainStatus}` as TranslationKey) },
              { label: t('buyerCompany.field.phone'), value: record.business.businessPhone ?? '—' },
              { label: t('buyerCompany.field.submitted'), value: record.submittedAt === null ? '—' : formatDateTime(record.submittedAt) },
            ]}
          />
        </Card>

        <Card title={t('buyerCompany.identifiersTitle')} bodyClassName="px-5 py-4">
          {record.identifiers.length === 0 ? (
            <p className="text-sm text-ink-muted">{t('buyerCompany.none')}</p>
          ) : (
            <DescriptionList
              items={record.identifiers.map((row) => ({
                label: row.scheme,
                value: row.notApplicable ? (
                  <span className="text-ink-muted">{t('buyerCompany.notApplicable', { reason: row.notApplicableReason ?? '' })}</span>
                ) : (
                  <span className="font-mono">{row.value}</span>
                ),
              }))}
            />
          )}
          {record.problems.length > 0 && (
            <Callout tone="warning" className="mt-4" title={t('buyerCompany.problemsTitle')}>
              <ul className="list-disc pl-4">
                {record.problems.map((problem) => (
                  <li key={`${problem.field}:${problem.code}`} className="font-mono text-xs">{problem.field} · {problem.code}</li>
                ))}
              </ul>
            </Callout>
          )}
        </Card>

        <Card title={t('buyerCompany.applicantTitle')} bodyClassName="px-5 py-4">
          <DescriptionList
            columns={1}
            items={[
              {
                label: t('buyerCompany.field.representative'),
                value: [record.applicant.fullName, record.applicant.phone].filter((part) => part !== null && part !== '').join(' · ') || '—',
              },
              { label: t('buyerCompany.field.jobTitle'), value: record.applicant.jobTitle ?? '—' },
              {
                label: t('buyerCompany.field.relationship'),
                value: record.applicant.relationship === null ? '—' : t(`buyerCompany.relationship.${record.applicant.relationship}` as TranslationKey),
              },
              { label: t('buyerCompany.field.authority'), value: record.applicant.authorityConfirmed ? t('buyerCompany.confirmed') : t('buyerCompany.notConfirmed') },
            ]}
          />
          <ul className="mt-4 divide-y divide-border rounded-md border border-border text-sm">
            {record.members.map((member) => (
              <li key={member.userId} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className="font-medium text-ink">{member.fullName ?? member.email}</span>
                <span className="text-xs text-ink-muted">{member.email}</span>
                {member.phone !== null && <span className="text-xs text-ink-muted">{member.phone}</span>}
                <Badge>{t(`buyerCompany.role.${member.role}` as TranslationKey)}</Badge>
                {member.status !== 'ACTIVE' && <Badge tone="warning">{member.status}</Badge>}
              </li>
            ))}
          </ul>
        </Card>

        <AccessReviewCard kind="company" id={record.id} />

        {record.linkedSeller !== null && (
          <Card title={t('buyerCompany.linkedSellerTitle')} bodyClassName="px-5 py-4">
            <p className="text-sm leading-relaxed text-ink-muted">{t('buyerCompany.linkedSellerBody')}</p>
            <DescriptionList
              columns={1}
              className="mt-3"
              items={[
                { label: t('buyerCompany.field.legalName'), value: record.linkedSeller.legalName },
                { label: t('buyerCompany.field.country'), value: record.linkedSeller.registrationCountry },
                {
                  label: t('buyerCompany.linkedSellerStatus'),
                  value: <Badge>{t(`buyerCompany.sellerStatus.${record.linkedSeller.status}` as TranslationKey)}</Badge>,
                },
              ]}
            />
            <Link to={`/sellers/${record.linkedSeller.id}`} className="mt-3 inline-block text-sm font-medium text-brand hover:underline">
              {t('buyerCompany.linkedSellerOpen')}
            </Link>
          </Card>
        )}

        <Card title={t('buyerCompany.addressesTitle')} bodyClassName="px-5 py-4">
          {record.addresses.length === 0 ? (
            <p className="text-sm text-ink-muted">{t('buyerCompany.none')}</p>
          ) : (
            <DescriptionList
              columns={1}
              items={record.addresses.map((address) => ({
                label: t(`buyerCompany.addressKind.${address.kind}` as TranslationKey),
                value: [address.line1, address.line2, address.city, address.region, address.postalCode, address.countryCode].filter((part) => part !== null && part !== '').join(', '),
              }))}
            />
          )}
        </Card>
      </div>

      <ChecksCard record={record} />
      <DocumentsCard record={record} onUpdated={apply} onError={onError} />
      <RequestsCard record={record} />
      <NotesCard record={record} onUpdated={apply} onError={onError} />
      <HistoryCard record={record} />

      {record.procurement !== null && (
        <Card title={t('buyerCompany.procurementTitle')} bodyClassName="px-5 py-4">
          <p className="mb-2 text-xs text-ink-muted">{t('buyerCompany.procurementNote')}</p>
          <pre className="overflow-x-auto rounded-md bg-surface-sunken p-3 text-xs text-ink">{JSON.stringify(record.procurement, null, 2)}</pre>
        </Card>
      )}

      {dialog === 'approve' && (
        <DecisionDialog
          title={restoring ? t('buyerCompany.restoreTitle') : t('buyerCompany.approveTitle')}
          body={restoring ? t('buyerCompany.restoreBody') : t('buyerCompany.approveBody', { name })}
          reasonLabel={t('buyerCompany.approveNote')}
          reasonRequired={restoring}
          confirmLabel={restoring ? t('buyerCompany.restore') : t('buyerCompany.approve')}
          onClose={() => { setDialog(null); }}
          onConfirm={async ({ reason }) => {
            const updated = await reviewApi.approve(record.id, { expectedVersion: record.version, reason: reason === '' ? null : reason });
            apply(updated);
            toast.success(updated.awaitingSecondReview === true ? t('buyerCompany.firstApprovalRecorded') : t('buyerCompany.approved'));
          }}
          onError={onError}
        />
      )}
      {dialog === 'reject' && (
        <DecisionDialog
          title={t('buyerCompany.rejectTitle')}
          body={t('buyerCompany.rejectBody')}
          reasonLabel={t('buyerCompany.reasonForApplicant')}
          reasonRequired
          withReasonCode
          withResubmission
          dangerous
          confirmLabel={t('buyerCompany.reject')}
          onClose={() => { setDialog(null); }}
          onConfirm={async ({ reason, reasonCode, resubmissionAllowed }) => {
            apply(await reviewApi.reject(record.id, { expectedVersion: record.version, reason, reasonCode, resubmissionAllowed }));
            toast.success(t('buyerCompany.rejected'));
          }}
          onError={onError}
        />
      )}
      {dialog === 'info' && (
        <DecisionDialog
          title={t('buyerCompany.infoTitle')}
          body={t('buyerCompany.infoBody')}
          reasonLabel={t('buyerCompany.messageForApplicant')}
          reasonRequired
          withDocuments
          confirmLabel={t('buyerCompany.sendRequest')}
          onClose={() => { setDialog(null); }}
          onConfirm={async ({ reason, documentKinds }) => {
            apply(await reviewApi.requestInformation(record.id, { expectedVersion: record.version, message: reason, documentKinds }));
            toast.success(t('buyerCompany.infoSent'));
          }}
          onError={onError}
        />
      )}
      {dialog === 'suspend' && (
        <DecisionDialog
          title={t('buyerCompany.suspendTitle')}
          body={t('buyerCompany.suspendBody')}
          reasonLabel={t('buyerCompany.reasonForApplicant')}
          reasonRequired
          dangerous
          confirmLabel={t('buyerCompany.suspend')}
          onClose={() => { setDialog(null); }}
          onConfirm={async ({ reason }) => {
            const result: unknown = await reviewApi.suspend(record.id, { expectedVersion: record.version, reason });
            // Maker-checker (JOURNEY-061): the suspension may wait for a second approver.
            if (isPendingResponse(result)) {
              pendingNotice(result.pending);
              return;
            }
            apply(result as ReviewCase);
            toast.success(t('buyerCompany.suspended'));
          }}
          onError={onError}
        />
      )}
      {dialog === 'reverify' && (
        <DecisionDialog
          title={t('buyerCompany.reverifyTitle')}
          body={t('buyerCompany.reverifyBody')}
          reasonLabel={t('buyerCompany.messageForApplicant')}
          reasonRequired
          withDocuments
          confirmLabel={t('buyerCompany.reverify')}
          onClose={() => { setDialog(null); }}
          onConfirm={async ({ reason, documentKinds }) => {
            apply(await reviewApi.reverify(record.id, { expectedVersion: record.version, reason, documentKinds }));
            toast.success(t('buyerCompany.reverifySent'));
          }}
          onError={onError}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function AssignBox({
  record,
  onUpdated,
  onError,
}: {
  record: ReviewCase;
  onUpdated: (updated: ReviewCase) => void;
  onError: (error: unknown) => void;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const { can } = useSession();
  const reviewers = useQuery({ queryKey: ['admin', 'buyer-company-reviewers'], queryFn: fetchReviewers });
  const assign = useMutation({
    mutationFn: (reviewerId: string | null) => reviewApi.assign(record.id, reviewerId),
    onSuccess: onUpdated,
    onError,
  });

  if (record.currentCase === null || record.currentCase.state !== 'OPEN') return null;
  const current = record.currentCase.assignedReviewer?.id ?? '';

  return (
    <div className="mt-4 max-w-sm">
      <Field label={t('buyerCompany.assignee')}>
        {({ inputId, describedBy }) => (
          <Select
            id={inputId}
            aria-describedby={describedBy}
            value={current}
            disabled={!can(Permission.BUYER_COMPANY_REVIEW) || assign.isPending}
            onChange={(event) => {
              assign.mutate(event.currentTarget.value === '' ? null : event.currentTarget.value);
            }}
          >
            <option value="">{t('buyerCompanies.unassigned')}</option>
            {(reviewers.data?.reviewers ?? []).map((reviewer) => (
              <option key={reviewer.id} value={reviewer.id}>{reviewer.email}</option>
            ))}
          </Select>
        )}
      </Field>
    </div>
  );
}

function ChecksCard({ record }: { record: ReviewCase }): React.JSX.Element {
  const { t } = useI18n();
  const duplicates = record.checks.filter((check) => check.provider === 'DUPLICATES');
  const others = record.checks.filter((check) => check.provider !== 'DUPLICATES');

  return (
    <Card title={t('buyerCompany.checksTitle')} description={t('buyerCompany.checksDescription')} bodyClassName="px-5 py-4">
      {duplicates.length > 0 && (
        <Callout tone="warning" title={t('buyerCompany.duplicatesTitle')} className="mb-4">
          <ul className="space-y-1">
            {duplicates.map((check) => {
              const matches = Array.isArray((check.result as { matches?: unknown } | null)?.matches)
                ? ((check.result as { matches: { id: string; reference: string; status: string }[] }).matches)
                : [];
              return (
                <li key={check.id} className="text-sm">
                  <span className="font-medium">{check.subject}</span>:{' '}
                  {matches.map((match, index) => (
                    <span key={match.id}>
                      {index > 0 && ', '}
                      <Link to={`/buyer-companies/${match.id}`} className="font-mono text-brand hover:underline">{match.reference}</Link>{' '}
                      <span className="text-xs text-ink-muted">({t(`buyerCompanies.status.${match.status}` as TranslationKey)})</span>
                    </span>
                  ))}
                </li>
              );
            })}
          </ul>
        </Callout>
      )}

      {others.length === 0 ? (
        <p className="text-sm text-ink-muted">{t('buyerCompany.noChecks')}</p>
      ) : (
        <ul className="divide-y divide-border">
          {others.map((check) => (
            <li key={check.id} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-start sm:gap-3">
              <div className="flex shrink-0 items-center gap-2 sm:w-56">
                <Badge tone={outcomeTone(check.outcome)}>{t(`buyerCompany.outcome.${check.outcome}` as TranslationKey)}</Badge>
                <span className="text-xs font-medium text-ink">{check.provider}</span>
              </div>
              <div className="min-w-0 flex-1 text-sm">
                <p className="text-ink">
                  <span className="font-mono text-xs text-ink-subtle">{check.subject}</span> · {check.summary}
                </p>
                <p className="mt-0.5 text-xs text-ink-subtle">
                  {formatDateTime(check.checkedAt)}
                  {check.sourceReference !== null && ` · ${t('buyerCompany.sourceReference', { reference: check.sourceReference })}`}
                </p>
                {check.result !== null && (
                  <details className="mt-1 text-xs">
                    <summary className="cursor-pointer text-brand">{t('buyerCompany.evidence')}</summary>
                    <pre className="mt-1 overflow-x-auto rounded bg-surface-sunken p-2 text-ink">{JSON.stringify(check.result, null, 2)}</pre>
                  </details>
                )}
              </div>
              {check.sourceUrl !== null && (
                <a href={check.sourceUrl} target="_blank" rel="noopener noreferrer" className="shrink-0 text-xs font-medium text-brand hover:underline">
                  {t('buyerCompany.openRegister')}
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function DocumentsCard({
  record,
  onUpdated,
  onError,
}: {
  record: ReviewCase;
  onUpdated: (updated: ReviewCase) => void;
  onError: (error: unknown) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const open = useMutation({
    mutationFn: reviewApi.documentLink,
    onSuccess: (link) => {
      // Opened at once and never kept: a signed link held in state is a link
      // that outlives the page it belongs to.
      window.open(link.url, '_blank', 'noopener,noreferrer');
    },
    onError,
  });

  const decide = useMutation({
    mutationFn: ({ documentId, decision, text }: { documentId: string; decision: 'ACCEPTED' | 'REJECTED'; text: string | null }) =>
      reviewApi.decideDocument(documentId, decision, text),
    onSuccess: (updated) => {
      onUpdated(updated);
      setRejecting(null);
      setReason('');
    },
    onError,
  });

  const visible = record.documents.filter((document) => document.status !== 'SUPERSEDED');

  return (
    <Card title={t('buyerCompany.documentsTitle')} description={t('buyerCompany.documentsDescription')} bodyClassName="px-5 py-4">
      {visible.length === 0 ? (
        <p className="text-sm text-ink-muted">{t('buyerCompany.noDocuments')}</p>
      ) : (
        <ul className="divide-y divide-border">
          {visible.map((document) => (
            <li key={document.id} className="flex flex-wrap items-center gap-2 py-3 text-sm">
              <span className="font-medium text-ink">{t(`buyerCompany.documentKind.${document.kind}` as TranslationKey)}</span>
              <span className="text-xs text-ink-muted">
                {document.mimeType} · {Math.max(1, Math.round(document.sizeBytes / 1024))} KB
                {document.pageCount !== null && ` · ${t('buyerCompany.pages', { count: document.pageCount })}`}
                {' · '}
                {formatDate(document.createdAt)}
              </span>
              <Badge tone={document.status === 'ACCEPTED' ? 'success' : document.status === 'REJECTED' ? 'danger' : 'neutral'}>
                {t(`buyerCompany.documentStatus.${document.status}` as TranslationKey)}
              </Badge>
              <span className="ml-auto flex flex-wrap gap-2">
                <Button size="sm" isLoading={open.isPending && open.variables === document.id} onClick={() => { open.mutate(document.id); }}>
                  {t('buyerCompany.openDocument')}
                </Button>
                {can(Permission.BUYER_COMPANY_REVIEW) && document.status === 'PENDING_REVIEW' && (
                  <>
                    <Button size="sm" onClick={() => { decide.mutate({ documentId: document.id, decision: 'ACCEPTED', text: null }); }}>
                      {t('buyerCompany.acceptDocument')}
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => { setRejecting(document.id); }}>
                      {t('buyerCompany.rejectDocument')}
                    </Button>
                  </>
                )}
              </span>
              {document.reviewReason !== null && <p className="basis-full text-xs text-danger">{document.reviewReason}</p>}
              {rejecting === document.id && (
                <div className="basis-full space-y-2 rounded-md border border-border p-3">
                  <Field label={t('buyerCompany.reasonForApplicant')} required>
                    {({ inputId, describedBy }) => (
                      <Textarea id={inputId} aria-describedby={describedBy} value={reason} onChange={(event) => { setReason(event.currentTarget.value); }} />
                    )}
                  </Field>
                  <div className="flex gap-2">
                    <Button size="sm" variant="danger" disabled={reason.trim().length === 0} isLoading={decide.isPending} onClick={() => { decide.mutate({ documentId: document.id, decision: 'REJECTED', text: reason.trim() }); }}>
                      {t('buyerCompany.rejectDocument')}
                    </Button>
                    <Button size="sm" onClick={() => { setRejecting(null); }}>{t('buyerCompany.cancel')}</Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function RequestsCard({ record }: { record: ReviewCase }): React.JSX.Element | null {
  const { t } = useI18n();
  if (record.infoRequests.length === 0) return null;
  return (
    <Card title={t('buyerCompany.requestsTitle')} description={t('buyerCompany.requestsDescription')} bodyClassName="px-5 py-4">
      <ul className="space-y-3">
        {record.infoRequests.map((request) => (
          <li key={request.id} className="rounded-md border border-border p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={request.status === 'OPEN' ? 'warning' : request.status === 'ANSWERED' ? 'success' : 'neutral'}>
                {t(`buyerCompany.requestStatus.${request.status}` as TranslationKey)}
              </Badge>
              <span className="text-xs text-ink-subtle">{formatDateTime(request.createdAt)}</span>
            </div>
            <p className="mt-2 whitespace-pre-line text-ink">{request.message}</p>
            {request.requestedDocumentKinds.length > 0 && (
              <p className="mt-1 text-xs text-ink-muted">
                {t('buyerCompany.requestedDocuments')}: {request.requestedDocumentKinds.map((kind) => t(`buyerCompany.documentKind.${kind}` as TranslationKey)).join(', ')}
              </p>
            )}
            {request.responseMessage !== null && (
              <blockquote className="mt-2 whitespace-pre-line border-l-4 border-border-strong pl-3 text-ink">
                <span className="block text-xs text-ink-subtle">{t('buyerCompany.applicantAnswered', { when: formatDateTime(request.respondedAt) })}</span>
                {request.responseMessage}
              </blockquote>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function NotesCard({
  record,
  onUpdated,
  onError,
}: {
  record: ReviewCase;
  onUpdated: (updated: ReviewCase) => void;
  onError: (error: unknown) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const [note, setNote] = useState('');
  const add = useMutation({
    mutationFn: () => reviewApi.note(record.id, note.trim()),
    onSuccess: (updated) => {
      onUpdated(updated);
      setNote('');
    },
    onError,
  });
  const notes = record.timeline.filter((event) => event.kind === 'NOTE').slice().reverse();

  return (
    <Card title={t('buyerCompany.notesTitle')} description={t('buyerCompany.notesDescription')} bodyClassName="px-5 py-4">
      {can(Permission.BUYER_COMPANY_REVIEW) && (
        <form
          className="mb-4 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (note.trim().length > 0) add.mutate();
          }}
        >
          <Field label={t('buyerCompany.newNote')}>
            {({ inputId, describedBy }) => (
              <Textarea id={inputId} aria-describedby={describedBy} maxLength={5000} value={note} onChange={(event) => { setNote(event.currentTarget.value); }} />
            )}
          </Field>
          <Button type="submit" size="sm" disabled={note.trim().length === 0} isLoading={add.isPending}>
            {t('buyerCompany.addNote')}
          </Button>
        </form>
      )}
      {notes.length === 0 ? (
        <p className="text-sm text-ink-muted">{t('buyerCompany.noNotes')}</p>
      ) : (
        <ul className="space-y-2">
          {notes.map((event) => (
            <li key={event.id} className="rounded-md bg-surface-sunken p-3 text-sm">
              <p className="text-xs text-ink-subtle">{formatDateTime(event.createdAt)}</p>
              <p className="mt-1 whitespace-pre-line text-ink">{event.message}</p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function HistoryCard({ record }: { record: ReviewCase }): React.JSX.Element {
  const { t } = useI18n();
  const events = record.timeline.slice().reverse();
  return (
    <Card title={t('buyerCompany.historyTitle')} description={t('buyerCompany.historyDescription')} bodyClassName="px-5 py-4">
      <ol className="space-y-2 text-sm">
        {events.map((event) => {
          const to = typeof event.data?.['to'] === 'string' ? event.data['to'] : null;
          return (
            <li key={event.id} className="flex flex-col gap-0.5 border-l-2 border-border pl-3">
              <span className="text-xs text-ink-subtle">
                {formatDateTime(event.createdAt)} · {event.actorType}
                {event.visibility === 'INTERNAL' && ` · ${t('buyerCompany.internal')}`}
              </span>
              <span className="text-ink">
                {event.kind === 'STATUS_CHANGED' && to !== null
                  ? t('buyerCompany.event.statusChanged', { status: t(`buyerCompanies.status.${to}` as TranslationKey) })
                  : t(`buyerCompany.event.${event.kind}` as TranslationKey, { defaultValue: event.kind })}
              </span>
              {event.message !== null && event.kind !== 'NOTE' && <span className="whitespace-pre-line text-xs text-ink-muted">{event.message}</span>}
            </li>
          );
        })}
      </ol>
      {record.consents.length > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">{t('buyerCompany.declarations')}</p>
          <ul className="mt-1 space-y-0.5 text-xs text-ink-muted">
            {record.consents.map((consent) => (
              <li key={`${consent.purpose}-${consent.acceptedAt}`}>
                {consent.purpose} · v{consent.textVersion} · {formatDateTime(consent.acceptedAt)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}


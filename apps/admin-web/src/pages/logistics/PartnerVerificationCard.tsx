/**
 * Verifying a carrier: its identity, the change it has asked for, its file.
 *
 * Everything the carrier proposes from My Profile that touches who it IS -
 * legal and trading name, registration and tax number, registered address,
 * licence - waits here, beside the compliance documents it has filed. An
 * approval applies the change and marks the company verified; a refusal needs
 * a reason, because the carrier is shown it and a refusal with no reason
 * cannot be fixed.
 *
 * Documents are downloaded through a link that works once, for the member of
 * staff who asked, for a few minutes. Nothing here is ever a public URL.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Callout, Card, ErrorState, Field, LoadingState, Textarea } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { formatDate, formatDateTime } from '@/lib/format';
import {
  decideDocument,
  decideProfileChange,
  downloadReviewDocument,
  fetchPartnerReview,
  partnerReviewKey,
  setVerification,
  type PartnerProfileReview,
  type ReviewDocument,
  type VerificationState,
} from '@/lib/logistics-profile';
import { Permission } from '@/lib/permissions';

type Pending =
  | { kind: 'change'; changeId: string; decision: 'REJECTED' }
  | { kind: 'document'; documentId: string; decision: 'REJECTED' }
  | { kind: 'verification'; state: Exclude<VerificationState, 'VERIFIED'> };

const MIN_REASON = 8;

function describe(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const address = value as Partial<Record<string, string | null>>;
    return [address['line1'], address['line2'], address['city'], address['postalCode'], address['countryCode']]
      .filter((part): part is string => typeof part === 'string' && part !== '')
      .join(', ');
  }
  return typeof value === 'number' || typeof value === 'boolean' ? String(value) : '—';
}

const VERIFICATION_TONE: Record<VerificationState, 'success' | 'warning' | 'neutral'> = {
  VERIFIED: 'success',
  UNVERIFIED: 'neutral',
  REVERIFICATION_REQUIRED: 'warning',
};

const REVIEW_TONE: Record<ReviewDocument['reviewState'], 'success' | 'danger' | 'accent'> = {
  VERIFIED: 'success',
  REJECTED: 'danger',
  PENDING_REVIEW: 'accent',
};

export function PartnerVerificationCard({ partnerId }: { partnerId: string }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { can } = useSession();
  const mayDecide = can(Permission.LOGISTICS_WRITE);

  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState('');
  const [attempted, setAttempted] = useState(false);

  const query = useQuery({
    queryKey: partnerReviewKey(partnerId),
    queryFn: () => fetchPartnerReview(partnerId),
  });

  const settle = (review: PartnerProfileReview, message: string): void => {
    queryClient.setQueryData(partnerReviewKey(partnerId), review);
    void queryClient.invalidateQueries({ queryKey: ['admin', 'logistics', 'partner', partnerId] });
    setPending(null);
    setReason('');
    setAttempted(false);
    toast.success(message);
  };

  const onError = (error: Error): void => {
    toast.error(error.message);
  };

  const changeDecision = useMutation({
    mutationFn: (input: { changeId: string; decision: 'APPROVED' | 'REJECTED'; note: string }) =>
      decideProfileChange(partnerId, input.changeId, input.decision, input.note),
    onSuccess: (review, input) => {
      settle(
        review,
        input.decision === 'APPROVED'
          ? t('logistics.verification.changeApproved')
          : t('logistics.verification.changeRejected'),
      );
    },
    onError,
  });

  const documentDecision = useMutation({
    mutationFn: (input: { documentId: string; decision: 'VERIFIED' | 'REJECTED'; reason: string }) =>
      decideDocument(partnerId, input.documentId, input.decision, input.reason),
    onSuccess: (review, input) => {
      settle(
        review,
        input.decision === 'VERIFIED'
          ? t('logistics.verification.documentVerified')
          : t('logistics.verification.documentRejected'),
      );
    },
    onError,
  });

  const verification = useMutation({
    mutationFn: (input: { state: VerificationState; note: string }) =>
      setVerification(partnerId, input.state, input.note),
    onSuccess: (review) => {
      settle(review, t('logistics.verification.stateSaved'));
    },
    onError,
  });

  const download = useMutation({
    mutationFn: (document: ReviewDocument) => downloadReviewDocument(partnerId, document),
    onError,
  });

  const working = changeDecision.isPending || documentDecision.isPending || verification.isPending;

  if (query.isLoading) return <LoadingState />;
  if (query.isError || query.data === undefined) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  const { profile, documentHistory } = query.data;
  const change = profile.review.pendingChange;
  const state = profile.identity.verificationState;

  const confirmPending = (): void => {
    setAttempted(true);
    if (pending === null || reason.trim().length < MIN_REASON) return;
    if (pending.kind === 'change') {
      changeDecision.mutate({ changeId: pending.changeId, decision: 'REJECTED', note: reason });
    } else if (pending.kind === 'document') {
      documentDecision.mutate({ documentId: pending.documentId, decision: 'REJECTED', reason });
    } else {
      verification.mutate({ state: pending.state, note: reason });
    }
  };

  const fieldLabel = (field: string): string =>
    t(`logistics.verification.field.${field}` as TranslationKey);

  return (
    <Card
      title={t('logistics.verification.title')}
      description={t('logistics.verification.description')}
      bodyClassName="space-y-5 px-5 py-4"
      actions={
        <Badge tone={VERIFICATION_TONE[state]} dot>
          {t(`logistics.verification.state.${state}`)}
        </Badge>
      }
    >
      <section aria-labelledby="verification-identity" className="space-y-2">
        <h3 id="verification-identity" className="text-sm font-semibold text-ink">
          {t('logistics.verification.identityHeading')}
        </h3>
        <p className="text-sm text-ink-muted">
          {profile.identity.verifiedAt === null
            ? t('logistics.verification.neverVerified')
            : t('logistics.verification.verifiedOn', { date: formatDateTime(profile.identity.verifiedAt) })}
        </p>
        {mayDecide ? (
          <div className="flex flex-wrap gap-2">
            {state === 'VERIFIED' ? null : (
              <Button
                size="sm"
                variant="primary"
                isLoading={verification.isPending}
                onClick={() => {
                  verification.mutate({ state: 'VERIFIED', note: '' });
                }}
              >
                {t('logistics.verification.markVerified')}
              </Button>
            )}
            {state === 'VERIFIED' ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={working}
                onClick={() => {
                  setPending({ kind: 'verification', state: 'REVERIFICATION_REQUIRED' });
                }}
              >
                {t('logistics.verification.requireReverification')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </section>

      <section aria-labelledby="verification-change" className="space-y-2">
        <h3 id="verification-change" className="text-sm font-semibold text-ink">
          {t('logistics.verification.changeHeading')}
        </h3>
        {change === null ? (
          <p className="text-sm text-ink-muted">{t('logistics.verification.noChange')}</p>
        ) : (
          <div className="rounded-lg border border-warning/30 bg-warning-soft px-4 py-3">
            <p className="text-xs text-ink-muted">
              {t('logistics.verification.requestedBy', {
                who: change.requestedByLabel,
                when: formatDateTime(change.requestedAt),
              })}
            </p>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[28rem] text-sm">
                <caption className="sr-only">{t('logistics.verification.changeHeading')}</caption>
                <thead>
                  <tr className="text-left text-xs text-ink-muted">
                    <th scope="col" className="py-1 pr-3 font-medium">{t('logistics.verification.column.field')}</th>
                    <th scope="col" className="py-1 pr-3 font-medium">{t('logistics.verification.column.current')}</th>
                    <th scope="col" className="py-1 font-medium">{t('logistics.verification.column.proposed')}</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(change.proposed).map(([field, value]) => (
                    <tr key={field} className="border-t border-warning/20 align-top">
                      <th scope="row" className="py-1.5 pr-3 font-medium text-ink">{fieldLabel(field)}</th>
                      <td className="py-1.5 pr-3 text-ink-muted">{describe(change.current[field])}</td>
                      <td className="py-1.5 font-medium text-ink">{describe(value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {mayDecide ? (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  isLoading={changeDecision.isPending}
                  onClick={() => {
                    changeDecision.mutate({ changeId: change.id, decision: 'APPROVED', note: '' });
                  }}
                >
                  {t('logistics.verification.approveChange')}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={working}
                  onClick={() => {
                    setPending({ kind: 'change', changeId: change.id, decision: 'REJECTED' });
                  }}
                >
                  {t('logistics.verification.rejectChange')}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </section>

      <section aria-labelledby="verification-documents" className="space-y-2">
        <h3 id="verification-documents" className="text-sm font-semibold text-ink">
          {t('logistics.verification.documentsHeading')}
        </h3>
        <ul className="flex flex-wrap gap-2">
          {profile.compliance.items.map((item) => (
            <li key={item.kind}>
              <Badge
                tone={
                  item.status === 'VERIFIED'
                    ? 'success'
                    : item.status === 'MISSING'
                      ? 'neutral'
                      : item.status === 'PENDING_REVIEW'
                        ? 'accent'
                        : 'warning'
                }
                dot
              >
                {t(`logistics.verification.kind.${item.kind}`)} · {t(`logistics.verification.status.${item.status}`)}
              </Badge>
            </li>
          ))}
        </ul>

        {documentHistory.length === 0 ? (
          <p className="text-sm text-ink-muted">{t('logistics.verification.noDocuments')}</p>
        ) : (
          <ul className="divide-y divide-border-subtle rounded-lg border border-border-subtle">
            {documentHistory.map((document) => (
              <li
                key={document.id}
                className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">
                    {t(`logistics.verification.kind.${document.kind}`)} · {document.fileName}
                  </p>
                  <p className="text-xs text-ink-muted">
                    {t('logistics.verification.uploaded', {
                      who: document.uploadedByLabel,
                      when: formatDate(document.createdAt),
                    })}
                    {document.expiresOn === null
                      ? ''
                      : ` · ${t('logistics.verification.expires', { date: formatDate(document.expiresOn) })}`}
                    {document.supersededAt === null ? '' : ` · ${t('logistics.verification.superseded')}`}
                  </p>
                  {document.rejectionReason === null ? null : (
                    <p className="text-xs text-danger">{document.rejectionReason}</p>
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Badge tone={document.scanState === 'CLEAN' ? 'success' : document.scanState === 'INFECTED' || document.scanState === 'FAILED' ? 'danger' : 'neutral'}>
                    {t(`logistics.verification.scan.${document.scanState}`)}
                  </Badge>
                  <Badge tone={REVIEW_TONE[document.reviewState]} dot>
                    {t(`logistics.verification.review.${document.reviewState}`)}
                  </Badge>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!document.downloadable || download.isPending}
                    title={document.downloadable ? undefined : t('logistics.verification.notDownloadable')}
                    onClick={() => {
                      download.mutate(document);
                    }}
                  >
                    {t('logistics.verification.download')}
                  </Button>
                  {mayDecide && document.supersededAt === null && document.reviewState !== 'VERIFIED' ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={working || document.scanState === 'INFECTED' || document.scanState === 'FAILED'}
                      onClick={() => {
                        documentDecision.mutate({ documentId: document.id, decision: 'VERIFIED', reason: '' });
                      }}
                    >
                      {t('logistics.verification.verifyDocument')}
                    </Button>
                  ) : null}
                  {mayDecide && document.supersededAt === null && document.reviewState !== 'REJECTED' ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={working}
                      onClick={() => {
                        setPending({ kind: 'document', documentId: document.id, decision: 'REJECTED' });
                      }}
                    >
                      {t('logistics.verification.rejectDocument')}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        {documentHistory.some((document) => document.scanState === 'SKIPPED') ? (
          <Callout tone="warning">{t('logistics.verification.unscannedWarning')}</Callout>
        ) : null}
      </section>

      <Modal
        isOpen={pending !== null}
        onClose={() => {
          setPending(null);
          setReason('');
          setAttempted(false);
        }}
        title={
          pending?.kind === 'verification'
            ? t('logistics.verification.requireReverification')
            : pending?.kind === 'document'
              ? t('logistics.verification.rejectDocument')
              : t('logistics.verification.rejectChange')
        }
        footer={
          <>
            <Button
              onClick={() => {
                setPending(null);
              }}
              disabled={working}
            >
              {t('modal.cancel')}
            </Button>
            <Button variant="danger" onClick={confirmPending} isLoading={working}>
              {t('logistics.verification.confirmReason')}
            </Button>
          </>
        }
      >
        <Field
          label={t('logistics.verification.reasonLabel')}
          hint={t('logistics.verification.reasonHint')}
          error={attempted && reason.trim().length < MIN_REASON ? t('logistics.verification.reasonTooShort') : undefined}
          required
        >
          {({ inputId, describedBy }) => (
            <Textarea
              id={inputId}
              aria-describedby={describedBy}
              value={reason}
              maxLength={512}
              invalid={attempted && reason.trim().length < MIN_REASON}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
          )}
        </Field>
      </Modal>
    </Card>
  );
}

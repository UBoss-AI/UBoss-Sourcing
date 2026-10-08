/**
 * One seller application, as the Audit Team verifies it.
 *
 *   GET  /api/v1/audit/seller-verification/:id                       the application, readiness, turnover, history
 *   POST /api/v1/audit/seller-verification/:id/decision              take for review / ask for corrections / approve / reject
 *   POST /api/v1/audit/seller-verification/documents/:id/decision    accept or refuse one document
 *   (screening and turnover decisions live in their panels)
 *
 * Every decision carries the version on screen, so a colleague's decision
 * made meanwhile is never overwritten: the server refuses and this screen says
 * to reload. A reason the seller reads is required to ask for corrections or
 * to reject. Approval still runs the server's evidence gate; the panel above
 * the buttons says what it is waiting for, and a refusal lists it again.
 *
 * Nothing here edits what the seller submitted. The Audit Team records
 * decisions; the seller changes their own details.
 */
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { DownloadButton, HistoryList, MutationError, QueryBoundary } from '@/components/console';
import { Modal } from '@/components/Modal';
import { Badge, Button, Callout, Card, CheckboxField, DescriptionList, Field, PageHeader, Textarea } from '@/components/ui';
import { useSession } from '@/auth/session-context';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { formatDateTime } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import {
  decideDocument,
  decideVerification,
  documentFilePath,
  documentKindLabel,
  fetchVerification,
  verificationKeys,
  type SellerDocument,
  type SellerVerificationDetail,
  type VerificationDecisionStatus,
  type VerificationHistoryEntry,
} from '@/lib/seller-verification';
import { useConsoleMutation } from '@/lib/use-console-mutation';
import { KybReviewPanel } from './KybReviewPanel';
import { NEEDS_REASON, STATUS_TONE, decisionsFor } from './status';
import { TurnoverPanel } from './TurnoverPanel';

const DECISION_LABEL: Record<VerificationDecisionStatus, TranslationKey> = {
  UNDER_REVIEW: 'sellerVerification.action.UNDER_REVIEW',
  ACTION_REQUIRED: 'sellerVerification.action.ACTION_REQUIRED',
  APPROVED: 'sellerVerification.action.APPROVED',
  REJECTED: 'sellerVerification.action.REJECTED',
};

const DECISION_EXPLAIN: Record<VerificationDecisionStatus, TranslationKey> = {
  UNDER_REVIEW: 'sellerVerification.explain.UNDER_REVIEW',
  ACTION_REQUIRED: 'sellerVerification.explain.ACTION_REQUIRED',
  APPROVED: 'sellerVerification.explain.APPROVED',
  REJECTED: 'sellerVerification.explain.REJECTED',
};

export function SellerVerificationDetailPage(): React.JSX.Element {
  const { t } = useI18n();
  const { id = '' } = useParams();
  const query = useQuery({ queryKey: verificationKeys.detail(id), queryFn: () => fetchVerification(id), enabled: id !== '' });
  const back = { to: '/seller-verification', label: t('sellerVerification.title') };

  return (
    <>
      {query.isPending || query.isError ? <PageHeader back={back} title={t('sellerVerification.detailTitle')} /> : null}
      <QueryBoundary query={query}>{(detail) => <DetailScreen detail={detail} back={back} />}</QueryBoundary>
    </>
  );
}

function DetailScreen({ detail, back }: { detail: SellerVerificationDetail; back: { to: string; label: string } }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const canVerify = can(Permission.SELLER_VERIFY);
  const seller = detail.application;
  const [deciding, setDeciding] = useState<VerificationDecisionStatus | null>(null);

  const decisions = canVerify
    ? decisionsFor(seller.status).filter((next) => !(seller.status === 'REJECTED' && next === 'ACTION_REQUIRED' && !seller.resubmissionAllowed))
    : [];
  const profile = seller.businessProfile;
  const none = t('common.none');

  return (
    <>
      <PageHeader
        back={back}
        title={seller.displayName}
        description={seller.legalName}
        meta={<Badge tone={STATUS_TONE[seller.status]}>{t(`sellerVerification.status.${seller.status}` as TranslationKey)}</Badge>}
        actions={
          decisions.length === 0 ? undefined : (
            <>
              {decisions.map((next) => (
                <Button
                  key={next}
                  size="md"
                  variant={next === 'APPROVED' ? 'primary' : next === 'REJECTED' ? 'danger' : 'secondary'}
                  onClick={() => {
                    setDeciding(next);
                  }}
                >
                  {t(DECISION_LABEL[next])}
                </Button>
              ))}
            </>
          )
        }
      />

      <div className="space-y-6">
        {seller.status === 'DRAFT' && (
          <Callout tone="neutral" title={t('sellerVerification.draftTitle')}>
            {t('sellerVerification.draftBody')}
          </Callout>
        )}
        {seller.status === 'SUSPENDED' && (
          <Callout tone="warning" title={t('sellerVerification.suspendedTitle')}>
            {t('sellerVerification.suspendedBody')}
          </Callout>
        )}

        <Card title={t('sellerVerification.decisionCard')} bodyClassName="px-5 py-4">
          <DescriptionList
            columns={3}
            items={[
              { label: t('common.status'), value: t(`sellerVerification.status.${seller.status}` as TranslationKey) },
              { label: t('sellerVerification.submittedAt'), value: formatDateTime(seller.submittedAt) },
              { label: t('sellerVerification.approvedAt'), value: formatDateTime(seller.approvedAt) },
              { label: t('sellerVerification.decidedBy'), value: <DecidedBy entry={seller.verification.currentDecision} /> },
              {
                label: t('sellerVerification.resubmission'),
                value: seller.resubmissionAllowed ? t('sellerVerification.resubmissionOpen') : t('sellerVerification.resubmissionClosed'),
              },
            ]}
          />
          <div className="mt-5 grid gap-3 md:grid-cols-2">
            <MessageBox kind="seller" text={seller.statusReason} />
            <MessageBox kind="internal" text={seller.internalNotes} />
          </div>
        </Card>

        <Card title={t('sellerVerification.businessCard')} description={t('sellerVerification.businessHint')} bodyClassName="px-5 py-4">
          <DescriptionList
            columns={3}
            items={[
              { label: t('sellerVerification.field.country'), value: seller.registrationCountry },
              { label: t('sellerVerification.field.kind'), value: seller.kind },
              { label: t('sellerVerification.field.registration'), value: profile?.companyRegistrationNumber ?? none },
              { label: t('sellerVerification.field.tax'), value: profile?.taxRegistrationNumber ?? none },
              { label: t('sellerVerification.field.eori'), value: profile?.eoriNumber ?? none },
              { label: t('sellerVerification.field.website'), value: profile?.websiteUrl ?? none },
              { label: t('sellerVerification.field.representative'), value: profile?.representativeName ?? none },
              { label: t('sellerVerification.field.representativeEmail'), value: profile?.representativeEmail ?? none },
              { label: t('sellerVerification.field.supportEmail'), value: profile?.supportEmail ?? none },
              {
                label: t('sellerVerification.field.address'),
                value:
                  profile === null || profile.registeredAddressLine1 === null
                    ? none
                    : [profile.registeredAddressLine1, profile.registeredAddressLine2, profile.registeredCity, profile.registeredPostcode, profile.registeredCountry]
                        .filter((part): part is string => part !== null && part !== '')
                        .join(', '),
              },
              { label: t('sellerVerification.field.description'), value: seller.description ?? none },
            ]}
          />
        </Card>

        <DocumentsCard sellerAccountId={seller.id} documents={seller.documents} canVerify={canVerify} />

        <KybReviewPanel sellerAccountId={seller.id} legalName={seller.legalName} kyb={{ ...seller.kyb, readiness: detail.readiness }} />

        <TurnoverPanel sellerAccountId={seller.id} review={detail.turnover} />

        <Card title={t('sellerVerification.historyCard')} description={t('sellerVerification.historyHint')} bodyClassName="px-5 py-4">
          <HistoryList
            entries={[...seller.verification.history].reverse().map((entry) => ({
              kind: entry.action,
              at: entry.at,
              summary: entry.summary ?? entry.action,
              actorLabel: actorText(t, entry),
            }))}
          />
        </Card>
      </div>

      {deciding !== null && (
        <DecisionDialog
          detail={detail}
          decision={deciding}
          onClose={() => {
            setDeciding(null);
          }}
        />
      )}
    </>
  );
}

function actorText(t: (key: TranslationKey, options?: Record<string, unknown>) => string, entry: VerificationHistoryEntry): string {
  const who = t(`sellerVerification.actor.${entry.actorType}` as TranslationKey);
  return entry.actorLabel === null || entry.actorLabel === '' ? who : `${who} · ${entry.actorLabel}`;
}

function DecidedBy({ entry }: { entry: VerificationHistoryEntry | null }): React.JSX.Element {
  const { t } = useI18n();
  if (entry === null) return <span className="text-ink-muted">{t('sellerVerification.notDecided')}</span>;
  return (
    <span>
      {actorText(t, entry)}
      <span className="block text-xs text-ink-muted">{formatDateTime(entry.at)}</span>
    </span>
  );
}

/** The seller's words and the team's own note, never styled alike. */
function MessageBox({ kind, text }: { kind: 'seller' | 'internal'; text: string | null }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div
      className={
        kind === 'seller'
          ? 'rounded-md border border-accent/30 bg-accent-soft px-3 py-2.5'
          : 'rounded-md border border-dashed border-border-strong bg-surface-sunken px-3 py-2.5'
      }
    >
      <p className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
        {kind === 'seller' ? t('case.sellerMessage') : t('case.internalNote')}
      </p>
      <p className="mt-0.5 text-xs text-ink-muted">{kind === 'seller' ? t('case.sellerMessageHint') : t('case.internalNoteHint')}</p>
      <p className="mt-1.5 whitespace-pre-line text-sm text-ink">{text ?? t('common.none')}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

const DOCUMENT_TONE = { PENDING: 'warning', APPROVED: 'success', REJECTED: 'danger' } as const;

function DocumentsCard({
  sellerAccountId,
  documents,
  canVerify,
}: {
  sellerAccountId: string;
  documents: SellerDocument[];
  canVerify: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const [refusing, setRefusing] = useState<SellerDocument | null>(null);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);

  const decide = useConsoleMutation({
    mutationFn: (variables: { id: string; decision: 'APPROVED' | 'REJECTED'; why: string | null }, key) =>
      decideDocument(variables.id, { decision: variables.decision, reason: variables.why }, key),
    invalidate: [verificationKeys.detail(sellerAccountId)],
    successMessage: (_result, variables) =>
      variables.decision === 'APPROVED' ? t('sellerVerification.documentAccepted') : t('sellerVerification.documentRefused'),
    onSuccess: () => {
      setRefusing(null);
      setReason('');
      setTried(false);
    },
  });

  const reasonError = tried && reason.trim().length < 3 ? t('sellerVerification.reasonRequired') : undefined;

  return (
    <Card title={t('sellerVerification.documentsCard')} description={t('sellerVerification.documentsHint')}>
      {documents.length === 0 ? (
        <p className="px-5 py-4 text-sm text-ink-muted">{t('sellerVerification.noDocuments')}</p>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {documents.map((document) => (
            <li key={document.id} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm font-medium text-ink">{documentKindLabel(document.kind)}</p>
                <p className="break-words text-xs text-ink-muted">
                  {document.originalFileName} · {formatDateTime(document.createdAt)}
                  {document.expiresOn !== null && ` · ${t('sellerVerification.expires', { date: formatDateTime(document.expiresOn) })}`}
                </p>
                {document.status === 'REJECTED' && document.rejectedReason !== null && (
                  <p className="mt-1 text-xs text-danger">{document.rejectedReason}</p>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={DOCUMENT_TONE[document.status]}>{t(`sellerVerification.documentStatus.${document.status}` as TranslationKey)}</Badge>
                {document.isDownloadable && (
                  <DownloadButton path={documentFilePath(document.id)} fileName={document.originalFileName} label={t('common.open')} />
                )}
                {canVerify && document.status !== 'APPROVED' && (
                  <Button
                    size="sm"
                    variant="primary"
                    isLoading={decide.isPending && decide.variables.id === document.id && decide.variables.decision === 'APPROVED'}
                    onClick={() => {
                      decide.mutate({ id: document.id, decision: 'APPROVED', why: null });
                    }}
                  >
                    {t('sellerVerification.accept')}
                  </Button>
                )}
                {canVerify && document.status !== 'REJECTED' && (
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => {
                      setRefusing(document);
                    }}
                  >
                    {t('sellerVerification.refuse')}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {decide.isError && refusing === null && (
        <div className="px-5 pb-4">
          <MutationError error={decide.error} />
        </div>
      )}

      {refusing !== null && (
        <Modal
          isOpen
          onClose={() => {
            setRefusing(null);
          }}
          title={t('sellerVerification.refuseTitle')}
          description={refusing.originalFileName}
          footer={
            <>
              <Button
                onClick={() => {
                  setRefusing(null);
                }}
                disabled={decide.isPending}
              >
                {t('modal.cancel')}
              </Button>
              <Button
                variant="danger"
                isLoading={decide.isPending}
                onClick={() => {
                  setTried(true);
                  if (reason.trim().length < 3) return;
                  decide.mutate({ id: refusing.id, decision: 'REJECTED', why: reason.trim() });
                }}
              >
                {t('sellerVerification.refuse')}
              </Button>
            </>
          }
        >
          <div className="space-y-3">
            <Field label={t('case.sellerMessage')} hint={t('sellerVerification.refuseHint')} required error={reasonError}>
              {({ inputId, describedBy }) => (
                <Textarea
                  id={inputId}
                  aria-describedby={describedBy}
                  invalid={reasonError !== undefined}
                  maxLength={2000}
                  value={reason}
                  onChange={(event) => {
                    setReason(event.target.value);
                  }}
                />
              )}
            </Field>
            {decide.isError && <MutationError error={decide.error} />}
          </div>
        </Modal>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

function DecisionDialog({
  detail,
  decision,
  onClose,
}: {
  detail: SellerVerificationDetail;
  decision: VerificationDecisionStatus;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const seller = detail.application;
  const needsReason = NEEDS_REASON.has(decision);
  const [reason, setReason] = useState('');
  const [internalNote, setInternalNote] = useState(seller.internalNotes ?? '');
  const [resubmissionAllowed, setResubmissionAllowed] = useState(true);
  const [tried, setTried] = useState(false);

  const mutation = useConsoleMutation({
    mutationFn: (_: undefined, key) =>
      decideVerification(
        seller.id,
        {
          status: decision,
          reason: reason.trim() === '' ? null : reason.trim(),
          internalNote: internalNote.trim() === '' ? null : internalNote.trim(),
          ...(decision === 'REJECTED' ? { resubmissionAllowed } : {}),
          expectedVersion: seller.version,
        },
        key,
      ),
    invalidate: [verificationKeys.all],
    successMessage: t('sellerVerification.decided'),
    onSuccess: onClose,
  });

  const reasonError = needsReason && tried && reason.trim().length < 3 ? t('sellerVerification.reasonRequired') : undefined;

  return (
    <Modal
      isOpen
      onClose={onClose}
      size="lg"
      title={t(DECISION_LABEL[decision])}
      description={t(DECISION_EXPLAIN[decision])}
      footer={
        <>
          <Button onClick={onClose} disabled={mutation.isPending}>
            {t('modal.cancel')}
          </Button>
          <Button
            variant={decision === 'REJECTED' ? 'danger' : 'primary'}
            isLoading={mutation.isPending}
            onClick={() => {
              setTried(true);
              if (needsReason && reason.trim().length < 3) return;
              mutation.mutate(undefined);
            }}
          >
            {t(DECISION_LABEL[decision])}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {decision === 'APPROVED' && !detail.readiness.ready && (
          <Callout tone="warning" title={t('sellerVerification.notReadyTitle')}>
            {t('sellerVerification.notReadyBody', { gaps: String(detail.readiness.missing.length) })}
          </Callout>
        )}
        {decision !== 'UNDER_REVIEW' && (
          <div className="rounded-md border border-accent/30 bg-accent-soft p-3">
            <Field label={t('case.sellerMessage')} hint={t('case.sellerMessageHint')} required={needsReason} error={reasonError}>
              {({ inputId, describedBy }) => (
                <Textarea
                  id={inputId}
                  aria-describedby={describedBy}
                  invalid={reasonError !== undefined}
                  value={reason}
                  maxLength={4000}
                  onChange={(event) => {
                    setReason(event.target.value);
                  }}
                />
              )}
            </Field>
          </div>
        )}
        <div className="rounded-md border border-dashed border-border-strong bg-surface-sunken p-3">
          <Field label={t('case.internalNote')} hint={t('case.internalNoteHint')}>
            {({ inputId, describedBy }) => (
              <Textarea
                id={inputId}
                aria-describedby={describedBy}
                value={internalNote}
                maxLength={4000}
                onChange={(event) => {
                  setInternalNote(event.target.value);
                }}
              />
            )}
          </Field>
        </div>
        {decision === 'REJECTED' && (
          <CheckboxField
            boxed
            checked={resubmissionAllowed}
            onChange={(event) => {
              setResubmissionAllowed(event.target.checked);
            }}
            label={t('sellerVerification.allowResubmission')}
            description={t('sellerVerification.allowResubmissionHint')}
          />
        )}
        {mutation.isError && <MutationError error={mutation.error} title={t('sellerVerification.refusedTitle')} />}
      </div>
    </Modal>
  );
}

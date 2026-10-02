/**
 * Seller Hub -> one request for quotation this seller was asked to answer.
 *
 * The requirement as it stands (and every earlier version, with what
 * changed), the buyer's files, this seller's own thread with the buyer, and
 * Decline. Nothing about any other seller is on this page, because the
 * server never sends it.
 */
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ConfirmDialog } from '@/components/Modal';
import {
  AttachmentList,
  InvitationStatusBadge,
  RequirementDetails,
  RfqStatusBadge,
  RfqTimeline,
} from '@/components/rfq/RfqParts';
import { RfqThread } from '@/components/rfq/RfqThread';
import { NegotiationPanel } from '@/components/rfq/NegotiationPanel';
import { SamplesPanel } from '@/components/rfq/SamplesPanel';
import { QuoteForm } from '@/components/rfq/QuoteForm';
import { fetchSellerQuote } from '@/lib/rfq-quote';
import { useToast } from '@/components/toast-context';
import { Tabs } from '@/components/ui/Tabs';
import { Button, Card, ErrorState, LoadingState, PageHeader, Select, Textarea } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { rfqAttachmentUrl } from '@/lib/rfq';
import { formatUtc } from '@/lib/rfq-format';
import {
  assignSellerRfq,
  declineSellerRfq,
  fetchRfqAssignees,
  fetchSellerRfq,
  setSellerRfqHidden,
  type SellerRfq,
} from '@/lib/rfq-seller';

/** This seller's quote: the form before it quoted, then every offer version. */
function SellerQuotePanel({ rfq }: { rfq: SellerRfq }): React.JSX.Element {
  const { t } = useI18n();
  const query = useQuery({ queryKey: ['seller', 'rfq-quote', rfq.id], queryFn: () => fetchSellerQuote(rfq.id) });
  if (query.isPending) return <LoadingState label={t('rfq.quote.loading')} />;
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
  const quote = query.data;
  if (quote === null) {
    return (
      <Card bodyClassName="px-6 py-5">
        {rfq.actions.canQuote ? (
          <QuoteForm rfqId={rfq.id} requirement={rfq.requirement} filesAvailable={rfq.attachmentPolicy.available} />
        ) : (
          <p className="text-sm text-ink-muted">{t('rfq.quote.cannotQuote')}</p>
        )}
      </Card>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-ink">{t('rfq.quote.yours', { status: t(`rfq.quoteStatus.${quote.status}` as TranslationKey) })}</p>
      <NegotiationPanel quote={quote} party="SUPPLIER" basePath={`/seller/rfqs/${rfq.id}/quote`} queryKey={['seller', 'rfq-quote', rfq.id]} />
    </div>
  );
}

type TabKey = 'requirement' | 'quote' | 'questions' | 'samples' | 'files' | 'timeline';

export function SellerRfqDetailPage(): React.JSX.Element {
  const { id = '' } = useParams<{ id: string }>();
  const { t } = useI18n();
  const query = useQuery({ queryKey: ['seller', 'rfq', id], queryFn: () => fetchSellerRfq(id) });
  if (query.isPending) return <LoadingState label={t('rfq.detail.loading')} />;
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
  return <SellerRfqWorkspace rfq={query.data} />;
}

function SellerRfqWorkspace({ rfq }: { rfq: SellerRfq }): React.JSX.Element {
  const { t, intlLocale } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<TabKey>('requirement');
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');

  const decline = useMutation({
    mutationFn: () => declineSellerRfq(rfq.id, reason.trim()),
    onSuccess: (next) => {
      queryClient.setQueryData(['seller', 'rfq', rfq.id], next);
      void queryClient.invalidateQueries({ queryKey: ['seller', 'rfqs'] });
      setDeclining(false);
      toast.success(t('sellerRfq.declined'));
    },
    onError: (error) => {
      toast.error(errorMessage(t, error));
    },
  });

  const buyerName = rfq.buyer.kind === 'COMPANY' ? rfq.buyer.companyName : t('sellerRfq.individualBuyer');
  const behind = rfq.invitation.notifiedVersion > 0 && rfq.currentRequirementVersion > 1;

  return (
    <>
      <PageHeader
        title={rfq.requirement.title}
        description={`${rfq.reference} · ${buyerName}`}
        actions={
          <>
            <RfqStatusBadge status={rfq.status} />
            <InvitationStatusBadge status={rfq.invitation.status} />
            {rfq.actions.canDecline && (
              <Button
                variant="ghost"
                onClick={() => {
                  setDeclining(true);
                }}
              >
                {t('sellerRfq.decline')}
              </Button>
            )}
          </>
        }
      />
      <p className={rfq.isPastDeadline ? 'mb-4 text-sm font-medium text-warning' : 'mb-4 text-sm text-ink'}>
        {rfq.isPastDeadline
          ? t('sellerRfq.deadlinePassed', { deadline: formatUtc(rfq.requirement.responseDeadline, intlLocale) })
          : t('sellerRfq.deadline', { deadline: formatUtc(rfq.requirement.responseDeadline, intlLocale) })}
      </p>
      {behind && (
        <p role="status" className="mb-4 rounded-md border border-brand/30 bg-brand/5 px-4 py-3 text-sm text-ink">
          {t('sellerRfq.amended', { version: String(rfq.currentRequirementVersion) })}
        </p>
      )}
      {rfq.invitation.declineReason !== null && (
        <p className="mb-4 text-sm text-ink-muted">{t('sellerRfq.youDeclined', { reason: rfq.invitation.declineReason })}</p>
      )}
      <InboxPanel rfq={rfq} />

      <Tabs
        tabs={[
          { key: 'requirement', label: t('rfq.detail.tab.requirement') },
          { key: 'quote', label: t('sellerRfq.tab.quote') },
          { key: 'questions', label: t('sellerRfq.tab.questions') },
          { key: 'samples', label: t('rfq.sample.tab') },
          { key: 'files', label: t('rfq.detail.tab.files') },
          { key: 'timeline', label: t('rfq.detail.tab.timeline') },
        ]}
        value={tab}
        onChange={setTab}
        label={t('rfq.detail.tabsLabel')}
      >
        {tab === 'requirement' && (
          <div className="space-y-4">
            <Card bodyClassName="px-6 py-3">
              <RequirementDetails requirement={rfq.requirement} categoryName={rfq.category?.name ?? null} />
            </Card>
            <Card title={t('rfq.detail.versionsTitle')} bodyClassName="px-6 py-4">
              <ol className="space-y-2">
                {rfq.versions.map((version) => (
                  <li key={version.versionNumber} className="text-sm text-ink">
                    <span className="font-medium">{t('rfq.detail.versionN', { version: String(version.versionNumber) })}</span>
                    <span className="text-ink-muted"> · {formatUtc(version.createdAt, intlLocale)}</span>
                    {version.changedFields.length > 0 && (
                      <span className="block text-xs text-ink-muted">
                        {t('rfq.detail.changed', {
                          fields: version.changedFields
                            .map((field) => t(`rfq.fieldName.${field}` as TranslationKey, { defaultValue: field }))
                            .join(', '),
                        })}
                      </span>
                    )}
                    {version.changeSummary !== null && <span className="block text-xs">{version.changeSummary}</span>}
                  </li>
                ))}
              </ol>
            </Card>
          </div>
        )}
        {tab === 'quote' && <SellerQuotePanel rfq={rfq} />}
        {tab === 'samples' && <SamplesPanel party="SUPPLIER" rfqId={rfq.id} filesAvailable={rfq.attachmentPolicy.available} />}
        {tab === 'questions' && (
          <Card bodyClassName="px-6 py-5">
            <RfqThread
              path={`/seller/rfqs/${rfq.id}/messages`}
              canWrite={rfq.actions.canAsk}
              otherPartyName={buyerName}
              audience="seller"
              attachableFiles={rfq.attachments.filter(
                (file) =>
                  (file.purpose === 'REQUIREMENT' && file.requirementVersion !== null) ||
                  (file.purpose !== 'REQUIREMENT' && file.uploadedBy === 'SUPPLIER'),
              )}
              attachmentHref={(attachmentId) => rfqAttachmentUrl('/seller/rfqs', rfq.id, attachmentId)}
            />
          </Card>
        )}
        {tab === 'files' && (
          <Card bodyClassName="px-6 py-5">
            <AttachmentList
              attachments={rfq.attachments}
              hrefFor={(attachment) => rfqAttachmentUrl('/seller/rfqs', rfq.id, attachment.id)}
            />
          </Card>
        )}
        {tab === 'timeline' && (
          <Card bodyClassName="px-6 py-5">
            <RfqTimeline events={rfq.timeline.map((event) => ({ ...event, supplierName: null }))} />
          </Card>
        )}
      </Tabs>

      <ConfirmDialog
        isOpen={declining}
        onClose={() => {
          setDeclining(false);
        }}
        onConfirm={() => {
          if (reason.trim().length >= 3) decline.mutate();
        }}
        title={t('sellerRfq.declineTitle')}
        body={
          <label className="block text-sm font-medium text-ink">
            {t('sellerRfq.declineReason')}
            <Textarea
              className="mt-1"
              rows={3}
              maxLength={1000}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
          </label>
        }
        confirmLabel={t('sellerRfq.decline')}
        isDangerous
        isWorking={decline.isPending}
      />
    </>
  );
}

/**
 * The seller's own handling of this request (JOURNEY-030): how well they fit
 * it and why, who is asking, who on the team owns the answer, and hiding it
 * from the inbox. None of it is visible to the buyer.
 */
function InboxPanel({ rfq }: { rfq: SellerRfq }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const assignees = useQuery({ queryKey: ['seller', 'rfqs', 'assignees'], queryFn: fetchRfqAssignees });

  const onDone = (next: SellerRfq, message: string): void => {
    queryClient.setQueryData(['seller', 'rfq', rfq.id], next);
    void queryClient.invalidateQueries({ queryKey: ['seller', 'rfqs'] });
    toast.success(message);
  };
  const assign = useMutation({
    mutationFn: (memberId: string | null) => assignSellerRfq(rfq.id, memberId),
    onSuccess: (next) => {
      onDone(next, t('sellerRfq.inbox.assignedDone'));
    },
    onError: (error) => {
      toast.error(errorMessage(t, error, t('sellerRfq.inbox.failed')));
    },
  });
  const hide = useMutation({
    mutationFn: () => setSellerRfqHidden(rfq.id, !rfq.hidden),
    onSuccess: (next) => {
      onDone(next, next.hidden ? t('sellerRfq.inbox.hiddenDone') : t('sellerRfq.inbox.unhiddenDone'));
    },
    onError: (error) => {
      toast.error(errorMessage(t, error, t('sellerRfq.inbox.failed')));
    },
  });

  const { qualification } = rfq;
  return (
    <Card title={t('sellerRfq.inbox.panelTitle')} bodyClassName="px-6 py-4" className="mb-4">
      <div className="grid gap-4 text-sm sm:grid-cols-3">
        <div>
          <p className="text-xxs uppercase tracking-wider text-ink-subtle">{t('sellerRfq.inbox.fit')}</p>
          <p className="mt-1 font-semibold text-ink">{t('sellerRfq.inbox.score', { score: String(qualification.score) })}</p>
          <ul className="mt-1 space-y-0.5 text-xs text-ink-muted">
            {qualification.reasons.map((reason) => (
              <li key={reason}>{t(`sellerRfq.reason.${reason}` as TranslationKey)}</li>
            ))}
            {qualification.flags.map((flag) => (
              <li key={flag} className="text-warning">
                {t(`sellerRfq.flag.${flag}` as TranslationKey)}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="text-xxs uppercase tracking-wider text-ink-subtle">{t('sellerRfq.inbox.buyer')}</p>
          <p className="mt-1 text-ink">{t(`sellerRfq.buyerVerification.${rfq.buyerVerification}` as TranslationKey)}</p>
        </div>
        <div className="space-y-2">
          <label className="block text-xxs uppercase tracking-wider text-ink-subtle">
            {t('sellerRfq.inbox.owner')}
            <Select
              className="mt-1 normal-case tracking-normal"
              value={rfq.assignedMember?.id ?? ''}
              disabled={assign.isPending}
              onChange={(event) => {
                assign.mutate(event.currentTarget.value === '' ? null : event.currentTarget.value);
              }}
            >
              <option value="">{t('sellerRfq.inbox.noOwner')}</option>
              {(assignees.data ?? []).map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </Select>
          </label>
          <Button
            size="sm"
            variant="ghost"
            disabled={hide.isPending}
            onClick={() => {
              hide.mutate();
            }}
          >
            {rfq.hidden ? t('sellerRfq.inbox.unhide') : t('sellerRfq.inbox.hide')}
          </Button>
        </div>
      </div>
    </Card>
  );
}

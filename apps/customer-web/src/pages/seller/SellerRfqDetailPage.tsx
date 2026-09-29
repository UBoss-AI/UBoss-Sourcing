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
import { useToast } from '@/components/toast-context';
import { Tabs } from '@/components/ui/Tabs';
import { Button, Card, ErrorState, LoadingState, PageHeader, Textarea } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { rfqAttachmentUrl } from '@/lib/rfq';
import { formatUtc } from '@/lib/rfq-format';
import { declineSellerRfq, fetchSellerRfq, type SellerRfq } from '@/lib/rfq-seller';

type TabKey = 'requirement' | 'questions' | 'files' | 'timeline';

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

      <Tabs
        tabs={[
          { key: 'requirement', label: t('rfq.detail.tab.requirement') },
          { key: 'questions', label: t('sellerRfq.tab.questions') },
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
        {tab === 'questions' && (
          <Card bodyClassName="px-6 py-5">
            <RfqThread path={`/seller/rfqs/${rfq.id}/messages`} canWrite={rfq.actions.canAsk} otherPartyName={buyerName} />
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

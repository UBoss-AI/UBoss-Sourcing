/**
 * One request for quotation, as its buyer works it: `/account/rfqs/:id`.
 *
 * Tabs, because each part is read on its own: the requirement and its
 * versions, the sellers asked and where each stands, the files, and what
 * happened when. The deadline is shown in UTC everywhere.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStorefront } from '@/app/storefront-context';
import { ConfirmDialog } from '@/components/Modal';
import {
  AttachmentList,
  InvitationStatusBadge,
  RequirementDetails,
  RfqStatusBadge,
  RfqTimeline,
  formatUtc,
} from '@/components/rfq/RfqParts';
import { SupplierPicker } from '@/components/rfq/SupplierPicker';
import { useToast } from '@/components/toast-context';
import { Tabs } from '@/components/ui/Tabs';
import { Button, ButtonLink, Card, ErrorState, LoadingState, PageHeader, Textarea } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { endRfq, fetchRfq, inviteRfqSupplier, rfqAttachmentUrl, type BuyerRfq } from '@/lib/rfq';
import { useDocumentMeta } from '@/lib/useDocumentMeta';

type TabKey = 'requirement' | 'suppliers' | 'files' | 'timeline';

export function RfqDetailPage(): React.JSX.Element {
  const { id = '' } = useParams<{ id: string }>();
  const { t } = useI18n();
  const { business } = useStorefront();
  const query = useQuery({ queryKey: ['rfq', id], queryFn: () => fetchRfq(id) });
  useDocumentMeta({ title: query.data?.reference ?? t('rfq.detail.title'), noIndex: true }, business.displayName);

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
  return <RfqWorkspace rfq={query.data} />;
}

function RfqWorkspace({ rfq }: { rfq: BuyerRfq }): React.JSX.Element {
  const { t, intlLocale } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<TabKey>('requirement');
  const [ending, setEnding] = useState<'cancel' | 'close' | null>(null);
  const [reason, setReason] = useState('');

  const refresh = (next: BuyerRfq): void => {
    queryClient.setQueryData(['rfq', next.id], next);
    void queryClient.invalidateQueries({ queryKey: ['rfqs'] });
  };

  const end = useMutation({
    mutationFn: (action: 'cancel' | 'close') =>
      endRfq(rfq.id, action, rfq.version, reason.trim().length === 0 ? null : reason.trim()),
    onSuccess: (next) => {
      refresh(next);
      setEnding(null);
      setReason('');
      toast.success(next.status === 'CANCELLED' ? t('rfq.detail.cancelled') : t('rfq.detail.closed'));
    },
    onError: (error) => {
      toast.error(errorMessage(t, error));
    },
  });

  const invite = useMutation({
    mutationFn: (sellerAccountId: string) => inviteRfqSupplier(rfq.id, sellerAccountId),
    onSuccess: (next) => {
      refresh(next);
      toast.success(t('rfq.detail.invited'));
    },
    onError: (error) => {
      toast.error(errorMessage(t, error));
    },
  });

  const tabs = [
    { key: 'requirement' as const, label: t('rfq.detail.tab.requirement') },
    { key: 'suppliers' as const, label: t('rfq.detail.tab.suppliers', { invited: String(rfq.invitations.length) }) },
    { key: 'files' as const, label: t('rfq.detail.tab.files') },
    { key: 'timeline' as const, label: t('rfq.detail.tab.timeline') },
  ];

  return (
    <>
      <PageHeader
        title={rfq.requirement.title.length > 0 ? rfq.requirement.title : t('rfq.untitled')}
        description={`${rfq.reference}${rfq.owner.kind === 'COMPANY' ? ` · ${rfq.owner.companyName}` : ''}`}
        actions={
          <>
            <RfqStatusBadge status={rfq.status} />
            {rfq.actions.canEdit && <ButtonLink to={`/account/rfqs/${rfq.id}/edit`}>{t('rfq.detail.editDraft')}</ButtonLink>}
            {rfq.actions.canClose && (
              <Button
                onClick={() => {
                  setEnding('close');
                }}
              >
                {t('rfq.detail.close')}
              </Button>
            )}
            {rfq.actions.canCancel && (
              <Button
                variant="ghost"
                onClick={() => {
                  setEnding('cancel');
                }}
              >
                {t('rfq.detail.cancel')}
              </Button>
            )}
          </>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Card bodyClassName="px-4 py-3">
          <p className="text-xxs uppercase tracking-wider text-ink-subtle">{t('rfq.field.deadline')}</p>
          <p className={rfq.isPastDeadline && rfq.status === 'OPEN' ? 'text-sm font-medium text-warning' : 'text-sm font-medium text-ink'}>
            {formatUtc(rfq.requirement.responseDeadline, intlLocale)}
          </p>
          {rfq.isPastDeadline && rfq.status === 'OPEN' && <p className="text-xs text-warning">{t('rfq.detail.deadlinePassed')}</p>}
        </Card>
        <Card bodyClassName="px-4 py-3">
          <p className="text-xxs uppercase tracking-wider text-ink-subtle">{t('rfq.detail.requirementVersion')}</p>
          <p className="text-sm font-medium text-ink">
            {rfq.currentRequirementVersion === 0 ? t('rfq.status.DRAFT') : t('rfq.detail.versionN', { version: String(rfq.currentRequirementVersion) })}
          </p>
        </Card>
        <Card bodyClassName="px-4 py-3">
          <p className="text-xxs uppercase tracking-wider text-ink-subtle">{t('rfq.list.responses')}</p>
          <p className="text-sm font-medium text-ink">
            {t('rfq.list.respondedOf', {
              responded: String(rfq.invitations.filter((invitation) => ['QUOTED', 'DECLINED', 'WITHDRAWN'].includes(invitation.status)).length),
              invited: String(rfq.invitations.length),
            })}
          </p>
        </Card>
      </div>

      {rfq.statusReason !== null && (
        <p className="mb-4 rounded-md border border-border-subtle bg-surface-sunken px-4 py-3 text-sm text-ink">
          {t('rfq.detail.reason', { reason: rfq.statusReason })}
        </p>
      )}

      <Tabs tabs={tabs} value={tab} onChange={setTab} label={t('rfq.detail.tabsLabel')}>
        {tab === 'requirement' && (
          <div className="space-y-4">
            <Card bodyClassName="px-6 py-3">
              <RequirementDetails requirement={rfq.requirement} categoryName={rfq.category?.name ?? null} />
            </Card>
            {rfq.versions.length > 0 && (
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
                      {version.changeSummary !== null && <span className="block text-xs text-ink">{version.changeSummary}</span>}
                    </li>
                  ))}
                </ol>
              </Card>
            )}
          </div>
        )}

        {tab === 'suppliers' && (
          <Card bodyClassName="space-y-4 px-6 py-5">
            {rfq.status !== 'DRAFT' && rfq.matchOutcome === 'NO_MATCH' && (
              <p role="status" className="rounded-md border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-ink">
                {t('rfq.detail.noMatch')}
              </p>
            )}
            {rfq.invitations.length === 0 ? (
              <p className="text-sm text-ink-muted">{t('rfq.detail.noSuppliers')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[32rem] text-left text-sm">
                  <caption className="sr-only">{t('rfq.detail.suppliersCaption')}</caption>
                  <thead>
                    <tr className="border-b border-border-subtle text-xs text-ink-muted">
                      <th scope="col" className="py-2 pr-4 font-medium">{t('rfq.detail.col.supplier')}</th>
                      <th scope="col" className="py-2 pr-4 font-medium">{t('rfq.detail.col.how')}</th>
                      <th scope="col" className="py-2 pr-4 font-medium">{t('rfq.detail.col.status')}</th>
                      <th scope="col" className="py-2 font-medium">{t('rfq.detail.col.updated')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rfq.invitations.map((invitation) => (
                      <tr key={invitation.id} className="border-b border-border-subtle last:border-0">
                        <th scope="row" className="py-2 pr-4 font-medium text-ink">
                          {invitation.supplier.displayName}
                          {invitation.supplier.verifiedAt !== null && (
                            <span className="ml-2 text-xs font-normal text-success">{t('rfq.supplier.verified')}</span>
                          )}
                        </th>
                        <td className="py-2 pr-4 text-ink-muted">{t(`rfq.detail.source.${invitation.source}` as TranslationKey)}</td>
                        <td className="py-2 pr-4">
                          <InvitationStatusBadge status={invitation.status} />
                          {invitation.declineReason !== null && (
                            <span className="block text-xs text-ink-muted">{invitation.declineReason}</span>
                          )}
                        </td>
                        <td className="py-2 text-ink-muted">{formatUtc(invitation.respondedAt ?? invitation.viewedAt ?? invitation.invitedAt, intlLocale)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {rfq.actions.canInvite && (
              <div className="border-t border-border-subtle pt-4">
                <h2 className="text-title-xs text-ink">{t('rfq.detail.inviteTitle')}</h2>
                <SupplierPicker
                  categoryId={rfq.requirement.categoryId}
                  country={rfq.requirement.destinationCountry}
                  picked={rfq.invitations.map((invitation) => invitation.supplier)}
                  pickLabel={t('rfq.detail.invite')}
                  onPick={(supplier) => {
                    invite.mutate(supplier.sellerAccountId);
                  }}
                />
              </div>
            )}
          </Card>
        )}

        {tab === 'files' && (
          <Card bodyClassName="space-y-3 px-6 py-5">
            <AttachmentList attachments={rfq.attachments} hrefFor={(attachment) => rfqAttachmentUrl('/rfqs', rfq.id, attachment.id)} />
            {rfq.status === 'DRAFT' && (
              <Link to={`/account/rfqs/${rfq.id}/edit`} className="text-sm font-medium text-brand hover:underline">
                {t('rfq.detail.addFilesOnDraft')}
              </Link>
            )}
          </Card>
        )}

        {tab === 'timeline' && (
          <Card bodyClassName="px-6 py-5">
            <RfqTimeline events={rfq.timeline} />
          </Card>
        )}
      </Tabs>

      <ConfirmDialog
        isOpen={ending !== null}
        onClose={() => {
          setEnding(null);
        }}
        onConfirm={() => {
          if (ending !== null) end.mutate(ending);
        }}
        title={ending === 'close' ? t('rfq.detail.closeTitle') : t('rfq.detail.cancelTitle')}
        body={
          <div className="space-y-3">
            <p>{ending === 'close' ? t('rfq.detail.closeBody') : t('rfq.detail.cancelBody')}</p>
            <label className="block text-sm font-medium text-ink">
              {t('rfq.detail.reasonLabel')}
              <Textarea
                className="mt-1"
                rows={2}
                maxLength={1000}
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                }}
              />
            </label>
          </div>
        }
        confirmLabel={ending === 'close' ? t('rfq.detail.close') : t('rfq.detail.cancel')}
        isDangerous={ending === 'cancel'}
        isWorking={end.isPending}
      />
    </>
  );
}

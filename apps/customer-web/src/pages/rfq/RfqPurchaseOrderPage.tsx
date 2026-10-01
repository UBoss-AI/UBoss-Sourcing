import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import { Button, Card, ErrorState, Input, LoadingState, PageHeader, Textarea } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { formatMoneyMinor } from '@/lib/format';
import {
  decideRfqPurchaseOrder,
  fetchRfqPoReview,
  submitRfqPurchaseOrder,
  type RfqPoContract,
  type RfqPoPreview,
  type RfqPurchaseOrder,
} from '@/lib/rfq-purchase-order';

function Value({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-subtle">{label}</dt>
      <dd className="mt-1 whitespace-pre-wrap break-words text-sm text-ink">{children}</dd>
    </div>
  );
}

function ContractReview({ contract, amounts, buyerSku }: {
  contract: RfqPoContract;
  amounts: RfqPoPreview['amounts'];
  buyerSku: string | null;
}): React.JSX.Element {
  const { t } = useI18n();
  const missing = t('rfq.notProvided');
  return (
    <div className="space-y-4">
      <Card title={t('rfq.po.commercialTitle')} bodyClassName="px-5 py-5">
        <dl className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <Value label={t('rfq.po.supplier')}>{contract.supplier.name}</Value>
          <Value label={t('rfq.po.item')}>{contract.item.title}</Value>
          <Value label={t('rfq.po.buyerSku')}>{buyerSku ?? missing}</Value>
          <Value label={t('rfq.field.quantity')}>{contract.item.quantity} {contract.item.unitOfMeasure ?? ''}</Value>
          <Value label={t('rfq.po.unitPrice')}>{formatMoneyMinor(contract.commercial.applicableUnitPriceMinor, contract.commercial.currency)}</Value>
          <Value label={t('rfq.po.goodsTotal')}>{formatMoneyMinor(amounts.goods.minor, amounts.currency)}</Value>
          <Value label={t('rfq.po.tooling')}>{formatMoneyMinor(amounts.tooling.minor, amounts.currency)}</Value>
          <Value label={t('rfq.po.shipping')}>{formatMoneyMinor(amounts.shipping.minor, amounts.currency)}</Value>
          <Value label={t('rfq.po.total')}>{formatMoneyMinor(amounts.grand.minor, amounts.currency)}</Value>
          <Value label={t('rfq.field.incoterm')}>{contract.delivery.incoterm ?? missing}{contract.delivery.incotermPlace === null ? '' : ` · ${contract.delivery.incotermPlace}`}</Value>
          <Value label={t('rfq.po.paymentTerms')}>{contract.commercial.paymentTerms ?? missing}</Value>
          <Value label={t('rfq.po.taxDisclosure')}>{contract.commercial.taxesDisclosure ?? missing}</Value>
        </dl>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t('rfq.po.specificationTitle')} bodyClassName="px-5 py-5">
          <dl className="space-y-4">
            <Value label={t('rfq.po.specification')}>{contract.item.specification ?? missing}</Value>
            {contract.item.specifications.map((specification) => (
              <Value key={specification.key} label={specification.key}>{specification.value}</Value>
            ))}
            <Value label={t('rfq.po.certifications')}>{contract.quality.certifications.length === 0 ? missing : contract.quality.certifications.join(', ')}</Value>
            <Value label={t('rfq.po.warranty')}>{contract.quality.warranty ?? missing}</Value>
            <Value label={t('rfq.compare.row.exportDocuments')}>
              {(contract.quality.exportDocuments ?? []).length === 0
                ? missing
                : (contract.quality.exportDocuments ?? []).map((code) => t(`rfq.exportDocument.${code}` as 'rfq.exportDocument.PACKING_LIST')).join(', ')}
            </Value>
          </dl>
        </Card>
        <Card title={t('rfq.po.deliveryTitle')} bodyClassName="px-5 py-5">
          <dl className="space-y-4">
            <Value label={t('rfq.po.destination')}>
              {[contract.delivery.destinationAddress, contract.delivery.destinationPort, contract.delivery.destinationCountry].filter(Boolean).join(', ') || missing}
            </Value>
            <Value label={t('rfq.po.shipWindow')}>{contract.delivery.targetDate ?? missing}</Value>
            <Value label={t('rfq.po.leadTime')}>{contract.delivery.leadTimeDays === null ? missing : t('rfq.po.days', { count: contract.delivery.leadTimeDays })}</Value>
            <Value label={t('rfq.po.inspection')}>{contract.quality.inspectionTerms ?? contract.quality.inspectionRequirement}</Value>
            <Value label={t('rfq.po.documents')}>
              {contract.documents.length === 0 ? missing : contract.documents.map((document) => document.fileName).join(', ')}
            </Value>
          </dl>
        </Card>
      </div>
    </div>
  );
}

function Status({ purchaseOrder }: { purchaseOrder: RfqPurchaseOrder }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <Card title={t('rfq.po.approvalTitle')} bodyClassName="space-y-4 px-5 py-5">
      <p role="status" className="inline-flex rounded-full bg-surface-sunken px-3 py-1 text-sm font-medium text-ink">
        {t(`rfq.po.status.${purchaseOrder.status}` as TranslationKey)}
      </p>
      {purchaseOrder.approvals.length === 0 ? (
        <p className="text-sm text-ink-muted">{t('rfq.po.noApprovalRequired')}</p>
      ) : (
        <ol className="space-y-2">
          {purchaseOrder.approvals.map((approval) => (
            <li key={approval.stage} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border-subtle px-3 py-2 text-sm">
              <span className="font-medium text-ink">{t(`rfq.po.stage.${approval.stage}` as TranslationKey)}</span>
              <span className="text-ink-muted">{t(`rfq.po.decision.${approval.decision}` as TranslationKey)}</span>
              {approval.reason !== null && <span className="w-full text-xs text-ink-muted">{approval.reason}</span>}
            </li>
          ))}
        </ol>
      )}
      <p className="break-all font-mono text-xs text-ink-muted">{t('rfq.po.contractHash', { hash: purchaseOrder.contractHash })}</p>
      <p className="text-xs text-ink-muted">
        {t('rfq.po.signedBy', { name: purchaseOrder.electronicAcceptance.signatureName, date: purchaseOrder.electronicAcceptance.acceptedAt })}
      </p>
    </Card>
  );
}

export function RfqPurchaseOrderPage(): React.JSX.Element {
  const { id = '' } = useParams<{ id: string }>();
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const queryKey = ['rfq', id, 'purchase-order'] as const;
  const query = useQuery({ queryKey, queryFn: () => fetchRfqPoReview(id) });
  const [buyerSku, setBuyerSku] = useState('');
  const [signatureName, setSignatureName] = useState('');
  const [signatureTitle, setSignatureTitle] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [decisionReason, setDecisionReason] = useState('');

  const submit = useMutation({
    mutationFn: (preview: RfqPoPreview) => submitRfqPurchaseOrder(id, {
      acceptedTermsHash: preview.acceptedTermsHash,
      eAccepted: true,
      signatureName: signatureName.trim(),
      signatureTitle: signatureTitle.trim() === '' ? null : signatureTitle.trim(),
      buyerSku: buyerSku.trim() === '' ? null : buyerSku.trim(),
    }),
    onSuccess: (purchaseOrder) => {
      queryClient.setQueryData(queryKey, { kind: 'PURCHASE_ORDER', purchaseOrder });
      toast.success(t('rfq.po.created'));
    },
    onError: (error) => { toast.error(errorMessage(t, error)); },
  });

  const decide = useMutation({
    mutationFn: ({ purchaseOrder, approved }: { purchaseOrder: RfqPurchaseOrder; approved: boolean }) =>
      decideRfqPurchaseOrder(id, {
        expectedVersion: purchaseOrder.version,
        approved,
        reason: decisionReason.trim() === '' ? null : decisionReason.trim(),
      }),
    onSuccess: (purchaseOrder) => {
      queryClient.setQueryData(queryKey, { kind: 'PURCHASE_ORDER', purchaseOrder });
      setDecisionReason('');
      toast.success(t('rfq.po.decisionSaved'));
    },
    onError: (error) => { toast.error(errorMessage(t, error)); },
  });

  if (query.isPending) return <LoadingState label={t('rfq.po.loading')} />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => { void query.refetch(); }} />;
  const review = query.data;
  const preview = review.kind === 'PREVIEW' ? review.preview : null;
  const purchaseOrder = review.kind === 'PURCHASE_ORDER' ? review.purchaseOrder : null;
  const contract = preview?.contract ?? purchaseOrder?.contract;
  const amounts = preview?.amounts ?? purchaseOrder?.amounts;
  if (contract === undefined || amounts === undefined) return <ErrorState error={new Error(t('rfq.po.loading'))} />;
  const shownSku = preview !== null ? (buyerSku.trim() || null) : (purchaseOrder?.buyerSku ?? null);

  return (
    <>
      <PageHeader
        title={purchaseOrder?.reference ?? t('rfq.po.title')}
        description={t('rfq.po.description', { reference: contract.rfq.reference })}
        actions={<Link to={`/account/rfqs/${id}`} className="text-sm font-medium text-brand hover:underline">{t('rfq.po.back')}</Link>}
      />
      <ContractReview contract={contract} amounts={amounts} buyerSku={shownSku} />

      {preview !== null ? (
        <Card title={t('rfq.po.acceptTitle')} bodyClassName="space-y-4 px-5 py-5" className="mt-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm font-medium text-ink">
              {t('rfq.po.buyerSku')}
              <Input className="mt-1" value={buyerSku} maxLength={80} onChange={(event) => { setBuyerSku(event.target.value); }} />
            </label>
            <label className="text-sm font-medium text-ink">
              {t('rfq.po.signatureName')}
              <Input className="mt-1" value={signatureName} required maxLength={160} onChange={(event) => { setSignatureName(event.target.value); }} />
            </label>
            <label className="text-sm font-medium text-ink sm:col-span-2">
              {t('rfq.po.signatureTitle')}
              <Input className="mt-1" value={signatureTitle} maxLength={160} onChange={(event) => { setSignatureTitle(event.target.value); }} />
            </label>
          </div>
          <label className="flex items-start gap-3 rounded-md border border-border-subtle p-3 text-sm text-ink">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-brand" checked={accepted} onChange={(event) => { setAccepted(event.target.checked); }} />
            <span className="min-w-0 break-all">{t('rfq.po.acceptStatement', { hash: preview.acceptedTermsHash })}</span>
          </label>
          <Button
            variant="primary"
            disabled={!accepted || signatureName.trim().length < 2 || submit.isPending}
            onClick={() => { submit.mutate(preview); }}
          >
            {submit.isPending ? t('rfq.po.submitting') : t('rfq.po.submit')}
          </Button>
        </Card>
      ) : (
        <div className="mt-4 space-y-4">
          {purchaseOrder !== null && <Status purchaseOrder={purchaseOrder} />}
          {purchaseOrder !== null && (purchaseOrder.actions.canApprove || purchaseOrder.actions.canReject) && (
            <Card title={t('rfq.po.decisionTitle')} bodyClassName="space-y-3 px-5 py-5">
              <label className="block text-sm font-medium text-ink">
                {t('rfq.po.decisionReason')}
                <Textarea className="mt-1" value={decisionReason} maxLength={1000} onChange={(event) => { setDecisionReason(event.target.value); }} />
              </label>
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" disabled={decide.isPending} onClick={() => { decide.mutate({ purchaseOrder, approved: true }); }}>{t('rfq.po.approve')}</Button>
                <Button disabled={decide.isPending || decisionReason.trim() === ''} onClick={() => { decide.mutate({ purchaseOrder, approved: false }); }}>{t('rfq.po.reject')}</Button>
              </div>
            </Card>
          )}
        </div>
      )}
    </>
  );
}

/**
 * One commission invoice: the preview, the calculation and where each figure
 * came from, what still blocks it, and the actions its status allows.
 *
 * What the screen is careful to say:
 *
 *   - **A draft is shown exactly as it would be issued.** The preview is the
 *     server's own PDF of the stored draft, and issuing sends that draft's
 *     hash back: if anything behind it moved since, the server refuses and the
 *     screen asks for a regenerate and a second look.
 *   - **Every figure has a source.** The fee and the tax come from the seller
 *     order's settlement, with its fee policy version and rate, shown beside
 *     the lines they produced.
 *   - **Issued means frozen.** An issued invoice offers downloads, credit notes
 *     and recording the seller's payment - never an edit.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { useSession } from '@/auth/session-context';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Callout, Card, DescriptionList, ErrorState, Field, Input, LoadingState, PageHeader, Select, Textarea } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { currencyExponent, formatDate, formatDateTime, formatMoney, majorToMinor } from '@/lib/format';
import type { Money } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import {
  CREDIT_REASONS,
  commissionApi,
  downloadCommissionDocument,
  newIdempotencyKey,
  previewUrl,
  type CommissionInvoiceDetail,
  type CreditBasis,
  type CreditReason,
  type Problem,
} from '@/lib/commission-invoices';
import { COLLECTION_TONE, STATUS_TONE, blockerText } from './commission-shared';

const ISSUE_KEYS = new Set([
  'TAX_RULE_UNVERIFIED',
  'TAX_WITHOUT_REGISTRATION',
  'ISSUER_TAX_ID_MISSING',
  'ISSUER_DETAIL_MISSING',
  'ISSUER_STATE_INVALID',
  'ISSUER_COUNTRY_MISMATCH',
  'ISSUER_GSTIN_STATE_MISMATCH',
  'SELLER_TAX_ID_MISSING',
  'SELLER_STATE_UNKNOWN',
  'SELLER_COUNTRY_MISSING',
  'SELLER_LEGAL_NAME_MISSING',
  'SELLER_ADDRESS_MISSING',
  'LUT_REQUIRED',
  'CURRENCY_MISMATCH',
]);

type Dialog = 'issue' | 'void' | 'credit' | 'collection' | null;

export function CommissionInvoiceDetailPage(): React.JSX.Element {
  const { id = '' } = useParams();
  const { t } = useI18n();
  const query = useQuery({ queryKey: ['admin', 'commission-invoice', id], queryFn: () => commissionApi.read(id) });

  if (query.isPending) return <LoadingState />;
  if (query.data === undefined) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  return <InvoiceView invoice={query.data} t={t} />;
}

function InvoiceView({ invoice, t }: { invoice: CommissionInvoiceDetail; t: ReturnType<typeof useI18n>['t'] }): React.JSX.Element {
  const toast = useToast();
  const client = useQueryClient();
  const { can } = useSession();
  const [dialog, setDialog] = useState<Dialog>(null);
  const key = ['admin', 'commission-invoice', invoice.id];

  function refreshed(next: CommissionInvoiceDetail): void {
    client.setQueryData(key, next);
    void client.invalidateQueries({ queryKey: ['admin', 'commission-invoices'] });
    void client.invalidateQueries({ queryKey: ['admin', 'order-commission'] });
  }
  const onError = (error: unknown) => {
    toast.error(errorMessage(t, error));
  };

  const regenerate = useMutation({
    mutationFn: () => commissionApi.regenerate(invoice.id),
    onSuccess: (next) => {
      refreshed(next);
      toast.success(t('commission.detail.regenerated'));
    },
    onError,
  });
  const issue = useMutation({
    mutationFn: () => commissionApi.issue(invoice.id, invoice.snapshotHash),
    onSuccess: (result) => {
      refreshed(result.invoice);
      setDialog(null);
      toast.success(t('commission.detail.issued', { number: result.invoice.number ?? '' }));
    },
    onError: (error: unknown) => {
      setDialog(null);
      onError(error);
      void client.invalidateQueries({ queryKey: key });
    },
  });
  const download = useMutation({
    mutationFn: ({ documentId, name }: { documentId: string; name: string }) => downloadCommissionDocument(documentId, name),
    onError,
  });

  const isDraft = invoice.status === 'DRAFT';
  const isIssued = ['ISSUED', 'PARTIALLY_CREDITED', 'FULLY_CREDITED'].includes(invoice.status);
  const problems = [...invoice.blockers.map((item) => ({ ...item, kind: 'blocker' as const })), ...invoice.issues.map((item) => ({ ...item, kind: 'issue' as const }))];

  return (
    <div className="space-y-6">
      <PageHeader
        title={invoice.number ?? t('commission.detail.draftTitle')}
        description={t(`commission.documentType.${invoice.documentType}` as TranslationKey) + ' · ' + t('commission.detail.subtitle')}
        back={{ to: '/finance/commission-invoices', label: t('commission.title') }}
        meta={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS_TONE[invoice.status] ?? 'neutral'}>{t(`commission.status.${invoice.status}` as TranslationKey)}</Badge>
            {isIssued && (
              <Badge tone={COLLECTION_TONE[invoice.collection.status] ?? 'neutral'}>{t(`commission.collection.${invoice.collection.status}` as TranslationKey)}</Badge>
            )}
          </div>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {isDraft && can(Permission.COMMISSION_INVOICE_GENERATE) && (
              <Button variant="secondary" isLoading={regenerate.isPending} onClick={() => { regenerate.mutate(); }}>
                {t('commission.detail.regenerate')}
              </Button>
            )}
            {isDraft && can(Permission.COMMISSION_INVOICE_ISSUE) && (
              <Button variant="primary" disabled={!invoice.canIssue} onClick={() => { setDialog('issue'); }}>
                {t('commission.detail.issue')}
              </Button>
            )}
            {invoice.document !== null && can(Permission.COMMISSION_INVOICE_DOWNLOAD) && (
              <Button
                variant="primary"
                isLoading={download.isPending && download.variables.documentId === invoice.document.id}
                onClick={() => {
                  if (invoice.document !== null) download.mutate({ documentId: invoice.document.id, name: invoice.document.fileName });
                }}
              >
                {t('commission.detail.download')}
              </Button>
            )}
            {(invoice.status === 'ISSUED' || invoice.status === 'PARTIALLY_CREDITED') && can(Permission.COMMISSION_CREDIT_NOTE_CREATE) && (
              <Button variant="secondary" onClick={() => { setDialog('credit'); }}>
                {t('commission.detail.creditNote')}
              </Button>
            )}
            {isIssued && invoice.collection.status === 'OUTSTANDING' && can(Permission.COMMISSION_INVOICE_ISSUE) && (
              <Button variant="ghost" onClick={() => { setDialog('collection'); }}>
                {t('commission.detail.recordPayment')}
              </Button>
            )}
            {invoice.canVoid && can(isDraft ? Permission.COMMISSION_INVOICE_GENERATE : Permission.COMMISSION_INVOICE_ISSUE) && (
              <Button variant="ghost" onClick={() => { setDialog('void'); }}>
                {isDraft ? t('commission.detail.discard') : t('commission.detail.void')}
              </Button>
            )}
          </div>
        }
      />

      {problems.length > 0 && (
        <Callout tone="warning" title={t('commission.detail.cannotIssue')}>
          <ul className="list-disc space-y-1 pl-5">
            {problems.map((problem) => (
              <li key={`${problem.kind}-${problem.code}-${problem.field ?? ''}`}>{problem.kind === 'blocker' ? blockerText(t, problem) : issueText(t, problem)}</li>
            ))}
          </ul>
        </Callout>
      )}
      {invoice.creditSuggestion !== null && (
        <Callout tone="warning" title={t('commission.detail.creditDueTitle')}>
          {t(`commission.creditSuggestion.${invoice.creditSuggestion}` as TranslationKey)}
        </Callout>
      )}
      {invoice.status === 'VOID' && invoice.voidReason !== null && <Callout tone="danger">{t('commission.detail.voided', { reason: invoice.voidReason })}</Callout>}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <div className="space-y-6">
          {isDraft && can(Permission.COMMISSION_INVOICE_PREVIEW) && <DraftPreview invoiceId={invoice.id} hash={invoice.snapshotHash} t={t} />}
          {invoice.document !== null && (
            <Card title={t('commission.detail.issuedDocument')}>
              <div className="p-5">
                <DescriptionList
                  columns={1}
                  items={[
                    { label: t('commission.detail.fileName'), value: <span className="break-all font-mono text-xs">{invoice.document.fileName}</span> },
                    { label: t('commission.detail.pages'), value: String(invoice.document.pageCount) },
                    { label: t('commission.detail.sha256'), value: <span className="break-all font-mono text-xxs">{invoice.document.contentHash}</span> },
                  ]}
                />
              </div>
            </Card>
          )}
          <Card title={t('commission.detail.parties')}>
            <div className="grid gap-5 p-5 sm:grid-cols-2 xl:grid-cols-1">
              <Party heading={t('commission.detail.supplier')} name={invoice.issuer.legalName === '' ? t('commission.detail.notSet') : invoice.issuer.legalName} lines={[
                ...(invoice.issuer.tradeName === null ? [] : [invoice.issuer.tradeName]),
                ...invoice.issuer.addressLines,
                ...(invoice.issuer.taxRegistrationNumber === null ? [] : [`${invoice.issuer.taxRegistrationLabel}: ${invoice.issuer.taxRegistrationNumber}`]),
              ]} />
              <Party heading={t('commission.detail.billTo')} name={invoice.seller.legalName} lines={[
                `${t('commission.detail.sellerId')}: ${invoice.seller.sellerAccountId}`,
                ...invoice.seller.addressLines,
                ...(invoice.seller.taxId === null ? [] : [`${t('commission.detail.taxId')}: ${invoice.seller.taxId}`]),
                ...(invoice.seller.stateCode === null ? [] : [`${invoice.seller.stateName ?? ''} (${invoice.seller.stateCode})`]),
              ]} />
            </div>
          </Card>
        </div>

        <div className="space-y-6">
          <Card title={t('commission.detail.calculation')} description={t('commission.detail.calculationHint')}>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <caption className="sr-only">{t('commission.detail.calculation')}</caption>
                <thead className="bg-surface-sunken text-left text-xs text-ink-muted">
                  <tr>
                    <th className="px-4 py-2 font-medium">{t('commission.detail.description')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('commission.detail.taxable')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('commission.detail.rate')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('commission.detail.tax')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('commission.detail.total')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {invoice.lines.map((line) => (
                    <tr key={line.position}>
                      <td className="px-4 py-3 align-top">
                        <p className="text-ink">{line.description}</p>
                        <p className="text-xs text-ink-muted">
                          {[line.detail, line.serviceCode === null ? null : `SAC ${line.serviceCode}`, line.orderReference, line.policyVersion === null ? null : t('commission.detail.policyVersion', { version: line.policyVersion })]
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{formatMoney(line.taxable)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{line.taxRatePercent}%</td>
                      <td className="px-4 py-3 text-right tabular-nums">{formatMoney(line.tax)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{formatMoney(line.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="border-t border-border-subtle p-5">
              <Totals invoice={invoice} t={t} />
            </div>
          </Card>

          <Card title={t('commission.detail.sources')} description={t('commission.detail.sourcesHint')}>
            <div className="p-5">
              <DescriptionList
                columns={2}
                items={[
                  { label: t('commission.detail.order'), value: <Link className="text-accent hover:underline" to={`/orders/${invoice.source.orderId}`}>{invoice.source.orderNumber}</Link> },
                  { label: t('commission.detail.sellerOrder'), value: `${invoice.source.sellerOrderNumber} · ${invoice.sources.sellerOrderStatus}` },
                  { label: t('commission.detail.payment'), value: `${formatMoney(invoice.sources.orderPaid)} / ${formatMoney(invoice.sources.orderTotal)}` },
                  { label: t('commission.detail.paymentRef'), value: invoice.source.paymentReference ?? '—' },
                  { label: t('commission.detail.proceeds'), value: formatMoney(invoice.sources.settlement.grossProceeds) },
                  { label: t('commission.detail.feeBasis'), value: formatMoney(invoice.sources.settlement.feeBasis) },
                  { label: t('commission.detail.platformFee'), value: formatMoney(invoice.sources.settlement.platformFee) },
                  { label: t('commission.detail.feeTax'), value: `${formatMoney(invoice.sources.settlement.platformFeeTax)} · ${invoice.sources.settlement.feeTaxLabel.includes("%") ? invoice.sources.settlement.feeTaxLabel : `${invoice.sources.settlement.feeTaxLabel} ${invoice.sources.settlement.feeTaxRatePercent}%`}` },
                  { label: t('commission.detail.refunds'), value: formatMoney(invoice.sources.settlement.refundsAdjustments) },
                  { label: t('commission.detail.settlementRef'), value: invoice.source.settlementReference ?? t('commission.detail.notSettled') },
                  { label: t('commission.detail.calculatedAt'), value: formatDateTime(invoice.sources.settlement.computedAt) },
                  { label: t('commission.detail.treatment'), value: t(`commission.treatment.${invoice.taxTreatment}` as TranslationKey) },
                  { label: t('commission.detail.placeOfSupply'), value: invoice.placeOfSupply === null ? '—' : `${invoice.placeOfSupply.name} (${invoice.placeOfSupply.code})` },
                  { label: t('commission.detail.reverseCharge'), value: invoice.reverseCharge ? t('commission.yes') : t('commission.no') },
                  ...(invoice.issueDate === null ? [] : [{ label: t('commission.detail.issueDate'), value: formatDate(invoice.issueDate) }]),
                  ...(invoice.dueDate === null ? [] : [{ label: t('commission.detail.dueDate'), value: formatDate(invoice.dueDate) }]),
                  ...(invoice.collection.reference === null ? [] : [{ label: t('commission.detail.collectionRef'), value: invoice.collection.reference }]),
                ]}
              />
            </div>
          </Card>

          {invoice.creditNotes.length > 0 && (
            <Card title={t('commission.detail.creditNotes')}>
              <ul className="divide-y divide-border-subtle text-sm">
                {invoice.creditNotes.map((note) => (
                  <li key={note.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
                    <div>
                      <p className="font-mono text-ink">{note.number}</p>
                      <p className="text-xs text-ink-muted">
                        {formatDate(note.issueDate)} · {t(`commission.creditReason.${note.reason}` as TranslationKey)} · {formatMoney(note.grandTotal)}
                      </p>
                    </div>
                    {note.document !== null && can(Permission.COMMISSION_INVOICE_DOWNLOAD) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          if (note.document !== null) download.mutate({ documentId: note.document.id, name: note.document.fileName });
                        }}
                      >
                        {t('commission.detail.download')}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card title={t('commission.detail.history')}>
            <ol className="divide-y divide-border-subtle text-sm">
              {invoice.history.map((item) => (
                <li key={item.id} className="flex flex-wrap justify-between gap-2 px-5 py-2.5">
                  <span className="text-ink">
                    {t(`commission.event.${item.action}` as TranslationKey)}
                    {item.toStatus !== null && item.fromStatus !== item.toStatus && (
                      <span className="text-ink-muted"> · {t(`commission.status.${item.toStatus}` as TranslationKey)}</span>
                    )}
                  </span>
                  <span className="text-xs text-ink-muted">
                    {item.actor ?? t('commission.detail.system')} · {formatDateTime(item.at)}
                  </span>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>

      <Modal
        isOpen={dialog === 'issue'}
        onClose={() => { setDialog(null); }}
        title={t('commission.issueDialog.title')}
        description={t('commission.issueDialog.body', { total: formatMoney(invoice.totals.grandTotal), seller: invoice.seller.legalName })}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => { setDialog(null); }}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" isLoading={issue.isPending} onClick={() => { issue.mutate(); }}>
              {t('commission.issueDialog.confirm')}
            </Button>
          </div>
        }
      >
        <p className="text-sm text-ink-muted">{t('commission.issueDialog.irreversible')}</p>
      </Modal>
      {dialog === 'void' && <VoidDialog invoice={invoice} onClose={() => { setDialog(null); }} onDone={refreshed} t={t} />}
      {dialog === 'credit' && <CreditDialog invoice={invoice} onClose={() => { setDialog(null); }} onDone={refreshed} t={t} />}
      {dialog === 'collection' && <CollectionDialog invoice={invoice} onClose={() => { setDialog(null); }} onDone={refreshed} t={t} />}
    </div>
  );
}

type Translate = ReturnType<typeof useI18n>['t'];

function issueText(t: Translate, issue: Problem): string {
  if (issue.code.startsWith('SELLER_GSTIN_')) return t('commission.issue.SELLER_GSTIN_INVALID');
  if (issue.code.startsWith('ISSUER_GSTIN_') && issue.code !== 'ISSUER_GSTIN_STATE_MISMATCH') return t('commission.issue.ISSUER_GSTIN_INVALID');
  return ISSUE_KEYS.has(issue.code) ? t(`commission.issue.${issue.code}` as TranslationKey) : issue.message;
}

function Party({ heading, name, lines }: { heading: string; name: string; lines: string[] }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <p className="text-xxs font-semibold uppercase tracking-wide text-accent">{heading}</p>
      <p className="mt-1 font-medium text-ink">{name}</p>
      {lines.map((line) => (
        <p key={line} className="break-words text-sm text-ink-muted">
          {line}
        </p>
      ))}
    </div>
  );
}

function Totals({ invoice, t }: { invoice: CommissionInvoiceDetail; t: Translate }): React.JSX.Element {
  const rows: [string, Money, boolean?][] = [
    [t('commission.totals.subtotal'), invoice.totals.subtotal],
    [t('commission.totals.discount'), invoice.totals.discount],
    [t('commission.totals.taxable'), invoice.totals.taxable],
  ];
  if (invoice.totals.cgst.minor !== '0' || invoice.totals.sgst.minor !== '0') {
    rows.push([invoice.taxLabels.cgst, invoice.totals.cgst], [invoice.taxLabels.sgst, invoice.totals.sgst]);
  }
  if (invoice.totals.igst.minor !== '0') rows.push([invoice.taxLabels.igst, invoice.totals.igst]);
  if (invoice.totals.otherTax.minor !== '0') rows.push([invoice.taxLabels.other, invoice.totals.otherTax]);
  if (invoice.totals.totalTax.minor === '0') rows.push([t('commission.totals.noTax'), invoice.totals.totalTax]);
  rows.push([t('commission.totals.rounding'), invoice.totals.rounding], [t('commission.totals.grandTotal'), invoice.totals.grandTotal, true]);
  if (invoice.totals.credited.minor !== '0') rows.push([t('commission.totals.credited'), invoice.totals.credited], [t('commission.totals.remaining'), invoice.totals.outstanding]);

  return (
    <div className="grid gap-5 md:grid-cols-2">
      <div className="space-y-2 text-sm">
        <p className="text-xxs font-semibold uppercase tracking-wide text-ink-subtle">{t('commission.totals.inWords')}</p>
        <p className="text-ink">{invoice.amountInWords}</p>
        <p className="rounded-md border border-border-strong bg-surface-sunken px-3 py-2 text-ink">
          {invoice.source.collection === 'ADJUSTED_AGAINST_SETTLEMENT' ? t('commission.totals.adjusted') : t('commission.totals.payable')}
        </p>
        {invoice.notes.map((note) => (
          <p key={note} className="text-xs font-medium text-ink">
            {note}
          </p>
        ))}
      </div>
      <dl className="space-y-1.5 text-sm">
        {rows.map(([label, value, strong]) => (
          <div key={label} className={strong === true ? 'flex justify-between rounded-md bg-brand px-3 py-2 font-semibold text-white' : 'flex justify-between px-3'}>
            <dt className={strong === true ? '' : 'text-ink-muted'}>{label}</dt>
            <dd className="tabular-nums">{formatMoney(value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function DraftPreview({ invoiceId, hash, t }: { invoiceId: string; hash: string; t: Translate }): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let revoked = false;
    let created: string | null = null;
    setUrl(null);
    setFailed(null);
    previewUrl(invoiceId)
      .then((value) => {
        created = value;
        if (revoked) URL.revokeObjectURL(value);
        else setUrl(value);
      })
      .catch((error: unknown) => {
        setFailed(error instanceof Error ? error.message : String(error));
      });
    return () => {
      revoked = true;
      if (created !== null) URL.revokeObjectURL(created);
    };
  }, [invoiceId, hash]);

  return (
    <Card title={t('commission.detail.preview')} description={t('commission.detail.previewHint')}>
      <div className="p-3">
        {failed !== null && <Callout tone="danger">{failed}</Callout>}
        {url === null && failed === null && <LoadingState label={t('commission.detail.previewLoading')} />}
        {url !== null && (
          // A6 is 105 x 148 mm; the frame keeps that ratio.
          <iframe title={t('commission.detail.preview')} src={`${url}#view=Fit&toolbar=0`} className="mx-auto block aspect-[105/148] w-full max-w-[26rem] rounded-md border border-border-strong bg-white" />
        )}
      </div>
    </Card>
  );
}

interface DialogProps {
  invoice: CommissionInvoiceDetail;
  onClose: () => void;
  onDone: (next: CommissionInvoiceDetail) => void;
  t: Translate;
}

function VoidDialog({ invoice, onClose, onDone, t }: DialogProps): React.JSX.Element {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const mutation = useMutation({
    mutationFn: () => (invoice.status === 'DRAFT' ? commissionApi.discard(invoice.id, reason) : commissionApi.void(invoice.id, reason)),
    onSuccess: (next) => {
      onDone(next);
      onClose();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error));
    },
  });
  const draft = invoice.status === 'DRAFT';
  return (
    <Modal
      isOpen
      onClose={onClose}
      title={draft ? t('commission.voidDialog.discardTitle') : t('commission.voidDialog.voidTitle')}
      description={draft ? t('commission.voidDialog.discardBody') : t('commission.voidDialog.voidBody')}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" disabled={reason.trim().length < 3} isLoading={mutation.isPending} onClick={() => { mutation.mutate(); }}>
            {draft ? t('commission.detail.discard') : t('commission.detail.void')}
          </Button>
        </div>
      }
    >
      <Field label={t('commission.voidDialog.reason')} required>
        {({ inputId, describedBy }) => <Textarea id={inputId} aria-describedby={describedBy} value={reason} rows={3} maxLength={1000} onChange={(event) => { setReason(event.target.value); }} />}
      </Field>
    </Modal>
  );
}

function CreditDialog({ invoice, onClose, onDone, t }: DialogProps): React.JSX.Element {
  const toast = useToast();
  const [reason, setReason] = useState<CreditReason>('FULL_REFUND');
  const [basis, setBasis] = useState<CreditBasis>('FULL');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  // One key for this dialog: a double click or a retry lands on one credit note.
  const [idempotencyKey] = useState(newIdempotencyKey);
  const exponent = currencyExponent(invoice.currency);
  const taxableMinor = basis === 'CUSTOM_AMOUNT' ? majorToMinor(amount, exponent) : null;
  const mutation = useMutation({
    mutationFn: () =>
      commissionApi.credit(
        invoice.id,
        {
          reason,
          basis,
          ...(taxableMinor === null ? {} : { taxableMinor }),
          ...(note.trim() === '' ? {} : { note: note.trim() }),
        },
        idempotencyKey,
      ),
    onSuccess: (result) => {
      onDone(result.invoice);
      onClose();
      toast.success(t('commission.creditDialog.done'));
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error));
    },
  });
  return (
    <Modal
      isOpen
      onClose={onClose}
      size="lg"
      title={t('commission.creditDialog.title')}
      description={t('commission.creditDialog.body', { remaining: formatMoney(invoice.totals.outstanding) })}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={basis === 'CUSTOM_AMOUNT' && taxableMinor === null} isLoading={mutation.isPending} onClick={() => { mutation.mutate(); }}>
            {t('commission.creditDialog.confirm')}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label={t('commission.creditDialog.reason')}>
          {({ inputId, describedBy }) => (
            <Select id={inputId} aria-describedby={describedBy} value={reason} onChange={(event) => { setReason(event.target.value as CreditReason); }}>
              {CREDIT_REASONS.map((value) => (
                <option key={value} value={value}>
                  {t(`commission.creditReason.${value}` as TranslationKey)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('commission.creditDialog.basis')} hint={t(`commission.creditBasis.${basis}.hint` as TranslationKey)}>
          {({ inputId, describedBy }) => (
            <Select id={inputId} aria-describedby={describedBy} value={basis} onChange={(event) => { setBasis(event.target.value as CreditBasis); }}>
              {(['FULL', 'PROPORTIONAL_TO_REFUND', 'CUSTOM_AMOUNT'] as const).map((value) => (
                <option key={value} value={value}>
                  {t(`commission.creditBasis.${value}` as TranslationKey)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {basis === 'CUSTOM_AMOUNT' && (
          <Field label={t('commission.creditDialog.amount', { currency: invoice.currency })} hint={t('commission.creditDialog.amountHint')}>
            {({ inputId, describedBy }) => <Input id={inputId} aria-describedby={describedBy} inputMode="decimal" value={amount} onChange={(event) => { setAmount(event.target.value); }} />}
          </Field>
        )}
        <Field label={t('commission.creditDialog.note')}>
          {({ inputId, describedBy }) => <Textarea id={inputId} aria-describedby={describedBy} value={note} rows={2} maxLength={1000} onChange={(event) => { setNote(event.target.value); }} />}
        </Field>
      </div>
    </Modal>
  );
}

function CollectionDialog({ invoice, onClose, onDone, t }: DialogProps): React.JSX.Element {
  const toast = useToast();
  const [reference, setReference] = useState('');
  const mutation = useMutation({
    mutationFn: () => commissionApi.recordCollection(invoice.id, reference.trim()),
    onSuccess: (next) => {
      onDone(next);
      onClose();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error));
    },
  });
  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t('commission.collectionDialog.title')}
      description={t('commission.collectionDialog.body', { total: formatMoney(invoice.totals.outstanding) })}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={reference.trim().length < 2} isLoading={mutation.isPending} onClick={() => { mutation.mutate(); }}>
            {t('commission.collectionDialog.confirm')}
          </Button>
        </div>
      }
    >
      <Field label={t('commission.collectionDialog.reference')} required>
        {({ inputId, describedBy }) => <Input id={inputId} aria-describedby={describedBy} value={reference} maxLength={128} onChange={(event) => { setReference(event.target.value); }} />}
      </Field>
    </Modal>
  );
}

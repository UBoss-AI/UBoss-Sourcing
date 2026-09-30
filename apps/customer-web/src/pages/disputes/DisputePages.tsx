/**
 * Claims for the buyer (checklist Master row 24).
 *
 *   /account/orders/:id/claim     raise a claim on an order, or one line of it
 *   /account/disputes             every claim, most recently active first
 *   /account/disputes/:reference  one claim: status, decision, evidence, thread
 *
 * What the buyer may do next comes from the claim's own `can` block.
 */
import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStorefront } from '@/app/storefront-context';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, PageHeader, Select, Textarea } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { api, newIdempotencyKey } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { currencyExponent, formatDateTime, formatMoney, majorToMinor } from '@/lib/format';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import type { OrderDetail } from '@/lib/types';
import {
  appealClaim,
  claimAction,
  createClaim,
  disputeKeys,
  fetchClaimContext,
  fetchDispute,
  fetchDisputes,
  sendClaimMessage,
  uploadClaimEvidence,
  type DisputeRemedy,
  type DisputeView,
} from '@/lib/disputes';

const statusLabel = (t: (key: TranslationKey) => string, status: string): string =>
  t(`disputes.status.${status}` as TranslationKey);
const reasonLabel = (t: (key: TranslationKey) => string, code: string): string =>
  t(`disputes.reason.${code}` as TranslationKey);

/** Raise a claim on one order. */
export function ClaimRequestPage(): React.JSX.Element {
  const { id = '' } = useParams();
  const { business } = useStorefront();
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  useDocumentMeta({ title: t('disputes.requestTitle'), noIndex: true }, business.displayName);

  const context = useQuery({ queryKey: disputeKeys.context, queryFn: fetchClaimContext });
  const order = useQuery({
    queryKey: ['order', id],
    queryFn: () => api.get<{ order: OrderDetail }>(`/orders/${id}`),
  });
  const [lineId, setLineId] = useState('');
  const [reasonCode, setReasonCode] = useState('');
  const [description, setDescription] = useState('');
  const [outcome, setOutcome] = useState<DisputeRemedy>('REFUND_FULL');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newIdempotencyKey());

  const currency = order.data?.order.currency ?? 'EUR';
  const amountMinor = outcome === 'REFUND_PARTIAL' ? majorToMinor(amount, currencyExponent(currency)) : null;

  const submit = useMutation({
    mutationFn: () =>
      createClaim(
        {
          orderId: id,
          orderItemId: lineId === '' ? null : lineId,
          reasonCode,
          description: description.trim(),
          desiredOutcome: outcome,
          requestedAmountMinor: amountMinor,
        },
        key.current,
      ),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: disputeKeys.list });
      toast.success(t('disputes.sent'));
      void navigate(`/account/disputes/${result.dispute.reference}`);
    },
    onError: (failure) => {
      setError(errorMessage(t, failure));
    },
  });

  if (context.isPending || order.isPending) return <LoadingState />;
  if (context.isError) return <ErrorState error={context.error} onRetry={() => { void context.refetch(); }} />;
  if (order.isError) return <ErrorState error={order.error} onRetry={() => { void order.refetch(); }} />;

  const min = context.data.limits.descriptionMin;
  const canSend =
    reasonCode !== '' &&
    description.trim().length >= min &&
    (outcome !== 'REFUND_PARTIAL' || (amountMinor !== null && amountMinor !== '0')) &&
    !submit.isPending;

  return (
    <>
      <PageHeader
        title={t('disputes.requestTitle')}
        description={t('disputes.requestDescription', {
          order: order.data.order.orderNumber,
          days: String(context.data.claimWindowDays),
          hours: String(context.data.sellerResponseHours),
        })}
        actions={
          <Link to={`/account/orders/${id}`} className="text-sm font-medium text-brand hover:underline">
            {t('returns.backToOrder')}
          </Link>
        }
      />
      <Card bodyClassName="space-y-4 px-5 py-5">
        <Field label={t('disputes.lineLabel')}>
          {({ inputId }) => (
            <Select id={inputId} value={lineId} onChange={(event) => { setLineId(event.target.value); }}>
              <option value="">{t('disputes.wholeOrder')}</option>
              {order.data.order.items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('disputes.reasonLabel')} required>
          {({ inputId }) => (
            <Select id={inputId} value={reasonCode} onChange={(event) => { setReasonCode(event.target.value); }}>
              <option value="">{t('returns.chooseReason')}</option>
              {context.data.reasons.map((code) => (
                <option key={code} value={code}>
                  {reasonLabel(t, code)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('disputes.descriptionLabel')} hint={t('disputes.descriptionHint', { min: String(min) })} required>
          {({ inputId, describedBy }) => (
            <Textarea
              id={inputId}
              aria-describedby={describedBy}
              rows={4}
              maxLength={context.data.limits.descriptionMax}
              value={description}
              onChange={(event) => { setDescription(event.target.value); }}
            />
          )}
        </Field>
        <fieldset className="space-y-2 text-sm">
          <legend className="font-medium text-ink">{t('disputes.outcomeLabel')}</legend>
          {context.data.remedies.map((remedy) => (
            <label key={remedy} className="flex items-center gap-2">
              <input type="radio" name="outcome" checked={outcome === remedy} onChange={() => { setOutcome(remedy); }} />
              {t(`disputes.remedy.${remedy}`)}
            </label>
          ))}
        </fieldset>
        {outcome === 'REFUND_PARTIAL' && (
          <Field label={t('disputes.amountLabel', { currency })} required>
            {({ inputId }) => (
              <Input id={inputId} inputMode="decimal" value={amount} onChange={(event) => { setAmount(event.target.value); }} />
            )}
          </Field>
        )}
        <p className="text-xs text-ink-muted">{t('disputes.evidenceLater')}</p>
        {error !== null && (
          <p role="alert" className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger">
            {error}
          </p>
        )}
        <Button variant="primary" disabled={!canSend} isLoading={submit.isPending} onClick={() => { setError(null); submit.mutate(); }}>
          {t('disputes.send')}
        </Button>
      </Card>
    </>
  );
}

/** Every claim the buyer has raised. */
export function DisputesPage(): React.JSX.Element {
  const { business } = useStorefront();
  const { t } = useI18n();
  useDocumentMeta({ title: t('disputes.listTitle'), noIndex: true }, business.displayName);
  const query = useQuery({ queryKey: disputeKeys.list, queryFn: fetchDisputes });

  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => { void query.refetch(); }} />;

  return (
    <>
      <PageHeader title={t('disputes.listTitle')} description={t('disputes.listDescription')} />
      {query.data.length === 0 ? (
        <EmptyState title={t('disputes.emptyTitle')} description={t('disputes.emptyBody')} />
      ) : (
        <Card bodyClassName="px-5 py-2">
          <ul className="divide-y divide-border-subtle">
            {query.data.map((item) => (
              <li key={item.reference} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <Link to={`/account/disputes/${item.reference}`} className="font-medium text-brand hover:underline">
                    {item.reference}
                  </Link>
                  <p className="text-xs text-ink-muted">
                    {t('returns.forOrder', { order: item.orderNumber })} · {reasonLabel(t, item.reasonCode)} ·{' '}
                    {formatDateTime(item.lastActivityAt)}
                  </p>
                </div>
                <Badge>{statusLabel(t, item.status)}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

function DecisionBlock({ dispute }: { dispute: DisputeView }): React.JSX.Element {
  const { t } = useI18n();
  if (dispute.decision === null) return <p className="text-sm text-ink-muted">{t('disputes.noDecision')}</p>;
  const { decision } = dispute;
  return (
    <div className="space-y-1 text-sm">
      <p className="font-medium text-ink">
        {t(`disputes.resolution.${decision.resolution}` as TranslationKey)}
        {decision.amount !== null && ` · ${formatMoney(decision.amount)}`}
      </p>
      {decision.reason !== null && <p className="whitespace-pre-wrap text-ink-muted">{decision.reason}</p>}
      {decision.refund !== null && (
        <p className="text-ink-muted">
          {t('disputes.refundStatus', { status: decision.refund.status })}
        </p>
      )}
    </div>
  );
}

/** One claim, and what the buyer may do on it now. */
export function DisputeDetailPage(): React.JSX.Element {
  const { reference = '' } = useParams();
  const { business } = useStorefront();
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  useDocumentMeta({ title: reference, noIndex: true }, business.displayName);
  const query = useQuery({ queryKey: disputeKeys.one(reference), queryFn: () => fetchDispute(reference) });
  const [message, setMessage] = useState('');

  const refresh = (dispute: DisputeView): void => {
    queryClient.setQueryData(disputeKeys.one(reference), dispute);
    void queryClient.invalidateQueries({ queryKey: disputeKeys.list });
  };
  const onError = (failure: unknown): void => {
    toast.error(errorMessage(t, failure));
  };

  const send = useMutation({
    mutationFn: () => sendClaimMessage(reference, message.trim()),
    onSuccess: (result) => { setMessage(''); refresh(result.dispute); },
    onError,
  });
  const act = useMutation({
    mutationFn: (action: 'escalate' | 'withdraw') => claimAction(reference, action),
    onSuccess: (result) => { refresh(result.dispute); },
    onError,
  });
  const appeal = useMutation({
    mutationFn: () => appealClaim(reference, message.trim()),
    onSuccess: (result) => { setMessage(''); refresh(result.dispute); },
    onError,
  });
  const upload = useMutation({
    mutationFn: (file: File) => uploadClaimEvidence(reference, file),
    onSuccess: () => { void query.refetch(); },
    onError,
  });

  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => { void query.refetch(); }} />;
  const dispute = query.data;
  const busy = send.isPending || act.isPending || appeal.isPending;

  return (
    <>
      <PageHeader
        title={dispute.reference}
        description={t('returns.forOrder', { order: dispute.order.orderNumber })}
        actions={
          <Link to="/account/disputes" className="text-sm font-medium text-brand hover:underline">
            {t('disputes.backToList')}
          </Link>
        }
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t('returns.summaryTitle')} bodyClassName="space-y-3 px-5 py-4 text-sm">
          <p>
            <Badge>{statusLabel(t, dispute.status)}</Badge>
          </p>
          <p>
            <span className="text-ink-muted">{t('disputes.reasonLabel')}: </span>
            {reasonLabel(t, dispute.reasonCode)}
            {dispute.line !== null && ` · ${dispute.line.name}`}
          </p>
          <p>
            <span className="text-ink-muted">{t('disputes.outcomeLabel')}: </span>
            {t(`disputes.remedy.${dispute.desiredOutcome}`)}
            {dispute.requestedAmount !== null && ` · ${formatMoney(dispute.requestedAmount)}`}
          </p>
          <p className="whitespace-pre-wrap">{dispute.description}</p>
          {dispute.attachments.length > 0 && (
            <p className="text-ink-muted">{dispute.attachments.map((file) => file.fileName).join(', ')}</p>
          )}
          {dispute.can.addEvidence && (
            <label className="block text-sm">
              <span className="font-medium text-ink">{t('disputes.addEvidence')}</span>
              <input
                type="file"
                className="mt-1 block w-full text-sm"
                disabled={upload.isPending}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file !== undefined) upload.mutate(file);
                  event.target.value = '';
                }}
              />
            </label>
          )}
        </Card>
        <Card title={t('disputes.decisionTitle')} bodyClassName="space-y-3 px-5 py-4">
          <DecisionBlock dispute={dispute} />
          <div className="flex flex-wrap gap-2">
            {dispute.can.escalate && (
              <Button variant="secondary" disabled={busy} onClick={() => { act.mutate('escalate'); }}>
                {t('disputes.escalate')}
              </Button>
            )}
            {dispute.can.withdraw && (
              <Button variant="secondary" disabled={busy} onClick={() => { act.mutate('withdraw'); }}>
                {t('disputes.withdraw')}
              </Button>
            )}
          </div>
        </Card>
      </div>

      <Card title={t('disputes.threadTitle')} className="mt-4" bodyClassName="space-y-3 px-5 py-4">
        <ol className="space-y-3 text-sm">
          {dispute.thread.map((entry) => (
            <li key={entry.id}>
              <p className="text-xs text-ink-muted">
                {t(`disputes.author.${entry.author}` as TranslationKey)} · {formatDateTime(entry.createdAt)}
              </p>
              {entry.body !== null && <p className="whitespace-pre-wrap text-ink">{entry.body}</p>}
            </li>
          ))}
        </ol>
        {(dispute.can.message || dispute.can.appeal) && (
          <div className="space-y-2">
            <Textarea
              aria-label={dispute.can.appeal ? t('disputes.appealLabel') : t('disputes.messageLabel')}
              rows={3}
              value={message}
              onChange={(event) => { setMessage(event.target.value); }}
            />
            <div className="flex gap-2">
              {dispute.can.message && (
                <Button variant="primary" disabled={busy || message.trim() === ''} onClick={() => { send.mutate(); }}>
                  {t('disputes.sendMessage')}
                </Button>
              )}
              {dispute.can.appeal && (
                <Button variant="secondary" disabled={busy || message.trim().length < 10} onClick={() => { appeal.mutate(); }}>
                  {t('disputes.appeal')}
                </Button>
              )}
            </div>
          </div>
        )}
      </Card>
    </>
  );
}

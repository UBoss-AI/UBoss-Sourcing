/**
 * Seller Hub -> Claims (checklist JOURNEY-058).
 *
 *   /seller/disputes             claims on this seller's goods, most recently active first
 *   /seller/disputes/:reference  one claim: the buyer's account and evidence, the
 *                                deadline to answer, the inspection report, the
 *                                thread, and what the seller may do now
 *
 * A seller answers once with their account and, optionally, an offer (a full
 * or partial refund, or a replacement). Answering moves the claim to the
 * marketplace's review; the marketplace decides. After a decision either side
 * may appeal once, inside the appeal window.
 *
 * Every rule is the server's: what the seller may do comes from the claim's
 * own `can` block, and the most a partial refund may be is checked there too.
 * Reading claims needs `seller.order.read`; answering, writing, adding
 * evidence and appealing need `seller.return.handle`, which the server checks.
 */
import { Countdown } from '@/components/Countdown';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, PageHeader, Textarea } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';
import { errorMessage } from '@/lib/errors';
import { currencyExponent, formatDateTime, formatMoney, majorToMinor } from '@/lib/format';
import {
  appealSellerClaim,
  fetchSellerDispute,
  fetchSellerDisputes,
  respondToClaim,
  sellerDisputeKeys,
  sendSellerClaimMessage,
  uploadSellerClaimEvidence,
  type DisputeRemedy,
  type DisputeView,
} from '@/lib/disputes';
import { DecisionBlock } from '@/pages/disputes/DisputePages';
import { EvidenceTimeline, InspectionCard } from '@/pages/disputes/DisputeShared';

const FILTERS = ['OPEN', 'CLOSED', 'ALL'] as const;
type Filter = (typeof FILTERS)[number];
const OFFERS: readonly (DisputeRemedy | 'NONE')[] = ['NONE', 'REFUND_FULL', 'REFUND_PARTIAL', 'REPLACEMENT'];

const statusLabel = (t: (key: TranslationKey) => string, status: string): string =>
  t(`disputes.status.${status}` as TranslationKey);
const reasonLabel = (t: (key: TranslationKey) => string, code: string): string =>
  t(`disputes.reason.${code}` as TranslationKey);

/** Claims on this seller's goods. */
export function SellerDisputesPage(): React.JSX.Element {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const raw = params.get('filter');
  const filter: Filter = (FILTERS as readonly string[]).includes(raw ?? '') ? (raw as Filter) : 'OPEN';
  const query = useQuery({
    queryKey: [...sellerDisputeKeys.list, filter],
    queryFn: () => fetchSellerDisputes(filter === 'ALL' ? null : filter),
    refetchInterval: 60_000,
  });

  return (
    <>
      <PageHeader title={t('sellerDisputes.title')} description={t('sellerDisputes.description')} />
      <div role="group" aria-label={t('sellerDisputes.filters')} className="mb-4 flex flex-wrap gap-2">
        {FILTERS.map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={filter === key}
            onClick={() => {
              const next = new URLSearchParams(params);
              next.set('filter', key);
              setParams(next, { replace: true });
            }}
            className={cx(
              'inline-flex items-center rounded-full border px-3 py-1.5 text-sm transition-colors',
              filter === key ? 'border-brand bg-brand/10 font-semibold text-brand' : 'border-border bg-surface text-ink hover:border-border-hover',
            )}
          >
            {t(`sellerDisputes.filter.${key}` as TranslationKey)}
          </button>
        ))}
      </div>
      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => { void query.refetch(); }} />
      ) : query.data.length === 0 ? (
        <EmptyState title={t('sellerDisputes.emptyTitle')} description={t('sellerDisputes.emptyBody')} />
      ) : (
        <Card bodyClassName="px-5 py-2">
          <ul className="divide-y divide-border-subtle">
            {query.data.map((item) => (
              <li key={item.reference} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <Link to={`/seller/disputes/${item.reference}`} className="font-medium text-brand hover:underline">
                    {item.reference}
                  </Link>
                  <p className="text-xs text-ink-muted">
                    {[
                      t('returns.forOrder', { order: item.orderNumber }),
                      reasonLabel(t, item.reasonCode),
                      item.lineName,
                      formatDateTime(item.lastActivityAt),
                    ]
                      .filter((part) => part !== null && part !== '')
                      .join(' · ')}
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

/** The seller's answer: their account and, optionally, an offer. */
function RespondForm({
  dispute,
  busy,
  onSubmit,
}: {
  dispute: DisputeView;
  busy: boolean;
  onSubmit: (input: { body: string; proposal: DisputeRemedy | null; proposalAmountMinor: string | null }) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [body, setBody] = useState('');
  const [offer, setOffer] = useState<DisputeRemedy | 'NONE'>('NONE');
  const [amount, setAmount] = useState('');
  const currency = dispute.currency ?? dispute.requestedAmount?.currency ?? 'EUR';
  const amountMinor = offer === 'REFUND_PARTIAL' ? majorToMinor(amount, currencyExponent(currency)) : null;
  const ready =
    body.trim().length >= 10 && (offer !== 'REFUND_PARTIAL' || (amountMinor !== null && amountMinor !== '0')) && !busy;

  return (
    <div className="space-y-3">
      <Field label={t('sellerDisputes.respondLabel')} hint={t('sellerDisputes.respondHint')} required>
        {({ inputId, describedBy }) => (
          <Textarea
            id={inputId}
            aria-describedby={describedBy}
            rows={4}
            maxLength={5000}
            value={body}
            onChange={(event) => { setBody(event.target.value); }}
          />
        )}
      </Field>
      <fieldset className="space-y-2 text-sm">
        <legend className="font-medium text-ink">{t('sellerDisputes.offerLabel')}</legend>
        {OFFERS.map((value) => (
          <label key={value} className="flex items-center gap-2">
            <input type="radio" name="offer" checked={offer === value} onChange={() => { setOffer(value); }} />
            {value === 'NONE' ? t('sellerDisputes.offerNone') : t(`disputes.remedy.${value}`)}
          </label>
        ))}
      </fieldset>
      {offer === 'REFUND_PARTIAL' && (
        <Field label={t('sellerDisputes.offerAmount', { currency })} required>
          {({ inputId }) => (
            <Input id={inputId} inputMode="decimal" value={amount} onChange={(event) => { setAmount(event.target.value); }} />
          )}
        </Field>
      )}
      <Button
        variant="primary"
        disabled={!ready}
        isLoading={busy}
        onClick={() => {
          onSubmit({ body: body.trim(), proposal: offer === 'NONE' ? null : offer, proposalAmountMinor: amountMinor });
        }}
      >
        {t('sellerDisputes.respond')}
      </Button>
    </div>
  );
}

/** One claim on this seller's goods. */
export function SellerDisputeDetailPage(): React.JSX.Element {
  const { reference = '' } = useParams();
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: sellerDisputeKeys.one(reference), queryFn: () => fetchSellerDispute(reference) });
  const [message, setMessage] = useState('');

  const refresh = (dispute: DisputeView): void => {
    queryClient.setQueryData(sellerDisputeKeys.one(reference), dispute);
    void queryClient.invalidateQueries({ queryKey: sellerDisputeKeys.list });
  };
  const onError = (failure: unknown): void => {
    toast.error(errorMessage(t, failure));
  };

  const respond = useMutation({
    mutationFn: (input: { body: string; proposal: DisputeRemedy | null; proposalAmountMinor: string | null }) =>
      respondToClaim(reference, input),
    onSuccess: (result) => {
      toast.success(t('sellerDisputes.responded'));
      refresh(result.dispute);
    },
    onError,
  });
  const send = useMutation({
    mutationFn: () => sendSellerClaimMessage(reference, message.trim()),
    onSuccess: (result) => { setMessage(''); refresh(result.dispute); },
    onError,
  });
  const appeal = useMutation({
    mutationFn: () => appealSellerClaim(reference, message.trim()),
    onSuccess: (result) => { setMessage(''); refresh(result.dispute); },
    onError,
  });
  const upload = useMutation({
    mutationFn: (file: File) => uploadSellerClaimEvidence(reference, file),
    onSuccess: () => { void query.refetch(); },
    onError,
  });

  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => { void query.refetch(); }} />;
  const dispute = query.data;
  const busy = send.isPending || appeal.isPending || respond.isPending;
  const due = dispute.deadlines?.sellerResponseDueAt ?? null;

  return (
    <>
      <PageHeader
        title={dispute.reference}
        description={t('returns.forOrder', { order: dispute.order.sellerOrderNumber ?? dispute.order.orderNumber })}
        actions={
          <div className="flex flex-wrap gap-3 text-sm">
            {(dispute.order.sellerOrderGroupId ?? null) !== null && (
              <Link to={`/seller/orders/${dispute.order.sellerOrderGroupId ?? ''}`} className="font-medium text-brand hover:underline">
                {t('sellerDisputes.viewOrder')}
              </Link>
            )}
            <Link to="/seller/disputes" className="font-medium text-brand hover:underline">
              {t('sellerDisputes.backToList')}
            </Link>
          </div>
        }
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t('sellerDisputes.claimTitle')} bodyClassName="space-y-3 px-5 py-4 text-sm">
          <p className="flex flex-wrap items-center gap-2">
            <Badge>{statusLabel(t, dispute.status)}</Badge>
            {due !== null && dispute.status === 'AWAITING_SELLER' && (
              <span className={cx('text-xs', dispute.deadlines?.sellerResponseBreached === true ? 'text-danger' : 'text-ink-muted')}>
                {dispute.deadlines?.sellerResponseBreached === true
                  ? t('sellerDisputes.late', { at: formatDateTime(due) })
                  : t('sellerDisputes.answerBy', { at: formatDateTime(due) })}{' '}
                <Countdown deadline={due} />
              </span>
            )}
          </p>
          <p>
            <span className="text-ink-muted">{t('sellerDisputes.reasonLabel')}: </span>
            {reasonLabel(t, dispute.reasonCode)}
            {dispute.line !== null && ` · ${dispute.line.name}`}
          </p>
          <p>
            <span className="text-ink-muted">{t('sellerDisputes.buyerAsked')}: </span>
            {t(`disputes.remedy.${dispute.desiredOutcome}`)}
            {dispute.requestedAmount !== null && ` · ${formatMoney(dispute.requestedAmount)}`}
          </p>
          <p className="whitespace-pre-wrap">{dispute.description}</p>
          {dispute.sellerProposal !== null && (
            <p>
              <span className="text-ink-muted">{t('sellerDisputes.yourOffer')}: </span>
              {t(`disputes.remedy.${dispute.sellerProposal.resolution}` as TranslationKey)}
              {dispute.sellerProposal.amount !== null && ` · ${formatMoney(dispute.sellerProposal.amount)}`}
            </p>
          )}
          <div>
            <p className="font-medium text-ink">{t('disputes.evidenceTitle')}</p>
            <EvidenceTimeline surface="SELLER" dispute={dispute} />
          </div>
          {dispute.can.addEvidence && (
            <label className="block text-sm">
              <span className="font-medium text-ink">{t('sellerDisputes.addEvidence')}</span>
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

        <Card title={t('disputes.decisionTitle')} bodyClassName="space-y-4 px-5 py-4">
          <DecisionBlock dispute={dispute} />
          {dispute.can.respond === true && (
            <RespondForm
              dispute={dispute}
              busy={respond.isPending}
              onSubmit={(input) => { respond.mutate(input); }}
            />
          )}
        </Card>
        <InspectionCard dispute={dispute} />
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

/**
 * The dispute resolution console (checklist Master row 64).
 *
 *   /disputes      the queue: claims and chargebacks, filter by status, search
 *   /disputes/:id  one dispute: both sides, evidence, SLA, money, the thread,
 *                  and the decision - which a refund above the threshold sends
 *                  to a second approver
 *
 * Every rule is the server's. What the signed-in person may do comes from the
 * dispute's own `can` block, and the preview of a decision's money comes from
 * `decision-preview` - this screen computes no amount.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, EmptyState, ErrorState, Input, LoadingState, PageHeader, Select, Textarea } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { formatDateTime, formatMoney, type Money } from '@/lib/format';

interface QueueRow {
  id: string;
  reference: string;
  kind: string;
  status: string;
  reasonCode: string | null;
  orderNumber: string;
  sellerName: string | null;
  requestedAmount: Money | null;
  disputedAmount: Money | null;
  assignee: { fullName?: string; email?: string } | null;
  lastActivityAt: string;
}

interface CaseView {
  id: string;
  reference: string;
  kind: string;
  status: string;
  reasonCode: string | null;
  description: string;
  desiredOutcome: string | null;
  requestedAmount: Money | null;
  currency: string;
  order: { id: string | null; orderNumber: string; paid: Money | null; refunded: Money | null; maxRefundable: Money | null };
  buyer: { name: string; email: string };
  seller: { displayName?: string } | null;
  sellerProposal: { resolution: string; amount: Money | null } | null;
  decision: { resolution: string; amount: Money | null; reason: string | null } | null;
  attachments: { id: string; fileName: string }[];
  events: { id: string; kind: string; party: string; body: string | null; createdAt: string }[];
  can: { manage: boolean; note: boolean; decide: boolean; approve: boolean; assign: boolean };
}

const RESOLUTIONS = ['REFUND_FULL', 'REFUND_PARTIAL', 'REPLACEMENT', 'REJECT'] as const;
const STATUS_FILTERS = ['OPEN', 'AWAITING_SELLER', 'UNDER_REVIEW', 'PENDING_APPROVAL', 'APPEALED', 'RESOLVED', 'REJECTED'] as const;

/** The queue. */
export function DisputeQueuePage(): React.JSX.Element {
  const { t } = useI18n();
  const [status, setStatus] = useState<string>('OPEN');
  const [search, setSearch] = useState('');
  const query = useQuery({
    queryKey: ['admin', 'disputes', status, search],
    queryFn: () =>
      api.get<{ disputes: QueueRow[]; counts: Record<string, number> }>('/admin/disputes', {
        query: { status, ...(search.trim() === '' ? {} : { search: search.trim() }) },
      }),
  });

  return (
    <>
      <PageHeader title={t('disputes.queueTitle')} description={t('disputes.queueDescription')} />
      <div className="mb-4 flex flex-wrap gap-3">
        <Select aria-label={t('disputes.statusFilter')} value={status} onChange={(event) => { setStatus(event.target.value); }}>
          {STATUS_FILTERS.map((value) => (
            <option key={value} value={value}>
              {value === 'OPEN' ? t('disputes.filterOpen') : t(`disputes.status.${value}` as TranslationKey)}
            </option>
          ))}
        </Select>
        <Input
          aria-label={t('disputes.search')}
          placeholder={t('disputes.search')}
          value={search}
          onChange={(event) => { setSearch(event.target.value); }}
        />
      </div>
      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => { void query.refetch(); }} />
      ) : query.data.disputes.length === 0 ? (
        <EmptyState title={t('disputes.queueEmpty')} />
      ) : (
        <Card bodyClassName="divide-y divide-border-subtle">
          {query.data.disputes.map((row) => (
            <div key={row.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
              <div className="min-w-0">
                <Link to={`/disputes/${row.id}`} className="font-medium text-brand hover:underline">
                  {row.reference}
                </Link>
                <p className="text-xs text-ink-muted">
                  {[row.orderNumber, row.sellerName, row.kind, formatDateTime(row.lastActivityAt)].filter(Boolean).join(' · ')}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs">{formatMoney(row.requestedAmount ?? row.disputedAmount)}</span>
                <Badge>{t(`disputes.status.${row.status}` as TranslationKey)}</Badge>
              </div>
            </div>
          ))}
        </Card>
      )}
    </>
  );
}

/** One dispute. */
export function DisputeCasePage(): React.JSX.Element {
  const { id = '' } = useParams();
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const key = ['admin', 'dispute', id];
  const query = useQuery({ queryKey: key, queryFn: () => api.get<{ dispute: CaseView }>(`/admin/disputes/${id}`) });
  const [message, setMessage] = useState('');
  const [audience, setAudience] = useState<'BUYER' | 'SELLER' | 'BOTH'>('BOTH');
  const [resolution, setResolution] = useState<(typeof RESOLUTIONS)[number]>('REFUND_FULL');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');

  const preview = useQuery({
    queryKey: [...key, 'preview', resolution, amount],
    queryFn: () =>
      api.get<{ amount?: Money | null; needsApproval?: boolean }>(`/admin/disputes/${id}/decision-preview`, {
        query: { resolution, ...(amount.trim() === '' ? {} : { amountMinor: amount.trim() }) },
      }),
    enabled: query.data?.dispute.can.decide === true,
  });

  const done = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['admin', 'dispute', id] });
    await queryClient.invalidateQueries({ queryKey: ['admin', 'disputes'] });
  };
  const run = useMutation({
    mutationFn: (step: { path: string; body?: unknown }) => api.post(`/admin/disputes/${id}/${step.path}`, step.body),
    onSuccess: async () => {
      setMessage('');
      setReason('');
      toast.success(t('disputes.saved'));
      await done();
    },
    onError: (failure) => { toast.error(errorMessage(t, failure)); },
  });

  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => { void query.refetch(); }} />;
  const d = query.data.dispute;
  const busy = run.isPending;

  return (
    <>
      <PageHeader
        title={d.reference}
        description={`${d.order.orderNumber} · ${d.kind}`}
        back={{ to: '/disputes', label: t('disputes.queueTitle') }}
        meta={<Badge>{t(`disputes.status.${d.status}` as TranslationKey)}</Badge>}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t('disputes.claimTitle')} bodyClassName="space-y-2 px-5 py-4 text-sm">
          <p>{t('disputes.buyerLine', { name: d.buyer.name, email: d.buyer.email })}</p>
          {d.seller?.displayName !== undefined && <p>{t('disputes.sellerLine', { name: d.seller.displayName })}</p>}
          <p>{t('disputes.askedFor', { outcome: d.desiredOutcome ?? '—', amount: formatMoney(d.requestedAmount) })}</p>
          <p className="whitespace-pre-wrap">{d.description}</p>
          <p className="text-ink-muted">
            {t('disputes.moneyLine', {
              paid: formatMoney(d.order.paid),
              refunded: formatMoney(d.order.refunded),
              max: formatMoney(d.order.maxRefundable),
            })}
          </p>
          {d.sellerProposal !== null && (
            <p>{t('disputes.sellerOffered', { outcome: d.sellerProposal.resolution, amount: formatMoney(d.sellerProposal.amount) })}</p>
          )}
          {d.attachments.length > 0 && <p className="text-ink-muted">{d.attachments.map((file) => file.fileName).join(', ')}</p>}
        </Card>

        <Card title={t('disputes.decisionTitle')} bodyClassName="space-y-3 px-5 py-4 text-sm">
          {d.decision !== null && (
            <p className="font-medium">
              {d.decision.resolution} · {formatMoney(d.decision.amount)} {d.decision.reason !== null && `— ${d.decision.reason}`}
            </p>
          )}
          {d.status === 'AWAITING_SELLER' && d.can.manage && (
            <Button variant="secondary" disabled={busy} onClick={() => { run.mutate({ path: 'review' }); }}>
              {t('disputes.startReview')}
            </Button>
          )}
          {d.can.decide && (
            <div className="space-y-2">
              <Select aria-label={t('disputes.resolutionLabel')} value={resolution} onChange={(event) => { setResolution(event.target.value as (typeof RESOLUTIONS)[number]); }}>
                {RESOLUTIONS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
              {resolution === 'REFUND_PARTIAL' && (
                <Input aria-label={t('disputes.amountMinorLabel')} placeholder={t('disputes.amountMinorLabel')} value={amount} onChange={(event) => { setAmount(event.target.value); }} />
              )}
              <Textarea aria-label={t('disputes.reasonRequired')} placeholder={t('disputes.reasonRequired')} rows={3} value={reason} onChange={(event) => { setReason(event.target.value); }} />
              {preview.data !== undefined && (
                <p className="text-xs text-ink-muted">
                  {t('disputes.previewLine', { amount: formatMoney(preview.data.amount ?? null) })}
                  {preview.data.needsApproval === true && ` ${t('disputes.needsApproval')}`}
                </p>
              )}
              <Button
                variant="primary"
                disabled={busy || reason.trim().length < 10}
                onClick={() => {
                  run.mutate({
                    path: 'decision',
                    body: { resolution, amountMinor: amount.trim() === '' ? null : amount.trim(), reason: reason.trim() },
                  });
                }}
              >
                {t('disputes.decide')}
              </Button>
            </div>
          )}
          {d.can.approve && (
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" disabled={busy} onClick={() => { run.mutate({ path: 'decision/approve' }); }}>
                {t('disputes.approve')}
              </Button>
              <Button
                variant="secondary"
                disabled={busy || reason.trim().length < 10}
                onClick={() => { run.mutate({ path: 'decision/refuse', body: { reason: reason.trim() } }); }}
              >
                {t('disputes.refuse')}
              </Button>
            </div>
          )}
        </Card>
      </div>

      <Card title={t('disputes.threadTitle')} className="mt-4" bodyClassName="space-y-3 px-5 py-4 text-sm">
        <ol className="space-y-3">
          {d.events.map((event) => (
            <li key={event.id}>
              <p className="text-xs text-ink-muted">
                {event.party} · {event.kind} · {formatDateTime(event.createdAt)}
              </p>
              {event.body !== null && <p className="whitespace-pre-wrap">{event.body}</p>}
            </li>
          ))}
        </ol>
        {(d.can.manage || d.can.note) && (
          <div className="space-y-2">
            <Textarea aria-label={t('disputes.messageLabel')} rows={3} value={message} onChange={(event) => { setMessage(event.target.value); }} />
            <div className="flex flex-wrap items-center gap-2">
              {d.can.manage && (
                <>
                  <Select aria-label={t('disputes.audience')} value={audience} onChange={(event) => { setAudience(event.target.value as 'BUYER' | 'SELLER' | 'BOTH'); }}>
                    <option value="BOTH">{t('disputes.toBoth')}</option>
                    <option value="BUYER">{t('disputes.toBuyer')}</option>
                    <option value="SELLER">{t('disputes.toSeller')}</option>
                  </Select>
                  <Button variant="primary" disabled={busy || message.trim() === ''} onClick={() => { run.mutate({ path: 'messages', body: { body: message.trim(), audience } }); }}>
                    {t('disputes.sendMessage')}
                  </Button>
                </>
              )}
              {d.can.note && (
                <Button variant="secondary" disabled={busy || message.trim() === ''} onClick={() => { run.mutate({ path: 'notes', body: { body: message.trim(), kind: 'INTERNAL_NOTE' } }); }}>
                  {t('disputes.addNote')}
                </Button>
              )}
            </div>
          </div>
        )}
      </Card>
    </>
  );
}

/**
 * The dispute resolution console (checklist Master row 64, JOURNEY-058).
 *
 *   /disputes      the queue: claims and chargebacks, filter by status, search
 *   /disputes/:id  one dispute: both sides, the evidence timeline (each file
 *                  downloadable, staff may add their own), the inspection
 *                  report behind the claim, the payment, any chargeback and
 *                  the seller money held for it, deadlines, who may decide,
 *                  the assignee, the thread, and the decision - which a
 *                  refund above the threshold sends to a second approver
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
import { api, downloadFile } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { currencyExponent, formatDateTime, formatMoney, humanise, minorToMajor, type Money } from '@/lib/format';

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
  order: { id: string | null; orderNumber: string; status?: string; paid: Money | null; refunded: Money | null; maxRefundable: Money | null };
  payment?: { provider: string; status: string; disputedAt: string | null; amount: Money | null } | null;
  openChargeback?: { id: string; reference: string; status: string; providerStatus: string | null; evidenceDueAt: string | null } | null;
  chargeback?: { providerDisputeId: string | null; providerStatus: string | null; disputedAmount: Money | null; evidenceDueAt: string | null } | null;
  fundHolds?: {
    sellerOrderGroupId: string;
    sellerName: string | null;
    status: string;
    allocated: Money;
    released: Money;
    holdCode: string | null;
    holdReason: string | null;
    holdPlacedAt: string | null;
    releasedAt: string | null;
  }[];
  inspection?: {
    requirementId: string | null;
    sellerOrderGroupId: string;
    status: string;
    reports: { id: string; revision: number; status: string; result: string; signedAt: string | null }[];
    linkPath: string | null;
  }[];
  buyer: { name: string; email: string };
  seller: { displayName?: string } | null;
  sellerProposal: { resolution: string; amount: Money | null } | null;
  proposal?: {
    resolution: string | null;
    amount: Money | null;
    reason: string | null;
    proposedBy: { id: string; email: string | null } | null;
    proposedAt: string | null;
  } | null;
  decision: {
    resolution: string;
    amount: Money | null;
    reason: string | null;
    decidedBy?: { id: string; email: string | null } | null;
    approvedBy?: { id: string; email: string | null } | null;
  } | null;
  assignee?: { id: string; email: string } | null;
  sla?: {
    sellerResponseDueAt: string | null;
    sellerResponseBreached: boolean;
    decisionDueAt: string | null;
    decisionBreached: boolean;
    evidenceDueAt: string | null;
    evidenceBreached: boolean;
    appealDueAt: string | null;
  };
  appealCount?: number;
  approval?: { thresholdMinor: string; currency: string };
  attachments: { id: string; fileName: string; party?: string; kind?: string; byteSize?: number; createdAt?: string }[];
  events: {
    id: string;
    kind: string;
    party: string;
    body: string | null;
    toValue?: string | null;
    amount?: Money | null;
    actor?: { id: string; email: string } | null;
    visibleToBuyer?: boolean;
    visibleToSeller?: boolean;
    createdAt: string;
  }[];
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

/** Ask for a five-minute, single-use link to one file, then download it. */
async function downloadEvidence(disputeId: string, file: { id: string; fileName: string }): Promise<void> {
  const link = await api.post<{ url: string }>(`/admin/disputes/${disputeId}/attachments/${file.id}/link`);
  await downloadFile(link.url.replace(/^\/api\/v1/, ''), file.fileName);
}

function sizeOf(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  if (bytes < 1024 * 1024) return `${String(Math.max(1, Math.round(bytes / 1024)))} KB`;
  return `${(bytes / 1_048_576).toFixed(1).replace(/\.0$/, '')} MB`;
}

/** A deadline line, marked when it has passed. */
function Deadline({ label, at, breached }: { label: string; at: string | null; breached: boolean }): React.JSX.Element | null {
  const { t } = useI18n();
  if (at === null) return null;
  return (
    <p className="flex flex-wrap items-center gap-2">
      <span className="text-ink-muted">{label}:</span>
      <span className="tabular">{formatDateTime(at)}</span>
      {breached && <Badge tone="danger">{t('disputes.console.breached')}</Badge>}
    </p>
  );
}

/** The payment, any chargeback against it, and the seller money held. */
function MoneyPanel({ d }: { d: CaseView }): React.JSX.Element {
  const { t } = useI18n();
  const chargeback = d.chargeback ?? null;
  const open = d.openChargeback ?? null;
  const holds = d.fundHolds ?? [];
  return (
    <Card title={t('disputes.console.moneyTitle')} bodyClassName="space-y-2 px-5 py-4 text-sm">
      {d.payment === undefined || d.payment === null ? (
        <p className="text-ink-muted">{t('disputes.console.noPayment')}</p>
      ) : (
        <p>
          {t('disputes.console.paymentLine', {
            provider: d.payment.provider,
            status: humanise(d.payment.status),
            amount: formatMoney(d.payment.amount),
          })}
          {d.payment.disputedAt !== null && ` · ${t('disputes.console.disputedAt', { at: formatDateTime(d.payment.disputedAt) })}`}
        </p>
      )}
      {chargeback !== null && (
        <p>
          {t('disputes.console.chargebackLine', {
            status: chargeback.providerStatus ?? '—',
            amount: formatMoney(chargeback.disputedAmount),
            due: formatDateTime(chargeback.evidenceDueAt),
          })}
        </p>
      )}
      {open !== null && (
        <p className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-warning">
          {t('disputes.console.openChargeback', {
            reference: open.reference,
            status: open.providerStatus ?? humanise(open.status),
            due: formatDateTime(open.evidenceDueAt),
          })}{' '}
          <Link to={`/disputes/${open.id}`} className="font-medium underline">
            {t('disputes.console.openIt')}
          </Link>
        </p>
      )}
      <div>
        <p className="font-medium text-ink">{t('disputes.console.holdsTitle')}</p>
        {holds.length === 0 ? (
          <p className="text-ink-muted">{t('disputes.console.noHolds')}</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {holds.map((hold) => (
              <li key={hold.sellerOrderGroupId} className="flex flex-wrap items-center gap-2">
                <Badge tone={hold.status === 'ON_HOLD' ? 'warning' : hold.status === 'RELEASED' ? 'success' : 'neutral'}>
                  {humanise(hold.status)}
                </Badge>
                <span>
                  {[hold.sellerName, formatMoney(hold.allocated), hold.holdCode === null ? null : humanise(hold.holdCode), hold.holdReason]
                    .filter((part) => part !== null && part !== '')
                    .join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

/** The inspection reports behind the claim: a rating or a claim never replaces them. */
function InspectionPanel({ d }: { d: CaseView }): React.JSX.Element {
  const { t } = useI18n();
  const rows = d.inspection ?? [];
  return (
    <Card title={t('disputes.console.inspectionTitle')} bodyClassName="space-y-2 px-5 py-4 text-sm">
      {rows.length === 0 ? (
        <p className="text-ink-muted">{t('disputes.console.noInspection')}</p>
      ) : (
        rows.map((row) => (
          <div key={row.sellerOrderGroupId} className="space-y-1">
            <p className="flex flex-wrap items-center gap-2">
              <Badge>{humanise(row.status)}</Badge>
              {row.linkPath !== null && (
                <Link to={row.linkPath} className="font-medium text-brand hover:underline">
                  {t('disputes.console.openInspection')}
                </Link>
              )}
            </p>
            {row.reports.length === 0 ? (
              <p className="text-ink-muted">{t('disputes.console.noReport')}</p>
            ) : (
              <ul className="space-y-0.5">
                {row.reports.map((report) => (
                  <li key={report.id} className="flex flex-wrap items-center gap-2">
                    <span>{t('disputes.console.reportRevision', { revision: String(report.revision) })}</span>
                    <Badge>{humanise(report.status)}</Badge>
                    <Badge tone={report.result === 'PASS' ? 'success' : 'danger'}>{humanise(report.result)}</Badge>
                    {report.signedAt !== null && <span className="text-xs text-ink-muted">{formatDateTime(report.signedAt)}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))
      )}
    </Card>
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
  const assignees = useQuery({
    queryKey: ['admin', 'disputes', 'assignees'],
    queryFn: () => api.get<{ assignees: { id: string; email: string }[] }>('/admin/disputes/assignees'),
    enabled: query.data?.dispute.can.assign === true,
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
  const upload = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return api.upload(`/admin/disputes/${id}/attachments`, form);
    },
    onSuccess: async () => {
      toast.success(t('disputes.console.uploaded'));
      await done();
    },
    onError: (failure) => { toast.error(errorMessage(t, failure)); },
  });
  const download = useMutation({
    mutationFn: (file: { id: string; fileName: string }) => downloadEvidence(id, file),
    onError: (failure) => { toast.error(errorMessage(t, failure)); },
  });

  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => { void query.refetch(); }} />;
  const d = query.data.dispute;
  const busy = run.isPending;
  const threshold =
    d.approval === undefined
      ? null
      : formatMoney({
          minor: d.approval.thresholdMinor,
          formatted: minorToMajor(d.approval.thresholdMinor, currencyExponent(d.approval.currency)),
          currency: d.approval.currency,
        });

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
        </Card>

        <Card title={t('disputes.console.caseTitle')} bodyClassName="space-y-2 px-5 py-4 text-sm">
          {d.sla !== undefined && (
            <>
              <Deadline label={t('disputes.console.sellerDue')} at={d.sla.sellerResponseDueAt} breached={d.sla.sellerResponseBreached} />
              <Deadline label={t('disputes.console.decisionDue')} at={d.sla.decisionDueAt} breached={d.sla.decisionBreached} />
              <Deadline label={t('disputes.console.evidenceDue')} at={d.sla.evidenceDueAt} breached={d.sla.evidenceBreached} />
              <Deadline label={t('disputes.console.appealDue')} at={d.sla.appealDueAt} breached={false} />
            </>
          )}
          {d.appealCount !== undefined && d.appealCount > 0 && (
            <p><Badge tone="warning">{t('disputes.console.appealed')}</Badge></p>
          )}
          {threshold !== null && <p className="text-ink-muted">{t('disputes.console.authority', { amount: threshold })}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-ink-muted">{t('disputes.console.assignee')}:</span>
            {d.can.assign ? (
              <Select
                aria-label={t('disputes.console.assignee')}
                value={d.assignee?.id ?? ''}
                disabled={busy || assignees.isPending}
                onChange={(event) => {
                  run.mutate({ path: 'assignment', body: { assigneeUserId: event.target.value === '' ? null : event.target.value } });
                }}
              >
                <option value="">{t('disputes.console.unassigned')}</option>
                {d.assignee !== undefined && d.assignee !== null && !(assignees.data?.assignees ?? []).some((user) => user.id === d.assignee?.id) && (
                  <option value={d.assignee.id}>{d.assignee.email}</option>
                )}
                {(assignees.data?.assignees ?? []).map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.email}
                  </option>
                ))}
              </Select>
            ) : (
              <span>{d.assignee?.email ?? t('disputes.console.unassigned')}</span>
            )}
          </div>
        </Card>

        <MoneyPanel d={d} />
        <InspectionPanel d={d} />

        <Card title={t('disputes.console.evidenceTitle')} bodyClassName="space-y-3 px-5 py-4 text-sm">
          {d.attachments.length === 0 ? (
            <p className="text-ink-muted">{t('disputes.console.noEvidence')}</p>
          ) : (
            <ol className="space-y-2 border-l border-border-subtle pl-4">
              {d.attachments.map((file) => (
                <li key={file.id}>
                  <p className="text-xs text-ink-muted">
                    {[file.party === undefined ? null : humanise(file.party), file.createdAt === undefined ? null : formatDateTime(file.createdAt), sizeOf(file.byteSize)]
                      .filter((part) => part !== null && part !== '')
                      .join(' · ')}
                  </p>
                  <button
                    type="button"
                    className="font-medium text-brand hover:underline disabled:opacity-60"
                    disabled={download.isPending}
                    onClick={() => { download.mutate(file); }}
                  >
                    {t('disputes.console.download', { name: file.fileName })}
                  </button>
                </li>
              ))}
            </ol>
          )}
          {d.can.note && (
            <label className="block text-sm">
              <span className="font-medium text-ink">{t('disputes.console.addEvidence')}</span>
              <span className="block text-xs text-ink-muted">{t('disputes.console.addEvidenceHint')}</span>
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

        <Card title={t('disputes.decisionTitle')} bodyClassName="space-y-3 px-5 py-4 text-sm">
          {d.proposal !== undefined && d.proposal !== null && (
            <p className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-warning">
              {t('disputes.console.pendingProposal', {
                outcome: d.proposal.resolution ?? '—',
                amount: formatMoney(d.proposal.amount),
                by: d.proposal.proposedBy?.email ?? '—',
              })}
              {d.proposal.reason !== null && ` — ${d.proposal.reason}`}
            </p>
          )}
          {d.decision !== null && (
            <div className="space-y-1">
              <p className="font-medium">
                {d.decision.resolution} · {formatMoney(d.decision.amount)} {d.decision.reason !== null && `— ${d.decision.reason}`}
              </p>
              {(d.decision.decidedBy ?? null) !== null && (
                <p className="text-xs text-ink-muted">
                  {t('disputes.console.decidedBy', { email: d.decision.decidedBy?.email ?? '—' })}
                  {(d.decision.approvedBy ?? null) !== null && ` · ${t('disputes.console.approvedBy', { email: d.decision.approvedBy?.email ?? '—' })}`}
                </p>
              )}
            </div>
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
                {[
                  event.party,
                  humanise(event.kind),
                  event.actor?.email ?? null,
                  event.toValue ?? null,
                  event.amount === undefined || event.amount === null ? null : formatMoney(event.amount),
                  formatDateTime(event.createdAt),
                ]
                  .filter((part) => part !== null && part !== '')
                  .join(' · ')}
                {event.visibleToBuyer === false && event.visibleToSeller === false && (
                  <> · <Badge>{t('disputes.console.internal')}</Badge></>
                )}
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

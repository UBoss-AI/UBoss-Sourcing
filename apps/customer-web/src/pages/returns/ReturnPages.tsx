/**
 * Returns and refunds for the buyer (checklist Master row 30).
 *
 *   /account/orders/:id/return  ask to return lines of a delivered order
 *   /account/returns            every return, newest first
 *   /account/returns/:id        one return: status, instructions, refund, timeline
 *
 * The server decides everything that matters - eligibility, the window, which
 * reasons need photographs, each status change and the refund. These screens
 * show its answers and send the buyer's request; they compute nothing.
 */
import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStorefront } from '@/app/storefront-context';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, EmptyState, ErrorState, Field, LoadingState, PageHeader, Select, Textarea, type BadgeTone } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { formatDateTime, formatMoney } from '@/lib/format';
import { newIdempotencyKey } from '@/lib/api';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import {
  createReturn,
  fetchReturn,
  fetchReturnEligibility,
  fetchReturns,
  returnKeys,
  type ReturnStatus,
  type ReturnSummary,
} from '@/lib/returns';

const STATUS_TONE: Record<ReturnStatus, BadgeTone> = {
  REQUESTED: 'action',
  APPROVED: 'brand',
  REJECTED: 'neutral',
  RECEIVED: 'operational',
  INSPECTED: 'operational',
  COMPLETED: 'success',
};

function StatusBadge({ status }: { status: ReturnStatus }): React.JSX.Element {
  const { t } = useI18n();
  return <Badge tone={STATUS_TONE[status]}>{t(`returns.status.${status}` as TranslationKey)}</Badge>;
}

function reasonLabel(t: (key: TranslationKey) => string, code: string | null): string {
  return code === null ? t('returns.reason.OTHER') : t(`returns.reason.${code}` as TranslationKey);
}

/** Ask to return lines of one delivered order. */
export function ReturnRequestPage(): React.JSX.Element {
  const { business } = useStorefront();
  const { id = '' } = useParams();
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  useDocumentMeta({ title: t('returns.requestTitle'), noIndex: true }, business.displayName);

  const eligibility = useQuery({ queryKey: returnKeys.eligibility(id), queryFn: () => fetchReturnEligibility(id) });
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [reasonCode, setReasonCode] = useState('');
  const [description, setDescription] = useState('');
  const [resolution, setResolution] = useState<'REFUND' | 'REPLACEMENT'>('REFUND');
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newIdempotencyKey());

  const submit = useMutation({
    mutationFn: () =>
      createReturn(
        id,
        {
          reasonCode,
          description: description.trim() === '' ? null : description.trim(),
          preferredResolution: resolution,
          items: Object.entries(quantities)
            .filter(([, quantity]) => quantity > 0)
            .map(([orderItemId, quantity]) => ({ orderItemId, quantity })),
        },
        files,
        key.current,
      ),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: returnKeys.list });
      toast.success(t('returns.sent'));
      void navigate(`/account/returns/${result.return.id}`);
    },
    onError: (failure) => {
      setError(errorMessage(t, failure));
    },
  });

  if (eligibility.isPending) return <LoadingState />;
  if (eligibility.isError) return <ErrorState error={eligibility.error} onRetry={() => { void eligibility.refetch(); }} />;

  const view = eligibility.data;
  const back = (
    <Link to={`/account/orders/${id}`} className="text-sm font-medium text-brand hover:underline">
      {t('returns.backToOrder')}
    </Link>
  );

  if (!view.eligible) {
    return (
      <>
        <PageHeader title={t('returns.requestTitle')} actions={back} />
        <EmptyState
          title={t('returns.notEligibleTitle')}
          description={t(`returns.notEligible.${view.reason ?? 'NOTHING_LEFT'}` as TranslationKey)}
        />
      </>
    );
  }

  const chosen = Object.values(quantities).some((quantity) => quantity > 0);
  const needsPhotos = view.evidenceRequired.includes(reasonCode);
  const canSend = chosen && reasonCode !== '' && (!needsPhotos || files.length > 0) && !submit.isPending;

  return (
    <>
      <PageHeader
        title={t('returns.requestTitle')}
        description={t('returns.requestDescription', { order: view.orderNumber, days: String(view.windowDays) })}
        actions={back}
      />
      <div className="space-y-4">
        <Card title={t('returns.whatTitle')} bodyClassName="px-5 py-4">
          <ul className="divide-y divide-border-subtle">
            {view.groups.flatMap((group) =>
              group.lines.map((line) => (
                <li key={line.orderItemId} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="font-medium text-ink">{line.name}</p>
                    <p className="text-xs text-ink-muted">
                      {[line.variantName, line.sku, group.sellerName].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  {group.open && line.returnable > 0 ? (
                    <label className="flex items-center gap-2 text-sm">
                      <span>{t('returns.quantity', { max: String(line.returnable) })}</span>
                      <input
                        type="number"
                        min={0}
                        max={line.returnable}
                        value={quantities[line.orderItemId] ?? 0}
                        aria-label={t('returns.quantityFor', { name: line.name })}
                        className="w-20 rounded-md border border-border-strong px-2 py-1 text-sm"
                        onChange={(event) => {
                          const next = Math.max(0, Math.min(line.returnable, Math.floor(Number(event.target.value) || 0)));
                          setQuantities((current) => ({ ...current, [line.orderItemId]: next }));
                        }}
                      />
                    </label>
                  ) : (
                    <span className="text-xs text-ink-muted">{t('returns.lineClosed')}</span>
                  )}
                </li>
              )),
            )}
          </ul>
        </Card>

        <Card title={t('returns.whyTitle')} bodyClassName="space-y-4 px-5 py-4">
          <Field label={t('returns.reasonLabel')} required>
            {({ inputId, describedBy }) => (
              <Select
              id={inputId}
              aria-describedby={describedBy}
              value={reasonCode}
              onChange={(event) => {
                setReasonCode(event.target.value);
              }}
            >
              <option value="">{t('returns.chooseReason')}</option>
              {view.reasonCodes.map((code) => (
                <option key={code} value={code}>
                  {reasonLabel(t, code)}
                </option>
              ))}
            </Select>
            )}
          </Field>
          <Field label={t('returns.descriptionLabel')}>
            {({ inputId, describedBy }) => (
              <Textarea
              id={inputId}
              aria-describedby={describedBy}
              maxLength={512}
              rows={3}
              value={description}
              onChange={(event) => {
                setDescription(event.target.value);
              }}
            />
            )}
          </Field>
          {view.files.available && (
            <Field
              label={needsPhotos ? t('returns.photosRequired') : t('returns.photosOptional')}
              hint={t('returns.photosHint', { files: String(view.files.maxFiles) })}
            >
              {({ inputId, describedBy }) => (
                <input
                id={inputId}
                aria-describedby={describedBy}
                type="file"
                multiple
                accept={view.files.types.join(',')}
                className="block w-full text-sm"
                onChange={(event) => {
                  setFiles(Array.from(event.target.files ?? []).slice(0, view.files.maxFiles));
                }}
              />
              )}
            </Field>
          )}
          {view.replacementEnabled && (
            <fieldset className="space-y-2 text-sm">
              <legend className="font-medium text-ink">{t('returns.resolutionLabel')}</legend>
              {(['REFUND', 'REPLACEMENT'] as const).map((option) => (
                <label key={option} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="resolution"
                    checked={resolution === option}
                    onChange={() => {
                      setResolution(option);
                    }}
                  />
                  {t(`returns.resolution.${option}`)}
                </label>
              ))}
            </fieldset>
          )}
        </Card>

        {error !== null && (
          <p role="alert" className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger">
            {error}
          </p>
        )}
        <Button
          variant="primary"
          disabled={!canSend}
          isLoading={submit.isPending}
          onClick={() => {
            setError(null);
            submit.mutate();
          }}
        >
          {t('returns.send')}
        </Button>
      </div>
    </>
  );
}

/** Every return the buyer has asked for. */
export function ReturnsPage(): React.JSX.Element {
  const { business } = useStorefront();
  const { t } = useI18n();
  useDocumentMeta({ title: t('returns.listTitle'), noIndex: true }, business.displayName);
  const query = useQuery({ queryKey: returnKeys.list, queryFn: fetchReturns });

  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => { void query.refetch(); }} />;

  return (
    <>
      <PageHeader title={t('returns.listTitle')} description={t('returns.listDescription')} />
      {query.data.length === 0 ? (
        <EmptyState title={t('returns.emptyTitle')} description={t('returns.emptyBody')} />
      ) : (
        <Card bodyClassName="px-5 py-2">
          <ul className="divide-y divide-border-subtle">
            {query.data.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <Link to={`/account/returns/${item.id}`} className="font-medium text-brand hover:underline">
                    {item.reference}
                  </Link>
                  <p className="text-xs text-ink-muted">
                    {t('returns.forOrder', { order: item.orderNumber })} · {formatDateTime(item.createdAt)}
                  </p>
                </div>
                <StatusBadge status={item.status} />
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-subtle">{label}</dt>
      <dd className="mt-1 whitespace-pre-wrap break-words text-sm text-ink">{children}</dd>
    </div>
  );
}

function RefundBlock({ item }: { item: ReturnSummary }): React.JSX.Element {
  const { t } = useI18n();
  // Where the money goes and when, said before it happens (JOURNEY-025). No
  // number of days is promised: the deployment has no refund-time setting to
  // keep, and the bank's part is outside it.
  const method = <p className="mt-1 text-xs text-ink-muted">{t('returns.refundMethod')}</p>;
  if (item.refund === null) {
    return (
      <>
        <p className="text-sm text-ink-muted">{t('returns.noRefundYet')}</p>
        {method}
      </>
    );
  }
  return (
    <>
      <p className="text-sm text-ink">
        {t('returns.refundLine', { amount: formatMoney(item.refund.amount), status: item.refund.status })}
      </p>
      {method}
    </>
  );
}

/** One return: where it is, what to do next, and the refund. */
export function ReturnDetailPage(): React.JSX.Element {
  const { business } = useStorefront();
  const { id = '' } = useParams();
  const { t } = useI18n();
  const query = useQuery({ queryKey: returnKeys.one(id), queryFn: () => fetchReturn(id) });
  useDocumentMeta({ title: query.data?.reference ?? t('returns.listTitle'), noIndex: true }, business.displayName);

  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => { void query.refetch(); }} />;
  const item = query.data;

  return (
    <>
      <PageHeader
        title={item.reference}
        description={t('returns.forOrder', { order: item.orderNumber })}
        actions={
          <Link to="/account/returns" className="text-sm font-medium text-brand hover:underline">
            {t('returns.backToList')}
          </Link>
        }
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t('returns.summaryTitle')} bodyClassName="px-5 py-4">
          <dl className="space-y-4">
            <Row label={t('returns.statusLabel')}>
              <StatusBadge status={item.status} />
            </Row>
            <Row label={t('returns.reasonLabel')}>{reasonLabel(t, item.reasonCode)}</Row>
            {item.description !== '' && <Row label={t('returns.descriptionLabel')}>{item.description}</Row>}
            <Row label={t('returns.itemsLabel')}>
              {item.lines.map((line) => `${String(line.quantity)} × ${line.name}`).join('\n')}
            </Row>
            <Row label={t('returns.valueLabel')}>{formatMoney(item.value)}</Row>
            {item.files.length > 0 && (
              <Row label={t('returns.filesLabel')}>{item.files.map((file) => file.fileName).join(', ')}</Row>
            )}
          </dl>
        </Card>
        <div className="space-y-4">
          <Card title={t('returns.nextTitle')} bodyClassName="space-y-3 px-5 py-4 text-sm">
            {item.returnInstructions !== null && <p className="whitespace-pre-wrap">{item.returnInstructions}</p>}
            {item.decisionNote !== null && <p className="whitespace-pre-wrap text-ink-muted">{item.decisionNote}</p>}
            {item.returnInstructions === null && item.decisionNote === null && (
              <p className="text-ink-muted">{t(`returns.next.${item.status}` as TranslationKey)}</p>
            )}
          </Card>
          <Card title={t('returns.refundTitle')} bodyClassName="px-5 py-4">
            <RefundBlock item={item} />
          </Card>
          <Card title={t('returns.timelineTitle')} bodyClassName="px-5 py-4">
            <ol className="space-y-2 text-sm">
              {item.timeline.map((entry, index) => (
                <li key={`${entry.createdAt}-${String(index)}`} className="flex flex-wrap justify-between gap-2">
                  <span>
                    {entry.toStatus === null
                      ? entry.kind
                      : t(`returns.status.${entry.toStatus}` as TranslationKey)}
                    {entry.note !== null && <span className="text-ink-muted"> — {entry.note}</span>}
                  </span>
                  <span className="text-xs text-ink-muted">{formatDateTime(entry.createdAt)}</span>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
    </>
  );
}

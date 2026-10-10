/**
 * Shipment Assessment between L1 and L2, for the seller and the buyer.
 *
 * The seller sees the decision, the findings and the documents, can send
 * readiness information and evidence, and answer a corrective action. It
 * cannot change a finding or approve its own shipment.
 * The buyer sees only the status, the dispatch deadline and the released
 * certificate or waiver - never the findings or the evidence.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, Input, Textarea } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import {
  assessmentKeys,
  downloadAssessmentDocument,
  fetchBuyerAssessments,
  fetchSellerAssessment,
  sendSellerResponse,
  uploadSellerEvidence,
  type AssessmentDocument,
} from '@/lib/shipment-assessment';

function DocumentRow({ doc, onDownload }: { doc: AssessmentDocument; onDownload: () => Promise<void> }): React.JSX.Element {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-1 text-sm">
      <span>
        {t(`shipmentAssessment.docKind.${doc.kind}` as TranslationKey)} · {doc.number} · {t(`shipmentAssessment.docStatus.${doc.status}` as TranslationKey)}
        {doc.dispatchBy !== null && ` · ${t('shipmentAssessment.dispatchBy', { date: formatDateTime(doc.dispatchBy) })}`}
      </span>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          setError(null);
          onDownload().catch((caught: unknown) => {
            setError(errorMessage(t, caught));
          });
        }}
      >
        {t('shipmentAssessment.download')}
      </Button>
      {error !== null && <span className="w-full text-xs text-danger">{error}</span>}
    </li>
  );
}

export function SellerShipmentAssessmentPanel({ sellerOrderId }: { sellerOrderId: string }): React.JSX.Element | null {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: assessmentKeys.seller(sellerOrderId), queryFn: () => fetchSellerAssessment(sellerOrderId) });
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState('');
  const refresh = () => queryClient.invalidateQueries({ queryKey: assessmentKeys.seller(sellerOrderId) });
  const respond = useMutation({
    mutationFn: (kind: 'readiness' | 'corrective') => sendSellerResponse(query.data?.assessment?.id ?? '', kind === 'readiness' ? { readinessNote: text } : { correctiveResponse: text }),
    onSuccess: async () => {
      setText('');
      await refresh();
    },
  });
  const upload = useMutation({
    mutationFn: () => uploadSellerEvidence(query.data?.assessment?.id ?? '', file as File, note),
    onSuccess: async () => {
      setFile(null);
      setNote('');
      await refresh();
    },
  });
  const a = query.data?.assessment ?? null;
  if (a === null) return null;
  const blocked = a.status === 'FAILED' || a.status === 'ON_HOLD' || a.status === 'REASSESSMENT_REQUIRED';
  const closed = a.status === 'DISPATCHED' || a.status === 'CANCELLED';
  const issues = a.checks.filter((check) => check.outcome === 'FAIL' || check.outcome === 'HOLD');
  const lastRound = a.rounds[a.rounds.length - 1];
  const sampled = lastRound !== undefined && lastRound.quantities.sampledQuantity !== null && lastRound.quantities.countedQuantity !== null && lastRound.quantities.sampledQuantity < lastRound.quantities.countedQuantity;
  return (
    <Card title={`${t('shipmentAssessment.title')} · ${a.number}`}>
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap gap-2">
          <Badge tone={blocked ? 'danger' : a.status === 'APPROVED_FOR_L2' || a.status === 'DISPATCHED' ? 'success' : 'neutral'}>{t(`shipmentAssessment.status.${a.status}` as TranslationKey)}</Badge>
          <Badge tone="neutral">{t(`shipmentAssessment.badge.${a.badge ?? 'NONE'}` as TranslationKey)}</Badge>
        </div>
        <p>{a.requirementReason}</p>
        {a.releaseDeadline !== null && <p>{t('shipmentAssessment.dispatchBy', { date: formatDateTime(a.releaseDeadline) })}</p>}
        {blocked && <p className="rounded-md border border-danger p-2">{t('shipmentAssessment.sellerBlocked')}</p>}
        {sampled && <p className="text-ink-muted">{t('shipmentAssessment.sampledShort')}</p>}
        {issues.length > 0 && (
          <ul className="list-disc pl-5">
            {issues.map((check) => (
              <li key={`${String(check.round)}-${check.itemCode}`}>
                {check.itemCode}: {t(`shipmentAssessment.outcome.${check.outcome}` as TranslationKey)} {check.note ?? ''}
              </li>
            ))}
          </ul>
        )}
        {lastRound?.correctiveAction != null && <p className="border-l-2 border-warning pl-3">{lastRound.correctiveAction}</p>}
        {a.documents.length > 0 && (
          <ul>
            {a.documents.map((doc) => (
              <DocumentRow key={doc.id} doc={doc} onDownload={() => downloadAssessmentDocument('SELLER', a.id, doc.id)} />
            ))}
          </ul>
        )}
        {!closed && (
          <div className="space-y-2 border-t border-border-subtle pt-3">
            <Textarea
              aria-label={blocked ? t('shipmentAssessment.correctiveResponse') : t('shipmentAssessment.readiness')}
              placeholder={blocked ? t('shipmentAssessment.correctiveResponse') : t('shipmentAssessment.readiness')}
              value={text}
              onChange={(event) => {
                setText(event.target.value);
              }}
            />
            <Button
              size="sm"
              disabled={text.trim().length < 3 || respond.isPending}
              onClick={() => {
                respond.mutate(blocked ? 'corrective' : 'readiness');
              }}
            >
              {t('shipmentAssessment.send')}
            </Button>
            {respond.isError && <p className="text-xs text-danger">{errorMessage(t, respond.error)}</p>}
            <div className="flex flex-wrap items-end gap-2">
              <Input
                type="file"
                accept="image/*,application/pdf"
                aria-label={t('shipmentAssessment.evidence')}
                onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null);
                }}
              />
              <Input
                aria-label={t('shipmentAssessment.note')}
                placeholder={t('shipmentAssessment.note')}
                value={note}
                onChange={(event) => {
                  setNote(event.target.value);
                }}
              />
              <Button
                size="sm"
                variant="secondary"
                disabled={file === null || upload.isPending}
                onClick={() => {
                  upload.mutate();
                }}
              >
                {t('shipmentAssessment.upload')}
              </Button>
            </div>
            {upload.isError && <p className="text-xs text-danger">{errorMessage(t, upload.error)}</p>}
          </div>
        )}
      </div>
    </Card>
  );
}

export function BuyerShipmentAssessments({ orderId }: { orderId: string }): React.JSX.Element | null {
  const { t } = useI18n();
  const query = useQuery({ queryKey: assessmentKeys.buyer(orderId), queryFn: () => fetchBuyerAssessments(orderId) });
  const items = query.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <Card title={t('shipmentAssessment.title')}>
      <ul className="space-y-2 text-sm">
        {items.map((item) => (
          <li key={item.id}>
            <p>
              {item.number} · {t(`shipmentAssessment.status.${item.status}` as TranslationKey)}
            </p>
            <ul>
              {item.documents.map((doc) => (
                <DocumentRow key={doc.id} doc={doc} onDownload={() => downloadAssessmentDocument('BUYER', orderId, doc.id)} />
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * Pieces of a claim both sides see (JOURNEY-058): the evidence timeline, each
 * file opened through a single-use link, and the inspection report behind the
 * claim.
 *
 * The inspection card shows the report's status and result as the inspection
 * module recorded them. A claim, a message or a rating never changes or
 * replaces that result, and the card says so.
 */
import { useMutation } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useToast } from '@/components/toast-context';
import { Badge, Card } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { openDisputeAttachment, type DisputeInspection, type DisputeSurface, type DisputeView } from '@/lib/disputes';

/** Every file on the claim, oldest first, each one downloadable. */
export function EvidenceTimeline({
  surface,
  dispute,
}: {
  surface: DisputeSurface;
  dispute: DisputeView;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const open = useMutation({
    mutationFn: (attachmentId: string) => openDisputeAttachment(surface, dispute.reference, attachmentId),
    onError: (failure) => {
      toast.error(errorMessage(t, failure));
    },
  });

  if (dispute.attachments.length === 0) {
    return <p className="text-sm text-ink-muted">{t('disputes.noEvidence')}</p>;
  }
  return (
    <ol className="space-y-2 border-l border-border-subtle pl-4 text-sm">
      {dispute.attachments.map((file) => (
        <li key={file.id}>
          <p className="text-xs text-ink-muted">
            {[
              file.party === undefined ? null : t(`disputes.party.${file.party}` as TranslationKey),
              file.createdAt === undefined ? null : formatDateTime(file.createdAt),
            ]
              .filter((part) => part !== null)
              .join(' · ')}
          </p>
          <button
            type="button"
            className="font-medium text-brand hover:underline disabled:opacity-60"
            disabled={open.isPending}
            onClick={() => {
              open.mutate(file.id);
            }}
          >
            {t('disputes.download', { name: file.fileName })}
          </button>
        </li>
      ))}
    </ol>
  );
}

function InspectionEntry({ entry }: { entry: DisputeInspection }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div className="space-y-1">
      <p className="flex flex-wrap items-center gap-2">
        <Badge>{t(`orderMilestones.inspectionStatus.${entry.status}` as TranslationKey)}</Badge>
        {entry.linkPath !== null && (
          <Link to={entry.linkPath} className="font-medium text-brand hover:underline">
            {t('disputes.inspection.open')}
          </Link>
        )}
      </p>
      {entry.reports.length === 0 ? (
        <p className="text-ink-muted">{t('disputes.inspection.noReport')}</p>
      ) : (
        <ul className="space-y-0.5">
          {entry.reports.map((report) => (
            <li key={report.id} className="flex flex-wrap items-center gap-2">
              <span>{t('disputes.inspection.revision', { revision: String(report.revision) })}</span>
              <Badge tone={report.result === 'PASS' ? 'success' : 'danger'}>
                {t(`disputes.inspection.result.${report.result}` as TranslationKey)}
              </Badge>
              {report.signedAt !== null && (
                <span className="text-xs text-ink-muted">{t('disputes.inspection.signed', { at: formatDateTime(report.signedAt) })}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The inspection report behind the claim, when there was one. */
export function InspectionCard({ dispute }: { dispute: DisputeView }): React.JSX.Element | null {
  const { t } = useI18n();
  const entries = dispute.inspection ?? [];
  if (entries.length === 0) return null;
  return (
    <Card title={t('disputes.inspection.title')} bodyClassName="space-y-3 px-5 py-4 text-sm">
      {entries.map((entry) => (
        <InspectionEntry key={entry.sellerOrderGroupId} entry={entry} />
      ))}
      <p className="text-xs text-ink-muted">{t('disputes.inspection.note')}</p>
    </Card>
  );
}

/**
 * Pieces every request-for-quotation screen shares, on both sides of the
 * marketplace: the status badges, the requirement laid out for reading, the
 * file list and the activity timeline.
 *
 * Deadlines are instants and are always shown in UTC, with "UTC" written
 * beside them. A buyer in Pune and a seller in Łódź reading "18:00" must be
 * reading the same moment, and the server holds only the one.
 */
import type { ReactNode } from 'react';
import { Badge, type BadgeTone } from '@/components/ui';
import { DocumentIcon } from '@/components/icons';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { formatIsoDate } from '@/lib/calendar-date';
import { formatMoneyMinor } from '@/lib/format';
import { countryName } from '@/lib/iso-countries';
import { formatUtc, metaText, useQuantityLabel } from '@/lib/rfq-format';
import {
  fileSize,
  type InvitationStatus,
  type RfqAttachment,
  type RfqRequirement,
  type RfqStatus,
  type RfqTimelineEvent,
} from '@/lib/rfq';

const RFQ_TONES: Record<RfqStatus, BadgeTone> = {
  DRAFT: 'neutral',
  OPEN: 'brand',
  AWARDED: 'success',
  CLOSED: 'neutral',
  CANCELLED: 'danger',
};

export function RfqStatusBadge({ status }: { status: RfqStatus }): React.JSX.Element {
  const { t } = useI18n();
  return <Badge tone={RFQ_TONES[status]}>{t(`rfq.status.${status}` as TranslationKey)}</Badge>;
}

const INVITATION_TONES: Record<InvitationStatus, BadgeTone> = {
  INVITED: 'neutral',
  VIEWED: 'brand',
  QUOTED: 'success',
  DECLINED: 'warning',
  WITHDRAWN: 'warning',
  EXPIRED: 'danger',
};

export function InvitationStatusBadge({ status }: { status: InvitationStatus }): React.JSX.Element {
  const { t } = useI18n();
  return <Badge tone={INVITATION_TONES[status]}>{t(`rfq.invitationStatus.${status}` as TranslationKey)}</Badge>;
}

function Row({ label, children }: { label: string; children: ReactNode }): React.JSX.Element {
  return (
    <div className="grid gap-1 py-2 sm:grid-cols-[14rem_1fr] sm:gap-4">
      <dt className="text-sm text-ink-muted">{label}</dt>
      <dd className="min-w-0 break-words text-sm text-ink">{children}</dd>
    </div>
  );
}

/** The requirement, laid out to be read - by the buyer checking it or a seller quoting on it. */
export function RequirementDetails({
  requirement,
  categoryName,
}: {
  requirement: RfqRequirement;
  categoryName: string | null;
}): React.JSX.Element {
  const { t, intlLocale, language } = useI18n();
  const quantityLabel = useQuantityLabel();
  const missing = <span className="text-ink-subtle">{t('rfq.notProvided')}</span>;

  return (
    <dl className="divide-y divide-border-subtle">
      <Row label={t('rfq.field.category')}>{categoryName ?? missing}</Row>
      <Row label={t('rfq.field.specification')}>
        {requirement.specification === null ? missing : <p className="whitespace-pre-line">{requirement.specification}</p>}
      </Row>
      {requirement.specs.length > 0 && (
        <Row label={t('rfq.field.specs')}>
          <ul className="space-y-1">
            {requirement.specs.map((line, index) => (
              <li key={`${line.key}:${String(index)}`}>
                <span className="font-medium">{line.key}:</span> {line.value}
              </li>
            ))}
          </ul>
        </Row>
      )}
      <Row label={t('rfq.field.quantity')}>{quantityLabel(requirement.quantity, requirement.unitOfMeasure)}</Row>
      <Row label={t('rfq.field.annualVolume')}>
        {requirement.annualVolume === null ? missing : quantityLabel(requirement.annualVolume, requirement.unitOfMeasure)}
      </Row>
      <Row label={t('rfq.field.targetPrice')}>
        {requirement.targetUnitPriceMinor === null || requirement.targetCurrency === null
          ? missing
          : t('rfq.perUnit', { price: formatMoneyMinor(requirement.targetUnitPriceMinor, requirement.targetCurrency) })}
      </Row>
      <Row label={t('rfq.field.destination')}>
        {requirement.destinationCountry === null ? (
          missing
        ) : (
          <>
            {countryName(requirement.destinationCountry, language)}
            {requirement.destinationPort !== null && <span className="block text-ink-muted">{requirement.destinationPort}</span>}
            {requirement.destinationAddress !== null && (
              <span className="block whitespace-pre-line text-ink-muted">{requirement.destinationAddress}</span>
            )}
          </>
        )}
      </Row>
      <Row label={t('rfq.field.incoterm')}>
        {requirement.incoterm === null ? missing : `${requirement.incoterm} — ${t(`rfq.incoterm.${requirement.incoterm}` as TranslationKey)}`}
      </Row>
      <Row label={t('rfq.field.certifications')}>
        {requirement.certifications.length === 0 ? missing : requirement.certifications.join(', ')}
      </Row>
      <Row label={t('rfq.field.sample')}>{t(`rfq.sample.${requirement.sampleRequirement}` as TranslationKey)}</Row>
      <Row label={t('rfq.field.inspection')}>{t(`rfq.inspection.${requirement.inspectionRequirement}` as TranslationKey)}</Row>
      <Row label={t('rfq.field.deadline')}>{formatUtc(requirement.responseDeadline, intlLocale)}</Row>
      <Row label={t('rfq.field.deliveryDate')}>
        {requirement.deliveryTargetDate === null
          ? missing
          : formatIsoDate(requirement.deliveryTargetDate, intlLocale, { dateStyle: 'long' })}
      </Row>
      <Row label={t('rfq.field.notes')}>
        {requirement.notes === null ? missing : <p className="whitespace-pre-line">{requirement.notes}</p>}
      </Row>
    </dl>
  );
}

/** Files, each a download link. Links carry the session; nothing is public. */
export function AttachmentList({
  attachments,
  hrefFor,
  onRemove,
  canRemove,
}: {
  attachments: RfqAttachment[];
  hrefFor: (attachment: RfqAttachment) => string;
  onRemove?: (attachment: RfqAttachment) => void;
  canRemove?: (attachment: RfqAttachment) => boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  if (attachments.length === 0) return <p className="text-sm text-ink-muted">{t('rfq.files.none')}</p>;
  return (
    <ul className="divide-y divide-border-subtle rounded-md border border-border-subtle">
      {attachments.map((attachment) => (
        <li key={attachment.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
          <a
            href={hrefFor(attachment)}
            className="flex min-w-0 items-center gap-2 text-sm font-medium text-brand hover:underline"
            download
          >
            <DocumentIcon className="h-4 w-4 shrink-0" />
            <span className="truncate">{attachment.fileName}</span>
            <span className="sr-only">{t('rfq.files.download')}</span>
          </a>
          <span className="flex items-center gap-3 text-xs text-ink-muted">
            <span>{fileSize(attachment.byteSize)}</span>
            {attachment.purpose === 'REQUIREMENT' && (
              <span>
                {attachment.requirementVersion === null
                  ? t('rfq.files.pending')
                  : t('rfq.files.inVersion', { version: String(attachment.requirementVersion) })}
              </span>
            )}
            {onRemove !== undefined && (canRemove?.(attachment) ?? true) && (
              <button
                type="button"
                className="font-medium text-danger hover:underline"
                onClick={() => {
                  onRemove(attachment);
                }}
                aria-label={t('rfq.files.removeNamed', { name: attachment.fileName })}
              >
                {t('rfq.files.remove')}
              </button>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** What happened, oldest first, in plain words. */
export function RfqTimeline({ events }: { events: RfqTimelineEvent[] }): React.JSX.Element {
  const { t, intlLocale } = useI18n();
  if (events.length === 0) return <p className="text-sm text-ink-muted">{t('rfq.timeline.empty')}</p>;
  return (
    <ol className="space-y-3 border-l border-border-subtle pl-4">
      {events.map((event) => (
        <li key={event.id} className="relative">
          <span className="absolute -left-[1.3rem] top-1.5 h-2 w-2 rounded-full bg-brand" aria-hidden="true" />
          <p className="text-sm text-ink">
            {t(`rfq.timeline.kind.${event.kind}` as TranslationKey, {
              supplier: event.supplierName ?? t('rfq.timeline.aSupplier'),
              version: metaText(event.meta?.['requirementVersion'] ?? event.meta?.['versionNumber']),
              defaultValue: event.kind,
            })}
          </p>
          <p className="text-xs text-ink-muted">{formatUtc(event.at, intlLocale)}</p>
        </li>
      ))}
    </ol>
  );
}

/**
 * Whether an independent inspection lets this shipment's goods leave.
 *
 * Three answers and no more: released, held (with one sentence why), or no
 * inspection needed. A carrier is never shown the report, the findings or
 * who inspected - only whether it may move the goods. The server decides;
 * the dispatch moves it allows are already gated by the same verdict.
 */
import { Callout } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { InspectionReleaseState } from '@/lib/types';

/** Gate reasons that hold goods, each with its own sentence in the catalogue. */
const HELD_REASONS = new Set([
  'NOT_BOOKED',
  'IN_PROGRESS',
  'FAILED',
  'INCONCLUSIVE',
  'BLOCKING_NCR_OPEN',
  'RELEASE_PENDING_APPROVAL',
  'SCOPE_CHANGED',
  'BUYER_REVIEW_PERIOD',
]);

export function InspectionReleaseStatus({
  release,
}: {
  release: InspectionReleaseState | undefined;
}): React.JSX.Element | null {
  const { t } = useI18n();
  if (release === undefined) return null;

  if (!release.required) {
    return (
      <Callout tone="neutral" role="status" className="mb-4">
        {t('shipment.inspection.notNeeded')}
      </Callout>
    );
  }

  if (release.released) {
    return (
      <Callout tone="success" role="status" className="mb-4">
        {t('shipment.inspection.released')}
      </Callout>
    );
  }

  const sentence = HELD_REASONS.has(release.reason)
    ? t(`shipment.inspection.reason.${release.reason}` as never)
    : release.sentence;
  return (
    <Callout tone="warning" role="status" className="mb-4">
      {t('shipment.inspection.held', { sentence })}
    </Callout>
  );
}

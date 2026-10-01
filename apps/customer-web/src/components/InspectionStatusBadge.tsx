/**
 * The pre-shipment inspection status on an order card (ENH-010).
 *
 * One of seven card statuses the server works out; nothing when inspection has
 * not been decided for the order yet. Shared by the buyer's order list and
 * Seller Hub's, so both read the same words in the same colours.
 */
import { Badge, type BadgeTone } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';

const TONES: Record<string, BadgeTone> = {
  NOT_REQUIRED: 'neutral',
  REQUIRED: 'warning',
  BOOKED: 'brand',
  IN_PROGRESS: 'brand',
  NCR: 'danger',
  REINSPECTION: 'warning',
  RELEASED: 'success',
};

export function InspectionStatusBadge({ status }: { status: string | null | undefined }): React.JSX.Element | null {
  const { t } = useI18n();
  if (status === null || status === undefined) return null;
  const tone = TONES[status];
  if (tone === undefined) return null;
  return (
    <Badge tone={tone}>
      {t(`inspection.card.${status}` as TranslationKey)}
    </Badge>
  );
}

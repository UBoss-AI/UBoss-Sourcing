/** Status and badge chips for Shipment Assessment. Text always accompanies colour. */
import { Badge } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import type { AssessmentStatus, BadgeTier } from '@/lib/shipment-assessment';
import { STATUS_TONE } from './tones';

export function StatusBadge({ status }: { status: AssessmentStatus }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <Badge tone={STATUS_TONE[status]} dot>
      {t(`shipmentAssessment.status.${status}` as TranslationKey)}
    </Badge>
  );
}

export function BadgeTierBadge({ tier }: { tier: BadgeTier | null }): React.JSX.Element {
  const { t } = useI18n();
  return <Badge tone={tier === 'PLATINUM' || tier === 'GOLD' ? 'brand' : 'neutral'}>{t(`shipmentAssessment.badge.${tier ?? 'NONE'}` as TranslationKey)}</Badge>;
}

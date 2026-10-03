/**
 * A deadline as time left or time overdue (ENH-030), refreshed every 30 s.
 * At the exact deadline it is overdue: the boundary belongs to "late".
 * Wording comes from Intl.RelativeTimeFormat, so every language gets its
 * own units without a translated key per unit.
 */
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { countdownParts } from '@/lib/countdown';

export function Countdown({ deadline, label }: { deadline: string | null; label?: string }): React.JSX.Element | null {
  const { t, intlLocale } = useI18n();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(new Date());
    }, 30_000);
    return () => {
      window.clearInterval(id);
    };
  }, []);
  if (deadline === null) return null;
  const at = new Date(deadline);
  if (Number.isNaN(at.getTime())) return null;
  const { overdue, soon, phrase } = countdownParts(at, now, intlLocale);
  const text = overdue ? t('countdown.overdue', { relative: phrase }) : t('countdown.due', { relative: phrase });
  return (
    <span title={at.toLocaleString(intlLocale)} data-countdown={overdue ? 'overdue' : soon ? 'soon' : 'due'}>
      <Badge tone={overdue ? 'danger' : soon ? 'warning' : 'neutral'}>
        {label === undefined ? text : `${label}: ${text}`}
      </Badge>
    </span>
  );
}

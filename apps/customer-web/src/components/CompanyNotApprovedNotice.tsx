/**
 * "Ordering for this company opens once it is verified" - with the way to
 * the application, rather than a disabled button nobody can explain.
 *
 * Renders nothing unless the session is buying for a company that may not
 * order yet. The same words whatever page it sits on, and the status in
 * them, because "rejected" and "under review" send the reader to different
 * places.
 */
import { Link } from 'react-router-dom';
import { useSession } from '@/auth/session-context';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';

export function CompanyNotApprovedNotice({ className }: { className?: string }): React.JSX.Element | null {
  const { buyerContext } = useSession();
  const { t } = useI18n();

  if (buyerContext.kind !== 'COMPANY' || buyerContext.companyStatus === 'APPROVED') return null;

  return (
    <div role="note" className={cx('rounded-md border border-warning/30 bg-warning-soft px-3 py-2.5 text-xs', className)}>
      <p className="font-medium text-ink">
        {t('companyGate.heading', { company: buyerContext.companyName })}
      </p>
      <p className="mt-0.5 text-ink-muted">
        {t('companyGate.body', { status: t(`companyStatus.${buyerContext.companyStatus}` as TranslationKey) })}
      </p>
      <Link to={`/account/companies/${buyerContext.companyId}`} className="mt-1.5 inline-block font-medium text-brand hover:underline">
        {t('companyGate.link')}
      </Link>
    </div>
  );
}

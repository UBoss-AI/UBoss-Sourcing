/**
 * Where a company's verification stands, on every page, while buying for it.
 *
 * Persistent and not dismissable while the company cannot order: the person
 * browsing for it needs to know - before they build a cart and press Check
 * out - that ordering waits for verification, and why. Once the company is
 * approved the banner gives way to a small "Buying for ..." line, because the
 * one thing still worth saying on every page is which account the basket
 * belongs to.
 *
 * `role="status"`, not `alert`: it describes a standing state, it is not an
 * interruption, and a screen reader should read it on arrival without
 * shouting over the page every time it re-renders.
 */
import { Link } from 'react-router-dom';
import { useSession } from '@/auth/session-context';
import { BuildingIcon } from '@/components/icons';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';

const WARNING = new Set(['MORE_INFORMATION_REQUIRED', 'REVERIFICATION_REQUIRED', 'EMAIL_VERIFICATION_PENDING', 'DRAFT']);
const DANGER = new Set(['REJECTED', 'SUSPENDED']);

export function CompanyStatusBanner(): React.JSX.Element | null {
  const { buyerContext, isCustomer } = useSession();
  const { t } = useI18n();

  if (!isCustomer || buyerContext.kind !== 'COMPANY') return null;

  const link = `/account/companies/${buyerContext.companyId}`;

  if (buyerContext.companyStatus === 'APPROVED') {
    return (
      <div role="status" className="border-b border-border bg-surface">
        <p className="mx-auto flex max-w-content items-center gap-2 px-4 py-1.5 text-xs text-ink-muted">
          <BuildingIcon aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-brand" />
          <span className="truncate">{t('companyBanner.buyingFor', { company: buyerContext.companyName })}</span>
        </p>
      </div>
    );
  }

  const status = buyerContext.companyStatus;
  const tone = DANGER.has(status) ? 'danger' : WARNING.has(status) ? 'warning' : 'brand';

  return (
    <div
      role="status"
      className={cx(
        'border-b',
        tone === 'danger' && 'border-danger/30 bg-danger-soft',
        tone === 'warning' && 'border-warning/30 bg-warning-soft',
        tone === 'brand' && 'border-brand/20 bg-brand-soft',
      )}
    >
      <div className="mx-auto flex max-w-content flex-col gap-2 px-4 py-2.5 text-sm sm:flex-row sm:items-center sm:justify-between">
        <p className="flex items-start gap-2 text-ink">
          <BuildingIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <span className="font-semibold">{buyerContext.companyName}</span>
            {' · '}
            {t(`companyBanner.${status}` as TranslationKey)}
          </span>
        </p>
        <Link to={link} className="shrink-0 font-medium text-brand underline-offset-2 hover:underline">
          {status === 'MORE_INFORMATION_REQUIRED' || status === 'REVERIFICATION_REQUIRED' || status === 'DRAFT' || status === 'EMAIL_VERIFICATION_PENDING'
            ? t('companyBanner.continueApplication')
            : t('companyBanner.viewApplication')}
        </Link>
      </div>
    </div>
  );
}

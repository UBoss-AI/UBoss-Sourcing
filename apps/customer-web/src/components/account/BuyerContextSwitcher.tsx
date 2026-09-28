/**
 * "Buying for": switch between your own account and a company you belong to.
 *
 * Shown only to somebody who has at least one company - a choice with one
 * option is not a choice. Each entry is a real button with `aria-pressed`, so
 * the current one is announced as such and the list is a set of toggles
 * rather than links pretending to be a menu.
 *
 * Switching needs no password: it chooses between authorities the person
 * already holds. The server confirms the membership and holds the choice on
 * the session; this component only asks. After a switch the whole query
 * cache is dropped (see SessionProvider), and the person is taken home, so no
 * screen keeps showing the other context's basket or orders.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSession } from '@/auth/session-context';
import type { BuyerCompanyStatus } from '@/auth/session-context';
import { Badge } from '@/components/ui';
import { BuildingIcon, UserIcon } from '@/components/icons';
import { useToast } from '@/components/toast-context';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { statusTone } from '@/lib/buyer-companies';
import { cx } from '@/lib/cx';
import { HOME } from '@/lib/return-target';
import { errorMessage } from '@/lib/errors';

export function BuyerContextSwitcher({ onSwitched }: { onSwitched?: () => void }): React.JSX.Element | null {
  const { companies, buyerContext, switchBuyerContext } = useSession();
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const [pending, setPending] = useState<string | null>(null);

  if (companies.length === 0) return null;

  const currentId = buyerContext.kind === 'COMPANY' ? buyerContext.companyId : 'INDIVIDUAL';

  const choose = async (target: { kind: 'INDIVIDUAL' } | { kind: 'COMPANY'; companyId: string }, name: string): Promise<void> => {
    const key = target.kind === 'COMPANY' ? target.companyId : 'INDIVIDUAL';
    if (key === currentId) return;
    setPending(key);
    try {
      await switchBuyerContext(target);
      toast.success(
        target.kind === 'COMPANY'
          ? t('buyerContext.switchedToCompany', { name })
          : t('buyerContext.switchedToIndividual'),
      );
      onSwitched?.();
      void navigate(HOME);
    } catch (error) {
      toast.error(errorMessage(t, error, t('buyerContext.switchFailed')));
    } finally {
      setPending(null);
    }
  };

  return (
    <div role="group" aria-labelledby="buyer-context-heading" className="border-b border-border px-2 py-2">
      <p
        id="buyer-context-heading"
        className="px-2 pb-1 text-xxs font-semibold uppercase tracking-wider text-ink-subtle"
      >
        {t('buyerContext.heading')}
      </p>
      <ul className="space-y-0.5">
        <li>
          <ContextButton
            selected={currentId === 'INDIVIDUAL'}
            busy={pending === 'INDIVIDUAL'}
            icon={<UserIcon className="h-4 w-4" />}
            label={t('buyerContext.myself')}
            onClick={() => {
              void choose({ kind: 'INDIVIDUAL' }, '');
            }}
          />
        </li>
        {companies.map((company) => (
          <li key={company.companyId}>
            <ContextButton
              selected={currentId === company.companyId}
              busy={pending === company.companyId}
              icon={<BuildingIcon className="h-4 w-4" />}
              label={company.companyName}
              status={company.companyStatus}
              onClick={() => {
                void choose({ kind: 'COMPANY', companyId: company.companyId }, company.companyName);
              }}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function ContextButton({
  selected,
  busy,
  icon,
  label,
  status,
  onClick,
}: {
  selected: boolean;
  busy: boolean;
  icon: React.ReactNode;
  label: string;
  status?: BuyerCompanyStatus;
  onClick: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-busy={busy}
      disabled={busy}
      onClick={onClick}
      className={cx(
        'flex w-full items-center gap-2.5 rounded px-2 py-2 text-left text-sm transition-colors',
        selected ? 'bg-brand-soft font-medium text-brand' : 'text-ink hover:bg-surface-hover',
      )}
    >
      <span aria-hidden="true" className="shrink-0">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {status !== undefined && status !== 'APPROVED' && (
        <Badge tone={statusTone(status)}>{t(`companyStatus.${status}` as TranslationKey)}</Badge>
      )}
    </button>
  );
}

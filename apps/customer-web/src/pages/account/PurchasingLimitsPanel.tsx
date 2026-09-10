/**
 * The purchasing limits on this account, and what has been spent against them.
 *
 * Read-only, and the panel says so rather than offering an Edit that would
 * refuse: the limits are set by the supplier, not the buyer, and a customer
 * raising their own spending cap is the obvious attack — which is why the
 * fields are absent from the update schema on the server as well as from this
 * screen.
 *
 * It is here at all because a customer whose order is rejected at checkout for
 * exceeding a cap deserves to have seen that cap somewhere first. An opaque
 * limit error at the payment step is a support call.
 *
 * Every figure is quoted in the currency the customer is actually being quoted
 * in — the server resolves that, not this component. Showing a cap denominated
 * in a market they are not browsing would be worse than showing nothing.
 */
import { Badge } from '@/components/ui';
import { minorToMajor } from '@/lib/format';
import { useI18n } from '@/i18n/i18n-context';
import type { Translate } from '@/i18n/i18n-context';
import type { AccountResponse } from '@/lib/types';
import { AccountPanel, PanelRow } from './AccountPanel';

/** An amount from the account API, which sends bare minor units. */
function money(t: Translate, minor: string | null, currency: string): string {
  if (minor === null) return t('profile.noLimit');
  return `${currency} ${minorToMajor(minor)}`;
}

export function PurchasingLimitsPanel({
  account,
}: {
  account: AccountResponse;
}): React.JSX.Element {
  const { t } = useI18n();

  const { purchasingLimits: limits, spend } = account;

  return (
    <AccountPanel
      title={t('profile.yourPurchasingLimits')}
      description={t('profile.setByUsOnYour')}
    >
      <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
        <PanelRow
          label={t('profile.minimumPerOrder')}
          value={money(t, limits.perOrderMinMinor, limits.currency)}
        />
        <PanelRow
          label={t('profile.maximumPerOrder')}
          value={money(t, limits.perOrderMaxMinor, limits.currency)}
        />
        <PanelRow
          label={t('profile.spentThisMonth')}
          value={money(t, spend.monthToDateMinor, spend.currency)}
          {...(spend.capMinor === null
            ? {}
            : {
                hint: t('profile.ofCap', {
                  amount: money(t, spend.capMinor, spend.currency),
                }),
              })}
        />

        <div className="min-w-0">
          <dt className="text-xxs font-medium uppercase tracking-wider text-ink-subtle">
            {t('profile.approvals')}
          </dt>
          <dd className="mt-1 text-sm text-ink">
            {limits.requiresOrderApproval ? (
              <Badge tone="warning">{t('profile.ordersNeedApproval')}</Badge>
            ) : (
              <span className="text-ink-muted">{t('profile.notRequired')}</span>
            )}
          </dd>
        </div>
      </dl>

      {spend.remainingMinor !== null && (
        <p className="mt-4 border-t border-border pt-4 text-sm text-ink">
          {/*
            Split on the placeholder so the figure keeps its own styling: the
            amount is the one thing on this line somebody is looking for.
          */}
          {t('profile.leftToSpendThisMonth').split('{{amount}}')[0]}
          <span className="font-medium tabular">
            {money(t, spend.remainingMinor, spend.currency)}
          </span>
          {t('profile.leftToSpendThisMonth').split('{{amount}}')[1]}
        </p>
      )}
    </AccountPanel>
  );
}

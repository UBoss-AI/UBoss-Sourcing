/**
 * ERP API connections — an explanation, and deliberately nothing else.
 *
 * This is the one screen in the account area with no form on it, and that is
 * the honest shape rather than an unfinished one. A connection is a URL plus a
 * credential that **this installation's server** then calls on the buyer's
 * behalf; creating one means holding somebody's ERP credential, deciding which
 * endpoints are allowed, and mapping SKUs and warehouses between two systems.
 * All of that belongs to whoever runs the installation, which is why the screen
 * for it is in the admin console under Settings → ERP, and why there is no
 * customer-facing endpoint for it here.
 *
 * The alternative was a status chip. It was considered and rejected: there is
 * no customer-facing read for a connection's state, so a green "ERP connected"
 * would be a decoration pretending to be a status — worse than no chip at all.
 * `orchestration-nodes.ts` and the sourcing hub reach the same conclusion about
 * the same capability, and it is worth all three saying so in the same words.
 *
 * What the page does give a buyer is the two things they can act on: what the
 * hand-off actually does for them, and exactly what to ask their supplier for.
 */
import { useStorefront } from '@/app/storefront-context';
import { PageHeader } from '@/components/ui';
import { CheckIcon, MailIcon } from '@/components/icons';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { AccountPanel } from './AccountPanel';

/** What the hand-off does once it is set up. Facts, not a feature list. */
const BENEFITS: readonly TranslationKey[] = [
  'erpPage.benefitOrders',
  'erpPage.benefitStock',
  'erpPage.benefitNoRetyping',
];

export function ErpPage(): React.JSX.Element {
  const { t } = useI18n();
  const { business } = useStorefront();

  useDocumentMeta({ title: t('account.nav.erpConnections'), noIndex: true }, business.displayName);

  return (
    <>
      <PageHeader
        title={t('account.nav.erpConnections')}
        description={t('erpPage.description')}
      />

      <div className="space-y-6">
        <AccountPanel title={t('erpPage.whatItDoes')}>
          <ul className="space-y-2.5">
            {BENEFITS.map((key) => (
              <li key={key} className="flex items-start gap-2.5 text-sm leading-relaxed text-ink">
                <CheckIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                {t(key)}
              </li>
            ))}
          </ul>
        </AccountPanel>

        <AccountPanel title={t('erpPage.whoSetsItUp')}>
          <p className="max-w-prose text-sm leading-relaxed text-ink-muted">
            {t('erpPage.whoSetsItUpBody', { store: business.displayName })}
          </p>

          <p className="mt-3 max-w-prose text-sm leading-relaxed text-ink-muted">
            {t('erpPage.whatToAskFor')}
          </p>

          {/*
           * The support address, when the operator has configured one.
           *
           * Absent rather than a placeholder on a deployment that has not:
           * this page's whole point is telling somebody who to ask, and a
           * `mailto:` to nowhere is worse than a sentence saying to contact
           * the supplier by whatever means they already use.
           */}
          {business.supportEmail !== null && (
            <p className="mt-4 border-t border-border-subtle pt-4">
              <a
                href={`mailto:${business.supportEmail}`}
                className="inline-flex items-center gap-2 rounded text-sm font-medium text-brand hover:underline"
              >
                <MailIcon aria-hidden="true" className="h-4 w-4" />
                {business.supportEmail}
              </a>
            </p>
          )}
        </AccountPanel>
      </div>
    </>
  );
}

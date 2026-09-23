/**
 * How your orders are delivered — the Seller Hub screen.
 *
 * The same panel the Logistics Partner onboarding step renders, at a URL a
 * seller can reach for ever afterwards. That is the whole reason this page
 * exists: an application stops being editable the moment it is approved, so a
 * seller who set their delivery up during onboarding and wants to change it in
 * March has nowhere to go without it.
 *
 * WHAT IS DIFFERENT HERE, AND IT IS ONE THING
 *
 * `isEditable`. On the onboarding step it follows the APPLICATION - draft or
 * action-required, false once approved, because an application under review
 * must not move under the reviewer. Here it follows the ACCOUNT: a trading
 * seller may change how their goods ship whenever they like, and a suspended
 * one may not change anything at all.
 *
 * Everything else - the cards, the facts on them, the honesty about India
 * Post, the confirmation before a pause - is the one component, so the two
 * screens cannot drift into two answers about what a seller has configured.
 */
import { useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { PageHeader } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { fetchFulfilmentOptions } from '@/lib/seller';
import { LogisticsPartnerPanel } from './LogisticsPartnerPanel';
import { SelfManagedConfigPanel } from './SelfManagedConfigPanel';
import type { SellerOutletContext } from './SellerLayout';

export function SellerFulfilmentPage(): React.JSX.Element {
  const { t } = useI18n();
  const seller = useOutletContext<SellerOutletContext>();

  /*
   * The same query key the panel above uses, so this is the same request.
   *
   * It is read here only to decide whether the configuration panel has
   * anything to draw - a seller with no operation of their own gets nothing
   * rather than four empty forms.
   */
  const options = useQuery({
    queryKey: ['seller', 'fulfilment-options'],
    queryFn: fetchFulfilmentOptions,
  });

  /*
   * A suspended or rejected business changes nothing.
   *
   * Not `isTrading`: a seller whose account is merely paused for stock reasons
   * still needs to be able to fix the delivery method that caused it. What
   * closes this screen is the account being in a state where no change they
   * make leads anywhere.
   */
  const isEditable = seller.status !== 'SUSPENDED' && seller.status !== 'REJECTED';

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('sellerFulfilment.pageTitle')}
        description={t('sellerFulfilment.pageDescription')}
      />

      <LogisticsPartnerPanel isEditable={isEditable} />

      <SelfManagedConfigPanel
        methods={options.data?.methods ?? []}
        isEditable={isEditable}
      />
    </div>
  );
}

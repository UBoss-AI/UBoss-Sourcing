/**
 * The business buyer's tools, side by side on the home page (checklist
 * DYNAMIC-007): private label / OEM, a bulk SKU list, landed cost, a
 * scheduled cart and the buyer's own ERP connection.
 *
 * Every tile opens a screen that already exists - this row adds no capability
 * of its own. A tool whose switch is off in this deployment says so in a
 * line of its own instead of linking to a page that would refuse the buyer;
 * a tile is never a promise the deployment does not keep. Account screens
 * send a guest to sign in on their own, so the links do not branch on the
 * session.
 *
 *   - **Private label / OEM** opens the RFQ template (ENH-024) without a
 *     product, so the buyer names the request. Needs requests for quotation.
 *   - **Upload bulk requirement** is the cart's CSV / Excel SKU list upload
 *     (ENH-016). Always on.
 *   - **Landed cost** is the public estimator at `/tools/landed-cost`.
 *   - **Schedule cart** is repeat purchases (`features.recurringOrders`).
 *   - **ERP integration** is the buyer's own ERP connection
 *     (`features.customerErp`, off by default).
 */
import { Link } from 'react-router-dom';
import { useStorefront } from '@/app/storefront-context';
import { BoxIcon, CalendarIcon, CurrencyIcon, DocumentIcon, LinkIcon } from '@/components/icons';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';

interface Tool {
  id: string;
  icon: (props: { className?: string }) => React.JSX.Element;
  titleKey: TranslationKey;
  bodyKey: TranslationKey;
  to: string;
  /** False when this deployment has the feature switched off. */
  available: boolean;
}

export function HomeB2bTools(): React.JSX.Element {
  const { t } = useI18n();
  const { features } = useStorefront();

  const tools: Tool[] = [
    { id: 'oem', icon: BoxIcon, titleKey: 'home.tools.oemTitle', bodyKey: 'home.tools.oemBody', to: '/account/rfqs/new?template=oem', available: features.rfq === true },
    { id: 'bulk', icon: DocumentIcon, titleKey: 'home.tools.bulkTitle', bodyKey: 'home.tools.bulkBody', to: '/cart', available: true },
    { id: 'landed', icon: CurrencyIcon, titleKey: 'home.tools.landedTitle', bodyKey: 'home.tools.landedBody', to: '/tools/landed-cost', available: true },
    { id: 'schedule', icon: CalendarIcon, titleKey: 'home.tools.scheduleTitle', bodyKey: 'home.tools.scheduleBody', to: '/account/schedules', available: features.recurringOrders },
    { id: 'erp', icon: LinkIcon, titleKey: 'home.tools.erpTitle', bodyKey: 'home.tools.erpBody', to: '/account/integrations/erp', available: features.customerErp === true },
  ];

  return (
    <section aria-labelledby="home-b2b-tools" className="mb-12 mt-10">
      <h2 id="home-b2b-tools" className="text-title-lg text-ink">{t('home.tools.title')}</h2>
      <p className="mt-1 max-w-prose text-sm text-ink-muted">{t('home.tools.blurb')}</p>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {tools.map(({ id, icon: Icon, titleKey, bodyKey, to, available }) => {
          const inner = (
            <>
              <Icon className="h-5 w-5 shrink-0 text-brand" />
              <span className="mt-2 block font-medium text-ink">{t(titleKey)}</span>
              <span className="mt-1 block text-sm text-ink-muted">
                {available ? t(bodyKey) : t('home.tools.off')}
              </span>
            </>
          );
          return (
            <li key={id} data-testid={`b2b-tool-${id}`} className="flex">
              {available ? (
                <Link
                  to={to}
                  className="flex w-full flex-col rounded-2xl border border-line bg-surface p-4 shadow-sm transition-colors hover:border-border-hover hover:bg-surface-hover"
                >
                  {inner}
                </Link>
              ) : (
                <div className="flex w-full flex-col rounded-2xl border border-dashed border-line bg-surface p-4">{inner}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The quick-action dock (ENH-005): Create RFQ, Upload Image, Ask AI, Reorder,
 * Track Order and Contact Support, one press away on every storefront page.
 * An action shows only where it works: RFQ, image search and AI follow their
 * feature switches, and reorder and tracking need a signed-in buyer.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '@/auth/session-context';
import { useStorefront } from '@/app/storefront-context';
import { ImageSearchDialog } from '@/components/hero-search/ImageSearchDialog';
import { useI18n } from '@/i18n/i18n-context';

export function QuickActionDock(): React.JSX.Element {
  const { t } = useI18n();
  const { features } = useStorefront();
  const { isCustomer } = useSession();
  const [open, setOpen] = useState(false);
  const [imageOpen, setImageOpen] = useState(false);
  const links: { key: 'rfq' | 'ai' | 'reorder' | 'track' | 'support'; to: string }[] = [
    ...(features.rfq === true ? [{ key: 'rfq' as const, to: '/account/rfqs/new' }] : []),
    ...(features.assistant ? [{ key: 'ai' as const, to: '/ai' }] : []),
    ...(isCustomer ? [{ key: 'reorder' as const, to: '/account#buy-again-heading' }, { key: 'track' as const, to: '/account/orders' }] : []),
    { key: 'support' as const, to: '/support' },
  ];
  const close = (): void => {
    setOpen(false);
  };
  return (
    <nav aria-label={t('quickActions.label')} className="fixed bottom-4 right-4 z-40 flex flex-col items-end gap-2 print:hidden">
      {open ? (
        <ul id="quick-actions" className="w-56 rounded-lg border border-border bg-surface p-2 text-sm shadow-card">
          {features.imageSearch === true ? (
            <li>
              <button type="button" className="w-full rounded px-3 py-2 text-left hover:bg-surface-sunken" onClick={() => { setImageOpen(true); close(); }}>
                {t('quickActions.image')}
              </button>
            </li>
          ) : null}
          {links.map((link) => (
            <li key={link.key}>
              <Link to={link.to} onClick={close} className="block rounded px-3 py-2 hover:bg-surface-sunken">
                {t(`quickActions.${link.key}`)}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      <button
        type="button"
        aria-expanded={open}
        aria-controls="quick-actions"
        onClick={() => { setOpen((value) => !value); }}
        className="rounded-full bg-brand px-4 py-3 text-sm font-semibold text-white shadow-card focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        {open ? t('quickActions.close') : t('quickActions.open')}
      </button>
      {imageOpen ? <ImageSearchDialog isOpen onClose={() => { setImageOpen(false); }} /> : null}
    </nav>
  );
}

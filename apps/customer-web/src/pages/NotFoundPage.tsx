/**
 * 404.
 *
 * Offers a route onward rather than a dead end — a product that has been
 * unpublished is the most common way somebody lands here, and "browse the
 * catalogue" is the useful next step.
 */
import { Link } from 'react-router-dom';
import { useStorefront } from '@/app/storefront-context';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { useI18n } from '@/i18n/i18n-context';

export function NotFoundPage(): React.JSX.Element {
  const { t } = useI18n();

  const { business } = useStorefront();
  useDocumentMeta({ title: 'Page not found', noIndex: true }, business.displayName);

  return (
    <div className="mx-auto max-w-lg py-20 text-center">
      <p className="text-sm font-semibold uppercase tracking-wider text-ink-subtle">404</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink">
        {t('notFound.weCouldNotFindThat')}
      </h1>
      <p className="mt-3 text-sm text-ink-muted">{t('notFound.theLinkMayBeOut')}</p>
      <div className="mt-6 flex justify-center gap-2">
        <Link
          to="/products"
          className="inline-flex h-10 items-center rounded-md bg-brand px-5 text-sm font-medium text-white hover:bg-brand-hover"
        >
          {t('notFound.browseProducts')}
        </Link>
        <Link
          to="/"
          className="inline-flex h-10 items-center rounded-md border border-border-strong bg-surface px-5 text-sm font-medium text-ink hover:bg-surface-hover"
        >
          {t('notFound.home')}
        </Link>
      </div>
    </div>
  );
}

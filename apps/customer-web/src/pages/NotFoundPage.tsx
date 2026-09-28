/**
 * 404, inside the store's own header and footer.
 *
 * Offers a route onward rather than a dead end. An unpublished product is the
 * most common way somebody lands here, so the page carries the catalogue
 * search: it submits to `/products?q=`, the same destination as the search on
 * the home page, with the query URL-encoded. "Go back" appears only when this
 * tab has somewhere to go back to — on a link opened in a fresh tab it would
 * leave the site.
 */
import { useNavigate } from 'react-router-dom';
import { useStorefront } from '@/app/storefront-context';
import { ErrorPage } from '@/components/error-page/ErrorPage';
import { errorActions } from '@/components/error-page/error-actions';
import { useI18n } from '@/i18n/i18n-context';
import { useDocumentMeta } from '@/lib/useDocumentMeta';

/** React Router numbers its history entries; 0 is the first in this tab. */
function hasHistoryToGoBackTo(): boolean {
  const state: unknown = window.history.state;
  return typeof state === 'object' && state !== null && 'idx' in state && Number(state.idx) > 0;
}

export function NotFoundPage(): React.JSX.Element {
  const { t } = useI18n();
  const navigate = useNavigate();

  const { business } = useStorefront();
  useDocumentMeta({ title: t('errorPage.notFound.title'), noIndex: true }, business.displayName);

  return (
    <ErrorPage
      kind="notFound"
      t={t}
      statusCode={404}
      onSearch={(query) => {
        void navigate(query.length === 0 ? '/products' : `/products?q=${encodeURIComponent(query)}`);
      }}
      actions={errorActions('notFound', {
        t,
        home: { to: '/' },
        goBack: hasHistoryToGoBackTo()
          ? () => {
              void navigate(-1);
            }
          : undefined,
      })}
    />
  );
}

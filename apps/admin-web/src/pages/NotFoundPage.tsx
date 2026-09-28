/**
 * 404, inside the panel's own frame.
 *
 * Used to be a silent redirect to the dashboard for any unknown address.
 * An honest "this address does not exist" is better than being moved
 * somewhere else without being told why: a stale bookmark then looks like a
 * working one that happens to open the dashboard.
 *
 * "Go back" appears only when this tab has somewhere to go back to — on a link
 * opened in a fresh tab it would leave the panel.
 */
import { useNavigate } from 'react-router-dom';
import { ErrorPage } from '@/components/error-page/ErrorPage';
import { errorActions } from '@/components/error-page/error-actions';
import { useI18n } from '@/i18n/i18n-context';

/** React Router numbers its history entries; 0 is the first in this tab. */
function hasHistoryToGoBackTo(): boolean {
  const state: unknown = window.history.state;
  return typeof state === 'object' && state !== null && 'idx' in state && Number(state.idx) > 0;
}

export function NotFoundPage(): React.JSX.Element {
  const { t } = useI18n();
  const navigate = useNavigate();

  return (
    <ErrorPage
      kind="notFound"
      t={t}
      statusCode={404}
      actions={errorActions('notFound', {
        t,
        home: { to: '/' },
        homeIsDashboard: true,
        goBack: hasHistoryToGoBackTo()
          ? () => {
              void navigate(-1);
            }
          : undefined,
      })}
    />
  );
}

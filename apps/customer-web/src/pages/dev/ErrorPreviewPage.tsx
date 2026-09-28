/**
 * Every full-page error kind, on demand. Development builds only.
 *
 * `/dev/errors/<kind>` — `notFound`, `unauthorized`, `forbidden`, `timeout`,
 * `rateLimited`, `server`, `badGateway`, `unavailable`, `offline`, `chunk` —
 * renders that kind exactly as a real failure would, inside the store's frame,
 * with an example reference where a server error would carry one. Most of
 * these are hard to cause on purpose, and a page nobody can look at is a page
 * nobody checks in the dark theme or at 320px.
 *
 * The route is only declared when `import.meta.env.DEV` is true, so a
 * production build contains neither the route nor this file.
 */
import { useParams } from 'react-router-dom';
import { ErrorPage } from '@/components/error-page/ErrorPage';
import { errorActions } from '@/components/error-page/error-actions';
import { DEFAULT_STATUS, type ErrorKind } from '@/components/error-page/error-kind';
import { useI18n } from '@/i18n/i18n-context';
import { NotFoundPage } from '@/pages/NotFoundPage';

const KINDS = Object.keys(DEFAULT_STATUS) as ErrorKind[];

/** What a server's correlation id looks like: a ULID. */
const EXAMPLE_REFERENCE = '01J9ZK4M7Q2R8T5V3W6X9Y0ABC';

export function ErrorPreviewPage(): React.JSX.Element {
  const { t } = useI18n();
  const { kind: requested } = useParams();
  const kind = KINDS.find((candidate) => candidate === requested);

  if (kind === undefined || kind === 'notFound') return <NotFoundPage />;

  const fromServer = kind !== 'offline' && kind !== 'chunk';

  return (
    <ErrorPage
      kind={kind}
      t={t}
      reference={fromServer ? EXAMPLE_REFERENCE : null}
      actions={errorActions(kind, {
        t,
        home: { to: '/' },
        signIn: { to: '/login', from: `/dev/errors/${kind}` },
        supportTo: '/support',
        retry: () => {
          window.location.reload();
        },
      })}
    />
  );
}

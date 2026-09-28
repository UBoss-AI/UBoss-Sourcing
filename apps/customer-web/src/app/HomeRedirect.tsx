import { Navigate, useLocation } from 'react-router-dom';

/**
 * The old `/home` address, sent to `/`.
 *
 * `/` is the only home page. The web server answers `/home` with a 301 before
 * this bundle loads (see deploy/nginx/uboss.conf and the netlify.toml files);
 * this is the same rule for a visit that never reaches the server - a link
 * followed inside the app, or the dev server. The query string and the
 * fragment come along, so `/home?ref=mail` still carries its `ref`.
 * `replace`, so Back does not return to an address that only bounces.
 */
export function HomeRedirect(): React.JSX.Element {
  const { search, hash } = useLocation();
  return <Navigate to={{ pathname: '/', search, hash }} replace />;
}

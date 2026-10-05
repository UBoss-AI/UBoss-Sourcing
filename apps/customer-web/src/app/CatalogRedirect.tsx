import { Navigate, useLocation, useParams } from 'react-router-dom';

/**
 * The old `/catalog` and `/catalog/:slug` addresses, sent to the real ones.
 *
 * The storefront has never served `/catalog`: the catalogue is `/products` and
 * a department is `/category/:slug`. The sitemap named the `/catalog` forms
 * for a while, so search engines hold them, and each one landed on the "not
 * found" page marked noindex. These keep every such link working and point a
 * crawler at the page it was looking for. The query string and the fragment
 * come along; `replace`, so Back does not return to an address that only
 * bounces.
 */
export function CatalogRedirect(): React.JSX.Element {
  const { search, hash } = useLocation();
  const { slug } = useParams();
  const pathname = slug === undefined ? '/products' : `/category/${encodeURIComponent(slug)}`;

  return <Navigate to={{ pathname, search, hash }} replace />;
}

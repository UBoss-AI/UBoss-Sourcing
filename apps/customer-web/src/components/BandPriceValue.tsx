/**
 * A price on the product page's summary, corrected for the seller's quantity
 * band.
 *
 * The page works out "price per piece" and "total cost" from the list price,
 * which is wrong the moment a quantity reaches a seller's band: the basket
 * would charge the band price. This reads the same query the bulk-savings
 * popover reads (so it is one fetch) and, once the server has answered for
 * exactly this quantity, shows the band's figures - the list price struck
 * through beside the price per piece. Otherwise it shows what the page
 * worked out, unchanged.
 */
import { formatMoney } from '@/lib/format';
import { useBulkPricing } from '@/lib/use-bulk-pricing';

export function BandPriceValue({
  productId,
  variantId,
  pieces,
  displayCurrency,
  priceCurrency,
  enabled,
  kind,
  fallback,
}: {
  productId: string;
  variantId: string | null;
  pieces: number;
  displayCurrency: string | null;
  /** The currency the page's own figures are in; a band in another is not shown. */
  priceCurrency: string;
  /** Only for one version counted in pieces: a band prices a loose line, never a package. */
  enabled: boolean;
  kind: 'unit' | 'total';
  fallback: string;
}): React.JSX.Element {
  const { query } = useBulkPricing({ productId, variantId, pieces, displayCurrency, enabled });
  const data = query.data;
  const band =
    enabled &&
    data?.available === true &&
    data.quantity === pieces &&
    data.currency === priceCurrency &&
    data.current.tierMinQuantity !== null
      ? data
      : null;

  if (band === null) return <>{fallback}</>;
  if (kind === 'total') return <>{formatMoney(band.current.lineTotal)}</>;
  return (
    <>
      <s className="mr-1.5 text-xs font-normal text-ink-subtle">
        {formatMoney(band.listUnitPrice)}
      </s>
      <span className="text-success">{formatMoney(band.current.unitPrice)}</span>
    </>
  );
}

/**
 * The one sentence of value proposition under the home page's headline.
 *
 * It reads `GET /catalog/suppliers`, which lists only sellers the marketplace
 * operator reviewed and approved and who have something live to sell. So the
 * word "verified" in it is exactly as true as that review, and a deployment
 * with no approved sellers says nothing about suppliers at all — the sentence
 * falls back to a neutral one.
 *
 * The home page used to list those suppliers too, under "Verified suppliers"
 * and "Newly verified suppliers". Both lists are on the admin console's
 * Sellers screen now; the storefront keeps only this sentence, which is why
 * the read asks for one supplier rather than a page of cards.
 *
 * "FROM INDIA" IS READ, NEVER WRITTEN
 *
 * The sentence names a country only when every verified supplier is
 * registered in that one country, which the API reports across all of them
 * rather than just the one returned. A marketplace of Indian manufacturers
 * says "from India"; the same software run by somebody else, with sellers in
 * three countries, names no country and makes no claim it cannot keep.
 */
import { countryName } from '@/lib/iso-countries';
import { soleSupplierCountry, useVerifiedSuppliers } from '@/lib/verified-suppliers';
import { useI18n } from '@/i18n/i18n-context';

/**
 * All three wordings sit in the same grid cell and the two not in use are
 * invisible, so the line is as tall as the tallest of them from the first
 * frame — the answer arriving never pushes the search bar down. The hidden
 * copies are `aria-hidden`, so a screen reader hears only the one shown.
 */
export function ValueProposition(): React.JSX.Element {
  const { t, language } = useI18n();
  const query = useVerifiedSuppliers();

  const country = soleSupplierCountry(query.data);
  const hasSuppliers =
    Array.isArray(query.data?.suppliers) && query.data.suppliers.length > 0;
  const countryLabel = country === null ? '' : countryName(country, language);

  const wordings = [
    { id: 'neutral', text: t('home.everythingYourBusinessOrdersIn') },
    { id: 'suppliers', text: t('home.valuePropositionSuppliers') },
    {
      id: 'country',
      text: t('home.valuePropositionSuppliersFrom', { country: countryLabel || '—' }),
    },
  ];
  const shown = !hasSuppliers ? 'neutral' : country === null ? 'suppliers' : 'country';

  return (
    <p className="mt-3 grid max-w-xl text-sm leading-relaxed text-ink sm:text-base">
      {wordings.map((wording) => (
        <span
          key={wording.id}
          aria-hidden={wording.id === shown ? undefined : 'true'}
          data-testid={wording.id === shown ? 'value-proposition' : undefined}
          className={
            wording.id === shown
              ? 'col-start-1 row-start-1'
              : 'invisible col-start-1 row-start-1'
          }
        >
          {wording.text}
        </span>
      ))}
    </p>
  );
}

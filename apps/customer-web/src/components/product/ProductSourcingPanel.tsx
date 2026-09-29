/**
 * "Who sells it and how it reaches you" on the product page (checklist Master
 * row 4).
 *
 * Four facts, each from the product read's `sourcing` and each shown only when
 * it is known:
 *
 *   - **Sold by** the approved seller whose offer the basket binds - with their
 *     kind, country and since when they are verified - or by the marketplace
 *     itself. The seller's name opens their products.
 *   - **Delivery to the chosen country**: available, needs documents, not
 *     sold there (with the operator's reason), not delivered there by this
 *     seller, or "choose your country" when none is chosen. Never a guess.
 *   - **Lead time and origin**, as the seller stated them.
 *   - **Inspection before dispatch**, as the operator's rules decide it for
 *     this seller and destination; "from" an order value when the rule has a
 *     threshold, because the page cannot know the order yet.
 *
 * It states facts and makes no promise the system does not keep: there is no
 * "guaranteed", no "protected", no delivery date.
 */
import { Link } from 'react-router-dom';
import { AlertIcon, BuildingIcon, CheckIcon, GlobeIcon, InfoIcon, ShieldIcon, TruckIcon } from '@/components/icons';
import { countryName } from '@/lib/iso-countries';
import { formatMoneyMinor } from '@/lib/format';
import type { ProductSourcing } from '@/lib/types';
import { useI18n } from '@/i18n/i18n-context';

function Row({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    // The term and its detail are the row's own children, so assistive
    // technology reads each pair as one; the icon sits inside the term.
    <div className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-3 py-3">
      <dt className="col-span-2 flex items-center gap-3 text-xs font-semibold uppercase tracking-wide text-ink-subtle">
        <span className="shrink-0 text-brand">{icon}</span>
        <span className="min-w-0">{label}</span>
      </dt>
      <dd className="col-start-2 mt-0.5 text-sm text-ink">{children}</dd>
    </div>
  );
}

export function ProductSourcingPanel({ sourcing }: { sourcing: ProductSourcing | undefined }): React.JSX.Element | null {
  const { t, language } = useI18n();
  if (sourcing === undefined) return null;

  const destination = sourcing.destination === null ? '' : countryName(sourcing.destination, language);
  const seller = sourcing.seller;
  const notes = sourcing.delivery.notes;
  const verifiedOn =
    seller?.verifiedAt == null
      ? null
      : new Intl.DateTimeFormat(language, { month: 'long', year: 'numeric' }).format(new Date(seller.verifiedAt));

  const delivery = (() => {
    switch (sourcing.delivery.status) {
      case 'AVAILABLE':
        return { tone: 'ok' as const, text: t('product.sourcing.deliverable', { country: destination }) };
      case 'DOCUMENTS_REQUIRED':
        return { tone: 'warn' as const, text: t('product.sourcing.documentsRequired', { country: destination }) };
      case 'BLOCKED':
        return { tone: 'bad' as const, text: t('product.sourcing.blocked', { country: destination }) };
      case 'SELLER_DOES_NOT_DELIVER':
        return { tone: 'bad' as const, text: t('product.sourcing.sellerDoesNotDeliver', { country: destination }) };
      case 'CHOOSE_DESTINATION':
        return { tone: 'info' as const, text: t('product.sourcing.chooseCountry') };
      default:
        return null;
    }
  })();

  const inspection = (() => {
    switch (sourcing.inspection.outlook) {
      case 'REQUIRED':
        return t('product.sourcing.inspectionRequired');
      case 'REQUIRED_FROM_VALUE':
        return t('product.sourcing.inspectionFromValue', {
          amount: formatMoneyMinor(sourcing.inspection.fromValueMinor, sourcing.inspection.currency ?? ''),
        });
      case 'DEPENDS_ON_DESTINATION':
        return t('product.sourcing.inspectionDependsOnCountry');
      case 'NOT_REQUIRED':
        return t('product.sourcing.inspectionNotRequired');
      default:
        return null;
    }
  })();

  return (
    <section aria-labelledby="product-sourcing" className="mt-6 rounded-lg border border-border bg-surface px-4 shadow-card">
      <h2 id="product-sourcing" className="pt-4 text-title-sm text-ink">
        {t('product.sourcing.heading')}
      </h2>
      <dl className="divide-y divide-border-subtle">
        <Row icon={<BuildingIcon className="h-5 w-5" />} label={t('product.sourcing.soldBy')}>
          {seller === null ? (
            t('product.sourcing.soldByMarketplace')
          ) : (
            <>
              <Link
                to={`/suppliers/${encodeURIComponent(seller.slug)}`}
                className="font-medium text-brand underline-offset-2 hover:text-brand-hover hover:underline
                           focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
              >
                {seller.displayName}
              </Link>
              <span className="block text-ink-muted">
                {t(`home.supplierKind.${seller.kind}`)} · {countryName(seller.registrationCountry, language)}
              </span>
              <span className="mt-1 flex items-center gap-1.5 text-xs font-medium text-success">
                <ShieldIcon className="h-4 w-4 shrink-0" />
                {verifiedOn === null
                  ? t('home.supplierVerified')
                  : t('home.supplierVerifiedSince', { date: verifiedOn })}
              </span>
            </>
          )}
        </Row>

        {delivery !== null && (
          <Row icon={<GlobeIcon className="h-5 w-5" />} label={t('product.sourcing.delivery')}>
            <span
              className={
                delivery.tone === 'ok'
                  ? 'flex items-start gap-1.5 text-success'
                  : delivery.tone === 'bad'
                    ? 'flex items-start gap-1.5 text-danger'
                    : delivery.tone === 'warn'
                      ? 'flex items-start gap-1.5 text-warning'
                      : 'flex items-start gap-1.5 text-ink-muted'
              }
            >
              {delivery.tone === 'ok' ? (
                <CheckIcon className="mt-0.5 h-4 w-4 shrink-0" />
              ) : delivery.tone === 'info' ? (
                <InfoIcon className="mt-0.5 h-4 w-4 shrink-0" />
              ) : (
                <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
              )}
              <span>{delivery.text}</span>
            </span>
            {notes.map((note, index) => (
              <span key={index} className="mt-1 block text-ink-muted">
                {note.reason}
                {note.requiredDocuments.length > 0 && (
                  <span className="block">
                    {t('product.sourcing.documentsList', { documents: note.requiredDocuments.join(', ') })}
                  </span>
                )}
              </span>
            ))}
          </Row>
        )}

        {(sourcing.handlingTimeDays !== null || sourcing.countryOfOrigin !== null) && (
          <Row icon={<TruckIcon className="h-5 w-5" />} label={t('product.sourcing.leadTimeAndOrigin')}>
            {sourcing.handlingTimeDays !== null && (
              <span className="block">
                {t('product.sourcing.handlingTime', {
                  count: sourcing.handlingTimeDays,
                  days: sourcing.handlingTimeDays,
                })}
              </span>
            )}
            {sourcing.countryOfOrigin !== null && (
              <span className="block">
                {t('product.sourcing.origin', { country: countryName(sourcing.countryOfOrigin, language) })}
              </span>
            )}
          </Row>
        )}

        {inspection !== null && (
          <Row icon={<ShieldIcon className="h-5 w-5" />} label={t('product.sourcing.inspection')}>
            {inspection}
          </Row>
        )}
      </dl>
    </section>
  );
}

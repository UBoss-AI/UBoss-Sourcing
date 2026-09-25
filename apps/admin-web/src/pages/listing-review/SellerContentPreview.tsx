/**
 * The seller's description and specifications, as the moderator reviews them.
 *
 * Read only, and in the order the product page will show them: approving the
 * listing puts exactly this on the page. Text is shown as text - the server
 * removed markup when the seller saved it, and nothing here would render it.
 */
import { Card } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import type { ListingContent } from '@/lib/sellers';

const GROUP_ORDER = [
  'GENERAL',
  'TECHNICAL',
  'DIMENSIONS_WEIGHT',
  'MATERIAL',
  'PERFORMANCE',
  'COMPATIBILITY',
  'PACKAGING',
  'CARTON',
  'CONTAINER',
  'COMPLIANCE',
  'WARRANTY',
  'IN_THE_BOX',
  'MANUFACTURER',
  'SELLER',
  'ORIGIN',
];

export function SellerContentPreview({ content }: { content: ListingContent | null }): React.JSX.Element {
  const { t } = useI18n();
  const groups = [...(content?.specifications ?? [])]
    .filter((group) => group.rows.length > 0)
    .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
  const sections = content?.descriptionSections ?? [];
  const overrides = content?.variantOverrides ?? [];
  const empty = groups.length === 0 && sections.length === 0 && overrides.length === 0;

  return (
    <Card title={t('listingReview.content.title')} bodyClassName="space-y-5 px-5 py-4">
      {empty ? (
        <p className="text-sm text-ink-muted">{t('listingReview.content.none')}</p>
      ) : (
        <>
          {sections.map((section, index) => (
            <div key={index} className="min-w-0">
              {section.heading !== '' && <h3 className="text-sm font-semibold text-ink">{section.heading}</h3>}
              {section.imageMediaId !== null && (
                <p className="text-xxs text-ink-subtle">{t('listingReview.content.withPicture')}</p>
              )}
              <p className="mt-1 whitespace-pre-line text-sm text-ink-muted [overflow-wrap:anywhere]">{section.body}</p>
            </div>
          ))}
          {groups.map((group) => (
            <div key={group.group}>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                {t(`product.specGroup.${group.group}` as TranslationKey)}
              </h3>
              <dl className="mt-1 divide-y divide-border-subtle rounded-md border border-border">
                {group.rows.map((row) => (
                  <div key={row.label} className="grid grid-cols-1 gap-0.5 px-3 py-2 text-sm sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-4">
                    <dt className="text-ink-muted [overflow-wrap:anywhere]">
                      {row.label}
                      {row.highlight && <span className="ml-1.5 text-xxs font-semibold text-brand">{t('listingReview.content.highlight')}</span>}
                    </dt>
                    <dd className="text-ink [overflow-wrap:anywhere]">
                      {row.value}
                      {row.unit !== null && ` ${row.unit}`}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
          {overrides.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{t('listingReview.content.overrides')}</h3>
              <ul className="mt-1 space-y-1 text-sm">
                {overrides.map((row, index) => (
                  <li key={index} className="[overflow-wrap:anywhere]">
                    <span className="text-ink-muted">{row.variantSignature}</span> · {row.label}: {row.value}
                    {row.unit !== null && ` ${row.unit}`}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

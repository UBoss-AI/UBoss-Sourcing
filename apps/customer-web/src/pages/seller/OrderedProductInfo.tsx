/**
 * "Ordered product information" for one line of a seller's order.
 *
 * What the customer bought, as it was described when they ordered it: the
 * snapshot the server froze in the order's own transaction. Read only - there
 * is no control on it that changes anything - and the live listing is a
 * separate, clearly named link, so editing the product never looks like
 * editing the order.
 *
 * An order from before snapshots existed shows today's listing instead, under
 * a notice that says exactly that. Nothing is filled in where the order holds
 * nothing: a tab with no content says so rather than inventing a row.
 *
 * Four tabs, a real tablist: arrow keys move between them, Home and End go to
 * the ends, and only the selected tab is in the Tab order.
 */
import { useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';
import { formatNumber } from '@/lib/format';
import { SafeHtml } from '@/lib/safe-html';
import type { OrderedProductInfo as Info } from '@/lib/seller';

type Tab = 'description' | 'specifications' | 'packaging' | 'selections';
const TABS: readonly Tab[] = ['description', 'specifications', 'packaging', 'selections'];

function Facts({ rows }: { rows: [string, string | null][] }): React.JSX.Element {
  const { t } = useI18n();
  const shown = rows.filter((row): row is [string, string] => row[1] !== null && row[1] !== '');
  if (shown.length === 0) return <p className="text-xs text-ink-subtle">{t('seller.orderedInfo.nothingRecorded')}</p>;
  return (
    <dl className="divide-y divide-border-subtle rounded-md border border-border-subtle">
      {shown.map(([label, value]) => (
        <div key={label} className="grid grid-cols-1 gap-0.5 px-3 py-2 text-xs sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-4">
          <dt className="text-ink-muted">{label}</dt>
          <dd className="text-ink [overflow-wrap:anywhere]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function OrderedProductInfo({
  source,
  info,
  listingPath,
  sellerSku,
}: {
  source: 'SNAPSHOT' | 'CURRENT_LISTING' | 'UNAVAILABLE';
  info: Info | null;
  /** The seller's listing to edit. Absent on the customer's own order page. */
  listingPath?: string;
  /** The seller's own code. Absent on the customer's own order page. */
  sellerSku?: string;
}): React.JSX.Element {
  const isSeller = listingPath !== undefined;
  const { t, intlLocale } = useI18n();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('description');
  const baseId = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const regionId = `${baseId}-region`;

  const move = (index: number): void => {
    const next = TABS[(index + TABS.length) % TABS.length] ?? 'description';
    setTab(next);
    tabRefs.current[TABS.indexOf(next)]?.focus();
  };

  const n = (value: number | null): string | null => (value === null ? null : formatNumber(value));

  return (
    <section className="mt-3 rounded-md border border-border-subtle">
      <h3 className="m-0">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={regionId}
          onClick={() => {
            setOpen((value) => !value);
          }}
          className="flex min-h-10 w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-semibold text-ink hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand"
        >
          {t('seller.orderedInfo.title')}
          <span aria-hidden="true" className={cx('text-ink-subtle transition-transform motion-reduce:transition-none', open && 'rotate-180')}>
            ▾
          </span>
        </button>
      </h3>
      <div id={regionId} hidden={!open} className="space-y-3 border-t border-border-subtle px-3 py-3">
        {source === 'CURRENT_LISTING' && (
          <p role="note" className="rounded-md bg-warning-soft px-3 py-2 text-xs text-ink">
            {t('seller.orderedInfo.fallback')}
          </p>
        )}
        {source === 'UNAVAILABLE' || info === null ? (
          <p className="text-xs text-ink-muted">{t('seller.orderedInfo.unavailable')}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-start justify-between gap-2 text-xs">
              <div className="min-w-0">
                <p className="font-medium text-ink [overflow-wrap:anywhere]">{info.productName}</p>
                <p className="text-ink-muted">
                  {sellerSku === undefined
                    ? t('seller.orderedInfo.skuOnly', { sku: info.sku })
                    : t('seller.orderedInfo.skuLine', { sku: info.sku, code: sellerSku })}
                  {info.variantName !== null && <> · {info.variantName}</>}
                </p>
                {source === 'SNAPSHOT' && (
                  <p className="text-ink-subtle">
                    {t('seller.orderedInfo.capturedAt', {
                      date: new Intl.DateTimeFormat(intlLocale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(info.capturedAt)),
                    })}
                  </p>
                )}
              </div>
              {listingPath !== undefined && (
                <Link to={listingPath} className="shrink-0 font-medium text-brand underline underline-offset-2">
                  {t('seller.orderedInfo.viewListing')}
                </Link>
              )}
            </div>

            <div role="tablist" aria-label={t('seller.orderedInfo.title')} className="flex flex-wrap gap-1 border-b border-border-subtle">
              {TABS.map((key, index) => (
                <button
                  key={key}
                  ref={(element) => {
                    tabRefs.current[index] = element;
                  }}
                  type="button"
                  role="tab"
                  id={`${baseId}-tab-${key}`}
                  aria-selected={tab === key}
                  aria-controls={`${baseId}-panel-${key}`}
                  tabIndex={tab === key ? 0 : -1}
                  onClick={() => {
                    setTab(key);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowRight') move(index + 1);
                    else if (event.key === 'ArrowLeft') move(index - 1);
                    else if (event.key === 'Home') move(0);
                    else if (event.key === 'End') move(TABS.length - 1);
                    else return;
                    event.preventDefault();
                  }}
                  className={cx(
                    '-mb-px min-h-9 border-b-2 px-3 text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand',
                    tab === key ? 'border-brand text-brand' : 'border-transparent text-ink-muted hover:text-ink',
                  )}
                >
                  {t(`seller.orderedInfo.tab.${key}` as TranslationKey)}
                </button>
              ))}
            </div>

            {TABS.map((key) => (
              <div
                key={key}
                role="tabpanel"
                id={`${baseId}-panel-${key}`}
                aria-labelledby={`${baseId}-tab-${key}`}
                hidden={tab !== key}
                tabIndex={0}
                className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
              >
                {key === 'description' &&
                  (info.description.sections.length === 0 && info.description.text === null && info.description.html === null ? (
                    <p className="text-xs text-ink-subtle">{t('seller.orderedInfo.nothingRecorded')}</p>
                  ) : (
                    <div className="max-w-prose space-y-3 text-xs leading-relaxed text-ink-muted">
                      {info.description.html !== null ? (
                        <SafeHtml html={info.description.html} className="break-words [&_li]:ml-5 [&_li]:list-disc [&_p]:mt-2" />
                      ) : info.description.text !== null ? (
                        <p className="whitespace-pre-wrap break-words">{info.description.text}</p>
                      ) : null}
                      {info.description.sections.map((section, index) => (
                        <div key={index}>
                          {section.heading !== '' && <p className="font-semibold text-ink">{section.heading}</p>}
                          <p className="whitespace-pre-line [overflow-wrap:anywhere]">{section.body}</p>
                        </div>
                      ))}
                    </div>
                  ))}
                {key === 'specifications' &&
                  (info.specificationGroups.length === 0 ? (
                    <p className="text-xs text-ink-subtle">{t('seller.orderedInfo.nothingRecorded')}</p>
                  ) : (
                    <div className="space-y-3">
                      {info.specificationGroups.map((group) => (
                        <div key={group.group}>
                          <p className="mb-1 text-xxs font-semibold uppercase tracking-wide text-ink-muted">
                            {t(`product.specGroup.${group.group}` as TranslationKey)}
                          </p>
                          <Facts rows={group.rows.map((row) => [row.label, row.unit === null ? row.value : `${row.value} ${row.unit}`])} />
                        </div>
                      ))}
                    </div>
                  ))}
                {key === 'packaging' && (
                  <Facts
                    rows={[
                      [t('seller.orderedInfo.orderUnit'), t(`preorder.unit.${info.packaging.orderingUnit}` as TranslationKey, { defaultValue: info.packaging.orderingUnit })],
                      [t('seller.orderedInfo.unitQuantity'), n(info.packaging.unitQuantity)],
                      [t('seller.orderedInfo.piecesPerUnit'), n(info.packaging.piecesPerUnit)],
                      [t('seller.orderedInfo.equivalentPieces'), n(info.packaging.equivalentPieces)],
                      [t('seller.orderedInfo.moq'), n(info.moqPieces)],
                      [t('seller.orderedInfo.piecesPerCarton'), n(info.piecesPerCarton)],
                      [t('seller.orderedInfo.cartonsPerPallet'), n(info.packaging.cartonsPerPallet)],
                      [t('seller.orderedInfo.cartonsPerContainer'), n(info.packaging.cartonsPerContainer)],
                      [
                        t('seller.orderedInfo.container20'),
                        info.containerCapacity.CONTAINER_20_FT === null ? null : n(info.containerCapacity.CONTAINER_20_FT.pieces),
                      ],
                      [
                        t('seller.orderedInfo.container40'),
                        info.containerCapacity.CONTAINER_40_FT === null ? null : n(info.containerCapacity.CONTAINER_40_FT.pieces),
                      ],
                      [
                        t('seller.orderedInfo.dimensions'),
                        info.packaging.dimensionsMm === null
                          ? null
                          : [info.packaging.dimensionsMm.length, info.packaging.dimensionsMm.width, info.packaging.dimensionsMm.height]
                              .map((value) => (value === null ? '—' : formatNumber(value)))
                              .join(' × ') + ' mm',
                      ],
                    ]}
                  />
                )}
                {key === 'selections' && (
                  <div className="space-y-3">
                    <Facts
                      rows={[
                        [t('seller.orderedInfo.variant'), info.variantName],
                        ...info.selectedOptions.map((option): [string, string] => [option.name, option.value]),
                      ]}
                    />
                    {info.specialInstructions !== null && info.specialInstructions !== '' && (
                      <div className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-xs">
                        <p className="font-semibold text-warning">{t('seller.orderDetail.buyerInstructions')}</p>
                        <p className="mt-0.5 whitespace-pre-line text-ink">{info.specialInstructions}</p>
                      </div>
                    )}
                    {isSeller && <p className="text-xxs text-ink-subtle">{t('seller.orderedInfo.documentsNote')}</p>}
                  </div>
                )}
              </div>
            ))}
          </>
        )}
      </div>
    </section>
  );
}

/**
 * The department card, and the grid it sits in.
 *
 * Two pages show the same object. The front page shows the top level, and a
 * category page shows what is inside the category being read — and once a
 * catalogue is filed under one department those are the same set of cards, one
 * click apart. A shopper who recognised "Insulin Syringe" by its shape on one
 * page has to find the same shape on the other, so this is one component
 * rather than two that drift.
 *
 * The count is always the whole subtree, because that is what clicking the
 * card will show; see `totalProductCount` in the backend's category service.
 */
import { Link } from 'react-router-dom';
import { ChevronRightIcon } from '@/components/icons';
import { categoryMark } from '@/lib/category-mark';
import { cx } from '@/lib/cx';
import { formatNumber } from '@/lib/format';
import { useI18n } from '@/i18n/i18n-context';
import type { CategoryNode } from '@/lib/types';

export function CategoryCards({
  categories,
}: {
  categories: CategoryNode[];
}): React.JSX.Element | null {
  const { t } = useI18n();

  if (categories.length === 0) return null;

  // Never more columns than there are departments. A catalogue filed under one
  // department would otherwise put a single card in the corner of a four-wide
  // grid, which reads as a page that failed to load the other three.
  const columns =
    ['grid-cols-1', 'grid-cols-1 sm:grid-cols-2', 'grid-cols-2 md:grid-cols-3'][
      categories.length - 1
    ] ?? 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4';

  // One department is the doorway to the whole catalogue, so it is drawn as
  // one: a card the width of the page with a mark and a name to match. The
  // same card at the size it takes in a row of four would read as a leftover.
  const sole = categories.length === 1;

  return (
    /* Three across from `md` at the widest, not `sm`. The card is a horizontal
       row — mark, name, count, chevron — so a 200px column at `sm` would leave
       the category name about 80px, and "Packaging & Consumables" would arrive
       in four lines. */
    <ul className={cx('grid gap-3', columns)}>
      {categories.map((category) => {
        const Mark = categoryMark(category.name, category.slug);

        return (
          <li key={category.id}>
            <Link
              to={`/category/${category.slug}`}
              className={cx(
                'group flex h-full items-center rounded-lg border border-border bg-surface shadow-card transition-[border-color,box-shadow] hover:border-border-hover hover:shadow-card-hover',
                sole ? 'gap-4 p-5 sm:gap-6 sm:p-6' : 'gap-3.5 p-3.5 sm:gap-4 sm:p-4',
              )}
            >
              {/* The placeholder treatment. A tinted plate rather than a grey
                  box: grey reads as a missing image, a brand-tinted plate
                  reads as a chosen mark. */}
              <span
                aria-hidden="true"
                className={cx(
                  'relative flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-brand-soft text-brand ring-1 ring-inset ring-brand/15 transition-colors group-hover:bg-brand-soft-hover',
                  sole ? 'h-16 w-16 sm:h-20 sm:w-20' : 'h-12 w-12 sm:h-14 sm:w-14',
                )}
              >
                <span
                  className="absolute inset-0"
                  style={{
                    backgroundImage:
                      'linear-gradient(to right, rgb(var(--brand) / 0.07) 1px, transparent 1px),' +
                      'linear-gradient(to bottom, rgb(var(--brand) / 0.07) 1px, transparent 1px)',
                    backgroundSize: '8px 8px',
                  }}
                />
                <Mark
                  className={cx(
                    'relative',
                    sole ? 'h-8 w-8 sm:h-10 sm:w-10' : 'h-6 w-6 sm:h-7 sm:w-7',
                  )}
                />
              </span>

              <span className="min-w-0 flex-1">
                <span
                  className={cx(
                    'block leading-snug text-ink group-hover:text-brand',
                    sole ? 'text-title sm:text-title-lg' : 'text-sm font-medium',
                  )}
                >
                  {category.name}
                </span>
                <span className={cx('mt-1 block text-ink-muted', sole ? 'text-sm' : 'text-xs')}>
                  {t('catalog.productCount', {
                    count: category.totalProductCount,
                    products: formatNumber(category.totalProductCount),
                  })}
                  {/* Only worth saying when the department is the whole
                      catalogue: it is the one card, so its shape is the only
                      hint of how much sits behind it. */}
                  {sole && category.children.length > 0 && (
                    <>
                      {' '}
                      {t('catalog.inSubCategories', {
                        count: category.children.length,
                        categories: formatNumber(category.children.length),
                      })}
                    </>
                  )}
                </span>
              </span>

              <ChevronRightIcon
                className={cx(
                  'shrink-0 text-ink-subtle transition-colors group-hover:text-brand',
                  sole ? 'h-5 w-5' : 'h-4 w-4',
                )}
              />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

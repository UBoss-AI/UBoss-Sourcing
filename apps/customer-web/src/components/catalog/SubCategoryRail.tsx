/**
 * What is inside a department, as a deck of photographs.
 *
 * Press a department in the strip and this is what answers: one square card
 * per shelf inside it, the one in focus square to the reader with a link into
 * it, the rest tipped back behind. It replaced a grid of small rows, and the
 * reason is the same one the front page's rail gives — a shopper who does not
 * yet know the catalogue's vocabulary cannot pick between "Consumables &
 * Sampling" and "Measurement & Calibration" from the words, and can from the
 * pictures.
 *
 * The deck itself is `ui/carousel.tsx` and knows nothing about categories.
 * This file is the whole of what a sub-category *is* on it: which photograph
 * it gets, what the card says, and where pressing it goes. The split is the
 * same one `CategoryCarousel` keeps with `ui/apple-cards-carousel.tsx`, and
 * for the same reason: the next thing that wants a deck gets one without
 * inheriting the catalogue.
 *
 * WHERE THE PHOTOGRAPHS COME FROM
 *
 * `lib/subcategory-cover.ts`, which recognises the starter catalogue's own
 * sub-category names and nothing else. A name it has not seen gets the drawn
 * plate below instead — the shelf's own mark, large, on the brand gradient —
 * which is a finished card and not an apology for a missing one. An operator
 * who files their catalogue under names of their own gets a deck entirely of
 * these, and it still works.
 *
 * WHY THE COUNT IS NOT ON THE CARD
 *
 * It is on the link underneath, where the department's own count already sits.
 * A photograph with a title, a count, and a button on it is three things
 * competing on one 26rem square, and the count is the one a shopper checks
 * after choosing rather than while choosing.
 */
import { Link } from 'react-router-dom';
import { Carousel } from '@/components/ui/carousel';
import type { CarouselSlide } from '@/components/ui/carousel';
import { categoryMark } from '@/lib/category-mark';
import { subCategoryCover } from '@/lib/subcategory-cover';
import { formatNumber } from '@/lib/format';
import { useI18n } from '@/i18n/i18n-context';
import type { CategoryNode } from '@/lib/types';

export function SubCategoryRail({
  department,
  subCategories,
}: {
  /** The department these are inside, for the deck's accessible name. */
  department: string;
  subCategories: CategoryNode[];
}): React.JSX.Element | null {
  const { t } = useI18n();

  if (subCategories.length === 0) return null;

  const slides: CarouselSlide[] = subCategories.map((category) => ({
    id: category.id,
    title: category.name,
    src: subCategoryCover(category.name, category.slug),
    fallback: <ShelfPlate name={category.name} slug={category.slug} />,
    action: (
      /*
       * "Browse", not "Browse Prefilled Heparin Syringe".
       *
       * The name is set in 20px directly above the button; repeating it inside
       * a control 288px wide wrapped it to three lines on the longer shelves.
       * The accessible name still carries it — `aria-label` — so a screen
       * reader hears which department it is browsing rather than a row of
       * identical "Browse" links.
       */
      <Link
        to={`/category/${category.slug}`}
        aria-label={t('home.browseDepartment', { department: category.name })}
        className="inline-flex h-10 items-center gap-2 rounded-md bg-surface px-4 text-sm font-semibold
                   text-ink shadow-lift transition hover:bg-surface-hover
                   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white
                   focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
      >
        {t('catalog.browse')}
        <span className="text-xs font-normal text-ink-muted">
          {t('catalog.productCount', {
            count: category.totalProductCount,
            products: formatNumber(category.totalProductCount),
          })}
        </span>
      </Link>
    ),
  }));

  return <Carousel slides={slides} label={t('catalog.insideDepartment', { department })} />;
}

/**
 * The card for a shelf with no photograph.
 *
 * The shelf's own mark from `lib/category-mark.ts` — the same picture it
 * carries everywhere else in the catalogue, so a shopper who learned "IV
 * Cannula" by its shape on one page meets the same shape here — drawn large on
 * the brand gradient over the engineering grid the rest of the storefront
 * uses. Nothing is fetched and there is nothing to 404.
 */
function ShelfPlate({ name, slug }: { name: string; slug: string }): React.JSX.Element {
  const Mark = categoryMark(name, slug);

  return (
    <span
      aria-hidden="true"
      className="absolute inset-0 overflow-hidden bg-gradient-to-br from-brand via-brand-hover to-navy"
    >
      <span
        className="absolute inset-0"
        // Inline rather than an arbitrary Tailwind value, for the reason
        // `CategoryCarousel` gives: two stacked gradients in bracket syntax
        // are considerably harder to read than the CSS.
        style={{
          backgroundImage:
            'linear-gradient(to right, rgb(255 255 255 / 0.08) 1px, transparent 1px),' +
            'linear-gradient(to bottom, rgb(255 255 255 / 0.08) 1px, transparent 1px)',
          backgroundSize: '28px 28px',
        }}
      />
      <span className="absolute inset-0 flex items-center justify-center">
        <Mark className="h-28 w-28 text-white/40" />
      </span>
    </span>
  );
}

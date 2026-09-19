/**
 * Shop by category, as a rail of photographs.
 *
 * The front page's answer to "what do you sell?". One card per department the
 * catalogue actually stocks, scrolled sideways, and each one opens into a
 * panel listing what is inside it — so a shopper who knows roughly what they
 * want reaches the right sub-department in two presses without reading a
 * single price.
 *
 * The rail itself is `ui/apple-cards-carousel.tsx` and knows nothing about
 * categories. This file is the whole of what a department *is*: which picture
 * it gets, what the two lines on the card say, and what opening it shows. The
 * split is deliberate — the next thing that wants a rail of cards gets one
 * without inheriting the catalogue.
 *
 * WHAT IS ON A CARD, AND WHY IT IS THAT
 *
 * A picture, the department's name, how many products are behind it, and how
 * many sub-departments they are filed under. Both numbers are the whole
 * subtree, because that is what pressing the card will show — the same rule
 * `SubCategoryRail` follows, and for the same reason: a department whose
 * products all sit one level down holds none of its own, and a card reading
 * "0 products" over a photograph of a warehouse is a card that has lied.
 *
 * ONE LEVEL DOWN IS A DIFFERENT DECK
 *
 * `catalog/SubCategoryRail.tsx` is what a category page shows for its
 * children. It is a deck rather than a rail — one square card in focus with
 * the rest tipped back behind it — because the two are doing different jobs: a
 * rail is for skimming a whole floor, and a deck is for choosing between the
 * handful of shelves in one aisle. Two components, two jobs, one API read.
 */
import { Link } from 'react-router-dom';
import { Carousel } from '@/components/ui/apple-cards-carousel';
import type { CarouselCard } from '@/components/ui/apple-cards-carousel';
import { ButtonLink } from '@/components/ui';
import { categoryCover } from '@/lib/category-cover';
import { categoryMark } from '@/lib/category-mark';
import { stockedCategories } from '@/lib/category-tree';
import { formatNumber } from '@/lib/format';
import { useI18n } from '@/i18n/i18n-context';
import type { Translate } from '@/i18n/i18n-context';
import type { CategoryNode } from '@/lib/types';

export function CategoryCarousel({
  categories,
}: {
  categories: CategoryNode[];
}): React.JSX.Element | null {
  const { t } = useI18n();

  if (categories.length === 0) return null;

  const cards: CarouselCard[] = categories.map((category) => {
    const subCategories = stockedCategories(category.children);

    return {
      id: category.id,
      eyebrow: t('catalog.productCount', {
        count: category.totalProductCount,
        products: formatNumber(category.totalProductCount),
      }),
      title: category.name,
      meta:
        subCategories.length === 0
          ? null
          : t('home.categorySubCategories', {
              count: subCategories.length,
              categories: formatNumber(subCategories.length),
            }),
      src: categoryCover(category.name, category.slug),
      fallback: <CategoryPlate name={category.name} slug={category.slug} />,
      content: (close) => (
        <CategoryPanel category={category} subCategories={subCategories} t={t} onLeave={close} />
      ),
    };
  });

  return <Carousel cards={cards} />;
}

/**
 * The card for a department with no photograph.
 *
 * Which is not a failure state: `lib/category-cover.ts` only recognises
 * department names this catalogue has been told about, so an operator filing
 * their catalogue under names of their own gets a rail entirely of these — and
 * it has to be a finished-looking card rather than an apology for a missing
 * one. So it is drawn: the department's own mark, large, on a brand gradient
 * over the same engineering grid the greeting uses. Nothing is fetched and
 * there is nothing to 404.
 *
 * The mark is `lib/category-mark.ts`, the same picture the department already
 * has in the grid on its own page — a shopper who learned a department by its
 * shape in one place meets the same shape in the other.
 */
function CategoryPlate({ name, slug }: { name: string; slug: string }): React.JSX.Element {
  const Mark = categoryMark(name, slug);

  return (
    <span
      aria-hidden="true"
      className="absolute inset-0 overflow-hidden bg-gradient-to-br from-brand via-brand-hover to-navy"
    >
      <span
        className="absolute inset-0"
        // Inline rather than an arbitrary Tailwind value, for the reason
        // `HomePage`'s backdrop gives: this is two stacked gradients and the
        // bracket syntax for them is considerably harder to read than the CSS.
        style={{
          backgroundImage:
            'linear-gradient(to right, rgb(255 255 255 / 0.08) 1px, transparent 1px),' +
            'linear-gradient(to bottom, rgb(255 255 255 / 0.08) 1px, transparent 1px)',
          backgroundSize: '28px 28px',
        }}
      />
      <span className="absolute inset-0 flex items-center justify-center">
        <Mark className="h-24 w-24 text-white/40 transition-transform duration-500 group-hover:scale-105 md:h-36 md:w-36" />
      </span>
    </span>
  );
}

/**
 * What a card opens into.
 *
 * The sub-departments, each with its own subtree count, and one filled link
 * into the department itself. A department with nothing beneath it gets the
 * link on its own, which is the whole of the useful answer for it.
 *
 * Every link calls `onLeave`. A link inside a modal dialog navigates the page
 * *behind* the dialog, and without this the shopper arrives at the category
 * they asked for with the panel still sitting on top of it.
 */
function CategoryPanel({
  category,
  subCategories,
  t,
  onLeave,
}: {
  category: CategoryNode;
  subCategories: CategoryNode[];
  t: Translate;
  onLeave: () => void;
}): React.JSX.Element {
  return (
    <div>
      <p className="text-sm leading-relaxed text-ink-muted">
        {t('home.categoryPanelIntro', { department: category.name })}
      </p>

      {subCategories.length > 0 && (
        <>
          <h4 className="mt-6 text-title-xs text-ink">{t('home.categoryInsideThis')}</h4>

          {/* Two columns from `sm`, and the name truncates rather than wraps:
              this is a list to scan, and a department with twenty children
              that each take two lines is a panel nobody reaches the bottom
              of. */}
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {subCategories.map((child) => (
              <li key={child.id}>
                <Link
                  to={`/category/${child.slug}`}
                  onClick={onLeave}
                  className="group flex items-center justify-between gap-3 rounded-md border border-border bg-surface px-3.5 py-2.5 transition-[border-color,box-shadow] hover:border-border-hover hover:shadow-card"
                >
                  <span className="min-w-0 truncate text-sm font-medium text-ink group-hover:text-brand">
                    {child.name}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-ink-muted">
                    {formatNumber(child.totalProductCount)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="mt-6">
        <ButtonLink to={`/category/${category.slug}`} variant="primary" onClick={onLeave}>
          {t('home.browseDepartment', { department: category.name })}
        </ButtonLink>
      </div>
    </div>
  );
}

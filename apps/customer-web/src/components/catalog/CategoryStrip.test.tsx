/**
 * The department strip, and the deck a department opens into.
 *
 * What is worth pinning here is the handful of things that would each leave a
 * working-looking catalogue that is quietly wrong:
 *
 *   - **The lit item is the ROOT department.** A shopper inside "IV Cannula"
 *     is inside Medical Devices, and a strip that lit nothing because the slug
 *     in the address is not top-level would be telling them they are nowhere.
 *     This is the whole reason `rootCategorySlug` exists and it is invisible
 *     to anyone testing from a department page.
 *   - **Empty departments are not offered.** A link to a page with no products
 *     on it is a dead end, and the count that decides is the subtree's.
 *   - **A slide with no photograph is still a finished slide.** An operator
 *     whose sub-category names this catalogue has never seen gets the drawn
 *     plate, and that path is the one nobody developing against the seeded
 *     catalogue ever sees.
 *   - **Only the slide in focus is in the tab order.** A deck of twenty-six
 *     live links for one visible choice is twenty-six tab stops a keyboard
 *     user has to walk past.
 */
import { useState } from 'react';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { CategoryStrip } from './CategoryStrip';
import { SubCategoryRail } from './SubCategoryRail';
import { renderWithProviders as render } from '@/test/harness';
import type { CategoryNode } from '@/lib/types';

function node(
  overrides: Partial<CategoryNode> & Pick<CategoryNode, 'id' | 'name' | 'slug'>,
): CategoryNode {
  return {
    parentId: null,
    depth: 0,
    sortOrder: 0,
    isActive: true,
    productCount: 0,
    totalProductCount: 0,
    children: [],
    ...overrides,
  };
}

const CANNULA = node({
  id: 'cat-cannula',
  name: 'IV Cannula',
  slug: 'iv-cannula',
  depth: 1,
  parentId: 'cat-medical',
  productCount: 30,
  totalProductCount: 30,
});

/** A name no pattern in `lib/subcategory-cover.ts` recognises. */
const BESPOKE = node({
  id: 'cat-bespoke',
  name: 'Bespoke Widgetry',
  slug: 'bespoke-widgetry',
  depth: 1,
  parentId: 'cat-medical',
  productCount: 3,
  totalProductCount: 3,
});

const MEDICAL = node({
  id: 'cat-medical',
  name: 'Medical Devices',
  slug: 'medical-devices',
  totalProductCount: 33,
  children: [CANNULA, BESPOKE],
});

const HAND_TOOLS = node({
  id: 'cat-hand-tools',
  name: 'Hand Tools',
  slug: 'hand-tools',
  depth: 1,
  parentId: 'cat-tools',
  productCount: 12,
  totalProductCount: 12,
});

const ANVIL = node({
  id: 'cat-anvil',
  name: 'Anvils',
  slug: 'anvils',
  depth: 1,
  parentId: 'cat-tools',
  productCount: 1,
  totalProductCount: 1,
});

const TOOLS = node({
  id: 'cat-tools',
  name: 'Tools & Hardware',
  slug: 'tools-hardware',
  totalProductCount: 128,
  children: [HAND_TOOLS, ANVIL],
});

describe('the department strip', () => {
  it('shows nothing rather than an empty band', () => {
    render(<CategoryStrip departments={[]} activeSlug={null} />);

    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('opens with all products and then every department, as links', () => {
    render(<CategoryStrip departments={[MEDICAL, TOOLS]} activeSlug={null} />);

    const strip = screen.getByRole('navigation', { name: 'Departments' });
    const links = within(strip).getAllByRole('link');

    expect(links.map((link) => link.textContent)).toEqual([
      'All products',
      'Medical Devices',
      'Tools & Hardware',
    ]);
    expect(links[1]).toHaveAttribute('href', '/category/medical-devices');
  });

  it('lights "all products" on the catalogue itself', () => {
    render(<CategoryStrip departments={[MEDICAL, TOOLS]} activeSlug={null} />);

    expect(screen.getByRole('link', { name: 'All products' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Medical Devices' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  /*
   * The one that matters. `CatalogPage` resolves the root before passing it, so
   * a shopper reading `/category/iv-cannula` arrives here with
   * `activeSlug="medical-devices"` — and the department they are inside is lit
   * even though its own name is nowhere in the address bar.
   */
  it('lights the department a sub-category is filed under', () => {
    render(<CategoryStrip departments={[MEDICAL, TOOLS]} activeSlug="medical-devices" />);

    expect(screen.getByRole('link', { name: 'Medical Devices' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'All products' })).not.toHaveAttribute('aria-current');
  });
});

/**
 * The deck, with the page around it staying mounted.
 *
 * `CatalogPage` serves every listing, so moving between departments re-renders
 * the deck rather than remounting it — and that is the whole condition the two
 * tests below are about. RTL's own `rerender` cannot stand in for it: it
 * replaces the tree it was given, which here means dropping the router and
 * every provider with it. So the swap is driven from inside the tree, the way
 * the real page does it.
 */
function Swapper(): React.JSX.Element {
  const [department, setDepartment] = useState<'medical' | 'tools'>('medical');
  const [generation, setGeneration] = useState(0);

  // Fresh objects every render, and `generation` rides along so a "Refetch"
  // press is a real change of data rather than a no-op React can skip — the
  // same shelves under the same ids, which is what a background refetch of the
  // category tree actually hands the deck.
  const shelves = (department === 'medical' ? [CANNULA, BESPOKE] : [HAND_TOOLS, ANVIL]).map(
    (shelf) => ({ ...shelf, sortOrder: generation }),
  );

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setDepartment('tools');
        }}
      >
        Go to Tools &amp; Hardware
      </button>
      <button
        type="button"
        onClick={() => {
          setGeneration((n) => n + 1);
        }}
      >
        Refetch
      </button>
      {/* No `key`: the deck must survive both presses as one mounted
          component, which is exactly the condition being tested. */}
      <SubCategoryRail
        department={department === 'medical' ? 'Medical Devices' : 'Tools & Hardware'}
        subCategories={shelves}
      />
    </>
  );
}

describe('the sub-category deck', () => {
  it('shows nothing rather than an empty deck', () => {
    render(<SubCategoryRail department="Medical Devices" subCategories={[]} />);

    expect(screen.queryByRole('group')).not.toBeInTheDocument();
  });

  it('puts only the slide in focus in the tab order', () => {
    render(<SubCategoryRail department="Medical Devices" subCategories={[CANNULA, BESPOKE]} />);

    // The first slide's link is the only one rendered at all. This is a
    // condition in the component rather than an `invisible` class precisely
    // so it holds here, where there is no CSS.
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/category/iv-cannula');
  });

  it('offers every other slide as a button that brings it forward', async () => {
    const user = userEvent.setup();
    render(<SubCategoryRail department="Medical Devices" subCategories={[CANNULA, BESPOKE]} />);

    await user.click(screen.getByRole('button', { name: 'Show Bespoke Widgetry' }));

    expect(screen.getByRole('link')).toHaveAttribute('href', '/category/bespoke-widgetry');
    // And the slide that was in focus is now the one offering to come back.
    expect(screen.getByRole('button', { name: 'Show IV Cannula' })).toBeInTheDocument();
  });

  /*
   * `CatalogPage` stays mounted as a shopper moves between departments, so the
   * deck is re-rendered with new shelves rather than remounted. Left to
   * itself it keeps the index it was on: stepping to the second shelf of one
   * department and pressing another opened that one at its *last* card,
   * clamped against the right-hand edge, which reads as a department opening
   * at its end.
   */
  it('opens a different department at its first card, not at the index it was left on', async () => {
    const user = userEvent.setup();
    render(<Swapper />);

    await user.click(screen.getByRole('button', { name: 'Show Bespoke Widgetry' }));
    expect(screen.getByRole('link', { name: /Bespoke Widgetry/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Go to Tools & Hardware' }));

    expect(screen.getByRole('link', { name: /Hand Tools/ })).toBeInTheDocument();
  });

  /*
   * The other half: the same deck coming back from a background refetch of the
   * category tree is not a different deck, and must not throw away the shelf
   * somebody is reading.
   */
  it('keeps its place when the same shelves are re-rendered', async () => {
    const user = userEvent.setup();
    render(<Swapper />);

    await user.click(screen.getByRole('button', { name: 'Show Bespoke Widgetry' }));
    // The same department again — new objects, same shelves, which is what a
    // background refetch of the category tree hands it.
    await user.click(screen.getByRole('button', { name: 'Refetch' }));

    expect(screen.getByRole('link', { name: /Bespoke Widgetry/ })).toBeInTheDocument();
  });

  it('draws a plate for a sub-category with no photograph', () => {
    render(<SubCategoryRail department="Medical Devices" subCategories={[BESPOKE]} />);

    // Recognised names get an `<img>`; this one is not recognised, so there is
    // nothing to load and nothing to 404.
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Bespoke Widgetry/ })).toBeInTheDocument();
  });

  /*
   * The visible label is just "Browse" — the shelf's name is set large
   * directly above it and repeating it inside a 288px control wrapped it over
   * three lines. The accessible name still carries the shelf, so a screen
   * reader hears which one it is browsing rather than a deck of identical
   * "Browse" links, and the count rides along as visible text.
   */
  it('names the shelf to a screen reader and states the subtree count on screen', () => {
    render(<SubCategoryRail department="Medical Devices" subCategories={[CANNULA]} />);

    const browse = screen.getByRole('link', { name: 'Browse IV Cannula' });
    expect(browse).toHaveTextContent('Browse');
    expect(browse).toHaveTextContent('30 products');
  });
});

/**
 * The department rail on the front page.
 *
 * What is worth pinning here is not that it renders — it is the handful of
 * things that would each turn a working storefront into a broken-looking one
 * without failing anywhere else:
 *
 *   - **A card with no photograph still has a card.** An operator whose
 *     department names this catalogue has never seen gets the drawn plate, and
 *     that path is the one nobody developing against the seeded catalogue ever
 *     sees.
 *   - **The panel is a dialog, and it is labelled.** A modal with no
 *     accessible name is a modal a screen-reader user has been dropped into
 *     with no idea what it is. jsdom cannot check that focus is trapped — the
 *     note in `test/setup.ts` says why — but it can check this.
 *   - **A link inside the panel closes it.** The panel sits in the top layer;
 *     navigating underneath it and leaving it open is a page that looks like
 *     it failed to respond.
 *   - **The counts are the subtree.** A card is a promise about what pressing
 *     it will show.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { CategoryCarousel } from './CategoryCarousel';
import { renderWithProviders as render } from '@/test/harness';
import type { CategoryNode } from '@/lib/types';

function node(overrides: Partial<CategoryNode> & Pick<CategoryNode, 'id' | 'name' | 'slug'>): CategoryNode {
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

const TOOLS = node({
  id: 'cat-tools',
  name: 'Tools & Hardware',
  slug: 'tools-hardware',
  productCount: 4,
  totalProductCount: 128,
  children: [
    node({
      id: 'cat-drills',
      name: 'Cordless Drills',
      slug: 'cordless-drills',
      depth: 1,
      parentId: 'cat-tools',
      productCount: 40,
      totalProductCount: 40,
    }),
    // Empty, so it must not be offered: a sub-department with nothing in it is
    // a link to an empty page.
    node({
      id: 'cat-empty',
      name: 'Discontinued',
      slug: 'discontinued',
      depth: 1,
      parentId: 'cat-tools',
    }),
  ],
});

/** A name no pattern in `lib/category-cover.ts` recognises. */
const UNKNOWN = node({
  id: 'cat-widgets',
  name: 'Bespoke Widgetry',
  slug: 'bespoke-widgetry',
  productCount: 7,
  totalProductCount: 7,
});

describe('the department rail', () => {
  it('shows nothing at all rather than an empty rail', () => {
    render(<CategoryCarousel categories={[]} />);

    // Not `container` — the harness mounts the toast region, which is always
    // there. What must be absent is the rail: no cards, and no pair of scroll
    // buttons offering to move a track that does not exist.
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('gives each department a card carrying its whole subtree count', () => {
    render(<CategoryCarousel categories={[TOOLS, UNKNOWN]} />);

    const card = screen.getByRole('button', { name: /Tools & Hardware/ });

    // 128, not the 4 filed directly in it — pressing the card shows the
    // subtree, so the card has to count the subtree.
    expect(card).toHaveTextContent('128 products');
    expect(card).not.toHaveTextContent('4 products');
  });

  it('counts only the sub-departments that have something in them', () => {
    render(<CategoryCarousel categories={[TOOLS]} />);

    // Two children, one of them empty.
    expect(screen.getByRole('button', { name: /Tools & Hardware/ })).toHaveTextContent(
      '1 sub-category',
    );
  });

  it('draws a department it has no photograph for rather than leaving a hole', () => {
    render(<CategoryCarousel categories={[UNKNOWN]} />);

    const card = screen.getByRole('button', { name: /Bespoke Widgetry/ });

    // The drawn plate is SVG and inline CSS; there is no <img> to fail to
    // load, and the name is still on the card.
    expect(card.querySelector('img')).toBeNull();
    expect(card.querySelector('svg')).not.toBeNull();
    expect(card).toHaveTextContent('Bespoke Widgetry');
  });

  it('opens a labelled dialog listing what is inside the department', async () => {
    const user = userEvent.setup();
    render(<CategoryCarousel categories={[TOOLS]} />);

    await user.click(screen.getByRole('button', { name: /Tools & Hardware/ }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAccessibleName('Tools & Hardware');

    expect(within(dialog).getByRole('link', { name: /Cordless Drills/ })).toHaveAttribute(
      'href',
      '/category/cordless-drills',
    );
    // The empty sub-department is not offered here either.
    expect(within(dialog).queryByRole('link', { name: /Discontinued/ })).toBeNull();

    expect(within(dialog).getByRole('link', { name: 'Browse Tools & Hardware' })).toHaveAttribute(
      'href',
      '/category/tools-hardware',
    );
  });

  it('closes the panel when a link inside it navigates away', async () => {
    const user = userEvent.setup();
    render(<CategoryCarousel categories={[TOOLS]} />);

    await user.click(screen.getByRole('button', { name: /Tools & Hardware/ }));
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('link', { name: /Cordless Drills/ }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('closes the panel on its close button', async () => {
    const user = userEvent.setup();
    render(<CategoryCarousel categories={[TOOLS]} />);

    await user.click(screen.getByRole('button', { name: /Tools & Hardware/ }));
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: 'Close' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('names its scroll buttons for somebody who cannot see which way they point', () => {
    render(<CategoryCarousel categories={[TOOLS, UNKNOWN]} />);

    // Disabled on arrival in jsdom, where every box is 0x0 and nothing
    // overflows — which is exactly the state the original got wrong by
    // assuming the rail always had somewhere to go.
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });
});

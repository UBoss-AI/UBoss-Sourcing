/**
 * Finding your way about the category tree.
 *
 * `/catalog/categories` returns the whole tree in one cached read, so every
 * question a page has about where it is — what is above this, what is inside
 * it — is answered by walking what is already in memory rather than by asking
 * the server again. The category detail endpoint returns a category and not
 * its family, which is why it cannot answer either question.
 */
import type { CategoryNode } from '@/lib/types';

export interface FoundCategory {
  node: CategoryNode;
  /** `null` when the category is at the top level. */
  parent: CategoryNode | null;
}

/** The node for a slug, and its parent, from one walk of the tree. */
export function findCategoryInTree(
  tree: CategoryNode[] | undefined,
  slug: string | null,
): FoundCategory | null {
  if (tree === undefined || slug === null) return null;

  const walk = (nodes: CategoryNode[], parent: CategoryNode | null): FoundCategory | null => {
    for (const node of nodes) {
      if (node.slug === slug) return { node, parent };
      const hit = walk(node.children, node);
      if (hit !== null) return hit;
    }
    return null;
  };

  return walk(tree, null);
}

/**
 * The department a category is filed under, however deep it sits.
 *
 * `findCategoryInTree` answers "what is directly above this", which is one
 * level and is the right answer for a breadcrumb. The department strip needs
 * the other one: a shopper three levels inside Medical Devices is still in
 * Medical Devices, and a strip that lit nothing up because "IV Cannula" is not
 * a top-level department would be telling them they are nowhere.
 *
 * A top-level category is its own department, so `/category/medical-devices`
 * and `/category/iv-cannula` both answer `medical-devices`. A slug the tree
 * does not contain answers `null`, which is the same thing `/products` passes
 * and lights up "All products".
 */
export function rootCategorySlug(
  tree: CategoryNode[] | undefined,
  slug: string | null,
): string | null {
  if (tree === undefined || slug === null) return null;

  const walk = (nodes: CategoryNode[], root: CategoryNode | null): string | null => {
    for (const node of nodes) {
      const here = root ?? node;
      if (node.slug === slug) return here.slug;
      const hit = walk(node.children, here);
      if (hit !== null) return hit;
    }
    return null;
  };

  return walk(tree, null);
}

/**
 * The ones worth offering.
 *
 * A category with nothing published anywhere beneath it is a dead end, and the
 * subtree total is what decides that: a department whose products all sit in
 * its sub-categories holds none of its own, and testing the direct count would
 * drop the very thing a grid of them exists to show.
 */
export function stockedCategories(nodes: CategoryNode[]): CategoryNode[] {
  return nodes.filter((node) => node.totalProductCount > 0);
}

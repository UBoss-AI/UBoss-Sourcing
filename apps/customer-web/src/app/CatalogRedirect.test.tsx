/**
 * The `/catalog` addresses an older sitemap handed to search engines must
 * lead to the real catalogue pages, never to the "not found" page.
 */
import { render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { CatalogRedirect } from './CatalogRedirect';
import { router } from './router';

function Where(): React.JSX.Element {
  const { pathname, search, hash } = useLocation();
  return <p data-testid="where">{`${pathname}${search}${hash}`}</p>;
}

function miniRouter(entry: string): ReturnType<typeof createMemoryRouter> {
  return createMemoryRouter(
    [
      { path: '/products', element: <Where /> },
      { path: '/category/:slug', element: <Where /> },
      { path: '/catalog', element: <CatalogRedirect /> },
      { path: '/catalog/:slug', element: <CatalogRedirect /> },
    ],
    { initialEntries: [entry] },
  );
}

describe('the old /catalog addresses', () => {
  it('sends /catalog to the catalogue', async () => {
    render(<RouterProvider router={miniRouter('/catalog')} />);
    expect(await screen.findByTestId('where')).toHaveTextContent(/^\/products$/);
  });

  it('sends /catalog/:slug to that category, keeping the query and fragment', async () => {
    const memory = miniRouter('/catalog/kitchenware?lang=de#top');
    render(<RouterProvider router={memory} />);

    expect(await screen.findByTestId('where')).toHaveTextContent('/category/kitchenware?lang=de#top');
    expect(memory.state.historyAction).toBe('REPLACE');
  });

  it('is in the real route table', () => {
    const children = router.routes[0]?.children ?? [];
    for (const path of ['catalog', 'catalog/:slug']) {
      const route = children.find((child) => child.path === path);
      expect((route?.element as React.ReactElement | undefined)?.type, path).toBe(CatalogRedirect);
    }
  });
});

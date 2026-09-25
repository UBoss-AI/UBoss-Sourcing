/**
 * What the console calls itself.
 *
 * The product used to be UBOSS Sourcing and the rail used to say "UBOSS" over
 * "Admin console". It is Glovia now, over `The Way to the World` — the
 * product, and its tagline. Both strings live in `lib/brand.ts` and nowhere else, so
 * what these hold down is not the spelling of a constant but the shape of the
 * lockup: two lines, in that order, with the retired wording gone and a link
 * that is named whatever the rail's width.
 *
 * The rail is rendered pinned open. A collapsed rail hides the wording behind
 * a `display: none` that jsdom will happily report as present, so a test that
 * ran against the default would pass without the lines being readable by
 * anybody.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { SidebarProvider } from '@/components/ui/sidebar';
import { i18n } from '@/i18n/config';
import { PARENT_ATTRIBUTION, PORTAL_TITLE, PRODUCT_BRAND, PRODUCT_TAGLINE } from '@/lib/brand';
import { BrandLockup } from './BrandLockup';

function renderBrand(): void {
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <SidebarProvider open animate={false}>
          <BrandLockup />
        </SidebarProvider>
      </MemoryRouter>
    </I18nextProvider>,
  );
}

describe('the console’s brand lockup', () => {
  it('is the product over its tagline', () => {
    renderBrand();

    expect(screen.getByText(PRODUCT_BRAND)).toBeDefined();
    expect(screen.getByText(PRODUCT_TAGLINE)).toBeDefined();
    // The attribution is the sign-in screen's small print now, not the
    // lockup's second line.
    expect(screen.queryByText(PARENT_ATTRIBUTION)).toBeNull();
  });

  it('sets the name and the tagline in the one wordmark face', () => {
    renderBrand();

    expect(screen.getByText(PRODUCT_BRAND).className).toContain('font-brand');
    expect(screen.getByText(PRODUCT_TAGLINE).className).toContain('font-brand');
  });

  it('spells both of them the one way', () => {
    renderBrand();

    // Written as a sentence, not in capitals:
    // the markup says `The Way to the World`, never `THE WAY TO THE WORLD`.
    expect(screen.getByText('Glovia').textContent).toBe('Glovia');
    expect(screen.getByText('The Way to the World').textContent).toBe('The Way to the World');
  });

  it('is a link home, named with both lines', () => {
    renderBrand();

    // Named on the link rather than assembled from the two visible lines,
    // because at sixty pixels the lines are gone and the link is still there.
    const home = screen.getByRole('link', { name: `${PRODUCT_BRAND} — ${PRODUCT_TAGLINE}` });

    expect(home.getAttribute('href')).toBe('/');
  });

  it('no longer says what it used to say', () => {
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>
          <SidebarProvider open animate={false}>
            <BrandLockup />
          </SidebarProvider>
        </MemoryRouter>
      </I18nextProvider>,
    );

    expect(container.textContent).not.toContain('UBOSS Sourcing');
    expect(container.textContent).not.toContain('Admin console');
  });
});

describe('the tab', () => {
  it('is what says which of the two consoles this is', () => {
    // The rail gave that job up when the attribution took its second line.
    expect(PORTAL_TITLE).toBe('Glovia Admin');
  });
});

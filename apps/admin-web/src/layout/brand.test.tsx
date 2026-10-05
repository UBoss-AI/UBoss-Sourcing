/**
 * What the console calls itself.
 *
 * The product used to be UBOSS Sourcing and the rail used to say "UBOSS" over
 * "Admin console". It is Gloviaa Mart now, over `Source with Intelligence | Deliver with Confidence` — the
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

/**
 * The innermost element whose whole text is `text`. The wordmark is two spans
 * now — "Gloviaa" and "Mart" in different faces — so the name is no longer
 * one text node that `getByText` can match on its own.
 */
function whole(text: string): (content: string, element: Element | null) => boolean {
  return (_content, element) =>
    element !== null &&
    element.textContent === text &&
    ![...element.children].some((child) => child.textContent === text);
}

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

    expect(screen.getByText(whole(PRODUCT_BRAND))).toBeDefined();
    expect(screen.getByText(PRODUCT_TAGLINE)).toBeDefined();
    // The attribution is the sign-in screen's small print now, not the
    // lockup's second line.
    expect(screen.queryByText(PARENT_ATTRIBUTION)).toBeNull();
  });

  it('sets the name and the tagline in the one wordmark face', () => {
    renderBrand();

    expect(screen.getByText(whole(PRODUCT_BRAND)).className).toContain('font-brand');
    // Only "Mart" leaves the script, for the interface face.
    expect(screen.getByText('Mart').className).toContain('font-sans');
    // Shown as a light, lowercase "mart"; the text itself stays "Mart".
    expect(screen.getByText('Mart').className).toMatch(/font-light.*lowercase/);
    expect(screen.getByText(PRODUCT_TAGLINE).className).toContain('font-brand');
  });

  it('spells both of them the one way', () => {
    renderBrand();

    // Written as a sentence, not in capitals:
    // the markup says the approved line exactly, capitals and bar included.
    expect(screen.getByText(whole('Gloviaa Mart')).textContent).toBe('Gloviaa Mart');
    expect(screen.getByText('Source with Intelligence | Deliver with Confidence').textContent).toBe('Source with Intelligence | Deliver with Confidence');
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
    expect(PORTAL_TITLE).toBe('Gloviaa Mart Admin');
  });
});

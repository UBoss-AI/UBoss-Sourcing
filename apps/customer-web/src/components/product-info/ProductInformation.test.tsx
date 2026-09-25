/**
 * The product information below the buy panel.
 *
 *   - Sections appear in the fixed order, and only with something to say.
 *   - Specifications are grouped under translated headings; an empty group, an
 *     empty value and a label seen twice never render.
 *   - A long table shows a subset with "View all specifications" / "Show less",
 *     and says which it is to a screen reader; a link to #specifications opens it.
 *   - A description section is text: markup a seller typed is shown as text.
 *   - Changing option replaces the values, and changing language the headings.
 */
import { act, screen, within, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { i18n } from '@/i18n/config';
import { renderWithProviders } from '@/test/harness';
import type { SpecGroup } from '@/lib/types';
import { ProductInformation, SPEC_ROWS_SHOWN } from './ProductInformation';

const row = (label: string, value: string, extra: { unit?: string; highlight?: boolean } = {}) => ({
  label,
  value,
  unit: extra.unit ?? null,
  highlight: extra.highlight ?? false,
});

const SPECS: SpecGroup[] = [
  { group: 'GENERAL', rows: [row('Model', 'SB-750', { highlight: true }), row('Colour', '')] },
  { group: 'TECHNICAL', rows: [row('Capacity', '750', { unit: 'ml', highlight: true })] },
  { group: 'PERFORMANCE', rows: [] },
  { group: 'WARRANTY', rows: [row('Warranty', '2 years')] },
  { group: 'MANUFACTURER', rows: [row('Made by', 'Acme Bottles Ltd')] },
];

function renderInfo(props: Partial<Parameters<typeof ProductInformation>[0]> = {}, route = '/product/bottle') {
  return renderWithProviders(
    <ProductInformation
      specifications={SPECS}
      descriptionSections={[]}
      description={null}
      descriptionHtml={null}
      {...props}
    />,
    { route },
  );
}

afterEach(async () => {
  await act(async () => {
    await i18n.changeLanguage('en');
  });
});

describe('product information', () => {
  it('shows only the sections with something in them, in order', () => {
    renderInfo({
      descriptionSections: [{ heading: 'Overview', body: 'Keeps drinks cold.', image: null }],
      extraHighlights: [{ label: 'Minimum order', value: '500' }],
    });
    const headings = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
    expect(headings).toEqual([
      'Product highlights',
      'Description',
      'Specifications',
      'Warranty',
      'Manufacturer and seller information',
    ]);
    const highlights = within(screen.getByRole('region', { name: 'Product highlights' })).getAllByRole('listitem');
    expect(highlights.map((item) => item.textContent)).toEqual(['Model: SB-750', 'Capacity: 750 ml', 'Minimum order: 500']);
  });

  it('groups specifications under headings and hides empty values and groups', () => {
    renderInfo();
    const specs = screen.getByRole('region', { name: 'Specifications' });
    expect(within(specs).getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual([
      'General',
      'Technical specifications',
    ]);
    expect(within(specs).queryByText('Colour')).toBeNull();
    expect(within(specs).queryByText('Performance')).toBeNull();
    expect(within(specs).getByText('750 ml')).toBeInTheDocument();
  });

  it('shows a subset of a long table and expands and collapses it accessibly', () => {
    const many: SpecGroup[] = [
      { group: 'TECHNICAL', rows: Array.from({ length: SPEC_ROWS_SHOWN + 4 }, (_, index) => row(`Spec ${String(index + 1)}`, 'x')) },
    ];
    renderInfo({ specifications: many });
    const specs = screen.getByRole('region', { name: 'Specifications' });
    expect(within(specs).getAllByRole('term')).toHaveLength(SPEC_ROWS_SHOWN);
    const toggle = within(specs).getByRole('button', { name: 'View all specifications (12)' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById(toggle.getAttribute('aria-controls') ?? '')).not.toBeNull();
    fireEvent.click(toggle);
    expect(within(specs).getAllByRole('term')).toHaveLength(SPEC_ROWS_SHOWN + 4);
    const less = within(specs).getByRole('button', { name: 'Show less' });
    expect(less).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(less);
    expect(within(specs).getAllByRole('term')).toHaveLength(SPEC_ROWS_SHOWN);
  });

  it('opens the whole table when linked to directly', () => {
    const many: SpecGroup[] = [
      { group: 'TECHNICAL', rows: Array.from({ length: SPEC_ROWS_SHOWN + 2 }, (_, index) => row(`Spec ${String(index)}`, 'x')) },
    ];
    renderInfo({ specifications: many }, '/product/bottle#specifications');
    expect(screen.getAllByRole('term')).toHaveLength(SPEC_ROWS_SHOWN + 2);
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('shows markup in a description section as the characters typed', () => {
    const { container } = renderInfo({
      descriptionSections: [{ heading: 'Care', body: '<img src=x onerror=alert(1)>\nWash by hand.', image: null }],
    });
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });

  it('lazy-loads a section picture with words for a screen reader', () => {
    renderInfo({
      descriptionSections: [
        { heading: 'Lid', body: 'Twist to open.', image: { url: '/media/lid.png', alt: 'The lid, closed', width: 400, height: 300 } },
      ],
    });
    const image = screen.getByRole('img', { name: 'The lid, closed' });
    expect(image).toHaveAttribute('loading', 'lazy');
  });

  it('replaces every value when the option changes, keeping none of the old one', () => {
    function Switcher(): React.JSX.Element {
      const [large, setLarge] = useState(false);
      return (
        <>
          <button type="button" onClick={() => { setLarge(true); }}>1000 ml option</button>
          <ProductInformation
            specifications={large ? [{ group: 'TECHNICAL', rows: [row('Capacity', '1000', { unit: 'ml' })] }] : SPECS}
            descriptionSections={[]}
            description={null}
            descriptionHtml={null}
          />
        </>
      );
    }
    renderWithProviders(<Switcher />);
    // Once in the highlights, once in the table.
    expect(screen.getAllByText('750 ml')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '1000 ml option' }));
    expect(screen.getByText('1000 ml')).toBeInTheDocument();
    expect(screen.queryByText('750 ml')).toBeNull();
    expect(screen.queryByText('SB-750')).toBeNull();
  });

  it('translates the headings when the language changes', async () => {
    renderInfo();
    await act(async () => {
      await i18n.changeLanguage('de');
    });
    expect(screen.getByRole('heading', { name: 'Technische Daten', level: 3 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Garantie', level: 2 })).toBeInTheDocument();
  });

  it('wraps a long value rather than widening the page', () => {
    renderInfo({ specifications: [{ group: 'GENERAL', rows: [row('Part', 'X'.repeat(300))] }] });
    expect(screen.getByText('X'.repeat(300)).className).toContain('[overflow-wrap:anywhere]');
  });
});

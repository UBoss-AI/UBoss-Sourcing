/**
 * The cover-art lookup, tested for the two ways a table of patterns goes
 * wrong.
 *
 * **A broad pattern eating a narrow one.** The list is ordered, and the order
 * is load bearing: "Electronics & Components" and "Electrical & Lighting" are
 * one letter apart in the eye and two different departments in a warehouse,
 * and "Computers & IT" has to be answered before either of them claims it.
 * Every one of those is pinned below, because the failure is silent — the rail
 * still renders, it just shows a circuit board beside the light fittings.
 *
 * **A confident answer for a name nobody described.** An operator files their
 * catalogue under their own words, and the honest answer for a name this table
 * has never seen is no photograph at all. `components/icons.tsx` carries the
 * longer version of that rule.
 */
import { describe, expect, it } from 'vitest';
import { categoryCover } from './category-cover';

/** Two departments have the same picture. */
function sameCover(a: [string, string], b: [string, string]): boolean {
  return categoryCover(a[0], a[1]) === categoryCover(b[0], b[1]);
}

describe('category cover art', () => {
  it('recognises a department by name', () => {
    expect(categoryCover('Tools & Hardware', 'tools-hardware')).toContain('images.unsplash.com');
  });

  it('has nothing for a department it has never been told about', () => {
    expect(categoryCover('Widgets', 'widgets')).toBeNull();
    expect(categoryCover('Ferromagnetic Sundries', 'ferromagnetic-sundries')).toBeNull();
  });

  it('asks for a width the card can actually show', () => {
    // 2500px covers no screen in a 336px rail and costs about four times the
    // bytes. If this ever reads 2500 again, the addresses were pasted back in
    // from the original.
    expect(categoryCover('Office & Stationery', 'office')).toContain('w=1200');
  });

  it('keeps the three electrical departments apart', () => {
    const computers: [string, string] = ['Computers & IT', 'computers-it'];
    const electronics: [string, string] = ['Electronics & Components', 'electronics'];
    const electrical: [string, string] = ['Electrical & Lighting', 'electrical-lighting'];

    expect(sameCover(computers, electronics)).toBe(false);
    expect(sameCover(computers, electrical)).toBe(false);
    expect(sameCover(electronics, electrical)).toBe(false);
  });

  it('does not let a broad word claim a narrower department', () => {
    // "Food Service & Catering" contains neither of these as whole words, but
    // a pattern written without boundaries would have taken both.
    expect(sameCover(['Food Service & Catering', 'food'], ['Home & Kitchen', 'home'])).toBe(false);
    expect(
      sameCover(['Safety & Protective Equipment', 'safety'], ['Tools & Hardware', 'tools']),
    ).toBe(false);
  });

  it('matches whatever case and spacing a catalogue happens to use', () => {
    const plain = categoryCover('Packaging & Shipping', 'packaging-shipping');

    expect(categoryCover('PACKAGING AND SHIPPING', 'x')).toBe(plain);
    expect(categoryCover('packaging  &  shipping', 'x')).toBe(plain);
  });

  it('falls back to the slug when the name is in another language', () => {
    // The catalogue is translated; the slug usually is not. A German
    // storefront still gets the laboratory photograph.
    expect(categoryCover('Labor & Wissenschaft', 'laboratory-scientific')).toBe(
      categoryCover('Laboratory & Scientific', 'laboratory-scientific'),
    );
  });
});

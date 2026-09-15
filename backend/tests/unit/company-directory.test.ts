/**
 * "Are these two accounts the same company?"
 *
 * The directory groups a seller, a carrier and a pile of buying accounts into
 * one card on the strength of their names, so both directions of that decision
 * are worth pinning down: the merges an operator would be annoyed to have to
 * spot themselves, and — more important — the merges that must NOT happen,
 * because a card claiming two unrelated businesses are one is worse than two
 * cards that could have been one.
 */
import { describe, expect, it } from 'vitest';
import {
  groupIntoCompanies,
  normaliseCompanyName,
  type DirectoryIndexEntry,
} from '../../src/domain/company-directory.js';

function entry(over: Partial<DirectoryIndexEntry> & { kind: DirectoryIndexEntry['kind']; name: string }): DirectoryIndexEntry {
  return { id: over.name, country: null, ...over };
}

describe('normaliseCompanyName', () => {
  it('ignores case, punctuation and spacing', () => {
    expect(normaliseCompanyName('Northwind  Medical')).toBe('northwind medical');
    expect(normaliseCompanyName('northwind-medical.')).toBe('northwind medical');
    expect(normaliseCompanyName('NORTHWIND MEDICAL')).toBe('northwind medical');
  });

  it('reads an ampersand as the word', () => {
    expect(normaliseCompanyName('Smith & Sons')).toBe(normaliseCompanyName('Smith and Sons'));
  });

  it('folds accents, so one European supplier is not two', () => {
    expect(normaliseCompanyName('Médica España')).toBe(normaliseCompanyName('Medica Espana'));
  });

  it('drops a trailing legal form, in several markets', () => {
    const expected = 'northwind medical';

    expect(normaliseCompanyName('Northwind Medical Ltd')).toBe(expected);
    expect(normaliseCompanyName('Northwind Medical GmbH')).toBe(expected);
    expect(normaliseCompanyName('Northwind Medical B.V.')).toBe(expected);
    expect(normaliseCompanyName('Northwind Medical Pvt Ltd')).toBe(expected);
  });

  it('never strips the only word, so a company called Co survives', () => {
    expect(normaliseCompanyName('Co')).toBe('co');
  });

  it('does not merge two names that merely start the same', () => {
    expect(normaliseCompanyName('Northwind Medical')).not.toBe(
      normaliseCompanyName('Northwind Medical Supplies'),
    );
  });

  it('returns empty for a name with nothing in it', () => {
    expect(normaliseCompanyName('   ---  ')).toBe('');
  });
});

describe('groupIntoCompanies', () => {
  it('puts a seller, its buyers and its carrier arm on one company', () => {
    const companies = groupIntoCompanies([
      entry({ kind: 'SELLER', id: 's1', name: 'Northwind Medical', country: 'DE' }),
      entry({ kind: 'BUYER', id: 'b1', name: 'northwind medical ltd' }),
      entry({ kind: 'LOGISTICS', id: 'l1', name: 'Northwind Medical', country: 'DE' }),
    ]);

    expect(companies).toHaveLength(1);
    expect(companies[0]?.kinds).toEqual(['SELLER', 'BUYER', 'LOGISTICS']);
    // The seller names the card: its trading name went through a check, the
    // buyer's free-text employer field did not.
    expect(companies[0]?.name).toBe('Northwind Medical');
    expect(companies[0]?.country).toBe('DE');
  });

  it("matches a buyer's employer against the seller's LEGAL name", () => {
    const companies = groupIntoCompanies([
      entry({
        kind: 'SELLER',
        id: 's1',
        name: 'Northwind',
        alsoKnownAs: 'Northwind Medical Supplies Ltd',
      }),
      entry({ kind: 'BUYER', id: 'b1', name: 'Northwind Medical Supplies' }),
    ]);

    expect(companies).toHaveLength(1);
    expect(companies[0]?.kinds).toEqual(['SELLER', 'BUYER']);
  });

  it('keeps two businesses apart when only one word matches', () => {
    const companies = groupIntoCompanies([
      entry({ kind: 'SELLER', id: 's1', name: 'Northwind Medical' }),
      entry({ kind: 'SELLER', id: 's2', name: 'Northwind Surgical' }),
    ]);

    expect(companies).toHaveLength(2);
  });

  it('never merges accounts whose names are unusable', () => {
    const companies = groupIntoCompanies([
      entry({ kind: 'BUYER', id: 'b1', name: '---' }),
      entry({ kind: 'BUYER', id: 'b2', name: '...' }),
    ]);

    expect(companies).toHaveLength(2);
  });

  it('does not let a buying account claim an alias for everybody else', () => {
    /*
     * A buyer typing "Northwind Medical Supplies Ltd" must not pull the
     * unrelated seller "Supplies" onto their card. Only a seller or a carrier
     * registers an alias, and only its own.
     */
    const companies = groupIntoCompanies([
      entry({ kind: 'BUYER', id: 'b1', name: 'Northwind', alsoKnownAs: 'Acme' }),
      entry({ kind: 'SELLER', id: 's1', name: 'Acme' }),
    ]);

    expect(companies).toHaveLength(2);
  });

  it('sorts by name so a page is stable between reads', () => {
    const companies = groupIntoCompanies([
      entry({ kind: 'SELLER', id: 's1', name: 'Zenith' }),
      entry({ kind: 'SELLER', id: 's2', name: 'Acme' }),
    ]);

    expect(companies.map((company) => company.name)).toEqual(['Acme', 'Zenith']);
  });
});

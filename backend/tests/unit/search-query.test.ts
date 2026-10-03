import { describe, expect, it } from 'vitest';
import { interpretSearch, literalLike, normalizeSearch, oneEditApart } from '../../src/modules/catalog/search-query.js';
describe('public catalogue search interpretation', () => {
  it('reads an explicit plain-language request without discarding product specifications', () => {
    expect(interpretSearch('Please find me manufacturers who make sterile 18G cannulas').groups).toEqual([['sterile'], ['18g'], ['cannulas']]);
    expect(interpretSearch('gloves without latex').groups).toEqual([['gloves'], ['without'], ['latex']]);
  });
  it('preserves non-English text, punctuation, exact identifiers and an empty-object request', () => {
    expect(normalizeSearch('  RĘKAWICE  ＡＢＣ-18  ')).toBe('rękawice abc-18');
    expect(interpretSearch('find').groups).toEqual([['find']]);
    expect(interpretSearch('')).toMatchObject({ groups: [], terms: [] });
  });
  it('expands maintained word and phrase synonyms without requiring the original words', () => {
    const aliases = [{ term: 'iv catheter', synonymsJson: ['Cannula', 'cannula', null] }, { term: 'gloves', synonymsJson: ['mitts'] }];
    expect(interpretSearch('find IV catheter', aliases).groups).toEqual([['iv catheter', 'cannula']]);
    expect(interpretSearch('sterile gloves', aliases).groups).toEqual([['sterile'], ['gloves', 'mitts']]);
    expect(interpretSearch('gloves', [{ term: 'gloves', synonymsJson: {} }]).groups).toEqual([['gloves']]);
  });
  it('suggests insertion, deletion, replacement and adjacent transposition only', () => {
    for (const [a, b] of [['glovs', 'gloves'], ['glovess', 'gloves'], ['glaves', 'gloves'], ['gloevs', 'gloves']]) expect(oneEditApart(a!, b!)).toBe(true);
    for (const [a, b] of [['gloves', 'gloves'], ['gloves', 'boots'], ['IV', 'V'], ['glves', 'glares']]) expect(oneEditApart(a!, b!)).toBe(false);
  });
  it('escapes wildcard metacharacters before a parameterized capability search', () => {
    expect(literalLike('50%_OEM')).toBe('50\\%\\_OEM');
    expect(literalLike('a\\b')).toBe('a\\\\b');
  });
});

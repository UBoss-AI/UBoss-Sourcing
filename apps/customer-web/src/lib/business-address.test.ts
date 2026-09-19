/**
 * The rules behind the seller's registered address.
 *
 * Every one of these is a rule that was stated in the brief and would be
 * expensive to get wrong later — a postcode silently losing a leading zero, a
 * six-digit Indian check applied to a Dutch address, an admin panel printing
 * ", , 201301". They are pure functions precisely so they can be held to those
 * rules without a DOM, a network or a database.
 */
import { describe, expect, it } from 'vitest';
import {
  formatBusinessAddress,
  formatBusinessAddressInline,
  isLegacySingleLineAddress,
  normalisePostalCode,
  postalProblem,
  regionCodeOf,
  regionForStorage,
  regionNameOf,
  subdivisionsFor,
  validateBusinessAddress,
  EMPTY_BUSINESS_ADDRESS,
} from './business-address';

describe('the country a region belongs to', () => {
  it('offers a list where the country has one people actually write down', () => {
    const india = subdivisionsFor('IN');
    expect(india).not.toBeNull();
    // 28 states and 8 union territories.
    expect(india).toHaveLength(36);
    expect(india?.map((entry) => entry.code)).toContain('GJ');
    expect(india?.find((entry) => entry.code === 'GJ')?.name).toBe('Gujarat');

    expect(subdivisionsFor('US')).not.toBeNull();
    expect(subdivisionsFor('CA')).not.toBeNull();
    expect(subdivisionsFor('AU')).not.toBeNull();
  });

  it('offers none where a text box is the right control', () => {
    // Not a gap. A Dutch business address carries a postcode and a city and no
    // province anybody writes on an invoice, so a picker would force somebody
    // to answer a question that was not asked.
    expect(subdivisionsFor('NL')).toBeNull();
    expect(subdivisionsFor('DE')).toBeNull();
    expect(subdivisionsFor('FR')).toBeNull();
  });

  it('is case-insensitive about the country and safe with nothing chosen', () => {
    expect(subdivisionsFor('in')).toBe(subdivisionsFor('IN'));
    expect(subdivisionsFor(null)).toBeNull();
    expect(subdivisionsFor('')).toBeNull();
  });
});

describe('storing a region', () => {
  it('keeps both the name and the code, and gets both back', () => {
    // The requirement is "store both a state code and display name where
    // supported". The name is what a person reads and the code is what
    // survives a rename — Orissa became Odisha without the place moving.
    const stored = regionForStorage({ code: 'GJ', name: 'Gujarat' });

    expect(stored).toBe('Gujarat (GJ)');
    expect(regionCodeOf(stored)).toBe('GJ');
    expect(regionNameOf(stored)).toBe('Gujarat');
  });

  it('stores what was typed where there is no list, with nothing added', () => {
    expect(regionForStorage('Noord-Holland')).toBe('Noord-Holland');
    expect(regionCodeOf('Noord-Holland')).toBeNull();
    expect(regionNameOf('Noord-Holland')).toBe('Noord-Holland');
  });

  it('treats an empty or blank entry as nothing at all', () => {
    expect(regionForStorage('')).toBeNull();
    expect(regionForStorage('   ')).toBeNull();
    expect(regionForStorage(null)).toBeNull();
  });
});

describe('the postal code', () => {
  it('holds India to six digits, and says so usefully', () => {
    expect(postalProblem('380015', 'IN')).toBeNull();
    expect(postalProblem('201301', 'IN')).toBeNull();

    // Five digits, seven digits, and a PIN starting with zero — which does not
    // exist — are all refused, and the refusal carries an example so the
    // message can say what a right answer looks like.
    expect(postalProblem('38001', 'IN')).toEqual({ kind: 'countryFormat', example: '380015' });
    expect(postalProblem('3800155', 'IN')?.kind).toBe('countryFormat');
    expect(postalProblem('012345', 'IN')?.kind).toBe('countryFormat');
  });

  it('holds the United States to five digits or ZIP+4', () => {
    expect(postalProblem('94107', 'US')).toBeNull();
    expect(postalProblem('94107-1234', 'US')).toBeNull();
    // A leading zero is a real ZIP — 01234 is in Massachusetts.
    expect(postalProblem('01234', 'US')).toBeNull();

    expect(postalProblem('9410', 'US')?.kind).toBe('countryFormat');
    expect(postalProblem('94107-12', 'US')?.kind).toBe('countryFormat');
  });

  it('accepts the alphanumeric codes the rest of the world uses', () => {
    expect(postalProblem('1012 AB', 'NL')).toBeNull();
    expect(postalProblem('1012AB', 'NL')).toBeNull();
    expect(postalProblem('SW1A 1AA', 'GB')).toBeNull();
    expect(postalProblem('K1A 0B1', 'CA')).toBeNull();
    expect(postalProblem('D02 AF30', 'IE')).toBeNull();
    expect(postalProblem('01310-100', 'BR')).toBeNull();
  });

  it('is case-insensitive, because a postcode is', () => {
    expect(postalProblem('sw1a 1aa', 'GB')).toBeNull();
    expect(postalProblem('1012 ab', 'NL')).toBeNull();
  });

  /*
   * The most important test in this file.
   *
   * Applying India's six digits or America's five to every country is the
   * single easiest way to make this field unfillable for most of the world,
   * and the seller it blocks has no way to find out why.
   */
  it('never applies one country’s rule to another’s address', () => {
    // Six digits would be a valid PIN and is not a Dutch postcode.
    expect(postalProblem('380015', 'NL')?.kind).toBe('countryFormat');
    // Five digits is a valid ZIP and is not a British postcode.
    expect(postalProblem('94107', 'GB')?.kind).toBe('countryFormat');
    // And a Dutch postcode is not refused for failing India's rule.
    expect(postalProblem('1012 AB', 'NL')).toBeNull();
  });

  it('is permissive but safe where no rule is known', () => {
    // A country this build has no pattern for. Real postal codes pass.
    expect(postalProblem('ABC 123', 'ZW')).toBeNull();
    expect(postalProblem('12345', 'ZW')).toBeNull();
    expect(postalProblem('A1-B2', 'ZW')).toBeNull();

    // Things that are not a postal code at all do not.
    expect(postalProblem('not a postcode at all, really', 'ZW')?.kind).toBe('general');
    expect(postalProblem('<script>', 'ZW')?.kind).toBe('general');
    expect(postalProblem('12;34', 'ZW')?.kind).toBe('general');
  });

  it('refuses an empty one as missing rather than as malformed', () => {
    // Two different messages: "enter the postal code" and "that is not a valid
    // postal code" are answers to different mistakes.
    expect(postalProblem('', 'IN')).toEqual({ kind: 'required' });
    expect(postalProblem('   ', 'IN')).toEqual({ kind: 'required' });
  });

  it('checks presence only until a country has been chosen', () => {
    // Objecting to the shape of a postcode before somebody has said which
    // country it is in is an objection to a question they have not been asked.
    expect(postalProblem('380015', null)).toBeNull();
    expect(postalProblem('', null)).toEqual({ kind: 'required' });
  });

  it('preserves leading zeroes, spaces and hyphens exactly', () => {
    // The whole reason a postal code is a string everywhere in this system.
    expect(normalisePostalCode('01234')).toBe('01234');
    expect(normalisePostalCode('  01234  ')).toBe('01234');
    expect(normalisePostalCode('K1A 0B1')).toBe('K1A 0B1');
    expect(normalisePostalCode('01310-100')).toBe('01310-100');
    // Not upper-cased: "1012 ab" is what somebody wrote, and deciding for them
    // is not this function's job.
    expect(normalisePostalCode('sw1a 1aa')).toBe('sw1a 1aa');
  });
});

describe('validating the whole address', () => {
  const full = {
    line1: '42 Industrial Estate, Phase 2',
    line2: '',
    city: 'Noida',
    region: 'Uttar Pradesh (UP)',
    postcode: '201301',
    country: 'IN',
  };

  it('accepts a complete address with line 2 left empty', () => {
    // Line 2 is the only optional field, and that has to be true rather than
    // merely intended.
    expect(validateBusinessAddress(full)).toEqual({});
  });

  it('reports every missing required field at once', () => {
    // All of them, not the first: a form that reveals its objections one at a
    // time is a form somebody submits five times.
    const problems = validateBusinessAddress(EMPTY_BUSINESS_ADDRESS);

    expect(Object.keys(problems).sort()).toEqual(
      ['city', 'country', 'line1', 'postcode', 'region'].sort(),
    );
    expect(problems.line2).toBeUndefined();
  });

  it('checks the postcode against the country that was chosen', () => {
    const wrongCountry = validateBusinessAddress({ ...full, country: 'NL' });
    expect(wrongCountry.postcode?.kind).toBe('countryFormat');

    const right = validateBusinessAddress({ ...full, country: 'NL', postcode: '1012 AB' });
    expect(right.postcode).toBeUndefined();
  });
});

describe('formatting an address', () => {
  it('lays it out the way an address is written', () => {
    expect(
      formatBusinessAddress(
        {
          line1: '42 Industrial Estate, Phase 2',
          line2: null,
          city: 'Noida',
          region: 'Uttar Pradesh',
          postcode: '201301',
          country: 'IN',
        },
        { countryName: 'India' },
      ),
    ).toEqual(['42 Industrial Estate, Phase 2', 'Noida, Uttar Pradesh 201301', 'India']);
  });

  /*
   * The rule the whole formatter exists for.
   *
   * `[a, b, c].join(', ')` over nullable fields produces ", Noida, , 201301"
   * the moment one is missing — and one is always missing, because line 2 is
   * optional by design and every legacy row has nothing but line 1.
   */
  it('lets an absent part take nothing with it', () => {
    const lines = formatBusinessAddress({
      line1: '42 Industrial Estate',
      line2: null,
      city: null,
      region: null,
      postcode: '201301',
      country: 'IN',
    });

    expect(lines).toEqual(['42 Industrial Estate', '201301', 'IN']);

    for (const line of lines) {
      expect(line).not.toMatch(/,\s*,/);
      expect(line).not.toMatch(/^,|,\s*$/);
      expect(line).not.toContain('undefined');
      expect(line).not.toContain('null');
    }
  });

  it('prints nothing at all for an empty address', () => {
    expect(formatBusinessAddress({})).toEqual([]);
    expect(formatBusinessAddressInline({})).toBeNull();
    expect(
      formatBusinessAddress({ line1: '   ', city: '', postcode: null, country: undefined }),
    ).toEqual([]);
  });

  it('falls back to the country code where no name was looked up', () => {
    // Not wrong, and better than inventing a name from a lookup the caller
    // does not have.
    expect(formatBusinessAddress({ line1: 'X', country: 'IN' })).toEqual(['X', 'IN']);
    expect(formatBusinessAddress({ line1: 'X', country: 'IN' }, { countryName: 'India' })).toEqual([
      'X',
      'India',
    ]);
  });

  it('gives the same parts on one line for a compact view', () => {
    expect(
      formatBusinessAddressInline(
        { line1: '42 Industrial Estate', city: 'Noida', postcode: '201301', country: 'IN' },
        { countryName: 'India' },
      ),
    ).toBe('42 Industrial Estate, Noida 201301, India');
  });
});

describe('an address entered before the fields existed', () => {
  it('recognises line 1 standing alone as the legacy shape', () => {
    expect(
      isLegacySingleLineAddress({
        line1: '42 Industrial Estate Phase 2 Noida UP 201301',
        line2: null,
        city: null,
        region: null,
        postcode: null,
        country: null,
      }),
    ).toBe(true);
  });

  it('does not call an empty address legacy', () => {
    // There is nothing to preserve and nothing to ask about; an empty form is
    // the right thing to show.
    expect(isLegacySingleLineAddress({})).toBe(false);
    expect(isLegacySingleLineAddress({ line1: null })).toBe(false);
  });

  it('does not call a partly filled address legacy either', () => {
    // It is not a row from the old form; it is a new one somebody has not
    // finished. The ordinary validation has something to say about it.
    expect(
      isLegacySingleLineAddress({
        line1: '42 Industrial Estate',
        city: 'Noida',
        country: 'IN',
      }),
    ).toBe(false);
  });
});

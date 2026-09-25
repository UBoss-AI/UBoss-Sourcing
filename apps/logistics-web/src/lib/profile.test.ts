/**
 * The profile form's arithmetic: draft in, smallest PATCH out, problems found
 * before the server finds them.
 */
import { describe, expect, it } from 'vitest';
import {
  diffDraft,
  draftFromProfile,
  isReverified,
  problemKeyFor,
  validateDraft,
} from './profile';
import { profileFixture } from './profile.fixture';

describe('diffDraft', () => {
  it('is empty for an untouched draft', () => {
    const initial = draftFromProfile(profileFixture());
    expect(diffDraft(initial, { ...initial })).toEqual({});
  });

  it('sends only what changed, trimmed, and a cleared field as null', () => {
    const initial = draftFromProfile(
      profileFixture({
        contacts: { ...profileFixture().contacts, supportEmail: 'old@alpha.test' },
      }),
    );
    const patch = diffDraft(initial, {
      ...initial,
      supportEmail: '',
      billingEmail: '  billing@alpha.test  ',
    });
    expect(patch).toEqual({ supportEmail: null, billingEmail: 'billing@alpha.test' });
  });

  it('treats re-typing the same value, or trailing spaces, as no change', () => {
    const initial = draftFromProfile(profileFixture());
    expect(diffDraft(initial, { ...initial, contactEmail: 'ops@alpha.test  ' })).toEqual({});
  });

  it('does not count re-ordered transport modes as a change', () => {
    const initial = draftFromProfile(
      profileFixture({
        capabilities: { ...profileFixture().capabilities, declaredTransportModes: ['AIR', 'ROAD'] },
      }),
    );
    expect(diffDraft(initial, { ...initial, declaredTransportModes: ['ROAD', 'AIR'] })).toEqual({});
  });

  it('sends opening hours for the open days only, and null when every day is closed', () => {
    const initial = draftFromProfile(profileFixture());
    const open = {
      ...initial,
      operatingHours: { ...initial.operatingHours, mon: { enabled: true, open: '08:00', close: '17:00' } },
    };
    expect(diffDraft(initial, open)).toEqual({ operatingHours: { mon: { open: '08:00', close: '17:00' } } });

    const back = diffDraft(draftFromProfile(profileFixture({
      capabilities: { ...profileFixture().capabilities, operatingHours: { mon: { open: '08:00', close: '17:00' } } },
    })), initial);
    expect(back).toEqual({ operatingHours: null });
  });

  it('clears an address to null and upper-cases its country', () => {
    const initial = draftFromProfile(profileFixture());
    const cleared = diffDraft(initial, {
      ...initial,
      registeredAddress: { line1: '', line2: '', city: '', region: '', postalCode: '', countryCode: '' },
    });
    expect(cleared).toEqual({ registeredAddress: null });

    const typed = diffDraft(initial, {
      ...initial,
      operationalAddress: { line1: '9 Quay', line2: '', city: 'Cobh', region: '', postalCode: '', countryCode: 'ie' },
    });
    expect(typed).toEqual({
      operationalAddress: {
        line1: '9 Quay',
        line2: null,
        city: 'Cobh',
        region: null,
        postalCode: null,
        countryCode: 'IE',
      },
    });
  });
});

describe('validateDraft', () => {
  it('finds nothing wrong with a valid draft', () => {
    expect(validateDraft(draftFromProfile(profileFixture()))).toEqual({});
  });

  it('names each kind of problem against its field', () => {
    const draft = draftFromProfile(profileFixture());
    const problems = validateDraft({
      ...draft,
      legalName: ' ',
      contactEmail: 'nope',
      supportPhone: 'call me',
      websiteUrl: 'javascript:alert(1)',
      registrationCountry: 'Ireland',
      timeZone: 'Mars/Base',
      operatingHours: { ...draft.operatingHours, tue: { enabled: true, open: '18:00', close: '09:00' } },
      hubLocations: [{ name: '', city: 'Cork', countryCode: 'IE' }],
      operationalAddress: { line1: '1 Road', line2: '', city: '', region: '', postalCode: '', countryCode: 'IE' },
    });
    expect(problems).toEqual({
      legalName: 'required',
      contactEmail: 'email',
      supportPhone: 'phone',
      websiteUrl: 'url',
      registrationCountry: 'country',
      timeZone: 'timeZone',
      'operatingHours.tue': 'hours',
      'hubLocations.0': 'required',
      operationalAddress: 'address',
    });
  });

  it('allows optional fields to be empty', () => {
    const draft = draftFromProfile(profileFixture());
    expect(validateDraft({ ...draft, supportEmail: '', websiteUrl: '', contactPhone: '' })).toEqual({});
  });
});

describe('field classes', () => {
  it('knows which fields go to the operator first', () => {
    expect(isReverified('legalName')).toBe(true);
    expect(isReverified('taxNumber')).toBe(true);
    expect(isReverified('supportEmail')).toBe(false);
  });

  it('maps a server detail onto the field that shows it', () => {
    expect(problemKeyFor('operationalAddress.city')).toBe('operationalAddress');
    expect(problemKeyFor('hubLocations.2.name')).toBe('hubLocations.2');
    expect(problemKeyFor('operatingHours.mon')).toBe('operatingHours.mon');
    expect(problemKeyFor('supportEmail')).toBe('supportEmail');
  });
});

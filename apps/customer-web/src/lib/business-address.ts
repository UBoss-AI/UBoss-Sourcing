/**
 * The seller's registered business address, as a structured thing.
 *
 * ## Why this file exists
 *
 * The Seller Hub used to ask for a "Registered address" in one text box and
 * write whatever was typed into `registeredAddressLine1`. The columns for the
 * rest — line 2, city, region, postcode, country — have existed in
 * `seller_business_profiles` since it was created, and every one of them was
 * null on every row, because nothing ever asked.
 *
 * That was not a cosmetic gap. A registered address is the address on an
 * invoice and on a tax registration, and three separate things downstream need
 * its PARTS rather than its prose:
 *
 *   - The country decides which registrations the seller is asked for at all.
 *     `SellerOnboardingRequirement` is keyed by country, and the assistant, the
 *     VAT resolution and the EORI question all turn on it.
 *   - The postcode is what a reviewer checks a registration certificate
 *     against. "Ahmedabad 380015" buried in a sentence is not something a
 *     screen can compare with anything.
 *   - The region is what several tax authorities key a rate on.
 *
 * A single string cannot be split back into those reliably — that is the whole
 * lesson of address parsing — so the fields are asked for separately and the
 * one-line version is composed FROM them rather than the other way round.
 *
 * ## What is in here and what is not
 *
 * Everything in this file is data and pure functions: no React, no network, no
 * formatting that depends on a locale. That is what lets the same rules run in
 * the onboarding form, in the profile editor, in the admin panel's read-only
 * view and in a unit test with no DOM.
 *
 * The COUNTRY LIST is deliberately not here. It comes off the server, through
 * `LocaleProvider`, from the `countries` table an operator edits — the same
 * list the "where are you ordering from?" picker and the seller application
 * already use. Hard-coding 249 countries into the bundle would be a second
 * list to disagree with the first, and the first is the one the rest of the
 * system enforces against.
 */

import type { Translate } from '@/i18n/i18n-context';

/** ISO 3166-1 alpha-2, upper case. The shape the whole system stores. */
export type CountryCode = string;

/**
 * One subdivision of a country, as it is stored and as it is shown.
 *
 * Both, and that is the requirement rather than a convenience: a code is
 * stable and a name is not — "Orissa" became "Odisha" and "Pondicherry" became
 * "Puducherry" without either place moving — so the code is what survives, and
 * the name is what a person reads.
 *
 * The code is stored in `registeredRegion` alongside the name rather than in a
 * column of its own; see `regionForStorage` below for the format and for why.
 */
export interface Subdivision {
  /** ISO 3166-2 subdivision code, without the country prefix. */
  code: string;
  name: string;
}

/**
 * Countries whose subdivisions this build knows.
 *
 * ## Why a list at all, and why a short one
 *
 * Where a country has a fixed, official, everyday-use set of subdivisions, a
 * picker is strictly better than a text box: it cannot be misspelled, it
 * cannot be abbreviated three different ways by three different sellers, and
 * a reviewer comparing it against a registration certificate is comparing two
 * values from the same vocabulary.
 *
 * Where a country does NOT have that — most of Europe, where an address
 * carries a postcode and a city and no province anybody writes down — a picker
 * is worse than a text box. It forces somebody to pick something they would
 * not have written, and what is stored is then an answer to a question that
 * was not asked.
 *
 * So this is short on purpose and it is meant to stay short. The rule for
 * adding one is: does a business in that country routinely write this on an
 * invoice? India yes. The United States yes. Germany no.
 *
 * ## Why it is in the bundle rather than in the database
 *
 * These are ISO 3166-2, they change about once a decade, and an operator has
 * no business editing them — unlike `countries`, which decides which markets a
 * deployment serves and is genuinely theirs. A country absent from this map is
 * not broken: it gets a free-text box, which is the correct control for it.
 */
export const SUBDIVISIONS: Readonly<Record<CountryCode, readonly Subdivision[]>> = Object.freeze({
  /*
   * India: 28 states and 8 union territories.
   *
   * Every Indian business address carries one, GST registration is per state,
   * and a GSTIN's first two digits ARE the state — so this is the country
   * where getting it as a code rather than as prose matters most.
   */
  IN: Object.freeze([
    { code: 'AN', name: 'Andaman and Nicobar Islands' },
    { code: 'AP', name: 'Andhra Pradesh' },
    { code: 'AR', name: 'Arunachal Pradesh' },
    { code: 'AS', name: 'Assam' },
    { code: 'BR', name: 'Bihar' },
    { code: 'CH', name: 'Chandigarh' },
    { code: 'CT', name: 'Chhattisgarh' },
    { code: 'DH', name: 'Dadra and Nagar Haveli and Daman and Diu' },
    { code: 'DL', name: 'Delhi' },
    { code: 'GA', name: 'Goa' },
    { code: 'GJ', name: 'Gujarat' },
    { code: 'HR', name: 'Haryana' },
    { code: 'HP', name: 'Himachal Pradesh' },
    { code: 'JK', name: 'Jammu and Kashmir' },
    { code: 'JH', name: 'Jharkhand' },
    { code: 'KA', name: 'Karnataka' },
    { code: 'KL', name: 'Kerala' },
    { code: 'LA', name: 'Ladakh' },
    { code: 'LD', name: 'Lakshadweep' },
    { code: 'MP', name: 'Madhya Pradesh' },
    { code: 'MH', name: 'Maharashtra' },
    { code: 'MN', name: 'Manipur' },
    { code: 'ML', name: 'Meghalaya' },
    { code: 'MZ', name: 'Mizoram' },
    { code: 'NL', name: 'Nagaland' },
    { code: 'OR', name: 'Odisha' },
    { code: 'PY', name: 'Puducherry' },
    { code: 'PB', name: 'Punjab' },
    { code: 'RJ', name: 'Rajasthan' },
    { code: 'SK', name: 'Sikkim' },
    { code: 'TN', name: 'Tamil Nadu' },
    { code: 'TG', name: 'Telangana' },
    { code: 'TR', name: 'Tripura' },
    { code: 'UP', name: 'Uttar Pradesh' },
    { code: 'UT', name: 'Uttarakhand' },
    { code: 'WB', name: 'West Bengal' },
  ]),

  /** United States: 50 states, DC and the inhabited territories. */
  US: Object.freeze([
    { code: 'AL', name: 'Alabama' },
    { code: 'AK', name: 'Alaska' },
    { code: 'AZ', name: 'Arizona' },
    { code: 'AR', name: 'Arkansas' },
    { code: 'CA', name: 'California' },
    { code: 'CO', name: 'Colorado' },
    { code: 'CT', name: 'Connecticut' },
    { code: 'DE', name: 'Delaware' },
    { code: 'DC', name: 'District of Columbia' },
    { code: 'FL', name: 'Florida' },
    { code: 'GA', name: 'Georgia' },
    { code: 'HI', name: 'Hawaii' },
    { code: 'ID', name: 'Idaho' },
    { code: 'IL', name: 'Illinois' },
    { code: 'IN', name: 'Indiana' },
    { code: 'IA', name: 'Iowa' },
    { code: 'KS', name: 'Kansas' },
    { code: 'KY', name: 'Kentucky' },
    { code: 'LA', name: 'Louisiana' },
    { code: 'ME', name: 'Maine' },
    { code: 'MD', name: 'Maryland' },
    { code: 'MA', name: 'Massachusetts' },
    { code: 'MI', name: 'Michigan' },
    { code: 'MN', name: 'Minnesota' },
    { code: 'MS', name: 'Mississippi' },
    { code: 'MO', name: 'Missouri' },
    { code: 'MT', name: 'Montana' },
    { code: 'NE', name: 'Nebraska' },
    { code: 'NV', name: 'Nevada' },
    { code: 'NH', name: 'New Hampshire' },
    { code: 'NJ', name: 'New Jersey' },
    { code: 'NM', name: 'New Mexico' },
    { code: 'NY', name: 'New York' },
    { code: 'NC', name: 'North Carolina' },
    { code: 'ND', name: 'North Dakota' },
    { code: 'OH', name: 'Ohio' },
    { code: 'OK', name: 'Oklahoma' },
    { code: 'OR', name: 'Oregon' },
    { code: 'PA', name: 'Pennsylvania' },
    { code: 'PR', name: 'Puerto Rico' },
    { code: 'RI', name: 'Rhode Island' },
    { code: 'SC', name: 'South Carolina' },
    { code: 'SD', name: 'South Dakota' },
    { code: 'TN', name: 'Tennessee' },
    { code: 'TX', name: 'Texas' },
    { code: 'UT', name: 'Utah' },
    { code: 'VT', name: 'Vermont' },
    { code: 'VA', name: 'Virginia' },
    { code: 'VI', name: 'U.S. Virgin Islands' },
    { code: 'WA', name: 'Washington' },
    { code: 'WV', name: 'West Virginia' },
    { code: 'WI', name: 'Wisconsin' },
    { code: 'WY', name: 'Wyoming' },
  ]),

  /** Canada: 10 provinces and 3 territories. */
  CA: Object.freeze([
    { code: 'AB', name: 'Alberta' },
    { code: 'BC', name: 'British Columbia' },
    { code: 'MB', name: 'Manitoba' },
    { code: 'NB', name: 'New Brunswick' },
    { code: 'NL', name: 'Newfoundland and Labrador' },
    { code: 'NT', name: 'Northwest Territories' },
    { code: 'NS', name: 'Nova Scotia' },
    { code: 'NU', name: 'Nunavut' },
    { code: 'ON', name: 'Ontario' },
    { code: 'PE', name: 'Prince Edward Island' },
    { code: 'QC', name: 'Quebec' },
    { code: 'SK', name: 'Saskatchewan' },
    { code: 'YT', name: 'Yukon' },
  ]),

  /** Australia: 6 states and 2 mainland territories. */
  AU: Object.freeze([
    { code: 'ACT', name: 'Australian Capital Territory' },
    { code: 'NSW', name: 'New South Wales' },
    { code: 'NT', name: 'Northern Territory' },
    { code: 'QLD', name: 'Queensland' },
    { code: 'SA', name: 'South Australia' },
    { code: 'TAS', name: 'Tasmania' },
    { code: 'VIC', name: 'Victoria' },
    { code: 'WA', name: 'Western Australia' },
  ]),
});

/** The subdivisions of a country, or null where a text box is the right control. */
export function subdivisionsFor(country: CountryCode | null): readonly Subdivision[] | null {
  if (country === null || country === '') return null;
  return SUBDIVISIONS[country.toUpperCase()] ?? null;
}

/**
 * The region, as it is stored in one `VARCHAR(120)` column.
 *
 * ## The format, and why it is not two columns
 *
 * `"Gujarat (GJ)"` — the name, then the code in brackets.
 *
 * The obvious design is `registeredRegion` plus `registeredRegionCode`, and it
 * was rejected for a reason that is specific to this table rather than a
 * general preference. Adding a column to `seller_business_profiles` means a
 * migration on a table that already exists in every deployment, and it buys a
 * column that is null for every seller in Germany, France, the Netherlands,
 * Poland, Greece, Italy and Spain — which is most of the countries this
 * product is being sold into — because those countries have no subdivision a
 * business writes down.
 *
 * What this format gives instead:
 *
 *   - The stored value is READABLE on its own. An admin screen, a CSV export,
 *     a database session and the GDPR export all render "Gujarat (GJ)" without
 *     knowing this file exists, which a bare "GJ" does not.
 *   - The code is recoverable exactly, by `regionCodeOf` below.
 *   - A country with no list stores what was typed, with no brackets and
 *     nothing lost.
 *
 * What it costs: a seller in a listed country who types a region containing
 * brackets would confuse `regionCodeOf`. They cannot — the control is a picker
 * for exactly those countries — and a free-text region that happens to end in
 * brackets is read as a code, which is wrong in a way nobody will notice or be
 * harmed by.
 */
export function regionForStorage(region: Subdivision | string | null): string | null {
  if (region === null) return null;

  if (typeof region === 'string') {
    const trimmed = region.trim();
    return trimmed.length === 0 ? null : trimmed;
  }

  return `${region.name} (${region.code})`;
}

/** The code out of a stored region, or null where there is not one. */
export function regionCodeOf(stored: string | null): string | null {
  if (stored === null) return null;
  const match = /\(([A-Z0-9-]{1,6})\)\s*$/.exec(stored.trim());
  return match?.[1] ?? null;
}

/** The name out of a stored region: the whole thing, less any bracketed code. */
export function regionNameOf(stored: string | null): string | null {
  if (stored === null) return null;
  const trimmed = stored.trim();
  if (trimmed.length === 0) return null;
  return trimmed.replace(/\s*\([A-Z0-9-]{1,6}\)\s*$/, '').trim();
}

/**
 * How a country writes its postal code.
 *
 * ## The rule this table exists to enforce, which is mostly a rule about NOT
 * validating
 *
 * A six-digit check is right for India and wrong everywhere else. A five-digit
 * check is right for the United States and wrong everywhere else. Applying
 * either one globally — which is what a single `\d{6}` in a schema does —
 * makes the field unfillable for most of the world, and the seller who cannot
 * finish an application has no way to tell you why.
 *
 * So this is a map from country to ITS rule, and the absence of an entry is
 * meaningful: a country not listed here is validated permissively, by
 * `POSTAL_GENERAL` below. That is the honest answer. There are around 200
 * postal systems, several have no postal code at all, and a wrong rule is
 * worse than no rule — it refuses a correct address with a confident message.
 *
 * Only countries whose format is genuinely fixed and unambiguous are listed.
 * Where a country's format has exceptions, the pattern is the loose one: this
 * catches a typo, it is not a postal database, and the reviewer looking at the
 * registration certificate is the real check.
 */
interface PostalRule {
  /** Anchored, and tested against the trimmed upper-cased value. */
  pattern: RegExp;
  /** Shown in the error, so the message says what a right answer looks like. */
  example: string;
}

const POSTAL_RULES: Readonly<Record<CountryCode, PostalRule>> = Object.freeze({
  // Six digits, first digit 1-9. A PIN starting 0 does not exist.
  IN: { pattern: /^[1-9]\d{5}$/, example: '380015' },
  // Five digits, optionally ZIP+4.
  US: { pattern: /^\d{5}(-\d{4})?$/, example: '94107 or 94107-1234' },
  // A1A 1A1. The space is optional and the letter set excludes D, F, I, O, Q, U.
  CA: { pattern: /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z] ?\d[ABCEGHJ-NPRSTV-Z]\d$/, example: 'K1A 0B1' },
  // Four digits.
  AU: { pattern: /^\d{4}$/, example: '3000' },
  DE: { pattern: /^\d{5}$/, example: '10115' },
  FR: { pattern: /^\d{5}$/, example: '75001' },
  ES: { pattern: /^\d{5}$/, example: '28001' },
  IT: { pattern: /^\d{5}$/, example: '00184' },
  // 1234 AB. The space is conventional and accepted either way.
  NL: { pattern: /^\d{4} ?[A-Z]{2}$/, example: '1012 AB' },
  PL: { pattern: /^\d{2}-?\d{3}$/, example: '00-001' },
  GR: { pattern: /^\d{3} ?\d{2}$/, example: '104 31' },
  BE: { pattern: /^\d{4}$/, example: '1000' },
  AT: { pattern: /^\d{4}$/, example: '1010' },
  CH: { pattern: /^\d{4}$/, example: '8001' },
  PT: { pattern: /^\d{4}-?\d{3}$/, example: '1000-001' },
  SE: { pattern: /^\d{3} ?\d{2}$/, example: '111 20' },
  DK: { pattern: /^\d{4}$/, example: '1050' },
  NO: { pattern: /^\d{4}$/, example: '0150' },
  FI: { pattern: /^\d{5}$/, example: '00100' },
  IE: { pattern: /^[A-Z]\d{2} ?[A-Z0-9]{4}$/, example: 'D02 AF30' },
  JP: { pattern: /^\d{3}-?\d{4}$/, example: '100-0001' },
  SG: { pattern: /^\d{6}$/, example: '018956' },
  BR: { pattern: /^\d{5}-?\d{3}$/, example: '01310-100' },
  ZA: { pattern: /^\d{4}$/, example: '8001' },
  // Letters and digits in several layouts; the loose one is the honest one.
  GB: { pattern: /^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/, example: 'SW1A 1AA' },
});

/**
 * The fallback, for the roughly 170 countries with no rule above.
 *
 * Letters, digits, spaces and hyphens, two to twelve characters. Wide enough
 * for every postal system in use and narrow enough to refuse the things that
 * are not a postal code at all: an empty string, a sentence, a semicolon, a
 * newline, a script tag.
 *
 * "Permissive but safe" is exactly the right description. It is a shape check,
 * not a lookup.
 */
const POSTAL_GENERAL = /^[A-Z0-9][A-Z0-9 -]{0,10}[A-Z0-9]$/;

/**
 * Why a postal code was refused, or null where it was not.
 *
 * Returns a KEY and its parameters rather than a sentence, so the eight
 * translation catalogues own the wording and this file owns the rule. A
 * validator that returned English would be a validator that made one of the
 * eight languages the real one.
 *
 * The value is compared trimmed and upper-cased, because "sw1a 1aa" and
 * "SW1A 1AA" are the same postcode and refusing the first would be pedantry.
 * What is STORED is what was typed, trimmed — see `normalisePostalCode`.
 */
export type PostalProblem =
  | { kind: 'required' }
  | { kind: 'countryFormat'; example: string }
  | { kind: 'general' };

export function postalProblem(value: string, country: CountryCode | null): PostalProblem | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { kind: 'required' };

  // Longer than the column, whatever the country. Caught here so it is a
  // message rather than a truncation.
  if (trimmed.length > 20) return { kind: 'general' };

  const compared = trimmed.toUpperCase();
  const rule = country === null ? undefined : POSTAL_RULES[country.toUpperCase()];

  if (rule !== undefined) {
    return rule.pattern.test(compared) ? null : { kind: 'countryFormat', example: rule.example };
  }

  return POSTAL_GENERAL.test(compared) ? null : { kind: 'general' };
}

/**
 * A postal code as it should be STORED.
 *
 * Trimmed at both ends and otherwise left exactly as typed. Three things this
 * deliberately does not do, and each of them has bitten somebody:
 *
 *   - **It does not upper-case.** Validation compares upper-cased; storage
 *     keeps what was written. A Dutch postcode is conventionally "1012 AB" and
 *     a British one "SW1A 1AA", and neither is improved by this code deciding.
 *   - **It does not strip spaces or hyphens.** "K1A 0B1" without its space is
 *     not how anybody writes a Canadian postcode, and "01310-100" without its
 *     hyphen is not a CEP.
 *   - **It never touches leading zeroes**, which is the whole reason this is a
 *     string and not a number anywhere in the system. "01234" is a postcode in
 *     Massachusetts; `1234` is a different place in Australia.
 */
export function normalisePostalCode(value: string): string {
  return value.trim();
}

/** The six parts, as they are held on screen and as the API takes them. */
export interface BusinessAddress {
  line1: string;
  line2: string;
  city: string;
  /** Stored form — see `regionForStorage`. */
  region: string;
  postcode: string;
  /** ISO 3166-1 alpha-2, upper case, or '' where nothing is chosen. */
  country: string;
}

export const EMPTY_BUSINESS_ADDRESS: BusinessAddress = Object.freeze({
  line1: '',
  line2: '',
  city: '',
  region: '',
  postcode: '',
  country: '',
});

/** Which fields a seller must fill in. Line 2 is the only optional one. */
export const REQUIRED_ADDRESS_FIELDS = ['line1', 'city', 'region', 'postcode', 'country'] as const;

export type AddressField = keyof BusinessAddress;

/**
 * Everything wrong with an address, keyed by field.
 *
 * Every problem at once rather than the first one, because a form that reveals
 * its objections one at a time is a form somebody submits five times. The
 * shape is `{ field: reason }` so each message can be rendered against its own
 * input, which is what `aria-describedby` needs to be true.
 */
export type AddressProblems = Partial<Record<AddressField, PostalProblem | { kind: 'required' }>>;

export function validateBusinessAddress(address: BusinessAddress): AddressProblems {
  const problems: AddressProblems = {};

  if (address.line1.trim().length === 0) problems.line1 = { kind: 'required' };
  if (address.city.trim().length === 0) problems.city = { kind: 'required' };
  if (address.region.trim().length === 0) problems.region = { kind: 'required' };
  if (address.country.trim().length === 0) problems.country = { kind: 'required' };

  /*
   * The postcode is checked against the COUNTRY, so the country has to be
   * known first. With none chosen it is checked for presence only — telling
   * somebody their postcode is the wrong shape before they have said which
   * country it is in would be an objection to a question they have not been
   * asked yet.
   */
  const postal = postalProblem(
    address.postcode,
    address.country.trim().length === 0 ? null : address.country,
  );
  if (postal !== null) problems.postcode = postal;

  return problems;
}

/** True when nothing at all has been filled in. */
export function isAddressEmpty(address: BusinessAddress): boolean {
  // Named rather than `Object.values`, which TypeScript widens to `any` on an
  // interface and which would then quietly keep compiling if a non-string
  // field were ever added here.
  return (
    [
      address.line1,
      address.line2,
      address.city,
      address.region,
      address.postcode,
      address.country,
    ].every((value) => value.trim().length === 0)
  );
}

/**
 * The address on however many lines it takes, ready to print.
 *
 * ## The rule, which is the only interesting thing about this function
 *
 * **A part that is absent takes nothing with it.** No empty line, no stray
 * comma, no "undefined", no ", , ". That is the specific failure this exists
 * to make impossible: a naive `[a, b, c].join(', ')` over nullable fields
 * produces ", Mumbai, , 400001" the moment one of them is missing, and it will
 * be missing, because line 2 is optional by design and every legacy row has
 * only line 1.
 *
 * The shape follows the convention most of the world writes:
 *
 *     Line 1
 *     Line 2
 *     City, Region Postcode
 *     Country
 *
 * City/region/postcode share a line because they are read together, and the
 * postcode is separated from the region by a space rather than a comma — which
 * is how "Noida, Uttar Pradesh 201301" is actually written.
 */
export function formatBusinessAddress(
  address: Partial<Record<AddressField, string | null | undefined>>,
  options: { countryName?: string | null } = {},
): string[] {
  const clean = (value: string | null | undefined): string | null => {
    if (value === null || value === undefined) return null;
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
  };

  const lines: string[] = [];

  const line1 = clean(address.line1);
  const line2 = clean(address.line2);
  if (line1 !== null) lines.push(line1);
  if (line2 !== null) lines.push(line2);

  // The middle line is built from the parts that exist, in two steps: the
  // comma-separated pair first, then the postcode appended with a space.
  const city = clean(address.city);
  const region = clean(address.region);
  const postcode = clean(address.postcode);

  const placeParts = [city, region].filter((part): part is string => part !== null);
  const place = placeParts.join(', ');
  const middle = [place, postcode]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(' ');
  if (middle.length > 0) lines.push(middle);

  // The country's NAME where the caller could look it up, its code otherwise.
  // A line reading "IN" is not wrong, and it is what a screen with no country
  // list to hand can honestly print.
  const country = clean(options.countryName) ?? clean(address.country);
  if (country !== null) lines.push(country);

  return lines;
}

/** The same address on one line, for a table cell or a summary row. */
export function formatBusinessAddressInline(
  address: Partial<Record<AddressField, string | null | undefined>>,
  options: { countryName?: string | null } = {},
): string | null {
  const lines = formatBusinessAddress(address, options);
  return lines.length === 0 ? null : lines.join(', ');
}

/**
 * Whether a stored profile still has only the old single-line address.
 *
 * True when line 1 says something and every one of the structured fields is
 * empty. That is exactly the shape of a row written by the version of the form
 * that asked one question, and it is what the editor keys its "please finish
 * this off" prompt on.
 *
 * A row with no address at all is NOT legacy — it is empty, and an empty form
 * is the right thing to show for it. A row with line 1 and a country but no
 * postcode is also not legacy; it is partly filled in, and the ordinary
 * validation has something to say about it.
 */
export function isLegacySingleLineAddress(
  stored: Partial<Record<AddressField, string | null | undefined>>,
): boolean {
  const has = (value: string | null | undefined): boolean =>
    value !== null && value !== undefined && value.trim().length > 0;

  return (
    has(stored.line1) &&
    !has(stored.line2) &&
    !has(stored.city) &&
    !has(stored.region) &&
    !has(stored.postcode) &&
    !has(stored.country)
  );
}

/**
 * A problem, in the reader's own language.
 *
 * The validator returns a key and its parameters rather than a sentence — see
 * `business-address.ts` — so this is the one place a rule becomes words, and
 * the eight catalogues own the words.
 */
export function addressProblemMessage(
  t: Translate,
  field: AddressField,
  problem: PostalProblem | { kind: 'required' } | undefined,
): string | undefined {
  if (problem === undefined) return undefined;

  if (problem.kind === 'required') {
    switch (field) {
      case 'line1':
        return t('sellerAddress.line1Required');
      case 'city':
        return t('sellerAddress.cityRequired');
      case 'region':
        return t('sellerAddress.regionRequired');
      case 'country':
        return t('sellerAddress.countryRequired');
      case 'postcode':
        return t('sellerAddress.postcodeRequired');
      default:
        return t('sellerAddress.postcodeRequired');
    }
  }

  // A country whose format this build knows: the message names an example, so
  // it says what a right answer looks like instead of only that this one is
  // wrong. "Enter a valid 6-digit PIN code" is the Indian case of it.
  if (problem.kind === 'countryFormat') {
    return t('sellerAddress.postcodeFormat', { example: problem.example });
  }

  return t('sellerAddress.postcodeGeneral');
}

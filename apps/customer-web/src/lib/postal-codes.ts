/**
 * Postal-code formats for the markets this product is sold into (JOURNEY-022
 * address validation). Only the SHAPE is checked - that a German code is five
 * digits, a Polish one NN-NNN - never that the code exists, which needs a
 * postal authority's register. A country not listed here is accepted as typed:
 * refusing a real address because this table is incomplete would be worse
 * than accepting one with a typo.
 *
 * The storefront keeps the same table here (copied from backend/src/domain/postal-codes.ts)
 * so the shopper is told before they press Save; the server's copy is the authority.
 */
export const POSTAL_CODE_PATTERNS: Readonly<Record<string, RegExp>> = Object.freeze({
  IN: /^[1-9]\d{5}$/,
  DE: /^\d{5}$/,
  FR: /^\d{5}$/,
  ES: /^\d{5}$/,
  IT: /^\d{5}$/,
  GR: /^\d{3} ?\d{2}$/,
  NL: /^\d{4} ?[A-Za-z]{2}$/,
  PL: /^\d{2}-\d{3}$/,
  US: /^\d{5}(-\d{4})?$/,
  GB: /^[A-Za-z]{1,2}\d[A-Za-z\d]? ?\d[A-Za-z]{2}$/,
});

/** True when the code has the shape the country uses, or the country is not listed. */
export function isPlausiblePostalCode(country: string, postalCode: string): boolean {
  const pattern = POSTAL_CODE_PATTERNS[country.toUpperCase()];
  return pattern === undefined || pattern.test(postalCode.trim());
}

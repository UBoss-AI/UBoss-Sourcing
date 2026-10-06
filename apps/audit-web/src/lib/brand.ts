/**
 * The product's own name, and the company behind it.
 *
 * Three facts, and the difference between them is the whole reason this file
 * exists:
 *
 *   - **`PRODUCT_BRAND` is what this software is called.** It is Gloviaa
 *     Mart, and `PRODUCT_SHORT_NAME` — Gloviaa — is the same name where there
 *     is room for one word only. It is not a per-deployment setting, because a buyer does not get to rename the
 *     product they licensed any more than they get to rename their browser.
 *   - **`PRODUCT_TAGLINE` is what it says under its name.** `The Way to the
 *     Global Sourcing`, beside the wordmark wherever the wordmark is shown.
 *   - **`PARENT_ATTRIBUTION` is who makes it.** UBOSS. It appears verbatim, as
 *     small print — the storefront's footer, the console's sign-in screens.
 *
 * WHAT THIS IS NOT
 *
 * It is not the agency's name. That is `session.member.agency.name`, which
 * arrives with the console session and belongs to whichever inspection agency
 * the person works for. Nothing here may ever stand in for it: an inspector
 * shown the product's name where their agency should be has no way to tell
 * whose jobs they are looking at.
 *
 * WHY THESE ARE CONSTANTS AND NOT TRANSLATION KEYS
 *
 * A name is not a string to translate; it is a fact, and a slogan is a brand
 * asset rather than a sentence. `Powered by UBOSS` is a
 * fixed attribution lockup rather than a sentence, so it reads identically in
 * all eight languages — one spelling, one capitalisation, nothing for a
 * translator to drift. `scripts/check-i18n.mjs` carries the same reasoning in
 * `NEVER_TRANSLATED_KEYS` for the handful of catalogue entries that name the
 * product.
 *
 * Copied byte-for-byte from `apps/customer-web/src/lib/brand.ts` apart from
 * `PORTAL_TITLE`. The four applications are four builds with no shared
 * package — the same arrangement `components/ui/3d-globe.tsx` lives under.
 * Change one, change all four.
 */

/**
 * The product. Never `Glovia`, never `Glovia Mart`, never `Gloviaa Market`:
 * two a's, and "Mart".
 */
export const PRODUCT_BRAND = 'Gloviaa Mart';

/**
 * The same name in one word, for the places a two-word name does not fit or
 * does not belong: the core of the orchestration hub on the landing page,
 * where the globe is the "Mart" and the name only has to say whose it is, and
 * the header on a phone, where the row beside five controls has room for one
 * word. Never `GLOVIAA`; any uppercasing is CSS.
 */
export const PRODUCT_SHORT_NAME = 'Gloviaa';

/**
 * The line under the wordmark. The product's slogan, written once, in English,
 * in every language — a tagline is a brand asset rather than a sentence to
 * translate, for the same reason the name is. Owner-approved, exactly: the
 * capitals and the vertical bar are part of it. It replaced `The Way to the
 * Global Sourcing`, which must not come back; any uppercasing is CSS.
 */
export const PRODUCT_TAGLINE = 'Source with Intelligence | Deliver with Confidence';

/**
 * The company behind it. Never `Power by UBOSS`, never `Powered By Uboss`.
 *
 * It no longer sits under the wordmark — the tagline does. It is the small
 * print in the storefront's footer and on the sign-in screens.
 */
export const PARENT_ATTRIBUTION = 'Powered by UBOSS';

/**
 * The letter under the earth, for the moments and the browsers where the
 * globe cannot be drawn. See `components/EarthMark.tsx`.
 */
export const PRODUCT_INITIAL = PRODUCT_BRAND.slice(0, 1).toUpperCase();

/**
 * What the browser tab says, and the only place the console is named.
 *
 * The same pattern as the carrier portal's `Gloviaa Mart Logistics`: the product,
 * then which of its applications this is. The tab is what a person with the
 * admin console and this one open side by side reads to tell them apart. Kept
 * in step with `index.html`, which carries the same string for the first paint.
 */
export const PORTAL_TITLE = `${PRODUCT_BRAND} Audit Console`;

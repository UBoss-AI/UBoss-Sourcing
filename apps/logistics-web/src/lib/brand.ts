/**
 * The product's own name, and the company behind it.
 *
 * Three facts, and the difference between them is the whole reason this file
 * exists:
 *
 *   - **`PRODUCT_BRAND` is what this software is called.** It is Glovia. It is
 *     not a per-deployment setting, because a buyer does not get to rename the
 *     product they licensed any more than they get to rename their browser.
 *   - **`PRODUCT_TAGLINE` is what it says under its name.** `The Way to the
 *     World`, beside the wordmark wherever the wordmark is shown.
 *   - **`PARENT_ATTRIBUTION` is who makes it.** UBOSS. It appears verbatim, as
 *     small print — the storefront's footer, the console's sign-in screens.
 *
 * WHAT THIS IS NOT
 *
 * It is not the carrier's name. That is `session.partner.displayName`, which
 * arrives with the portal session and belongs to whichever company signed in —
 * Sahyadri Express reads "Sahyadri Express" on the rail, under a portal called
 * Glovia. Nothing here may ever stand in for it: a carrier shown the product's
 * name where their own company should be has no way to tell whose consignments
 * they are looking at.
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
 * `PORTAL_TITLE`. The three applications are three builds with no shared
 * package — the same arrangement `components/ui/3d-globe.tsx` lives under.
 * Change one, change all three.
 */

/** The product. Never `GLOVIA`, never `Glovia Sourcing`. */
export const PRODUCT_BRAND = 'Glovia';

/**
 * The line under the wordmark. The product's slogan, written once, in English,
 * in every language — a tagline is a brand asset rather than a sentence to
 * translate, for the same reason the name is. Never `The way to the world`,
 * never `The Way To The World`; any uppercasing is CSS.
 */
export const PRODUCT_TAGLINE = 'The Way to the World';

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
 * What the browser tab says, and the only place the portal is named.
 *
 * The rail used to carry "UBOSS Logistics" as its one line, which is what told
 * a dispatcher with two tabs open which one they were in. The attribution
 * stands under the brand there now, so the job moves to the tab — which is,
 * after all, the thing a person reads when they are looking at two tabs. Kept
 * in step with `index.html`, which carries the same string for the first
 * paint.
 */
export const PORTAL_TITLE = `${PRODUCT_BRAND} Logistics`;

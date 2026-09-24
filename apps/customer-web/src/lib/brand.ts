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
 * It is not the shop's name. That is `business.displayName`, which arrives
 * from `GET /api/v1/config` and comes from the operator's own settings — see
 * `app/storefront-context.ts`. Every buyer runs their own deployment, so the
 * storefront header, the footer, the e-mails and the tab title name *their*
 * business, not ours. The two are distinct and the distinction is load-bearing:
 * a storefront that greeted Northwind's customers with "Glovia" would be this
 * software putting the vendor's name over somebody else's shop.
 *
 * Where the product's own identity genuinely belongs — the core of the
 * orchestration hub, the tagline under the wordmark, the console and portal
 * chrome — it comes from here and from nowhere else.
 *
 * WHY THESE ARE CONSTANTS AND NOT TRANSLATION KEYS
 *
 * A name is not a string to translate; it is a fact, and a slogan is a brand
 * asset rather than a sentence. The greeting's moving line under it —
 * `greeting.taglineSource` and `greeting.taglineDeliver` — *is* prose and *is*
 * translated, which is exactly the line this draws.
 * `Powered by UBOSS` is a fixed attribution lockup rather than a sentence, so
 * it reads identically in all eight languages — one spelling, one
 * capitalisation, nothing for a translator to drift. `scripts/check-i18n.mjs`
 * carries the same reasoning in `NEVER_TRANSLATED_KEYS` for the handful of
 * catalogue entries that name the product.
 *
 * Copied byte-for-byte into `apps/admin-web/src/lib/brand.ts` and
 * `apps/logistics-web/src/lib/brand.ts`, apart from the portal title at the
 * foot of each. The three applications are three builds with no shared
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

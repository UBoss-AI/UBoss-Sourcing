/**
 * "Gloviaa Mart", set the way the product names itself everywhere it appears
 * as a wordmark: "Gloviaa" in the surrounding script face, "Mart" in Inter light and lowercase ("mart"),
 * the interface face, a step smaller and on the same baseline — the way a
 * parent brand names one of its services.
 *
 * Plain text in two spans, so it reads, copies and is announced as
 * "Gloviaa Mart". Inter is already loaded for the whole interface, so the
 * second face costs no request and cannot arrive late and move the word.
 *
 * The parent word takes its face from whatever it sits in (`font-brand` on
 * the hero heading and the header lockup); only "Mart" sets its own. Kept the
 * same in `apps/admin-web` and `apps/logistics-web`'s `BrandLockup`.
 */
import { PRODUCT_BRAND, PRODUCT_SHORT_NAME } from '@/lib/brand';

/** "Mart": the part of the name after the parent brand. */
export const PRODUCT_SERVICE_NAME = PRODUCT_BRAND.slice(PRODUCT_SHORT_NAME.length).trim();

export function BrandName(): React.JSX.Element {
  return (
    <>
      <span className="brand-name-parent">{PRODUCT_SHORT_NAME}</span>{' '}
      <span className="brand-name-service font-sans text-[0.62em] font-light lowercase tracking-tight">
        {PRODUCT_SERVICE_NAME}
      </span>
    </>
  );
}

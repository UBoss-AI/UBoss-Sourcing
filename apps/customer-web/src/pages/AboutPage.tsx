/**
 * About - what this marketplace is, who takes part in it and what it does.
 *
 * Public, inside the ordinary storefront frame, and the one page every About
 * link opens: the footer's on every width, and the header's from `lg`.
 *
 * It describes the deployment it is running on, not a brochure of the
 * software: a capability that is switched off here is not mentioned here (see
 * `components/about/about-content.ts`), and nothing on it is a number, because
 * the business running this storefront has not given us any to print.
 *
 * No questions and answers. Those are the Support page's, near its top, and a
 * second copy here would be a second place for them to go out of date.
 */
import { useStorefront } from '@/app/storefront-context';
import {
  AboutCallToAction,
  AboutCapabilities,
  AboutIntro,
  AboutStory,
} from '@/components/about/AboutSections';
import { useI18n } from '@/i18n/i18n-context';
import { useDocumentMeta } from '@/lib/useDocumentMeta';

export function AboutPage(): React.JSX.Element {
  const { t } = useI18n();
  const { business } = useStorefront();

  useDocumentMeta(
    {
      title: t('about.metaTitle'),
      description: t('about.metaDescription'),
      // The shop's own logo when it has uploaded one; otherwise no image,
      // rather than a picture nobody approved for sharing.
      imageUrl: business.logo?.url ?? null,
    },
    business.displayName,
  );

  return (
    // `overflow-x-clip`, not `hidden`: it stops the decoration from ever
    // widening the page without making this a scroll container, which would
    // break the sticky header above it and the anchor jump inside it.
    <div className="mx-auto max-w-6xl space-y-16 overflow-x-clip px-0 py-4 sm:space-y-20 sm:px-2 lg:py-10">
      <AboutIntro />
      <AboutStory />
      <AboutCapabilities />
      <AboutCallToAction />
    </div>
  );
}

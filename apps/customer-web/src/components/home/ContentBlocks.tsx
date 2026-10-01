/**
 * The operator's banners and category content blocks (checklist Master row 72).
 *
 * Asks for the blocks live now for the shopper's country and language; the
 * server applies the publishing flag, the schedule and the targeting, so
 * nothing here decides what is shown. A block may carry a coupon code, which
 * the server sends only while that coupon can actually be used. Renders
 * nothing when there are no blocks or the request fails: a missing banner is
 * never an error a shopper needs to see.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useLocale } from '@/app/locale-context';
import { api } from '@/lib/api';
import { useI18n } from '@/i18n/i18n-context';

export interface PublicContentBlock {
  id: string;
  title: string;
  body: string | null;
  imageUrl: string | null;
  linkUrl: string | null;
  couponCode: string | null;
}

function useBlocks(placement: 'HOME_BANNER' | 'CATEGORY_BLOCK', category: string | null) {
  const { language } = useI18n();
  const { country } = useLocale();
  const code = country !== null && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : '';
  return useQuery({
    queryKey: ['content-blocks', placement, category ?? '', code, language],
    queryFn: () =>
      api.get<{ blocks: PublicContentBlock[] }>('/catalog/content-blocks', {
        query: {
          placement,
          language,
          ...(code === '' ? {} : { country: code }),
          ...(category === null ? {} : { category }),
        },
      }),
    enabled: placement === 'HOME_BANNER' || category !== null,
    staleTime: 60_000,
    retry: false,
  });
}

function BlockCard({ block }: { block: PublicContentBlock }): React.JSX.Element {
  const { t } = useI18n();
  const link = block.linkUrl;
  const cta =
    link === null ? null : link.startsWith('/') ? (
      <Link to={link} className="text-sm font-medium text-brand underline">
        {t('contentBlocks.open')}
      </Link>
    ) : (
      <a href={link} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-brand underline">
        {t('contentBlocks.open')}
      </a>
    );
  return (
    <article className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-sm sm:flex-row">
      {block.imageUrl !== null && (
        <img src={block.imageUrl} alt="" loading="lazy" className="h-40 w-full object-cover sm:h-auto sm:w-48" />
      )}
      <div className="min-w-0 space-y-2 p-5">
        <h3 className="text-base font-semibold text-ink">{block.title}</h3>
        {block.body !== null && <p className="whitespace-pre-line text-sm text-ink-muted">{block.body}</p>}
        {block.couponCode !== null && (
          <p className="text-sm text-ink">
            {t('contentBlocks.useCode')}{' '}
            <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-sm">{block.couponCode}</code>
          </p>
        )}
        {cta}
      </div>
    </article>
  );
}

/** The home page's banners. */
export function HomeBanners(): React.JSX.Element | null {
  const { t } = useI18n();
  const query = useBlocks('HOME_BANNER', null);
  const blocks = query.data?.blocks ?? [];
  if (blocks.length === 0) return null;
  return (
    <section aria-label={t('contentBlocks.homeLabel')} className="mb-10 grid gap-4 md:grid-cols-2">
      {blocks.map((block) => (
        <BlockCard key={block.id} block={block} />
      ))}
    </section>
  );
}

/** The blocks written for one category's page. */
export function CategoryContentBlocks({ slug }: { slug: string }): React.JSX.Element | null {
  const { t } = useI18n();
  const query = useBlocks('CATEGORY_BLOCK', slug);
  const blocks = query.data?.blocks ?? [];
  if (blocks.length === 0) return null;
  return (
    <section aria-label={t('contentBlocks.categoryLabel')} className="mb-6 grid gap-4 md:grid-cols-2">
      {blocks.map((block) => (
        <BlockCard key={block.id} block={block} />
      ))}
    </section>
  );
}

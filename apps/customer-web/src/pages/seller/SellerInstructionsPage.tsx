/**
 * What buyers have asked for, across everything this seller sells.
 *
 * The other end of the storefront's "Add instructions" button. A shopper can
 * say what they need on a product without buying it — "do you do this in
 * 8mm?", "can you supply a calibration certificate?", "we need four hundred a
 * month, would you hold stock?" — and this is where all of it lands.
 *
 * Its own screen as well as a panel on each listing, because the two answer
 * different questions. The panel answers "why is nobody buying THIS?"; this
 * page answers "what are people asking me for?", which is the one that changes
 * what a seller stocks. Reading it product by product would mean opening forty
 * listings to notice that six buyers have asked for the same size.
 *
 * Read-only. These are the buyer's own words: a seller who could edit one
 * could rewrite the evidence of what was asked for.
 *
 * Grouped by product rather than listed flat, and that is the whole value of
 * the page. Three sentences about one product from three different buyers is
 * a stocking decision; the same three scattered down a timeline is three
 * anecdotes. Within a product they stay newest first, and the products
 * themselves are ordered by their most recent request, so what came in this
 * morning is at the top of the page.
 */
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { formatRelative } from '@/lib/format';
import { fetchSellerInstructions, type SellerProductInstruction } from '@/lib/seller';

interface ProductGroup {
  productId: string;
  productName: string;
  productSku: string;
  instructions: SellerProductInstruction[];
}

/**
 * Fold the flat, newest-first list into products, keeping that order.
 *
 * A `Map` rather than an object, because insertion order on a `Map` is
 * guaranteed for every key type — an object would reorder anything that looks
 * like an integer, and a product id is a ULID which does not, but relying on
 * that is relying on the shape of an id.
 */
function groupByProduct(rows: readonly SellerProductInstruction[]): ProductGroup[] {
  const groups = new Map<string, ProductGroup>();

  for (const row of rows) {
    const existing = groups.get(row.productId);

    if (existing === undefined) {
      groups.set(row.productId, {
        productId: row.productId,
        productName: row.productName,
        productSku: row.productSku,
        instructions: [row],
      });
    } else {
      existing.instructions.push(row);
    }
  }

  return [...groups.values()];
}

export function SellerInstructionsPage(): React.JSX.Element {
  const { t } = useI18n();

  const query = useQuery({
    queryKey: ['seller', 'instructions'],
    queryFn: () => fetchSellerInstructions(200),
  });

  const groups = useMemo(() => groupByProduct(query.data ?? []), [query.data]);

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('seller.instructions.title')}
        description={t('seller.instructions.intro')}
      />

      {query.isPending && <LoadingState label={t('common.loading')} />}

      {query.isError && (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      )}

      {query.isSuccess && groups.length === 0 && (
        <EmptyState
          title={t('seller.instructions.emptyTitle')}
          description={t('seller.instructions.emptyBody')}
        />
      )}

      {groups.map((group) => (
        <Card
          key={group.productId}
          title={group.productName}
          description={t('seller.instructions.count', {
            count: group.instructions.length,
          })}
          bodyClassName="px-6 py-5"
        >
          <ul className="space-y-3">
            {group.instructions.map((instruction) => (
              <InstructionRow key={instruction.id} instruction={instruction} />
            ))}
          </ul>

          {/*
            The way back to the thing this is about.

            By product code rather than by name, because the code is what a
            seller's own warehouse and invoices key on — and because the name
            is already the card's heading directly above it.
          */}
          <p className="mt-4 text-xxs">
            <Link
              to={`/seller/listings?search=${encodeURIComponent(group.productSku)}`}
              className="font-medium text-brand hover:underline"
            >
              {t('seller.instructions.openListing')}
              <span className="text-ink-subtle"> · {group.productSku}</span>
            </Link>
          </p>
        </Card>
      ))}
    </div>
  );
}

function InstructionRow({
  instruction,
}: {
  instruction: SellerProductInstruction;
}): React.JSX.Element {
  const { t } = useI18n();

  return (
    <li className="rounded-lg border border-border-subtle bg-surface-sunken p-4">
      {/* `flex-wrap` and `min-w-0`: a name plus an organisation plus a
          timestamp does not fit on one line at 320px, and an organisation name
          with no spaces in it would otherwise widen the whole hub. */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="min-w-0 break-words text-sm font-semibold text-ink">
          {instruction.customerName}
          {instruction.customerOrganization !== null && (
            <span className="font-normal text-ink-muted">
              {' · '}
              {instruction.customerOrganization}
            </span>
          )}
        </p>
        <time dateTime={instruction.createdAt} className="shrink-0 text-xxs text-ink-subtle">
          {formatRelative(instruction.createdAt)}
        </time>
      </div>

      {instruction.variantName !== null && (
        <p className="mt-1 text-xxs uppercase tracking-wide text-ink-subtle">
          {t('seller.listing.aboutVersion', { version: instruction.variantName })}
        </p>
      )}

      {/* `whitespace-pre-line`: somebody who typed three lines meant three
          lines. `break-words` because this is free text and a buyer can paste
          a part number eighty characters long.

          Rendered as TEXT. Nothing on this path touches
          `dangerouslySetInnerHTML`, and the column holds plain text precisely
          so that it cannot. */}
      <p className="mt-2 whitespace-pre-line break-words text-sm leading-relaxed text-ink">
        {instruction.body}
      </p>
    </li>
  );
}

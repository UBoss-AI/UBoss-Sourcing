/**
 * Saved for later.
 *
 * The narrowest useful feature, and the absences are the design. There is no
 * quantity, no note and no reordering: a wishlist that carries a quantity is a
 * second basket with none of a basket's rules — no minimum order quantity, no
 * increment, no stock reservation, no priced total — and the moment one exists
 * somebody tries to check it out. Saving a line says "remind me about this";
 * buying it means adding it to the cart, where every one of those rules
 * applies.
 *
 * **A saved line whose product has gone is shown, not hidden.** Weeks pass. A
 * product gets unpublished, a variant deactivated, or the shopper switches to
 * a currency the product is not priced in. The row stays, marked unavailable
 * and without a price, because a saved item that silently vanishes is
 * indistinguishable from a bug — and the customer is owed the chance to see
 * that the thing they were waiting for has gone rather than to wonder whether
 * they imagined saving it.
 *
 * Prices come from the server, quoted for the destination and the currency the
 * rest of the storefront is using. Nothing here multiplies anything.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useLocale } from '@/app/locale-context';
import { useSession } from '@/auth/session-context';
import { useStorefront } from '@/app/storefront-context';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  ButtonLink,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/ui';
import { BoxIcon, TrashIcon } from '@/components/icons';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { formatDate, formatMoneyMinor } from '@/lib/format';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { useI18n } from '@/i18n/i18n-context';
import type { WishlistItem } from '@/lib/types';
import { AccountPanel } from './AccountPanel';

interface WishlistResponse {
  items: WishlistItem[];
  currency: string;
  country: string | null;
}

export function WishlistPage(): React.JSX.Element {
  const { t, language } = useI18n();
  const { business } = useStorefront();
  const { isCustomer } = useSession();
  const { currency, country } = useLocale();
  const toast = useToast();
  const queryClient = useQueryClient();

  useDocumentMeta({ title: t('account.nav.wishlist'), noIndex: true }, business.displayName);

  const wishlistKey = ['wishlist', { currency, country, language }];

  const query = useQuery({
    // The market is part of the key for the same reason it is on the catalogue
    // grid: the same saved line costs a different amount in another
    // destination, because the destination's tax is applied before it is sent.
    queryKey: wishlistKey,
    queryFn: () =>
      api.get<WishlistResponse>('/account/wishlist', {
        query: { currency, country: country ?? undefined, language },
      }),
    enabled: isCustomer,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/account/wishlist/${id}`),
    onSuccess: async () => {
      toast.success(t('wishlist.removed'));
      // Both keys: this list, and the profile read whose `wishlistCount` the
      // sidebar and the header may be showing.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['wishlist'] }),
        queryClient.invalidateQueries({ queryKey: ['account-profile'] }),
      ]);
    },
    onError: (error) => {
      toast.error(errorMessage(t, error, t('wishlist.couldNotRemove')));
    },
  });

  if (query.isPending) return <LoadingState label={t('wishlist.loading')} />;

  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  const { items } = query.data;

  return (
    <>
      <PageHeader title={t('account.nav.wishlist')} description={t('wishlist.description')} />

      <AccountPanel title={t('wishlist.heading')}>
        {items.length === 0 ? (
          <EmptyState
            title={t('wishlist.emptyTitle')}
            description={t('wishlist.emptyBody')}
            action={
              <ButtonLink to="/products" variant="secondary">
                {t('home.viewAllProducts')}
              </ButtonLink>
            }
          />
        ) : (
          <ul className="divide-y divide-border-subtle">
            {items.map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-start gap-x-4 gap-y-3 py-4 first:pt-0 last:pb-0"
              >
                {/* The picture, or a placeholder plate. A grey box would read
                    as a failed image load; a tinted plate with a stock mark
                    reads as a product with no photograph, which is what it is. */}
                {item.imageUrl === null ? (
                  <span
                    aria-hidden="true"
                    className="flex h-16 w-16 shrink-0 items-center justify-center rounded-md bg-brand-soft text-brand ring-1 ring-inset ring-brand/15"
                  >
                    <BoxIcon className="h-6 w-6" />
                  </span>
                ) : (
                  <img
                    src={item.imageUrl}
                    alt=""
                    width={64}
                    height={64}
                    className="h-16 w-16 shrink-0 rounded-md border border-border bg-surface-media object-contain p-1"
                  />
                )}

                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <Link
                      to={`/product/${item.productSlug}`}
                      className="text-sm font-medium text-ink hover:text-brand hover:underline"
                    >
                      {item.productName}
                    </Link>
                    {!item.isAvailable && (
                      <Badge tone="warning">{t('wishlist.notAvailable')}</Badge>
                    )}
                  </p>

                  <p className="mt-0.5 text-xs text-ink-muted">
                    {item.sku}
                    {item.variant !== null && ` · ${item.variant.name}`}
                  </p>

                  <p className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    {/* No price is an ordinary answer: the product is not
                        priced in the currency being browsed. Saying so beats
                        printing a figure from another market. */}
                    {item.priceMinor === null ? (
                      <span className="text-sm text-ink-subtle">
                        {t('wishlist.notPricedInCurrency', { currency: item.currency })}
                      </span>
                    ) : (
                      <span className="text-sm font-semibold tabular text-ink">
                        {formatMoneyMinor(item.priceMinor, item.currency)}
                      </span>
                    )}
                    <span className="text-xs text-ink-subtle">
                      {t('wishlist.savedOn', { date: formatDate(item.savedAt) })}
                    </span>
                  </p>
                </div>

                <div className="flex shrink-0 flex-col items-stretch gap-2 sm:flex-row sm:items-center">
                  {/*
                   * To the product page, not straight into the basket.
                   *
                   * Adding from here would have to invent a quantity, and the
                   * quantity is exactly what a purchase rule constrains — a
                   * minimum of ten, an increment of five. The product page is
                   * where those rules are stated and enforced, so that is
                   * where a saved line is turned into a basket line.
                   */}
                  <ButtonLink
                    to={`/product/${item.productSlug}`}
                    variant={item.isAvailable ? 'primary' : 'secondary'}
                    size="sm"
                  >
                    {t('wishlist.viewProduct')}
                  </ButtonLink>

                  <Button
                    variant="ghost"
                    size="sm"
                    isLoading={remove.isPending && remove.variables === item.id}
                    onClick={() => {
                      remove.mutate(item.id);
                    }}
                  >
                    <TrashIcon aria-hidden="true" className="h-4 w-4" />
                    {t('wishlist.remove')}
                    <span className="sr-only"> {item.productName}</span>
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </AccountPanel>
    </>
  );
}

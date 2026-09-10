/**
 * Save a line without buying it.
 *
 * Deliberately a small, quiet control beside the buy path rather than a second
 * primary action. Saving something is not a commitment and should not compete
 * with Add to cart, which is the one thing on a product page that is.
 *
 * Three decisions worth keeping.
 *
 * **It is a toggle whose state is read, not remembered.** The wishlist is on
 * the server, and this reads it — so a product saved on a phone shows as saved
 * on a laptop, and pressing it twice does not save it twice. The list is one
 * cheap read shared by every instance of this button on a page via the query
 * cache, rather than a per-product "is this saved" call.
 *
 * **A guest gets a sign-in prompt, not a hidden control.** Somebody browsing
 * without an account is exactly who wants to keep a line for later, and
 * removing the button teaches them nothing. It says what signing in buys them
 * and takes them there, returning to this product afterwards.
 *
 * **It saves the option that is chosen, when one is.** A product with variants
 * saved without its variant is a saved line the customer has to configure
 * again, which is most of what they came back for.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useLocale } from '@/app/locale-context';
import { useSession } from '@/auth/session-context';
import { useToast } from '@/components/toast-context';
import { Button } from '@/components/ui';
import { HeartIcon } from '@/components/icons';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { useI18n } from '@/i18n/i18n-context';
import type { WishlistItem } from '@/lib/types';

interface WishlistResponse {
  items: WishlistItem[];
  currency: string;
  country: string | null;
}

export interface SaveForLaterButtonProps {
  productId: string;
  /** Where to come back to after a sign-in detour. */
  productSlug: string;
  /** The chosen option, when the product has options and one is chosen. */
  variantId?: string | null;
}

export function SaveForLaterButton({
  productId,
  productSlug,
  variantId = null,
}: SaveForLaterButtonProps): React.JSX.Element {
  const { t, language } = useI18n();
  const { isCustomer } = useSession();
  const { currency, country } = useLocale();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();

  const wishlist = useQuery({
    // The same key the wishlist page uses, so this button costs nothing on a
    // visit that has already loaded the list — and saving from here updates
    // that page without either knowing about the other.
    queryKey: ['wishlist', { currency, country, language }],
    queryFn: () =>
      api.get<WishlistResponse>('/account/wishlist', {
        query: { currency, country: country ?? undefined, language },
      }),
    enabled: isCustomer,
    staleTime: 60_000,
  });

  /*
   * `?? []` on the array, not only on the response.
   *
   * This button lives on a product page, which is reachable without ever
   * having loaded a wishlist — so the query may be disabled, in flight, failed
   * or answered by a response from a deployment that predates the field. In
   * every one of those cases "nothing is saved" is the right answer and a
   * thrown `undefined.find` is not: it would take the whole product page down
   * over a decoration.
   */
  const saved =
    (wishlist.data?.items ?? []).find(
      (item) =>
        item.productId === productId && (item.variant?.id ?? null) === (variantId ?? null),
    ) ?? null;

  const invalidate = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['wishlist'] }),
      // The profile read carries `wishlistCount`, which the account area may
      // be showing.
      queryClient.invalidateQueries({ queryKey: ['account-profile'] }),
    ]);
  };

  const save = useMutation({
    mutationFn: () =>
      api.post('/account/wishlist', {
        productId,
        ...(variantId === null ? {} : { variantId }),
      }),
    onSuccess: async () => {
      toast.success(t('saveForLater.saved'));
      await invalidate();
    },
    onError: (error) => {
      toast.error(errorMessage(t, error, t('saveForLater.couldNotSave')));
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/account/wishlist/${id}`),
    onSuccess: async () => {
      toast.success(t('wishlist.removed'));
      await invalidate();
    },
    onError: (error) => {
      toast.error(errorMessage(t, error, t('wishlist.couldNotRemove')));
    },
  });

  if (!isCustomer) {
    return (
      <Button
        variant="ghost"
        onClick={() => {
          void navigate('/login', { state: { from: `/product/${productSlug}` } });
        }}
      >
        <HeartIcon aria-hidden="true" className="h-[1.15rem] w-[1.15rem]" />
        {t('saveForLater.action')}
      </Button>
    );
  }

  const isBusy = save.isPending || remove.isPending;

  return (
    <Button
      variant="ghost"
      // `aria-pressed` rather than two different labels: it is one control
      // with a state, and a screen reader announces "Save for later, pressed"
      // which is exactly what the filled heart says to everybody else.
      aria-pressed={saved !== null}
      isLoading={isBusy}
      onClick={() => {
        if (saved === null) save.mutate();
        else remove.mutate(saved.id);
      }}
      className={saved === null ? undefined : 'text-brand'}
    >
      <HeartIcon
        aria-hidden="true"
        // Filled by a currentColor stroke plus a tinted fill: the icon set is
        // stroke-only by design, so "saved" is said with colour rather than by
        // swapping in a second glyph that would sit at a different weight.
        className={saved === null ? 'h-[1.15rem] w-[1.15rem]' : 'h-[1.15rem] w-[1.15rem] fill-brand/20'}
      />
      {saved === null ? t('saveForLater.action') : t('saveForLater.savedLabel')}
    </Button>
  );
}

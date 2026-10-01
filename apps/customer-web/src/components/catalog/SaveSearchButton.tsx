/**
 * "Save this search", beside the heading of a search result (checklist Master
 * row 87).
 *
 * Only for a signed-in buyer and only for a real search term: a saved search
 * with no term would alert on the whole catalogue. Saves the term with the
 * narrowing on screen - category, price range in the shopper's currency, and
 * their destination - and alerts on, which is what somebody pressing this
 * button almost always wants. The list and the off switch live on
 * /account/saved-searches.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSession } from '@/auth/session-context';
import { Button, ButtonLink } from '@/components/ui';
import { BellIcon } from '@/components/icons';
import { useToast } from '@/components/toast-context';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { useI18n } from '@/i18n/i18n-context';

export interface SaveSearchButtonProps {
  q: string;
  category: string | null;
  minPrice: string | null;
  maxPrice: string | null;
  currency: string;
  country: string | null;
}

const WHOLE_MINOR = /^\d{1,18}$/;

export function SaveSearchButton(props: SaveSearchButtonProps): React.JSX.Element | null {
  const { t } = useI18n();
  const { isCustomer } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [savedFor, setSavedFor] = useState<string | null>(null);

  const term = props.q.trim();
  const save = useMutation({
    mutationFn: () => {
      const min = props.minPrice !== null && WHOLE_MINOR.test(props.minPrice) ? props.minPrice : null;
      const max = props.maxPrice !== null && WHOLE_MINOR.test(props.maxPrice) ? props.maxPrice : null;
      const filters = {
        ...(props.category !== null && !props.category.includes(',')
          ? { category: props.category }
          : {}),
        ...(props.country !== null ? { country: props.country } : {}),
        ...(min !== null || max !== null ? { currency: props.currency } : {}),
        ...(min !== null ? { minPrice: min } : {}),
        ...(max !== null ? { maxPrice: max } : {}),
      };
      return api.post('/account/saved-searches', {
        name: term.slice(0, 120),
        query: term.slice(0, 200),
        filters,
      });
    },
    onSuccess: async () => {
      setSavedFor(term);
      toast.success(t('savedSearch.saved'));
      await queryClient.invalidateQueries({ queryKey: ['saved-searches'] });
    },
    onError: (error) => {
      toast.error(errorMessage(t, error, t('savedSearch.couldNotSave')));
    },
  });

  if (!isCustomer || term === '') return null;

  if (savedFor === term) {
    return (
      <ButtonLink to="/account/saved-searches" variant="ghost" size="sm">
        {t('savedSearch.viewSaved')}
      </ButtonLink>
    );
  }

  return (
    <Button
      variant="secondary"
      size="sm"
      isLoading={save.isPending}
      onClick={() => {
        save.mutate();
      }}
    >
      <BellIcon aria-hidden="true" className="h-4 w-4" />
      {t('savedSearch.saveThisSearch')}
    </Button>
  );
}

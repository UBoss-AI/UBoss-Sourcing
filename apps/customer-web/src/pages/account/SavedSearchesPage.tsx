/**
 * Saved searches (checklist Master row 87).
 *
 * The searches a buyer kept from the results page, each with its new-match
 * e-mail alerts on or off. Opening one reruns it on the storefront; nothing
 * here searches by itself. The alerts are sent by the backend at most once a
 * day per search, for products published or repriced since the last one.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStorefront } from '@/app/storefront-context';
import { useSession } from '@/auth/session-context';
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
import { BellIcon, TrashIcon } from '@/components/icons';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { formatDate } from '@/lib/format';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { useI18n } from '@/i18n/i18n-context';
import { AccountPanel } from './AccountPanel';

export interface SavedSearch {
  id: string;
  name: string;
  query: string;
  filters: {
    category?: string;
    country?: string;
    currency?: string;
    minPrice?: string;
    maxPrice?: string;
  };
  alertsEnabled: boolean;
  lastNotifiedAt: string | null;
  createdAt: string;
}

interface SavedSearchesResponse {
  items: SavedSearch[];
  limit: number;
}

/** The storefront URL that reruns a saved search. */
function savedSearchHref(search: SavedSearch): string {
  const params = new URLSearchParams({ q: search.query });
  if (search.filters.category !== undefined) params.set('category', search.filters.category);
  if (search.filters.minPrice !== undefined) params.set('minPrice', search.filters.minPrice);
  if (search.filters.maxPrice !== undefined) params.set('maxPrice', search.filters.maxPrice);
  return `/search?${params.toString()}`;
}

export function SavedSearchesPage(): React.JSX.Element {
  const { t } = useI18n();
  const { business } = useStorefront();
  const { isCustomer } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();

  useDocumentMeta({ title: t('savedSearch.navLabel'), noIndex: true }, business.displayName);

  const query = useQuery({
    queryKey: ['saved-searches'],
    queryFn: () => api.get<SavedSearchesResponse>('/account/saved-searches'),
    enabled: isCustomer,
  });

  const toggle = useMutation({
    mutationFn: (search: SavedSearch) =>
      api.patch(`/account/saved-searches/${search.id}`, { alertsEnabled: !search.alertsEnabled }),
    onSuccess: async () => {
      toast.success(t('savedSearch.updated'));
      await queryClient.invalidateQueries({ queryKey: ['saved-searches'] });
    },
    onError: (error) => {
      toast.error(errorMessage(t, error, t('savedSearch.couldNotUpdate')));
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/account/saved-searches/${id}`),
    onSuccess: async () => {
      toast.success(t('savedSearch.deleted'));
      await queryClient.invalidateQueries({ queryKey: ['saved-searches'] });
    },
    onError: (error) => {
      toast.error(errorMessage(t, error, t('savedSearch.couldNotDelete')));
    },
  });

  if (query.isPending) return <LoadingState label={t('savedSearch.loading')} />;

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

  const { items, limit } = query.data;

  return (
    <>
      <PageHeader title={t('savedSearch.navLabel')} description={t('savedSearch.description')} />

      <AccountPanel
        title={t('savedSearch.heading')}
        description={t('savedSearch.usage', { used: String(items.length), limit: String(limit) })}
      >
        {items.length === 0 ? (
          <EmptyState
            title={t('savedSearch.emptyTitle')}
            description={t('savedSearch.emptyBody')}
            action={
              <ButtonLink to="/products" variant="secondary">
                {t('home.viewAllProducts')}
              </ButtonLink>
            }
          />
        ) : (
          <ul className="divide-y divide-border-subtle">
            {items.map((search) => (
              <li
                key={search.id}
                className="flex flex-wrap items-start gap-x-4 gap-y-3 py-4 first:pt-0 last:pb-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-ink">{search.name}</span>
                    <Badge tone={search.alertsEnabled ? 'success' : 'neutral'}>
                      {search.alertsEnabled ? t('savedSearch.alertsOn') : t('savedSearch.alertsOff')}
                    </Badge>
                  </p>
                  <p className="mt-0.5 break-words text-xs text-ink-muted">
                    {t('savedSearch.searchFor', { query: search.query })}
                    {search.filters.category !== undefined && ` · ${search.filters.category}`}
                  </p>
                  <p className="mt-1 text-xs text-ink-subtle">
                    {t('savedSearch.savedOn', { date: formatDate(search.createdAt) })}
                    {search.lastNotifiedAt !== null &&
                      ` · ${t('savedSearch.lastChecked', { date: formatDate(search.lastNotifiedAt) })}`}
                  </p>
                </div>

                <div className="flex shrink-0 flex-col items-stretch gap-2 sm:flex-row sm:items-center">
                  <ButtonLink to={savedSearchHref(search)} variant="primary" size="sm">
                    {t('savedSearch.open')}
                  </ButtonLink>
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-pressed={search.alertsEnabled}
                    isLoading={toggle.isPending && toggle.variables.id === search.id}
                    onClick={() => {
                      toggle.mutate(search);
                    }}
                  >
                    <BellIcon aria-hidden="true" className="h-4 w-4" />
                    {search.alertsEnabled ? t('savedSearch.turnAlertsOff') : t('savedSearch.turnAlertsOn')}
                    <span className="sr-only"> {search.name}</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    isLoading={remove.isPending && remove.variables === search.id}
                    onClick={() => {
                      remove.mutate(search.id);
                    }}
                  >
                    <TrashIcon aria-hidden="true" className="h-4 w-4" />
                    {t('savedSearch.delete')}
                    <span className="sr-only"> {search.name}</span>
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

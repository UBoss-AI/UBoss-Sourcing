/**
 * The seller's ranked to-do list (ENH-018), above the count tiles: overdue
 * first, then by deadline, then by what is at stake. The order is the
 * server's; this only shows it.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Card, ErrorState, LoadingState } from '@/components/ui';
import { Countdown } from '@/components/Countdown';
import { useI18n } from '@/i18n/i18n-context';
import { api } from '@/lib/api';
import { formatMinor } from '@/lib/seller';

interface ActionTask {
  kind: 'DISPUTE_RESPONSE' | 'DISPATCH' | 'QUOTE';
  id: string;
  reference: string;
  dueAt: string;
  overdue: boolean;
  amountMinor: string | null;
  currency: string | null;
  href: string;
}

const SHOWN = 10;

export function SellerActionQueue(): React.JSX.Element {
  const { t, intlLocale } = useI18n();
  const query = useQuery({
    queryKey: ['seller', 'action-queue'],
    queryFn: () => api.get<{ tasks: ActionTask[] }>('/seller/action-queue'),
    staleTime: 30_000,
  });
  return (
    <Card bodyClassName="p-4">
      <h2 className="text-base font-semibold">{t('sellerActions.title')}</h2>
      <p className="text-sm text-ink-muted">{t('sellerActions.blurb')}</p>
      {query.isPending ? <LoadingState /> : query.isError ? (
        <ErrorState error={query.error} onRetry={() => { void query.refetch(); }} />
      ) : query.data.tasks.length === 0 ? (
        <p role="status" className="mt-2 text-sm">{t('sellerActions.empty')}</p>
      ) : (
        <ol className="mt-2 divide-y divide-border-subtle">
          {query.data.tasks.slice(0, SHOWN).map((task) => (
            <li key={`${task.kind}-${task.id}`} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <Link to={task.href} className="font-medium text-brand hover:underline">
                {t(`sellerActions.kind.${task.kind}`, { reference: task.reference })}
              </Link>
              <span className="flex flex-wrap items-center gap-2">
                {task.amountMinor === null || task.currency === null ? null : <span className="text-ink-muted">{formatMinor(task.amountMinor, task.currency, intlLocale)}</span>}
                <Countdown deadline={task.dueAt} />
              </span>
            </li>
          ))}
        </ol>
      )}
      {query.data !== undefined && query.data.tasks.length > SHOWN ? (
        <p className="mt-2 text-xs text-ink-muted">{t('sellerActions.more', { more: (query.data.tasks.length - SHOWN).toLocaleString(intlLocale) })}</p>
      ) : null}
    </Card>
  );
}

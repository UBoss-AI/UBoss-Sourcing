/**
 * Sourcing on the buyer dashboard (checklist Master row 15).
 *
 * Its own request, its own loading and its own error: if the sourcing figures
 * cannot be fetched, this card says so and offers a retry, and the order ring
 * and insights beside it are untouched. A block the server could not measure
 * shows a dash, never a zero - "none" and "unknown" are different answers.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ConsoleCard } from '@/components/dashboard/console';
import { Button } from '@/components/ui';
import { formatRelative } from '@/lib/format';
import { fetchRfqSummary, nextActionHref, type RfqDashboardSummary } from '@/lib/rfq';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';

const REFRESH_MS = 120_000;

interface Tile {
  key: string;
  label: TranslationKey;
  value: number | null;
  hint: string | null;
  to: string;
}

function tiles(data: RfqDashboardSummary | undefined, waiting: (count: number) => string): Tile[] {
  const r = data?.requests ?? null;
  const q = data?.quotes ?? null;
  const n = data?.negotiations ?? null;
  const s = data?.samples ?? null;
  return [
    { key: 'open', label: 'rfqDashboard.open', value: r?.open ?? null, hint: null, to: '/account/rfqs?status=OPEN' },
    { key: 'draft', label: 'rfqDashboard.drafts', value: r?.draft ?? null, hint: null, to: '/account/rfqs?status=DRAFT' },
    {
      key: 'quotes',
      label: 'rfqDashboard.quotes',
      value: q?.open ?? null,
      hint: q === null || q.awaitingYou === 0 ? null : waiting(q.awaitingYou),
      to: '/account/rfqs?status=OPEN',
    },
    {
      key: 'negotiations',
      label: 'rfqDashboard.negotiations',
      value: n?.active ?? null,
      hint: n === null || n.awaitingYou === 0 ? null : waiting(n.awaitingYou),
      to: '/account/rfqs?status=OPEN',
    },
    {
      key: 'samples',
      label: 'rfqDashboard.samples',
      value: s?.inProgress ?? null,
      hint: s === null || s.awaitingYou === 0 ? null : waiting(s.awaitingYou),
      to: '/account/rfqs',
    },
    { key: 'awarded', label: 'rfqDashboard.awarded', value: r?.awarded ?? null, hint: null, to: '/account/rfqs?status=AWARDED' },
  ];
}

export function SourcingSummaryCard(): React.JSX.Element {
  const { t } = useI18n();
  const query = useQuery({
    queryKey: ['rfqs', 'summary'],
    queryFn: fetchRfqSummary,
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: false,
  });
  const data = query.data;

  if (query.isError && data === undefined) {
    return (
      <ConsoleCard title={t('rfqDashboard.title')} bodyClassName="px-5 py-4">
        <p role="alert" className="text-sm text-ink-muted">
          {t('rfqDashboard.failed')}
        </p>
        <Button
          variant="secondary"
          size="sm"
          className="mt-3"
          onClick={() => {
            void query.refetch();
          }}
        >
          {t('common.retry')}
        </Button>
      </ConsoleCard>
    );
  }

  const actions = data?.nextActions ?? null;
  return (
    <ConsoleCard
      title={t('rfqDashboard.title')}
      description={t('rfqDashboard.description')}
      actions={
        <Link to="/account/rfqs/new" className="text-sm font-medium text-primary hover:underline">
          {t('rfqDashboard.newRequest')}
        </Link>
      }
      bodyClassName="px-5 py-4"
    >
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {tiles(data, (count) => t('rfqDashboard.waitingOnYou', { waiting: String(count) })).map((tile) => (
          <li key={tile.key}>
            <Link
              to={tile.to}
              className="block rounded-lg border border-console-border/70 px-3 py-2 hover:border-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
            >
              <span className="block text-xs text-ink-muted">{t(tile.label)}</span>
              <span className="block text-title-sm tabular-nums text-ink" data-testid={`rfq-tile-${tile.key}`}>
                {query.isLoading ? '…' : tile.value === null ? '–' : String(tile.value)}
              </span>
              {tile.hint === null ? null : <span className="block text-xs text-warning">{tile.hint}</span>}
            </Link>
          </li>
        ))}
      </ul>

      {data !== undefined && data.unavailable.length > 0 && (
        <p className="mt-3 text-xs text-ink-muted">{t('rfqDashboard.partial')}</p>
      )}

      <h4 className="mt-4 text-sm font-medium text-ink">{t('rfqDashboard.nextActions')}</h4>
      {query.isLoading ? (
        <p className="mt-1 text-sm text-ink-muted">{t('common.loading')}</p>
      ) : actions === null ? (
        <p className="mt-1 text-sm text-ink-muted">{t('rfqDashboard.nextActionsUnavailable')}</p>
      ) : actions.length === 0 ? (
        <p className="mt-1 text-sm text-ink-muted">{t('rfqDashboard.nothingWaiting')}</p>
      ) : (
        <ul className="mt-1 divide-y divide-console-border/60">
          {actions.map((action) => (
            <li key={`${action.kind}-${action.rfqId}-${action.quoteId ?? action.sampleReference ?? ''}`} className="py-2">
              <Link to={nextActionHref(action)} className="flex flex-wrap items-baseline justify-between gap-2 hover:underline">
                <span className="text-sm text-ink">
                  {t(`rfqDashboard.action.${action.kind}` as TranslationKey, {
                    reference: action.sampleReference ?? action.rfqReference,
                  })}
                  <span className="text-ink-muted"> · {action.rfqTitle}</span>
                </span>
                <span className="text-xs text-ink-muted">{formatRelative(action.at)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </ConsoleCard>
  );
}

/**
 * Your own record of what happened.
 *
 * Not a filtered view of the operator's audit log — a separate one, which is
 * why an operator action appears here as a ROLE ("Marketplace moderation")
 * rather than as a staff member's name. A seller is entitled to know that a
 * decision was made and what it was; they are not entitled to know which person
 * at the marketplace made it, and a log that named them would make that
 * impossible to take back.
 *
 * The before/after diffs the operator's log keeps are deliberately not sent
 * here. The seller reads the summary; the diffs are for support, and shipping
 * them to a browser by default is how a redaction bug becomes a disclosure.
 */
import { useQuery } from '@tanstack/react-query';
import { useI18n } from '@/i18n/i18n-context';
import {
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/ui';
import { fetchSellerAudit, type SellerAuditRow } from '@/lib/seller';

export function SellerActivityPage(): React.JSX.Element {
  const { t } = useI18n();

  const query = useQuery({
    queryKey: ['seller', 'audit'],
    queryFn: () => fetchSellerAudit(200),
  });

  const entries = query.data?.entries ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('seller.activity.title')}
        description={t('seller.activity.intro')}
      />

      {query.isPending && <LoadingState label={t('seller.activity.loading')} />}

      {query.isError && (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      )}

      {query.isSuccess && entries.length === 0 && (
        <EmptyState
          title={t('seller.activity.emptyTitle')}
          description={t('seller.activity.emptyBody')}
        />
      )}

      {entries.length > 0 && (
        <Card title={t('seller.activity.card')}>
          <ol className="divide-y divide-border-subtle">
            {entries.map((entry) => (
              <ActivityRow key={entry.id} entry={entry} />
            ))}
          </ol>
        </Card>
      )}
    </div>
  );
}

function ActivityRow({ entry }: { entry: SellerAuditRow }): React.JSX.Element {
  return (
    <li className="px-6 py-3.5">
      {/*
        No wrapping between the two. A long summary is allowed to wrap inside
        its own column; letting the whole row wrap drops the timestamp under the
        text on the left, where it reads as part of the sentence.
      */}
      <div className="flex items-baseline justify-between gap-4">
        <p className="min-w-0 flex-1 text-sm text-ink">{entry.summary}</p>
        <time
          dateTime={entry.createdAt}
          className="shrink-0 text-xxs tabular-nums text-ink-subtle"
        >
          {new Date(entry.createdAt).toLocaleString()}
        </time>
      </div>

      <p className="mt-0.5 text-xxs text-ink-subtle">
        {entry.actorLabel} · {entry.resourceType.replace(/_/g, ' ')}
      </p>
    </li>
  );
}

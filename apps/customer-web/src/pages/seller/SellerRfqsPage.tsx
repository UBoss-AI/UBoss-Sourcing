/**
 * Seller Hub -> Requests for quotation: the requests this seller was asked to
 * quote on, and nothing else. The default view is the one that needs an
 * answer before its deadline.
 */
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InvitationStatusBadge, RfqStatusBadge } from '@/components/rfq/RfqParts';
import { Badge, Button, EmptyState, ErrorState, LoadingState, PageHeader, Select } from '@/components/ui';
import { useToast } from '@/components/toast-context';
import { errorMessage } from '@/lib/errors';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';
import { formatNumber } from '@/lib/format';
import { countryName } from '@/lib/iso-countries';
import { formatUtc, useQuantityLabel } from '@/lib/rfq-format';
import {
  SELLER_RFQ_FILTERS,
  fetchRfqAssignees,
  fetchSellerRfqs,
  setSellerRfqHidden,
  type SellerRfqFilter,
} from '@/lib/rfq-seller';
import { ApprovalRequiredNotice, type SellerOutletContext } from './SellerLayout';

/** Green from 80, amber from 40: the score is points, so the bands are its own. */
function scoreTone(score: number): 'success' | 'warning' | 'neutral' {
  if (score >= 80) return 'success';
  if (score >= 40) return 'warning';
  return 'neutral';
}

export function SellerRfqsPage(): React.JSX.Element {
  const seller = useOutletContext<SellerOutletContext>();
  const { t, intlLocale, language } = useI18n();
  const quantityLabel = useQuantityLabel();
  const [params, setParams] = useSearchParams();
  const raw = params.get('filter');
  const filter: SellerRfqFilter = (SELLER_RFQ_FILTERS as readonly string[]).includes(raw ?? '')
    ? (raw as SellerRfqFilter)
    : 'action';

  const assigneeParam = params.get('assignee');
  const assignee = assigneeParam === null || assigneeParam === '' ? undefined : assigneeParam;
  const client = useQueryClient();
  const toast = useToast();

  const query = useQuery({
    queryKey: ['seller', 'rfqs', filter, assignee ?? ''],
    queryFn: () => fetchSellerRfqs(filter, assignee),
    enabled: seller.isTrading,
    refetchInterval: 60_000,
  });
  const assignees = useQuery({
    queryKey: ['seller', 'rfqs', 'assignees'],
    queryFn: fetchRfqAssignees,
    enabled: seller.isTrading,
  });
  const hide = useMutation({
    mutationFn: (input: { id: string; hidden: boolean }) => setSellerRfqHidden(input.id, input.hidden),
    onSuccess: async (_rfq, input) => {
      await client.invalidateQueries({ queryKey: ['seller', 'rfqs'] });
      toast.success(input.hidden ? t('sellerRfq.inbox.hiddenDone') : t('sellerRfq.inbox.unhiddenDone'));
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('sellerRfq.inbox.failed')));
    },
  });

  if (!seller.isTrading) return <ApprovalRequiredNotice seller={seller} />;

  return (
    <>
      <PageHeader title={t('sellerRfq.title')} description={t('sellerRfq.description')} />
      <div className="mb-3 max-w-xs">
        <label className="block text-xs font-medium text-ink-muted">
          {t('sellerRfq.inbox.assigneeFilter')}
          <Select
            className="mt-1"
            value={assignee ?? ''}
            onChange={(event) => {
              const next = new URLSearchParams(params);
              if (event.currentTarget.value === '') next.delete('assignee');
              else next.set('assignee', event.currentTarget.value);
              setParams(next, { replace: true });
            }}
          >
            <option value="">{t('sellerRfq.inbox.assigneeAll')}</option>
            <option value="me">{t('sellerRfq.inbox.assigneeMe')}</option>
            <option value="unassigned">{t('sellerRfq.inbox.assigneeNone')}</option>
            {(assignees.data ?? []).map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </Select>
        </label>
      </div>
      <div role="group" aria-label={t('sellerRfq.filters')} className="mb-4 flex flex-wrap gap-2">
        {SELLER_RFQ_FILTERS.map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={filter === key}
            onClick={() => {
              const next = new URLSearchParams(params);
              next.set('filter', key);
              setParams(next, { replace: true });
            }}
            className={cx(
              'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors',
              filter === key ? 'border-brand bg-brand/10 font-semibold text-brand' : 'border-border bg-surface text-ink hover:border-border-hover',
            )}
          >
            {t(`sellerRfq.filter.${key}` as TranslationKey)}
            {(query.data?.counts[key] ?? 0) > 0 && (
              <span className="rounded-full bg-surface-sunken px-1.5 text-xxs tabular-nums text-ink-muted">
                {formatNumber(query.data?.counts[key] ?? 0)}
              </span>
            )}
          </button>
        ))}
      </div>

      {query.isPending ? (
        <LoadingState label={t('sellerRfq.loading')} />
      ) : query.isError ? (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : query.data.items.length === 0 ? (
        <EmptyState title={t('sellerRfq.emptyTitle')} description={t('sellerRfq.emptyBody')} />
      ) : (
        <ul className="space-y-3">
          {query.data.items.map((item) => (
            <li key={item.id}>
              <Link
                to={`/seller/rfqs/${item.id}`}
                className="block rounded-lg border border-border bg-surface p-4 shadow-card hover:border-border-hover"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-title-xs text-ink">{item.title}</p>
                    <p className="text-xs text-ink-muted">
                      {item.reference}
                      {item.categoryName !== null && ` · ${item.categoryName}`}
                      {` · ${t('rfq.detail.versionN', { version: String(item.currentRequirementVersion) })}`}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <RfqStatusBadge status={item.status} />
                    <InvitationStatusBadge status={item.invitationStatus} />
                  </div>
                </div>
                <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-2 border-t border-border-subtle pt-3 text-sm">
                  <div>
                    <dt className="text-xxs uppercase tracking-wider text-ink-subtle">{t('rfq.field.quantity')}</dt>
                    <dd className="text-ink">{quantityLabel(item.quantity, item.unitOfMeasure)}</dd>
                  </div>
                  <div>
                    <dt className="text-xxs uppercase tracking-wider text-ink-subtle">{t('rfq.field.destination')}</dt>
                    <dd className="text-ink">{item.destinationCountry === null ? t('rfq.notProvided') : countryName(item.destinationCountry, language)}</dd>
                  </div>
                  <div>
                    <dt className="text-xxs uppercase tracking-wider text-ink-subtle">{t('rfq.field.deadline')}</dt>
                    <dd className={item.isPastDeadline ? 'text-warning' : 'text-ink'}>{formatUtc(item.responseDeadline, intlLocale)}</dd>
                  </div>
                  <div>
                    <dt className="text-xxs uppercase tracking-wider text-ink-subtle">{t('sellerRfq.inbox.fit')}</dt>
                    <dd className="text-ink">
                      <Badge tone={scoreTone(item.qualification.score)}>
                        {t('sellerRfq.inbox.score', { score: String(item.qualification.score) })}
                      </Badge>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xxs uppercase tracking-wider text-ink-subtle">{t('sellerRfq.inbox.buyer')}</dt>
                    <dd>
                      <Badge tone={item.buyerVerification === 'VERIFIED_BUSINESS' ? 'success' : item.buyerVerification === 'BUSINESS_NOT_VERIFIED' ? 'danger' : 'neutral'}>
                        {t(`sellerRfq.buyerVerification.${item.buyerVerification}` as TranslationKey)}
                      </Badge>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xxs uppercase tracking-wider text-ink-subtle">{t('sellerRfq.inbox.owner')}</dt>
                    <dd className="text-ink">{item.assignedMember?.name ?? t('sellerRfq.inbox.noOwner')}</dd>
                  </div>
                </dl>
                {item.qualification.flags.length > 0 && (
                  <p className="mt-2 text-xs text-ink-muted">
                    {item.qualification.flags.map((flag) => t(`sellerRfq.flag.${flag}` as TranslationKey)).join(' · ')}
                  </p>
                )}
              </Link>
              <div className="mt-1 flex justify-end">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={hide.isPending}
                  onClick={() => {
                    hide.mutate({ id: item.id, hidden: !item.hidden });
                  }}
                >
                  {item.hidden ? t('sellerRfq.inbox.unhide') : t('sellerRfq.inbox.hide')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * Your requests for quotation, with a filter per status and the count in each.
 *
 * The status filter lives in the address (`?status=OPEN`), so a filtered list
 * survives a reload and can be bookmarked.
 */
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useStorefront } from '@/app/storefront-context';
import { PageEmptyState } from '@/components/PageEmptyState';
import { ChevronRightIcon, PlusIcon } from '@/components/icons';
import { RfqStatusBadge, formatUtc, useQuantityLabel } from '@/components/rfq/RfqParts';
import { ButtonLink, ErrorState, LoadingState, PageHeader } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';
import { formatNumber } from '@/lib/format';
import { countryName } from '@/lib/iso-countries';
import { RFQ_STATUSES, fetchMyRfqs, type RfqStatus } from '@/lib/rfq';
import { useDocumentMeta } from '@/lib/useDocumentMeta';

export function RfqListPage(): React.JSX.Element {
  const { t, intlLocale, language } = useI18n();
  const { business } = useStorefront();
  const quantityLabel = useQuantityLabel();
  const [params, setParams] = useSearchParams();
  useDocumentMeta({ title: t('rfq.list.title'), noIndex: true }, business.displayName);

  const raw = params.get('status');
  const status: RfqStatus | null = (RFQ_STATUSES as readonly string[]).includes(raw ?? '') ? (raw as RfqStatus) : null;

  const query = useQuery({ queryKey: ['rfqs', status ?? 'all'], queryFn: () => fetchMyRfqs(status) });

  const newButton = (
    <ButtonLink to="/account/rfqs/new" variant="primary">
      <PlusIcon className="h-4 w-4" />
      {t('rfq.list.new')}
    </ButtonLink>
  );

  return (
    <>
      <PageHeader title={t('rfq.list.title')} description={t('rfq.list.description')} actions={newButton} />

      <div role="group" aria-label={t('rfq.list.filters')} className="mb-4 flex flex-wrap gap-2">
        {[null, ...RFQ_STATUSES].map((key) => {
          const selected = status === key;
          const count = key === null ? null : (query.data?.counts[key] ?? null);
          return (
            <button
              key={key ?? 'all'}
              type="button"
              aria-pressed={selected}
              onClick={() => {
                const next = new URLSearchParams(params);
                if (key === null) next.delete('status');
                else next.set('status', key);
                setParams(next, { replace: true });
              }}
              className={cx(
                'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors',
                selected
                  ? 'border-brand bg-brand/10 font-semibold text-brand'
                  : 'border-border bg-surface text-ink hover:border-border-hover',
              )}
            >
              {key === null ? t('rfq.list.all') : t(`rfq.status.${key}` as TranslationKey)}
              {count !== null && count > 0 && (
                <span className="rounded-full bg-surface-sunken px-1.5 text-xxs tabular-nums text-ink-muted">
                  {formatNumber(count)}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {query.isPending ? (
        <LoadingState label={t('rfq.list.loading')} />
      ) : query.isError ? (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : query.data.items.length === 0 ? (
        <PageEmptyState
          title={status === null ? t('rfq.list.emptyTitle') : t('rfq.list.emptyFiltered')}
          description={t('rfq.list.emptyBody')}
          action={newButton}
        />
      ) : (
        <ul className="space-y-3">
          {query.data.items.map((item) => (
            <li key={item.id}>
              <Link
                to={item.status === 'DRAFT' ? `/account/rfqs/${item.id}/edit` : `/account/rfqs/${item.id}`}
                className="group block rounded-lg border border-border bg-surface p-4 shadow-card transition-[box-shadow,border-color] hover:border-border-hover hover:shadow-card-hover"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-title-xs text-ink">
                      <span className="truncate">{item.title.length > 0 ? item.title : t('rfq.untitled')}</span>
                      <ChevronRightIcon className="h-4 w-4 shrink-0 text-ink-subtle transition-transform group-hover:translate-x-0.5" />
                    </p>
                    <p className="mt-0.5 text-xs text-ink-muted">
                      {item.reference}
                      {item.categoryName !== null && ` · ${item.categoryName}`}
                    </p>
                  </div>
                  <RfqStatusBadge status={item.status} />
                </div>
                <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-2 border-t border-border-subtle pt-3 text-sm">
                  <div>
                    <dt className="text-xxs uppercase tracking-wider text-ink-subtle">{t('rfq.field.quantity')}</dt>
                    <dd className="mt-0.5 text-ink tabular-nums">{quantityLabel(item.quantity, item.unitOfMeasure)}</dd>
                  </div>
                  <div>
                    <dt className="text-xxs uppercase tracking-wider text-ink-subtle">{t('rfq.field.destination')}</dt>
                    <dd className="mt-0.5 text-ink">
                      {item.destinationCountry === null ? t('rfq.notProvided') : countryName(item.destinationCountry, language)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xxs uppercase tracking-wider text-ink-subtle">{t('rfq.field.deadline')}</dt>
                    <dd className={cx('mt-0.5', item.isPastDeadline && item.status === 'OPEN' ? 'text-warning' : 'text-ink')}>
                      {formatUtc(item.responseDeadline, intlLocale)}
                    </dd>
                  </div>
                  {item.status !== 'DRAFT' && (
                    <div>
                      <dt className="text-xxs uppercase tracking-wider text-ink-subtle">{t('rfq.list.responses')}</dt>
                      <dd className="mt-0.5 text-ink tabular-nums">
                        {t('rfq.list.respondedOf', {
                          responded: formatNumber(item.respondedCount),
                          invited: formatNumber(item.invitedCount),
                        })}
                      </dd>
                    </div>
                  )}
                </dl>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

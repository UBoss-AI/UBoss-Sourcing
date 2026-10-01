/**
 * Seller performance: how this seller converts, delivers and holds up on
 * quality over the last 30, 90 or 365 days.
 *
 * Every rate is shown with the counts it was worked out from ("3 of 4"),
 * and a rate over nothing is a dash, never 0% - a seller who delivered nothing
 * has not delivered late. Each tile says in one line what it counts, so a
 * figure can be acted on without guessing its definition.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Card, ErrorState, LoadingState, PageHeader } from '@/components/ui';
import { cx } from '@/lib/cx';
import { useI18n } from '@/i18n/i18n-context';
import {
  PERFORMANCE_WINDOWS,
  fetchPerformance,
  percentOf,
  type Ratio,
  type SellerPerformance,
} from '@/lib/seller-performance';

type Tone = 'good' | 'bad' | 'neutral';

/** One rate, with its counts and its definition. */
function RateTile({
  label,
  ratio,
  definition,
  higherIsBetter = true,
}: {
  label: string;
  ratio: Ratio;
  definition: string;
  higherIsBetter?: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const percent = percentOf(ratio);
  const tone: Tone =
    percent === null ? 'neutral' : (higherIsBetter ? percent >= 90 : percent <= 5) ? 'good' : 'bad';

  return (
    <div className="rounded-lg border border-border bg-surface px-5 py-4 shadow-card">
      <p className="text-xxs font-medium uppercase tracking-wider text-ink-subtle">{label}</p>
      <p
        className={cx(
          'tabular mt-2 text-title-lg font-semibold',
          tone === 'good' ? 'text-success' : tone === 'bad' ? 'text-warning' : 'text-ink-subtle',
        )}
      >
        {percent === null ? '—' : `${String(percent)}%`}
      </p>
      <p className="tabular mt-1 text-xxs text-ink-muted">
        {percent === null
          ? t('seller.performance.nothingToMeasure')
          : t('seller.performance.outOf', {
              part: String(ratio.numerator),
              whole: String(ratio.denominator),
            })}
      </p>
      <p className="mt-2 text-xxs leading-relaxed text-ink-subtle">{definition}</p>
    </div>
  );
}

/** One count, with what it counts. */
function CountTile({
  label,
  value,
  definition,
  to,
}: {
  label: string;
  value: number;
  definition: string;
  to?: string;
}): React.JSX.Element {
  const body = (
    <>
      <p className="text-xxs font-medium uppercase tracking-wider text-ink-subtle">{label}</p>
      <p className="tabular mt-2 text-title-lg font-semibold text-ink">{value}</p>
      <p className="mt-2 text-xxs leading-relaxed text-ink-subtle">{definition}</p>
    </>
  );
  const shell = 'block rounded-lg border border-border bg-surface px-5 py-4 shadow-card';
  return to === undefined ? (
    <div className={shell}>{body}</div>
  ) : (
    <Link to={to} className={cx(shell, 'hover:border-border-hover hover:bg-surface-hover')}>
      {body}
    </Link>
  );
}

export function SellerPerformancePage(): React.JSX.Element {
  const { t } = useI18n();
  const [days, setDays] = useState<number>(90);

  const query = useQuery({
    queryKey: ['seller', 'performance', days],
    queryFn: () => fetchPerformance(days),
    staleTime: 60_000,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('seller.performance.title')}
        description={t('seller.performance.intro')}
        actions={
          <div
            role="group"
            aria-label={t('seller.performance.window')}
            className="inline-flex rounded-md border border-border-strong bg-surface p-0.5"
          >
            {PERFORMANCE_WINDOWS.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={days === value}
                onClick={() => {
                  setDays(value);
                }}
                className={cx(
                  'rounded px-3 py-1.5 text-xs font-medium transition-colors',
                  days === value ? 'bg-brand-soft text-brand' : 'text-ink-muted hover:text-ink',
                )}
              >
                {t('seller.performance.lastDays', { days: String(value) })}
              </button>
            ))}
          </div>
        }
      />

      {query.isPending && <LoadingState label={t('seller.performance.loading')} />}
      {query.isError && (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      )}
      {query.data !== undefined && <PerformanceBody data={query.data} />}
    </div>
  );
}

function PerformanceBody({ data }: { data: SellerPerformance }): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div className="space-y-6">
      <Card title={t('seller.performance.conversion')} description={t('seller.performance.conversionIntro')}>
        <div className="grid gap-4 px-6 py-5 sm:grid-cols-2 xl:grid-cols-4">
          <CountTile
            label={t('seller.performance.rfqInvited')}
            value={data.rfq.invited}
            definition={t('seller.performance.rfqInvitedDef')}
            to="/seller/rfqs"
          />
          <RateTile
            label={t('seller.performance.quoteRate')}
            ratio={data.rfq.quoteRate}
            definition={t('seller.performance.quoteRateDef')}
          />
          <RateTile
            label={t('seller.performance.rfqConversion')}
            ratio={data.rfq.conversion}
            definition={t('seller.performance.rfqConversionDef')}
          />
          <RateTile
            label={t('seller.performance.fulfilmentRate')}
            ratio={data.orders.fulfilmentRate}
            definition={t('seller.performance.fulfilmentRateDef')}
          />
        </div>
      </Card>

      <Card title={t('seller.performance.delivery')} description={t('seller.performance.deliveryIntro')}>
        <div className="grid gap-4 px-6 py-5 sm:grid-cols-2 xl:grid-cols-4">
          <RateTile label={t('seller.performance.otif')} ratio={data.delivery.otif} definition={t('seller.performance.otifDef')} />
          <RateTile label={t('seller.performance.onTime')} ratio={data.delivery.onTime} definition={t('seller.performance.onTimeDef')} />
          <RateTile label={t('seller.performance.inFull')} ratio={data.delivery.inFull} definition={t('seller.performance.inFullDef')} />
          <RateTile
            label={t('seller.performance.dispatchOnTime')}
            ratio={data.delivery.dispatchOnTime}
            definition={t('seller.performance.dispatchOnTimeDef')}
          />
        </div>
        {data.delivery.withoutPromisedDate > 0 && (
          <p className="px-6 pb-5 text-xxs text-ink-muted">
            {t('seller.performance.withoutPromise', { orders: String(data.delivery.withoutPromisedDate) })}
          </p>
        )}
      </Card>

      <Card title={t('seller.performance.quality')} description={t('seller.performance.qualityIntro')}>
        <div className="grid gap-4 px-6 py-5 sm:grid-cols-2 xl:grid-cols-4">
          <RateTile
            label={t('seller.performance.returnRate')}
            ratio={data.quality.returnRate}
            definition={t('seller.performance.returnRateDef')}
            higherIsBetter={false}
          />
          <RateTile
            label={t('seller.performance.inspectionFailRate')}
            ratio={data.quality.inspectionFailRate}
            definition={t('seller.performance.inspectionFailRateDef')}
            higherIsBetter={false}
          />
          <CountTile
            label={t('seller.performance.openNcrs')}
            value={data.quality.openNcrs}
            definition={t('seller.performance.openNcrsDef')}
            to="/seller/orders"
          />
          <RateTile
            label={t('seller.performance.cancellationRate')}
            ratio={data.orders.cancellationRate}
            definition={t('seller.performance.cancellationRateDef')}
            higherIsBetter={false}
          />
        </div>
      </Card>

      <Card title={t('seller.performance.claims')} description={t('seller.performance.claimsIntro')}>
        <div className="grid gap-4 px-6 py-5 sm:grid-cols-2 xl:grid-cols-4">
          <CountTile label={t('seller.performance.claimsOpened')} value={data.claims.opened} definition={t('seller.performance.claimsOpenedDef')} />
          <CountTile label={t('seller.performance.claimsOpen')} value={data.claims.open} definition={t('seller.performance.claimsOpenDef')} />
          <RateTile
            label={t('seller.performance.claimRate')}
            ratio={data.claims.claimRate}
            definition={t('seller.performance.claimRateDef')}
            higherIsBetter={false}
          />
          <CountTile label={t('seller.performance.chargebacks')} value={data.claims.chargebacks} definition={t('seller.performance.chargebacksDef')} />
        </div>
      </Card>
    </div>
  );
}

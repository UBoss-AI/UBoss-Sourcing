/**
 * What a seller would be paid for a sale, read-only.
 *
 *   Gross seller proceeds
 * + Seller-controlled delivery proceeds
 * - Platform fee
 * - Tax on platform fee
 * - Refunds and adjustments
 * = Estimated seller settlement
 *
 * Worked out by the server on the policies in force now, with the same
 * calculation a real order uses. The seller can change the two amounts they
 * are asking about and nothing else: the fee, its basis, the tax rate and its
 * wording are UBOSS finance's, and no control here reaches them.
 *
 * The tax line says "configured 15%" rather than "GST 15%" until somebody with
 * finance authority has verified the rule - the server decides the wording.
 */
import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Card, ErrorState, Field, Input, LoadingState, Select } from '@/components/ui';
import { useLocale } from '@/app/locale-context';
import { useI18n } from '@/i18n/i18n-context';
import { currencyExponent, formatMoney, majorToMinor } from '@/lib/format';
import { fetchOffers } from '@/lib/seller';
import { fetchSettlementEstimate } from '@/lib/seller-logistics';

/** Wait this long after the last keystroke before asking for a new estimate. */
const ESTIMATE_DELAY_MS = 350;

function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSettled(value);
    }, delay);
    return () => {
      window.clearTimeout(timer);
    };
  }, [value, delay]);
  return settled;
}

export function SettlementPreviewCard({ currency }: { currency: string }): React.JSX.Element {
  const { t } = useI18n();
  const [goods, setGoods] = useState('10000');
  const [delivery, setDelivery] = useState('0');

  /*
   * The buyer's market and the listing, because a real order's fee policy is
   * chosen by both: a market or category policy applies only when the
   * preview says which market and which category it is about. The market
   * starts at the seller's own, the likeliest buyer; the listing list is the
   * seller's own, and is simply absent for a member who cannot read listings.
   */
  const { countries, country } = useLocale();
  const [market, setMarket] = useState(country ?? '');
  const [offerId, setOfferId] = useState('');
  const listings = useQuery({
    queryKey: ['seller', 'settlement-estimate', 'listings'],
    queryFn: () => fetchOffers(new URLSearchParams({ pageSize: '100' })),
    retry: false,
  });
  const listingRows = listings.data?.rows ?? [];

  const exponent = currencyExponent(currency);
  const goodsMinor = majorToMinor(goods, exponent);
  const deliveryMinor = majorToMinor(delivery === '' ? '0' : delivery, exponent);
  const valid = goodsMinor !== null && deliveryMinor !== null;

  // One request once typing pauses, not one per keystroke, and the previous
  // breakdown stays on screen while the next one loads. Swapping the table for
  // a spinner on every letter is what made the page jump as the seller typed.
  const settledGoods = useDebounced(goodsMinor, ESTIMATE_DELAY_MS);
  const settledDelivery = useDebounced(deliveryMinor, ESTIMATE_DELAY_MS);
  const settledValid = settledGoods !== null && settledDelivery !== null;

  const query = useQuery({
    queryKey: ['seller', 'settlement-estimate', settledGoods, settledDelivery, currency, market, offerId],
    queryFn: () =>
      fetchSettlementEstimate({
        goodsMinor: settledGoods ?? '0',
        sellerDeliveryMinor: settledDelivery ?? '0',
        currency,
        marketCountry: market,
        offerId,
      }),
    enabled: settledValid,
    placeholderData: keepPreviousData,
  });

  const estimate = query.data?.estimate;
  const stale = query.isPlaceholderData || settledGoods !== goodsMinor || settledDelivery !== deliveryMinor;

  return (
    <Card title={t('sellerLogistics.settlementTitle')} description={t('sellerLogistics.settlementBody')}>
      <div className="space-y-4 px-6 pb-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('sellerLogistics.settlementGoods', { currency })} error={goodsMinor === null ? t('sellerLogistics.priceInvalid') : undefined}>
            {({ inputId, describedBy }) => (
              <Input id={inputId} aria-describedby={describedBy} inputMode="decimal" value={goods} onChange={(event) => { setGoods(event.target.value); }} />
            )}
          </Field>
          <Field label={t('sellerLogistics.settlementDelivery', { currency })} error={deliveryMinor === null ? t('sellerLogistics.priceInvalid') : undefined}>
            {({ inputId, describedBy }) => (
              <Input id={inputId} aria-describedby={describedBy} inputMode="decimal" value={delivery} onChange={(event) => { setDelivery(event.target.value); }} />
            )}
          </Field>
          {countries.length > 0 && (
            <Field label={t('sellerLogistics.settlementMarket')}>
              {({ inputId, describedBy }) => (
                <Select id={inputId} aria-describedby={describedBy} value={market} onChange={(event) => { setMarket(event.target.value); }}>
                  <option value="">{t('sellerLogistics.settlementMarketAny')}</option>
                  {countries.map((entry) => (
                    <option key={entry.code} value={entry.code}>
                      {entry.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          {listingRows.length > 0 && (
            <Field label={t('sellerLogistics.settlementListing')}>
              {({ inputId, describedBy }) => (
                <Select id={inputId} aria-describedby={describedBy} value={offerId} onChange={(event) => { setOfferId(event.target.value); }}>
                  <option value="">{t('sellerLogistics.settlementListingAny')}</option>
                  {listingRows.map((row) => (
                    <option key={row.id} value={row.id}>
                      {`${row.productName} (${row.sellerSku})`}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
        </div>
        <p className="text-xs leading-relaxed text-ink-muted">{t('sellerLogistics.settlementScopeHint')}</p>

        {estimate === undefined && query.isPending && valid && <LoadingState label={t('sellerLogistics.loading')} />}
        {query.isError && (
          <ErrorState
            error={query.error}
            onRetry={() => {
              void query.refetch();
            }}
          />
        )}

        {estimate !== undefined && (
          <dl
            className={`divide-y divide-border-subtle rounded-md border border-border-subtle text-sm transition-opacity duration-200 ${stale ? 'opacity-60' : 'opacity-100'}`}
            aria-live="polite"
            aria-busy={stale}
          >
            <Row label={t('sellerLogistics.grossProceeds')} value={formatMoney(estimate.grossProceeds)} />
            <Row label={t('sellerLogistics.sellerDeliveryProceeds')} value={`+ ${formatMoney(estimate.sellerDeliveryProceeds)}`} />
            <Row
              label={
                estimate.policy === null
                  ? t('sellerLogistics.platformFee')
                  : t('sellerLogistics.platformFeeWithPolicy', { name: estimate.policy.name, version: String(estimate.policy.versionNumber) })
              }
              value={`− ${formatMoney(estimate.platformFee)}`}
            />
            <Row
              label={estimate.feeTaxVerified ? estimate.feeTaxLabel : t('sellerLogistics.feeTaxConfigured', { rate: estimate.feeTaxRatePercent })}
              value={`− ${formatMoney(estimate.platformFeeTax)}`}
            />
            <Row label={t('sellerLogistics.refundsAdjustments')} value={`− ${formatMoney(estimate.refundsAdjustments)}`} />
            <Row label={t('sellerLogistics.estimatedSettlement')} value={formatMoney(estimate.estimatedSettlement)} strong />
          </dl>
        )}

        <p className="text-xs leading-relaxed text-ink-muted">{t('sellerLogistics.settlementReadOnly')}</p>
      </div>
    </Card>
  );
}

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5">
      <dt className={strong ? 'font-semibold text-ink' : 'text-ink-muted'}>{label}</dt>
      <dd className={strong ? 'font-semibold text-ink' : 'text-ink'}>{value}</dd>
    </div>
  );
}

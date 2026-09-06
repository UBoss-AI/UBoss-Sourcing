/**
 * Per-currency prices for one product.
 *
 * Each figure is entered by a person for that market. Nothing here converts:
 * a rate would make the listed price drift from the amount actually charged,
 * and the whole pricing module exists to stop exactly that.
 *
 * A currency left blank is a market the product is not sold in. The storefront
 * omits it from that grid entirely rather than falling back to another
 * currency's number — which would offer a ¥5,000 item at $5,000.
 *
 * The base-currency row is the same figure as the Pricing card above; saving
 * here updates both, so they cannot disagree.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Callout, Card, Input, LoadingState } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { majorToMinor, minorToMajor } from '@/lib/format';
import { useI18n } from '@/i18n/i18n-context';

interface CurrencyRow {
  code: string;
  name: string;
  symbol: string;
  exponent: number;
  isBase: boolean;
}

interface PriceRow {
  currency: CurrencyRow;
  basePriceMinor: string | null;
  compareAtPriceMinor: string | null;
}

interface PricesResponse {
  product: { id: string; name: string; sku: string };
  baseCurrency: string;
  prices: PriceRow[];
}

interface DraftRow {
  price: string;
  compareAt: string;
}

export function CurrencyPricesPanel({
  productId,
  canWrite,
}: {
  productId: string;
  canWrite: boolean;
}): React.JSX.Element {
  const { t } = useI18n();

  const toast = useToast();
  const queryClient = useQueryClient();

  const [draft, setDraft] = useState<Record<string, DraftRow>>({});
  const [error, setError] = useState<string | null>(null);

  const prices = useQuery({
    queryKey: ['product-prices', productId],
    queryFn: () => api.get<PricesResponse>(`/admin/products/${productId}/prices`),
  });

  useEffect(() => {
    if (prices.data === undefined) return;

    setDraft(
      Object.fromEntries(
        prices.data.prices.map((row) => [
          row.currency.code,
          {
            price:
              row.basePriceMinor === null
                ? ''
                : minorToMajor(row.basePriceMinor, row.currency.exponent),
            compareAt:
              row.compareAtPriceMinor === null
                ? ''
                : minorToMajor(row.compareAtPriceMinor, row.currency.exponent),
          },
        ]),
      ),
    );
  }, [prices.data]);

  const save = useMutation({
    mutationFn: (body: unknown) =>
      api.put<{ updated: boolean }>(`/admin/products/${productId}/prices`, body),
    onSuccess: async () => {
      toast.success('Prices saved.');
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['product-prices', productId] });
      // The base-currency mirror on the product row moved too.
      await queryClient.invalidateQueries({ queryKey: ['product', productId] });
    },
    onError: (cause: unknown) => {
      setError(cause instanceof ApiError ? cause.message : 'Those prices could not be saved.');
    },
  });

  const submit = (): void => {
    setError(null);

    const rows = prices.data?.prices ?? [];
    const payload: {
      currencyCode: string;
      basePriceMinor: string;
      compareAtPriceMinor?: string;
    }[] = [];

    for (const row of rows) {
      const entry = draft[row.currency.code];
      const typed = entry?.price.trim() ?? '';
      if (typed === '') continue;

      const minor = majorToMinor(typed, row.currency.exponent);
      if (minor === null || minor === '0') {
        setError(`The ${row.currency.code} price is not a valid amount.`);
        return;
      }

      const compareTyped = entry?.compareAt.trim() ?? '';
      const compareMinor =
        compareTyped === '' ? null : majorToMinor(compareTyped, row.currency.exponent);

      if (compareTyped !== '' && compareMinor === null) {
        setError(`The ${row.currency.code} compare-at price is not a valid amount.`);
        return;
      }

      payload.push({
        currencyCode: row.currency.code,
        basePriceMinor: minor,
        ...(compareMinor === null ? {} : { compareAtPriceMinor: compareMinor }),
      });
    }

    if (payload.length === 0) {
      setError('Set a price in at least one currency, or the product cannot be sold anywhere.');
      return;
    }

    save.mutate({ prices: payload });
  };

  const rows = prices.data?.prices ?? [];
  const soldIn = rows.filter((row) => (draft[row.currency.code]?.price.trim() ?? '') !== '').length;

  return (
    <Card
      title={t('currencyPrices.pricesByCurrency')}
      description={t('currencyPrices.aRealPricePerMarket')}
      actions={
        canWrite ? (
          <Button
            size="sm"
            variant="primary"
            onClick={submit}
            isLoading={save.isPending}
            disabled={prices.isLoading}
          >
            {t('currencyPrices.savePrices')}
          </Button>
        ) : undefined
      }
    >
      <div className="px-5 py-4">
        {prices.isLoading ? (
          <LoadingState label={t('currencyPrices.loadingPrices')} />
        ) : (
          <>
            <div className="mb-3 flex items-center gap-2">
              <Badge dot tone={soldIn === 0 ? 'warning' : 'success'}>
                Sold in {soldIn} of {rows.length} currencies
              </Badge>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[32rem] text-sm">
                <caption className="sr-only">{t('currencyPrices.pricesByCurrency')}</caption>
                {/* The same header treatment as every other table in the
                    panel: a tinted band with a heavier rule under it, so this
                    one does not read as a different kind of thing. */}
                <thead className="bg-surface-sunken">
                  <tr className="border-b border-border-strong/40 text-left text-xxs font-semibold uppercase tracking-wider text-ink-muted">
                    <th scope="col" className="px-3 py-2.5">
                      {t('currencyPrices.currency')}
                    </th>
                    <th scope="col" className="px-3 py-2.5">
                      {t('currencyPrices.price')}
                    </th>
                    <th scope="col" className="px-3 py-2.5">
                      {t('currencyPrices.compareAt')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.currency.code}
                      className="border-b border-border-subtle last:border-0"
                    >
                      <th scope="row" className="px-3 py-2 text-left font-normal">
                        <span className="font-medium text-ink">{row.currency.code}</span>
                        <span className="ml-2 text-xs text-ink-muted">{row.currency.name}</span>
                        {row.currency.isBase && (
                          <span className="ml-2 text-xxs uppercase tracking-wide text-ink-subtle">
                            base
                          </span>
                        )}
                      </th>
                      <td className="px-3 py-2">
                        <Input
                          inputMode="decimal"
                          className="tabular"
                          placeholder={t('currencyPrices.notSold')}
                          disabled={!canWrite}
                          aria-label={`${row.currency.code} price`}
                          value={draft[row.currency.code]?.price ?? ''}
                          onChange={(event) => {
                            setDraft((current) => ({
                              ...current,
                              [row.currency.code]: {
                                price: event.target.value,
                                compareAt: current[row.currency.code]?.compareAt ?? '',
                              },
                            }));
                          }}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <Input
                          inputMode="decimal"
                          className="tabular"
                          placeholder="—"
                          disabled={!canWrite}
                          aria-label={`${row.currency.code} compare-at price`}
                          value={draft[row.currency.code]?.compareAt ?? ''}
                          onChange={(event) => {
                            setDraft((current) => ({
                              ...current,
                              [row.currency.code]: {
                                price: current[row.currency.code]?.price ?? '',
                                compareAt: event.target.value,
                              },
                            }));
                          }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {error !== null && (
              <Callout tone="danger" role="alert" className="mt-3">
                {error}
              </Callout>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

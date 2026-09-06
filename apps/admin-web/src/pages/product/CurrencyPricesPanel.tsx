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
 *
 * Beside each figure sits what a customer actually pays for it, for whichever
 * country is picked at the top. The two are not the same number and the gap is
 * the whole reason the picker is here: a euro row priced at 100 is 119 to a
 * German consumer, 121 to a Dutch one and 123 to an Irish one, because the
 * destination member state's VAT is what the storefront quotes. The preview
 * comes back from the same pricing engine the shop and the cart run on, so
 * what staff read here is what a shopper is charged - not a second opinion
 * computed in the browser, which would eventually disagree with both.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Callout, Card, Input, LoadingState, Select } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { formatMoney, majorToMinor, minorToMajor } from '@/lib/format';
import { useI18n } from '@/i18n/i18n-context';

interface CurrencyRow {
  code: string;
  name: string;
  symbol: string;
  exponent: number;
  isBase: boolean;
}

interface Money {
  minor: string;
  formatted: string;
  currency: string;
}

interface PriceRow {
  currency: CurrencyRow;
  basePriceMinor: string | null;
  compareAtPriceMinor: string | null;
  /** What a customer in the selected country is charged. Null where unpriced. */
  quoted: Money | null;
  quotedTax: { ratePercent: string; inclusive: boolean } | null;
}

interface PricesResponse {
  product: { id: string; name: string; sku: string };
  baseCurrency: string;
  country: string | null;
  countries: { code: string; name: string; currencyCode: string }[];
  /** Which rate applies where, and on what basis, in one sentence. */
  taxNote: string;
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

  /**
   * Which market the preview column is quoted for.
   *
   * Empty means "not stated", which the server reads the way it reads a
   * shopper who has not given a delivery address yet: the seller's own
   * country. That is the honest default - it is what the storefront shows
   * somebody who has not said where they are - rather than picking a member
   * state on staff's behalf and letting them read its rate as universal.
   */
  const [country, setCountry] = useState('');

  const prices = useQuery({
    // `country` is in the key because it changes the response: the same rows
    // come back with a different `quoted` figure against each.
    queryKey: ['product-prices', productId, country],
    queryFn: () =>
      api.get<PricesResponse>(`/admin/products/${productId}/prices`, {
        query: { country: country === '' ? undefined : country },
      }),
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

  const countries = prices.data?.countries ?? [];

  /**
   * Whether the preview column is worth showing at all.
   *
   * In a deployment with no EU VAT configured every quoted figure equals its
   * listed one, and a column repeating the number next to it is noise on a
   * screen that is already a grid of inputs. It appears when it has something
   * to say - which is exactly when a business has more than one market to say
   * it about.
   */
  const showsQuoted = rows.some(
    (row) => row.quoted !== null && row.quoted.minor !== row.basePriceMinor,
  );

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
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <Badge dot tone={soldIn === 0 ? 'warning' : 'success'}>
                Sold in {soldIn} of {rows.length} currencies
              </Badge>

              {countries.length > 0 && (
                <label className="flex items-center gap-2 text-xs text-ink-muted">
                  <span>Customer in</span>
                  <Select
                    className="h-8 w-48 text-xs"
                    value={country}
                    onChange={(event) => {
                      setCountry(event.target.value);
                    }}
                  >
                    <option value="">Nowhere stated yet</option>
                    {countries.map((entry) => (
                      <option key={entry.code} value={entry.code}>
                        {entry.name}
                      </option>
                    ))}
                  </Select>
                </label>
              )}
            </div>

            {showsQuoted && prices.data !== undefined && (
              <Callout tone="info" className="mb-3">
                {prices.data.taxNote}
              </Callout>
            )}

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
                    {showsQuoted && (
                      <th scope="col" className="px-3 py-2.5">
                        Customer pays
                      </th>
                    )}
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
                      {showsQuoted && (
                        // Read-only, and deliberately so: this is what the
                        // pricing engine makes of the figure to its left, not
                        // a second place to type one. Editing here would mean
                        // storing a price with VAT baked in at one country's
                        // rate, which is the exact confusion the per-currency
                        // list exists to avoid.
                        <td className="px-3 py-2 tabular text-ink">
                          {row.quoted === null ? (
                            <span className="text-ink-subtle">—</span>
                          ) : (
                            <>
                              <span className="font-medium">{formatMoney(row.quoted)}</span>
                              {row.quotedTax !== null && (
                                <span className="ml-2 text-xs text-ink-muted">
                                  {row.quotedTax.inclusive
                                    ? `incl. ${row.quotedTax.ratePercent}%`
                                    : `+ ${row.quotedTax.ratePercent}%`}
                                </span>
                              )}
                            </>
                          )}
                        </td>
                      )}
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

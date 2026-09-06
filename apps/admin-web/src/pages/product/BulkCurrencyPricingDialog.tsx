/**
 * Fill a currency's price list from another currency's, in one pass.
 *
 * The catalogue holds a real figure per currency and the storefront never
 * converts — so a market with no prices entered is a market that simply does
 * not exist to shoppers, however many currencies are switched on. Typing a
 * hundred products' worth of euro prices by hand is what stops people opening
 * a market at all, so this converts them once, at a rate staff choose, and
 * writes ordinary price rows. From then on they are as real as hand-typed
 * ones: they do not move when the rate moves, and any of them can be edited
 * on its own product afterwards.
 *
 * Nothing is written until the preview has been seen. The preview and the
 * write are the same backend call with one flag flipped, so what is shown is
 * exactly what will happen — a rate typed with a misplaced decimal point
 * misprices the whole catalogue, and that mistake has to be visible before it
 * is committed rather than discovered by a customer.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Callout, Field, Input, Select } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { minorToMajor } from '@/lib/format';
import { useI18n } from '@/i18n/i18n-context';

interface CurrencyRow {
  code: string;
  name: string;
  symbol: string;
  exponent: number;
  isBase: boolean;
  hasProducts: boolean;
  /** Today rate against the base currency, when the feed could be read. */
  rate: string | null;
}

interface CurrenciesResponse {
  currencies: CurrencyRow[];
  baseCurrency: string;
  ratesFetchedAt: string | null;
}

interface PreviewLine {
  productId: string;
  sku: string;
  name: string;
  variantKey: string | null;
  sourceMinor: string;
  targetMinor: string;
  existingMinor: string | null;
  skipped: 'existing' | null;
}

interface BulkPriceResult {
  sourceCurrency: string;
  targetCurrency: string;
  scanned: number;
  writable: number;
  skippedExisting: number;
  liftedToMinimum: number;
  sample: PreviewLine[];
  written: number;
}

type Rounding = 'exact' | 'whole' | 'charm';

/** Listed most-used first: charm pricing is what a shop actually ships. */
const ROUNDING_KEYS = {
  charm: 'bulkPricing.roundingCharm',
  whole: 'bulkPricing.roundingWhole',
  exact: 'bulkPricing.roundingExact',
} as const;

export function BulkCurrencyPricingDialog({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}): React.JSX.Element | null {
  const { t } = useI18n();

  const toast = useToast();
  const queryClient = useQueryClient();

  const [target, setTarget] = useState('');
  const [rate, setRate] = useState('');
  const [rounding, setRounding] = useState<Rounding>('charm');
  const [overwriteExisting, setOverwriteExisting] = useState(false);
  const [autoManaged, setAutoManaged] = useState(true);
  const [preview, setPreview] = useState<BulkPriceResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const currencies = useQuery({
    queryKey: ['admin-currencies', 'with-rates'],
    // Today's rates come with the list so the dialog opens on a real number
    // rather than an empty box somebody has to go and look up. Staff can still
    // type their own; the feed is a starting point, not an authority.
    queryFn: () => api.get<CurrenciesResponse>('/admin/currencies', { query: { rates: 'true' } }),
    enabled: isOpen,
    // A rate an hour old is fine to open on; one from last week is not.
    staleTime: 60 * 60_000,
  });

  const baseCurrency = currencies.data?.baseCurrency ?? '';

  // Each currency counts its own minor units, so a JPY figure must not be
  // rendered with two decimal places because the base currency has them.
  const sourceExponent =
    currencies.data?.currencies.find((currency) => currency.code === baseCurrency)?.exponent ?? 2;

  // Everything except the base currency: the base is the source of truth every
  // other figure is measured against, and the backend refuses to convert into
  // it for the same reason.
  const targets = (currencies.data?.currencies ?? []).filter(
    (currency) => currency.code !== baseCurrency,
  );

  // Open on the first currency with nothing priced in it, which is the one
  // somebody opening this screen is almost certainly here for.
  useEffect(() => {
    if (target !== '' || targets.length === 0) return;
    setTarget((targets.find((currency) => !currency.hasProducts) ?? targets[0])?.code ?? '');
  }, [target, targets]);

  const targetCurrency = targets.find((currency) => currency.code === target) ?? null;

  // Fill in today's rate for whichever currency is selected, but never over
  // something already typed: a rate somebody entered by hand is a decision,
  // and a background fetch landing must not quietly replace it.
  const [rateIsFromFeed, setRateIsFromFeed] = useState(false);

  useEffect(() => {
    const live = targetCurrency?.rate ?? null;
    if (live === null) return;
    if (rate !== '' && !rateIsFromFeed) return;
    if (rate === live) return;

    setRate(live);
    setRateIsFromFeed(true);
    setPreview(null);
  }, [rate, rateIsFromFeed, targetCurrency]);

  const run = useMutation({
    mutationFn: (dryRun: boolean) =>
      api.post<BulkPriceResult>('/admin/products/prices/bulk', {
        sourceCurrency: baseCurrency,
        targetCurrency: target,
        rate,
        rounding,
        overwriteExisting,
        autoManaged,
        dryRun,
      }),
  });

  /** Any change to the terms invalidates a preview taken under the old ones. */
  const reset = (): void => {
    setPreview(null);
    setError(null);
  };

  const submit = async (dryRun: boolean): Promise<void> => {
    setError(null);

    try {
      const result = await run.mutateAsync(dryRun);

      if (dryRun) {
        setPreview(result);
        return;
      }

      // Every price in this panel and on the storefront may have moved.
      await queryClient.invalidateQueries();

      toast.success(
        t('bulkPricing.written', {
          count: result.written,
          currency: result.targetCurrency,
        }),
      );
      onClose();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : t('bulkPricing.failedBody'));
    }
  };

  if (!isOpen) return null;

  const exponent = targetCurrency?.exponent ?? 2;
  const busy = run.isPending;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      title={t('bulkPricing.title')}
      description={t('bulkPricing.description', { base: baseCurrency })}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('bulkPricing.cancel')}
          </Button>

          {preview === null ? (
            <Button
              onClick={() => void submit(true)}
              disabled={busy || target === '' || rate.trim() === ''}
            >
              {busy ? t('bulkPricing.checking') : t('bulkPricing.preview')}
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => void submit(false)}
              disabled={busy || preview.writable === 0}
            >
              {busy
                ? t('bulkPricing.writing')
                : t('bulkPricing.write', {
                    count: preview.writable,
                    currency: preview.targetCurrency,
                  })}
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-4">
        {targets.length === 0 && !currencies.isLoading && (
          <Callout tone="warning" title={t('bulkPricing.noCurrencyTitle')}>
            {t('bulkPricing.noCurrencyBody')}
          </Callout>
        )}

        <Field
          label={t('bulkPricing.targetLabel')}
          // Spread rather than passed as `undefined`: under
          // `exactOptionalPropertyTypes` an absent hint and a hint of
          // `undefined` are different things, and `Field` accepts only the
          // former.
          {...(targetCurrency === null
            ? {}
            : {
                hint: targetCurrency.hasProducts
                  ? t('bulkPricing.targetHintPriced', { currency: targetCurrency.code })
                  : t('bulkPricing.targetHintEmpty', { currency: targetCurrency.code }),
              })}
        >
          {({ inputId, describedBy }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              value={target}
              onChange={(event) => {
                setTarget(event.target.value);
                reset();
              }}
            >
              {targets.map((currency) => (
                <option key={currency.code} value={currency.code}>
                  {currency.code} — {currency.name}
                  {currency.hasProducts ? '' : ` (${t('bulkPricing.targetOptionEmpty')})`}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field
          label={t('bulkPricing.rateLabel', {
            base: baseCurrency,
            target: target === '' ? '—' : target,
          })}
          hint={
            rateIsFromFeed
              ? t('bulkPricing.rateHintLive')
              : t('bulkPricing.rateHint')
          }
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              inputMode="decimal"
              placeholder="0.0105"
              value={rate}
              onChange={(event) => {
                setRate(event.target.value);
                setRateIsFromFeed(false);
                reset();
              }}
            />
          )}
        </Field>

        <Field label={t('bulkPricing.roundingLabel')} hint={t('bulkPricing.roundingHint')}>
          {({ inputId, describedBy }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              value={rounding}
              onChange={(event) => {
                setRounding(event.target.value as Rounding);
                reset();
              }}
            >
              {(Object.keys(ROUNDING_KEYS) as Rounding[]).map((key) => (
                <option key={key} value={key}>
                  {t(ROUNDING_KEYS[key])}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <label className="flex items-start gap-2.5 text-sm text-ink">
          <input
            type="checkbox"
            checked={autoManaged}
            onChange={(event) => {
              setAutoManaged(event.target.checked);
              reset();
            }}
            className="mt-0.5 h-4 w-4 rounded border-border-strong"
          />
          <span>
            {t('bulkPricing.autoManagedLabel')}
            <span className="mt-0.5 block text-xs text-ink-muted">
              {t('bulkPricing.autoManagedHint')}
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2.5 text-sm text-ink">
          <input
            type="checkbox"
            checked={overwriteExisting}
            onChange={(event) => {
              setOverwriteExisting(event.target.checked);
              reset();
            }}
            className="mt-0.5 h-4 w-4 rounded border-border-strong"
          />
          <span>
            {t('bulkPricing.overwriteLabel')}
            <span className="mt-0.5 block text-xs text-ink-muted">
              {t('bulkPricing.overwriteHint')}
            </span>
          </span>
        </label>

        {error !== null && (
          <Callout tone="danger" role="alert" title={t('bulkPricing.failedTitle')}>
            {error}
          </Callout>
        )}

        {preview !== null && (
          <div className="space-y-3 rounded-md border border-border bg-surface-sunken p-3">
            <p className="text-sm text-ink">
              {t('bulkPricing.summary', {
                count: preview.writable,
                target: preview.targetCurrency,
                scanned: preview.scanned,
                source: preview.sourceCurrency,
              })}
              {preview.skippedExisting > 0 && (
                <> {t('bulkPricing.summarySkipped', { count: preview.skippedExisting })}</>
              )}
            </p>

            {preview.liftedToMinimum > 0 && (
              <Callout tone="warning" title={t('bulkPricing.liftedTitle')}>
                {t('bulkPricing.lifted', {
                  count: preview.liftedToMinimum,
                  currency: preview.targetCurrency,
                })}
              </Callout>
            )}

            {preview.writable === 0 ? (
              <p className="text-sm text-ink-muted">
                {overwriteExisting
                  ? t('bulkPricing.nothingToWrite', { currency: preview.targetCurrency })
                  : t('bulkPricing.nothingToWriteOverwriteOff', {
                      currency: preview.targetCurrency,
                    })}
              </p>
            ) : (
              <>
                <table className="w-full text-sm">
                  <caption className="sr-only">
                    {t('bulkPricing.tableCaption', {
                      shown: preview.sample.length,
                      total: preview.scanned,
                    })}
                  </caption>
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-ink-subtle">
                      <th scope="col" className="pb-1.5 font-medium">
                        {t('bulkPricing.columnProduct')}
                      </th>
                      <th scope="col" className="pb-1.5 text-right font-medium">
                        {preview.sourceCurrency}
                      </th>
                      <th scope="col" className="pb-1.5 text-right font-medium">
                        {preview.targetCurrency}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.sample.map((line) => (
                      <tr
                        key={`${line.productId}:${line.variantKey ?? ''}`}
                        className="border-t border-border"
                      >
                        <td className="py-1.5 pr-2">
                          <span className="block truncate">{line.name}</span>
                          <span className="block text-xs text-ink-subtle">{line.sku}</span>
                        </td>
                        <td className="py-1.5 text-right tabular-nums">
                          {minorToMajor(line.sourceMinor, sourceExponent)}
                        </td>
                        <td className="py-1.5 text-right tabular-nums">
                          {line.skipped === 'existing' ? (
                            <Badge tone="neutral">{t('bulkPricing.kept')}</Badge>
                          ) : (
                            minorToMajor(line.targetMinor, exponent)
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {preview.scanned > preview.sample.length && (
                  <p className="text-xs text-ink-subtle">
                    {t('bulkPricing.showingFirst', {
                      shown: preview.sample.length,
                      rest: preview.scanned - preview.sample.length,
                    })}
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

/**
 * Landed cost calculator (checklist Master row 89).
 *
 * An estimate a buyer works out before asking for quotes: goods, freight,
 * import duty, tax, inspection and platform fees, per unit and in total. The
 * buyer types every figure; nothing here is a quote or a promise, and the page
 * says so. Money is BigInt minor units throughout - percentages are applied in
 * basis points and rounded half up, never through a float.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useLocale } from '@/app/locale-context';
import { useStorefront } from '@/app/storefront-context';
import { Card, Field, Input, PageHeader } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { currencyExponent, formatDate, formatMoneyMinor, majorToMinor } from '@/lib/format';
import { deliveryRange, landedCost, percentToBasisPoints, type LandedCostInput } from '@/lib/landed-cost';
import { useDocumentMeta } from '@/lib/useDocumentMeta';

const FIELDS = ['unitPrice', 'quantity', 'freight', 'inspection', 'duty', 'tax', 'platformFee'] as const;
type FieldName = (typeof FIELDS)[number];

export function LandedCostPage(): React.JSX.Element {
  const { t } = useI18n();
  const { business, features } = useStorefront();
  const { currency } = useLocale();
  useDocumentMeta({ title: t('landedCost.title') }, business.displayName);
  const [values, setValues] = useState<Record<FieldName, string>>({
    unitPrice: '',
    quantity: '1',
    freight: '',
    inspection: '',
    duty: '',
    tax: '',
    platformFee: '',
  });
  const exponent = currencyExponent(currency);
  const money = (text: string): bigint | null => {
    const minor = majorToMinor(text === '' ? '0' : text, exponent);
    return minor === null ? null : BigInt(minor);
  };
  const quantity = /^\d{1,9}$/.test(values.quantity) ? BigInt(values.quantity) : null;
  const parsed = {
    unitPriceMinor: money(values.unitPrice),
    quantity,
    freightMinor: money(values.freight),
    inspectionMinor: money(values.inspection),
    dutyBp: percentToBasisPoints(values.duty),
    taxBp: percentToBasisPoints(values.tax),
    platformFeeBp: percentToBasisPoints(values.platformFee),
  };
  const valid = Object.values(parsed).every((value) => value !== null);
  const result = valid ? landedCost(parsed as LandedCostInput) : null;
  const show = (minor: bigint): string => formatMoneyMinor(minor.toString(), currency);
  const [transit, setTransit] = useState({ min: '', max: '' });
  const range = transit.min === '' && transit.max === '' ? null : deliveryRange(new Date(), transit.min, transit.max);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <PageHeader title={t('landedCost.title')} description={t('landedCost.description', { currency })} />
      <div className="grid gap-4 md:grid-cols-2">
        <Card bodyClassName="grid gap-4 px-5 py-5">
          {FIELDS.map((name) => (
            <Field key={name} label={t(`landedCost.field.${name}` as TranslationKey)}>
              {({ inputId }) => (
                <Input
                  id={inputId}
                  inputMode="decimal"
                  value={values[name]}
                  onChange={(event) => {
                    setValues((current) => ({ ...current, [name]: event.target.value.trim() }));
                  }}
                />
              )}
            </Field>
          ))}
          <div className="grid grid-cols-2 gap-3">
            {(['min', 'max'] as const).map((bound) => (
              <Field key={bound} label={t(`landedCost.field.${bound}Days` as TranslationKey)}>
                {({ inputId }) => (
                  <Input
                    id={inputId}
                    inputMode="numeric"
                    value={transit[bound]}
                    onChange={(event) => {
                      setTransit((current) => ({ ...current, [bound]: event.target.value.trim() }));
                    }}
                  />
                )}
              </Field>
            ))}
          </div>
        </Card>
        <Card title={t('landedCost.resultTitle')} bodyClassName="px-5 py-5 text-sm">
          {result === null ? (
            <p role="alert" className="text-danger">{t('landedCost.invalid')}</p>
          ) : (
            <dl className="space-y-2">
              {(['goods', 'freight', 'duty', 'tax', 'inspection', 'platform'] as const).map((line) => (
                <div key={line} className="flex justify-between gap-3">
                  <dt className="text-ink-muted">{t(`landedCost.line.${line}` as TranslationKey)}</dt>
                  <dd className="tabular">{show(result[line])}</dd>
                </div>
              ))}
              <div className="flex justify-between gap-3 border-t border-border-subtle pt-2 font-semibold">
                <dt>{t('landedCost.line.total')}</dt>
                <dd className="tabular" data-testid="landed-total">{show(result.total)}</dd>
              </div>
              <div className="flex justify-between gap-3 text-ink-muted">
                <dt>{t('landedCost.line.perUnit')}</dt>
                <dd className="tabular">{show(result.perUnit)}</dd>
              </div>
            </dl>
          )}
          {(transit.min !== '' || transit.max !== '') && (
            <div className="mt-4 flex justify-between gap-3 border-t border-border-subtle pt-2">
              <span className="text-ink-muted">{t('landedCost.line.delivery')}</span>
              {range === null ? (
                <span role="alert" className="text-danger">{t('landedCost.invalidDays')}</span>
              ) : (
                <span className="tabular" data-testid="landed-delivery">{formatDate(`${range.earliest}T12:00:00`)} – {formatDate(`${range.latest}T12:00:00`)}</span>
              )}
            </div>
          )}
          <p className="mt-4 text-xs text-ink-muted">{t('landedCost.disclaimer')}</p>
          {features.rfq === true && (
            <Link to="/account/rfqs/new" className="mt-3 inline-block font-medium text-brand hover:underline">
              {t('rfq.cta.requestQuotes')}
            </Link>
          )}
        </Card>
      </div>
    </div>
  );
}

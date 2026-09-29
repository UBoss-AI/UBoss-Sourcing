/**
 * `/account/rfqs/:id/compare`: the quotes on a request, side by side.
 *
 * One column per supplier, one row per term. Every figure is shown as the
 * supplier quoted it; beneath it, when the buyer chose another currency and
 * a published rate exists, the converted figure - marked approximate, with
 * the rate, its source and its date in the note above the table. A term the
 * supplier did not give says "Not provided", never zero.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale } from '@/app/locale-context';
import { useToast } from '@/components/toast-context';
import { Button, ButtonAnchor, EmptyState, ErrorState, LoadingState, PageHeader, Select } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { formatMoney, type Money } from '@/lib/format';
import { formatUtc } from '@/lib/rfq-format';
import {
  comparisonCsvUrl,
  fetchComparison,
  setQuoteShortlist,
  type ComparisonRow,
  type ComparisonSort,
} from '@/lib/rfq-quote';

const SORTS: ComparisonSort[] = ['total', 'unitPrice', 'leadTime', 'moq', 'supplier'];

export function RfqComparePage(): React.JSX.Element {
  const { id = '' } = useParams<{ id: string }>();
  const { t, intlLocale } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { currencies, currency: localeCurrency } = useLocale();
  const [currency, setCurrency] = useState<string>(localeCurrency);
  const [sort, setSort] = useState<ComparisonSort>('total');
  const [shortlisted, setShortlisted] = useState(false);

  const query = useQuery({
    queryKey: ['rfq', id, 'comparison', currency, sort, shortlisted],
    queryFn: () => fetchComparison(id, { currency, sort, shortlisted }),
  });

  const toggle = useMutation({
    mutationFn: (row: ComparisonRow) => setQuoteShortlist(id, row.quoteId, !row.shortlisted),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['rfq', id, 'comparison'] });
    },
    onError: (error) => {
      toast.error(errorMessage(t, error));
    },
  });

  const missing = <span className="text-ink-subtle">{t('rfq.notProvided')}</span>;
  const cell = (quoted: Money | null, converted: Money | null | undefined): React.JSX.Element => (
    <>
      {quoted === null ? missing : <span className="tabular-nums">{formatMoney(quoted)}</span>}
      {quoted !== null && converted !== null && converted !== undefined && (
        <span className="block text-xs text-ink-muted tabular-nums">
          {t('rfq.compare.converted', { amount: formatMoney(converted) })}
        </span>
      )}
    </>
  );
  const textCell = (value: string | number | null): React.JSX.Element =>
    value === null ? missing : <span className="whitespace-pre-line">{String(value)}</span>;

  const rows: { label: string; render: (row: ComparisonRow) => React.JSX.Element }[] = [
    { label: t('rfq.compare.row.status'), render: (row) => <>{t(`rfq.quoteStatus.${row.status}` as TranslationKey)}</> },
    {
      label: t('rfq.compare.row.version'),
      render: (row) => (
        <>
          {t('rfq.detail.versionN', { version: String(row.versionNumber) })}
          {!row.onCurrentRequirement && (
            <span className="block text-xs text-warning">
              {t('rfq.compare.olderRequirement', { version: String(row.basedOnRequirementVersion) })}
            </span>
          )}
        </>
      ),
    },
    { label: t('rfq.compare.row.unitPrice'), render: (row) => cell(row.quoted.unitPrice, row.converted?.unitPrice) },
    { label: t('rfq.compare.row.applicableUnitPrice'), render: (row) => cell(row.quoted.applicableUnitPrice, row.converted?.applicableUnitPrice) },
    { label: t('rfq.compare.row.total'), render: (row) => cell(row.quoted.total, row.converted?.total) },
    {
      label: t('rfq.compare.row.tiers'),
      render: (row) =>
        row.tiers.length === 0 ? (
          missing
        ) : (
          <ul>
            {row.tiers.map((tier) => (
              <li key={tier.minQuantity}>{t('rfq.compare.tier', { quantity: tier.minQuantity, price: formatMoney(tier.unitPrice) })}</li>
            ))}
          </ul>
        ),
    },
    { label: t('rfq.compare.row.moq'), render: (row) => textCell(row.moq) },
    { label: t('rfq.compare.row.leadTime'), render: (row) => (row.leadTimeDays === null ? missing : <>{t('rfq.compare.days', { days: String(row.leadTimeDays) })}</>) },
    { label: t('rfq.compare.row.capacity'), render: (row) => textCell(row.capacityPerMonth) },
    { label: t('rfq.field.incoterm'), render: (row) => textCell(row.incoterm === null ? null : `${row.incoterm}${row.incotermPlace === null ? '' : ` ${row.incotermPlace}`}`) },
    { label: t('rfq.compare.row.payment'), render: (row) => textCell(row.paymentTerms) },
    { label: t('rfq.compare.row.inspection'), render: (row) => textCell(row.inspectionTerms) },
    { label: t('rfq.compare.row.warranty'), render: (row) => textCell(row.warranty) },
    { label: t('rfq.compare.row.tooling'), render: (row) => cell(row.quoted.tooling, row.converted?.tooling) },
    { label: t('rfq.compare.row.sample'), render: (row) => cell(row.quoted.sampleCost, row.converted?.sampleCost) },
    { label: t('rfq.compare.row.shipping'), render: (row) => cell(row.quoted.shippingEstimate, row.converted?.shippingEstimate) },
    { label: t('rfq.compare.row.taxes'), render: (row) => textCell(row.taxesDisclosure) },
    {
      label: t('rfq.compare.row.validUntil'),
      render: (row) => (
        <>
          {formatUtc(row.expiresAt, intlLocale)}
          {row.isExpired && <span className="block text-xs text-danger">{t('rfq.compare.expired')}</span>}
        </>
      ),
    },
  ];

  const conversions = [
    ...new Map(
      (query.data?.rows ?? []).flatMap((row) => (row.converted === null ? [] : [[row.quoted.currency, row.converted.conversion] as const])),
    ).entries(),
  ];

  return (
    <>
      <PageHeader
        title={t('rfq.compare.title')}
        {...(query.data === undefined ? {} : { description: query.data.reference })}
        actions={
          <>
            <Link to={`/account/rfqs/${id}`} className="text-sm font-medium text-brand hover:underline">
              {t('rfq.compare.back')}
            </Link>
            <ButtonAnchor href={comparisonCsvUrl(id, currency, sort, shortlisted)} download>
              {t('rfq.compare.export')}
            </ButtonAnchor>
          </>
        }
      />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="text-sm font-medium text-ink">
          {t('rfq.compare.currency')}
          <Select
            className="mt-1 w-32"
            value={currency}
            onChange={(event) => {
              setCurrency(event.target.value);
            }}
          >
            {currencies.map((option) => (
              <option key={option.code} value={option.code}>
                {option.code}
              </option>
            ))}
          </Select>
        </label>
        <label className="text-sm font-medium text-ink">
          {t('rfq.compare.sort')}
          <Select
            className="mt-1 w-48"
            value={sort}
            onChange={(event) => {
              setSort(event.target.value as ComparisonSort);
            }}
          >
            {SORTS.map((option) => (
              <option key={option} value={option}>
                {t(`rfq.compare.sortBy.${option}` as TranslationKey)}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={shortlisted}
            onChange={(event) => {
              setShortlisted(event.target.checked);
            }}
          />
          {t('rfq.compare.shortlistedOnly')}
        </label>
      </div>

      {conversions.length > 0 && (
        <p role="note" className="mb-4 rounded-md border border-border-subtle bg-surface-sunken px-4 py-3 text-xs text-ink-muted">
          {conversions
            .map(([from, conversion]) =>
              t('rfq.compare.rateNote', {
                from,
                to: conversion.currency,
                rate: conversion.rate,
                source: conversion.provider,
                date: formatUtc(conversion.rateAsOf, intlLocale),
              }),
            )
            .join(' ')}
        </p>
      )}

      {query.isPending ? (
        <LoadingState label={t('rfq.compare.loading')} />
      ) : query.isError ? (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : query.data.rows.length === 0 ? (
        <EmptyState title={t('rfq.compare.emptyTitle')} description={t('rfq.compare.emptyBody')} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-surface shadow-card">
          <table className="min-w-full text-left text-sm">
            <caption className="sr-only">{t('rfq.compare.caption')}</caption>
            <thead>
              <tr className="border-b border-border-subtle align-top">
                <th scope="col" className="sticky left-0 bg-surface px-4 py-3 text-xs font-medium text-ink-muted">
                  {t('rfq.compare.term')}
                </th>
                {query.data.rows.map((row) => (
                  <th key={row.quoteId} scope="col" className="min-w-[12rem] px-4 py-3 font-medium text-ink">
                    <span className="block">{row.supplier.displayName}</span>
                    <span className="block text-xs font-normal text-success">
                      {row.supplier.verified ? t('rfq.supplier.verified') : t('rfq.compare.notVerified')}
                    </span>
                    {row.conversionUnavailable && (
                      <span className="block text-xs font-normal text-warning">{t('rfq.compare.noRate', { from: row.quoted.currency })}</span>
                    )}
                    <Button
                      size="sm"
                      className="mt-2"
                      aria-pressed={row.shortlisted}
                      onClick={() => {
                        toggle.mutate(row);
                      }}
                    >
                      {row.shortlisted ? t('rfq.compare.unshortlist') : t('rfq.compare.shortlist')}
                    </Button>
                    <Link to={`/account/rfqs/${id}/quotes/${row.quoteId}`} className="mt-2 block text-xs font-medium text-brand hover:underline">
                      {t('rfq.compare.open')}
                    </Link>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((line) => (
                <tr key={line.label} className="border-b border-border-subtle align-top last:border-0">
                  <th scope="row" className="sticky left-0 bg-surface px-4 py-2 text-xs font-medium text-ink-muted">
                    {line.label}
                  </th>
                  {query.data.rows.map((row) => (
                    <td key={row.quoteId} className="px-4 py-2 text-ink">
                      {line.render(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/**
 * `/account/rfqs/:id/quotes/:quoteId`: one supplier's quote, and the
 * negotiation on it, as the buyer works it.
 */
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { NegotiationPanel } from '@/components/rfq/NegotiationPanel';
import { ErrorState, LoadingState, PageHeader } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { fetchBuyerQuote } from '@/lib/rfq-quote';

export function RfqQuotePage(): React.JSX.Element {
  const { id = '', quoteId = '' } = useParams<{ id: string; quoteId: string }>();
  const { t } = useI18n();
  const queryKey = ['rfq', id, 'quote', quoteId] as const;
  const query = useQuery({ queryKey, queryFn: () => fetchBuyerQuote(id, quoteId) });

  if (query.isPending) return <LoadingState label={t('rfq.quote.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }
  return (
    <>
      <PageHeader
        title={t('rfq.offer.pageTitle')}
        description={t(`rfq.quoteStatus.${query.data.status}` as TranslationKey)}
        actions={
          <Link to={`/account/rfqs/${id}/compare`} className="text-sm font-medium text-brand hover:underline">
            {t('rfq.offer.backToCompare')}
          </Link>
        }
      />
      <NegotiationPanel quote={query.data} party="BUYER" basePath={`/rfqs/${id}/quotes/${quoteId}`} queryKey={queryKey} />
    </>
  );
}

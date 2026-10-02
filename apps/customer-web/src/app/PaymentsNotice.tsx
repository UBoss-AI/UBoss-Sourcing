/**
 * The storefront's payments notice (JOURNEY-065).
 *
 * When the marketplace's payment gateway is having trouble - none switched on,
 * a failed connection test, or several refused payment confirmations in the
 * last hour - shoppers are told before they reach the payment step, so a
 * declined card is not read as their bank's fault. The server answers only
 * yes or no; it never says which provider or why.
 *
 * Its own query, separate from `ServiceBanner`'s error watch, and it swallows
 * its own failure: a notice about payments must never itself become the
 * reason the "having trouble reaching us" banner appears.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useI18n } from '@/i18n/i18n-context';

export const SERVICE_STATUS_KEY = ['service-status'] as const;

async function readStatus(): Promise<{ paymentsDegraded: boolean }> {
  try {
    const answer = await api.get<{ paymentsDegraded?: unknown }>('/service-status', { retryOnUnauthorised: false });
    return { paymentsDegraded: answer.paymentsDegraded === true };
  } catch {
    return { paymentsDegraded: false };
  }
}

export function PaymentsNotice(): React.JSX.Element | null {
  const { t } = useI18n();
  const query = useQuery({
    queryKey: SERVICE_STATUS_KEY,
    queryFn: readStatus,
    staleTime: 60_000,
    refetchInterval: 120_000,
    refetchIntervalInBackground: false,
  });

  if (query.data?.paymentsDegraded !== true) return null;

  return (
    <div role="status" className="bg-warning-soft px-4 py-2 text-center text-sm text-ink">
      <span className="font-medium text-warning">{t('serviceBanner.paymentsDegradedTitle')}</span>{' '}
      {t('serviceBanner.paymentsDegradedBody')}
    </div>
  );
}

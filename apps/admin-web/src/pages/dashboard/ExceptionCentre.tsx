/**
 * The exception centre (ENH-019): failed payments, missing documents, failed
 * inspections, late shipments, settlement mismatches and integration failures
 * in one ranked queue. The order and the permission gating are the server's.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { BentoCell } from '@/components/dashboard/console';
import { Badge, ErrorState, LoadingState } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { api } from '@/lib/api';

type ExceptionType = 'FAILED_PAYMENT' | 'MISSING_DOCUMENT' | 'INSPECTION_NCR' | 'LATE_SHIPMENT' | 'SETTLEMENT_MISMATCH' | 'INTEGRATION_FAILURE';
interface ExceptionCentreData {
  total: number;
  items: { type: ExceptionType; source: string; count: number; severity: 'info' | 'attention' | 'urgent'; href: string }[];
  types: { type: ExceptionType; count: number }[];
}

export function ExceptionCentre(): React.JSX.Element | null {
  const { t } = useI18n();
  const query = useQuery({ queryKey: ['admin-exceptions'], queryFn: () => api.get<ExceptionCentreData>('/admin/exceptions'), staleTime: 30_000 });
  if (query.data !== undefined && query.data.types.length === 0) return null;
  return (
    <BentoCell span={6}>
      <section aria-labelledby="exception-centre" className="p-4">
        <h2 id="exception-centre" className="text-base font-semibold">{t('exceptions.title')}</h2>
        {query.isPending ? <LoadingState /> : query.isError ? (
          <ErrorState error={query.error} onRetry={() => { void query.refetch(); }} />
        ) : (
          <>
            <ul className="mt-2 flex flex-wrap gap-2 text-sm">
              {query.data.types.map((row) => (
                <li key={row.type}><Badge tone={row.count > 0 ? 'danger' : 'neutral'}>{t(`exceptions.type.${row.type}`)}: {row.count}</Badge></li>
              ))}
            </ul>
            {query.data.items.length === 0 ? <p role="status" className="mt-2 text-sm">{t('exceptions.empty')}</p> : (
              <ol className="mt-3 divide-y divide-border-subtle text-sm">
                {query.data.items.map((item) => (
                  <li key={item.source} className="flex items-center justify-between gap-2 py-2">
                    <Link to={item.href} className="font-medium text-brand hover:underline">{t(`exceptions.type.${item.type}`)}</Link>
                    <span className={item.severity === 'urgent' ? 'font-semibold text-danger' : 'text-ink-muted'}>{item.count}</span>
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
      </section>
    </BentoCell>
  );
}

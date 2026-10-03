/**
 * The signed-in buyer's task row on the home page (DYNAMIC-004): quotes waiting
 * for a decision, open inspections, shipments on the way, payments to make and
 * something to buy again. Every figure is the buyer's own, read from endpoints
 * that already scope to them; a tile with nothing to do is left out, and a
 * source that fails is simply not shown rather than shown as zero.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useSession } from '@/auth/session-context';
import { useStorefront } from '@/app/storefront-context';
import { useI18n } from '@/i18n/i18n-context';
import { api } from '@/lib/api';
import { fetchDashboard } from '@/lib/buyer-dashboard';
import { fetchRfqSummary } from '@/lib/rfq';

const DAY = 86_400_000;

export function HomeTaskRow(): React.JSX.Element | null {
  const { t } = useI18n();
  const { isCustomer } = useSession();
  const { features } = useStorefront();
  const now = Date.now();
  const window = { from: new Date(now - 90 * DAY).toISOString().slice(0, 10), to: new Date(now).toISOString().slice(0, 10) };
  const dashboard = useQuery({ queryKey: ['home-tasks', 'dashboard'], queryFn: () => fetchDashboard(window), enabled: isCustomer, staleTime: 60_000, retry: false });
  const rfq = useQuery({ queryKey: ['home-tasks', 'rfq'], queryFn: fetchRfqSummary, enabled: isCustomer && features.rfq === true, staleTime: 60_000, retry: false });
  const inspections = useQuery({
    queryKey: ['home-tasks', 'inspections'],
    queryFn: () => api.get<{ inspections: { jobNumber: string; orderId: string; orderNumber: string }[] }>('/account/inspections'),
    enabled: isCustomer,
    staleTime: 60_000,
    retry: false,
  });
  if (!isCustomer) return null;
  const tiles: { key: string; label: string; to: string }[] = [];
  const awaiting = rfq.data?.quotes?.awaitingYou ?? 0;
  if (awaiting > 0) tiles.push({ key: 'quotes', label: t('homeTasks.quotes', { quotes: String(awaiting) }), to: '/account/rfqs' });
  const firstInspection = inspections.data?.inspections[0];
  if (firstInspection !== undefined) tiles.push({ key: 'inspections', label: t('homeTasks.inspections', { jobs: String(inspections.data?.inspections.length ?? 0), order: firstInspection.orderNumber }), to: `/account/orders/${firstInspection.orderId}` });
  const arriving = dashboard.data?.deliveries.arrivingSoon ?? [];
  if (arriving.length > 0) tiles.push({ key: 'shipments', label: t('homeTasks.shipments', { shipments: String(arriving.length) }), to: '/account/orders' });
  const payments = dashboard.data?.paymentActions ?? [];
  const firstPayment = payments[0];
  if (firstPayment !== undefined) tiles.push({ key: 'payments', label: t('homeTasks.payments', { payments: String(payments.length) }), to: `/account/orders/${firstPayment.orderId}` });
  const again = dashboard.data?.buyAgain?.[0];
  if (again !== undefined) tiles.push({ key: 'again', label: t('homeTasks.again', { name: again.name }), to: `/product/${again.slug}` });
  if (tiles.length === 0) return null;
  return (
    <section aria-labelledby="home-tasks" className="mx-auto my-4 max-w-7xl px-4">
      <h2 id="home-tasks" className="text-base font-semibold">{t('homeTasks.title')}</h2>
      <ul className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {tiles.map((tile) => (
          <li key={tile.key}>
            <Link to={tile.to} className="block h-full rounded-lg border border-border bg-surface p-3 text-sm font-medium text-ink shadow-card hover:border-brand">
              {tile.label}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

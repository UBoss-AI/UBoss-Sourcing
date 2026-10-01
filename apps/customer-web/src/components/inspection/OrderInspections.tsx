/**
 * Loads the inspection(s) on one order and renders them: every seller group
 * for the buyer, the seller's own group in Seller Hub. Renders nothing when no
 * inspection exists, so orders without one look exactly as before.
 */
import { useQuery } from '@tanstack/react-query';
import { BuyerBookingForm } from '@/components/inspection/BuyerBookingForm';
import { InspectionPanel } from '@/components/inspection/InspectionPanel';
import { OPEN_JOB_STATUSES, fetchBuyerInspections, fetchSellerInspection, inspectionKeys, type InspectionView } from '@/lib/inspection';

/** The buyer may book while nothing is in flight and nothing has been inspected yet. */
function buyerMayBook(view: InspectionView): boolean {
  return !view.jobs.some((job) => OPEN_JOB_STATUSES.includes(job.status) || job.status === 'COMPLETED');
}

export function BuyerOrderInspections({ orderId }: { orderId: string }): React.JSX.Element | null {
  const key = inspectionKeys.buyer(orderId);
  const query = useQuery({ queryKey: key, queryFn: () => fetchBuyerInspections(orderId), retry: false });
  if (query.data === undefined || query.data.length === 0) return null;
  return (
    <div className="space-y-3">
      {query.data.map((view) => (
        <div key={view.requirement.id} className="space-y-2">
          <InspectionPanel view={view} audience="BUYER" queryKey={key} />
          {buyerMayBook(view) && <BuyerBookingForm orderId={orderId} view={view} queryKey={key} />}
        </div>
      ))}
    </div>
  );
}

export function SellerOrderInspection({ sellerOrderGroupId }: { sellerOrderGroupId: string }): React.JSX.Element | null {
  const key = inspectionKeys.seller(sellerOrderGroupId);
  const query = useQuery({ queryKey: key, queryFn: () => fetchSellerInspection(sellerOrderGroupId), retry: false });
  if (query.data == null) return null;
  return <InspectionPanel view={query.data} audience="SELLER" queryKey={key} />;
}

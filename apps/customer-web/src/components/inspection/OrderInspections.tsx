/**
 * Loads the inspection(s) on one order and renders them: every seller group
 * for the buyer, the seller's own group in Seller Hub. Renders nothing when no
 * inspection exists, so orders without one look exactly as before.
 */
import { useQuery } from '@tanstack/react-query';
import { InspectionPanel } from '@/components/inspection/InspectionPanel';
import { fetchBuyerInspections, fetchSellerInspection, inspectionKeys } from '@/lib/inspection';

export function BuyerOrderInspections({ orderId }: { orderId: string }): React.JSX.Element | null {
  const key = inspectionKeys.buyer(orderId);
  const query = useQuery({ queryKey: key, queryFn: () => fetchBuyerInspections(orderId), retry: false });
  if (query.data === undefined || query.data.length === 0) return null;
  return (
    <div className="space-y-3">
      {query.data.map((view) => <InspectionPanel key={view.requirement.id} view={view} audience="BUYER" queryKey={key} />)}
    </div>
  );
}

export function SellerOrderInspection({ sellerOrderGroupId }: { sellerOrderGroupId: string }): React.JSX.Element | null {
  const key = inspectionKeys.seller(sellerOrderGroupId);
  const query = useQuery({ queryKey: key, queryFn: () => fetchSellerInspection(sellerOrderGroupId), retry: false });
  if (query.data == null) return null;
  return <InspectionPanel view={query.data} audience="SELLER" queryKey={key} />;
}

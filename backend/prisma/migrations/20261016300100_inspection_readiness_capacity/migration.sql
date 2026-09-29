-- Pre-shipment inspection, second part: seller readiness, agency capacity and
-- the two notification kinds the gate raises.
--
-- * inspection_jobs.readiness*: the seller presenting the final lot - lot,
--   location, packing list, date, contact, packed status and a declaration
--   that the goods match the order. The inspector cannot start before it.
-- * inspection_agencies.dailyCapacity: inspections an agency can do in a day.
-- * inspection_policies.requirePackingListForReadiness: the operator's switch.
-- * seller_notifications.kind gains INSPECTION_UPDATE and
--   logistics_notifications.kind gains DISPATCH_AUTHORISED - the carrier is
--   told when the goods may be collected. Both appended at the end of the
--   enum, so existing rows keep their values.

-- AlterTable
ALTER TABLE `seller_notifications` MODIFY `kind` ENUM('APPLICATION_STATUS', 'LISTING_DECISION', 'NEW_ORDER', 'DISPATCH_SLA_WARNING', 'LOW_STOCK', 'ERP_SYNC_FAILURE', 'DOCUMENT_EXPIRING', 'PAYOUT_RESULT', 'RETURN_OR_DISPUTE', 'SECURITY_EVENT', 'BRAND_REQUEST_DECISION', 'CARRIER_ARRANGEMENT_DECISION', 'CARRIER_ACCEPTED', 'CARRIER_REJECTED', 'CARRIER_OFFER_EXPIRED', 'FULFILMENT_METHOD_DECISION', 'CARRIER_CONNECTION_FAILED', 'PARTNER_INVITATION_RESULT', 'CONSIGNMENT_AWAITING_METHOD', 'BULK_ORDER_RECEIVED', 'FREIGHT_QUOTE_REQUESTED', 'FREIGHT_QUOTE_AVAILABLE', 'PACKAGING_VALIDATION_FAILED', 'ERP_BRIDGE_OFFLINE', 'ERP_MAPPING_INCOMPLETE', 'ERP_SYNC_RECOVERED', 'ERP_INITIAL_SYNC_COMPLETE', 'CONSIGNMENT_NEEDS_CARRIER', 'CARRIER_BOOKING_INCOMPLETE', 'LOGISTICS_POLICY_UPDATE', 'LOGISTICS_PRICE_REQUIRED', 'LOGISTICS_UBOSS_PRICE_PUBLISHED', 'LOGISTICS_LEG_ASSIGNMENT_REQUIRED', 'LOGISTICS_LEG_UPDATE', 'SETTLEMENT_CALCULATED', 'PREORDER_REQUEST_RECEIVED', 'PREORDER_BUYER_RESPONSE', 'PREORDER_CONFIRMED', 'PREORDER_CLOSED', 'PREORDER_DELIVERY_RISK', 'INVOICE_CREDIT_NOTE_REQUIRED', 'INSPECTION_UPDATE') NOT NULL;

-- AlterTable
ALTER TABLE `logistics_notifications` MODIFY `kind` ENUM('SHIPMENT_ASSIGNED', 'DRIVER_ASSIGNED', 'DRIVER_REASSIGNED', 'ASSIGNMENT_ACCEPTED', 'ASSIGNMENT_REJECTED', 'PICKUP_SCHEDULED', 'PICKUP_COMPLETED', 'SHIPMENT_DISPATCHED', 'SHIPMENT_IN_TRANSIT', 'OUT_FOR_DELIVERY', 'SHIPMENT_DELIVERED', 'DELIVERY_ATTEMPTED', 'SHIPMENT_DELAYED', 'EXCEPTION_RAISED', 'SLA_AT_RISK', 'SLA_BREACHED', 'POD_AVAILABLE', 'RETURN_INITIATED', 'INTEGRATION_FAILURE', 'USER_INVITED', 'SECURITY_EVENT', 'LEG_ASSIGNED', 'LEG_WITHDRAWN', 'DISPATCH_AUTHORISED') NOT NULL;

-- AlterTable
ALTER TABLE `inspection_policies` ADD COLUMN `requirePackingListForReadiness` BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE `inspection_agencies` ADD COLUMN `dailyCapacity` INTEGER NOT NULL DEFAULT 4;

-- AlterTable
ALTER TABLE `inspection_jobs` ADD COLUMN `readinessJson` JSON NULL,
    ADD COLUMN `readinessSubmittedAt` DATETIME(3) NULL,
    ADD COLUMN `readinessSubmittedById` CHAR(26) NULL;


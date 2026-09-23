-- Let a seller send a parcel with DHL, FedEx or India Post without an API
-- account, and say so honestly.
--
-- WHAT WAS MISSING. The only way to hand a consignment to anybody was an offer
-- to a delivery company on this platform. DHL, FedEx and India Post are not
-- delivery companies on this platform, so a seller with no API credentials had
-- no way to record who was carrying their parcel at all - and no seller in a
-- fresh deployment has credentials.
--
-- THREE CHANGES, ALL ADDITIVE:
--
--   1. `seller_manual_carrier_bookings`: what the seller arranged with the
--      carrier outside Glovia - the service, the collection reference, the
--      carrier's own waybill number once they have one. It never holds a
--      label, a rate or a generated number, because Glovia produced none.
--      One LIVE booking per consignment is enforced by
--      `uq_manual_booking_active` on a column that is NULL once the booking is
--      cancelled; MariaDB treats every NULL in a UNIQUE index as distinct, so
--      cancelled rows sit harmlessly beside the one live row.
--
--   2. `SELLER_PORTAL` on the three columns typed `LogisticsEventSource`, so an
--      event the seller typed in is never mistaken for one DHL's own system
--      reported. Appended, never inserted: MariaDB stores an ENUM as the
--      ORDINAL of its member, and reordering the list would silently change
--      the meaning of every existing row.
--
--   3. Two seller alert kinds, appended for the same reason:
--      CONSIGNMENT_NEEDS_CARRIER and CARRIER_BOOKING_INCOMPLETE.
--
-- SAFE ON A LIVE DEPLOYMENT. Nothing is removed or renamed, no existing row
-- changes meaning, and no backfill is needed. An existing deployment gets an
-- empty table.
--
-- ROLLBACK: drop the table, then restore the previous member lists. Any event,
-- document, proof or notification written with a new member must be deleted
-- first, which is why that is a rollback step and not a simple reversal.

CREATE TABLE `seller_manual_carrier_bookings` (
    `id` CHAR(26) NOT NULL,
    `shipmentId` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `provider` ENUM('MANUAL', 'CUSTOM', 'DHL', 'FEDEX', 'UPS', 'INDIA_POST') NOT NULL,
    `sellerFulfilmentMethodId` CHAR(26) NULL,
    `status` ENUM('BOOKING_REQUIRED', 'BOOKED', 'CANCELLED') NOT NULL DEFAULT 'BOOKING_REQUIRED',
    `activeShipmentId` CHAR(26) NULL,
    `serviceName` VARCHAR(120) NULL,
    `pickupReference` VARCHAR(64) NULL,
    `carrierTrackingNumber` VARCHAR(128) NULL,
    `expectedPickupAt` DATETIME(3) NULL,
    `expectedDeliveryAt` DATETIME(3) NULL,
    `shippingCostMinor` BIGINT NULL,
    `currency` CHAR(3) NULL,
    `createdBySellerMemberId` CHAR(26) NULL,
    `createdByLabel` VARCHAR(160) NOT NULL,
    `bookedAt` DATETIME(3) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `cancelledReason` VARCHAR(512) NULL,
    `cancelledByLabel` VARCHAR(160) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_manual_booking_active`(`activeShipmentId`),
    INDEX `ix_manual_booking_shipment`(`shipmentId`, `createdAt`),
    INDEX `ix_manual_booking_seller`(`sellerAccountId`, `status`),
    PRIMARY KEY (`id`),

    -- A cost is never negative, and never recorded without its currency:
    -- 4500 of nothing in particular is not a price anybody can check.
    CONSTRAINT `chk_manual_booking_cost` CHECK (
        `shippingCostMinor` IS NULL
        OR (`shippingCostMinor` >= 0 AND `currency` IS NOT NULL)
    ),
    -- Live means live: a cancelled booking never holds the active slot, and a
    -- live one always does. This is what makes the UNIQUE index above mean
    -- "one live booking" rather than "one row that happens to be non-null".
    CONSTRAINT `chk_manual_booking_active_slot` CHECK (
        (`status` = 'CANCELLED' AND `activeShipmentId` IS NULL)
        OR (`status` <> 'CANCELLED' AND `activeShipmentId` = `shipmentId`)
    ),
    -- BOOKED is the carrier's own number having been typed in. Without one it
    -- is still BOOKING_REQUIRED, whatever else is filled in.
    CONSTRAINT `chk_manual_booking_booked_has_number` CHECK (
        `status` <> 'BOOKED' OR `carrierTrackingNumber` IS NOT NULL
    )
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ON UPDATE RESTRICT, not CASCADE: `shipmentId` is named in
-- `chk_manual_booking_active_slot`, and MariaDB 11.4 refuses a CHECK on a
-- column a foreign key may rewrite (error 1901). ON DELETE CASCADE is allowed.
-- The parent key is a ULID that is never updated, so RESTRICT costs nothing.
ALTER TABLE `seller_manual_carrier_bookings`
    ADD CONSTRAINT `seller_manual_carrier_bookings_shipmentId_fkey`
    FOREIGN KEY (`shipmentId`) REFERENCES `logistics_shipments`(`id`)
    ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE `logistics_shipment_events`
    MODIFY `source` ENUM(
        'LOGISTICS_PORTAL', 'DRIVER_APP', 'UBOSS_ADMIN', 'CARRIER_API',
        'INBOUND_WEBHOOK', 'SYSTEM_AUTOMATION', 'SELLER_PORTAL'
    ) NOT NULL;

ALTER TABLE `logistics_shipment_documents`
    MODIFY `uploadedBySource` ENUM(
        'LOGISTICS_PORTAL', 'DRIVER_APP', 'UBOSS_ADMIN', 'CARRIER_API',
        'INBOUND_WEBHOOK', 'SYSTEM_AUTOMATION', 'SELLER_PORTAL'
    ) NOT NULL DEFAULT 'LOGISTICS_PORTAL';

ALTER TABLE `logistics_proof_of_delivery`
    MODIFY `capturedBySource` ENUM(
        'LOGISTICS_PORTAL', 'DRIVER_APP', 'UBOSS_ADMIN', 'CARRIER_API',
        'INBOUND_WEBHOOK', 'SYSTEM_AUTOMATION', 'SELLER_PORTAL'
    ) NOT NULL DEFAULT 'DRIVER_APP';

ALTER TABLE `seller_notifications`
    MODIFY `kind` ENUM(
        'APPLICATION_STATUS', 'LISTING_DECISION', 'NEW_ORDER', 'DISPATCH_SLA_WARNING',
        'LOW_STOCK', 'ERP_SYNC_FAILURE', 'DOCUMENT_EXPIRING', 'PAYOUT_RESULT',
        'RETURN_OR_DISPUTE', 'SECURITY_EVENT', 'BRAND_REQUEST_DECISION',
        'CARRIER_ARRANGEMENT_DECISION', 'CARRIER_ACCEPTED', 'CARRIER_REJECTED',
        'CARRIER_OFFER_EXPIRED',
        'FULFILMENT_METHOD_DECISION', 'CARRIER_CONNECTION_FAILED',
        'PARTNER_INVITATION_RESULT', 'CONSIGNMENT_AWAITING_METHOD',
        'BULK_ORDER_RECEIVED', 'FREIGHT_QUOTE_REQUESTED', 'FREIGHT_QUOTE_AVAILABLE',
        'PACKAGING_VALIDATION_FAILED',
        'ERP_BRIDGE_OFFLINE', 'ERP_MAPPING_INCOMPLETE', 'ERP_SYNC_RECOVERED',
        'ERP_INITIAL_SYNC_COMPLETE',
        'CONSIGNMENT_NEEDS_CARRIER', 'CARRIER_BOOKING_INCOMPLETE'
    ) NOT NULL;

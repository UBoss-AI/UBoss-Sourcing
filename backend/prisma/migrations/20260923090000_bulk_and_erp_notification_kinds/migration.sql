-- Eight more things a seller has to be told about, and was not.
--
-- Four belong to bulk ordering and four to the seller's own accounting system.
-- Each is a moment where something happened while the seller was looking at a
-- different screen, or at nothing at all:
--
--   BULK_ORDER_RECEIVED           an order arrived by the pallet or container
--   FREIGHT_QUOTE_REQUESTED       somebody asked for a freight price
--   FREIGHT_QUOTE_AVAILABLE       somebody answered one
--   PACKAGING_VALIDATION_FAILED   a package they switched on is incomplete
--   ERP_BRIDGE_OFFLINE            the Tally bridge stopped checking in
--   ERP_MAPPING_INCOMPLETE        something a sync needs is unmatched
--   ERP_SYNC_RECOVERED            it is working again
--   ERP_INITIAL_SYNC_COMPLETE     the first run finished
--
-- BULK_ORDER_RECEIVED is deliberately NOT a NEW_ORDER with different wording.
-- It is a different job: a pallet order needs a forklift booked and a lorry
-- found, and a seller who reads "new order" and pictures a box discovers the
-- difference on the loading bay.
--
-- Three of them are ALERTS rather than news, using the `class` column that
-- already exists. An alert is cleared by the problem going away, for the whole
-- business, rather than by one person glancing at it - and an incomplete
-- package, an offline bridge and an unmatched ledger are each still true
-- however many people have read about them.
--
-- ERP_SYNC_FAILURE is NOT reused for the bridge. That member belongs to the
-- OPERATOR's warehouse ERP, which is a different feature with a different
-- owner; folding a seller's own books into it would make "which ERP is
-- broken?" unanswerable from the notification alone.
--
-- APPEND-ONLY, like every other enum change in this schema.
--
-- MariaDB stores an ENUM as the ORDINAL of its member. A MODIFY that rearranges
-- the list rebuilds the table, and every stored ordinal then points at a
-- different word - silently, with no error, and with no way afterwards to tell
-- which rows were affected. So new members go on the end, always.
--
-- SAFE ON A LIVE DEPLOYMENT. Nothing is removed or renamed, no existing row
-- changes meaning, and no backfill is needed.
--
-- ROLLBACK: restore the previous member list. Any row written with one of the
-- eight new kinds would have to be deleted first, which is why this is listed
-- as a rollback step rather than as a simple reversal.

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
        'ERP_INITIAL_SYNC_COMPLETE'
    ) NOT NULL;

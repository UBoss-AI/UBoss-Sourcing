-- Four things a seller now has to be told about, and was not.
--
-- Each one is a moment where something happened to a seller's delivery setup
-- while they were looking at a different screen, or at nothing at all:
--
--   FULFILMENT_METHOD_DECISION   the marketplace approved, refused or asked
--                                for changes to a way of delivering
--   CARRIER_CONNECTION_FAILED    the seller's own carrier account stopped
--                                answering
--   PARTNER_INVITATION_RESULT    a delivery company the seller invited said
--                                yes, or did not
--   CONSIGNMENT_AWAITING_METHOD  a paid order has nothing that can carry it
--
-- The last two of those are ALERTS rather than news, which is a column that
-- already exists: an alert is cleared by the problem going away, for the whole
-- business, rather than by one person glancing at it. A connection that is
-- still broken and a parcel that still has nobody are both true however many
-- people read about them.
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
-- four new kinds would have to be deleted first, which is why this is listed as
-- a rollback step rather than as a simple reversal.

ALTER TABLE `seller_notifications`
    MODIFY `kind` ENUM(
        'APPLICATION_STATUS', 'LISTING_DECISION', 'NEW_ORDER', 'DISPATCH_SLA_WARNING',
        'LOW_STOCK', 'ERP_SYNC_FAILURE', 'DOCUMENT_EXPIRING', 'PAYOUT_RESULT',
        'RETURN_OR_DISPUTE', 'SECURITY_EVENT', 'BRAND_REQUEST_DECISION',
        'CARRIER_ARRANGEMENT_DECISION', 'CARRIER_ACCEPTED', 'CARRIER_REJECTED',
        'CARRIER_OFFER_EXPIRED',
        'FULFILMENT_METHOD_DECISION', 'CARRIER_CONNECTION_FAILED',
        'PARTNER_INVITATION_RESULT', 'CONSIGNMENT_AWAITING_METHOD'
    ) NOT NULL;

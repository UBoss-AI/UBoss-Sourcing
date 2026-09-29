-- DOD-019: every table carries `createdAt` and `updatedAt`.
--
-- 126 tables had one or neither. Each gets the missing column(s) as
-- DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), matching schema.prisma's
-- `@default(now())` / `@default(now()) @updatedAt`. The database default is
-- deliberate even for `updatedAt`: raw INSERTs and `createMany` elsewhere in
-- the code do not name these columns, and a column with no default would make
-- every one of them fail. Domain timestamps (receivedAt, assignedAt, ...) stay
-- alongside; they mean something the row-level stamps do not.
--
-- Backfill, so existing rows do not all claim to have been created today:
--   * createdAt comes from the table's own "when this row came into being"
--     column where it has one (receivedAt, startedAt, assignedAt, ...). The
--     nine tables with no such column (permissions, role_permissions,
--     product_attributes, product_variant_attributes, product_pack_dimensions,
--     import_row_errors, coupon_categories, coupon_minimums,
--     commission_invoice_lines) keep the migration time: nothing earlier is
--     known about those rows.
--   * updatedAt is the latest of createdAt and every past-tense timestamp on
--     the row (consumedAt, revokedAt, processedAt, ...). Future-facing ones -
--     expiresAt, nextRetryAt, plannedRunAt, delivery dates - are excluded.
--
-- Size and locking. One ALTER per table carrying every ADD COLUMN it needs, so
-- each table is rebuilt at most once. No ALGORITHM clause: MariaDB picks
-- INSTANT/INPLACE where it can, and naming one it cannot use aborts the
-- migration instead of falling back. The largest tables touched here in the
-- development data are inventory_movements, audit_logs, product_attributes
-- and product_pack_dimensions (a few thousand rows each). On a production
-- database with millions of audit or movement rows, run this in a
-- maintenance window: the ALTER itself is online, the backfill UPDATE is a
-- full-table write. Works unchanged on MariaDB 10.4 and 11.4.
--
-- audit_logs is append-only for the application account. Its new updatedAt
-- is written only when the maintenance account pseudonymises a row on a GDPR
-- erasure, so deploy/mariadb/post-migrate-grants.sql adds updatedAt to that
-- account's column-level UPDATE grant in the same change.

ALTER TABLE `permissions` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

ALTER TABLE `role_permissions` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

ALTER TABLE `user_roles` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `user_roles` SET `createdAt` = `assignedAt`, `updatedAt` = `assignedAt`;

ALTER TABLE `sessions` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `sessions` SET `updatedAt` = GREATEST(`createdAt`, COALESCE(`locationCapturedAt`, `createdAt`), COALESCE(`mfaVerifiedAt`, `createdAt`), COALESCE(`reauthenticatedAt`, `createdAt`), COALESCE(`sellerUnlockedAt`, `createdAt`), COALESCE(`sellerLastActivityAt`, `createdAt`), COALESCE(`revokedAt`, `createdAt`), COALESCE(`familyStartedAt`, `createdAt`), COALESCE(`lastUsedAt`, `createdAt`));

ALTER TABLE `auth_tokens` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `auth_tokens` SET `updatedAt` = GREATEST(`createdAt`, COALESCE(`consumedAt`, `createdAt`));

ALTER TABLE `login_attempts` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `login_attempts` SET `updatedAt` = `createdAt`;

ALTER TABLE `feature_flags` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `feature_flags` SET `createdAt` = `updatedAt`;

ALTER TABLE `media_assets` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `media_assets` SET `updatedAt` = `createdAt`;

ALTER TABLE `product_variant_media` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `product_variant_media` SET `updatedAt` = `createdAt`;

ALTER TABLE `product_media` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `product_media` SET `updatedAt` = `createdAt`;

ALTER TABLE `product_attributes` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

ALTER TABLE `product_variant_attributes` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

ALTER TABLE `product_pack_dimensions` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

ALTER TABLE `warehouse_country_exclusions` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `warehouse_country_exclusions` SET `updatedAt` = `createdAt`;

ALTER TABLE `inventory_balances` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `inventory_balances` SET `createdAt` = `updatedAt`;

ALTER TABLE `inventory_movements` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `inventory_movements` SET `updatedAt` = `createdAt`;

ALTER TABLE `stock_reservations` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `stock_reservations` SET `updatedAt` = GREATEST(`createdAt`, COALESCE(`committedAt`, `createdAt`), COALESCE(`releasedAt`, `createdAt`));

ALTER TABLE `order_items` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `order_items` SET `updatedAt` = GREATEST(`createdAt`, COALESCE(`productInfoCapturedAt`, `createdAt`));

ALTER TABLE `order_status_history` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `order_status_history` SET `updatedAt` = `createdAt`;

ALTER TABLE `order_approvals` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `order_approvals` SET `updatedAt` = GREATEST(`createdAt`, COALESCE(`decidedAt`, `createdAt`));

ALTER TABLE `idempotency_records` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `idempotency_records` SET `updatedAt` = GREATEST(`createdAt`, COALESCE(`completedAt`, `createdAt`));

ALTER TABLE `payment_events` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `payment_events` SET `createdAt` = `receivedAt`, `updatedAt` = GREATEST(`receivedAt`, COALESCE(`processedAt`, `receivedAt`), COALESCE(`attemptStartedAt`, `receivedAt`));

ALTER TABLE `payment_links` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `payment_links` SET `updatedAt` = GREATEST(`createdAt`, COALESCE(`sentAt`, `createdAt`), COALESCE(`openedAt`, `createdAt`), COALESCE(`usedAt`, `createdAt`), COALESCE(`revokedAt`, `createdAt`));

ALTER TABLE `schedule_occurrences` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `schedule_occurrences` SET `updatedAt` = GREATEST(`createdAt`, COALESCE(`lastAttemptAt`, `createdAt`), COALESCE(`actionRequiredAt`, `createdAt`), COALESCE(`reminderSentAt`, `createdAt`), COALESCE(`completedAt`, `createdAt`));

ALTER TABLE `fulfilment_quotes` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `fulfilment_quotes` SET `updatedAt` = `createdAt`;

ALTER TABLE `return_request_lines` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `return_request_lines` SET `updatedAt` = `createdAt`;

ALTER TABLE `return_request_events` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `return_request_events` SET `updatedAt` = `createdAt`;

ALTER TABLE `return_request_files` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `return_request_files` SET `updatedAt` = `createdAt`;

ALTER TABLE `sync_runs` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `sync_runs` SET `createdAt` = `startedAt`, `updatedAt` = GREATEST(`startedAt`, COALESCE(`finishedAt`, `startedAt`));

ALTER TABLE `sync_errors` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `sync_errors` SET `updatedAt` = `createdAt`;

ALTER TABLE `import_jobs` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `import_jobs` SET `updatedAt` = GREATEST(`createdAt`, COALESCE(`startedAt`, `createdAt`), COALESCE(`completedAt`, `createdAt`));

ALTER TABLE `import_row_errors` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

ALTER TABLE `export_jobs` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `export_jobs` SET `updatedAt` = GREATEST(`createdAt`, COALESCE(`downloadedAt`, `createdAt`), COALESCE(`completedAt`, `createdAt`));

ALTER TABLE `notification_deliveries` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `notification_deliveries` SET `updatedAt` = `createdAt`;

ALTER TABLE `admin_notifications` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `admin_notifications` SET `updatedAt` = GREATEST(`createdAt`, COALESCE(`resolvedAt`, `createdAt`));

ALTER TABLE `admin_notification_reads` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `admin_notification_reads` SET `createdAt` = `readAt`, `updatedAt` = GREATEST(`readAt`, COALESCE(`dismissedAt`, `readAt`));

ALTER TABLE `rate_limit_buckets` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `rate_limit_buckets` SET `createdAt` = `updatedAt`;

ALTER TABLE `audit_logs` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `audit_logs` SET `updatedAt` = `createdAt`;

ALTER TABLE `number_sequences` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `number_sequences` SET `createdAt` = `updatedAt`;

ALTER TABLE `exchange_rates` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `exchange_rates` SET `updatedAt` = `createdAt`;

ALTER TABLE `coupon_categories` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

ALTER TABLE `coupon_minimums` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

ALTER TABLE `coupon_redemptions` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `coupon_redemptions` SET `createdAt` = `redeemedAt`, `updatedAt` = `redeemedAt`;

ALTER TABLE `assistant_messages` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `assistant_messages` SET `updatedAt` = `createdAt`;

ALTER TABLE `vat_number_checks` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `vat_number_checks` SET `createdAt` = `checkedAt`, `updatedAt` = `checkedAt`;

ALTER TABLE `invoices` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `invoices` SET `updatedAt` = GREATEST(`createdAt`, COALESCE(`issuedAt`, `createdAt`), COALESCE(`suppliedAt`, `createdAt`));

ALTER TABLE `product_country_restrictions` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `product_country_restrictions` SET `updatedAt` = `createdAt`;

ALTER TABLE `erp_inventory_sync_runs` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `erp_inventory_sync_runs` SET `createdAt` = `startedAt`, `updatedAt` = GREATEST(`startedAt`, COALESCE(`finishedAt`, `startedAt`));

ALTER TABLE `erp_sync_record_errors` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `erp_sync_record_errors` SET `updatedAt` = `createdAt`;

ALTER TABLE `erp_webhook_receipts` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `erp_webhook_receipts` SET `createdAt` = `receivedAt`, `updatedAt` = GREATEST(`receivedAt`, COALESCE(`processedAt`, `receivedAt`));

ALTER TABLE `wishlist_items` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `wishlist_items` SET `updatedAt` = `createdAt`;

ALTER TABLE `support_ticket_events` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `support_ticket_events` SET `updatedAt` = `createdAt`;

ALTER TABLE `support_ticket_attachments` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `support_ticket_attachments` SET `updatedAt` = `createdAt`;

ALTER TABLE `dispute_events` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `dispute_events` SET `updatedAt` = `createdAt`;

ALTER TABLE `dispute_attachments` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `dispute_attachments` SET `updatedAt` = `createdAt`;

ALTER TABLE `buyer_organization_members` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `buyer_organization_members` SET `createdAt` = `joinedAt`;

ALTER TABLE `buyer_organization_invites` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `buyer_organization_invites` SET `updatedAt` = GREATEST(`createdAt`, COALESCE(`acceptedAt`, `createdAt`), COALESCE(`revokedAt`, `createdAt`));

ALTER TABLE `customer_erp_sync_jobs` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `customer_erp_sync_jobs` SET `createdAt` = `startedAt`, `updatedAt` = GREATEST(`startedAt`, COALESCE(`finishedAt`, `startedAt`));

ALTER TABLE `customer_erp_webhook_events` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `customer_erp_webhook_events` SET `createdAt` = `receivedAt`, `updatedAt` = GREATEST(`receivedAt`, COALESCE(`processedAt`, `receivedAt`));

ALTER TABLE `customer_erp_approvals` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `customer_erp_approvals` SET `createdAt` = `requestedAt`, `updatedAt` = GREATEST(`requestedAt`, COALESCE(`decidedAt`, `requestedAt`));

ALTER TABLE `customer_erp_oauth_states` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `customer_erp_oauth_states` SET `updatedAt` = GREATEST(`createdAt`, COALESCE(`consumedAt`, `createdAt`));

ALTER TABLE `customer_erp_audit_logs` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `customer_erp_audit_logs` SET `updatedAt` = `createdAt`;

ALTER TABLE `seller_members` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `seller_members` SET `createdAt` = `joinedAt`;

ALTER TABLE `seller_invitations` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `seller_invitations` SET `updatedAt` = GREATEST(`createdAt`, COALESCE(`acceptedAt`, `createdAt`), COALESCE(`revokedAt`, `createdAt`));

ALTER TABLE `seller_agreement_acceptances` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `seller_agreement_acceptances` SET `createdAt` = `acceptedAt`, `updatedAt` = `acceptedAt`;

ALTER TABLE `seller_listing_issues` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `seller_listing_issues` SET `updatedAt` = GREATEST(`createdAt`, COALESCE(`resolvedAt`, `createdAt`));

ALTER TABLE `seller_inventory_movements` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `seller_inventory_movements` SET `updatedAt` = `createdAt`;

ALTER TABLE `seller_bulk_import_row_errors` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `seller_bulk_import_row_errors` SET `updatedAt` = `createdAt`;

ALTER TABLE `seller_settlement_lines` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `seller_settlement_lines` SET `updatedAt` = GREATEST(`createdAt`, COALESCE(`occurredAt`, `createdAt`));

ALTER TABLE `seller_notifications` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `seller_notifications` SET `updatedAt` = GREATEST(`createdAt`, COALESCE(`resolvedAt`, `createdAt`));

ALTER TABLE `seller_audit_logs` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `seller_audit_logs` SET `updatedAt` = `createdAt`;

ALTER TABLE `shipment_purchases` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `shipment_purchases` SET `updatedAt` = GREATEST(`createdAt`, COALESCE(`completedAt`, `createdAt`));

ALTER TABLE `seller_logistics_relationship_events` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `seller_logistics_relationship_events` SET `updatedAt` = `createdAt`;

ALTER TABLE `logistics_partner_profile_changes` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `logistics_partner_profile_changes` SET `createdAt` = `requestedAt`, `updatedAt` = GREATEST(`requestedAt`, COALESCE(`decidedAt`, `requestedAt`));

ALTER TABLE `logistics_partner_documents` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `logistics_partner_documents` SET `updatedAt` = GREATEST(`createdAt`, COALESCE(`reviewedAt`, `createdAt`), COALESCE(`supersededAt`, `createdAt`));

ALTER TABLE `logistics_partner_invitations` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `logistics_partner_invitations` SET `updatedAt` = GREATEST(`createdAt`, COALESCE(`acceptedAt`, `createdAt`), COALESCE(`revokedAt`, `createdAt`));

ALTER TABLE `logistics_shipment_events` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `logistics_shipment_events` SET `updatedAt` = GREATEST(`createdAt`, COALESCE(`occurredAt`, `createdAt`), COALESCE(`recordedAt`, `createdAt`));

ALTER TABLE `logistics_shipment_documents` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `logistics_shipment_documents` SET `updatedAt` = GREATEST(`createdAt`, COALESCE(`scannedAt`, `createdAt`), COALESCE(`deletedAt`, `createdAt`));

ALTER TABLE `logistics_delivery_codes` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `logistics_delivery_codes` SET `updatedAt` = GREATEST(`createdAt`, COALESCE(`consumedAt`, `createdAt`), COALESCE(`supersededAt`, `createdAt`));

ALTER TABLE `logistics_dispatch_manifest_entries` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `logistics_dispatch_manifest_entries` SET `createdAt` = `addedAt`, `updatedAt` = GREATEST(`addedAt`, COALESCE(`removedAt`, `addedAt`));

ALTER TABLE `logistics_location_pings` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `logistics_location_pings` SET `createdAt` = `receivedAt`, `updatedAt` = `receivedAt`;

ALTER TABLE `carrier_webhook_events` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `carrier_webhook_events` SET `createdAt` = `receivedAt`, `updatedAt` = GREATEST(`receivedAt`, COALESCE(`processedAt`, `receivedAt`), COALESCE(`deadLetteredAt`, `receivedAt`));

ALTER TABLE `logistics_notifications` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `logistics_notifications` SET `updatedAt` = GREATEST(`createdAt`, COALESCE(`resolvedAt`, `createdAt`), COALESCE(`readAt`, `createdAt`), COALESCE(`emailedAt`, `createdAt`));

ALTER TABLE `logistics_audit_logs` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `logistics_audit_logs` SET `updatedAt` = `createdAt`;

ALTER TABLE `cart_item_packaging` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `cart_item_packaging` SET `createdAt` = `snapshotAt`, `updatedAt` = `snapshotAt`;

ALTER TABLE `order_item_packaging` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `order_item_packaging` SET `updatedAt` = GREATEST(`createdAt`, COALESCE(`snapshotAt`, `createdAt`));

ALTER TABLE `seller_erp_pairing_codes` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `seller_erp_pairing_codes` SET `updatedAt` = GREATEST(`createdAt`, COALESCE(`consumedAt`, `createdAt`));

ALTER TABLE `seller_erp_master_cache` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `seller_erp_master_cache` SET `createdAt` = `lastSeenAt`, `updatedAt` = `lastSeenAt`;

ALTER TABLE `seller_erp_sync_attempts` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `seller_erp_sync_attempts` SET `updatedAt` = GREATEST(`createdAt`, COALESCE(`startedAt`, `createdAt`), COALESCE(`finishedAt`, `createdAt`));

ALTER TABLE `seller_erp_audit_events` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `seller_erp_audit_events` SET `updatedAt` = `createdAt`;

ALTER TABLE `seller_logistics_policy_versions` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `seller_logistics_policy_versions` SET `createdAt` = `publishedAt`, `updatedAt` = GREATEST(`publishedAt`, COALESCE(`supersededAt`, `publishedAt`));

ALTER TABLE `order_logistics_legs` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `order_logistics_legs` SET `updatedAt` = `createdAt`;

ALTER TABLE `shipment_leg_events` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `shipment_leg_events` SET `createdAt` = `occurredAt`, `updatedAt` = `occurredAt`;

ALTER TABLE `seller_order_settlements` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `seller_order_settlements` SET `createdAt` = `computedAt`, `updatedAt` = `computedAt`;

ALTER TABLE `preorder_price_tiers` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `preorder_price_tiers` SET `updatedAt` = `createdAt`;

ALTER TABLE `preorder_status_history` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `preorder_status_history` SET `updatedAt` = `createdAt`;

ALTER TABLE `preorder_stock_holds` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `preorder_stock_holds` SET `updatedAt` = GREATEST(`createdAt`, COALESCE(`releasedAt`, `createdAt`));

ALTER TABLE `customer_acknowledgements` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `customer_acknowledgements` SET `createdAt` = `acknowledgedAt`, `updatedAt` = `acknowledgedAt`;

ALTER TABLE `preorder_chat_participants` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `preorder_chat_participants` SET `createdAt` = `joinedAt`, `updatedAt` = GREATEST(`joinedAt`, COALESCE(`lastReadAt`, `joinedAt`));

ALTER TABLE `preorder_chat_messages` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `preorder_chat_messages` SET `updatedAt` = GREATEST(`createdAt`, COALESCE(`deliveredAt`, `createdAt`), COALESCE(`editedAt`, `createdAt`), COALESCE(`redactedAt`, `createdAt`));

ALTER TABLE `preorder_chat_attachments` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `preorder_chat_attachments` SET `updatedAt` = `createdAt`;

ALTER TABLE `preorder_chat_customer_blocks` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `preorder_chat_customer_blocks` SET `updatedAt` = `createdAt`;

ALTER TABLE `realtime_events` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `realtime_events` SET `updatedAt` = `createdAt`;

ALTER TABLE `logistics_shipment_package_lines` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `logistics_shipment_package_lines` SET `updatedAt` = `createdAt`;

ALTER TABLE `buyer_company_verification_cases` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `buyer_company_verification_cases` SET `createdAt` = `openedAt`, `updatedAt` = GREATEST(`openedAt`, COALESCE(`assignedAt`, `openedAt`), COALESCE(`firstApprovalAt`, `openedAt`), COALESCE(`closedAt`, `openedAt`));

ALTER TABLE `buyer_company_checks` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `buyer_company_checks` SET `createdAt` = `checkedAt`, `updatedAt` = `checkedAt`;

ALTER TABLE `buyer_company_info_requests` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `buyer_company_info_requests` SET `updatedAt` = GREATEST(`createdAt`, COALESCE(`respondedAt`, `createdAt`));

ALTER TABLE `buyer_company_review_events` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `buyer_company_review_events` SET `updatedAt` = `createdAt`;

ALTER TABLE `buyer_company_status_history` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `buyer_company_status_history` SET `updatedAt` = `createdAt`;

ALTER TABLE `consent_records` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `consent_records` SET `createdAt` = `acceptedAt`, `updatedAt` = GREATEST(`acceptedAt`, COALESCE(`withdrawnAt`, `acceptedAt`));

ALTER TABLE `buyer_company_email_challenges` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `buyer_company_email_challenges` SET `updatedAt` = GREATEST(`createdAt`, COALESCE(`consumedAt`, `createdAt`));

ALTER TABLE `commission_invoice_lines` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

ALTER TABLE `commission_credit_notes` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `commission_credit_notes` SET `updatedAt` = GREATEST(`createdAt`, COALESCE(`issuedAt`, `createdAt`));

ALTER TABLE `commission_documents` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `commission_documents` SET `updatedAt` = `createdAt`;

ALTER TABLE `commission_invoice_events` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `commission_invoice_events` SET `updatedAt` = `createdAt`;

ALTER TABLE `inspection_policies` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `inspection_policies` SET `createdAt` = `updatedAt`;

ALTER TABLE `inspection_supplier_risks` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `inspection_supplier_risks` SET `createdAt` = `setAt`, `updatedAt` = `setAt`;

ALTER TABLE `inspection_conflict_declarations` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `inspection_conflict_declarations` SET `createdAt` = `declaredAt`, `updatedAt` = `declaredAt`;

ALTER TABLE `inspection_check_results` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `inspection_check_results` SET `createdAt` = `recordedAt`, `updatedAt` = `recordedAt`;

ALTER TABLE `inspection_defects` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `inspection_defects` SET `createdAt` = `recordedAt`, `updatedAt` = GREATEST(`recordedAt`, COALESCE(`reclassifiedAt`, `recordedAt`), COALESCE(`capaSubmittedAt`, `recordedAt`), COALESCE(`verifiedAt`, `recordedAt`));

ALTER TABLE `inspection_evidence` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `inspection_evidence` SET `createdAt` = `receivedAt`, `updatedAt` = GREATEST(`receivedAt`, COALESCE(`capturedAt`, `receivedAt`));

ALTER TABLE `inspection_reports` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `inspection_reports` SET `createdAt` = `submittedAt`, `updatedAt` = GREATEST(`submittedAt`, COALESCE(`returnedAt`, `submittedAt`), COALESCE(`publishedToBuyerAt`, `submittedAt`));

ALTER TABLE `inspection_releases` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `inspection_releases` SET `updatedAt` = GREATEST(`createdAt`, COALESCE(`requestedAt`, `createdAt`), COALESCE(`approvedAt`, `createdAt`), COALESCE(`rejectedAt`, `createdAt`), COALESCE(`supersededAt`, `createdAt`));

ALTER TABLE `inspection_shipment_bindings` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `inspection_shipment_bindings` SET `updatedAt` = GREATEST(`createdAt`, COALESCE(`stuffedAt`, `createdAt`));

ALTER TABLE `inspection_agency_invoices` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `inspection_agency_invoices` SET `createdAt` = `submittedAt`, `updatedAt` = GREATEST(`submittedAt`, COALESCE(`decidedAt`, `submittedAt`), COALESCE(`paidAt`, `submittedAt`));

ALTER TABLE `inspection_events` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `inspection_events` SET `updatedAt` = `createdAt`;

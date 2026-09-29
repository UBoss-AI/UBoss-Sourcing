-- DOD-019, second pass: every table carries `createdAt` and `updatedAt`.
--
-- 20261017200000_created_updated_timestamps brought every table of its day
-- into line. The 23 tables below arrived afterwards (payments, trust,
-- markets, production, trade documents, logistics lanes, the ledger and
-- payouts) without one or both columns, and tests/unit/row-timestamps.test.ts
-- has been red since. Same form as before: DATETIME(3) NOT NULL DEFAULT
-- CURRENT_TIMESTAMP(3), matching schema.prisma's `@default(now())` /
-- `@default(now()) @updatedAt`. The database default is deliberate even for
-- `updatedAt`, so any raw INSERT or `createMany` that does not name the
-- column keeps working.
--
-- Backfill, so existing rows do not all claim to have been created today:
--   * createdAt comes from the row's own "came into being" column where it
--     has one (heldAt, raisedAt, receivedAt, startedAt), from its ledger
--     entry for ledger_lines, and from updatedAt for the three settings
--     singletons (the earliest moment known about them). The rest keep the
--     migration time: nothing earlier is known about those rows.
--   * updatedAt is the latest of createdAt and every past-tense timestamp on
--     the row (decidedAt, releasedAt, resolvedAt, ...).
--
-- One ALTER per table. No ALGORITHM clause, so MariaDB picks INSTANT/INPLACE
-- where it can. Works unchanged on MariaDB 10.4 and 11.4.

ALTER TABLE `payment_receipts` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `payment_receipts` SET `updatedAt` = GREATEST(`createdAt`, `issuedAt`);

ALTER TABLE `platform_fee_rule_applications` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `platform_fee_rule_applications` SET `updatedAt` = `createdAt`;

ALTER TABLE `buyer_company_order_approvals` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `buyer_company_order_approvals` SET `updatedAt` = GREATEST(`createdAt`, COALESCE(`decidedAt`, `createdAt`));

ALTER TABLE `trust_settings` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `trust_settings` SET `createdAt` = `updatedAt`, `updatedAt` = `updatedAt`;

ALTER TABLE `seller_factory_machines` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

ALTER TABLE `seller_factory_evidence` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `seller_factory_evidence` SET `updatedAt` = `createdAt`;

ALTER TABLE `seller_listing_certifications` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

ALTER TABLE `seller_offer_compliance_holds` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `seller_offer_compliance_holds` SET `createdAt` = `heldAt`, `updatedAt` = GREATEST(`heldAt`, COALESCE(`releasedAt`, `heldAt`));

ALTER TABLE `market_profiles` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `market_profiles` SET `createdAt` = `updatedAt`, `updatedAt` = `updatedAt`;

ALTER TABLE `search_query_logs` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `search_query_logs` SET `updatedAt` = `createdAt`;

ALTER TABLE `seller_production_delays` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `seller_production_delays` SET `createdAt` = `raisedAt`, `updatedAt` = GREATEST(`raisedAt`, COALESCE(`resolvedAt`, `raisedAt`));

ALTER TABLE `seller_order_buyer_updates` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `seller_order_buyer_updates` SET `updatedAt` = `createdAt`;

ALTER TABLE `order_trade_document_versions` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `order_trade_document_versions` SET `updatedAt` = GREATEST(`createdAt`, COALESCE(`validatedAt`, `createdAt`), COALESCE(`supersededAt`, `createdAt`));

ALTER TABLE `order_trade_document_events` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `order_trade_document_events` SET `updatedAt` = `createdAt`;

ALTER TABLE `logistics_trade_settings` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `logistics_trade_settings` SET `createdAt` = `updatedAt`, `updatedAt` = `updatedAt`;

ALTER TABLE `logistics_lane_bands` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

ALTER TABLE `ledger_accounts` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `ledger_accounts` SET `updatedAt` = `createdAt`;

ALTER TABLE `ledger_entries` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `ledger_entries` SET `updatedAt` = `createdAt`;

ALTER TABLE `ledger_lines` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `ledger_lines` AS `l` INNER JOIN `ledger_entries` AS `e` ON `e`.`id` = `l`.`entryId` SET `l`.`createdAt` = `e`.`createdAt`, `l`.`updatedAt` = `e`.`createdAt`;

ALTER TABLE `seller_fund_release_requests` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `seller_fund_release_requests` SET `updatedAt` = GREATEST(`createdAt`, COALESCE(`decidedAt`, `createdAt`));

ALTER TABLE `payout_provider_events` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `payout_provider_events` SET `createdAt` = `receivedAt`, `updatedAt` = GREATEST(`receivedAt`, COALESCE(`processedAt`, `receivedAt`));

ALTER TABLE `ledger_reconciliation_runs` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `ledger_reconciliation_runs` SET `createdAt` = `startedAt`, `updatedAt` = GREATEST(`startedAt`, COALESCE(`completedAt`, `startedAt`));

ALTER TABLE `ledger_reconciliation_items` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `ledger_reconciliation_items` SET `updatedAt` = `createdAt`;

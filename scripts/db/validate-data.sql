-- ===========================================================================
-- UBOSS - data validation
--
-- Every query below returns one row: a check name, a count, and the count that
-- means "this is fine". Run the whole file against a database and the output
-- is a report you can diff against the same report taken before a migration.
--
--   scripts\db\validate-data.ps1                      (runs this, with a verdict)
--   mariadb uboss < scripts/db/validate-data.sql      (by hand, on the VPS)
--
-- READ-ONLY. Nothing here writes, locks or changes anything. It is safe to run
-- against production, and it is meant to be - a validation that only ever runs
-- somewhere else is a validation of somewhere else.
--
-- NO PERSONAL DATA IS RETURNED. Every query counts rows or returns an
-- identifier; none returns an email address, a name, an address or an amount
-- tied to a person. The output of this file can be pasted into a ticket.
--
-- WHAT "EXPECTED" MEANS
--
-- Most checks expect 0: a non-zero is a defect. Three of them - the table
-- count, the row counts and the auto-increment high-water marks - expect
-- nothing in particular and exist to be COMPARED between two runs. A row count
-- that fell between the pre-migration and post-migration report is the single
-- most important number in a migration rehearsal.
-- ===========================================================================

SELECT '=== INVENTORY ===' AS check_name, NULL AS actual, NULL AS expected;

-- --- Shape -----------------------------------------------------------------

SELECT 'tables'                         AS check_name,
       COUNT(*)                         AS actual,
       'compare between runs'           AS expected
  FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE();

SELECT 'tables not using InnoDB'        AS check_name,
       COUNT(*)                         AS actual,
       '0'                              AS expected
  FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE()
   AND ENGINE IS NOT NULL AND ENGINE <> 'InnoDB';

-- Mixed collations are how "Illegal mix of collations" appears in production
-- six months after somebody created one table without an explicit COLLATE.
SELECT 'distinct table collations'      AS check_name,
       COUNT(DISTINCT TABLE_COLLATION)  AS actual,
       '1 (utf8mb4_unicode_ci)'         AS expected
  FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_COLLATION IS NOT NULL;

-- Money must never be a binary float. Every monetary amount in this schema is
-- a BIGINT of minor units; a FLOAT or DOUBLE anywhere is a column added the
-- wrong way, and the symptom is a total that is out by a hundredth of a unit
-- in a way nobody can reproduce.
SELECT 'binary floating-point columns'  AS check_name,
       COUNT(*)                         AS actual,
       '0'                              AS expected
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND DATA_TYPE IN ('float', 'double', 'real');

SELECT '=== ROW COUNTS (compare between runs) ===' AS check_name, NULL, NULL;

-- Exact counts, not information_schema estimates. The estimates are derived
-- from InnoDB sampling and can be out by tens of percent, which makes them
-- useless for the one job this section has: proving nothing was lost.
SELECT 'users',                 COUNT(*), 'compare' FROM users;
SELECT 'customer_profiles',     COUNT(*), 'compare' FROM customer_profiles;
SELECT 'buyer_organizations',   COUNT(*), 'compare' FROM buyer_organizations;
SELECT 'seller_accounts',       COUNT(*), 'compare' FROM seller_accounts;
SELECT 'logistics_partners',    COUNT(*), 'compare' FROM logistics_partners;
SELECT 'products',              COUNT(*), 'compare' FROM products;
SELECT 'product_variants',      COUNT(*), 'compare' FROM product_variants;
SELECT 'seller_offers',         COUNT(*), 'compare' FROM seller_offers;
SELECT 'categories',            COUNT(*), 'compare' FROM categories;
SELECT 'inventory_locations',   COUNT(*), 'compare' FROM inventory_locations;
SELECT 'inventory_balances',    COUNT(*), 'compare' FROM inventory_balances;
SELECT 'inventory_movements',   COUNT(*), 'compare' FROM inventory_movements;
SELECT 'orders',                COUNT(*), 'compare' FROM orders;
SELECT 'order_items',           COUNT(*), 'compare' FROM order_items;
SELECT 'payment_transactions',  COUNT(*), 'compare' FROM payment_transactions;
SELECT 'refunds',               COUNT(*), 'compare' FROM refunds;
SELECT 'seller_settlements',    COUNT(*), 'compare' FROM seller_settlements;
SELECT 'recurring_schedules',   COUNT(*), 'compare' FROM recurring_schedules;
SELECT 'schedule_occurrences',  COUNT(*), 'compare' FROM schedule_occurrences;
SELECT 'shipments',             COUNT(*), 'compare' FROM shipments;
SELECT 'logistics_shipments',   COUNT(*), 'compare' FROM logistics_shipments;
SELECT 'audit_logs',            COUNT(*), 'compare' FROM audit_logs;
SELECT 'invoices',              COUNT(*), 'compare' FROM invoices;

SELECT '=== REFERENTIAL INTEGRITY ===' AS check_name, NULL, NULL;

-- Orphans. Every one of these relationships has a foreign key, so a non-zero
-- here means the constraint was dropped, the rows were loaded with
-- FOREIGN_KEY_CHECKS off, or the import put them in the wrong order. A dump
-- restored with `--disable-keys` and no re-check is the usual culprit.
SELECT 'order_items with no order',      COUNT(*), '0'
  FROM order_items oi LEFT JOIN orders o ON o.id = oi.orderId WHERE o.id IS NULL;

SELECT 'orders with no customer',        COUNT(*), '0'
  FROM orders o LEFT JOIN customer_profiles c ON c.id = o.customerProfileId WHERE c.id IS NULL;

SELECT 'order_items with no product',    COUNT(*), '0'
  FROM order_items oi LEFT JOIN products p ON p.id = oi.productId WHERE p.id IS NULL;

SELECT 'inventory_balances with no product', COUNT(*), '0'
  FROM inventory_balances b LEFT JOIN products p ON p.id = b.productId WHERE p.id IS NULL;

SELECT 'inventory_balances with no location', COUNT(*), '0'
  FROM inventory_balances b LEFT JOIN inventory_locations l ON l.id = b.locationId WHERE l.id IS NULL;

SELECT 'payments with no order',         COUNT(*), '0'
  FROM payment_transactions t LEFT JOIN orders o ON o.id = t.orderId WHERE o.id IS NULL;

SELECT 'refunds with no order',          COUNT(*), '0'
  FROM refunds r LEFT JOIN orders o ON o.id = r.orderId WHERE o.id IS NULL;

SELECT 'occurrences with no schedule',   COUNT(*), '0'
  FROM schedule_occurrences s LEFT JOIN recurring_schedules r ON r.id = s.scheduleId WHERE r.id IS NULL;

SELECT 'seller_offers with no seller',   COUNT(*), '0'
  FROM seller_offers so LEFT JOIN seller_accounts sa ON sa.id = so.sellerAccountId WHERE sa.id IS NULL;

SELECT 'customer_profiles with no user', COUNT(*), '0'
  FROM customer_profiles c LEFT JOIN users u ON u.id = c.userId WHERE u.id IS NULL;

SELECT '=== UNIQUENESS AND IDEMPOTENCY ===' AS check_name, NULL, NULL;

-- Each of these has a UNIQUE index, so each should be structurally impossible.
-- They are checked anyway, because a restore that hit a duplicate and was run
-- with `--force` drops the index rather than the row, and the next thing that
-- happens is a customer charged twice for one basket.
SELECT 'duplicate normalised emails',    COUNT(*), '0' FROM (
  SELECT emailNormalized FROM users WHERE emailNormalized IS NOT NULL
   GROUP BY emailNormalized HAVING COUNT(*) > 1) d;

SELECT 'duplicate product SKUs',         COUNT(*), '0' FROM (
  SELECT sku FROM products WHERE sku IS NOT NULL GROUP BY sku HAVING COUNT(*) > 1) d;

-- A seller's SKU is unique WITHIN that seller, never globally. Two sellers
-- listing the same manufacturer's part number is normal trade, not a defect.
SELECT 'duplicate seller SKUs per seller', COUNT(*), '0' FROM (
  SELECT sellerAccountId, sellerSku FROM seller_offers WHERE sellerSku IS NOT NULL
   GROUP BY sellerAccountId, sellerSku HAVING COUNT(*) > 1) d;

SELECT 'duplicate order numbers',        COUNT(*), '0' FROM (
  SELECT orderNumber FROM orders GROUP BY orderNumber HAVING COUNT(*) > 1) d;

SELECT 'duplicate payment idempotency keys', COUNT(*), '0' FROM (
  SELECT idempotencyKey FROM payment_transactions WHERE idempotencyKey IS NOT NULL
   GROUP BY idempotencyKey HAVING COUNT(*) > 1) d;

SELECT 'duplicate refund idempotency keys', COUNT(*), '0' FROM (
  SELECT idempotencyKey FROM refunds WHERE idempotencyKey IS NOT NULL
   GROUP BY idempotencyKey HAVING COUNT(*) > 1) d;

SELECT 'duplicate scheduled occurrences', COUNT(*), '0' FROM (
  SELECT scheduleId, plannedRunAt FROM schedule_occurrences
   GROUP BY scheduleId, plannedRunAt HAVING COUNT(*) > 1) d;

SELECT 'duplicate ERP push idempotency keys', COUNT(*), '0' FROM (
  SELECT idempotencyKey FROM erp_order_pushes WHERE idempotencyKey IS NOT NULL
   GROUP BY idempotencyKey HAVING COUNT(*) > 1) d;

SELECT 'duplicate provider webhook events', COUNT(*), '0' FROM (
  SELECT providerEventId FROM payment_events WHERE providerEventId IS NOT NULL
   GROUP BY providerEventId HAVING COUNT(*) > 1) d;

SELECT 'duplicate inventory movement dedupe keys', COUNT(*), '0' FROM (
  SELECT dedupeKey FROM inventory_movements WHERE dedupeKey IS NOT NULL
   GROUP BY dedupeKey HAVING COUNT(*) > 1) d;

-- Two orders claiming the same scheduled occurrence means one basket was
-- charged twice. There is a unique index; this is the belt to its braces.
SELECT 'occurrences claimed by 2+ orders', COUNT(*), '0' FROM (
  SELECT scheduleOccurrenceId FROM orders WHERE scheduleOccurrenceId IS NOT NULL
   GROUP BY scheduleOccurrenceId HAVING COUNT(*) > 1) d;

SELECT '=== MONEY ===' AS check_name, NULL, NULL;

-- A total that does not equal the sum of its lines. The arithmetic is
-- subtotal - discount + tax + shipping, all in minor units, and it is done in
-- the application; this proves the stored result still agrees with it.
SELECT 'orders whose total <> its parts', COUNT(*), '0'
  FROM orders
 WHERE grandTotalMinor <> (subtotalMinor - discountMinor + taxMinor + shippingMinor);

SELECT 'orders whose subtotal <> sum of lines', COUNT(*), '0' FROM (
  SELECT o.id
    FROM orders o
    JOIN order_items i ON i.orderId = o.id
   GROUP BY o.id, o.subtotalMinor
  HAVING o.subtotalMinor <> SUM(i.lineSubtotalMinor)) d;

SELECT 'negative order totals',          COUNT(*), '0'
  FROM orders WHERE grandTotalMinor < 0 OR subtotalMinor < 0 OR taxMinor < 0 OR shippingMinor < 0;

SELECT 'orders paid more than they cost', COUNT(*), '0'
  FROM orders WHERE paidMinor > grandTotalMinor;

SELECT 'orders refunded more than paid', COUNT(*), '0'
  FROM orders WHERE refundedMinor > paidMinor;

SELECT 'refunds larger than their payment', COUNT(*), '0'
  FROM refunds r JOIN payment_transactions t ON t.id = r.paymentTransactionId
 WHERE r.status = 'SUCCEEDED' AND r.amountMinor > t.capturedMinor;

SELECT 'settlements whose net <> its parts', COUNT(*), '0'
  FROM seller_settlements
 WHERE netPayableMinor <> (grossMinor + taxMinor + shippingMinor
                           - commissionMinor - processingFeeMinor
                           - refundsMinor + adjustmentsMinor);

-- A currency is stored beside every amount so that a total can never be read
-- without knowing what it is denominated in. A row whose currency is not a
-- three-letter code the shop is configured for is a row nobody can invoice.
SELECT 'orders with an unknown currency', COUNT(*), '0'
  FROM orders o LEFT JOIN currencies c ON c.code = o.currency WHERE c.code IS NULL;

SELECT 'payments whose currency <> their order''s', COUNT(*), '0'
  FROM payment_transactions t JOIN orders o ON o.id = t.orderId
 WHERE t.currency <> o.currency;

SELECT 'refunds whose currency <> their order''s', COUNT(*), '0'
  FROM refunds r JOIN orders o ON o.id = r.orderId
 WHERE r.currency <> o.currency;

-- Tax is a Decimal(9,6) percentage. A rate outside 0-100 is a unit mistake -
-- a fraction stored where a percentage was meant, or the other way round.
SELECT 'order lines with an impossible tax rate', COUNT(*), '0'
  FROM order_items WHERE taxRatePercent < 0 OR taxRatePercent > 100;

SELECT '=== INVENTORY INTEGRITY ===' AS check_name, NULL, NULL;

SELECT 'negative stock on hand',         COUNT(*), '0'
  FROM inventory_balances WHERE onHandQty < 0;

SELECT 'negative reservations',          COUNT(*), '0'
  FROM inventory_balances WHERE reservedQty < 0;

-- More reserved than exists. Reachable only by a reservation that was not
-- taken inside the same transaction as the stock check it was based on.
SELECT 'more reserved than on hand',     COUNT(*), '0'
  FROM inventory_balances WHERE reservedQty > onHandQty;

SELECT 'order lines with quantity <= 0', COUNT(*), '0'
  FROM order_items WHERE quantity <= 0;

SELECT 'seller offers with negative availability', COUNT(*), '0'
  FROM seller_offers WHERE availableQuantity < 0 OR reservedQuantity < 0;

-- Two stock rows for the same product, variant and location. `variantKey` is
-- the ULID or '' for the base product, never NULL, precisely because a NULL in
-- a MySQL UNIQUE index is distinct from every other NULL and would not have
-- stopped this.
SELECT 'duplicate stock rows',           COUNT(*), '0' FROM (
  SELECT productId, variantKey, locationId FROM inventory_balances
   GROUP BY productId, variantKey, locationId HAVING COUNT(*) > 1) d;

SELECT '=== TIME ===' AS check_name, NULL, NULL;

-- Every instant is UTC. A row created "in the future" is the signature of a
-- server that was running in local time when it wrote, or of a restore made
-- with the session timezone unset.
SELECT 'orders created in the future',   COUNT(*), '0'
  FROM orders WHERE createdAt > UTC_TIMESTAMP(3) + INTERVAL 1 HOUR;

SELECT 'rows updated before they were created', COUNT(*), '0'
  FROM orders WHERE updatedAt < createdAt;

SELECT 'orders confirmed before they were placed', COUNT(*), '0'
  FROM orders WHERE confirmedAt IS NOT NULL AND placedAt IS NOT NULL AND confirmedAt < placedAt;

-- A schedule whose next run is in the past and is still waiting is a worker
-- that stopped. Not a data defect on its own - but after a restore it is the
-- number that says how much catching up is about to happen all at once.
SELECT 'scheduled occurrences overdue',  COUNT(*), 'compare (0 on a healthy system)'
  FROM schedule_occurrences
 WHERE status IN ('SCHEDULED', 'AWAITING_VALIDATION') AND plannedRunAt < UTC_TIMESTAMP(3);

SELECT 'occurrences with no timezone',   COUNT(*), '0'
  FROM schedule_occurrences WHERE timezone IS NULL OR timezone = '';

SELECT '=== STATE MACHINES ===' AS check_name, NULL, NULL;

-- An order is only ever confirmed by a signature-verified webhook, so a
-- confirmed order with no captured payment means something confirmed it that
-- was not the payment provider.
SELECT 'confirmed orders with no captured payment', COUNT(*), '0'
  FROM orders o
 WHERE o.status IN ('CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED')
   AND o.paymentMode = 'ONLINE'
   AND NOT EXISTS (SELECT 1 FROM payment_transactions t
                    WHERE t.orderId = o.id AND t.status = 'CAPTURED');

SELECT 'delivered orders with no confirmation time', COUNT(*), '0'
  FROM orders WHERE status = 'DELIVERED' AND confirmedAt IS NULL;

SELECT 'cancelled orders with no cancellation time', COUNT(*), '0'
  FROM orders WHERE status = 'CANCELLED' AND cancelledAt IS NULL;

SELECT 'completed occurrences with no order', COUNT(*), '0'
  FROM schedule_occurrences s
 WHERE s.status IN ('COMPLETED', 'ORDER_CREATED', 'PAID')
   AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.scheduleOccurrenceId = s.id);

SELECT '=== REQUIRED FIELDS ===' AS check_name, NULL, NULL;

-- Columns that are nullable in the schema because of an older migration, but
-- that the application treats as mandatory. A NULL here is a row no screen can
-- render.
SELECT 'users with no normalised email', COUNT(*), '0'
  FROM users WHERE (emailNormalized IS NULL OR emailNormalized = '') AND erasedAt IS NULL;

SELECT 'active users with no password hash', COUNT(*), '0'
  FROM users WHERE status = 'ACTIVE' AND (passwordHash IS NULL OR passwordHash = '') AND erasedAt IS NULL;

SELECT 'products with no SKU',           COUNT(*), '0'
  FROM products WHERE (sku IS NULL OR sku = '') AND archivedAt IS NULL;

SELECT 'products with no category',      COUNT(*), '0'
  FROM products WHERE categoryId IS NULL AND archivedAt IS NULL;

SELECT 'published products with no price and no "price on request"', COUNT(*), '0'
  FROM products
 WHERE isPublished = 1 AND archivedAt IS NULL
   AND isPriceOnRequest = 0 AND (basePriceMinor IS NULL OR basePriceMinor <= 0);

SELECT '=== TENANT OWNERSHIP ===' AS check_name, NULL, NULL;

-- A seller's offer against a product from a different seller's private
-- catalogue, a settlement line belonging to another seller's order: the
-- queries that would show cross-tenant leakage if the backend ever trusted an
-- id sent by a browser.
SELECT 'settlement lines whose order group belongs to another seller', COUNT(*), '0'
  FROM seller_settlement_lines sl
  JOIN seller_settlements s  ON s.id = sl.settlementId
  JOIN seller_order_groups g ON g.id = sl.orderGroupId
 WHERE g.sellerAccountId <> s.sellerAccountId;

SELECT 'seller order lines whose offer belongs to another seller', COUNT(*), '0'
  FROM seller_order_lines ol
  JOIN seller_order_groups g ON g.id = ol.orderGroupId
  JOIN seller_offers o       ON o.id = ol.offerId
 WHERE o.sellerAccountId <> g.sellerAccountId;

SELECT 'seller inventory rows whose offer belongs to another seller', COUNT(*), '0'
  FROM seller_inventory si
  JOIN seller_offers o ON o.id = si.offerId
 WHERE o.sellerAccountId <> si.sellerAccountId;

SELECT 'buyer organisation members whose profile is missing', COUNT(*), '0'
  FROM buyer_organization_members m
  LEFT JOIN customer_profiles c ON c.id = m.customerProfileId
 WHERE c.id IS NULL;

SELECT 'buyer organisation members whose organisation is missing', COUNT(*), '0'
  FROM buyer_organization_members m
  LEFT JOIN buyer_organizations o ON o.id = m.organizationId
 WHERE o.id IS NULL;

SELECT '=== MEDIA AND GEOGRAPHY ===' AS check_name, NULL, NULL;

SELECT 'product media pointing at a missing asset', COUNT(*), '0'
  FROM product_media pm LEFT JOIN media_assets ma ON ma.id = pm.mediaId
 WHERE ma.id IS NULL;

-- Coordinates outside the possible range, or exactly (0,0) - which is in the
-- Atlantic and is what an unset pair of fields looks like.
SELECT 'warehouses with impossible coordinates', COUNT(*), '0'
  FROM inventory_locations
 WHERE (latitude IS NOT NULL AND (latitude < -90 OR latitude > 90))
    OR (longitude IS NOT NULL AND (longitude < -180 OR longitude > 180))
    OR (latitude = 0 AND longitude = 0);

SELECT '=== MIGRATION STATE ===' AS check_name, NULL, NULL;

SELECT 'applied migrations',             COUNT(*), 'must equal the count in prisma/migrations'
  FROM _prisma_migrations;

SELECT 'migrations started but never finished', COUNT(*), '0'
  FROM _prisma_migrations WHERE finished_at IS NULL;

SELECT 'migrations rolled back',         COUNT(*), '0'
  FROM _prisma_migrations WHERE rolled_back_at IS NOT NULL;

SELECT 'migrations recorded more than once', COUNT(*), '0' FROM (
  SELECT migration_name FROM _prisma_migrations
   GROUP BY migration_name HAVING COUNT(*) > 1) d;

SELECT '=== SEQUENCES (compare between runs) ===' AS check_name, NULL, NULL;

-- This schema uses ULID primary keys, so there is almost nothing here. What
-- there is, is `number_sequences` - the counter behind human-readable order
-- and invoice numbers. If a restore rewinds it, the next order reuses a number
-- that is already on somebody's invoice.
SELECT CONCAT('sequence: ', `key`), `value`, 'must not go backwards' FROM number_sequences ORDER BY `key`;

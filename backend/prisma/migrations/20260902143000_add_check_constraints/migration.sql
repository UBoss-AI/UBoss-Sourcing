-- ===========================================================================
-- Database-level invariants.
--
-- Prisma cannot express CHECK constraints, so they live in this hand-written
-- migration. They are the last line of defence: application services already
-- enforce every rule below, but a bug, a manual SQL fix, or a future import
-- script must not be able to leave the business data in an impossible state.
--
-- MariaDB 10.4 enforces CHECK constraints (verified against 10.4.32 before
-- writing this). On MySQL 5.7 they would be parsed and silently ignored.
-- ===========================================================================

-- --- Inventory ------------------------------------------------------------
-- Non-negative stock, and never more reserved than physically on hand.
ALTER TABLE `inventory_balances`
  ADD CONSTRAINT `chk_inventory_on_hand_non_negative` CHECK (`onHandQty` >= 0),
  ADD CONSTRAINT `chk_inventory_reserved_non_negative` CHECK (`reservedQty` >= 0),
  ADD CONSTRAINT `chk_inventory_reserved_within_on_hand` CHECK (`reservedQty` <= `onHandQty`);

-- A zero-delta movement carries no information and would corrupt ledger replay.
ALTER TABLE `inventory_movements`
  ADD CONSTRAINT `chk_movement_delta_non_zero` CHECK (`quantityDelta` <> 0),
  ADD CONSTRAINT `chk_movement_resulting_non_negative` CHECK (`resultingOnHand` >= 0);

ALTER TABLE `stock_reservations`
  ADD CONSTRAINT `chk_reservation_qty_positive` CHECK (`quantity` > 0);

-- --- Catalog --------------------------------------------------------------
ALTER TABLE `products`
  ADD CONSTRAINT `chk_product_price_non_negative` CHECK (`basePriceMinor` >= 0),
  ADD CONSTRAINT `chk_product_min_qty_positive` CHECK (`minOrderQty` >= 1),
  ADD CONSTRAINT `chk_product_increment_positive` CHECK (`qtyIncrement` >= 1),
  ADD CONSTRAINT `chk_product_max_qty_valid` CHECK (`maxOrderQty` IS NULL OR `maxOrderQty` >= `minOrderQty`),
  ADD CONSTRAINT `chk_product_reorder_non_negative` CHECK (`reorderThreshold` >= 0),
  ADD CONSTRAINT `chk_product_compare_price_valid` CHECK (`compareAtPriceMinor` IS NULL OR `compareAtPriceMinor` >= `basePriceMinor`);

ALTER TABLE `product_variants`
  ADD CONSTRAINT `chk_variant_price_non_negative` CHECK (`priceMinor` IS NULL OR `priceMinor` >= 0);

ALTER TABLE `tax_classes`
  ADD CONSTRAINT `chk_tax_rate_range` CHECK (`ratePercent` >= 0 AND `ratePercent` <= 100);

ALTER TABLE `shipping_methods`
  ADD CONSTRAINT `chk_shipping_price_non_negative` CHECK (`priceMinor` >= 0),
  ADD CONSTRAINT `chk_shipping_free_above_non_negative` CHECK (`freeAboveMinor` IS NULL OR `freeAboveMinor` >= 0);

-- --- Cart -----------------------------------------------------------------
ALTER TABLE `cart_items`
  ADD CONSTRAINT `chk_cart_item_qty_positive` CHECK (`quantity` > 0);

-- --- Orders ---------------------------------------------------------------
-- Money is never negative, and settled money can never exceed the order total.
-- `paidMinor` is only ever advanced from a signature-verified provider event.
ALTER TABLE `orders`
  ADD CONSTRAINT `chk_order_subtotal_non_negative` CHECK (`subtotalMinor` >= 0),
  ADD CONSTRAINT `chk_order_discount_non_negative` CHECK (`discountMinor` >= 0),
  ADD CONSTRAINT `chk_order_tax_non_negative` CHECK (`taxMinor` >= 0),
  ADD CONSTRAINT `chk_order_shipping_non_negative` CHECK (`shippingMinor` >= 0),
  ADD CONSTRAINT `chk_order_total_non_negative` CHECK (`grandTotalMinor` >= 0),
  ADD CONSTRAINT `chk_order_paid_non_negative` CHECK (`paidMinor` >= 0),
  ADD CONSTRAINT `chk_order_refunded_non_negative` CHECK (`refundedMinor` >= 0),
  ADD CONSTRAINT `chk_order_discount_within_subtotal` CHECK (`discountMinor` <= `subtotalMinor`),
  ADD CONSTRAINT `chk_order_paid_within_total` CHECK (`paidMinor` <= `grandTotalMinor`),
  -- The rule from SOP 10.4: a refund can never exceed what was captured.
  ADD CONSTRAINT `chk_order_refund_within_paid` CHECK (`refundedMinor` <= `paidMinor`);

ALTER TABLE `order_items`
  ADD CONSTRAINT `chk_order_item_qty_positive` CHECK (`quantity` > 0),
  ADD CONSTRAINT `chk_order_item_unit_price_non_negative` CHECK (`unitPriceMinor` >= 0),
  ADD CONSTRAINT `chk_order_item_subtotal_non_negative` CHECK (`lineSubtotalMinor` >= 0),
  ADD CONSTRAINT `chk_order_item_tax_non_negative` CHECK (`taxAmountMinor` >= 0),
  ADD CONSTRAINT `chk_order_item_discount_non_negative` CHECK (`discountMinor` >= 0),
  ADD CONSTRAINT `chk_order_item_total_non_negative` CHECK (`lineTotalMinor` >= 0),
  ADD CONSTRAINT `chk_order_item_tax_rate_range` CHECK (`taxRatePercent` >= 0 AND `taxRatePercent` <= 100);

-- --- Payments -------------------------------------------------------------
ALTER TABLE `payment_transactions`
  ADD CONSTRAINT `chk_payment_amount_positive` CHECK (`amountMinor` > 0),
  ADD CONSTRAINT `chk_payment_captured_non_negative` CHECK (`capturedMinor` >= 0),
  ADD CONSTRAINT `chk_payment_captured_within_amount` CHECK (`capturedMinor` <= `amountMinor`);

ALTER TABLE `payment_links`
  ADD CONSTRAINT `chk_payment_link_amount_positive` CHECK (`amountMinor` > 0);

ALTER TABLE `refunds`
  ADD CONSTRAINT `chk_refund_amount_positive` CHECK (`amountMinor` > 0);

-- --- Recurring ------------------------------------------------------------
-- Each frequency uses exactly the field that belongs to it, in a valid range.
ALTER TABLE `recurring_schedules`
  ADD CONSTRAINT `chk_schedule_interval_days` CHECK (`intervalDays` IS NULL OR `intervalDays` >= 1),
  ADD CONSTRAINT `chk_schedule_weekday_range` CHECK (`weekday` IS NULL OR (`weekday` >= 1 AND `weekday` <= 7)),
  ADD CONSTRAINT `chk_schedule_month_day_range` CHECK (`monthDay` IS NULL OR (`monthDay` >= 1 AND `monthDay` <= 31)),
  ADD CONSTRAINT `chk_schedule_run_minute_range` CHECK (`runAtMinute` >= 0 AND `runAtMinute` < 1440),
  ADD CONSTRAINT `chk_schedule_max_failures_positive` CHECK (`maxFailures` >= 1),
  ADD CONSTRAINT `chk_schedule_failure_count_non_negative` CHECK (`failureCount` >= 0),
  ADD CONSTRAINT `chk_schedule_occurrence_count_non_negative` CHECK (`occurrenceCount` >= 0),
  ADD CONSTRAINT `chk_schedule_max_occurrences_positive` CHECK (`maxOccurrences` IS NULL OR `maxOccurrences` >= 1),
  ADD CONSTRAINT `chk_schedule_end_after_start` CHECK (`endDate` IS NULL OR `endDate` >= `startDate`),
  -- The field required by the chosen frequency must actually be present.
  ADD CONSTRAINT `chk_schedule_frequency_field_present` CHECK (
    (`frequency` = 'EVERY_N_DAYS' AND `intervalDays` IS NOT NULL)
    OR (`frequency` = 'WEEKLY' AND `weekday` IS NOT NULL)
    OR (`frequency` = 'MONTHLY' AND `monthDay` IS NOT NULL)
  );

ALTER TABLE `recurring_schedule_items`
  ADD CONSTRAINT `chk_schedule_item_qty_positive` CHECK (`quantity` > 0);

ALTER TABLE `schedule_occurrences`
  ADD CONSTRAINT `chk_occurrence_attempts_non_negative` CHECK (`attemptCount` >= 0);

-- --- Operations -----------------------------------------------------------
ALTER TABLE `job_queue`
  ADD CONSTRAINT `chk_job_attempts_non_negative` CHECK (`attemptCount` >= 0),
  ADD CONSTRAINT `chk_job_max_attempts_positive` CHECK (`maxAttempts` >= 1);

ALTER TABLE `notification_outbox`
  ADD CONSTRAINT `chk_outbox_attempts_non_negative` CHECK (`attemptCount` >= 0),
  ADD CONSTRAINT `chk_outbox_max_attempts_positive` CHECK (`maxAttempts` >= 1);

ALTER TABLE `customer_profiles`
  ADD CONSTRAINT `chk_customer_per_order_min_non_negative` CHECK (`perOrderMinMinor` IS NULL OR `perOrderMinMinor` >= 0),
  ADD CONSTRAINT `chk_customer_per_order_max_non_negative` CHECK (`perOrderMaxMinor` IS NULL OR `perOrderMaxMinor` >= 0),
  ADD CONSTRAINT `chk_customer_order_range_valid` CHECK (
    `perOrderMinMinor` IS NULL OR `perOrderMaxMinor` IS NULL OR `perOrderMaxMinor` >= `perOrderMinMinor`
  ),
  ADD CONSTRAINT `chk_customer_monthly_cap_non_negative` CHECK (`monthlySpendCapMinor` IS NULL OR `monthlySpendCapMinor` >= 0);

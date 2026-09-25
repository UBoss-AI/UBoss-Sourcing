-- Stripe-hosted Checkout, and one authoritative Stripe Customer per person.
--
-- WHAT CHANGES
--
-- A Stripe card payment used to be a PaymentIntent confirmed inside this
-- storefront, through Stripe's Payment Element. It is now a Checkout Session:
-- the customer is sent to Stripe's own page, types or picks their card there,
-- answers 3-D Secure there, and comes back. Stripe creates the PaymentIntent
-- only when they confirm, so an attempt has to be traceable by its session
-- before it has any other Stripe reference at all.
--
--   * `payment_transactions.providerSessionId` - the cs_... id. UNIQUE, so one
--     session can never be filed against two attempts.
--   * `payment_transactions.sessionExpiresAt` - when Stripe will close it.
--   * `payment_transactions.openAttemptKey` - the order id while the attempt
--     is open, NULL once it is closed. UNIQUE: see "MARIADB NOTE".
--   * `payment_transactions.cardBrand` / `cardLast4` - display only, for the
--     confirmation page. Never a card number; Stripe does not send one.
--   * `payment_transactions.disputedAt` / `disputeReason` - a chargeback was
--     opened. The payment's own status stays CAPTURED: a dispute is a claim
--     against money that did move, not a reversal of it.
--
-- And one table:
--
--   * `payment_provider_customers` - this person's Customer at the gateway.
--     Until now the cus_... id was only ever copied onto saved-card rows, so a
--     customer with no saved card had no durable Stripe Customer, and one was
--     created per attempt once Stripe's 24-hour idempotency window lapsed.
--     Checkout needs the SAME Customer every time: it is what makes Stripe
--     offer a returning customer the card they saved.
--
-- SAFE TO RUN ON A LIVE DEPLOYMENT
--
--   Every added column is nullable. Every existing attempt reads as it did:
--   providerSessionId NULL means "not a Checkout attempt", openAttemptKey
--   NULL means "not holding the order's one open slot". The new table starts
--   empty and is filled the first time each customer pays through Checkout,
--   adopting the cus_... id from their saved cards where they have one.
--
-- MARIADB NOTE
--
--   `uq_payment_open_attempt` is a UNIQUE index over a NULLABLE column, and it
--   is the one-open-attempt-per-order rule. MariaDB treats every NULL in a
--   UNIQUE index as distinct, so any number of closed attempts coexist while a
--   second concurrent OPEN attempt for the same order collides on insert. The
--   same pattern as `uq_fx_snapshot_active_provider`.
--
-- ROLLBACK
--
--   Drop `payment_provider_customers`, then the seven columns and the two
--   indexes on `payment_transactions`. Nothing that existed before reads them.

-- AlterTable
ALTER TABLE `payment_transactions` ADD COLUMN `providerSessionId` VARCHAR(191) NULL,
    ADD COLUMN `sessionExpiresAt` DATETIME(3) NULL,
    ADD COLUMN `openAttemptKey` CHAR(26) NULL,
    ADD COLUMN `cardBrand` VARCHAR(32) NULL,
    ADD COLUMN `cardLast4` CHAR(4) NULL,
    ADD COLUMN `disputedAt` DATETIME(3) NULL,
    ADD COLUMN `disputeReason` VARCHAR(64) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `uq_payment_provider_session` ON `payment_transactions`(`providerSessionId`);

-- CreateIndex
CREATE UNIQUE INDEX `uq_payment_open_attempt` ON `payment_transactions`(`openAttemptKey`);

-- CreateTable
CREATE TABLE `payment_provider_customers` (
    `id` CHAR(26) NOT NULL,
    `customerProfileId` CHAR(26) NOT NULL,
    `provider` ENUM('RAZORPAY', 'STRIPE') NOT NULL,
    `mode` ENUM('TEST', 'LIVE') NOT NULL,
    `providerCustomerId` VARCHAR(128) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_provider_customer_profile`(`customerProfileId`, `provider`, `mode`),
    UNIQUE INDEX `uq_provider_customer_ref`(`provider`, `providerCustomerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `payment_provider_customers` ADD CONSTRAINT `payment_provider_customers_customerProfileId_fkey` FOREIGN KEY (`customerProfileId`) REFERENCES `customer_profiles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

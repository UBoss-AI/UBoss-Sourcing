-- The instrument a customer chose, and what they agreed to when a card was
-- stored.
--
-- Two independent additions that travel together because one is meaningless
-- without the other: choosing "Pay with Credit Card" is only useful if the
-- card that results can be told apart from a card somebody enrolled for
-- auto-pay.
--
-- ---------------------------------------------------------------------------
-- 1. What the customer picked, in their own words
-- ---------------------------------------------------------------------------
--
-- `orders.preferredPaymentProvider`/`preferredPaymentMethod` already record
-- which *gateway* was resolved. This records which *instrument* was asked for,
-- which is the only one of the two the customer ever saw on screen.
--
-- Its own column rather than a third member of the existing
-- ENUM('ANY','UPI'): widening that would be a MODIFY COLUMN rewriting every
-- historical order to record something none of them expressed.
--
-- Nullable, and null is the honest answer for every order that already exists.

ALTER TABLE `orders`
    ADD COLUMN `preferredPaymentInstrument` ENUM('CREDIT_CARD', 'DEBIT_CARD', 'UPI') NULL,
    ADD COLUMN `preferredPaymentMethodId` CHAR(26) NULL;

-- ON DELETE SET NULL, deliberately.
--
-- Removing a card must not remove the order it once paid for, and must not be
-- refused because an order from last year still names it. The order keeps its
-- instrument choice and simply stops naming a card that is gone — which is
-- what the payment page then asks the customer to replace.
--
-- Contrast `recurring_schedules.paymentMethodId`, which is RESTRICT: a live
-- schedule pointing at a detached card would fail its next charge silently,
-- so that one is refused at the database. A completed order cannot fail.

ALTER TABLE `orders`
    ADD CONSTRAINT `fk_order_preferred_payment_method`
        FOREIGN KEY (`preferredPaymentMethodId`) REFERENCES `customer_payment_methods`(`id`)
        ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX `ix_order_preferred_payment_method`
    ON `orders`(`preferredPaymentMethodId`);

-- ---------------------------------------------------------------------------
-- 2. Which agreement a stored card was stored under
-- ---------------------------------------------------------------------------
--
-- CHECKOUT and OFF_SESSION are not degrees of one permission. They are
-- different agreements:
--
--   CHECKOUT    "keep this so I need not type it again" — given with the
--               customer present, and every charge against it is one they
--               watch happen.
--   OFF_SESSION "charge this while I am not here" — given at auto-pay
--               enrolment. Strictly more than the above.
--
-- Conflating them is how a card somebody saved to avoid retyping it ends up
-- being charged in the night. `assertChargeable` in
-- modules/payments/payment-method.service.ts refuses anything that is not
-- OFF_SESSION, and that is the only place the separation is enforced.
--
-- DEFAULT 'OFF_SESSION' is what makes this migration safe rather than merely
-- additive. Every row that exists when it runs was written by
-- `completePaymentMethodEnrolment`, which has only ever created auto-pay
-- mandates, so the default states what those rows have always meant. A
-- default of CHECKOUT would silently revoke consent that was actually given
-- and break every live schedule.

ALTER TABLE `customer_payment_methods`
    ADD COLUMN `consentScope` ENUM('CHECKOUT', 'OFF_SESSION') NOT NULL DEFAULT 'OFF_SESSION'
        AFTER `status`;

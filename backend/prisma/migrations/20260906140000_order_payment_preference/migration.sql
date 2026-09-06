-- The gateway and instrument a customer chose at checkout.
--
-- Additive and nullable. Null is the honest answer for every order that
-- already exists: none of them were ever offered a choice, and a default here
-- would claim they picked something.
--
-- These record a *preference*, not where the money went. The gateway that was
-- actually paid is on payment_transactions.provider, resolved at payment time
-- from what the operator has connected — a deployment that disconnects a
-- gateway does not rewrite the orders that once asked for it.

-- AlterTable
ALTER TABLE `orders`
    ADD COLUMN `preferredPaymentProvider` ENUM('RAZORPAY', 'STRIPE') NULL,
    ADD COLUMN `preferredPaymentMethod` ENUM('ANY', 'UPI') NULL;

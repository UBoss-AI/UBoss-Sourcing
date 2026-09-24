-- Preorders for every product (follow-up to Work 1).
--
-- A preorder no longer has to belong to a seller. On the operator's own
-- products the operator's staff answer it in the admin console, and the
-- request carries no seller and no seller offer. The two are NULL together:
-- a request with a seller but no offer (or the reverse) would have nobody, or
-- the wrong party, entitled to answer it.
--
-- Both foreign keys are ON UPDATE RESTRICT and neither is SET NULL, so a CHECK
-- on these columns is accepted by MariaDB 11.4 as well as 10.4.

-- AlterTable
ALTER TABLE `preorder_offers` MODIFY `sellerAccountId` CHAR(26) NULL;

-- AlterTable
ALTER TABLE `preorder_requests` MODIFY `sellerAccountId` CHAR(26) NULL,
    MODIFY `offerId` CHAR(26) NULL;

ALTER TABLE `preorder_requests`
    ADD CONSTRAINT `chk_preorder_request_supplier` CHECK ((`sellerAccountId` IS NULL) = (`offerId` IS NULL));

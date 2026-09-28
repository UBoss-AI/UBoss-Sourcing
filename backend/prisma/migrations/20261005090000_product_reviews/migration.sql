-- Product reviews: what a buyer thought of a product they received, scored
-- 1 to 5 for quality, delivery, experience and support. Scores only - there
-- is no comment column. See the PRODUCT REVIEWS section of schema.prisma.
--
-- A new table and nothing else. No existing row is touched, so this is safe
-- to apply to a live installation: until somebody writes a review, every
-- product simply has none.
--
-- The four scores are held to 1..5 by a CHECK as well as by the API. MariaDB
-- 10.4 is not strict, so without it a 7 from any path that skipped the API
-- would be stored and averaged. The CHECK names only the score columns, none
-- of which is a foreign key, so it is unaffected by the ON UPDATE rule that
-- MariaDB 11.4 enforces for CHECKs on foreign-key columns (error 1901).

-- CreateTable
CREATE TABLE `product_reviews` (
    `id`                CHAR(26)      NOT NULL,
    `productId`         CHAR(26)      NOT NULL,
    `customerProfileId` CHAR(26)      NOT NULL,
    `orderId`           CHAR(26)      NULL,
    `qualityRating`     TINYINT       NOT NULL,
    `deliveryRating`    TINYINT       NOT NULL,
    `experienceRating`  TINYINT       NOT NULL,
    `supportRating`     TINYINT       NOT NULL,
    `status`            ENUM('PUBLISHED', 'HIDDEN') NOT NULL DEFAULT 'PUBLISHED',
    `moderationReason`  VARCHAR(500)  NULL,
    `moderatedByUserId` CHAR(26)      NULL,
    `moderatedAt`       DATETIME(3)   NULL,
    `createdAt`         DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt`         DATETIME(3)   NOT NULL,

    UNIQUE INDEX `uq_product_review`(`customerProfileId`, `productId`),
    INDEX `ix_product_review_product`(`productId`, `status`, `createdAt`),
    INDEX `ix_product_review_status`(`status`, `createdAt`),
    INDEX `ix_product_review_order`(`orderId`),
    INDEX `ix_product_review_moderator`(`moderatedByUserId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `product_reviews`
    ADD CONSTRAINT `fk_product_review_product` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `product_reviews`
    ADD CONSTRAINT `fk_product_review_customer` FOREIGN KEY (`customerProfileId`) REFERENCES `customer_profiles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `product_reviews`
    ADD CONSTRAINT `fk_product_review_order` FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `product_reviews`
    ADD CONSTRAINT `fk_product_review_moderator` FOREIGN KEY (`moderatedByUserId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- Every score is a whole number from 1 to 5.
ALTER TABLE `product_reviews`
    ADD CONSTRAINT `chk_product_review_ratings` CHECK (
        `qualityRating` BETWEEN 1 AND 5
        AND `deliveryRating` BETWEEN 1 AND 5
        AND `experienceRating` BETWEEN 1 AND 5
        AND `supportRating` BETWEEN 1 AND 5
    );

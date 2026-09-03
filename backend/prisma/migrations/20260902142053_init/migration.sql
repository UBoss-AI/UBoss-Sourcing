-- CreateTable
CREATE TABLE `users` (
    `id` CHAR(26) NOT NULL,
    `type` ENUM('ADMIN', 'CUSTOMER') NOT NULL,
    `email` VARCHAR(320) NOT NULL,
    `emailNormalized` VARCHAR(320) NOT NULL,
    `phone` VARCHAR(32) NULL,
    `passwordHash` VARCHAR(255) NULL,
    `status` ENUM('PENDING_INVITATION', 'PENDING_APPROVAL', 'ACTIVE', 'DEACTIVATED') NOT NULL DEFAULT 'PENDING_INVITATION',
    `emailVerifiedAt` DATETIME(3) NULL,
    `phoneVerifiedAt` DATETIME(3) NULL,
    `mfaSecretEnc` TEXT NULL,
    `mfaEnabledAt` DATETIME(3) NULL,
    `lastLoginAt` DATETIME(3) NULL,
    `failedLoginCount` INTEGER NOT NULL DEFAULT 0,
    `lockedUntil` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `archivedAt` DATETIME(3) NULL,

    UNIQUE INDEX `uq_user_email_normalized`(`emailNormalized`),
    INDEX `ix_user_type_status`(`type`, `status`),
    INDEX `ix_user_created_at`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `roles` (
    `id` CHAR(26) NOT NULL,
    `key` VARCHAR(64) NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `description` VARCHAR(512) NULL,
    `isSystem` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_role_key`(`key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `permissions` (
    `id` CHAR(26) NOT NULL,
    `key` VARCHAR(96) NOT NULL,
    `description` VARCHAR(512) NULL,

    UNIQUE INDEX `uq_permission_key`(`key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `role_permissions` (
    `roleId` CHAR(26) NOT NULL,
    `permissionId` CHAR(26) NOT NULL,

    INDEX `ix_role_permission_permission`(`permissionId`),
    PRIMARY KEY (`roleId`, `permissionId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_roles` (
    `userId` CHAR(26) NOT NULL,
    `roleId` CHAR(26) NOT NULL,
    `assignedById` CHAR(26) NULL,
    `assignedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_user_role_role`(`roleId`),
    PRIMARY KEY (`userId`, `roleId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sessions` (
    `id` CHAR(26) NOT NULL,
    `userId` CHAR(26) NOT NULL,
    `refreshTokenHash` CHAR(64) NOT NULL,
    `familyId` CHAR(26) NOT NULL,
    `userAgent` VARCHAR(512) NULL,
    `ipAddress` VARCHAR(45) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `revokedAt` DATETIME(3) NULL,
    `revokedReason` VARCHAR(128) NULL,
    `replacedBySessionId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastUsedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_session_refresh_hash`(`refreshTokenHash`),
    INDEX `ix_session_user_revoked`(`userId`, `revokedAt`),
    INDEX `ix_session_family`(`familyId`),
    INDEX `ix_session_expires`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `auth_tokens` (
    `id` CHAR(26) NOT NULL,
    `userId` CHAR(26) NOT NULL,
    `type` ENUM('INVITATION', 'EMAIL_VERIFICATION', 'PASSWORD_RESET') NOT NULL,
    `tokenHash` CHAR(64) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `consumedAt` DATETIME(3) NULL,
    `createdById` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_auth_token_hash`(`tokenHash`),
    INDEX `ix_auth_token_user_type`(`userId`, `type`, `consumedAt`),
    INDEX `ix_auth_token_expires`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `login_attempts` (
    `id` CHAR(26) NOT NULL,
    `emailNormalized` VARCHAR(320) NOT NULL,
    `userType` ENUM('ADMIN', 'CUSTOMER') NOT NULL,
    `ipAddress` VARCHAR(45) NULL,
    `success` BOOLEAN NOT NULL,
    `failureReason` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_login_attempt_email_time`(`emailNormalized`, `createdAt`),
    INDEX `ix_login_attempt_ip_time`(`ipAddress`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `business_profile` (
    `id` CHAR(26) NOT NULL,
    `legalName` VARCHAR(255) NOT NULL,
    `displayName` VARCHAR(255) NOT NULL,
    `logoMediaId` CHAR(26) NULL,
    `supportEmail` VARCHAR(320) NOT NULL,
    `supportPhone` VARCHAR(32) NULL,
    `gstin` VARCHAR(32) NULL,
    `addressJson` JSON NULL,
    `currency` CHAR(3) NOT NULL,
    `timezone` VARCHAR(64) NOT NULL,
    `invoicePrefix` VARCHAR(16) NOT NULL DEFAULT 'INV',
    `orderPrefix` VARCHAR(16) NOT NULL DEFAULT 'UB',
    `policyLinksJson` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `updatedById` CHAR(26) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tax_classes` (
    `id` CHAR(26) NOT NULL,
    `code` VARCHAR(32) NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `ratePercent` DECIMAL(9, 6) NOT NULL,
    `isInclusive` BOOLEAN NOT NULL DEFAULT false,
    `isDefault` BOOLEAN NOT NULL DEFAULT false,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_tax_class_code`(`code`),
    INDEX `ix_tax_class_active`(`isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `shipping_methods` (
    `id` CHAR(26) NOT NULL,
    `code` VARCHAR(32) NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `description` VARCHAR(512) NULL,
    `priceMinor` BIGINT NOT NULL DEFAULT 0,
    `freeAboveMinor` BIGINT NULL,
    `regionsJson` JSON NULL,
    `estimatedDaysMin` INTEGER NULL,
    `estimatedDaysMax` INTEGER NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_shipping_method_code`(`code`),
    INDEX `ix_shipping_method_active`(`isActive`, `sortOrder`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `feature_flags` (
    `id` CHAR(26) NOT NULL,
    `key` VARCHAR(96) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `description` VARCHAR(512) NULL,
    `updatedAt` DATETIME(3) NOT NULL,
    `updatedById` CHAR(26) NULL,

    UNIQUE INDEX `uq_feature_flag_key`(`key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notification_settings` (
    `id` CHAR(26) NOT NULL,
    `eventKey` VARCHAR(96) NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `emailEnabled` BOOLEAN NOT NULL DEFAULT true,
    `smsEnabled` BOOLEAN NOT NULL DEFAULT false,
    `subjectTemplate` VARCHAR(255) NOT NULL,
    `bodyTemplate` TEXT NOT NULL,
    `internalRecipientsJson` JSON NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_notification_setting_event`(`eventKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `media_assets` (
    `id` CHAR(26) NOT NULL,
    `storageKey` VARCHAR(512) NOT NULL,
    `url` VARCHAR(1024) NOT NULL,
    `mimeType` VARCHAR(128) NOT NULL,
    `sizeBytes` INTEGER NOT NULL,
    `width` INTEGER NULL,
    `height` INTEGER NULL,
    `altText` VARCHAR(512) NULL,
    `checksum` CHAR(64) NULL,
    `uploadedById` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_media_storage_key`(`storageKey`),
    INDEX `ix_media_checksum`(`checksum`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `categories` (
    `id` CHAR(26) NOT NULL,
    `parentId` CHAR(26) NULL,
    `name` VARCHAR(255) NOT NULL,
    `slug` VARCHAR(255) NOT NULL,
    `description` TEXT NULL,
    `imageMediaId` CHAR(26) NULL,
    `bannerMediaId` CHAR(26) NULL,
    `path` VARCHAR(1024) NOT NULL DEFAULT '/',
    `depth` INTEGER NOT NULL DEFAULT 0,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT false,
    `metaTitle` VARCHAR(255) NULL,
    `metaDescription` VARCHAR(512) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `archivedAt` DATETIME(3) NULL,
    `createdById` CHAR(26) NULL,
    `updatedById` CHAR(26) NULL,

    UNIQUE INDEX `uq_category_slug`(`slug`),
    INDEX `ix_category_parent_sort`(`parentId`, `sortOrder`),
    INDEX `ix_category_active`(`isActive`, `archivedAt`),
    INDEX `ix_category_path`(`path`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `products` (
    `id` CHAR(26) NOT NULL,
    `categoryId` CHAR(26) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `slug` VARCHAR(255) NOT NULL,
    `sku` VARCHAR(64) NOT NULL,
    `shortDescription` VARCHAR(1024) NULL,
    `description` TEXT NULL,
    `descriptionHtml` TEXT NULL,
    `status` ENUM('DRAFT', 'ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'DRAFT',
    `isPublished` BOOLEAN NOT NULL DEFAULT false,
    `publishedAt` DATETIME(3) NULL,
    `publishFrom` DATETIME(3) NULL,
    `taxClassId` CHAR(26) NOT NULL,
    `basePriceMinor` BIGINT NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `compareAtPriceMinor` BIGINT NULL,
    `isStockTracked` BOOLEAN NOT NULL DEFAULT true,
    `reorderThreshold` INTEGER NOT NULL DEFAULT 0,
    `minOrderQty` INTEGER NOT NULL DEFAULT 1,
    `maxOrderQty` INTEGER NULL,
    `qtyIncrement` INTEGER NOT NULL DEFAULT 1,
    `isRecurringEligible` BOOLEAN NOT NULL DEFAULT false,
    `hasVariants` BOOLEAN NOT NULL DEFAULT false,
    `weightGrams` INTEGER NULL,
    `metaTitle` VARCHAR(255) NULL,
    `metaDescription` VARCHAR(512) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `archivedAt` DATETIME(3) NULL,
    `createdById` CHAR(26) NULL,
    `updatedById` CHAR(26) NULL,

    UNIQUE INDEX `uq_product_slug`(`slug`),
    UNIQUE INDEX `uq_product_sku`(`sku`),
    INDEX `ix_product_category_visibility`(`categoryId`, `status`, `isPublished`),
    INDEX `ix_product_visibility`(`status`, `isPublished`, `archivedAt`),
    INDEX `ix_product_price`(`basePriceMinor`),
    INDEX `ix_product_created`(`createdAt`),
    INDEX `ix_product_name`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `product_variants` (
    `id` CHAR(26) NOT NULL,
    `productId` CHAR(26) NOT NULL,
    `sku` VARCHAR(64) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `optionsJson` JSON NOT NULL,
    `priceMinor` BIGINT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `archivedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_variant_sku`(`sku`),
    INDEX `ix_variant_product`(`productId`, `isActive`, `sortOrder`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `product_media` (
    `id` CHAR(26) NOT NULL,
    `productId` CHAR(26) NOT NULL,
    `mediaId` CHAR(26) NOT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `isPrimary` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_product_media_sort`(`productId`, `sortOrder`),
    UNIQUE INDEX `uq_product_media`(`productId`, `mediaId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `product_attributes` (
    `id` CHAR(26) NOT NULL,
    `productId` CHAR(26) NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `value` VARCHAR(512) NOT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `isFilterable` BOOLEAN NOT NULL DEFAULT false,

    INDEX `ix_product_attribute_lookup`(`name`, `value`),
    UNIQUE INDEX `uq_product_attribute_name`(`productId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inventory_locations` (
    `id` CHAR(26) NOT NULL,
    `code` VARCHAR(32) NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `addressJson` JSON NULL,
    `isDefault` BOOLEAN NOT NULL DEFAULT false,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_inventory_location_code`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inventory_balances` (
    `id` CHAR(26) NOT NULL,
    `productId` CHAR(26) NOT NULL,
    `variantId` CHAR(26) NULL,
    `variantKey` VARCHAR(26) NOT NULL DEFAULT '',
    `locationId` CHAR(26) NOT NULL,
    `onHandQty` INTEGER NOT NULL DEFAULT 0,
    `reservedQty` INTEGER NOT NULL DEFAULT 0,
    `version` INTEGER NOT NULL DEFAULT 0,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_inventory_balance_location`(`locationId`),
    INDEX `ix_inventory_balance_variant`(`variantId`),
    UNIQUE INDEX `uq_inventory_balance_sku_location`(`productId`, `variantKey`, `locationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inventory_movements` (
    `id` CHAR(26) NOT NULL,
    `productId` CHAR(26) NOT NULL,
    `variantId` CHAR(26) NULL,
    `variantKey` VARCHAR(26) NOT NULL DEFAULT '',
    `locationId` CHAR(26) NOT NULL,
    `type` ENUM('RECEIPT', 'ADJUSTMENT', 'RESERVATION_COMMIT', 'ORDER_CANCEL_RESTOCK', 'RETURN_RESTOCK', 'RETURN_QUARANTINE', 'SYNC_CORRECTION') NOT NULL,
    `quantityDelta` INTEGER NOT NULL,
    `resultingOnHand` INTEGER NOT NULL,
    `reason` VARCHAR(512) NULL,
    `referenceType` VARCHAR(48) NULL,
    `referenceId` CHAR(26) NULL,
    `actorUserId` CHAR(26) NULL,
    `actorType` ENUM('SYSTEM', 'ADMIN', 'CUSTOMER', 'PROVIDER') NOT NULL DEFAULT 'SYSTEM',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_inventory_movement_sku_time`(`productId`, `variantKey`, `createdAt`),
    INDEX `ix_inventory_movement_reference`(`referenceType`, `referenceId`),
    INDEX `ix_inventory_movement_time`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stock_reservations` (
    `id` CHAR(26) NOT NULL,
    `productId` CHAR(26) NOT NULL,
    `variantId` CHAR(26) NULL,
    `variantKey` VARCHAR(26) NOT NULL DEFAULT '',
    `locationId` CHAR(26) NOT NULL,
    `cartId` CHAR(26) NULL,
    `orderId` CHAR(26) NULL,
    `quantity` INTEGER NOT NULL,
    `status` ENUM('ACTIVE', 'COMMITTED', 'RELEASED', 'EXPIRED') NOT NULL DEFAULT 'ACTIVE',
    `expiresAt` DATETIME(3) NOT NULL,
    `committedAt` DATETIME(3) NULL,
    `releasedAt` DATETIME(3) NULL,
    `releaseReason` VARCHAR(128) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_reservation_sweep`(`status`, `expiresAt`),
    INDEX `ix_reservation_order`(`orderId`),
    INDEX `ix_reservation_cart`(`cartId`),
    INDEX `ix_reservation_sku_status`(`productId`, `variantKey`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `customer_profiles` (
    `id` CHAR(26) NOT NULL,
    `userId` CHAR(26) NOT NULL,
    `fullName` VARCHAR(255) NOT NULL,
    `organization` VARCHAR(255) NULL,
    `department` VARCHAR(128) NULL,
    `phone` VARCHAR(32) NULL,
    `gstin` VARCHAR(32) NULL,
    `customerCode` VARCHAR(32) NULL,
    `perOrderMinMinor` BIGINT NULL,
    `perOrderMaxMinor` BIGINT NULL,
    `monthlySpendCapMinor` BIGINT NULL,
    `requiresOrderApproval` BOOLEAN NOT NULL DEFAULT false,
    `approvalThresholdMinor` BIGINT NULL,
    `internalNotes` TEXT NULL,
    `consentAcceptedAt` DATETIME(3) NULL,
    `consentVersion` VARCHAR(32) NULL,
    `invitedById` CHAR(26) NULL,
    `invitedAt` DATETIME(3) NULL,
    `activatedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_customer_profile_user`(`userId`),
    UNIQUE INDEX `uq_customer_code`(`customerCode`),
    INDEX `ix_customer_organization`(`organization`),
    INDEX `ix_customer_created`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `addresses` (
    `id` CHAR(26) NOT NULL,
    `customerProfileId` CHAR(26) NOT NULL,
    `kind` ENUM('BILLING', 'SHIPPING', 'BOTH') NOT NULL DEFAULT 'BOTH',
    `label` VARCHAR(64) NULL,
    `contactName` VARCHAR(255) NOT NULL,
    `contactPhone` VARCHAR(32) NOT NULL,
    `line1` VARCHAR(255) NOT NULL,
    `line2` VARCHAR(255) NULL,
    `city` VARCHAR(128) NOT NULL,
    `state` VARCHAR(128) NOT NULL,
    `postalCode` VARCHAR(16) NOT NULL,
    `country` CHAR(2) NOT NULL,
    `isDefaultBilling` BOOLEAN NOT NULL DEFAULT false,
    `isDefaultShipping` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `archivedAt` DATETIME(3) NULL,

    INDEX `ix_address_customer`(`customerProfileId`, `archivedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `carts` (
    `id` CHAR(26) NOT NULL,
    `customerProfileId` CHAR(26) NULL,
    `guestToken` CHAR(64) NULL,
    `status` ENUM('ACTIVE', 'CONVERTED', 'ABANDONED') NOT NULL DEFAULT 'ACTIVE',
    `currency` CHAR(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `expiresAt` DATETIME(3) NULL,

    UNIQUE INDEX `uq_cart_guest_token`(`guestToken`),
    INDEX `ix_cart_customer_status`(`customerProfileId`, `status`),
    INDEX `ix_cart_sweep`(`status`, `expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cart_items` (
    `id` CHAR(26) NOT NULL,
    `cartId` CHAR(26) NOT NULL,
    `productId` CHAR(26) NOT NULL,
    `variantId` CHAR(26) NULL,
    `variantKey` VARCHAR(26) NOT NULL DEFAULT '',
    `quantity` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_cart_item_product`(`productId`),
    UNIQUE INDEX `uq_cart_item_sku`(`cartId`, `productId`, `variantKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `orders` (
    `id` CHAR(26) NOT NULL,
    `orderNumber` VARCHAR(32) NOT NULL,
    `customerProfileId` CHAR(26) NOT NULL,
    `cartId` CHAR(26) NULL,
    `source` ENUM('ONE_TIME', 'RECURRING') NOT NULL DEFAULT 'ONE_TIME',
    `scheduleOccurrenceId` CHAR(26) NULL,
    `status` ENUM('DRAFT', 'PENDING_APPROVAL', 'PENDING_PAYMENT', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'RETURNED', 'REFUNDED') NOT NULL DEFAULT 'DRAFT',
    `currency` CHAR(3) NOT NULL,
    `subtotalMinor` BIGINT NOT NULL DEFAULT 0,
    `discountMinor` BIGINT NOT NULL DEFAULT 0,
    `taxMinor` BIGINT NOT NULL DEFAULT 0,
    `shippingMinor` BIGINT NOT NULL DEFAULT 0,
    `grandTotalMinor` BIGINT NOT NULL DEFAULT 0,
    `paidMinor` BIGINT NOT NULL DEFAULT 0,
    `refundedMinor` BIGINT NOT NULL DEFAULT 0,
    `billingAddressJson` JSON NOT NULL,
    `shippingAddressJson` JSON NOT NULL,
    `shippingMethodCode` VARCHAR(32) NULL,
    `shippingMethodName` VARCHAR(128) NULL,
    `paymentMode` ENUM('ONLINE', 'PAYMENT_LINK') NOT NULL DEFAULT 'ONLINE',
    `customerNote` TEXT NULL,
    `internalNote` TEXT NULL,
    `placedAt` DATETIME(3) NULL,
    `confirmedAt` DATETIME(3) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `cancelReason` VARCHAR(512) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_order_number`(`orderNumber`),
    UNIQUE INDEX `uq_order_schedule_occurrence`(`scheduleOccurrenceId`),
    INDEX `ix_order_customer_time`(`customerProfileId`, `createdAt`),
    INDEX `ix_order_status_time`(`status`, `createdAt`),
    INDEX `ix_order_source_time`(`source`, `createdAt`),
    INDEX `ix_order_placed`(`placedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `order_items` (
    `id` CHAR(26) NOT NULL,
    `orderId` CHAR(26) NOT NULL,
    `productId` CHAR(26) NOT NULL,
    `variantId` CHAR(26) NULL,
    `nameSnapshot` VARCHAR(255) NOT NULL,
    `skuSnapshot` VARCHAR(64) NOT NULL,
    `variantNameSnapshot` VARCHAR(255) NULL,
    `taxClassCodeSnapshot` VARCHAR(32) NOT NULL,
    `imageUrlSnapshot` VARCHAR(1024) NULL,
    `unitPriceMinor` BIGINT NOT NULL,
    `quantity` INTEGER NOT NULL,
    `lineSubtotalMinor` BIGINT NOT NULL,
    `taxRatePercent` DECIMAL(9, 6) NOT NULL,
    `taxInclusive` BOOLEAN NOT NULL DEFAULT false,
    `taxAmountMinor` BIGINT NOT NULL,
    `discountMinor` BIGINT NOT NULL DEFAULT 0,
    `lineTotalMinor` BIGINT NOT NULL,
    `isRecurringEligibleSnapshot` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_order_item_order`(`orderId`),
    INDEX `ix_order_item_product`(`productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `order_status_history` (
    `id` CHAR(26) NOT NULL,
    `orderId` CHAR(26) NOT NULL,
    `fromStatus` ENUM('DRAFT', 'PENDING_APPROVAL', 'PENDING_PAYMENT', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'RETURNED', 'REFUNDED') NULL,
    `toStatus` ENUM('DRAFT', 'PENDING_APPROVAL', 'PENDING_PAYMENT', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'RETURNED', 'REFUNDED') NOT NULL,
    `actorType` ENUM('SYSTEM', 'ADMIN', 'CUSTOMER', 'PROVIDER') NOT NULL DEFAULT 'SYSTEM',
    `actorUserId` CHAR(26) NULL,
    `reason` VARCHAR(512) NULL,
    `metaJson` JSON NULL,
    `correlationId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_order_history_order_time`(`orderId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `order_approvals` (
    `id` CHAR(26) NOT NULL,
    `orderId` CHAR(26) NOT NULL,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
    `requiredReason` VARCHAR(255) NOT NULL,
    `thresholdMinor` BIGINT NULL,
    `decidedById` CHAR(26) NULL,
    `decidedAt` DATETIME(3) NULL,
    `comment` VARCHAR(512) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_order_approval_status`(`status`, `createdAt`),
    INDEX `ix_order_approval_order`(`orderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `idempotency_records` (
    `id` CHAR(26) NOT NULL,
    `scope` VARCHAR(64) NOT NULL,
    `key` VARCHAR(128) NOT NULL,
    `requestHash` CHAR(64) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `responseJson` JSON NULL,
    `httpStatus` INTEGER NULL,
    `ownerId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completedAt` DATETIME(3) NULL,
    `expiresAt` DATETIME(3) NOT NULL,

    INDEX `ix_idempotency_expires`(`expiresAt`),
    UNIQUE INDEX `uq_idempotency_scope_key`(`scope`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment_provider_connections` (
    `id` CHAR(26) NOT NULL,
    `provider` ENUM('RAZORPAY', 'STRIPE') NOT NULL,
    `mode` ENUM('TEST', 'LIVE') NOT NULL,
    `label` VARCHAR(128) NOT NULL,
    `credentialsEnc` TEXT NOT NULL,
    `webhookSecretEnc` TEXT NULL,
    `credentialsMask` VARCHAR(64) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT false,
    `lastTestedAt` DATETIME(3) NULL,
    `lastTestStatus` VARCHAR(32) NULL,
    `lastTestMessage` VARCHAR(512) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `createdById` CHAR(26) NULL,

    INDEX `ix_payment_connection_active`(`isActive`),
    UNIQUE INDEX `uq_payment_connection_provider_mode`(`provider`, `mode`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment_transactions` (
    `id` CHAR(26) NOT NULL,
    `orderId` CHAR(26) NOT NULL,
    `connectionId` CHAR(26) NOT NULL,
    `provider` ENUM('RAZORPAY', 'STRIPE') NOT NULL,
    `mode` ENUM('TEST', 'LIVE') NOT NULL,
    `providerOrderId` VARCHAR(128) NULL,
    `providerPaymentId` VARCHAR(128) NULL,
    `status` ENUM('CREATED', 'PENDING', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'CANCELLED', 'EXPIRED') NOT NULL DEFAULT 'CREATED',
    `amountMinor` BIGINT NOT NULL,
    `capturedMinor` BIGINT NOT NULL DEFAULT 0,
    `currency` CHAR(3) NOT NULL,
    `method` VARCHAR(48) NULL,
    `failureCode` VARCHAR(64) NULL,
    `failureMessage` VARCHAR(512) NULL,
    `idempotencyKey` VARCHAR(128) NOT NULL,
    `mandateReference` VARCHAR(128) NULL,
    `authorizedAt` DATETIME(3) NULL,
    `capturedAt` DATETIME(3) NULL,
    `failedAt` DATETIME(3) NULL,
    `reconciledAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_payment_provider_payment_id`(`providerPaymentId`),
    UNIQUE INDEX `uq_payment_idempotency_key`(`idempotencyKey`),
    INDEX `ix_payment_order_time`(`orderId`, `createdAt`),
    INDEX `ix_payment_status_time`(`status`, `createdAt`),
    INDEX `ix_payment_provider_order`(`providerOrderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment_events` (
    `id` CHAR(26) NOT NULL,
    `provider` ENUM('RAZORPAY', 'STRIPE') NOT NULL,
    `connectionId` CHAR(26) NULL,
    `providerEventId` VARCHAR(191) NOT NULL,
    `eventType` VARCHAR(96) NOT NULL,
    `signatureVerified` BOOLEAN NOT NULL DEFAULT false,
    `rawPayload` LONGTEXT NOT NULL,
    `processingStatus` ENUM('RECEIVED', 'PROCESSED', 'DUPLICATE', 'REJECTED', 'FAILED') NOT NULL DEFAULT 'RECEIVED',
    `processingError` VARCHAR(1024) NULL,
    `orderId` CHAR(26) NULL,
    `paymentTransactionId` CHAR(26) NULL,
    `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `processedAt` DATETIME(3) NULL,

    UNIQUE INDEX `uq_payment_event_provider_id`(`providerEventId`),
    INDEX `ix_payment_event_status_time`(`processingStatus`, `receivedAt`),
    INDEX `ix_payment_event_order`(`orderId`),
    INDEX `ix_payment_event_time`(`receivedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment_links` (
    `id` CHAR(26) NOT NULL,
    `orderId` CHAR(26) NOT NULL,
    `tokenHash` CHAR(64) NOT NULL,
    `recipientEmail` VARCHAR(320) NOT NULL,
    `recipientName` VARCHAR(255) NULL,
    `amountMinor` BIGINT NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `sentAt` DATETIME(3) NULL,
    `openedAt` DATETIME(3) NULL,
    `usedAt` DATETIME(3) NULL,
    `revokedAt` DATETIME(3) NULL,
    `revokedReason` VARCHAR(255) NULL,
    `supersededByLinkId` CHAR(26) NULL,
    `createdById` CHAR(26) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_payment_link_token_hash`(`tokenHash`),
    INDEX `ix_payment_link_order`(`orderId`, `createdAt`),
    INDEX `ix_payment_link_expiry`(`expiresAt`, `usedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `refunds` (
    `id` CHAR(26) NOT NULL,
    `orderId` CHAR(26) NOT NULL,
    `paymentTransactionId` CHAR(26) NOT NULL,
    `provider` ENUM('RAZORPAY', 'STRIPE') NOT NULL,
    `providerRefundId` VARCHAR(128) NULL,
    `amountMinor` BIGINT NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `reason` VARCHAR(512) NOT NULL,
    `status` ENUM('REQUESTED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'REQUESTED',
    `requestedById` CHAR(26) NOT NULL,
    `approvedById` CHAR(26) NULL,
    `idempotencyKey` VARCHAR(128) NOT NULL,
    `failureCode` VARCHAR(64) NULL,
    `failureMessage` VARCHAR(512) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `completedAt` DATETIME(3) NULL,

    UNIQUE INDEX `uq_refund_provider_id`(`providerRefundId`),
    UNIQUE INDEX `uq_refund_idempotency_key`(`idempotencyKey`),
    INDEX `ix_refund_order_time`(`orderId`, `createdAt`),
    INDEX `ix_refund_status_time`(`status`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `recurring_schedules` (
    `id` CHAR(26) NOT NULL,
    `customerProfileId` CHAR(26) NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `status` ENUM('ACTIVE', 'PAUSED', 'CANCELLED', 'FAILED') NOT NULL DEFAULT 'ACTIVE',
    `frequency` ENUM('EVERY_N_DAYS', 'WEEKLY', 'MONTHLY') NOT NULL,
    `intervalDays` INTEGER NULL,
    `weekday` INTEGER NULL,
    `monthDay` INTEGER NULL,
    `timezone` VARCHAR(64) NOT NULL,
    `runAtMinute` INTEGER NOT NULL DEFAULT 360,
    `startDate` DATE NOT NULL,
    `endDate` DATE NULL,
    `maxOccurrences` INTEGER NULL,
    `occurrenceCount` INTEGER NOT NULL DEFAULT 0,
    `nextRunAt` DATETIME(3) NULL,
    `lastRunAt` DATETIME(3) NULL,
    `paymentMode` ENUM('AUTO_PAY', 'PAYMENT_LINK') NOT NULL,
    `mandateReference` VARCHAR(128) NULL,
    `mandateProvider` ENUM('RAZORPAY', 'STRIPE') NULL,
    `payerEmail` VARCHAR(320) NULL,
    `shippingAddressId` CHAR(26) NOT NULL,
    `billingAddressId` CHAR(26) NOT NULL,
    `shippingMethodCode` VARCHAR(32) NULL,
    `consentAcceptedAt` DATETIME(3) NOT NULL,
    `consentVersion` VARCHAR(32) NOT NULL,
    `repriceApprovalThresholdMinor` BIGINT NULL,
    `failureCount` INTEGER NOT NULL DEFAULT 0,
    `maxFailures` INTEGER NOT NULL DEFAULT 3,
    `pausedAt` DATETIME(3) NULL,
    `pausedReason` VARCHAR(512) NULL,
    `pausedById` CHAR(26) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `cancelReason` VARCHAR(512) NULL,
    `leaseOwner` VARCHAR(64) NULL,
    `leaseExpiresAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_schedule_due`(`status`, `nextRunAt`),
    INDEX `ix_schedule_customer_status`(`customerProfileId`, `status`),
    INDEX `ix_schedule_lease`(`leaseExpiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `recurring_schedule_items` (
    `id` CHAR(26) NOT NULL,
    `scheduleId` CHAR(26) NOT NULL,
    `productId` CHAR(26) NOT NULL,
    `variantId` CHAR(26) NULL,
    `variantKey` VARCHAR(26) NOT NULL DEFAULT '',
    `quantity` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_schedule_item_product`(`productId`),
    UNIQUE INDEX `uq_schedule_item_sku`(`scheduleId`, `productId`, `variantKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `schedule_occurrences` (
    `id` CHAR(26) NOT NULL,
    `scheduleId` CHAR(26) NOT NULL,
    `plannedRunAt` DATETIME(3) NOT NULL,
    `status` ENUM('PENDING', 'ORDER_CREATED', 'PAID', 'SKIPPED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `attemptCount` INTEGER NOT NULL DEFAULT 0,
    `lastAttemptAt` DATETIME(3) NULL,
    `nextRetryAt` DATETIME(3) NULL,
    `quotedTotalMinor` BIGINT NULL,
    `actualTotalMinor` BIGINT NULL,
    `failureCode` VARCHAR(64) NULL,
    `failureMessage` VARCHAR(512) NULL,
    `skipReason` VARCHAR(512) NULL,
    `reminderSentAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completedAt` DATETIME(3) NULL,

    INDEX `ix_occurrence_retry`(`status`, `nextRetryAt`),
    INDEX `ix_occurrence_planned`(`plannedRunAt`),
    UNIQUE INDEX `uq_occurrence_schedule_run`(`scheduleId`, `plannedRunAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `shipments` (
    `id` CHAR(26) NOT NULL,
    `orderId` CHAR(26) NOT NULL,
    `carrier` VARCHAR(128) NOT NULL,
    `trackingNumber` VARCHAR(128) NULL,
    `trackingUrl` VARCHAR(1024) NULL,
    `status` ENUM('CREATED', 'DISPATCHED', 'IN_TRANSIT', 'DELIVERED', 'FAILED', 'RETURNED_TO_ORIGIN') NOT NULL DEFAULT 'CREATED',
    `itemsJson` JSON NOT NULL,
    `dispatchedAt` DATETIME(3) NULL,
    `deliveredAt` DATETIME(3) NULL,
    `notes` VARCHAR(512) NULL,
    `createdById` CHAR(26) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_shipment_order`(`orderId`),
    INDEX `ix_shipment_status_time`(`status`, `createdAt`),
    INDEX `ix_shipment_tracking`(`trackingNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `return_requests` (
    `id` CHAR(26) NOT NULL,
    `orderId` CHAR(26) NOT NULL,
    `status` ENUM('REQUESTED', 'APPROVED', 'REJECTED', 'RECEIVED', 'INSPECTED', 'COMPLETED') NOT NULL DEFAULT 'REQUESTED',
    `reason` VARCHAR(512) NOT NULL,
    `itemsJson` JSON NOT NULL,
    `requestedById` CHAR(26) NOT NULL,
    `decidedById` CHAR(26) NULL,
    `decidedAt` DATETIME(3) NULL,
    `decisionNote` VARCHAR(512) NULL,
    `refundId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `completedAt` DATETIME(3) NULL,

    INDEX `ix_return_order`(`orderId`),
    INDEX `ix_return_status_time`(`status`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `integration_connections` (
    `id` CHAR(26) NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `baseUrl` VARCHAR(1024) NOT NULL,
    `authType` ENUM('NONE', 'API_KEY_HEADER', 'BEARER_TOKEN', 'BASIC') NOT NULL DEFAULT 'NONE',
    `credentialsEnc` TEXT NULL,
    `credentialsMask` VARCHAR(64) NULL,
    `fieldMappingJson` JSON NOT NULL,
    `direction` ENUM('IMPORT', 'EXPORT', 'BIDIRECTIONAL') NOT NULL DEFAULT 'IMPORT',
    `conflictPolicy` ENUM('EXTERNAL_WINS', 'UBOSS_WINS', 'FIELD_LEVEL') NOT NULL DEFAULT 'EXTERNAL_WINS',
    `scheduleCron` VARCHAR(64) NULL,
    `timeoutMs` INTEGER NOT NULL DEFAULT 15000,
    `maxRetries` INTEGER NOT NULL DEFAULT 3,
    `circuitState` ENUM('CLOSED', 'OPEN', 'HALF_OPEN') NOT NULL DEFAULT 'CLOSED',
    `circuitOpenedAt` DATETIME(3) NULL,
    `consecutiveFailures` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT false,
    `lastSuccessAt` DATETIME(3) NULL,
    `lastTestedAt` DATETIME(3) NULL,
    `lastTestStatus` VARCHAR(32) NULL,
    `alertRecipientsJson` JSON NULL,
    `createdById` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_integration_active`(`isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sync_runs` (
    `id` CHAR(26) NOT NULL,
    `connectionId` CHAR(26) NOT NULL,
    `status` ENUM('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'RUNNING',
    `isDryRun` BOOLEAN NOT NULL DEFAULT false,
    `triggeredBy` VARCHAR(32) NOT NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,
    `totalRecords` INTEGER NOT NULL DEFAULT 0,
    `createdCount` INTEGER NOT NULL DEFAULT 0,
    `updatedCount` INTEGER NOT NULL DEFAULT 0,
    `skippedCount` INTEGER NOT NULL DEFAULT 0,
    `failureCount` INTEGER NOT NULL DEFAULT 0,
    `summaryJson` JSON NULL,
    `errorMessage` VARCHAR(1024) NULL,

    INDEX `ix_sync_run_connection_time`(`connectionId`, `startedAt`),
    INDEX `ix_sync_run_status_time`(`status`, `startedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sync_errors` (
    `id` CHAR(26) NOT NULL,
    `syncRunId` CHAR(26) NOT NULL,
    `rowRef` VARCHAR(128) NULL,
    `field` VARCHAR(128) NULL,
    `errorCode` VARCHAR(64) NOT NULL,
    `errorMessage` VARCHAR(1024) NOT NULL,
    `payloadJson` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_sync_error_run`(`syncRunId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `import_jobs` (
    `id` CHAR(26) NOT NULL,
    `type` VARCHAR(32) NOT NULL,
    `fileKey` VARCHAR(512) NOT NULL,
    `fileName` VARCHAR(255) NOT NULL,
    `isDryRun` BOOLEAN NOT NULL DEFAULT true,
    `status` ENUM('PENDING', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'DEAD', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `totalRows` INTEGER NOT NULL DEFAULT 0,
    `validRows` INTEGER NOT NULL DEFAULT 0,
    `errorRows` INTEGER NOT NULL DEFAULT 0,
    `createdRows` INTEGER NOT NULL DEFAULT 0,
    `updatedRows` INTEGER NOT NULL DEFAULT 0,
    `resultJson` JSON NULL,
    `errorMessage` VARCHAR(1024) NULL,
    `confirmedFromJobId` CHAR(26) NULL,
    `createdById` CHAR(26) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,

    INDEX `ix_import_job_type_status`(`type`, `status`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `import_row_errors` (
    `id` CHAR(26) NOT NULL,
    `importJobId` CHAR(26) NOT NULL,
    `rowNumber` INTEGER NOT NULL,
    `field` VARCHAR(128) NULL,
    `code` VARCHAR(64) NOT NULL,
    `message` VARCHAR(1024) NOT NULL,
    `rawJson` JSON NULL,

    INDEX `ix_import_row_error_job`(`importJobId`, `rowNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `export_jobs` (
    `id` CHAR(26) NOT NULL,
    `type` VARCHAR(32) NOT NULL,
    `paramsJson` JSON NOT NULL,
    `status` ENUM('PENDING', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'DEAD', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `fileKey` VARCHAR(512) NULL,
    `fileName` VARCHAR(255) NULL,
    `rowCount` INTEGER NULL,
    `downloadTokenHash` CHAR(64) NULL,
    `downloadExpiresAt` DATETIME(3) NULL,
    `downloadedAt` DATETIME(3) NULL,
    `errorMessage` VARCHAR(1024) NULL,
    `createdById` CHAR(26) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completedAt` DATETIME(3) NULL,

    UNIQUE INDEX `uq_export_download_token`(`downloadTokenHash`),
    INDEX `ix_export_job_type_status`(`type`, `status`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notification_outbox` (
    `id` CHAR(26) NOT NULL,
    `eventKey` VARCHAR(96) NOT NULL,
    `channel` ENUM('EMAIL', 'SMS') NOT NULL DEFAULT 'EMAIL',
    `recipientEmail` VARCHAR(320) NULL,
    `recipientPhone` VARCHAR(32) NULL,
    `recipientName` VARCHAR(255) NULL,
    `subject` VARCHAR(255) NOT NULL,
    `body` LONGTEXT NOT NULL,
    `payloadJson` JSON NULL,
    `status` ENUM('PENDING', 'SENDING', 'SENT', 'FAILED', 'DEAD', 'SUPPRESSED') NOT NULL DEFAULT 'PENDING',
    `attemptCount` INTEGER NOT NULL DEFAULT 0,
    `maxAttempts` INTEGER NOT NULL DEFAULT 5,
    `nextAttemptAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `dedupeKey` VARCHAR(191) NULL,
    `lastError` VARCHAR(1024) NULL,
    `relatedType` VARCHAR(48) NULL,
    `relatedId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `sentAt` DATETIME(3) NULL,

    UNIQUE INDEX `uq_outbox_dedupe_key`(`dedupeKey`),
    INDEX `ix_outbox_due`(`status`, `nextAttemptAt`),
    INDEX `ix_outbox_event_time`(`eventKey`, `createdAt`),
    INDEX `ix_outbox_related`(`relatedType`, `relatedId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notification_deliveries` (
    `id` CHAR(26) NOT NULL,
    `outboxId` CHAR(26) NOT NULL,
    `provider` VARCHAR(48) NOT NULL,
    `providerMessageId` VARCHAR(191) NULL,
    `status` VARCHAR(32) NOT NULL,
    `errorMessage` VARCHAR(1024) NULL,
    `durationMs` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_delivery_outbox`(`outboxId`),
    INDEX `ix_delivery_time`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `job_queue` (
    `id` CHAR(26) NOT NULL,
    `queue` VARCHAR(48) NOT NULL DEFAULT 'default',
    `jobType` VARCHAR(64) NOT NULL,
    `payloadJson` JSON NOT NULL,
    `status` ENUM('PENDING', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'DEAD', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `priority` INTEGER NOT NULL DEFAULT 0,
    `runAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `attemptCount` INTEGER NOT NULL DEFAULT 0,
    `maxAttempts` INTEGER NOT NULL DEFAULT 5,
    `leaseOwner` VARCHAR(64) NULL,
    `leaseExpiresAt` DATETIME(3) NULL,
    `lastError` TEXT NULL,
    `dedupeKey` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,

    UNIQUE INDEX `uq_job_dedupe_key`(`dedupeKey`),
    INDEX `ix_job_claim`(`status`, `runAt`, `priority`),
    INDEX `ix_job_queue_status`(`queue`, `status`),
    INDEX `ix_job_lease_reaper`(`leaseExpiresAt`),
    INDEX `ix_job_type_status`(`jobType`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `rate_limit_buckets` (
    `bucketKey` VARCHAR(191) NOT NULL,
    `counter` INTEGER NOT NULL DEFAULT 0,
    `windowStart` DATETIME(3) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_rate_limit_expires`(`expiresAt`),
    PRIMARY KEY (`bucketKey`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_logs` (
    `id` CHAR(26) NOT NULL,
    `actorType` ENUM('SYSTEM', 'ADMIN', 'CUSTOMER', 'PROVIDER') NOT NULL DEFAULT 'SYSTEM',
    `actorUserId` CHAR(26) NULL,
    `actorEmail` VARCHAR(320) NULL,
    `action` VARCHAR(96) NOT NULL,
    `resourceType` VARCHAR(48) NOT NULL,
    `resourceId` CHAR(26) NULL,
    `beforeJson` JSON NULL,
    `afterJson` JSON NULL,
    `ipAddress` VARCHAR(45) NULL,
    `userAgent` VARCHAR(512) NULL,
    `correlationId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_audit_resource`(`resourceType`, `resourceId`, `createdAt`),
    INDEX `ix_audit_actor`(`actorUserId`, `createdAt`),
    INDEX `ix_audit_action`(`action`, `createdAt`),
    INDEX `ix_audit_time`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `number_sequences` (
    `key` VARCHAR(64) NOT NULL,
    `value` BIGINT NOT NULL DEFAULT 0,
    `prefix` VARCHAR(16) NOT NULL,
    `padding` INTEGER NOT NULL DEFAULT 6,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `role_permissions` ADD CONSTRAINT `role_permissions_roleId_fkey` FOREIGN KEY (`roleId`) REFERENCES `roles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `role_permissions` ADD CONSTRAINT `role_permissions_permissionId_fkey` FOREIGN KEY (`permissionId`) REFERENCES `permissions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_roles` ADD CONSTRAINT `user_roles_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_roles` ADD CONSTRAINT `user_roles_roleId_fkey` FOREIGN KEY (`roleId`) REFERENCES `roles`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `auth_tokens` ADD CONSTRAINT `auth_tokens_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_profile` ADD CONSTRAINT `business_profile_logoMediaId_fkey` FOREIGN KEY (`logoMediaId`) REFERENCES `media_assets`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `categories` ADD CONSTRAINT `categories_parentId_fkey` FOREIGN KEY (`parentId`) REFERENCES `categories`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `categories` ADD CONSTRAINT `categories_imageMediaId_fkey` FOREIGN KEY (`imageMediaId`) REFERENCES `media_assets`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `categories` ADD CONSTRAINT `categories_bannerMediaId_fkey` FOREIGN KEY (`bannerMediaId`) REFERENCES `media_assets`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `products` ADD CONSTRAINT `products_categoryId_fkey` FOREIGN KEY (`categoryId`) REFERENCES `categories`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `products` ADD CONSTRAINT `products_taxClassId_fkey` FOREIGN KEY (`taxClassId`) REFERENCES `tax_classes`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `product_variants` ADD CONSTRAINT `product_variants_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `product_media` ADD CONSTRAINT `product_media_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `product_media` ADD CONSTRAINT `product_media_mediaId_fkey` FOREIGN KEY (`mediaId`) REFERENCES `media_assets`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `product_attributes` ADD CONSTRAINT `product_attributes_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inventory_balances` ADD CONSTRAINT `inventory_balances_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inventory_balances` ADD CONSTRAINT `inventory_balances_variantId_fkey` FOREIGN KEY (`variantId`) REFERENCES `product_variants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inventory_balances` ADD CONSTRAINT `inventory_balances_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `inventory_locations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inventory_movements` ADD CONSTRAINT `inventory_movements_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inventory_movements` ADD CONSTRAINT `inventory_movements_variantId_fkey` FOREIGN KEY (`variantId`) REFERENCES `product_variants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inventory_movements` ADD CONSTRAINT `inventory_movements_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `inventory_locations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_reservations` ADD CONSTRAINT `stock_reservations_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_reservations` ADD CONSTRAINT `stock_reservations_variantId_fkey` FOREIGN KEY (`variantId`) REFERENCES `product_variants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_reservations` ADD CONSTRAINT `stock_reservations_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `inventory_locations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_reservations` ADD CONSTRAINT `stock_reservations_cartId_fkey` FOREIGN KEY (`cartId`) REFERENCES `carts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_reservations` ADD CONSTRAINT `stock_reservations_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_profiles` ADD CONSTRAINT `customer_profiles_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `addresses` ADD CONSTRAINT `addresses_customerProfileId_fkey` FOREIGN KEY (`customerProfileId`) REFERENCES `customer_profiles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `carts` ADD CONSTRAINT `carts_customerProfileId_fkey` FOREIGN KEY (`customerProfileId`) REFERENCES `customer_profiles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cart_items` ADD CONSTRAINT `cart_items_cartId_fkey` FOREIGN KEY (`cartId`) REFERENCES `carts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cart_items` ADD CONSTRAINT `cart_items_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cart_items` ADD CONSTRAINT `cart_items_variantId_fkey` FOREIGN KEY (`variantId`) REFERENCES `product_variants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `orders` ADD CONSTRAINT `orders_customerProfileId_fkey` FOREIGN KEY (`customerProfileId`) REFERENCES `customer_profiles`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `orders` ADD CONSTRAINT `orders_cartId_fkey` FOREIGN KEY (`cartId`) REFERENCES `carts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `orders` ADD CONSTRAINT `orders_scheduleOccurrenceId_fkey` FOREIGN KEY (`scheduleOccurrenceId`) REFERENCES `schedule_occurrences`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `order_items` ADD CONSTRAINT `order_items_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `order_items` ADD CONSTRAINT `order_items_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `order_items` ADD CONSTRAINT `order_items_variantId_fkey` FOREIGN KEY (`variantId`) REFERENCES `product_variants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `order_status_history` ADD CONSTRAINT `order_status_history_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `order_approvals` ADD CONSTRAINT `order_approvals_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_transactions` ADD CONSTRAINT `payment_transactions_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_transactions` ADD CONSTRAINT `payment_transactions_connectionId_fkey` FOREIGN KEY (`connectionId`) REFERENCES `payment_provider_connections`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_events` ADD CONSTRAINT `payment_events_connectionId_fkey` FOREIGN KEY (`connectionId`) REFERENCES `payment_provider_connections`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_events` ADD CONSTRAINT `payment_events_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_events` ADD CONSTRAINT `payment_events_paymentTransactionId_fkey` FOREIGN KEY (`paymentTransactionId`) REFERENCES `payment_transactions`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_links` ADD CONSTRAINT `payment_links_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `refunds` ADD CONSTRAINT `refunds_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `refunds` ADD CONSTRAINT `refunds_paymentTransactionId_fkey` FOREIGN KEY (`paymentTransactionId`) REFERENCES `payment_transactions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `recurring_schedules` ADD CONSTRAINT `recurring_schedules_customerProfileId_fkey` FOREIGN KEY (`customerProfileId`) REFERENCES `customer_profiles`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `recurring_schedules` ADD CONSTRAINT `recurring_schedules_shippingAddressId_fkey` FOREIGN KEY (`shippingAddressId`) REFERENCES `addresses`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `recurring_schedules` ADD CONSTRAINT `recurring_schedules_billingAddressId_fkey` FOREIGN KEY (`billingAddressId`) REFERENCES `addresses`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `recurring_schedule_items` ADD CONSTRAINT `recurring_schedule_items_scheduleId_fkey` FOREIGN KEY (`scheduleId`) REFERENCES `recurring_schedules`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `recurring_schedule_items` ADD CONSTRAINT `recurring_schedule_items_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `recurring_schedule_items` ADD CONSTRAINT `recurring_schedule_items_variantId_fkey` FOREIGN KEY (`variantId`) REFERENCES `product_variants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `schedule_occurrences` ADD CONSTRAINT `schedule_occurrences_scheduleId_fkey` FOREIGN KEY (`scheduleId`) REFERENCES `recurring_schedules`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `shipments` ADD CONSTRAINT `shipments_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `return_requests` ADD CONSTRAINT `return_requests_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `return_requests` ADD CONSTRAINT `return_requests_refundId_fkey` FOREIGN KEY (`refundId`) REFERENCES `refunds`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sync_runs` ADD CONSTRAINT `sync_runs_connectionId_fkey` FOREIGN KEY (`connectionId`) REFERENCES `integration_connections`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sync_errors` ADD CONSTRAINT `sync_errors_syncRunId_fkey` FOREIGN KEY (`syncRunId`) REFERENCES `sync_runs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `import_row_errors` ADD CONSTRAINT `import_row_errors_importJobId_fkey` FOREIGN KEY (`importJobId`) REFERENCES `import_jobs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notification_deliveries` ADD CONSTRAINT `notification_deliveries_outboxId_fkey` FOREIGN KEY (`outboxId`) REFERENCES `notification_outbox`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_actorUserId_fkey` FOREIGN KEY (`actorUserId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

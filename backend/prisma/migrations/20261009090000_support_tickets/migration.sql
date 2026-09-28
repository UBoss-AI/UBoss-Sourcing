-- Support tickets: a request somebody sent from the Support page, and the
-- history of what happened to it. See the SUPPORT section of schema.prisma.
--
-- Two new tables and nothing else. No existing row is touched, so this is
-- safe to apply to a live installation: until somebody sends a request, the
-- inbox is simply empty.
--
-- No CHECK constraints. The rules that matter (who may read a ticket, which
-- status may follow which) are enforced in the service, and a CHECK on a
-- foreign-key column would also need ON UPDATE RESTRICT on MariaDB 11.4
-- (error 1901), which none of these relations wants.

-- CreateTable
CREATE TABLE `support_tickets` (
    `id`                  CHAR(26)      NOT NULL,
    `reference`           VARCHAR(16)   NOT NULL,
    `requesterUserId`     CHAR(26)      NOT NULL,
    `requesterRole`       ENUM('BUYER', 'COMPANY_BUYER', 'SELLER', 'LOGISTICS_PARTNER') NOT NULL,
    `source`              ENUM('STOREFRONT', 'SELLER_HUB', 'LOGISTICS_PORTAL') NOT NULL,
    `customerProfileId`   CHAR(26)      NULL,
    `buyerCompanyId`      CHAR(26)      NULL,
    `sellerAccountId`     CHAR(26)      NULL,
    `logisticsPartnerId`  CHAR(26)      NULL,
    `nameSnapshot`        VARCHAR(120)  NOT NULL,
    `emailSnapshot`       VARCHAR(254)  NOT NULL,
    `companyNameSnapshot` VARCHAR(255)  NULL,
    `language`            VARCHAR(10)   NULL,
    `category`            ENUM('ORDERS', 'PAYMENTS', 'PREORDERS', 'PRODUCTS', 'SELLER_HUB', 'LOGISTICS', 'COMPANY_VERIFICATION', 'ERP_INTEGRATION', 'ACCOUNT_SECURITY', 'OTHER') NOT NULL,
    `subject`             VARCHAR(160)  NOT NULL,
    `message`             TEXT          NOT NULL,
    `relatedOrderId`      CHAR(26)      NULL,
    `relatedOrderNumber`  VARCHAR(32)   NULL,
    `status`              ENUM('OPEN', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED') NOT NULL DEFAULT 'OPEN',
    `priority`            ENUM('LOW', 'NORMAL', 'HIGH', 'URGENT') NOT NULL DEFAULT 'NORMAL',
    `assignedAdminId`     CHAR(26)      NULL,
    `lastActivityAt`      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `resolvedAt`          DATETIME(3)   NULL,
    `closedAt`            DATETIME(3)   NULL,
    `createdAt`           DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt`           DATETIME(3)   NOT NULL,

    UNIQUE INDEX `uq_support_ticket_reference`(`reference`),
    INDEX `ix_support_ticket_requester`(`requesterUserId`, `createdAt`),
    INDEX `ix_support_ticket_status`(`status`, `lastActivityAt`),
    INDEX `ix_support_ticket_assignee`(`assignedAdminId`, `status`),
    INDEX `ix_support_ticket_customer`(`customerProfileId`),
    INDEX `ix_support_ticket_company`(`buyerCompanyId`),
    INDEX `ix_support_ticket_seller`(`sellerAccountId`),
    INDEX `ix_support_ticket_logistics`(`logisticsPartnerId`),
    INDEX `ix_support_ticket_order`(`relatedOrderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `support_ticket_events` (
    `id`                 CHAR(26)     NOT NULL,
    `ticketId`           CHAR(26)     NOT NULL,
    `kind`               ENUM('CREATED', 'REQUESTER_MESSAGE', 'STAFF_REPLY', 'INTERNAL_NOTE', 'STATUS_CHANGED', 'PRIORITY_CHANGED', 'ASSIGNED') NOT NULL,
    `visibleToRequester` BOOLEAN      NOT NULL,
    `actorUserId`        CHAR(26)     NULL,
    `actorIsRequester`   BOOLEAN      NOT NULL DEFAULT false,
    `body`               TEXT         NULL,
    `fromValue`          VARCHAR(40)  NULL,
    `toValue`            VARCHAR(40)  NULL,
    `createdAt`          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_support_ticket_event_ticket`(`ticketId`, `createdAt`),
    INDEX `ix_support_ticket_event_actor`(`actorUserId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `support_tickets`
    ADD CONSTRAINT `fk_support_ticket_requester` FOREIGN KEY (`requesterUserId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `support_tickets`
    ADD CONSTRAINT `fk_support_ticket_customer` FOREIGN KEY (`customerProfileId`) REFERENCES `customer_profiles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `support_tickets`
    ADD CONSTRAINT `fk_support_ticket_company` FOREIGN KEY (`buyerCompanyId`) REFERENCES `buyer_companies`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `support_tickets`
    ADD CONSTRAINT `fk_support_ticket_seller` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `support_tickets`
    ADD CONSTRAINT `fk_support_ticket_logistics` FOREIGN KEY (`logisticsPartnerId`) REFERENCES `logistics_partners`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `support_tickets`
    ADD CONSTRAINT `fk_support_ticket_order` FOREIGN KEY (`relatedOrderId`) REFERENCES `orders`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `support_tickets`
    ADD CONSTRAINT `fk_support_ticket_assignee` FOREIGN KEY (`assignedAdminId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `support_ticket_events`
    ADD CONSTRAINT `fk_support_ticket_event_ticket` FOREIGN KEY (`ticketId`) REFERENCES `support_tickets`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `support_ticket_events`
    ADD CONSTRAINT `fk_support_ticket_event_actor` FOREIGN KEY (`actorUserId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- Doc 07 (Delivery, Returns, Refunds and Dispute Administration Policy v1.0)
-- and Doc 08 (Commercial, Certification and Launch Approval Guide v1.0).
--
-- Additive only: 32 new tables and one nullable column on proof of delivery.
-- No row is back-filled and nothing is activated. Commercial schedules are
-- seeded as DRAFT by the reference-data seed, never by this migration.

-- AlterTable
ALTER TABLE `logistics_proof_of_delivery` ADD COLUMN `quantitiesJson` JSON NULL;

-- CreateTable
CREATE TABLE `commercial_schedules` (
    `id` CHAR(26) NOT NULL,
    `kind` VARCHAR(32) NOT NULL,
    `version` INTEGER NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    `title` VARCHAR(200) NOT NULL,
    `sourceDocument` VARCHAR(200) NOT NULL,
    `scopeJson` JSON NOT NULL,
    `bodyJson` JSON NOT NULL,
    `effectiveFrom` DATETIME(3) NULL,
    `effectiveUntil` DATETIME(3) NULL,
    `scheduleReference` VARCHAR(200) NULL,
    `preparedById` CHAR(26) NULL,
    `submittedAt` DATETIME(3) NULL,
    `approvedById` CHAR(26) NULL,
    `approvedAt` DATETIME(3) NULL,
    `approvalEvidence` TEXT NULL,
    `providerConfirmationRef` VARCHAR(200) NULL,
    `providerConfirmedAt` DATETIME(3) NULL,
    `activatedById` CHAR(26) NULL,
    `activatedAt` DATETIME(3) NULL,
    `retiredAt` DATETIME(3) NULL,
    `note` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_cs_kind_status`(`kind`, `status`),
    UNIQUE INDEX `uq_cs_kind_version`(`kind`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `commercial_schedule_events` (
    `id` CHAR(26) NOT NULL,
    `scheduleId` CHAR(26) NOT NULL,
    `kind` VARCHAR(32) NOT NULL,
    `actorUserId` CHAR(26) NULL,
    `note` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_cse_schedule`(`scheduleId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `order_line_commercial_snapshots` (
    `id` CHAR(26) NOT NULL,
    `orderId` CHAR(26) NOT NULL,
    `orderItemId` CHAR(26) NOT NULL,
    `sellerOrderGroupId` CHAR(26) NULL,
    `sellerAccountId` CHAR(26) NULL,
    `offerId` CHAR(26) NULL,
    `manufacturerName` VARCHAR(200) NULL,
    `productVersion` VARCHAR(64) NULL,
    `facilityRef` VARCHAR(64) NULL,
    `approvalScopeId` CHAR(26) NULL,
    `sellerCountry` CHAR(2) NULL,
    `destinationCountry` CHAR(2) NOT NULL,
    `channel` VARCHAR(4) NOT NULL,
    `departmentSlug` VARCHAR(120) NULL,
    `deliveryTerm` VARCHAR(12) NOT NULL,
    `namedPlace` VARCHAR(400) NULL,
    `importerOfRecord` VARCHAR(24) NOT NULL,
    `importRouteId` CHAR(26) NULL,
    `localActorsJson` JSON NULL,
    `titleTransferPoint` VARCHAR(200) NULL,
    `riskTransferPoint` VARCHAR(200) NULL,
    `promisedDeliveryFrom` DATETIME(3) NULL,
    `promisedDeliveryTo` DATETIME(3) NULL,
    `technicalAcceptanceDays` INTEGER NULL,
    `leadTimeDays` INTEGER NULL,
    `returnRoute` VARCHAR(400) NULL,
    `packagingNote` VARCHAR(400) NULL,
    `transportRestrictionsJson` JSON NULL,
    `insuranceJson` JSON NULL,
    `paymentMilestonesJson` JSON NULL,
    `goodsMinor` BIGINT NOT NULL,
    `sellerFundedDiscountMinor` BIGINT NOT NULL DEFAULT 0,
    `platformFundedDiscountMinor` BIGINT NOT NULL DEFAULT 0,
    `taxMinor` BIGINT NOT NULL,
    `chargesJson` JSON NULL,
    `currency` CHAR(3) NOT NULL,
    `commissionBaseMinor` BIGINT NOT NULL,
    `commissionBps` INTEGER NOT NULL,
    `commissionMinor` BIGINT NOT NULL,
    `commissionSource` VARCHAR(40) NOT NULL,
    `commissionRuleVersion` VARCHAR(64) NULL,
    `rounding` VARCHAR(24) NOT NULL DEFAULT 'HALF_UP_PER_LINE',
    `certificationAllocationId` CHAR(26) NULL,
    `certificationChargeMinor` BIGINT NOT NULL DEFAULT 0,
    `policyVersionsJson` JSON NOT NULL,
    `controlGapsJson` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_olcs_item`(`orderItemId`),
    INDEX `ix_olcs_order`(`orderId`),
    INDEX `ix_olcs_group`(`sellerOrderGroupId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `import_routes` (
    `id` CHAR(26) NOT NULL,
    `countryCode` CHAR(2) NOT NULL,
    `categoryId` CHAR(26) NULL,
    `categoryKey` VARCHAR(26) NOT NULL DEFAULT '',
    `channel` VARCHAR(4) NOT NULL,
    `importerParty` VARCHAR(24) NOT NULL,
    `importerName` VARCHAR(200) NULL,
    `localActorsJson` JSON NOT NULL,
    `regulatedCategory` BOOLEAN NOT NULL DEFAULT true,
    `status` VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
    `evidence` TEXT NULL,
    `preparedById` CHAR(26) NULL,
    `reviewerUserId` CHAR(26) NULL,
    `reviewedAt` DATETIME(3) NULL,
    `validUntil` DATETIME(3) NULL,
    `note` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_import_route_country`(`countryCode`, `status`),
    UNIQUE INDEX `uq_import_route`(`countryCode`, `categoryKey`, `channel`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `dispute_case_profiles` (
    `id` CHAR(26) NOT NULL,
    `disputeId` CHAR(26) NOT NULL,
    `category` VARCHAR(24) NOT NULL,
    `urgency` VARCHAR(12) NOT NULL DEFAULT 'NORMAL',
    `market` CHAR(2) NULL,
    `channel` VARCHAR(4) NULL,
    `affectedQuantity` INTEGER NULL,
    `lotsOrSerialsJson` JSON NULL,
    `shipmentId` CHAR(26) NULL,
    `paymentTransactionId` CHAR(26) NULL,
    `lateIntake` BOOLEAN NOT NULL DEFAULT false,
    `lateIntakeReason` VARCHAR(32) NULL,
    `lateExplanation` TEXT NULL,
    `statutoryBasis` BOOLEAN NOT NULL DEFAULT false,
    `calendarTimeZone` VARCHAR(64) NOT NULL,
    `acknowledgementDueAt` DATETIME(3) NOT NULL,
    `acknowledgedAt` DATETIME(3) NULL,
    `acknowledgedById` CHAR(26) NULL,
    `evidenceSufficientAt` DATETIME(3) NULL,
    `evidenceSufficientById` CHAR(26) NULL,
    `evidenceSufficientReason` TEXT NULL,
    `initialDecisionDueAt` DATETIME(3) NULL,
    `appealReviewDueAt` DATETIME(3) NULL,
    `appealReviewerId` CHAR(26) NULL,
    `decisionParticipantsJson` JSON NULL,
    `reasonedDecisionJson` JSON NULL,
    `safetyCaseId` CHAR(26) NULL,
    `escalatedOverdueAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_dcp_dispute`(`disputeId`),
    INDEX `ix_dcp_category`(`category`),
    INDEX `ix_dcp_ack`(`acknowledgedAt`, `acknowledgementDueAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `dispute_evidence_requests` (
    `id` CHAR(26) NOT NULL,
    `disputeId` CHAR(26) NOT NULL,
    `requestedFrom` VARCHAR(12) NOT NULL,
    `purpose` VARCHAR(32) NOT NULL,
    `description` TEXT NOT NULL,
    `proportionalityNote` TEXT NOT NULL,
    `dueAt` DATETIME(3) NOT NULL,
    `status` VARCHAR(12) NOT NULL DEFAULT 'OPEN',
    `responseNote` TEXT NULL,
    `respondedAt` DATETIME(3) NULL,
    `requestedById` CHAR(26) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_der_dispute`(`disputeId`),
    INDEX `ix_der_due`(`status`, `dueAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `dispute_remedy_actions` (
    `id` CHAR(26) NOT NULL,
    `disputeId` CHAR(26) NOT NULL,
    `kind` VARCHAR(32) NOT NULL,
    `amountMinor` BIGINT NULL,
    `currency` CHAR(3) NULL,
    `payer` VARCHAR(16) NOT NULL,
    `returnFreightPayer` VARCHAR(16) NULL,
    `quantity` INTEGER NULL,
    `expectedCompletionAt` DATETIME(3) NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'PLANNED',
    `completedAt` DATETIME(3) NULL,
    `refundId` CHAR(26) NULL,
    `note` TEXT NULL,
    `decidedById` CHAR(26) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_dra_dispute`(`disputeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `dispute_testing_records` (
    `id` CHAR(26) NOT NULL,
    `disputeId` CHAR(26) NOT NULL,
    `laboratory` VARCHAR(200) NOT NULL,
    `protocol` TEXT NOT NULL,
    `agreedByBuyer` BOOLEAN NOT NULL DEFAULT false,
    `agreedBySeller` BOOLEAN NOT NULL DEFAULT false,
    `interimPayer` VARCHAR(16) NOT NULL,
    `costMinor` BIGINT NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `sampleCustody` TEXT NULL,
    `resultSummary` TEXT NULL,
    `finalPayer` VARCHAR(16) NULL,
    `finalAllocationReason` TEXT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'PLANNED',
    `recordedById` CHAR(26) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_dtr_dispute`(`disputeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `loss_recoveries` (
    `id` CHAR(26) NOT NULL,
    `orderId` CHAR(26) NOT NULL,
    `sellerOrderGroupId` CHAR(26) NULL,
    `disputeId` CHAR(26) NULL,
    `lossKey` VARCHAR(64) NOT NULL,
    `lossMinor` BIGINT NOT NULL,
    `source` VARCHAR(16) NOT NULL,
    `sourceReference` VARCHAR(128) NOT NULL,
    `amountMinor` BIGINT NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'RECORDED',
    `overlapNote` TEXT NULL,
    `recordedById` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_loss_recovery_loss`(`orderId`, `lossKey`),
    UNIQUE INDEX `uq_loss_recovery_source`(`source`, `sourceReference`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `commission_adjustments` (
    `id` CHAR(26) NOT NULL,
    `refundId` CHAR(26) NOT NULL,
    `orderItemId` CHAR(26) NOT NULL,
    `sellerOrderGroupId` CHAR(26) NULL,
    `refundedGoodsMinor` BIGINT NOT NULL,
    `reversedMinor` BIGINT NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `basis` VARCHAR(40) NOT NULL,
    `fault` VARCHAR(16) NOT NULL,
    `status` VARCHAR(12) NOT NULL DEFAULT 'PROPOSED',
    `appliedById` CHAR(26) NULL,
    `appliedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_commission_adjustment_group`(`sellerOrderGroupId`),
    UNIQUE INDEX `uq_commission_adjustment`(`refundId`, `orderItemId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `certification_programmes` (
    `id` CHAR(26) NOT NULL,
    `reference` VARCHAR(40) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `title` VARCHAR(200) NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `capBps` INTEGER NOT NULL DEFAULT 100,
    `periodStart` DATETIME(3) NOT NULL,
    `periodEnd` DATETIME(3) NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
    `fxPolicy` VARCHAR(400) NULL,
    `scheduleId` CHAR(26) NULL,
    `eligibleCostMinor` BIGINT NOT NULL DEFAULT 0,
    `reservedMinor` BIGINT NOT NULL DEFAULT 0,
    `confirmedMinor` BIGINT NOT NULL DEFAULT 0,
    `refundedMinor` BIGINT NOT NULL DEFAULT 0,
    `creditedMinor` BIGINT NOT NULL DEFAULT 0,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdById` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_cert_programme_ref`(`reference`),
    INDEX `ix_cert_programme_seller`(`sellerAccountId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `certification_cost_entries` (
    `id` CHAR(26) NOT NULL,
    `programmeId` CHAR(26) NOT NULL,
    `kind` VARCHAR(16) NOT NULL,
    `externalReference` VARCHAR(128) NOT NULL,
    `supplierName` VARCHAR(200) NOT NULL,
    `amountMinor` BIGINT NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `originalAmountMinor` BIGINT NULL,
    `originalCurrency` CHAR(3) NULL,
    `fxRate` VARCHAR(32) NULL,
    `eligible` BOOLEAN NOT NULL DEFAULT false,
    `verifiedById` CHAR(26) NULL,
    `verifiedAt` DATETIME(3) NULL,
    `evidence` TEXT NOT NULL,
    `fundedBy` VARCHAR(16) NOT NULL DEFAULT 'GLOVIAA',
    `recordedById` CHAR(26) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_cert_cost_ref`(`externalReference`),
    INDEX `ix_cert_cost_programme`(`programmeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `certification_recovery_allocations` (
    `id` CHAR(26) NOT NULL,
    `programmeId` CHAR(26) NOT NULL,
    `quoteKey` VARCHAR(80) NOT NULL,
    `orderId` CHAR(26) NULL,
    `orderItemId` CHAR(26) NULL,
    `netGoodsMinor` BIGINT NOT NULL,
    `amountMinor` BIGINT NOT NULL,
    `refundedMinor` BIGINT NOT NULL DEFAULT 0,
    `currency` CHAR(3) NOT NULL,
    `status` VARCHAR(12) NOT NULL DEFAULT 'RESERVED',
    `reservedUntil` DATETIME(3) NOT NULL,
    `confirmedAt` DATETIME(3) NULL,
    `releasedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_cert_alloc_order`(`orderId`),
    INDEX `ix_cert_alloc_status`(`status`, `reservedUntil`),
    UNIQUE INDEX `uq_cert_alloc_quote`(`programmeId`, `quoteKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_security_schedules` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `tier` VARCHAR(12) NOT NULL,
    `form` VARCHAR(16) NOT NULL,
    `reserveBps` INTEGER NOT NULL DEFAULT 0,
    `holdDays` INTEGER NOT NULL DEFAULT 0,
    `guaranteeMinor` BIGINT NOT NULL DEFAULT 0,
    `depositMinor` BIGINT NOT NULL DEFAULT 0,
    `capMinor` BIGINT NULL,
    `currency` CHAR(3) NOT NULL,
    `exposureBasis` TEXT NOT NULL,
    `documentedExposureMinor` BIGINT NULL,
    `permittedUsesJson` JSON NOT NULL,
    `noticeTerms` TEXT NULL,
    `disputeRoute` TEXT NULL,
    `providerPermissionRef` VARCHAR(200) NULL,
    `scheduleReference` VARCHAR(200) NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'PROPOSED',
    `preparedById` CHAR(26) NULL,
    `approvedById` CHAR(26) NULL,
    `approvedAt` DATETIME(3) NULL,
    `activatedAt` DATETIME(3) NULL,
    `endedAt` DATETIME(3) NULL,
    `nextMonthlyReviewAt` DATETIME(3) NULL,
    `nextQuarterlyReviewAt` DATETIME(3) NULL,
    `satisfactorySince` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_sss_seller`(`sellerAccountId`, `status`),
    INDEX `ix_sss_review`(`status`, `nextMonthlyReviewAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `security_reviews` (
    `id` CHAR(26) NOT NULL,
    `scheduleId` CHAR(26) NOT NULL,
    `kind` VARCHAR(12) NOT NULL,
    `periodKey` VARCHAR(16) NOT NULL,
    `heldMinor` BIGINT NULL,
    `exposureMinor` BIGINT NULL,
    `excessMinor` BIGINT NULL,
    `outcome` VARCHAR(20) NOT NULL DEFAULT 'DUE',
    `note` TEXT NULL,
    `reviewedById` CHAR(26) NULL,
    `reviewedAt` DATETIME(3) NULL,
    `dueAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_security_review_due`(`outcome`, `dueAt`),
    UNIQUE INDEX `uq_security_review_period`(`scheduleId`, `kind`, `periodKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `insurance_policy_records` (
    `id` CHAR(26) NOT NULL,
    `holderType` VARCHAR(12) NOT NULL,
    `sellerAccountId` CHAR(26) NULL,
    `coverType` VARCHAR(32) NOT NULL,
    `riskGroup` VARCHAR(12) NULL,
    `insurer` VARCHAR(200) NOT NULL,
    `policyNumber` VARCHAR(120) NOT NULL,
    `insuredEntity` VARCHAR(200) NOT NULL,
    `additionalInsured` VARCHAR(400) NULL,
    `sitesJson` JSON NOT NULL,
    `productsJson` JSON NOT NULL,
    `territoriesJson` JSON NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `perOccurrenceMinor` BIGINT NULL,
    `aggregateMinor` BIGINT NULL,
    `deductibleMinor` BIGINT NULL,
    `exclusions` TEXT NULL,
    `claimsMadeRetroDate` DATETIME(3) NULL,
    `effectiveFrom` DATETIME(3) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `cancellationNoticeDays` INTEGER NULL,
    `brokerName` VARCHAR(200) NULL,
    `brokerReviewedAt` DATETIME(3) NULL,
    `brokerReviewRef` VARCHAR(200) NULL,
    `verificationStatus` VARCHAR(12) NOT NULL DEFAULT 'PENDING',
    `verificationMethod` VARCHAR(200) NULL,
    `verifiedById` CHAR(26) NULL,
    `verifiedAt` DATETIME(3) NULL,
    `recordedById` CHAR(26) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_insurance_holder`(`holderType`, `sellerAccountId`),
    INDEX `ix_insurance_expiry`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `product_compliance_evidence` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `offerId` CHAR(26) NULL,
    `productKey` VARCHAR(64) NOT NULL,
    `productVersion` VARCHAR(64) NOT NULL,
    `facilityRef` VARCHAR(64) NOT NULL,
    `countryCode` CHAR(2) NOT NULL,
    `departmentSlug` VARCHAR(120) NULL,
    `kind` VARCHAR(32) NOT NULL,
    `scheme` VARCHAR(200) NOT NULL,
    `issuer` VARCHAR(200) NOT NULL,
    `accreditation` VARCHAR(200) NULL,
    `scope` TEXT NOT NULL,
    `certificateNumber` VARCHAR(120) NULL,
    `issuedOn` DATETIME(3) NULL,
    `expiresOn` DATETIME(3) NULL,
    `changeConditions` TEXT NULL,
    `surveillanceDueAt` DATETIME(3) NULL,
    `requiredForTrading` BOOLEAN NOT NULL DEFAULT true,
    `existingAccepted` BOOLEAN NOT NULL DEFAULT false,
    `gapAssessment` TEXT NULL,
    `verificationMethod` VARCHAR(200) NULL,
    `verificationEvidence` TEXT NULL,
    `verifiedById` CHAR(26) NULL,
    `verifiedAt` DATETIME(3) NULL,
    `status` VARCHAR(12) NOT NULL DEFAULT 'UNVERIFIED',
    `statusReason` TEXT NULL,
    `remindersSentJson` JSON NULL,
    `recordedById` CHAR(26) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_pce_seller_country`(`sellerAccountId`, `countryCode`),
    INDEX `ix_pce_offer`(`offerId`),
    INDEX `ix_pce_expiry`(`expiresOn`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `safety_cases` (
    `id` CHAR(26) NOT NULL,
    `reference` VARCHAR(20) NOT NULL,
    `title` VARCHAR(200) NOT NULL,
    `description` TEXT NOT NULL,
    `severity` VARCHAR(12) NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'TRIAGE',
    `sourceType` VARCHAR(16) NOT NULL,
    `sourceId` CHAR(26) NULL,
    `sellerAccountId` CHAR(26) NULL,
    `triagedById` CHAR(26) NULL,
    `triagedAt` DATETIME(3) NULL,
    `containmentJson` JSON NULL,
    `rootCause` TEXT NULL,
    `correctionEvidence` TEXT NULL,
    `verificationTests` TEXT NULL,
    `currentCertificates` TEXT NULL,
    `releaseApprovedById` CHAR(26) NULL,
    `releasedAt` DATETIME(3) NULL,
    `openedById` CHAR(26) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_safety_case_ref`(`reference`),
    INDEX `ix_safety_case_status`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `safety_case_scope` (
    `id` CHAR(26) NOT NULL,
    `safetyCaseId` CHAR(26) NOT NULL,
    `kind` VARCHAR(16) NOT NULL,
    `ref` VARCHAR(128) NOT NULL,
    `label` VARCHAR(200) NULL,
    `contained` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_safety_scope_ref`(`kind`, `ref`, `contained`),
    UNIQUE INDEX `uq_safety_scope`(`safetyCaseId`, `kind`, `ref`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `safety_case_actions` (
    `id` CHAR(26) NOT NULL,
    `safetyCaseId` CHAR(26) NOT NULL,
    `kind` VARCHAR(24) NOT NULL,
    `authority` VARCHAR(200) NULL,
    `decision` VARCHAR(24) NULL,
    `deadlineAt` DATETIME(3) NULL,
    `qualifiedRole` VARCHAR(120) NULL,
    `quantity` INTEGER NULL,
    `effectivenessPercentBp` INTEGER NULL,
    `detail` TEXT NOT NULL,
    `actorUserId` CHAR(26) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_safety_action_case`(`safetyCaseId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `recall_rehearsals` (
    `id` CHAR(26) NOT NULL,
    `year` INTEGER NOT NULL,
    `scenario` TEXT NOT NULL,
    `scopeTraced` TEXT NOT NULL,
    `minutesToTrace` INTEGER NULL,
    `findings` TEXT NULL,
    `outcome` VARCHAR(16) NOT NULL,
    `performedAt` DATETIME(3) NOT NULL,
    `recordedById` CHAR(26) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_recall_rehearsal_year`(`year`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `launch_readiness_items` (
    `id` CHAR(26) NOT NULL,
    `countryCode` CHAR(2) NOT NULL,
    `key` VARCHAR(48) NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'NOT_STARTED',
    `ownerName` VARCHAR(120) NULL,
    `ownerUserId` CHAR(26) NULL,
    `scope` TEXT NULL,
    `evidence` TEXT NULL,
    `reviewerUserId` CHAR(26) NULL,
    `reviewedAt` DATETIME(3) NULL,
    `expiresAt` DATETIME(3) NULL,
    `blockingReason` TEXT NULL,
    `sourceCheckedOn` DATETIME(3) NULL,
    `sourceNote` TEXT NULL,
    `updatedById` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_launch_item`(`countryCode`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `country_launches` (
    `id` CHAR(26) NOT NULL,
    `countryCode` CHAR(2) NOT NULL,
    `status` VARCHAR(12) NOT NULL DEFAULT 'DISABLED',
    `enabledById` CHAR(26) NULL,
    `enabledAt` DATETIME(3) NULL,
    `disabledById` CHAR(26) NULL,
    `disabledAt` DATETIME(3) NULL,
    `note` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_country_launch`(`countryCode`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `freight_bookings` (
    `id` CHAR(26) NOT NULL,
    `sellerOrderGroupId` CHAR(26) NOT NULL,
    `lane` VARCHAR(200) NOT NULL,
    `grossWeightGrams` INTEGER NOT NULL,
    `dimensionsJson` JSON NOT NULL,
    `packaging` VARCHAR(400) NOT NULL,
    `hazardClass` VARCHAR(32) NULL,
    `cargoCoverJson` JSON NULL,
    `custodyJson` JSON NOT NULL,
    `returnCapability` VARCHAR(400) NULL,
    `materialCommitment` BOOLEAN NOT NULL DEFAULT false,
    `selectedQuoteId` CHAR(26) NULL,
    `singleSourceReason` TEXT NULL,
    `externalCostMinor` BIGINT NULL,
    `coordinationMinor` BIGINT NULL,
    `currency` CHAR(3) NULL,
    `status` VARCHAR(12) NOT NULL DEFAULT 'DRAFT',
    `recordedById` CHAR(26) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_freight_booking_group`(`sellerOrderGroupId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `freight_quote_options` (
    `id` CHAR(26) NOT NULL,
    `bookingId` CHAR(26) NOT NULL,
    `providerName` VARCHAR(200) NOT NULL,
    `logisticsPartnerId` CHAR(26) NULL,
    `amountMinor` BIGINT NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `transitDaysMin` INTEGER NULL,
    `transitDaysMax` INTEGER NULL,
    `cargoCover` VARCHAR(400) NULL,
    `comparable` BOOLEAN NOT NULL DEFAULT true,
    `validUntil` DATETIME(3) NULL,
    `reference` VARCHAR(120) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_freight_quote_booking`(`bookingId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `logistics_provider_reviews` (
    `id` CHAR(26) NOT NULL,
    `providerName` VARCHAR(200) NOT NULL,
    `logisticsPartnerId` CHAR(26) NULL,
    `itemsJson` JSON NOT NULL,
    `integrationStatus` VARCHAR(24) NOT NULL DEFAULT 'CREDENTIALS_REQUIRED',
    `status` VARCHAR(12) NOT NULL DEFAULT 'IN_REVIEW',
    `reviewerUserId` CHAR(26) NULL,
    `reviewedAt` DATETIME(3) NULL,
    `nextReviewAt` DATETIME(3) NULL,
    `recordedById` CHAR(26) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_lpr_partner`(`logisticsPartnerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `handling_requirements` (
    `id` CHAR(26) NOT NULL,
    `kind` VARCHAR(24) NOT NULL,
    `categoryId` CHAR(26) NULL,
    `destinationCountry` CHAR(2) NULL,
    `requiredEvidence` TEXT NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdById` CHAR(26) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_handling_req_kind`(`kind`, `isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `dispatch_evidence` (
    `id` CHAR(26) NOT NULL,
    `sellerOrderGroupId` CHAR(26) NOT NULL,
    `quantitiesJson` JSON NOT NULL,
    `lotsJson` JSON NULL,
    `sealsJson` JSON NULL,
    `packingPhotoRefsJson` JSON NULL,
    `temperatureLogRef` VARCHAR(400) NULL,
    `handlingEvidenceJson` JSON NULL,
    `recordedById` CHAR(26) NOT NULL,
    `recordedByRole` VARCHAR(12) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_dispatch_evidence_group`(`sellerOrderGroupId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `custody_handovers` (
    `id` CHAR(26) NOT NULL,
    `sellerOrderGroupId` CHAR(26) NOT NULL,
    `shipmentLegId` CHAR(26) NULL,
    `fromParty` VARCHAR(200) NOT NULL,
    `toParty` VARCHAR(200) NOT NULL,
    `place` VARCHAR(400) NOT NULL,
    `handedOverAt` DATETIME(3) NOT NULL,
    `packages` INTEGER NOT NULL,
    `sealsIntact` BOOLEAN NOT NULL,
    `exceptionNote` TEXT NULL,
    `recordedById` CHAR(26) NOT NULL,
    `recordedByRole` VARCHAR(12) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_custody_group`(`sellerOrderGroupId`, `handedOverAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `partial_shipment_approvals` (
    `id` CHAR(26) NOT NULL,
    `sellerOrderGroupId` CHAR(26) NOT NULL,
    `orderApprovalRef` VARCHAR(200) NOT NULL,
    `approvedByParty` VARCHAR(12) NOT NULL,
    `quantitiesJson` JSON NOT NULL,
    `billedMinor` BIGINT NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `recordedById` CHAR(26) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_partial_shipment_group`(`sellerOrderGroupId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `return_authorizations` (
    `id` CHAR(26) NOT NULL,
    `returnRequestId` CHAR(26) NOT NULL,
    `rmaNumber` VARCHAR(24) NOT NULL,
    `returnRoute` VARCHAR(400) NOT NULL,
    `freightPayer` VARCHAR(16) NOT NULL,
    `payerReason` TEXT NOT NULL,
    `carrier` VARCHAR(120) NULL,
    `trackingNumber` VARCHAR(120) NULL,
    `returnBy` DATETIME(3) NULL,
    `receivedEvidence` TEXT NULL,
    `inspectionEvidence` TEXT NULL,
    `deductionMinor` BIGINT NULL,
    `deductionBasis` TEXT NULL,
    `issuedById` CHAR(26) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_return_authorization`(`returnRequestId`),
    UNIQUE INDEX `uq_return_authorization_rma`(`rmaNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `order_payment_plans` (
    `id` CHAR(26) NOT NULL,
    `orderId` CHAR(26) NOT NULL,
    `scheduleId` CHAR(26) NULL,
    `milestonesJson` JSON NOT NULL,
    `sellerAgreedAt` DATETIME(3) NULL,
    `buyerAgreedAt` DATETIME(3) NULL,
    `providerConfirmationRef` VARCHAR(200) NULL,
    `status` VARCHAR(12) NOT NULL DEFAULT 'PROPOSED',
    `recordedById` CHAR(26) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_order_payment_plan`(`orderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;


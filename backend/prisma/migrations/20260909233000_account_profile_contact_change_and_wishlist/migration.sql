-- The customer's own account area grows a real profile, a safe way to change
-- the two things that identify them, and a place to keep a line without buying
-- it.
--
-- Four separate changes, and they are in one migration because they are one
-- feature: the account screens the header's new profile menu leads to.
--
-- ---------------------------------------------------------------------------
-- 1. A name in two parts, and a job title
-- ---------------------------------------------------------------------------
--
-- `fullName` stays the canonical name and every existing reader of it is
-- untouched: it is what an order, an invoice, a delivery note and the greeting
-- in the header all use, and it remains NOT NULL. What is added is the two
-- parts a person actually types, plus the title they hold.
--
-- The parts are nullable and will be null for every row that exists today,
-- which is the correct state rather than a gap to backfill. Splitting a stored
-- `fullName` on its first space would be a guess, and it is wrong for a large
-- fraction of real names in the markets this ships into - "Van der Berg" is
-- one surname, "Jean Paul" is one forename, and Indonesian and Tamil accounts
-- routinely hold a single mononym. A guessed split is worse than an empty
-- field, because the customer cannot tell it was guessed.
--
-- Going the other way IS safe and is what the service does: when the parts are
-- supplied, `fullName` is composed from them. One writer, so the two cannot
-- drift.
--
-- `jobTitle` is distinct from `department`, which is already here. Department
-- is where in the organisation the order is placed from ("Surgical Services");
-- the title is what this person does ("Head of Theatre Procurement"). A
-- purchasing account that names both is one a supplier can route a query to.

ALTER TABLE `customer_profiles`
    ADD COLUMN `firstName` VARCHAR(120) NULL AFTER `fullName`,
    ADD COLUMN `lastName` VARCHAR(120) NULL AFTER `firstName`,
    ADD COLUMN `jobTitle` VARCHAR(128) NULL AFTER `department`;

-- ---------------------------------------------------------------------------
-- 2. A pending email address and a pending telephone number
-- ---------------------------------------------------------------------------
--
-- Both are parked rather than written over the live value, and that is the
-- whole point of the columns.
--
-- `users.email` is what the account signs in with and where every order
-- confirmation, payment link and password reset is sent. Writing an
-- unconfirmed address into it means one typo locks somebody out of their own
-- purchasing account permanently: the confirmation link goes to the address
-- that does not exist, and there is no way back in. So the new address waits
-- here until a token minted to it has been consumed, and only then is it
-- promoted.
--
-- `pendingEmailNormalized` is not a duplicate of the column above it for its
-- own sake. It exists to be compared against `users.emailNormalized` before a
-- change is accepted, so two accounts cannot both be moving to the same
-- address and only discover it at the moment the second one confirms.
--
-- It is deliberately NOT UNIQUE. A collision here is an ordinary race to be
-- refused with a sentence, not a 1062 from the database — and two accounts
-- abandoning a change to the same address is not a corrupt state, it is two
-- rows nobody ever confirmed.
--
-- Every one of these is NULL for every existing row, which is exactly right:
-- nobody has a change in flight.

ALTER TABLE `users`
    ADD COLUMN `pendingEmail` VARCHAR(320) NULL AFTER `phoneVerifiedAt`,
    ADD COLUMN `pendingEmailNormalized` VARCHAR(320) NULL AFTER `pendingEmail`,
    ADD COLUMN `pendingPhone` VARCHAR(32) NULL AFTER `pendingEmailNormalized`;

-- One index, on the normalised pending address.
--
-- The collision check runs on every request to change an address and asks "is
-- anybody else already moving to this one?". Without an index that is a full
-- scan of `users` per request, on a table that grows with every account this
-- deployment has ever opened. Not unique, for the reason above.

CREATE INDEX `ix_user_pending_email` ON `users`(`pendingEmailNormalized`);

-- ---------------------------------------------------------------------------
-- 3. Two more token purposes
-- ---------------------------------------------------------------------------
--
-- `auth_tokens.type` is an ENUM, so a new purpose is a column alteration
-- rather than a row. The two additions confirm control of a new address and of
-- a new number.
--
-- They are separate values rather than a reuse of EMAIL_VERIFICATION, and that
-- distinction is load bearing: `consumeToken` refuses a token whose purpose
-- does not match, which is what stops a link minted to prove somebody owns a
-- new address from being replayed to prove the original one was verified.
--
-- Adding values at the END of the list, never in the middle. MariaDB stores an
-- ENUM as an ordinal, so inserting a value ahead of an existing one silently
-- renumbers every row already written.

ALTER TABLE `auth_tokens`
    MODIFY COLUMN `type` ENUM('INVITATION', 'EMAIL_VERIFICATION', 'PASSWORD_RESET', 'EMAIL_CHANGE', 'PHONE_CHANGE') NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Saved for later
-- ---------------------------------------------------------------------------
--
-- A link to a person, a link to a product, and when. Nothing else, and the
-- absences are deliberate: no quantity, no note, no ordering column. A
-- wishlist that carries a quantity is a second basket with none of a basket's
-- rules - no minimum order quantity, no increment, no stock reservation and no
-- price - and the moment one exists somebody will try to check it out.
--
-- `variantKey` is the device the cart and the schedule items already use, for
-- the MariaDB reason in the schema header: a UNIQUE index treats every NULL as
-- distinct, so a nullable `variantId` inside the composite unique below would
-- NOT stop the same variant being saved twice. The key is the variant ULID, or
-- the empty string for the base product, and is never null.
--
-- There is no foreign key on the variant, and that is not an omission. A
-- variant can be deleted while a saved line still names it, and the
-- alternative - ON DELETE RESTRICT - would make somebody else's wishlist a
-- reason an administrator cannot tidy up a product. The reader resolves the
-- key if it still resolves and falls back to the base product if it does not.
--
-- Both foreign keys CASCADE. An account being erased takes its saved lines
-- with it, and a product leaving the catalogue takes the rows that pointed at
-- it: neither is a record anything is legally required to keep, and neither
-- should be able to block the other side's deletion.
--
-- NOTE FOR THE NEXT PERSON: this table carries a `customerProfileId`, so
-- `tests/unit/export-bundle-completeness.test.ts` will fail until the Art. 15
-- export accounts for it. That is the test working. It is disclosed as the
-- `wishlist` section, and `erasure.service.ts` deletes it outright.

CREATE TABLE `wishlist_items` (
    `id` CHAR(26) NOT NULL,
    `customerProfileId` CHAR(26) NOT NULL,
    `productId` CHAR(26) NOT NULL,
    `variantKey` CHAR(26) NOT NULL DEFAULT '',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_wishlist_item`(`customerProfileId`, `productId`, `variantKey`),
    INDEX `ix_wishlist_customer_time`(`customerProfileId`, `createdAt`),
    INDEX `ix_wishlist_product`(`productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `wishlist_items`
    ADD CONSTRAINT `fk_wishlist_customer` FOREIGN KEY (`customerProfileId`) REFERENCES `customer_profiles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `wishlist_items`
    ADD CONSTRAINT `fk_wishlist_product` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- `ActorType` gains LOGISTICS.
--
-- Its own migration rather than an amendment to the one before it, because
-- that one has already been applied and a migration's checksum is what makes
-- "applied" mean anything.
--
-- Additive. A MySQL ENUM widened by appending a member rewrites no row and
-- invalidates no index; every existing row in all four tables stays SYSTEM,
-- ADMIN, CUSTOMER or PROVIDER.
--
-- Why not fold a carrier into SYSTEM: "the system moved this shipment" and "a
-- named dispatcher at a named carrier moved it" are the two answers an
-- operator most needs to tell apart after a bad delivery, and an audit trail
-- that cannot tell them apart is an audit trail that answers the wrong
-- question.
--
-- All four columns that use the enum are widened together. Leaving one behind
-- would be a column that cannot store a value the type system says is legal,
-- and the failure would surface as a driver error in production rather than
-- as a compile error here.
--
-- ROLLBACK
--   UPDATE each table SET `actorType` = 'SYSTEM' WHERE `actorType` = 'LOGISTICS';
--   then MODIFY each column back to
--   ENUM('SYSTEM','ADMIN','CUSTOMER','PROVIDER').

ALTER TABLE `audit_logs`
    MODIFY `actorType` ENUM('SYSTEM', 'ADMIN', 'CUSTOMER', 'PROVIDER', 'LOGISTICS') NOT NULL DEFAULT 'SYSTEM';

ALTER TABLE `order_status_history`
    MODIFY `actorType` ENUM('SYSTEM', 'ADMIN', 'CUSTOMER', 'PROVIDER', 'LOGISTICS') NOT NULL DEFAULT 'SYSTEM';

ALTER TABLE `inventory_movements`
    MODIFY `actorType` ENUM('SYSTEM', 'ADMIN', 'CUSTOMER', 'PROVIDER', 'LOGISTICS') NOT NULL DEFAULT 'SYSTEM';

ALTER TABLE `seller_audit_logs`
    MODIFY `actorType` ENUM('SYSTEM', 'ADMIN', 'CUSTOMER', 'PROVIDER', 'LOGISTICS') NOT NULL;

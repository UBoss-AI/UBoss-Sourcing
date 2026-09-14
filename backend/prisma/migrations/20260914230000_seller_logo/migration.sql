-- A seller's own mark, for their own shop front.
--
-- Until now a seller storefront rendered the seller's initial in a plate,
-- because there was nowhere to put a logo and the only alternative was showing
-- the OPERATOR's mark above a seller's name. That is worse than a letter: it
-- tells a buyer they are on the marketplace's shop when they are not, which is
-- exactly the confusion a per-seller storefront exists to remove.
--
-- AN OBJECT KEY, NOT THE BYTES, and not a `media_assets` row either. The
-- operator's `MediaAsset` table is the operator's catalogue library — it is
-- reachable from the admin media picker, it is counted in catalogue reports,
-- and a seller's brand mark appearing in it would be a seller writing into the
-- operator's library. `seller_documents` already stores a seller's own files as
-- a bare `storageKey` for the same reason; this follows it.
--
-- NULLABLE, and it stays nullable. A seller who has not uploaded one has a shop
-- front that renders their initial, which works and is not a broken state to be
-- migrated away from.
ALTER TABLE `seller_accounts`
  ADD COLUMN `logoStorageKey` VARCHAR(512) NULL AFTER `description`;

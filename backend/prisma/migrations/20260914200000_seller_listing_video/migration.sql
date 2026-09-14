-- Product videos on a seller's listing.
--
-- A photograph tells a buyer what a thing looks like. A video is what answers
-- "how does the clamp actually close", "how loud is it", "does the lid seal" -
-- and for a B2B buyer committing to a carton of five hundred, that question is
-- often the one standing between a quote and an order.
--
-- THREE COLUMNS, AND WHY EACH IS SEPARATE
--
--   * `kind` - IMAGE or VIDEO. Not inferred from `contentType` at read time,
--     because the gallery decides between an `<img>` and a `<video>` on every
--     render and parsing a MIME string to do it is work repeated forever. It
--     also makes "how many photographs does this listing have" an indexed
--     question rather than a string comparison.
--
--   * `durationSeconds` - nullable, and legitimately so. Some containers do not
--     carry a duration anywhere the server can cheaply read, and a video whose
--     length is unknown is still a perfectly good video. Null means unknown,
--     never zero.
--
--   * `VIDEO` as a slot - its own member rather than a flag on OTHER. A
--     moderator checking that the required photographs are present, and a buyer
--     asking whether there is a video, are both asking about a specific thing.
--
-- The default on `kind` is IMAGE, which every row already in the table is.

ALTER TABLE `seller_listing_draft_media`
  ADD COLUMN `kind` ENUM('IMAGE', 'VIDEO') NOT NULL DEFAULT 'IMAGE',
  ADD COLUMN `durationSeconds` INTEGER NULL;

-- MariaDB rewrites the whole column definition to add a member, so the full
-- list is repeated here. Appended at the END: the storage is ordinal, and
-- inserting a member in the middle would silently re-point every existing row
-- at its neighbour.
ALTER TABLE `seller_listing_draft_media`
  MODIFY COLUMN `slot` ENUM(
    'FRONT_VIEW',
    'BACK_VIEW',
    'SIDE_VIEW',
    'PACKAGING',
    'PRODUCT_LABEL',
    'UDI_LABEL',
    'DIMENSIONS_REFERENCE',
    'CONNECTOR_VIEW',
    'STERILE_SEAL',
    'INSTRUCTIONS_VIEW',
    'OTHER',
    'DOCUMENT',
    'VIDEO'
  ) NOT NULL DEFAULT 'OTHER';

-- A video has no duration of zero or less, and a negative one is a parse bug
-- rather than a fact about the file.
ALTER TABLE `seller_listing_draft_media`
  ADD CONSTRAINT `chk_seller_media_duration_positive`
  CHECK (`durationSeconds` IS NULL OR `durationSeconds` > 0);

-- The gallery reads pictures and videos separately - photographs into the slot
-- strip, videos into their own row - so the pair is worth an index.
CREATE INDEX `ix_listing_media_kind` ON `seller_listing_draft_media` (`draftId`, `kind`);

-- The interface language somebody working in a country reads.
--
-- The admin console already records which country each sign-in came from and
-- prices its catalogue for it. This column is the other half of that fact: a
-- member of staff signing in from Berlin should be reading a German panel
-- before they touch anything, and the console cannot know that from the
-- country code alone.
--
-- A column on `countries` rather than a map in the frontends, for the same
-- reason `currencyCode` is one: which language an office works in is a
-- decision the deployment makes and corrects in a row, not a fact of
-- geography. Belgium is the case that proves it - a Brussels office may read
-- French where an Antwerp one reads Dutch, and neither is wrong.
--
-- Additive and nullable. NULL means "leave this person's own choice alone",
-- and it is the honest answer for a country whose language the panel ships no
-- catalogue for. It never means English.

-- AlterTable
ALTER TABLE `countries`
    ADD COLUMN `languageCode` VARCHAR(8) NULL AFTER `currencyCode`;

-- The starting values, so a deployment that already has its countries seeded
-- gets them without re-running the seed. Grouped by language rather than
-- written per country: the grouping is the fact being asserted.
--
-- Only the eight languages the panel ships a catalogue for appear here. A
-- member state whose language it does not - Bulgaria, Czechia, Denmark,
-- Estonia, Finland, Croatia, Hungary, Lithuania, Latvia, Portugal, Romania,
-- Sweden, Slovenia, Slovakia - is left NULL on purpose. Forcing English on
-- somebody in Prague who had chosen Polish would be a worse answer than
-- leaving their choice where it was.
--
-- `languageCode IS NULL` on every statement so re-running this by hand cannot
-- overwrite a correction an operator has already made in the panel.

UPDATE `countries` SET `languageCode` = 'de'
    WHERE `code` IN ('DE', 'AT', 'CH') AND `languageCode` IS NULL;

UPDATE `countries` SET `languageCode` = 'fr'
    WHERE `code` IN ('FR', 'LU') AND `languageCode` IS NULL;

-- Dutch for Belgium is a choice, not a certainty - see the note above. It is
-- the larger language community of the two, and an operator whose office is in
-- Brussels changes this one row.
UPDATE `countries` SET `languageCode` = 'nl'
    WHERE `code` IN ('NL', 'BE') AND `languageCode` IS NULL;

UPDATE `countries` SET `languageCode` = 'el'
    WHERE `code` IN ('GR', 'CY') AND `languageCode` IS NULL;

UPDATE `countries` SET `languageCode` = 'it'
    WHERE `code` = 'IT' AND `languageCode` IS NULL;

UPDATE `countries` SET `languageCode` = 'pl'
    WHERE `code` = 'PL' AND `languageCode` IS NULL;

UPDATE `countries` SET `languageCode` = 'es'
    WHERE `code` = 'ES' AND `languageCode` IS NULL;

-- English where it is the working language of the office, not as a fallback
-- for everywhere else.
UPDATE `countries` SET `languageCode` = 'en'
    WHERE `code` IN ('IN', 'GB', 'IE', 'MT', 'US', 'CA', 'AU', 'NZ', 'SG')
      AND `languageCode` IS NULL;

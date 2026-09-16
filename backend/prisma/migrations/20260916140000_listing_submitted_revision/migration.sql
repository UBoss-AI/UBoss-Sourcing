-- Which revision of a listing the moderator is actually deciding on.
--
-- THE RACE THIS CLOSES
--
-- A seller submits a listing. A moderator opens it, reads it, and goes to
-- lunch. The listing comes back ACTION_REQUIRED from a colleague, the seller
-- edits it, and resubmits. The first moderator returns and presses Approve.
--
-- Nothing in the decision path noticed. `decideListing` read the draft by id,
-- checked that the transition was legal - and PENDING_REVIEW -> APPROVED still
-- is - and published whatever the row happened to hold. The moderator approved
-- a revision they had never seen, and the audit entry says they approved it.
--
-- `version` alone cannot close it: it moves on every autosave, so a moderator
-- holding a version number is holding a number that changes while the seller
-- is still typing, and refusing on that would refuse every ordinary decision.
-- What is needed is the version AS SUBMITTED, which is stable for exactly as
-- long as the listing is in the queue - and which therefore changes precisely
-- when, and only when, the thing under review is no longer the thing that was
-- sent.
--
-- The seller application already worked this way (`seller_accounts.version`,
-- checked through `expectedVersion` in `transitionApplication`). This is the
-- same guard for listings, which had none.
--
-- NULLABLE, and it stays nullable. A draft that has never been submitted has
-- no submitted revision, and that is a real state rather than a missing value
-- to be backfilled.

ALTER TABLE `seller_listing_drafts`
  ADD COLUMN `submittedVersion` INT NULL AFTER `version`;

-- Backfill the drafts currently sitting in a queue.
--
-- Their `version` is the revision a moderator is looking at right now: nobody
-- can have edited them, because PENDING_REVIEW is not an editable status. So
-- this is the one moment where the two are known to be equal, and recording it
-- means the decisions already in flight are guarded from the first deploy
-- rather than from the first resubmission after it.
--
-- Everything else is deliberately left NULL, including APPROVED and REJECTED
-- drafts: writing a submitted revision onto a listing whose decision is already
-- made would be inventing a record of a review that happened without one.
UPDATE `seller_listing_drafts`
SET `submittedVersion` = `version`
WHERE `status` = 'PENDING_REVIEW' AND `submittedVersion` IS NULL;

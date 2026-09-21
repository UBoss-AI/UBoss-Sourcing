-- Absolute lifetime for a refresh-token family.
--
-- `sessions.createdAt` is rewritten by every rotation, so it cannot answer
-- "how long ago did this person sign in?". This column is set once at
-- sign-in and copied into each replacement row, which is what lets
-- SESSION_ABSOLUTE_TTL_SECONDS put a ceiling on a family that would
-- otherwise slide forward for ever.
--
-- Additive and nullable: sessions that already exist keep working and simply
-- have no recorded start, so they expire on their own refresh token as
-- before. Nothing is rewritten and nothing is dropped. No index: the column
-- is only ever read from a session row that has already been looked up by
-- its refresh-token hash.
ALTER TABLE `sessions`
  ADD COLUMN `familyStartedAt` DATETIME(3) NULL AFTER `replacedBySessionId`;

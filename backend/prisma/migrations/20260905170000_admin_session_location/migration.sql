-- Where an admin session was opened from.
--
-- The console now asks the browser for the device's position at sign-in and
-- refuses to open until it has one. The point is not to track anybody's
-- movements: it is that a shared self-hosted panel with several staff accounts
-- gives the people running it no way to notice a sign-in from somewhere nobody
-- works. The bell says "signed in from X" the moment it happens, and the row
-- below is what that sentence is built from.
--
-- On the session rather than on `login_attempts`: the position arrives on a
-- second request, after the password has already been accepted, and it is the
-- session - not the attempt - that stays blocked until it does. Keeping the two
-- together is also what lets a refresh carry the position forward instead of
-- re-prompting somebody mid-task.
--
-- Every column is nullable. Customer sessions never fill them, an admin session
-- has them empty for the moment between the password and the position, and a
-- deployment that turns the feature off leaves them empty for good.

ALTER TABLE `sessions`
    -- Six decimals is ~0.1m, finer than any browser fix, so nothing is lost to
    -- rounding on the way in.
    ADD COLUMN `locationLatitude`   DECIMAL(9, 6) NULL AFTER `ipAddress`,
    ADD COLUMN `locationLongitude`  DECIMAL(9, 6) NULL AFTER `locationLatitude`,
    -- The radius the device claimed, in metres. Stored because a 2000m wifi fix
    -- and a 5m GPS fix must not read the same in the notification.
    ADD COLUMN `locationAccuracyM`  INT           NULL AFTER `locationLongitude`,
    -- The reverse-geocoded place. Null when the lookup was unavailable or
    -- switched off, in which case the coordinates are shown instead.
    ADD COLUMN `locationLabel`      VARCHAR(255)  NULL AFTER `locationAccuracyM`,
    ADD COLUMN `locationCapturedAt` DATETIME(3)   NULL AFTER `locationLabel`;

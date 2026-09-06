-- The interface language, stored per account.
--
-- On `users` rather than on `customer_profiles` because staff need it too and
-- a staff account has no profile row. One column serves both surfaces.
--
-- Nullable with no default, and that is the point: null means "has never
-- chosen", which the storefront treats differently from a deliberate choice of
-- English. A null lets it fall back to whatever the browser asks for, so a
-- Polish buyer who has never opened the picker still lands on a Polish
-- interface. Defaulting this to 'en' would silently take that away from every
-- account that already exists.
--
-- VARCHAR(10) rather than CHAR(2) to leave room for a regional tag later
-- ('pt-BR', 'nl-BE') without a second migration.

ALTER TABLE `users`
    ADD COLUMN `preferredLanguage` VARCHAR(10) NULL;

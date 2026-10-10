-- The certification-cost funder is the marketplace operating the deployment,
-- whoever that is: a neutral value, never one operator's name.
ALTER TABLE `certification_cost_entries` ALTER COLUMN `fundedBy` SET DEFAULT 'MARKETPLACE';
UPDATE `certification_cost_entries` SET `fundedBy` = 'MARKETPLACE' WHERE `fundedBy` = 'GLOVIAA';

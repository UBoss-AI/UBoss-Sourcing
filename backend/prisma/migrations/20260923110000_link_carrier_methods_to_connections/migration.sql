-- Join every integrated-carrier method to the carrier account it was set up for.
--
-- THE BUG THIS REPAIRS. A seller's delivery method for FedEx is created when
-- they press the FedEx card; the carrier connection is created later, from the
-- setup panel. Nothing ever wrote `sellerCarrierConnectionId` on the method, so
-- the join was always empty. The setup panel had no other place to read the
-- provider from and fell back to DHL - which is why the FedEx card said "Your
-- DHL account", fetched DHL's credential fields, and created a DHL connection
-- when its button was pressed.
--
-- The application now writes the join when a connection is created or a
-- method is chosen. This fills it in for rows written before that.
--
-- HOW A METHOD AND A CONNECTION ARE MATCHED. By the method's own key, which is
-- `CARRIER:<provider>:<environment>` and is written by `methodKeyFor` in
-- `domain/seller-fulfilment.ts`. The same seller, the same provider and the
-- same environment - so a FedEx connection can only ever join a FedEx method.
--
-- DATA ONLY. No column, index or constraint changes. A disconnected connection
-- is not joined: its credential was destroyed and it carries nothing.
--
-- SAFE ON A LIVE DEPLOYMENT, AND SAFE TO RUN TWICE: only rows whose join is
-- still empty are touched.
--
-- ROLLBACK: nothing to undo. Setting the column back to NULL would restore the
-- bug, not the previous state of anything that worked.

UPDATE `seller_fulfilment_methods` AS m
JOIN `seller_carrier_connections` AS c
  ON c.`sellerAccountId` = m.`sellerAccountId`
 AND m.`methodKey` = CONCAT('CARRIER:', c.`provider`, ':', c.`environment`)
SET m.`sellerCarrierConnectionId` = c.`id`
WHERE m.`mode` = 'INTEGRATED_CARRIER'
  AND m.`sellerCarrierConnectionId` IS NULL
  AND m.`archivedAt` IS NULL
  AND c.`state` <> 'DISCONNECTED';

-- Master row 56: the pickup a seller asks for when booking a consignment.
-- A date and an optional window ("09:00" to "13:00", local to the pickup
-- address), stored with the rest of the booking terms.
ALTER TABLE `consignment_booking_terms`
    ADD COLUMN `pickupDate` DATE NULL,
    ADD COLUMN `pickupWindowFrom` VARCHAR(5) NULL,
    ADD COLUMN `pickupWindowTo` VARCHAR(5) NULL;

-- The storefront assistant is now for signed-in customers only, and it no
-- longer asks anybody for their name, mobile number and email before it will
-- answer a question.
--
-- Those three details were a lead-capture form standing in for authentication
-- on an endpoint that had none. The endpoint has a real one now: every
-- `/assistant/*` call carries a customer session, and `customerProfileId` -
-- an authenticated fact rather than a typed claim - is what says whose
-- conversation a row is. A form that collected a phone number nobody verified
-- was never worth the friction once the caller had to sign in anyway.
--
-- WHAT THIS MIGRATION DOES NOT DO: it does not delete a single row, and it
-- does not blank a single value. Every enquiry already recorded keeps its
-- name, its phone number, its email and its transcript, and they leave on the
-- schedule the retention sweep has always applied to them
-- (`RETENTION_ASSISTANT_CONVERSATION_DAYS`, swept by `retention.service.ts`). Erasing
-- personal data early is a data-protection decision, not a side effect of a
-- schema change, and a customer's right to erasure already has its own route.
--
-- So the four visitor columns and the guest session-token hash become
-- NULLABLE. New rows leave them NULL; old rows are untouched. Nothing widens,
-- nothing narrows, and no index is rebuilt - `ix_assistant_conversation_email`
-- still answers "what else has this address asked" for the rows that have one.

ALTER TABLE `assistant_conversations`
    MODIFY `visitorName` VARCHAR(120) NULL,
    MODIFY `visitorPhone` VARCHAR(32) NULL,
    MODIFY `visitorEmail` VARCHAR(320) NULL,
    MODIFY `visitorEmailNormalized` VARCHAR(320) NULL,
    MODIFY `sessionTokenHash` CHAR(64) NULL;

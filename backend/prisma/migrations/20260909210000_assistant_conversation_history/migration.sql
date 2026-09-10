-- The assistant becomes a page with a history, rather than a panel with one
-- conversation that the browser forgot when the tab closed.
--
-- Two columns, both on the customer's side of the record:
--
--   `title`    what the customer chose to call a thread in their sidebar.
--              NULL is the normal state and not a missing value: the list
--              falls back to the opening question, which is a better label
--              than any generated one and costs no provider call to make.
--
--   `hiddenAt` when the customer removed a thread from their own history.
--              A soft delete on purpose. The transcript is the record of what
--              this deployment's AI told a buyer about a medical device, and
--              somebody tidying a sidebar is not a reason to destroy it -
--              staff still read it under Enquiries, and the retention sweep
--              (`RETENTION_ASSISTANT_CONVERSATION_DAYS`) is what clears it in
--              the end. Erasure under Art. 17 is a different act with its own
--              route, and that one still deletes the rows outright.
--
-- Both are NULL for every existing row, which is exactly right: nothing was
-- renamed and nothing was hidden before this existed.
--
-- No new index. A customer's history is narrowed to one owner by
-- `ix_assistant_conversation_customer` and then ordered in a result set of
-- tens of rows; a second index would cost every write and save nothing.

ALTER TABLE `assistant_conversations`
    ADD COLUMN `title` VARCHAR(120) NULL AFTER `customerProfileId`,
    ADD COLUMN `hiddenAt` DATETIME(3) NULL AFTER `title`;

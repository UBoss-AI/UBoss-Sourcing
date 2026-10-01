-- Art. 16 rectification: a subject asks for a correction to their personal data.
-- Additive: existing EXPORT and ERASURE rows are unchanged.
ALTER TABLE `data_requests` MODIFY `type` ENUM('EXPORT', 'ERASURE', 'RECTIFICATION') NOT NULL;

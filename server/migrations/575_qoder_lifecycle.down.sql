ALTER TABLE qoder_connection
 DROP COLUMN IF EXISTS busy_until,
 DROP COLUMN IF EXISTS journal_encrypted;

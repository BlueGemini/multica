ALTER TABLE qoder_connection
 ADD COLUMN IF NOT EXISTS busy_until timestamptz,
 ADD COLUMN IF NOT EXISTS journal_encrypted text NOT NULL DEFAULT '';

-- Existing development credentials were user-wide PATs. Require a new save to
-- replace them with a workspace/daemon-scoped credential; preserve QCA secrets.
UPDATE personal_access_token SET revoked=true
 WHERE id IN (SELECT token_id FROM qoder_connection);
UPDATE qoder_connection SET enabled=false, status='stopped';

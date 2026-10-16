-- Attach the CONCURRENTLY-built unique index as the table's primary key.
ALTER TABLE agent_draft
    ADD CONSTRAINT agent_draft_pkey PRIMARY KEY USING INDEX agent_draft_pkey_uidx;

-- One row per (member, UTC day) on which that member personally started an
-- agent run: commented, mentioned, assigned, promoted, triggered, reran,
-- chatted or quick-created. Written at the moment of the human action, so it
-- keeps every human who acted and the day they acted even when a later comment
-- folds into a queued run and re-attributes it, and it never records runs that
-- only inherit a human (retries, system wakeups, delegation, autopilot).
--
-- Feeds the self-host telemetry "delegating member" counts; no other reader.
-- New and empty, so the inline primary key builds instantly. No FK to "user"
-- by design (workspace DB rules); readers join current members.
CREATE TABLE member_delegation_day (
    user_id       UUID NOT NULL,
    activity_date DATE NOT NULL,
    PRIMARY KEY (user_id, activity_date)
);

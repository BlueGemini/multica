package selfhosttelemetry

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

const collectionSQL = `
WITH terminal_tasks AS (
    SELECT count(*) FILTER (WHERE status = 'completed') AS completed,
           count(*) FILTER (WHERE status = 'failed') AS failed,
           count(*) FILTER (WHERE status = 'cancelled') AS cancelled
      FROM agent_task_queue
     WHERE status IN ('completed', 'failed', 'cancelled')
       AND completed_at >= $1
       AND completed_at < $2
)
SELECT
    (SELECT count(*) FROM workspace),
    (SELECT count(DISTINCT user_id) FROM member),
    (SELECT count(*) FROM agent WHERE archived_at IS NULL),
    (SELECT count(DISTINCT daemon_id)
       FROM agent_runtime
      WHERE daemon_id IS NOT NULL
        AND last_seen_at >= $1
        AND last_seen_at < $2),
    (SELECT count(*)
       FROM agent_task_queue
      WHERE started_at >= $1
        AND started_at < $2),
    terminal_tasks.completed,
    terminal_tasks.failed,
    terminal_tasks.cancelled
FROM terminal_tasks`

// activitySQL counts distinct current members active in the N complete UTC
// days before the snapshot's UTC day ($1). Windows are calendar days, not
// [T-24h, T), because client_usage_daily only records an activity date.
//
//   - visiting: the signed-in web or desktop app reported the member that day.
//   - delegating: the member personally started an agent run. Attribution
//     stamps originator_source = 'direct_human' for assign, mention, comment,
//     chat, manual run and rerun; delegation between agents and autopilot runs
//     carry other sources and are excluded.
//
// Both reads are bounded by member count rather than history size: the visit
// read is a 28-day range on the (activity_date, client_type, user_id) index,
// and the delegation read is one backward probe per member on
// idx_agent_task_queue_direct_human_originator.
const activitySQL = `
WITH members AS (
    SELECT DISTINCT user_id FROM member
), visits AS (
    SELECT c.user_id, max(c.activity_date) AS last_day
      FROM client_usage_daily c
      JOIN members m ON m.user_id = c.user_id
     WHERE c.activity_date >= $1::date - 28
       AND c.activity_date < $1::date
     GROUP BY c.user_id
), delegations AS MATERIALIZED (
    -- MATERIALIZED: probe once per member, not once per window below.
    SELECT m.user_id,
           (SELECT max(t.created_at)
              FROM agent_task_queue t
             WHERE t.originator_user_id = m.user_id
               AND t.originator_source = 'direct_human'
               AND t.created_at < $1::date::timestamp AT TIME ZONE 'UTC') AS last_at
      FROM members m
)
SELECT
    (SELECT count(*) FROM visits WHERE last_day >= $1::date - 1),
    (SELECT count(*) FROM visits WHERE last_day >= $1::date - 7),
    (SELECT count(*) FROM visits),
    count(*) FILTER (WHERE last_at >= ($1::date - 1)::timestamp AT TIME ZONE 'UTC'),
    count(*) FILTER (WHERE last_at >= ($1::date - 7)::timestamp AT TIME ZONE 'UTC'),
    count(*) FILTER (WHERE last_at >= ($1::date - 28)::timestamp AT TIME ZONE 'UTC')
FROM delegations`

const collectionStatementTimeout = 2 * time.Second

type eventCollector interface {
	Collect(context.Context, *pgx.Conn, time.Time) (Counts, error)
}

type SQLCollector struct{}

// Collect executes all aggregates in one SQL statement, so PostgreSQL uses one
// statement snapshot and every field shares exactly the same [T-24h, T)
// boundary. SET LOCAL guarantees the two-second ceiling cannot leak onto the
// pooled connection after the transaction ends.
func (SQLCollector) Collect(ctx context.Context, conn *pgx.Conn, at time.Time) (counts Counts, err error) {
	tx, err := conn.Begin(ctx)
	if err != nil {
		return Counts{}, fmt.Errorf("begin telemetry collection: %w", err)
	}
	defer func() {
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
		defer cancel()
		if rollbackErr := tx.Rollback(cleanupCtx); rollbackErr != nil && rollbackErr != pgx.ErrTxClosed && err == nil {
			err = fmt.Errorf("rollback telemetry collection: %w", rollbackErr)
		}
	}()

	statementTimeoutSQL := fmt.Sprintf("SET LOCAL statement_timeout = '%dms'", collectionStatementTimeout.Milliseconds())
	if _, err = tx.Exec(ctx, statementTimeoutSQL); err != nil {
		return Counts{}, fmt.Errorf("set telemetry statement timeout: %w", err)
	}
	from := at.UTC().Add(-24 * time.Hour)
	to := at.UTC()
	err = tx.QueryRow(ctx, collectionSQL, from, to).Scan(
		&counts.Workspaces,
		&counts.HumanMembers,
		&counts.Agents,
		&counts.ActiveDaemons,
		&counts.TasksStarted,
		&counts.TasksCompleted,
		&counts.TasksFailed,
		&counts.TasksCancelled,
	)
	if err != nil {
		return Counts{}, fmt.Errorf("collect telemetry snapshot: %w", err)
	}
	// Member activity is optional: a failure here (timeout, a schema the
	// query does not expect) must not cost the deployment its V1 snapshot.
	// The savepoint lets the outer transaction survive the aborted statement.
	counts.Activity, counts.ActivityCollected = collectActivity(ctx, tx, at)
	if err = tx.Commit(ctx); err != nil {
		return Counts{}, fmt.Errorf("commit telemetry collection: %w", err)
	}
	return counts, nil
}

func collectActivity(ctx context.Context, tx pgx.Tx, at time.Time) (ActivityCounts, bool) {
	savepoint, err := tx.Begin(ctx)
	if err != nil {
		return ActivityCounts{}, false
	}
	var activity ActivityCounts
	err = savepoint.QueryRow(ctx, activitySQL, utcDay(at)).Scan(
		&activity.Visiting1d,
		&activity.Visiting7d,
		&activity.Visiting28d,
		&activity.Delegating1d,
		&activity.Delegating7d,
		&activity.Delegating28d,
	)
	if err != nil {
		_ = savepoint.Rollback(ctx)
		return ActivityCounts{}, false
	}
	if err := savepoint.Commit(ctx); err != nil {
		return ActivityCounts{}, false
	}
	return activity, true
}

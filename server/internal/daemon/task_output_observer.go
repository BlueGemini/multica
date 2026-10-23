package daemon

import (
	"context"
	"sync"
	"time"
)

// silentResumeRetireThreshold is how long a RESUMED run must have gone without
// a single agent message before a cancellation retires its session.
//
// A healthy resumed turn produces its first thinking/text/tool event within
// seconds; minutes of total silence after a resume means the runtime loaded
// the transcript and then could not drive it — the MUL-8188 shape, where Kiro
// panicked in its agent loop and left session/prompt unanswered. Users cancel
// such runs by hand, and before this the cancelled row kept the session
// resumable, so every later trigger re-entered the same hang.
//
// The threshold keeps an ordinary early cancel ("wrong issue", "let me edit
// the prompt") from discarding a healthy conversation: those land well before
// it. The cost of a false positive is bounded — the next run starts a fresh
// session in the same workdir — while a false negative is an issue that hangs
// on every trigger.
const silentResumeRetireThreshold = 5 * time.Minute

// taskOutputObserver records, for the most recent backend execution of a task,
// when it started and whether it produced any agent output. Unlike
// taskPhaseRecorder (diagnostic-only by contract) it exists to drive the
// silent-resume retirement decision.
type taskOutputObserver struct {
	mu       sync.Mutex
	started  time.Time
	observed bool
}

// begin marks the start of a backend execution. Each execution (including a
// fresh-session retry) resets the observation so the decision always concerns
// the run whose result is being classified.
func (o *taskOutputObserver) begin(now time.Time) {
	if o == nil {
		return
	}
	o.mu.Lock()
	o.started = now
	o.observed = false
	o.mu.Unlock()
}

func (o *taskOutputObserver) markOutput() {
	if o == nil {
		return
	}
	o.mu.Lock()
	o.observed = true
	o.mu.Unlock()
}

// silentFor reports how long the current execution has run without output.
// ok is false when the execution never started or did produce output.
func (o *taskOutputObserver) silentFor(now time.Time) (time.Duration, bool) {
	if o == nil {
		return 0, false
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.started.IsZero() || o.observed {
		return 0, false
	}
	return now.Sub(o.started), true
}

type taskOutputObserverContextKey struct{}

func withTaskOutputObserver(ctx context.Context, o *taskOutputObserver) context.Context {
	return context.WithValue(ctx, taskOutputObserverContextKey{}, o)
}

func taskOutputObserverFromContext(ctx context.Context) *taskOutputObserver {
	o, _ := ctx.Value(taskOutputObserverContextKey{}).(*taskOutputObserver)
	return o
}

// shouldRetireSilentResume reports whether a run's resumed session should be
// retired because the run was cancelled after resuming it and never produced
// any output for at least silentResumeRetireThreshold.
//
// Only cancellation statuses qualify: a failed run already carries an error
// the resume guards classify, and a timeout/idle_watchdog has its own
// failure_reason. priorSessionID == "" means the run started cold, so there
// is no resumed session to blame.
func shouldRetireSilentResume(status, priorSessionID string, silent time.Duration, wasSilent bool) bool {
	if priorSessionID == "" || !wasSilent {
		return false
	}
	switch status {
	case "cancelled", "aborted":
	default:
		return false
	}
	return silent >= silentResumeRetireThreshold
}

package agent

import (
	"errors"
	"fmt"
	"os/exec"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

const piCleanupBudget = 10 * time.Second

type piProcessTracker interface {
	snapshot(bool) error
	signal(syscall.Signal) error
	remaining() ([]int, error)
	unobservedTools() bool
	close()
}

// piRunCleanup retains descendant identities while the parent still exists.
// Process groups alone do not own Pi's detached Unix tools. This is bounded,
// best-effort discovery, not containment of arbitrary double-forking programs.
type piRunCleanup struct {
	mu         sync.Mutex
	tracker    piProcessTracker
	err        error
	tools      atomic.Int32
	once       sync.Once
	done       chan struct{}
	stop       chan struct{}
	observed   chan struct{}
	exited     chan struct{}
	finished   bool
	unobserved bool
}

func newPiRunCleanup(cmd *exec.Cmd) *piRunCleanup {
	c := &piRunCleanup{tracker: newPiProcessTracker(cmd), done: make(chan struct{}), stop: make(chan struct{}), observed: make(chan struct{}), exited: make(chan struct{})}
	c.snapshot()
	go func() {
		defer close(c.observed)
		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-c.stop:
				return
			case <-ticker.C:
				if c.tools.Load() > 0 {
					c.snapshot()
				}
				if piRuntimeExited(cmd) {
					close(c.exited)
					return
				}
			}
		}
	}()
	return c
}

func (c *piRunCleanup) snapshot() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.finished {
		return
	}
	if err := c.tracker.snapshot(c.tools.Load() > 0); c.err == nil {
		c.err = err
	}
}

func (c *piRunCleanup) observe(event string) {
	switch event {
	case "tool_execution_start":
		c.tools.Add(1)
		c.snapshot()
	case "tool_execution_end":
		if c.tools.Load() > 0 {
			c.tools.Add(-1)
		}
		c.snapshot()
	case "agent_end":
		c.tools.Store(0)
	}
}

// finish is shared by cancellation, provider-error expiry, and normal EOF.
// Pipes and Result cannot be released until this single cleanup has finished.
func (c *piRunCleanup) finish(cmd *exec.Cmd, closeStdin, closePipes func(), grace time.Duration) error {
	c.once.Do(func() {
		defer close(c.done)
		close(c.stop)
		<-c.observed
		c.mu.Lock()
		defer c.mu.Unlock()
		c.finished = true
		defer c.tracker.close()
		defer closePipes()
		deadline := time.Now().Add(piCleanupBudget)
		c.err = errors.Join(c.err, c.tracker.snapshot(c.tools.Load() > 0))
		closeStdin()
		// cmd.Wait has not run yet: the unreaped leader still reserves this
		// process-group ID. Detached descendants use retained identities below.
		signalProcessGroup(cmd, syscall.SIGTERM)
		graceEnd := time.Now().Add(grace)
		for time.Now().Before(graceEnd) {
			remaining, err := c.tracker.remaining()
			if err == nil && len(remaining) == 0 {
				break
			}
			if err := c.tracker.snapshot(c.tools.Load() > 0); c.err == nil {
				c.err = err
			}
			time.Sleep(20 * time.Millisecond)
		}
		// Re-scan before killing the parent, then stop every retained identity.
		// Never signal a detached numeric PGID after its leader has exited.
		c.err = errors.Join(c.err, c.tracker.snapshot(c.tools.Load() > 0))
		c.unobserved = c.tracker.unobservedTools()
		signalProcessGroup(cmd, syscall.SIGKILL)
		c.err = errors.Join(c.err, c.tracker.signal(syscall.SIGKILL))
		for {
			remaining, err := c.tracker.remaining()
			if err != nil {
				c.err = errors.Join(c.err, err)
				break
			}
			if len(remaining) == 0 {
				break
			}
			if time.Now().After(deadline) {
				c.err = errors.Join(c.err, fmt.Errorf("processes still active: %v", remaining))
				break
			}
			// A retained Darwin process may exec between identity lookup and
			// signalling. Retry against its birth identity, never a reused PID.
			if err := c.tracker.signal(syscall.SIGKILL); err != nil {
				c.err = errors.Join(c.err, err)
				break
			}
			time.Sleep(20 * time.Millisecond)
		}
	})
	<-c.done
	return c.err
}

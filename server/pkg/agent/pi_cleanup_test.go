package agent

import (
	"errors"
	"os/exec"
	"syscall"
	"testing"
	"time"
)

type failedPiProcessTracker struct{ signalled, closed bool }

func (*failedPiProcessTracker) unobservedTools() bool { return false }

func (*failedPiProcessTracker) snapshot(bool) error {
	return errors.New("cannot inspect process identity")
}
func (p *failedPiProcessTracker) signal(syscall.Signal) error { p.signalled = true; return nil }
func (*failedPiProcessTracker) remaining() ([]int, error)     { return nil, nil }
func (p *failedPiProcessTracker) close()                      { p.closed = true }

func TestPiCleanupInspectionFailureIsNotSuccess(t *testing.T) {
	tracker := &failedPiProcessTracker{}
	observed := make(chan struct{})
	close(observed)
	c := &piRunCleanup{tracker: tracker, done: make(chan struct{}), stop: make(chan struct{}), observed: observed}
	pipesClosed := false
	err := c.finish(&exec.Cmd{}, func() {}, func() {
		if !tracker.signalled {
			t.Error("output pipes released before cleanup finished")
		}
		pipesClosed = true
	}, time.Millisecond)
	if err == nil || !pipesClosed || !tracker.closed {
		t.Fatalf("inspection failure was lost: err=%v pipesClosed=%v", err, pipesClosed)
	}
}

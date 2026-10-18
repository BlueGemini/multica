package daemon

import (
	"errors"
	"runtime"
	"slices"
	"testing"

	"github.com/multica-ai/multica/server/internal/daemon/execenv"
	"github.com/multica-ai/multica/server/pkg/agent"
)

func TestCursorSupplementHookCommandOnlyForManagedWorkdirs(t *testing.T) {
	originalResolveSelfExecutable := resolveSelfExecutable
	t.Cleanup(func() { resolveSelfExecutable = originalResolveSelfExecutable })
	resolveSelfExecutable = func() (string, error) { return "/usr/local/bin/multica", nil }

	command, ok := cursorSupplementHookCommand(&execenv.Environment{WorkDir: "/w/workdir"})
	if runtime.GOOS == "windows" {
		if ok {
			t.Fatal("cursor steering offered on Windows")
		}
	} else if want := []string{"/usr/local/bin/multica", agent.CursorHookHelperArg}; !ok || !slices.Equal(command, want) {
		t.Fatalf("managed workdir: command=%q ok=%v, want %q", command, ok, want)
	}

	for name, env := range map[string]*execenv.Environment{
		"nil env":         nil,
		"local directory": {WorkDir: "/Users/me/project", LocalDirectory: true},
		"local worktree":  {WorkDir: "/Users/me/project-wt", LocalWorktree: &execenv.LocalWorktree{}},
	} {
		if _, ok := cursorSupplementHookCommand(env); ok {
			t.Fatalf("%s: cursor steering offered", name)
		}
	}

	resolveSelfExecutable = func() (string, error) { return "", errors.New("unresolvable") }
	if _, ok := cursorSupplementHookCommand(&execenv.Environment{WorkDir: "/w/workdir"}); ok {
		t.Fatal("cursor steering offered without a relay executable")
	}
}

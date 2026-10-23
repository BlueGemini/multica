//go:build !windows

package agent

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCheckOpenCodeResumeClock(t *testing.T) {
	for _, tc := range []struct {
		name, body               string
		wantSkew, wantUnverified bool
	}{
		{"normal", `printf '%s' '{"info":{"id":"ses-test","time":{"updated":1}},"messages":[{"info":{"time":{"created":1}}}]}'`, false, false},
		{"future", `printf '%s' '{"info":{"id":"ses-test","time":{"updated":9999999999999}},"messages":[]}'`, true, false},
		{"failure with private stderr", `echo private-transcript >&2; exit 1`, false, true},
		{"malformed", `echo private-transcript`, false, true},
		{"oversized", `printf '{"ignored":"'; head -c 33554433 /dev/zero | LC_ALL=C tr '\000' x; printf '"}'`, false, true},
		{"timeout", `sleep 30`, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cwd := t.TempDir()
			bin := filepath.Join(t.TempDir(), "opencode")
			// Assert the same storage selection, project root and MCP overlay as
			// Execute, without ever resolving an installed agent or its account.
			body := `#!/bin/sh
[ "$1" = export ] && [ "$2" = ses-test ] && [ "$3" = --sanitize ] || exit 2
[ "$PWD" = "$CLOCK_EXPECTED_CWD" ] && [ "$(pwd)" = "$CLOCK_EXPECTED_CWD" ] || exit 3
[ "$XDG_DATA_HOME" = clock-test-storage ] || exit 4
case "$OPENCODE_CONFIG_CONTENT" in *clock-mcp*) ;; *) exit 5;; esac
` + tc.body + "\n"
			if err := os.WriteFile(bin, []byte(body), 0o755); err != nil {
				t.Fatal(err)
			}
			cfg := Config{ExecutablePath: bin, BuiltinRuntime: true, CLIVersion: "1.18.30", Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Env: map[string]string{"CLOCK_EXPECTED_CWD": cwd, "XDG_DATA_HOME": "clock-test-storage"}}
			opts := ExecOptions{Cwd: cwd, ResumeSessionID: "ses-test", McpConfig: []byte(`{"mcpServers":{"clock-mcp":{"command":"unused"}}}`)}
			ctx := context.Background()
			if tc.name == "timeout" {
				var cancel context.CancelFunc
				ctx, cancel = context.WithTimeout(ctx, 100*time.Millisecond)
				defer cancel()
			}
			err := CheckOpenCodeResumeClock(ctx, cfg, opts)
			if errors.Is(err, ErrOpenCodeClockSkew) != tc.wantSkew || (err != nil && !errors.Is(err, ErrOpenCodeClockSkew)) != tc.wantUnverified {
				t.Fatalf("check = %v, want skew=%v unverified=%v", err, tc.wantSkew, tc.wantUnverified)
			}
			if err != nil && strings.Contains(err.Error(), "private-transcript") {
				t.Fatal("export contents leaked")
			}
		})
	}
}

func TestCheckOpenCodeResumeClockUnsupportedContractsDoNotExecute(t *testing.T) {
	for _, tc := range []struct {
		version string
		builtin bool
		args    []string
	}{
		{"1.18.30", false, nil}, {"", true, nil}, {"opencode v2.0.10", true, nil}, {"1.18.31", true, nil},
		{"1.18.30", true, []string{"--server=https://unused.invalid"}},
		{"1.18.30", true, []string{"--attach", "https://unused.invalid"}},
		{"1.18.30", true, []string{"--session", "other-session"}},
		{"1.18.30", true, []string{"-sother-session"}},
		{"1.18.30", true, []string{"-csother-session"}},
	} {
		cfg := Config{ExecutablePath: filepath.Join(t.TempDir(), "does-not-exist"), BuiltinRuntime: tc.builtin, CLIVersion: tc.version}
		err := CheckOpenCodeResumeClock(context.Background(), cfg, ExecOptions{ResumeSessionID: "ses-test", CustomArgs: tc.args})
		if err == nil || errors.Is(err, ErrOpenCodeClockSkew) || strings.Contains(err.Error(), "executable not found") {
			t.Fatalf("unsupported contract must be rejected before lookup: %v", err)
		}
	}
}

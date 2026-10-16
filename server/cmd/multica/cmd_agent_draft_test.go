package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

func newAgentDraftSetTestCmd() *cobra.Command {
	cmd := &cobra.Command{Use: "set"}
	addAgentDraftConfigFlags(cmd)
	cmd.Flags().String("profile", "", "")
	return cmd
}

func TestRunAgentDraftSetSendsOnlyChangedFields(t *testing.T) {
	t.Chdir(t.TempDir())
	t.Setenv("MULTICA_AGENT_ID", "")
	t.Setenv("MULTICA_TASK_ID", "")
	if err := os.WriteFile("instructions.md", []byte("# Role\nWrite the weekly report.\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	var body map[string]map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPatch || r.URL.Path != "/api/agent-drafts/draft-1" {
			t.Fatalf("request = %s %s", r.Method, r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id":      "draft-1",
			"status":  "pending",
			"config":  map[string]any{"name": "Weekly reporter"},
			"mention": "[Weekly reporter](mention://agent-draft/draft-1)",
		})
	}))
	defer srv.Close()
	setCLITestServerEnv(t, srv.URL)

	cmd := newAgentDraftSetTestCmd()
	for flag, value := range map[string]string{
		"instructions-file": "instructions.md",
		"skill-ids":         "s1,s2",
		"access":            "workspace",
		"output":            "table",
	} {
		if err := cmd.Flags().Set(flag, value); err != nil {
			t.Fatal(err)
		}
	}
	out, err := captureStdout(t, func() error { return runAgentDraftSet(cmd, []string{"draft-1"}) })
	if err != nil {
		t.Fatalf("runAgentDraftSet: %v", err)
	}

	want := map[string]any{
		"instructions":     "# Role\nWrite the weekly report.",
		"skill_ids":        []any{"s1", "s2"},
		"permission_scope": "workspace",
	}
	if !reflect.DeepEqual(body["config"], want) {
		t.Fatalf("config = %#v, want %#v", body["config"], want)
	}
	if !strings.Contains(out, "mention://agent-draft/draft-1") {
		t.Fatalf("table output should hand the agent the mention link: %s", out)
	}
}

func TestRunAgentDraftSetRequiresAField(t *testing.T) {
	t.Chdir(t.TempDir())
	cmd := newAgentDraftSetTestCmd()
	if err := runAgentDraftSet(cmd, []string{"draft-1"}); err == nil {
		t.Fatal("expected an error when no field flag is passed")
	}
}

func TestRunAgentDraftSetSendsFollowUps(t *testing.T) {
	t.Chdir(t.TempDir())
	t.Setenv("MULTICA_AGENT_ID", "")
	t.Setenv("MULTICA_TASK_ID", "")

	var body map[string]json.RawMessage
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "draft-1", "status": "pending"})
	}))
	defer srv.Close()
	setCLITestServerEnv(t, srv.URL)

	cmd := newAgentDraftSetTestCmd()
	for flag, value := range map[string]string{
		"needs-env": "SENTRY_TOKEN=Read-only token",
		"follow-up": "Daily 09:00 autopilot",
	} {
		if err := cmd.Flags().Set(flag, value); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := captureStdout(t, func() error { return runAgentDraftSet(cmd, []string{"draft-1"}) }); err != nil {
		t.Fatalf("runAgentDraftSet: %v", err)
	}
	var followUps []map[string]string
	if err := json.Unmarshal(body["follow_ups"], &followUps); err != nil {
		t.Fatalf("follow_ups: %v (%s)", err, body["follow_ups"])
	}
	got := map[string]map[string]string{}
	for _, item := range followUps {
		got[item["kind"]] = item
	}
	if got["env"]["label"] != "SENTRY_TOKEN" || got["env"]["hint"] != "Read-only token" || got["note"]["label"] != "Daily 09:00 autopilot" {
		t.Fatalf("follow_ups = %+v", followUps)
	}
}

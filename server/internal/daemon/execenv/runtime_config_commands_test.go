package execenv

import (
	"strings"
	"testing"
)

// availableCommandsSection cuts `## Available Commands` out of a brief by its
// line-start heading, so a phrase that also appears in another section (the
// Comment Formatting rules, the Repositories checkout note) cannot satisfy an
// assertion meant for this one.
func availableCommandsSection(t *testing.T, brief string) string {
	t.Helper()
	start := strings.Index(brief, "\n## Available Commands\n")
	if start < 0 {
		t.Fatalf("brief has no ## Available Commands section:\n%s", brief)
	}
	rest := brief[start+1:]
	if end := strings.Index(rest[len("## Available Commands\n"):], "\n## "); end >= 0 {
		return rest[:len("## Available Commands\n")+end]
	}
	return rest
}

// TestAvailableCommandsKeepsCompressedContracts pins what MUL-8292 kept when it
// moved command detail out of the brief and into `--help` and the
// multica-platform references. Each entry is a behaviour the agent needs at
// the moment it reaches for the command, not something it can look up after
// the fact; the removed parts (wakeup condition catalogue, PR snapshot
// mechanics, actor-filter recipe, repeated file rules) are covered where the
// pointer leads.
func TestAvailableCommandsKeepsCompressedContracts(t *testing.T) {
	t.Parallel()
	brief := buildMetaSkillContent("claude", TaskContextForEnv{IssueID: "issue-1", AgentID: "a-1", AgentName: "Eve"})
	ac := availableCommandsSection(t, brief)

	for _, want := range []string{
		// wakeup: the run ends after registering; conditions beat polling; the
		// failure field and where the full syntax lives.
		"persist an event, condition or time wakeup on this issue, then finish the current run",
		"use one `--until-*` condition so no run starts before it holds",
		"a rule that does not fire records why in `last_error`",
		"`multica issue wakeup create --help` and the multica-platform issues reference",
		// comment list: the pagination pointer and the THREADS trap.
		"workflow step 2 gives the two bounded reads",
		"it caps THREADS, not comments",
		// issue create: long descriptions go through a file under the comment rules.
		"Put agent-authored long descriptions in `--description-file <path>`, written under the same file rules as `## Comment Formatting`",
		// duplicate mark: why a plain cancel is not enough.
		"`multica issue status <id> cancelled --duplicate-of <original>`",
		"a plain cancel leaves no link",
		// comment add: the file-first mandate stays at the call site.
		"Agent-authored bodies MUST use `--content-file`",
		// repo checkout: re-run safety and the destructive flag's limit.
		"re-running it keeps existing work and only fetches",
		"`--fresh` discards uncommitted and untracked files",
		"push any you still need first",
		// Git identity: the scoped override and the two prohibitions.
		"keep it unless asked",
		"`git config --worktree user.name` / `user.email`",
		"plain or `--local` config can leak into a shared cache",
		"never change the global identity",
	} {
		if !strings.Contains(ac, want) {
			t.Errorf("Available Commands lost %q\n---\n%s", want, ac)
		}
	}

	// Detail that now lives behind the pointers must not drift back in.
	for _, banned := range []string{
		"--until-children-done",
		"server-side GitHub snapshots",
		"--filter-actor-id USER_ID",
		"never `/tmp` or shared paths — same workdir rule",
	} {
		if strings.Contains(ac, banned) {
			t.Errorf("Available Commands carries %q again; it belongs in --help / the platform reference\n---\n%s", banned, ac)
		}
	}
}

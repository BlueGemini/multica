package daemon

import (
	"strings"
	"testing"
)

// MUL-8218 / GH #9492: a resumed session may quote the pre-edit text of the
// trigger comment. The prompt must say which version is current without
// claiming the earlier run's work was undone.
func TestBuildCommentPromptEditedTrigger(t *testing.T) {
	base := Task{
		IssueID:                "issue-1",
		TriggerCommentID:       "comment-1",
		TriggerCommentContent:  "Now it connects over TLS",
		PriorSessionID:         "session-1",
		TriggerCommentEditedAt: "2026-10-26T02:20:00Z",
		TriggerCommentRevision: 3,
	}

	t.Run("edited on a resumed session", func(t *testing.T) {
		out := buildCommentPrompt(base, "claude")
		for _, want := range []string{
			"[EDITED COMMENT] A user edited a comment after your previous run in this session started.",
			"> Now it connects over TLS",
			"This comment (comment-1, revision 3) was edited at 2026-10-26T02:20:00Z.",
			"The text quoted above is the current version and the only one to act on",
			"still happened and was not rolled back",
		} {
			if !strings.Contains(out, want) {
				t.Errorf("prompt missing %q:\n%s", want, out)
			}
		}
		if strings.Contains(out, "[NEW COMMENT]") {
			t.Error("edited trigger must not be announced as a new comment")
		}
	})

	t.Run("not edited", func(t *testing.T) {
		task := base
		task.TriggerCommentEditedAt = ""
		task.TriggerCommentRevision = 0
		out := buildCommentPrompt(task, "claude")
		if !strings.Contains(out, "[NEW COMMENT] A user just left a new comment.") {
			t.Errorf("unedited trigger must keep the new-comment header:\n%s", out)
		}
		if strings.Contains(out, "[EDITED COMMENT]") || strings.Contains(out, "was edited at") {
			t.Error("unedited trigger must not carry the edit note")
		}
	})

	// Without a resumed session there is no earlier version in history to
	// warn about; the daemon clears PriorSessionID when it drops the session.
	for name, mutate := range map[string]func(*Task){
		"cold start":         func(t *Task) { t.PriorSessionID = "" },
		"resume unavailable": func(t *Task) { t.PriorSessionResumeUnavailable = true },
	} {
		t.Run(name, func(t *testing.T) {
			task := base
			mutate(&task)
			out := buildCommentPrompt(task, "claude")
			if strings.Contains(out, "[EDITED COMMENT]") || strings.Contains(out, "was edited at") {
				t.Errorf("%s: edit note must only render on a resumed session:\n%s", name, out)
			}
		})
	}
}

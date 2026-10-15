package issueworkflow

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

const testAgentID = "0f0e0d0c-0b0a-4909-8807-060504030201"

func testCatalog() map[string]CatalogEntry {
	return map[string]CatalogEntry{
		"backlog":     {Key: "backlog", Name: "Backlog", Category: "unstarted"},
		"todo":        {Key: "todo", Name: "Todo", Category: "unstarted"},
		"implement":   {Key: "implement", Name: "Implement", Category: "started"},
		"code_review": {Key: "code_review", Name: "Code review", Category: "started"},
		"blocked":     {Key: "blocked", Name: "Blocked", Category: "started"},
		"done":        {Key: "done", Name: "Done", Category: "done"},
		"cancelled":   {Key: "cancelled", Name: "Cancelled", Category: "closed"},
		"retired":     {Key: "retired", Name: "Retired", Category: "started", Archived: true},
	}
}

func devDefinition() Definition {
	def := Definition{Name: "Delivery", Steps: stepsFor(WithFixed([]string{"implement", "code_review"}))}
	return WithHandoffs(def, []Step{
		{StatusKey: "implement", Handler: Handler{Type: HandlerAgent, ID: testAgentID}, Instructions: "Implement it."},
		{StatusKey: "code_review", Handler: Handler{Type: HandlerProjectLead}, NextStatusKey: "done", BackStatusKey: "implement"},
	})
}

func TestNormalizePlacesFixedStatusesAroundOwnSteps(t *testing.T) {
	name, _, keys := Normalize(" Delivery ", "", []string{"done", " implement ", "todo", "code_review"})
	if name != "Delivery" {
		t.Fatalf("name was not trimmed: %q", name)
	}
	want := []string{"backlog", "todo", "implement", "code_review", "blocked", "done", "cancelled"}
	if !reflect.DeepEqual(keys, want) {
		t.Fatalf("keys = %v, want %v", keys, want)
	}
	if got := BuiltInDefaultKeys(); !reflect.DeepEqual(got, []string{"backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"}) {
		t.Fatalf("built-in Default = %v", got)
	}
}

func TestValidateRejectsBrokenWorkflows(t *testing.T) {
	cases := map[string]struct {
		name      string
		middle    []string
		isDefault bool
		want      string
	}{
		"empty name":       {name: "", want: "name"},
		"reserved name":    {name: "default", want: "reserved"},
		"unknown status":   {name: "x", middle: []string{"nope"}, want: "does not exist"},
		"archived status":  {name: "x", middle: []string{"retired"}, want: "archived"},
		"duplicate status": {name: "x", middle: []string{"implement", "implement"}, want: "more than once"},
	}
	for label, tc := range cases {
		t.Run(label, func(t *testing.T) {
			name, desc, keys := Normalize(tc.name, "", tc.middle)
			err := Validate(name, desc, keys, tc.isDefault, testCatalog())
			var verr *ValidationError
			if !errors.As(err, &verr) {
				t.Fatalf("Validate = %v, want a ValidationError", err)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error %q does not mention %q", err, tc.want)
			}
		})
	}
	name, desc, keys := Normalize(DefaultName, "", []string{"implement"})
	if err := Validate(name, desc, keys, true, testCatalog()); err != nil {
		t.Fatalf("Default keeps its reserved name: %v", err)
	}
}

func TestValidateHandoff(t *testing.T) {
	def := devDefinition()
	cases := map[string]struct {
		step Step
		want string
	}{
		"not a column":      {step: Step{StatusKey: "nope", Handler: Handler{Type: HandlerProjectLead}}, want: "not part"},
		"needs an id":       {step: Step{StatusKey: "implement", Handler: Handler{Type: HandlerAgent}}, want: "choose a agent"},
		"unknown handler":   {step: Step{StatusKey: "implement", Handler: Handler{Type: "robot"}}, want: "unknown handler"},
		"backlog parks":     {step: Step{StatusKey: "backlog", Handler: Handler{Type: HandlerProjectLead}}, want: "cannot be handed off"},
		"done finishes":     {step: Step{StatusKey: "done", Handler: Handler{Type: HandlerProjectLead}}, want: "cannot be handed off"},
		"next outside flow": {step: Step{StatusKey: "implement", Handler: Handler{Type: HandlerProjectLead}, NextStatusKey: "in_review"}, want: "not another status"},
		"next is itself":    {step: Step{StatusKey: "implement", Handler: Handler{Type: HandlerProjectLead}, NextStatusKey: "implement"}, want: "not another status"},
	}
	for label, tc := range cases {
		t.Run(label, func(t *testing.T) {
			err := ValidateHandoff(NormalizeHandoff(tc.step), def)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("ValidateHandoff = %v, want it to mention %q", err, tc.want)
			}
		})
	}
	if err := ValidateHandoff(NormalizeHandoff(Step{StatusKey: "todo", Handler: Handler{Type: HandlerProjectLead}}), def); err != nil {
		t.Fatalf("todo may hand off: %v", err)
	}
}

func TestNormalizeHandoffDropsStaleHandlerData(t *testing.T) {
	lead := NormalizeHandoff(Step{StatusKey: "a", Handler: Handler{Type: HandlerProjectLead, ID: testAgentID}, Instructions: " keep "})
	if lead.Handler.ID != "" || lead.Instructions != "keep" {
		t.Fatalf("project-lead handoff = %+v, want no id and trimmed instructions", lead)
	}
	none := NormalizeHandoff(Step{StatusKey: "b", Handler: Handler{Type: HandlerNone, ID: testAgentID}, Instructions: "drop"})
	if none.Handler.ID != "" || none.Instructions != "" {
		t.Fatalf("no-handoff = %+v, want no id and no instructions", none)
	}
	if empty := NormalizeHandoff(Step{StatusKey: "c"}); empty.Handler.Type != HandlerNone {
		t.Fatalf("empty handler type = %q, want none", empty.Handler.Type)
	}
}

func TestWithHandoffsIgnoresOtherColumnsAndTerminalStatuses(t *testing.T) {
	def := Definition{Name: "Default", IsDefault: true, Steps: stepsFor(BuiltInDefaultKeys())}
	got := WithHandoffs(def, []Step{
		{StatusKey: "in_progress", Handler: Handler{Type: HandlerAgent, ID: testAgentID}},
		{StatusKey: "code_review", Handler: Handler{Type: HandlerProjectLead}},
		{StatusKey: "done", Handler: Handler{Type: HandlerProjectLead}},
	})
	if step, _ := got.Step("in_progress"); !step.HandsOff() {
		t.Fatal("in_progress should hand off")
	}
	if got.Has("code_review") {
		t.Fatal("a handoff must not add a column")
	}
	if step, _ := got.Step("done"); step.HandsOff() {
		t.Fatal("done must never hand off")
	}
	if step, _ := def.Step("in_progress"); step.HandsOff() {
		t.Fatal("WithHandoffs must not change its input")
	}
}

func TestEncodeHandoffsClearsWhenNothingIsLeft(t *testing.T) {
	raw, err := EncodeHandoffs([]Step{{StatusKey: "todo", Handler: Handler{Type: HandlerNone}}})
	if err != nil || raw != nil {
		t.Fatalf("EncodeHandoffs = %s, %v; want nil", raw, err)
	}
}

func TestNextStatusFallsBackToTheNextColumn(t *testing.T) {
	def := devDefinition()
	if got := def.NextStatus("implement"); got != "code_review" {
		t.Fatalf("implement next = %q, want the next column", got)
	}
	if got := def.NextStatus("code_review"); got != "done" {
		t.Fatalf("code_review next = %q, want its own choice", got)
	}
	// The column after the last own step is blocked, which is skipped.
	plain := Definition{Steps: stepsFor(WithFixed([]string{"implement"}))}
	if got := plain.NextStatus("implement"); got != "done" {
		t.Fatalf("last step next = %q, want done", got)
	}
}

func TestResolveHandler(t *testing.T) {
	var lead pgtype.UUID
	_ = lead.Scan(testAgentID)
	project := db.Project{LeadType: pgtype.Text{String: "member", Valid: true}, LeadID: lead}
	creator := lead

	def := devDefinition()
	implement, _ := def.Step("implement")
	review, _ := def.Step("code_review")
	todo, _ := def.Step("todo")
	if typ, id, ok := ResolveHandler(implement, project, "member", creator); !ok || typ != "agent" || id != lead {
		t.Fatalf("agent handler = %s %v %v", typ, id, ok)
	}
	if typ, _, ok := ResolveHandler(review, project, "member", creator); !ok || typ != "member" {
		t.Fatalf("project lead handler = %s %v, want member", typ, ok)
	}
	if _, _, ok := ResolveHandler(review, db.Project{}, "member", creator); ok {
		t.Fatal("a project without a lead must not resolve a handoff")
	}
	if _, _, ok := ResolveHandler(Step{StatusKey: "x", Handler: Handler{Type: HandlerCreator}}, project, "agent", creator); !ok {
		t.Fatal("creator handler should resolve to the issue creator")
	}
	if _, _, ok := ResolveHandler(todo, project, "member", creator); ok {
		t.Fatal("a column without a handoff must not resolve one")
	}
}

func TestMoveTargetPrefersSameStatusThenCategory(t *testing.T) {
	def := devDefinition()
	category := func(key string) string {
		if key == "in_review" {
			return "started"
		}
		if key == "elsewhere" {
			return "unknown"
		}
		return testCatalog()[key].Category
	}
	if got := MoveTarget(def, "done", category); got != "done" {
		t.Fatalf("listed status moved to %q", got)
	}
	if got := MoveTarget(def, "in_review", category); got != "implement" {
		t.Fatalf("in_review moved to %q, want the first started step", got)
	}
	if got := MoveTarget(def, "elsewhere", category); got != StartStatus {
		t.Fatalf("a category the workflow lacks moved to %q, want todo", got)
	}
}

func TestCheckStatusListsAllowedKeys(t *testing.T) {
	def := devDefinition()
	if err := CheckStatus(nil, "anything"); err != nil {
		t.Fatalf("an issue outside projects accepts any status, got %v", err)
	}
	if err := CheckStatus(&Definition{Name: DefaultName, IsDefault: true, Steps: stepsFor(BuiltInDefaultKeys())}, "code_review"); err != nil {
		t.Fatalf("Default accepts any status, got %v", err)
	}
	err := CheckStatus(&def, "in_review")
	var notIn *NotInWorkflowError
	if !errors.As(err, &notIn) {
		t.Fatalf("CheckStatus = %v, want NotInWorkflowError", err)
	}
	if !strings.Contains(err.Error(), "backlog, todo, implement, code_review, blocked, done, cancelled") {
		t.Fatalf("error %q should list the workflow's keys for agents", err)
	}
}

func TestBriefNamesStepCommandsAndHandlers(t *testing.T) {
	brief := Brief(BriefInput{
		Workflow:        devDefinition(),
		ProjectName:     "Payments",
		StatusKey:       "code_review",
		IssueIdentifier: "MUL-7",
		StatusName:      func(key string) string { return testCatalog()[key].Name },
		HandlerName: func(step Step) string {
			if step.Handler.Type == HandlerAgent {
				return "Forge"
			}
			if step.Handler.Type == HandlerProjectLead {
				return "Lin (project lead)"
			}
			return ""
		},
	})
	for _, want := range []string{
		"This project's workflow — Delivery (Payments)\n",
		`You are handling the "Code review" step of MUL-7.`,
		"- `implement` Implement — hands off to Forge\n",
		"- `code_review` Code review — hands off to Lin (project lead)   ← current\n",
		"- `done` Done\n",
		"Step done      → multica issue status MUL-7 done\n",
		"Needs changes  → multica issue status MUL-7 implement\n",
		"Can't proceed  → multica issue status MUL-7 blocked",
	} {
		if !strings.Contains(brief, want) {
			t.Fatalf("brief is missing %q:\n%s", want, brief)
		}
	}
}

func TestBriefPrintsBuiltInKeysOnce(t *testing.T) {
	def := WithHandoffs(Definition{Name: DefaultName, IsDefault: true, Steps: stepsFor(BuiltInDefaultKeys())},
		[]Step{{StatusKey: "in_review", Handler: Handler{Type: HandlerProjectLead}}})
	brief := Brief(BriefInput{
		Workflow:        def,
		StatusKey:       "in_review",
		IssueIdentifier: "MUL-1",
		// Built-ins resolve to no stored name.
		StatusName: func(string) string { return "" },
	})
	if !strings.Contains(brief, "- `todo`\n") || strings.Contains(brief, "`todo` todo") {
		t.Fatalf("a built-in step should print its key once:\n%s", brief)
	}
	if !strings.Contains(brief, "Step done      → multica issue status MUL-1 done\n") {
		t.Fatalf("the last own step should suggest done:\n%s", brief)
	}
}

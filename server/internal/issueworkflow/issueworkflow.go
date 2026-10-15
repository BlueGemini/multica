// Package issueworkflow owns project workflows (MUL-7420).
//
// A workflow selects and orders statuses from the workspace's shared
// issue_status catalog: it decides which columns a project's board shows.
// Every workflow starts with backlog and todo and ends with blocked, done and
// cancelled; only the steps in between differ. Statuses stay shared and
// peer-level, so issue.status keeps holding a catalog key.
//
// Who a column hands an issue to belongs to the project, not the workflow
// (project.workflow_handoffs): when an issue enters a status through an
// ordinary issue write, it is assigned to that project's handler for the
// status and, for an agent or squad, its run starts with the step's
// instructions. Two projects can share a workflow and hand the same step to
// different agents.
//
// A project without a workflow uses the workspace Default workflow. Default
// is a stored row once created; before that it is the built-in statuses.
// Status writes on a Default project are never rejected: issues already on
// statuses Default does not list keep them, as they always have.
package issueworkflow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/issuestatus"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Handler types a project can hand an issue to when it enters a status.
const (
	HandlerNone        = "none"
	HandlerAgent       = "agent"
	HandlerSquad       = "squad"
	HandlerMember      = "member"
	HandlerProjectLead = "project_lead"
	HandlerCreator     = "creator"
)

const (
	MaxSteps             = 50
	MaxNameRunes         = 64
	MaxDescriptionRunes  = 256
	MaxInstructionsRunes = 8000
	DefaultName          = "Default"
)

// StartStatus is where a new issue lands unless its creator picks a status.
const StartStatus = issuestatus.Todo

// Every workflow lists these statuses, in this order, around its own steps.
var (
	fixedHead = []string{issuestatus.Backlog, issuestatus.Todo}
	fixedTail = []string{issuestatus.Blocked, issuestatus.Done, issuestatus.Cancelled}
)

// IsFixed reports whether every workflow lists the status in a fixed place.
func IsFixed(key string) bool {
	for _, k := range fixedHead {
		if k == key {
			return true
		}
	}
	for _, k := range fixedTail {
		if k == key {
			return true
		}
	}
	return false
}

// AcceptsHandoff reports whether entering the status can hand an issue off.
// Parking, finishing and cancelling an issue never reassign it.
func AcceptsHandoff(key string) bool {
	switch key {
	case issuestatus.Backlog, issuestatus.Done, issuestatus.Cancelled:
		return false
	}
	return true
}

// WithFixed places the fixed statuses around a workflow's own steps. Fixed
// keys inside middle are dropped, so their position never moves.
func WithFixed(middle []string) []string {
	out := make([]string, 0, len(fixedHead)+len(middle)+len(fixedTail))
	out = append(out, fixedHead...)
	for _, key := range middle {
		if !IsFixed(key) {
			out = append(out, key)
		}
	}
	return append(out, fixedTail...)
}

// MiddleKeys returns the workflow's own steps, without the fixed statuses.
func MiddleKeys(keys []string) []string {
	out := make([]string, 0, len(keys))
	for _, key := range keys {
		if !IsFixed(key) {
			out = append(out, key)
		}
	}
	return out
}

// BuiltInDefaultKeys is Default before a workspace stores its own.
func BuiltInDefaultKeys() []string {
	return WithFixed([]string{issuestatus.InProgress, issuestatus.InReview})
}

// Handler names who receives an issue when it enters a step. ID is set only
// for the concrete types (agent, squad, member).
type Handler struct {
	Type string `json:"type"`
	ID   string `json:"id,omitempty"`
}

// Step is one status of a project's board with that project's handoff for it.
// A workflow row stores only StatusKey; a project's workflow_handoffs stores
// the rest.
type Step struct {
	StatusKey     string  `json:"status_key"`
	Handler       Handler `json:"handler"`
	Instructions  string  `json:"instructions"`
	NextStatusKey string  `json:"next_status_key,omitempty"`
	BackStatusKey string  `json:"back_status_key,omitempty"`
}

// Definition is the workflow a project uses, with that project's handoffs
// applied to its steps.
type Definition struct {
	ID        pgtype.UUID
	Name      string
	IsDefault bool
	Steps     []Step
}

// HandsOff reports whether entering the step reassigns the issue.
func (s Step) HandsOff() bool {
	switch s.Handler.Type {
	case HandlerAgent, HandlerSquad, HandlerMember, HandlerProjectLead, HandlerCreator:
		return true
	}
	return false
}

type storedStep struct {
	StatusKey string `json:"status_key"`
}

// Decode parses a stored workflow row. Its steps carry no handoffs.
func Decode(row db.IssueWorkflow) (Definition, error) {
	keys, err := DecodeKeys(row.Steps)
	if err != nil {
		return Definition{}, err
	}
	return Definition{ID: row.ID, Name: row.Name, IsDefault: row.IsDefault, Steps: stepsFor(keys)}, nil
}

// DecodeKeys parses a stored steps array into its status keys, in order.
func DecodeKeys(raw []byte) ([]string, error) {
	if len(raw) == 0 {
		return []string{}, nil
	}
	var stored []storedStep
	if err := json.Unmarshal(raw, &stored); err != nil {
		return nil, fmt.Errorf("decode workflow steps: %w", err)
	}
	keys := make([]string, len(stored))
	for i, s := range stored {
		keys[i] = s.StatusKey
	}
	return keys, nil
}

// EncodeKeys serializes a workflow's statuses for storage.
func EncodeKeys(keys []string) ([]byte, error) {
	stored := make([]storedStep, len(keys))
	for i, key := range keys {
		stored[i] = storedStep{StatusKey: key}
	}
	return json.Marshal(stored)
}

func stepsFor(keys []string) []Step {
	steps := make([]Step, len(keys))
	for i, key := range keys {
		steps[i] = Step{StatusKey: key, Handler: Handler{Type: HandlerNone}}
	}
	return steps
}

// DecodeHandoffs parses a project's stored handoffs, normalizing an empty
// handler to "none".
func DecodeHandoffs(raw []byte) ([]Step, error) {
	if len(raw) == 0 {
		return []Step{}, nil
	}
	var steps []Step
	if err := json.Unmarshal(raw, &steps); err != nil {
		return nil, fmt.Errorf("decode project handoffs: %w", err)
	}
	for i := range steps {
		if steps[i].Handler.Type == "" {
			steps[i].Handler.Type = HandlerNone
		}
	}
	return steps, nil
}

// EncodeHandoffs serializes a project's handoffs, dropping empty entries.
// It returns nil when nothing is left, which clears the column.
func EncodeHandoffs(steps []Step) ([]byte, error) {
	kept := make([]Step, 0, len(steps))
	for _, s := range steps {
		if s.HandsOff() || s.Instructions != "" || s.NextStatusKey != "" || s.BackStatusKey != "" {
			kept = append(kept, s)
		}
	}
	if len(kept) == 0 {
		return nil, nil
	}
	return json.Marshal(kept)
}

// WithHandoffs returns def with a project's handoffs applied to its steps.
// Handoffs for statuses the workflow does not list are ignored.
func WithHandoffs(def Definition, handoffs []Step) Definition {
	byKey := make(map[string]Step, len(handoffs))
	for _, h := range handoffs {
		byKey[h.StatusKey] = h
	}
	out := def
	out.Steps = make([]Step, len(def.Steps))
	for i, s := range def.Steps {
		if h, ok := byKey[s.StatusKey]; ok && AcceptsHandoff(s.StatusKey) {
			out.Steps[i] = h
			continue
		}
		out.Steps[i] = Step{StatusKey: s.StatusKey, Handler: Handler{Type: HandlerNone}}
	}
	return out
}

// Has reports whether the workflow lists the status key.
func (d Definition) Has(key string) bool {
	_, ok := d.Step(key)
	return ok
}

// Step returns the step for a status key.
func (d Definition) Step(key string) (Step, bool) {
	for _, s := range d.Steps {
		if s.StatusKey == key {
			return s, true
		}
	}
	return Step{}, false
}

// StatusKeys lists the workflow's statuses in board order.
func (d Definition) StatusKeys() []string {
	keys := make([]string, len(d.Steps))
	for i, s := range d.Steps {
		keys[i] = s.StatusKey
	}
	return keys
}

// HandsOffAnywhere reports whether any step hands an issue off.
func (d Definition) HandsOffAnywhere() bool {
	for _, s := range d.Steps {
		if s.HandsOff() {
			return true
		}
	}
	return false
}

// NextStatus is where a step's handler moves the issue when done: the step's
// own choice, or else the next status on the board that is not blocked.
func (d Definition) NextStatus(key string) string {
	step, ok := d.Step(key)
	if !ok {
		return ""
	}
	if step.NextStatusKey != "" {
		return step.NextStatusKey
	}
	for i, s := range d.Steps {
		if s.StatusKey != key {
			continue
		}
		for _, next := range d.Steps[i+1:] {
			if next.StatusKey != issuestatus.Blocked {
				return next.StatusKey
			}
		}
	}
	return ""
}

// CatalogEntry is the slice of an issue_status row validation needs.
type CatalogEntry struct {
	Key      string
	Name     string
	Category string
	Archived bool
}

// Normalize trims free text and places the fixed statuses around keys.
func Normalize(name, description string, keys []string) (string, string, []string) {
	middle := make([]string, 0, len(keys))
	for _, key := range keys {
		middle = append(middle, strings.TrimSpace(key))
	}
	return strings.TrimSpace(name), strings.TrimSpace(description), WithFixed(middle)
}

// ValidationError is a user-correctable problem with a workflow definition.
type ValidationError struct{ Message string }

func (e *ValidationError) Error() string { return e.Message }

func invalid(format string, args ...any) error {
	return &ValidationError{Message: fmt.Sprintf(format, args...)}
}

// Validate checks a normalized workflow against the status catalog. The
// Default workflow keeps its reserved name.
func Validate(name, description string, keys []string, isDefault bool, catalog map[string]CatalogEntry) error {
	if !isDefault {
		if name == "" || utf8.RuneCountInString(name) > MaxNameRunes {
			return invalid("name must be 1-%d characters", MaxNameRunes)
		}
		if strings.EqualFold(name, DefaultName) {
			return invalid("%q is reserved for the workspace default workflow", DefaultName)
		}
	}
	if utf8.RuneCountInString(description) > MaxDescriptionRunes {
		return invalid("description must be at most %d characters", MaxDescriptionRunes)
	}
	if len(keys) > MaxSteps {
		return invalid("a workflow can have at most %d statuses", MaxSteps)
	}
	seen := make(map[string]bool, len(keys))
	for _, key := range keys {
		entry, ok := catalog[key]
		if !ok && !issuestatus.IsBuiltIn(key) {
			return invalid("status %q does not exist", key)
		}
		if ok && entry.Archived {
			return invalid("status %q is archived", key)
		}
		if seen[key] {
			return invalid("status %q appears more than once", key)
		}
		seen[key] = true
	}
	return nil
}

// NormalizeHandoff trims a handoff and drops fields its handler type does
// not use.
func NormalizeHandoff(s Step) Step {
	s.StatusKey = strings.TrimSpace(s.StatusKey)
	s.Handler.Type = strings.TrimSpace(s.Handler.Type)
	s.Handler.ID = strings.TrimSpace(s.Handler.ID)
	if s.Handler.Type == "" {
		s.Handler.Type = HandlerNone
	}
	switch s.Handler.Type {
	case HandlerAgent, HandlerSquad, HandlerMember:
	default:
		// Only the concrete handler types carry an id; a stale one left
		// by a type switch in the form would otherwise be stored.
		s.Handler.ID = ""
	}
	s.Instructions = strings.TrimSpace(s.Instructions)
	if s.Handler.Type == HandlerNone {
		s.Instructions = ""
	}
	s.NextStatusKey = strings.TrimSpace(s.NextStatusKey)
	s.BackStatusKey = strings.TrimSpace(s.BackStatusKey)
	return s
}

// ValidateHandoff checks one normalized handoff against the project's
// workflow. Handler ids are checked by the caller, which owns the workspace
// lookups.
func ValidateHandoff(s Step, def Definition) error {
	if !def.Has(s.StatusKey) {
		return invalid("status %q is not part of this project's workflow", s.StatusKey)
	}
	switch s.Handler.Type {
	case HandlerNone, HandlerProjectLead, HandlerCreator:
	case HandlerAgent, HandlerSquad, HandlerMember:
		if s.Handler.ID == "" {
			return invalid("choose a %s to hand off to", s.Handler.Type)
		}
	default:
		return invalid("unknown handler type %q", s.Handler.Type)
	}
	if s.HandsOff() && !AcceptsHandoff(s.StatusKey) {
		return invalid("issues entering %q cannot be handed off", s.StatusKey)
	}
	if utf8.RuneCountInString(s.Instructions) > MaxInstructionsRunes {
		return invalid("instructions must be at most %d characters", MaxInstructionsRunes)
	}
	for _, ref := range []string{s.NextStatusKey, s.BackStatusKey} {
		if ref != "" && (ref == s.StatusKey || !def.Has(ref)) {
			return invalid("%q is not another status of this project's workflow", ref)
		}
	}
	return nil
}

// Querier is the read surface workflow resolution needs.
type Querier interface {
	GetIssueWorkflow(ctx context.Context, arg db.GetIssueWorkflowParams) (db.IssueWorkflow, error)
	GetDefaultIssueWorkflow(ctx context.Context, workspaceID pgtype.UUID) (db.IssueWorkflow, error)
	GetProjectInWorkspace(ctx context.Context, arg db.GetProjectInWorkspaceParams) (db.Project, error)
}

// DefaultFor loads the workspace Default workflow, or the built-in one when
// the workspace has not stored its own yet.
func DefaultFor(ctx context.Context, q Querier, workspaceID pgtype.UUID) (Definition, error) {
	row, err := q.GetDefaultIssueWorkflow(ctx, workspaceID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Definition{Name: DefaultName, IsDefault: true, Steps: stepsFor(BuiltInDefaultKeys())}, nil
		}
		return Definition{}, err
	}
	return Decode(row)
}

// ForProject loads the workflow a project uses with the project's handoffs
// applied. def is nil only for an issue outside any project.
func ForProject(ctx context.Context, q Querier, workspaceID, projectID pgtype.UUID) (*Definition, db.Project, error) {
	if !projectID.Valid {
		return nil, db.Project{}, nil
	}
	project, err := q.GetProjectInWorkspace(ctx, db.GetProjectInWorkspaceParams{ID: projectID, WorkspaceID: workspaceID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, db.Project{}, nil
		}
		return nil, db.Project{}, err
	}
	def, err := ForProjectRow(ctx, q, project)
	return def, project, err
}

// ForProjectRow loads the workflow of an already-loaded project. A dangling
// workflow reference falls back to Default.
func ForProjectRow(ctx context.Context, q Querier, project db.Project) (*Definition, error) {
	def, err := structureFor(ctx, q, project)
	if err != nil {
		return nil, err
	}
	handoffs, err := DecodeHandoffs(project.WorkflowHandoffs)
	if err != nil {
		return nil, err
	}
	out := WithHandoffs(def, handoffs)
	return &out, nil
}

func structureFor(ctx context.Context, q Querier, project db.Project) (Definition, error) {
	if project.WorkflowID.Valid {
		row, err := q.GetIssueWorkflow(ctx, db.GetIssueWorkflowParams{ID: project.WorkflowID, WorkspaceID: project.WorkspaceID})
		if err == nil {
			return Decode(row)
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return Definition{}, err
		}
	}
	return DefaultFor(ctx, q, project.WorkspaceID)
}

// ResolveHandler turns a step's handler into a concrete assignee for one
// issue. ok is false when the step does not hand off, or when a relative
// handler (project lead, creator) has nobody to resolve to.
func ResolveHandler(step Step, project db.Project, issueCreatorType string, issueCreatorID pgtype.UUID) (assigneeType string, assigneeID pgtype.UUID, ok bool) {
	switch step.Handler.Type {
	case HandlerAgent, HandlerSquad, HandlerMember:
		var id pgtype.UUID
		if err := id.Scan(step.Handler.ID); err != nil || !id.Valid {
			return "", pgtype.UUID{}, false
		}
		return step.Handler.Type, id, true
	case HandlerProjectLead:
		if !project.LeadType.Valid || !project.LeadID.Valid {
			return "", pgtype.UUID{}, false
		}
		return project.LeadType.String, project.LeadID, true
	case HandlerCreator:
		if issueCreatorType == "" || !issueCreatorID.Valid {
			return "", pgtype.UUID{}, false
		}
		return issueCreatorType, issueCreatorID, true
	}
	return "", pgtype.UUID{}, false
}

// MoveTarget picks the status an issue keeps when it moves into a project
// using def: its current status when the workflow lists it, otherwise the
// first step of the same lifecycle category, otherwise the start status.
func MoveTarget(def Definition, currentKey string, categoryOf func(string) string) string {
	if def.Has(currentKey) {
		return currentKey
	}
	category := categoryOf(currentKey)
	for _, s := range def.Steps {
		if category != "" && categoryOf(s.StatusKey) == category {
			return s.StatusKey
		}
	}
	return StartStatus
}

// NotInWorkflowError explains a status write the project's workflow rejects.
// Its message lists the allowed keys because agents read it verbatim.
type NotInWorkflowError struct {
	StatusKey    string
	WorkflowName string
	Allowed      []string
}

func (e *NotInWorkflowError) Error() string {
	return fmt.Sprintf("status %q is not part of this project's workflow %q; use one of: %s",
		e.StatusKey, e.WorkflowName, strings.Join(e.Allowed, ", "))
}

// StepMovedError refuses an agent's status change on an issue that has left
// the step the agent's run works on: someone else moved it while the run
// worked, so the run's decision no longer applies, and applying it would undo
// that move.
type StepMovedError struct {
	IssueIdentifier string
	// Step is the status the run works on; Current is where the issue is now.
	Step, StepName       string
	Current, CurrentName string
	// MovedBy names whoever last changed the status; empty when unknown.
	MovedBy string
}

func (e *StepMovedError) Error() string {
	mover := e.MovedBy
	if mover == "" {
		mover = "someone else"
	}
	return fmt.Sprintf("%s is no longer at %s: %s moved it to %s while this run was working, so this status change was not applied. "+
		"Do not change the status again in this run; leave a comment if something still needs attention.",
		e.IssueIdentifier, statusLabel(e.StepName, e.Step), mover, statusLabel(e.CurrentName, e.Current))
}

// statusLabel names a status for an agent: its display name with the key the
// CLI takes, or the bare key when the two are the same.
func statusLabel(name, key string) string {
	if name == "" || name == key {
		return fmt.Sprintf("%q", key)
	}
	return fmt.Sprintf("%q (%s)", name, key)
}

// CheckStatus rejects a status a named workflow does not list. Default
// accepts every status, so issues already on statuses it no longer lists
// keep working.
func CheckStatus(def *Definition, key string) error {
	if def == nil || def.IsDefault || def.Has(key) {
		return nil
	}
	return &NotInWorkflowError{StatusKey: key, WorkflowName: def.Name, Allowed: def.StatusKeys()}
}

// BriefInput carries what the handoff brief names.
type BriefInput struct {
	Workflow        Definition
	ProjectName     string
	StatusKey       string
	IssueIdentifier string
	// StatusName resolves a catalog key to its display name.
	StatusName func(key string) string
	// HandlerName describes who a step hands off to, e.g. "Sentinel" or
	// "Lin (project lead)". Empty means the step does not hand off.
	HandlerName func(step Step) string
}

// Brief renders the handoff note an agent or squad leader receives when an
// issue enters a step that hands off to it. The runtime brief's built-in
// status rules (for example in_review on delivery) name statuses this project
// may not use, so the note spells out the workflow's own statuses and the
// exact commands for the next move.
func Brief(in BriefInput) string {
	step, _ := in.Workflow.Step(in.StatusKey)
	name := func(key string) string {
		if in.StatusName == nil {
			return key
		}
		if n := in.StatusName(key); n != "" {
			return n
		}
		return key
	}
	var b strings.Builder
	title := in.Workflow.Name
	if in.ProjectName != "" {
		title = fmt.Sprintf("%s (%s)", title, in.ProjectName)
	}
	fmt.Fprintf(&b, "This project's workflow — %s\n", title)
	fmt.Fprintf(&b, "You are handling the %q step of %s. You were assigned because the issue entered this status.\n",
		name(in.StatusKey), in.IssueIdentifier)
	if step.Instructions != "" {
		b.WriteString("\nStep instructions:\n")
		for _, line := range strings.Split(step.Instructions, "\n") {
			b.WriteString("> ")
			b.WriteString(line)
			b.WriteString("\n")
		}
	}
	b.WriteString("\nStatuses in this workflow (use only these keys):\n")
	for _, s := range in.Workflow.Steps {
		// Built-in statuses have no stored name; their key reads on its own.
		fmt.Fprintf(&b, "- `%s`", s.StatusKey)
		if n := name(s.StatusKey); n != s.StatusKey {
			fmt.Fprintf(&b, " %s", n)
		}
		if in.HandlerName != nil {
			if who := in.HandlerName(s); who != "" {
				fmt.Fprintf(&b, " — hands off to %s", who)
			}
		}
		if s.StatusKey == in.StatusKey {
			b.WriteString("   ← current")
		}
		b.WriteString("\n")
	}
	b.WriteString("\nHand off by changing the status:\n")
	if next := in.Workflow.NextStatus(in.StatusKey); next != "" {
		fmt.Fprintf(&b, "Step done      → multica issue status %s %s\n", in.IssueIdentifier, next)
	}
	if step.BackStatusKey != "" {
		fmt.Fprintf(&b, "Needs changes  → multica issue status %s %s\n", in.IssueIdentifier, step.BackStatusKey)
	}
	if in.Workflow.Has(issuestatus.Blocked) {
		fmt.Fprintf(&b, "Can't proceed  → multica issue status %s blocked, then comment why\n", in.IssueIdentifier)
	}
	b.WriteString("The system does not advance the status when your run ends. Where your runtime instructions name a status this list does not include, use the commands above instead.\n")
	b.WriteString("Each step's handler gets a run when the issue enters that step, so do not use `multica issue wakeup` to watch this issue's status, assignee or runs; use wakeups only to wait for a time or for something outside this issue.\n")
	return b.String()
}

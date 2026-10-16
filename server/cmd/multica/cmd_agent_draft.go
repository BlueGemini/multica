package main

import (
	"context"
	"fmt"
	"net/url"
	"os"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

// Agent drafts (MUL-8048). An agent that is asked to create an agent writes a
// draft and puts the draft's mention link in its reply; the member it works for
// reviews the card and creates the agent. Members can use these commands too.

var agentDraftCmd = &cobra.Command{
	Use:   "draft",
	Short: "Propose agents as drafts a member reviews and creates",
	Long: "An agent draft is the configuration of an agent that does not exist yet. " +
		"Write one with `draft create`, refine it with `draft set`, and put the returned " +
		"`mention` link in your reply: it renders as a card where the member reviews and " +
		"creates the agent. Only a member can create the agent; drafts never hold secrets.",
}

var agentDraftCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Start an agent draft",
	RunE:  runAgentDraftCreate,
}

var agentDraftSetCmd = &cobra.Command{
	Use:   "set <draft-id>",
	Short: "Update fields of a pending draft (only the flags you pass change)",
	Args:  exactArgs(1),
	RunE:  runAgentDraftSet,
}

var agentDraftGetCmd = &cobra.Command{
	Use:   "get <draft-id>",
	Short: "Get a draft, including edits the member made in the card",
	Args:  exactArgs(1),
	RunE:  runAgentDraftGet,
}

var agentDraftListCmd = &cobra.Command{
	Use:   "list",
	Short: "List your drafts (for an agent: the drafts of the member it works for)",
	RunE:  runAgentDraftList,
}

var agentDraftDiscardCmd = &cobra.Command{
	Use:   "discard <draft-id>",
	Short: "Discard a pending draft",
	Args:  exactArgs(1),
	RunE:  runAgentDraftDiscard,
}

func init() {
	agentCmd.AddCommand(agentDraftCmd)
	agentDraftCmd.AddCommand(agentDraftCreateCmd)
	agentDraftCmd.AddCommand(agentDraftSetCmd)
	agentDraftCmd.AddCommand(agentDraftGetCmd)
	agentDraftCmd.AddCommand(agentDraftListCmd)
	agentDraftCmd.AddCommand(agentDraftDiscardCmd)

	addAgentDraftConfigFlags(agentDraftCreateCmd)
	addAgentDraftConfigFlags(agentDraftSetCmd)
	agentDraftGetCmd.Flags().String("output", "json", "Output format: table or json")
	agentDraftListCmd.Flags().String("status", "pending", "Draft status: pending, created or discarded")
	agentDraftListCmd.Flags().String("output", "table", "Output format: table or json")
	agentDraftDiscardCmd.Flags().String("output", "json", "Output format: table or json")
}

func addAgentDraftConfigFlags(c *cobra.Command) {
	c.Flags().String("name", "", "Agent name")
	c.Flags().String("description", "", "One-sentence description (at most 255 characters)")
	c.Flags().String("instructions", "", "Instructions (Markdown system prompt). Prefer --instructions-file for anything longer than a line.")
	c.Flags().Bool("instructions-stdin", false, "Read the instructions from stdin")
	c.Flags().String("instructions-file", "", "Read the instructions from a UTF-8 file inside the current working directory")
	c.Flags().Bool("allow-external-file", false, "Allow --instructions-file to read a path outside the current working directory")
	c.Flags().String("conversation-starters", "", "Conversation starters as a JSON array of {\"label\",\"prompt\"} objects (at most 3)")
	c.Flags().String("avatar-url", "", "Avatar: an emoji or an uploaded image URL")
	c.Flags().String("runtime-id", "", "Runtime the new agent runs on. Leave unset to let the member pick; it does not have to be your own runtime.")
	c.Flags().String("model", "", "Model id for the chosen runtime. Leave unset for the runtime default.")
	c.Flags().String("thinking-level", "", "Reasoning/effort level for the chosen model")
	c.Flags().String("service-tier", "", "Codex execution speed for the chosen model")
	c.Flags().StringSlice("skill-ids", nil, "Workspace skill ids to attach (comma-separated; replaces the draft's list)")
	c.Flags().String("access", "", "Who can use the agent: private, workspace or members")
	c.Flags().StringSlice("member-ids", nil, "Member user ids for --access members (comma-separated; replaces the draft's list)")
	c.Flags().String("output", "json", "Output format: table or json")
}

// agentDraftConfigFromFlags collects only the flags the caller passed, so
// `draft set` leaves every other field — including the member's edits — alone.
func agentDraftConfigFromFlags(cmd *cobra.Command) (map[string]any, error) {
	config := map[string]any{}
	for flag, field := range map[string]string{
		"name":           "name",
		"description":    "description",
		"avatar-url":     "avatar_url",
		"runtime-id":     "runtime_id",
		"model":          "model",
		"thinking-level": "thinking_level",
		"service-tier":   "service_tier",
		"access":         "permission_scope",
	} {
		if cmd.Flags().Changed(flag) {
			v, _ := cmd.Flags().GetString(flag)
			config[field] = v
		}
	}
	if cmd.Flags().Changed("instructions") || cmd.Flags().Changed("instructions-stdin") || cmd.Flags().Changed("instructions-file") {
		instructions, _, err := resolveTextFlag(cmd, "instructions")
		if err != nil {
			return nil, err
		}
		config["instructions"] = instructions
	}
	if err := applyConversationStartersFlag(cmd, config); err != nil {
		return nil, err
	}
	for flag, field := range map[string]string{"skill-ids": "skill_ids", "member-ids": "member_ids"} {
		if cmd.Flags().Changed(flag) {
			v, _ := cmd.Flags().GetStringSlice(flag)
			if v == nil {
				v = []string{}
			}
			config[field] = v
		}
	}
	return config, nil
}

func printAgentDraft(cmd *cobra.Command, draft map[string]any) error {
	output, _ := cmd.Flags().GetString("output")
	if output == "json" {
		return cli.PrintJSON(os.Stdout, draft)
	}
	config, _ := draft["config"].(map[string]any)
	fmt.Printf("Draft %s (%s): %s\n", strVal(draft, "id"), strVal(draft, "status"), strVal(config, "name"))
	if strVal(draft, "status") == "pending" {
		fmt.Printf("Put this link in your reply so the member can review and create it:\n%s\n", strVal(draft, "mention"))
	}
	return nil
}

func runAgentDraftCreate(cmd *cobra.Command, _ []string) error {
	config, err := agentDraftConfigFromFlags(cmd)
	if err != nil {
		return err
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	var draft map[string]any
	if err := client.PostJSON(ctx, "/api/agent-drafts", map[string]any{"config": config}, &draft); err != nil {
		return fmt.Errorf("create agent draft: %w", err)
	}
	return printAgentDraft(cmd, draft)
}

func runAgentDraftSet(cmd *cobra.Command, args []string) error {
	config, err := agentDraftConfigFromFlags(cmd)
	if err != nil {
		return err
	}
	if len(config) == 0 {
		return fmt.Errorf("pass at least one field flag to change")
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	var draft map[string]any
	if err := client.PatchJSON(ctx, "/api/agent-drafts/"+url.PathEscape(args[0]), map[string]any{"config": config}, &draft); err != nil {
		return fmt.Errorf("update agent draft: %w", err)
	}
	return printAgentDraft(cmd, draft)
}

func runAgentDraftGet(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	var draft map[string]any
	if err := client.GetJSON(ctx, "/api/agent-drafts/"+url.PathEscape(args[0]), &draft); err != nil {
		return fmt.Errorf("get agent draft: %w", err)
	}
	return printAgentDraft(cmd, draft)
}

func runAgentDraftDiscard(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	var draft map[string]any
	if err := client.PostJSON(ctx, "/api/agent-drafts/"+url.PathEscape(args[0])+"/discard", nil, &draft); err != nil {
		return fmt.Errorf("discard agent draft: %w", err)
	}
	return printAgentDraft(cmd, draft)
}

func runAgentDraftList(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	status, _ := cmd.Flags().GetString("status")
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	var result struct {
		Drafts []map[string]any `json:"drafts"`
	}
	if err := client.GetJSON(ctx, "/api/agent-drafts?status="+url.QueryEscape(status), &result); err != nil {
		return fmt.Errorf("list agent drafts: %w", err)
	}
	output, _ := cmd.Flags().GetString("output")
	if output == "json" {
		return cli.PrintJSON(os.Stdout, result.Drafts)
	}
	rows := make([][]string, 0, len(result.Drafts))
	for _, d := range result.Drafts {
		config, _ := d["config"].(map[string]any)
		rows = append(rows, []string{strVal(d, "id"), strVal(config, "name"), strVal(d, "status"), strVal(d, "author_type"), strVal(d, "updated_at")})
	}
	cli.PrintTable(os.Stdout, []string{"ID", "NAME", "STATUS", "AUTHOR", "UPDATED"}, rows)
	return nil
}

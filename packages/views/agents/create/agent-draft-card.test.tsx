// @vitest-environment jsdom

import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { agentDraftKeys, EMPTY_AGENT_DRAFT, toAgentDraftConfig } from "@multica/core/agents";
import { I18nProvider } from "@multica/core/i18n/react";
import type { AgentDraftRecord } from "@multica/core/types";
import enAgents from "../../locales/en/agents.json";

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multica/core/auth", () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ user: { id: "user-1" } }),
}));

vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({
    agentDetail: (id: string) => `/acme/agents/${id}`,
  }),
}));

vi.mock("../../navigation", () => ({
  AppLink: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("./agent-draft-dialog", () => ({ AgentDraftDialog: () => null }));
vi.mock("./agent-draft-actions", () => ({ DiscardAgentDraftDialog: () => null }));

import { AgentDraftCard } from "./agent-draft-card";

function draft(overrides: Partial<AgentDraftRecord> = {}): AgentDraftRecord {
  return {
    id: "draft-1",
    workspace_id: "ws-1",
    owner_id: "user-1",
    author_type: "agent",
    author_id: "agent-mika",
    source_issue_id: null,
    source_chat_session_id: "session-1",
    status: "pending",
    config: toAgentDraftConfig({ ...EMPTY_AGENT_DRAFT, name: "Reviewer" }),
    version: 1,
    created_agent_id: null,
    created_at: "",
    updated_at: "",
    mention: "",
    ...overrides,
  };
}

function renderCard(record: AgentDraftRecord) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(agentDraftKeys.detail("ws-1", record.id), record);
  queryClient.setQueryData(["workspaces", "ws-1", "runtimes"], []);
  return render(
    <I18nProvider locale="en" resources={{ en: { agents: enAgents } }}>
      <QueryClientProvider client={queryClient}>
        <AgentDraftCard draftId={record.id} />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe("AgentDraftCard", () => {
  it("offers the owner review and discard", () => {
    renderCard(draft());
    expect(screen.getByText("Reviewer")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review & create" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discard draft" })).toBeInTheDocument();
  });

  // Only the owner can create. Everyone else sees what is proposed and whose
  // confirmation it waits on, with nothing to click.
  it("shows anyone else only whose confirmation it waits on", () => {
    renderCard(draft({ owner_id: "user-2" }));
    expect(screen.queryByRole("button", { name: "Review & create" })).toBeNull();
    expect(screen.getByText(/Waiting for .* to confirm/)).toBeInTheDocument();
  });

  it("links a created draft to its agent", () => {
    renderCard(draft({ status: "created", created_agent_id: "agent-9" }));
    expect(screen.queryByRole("button", { name: "Review & create" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open agent" })).toHaveAttribute(
      "href",
      "/acme/agents/agent-9",
    );
  });
});

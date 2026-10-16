// @vitest-environment jsdom

import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentDraftKeys, EMPTY_AGENT_DRAFT, toAgentDraftConfig } from "@multica/core/agents";
import { I18nProvider } from "@multica/core/i18n/react";
import type { AgentDraftRecord } from "@multica/core/types";
import {
  agentListOptions,
  memberListOptions,
  skillListOptions,
} from "@multica/core/workspace/queries";
import enAgents from "../../locales/en/agents.json";
import enCommon from "../../locales/en/common.json";

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

const openModal = vi.fn();
vi.mock("@multica/core/modals", () => ({
  useModalStore: { getState: () => ({ open: openModal }) },
}));

vi.mock("../../navigation", () => ({
  AppLink: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

const direct = { ready: true, creating: false, error: null as string | null, create: vi.fn() };
vi.mock("./use-direct-create-draft", () => ({ useDirectCreateDraft: () => direct }));
vi.mock("./use-agent-draft-editor", () => ({
  useAgentDraftEditor: () => ({
    form: { draft: EMPTY_AGENT_DRAFT },
    sync: { loading: false, saveState: "idle" },
    submit: { formError: null, nameError: null, creating: false },
    editable: true,
    canCreate: true,
    create: vi.fn(),
  }),
}));
vi.mock("./agent-configuration-panel", () => ({
  AgentConfigurationPanel: () => <div data-testid="inline-editor" />,
}));
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
    config: toAgentDraftConfig({
      ...EMPTY_AGENT_DRAFT,
      name: "Reviewer",
      instructions: "Review PRs.",
    }),
    version: 1,
    revision: 1,
    revisions: [],
    follow_ups: [],
    discard_reason: "",
    created_agent_id: null,
    created_at: "",
    updated_at: "",
    mention: "",
    ...overrides,
  };
}

function renderCard(record: AgentDraftRecord, revision: number | null = null) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(agentDraftKeys.detail("ws-1", record.id), record);
  queryClient.setQueryData(["workspaces", "ws-1", "runtimes"], []);
  queryClient.setQueryData(agentListOptions("ws-1").queryKey, [
    { id: "agent-mika", name: "Mika" },
  ] as never);
  queryClient.setQueryData(memberListOptions("ws-1").queryKey, [
    { user_id: "user-2", name: "Lin" },
  ] as never);
  queryClient.setQueryData(skillListOptions("ws-1").queryKey, []);
  return render(
    <I18nProvider locale="en" resources={{ en: { agents: enAgents, common: enCommon } }}>
      <QueryClientProvider client={queryClient}>
        <AgentDraftCard draftId={record.id} revision={revision} />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  direct.ready = true;
  direct.create.mockReset();
  openModal.mockReset();
});

describe("AgentDraftCard", () => {
  it("lets the owner create the draft as it stands", () => {
    renderCard(draft());
    expect(screen.getByText("Reviewer")).toBeInTheDocument();
    expect(screen.getByText("Needs your confirmation")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create agent" }));
    expect(direct.create).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("inline-editor")).toBeNull();
  });

  it("opens the editor in the card when the draft cannot be created yet", () => {
    direct.ready = false;
    renderCard(draft());
    fireEvent.click(screen.getByRole("button", { name: "Create agent" }));
    expect(direct.create).not.toHaveBeenCalled();
    expect(screen.getByTestId("inline-editor")).toBeInTheDocument();
  });

  // Only the owner can create. Everyone else sees what is proposed and whose
  // confirmation it waits on, with nothing to click.
  it("shows anyone else only whose confirmation it waits on", () => {
    renderCard(draft({ owner_id: "user-2" }));
    expect(screen.queryByRole("button", { name: "Create agent" })).toBeNull();
    expect(screen.getByText("Waiting for Lin to confirm")).toBeInTheDocument();
  });

  it("lists what the owner still has to do after creating", () => {
    renderCard(
      draft({
        follow_ups: [{ kind: "env", label: "SENTRY_TOKEN", hint: "Only you can fill it in" }],
      }),
    );
    expect(screen.getByText("Still needed after creating")).toBeInTheDocument();
    expect(screen.getByText("SENTRY_TOKEN")).toBeInTheDocument();
  });

  it("collapses a link to an older revision to one line", () => {
    renderCard(draft({ revision: 2 }), 1);
    expect(screen.getByText(/Superseded by revision 2/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create agent" })).toBeNull();
  });

  it("links a created draft to its agent and its first issue", () => {
    renderCard(draft({ status: "created", created_agent_id: "agent-9" }));
    expect(screen.getByRole("link", { name: "Open agent" })).toHaveAttribute(
      "href",
      "/acme/agents/agent-9",
    );
    fireEvent.click(screen.getByRole("button", { name: "Assign first issue" }));
    expect(openModal).toHaveBeenCalledWith("quick-create-issue", { agent_id: "agent-9" });
  });

  it("shows why a draft was rejected", () => {
    renderCard(draft({ status: "discarded", discard_reason: "Too broad" }));
    expect(screen.getByText("Rejected")).toBeInTheDocument();
    expect(screen.getByText("Reason: Too broad")).toBeInTheDocument();
  });
});

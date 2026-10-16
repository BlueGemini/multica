// @vitest-environment jsdom

import { useState, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentDraftKeys,
  EMPTY_AGENT_DRAFT,
  toAgentDraftConfig,
  type AgentDraft,
} from "@multica/core/agents";
import type { AgentDraftRecord } from "@multica/core/types";

const mockApi = vi.hoisted(() => ({
  createAgentDraft: vi.fn(),
  updateAgentDraft: vi.fn(),
  getAgentDraft: vi.fn(),
}));

vi.mock("@multica/core/api", () => {
  class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return { api: mockApi, ApiError };
});

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

import { useAgentDraftSync } from "./use-agent-draft-sync";

function record(id: string, draft: AgentDraft, version = 1): AgentDraftRecord {
  return {
    id,
    workspace_id: "ws-1",
    owner_id: "user-1",
    author_type: "member",
    author_id: "user-1",
    source_issue_id: null,
    source_chat_session_id: null,
    status: "pending",
    config: toAgentDraftConfig(draft),
    version,
    revision: 0,
    revisions: [],
    follow_ups: [],
    discard_reason: "",
    created_agent_id: null,
    created_at: "",
    updated_at: "",
    mention: "",
  };
}

function setup(draftId: string | null, queryClient: QueryClient) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(
    () => {
      const [draft, setDraft] = useState<AgentDraft>({
        ...EMPTY_AGENT_DRAFT,
        runtimeId: "runtime-1",
      });
      const sync = useAgentDraftSync({ draftId, draft, setDraft, ready: true });
      return { draft, setDraft, sync };
    },
    { wrapper },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useAgentDraftSync", () => {
  it("does not create a draft for a form nobody has typed into", async () => {
    const queryClient = new QueryClient();
    const { result } = setup(null, queryClient);
    await act(async () => {
      await result.current.sync.flush();
    });
    expect(mockApi.createAgentDraft).not.toHaveBeenCalled();
  });

  it("creates on the first real edit, then saves only what changed", async () => {
    const queryClient = new QueryClient();
    mockApi.createAgentDraft.mockImplementation(async (config) =>
      record("draft-1", {
        ...EMPTY_AGENT_DRAFT,
        name: config.name,
        runtimeId: config.runtime_id,
      }),
    );
    mockApi.updateAgentDraft.mockImplementation(async (_id, changed) =>
      record(
        "draft-1",
        { ...EMPTY_AGENT_DRAFT, name: "Reviewer", runtimeId: "runtime-1", ...changed },
        2,
      ),
    );
    const { result } = setup(null, queryClient);

    act(() => result.current.setDraft((d) => ({ ...d, name: "Reviewer" })));
    await act(async () => {
      await result.current.sync.flush();
    });
    expect(mockApi.createAgentDraft).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Reviewer", runtime_id: "runtime-1" }),
    );
    expect(result.current.sync.draftId).toBe("draft-1");

    act(() =>
      result.current.setDraft((d) => ({ ...d, description: "Reviews PRs" })),
    );
    await act(async () => {
      await result.current.sync.flush();
    });
    expect(mockApi.updateAgentDraft).toHaveBeenCalledWith("draft-1", {
      description: "Reviews PRs",
    });
  });

  it("hydrates a saved draft and folds in another author's edits", async () => {
    const queryClient = new QueryClient();
    const saved = { ...EMPTY_AGENT_DRAFT, name: "Reviewer", runtimeId: "runtime-1" };
    mockApi.getAgentDraft.mockResolvedValue(record("draft-1", saved));
    const { result } = setup("draft-1", queryClient);

    await waitFor(() => expect(result.current.sync.hydrated).toBe(true));
    expect(result.current.draft.name).toBe("Reviewer");

    act(() => result.current.setDraft((d) => ({ ...d, name: "My name" })));
    act(() => {
      queryClient.setQueryData(
        agentDraftKeys.detail("ws-1", "draft-1"),
        record("draft-1", { ...saved, instructions: "Written by an agent" }, 2),
      );
    });

    await waitFor(() =>
      expect(result.current.draft.instructions).toBe("Written by an agent"),
    );
    expect(result.current.draft.name).toBe("My name");
  });
});

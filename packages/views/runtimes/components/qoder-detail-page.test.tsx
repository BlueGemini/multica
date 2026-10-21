import { vi, it, expect, beforeEach, afterEach, describe } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import type { AgentRuntime } from "@multica/core/types";
import enRuntimes from "../../locales/en/runtimes.json";
import { isQoderLocator, QoderDetailPage } from "./qoder-detail-page";

const { ApiError, mocks, nav } = vi.hoisted(() => {
  class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(message: string, status: number, body: unknown) {
      super(message);
      this.status = status;
      this.body = body;
    }
  }
  return {
    ApiError,
    mocks: {
      getQoderConnection: vi.fn(),
      listMembers: vi.fn(),
      listRuntimes: vi.fn(),
      listAgents: vi.fn(),
      stopQoderConnection: vi.fn(),
      saveQoderConnection: vi.fn(),
      disconnectQoderConnection: vi.fn(),
    },
    nav: { push: vi.fn(), replace: vi.fn() },
  };
});
vi.mock("@multica/core/api", () => ({ api: mocks, ApiError }));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-test" }));
vi.mock("@multica/core/auth", () => {
  const state = { user: { id: "owner" } };
  return {
    useAuthStore: Object.assign(
      (selector: (s: typeof state) => unknown) => selector(state),
      { getState: () => state },
    ),
  };
});
vi.mock("@multica/core/agents", () => ({
  useWorkspacePresenceMap: () => ({ byAgent: new Map() }),
}));
vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({
    runtimes: () => "/acme/runtimes",
    newAgentManual: () => "/acme/agents/new/manual",
    agentDetail: (id: string) => `/acme/agents/${id}`,
  }),
}));
vi.mock("../../navigation", () => ({
  useNavigation: () => nav,
  AppLink: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("./qoder-configuration", () => ({
  QoderConfiguration: () => <div>configuration form</div>,
}));
vi.mock("./usage-section", () => ({ UsageSection: () => null }));
vi.mock("./runtime-detail", () => ({
  ServingAgentsCard: ({ agents }: { agents: { id: string; name: string }[] }) => (
    <ul aria-label="serving agents">
      {agents.map((agent) => (
        <li key={agent.id}>{agent.name}</li>
      ))}
    </ul>
  ),
}));

const connection = {
  available: true,
  configured: true,
  name: "QCA",
  baseUrl: "https://api.qoder.com/api/v1/cloud",
  environmentId: "env_one",
  hasToken: true,
  repositories: ["https://github.com/acme/web"],
  enabled: true,
  status: "online",
  lastError: "",
  maxConcurrency: 3,
  runTimeoutMinutes: 60,
  activeRuns: 1,
  queuedRuns: 0,
};

beforeEach(() => {
  mocks.getQoderConnection.mockResolvedValue(connection);
  mocks.listMembers.mockResolvedValue([{ user_id: "owner", role: "owner" }]);
  mocks.listRuntimes.mockResolvedValue([
    { id: "rt_qoder", provider: "qoder_cloud", status: "online", visibility: "public" },
  ]);
  mocks.listAgents.mockResolvedValue([
    { id: "a1", name: "Reviewer", runtime_id: "rt_qoder", archived_at: null },
    { id: "a2", name: "Local helper", runtime_id: "rt_local", archived_at: null },
  ]);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <I18nProvider locale="en" resources={{ en: { runtimes: enRuntimes } }}>
      <QueryClientProvider client={client}>
        <QoderDetailPage />
      </QueryClientProvider>
    </I18nProvider>,
  );
  return client;
}

describe("isQoderLocator", () => {
  const runtimes = [
    { id: "rt_qoder", provider: "qoder_cloud" },
    { id: "rt_local", provider: "claude" },
  ] as AgentRuntime[];
  it("accepts the page locator, the managed machine id and a Qoder runtime id", () => {
    expect(isQoderLocator("qoder", runtimes)).toBe(true);
    expect(isQoderLocator("cloud:qoder-managed-ws-test", runtimes)).toBe(true);
    expect(isQoderLocator("rt_qoder", runtimes)).toBe(true);
    expect(isQoderLocator("rt_local", runtimes)).toBe(false);
    expect(isQoderLocator("local:daemon-1", runtimes)).toBe(false);
  });
});

it("shows the connection with its agents and no machine-level controls", async () => {
  const client = mount();
  expect(
    await screen.findByRole("heading", { name: "Qoder Cloud Agent" }),
  ).toBeInTheDocument();
  expect(await screen.findByText("configuration form")).toBeInTheDocument();
  const serving = await screen.findByRole("list", { name: "serving agents" });
  expect(within(serving).getByText("Reviewer")).toBeInTheDocument();
  expect(within(serving).queryByText("Local helper")).not.toBeInTheDocument();
  expect(screen.getByText("1 of 3 running · 0 queued")).toBeInTheDocument();
  expect(screen.queryByText("Visibility")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Delete runtime" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Create an agent with it" }));
  expect(nav.push).toHaveBeenCalledWith(
    "/acme/agents/new/manual?runtime=rt_qoder",
  );
  client.clear();
});

it("asks before pausing and names the agents it strands", async () => {
  mocks.stopQoderConnection.mockResolvedValue({ ...connection, enabled: false });
  const client = mount();
  fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText("Pause Qoder Cloud Agent?")).toBeInTheDocument();
  expect(within(dialog).getByText("Reviewer")).toBeInTheDocument();
  expect(mocks.stopQoderConnection).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Pause" }));
  await waitFor(() => expect(mocks.stopQoderConnection).toHaveBeenCalledWith("ws-test"));
  client.clear();
});

it("resumes with the saved token and repository bindings", async () => {
  mocks.getQoderConnection.mockResolvedValue({
    ...connection,
    enabled: false,
    status: "offline",
  });
  mocks.saveQoderConnection.mockResolvedValue(connection);
  const client = mount();
  fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
  await waitFor(() => expect(mocks.saveQoderConnection).toHaveBeenCalledTimes(1));
  const input = mocks.saveQoderConnection.mock.calls[0]![1];
  expect(input).toMatchObject({
    environmentId: "env_one",
    qoderToken: "",
    maxConcurrency: 3,
    runTimeoutMinutes: 60,
  });
  expect(input).not.toHaveProperty("githubTokens");
  client.clear();
});

it("disconnects after confirming the latest agents to unbind", async () => {
  mocks.disconnectQoderConnection
    .mockRejectedValueOnce(
      new ApiError("plan changed", 409, {
        code: "runtime_delete_plan_changed",
        active_agents: [
          { id: "a1", name: "Reviewer" },
          { id: "a3", name: "Triage" },
        ],
      }),
    )
    .mockResolvedValueOnce({ ...connection, configured: false });
  const client = mount();
  fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText("Reviewer")).toBeInTheDocument();

  fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
  expect(
    await within(dialog).findByText(
      "The agents on Qoder changed. Review the list and confirm again.",
    ),
  ).toBeInTheDocument();
  expect(within(dialog).getByText("Triage")).toBeInTheDocument();
  expect(mocks.disconnectQoderConnection).toHaveBeenLastCalledWith("ws-test", ["a1"]);
  expect(nav.replace).not.toHaveBeenCalled();

  fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
  await waitFor(() =>
    expect(mocks.disconnectQoderConnection).toHaveBeenLastCalledWith("ws-test", [
      "a1",
      "a3",
    ]),
  );
  await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/acme/runtimes"));
  client.clear();
});

it("keeps lifecycle actions away from members", async () => {
  mocks.listMembers.mockResolvedValue([{ user_id: "owner", role: "member" }]);
  const client = mount();
  expect(await screen.findByText("configuration form")).toBeInTheDocument();
  await waitFor(() => expect(mocks.listMembers).toHaveBeenCalled());
  expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
  client.clear();
});

import { vi, it, expect, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import enRuntimes from "../../locales/en/runtimes.json";
import { QoderConfiguration } from "./qoder-configuration";

const mocks = vi.hoisted(() => ({
  getQoderConnection: vi.fn(),
  listMembers: vi.fn(),
  listQoderEnvironments: vi.fn(),
  checkQoderConnection: vi.fn(),
  saveQoderConnection: vi.fn(),
}));
vi.mock("@multica/core/api", () => ({ api: mocks }));
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
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  mocks.getQoderConnection.mockResolvedValue({
    available: true,
    configured: true,
    name: "QCA",
    baseUrl: "https://api.qoder.com/api/v1/cloud",
    environmentId: "",
    hasToken: true,
    repositories: [],
    enabled: true,
    status: "online",
    lastError: "",
    maxConcurrency: 3,
    runTimeoutMinutes: 60,
    activeRuns: 0,
    queuedRuns: 0,
  });
  mocks.listMembers.mockResolvedValue([{ user_id: "owner", role: "owner" }]);
  mocks.checkQoderConnection.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function mount(onConnected?: () => void) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <I18nProvider locale="en" resources={{ en: { runtimes: enRuntimes } }}>
      <QueryClientProvider client={client}>
        <QoderConfiguration onConnected={onConnected} />
      </QueryClientProvider>
    </I18nProvider>,
  );
  return client;
}
it("selects the only environment, hides saved PATs and reports connection success", async () => {
  mocks.listQoderEnvironments.mockResolvedValue([
    { id: "env_one", name: "Web environment" },
  ]);
  const client = mount();
  const check = await screen.findByRole("button", { name: "Test connection" });
  await waitFor(() => expect(check).toBeEnabled());
  expect(
    screen.getByRole("combobox", { name: "Environment" }),
  ).toHaveTextContent("Web environment");
  expect(screen.queryByText("QCA Agent ID")).not.toBeInTheDocument();
  expect(screen.getByPlaceholderText("Saved, never displayed")).toBeDisabled();
  expect(screen.getByText("What Multica sends to Qoder")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText(/Concurrent runs/), {
    target: { value: "5" },
  });
  fireEvent.click(check);
  await screen.findByText("Connection successful");
  expect(mocks.checkQoderConnection).toHaveBeenCalledWith(
    "ws-test",
    expect.objectContaining({
      environmentId: "env_one",
      qoderToken: "",
      maxConcurrency: 5,
      runTimeoutMinutes: 60,
    }),
  );
  client.clear();
});
it("loads environments from the saved region", async () => {
  mocks.getQoderConnection.mockResolvedValue({
    ...(await mocks.getQoderConnection()),
    baseUrl: "https://api.qoder.com.cn/api/v1/cloud",
  });
  mocks.listQoderEnvironments.mockResolvedValue([
    { id: "env_cn", name: "CN environment" },
  ]);
  const client = mount();
  expect(
    await screen.findByRole("combobox", { name: "Region" }),
  ).toHaveTextContent("China (qoder.com.cn)");
  await waitFor(() =>
    expect(mocks.listQoderEnvironments).toHaveBeenCalledWith(
      "ws-test",
      "",
      "https://api.qoder.com.cn/api/v1/cloud",
      expect.anything(),
    ),
  );
  client.clear();
});
it("requires an explicit choice when several environments are available", async () => {
  mocks.listQoderEnvironments.mockResolvedValue([
    { id: "env_one", name: "Web" },
    { id: "env_two", name: "Build" },
  ]);
  const client = mount();
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Environment" })).toBeEnabled(),
  );
  expect(
    screen.getByRole("combobox", { name: "Environment" }),
  ).toHaveTextContent("Select an environment");
  expect(
    screen.getByRole("button", { name: "Test connection" }),
  ).toBeDisabled();
  client.clear();
});
it("connects a first-time workspace with the short form", async () => {
  mocks.getQoderConnection.mockResolvedValue({
    ...(await mocks.getQoderConnection()),
    configured: false,
    hasToken: false,
    enabled: false,
    status: "offline",
  });
  mocks.listQoderEnvironments.mockResolvedValue([]);
  const client = mount();
  expect(await screen.findByRole("button", { name: "Connect" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Test connection" })).not.toBeInTheDocument();
  client.clear();
});
it("reports a first-time connection so the caller can close", async () => {
  mocks.getQoderConnection.mockResolvedValue({
    ...(await mocks.getQoderConnection()),
    configured: false,
    hasToken: false,
    enabled: false,
    status: "offline",
  });
  mocks.listQoderEnvironments.mockResolvedValue([
    { id: "env_one", name: "Web environment" },
  ]);
  mocks.saveQoderConnection.mockResolvedValue(undefined);
  const onConnected = vi.fn();
  const client = mount(onConnected);
  fireEvent.change(await screen.findByPlaceholderText("pt-…"), {
    target: { value: "pt-test" },
  });
  const connect = screen.getByRole("button", { name: "Connect" });
  await waitFor(() => expect(connect).toBeEnabled(), { timeout: 3000 });
  fireEvent.click(connect);
  await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
  expect(mocks.saveQoderConnection).toHaveBeenCalledWith(
    "ws-test",
    expect.objectContaining({ environmentId: "env_one", qoderToken: "pt-test" }),
  );
  client.clear();
});

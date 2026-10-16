/**
 * An agent draft link becomes a card only when it stands alone in its
 * paragraph — the shape agents are told to post. A card is a block; inside a
 * sentence it would break the paragraph, so there the link stays inline.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { NavigationProvider } from "../navigation/context";
import type { NavigationAdapter } from "../navigation/types";

vi.mock("../issues/hooks", () => ({
  useResolveIssueIdentifier: () => null,
}));

vi.mock("../i18n", async () => {
  const editor = (await import("../locales/en/editor.json")).default;
  return {
    useT: () => ({
      t: (select: (bundle: typeof editor) => string) => select(editor),
    }),
    useTimeAgo: () => "just now",
  };
});

vi.mock("@multica/core/api", () => ({
  api: { getAttachmentTextContent: vi.fn() },
  PreviewTooLargeError: class extends Error {},
  PreviewUnsupportedError: class extends Error {},
}));

vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({
    issueDetail: (id: string) => `/acme/issues/${id}`,
    projectDetail: (id: string) => `/acme/projects/${id}`,
  }),
  useWorkspaceSlug: () => "acme",
}));

vi.mock("../editor/link-hover-card", () => ({
  useLinkHover: () => ({}),
  LinkHoverCard: () => null,
}));

vi.mock("../agents/create/agent-draft-card", () => ({
  AgentDraftCard: ({ draftId, revision }: { draftId: string; revision: number | null }) => (
    <div data-testid="agent-draft-card">
      {draftId}
      {revision !== null ? `@${revision}` : ""}
    </div>
  ),
}));

import { RichContent } from "./rich-content";

const adapter: NavigationAdapter = {
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  pathname: "/",
  searchParams: new URLSearchParams(),
  hash: "",
  getShareableUrl: (p) => p,
};

function renderContent(content: string) {
  return render(
    <NavigationProvider value={adapter}>
      <RichContent content={content} />
    </NavigationProvider>,
  );
}

describe("agent draft embed", () => {
  it("renders a paragraph holding only the draft link as a card", async () => {
    const { container } = renderContent(
      "Here is the draft:\n\n[Reviewer](mention://agent-draft/draft-1)",
    );
    expect(await screen.findByTestId("agent-draft-card")).toHaveTextContent(
      "draft-1",
    );
    expect(container.querySelector("p [data-testid=agent-draft-card]")).toBeNull();
  });

  it("passes the revision a link was posted for to the card", async () => {
    renderContent("[Reviewer](mention://agent-draft/draft-1?rev=2)");
    expect(await screen.findByTestId("agent-draft-card")).toHaveTextContent(
      "draft-1@2",
    );
  });

  it("keeps a draft link inside a sentence inline", () => {
    renderContent("I updated [Reviewer](mention://agent-draft/draft-1) for you.");
    expect(screen.queryByTestId("agent-draft-card")).toBeNull();
    expect(screen.getByText("Reviewer")).toHaveClass("mention");
  });
});

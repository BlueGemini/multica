// @vitest-environment node

import { describe, expect, it } from "vitest";
import { AgentDraftConfigSchema } from "../api/schemas";
import type { AgentDraft } from "./draft";
import {
  diffAgentDraftConfig,
  fromAgentDraftConfig,
  mergeRemoteAgentDraft,
  toAgentDraftConfig,
} from "./stored-draft";

const draft = (): AgentDraft => ({
  name: "Release manager",
  description: "Ships carefully",
  instructions: "# Role\nShip.",
  conversationStarters: [
    { label: "Plan a release", prompt: "Plan the next release." },
  ],
  avatarUrl: "🚀",
  runtimeId: "runtime-1",
  model: "gpt-5.6-sol",
  thinkingLevel: "high",
  serviceTier: "priority",
  skillIds: new Set(["skill-1", "skill-2"]),
  permissionScope: "members",
  memberIds: new Set(["member-1"]),
  teamIds: new Set(["team-1"]),
});

describe("agent draft config", () => {
  it("round-trips every editable field", () => {
    const original = draft();
    expect(fromAgentDraftConfig(toAgentDraftConfig(original))).toEqual(original);
  });

  it("survives the wire schema unchanged", () => {
    const config = toAgentDraftConfig(draft());
    expect(AgentDraftConfigSchema.parse(config)).toEqual(config);
  });

  // A PATCH carries only what changed, so a member and an agent editing
  // different fields of the same draft do not overwrite each other.
  it("diffs to the changed fields only", () => {
    const base = toAgentDraftConfig(draft());
    const next = toAgentDraftConfig({
      ...draft(),
      name: "Other",
      skillIds: new Set(["skill-1"]),
    });
    expect(diffAgentDraftConfig(base, next)).toEqual({
      name: "Other",
      skill_ids: ["skill-1"],
    });
  });

  it("treats rebuilt sets with the same members as unchanged", () => {
    expect(
      diffAgentDraftConfig(
        toAgentDraftConfig(draft()),
        toAgentDraftConfig(draft()),
      ),
    ).toEqual({});
  });

  // An agent filling in instructions while the member renames the draft: both
  // edits must survive.
  it("takes remote edits only for fields the user has not touched", () => {
    const base = toAgentDraftConfig(draft());
    const local = { ...draft(), name: "Renamed locally" };
    const server = {
      ...base,
      name: "Renamed remotely",
      instructions: "# Role\nShip, then announce.",
    };
    const merged = mergeRemoteAgentDraft(local, base, server);
    expect(merged.name).toBe("Renamed locally");
    expect(merged.instructions).toBe("# Role\nShip, then announce.");
    expect(merged.skillIds).toEqual(new Set(["skill-1", "skill-2"]));
  });
});

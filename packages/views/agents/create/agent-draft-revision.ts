import type { AgentDraftRecord } from "@multica/core/types";

/**
 * What the agent's latest revision changed, for marking rows and diffing the
 * instructions. Nothing for the first revision (there is nothing to compare
 * with) or when the history does not reach the current revision.
 */
export function latestRevisionChanges(record: AgentDraftRecord | null): {
  changedFields: ReadonlySet<string> | undefined;
  previousInstructions: string | null;
} {
  const last = record?.revisions.at(-1);
  if (!record || !last || last.revision !== record.revision || last.revision <= 1) {
    return { changedFields: undefined, previousInstructions: null };
  }
  const previous = last.previous;
  return {
    changedFields: new Set(Object.keys(previous)),
    previousInstructions:
      "instructions" in previous
        ? typeof previous.instructions === "string"
          ? previous.instructions
          : ""
        : null,
  };
}

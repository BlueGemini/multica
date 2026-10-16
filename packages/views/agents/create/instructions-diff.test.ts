import { describe, expect, it } from "vitest";
import { diffLines, withContext } from "./instructions-diff";

describe("diffLines", () => {
  it("marks a replaced line as removed then added", () => {
    expect(diffLines("## Scope\nComment only\nNever merge", "## Scope\nRequest changes\nNever merge")).toEqual([
      { kind: "same", text: "## Scope" },
      { kind: "del", text: "Comment only" },
      { kind: "add", text: "Request changes" },
      { kind: "same", text: "Never merge" },
    ]);
  });

  it("reads text that was empty as all added", () => {
    expect(diffLines("", "one")).toEqual([
      { kind: "del", text: "" },
      { kind: "add", text: "one" },
    ]);
  });
});

describe("withContext", () => {
  it("keeps one unchanged line around each change and folds the rest", () => {
    const lines = diffLines("a\nb\nc\nd\ne", "a\nb\nc\nd\nE");
    expect(withContext(lines)).toEqual([
      null,
      { kind: "same", text: "d" },
      { kind: "del", text: "e" },
      { kind: "add", text: "E" },
    ]);
  });
});

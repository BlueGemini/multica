"use client";

import { cn } from "@multica/ui/lib/utils";

export type DiffLine = { kind: "same" | "add" | "del"; text: string };

// Beyond this many lines on either side the table would be too large to build
// on every render; the whole text then reads as replaced.
const MAX_DIFF_LINES = 600;

/** Line diff by longest common subsequence. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return [
      ...a.map((text) => ({ kind: "del" as const, text })),
      ...b.map((text) => ({ kind: "add" as const, text })),
    ];
  }
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: "del", text: a[i]! });
      i++;
    } else {
      out.push({ kind: "add", text: b[j]! });
      j++;
    }
  }
  while (i < a.length) out.push({ kind: "del", text: a[i++]! });
  while (j < b.length) out.push({ kind: "add", text: b[j++]! });
  return out;
}

/** Keeps changed lines and `context` unchanged lines around each; a run of
 *  dropped lines becomes one `null` gap. */
export function withContext(lines: DiffLine[], context = 1): (DiffLine | null)[] {
  const keep = lines.map(() => false);
  lines.forEach((line, index) => {
    if (line.kind === "same") return;
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) {
      keep[k] = true;
    }
  });
  const out: (DiffLine | null)[] = [];
  lines.forEach((line, index) => {
    if (keep[index]) out.push(line);
    else if (out[out.length - 1] !== null) out.push(null);
  });
  return out;
}

export function InstructionsDiff({
  before,
  after,
  className,
}: {
  before: string;
  after: string;
  className?: string;
}) {
  const lines = withContext(diffLines(before, after));
  return (
    <div
      className={cn(
        "overflow-x-auto rounded-md border bg-background py-1.5 font-mono text-label leading-6",
        className,
      )}
    >
      {lines.map((line, index) =>
        line === null ? (
          <div key={index} className="px-3 text-muted-foreground">
            …
          </div>
        ) : (
          <div
            key={index}
            className={cn(
              "whitespace-pre-wrap break-words px-3",
              line.kind === "add" && "bg-success/10 text-success",
              line.kind === "del" && "bg-destructive/10 text-destructive line-through",
            )}
          >
            {line.kind === "add" ? "+ " : line.kind === "del" ? "− " : "  "}
            {line.text || " "}
          </div>
        ),
      )}
    </div>
  );
}

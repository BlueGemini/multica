import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";

import { colorTokenViolations } from "./check-ui-color-tokens.mjs";

const viewsProbe = resolve("packages/views/zz-color-probe.tsx");
const uiProbe = resolve("packages/ui/zz-color-probe.tsx");

const tokens = (source, file = viewsProbe) =>
  colorTokenViolations(source, file).map(({ rule, token }) => `${rule} ${token}`);

test("rejects raw palette classes in views, including variants, alphas, and templates", () => {
  const source = `
    const pill = "bg-amber-500/10 text-amber-700 dark:text-amber-400";
    const icon = \`hover:text-emerald-500 \${on ? "border-l-red-200" : ""}\`;
  `;
  assert.deepEqual(tokens(source), [
    "raw-palette bg-amber-500/10",
    "raw-palette text-amber-700",
    "raw-palette dark:text-amber-400",
    "raw-palette hover:text-emerald-500",
    "raw-palette border-l-red-200",
  ]);
});

test("rejects hex colors in views but not issue numbers or token fallbacks", () => {
  assert.deepEqual(tokens(`const c = "#22c55e";`), ["hex-color #22c55e"]);
  assert.deepEqual(tokens(`const c = "bg-[#1f2937]";`), ["hex-color #1f2937"]);
  assert.deepEqual(tokens(`const s = "0 0 0 1px #fff";`), ["hex-color #fff"]);
  assert.deepEqual(tokens(`const t = "Fixed in MUL#123 and #abc-def";`), []);
  assert.deepEqual(tokens(`const s = <path stroke="var(--background, #fff)" />;`), []);
});

test("scopes palette and hex to views, but bans muted alphas and Tailwind shadows everywhere", () => {
  const source = `const c = "text-red-500 bg-muted/40 hover:bg-muted/[0.5] shadow-sm data-active:shadow-lg";`;
  assert.deepEqual(tokens(source, uiProbe), [
    "muted-fill bg-muted/40",
    "muted-fill hover:bg-muted/[0.5]",
    "tailwind-shadow shadow-sm",
    "tailwind-shadow data-active:shadow-lg",
  ]);
});

test("accepts role tokens, comments, and test files", () => {
  assert.deepEqual(
    tokens(`
      // bg-amber-500 used to live here
      const c = "bg-warning-subtle text-warning-subtle-foreground bg-fill-hover shadow-menu bg-muted text-white";
    `),
    [],
  );
  assert.deepEqual(
    tokens(`expect(el).toHaveClass("bg-amber-500/10");`, resolve("packages/views/zz.test.tsx")),
    [],
  );
});

test("honors the exact-file allowlist per rule", () => {
  const prList = resolve("packages/views/issues/components/pull-request-list.tsx");
  assert.deepEqual(tokens(`const merged = "text-violet-600";`, prList), []);
  assert.deepEqual(tokens(`const c = "bg-muted/40";`, prList), ["muted-fill bg-muted/40"]);
});

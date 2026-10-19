#!/usr/bin/env node
/**
 * Keeps product color, fill and elevation on the shared token roles.
 *
 * Status color, translucent fills and shadows each drifted the same way the
 * type scale once did: with no role token to reach for, every page picked its
 * own raw value (186 raw palette classes, 11 bg-muted alphas, 51 Tailwind
 * shadows). The roles now exist in packages/ui/styles/tokens.css, so this
 * guard rejects the raw spellings:
 *
 * - raw Tailwind palette classes and hex colors in packages/views — use a
 *   role (`text-success`, `bg-warning-subtle`, `text-info-subtle-foreground`);
 * - `bg-muted/<n>` anywhere in product UI — use `bg-fill-subtle`,
 *   `bg-fill-hover` or `bg-fill-selected`;
 * - Tailwind's `shadow-xs` .. `shadow-2xl` in product UI — use
 *   `shadow-surface`, `shadow-menu` or `shadow-floating`.
 *
 * Colors that are data rather than design — third-party brand marks, user
 * label colors, media backdrops — are allowlisted by exact file so an
 * exception cannot spread silently.
 *
 * Run: node scripts/check-ui-color-tokens.mjs
 */

import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = resolve(import.meta.dirname, "..");
const roots = ["apps/web", "apps/desktop", "packages/ui", "packages/views"];
const paletteRoots = ["packages/views/"];
const extensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);
const skippedDirectories = new Set(["node_modules", ".next", ".turbo", "dist", "build", "out"]);
// Marketing pages run on their own art direction and are out of scope.
const skippedPaths = ["apps/web/features/landing/"];

const paletteHues =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const colorUtilities =
  "bg|text|border(?:-[trblxyse])?|ring|ring-offset|outline|fill|stroke|from|via|to|decoration|divide|placeholder|caret|accent|shadow|inset-shadow|inset-ring";
const rawPalette = new RegExp(
  `^(?:${colorUtilities})-(?:${paletteHues})-(?:50|[1-9]00|950)(?:/\\S+)?$`,
);
const hexColor = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-zA-Z_-])/;
const mutedFill = /^bg-muted\/(?:\d+|\[[^\]]+\])$/;
const tailwindShadow = /^shadow-(?:2xs|xs|sm|md|lg|xl|2xl)(?:\/\S+)?$/;

/**
 * Exact-file exceptions, keyed `path:rule`. Each entry is a color that is
 * content, not chrome.
 */
const allowlist = new Set([
  // Third-party brand marks must render in the vendor's exact colors.
  "packages/views/auth/login-page.tsx:hex-color",
  "packages/views/onboarding/components/brand-icons.tsx:hex-color",
  "packages/views/runtimes/components/provider-logo.tsx:hex-color",
  // GitHub's "merged" violet has no product role.
  "packages/views/issues/components/pull-request-list.tsx:raw-palette",
  // User label colors and the picker that produces them.
  "packages/views/common/color-picker.tsx:hex-color",
  "packages/views/issues/components/pickers/label-picker.tsx:hex-color",
  "packages/views/labels/label-chip.tsx:hex-color",
  // Media: the crop backdrop and the JPEG export bed are image pixels, not UI.
  "packages/views/common/avatar-crop-dialog.tsx:hex-color",
  "packages/views/common/avatar-crop-dialog.tsx:raw-palette",
  // Canvas probe that converts CSS colors into the sRGB bytes Mermaid accepts.
  "packages/views/editor/mermaid-diagram.tsx:hex-color",
]);

function walk(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || skippedDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, files);
    else if (extensions.has(extname(entry.name))) files.push(path);
  }
  return files;
}

function isStringSegment(node) {
  return (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    node.kind === ts.SyntaxKind.TemplateHead ||
    node.kind === ts.SyntaxKind.TemplateMiddle ||
    node.kind === ts.SyntaxKind.TemplateTail
  );
}

function utilityName(token) {
  const withoutVariant = token.slice(token.lastIndexOf(":") + 1);
  return withoutVariant.replace(/^!/, "").replace(/!$/, "").replace(/^-/, "");
}

function isTestFile(relativePath) {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relativePath) || relativePath.includes("/__tests__/");
}

/**
 * A hex is a color when it is the whole value or sits in a CSS-ish position;
 * `#123` in prose is an issue number. A fallback inside `var(--token, #fff)`
 * already resolves through the token, so it is not a raw color.
 */
function hexColorIn(text) {
  const stripped = text.replace(/var\(--[\w-]+,\s*#[0-9a-fA-F]+\)/g, "");
  const match = stripped.match(hexColor);
  if (!match) return null;
  const before = stripped.slice(0, match.index);
  if (before === "" || /[\s(,:[_=]$/.test(before)) return match[0];
  return null;
}

export function colorTokenViolations(sourceText, filePath) {
  const relativePath = relative(repoRoot, filePath).split(sep).join("/");
  if (isTestFile(relativePath)) return [];
  const checkPalette = paletteRoots.some((root) => relativePath.startsWith(root));
  const source = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const violations = [];

  const report = (node, rule, token) => {
    if (allowlist.has(`${relativePath}:${rule}`)) return;
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    violations.push({ file: relativePath, line: line + 1, column: character + 1, rule, token });
  };

  const visit = (node) => {
    if (isStringSegment(node)) {
      for (const token of node.text.split(/\s+/)) {
        if (!token) continue;
        const utility = utilityName(token);
        if (mutedFill.test(utility)) report(node, "muted-fill", token);
        else if (tailwindShadow.test(utility)) report(node, "tailwind-shadow", token);
        else if (checkPalette && rawPalette.test(utility)) report(node, "raw-palette", token);
      }
      if (checkPalette) {
        const hex = hexColorIn(node.text);
        if (hex) report(node, "hex-color", hex);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

function main() {
  const files = roots
    .flatMap((root) => walk(join(repoRoot, root)))
    .filter((file) => {
      const rel = relative(repoRoot, file).split(sep).join("/");
      return !skippedPaths.some((path) => rel.startsWith(path));
    });
  const violations = files.flatMap((file) =>
    colorTokenViolations(readFileSync(file, "utf8"), file),
  );

  if (violations.length > 0) {
    console.error(`Un-tokenized color, fill or shadow (${violations.length})`);
    for (const violation of violations) {
      console.error(
        `  ${violation.file}:${violation.line}:${violation.column}  ${violation.rule}  ${violation.token}`,
      );
    }
    console.error(
      [
        "",
        "Use a role token instead:",
        "  status color   text-success / bg-warning-subtle / text-info-subtle-foreground / Badge variant",
        "  neutral fill   bg-fill-subtle / bg-fill-hover / bg-fill-selected",
        "  elevation      shadow-surface / shadow-menu / shadow-floating",
        "Allowlist by exact file only for colors that are content, not chrome",
        "(third-party brand marks, user label colors, media backdrops).",
      ].join("\n"),
    );
    process.exit(1);
  }

  console.log(`UI color tokens clean (${files.length} source files checked).`);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();

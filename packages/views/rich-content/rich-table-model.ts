import { Children, isValidElement, type ReactElement, type ReactNode } from "react";

type ElementWithChildren = ReactElement<{ children?: ReactNode }>;

export function getTextContent(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(getTextContent).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return getTextContent(node.props.children);
  }
  return "";
}

function childElements(node: ReactNode): ElementWithChildren[] {
  return Children.toArray(node).filter(
    (child): child is ElementWithChildren => isValidElement(child),
  );
}

export interface RichTableModel {
  header: ReactNode[];
  rows: ReactNode[][];
  /** Plain text of every cell, for sorting, filtering, CSV and the width key. */
  headerText: string[];
  rowText: string[][];
}

/**
 * Reads the cells out of the elements react-markdown hands a `table` override:
 * `thead` and `tbody`, each holding `tr` elements. The cells stay the rendered
 * elements, so links, mentions and inline code keep their own renderers
 * wherever the cells are shown again.
 */
export function readTableModel(children: ReactNode): RichTableModel {
  let header: ReactNode[] = [];
  const rows: ReactNode[][] = [];
  for (const section of childElements(children)) {
    for (const row of childElements(section.props.children)) {
      const cells = childElements(row.props.children).map(
        (cell) => cell.props.children,
      );
      if (section.type === "thead") header = cells;
      else rows.push(cells);
    }
  }
  return {
    header,
    rows,
    headerText: header.map((cell) => getTextContent(cell).trim()),
    rowText: rows.map((row) => row.map((cell) => getTextContent(cell).trim())),
  };
}

const MARKDOWN_LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;
const URL_SCHEME = /^(?:https?:\/\/|mailto:)/;

/**
 * The table's Markdown as the author wrote it. RichContent renders a
 * preprocessed copy of the content, and the readonly preprocessing rewrites
 * three things a table can contain — bare issue identifiers into mention
 * links, bare URLs into Markdown links, and `==text==` into `<mark>` — so the
 * slice is turned back before it is copied.
 */
export function tableMarkdownFromSource(
  processed: string,
  start: number | undefined,
  end: number | undefined,
): string {
  if (start == null || end == null || end <= start) return "";
  return processed
    .slice(start, end)
    .replace(MARKDOWN_LINK, (link, text: string, url: string) => {
      if (url === `mention://issue/${text}`) return text;
      if (url === text || url.replace(URL_SCHEME, "") === text) return text;
      return link;
    })
    .replace(/<mark>([\s\S]*?)<\/mark>/g, "==$1==");
}

function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function tableToCsv(header: string[], rows: string[][]): string {
  return [header, ...rows].map((row) => row.map(csvField).join(",")).join("\n");
}

// Column widths a viewer chose by dragging. They belong to this device, not to
// the content: an agent's comment can be resized by someone who cannot edit it.
// A table is identified by its own text, so the widths follow it into every
// place it renders and lapse once its content changes.
const WIDTHS_STORAGE_KEY = "multica:rich-table-widths";
const MAX_STORED_TABLES = 200;

interface StoredWidths {
  widths: number[];
  usedAt: number;
}

function getStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readStore(storage: Storage): Record<string, StoredWidths> {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(WIDTHS_STORAGE_KEY) ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, StoredWidths>;
    }
  } catch {
    // A corrupt entry is replaced on the next write.
  }
  return {};
}

function isWidthList(value: unknown, columnCount: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === columnCount &&
    value.every((width) => typeof width === "number" && Number.isFinite(width) && width > 0)
  );
}

// FNV-1a: short, stable keys; a collision only shares one table's widths.
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function columnWidthKey(model: Pick<RichTableModel, "headerText" | "rowText">): string {
  const text = JSON.stringify([model.headerText, model.rowText]);
  return `${model.headerText.length}:${text.length}:${hash(text)}`;
}

export function readColumnWidths(key: string, columnCount: number): number[] | null {
  const storage = getStorage();
  if (!storage || columnCount === 0) return null;
  const widths = readStore(storage)[key]?.widths;
  return isWidthList(widths, columnCount) ? widths : null;
}

export function writeColumnWidths(key: string, widths: number[] | null): void {
  const storage = getStorage();
  if (!storage) return;
  const store = readStore(storage);
  if (widths) store[key] = { widths, usedAt: Date.now() };
  else delete store[key];
  const kept = Object.entries(store)
    .sort(([, a], [, b]) => (b.usedAt ?? 0) - (a.usedAt ?? 0))
    .slice(0, MAX_STORED_TABLES);
  try {
    storage.setItem(WIDTHS_STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Quota exceeded or storage disabled: the widths last for this view only.
  }
}

"use client";

/**
 * Readonly Markdown tables: column resizing, an expanded view and copy.
 *
 * The table keeps the browser's automatic layout while its columns fit (see
 * `overflowWidths` for when they do not). A viewer's first drag pins every
 * column at the width it renders at and switches to fixed layout, so only the
 * dragged column moves. Those widths are the viewer's own (see
 * `writeColumnWidths`) and never touch the content.
 */

import {
  createContext,
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { ExtraProps } from "react-markdown";
import { Check, Copy, Maximize2, RotateCcw } from "lucide-react";
import { copyText } from "@multica/ui/lib/clipboard";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../i18n";
import { RichTableDialog } from "./rich-table-dialog";
import {
  columnWidthKey,
  getTextContent,
  readColumnWidths,
  readTableModel,
  tableMarkdownFromSource,
  writeColumnWidths,
} from "./rich-table-model";

/** The processed Markdown RichContent rendered, which node offsets index into. */
export const RichTableSourceContext = createContext("");

const RESIZE_DRAG_THRESHOLD = 4;
const MIN_COLUMN_WIDTH = 64;
const MAX_COLUMN_WIDTH = 1200;
// A double-click fits the content, but a paragraph-long cell would otherwise
// claim its full single-line width.
const MAX_AUTO_FIT_WIDTH = 480;
const KEYBOARD_STEP = 8;
const KEYBOARD_STEP_LARGE = 32;
const SCROLL_SHADOW = "color-mix(in oklab, var(--foreground) 8%, transparent)";

function clampWidth(width: number, max = MAX_COLUMN_WIDTH): number {
  return Math.min(max, Math.max(MIN_COLUMN_WIDTH, Math.round(width)));
}

function sum(widths: number[]): number {
  return widths.reduce((total, width) => total + width, 0);
}

function sameWidths(a: number[] | null, b: number[] | null): boolean {
  return a === b || (!!a && !!b && a.length === b.length && a.every((w, i) => w === b[i]));
}

// Each column's min-content and max-content width, read with the table's own
// sizing lifted and restored within the same task, so the browser paints only
// the restored layout.
function measureColumns(table: HTMLTableElement): { min: number[]; max: number[] } {
  const { style } = table;
  const saved = { layout: style.tableLayout, width: style.width, minWidth: style.minWidth };
  const fixed = table.hasAttribute("data-column-widths");
  const cols = Array.from(table.querySelectorAll<HTMLElement>("colgroup > col"));
  const colWidths = cols.map((col) => col.style.width);
  const read = () =>
    Array.from(table.tHead?.rows[0]?.cells ?? [], (cell) => Math.ceil(cell.getBoundingClientRect().width));

  if (fixed) table.removeAttribute("data-column-widths");
  for (const col of cols) col.style.width = "";
  style.tableLayout = "auto";
  style.minWidth = "0";
  style.width = "max-content";
  const max = read();
  style.width = "min-content";
  const min = read();

  style.tableLayout = saved.layout;
  style.width = saved.width;
  style.minWidth = saved.minWidth;
  cols.forEach((col, i) => {
    col.style.width = colWidths[i] ?? "";
  });
  if (fixed) table.setAttribute("data-column-widths", "");
  return { min, max };
}

// The browser's automatic layout reads well while the columns' minimums fit.
// Once they do not, it shrinks every column to its minimum, which leaves a
// prose column a few characters wide beside a column of unbreakable paths.
// Past that point each column gets its content width, capped so one long cell
// cannot claim the table, and the table scrolls.
const PREFERRED_MAX_COLUMN_WIDTH = 320;

function overflowWidths(table: HTMLTableElement, available: number): number[] | null {
  const { min, max } = measureColumns(table);
  if (min.length === 0 || sum(min) <= available) return null;
  return min.map((least, i) => Math.max(least, Math.min(max[i] ?? least, PREFERRED_MAX_COLUMN_WIDTH)));
}

interface ColumnResizeApi {
  begin: (event: ReactPointerEvent<HTMLElement>) => void;
  autoFit: (handle: HTMLElement) => void;
  nudge: (event: ReactKeyboardEvent<HTMLElement>) => void;
}

const ColumnResizeContext = createContext<ColumnResizeApi | null>(null);

function headerCellOf(handle: HTMLElement): HTMLTableCellElement | null {
  return handle.closest("th");
}

// Rendered children of the table. Memoized on their identity so a drag, which
// re-renders the table every frame for its widths, never re-renders the cells.
const TableContent = memo(function TableContent({ children }: { children: ReactNode }) {
  return <>{children}</>;
});

type RichTableProps = ComponentPropsWithoutRef<"table"> & ExtraProps;

export function RichTable({ children, node }: RichTableProps) {
  const { t } = useT("editor");
  const source = useContext(RichTableSourceContext);
  const model = useMemo(() => readTableModel(children), [children]);
  const columnCount = model.headerText.length;
  const storageKey = useMemo(() => columnWidthKey(model), [model]);

  const [widths, setWidths] = useState<number[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const tableRef = useRef<HTMLTableElement>(null);
  const widthsRef = useRef(widths);
  useLayoutEffect(() => {
    widthsRef.current = widths;
  }, [widths]);

  // Layout effect: stored widths apply before the first paint, so a resized
  // table does not flash at its automatic layout on every mount.
  useLayoutEffect(() => {
    setWidths(readColumnWidths(storageKey, columnCount));
  }, [storageKey, columnCount]);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const [autoWidths, setAutoWidths] = useState<number[] | null>(null);
  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    const table = tableRef.current;
    if (!wrapper || !table || widths) return;
    let measuredAt = -1;
    let active = true;
    const fit = () => {
      const available = wrapper.clientWidth;
      if (!active || available === measuredAt) return;
      measuredAt = available;
      const next = overflowWidths(table, available);
      setAutoWidths((prev) => (sameWidths(prev, next) ? prev : next));
    };
    fit();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    observer?.observe(wrapper);
    // Content widths change when a web font replaces its fallback.
    void document.fonts?.ready.then(() => {
      measuredAt = -1;
      fit();
    });
    return () => {
      active = false;
      observer?.disconnect();
    };
  }, [widths, model]);

  const [overflow, setOverflow] = useState({ start: false, end: false });
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const sync = () => {
      const start = wrapper.scrollLeft > 0;
      const end = wrapper.scrollLeft + wrapper.clientWidth < wrapper.scrollWidth - 1;
      setOverflow((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
    };
    sync();
    wrapper.addEventListener("scroll", sync, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    observer?.observe(wrapper);
    if (tableRef.current) observer?.observe(tableRef.current);
    return () => {
      wrapper.removeEventListener("scroll", sync);
      observer?.disconnect();
    };
  }, []);

  const api = useMemo<ColumnResizeApi>(() => {
    const renderedWidths = (): number[] => {
      const cells = tableRef.current?.tHead?.rows[0]?.cells;
      return cells ? Array.from(cells, (cell) => clampWidth(cell.getBoundingClientRect().width)) : [];
    };
    const baseWidths = () => widthsRef.current ?? renderedWidths();
    const commit = (next: number[]) => {
      setWidths(next);
      writeColumnWidths(storageKey, next);
    };

    return {
      begin(event) {
        const handle = event.currentTarget;
        const index = headerCellOf(handle)?.cellIndex ?? -1;
        if (index < 0) return;
        event.preventDefault();
        event.stopPropagation();

        const startX = event.clientX;
        const { pointerId } = event;
        const table = tableRef.current;
        const badge = handle.querySelector<HTMLElement>("[data-width-badge]");
        let base: number[] | null = null;
        let latest: number[] | null = null;

        const move = (pointerEvent: PointerEvent) => {
          const delta = pointerEvent.clientX - startX;
          if (!base && Math.abs(delta) < RESIZE_DRAG_THRESHOLD) return;
          if (!base) {
            base = baseWidths();
            handle.dataset.resizing = "";
            if (table) handle.style.height = `${table.offsetHeight}px`;
            setDragging(true);
          }
          const width = clampWidth((base[index] ?? 0) + delta);
          latest = base.map((w, i) => (i === index ? width : w));
          if (badge) badge.textContent = `${width}px`;
          setWidths(latest);
        };
        const stop = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", stop);
          window.removeEventListener("pointercancel", stop);
          window.removeEventListener("blur", stop);
          handle.removeEventListener("lostpointercapture", stop);
          if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture?.(pointerId);
          delete handle.dataset.resizing;
          handle.style.height = "";
          setDragging(false);
          if (latest) commit(latest);
        };

        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", stop);
        window.addEventListener("pointercancel", stop);
        // Releasing outside the window never delivers pointerup.
        window.addEventListener("blur", stop);
        handle.addEventListener("lostpointercapture", stop);
        handle.setPointerCapture?.(pointerId);
      },

      // Fixed layout ignores content, so the column's cells are measured with
      // the constraints lifted and restored within the same task; the browser
      // paints once, after the restore.
      autoFit(handle) {
        const table = tableRef.current;
        const index = headerCellOf(handle)?.cellIndex ?? -1;
        if (!table || index < 0) return;
        const base = baseWidths();
        const col = table.querySelector("colgroup")?.children[index] as HTMLElement | undefined;
        const cells = Array.from(table.rows, (row) => row.cells[index]).filter(
          (cell): cell is HTMLTableCellElement => cell != null,
        );
        const previous = {
          layout: table.style.tableLayout,
          width: table.style.width,
          col: col?.style.width ?? "",
        };
        table.style.tableLayout = "auto";
        table.style.width = "max-content";
        if (col) col.style.width = "";
        const cellWidths = cells.map((cell) => cell.style.width);
        for (const cell of cells) cell.style.width = "max-content";
        const widest = Math.max(0, ...cells.map((cell) => cell.getBoundingClientRect().width));
        cells.forEach((cell, i) => {
          cell.style.width = cellWidths[i] ?? "";
        });
        if (col) col.style.width = previous.col;
        table.style.width = previous.width;
        table.style.tableLayout = previous.layout;
        if (widest > 0) {
          commit(base.map((w, i) => (i === index ? clampWidth(widest, MAX_AUTO_FIT_WIDTH) : w)));
        }
      },

      nudge(event) {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        const index = headerCellOf(event.currentTarget)?.cellIndex ?? -1;
        if (index < 0) return;
        event.preventDefault();
        const step = event.shiftKey ? KEYBOARD_STEP_LARGE : KEYBOARD_STEP;
        const delta = event.key === "ArrowRight" ? step : -step;
        commit(baseWidths().map((w, i) => (i === index ? clampWidth(w + delta) : w)));
      },
    };
  }, [storageKey]);

  const resetWidths = () => {
    setWidths(null);
    writeColumnWidths(storageKey, null);
  };

  const markdown = () =>
    tableMarkdownFromSource(source, node?.position?.start.offset, node?.position?.end.offset);

  const copyMarkdown = async () => {
    if (await copyText(markdown())) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const userWidths = widths?.length === columnCount ? widths : null;
  const resized = userWidths !== null;
  const columnWidths = userWidths ?? (autoWidths?.length === columnCount ? autoWidths : null);
  const toolbarButton =
    "flex h-6 items-center justify-center gap-1 rounded-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <div className="rich-table group/table relative" data-resized={resized ? "" : undefined}>
      <div className="rich-table-toolbar absolute top-1.5 right-1.5 z-20 flex items-center gap-0.5 rounded-md border border-surface-border bg-surface-raised p-0.5 opacity-0 shadow-[var(--menu-shadow)] transition-opacity group-hover/table:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
        {resized && (
          <button type="button" onClick={resetWidths} className={cn(toolbarButton, "px-1.5 text-caption")}>
            <RotateCcw className="size-3.5" />
            {t(($) => $.table.reset_widths)}
          </button>
        )}
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className={cn(toolbarButton, "w-6")}
          title={t(($) => $.table.expand)}
          aria-label={t(($) => $.table.expand)}
        >
          <Maximize2 className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={copyMarkdown}
          className={cn(toolbarButton, "w-6")}
          title={copied ? t(($) => $.table.copied) : t(($) => $.table.copy_markdown)}
          aria-label={t(($) => $.table.copy_markdown)}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
      </div>
      <div ref={wrapperRef} className="tableWrapper">
        <table
          ref={tableRef}
          data-column-widths={columnWidths ? "" : undefined}
          style={columnWidths ? { width: sum(columnWidths) } : undefined}
        >
          {columnWidths && (
            <colgroup>
              {columnWidths.map((width, index) => (
                <col key={index} style={{ width }} />
              ))}
            </colgroup>
          )}
          <ColumnResizeContext.Provider value={api}>
            <TableContent>{children}</TableContent>
          </ColumnResizeContext.Provider>
        </table>
      </div>
      {/* Columns continue past the edge: a shadow, not a fade to a background
          colour, because the same table renders on cards, pages and chat. */}
      {overflow.start && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-px left-px w-3 rounded-l-[var(--radius)]"
          style={{ background: `linear-gradient(to right, ${SCROLL_SHADOW}, transparent)` }}
        />
      )}
      {overflow.end && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-px right-px w-3 rounded-r-[var(--radius)]"
          style={{ background: `linear-gradient(to left, ${SCROLL_SHADOW}, transparent)` }}
        />
      )}
      {expanded && (
        <RichTableDialog
          model={model}
          open={expanded}
          onOpenChange={setExpanded}
          getMarkdown={markdown}
        />
      )}
      {/* Owns the cursor for the whole drag, so cells that declare their own
          (links, text) cannot override it, and keeps text unselectable. */}
      {dragging &&
        typeof document !== "undefined" &&
        createPortal(
          <div aria-hidden className="fixed inset-0 z-50 cursor-col-resize touch-none select-none" />,
          document.body,
        )}
    </div>
  );
}

type RichTableHeaderCellProps = ComponentPropsWithoutRef<"th"> & ExtraProps;

export function RichTableHeaderCell({ node: _node, children, ...props }: RichTableHeaderCellProps) {
  const api = useContext(ColumnResizeContext);
  const { t } = useT("editor");
  return (
    <th {...props}>
      {children}
      {api && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t(($) => $.table.resize_column, { name: getTextContent(children).trim() })}
          tabIndex={0}
          className="rich-table-resize-handle"
          onPointerDown={api.begin}
          onDoubleClick={(event) => {
            event.preventDefault();
            api.autoFit(event.currentTarget);
          }}
          onKeyDown={api.nudge}
        >
          <span data-width-badge="" aria-hidden />
        </div>
      )}
    </th>
  );
}

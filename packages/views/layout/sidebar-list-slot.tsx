"use client";

import { createContext, use, useState, type ReactNode } from "react";
import { cn } from "@multica/ui/lib/utils";

/**
 * Lets a list/detail page hand its list to the sidebar panel.
 *
 * In the rail + panel sidebar, Inbox and Chat are modules whose panel IS the
 * list: the page keeps owning the list's state and behaviour, and renders it
 * through a portal into the element the panel publishes here, leaving the main
 * area to the detail alone.
 *
 * The panel publishes the element whenever it is a column in the canvas
 * rather than a compact sheet. Folding the panel keeps it mounted at zero
 * width, so the list stays put and the page still shows the detail alone. A
 * `null` slot is the signal for the page to fall back to its own two-pane
 * layout.
 */
const SidebarListSlotContext = createContext<{
  slot: HTMLElement | null;
  setSlot: (el: HTMLElement | null) => void;
} | null>(null);

export function SidebarListSlotProvider({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <SidebarListSlotContext value={{ slot, setSlot }}>
      {children}
    </SidebarListSlotContext>
  );
}

/** The element a module panel publishes for its page's list. */
export function SidebarListSlot({ className }: { className?: string }) {
  const ctx = use(SidebarListSlotContext);
  return (
    <div
      ref={ctx?.setSlot}
      data-slot="sidebar-list-slot"
      className={cn("flex min-h-0 flex-1 flex-col", className)}
    />
  );
}

/**
 * The element to portal the page's list into, or `null` when the page should
 * render the list itself. Pass `active: false` from an instance that is not
 * the current route (App Router can keep a page mounted after navigating
 * away), so a stale page never claims the panel.
 */
export function useSidebarListSlot(active: boolean): HTMLElement | null {
  const ctx = use(SidebarListSlotContext);
  return active ? (ctx?.slot ?? null) : null;
}

/**
 * The title row at the top of a sidebar panel. Shares the page header's
 * height and bottom rule so the panel and the page beside it read as one band.
 */
export function SidebarPanelHeader({
  title,
  children,
  className,
}: {
  title: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <header
      data-slot="sidebar-panel-header"
      className={cn("flex h-12 shrink-0 items-center gap-1 border-b pr-2 pl-4", className)}
    >
      <h2 className="flex min-w-0 flex-1 items-center gap-2 truncate text-body font-semibold">
        {title}
      </h2>
      {children}
    </header>
  );
}

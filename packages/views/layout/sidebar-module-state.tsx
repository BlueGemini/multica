"use client";

import {
  createContext,
  use,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useWorkspacePaths } from "@multica/core/paths";
import { useNavigation } from "../navigation";
import { SidebarListSlotProvider } from "./sidebar-list-slot";
import { resolveSidebarModule, type SidebarModule } from "./sidebar-modules";

/**
 * The module the rail last settled on, keyed by the route it settled on. A
 * route several modules lead to (an issue detail) keeps the module it was
 * opened from, so the active module depends on this rather than on the route
 * alone. A rail click names its module up front (`pending`), since the route
 * it reopens may be one of those shared ones.
 */
export interface SidebarModuleState {
  pathname: string;
  module: SidebarModule;
  pending: { pathname: string; module: SidebarModule } | null;
}

const SidebarModuleContext = createContext<{
  state: SidebarModuleState | null;
  setState: Dispatch<SetStateAction<SidebarModuleState | null>>;
} | null>(null);

/**
 * Shared by the rail and the panel, which render in different parts of the
 * shell: the rail in the sidebar, the panel inside the canvas.
 */
export function AppSidebarProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SidebarModuleState | null>(null);
  return (
    <SidebarModuleContext value={{ state, setState }}>
      <SidebarListSlotProvider>{children}</SidebarListSlotProvider>
    </SidebarModuleContext>
  );
}

/**
 * The active module for the current route. Derived during render from the
 * settled state, so the rail and the panel agree on the same frame; the rail
 * settles the state after each route change.
 */
export function useSidebarModule() {
  const ctx = use(SidebarModuleContext);
  if (!ctx) throw new Error("useSidebarModule must be used within an AppSidebarProvider.");
  const { pathname } = useNavigation();
  const p = useWorkspacePaths();
  const { state, setState } = ctx;
  let module: SidebarModule;
  if (state === null) module = resolveSidebarModule(pathname, p, "work");
  else if (state.pathname === pathname) module = state.module;
  else if (state.pending?.pathname === pathname) module = state.pending.module;
  else module = resolveSidebarModule(pathname, p, state.module);
  return { module, pathname, state, setState };
}

/**
 * Whether the page renders inside the rail + panel shell. A page whose own
 * navigation the module panel already shows (Settings) drops that column
 * when this is true and the viewport is not compact.
 */
export function useInModuleShell(): boolean {
  return use(SidebarModuleContext) !== null;
}

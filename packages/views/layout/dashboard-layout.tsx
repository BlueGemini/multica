"use client";

import type { ReactNode } from "react";
import { SidebarProvider, SidebarInset } from "@multica/ui/components/ui/sidebar";
import { ModalRegistry } from "../modals/registry";
import { SourceBackfillModal } from "../onboarding";
import { APP_SIDEBAR_PROVIDER_PROPS, AppSidebar } from "./app-sidebar";
import { SidebarListSlotProvider } from "./sidebar-list-slot";
import { DashboardGuard } from "./dashboard-guard";
import { NavigationProgress } from "./navigation-progress";
import { WorkspacePresencePrefetch } from "./workspace-presence-prefetch";
import { GlobalShortcuts } from "./global-shortcuts";

interface DashboardLayoutProps {
  children: ReactNode;
  /** Rendered inside SidebarInset (e.g. ChatWindow, ChatFab — absolute-positioned overlays) */
  extra?: ReactNode;
  /** Loading indicator */
  loadingIndicator?: ReactNode;
}

export function DashboardLayout({
  children,
  extra,
  loadingIndicator,
}: DashboardLayoutProps) {
  return (
    <DashboardGuard
      loadingFallback={
        <div className="flex h-svh items-center justify-center">
          {loadingIndicator}
        </div>
      }
    >
      <SidebarProvider className="h-svh bg-app-shell" {...APP_SIDEBAR_PROVIDER_PROPS}>
        <SidebarListSlotProvider>
          <GlobalShortcuts />
          <WorkspacePresencePrefetch />
          <AppSidebar />
          <SidebarInset className="relative overflow-hidden">
            <NavigationProgress />
            {children}
            <ModalRegistry />
            <SourceBackfillModal />
            {extra}
          </SidebarInset>
        </SidebarListSlotProvider>
      </SidebarProvider>
    </DashboardGuard>
  );
}

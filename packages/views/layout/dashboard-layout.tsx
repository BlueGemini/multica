"use client";

import type { ReactNode } from "react";
import { SidebarProvider, SidebarInset } from "@multica/ui/components/ui/sidebar";
import { ModalRegistry } from "../modals/registry";
import { SourceBackfillModal } from "../onboarding";
import { APP_SIDEBAR_PROVIDER_PROPS, AppSidebar, AppSidebarPanel } from "./app-sidebar";
import { AppSidebarProvider } from "./sidebar-module-state";
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
        <AppSidebarProvider>
          <GlobalShortcuts />
          <WorkspacePresencePrefetch />
          <AppSidebar />
          <SidebarInset className="relative overflow-hidden">
            <NavigationProgress />
            <div className="flex min-h-0 flex-1">
              <AppSidebarPanel />
              <div className="relative flex min-w-0 flex-1 flex-col">{children}</div>
            </div>
            <ModalRegistry />
            <SourceBackfillModal />
            {extra}
          </SidebarInset>
        </AppSidebarProvider>
      </SidebarProvider>
    </DashboardGuard>
  );
}

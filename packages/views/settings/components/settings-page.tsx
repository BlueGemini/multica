"use client";

import { useEffect, useRef } from "react";
import { useIsCompact } from "@multica/ui/hooks/use-mobile";
import { cn } from "@multica/ui/lib/utils";
import { useNavigation } from "../../navigation";
import { SETTINGS_ANCHOR_ATTR } from "./settings-layout";
import { SettingsNav, useSettingsGroups } from "./settings-nav";
import { CollapsedNavTrigger } from "../../layout/page-header";
import { useInModuleShell } from "../../layout/sidebar-module-state";
import { useT } from "../../i18n";

const FLASH_MS = 1600;
const ANCHOR_WAIT_MS = 1500;

export function SettingsPage() {
  const { t } = useT("settings");
  const navigation = useNavigation();
  const { groups, active, location, tabHref } = useSettingsGroups();
  const inModuleShell = useInModuleShell();
  const isCompact = useIsCompact();
  // The Settings panel beside the canvas already shows this navigation.
  const panelShowsNav = inModuleShell && !isCompact;
  const href = (value: string) =>
    groups
      .flatMap((group) => group.subgroups.flatMap((subgroup) => subgroup.entries))
      .find((item) => item.value === value)?.href ?? tabHref(value);

  // --- anchors --------------------------------------------------------------
  // Search results and legacy `?section=` links name an anchor inside the
  // page. Tab content can still be loading on the first frame, so wait briefly
  // for the anchor before scrolling it into view and flashing it.
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const anchor = location.section;
    if (!anchor) return;
    let cancelled = false;
    let flashTimer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    const find = () => {
      if (cancelled) return;
      const target = contentRef.current?.querySelector<HTMLElement>(
        `[${SETTINGS_ANCHOR_ATTR}="${CSS.escape(anchor)}"]`,
      );
      if (!target) {
        if (Date.now() - startedAt < ANCHOR_WAIT_MS) {
          requestAnimationFrame(find);
        }
        return;
      }
      const reduceMotion =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      target.scrollIntoView?.({
        block: "center",
        behavior: reduceMotion ? "auto" : "smooth",
      });
      target.setAttribute("data-flash", "true");
      flashTimer = setTimeout(() => target.removeAttribute("data-flash"), FLASH_MS);
    };
    requestAnimationFrame(find);
    return () => {
      cancelled = true;
      if (flashTimer) clearTimeout(flashTimer);
    };
  }, [active.value, location.section]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background md:flex-row">
      {panelShowsNav ? null : (
        <aside className="shrink-0 border-b border-surface-border md:flex md:w-60 md:flex-col md:border-b-0 md:border-r">
          <div className="flex h-16 shrink-0 items-center gap-1 px-4 md:px-5">
            <CollapsedNavTrigger />
            <h1 className="text-title font-semibold tracking-tight">
              {t(($) => $.page.title)}
            </h1>
          </div>
          <div className="px-4 pb-4 md:hidden">
            <label className="sr-only" htmlFor="settings-navigation">
              {t(($) => $.page.navigate)}
            </label>
            <select
              id="settings-navigation"
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-body text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              value={active.value}
              onChange={(event) => navigation.push(href(event.target.value))}
            >
              {groups.flatMap((group) =>
                group.subgroups.map((subgroup) => (
                  <optgroup
                    key={`${group.key}:${subgroup.key}`}
                    label={subgroup.label ? `${group.label} · ${subgroup.label}` : group.label}
                  >
                    {subgroup.entries.map((item) => (
                      <option key={item.value} value={item.value}>
                        {item.label}
                      </option>
                    ))}
                  </optgroup>
                )),
              )}
            </select>
          </div>
          <SettingsNav className="hidden md:flex" />
        </aside>
      )}
      <div
        ref={contentRef}
        key={`${active.value}:${location.integration ?? ""}`}
        className="min-w-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <div
          className={cn(
            "mx-auto w-full px-4 py-6 sm:px-6 md:px-10 md:py-8",
            active.wide ? "max-w-5xl" : "max-w-4xl",
          )}
        >
          {active.content}
        </div>
      </div>
    </div>
  );
}

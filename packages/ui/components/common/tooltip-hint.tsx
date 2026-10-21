"use client";

import type { ComponentProps, ReactElement, ReactNode } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@multica/ui/components/ui/tooltip";

/**
 * Tooltip for an icon-only control that keeps its own element and styling
 * (a raw `<button>`, a link, a toggle). The child must carry its own
 * accessible name; prefer `IconButton` for a plain icon `Button`.
 */
function TooltipHint({
  label,
  shortcut,
  side = "top",
  children,
}: {
  label: ReactNode;
  /** Decorative keycaps shown after the label. */
  shortcut?: ReactNode;
  side?: ComponentProps<typeof TooltipContent>["side"];
  children: ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side={side}>
        {label}
        {shortcut}
      </TooltipContent>
    </Tooltip>
  );
}

export { TooltipHint };

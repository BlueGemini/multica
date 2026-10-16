"use client";

import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import { useT } from "../../i18n";

/**
 * Where the flow ends. The error sits on the left so it reads before the
 * button it explains; `secondary` holds the ways out that keep the draft
 * (finish later, hand it to an agent) and the one that throws it away.
 */
export function CreateAgentFooter({
  canCreate,
  creating,
  squad,
  opensAgent = true,
  error,
  onCreate,
  secondary,
}: {
  canCreate: boolean;
  creating: boolean;
  squad: boolean;
  opensAgent?: boolean;
  error: string | null;
  onCreate: () => void;
  secondary?: ReactNode;
}) {
  const { t } = useT("agents");
  return (
    <div
      data-slot="create-agent-footer"
      className="flex flex-wrap items-center gap-3 border-t bg-background px-5 py-3"
    >
      {error ? (
        <p
          role="alert"
          className="min-w-0 flex-1 break-words text-body text-destructive"
        >
          {error}
        </p>
      ) : null}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {secondary}
        <Button type="button" onClick={onCreate} disabled={!canCreate}>
          {creating && <Loader2 className="size-4 animate-spin" />}
          {creating
            ? t(($) => $.creation_studio.creating)
            : squad
              ? t(($) => $.creation_studio.create_and_add)
              : opensAgent
                ? t(($) => $.creation_studio.create_and_open)
                : t(($) => $.create_dialog.create)}
        </Button>
      </div>
    </div>
  );
}

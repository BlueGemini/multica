"use client";

import {
  Activity,
  Bot,
  CircleAlert,
  Cloud,
  KeyRound,
  Plus,
} from "lucide-react";
import type { QoderConnection } from "@multica/core/runtimes/qoder";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button, buttonVariants } from "@multica/ui/components/ui/button";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";
import { QoderStatusBadge } from "./qoder-status-badge";

export function QoderCloudCard({
  connection,
  agentCount,
  createAgentHref,
  detailHref,
  onConfigure,
}: {
  connection: QoderConnection;
  agentCount: number;
  /** Step 2 of agent creation on the Qoder runtime; absent until it is online. */
  createAgentHref: string | null;
  detailHref?: string;
  onConfigure: () => void;
}) {
  const { t } = useT("runtimes");
  return (
    <div>
      <div className="flex flex-col gap-5 rounded-xl border bg-background p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
        <div className="flex min-w-0 gap-4">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-info/10 text-info">
            <Cloud aria-hidden="true" className="size-6" />
          </div>
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-body font-semibold">
                {detailHref ? (
                  <AppLink
                    href={detailHref}
                    className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {t(($) => $.qoder.cloud_title)}
                  </AppLink>
                ) : (
                  t(($) => $.qoder.cloud_title)
                )}
              </h3>
              <Badge variant="secondary" className="bg-info/10 text-info">
                {t(($) => $.qoder.managed)}
              </Badge>
              <QoderStatusBadge connection={connection} />
            </div>
            <p className="text-caption leading-relaxed text-muted-foreground">
              {t(($) => $.qoder.cloud_description)}
            </p>
            <div className="flex flex-wrap gap-2">
              <p className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-caption text-muted-foreground">
                <Bot aria-hidden="true" className="size-3.5" />
                {t(($) => $.qoder.agent_count, { count: agentCount })}
              </p>
              {connection.configured && connection.enabled && (
                <p className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-caption tabular-nums text-muted-foreground">
                  <Activity aria-hidden="true" className="size-3.5" />
                  {t(($) => $.qoder.usage, {
                    active: connection.activeRuns,
                    limit: connection.maxConcurrency,
                    queued: connection.queuedRuns,
                  })}
                </p>
              )}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">
          <Button
            variant={connection.configured ? "outline" : "default"}
            onClick={onConfigure}
          >
            <KeyRound aria-hidden="true" className="size-4" />
            {connection.configured
              ? t(($) => $.qoder.configure_credentials)
              : t(($) => $.qoder.connect.submit)}
          </Button>
          {createAgentHref ? (
            <AppLink href={createAgentHref} className={buttonVariants()}>
              <Plus aria-hidden="true" className="size-4" />
              {t(($) => $.qoder.create_agent)}
            </AppLink>
          ) : connection.configured ? (
            <Button disabled>
              <Plus aria-hidden="true" className="size-4" />
              {t(($) => $.qoder.create_agent)}
            </Button>
          ) : null}
        </div>
      </div>
      {connection.enabled &&
        connection.status === "error" &&
        connection.lastError && (
          <div
            role="alert"
            className="mt-2 flex items-center gap-3 rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-2.5 text-caption text-destructive"
          >
            <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
            <p className="min-w-0 flex-1 break-words">{connection.lastError}</p>
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0"
              onClick={onConfigure}
            >
              {t(($) => $.qoder.open_settings)}
            </Button>
          </div>
        )}
    </div>
  );
}

"use client";

import type { ReactNode } from "react";
import {
  Check,
  CircleAlert,
  Cloud,
  Info,
  Laptop,
  Loader2,
  Lock,
  Server,
  TriangleAlert,
} from "lucide-react";
import { QODER_REGIONS, type QoderConnection } from "@multica/core/runtimes/qoder";
import { Button } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import { ProviderLogo } from "../../runtimes/components/provider-logo";
import { QoderConnectForm } from "../../runtimes/components/qoder-connect-form";
import type { RuntimeMachine } from "../../runtimes/components/runtime-machines";
import { QoderStatusChip, type QoderChoiceState } from "./runtime-choice-sections";
import type { HarnessOption } from "./runtime-choice";

function PanelSection({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("border-b px-5 py-4 last:border-b-0", className)}>{children}</div>;
}

function PanelHead({
  provider,
  title,
  subtitle,
  status,
}: {
  provider: string;
  title: string;
  subtitle: string;
  status: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-background">
        <ProviderLogo provider={provider} className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-title-sm font-semibold">{title}</p>
        <p className="truncate text-caption text-muted-foreground">{subtitle}</p>
      </div>
      {status}
    </div>
  );
}

function OnlineLabel({ online }: { online: boolean }) {
  const { t } = useT("agents");
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-caption text-muted-foreground">
      <span
        aria-hidden="true"
        className={cn("size-1.5 rounded-full", online ? "bg-success" : "bg-muted-foreground/40")}
      />
      {online
        ? t(($) => $.creation_studio.runtime_step.online)
        : t(($) => $.creation_studio.runtime_step.offline)}
    </span>
  );
}

function KeyValues({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-label">
      {rows.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-muted-foreground">{key}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function FeatureChips({ features }: { features: string[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {features.map((feature) => (
        <span key={feature} className="rounded-xs bg-muted px-1.5 py-0.5 text-caption">
          {feature}
        </span>
      ))}
    </span>
  );
}

function Notice({
  tone,
  children,
}: {
  tone: "info" | "warning" | "error";
  children: ReactNode;
}) {
  const Icon = tone === "info" ? Info : tone === "warning" ? TriangleAlert : CircleAlert;
  return (
    <div
      role={tone === "error" ? "alert" : undefined}
      className={cn(
        "flex items-start gap-2 rounded-lg px-3 py-2.5 text-label",
        tone === "info" && "bg-muted/60 text-muted-foreground",
        tone === "warning" && "border border-warning/30 bg-warning/5",
        tone === "error" && "border border-destructive/20 bg-destructive/5 text-destructive",
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn("mt-0.5 size-3.5 shrink-0", tone === "warning" && "text-warning")}
      />
      <span className="min-w-0">{children}</span>
    </div>
  );
}

export function IntroPanel() {
  const { t } = useT("agents");
  const blocks = [
    {
      icon: Laptop,
      title: t(($) => $.creation_studio.runtime_step.sections.local.title),
      pros: [
        t(($) => $.creation_studio.runtime_step.compare.local_pro_account),
        t(($) => $.creation_studio.runtime_step.compare.local_pro_features),
      ],
      con: t(($) => $.creation_studio.runtime_step.compare.local_con),
    },
    {
      icon: Server,
      title: t(($) => $.creation_studio.runtime_step.sections.remote.title),
      pros: [
        t(($) => $.creation_studio.runtime_step.compare.remote_pro_cli),
        t(($) => $.creation_studio.runtime_step.compare.remote_pro_offline),
      ],
      con: t(($) => $.creation_studio.runtime_step.compare.remote_con),
    },
    {
      icon: Cloud,
      title: t(($) => $.creation_studio.runtime_step.sections.cloud.title),
      pros: [
        t(($) => $.creation_studio.runtime_step.compare.cloud_pro_offline),
        t(($) => $.creation_studio.runtime_step.compare.cloud_pro_shared),
      ],
      con: t(($) => $.creation_studio.runtime_step.compare.cloud_con),
    },
  ];
  return (
    <>
      <PanelSection>
        <p className="text-title-sm font-semibold">
          {t(($) => $.creation_studio.runtime_step.intro_title)}
        </p>
        <p className="mt-1.5 text-label text-muted-foreground">
          {t(($) => $.creation_studio.runtime_step.intro_body)}
        </p>
      </PanelSection>
      <PanelSection className="space-y-2.5">
        {blocks.map(({ icon: Icon, title, pros, con }) => (
          <div key={title} className="rounded-lg border bg-card p-3">
            <p className="flex items-center gap-2 text-body font-semibold">
              <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
              {title}
            </p>
            <ul className="mt-2 space-y-1 text-caption">
              {pros.map((pro) => (
                <li key={pro} className="flex items-center gap-1.5">
                  <Check aria-hidden="true" className="size-3 text-success" />
                  {pro}
                </li>
              ))}
              <li className="flex items-center gap-1.5 text-muted-foreground">
                <Info aria-hidden="true" className="size-3" />
                {con}
              </li>
            </ul>
          </div>
        ))}
      </PanelSection>
    </>
  );
}

export function HarnessPanel({
  option,
  machine,
  isLocal,
  owner,
  ownerIsMe,
}: {
  option: HarnessOption;
  machine: RuntimeMachine | null;
  isLocal: boolean;
  owner: string | null;
  ownerIsMe: boolean;
}) {
  const { t } = useT("agents");
  const runtime = option.runtime;
  const online = runtime.status === "online";
  const cloud = runtime.runtime_mode === "cloud";
  const deviceTitle = machine?.title ?? runtime.device_info;
  const sectionLabel = cloud
    ? t(($) => $.creation_studio.runtime_step.sections.cloud.title)
    : isLocal
      ? t(($) => $.creation_studio.runtime_step.sections.local.title)
      : t(($) => $.creation_studio.runtime_step.sections.remote.title);
  const harnessValue = option.version ? `${option.label} ${option.version}` : option.label;
  const rows: [string, ReactNode][] = [
    [
      t(($) => $.creation_studio.runtime_step.kv.where),
      isLocal
        ? t(($) => $.creation_studio.runtime_step.kv.where_this_device)
        : [deviceTitle, machine?.subtitle].filter(Boolean).join(" · "),
    ],
  ];
  if (!isLocal && owner) {
    rows.push([t(($) => $.creation_studio.runtime_step.kv.owner), owner]);
  }
  rows.push([t(($) => $.creation_studio.runtime_step.kv.harness), harnessValue]);
  if (!cloud) {
    rows.push([
      t(($) => $.creation_studio.runtime_step.kv.account),
      isLocal || ownerIsMe
        ? t(($) => $.creation_studio.runtime_step.kv.account_local)
        : t(($) => $.creation_studio.runtime_step.kv.account_remote, { owner: owner ?? "" }),
    ]);
  }
  rows.push([
    t(($) => $.creation_studio.runtime_step.kv.model),
    t(($) => $.creation_studio.runtime_step.kv.next_step),
  ]);
  rows.push([
    t(($) => $.creation_studio.runtime_step.kv.features),
    <FeatureChips
      key="features"
      features={[
        t(($) => $.creation_studio.runtime_step.features.issues),
        t(($) => $.creation_studio.runtime_step.features.chat),
        t(($) => $.creation_studio.runtime_step.features.skills),
        t(($) => $.creation_studio.runtime_step.features.mcp),
      ]}
    />,
  ]);

  return (
    <>
      <PanelSection>
        <PanelHead
          provider={runtime.provider}
          title={option.label}
          subtitle={`${deviceTitle} · ${sectionLabel}`}
          status={<OnlineLabel online={online} />}
        />
      </PanelSection>
      <PanelSection>
        <KeyValues rows={rows} />
      </PanelSection>
      <PanelSection className="space-y-2.5">
        {!online ? (
          <Notice tone="warning">
            {t(($) => $.creation_studio.runtime_step.offline_warning)}
          </Notice>
        ) : null}
        {!isLocal && !cloud && !ownerIsMe && owner ? (
          <Notice tone="warning">
            {t(($) => $.creation_studio.runtime_step.remote_warning, { owner })}
          </Notice>
        ) : null}
        {isLocal ? (
          <Notice tone="info">{t(($) => $.creation_studio.runtime_step.local_note)}</Notice>
        ) : null}
      </PanelSection>
    </>
  );
}

export function QoderPanel({
  wsId,
  connection,
  state,
  canManage,
  admins,
  waiting,
  onConnected,
  onOpenSettings,
  onClearSelection,
}: {
  wsId: string;
  connection: QoderConnection;
  state: QoderChoiceState;
  canManage: boolean;
  admins: string[];
  /** A connect from this screen is waiting for the runtime to come online. */
  waiting: boolean;
  onConnected: () => void;
  onOpenSettings: () => void;
  onClearSelection: () => void;
}) {
  const { t } = useT("agents");
  const regionLabel =
    connection.baseUrl === QODER_REGIONS.cn
      ? t(($) => $.creation_studio.runtime_step.region_cn)
      : t(($) => $.creation_studio.runtime_step.region_global);
  const subtitle =
    state === "not_configured"
      ? t(($) => $.creation_studio.runtime_step.qoder_not_connected)
      : regionLabel;
  const head = (
    <PanelSection>
      <PanelHead
        provider="qoder_cloud"
        // eslint-disable-next-line no-restricted-syntax -- product name, not translated
        title="Qoder Cloud Agent"
        subtitle={subtitle}
        status={<QoderStatusChip state={state} />}
      />
      {state === "not_configured" ? (
        <p className="mt-3 text-label text-muted-foreground">
          {t(($) => $.creation_studio.runtime_step.qoder_intro)}
        </p>
      ) : null}
    </PanelSection>
  );

  if (state === "ready") {
    return (
      <>
        {head}
        <PanelSection>
          <KeyValues
            rows={[
              [t(($) => $.creation_studio.runtime_step.kv.region), regionLabel],
              [
                t(($) => $.creation_studio.runtime_step.kv.load),
                <span key="load" className="tabular-nums">
                  {t(($) => $.creation_studio.runtime_step.qoder_load, {
                    active: connection.activeRuns,
                    limit: connection.maxConcurrency,
                    queued: connection.queuedRuns,
                  })}
                </span>,
              ],
              [
                t(($) => $.creation_studio.runtime_step.kv.qoder_agent),
                t(($) => $.creation_studio.runtime_step.kv.next_step),
              ],
              [
                t(($) => $.creation_studio.runtime_step.kv.features),
                <FeatureChips
                  key="features"
                  features={[
                    t(($) => $.creation_studio.runtime_step.features.issues),
                    t(($) => $.creation_studio.runtime_step.features.followups),
                    t(($) => $.creation_studio.runtime_step.features.prs),
                  ]}
                />,
              ],
            ]}
          />
        </PanelSection>
        <PanelSection>
          <Notice tone="info">{t(($) => $.creation_studio.runtime_step.qoder_note)}</Notice>
        </PanelSection>
      </>
    );
  }

  if (state === "starting") {
    return (
      <>
        {head}
        <PanelSection>
          <div role="status" className="flex items-center gap-2 text-label text-muted-foreground">
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            {waiting
              ? t(($) => $.creation_studio.runtime_step.qoder_starting_continue)
              : t(($) => $.creation_studio.runtime_step.qoder_starting)}
          </div>
        </PanelSection>
      </>
    );
  }

  if (!canManage) {
    return (
      <>
        {head}
        <PanelSection className="space-y-3">
          <div className="flex items-start gap-2.5 rounded-lg bg-muted/60 p-3 text-label">
            <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span>
              {state === "not_configured"
                ? t(($) => $.creation_studio.runtime_step.member_ask)
                : t(($) => $.creation_studio.runtime_step.member_fix)}
            </span>
          </div>
          {admins.length > 0 ? (
            <p className="text-caption text-muted-foreground">
              {t(($) => $.creation_studio.runtime_step.admins, {
                names: admins.join(", "),
              })}
            </p>
          ) : null}
          <Button variant="ghost" className="w-full" onClick={onClearSelection}>
            {t(($) => $.creation_studio.runtime_step.choose_another)}
          </Button>
        </PanelSection>
      </>
    );
  }

  if (state === "not_configured") {
    return (
      <>
        {head}
        <PanelSection className="flex min-h-0 flex-1 flex-col">
          <QoderConnectForm
            wsId={wsId}
            connection={connection}
            submitLabel={t(($) => $.creation_studio.runtime_step.connect_and_continue)}
            onConnected={onConnected}
          />
        </PanelSection>
      </>
    );
  }

  return (
    <>
      {head}
      <PanelSection className="space-y-3">
        <Notice tone={state === "error" ? "error" : "info"}>
          {state === "error"
            ? connection.lastError ||
              t(($) => $.creation_studio.runtime_step.qoder_error)
            : t(($) => $.creation_studio.runtime_step.qoder_stopped)}
        </Notice>
        <Button className="w-full" onClick={onOpenSettings}>
          {t(($) => $.creation_studio.runtime_step.open_settings)}
        </Button>
      </PanelSection>
    </>
  );
}


"use client";

import { useEffect, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  Gauge,
  Loader2,
  KeyRound,
  Pencil,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@multica/ui/components/ui/badge";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "@multica/core/auth";
import { memberListOptions } from "@multica/core/workspace/queries";
import { useWorkspaceId } from "@multica/core/hooks";
import {
  MAX_CONCURRENCY,
  MAX_RUN_TIMEOUT,
  MIN_RUN_TIMEOUT,
  QODER_REGIONS,
  qoderOptions,
  useQoderEnvironments,
  useCheckQoder,
  useSaveQoder,
  type QoderConnection,
  type QoderInput,
  type QoderRegion,
} from "@multica/core/runtimes/qoder";
import { Button } from "@multica/ui/components/ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@multica/ui/components/ui/select";
import { Input } from "@multica/ui/components/ui/input";
import { QoderConnectForm } from "./qoder-connect-form";
import { useT } from "../../i18n";

export function QoderConfiguration({
  onConnected,
}: {
  /** Called after a first-time connection succeeds. */
  onConnected?: () => void;
} = {}) {
  const wsId = useWorkspaceId();
  const query = useQuery(qoderOptions(wsId));
  const { t } = useT("runtimes");
  const user = useAuthStore((s) => s.user);
  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const member = members.find((m) => m.user_id === user?.id);
  const canManage = member?.role === "owner" || member?.role === "admin";
  if (query.isPending) return <p role="status">{t(($) => $.qoder.loading)}</p>;
  if (query.isError) return <p role="alert">{query.error.message}</p>;
  if (query.data?.available !== true)
    return <p>{t(($) => $.qoder.unavailable)}</p>;
  // A first connection only needs a token and an environment; the full form
  // is for changing a connection that already exists.
  if (!query.data.configured && canManage) {
    return (
      <QoderConnectForm
        wsId={wsId}
        connection={query.data}
        submitLabel={t(($) => $.qoder.connect.submit)}
        onConnected={() => {
          toast.success(t(($) => $.qoder.connect.connected));
          onConnected?.();
        }}
      />
    );
  }
  return <QoderForm wsId={wsId} data={query.data} />;
}

function QoderForm({
  wsId,
  data,
}: {
  wsId: string;
  data: QoderConnection;
}) {
  const { t } = useT("runtimes");
  const [input, setInput] = useState<QoderInput>(() => ({
    name: data.name || "Qoder Cloud Agent",
    baseUrl: data.baseUrl || QODER_REGIONS.global,
    environmentId: data.environmentId,
    qoderToken: "",
    githubTokens: {},
    maxConcurrency: data.maxConcurrency,
    runTimeoutMinutes: data.runTimeoutMinutes,
  }));
  const [editingToken, setEditingToken] = useState(!data.hasToken);
  const [editingRepositories, setEditingRepositories] = useState(
    !data.repositories.length,
  );
  const [repos, setRepos] = useState(() =>
    data.repositories.map((url) => ({ url, token: "" })),
  );
  const user = useAuthStore((s) => s.user);
  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const member = members.find((m) => m.user_id === user?.id);
  const canManage = member?.role === "owner" || member?.role === "admin";
  const save = useSaveQoder(wsId);
  const check = useCheckQoder(wsId);
  const environments = useQoderEnvironments(wsId);
  const { mutate: loadEnvironments, reset: resetEnvironments } = environments;
  useEffect(() => {
    resetEnvironments();
    if (!canManage || (!input.qoderToken.trim() && !data.hasToken)) return;
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        loadEnvironments(
          {
            token: input.qoderToken,
            baseUrl: input.baseUrl,
            signal: controller.signal,
          },
          {
            onSuccess: (items) => {
              if (controller.signal.aborted) return;
              setInput((old) =>
                old.environmentId || items.length !== 1
                  ? old
                  : { ...old, environmentId: items[0]!.id },
              );
            },
          },
        );
      },
      input.qoderToken ? 600 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    input.qoderToken,
    input.baseUrl,
    data.hasToken,
    canManage,
    loadEnvironments,
    resetEnvironments,
  ]);
  const region =
    (Object.keys(QODER_REGIONS) as QoderRegion[]).find(
      (key) => QODER_REGIONS[key] === input.baseUrl,
    ) ?? "global";
  const regionItems = [
    { value: "global", label: t(($) => $.qoder.region_global) },
    { value: "cn", label: t(($) => $.qoder.region_cn) },
  ];
  const environmentValid =
    !!input.environmentId &&
    environments.data?.some((item) => item.id === input.environmentId) === true;

  const [saved, setSaved] = useState(false);

  const payload = () => ({
    ...input,
    githubTokens: Object.fromEntries(
      repos.map((row) => [row.url.trim(), row.token]),
    ),
  });
  const busy = !canManage || save.isPending || check.isPending;
  const edit = (
    key: "name" | "baseUrl" | "environmentId" | "qoderToken",
    value: string,
  ) => {
    setInput((old) => ({
      ...old,
      [key]: value,
      ...(key === "qoderToken" || key === "baseUrl"
        ? { environmentId: "" }
        : {}),
    }));
    if (key === "baseUrl") setEditingToken(true);
    check.reset();
    setSaved(false);
  };
  const editLimit = (
    key: "maxConcurrency" | "runTimeoutMinutes",
    value: number,
  ) => {
    setInput((old) => ({ ...old, [key]: value }));
    setSaved(false);
  };
  return (
    <form
      className="space-y-6"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!environmentValid || busy) return;
        try {
          await save.mutateAsync(payload());
          setInput((old) => ({ ...old, qoderToken: "" }));
          setRepos((old) => old.map((row) => ({ ...row, token: "" })));
          setSaved(true);
          setEditingToken(false);
          setEditingRepositories(false);
        } catch {
          /* Mutation error is rendered below. */
        }
      }}
    >
      <section className="space-y-4">
        <h3 className="flex items-center gap-2 text-body font-medium">
          <KeyRound
            aria-hidden="true"
            className="size-4 text-muted-foreground"
          />
          {t(($) => $.qoder.connection_credentials)}
        </h3>
        <p className="text-caption leading-relaxed text-muted-foreground">
          {t(($) => $.qoder.shared_credentials_hint)}
        </p>
        <div className="space-y-2">
          <p id="qoder-region-label" className="text-caption">
            {t(($) => $.qoder.region)}
          </p>
          <Select
            items={regionItems}
            value={region}
            onValueChange={(value) =>
              value && edit("baseUrl", QODER_REGIONS[value as QoderRegion])
            }
            disabled={busy}
          >
            <SelectTrigger
              className="w-full"
              aria-labelledby="qoder-region-label"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              {regionItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="break-all text-caption text-muted-foreground">
            {t(($) => $.qoder.region_hint)} {t(($) => $.qoder.api_url)}:{" "}
            {input.baseUrl}
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block space-y-1 text-caption">
            {t(($) => $.qoder.name)}
            <Input
              value={input.name}
              required
              disabled={busy}
              onChange={(e) => edit("name", e.target.value)}
            />
          </label>
          <label className="block space-y-1 text-caption">
            {t(($) => $.qoder.token)}
            <Input
              type="password"
              autoComplete="new-password"
              value={input.qoderToken}
              required={!data.hasToken}
              placeholder={
                data.hasToken
                  ? t(($) => $.qoder.secret_saved)
                  : t(($) => $.qoder.enter_pat)
              }
              disabled={busy || !editingToken}
              onChange={(e) => edit("qoderToken", e.target.value)}
            />
          </label>
        </div>
        {data.hasToken && !editingToken && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setEditingToken(true)}
          >
            <Pencil aria-hidden="true" className="size-3.5" />
            {t(($) => $.qoder.update_credentials)}
          </Button>
        )}
        <div className="space-y-2">
          <p id="qoder-environment-label" className="text-caption">
            {t(($) => $.qoder.environment)}
          </p>
          <Select
            items={
              environments.data?.map((item) => ({
                value: item.id,
                label: item.name,
              })) ?? []
            }
            value={input.environmentId || null}
            onValueChange={(value) => edit("environmentId", value ?? "")}
            disabled={
              busy || environments.isPending || !environments.data?.length
            }
          >
            <SelectTrigger
              className="w-full"
              aria-labelledby="qoder-environment-label"
            >
              <SelectValue placeholder={t(($) => $.qoder.select_environment)} />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              {environments.data?.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-caption text-muted-foreground">
            {t(($) => $.qoder.environment_hint)}
          </p>
          {environments.isPending && (
            <p role="status" className="text-caption text-muted-foreground">
              {t(($) => $.qoder.loading)}
            </p>
          )}
          {environments.isError && (
            <p role="alert" className="text-caption text-destructive">
              {environments.error.message}
            </p>
          )}
          {environments.isSuccess && !environments.data.length && (
            <p role="status" className="text-caption text-muted-foreground">
              {t(($) => $.qoder.no_environments)}
            </p>
          )}
          {environments.isSuccess &&
            input.environmentId &&
            !environmentValid && (
              <p role="alert" className="text-caption text-destructive">
                {t(($) => $.qoder.environment_unavailable)}
              </p>
            )}
          {canManage && (input.qoderToken.trim() || data.hasToken) && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy || environments.isPending}
              onClick={() =>
                loadEnvironments(
                  { token: input.qoderToken, baseUrl: input.baseUrl },
                  {
                    onSuccess: (items) => {
                      if (!input.environmentId && items.length === 1)
                        edit("environmentId", items[0]!.id);
                    },
                  },
                )
              }
            >
              {t(($) => $.qoder.refresh_catalog)}
            </Button>
          )}
        </div>
      </section>
      <fieldset className="space-y-4 border-t pt-5">
        <legend className="flex items-center gap-2 pr-3 text-body font-medium">
          <KeyRound
            aria-hidden="true"
            className="size-4 text-muted-foreground"
          />
          {t(($) => $.qoder.repositories)}
          {data.repositories.length > 0 && (
            <Badge variant="secondary" className="bg-success/10 text-success">
              <CheckCircle2 aria-hidden="true" />
              {t(($) => $.qoder.credentials_configured)}
            </Badge>
          )}
        </legend>
        {data.repositories.length > 0 && !editingRepositories && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setEditingRepositories(true)}
          >
            <Pencil aria-hidden="true" className="size-3.5" />
            {t(($) => $.qoder.update_credentials)}
          </Button>
        )}
        <p className="text-caption text-muted-foreground">
          {t(($) => $.qoder.repositories_hint)}
        </p>
        {repos.map((row, index) => (
          <div key={index} className="space-y-3 rounded-lg bg-muted/30 p-3">
            <label className="block space-y-1 text-caption">
              {t(($) => $.qoder.github_url)}
              <Input
                type="url"
                required
                value={row.url}
                disabled={busy}
                onChange={(e) => {
                  setRepos((old) =>
                    old.map((r, i) =>
                      i === index ? { ...r, url: e.target.value } : r,
                    ),
                  );
                  setEditingRepositories(true);
                  check.reset();
                  setSaved(false);
                }}
              />
            </label>
            <label className="block space-y-1 text-caption">
              {t(($) => $.qoder.github_token)}
              <Input
                type="password"
                autoComplete="new-password"
                value={row.token}
                placeholder={
                  data.repositories.includes(row.url)
                    ? t(($) => $.qoder.secret_saved)
                    : t(($) => $.qoder.enter_pat)
                }
                disabled={busy || !editingRepositories}
                onChange={(e) => {
                  setRepos((old) =>
                    old.map((r, i) =>
                      i === index ? { ...r, token: e.target.value } : r,
                    ),
                  );
                  check.reset();
                  setSaved(false);
                }}
              />
            </label>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setRepos((old) => old.filter((_, i) => i !== index));
                check.reset();
                setSaved(false);
              }}
            >
              {t(($) => $.qoder.remove)}
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => {
            setRepos((old) => [...old, { url: "", token: "" }]);
            setEditingRepositories(true);
            check.reset();
            setSaved(false);
          }}
        >
          {t(($) => $.qoder.add_repository)}
        </Button>
      </fieldset>
      <fieldset className="space-y-4 border-t pt-5">
        <legend className="flex items-center gap-2 pr-3 text-body font-medium">
          <Gauge aria-hidden="true" className="size-4 text-muted-foreground" />
          {t(($) => $.qoder.execution)}
        </legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block space-y-1 text-caption">
            {t(($) => $.qoder.concurrency)}
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_CONCURRENCY}
              step={1}
              required
              value={input.maxConcurrency}
              disabled={busy}
              onChange={(e) =>
                editLimit("maxConcurrency", e.target.valueAsNumber || 0)
              }
            />
            <span className="block text-muted-foreground">
              {t(($) => $.qoder.concurrency_hint)}
            </span>
          </label>
          <label className="block space-y-1 text-caption">
            {t(($) => $.qoder.run_timeout)}
            <Input
              type="number"
              inputMode="numeric"
              min={MIN_RUN_TIMEOUT}
              max={MAX_RUN_TIMEOUT}
              step={5}
              required
              value={input.runTimeoutMinutes}
              disabled={busy}
              onChange={(e) =>
                editLimit("runTimeoutMinutes", e.target.valueAsNumber || 0)
              }
            />
            <span className="block text-muted-foreground">
              {t(($) => $.qoder.run_timeout_hint)}
            </span>
          </label>
        </div>
        <div className="flex items-start gap-2 rounded-lg bg-muted/50 p-3 text-caption">
          <ShieldCheck
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          />
          <div className="min-w-0 space-y-1">
            <p className="font-medium">
              {t(($) => $.qoder.data_disclosure_title)}
            </p>
            <p className="leading-relaxed text-muted-foreground">
              {t(($) => $.qoder.data_disclosure)}
            </p>
          </div>
        </div>
      </fieldset>
      {save.error && (
        <p role="alert" className="text-caption text-destructive">
          {save.error.message}
        </p>
      )}
      <div aria-live="polite" aria-atomic="true">
        {(check.isPending || check.isSuccess || check.isError) && (
          <div
            className={`flex items-start gap-2 rounded-lg border p-3 text-caption ${check.isError ? "border-destructive/20 bg-destructive/5 text-destructive" : check.isSuccess ? "border-success/20 bg-success/5 text-success" : "border-border bg-muted/50 text-muted-foreground"}`}
          >
            {check.isPending ? (
              <Loader2
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 animate-spin"
              />
            ) : check.isSuccess ? (
              <CheckCircle2
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0"
              />
            ) : (
              <CircleAlert
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0"
              />
            )}
            <div className="min-w-0 space-y-1">
              <p className="font-medium">
                {check.isPending
                  ? t(($) => $.qoder.checking)
                  : check.isSuccess
                    ? t(($) => $.qoder.check_passed)
                    : t(($) => $.qoder.check_failed)}
              </p>
              {check.isSuccess && (
                <p className="text-muted-foreground">
                  {t(($) => $.qoder.check_success)}
                </p>
              )}
              {check.isError && (
                <p className="break-words">{check.error.message}</p>
              )}
            </div>
          </div>
        )}
      </div>
      {saved && (
        <p role="status" className="text-caption">
          {t(($) => $.qoder.saved)}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={busy || !environmentValid}
          aria-busy={check.isPending}
          onClick={(e) => {
            if (!e.currentTarget.form?.reportValidity()) return;
            check.mutate(payload(), {
              onSuccess: () => toast.success(t(($) => $.qoder.check_passed)),
              onError: () => toast.error(t(($) => $.qoder.check_failed)),
            });
          }}
        >
          {check.isPending && (
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
          )}
          {check.isPending
            ? t(($) => $.qoder.checking)
            : t(($) => $.qoder.check)}
        </Button>
        <Button type="submit" aria-busy={save.isPending} disabled={busy || !environmentValid}>
          {save.isPending ? t(($) => $.qoder.working) : t(($) => $.qoder.save)}
        </Button>
      </div>
    </form>
  );
}

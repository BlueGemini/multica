"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, clientErrorMessage } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import { useIssueStatuses } from "@multica/core/issue-statuses/hooks";
import { useSetProjectWorkflowHandoff, workflowNextStatus } from "@multica/core/issue-workflows";
import { agentListOptions, memberListOptions, squadListOptions } from "@multica/core/workspace/queries";
import type { IssueWorkflow, IssueWorkflowHandlerType, IssueWorkflowStep, Project } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multica/ui/components/ui/select";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { cn } from "@multica/ui/lib/utils";
import { ActorAvatar } from "../common/actor-avatar";
import { StatusIcon } from "../issues/components/status-icon";
import { useStatusLabel } from "../issues/utils/status-label";
import { useT } from "../i18n";

const HANDLER_TYPES: IssueWorkflowHandlerType[] = ["none", "agent", "squad", "member", "project_lead", "creator"];
const NOT_SET = "__not_set__";

function sameStep(a: IssueWorkflowStep, b: IssueWorkflowStep): boolean {
  return (
    a.handler.type === b.handler.type &&
    (a.handler.id ?? "") === (b.handler.id ?? "") &&
    a.instructions === b.instructions &&
    (a.next_status_key ?? "") === (b.next_status_key ?? "") &&
    (a.back_status_key ?? "") === (b.back_status_key ?? "")
  );
}

/**
 * One column's handoff for one project (MUL-7420): who entering the column
 * hands the issue to, what they are told, and where it goes next. The board's
 * column popover and the full-flow panel both render this form.
 */
export function ProjectHandoffForm({
  project,
  workflow,
  statusKey,
  canEdit,
  onSaved,
}: {
  project: Project;
  workflow: IssueWorkflow;
  statusKey: string;
  canEdit: boolean;
  onSaved?: () => void;
}) {
  const { t } = useT("issues");
  const saved = useMemo<IssueWorkflowStep>(
    () =>
      workflow.steps.find((s) => s.status_key === statusKey) ?? {
        status_key: statusKey,
        handler: { type: "none" },
        instructions: "",
      },
    [statusKey, workflow.steps],
  );
  const [draft, setDraft] = useState<IssueWorkflowStep>(saved);
  const [previewOpen, setPreviewOpen] = useState(false);
  const setHandoff = useSetProjectWorkflowHandoff();
  useEffect(() => setDraft(saved), [saved]);

  const handler = draft.handler;
  const needsTarget = (handler.type === "agent" || handler.type === "squad" || handler.type === "member") && !handler.id;
  const dirty = !sameStep(draft, saved);

  const save = async () => {
    try {
      await setHandoff.mutateAsync({
        projectId: project.id,
        statusKey,
        handler: draft.handler,
        instructions: draft.handler.type === "none" ? "" : draft.instructions,
        next_status_key: draft.next_status_key,
        back_status_key: draft.back_status_key,
      });
      toast.success(t(($) => $.workflows.handoff.saved));
      onSaved?.();
    } catch (err) {
      toast.error(clientErrorMessage(err) ?? t(($) => $.workflows.handoff.error));
    }
  };

  return (
    <div className="space-y-4">
      <HandoffFields
        step={draft}
        workflow={workflow}
        canEdit={canEdit}
        onPatch={(patch) => setDraft((d) => ({ ...d, ...patch }))}
        onPreview={() => setPreviewOpen(true)}
      />
      {canEdit ? (
        <div className="flex items-center justify-end gap-2">
          {dirty && (
            <Button variant="ghost" size="sm" onClick={() => setDraft(saved)}>
              {t(($) => $.workflows.editor.cancel)}
            </Button>
          )}
          <Button size="sm" onClick={() => void save()} disabled={!dirty || needsTarget || setHandoff.isPending}>
            {setHandoff.isPending && <Spinner className="size-3.5" />}
            {t(($) => $.workflows.editor.save)}
          </Button>
        </div>
      ) : (
        <p className="text-caption text-muted-foreground">{t(($) => $.workflows.handoff.read_only)}</p>
      )}
      <BriefPreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        project={project}
        step={draft}
      />
    </div>
  );
}

/** The handoff fields of one column; the caller owns saving. */
export function HandoffFields({
  step,
  workflow,
  canEdit,
  onPatch,
  onPreview,
}: {
  step: IssueWorkflowStep;
  workflow: Pick<IssueWorkflow, "steps">;
  canEdit: boolean;
  onPatch: (patch: Partial<IssueWorkflowStep>) => void;
  onPreview?: () => void;
}) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const catalog = useIssueStatuses(wsId);
  const labelOf = useStatusLabel(wsId);
  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const { data: squads = [] } = useQuery(squadListOptions(wsId));
  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const type = step.handler.type;
  const handsOff = type !== "none";

  const statusIcon = (key: string) => (
    <StatusIcon
      status={key}
      category={catalog.categoryOf(key)}
      color={catalog.colorOf(key)}
      icon={catalog.iconOf(key)}
      className="h-3.5 w-3.5 shrink-0"
    />
  );

  const targets =
    type === "agent"
      ? agents.filter((a) => !a.archived_at).map((a) => ({ id: a.id, name: a.name }))
      : type === "squad"
        ? squads.map((s) => ({ id: s.id, name: s.name }))
        : type === "member"
          ? members.map((m) => ({ id: m.user_id, name: m.name }))
          : [];
  const targetType = type === "agent" || type === "squad" || type === "member" ? type : null;
  const targetKind = targetType ? t(($) => $.workflows.editor[`target_${targetType}`]) : "";
  const nextDefault = workflowNextStatus({ steps: workflow.steps.map((s) => ({ ...s, next_status_key: undefined })) }, step.status_key);
  const others = workflow.steps.filter((s) => s.status_key !== step.status_key).map((s) => s.status_key);

  return (
    <div className="space-y-4">
      <Field
        label={t(($) => $.workflows.editor.on_enter)}
        hint={
          type === "project_lead"
            ? t(($) => $.workflows.editor.handler_hint_lead) + " " + t(($) => $.workflows.editor.handler_hint_on)
            : type === "creator"
              ? t(($) => $.workflows.editor.handler_hint_creator) + " " + t(($) => $.workflows.editor.handler_hint_on)
              : handsOff
                ? t(($) => $.workflows.editor.handler_hint_on)
                : t(($) => $.workflows.editor.handler_hint_off)
        }
      >
        <div
          role="radiogroup"
          aria-label={t(($) => $.workflows.editor.on_enter)}
          className="inline-flex max-w-full flex-wrap gap-0.5 rounded-lg bg-muted p-0.5"
        >
          {HANDLER_TYPES.map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={type === option}
              disabled={!canEdit}
              onClick={() => onPatch({ handler: { type: option } })}
              className={cn(
                "rounded-md px-2.5 py-1 text-caption transition-colors",
                type === option
                  ? "bg-background font-medium text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t(($) => $.workflows.handler[option])}
            </button>
          ))}
        </div>
        {targetType && (
          <Select
            items={targets.map((target) => ({ value: target.id, label: target.name }))}
            value={step.handler.id ?? ""}
            disabled={!canEdit}
            onValueChange={(value) => value && onPatch({ handler: { type: targetType, id: value } })}
          >
            <SelectTrigger aria-label={targetKind} className="mt-2 w-full">
              {step.handler.id ? (
                <span className="flex min-w-0 items-center gap-2">
                  <ActorAvatar actorType={targetType} actorId={step.handler.id} size="xs" profileLink={false} />
                  <span className="truncate">{targets.find((x) => x.id === step.handler.id)?.name ?? ""}</span>
                  <span className="truncate text-caption text-muted-foreground">{targetKind}</span>
                </span>
              ) : (
                <SelectValue placeholder={t(($) => $.workflows.editor.choose_target)} />
              )}
            </SelectTrigger>
            <SelectContent>
              {targets.map((target) => (
                <SelectItem key={target.id} value={target.id}>
                  <span className="flex items-center gap-2">
                    <ActorAvatar actorType={targetType} actorId={target.id} size="xs" profileLink={false} />
                    <span>{target.name}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Field>

      {handsOff && (
        <>
          <Field
            label={t(($) => $.workflows.editor.instructions)}
            hint={t(($) => $.workflows.editor.instructions_hint)}
            htmlFor={`workflow-handoff-instructions-${step.status_key}`}
          >
            <Textarea
              id={`workflow-handoff-instructions-${step.status_key}`}
              rows={4}
              maxLength={8000}
              readOnly={!canEdit}
              value={step.instructions}
              placeholder={t(($) => $.workflows.editor.instructions_placeholder)}
              onChange={(e) => onPatch({ instructions: e.target.value })}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            {(["next", "back"] as const).map((kind) => {
              const field = kind === "next" ? "next_status_key" : "back_status_key";
              const value = step[field];
              const unsetLabel =
                kind === "next" && nextDefault
                  ? t(($) => $.workflows.handoff.next_default, { status: labelOf(nextDefault) })
                  : t(($) => $.workflows.editor.none_option);
              const options = [{ value: NOT_SET, label: unsetLabel }, ...others.map((key) => ({ value: key, label: labelOf(key) }))];
              return (
                <div key={kind} className="min-w-0 space-y-1.5">
                  <span className="block text-caption font-medium">{t(($) => $.workflows.editor[kind])}</span>
                  <Select
                    items={options}
                    value={value ?? NOT_SET}
                    disabled={!canEdit}
                    onValueChange={(next) => onPatch({ [field]: !next || next === NOT_SET ? undefined : next })}
                  >
                    <SelectTrigger aria-label={t(($) => $.workflows.editor[kind])} className="w-full">
                      {value ? (
                        <span className="flex min-w-0 items-center gap-2">
                          {statusIcon(value)}
                          <span className="truncate">{labelOf(value)}</span>
                        </span>
                      ) : (
                        <span className="truncate text-muted-foreground">{unsetLabel}</span>
                      )}
                    </SelectTrigger>
                    <SelectContent>
                      {options.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          <span className="flex items-center gap-2">
                            {option.value !== NOT_SET && statusIcon(option.value)}
                            <span>{option.label}</span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              );
            })}
          </div>
          <p className="text-caption leading-5 text-muted-foreground">
            {t(($) => $.workflows.editor.next_hint)}{" "}
            {onPreview && (
              <button type="button" onClick={onPreview} className="text-brand hover:underline">
                {t(($) => $.workflows.editor.preview_brief)}
              </button>
            )}
          </p>
        </>
      )}
    </div>
  );
}

function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-caption font-medium">
        {label}
      </label>
      {children}
      {hint && <p className="text-caption leading-5 text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** The brief a column's handler receives, rendered by the server from the unsaved handoff. */
function BriefPreviewDialog({
  open,
  onOpenChange,
  project,
  step,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  step: IssueWorkflowStep;
}) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const labelOf = useStatusLabel(wsId);
  const { data: brief, isPending } = useQuery({
    queryKey: ["issue-workflows", wsId, "brief-preview", project.id, JSON.stringify(step)],
    queryFn: () =>
      api.previewProjectWorkflowBrief(project.id, {
        status_key: step.status_key,
        handler: step.handler,
        instructions: step.instructions,
        next_status_key: step.next_status_key,
        back_status_key: step.back_status_key,
      }),
    enabled: open,
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t(($) => $.workflows.editor.preview_title, { status: labelOf(step.status_key) })}</DialogTitle>
          <DialogDescription>{t(($) => $.workflows.editor.preview_description)}</DialogDescription>
        </DialogHeader>
        <BriefBlock brief={brief} loading={isPending} />
      </DialogContent>
    </Dialog>
  );
}

/** A handoff brief, shown as the agent reads it. */
export function BriefBlock({ brief, loading }: { brief: string | undefined; loading?: boolean }) {
  return (
    <div className="max-h-[50dvh] overflow-auto rounded-lg border border-surface-border bg-muted/40 p-4">
      {loading ? (
        <Spinner className="size-4" />
      ) : (
        <pre className="whitespace-pre-wrap break-words font-mono text-caption leading-5 text-foreground">{brief}</pre>
      )}
    </div>
  );
}

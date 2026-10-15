"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, clientErrorMessage } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import { useIssueStatuses } from "@multica/core/issue-statuses/hooks";
import { useSetWorkflowHandoff, workflowNextStatus } from "@multica/core/issue-workflows";
import { agentListOptions, memberListOptions } from "@multica/core/workspace/queries";
import type { IssueWorkflow, IssueWorkflowStep } from "@multica/core/types";
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
} from "@multica/ui/components/ui/select";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { cn } from "@multica/ui/lib/utils";
import { ChevronDown } from "lucide-react";
import { ActorAvatar } from "../common/actor-avatar";
import { PickerEmpty, PickerItem, PickerSection, PropertyPicker } from "../issues/components/pickers/property-picker";
import { StatusIcon } from "../issues/components/status-icon";
import { useStatusLabel } from "../issues/utils/status-label";
import { useT } from "../i18n";

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
 * One column's handoff (MUL-7420): who entering the column hands the issue
 * to, what they are told, and where it goes next. It belongs to the workflow,
 * so saving applies to every project using it. The board's column popover and
 * the full-flow panel both render this form.
 */
export function WorkflowHandoffForm({
  workflow,
  statusKey,
  canEdit,
  projectId,
  onSaved,
}: {
  workflow: IssueWorkflow;
  statusKey: string;
  canEdit: boolean;
  /** The project the brief preview is for. */
  projectId?: string;
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
  const setHandoff = useSetWorkflowHandoff();
  useEffect(() => setDraft(saved), [saved]);

  const handler = draft.handler;
  const needsTarget = (handler.type === "agent" || handler.type === "member") && !handler.id;
  const dirty = !sameStep(draft, saved);

  const save = async () => {
    try {
      await setHandoff.mutateAsync({
        workflowId: workflow.id,
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
        workflowId={workflow.id}
        projectId={projectId}
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
  const labelOf = useStatusLabel(wsId);
  const handsOff = step.handler.type !== "none";
  const [more, setMore] = useState(!!step.back_status_key || !!step.next_status_key);
  const nextDefault = workflowNextStatus({ steps: workflow.steps.map((s) => ({ ...s, next_status_key: undefined })) }, step.status_key);
  const next = step.next_status_key ?? nextDefault;

  return (
    <div className="space-y-4">
      <Field
        label={t(($) => $.workflows.handoff.to)}
        hint={handsOff ? t(($) => $.workflows.handoff.hint_on) : t(($) => $.workflows.handoff.hint_off)}
      >
        <HandlerPicker value={step.handler} disabled={!canEdit} onChange={(handler) => onPatch({ handler })} />
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
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted-foreground">
            <span>
              {next
                ? t(($) => $.workflows.handoff.then, { status: labelOf(next) })
                : t(($) => $.workflows.handoff.then_none)}
            </span>
            <button
              type="button"
              aria-expanded={more}
              onClick={() => setMore((v) => !v)}
              className="inline-flex items-center gap-0.5 hover:text-foreground"
            >
              {t(($) => $.workflows.handoff.more)}
              <ChevronDown aria-hidden className={cn("size-3 transition-transform", more && "rotate-180")} />
            </button>
            {onPreview && (
              <button type="button" onClick={onPreview} className="ml-auto text-brand hover:underline">
                {t(($) => $.workflows.editor.preview_brief)}
              </button>
            )}
          </div>
          {more && <NextBackFields step={step} workflow={workflow} canEdit={canEdit} nextDefault={nextDefault} onPatch={onPatch} />}
        </>
      )}
    </div>
  );
}

/**
 * Who entering a column hands the issue to: nobody, the project lead, or one
 * agent or member. Squads are left out on purpose — they route work
 * themselves. (MUL-7420)
 */
function HandlerPicker({
  value,
  disabled,
  onChange,
}: {
  value: IssueWorkflowStep["handler"];
  disabled: boolean;
  onChange: (handler: IssueWorkflowStep["handler"]) => void;
}) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const matches = (name: string) => !q || name.toLowerCase().includes(q);
  const agentRows = agents.filter((a) => !a.archived_at && matches(a.name));
  const memberRows = members.filter((m) => matches(m.name));
  const leadLabel = t(($) => $.workflows.handler.project_lead);
  const noneLabel = t(($) => $.workflows.handoff.none);
  const pick = (handler: IssueWorkflowStep["handler"]) => {
    onChange(handler);
    setOpen(false);
  };
  const is = (type: string, id?: string) => value.type === type && (id === undefined || value.id === id);
  const current =
    value.type === "agent" || value.type === "member"
      ? (value.type === "agent" ? agents.find((a) => a.id === value.id)?.name : members.find((m) => m.user_id === value.id)?.name) ?? ""
      : value.type === "project_lead"
        ? leadLabel
        : noneLabel;

  return (
    <PropertyPicker
      open={open && !disabled}
      onOpenChange={setOpen}
      align="start"
      width="w-72"
      searchable
      searchPlaceholder={t(($) => $.workflows.handoff.search)}
      onSearchChange={setQuery}
      triggerRender={
        <button
          type="button"
          disabled={disabled}
          aria-label={t(($) => $.workflows.handoff.to)}
          className="flex h-9 w-full items-center gap-2 rounded-md border border-input bg-transparent px-3 text-left text-body disabled:cursor-default"
        />
      }
      trigger={
        <>
          {(value.type === "agent" || value.type === "member") && value.id && (
            <ActorAvatar actorType={value.type} actorId={value.id} size="xs" profileLink={false} />
          )}
          <span className={cn("min-w-0 flex-1 truncate", value.type === "none" && "text-muted-foreground")}>{current}</span>
          <ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        </>
      }
    >
      {!q && (
        <>
          <PickerItem emptyValue selected={is("none")} onClick={() => pick({ type: "none" })}>
            <span className="truncate">{noneLabel}</span>
          </PickerItem>
          <PickerItem selected={is("project_lead")} onClick={() => pick({ type: "project_lead" })}>
            <span className="truncate">{leadLabel}</span>
          </PickerItem>
        </>
      )}
      {agentRows.length > 0 && (
        <PickerSection label={t(($) => $.workflows.handoff.agents)}>
          {agentRows.map((agent) => (
            <PickerItem key={agent.id} selected={is("agent", agent.id)} onClick={() => pick({ type: "agent", id: agent.id })}>
              <ActorAvatar actorType="agent" actorId={agent.id} size="xs" profileLink={false} />
              <span className="truncate">{agent.name}</span>
            </PickerItem>
          ))}
        </PickerSection>
      )}
      {memberRows.length > 0 && (
        <PickerSection label={t(($) => $.workflows.handoff.members)}>
          {memberRows.map((member) => (
            <PickerItem
              key={member.user_id}
              selected={is("member", member.user_id)}
              onClick={() => pick({ type: "member", id: member.user_id })}
            >
              <ActorAvatar actorType="member" actorId={member.user_id} size="xs" profileLink={false} />
              <span className="truncate">{member.name}</span>
            </PickerItem>
          ))}
        </PickerSection>
      )}
      {q && agentRows.length === 0 && memberRows.length === 0 && <PickerEmpty />}
    </PropertyPicker>
  );
}

function NextBackFields({
  step,
  workflow,
  canEdit,
  nextDefault,
  onPatch,
}: {
  step: IssueWorkflowStep;
  workflow: Pick<IssueWorkflow, "steps">;
  canEdit: boolean;
  nextDefault: string | null;
  onPatch: (patch: Partial<IssueWorkflowStep>) => void;
}) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const catalog = useIssueStatuses(wsId);
  const labelOf = useStatusLabel(wsId);
  const others = workflow.steps.filter((s) => s.status_key !== step.status_key).map((s) => s.status_key);
  const statusIcon = (key: string) => (
    <StatusIcon
      status={key}
      category={catalog.categoryOf(key)}
      color={catalog.colorOf(key)}
      icon={catalog.iconOf(key)}
      className="h-3.5 w-3.5 shrink-0"
    />
  );

  return (
    <div className="space-y-2">
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
                onValueChange={(v) => onPatch({ [field]: !v || v === NOT_SET ? undefined : v })}
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
      <p className="text-caption leading-5 text-muted-foreground">{t(($) => $.workflows.editor.next_hint)}</p>
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

/**
 * The brief a column's handler receives, rendered by the server from the
 * unsaved handoff on the saved workflow.
 */
export function BriefPreviewDialog({
  open,
  onOpenChange,
  workflowId,
  projectId,
  step,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workflowId: string;
  projectId?: string;
  step: IssueWorkflowStep;
}) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const labelOf = useStatusLabel(wsId);
  const { data: brief, isPending } = useQuery({
    queryKey: ["issue-workflows", wsId, "brief-preview", workflowId, projectId ?? "", JSON.stringify(step)],
    queryFn: () =>
      api.previewWorkflowBrief(workflowId, {
        status_key: step.status_key,
        ...(projectId ? { project_id: projectId } : {}),
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

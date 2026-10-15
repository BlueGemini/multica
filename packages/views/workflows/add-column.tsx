"use client";

import { useState, type ReactElement } from "react";
import { toast } from "sonner";
import { clientErrorMessage } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import { useIssueStatuses } from "@multica/core/issue-statuses/hooks";
import { statusColumnKeys } from "@multica/core/issues";
import { useAddProjectWorkflowColumn, workflowMiddleKeys } from "@multica/core/issue-workflows";
import type { IssueWorkflow, Project } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@multica/ui/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@multica/ui/components/ui/select";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { cn } from "@multica/ui/lib/utils";
import { StatusIcon } from "../issues/components/status-icon";
import { useStatusLabel } from "../issues/utils/status-label";
import { useT } from "../i18n";
import { useWorkflowPermissions } from "./permissions";

const NEW_STATUS = "__new__";

/**
 * Adds a column to a project's board (MUL-7420): a status from the library or
 * a new one. When other projects share the board's workflow, the column goes
 * to this project only — the server gives it its own copy first — unless an
 * admin chooses to change the shared workflow.
 */
export function AddColumnPopover({
  project,
  workflow,
  trigger,
}: {
  project: Project;
  workflow: IssueWorkflow;
  trigger: ReactElement;
}) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const catalog = useIssueStatuses(wsId);
  const labelOf = useStatusLabel(wsId);
  const { isAdmin } = useWorkflowPermissions(project);
  const addColumn = useAddProjectWorkflowColumn();
  const [open, setOpen] = useState(false);
  const columns = workflow.steps.map((s) => s.status_key);
  const addable = statusColumnKeys(catalog).filter((key) => !columns.includes(key));
  const [choice, setChoice] = useState<string>(addable[0] ?? NEW_STATUS);
  const [name, setName] = useState("");
  const shared = workflow.is_default || workflow.project_ids.length > 1;
  const [scope, setScope] = useState<"project" | "workflow">("project");
  const middle = workflowMiddleKeys(workflow);
  const after = middle[middle.length - 1] ?? "todo";

  const reset = () => {
    setChoice(addable[0] ?? NEW_STATUS);
    setName("");
    setScope("project");
  };

  const submit = async () => {
    try {
      await addColumn.mutateAsync({
        projectId: project.id,
        ...(choice === NEW_STATUS ? { new_status: { name: name.trim() } } : { status_key: choice }),
        scope: shared ? scope : "project",
        after_status_key: after,
      });
      toast.success(t(($) => $.workflows.columns.added));
      setOpen(false);
      reset();
    } catch (err) {
      toast.error(clientErrorMessage(err) ?? t(($) => $.workflows.columns.error));
    }
  };

  const statusIcon = (key: string) => (
    <StatusIcon
      status={key}
      category={catalog.categoryOf(key)}
      color={catalog.colorOf(key)}
      icon={catalog.iconOf(key)}
      className="h-3.5 w-3.5 shrink-0"
    />
  );
  const options = [
    ...addable.map((key) => ({ value: key, label: labelOf(key) })),
    { value: NEW_STATUS, label: t(($) => $.workflows.columns.new_status) },
  ];
  const canSubmit = choice === NEW_STATUS ? name.trim().length > 0 : addable.includes(choice);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <PopoverTrigger render={trigger} />
      <PopoverContent align="start" className="w-80 space-y-3 p-4">
        <p className="text-body font-medium">{t(($) => $.workflows.columns.title)}</p>
        <Select items={options} value={choice} onValueChange={(value) => value && setChoice(value)}>
          <SelectTrigger aria-label={t(($) => $.workflows.columns.status)} className="w-full">
            {choice === NEW_STATUS ? (
              <span>{t(($) => $.workflows.columns.new_status)}</span>
            ) : (
              <span className="flex min-w-0 items-center gap-2">
                {statusIcon(choice)}
                <span className="truncate">{labelOf(choice)}</span>
              </span>
            )}
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                <span className="flex items-center gap-2">
                  {option.value !== NEW_STATUS && statusIcon(option.value)}
                  <span>{option.label}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {choice === NEW_STATUS && (
          <Input
            autoFocus
            maxLength={64}
            value={name}
            placeholder={t(($) => $.workflows.columns.name_placeholder)}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && canSubmit && void submit()}
          />
        )}
        {shared && (
          <div role="radiogroup" aria-label={t(($) => $.workflows.columns.scope)} className="space-y-1.5">
            {(["project", "workflow"] as const).map((option) => {
              const disabled = option === "workflow" && !isAdmin;
              return (
                <label
                  key={option}
                  className={cn(
                    "flex cursor-pointer items-start gap-2 rounded-md border border-surface-border px-2.5 py-2 text-caption",
                    scope === option && "border-foreground/20 bg-accent/50",
                    disabled && "cursor-not-allowed opacity-50",
                  )}
                >
                  <input
                    type="radio"
                    name="workflow-column-scope"
                    className="mt-0.5"
                    checked={scope === option}
                    disabled={disabled}
                    onChange={() => setScope(option)}
                  />
                  <span className="min-w-0">
                    <span className="block font-medium">
                      {option === "project"
                        ? t(($) => $.workflows.columns.scope_project, { project: project.title })
                        : t(($) => $.workflows.columns.scope_workflow, { workflow: workflow.name })}
                    </span>
                    <span className="block text-muted-foreground">
                      {option === "project"
                        ? t(($) => $.workflows.columns.scope_project_hint)
                        : disabled
                          ? t(($) => $.workflows.columns.scope_workflow_admin)
                          : t(($) => $.workflows.columns.scope_workflow_hint)}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        )}
        <div className="flex justify-end">
          <Button size="sm" onClick={() => void submit()} disabled={!canSubmit || addColumn.isPending}>
            {addColumn.isPending && <Spinner className="size-3.5" />}
            {t(($) => $.workflows.columns.add)}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

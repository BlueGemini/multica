"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, LayoutTemplate, ListTree, Plus, Settings, Workflow } from "lucide-react";
import { toast } from "sonner";
import { clientErrorMessage } from "@multica/core/api";
import { useFeatureEnabled } from "@multica/core/config";
import { PROJECT_WORKFLOWS_V1_FLAG } from "@multica/core/feature-flags";
import { useWorkspaceId } from "@multica/core/hooks";
import { useIssueStatuses } from "@multica/core/issue-statuses/hooks";
import {
  resolveProjectWorkflow,
  statusAcceptsHandoff,
  useCreateIssueWorkflow,
  useIssueWorkflows,
} from "@multica/core/issue-workflows";
import { useWorkspacePaths } from "@multica/core/paths";
import { projectListOptions } from "@multica/core/projects/queries";
import type { IssueWorkflow, Project } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@multica/ui/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@multica/ui/components/ui/sheet";
import { cn } from "@multica/ui/lib/utils";
import { ActorAvatar } from "../common/actor-avatar";
import { StatusIcon } from "../issues/components/status-icon";
import { useStatusLabel } from "../issues/utils/status-label";
import { useNavigation } from "../navigation";
import { useT } from "../i18n";
import { AddColumnPopover } from "./add-column";
import { ProjectHandoffForm } from "./handoff-form";
import { useWorkflowPermissions } from "./permissions";
import { useProjectWorkflowSwitch, WorkflowChoiceItems } from "./project-workflow-row";
import { stepHandlerActor, useStepHandlerLabel } from "./step-handler";
import { WORKFLOW_TEMPLATES, templateSteps, type WorkflowTemplateId } from "./templates";

/**
 * The project board's "Workflow" menu (MUL-7420): open the full flow, switch
 * workflows, or start one from a template. Shown while workflows are on, or
 * when the project already names one.
 */
export function ProjectWorkflowMenu({ project }: { project: Project }) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const navigation = useNavigation();
  const paths = useWorkspacePaths();
  const enabled = useFeatureEnabled(PROJECT_WORKFLOWS_V1_FLAG, false);
  const { workflows } = useIssueWorkflows(wsId);
  const { canManageProject, isAdmin } = useWorkflowPermissions(project);
  const { choose, busy, dialog } = useProjectWorkflowSwitch(project);
  const createWorkflow = useCreateIssueWorkflow();
  const [flowOpen, setFlowOpen] = useState(false);
  const workflow = resolveProjectWorkflow(workflows, project);

  if (!workflow || (!enabled && !project.workflow_id)) return null;

  const fromTemplate = async (id: WorkflowTemplateId) => {
    const template = WORKFLOW_TEMPLATES.find((tpl) => tpl.id === id);
    if (!template) return;
    const templateName = t(($) => $.workflows.templates[id].name);
    const taken = new Set(workflows.map((w) => w.name.toLowerCase()));
    const name = taken.has(templateName.toLowerCase()) ? `${templateName} · ${project.title}`.slice(0, 64) : templateName;
    try {
      const created = await createWorkflow.mutateAsync({
        name,
        project_id: project.id,
        steps: templateSteps(template, (status) =>
          t(($) => ($.workflows.templates[id].statuses as Record<string, string>)[status] ?? status),
        ),
      });
      await choose(created);
    } catch (err) {
      toast.error(clientErrorMessage(err) ?? t(($) => $.workflows.editor.error));
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={busy || createWorkflow.isPending}
          render={
            <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
              <Workflow className="size-3.5" />
              <span className="max-w-40 truncate">{workflow.name}</span>
              <ChevronDown className="size-3" />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuItem onClick={() => setFlowOpen(true)}>
            <ListTree className="size-3.5" />
            {t(($) => $.workflows.menu.view_flow)}
          </DropdownMenuItem>
          {canManageProject && (
            <>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Workflow className="size-3.5" />
                  {t(($) => $.workflows.menu.switch)}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-80">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>{t(($) => $.workflows.project.picker_title)}</DropdownMenuLabel>
                    <WorkflowChoiceItems project={project} onChoose={(w) => void choose(w)} />
                  </DropdownMenuGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              {enabled && (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <LayoutTemplate className="size-3.5" />
                    {t(($) => $.workflows.menu.from_template)}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-72">
                    {WORKFLOW_TEMPLATES.map((template) => (
                      <DropdownMenuItem
                        key={template.id}
                        className="items-start py-2"
                        onClick={() => void fromTemplate(template.id)}
                      >
                        <span className="min-w-0">
                          <span className="block font-medium">{t(($) => $.workflows.templates[template.id].name)}</span>
                          <span className="block text-caption text-muted-foreground">
                            {t(($) => $.workflows.templates[template.id].summary)}
                          </span>
                        </span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}
            </>
          )}
          {isAdmin && enabled && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => navigation.push(`${paths.settings()}?tab=workflows`)}>
                <Settings className="size-3.5" />
                {t(($) => $.workflows.project.manage)}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog}
      <WorkflowFlowSheet open={flowOpen} onOpenChange={setFlowOpen} project={project} workflow={workflow} />
    </>
  );
}

/**
 * The project's whole flow in one panel (MUL-7420): every column, who it
 * hands to, and the same handoff form the column header opens.
 */
export function WorkflowFlowSheet({
  open,
  onOpenChange,
  project,
  workflow,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  workflow: IssueWorkflow;
}) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const { data: projects = [] } = useQuery(projectListOptions(wsId));
  const enabled = useFeatureEnabled(PROJECT_WORKFLOWS_V1_FLAG, false);
  const { canManageProject } = useWorkflowPermissions(project);
  const [expanded, setExpanded] = useState<string | null>(null);
  const sharedWith = workflow.is_default
    ? projects.filter((p) => !p.workflow_id && p.id !== project.id).length
    : workflow.project_ids.filter((id) => id !== project.id).length;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[440px] overflow-y-auto p-5 sm:max-w-[440px]">
        <SheetHeader className="p-0">
          <SheetTitle>{t(($) => $.workflows.flow.title, { workflow: workflow.name })}</SheetTitle>
          <SheetDescription>
            {sharedWith > 0
              ? t(($) => $.workflows.flow.scope_shared, { count: sharedWith, workflow: workflow.name })
              : t(($) => $.workflows.flow.scope_own)}
          </SheetDescription>
        </SheetHeader>
        <ol className="space-y-1.5">
          {workflow.steps.map((step) => (
            <FlowRow
              key={step.status_key}
              project={project}
              workflow={workflow}
              statusKey={step.status_key}
              canEdit={canManageProject}
              expanded={expanded === step.status_key}
              onToggle={() => setExpanded((current) => (current === step.status_key ? null : step.status_key))}
            />
          ))}
        </ol>
        {canManageProject && enabled && (
          <AddColumnPopover
            project={project}
            workflow={workflow}
            trigger={
              <Button variant="outline" size="sm" className="gap-1.5 self-start">
                <Plus className="size-3.5" />
                {t(($) => $.workflows.columns.add_column)}
              </Button>
            }
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function FlowRow({
  project,
  workflow,
  statusKey,
  canEdit,
  expanded,
  onToggle,
}: {
  project: Project;
  workflow: IssueWorkflow;
  statusKey: string;
  canEdit: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const catalog = useIssueStatuses(wsId);
  const labelOf = useStatusLabel(wsId);
  const handlerLabel = useStepHandlerLabel(project);
  const step = workflow.steps.find((s) => s.status_key === statusKey);
  const label = handlerLabel(step);
  const actor = stepHandlerActor(step, project);
  const accepts = statusAcceptsHandoff(statusKey);

  return (
    <li className={cn("rounded-lg border border-surface-border", expanded && "bg-card")}>
      <button
        type="button"
        disabled={!accepts}
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left disabled:cursor-default"
      >
        <StatusIcon
          status={statusKey}
          category={catalog.categoryOf(statusKey)}
          color={catalog.colorOf(statusKey)}
          icon={catalog.iconOf(statusKey)}
          className="h-3.5 w-3.5 shrink-0"
        />
        <span className="min-w-0 flex-1 truncate text-body font-medium">{labelOf(statusKey)}</span>
        {label ? (
          <span className="flex min-w-0 items-center gap-1 text-caption text-muted-foreground">
            {actor && <ActorAvatar actorType={actor.type} actorId={actor.id} size="xs" profileLink={false} />}
            <span className="truncate">{label}</span>
          </span>
        ) : (
          <span className="text-caption text-muted-foreground">
            {accepts ? t(($) => $.workflows.handler.none) : t(($) => $.workflows.flow.no_handoff_here)}
          </span>
        )}
        {accepts && (
          <ChevronRight
            aria-hidden
            className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")}
          />
        )}
      </button>
      {expanded && accepts && (
        <div className="border-t border-surface-border px-3 py-3">
          <ProjectHandoffForm project={project} workflow={workflow} statusKey={statusKey} canEdit={canEdit} />
        </div>
      )}
    </li>
  );
}

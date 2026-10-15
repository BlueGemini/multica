"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronRight, Copy, GripVertical, Lock, MoreHorizontal, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { ApiError, clientErrorMessage } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import { useCurrentWorkspace } from "@multica/core/paths";
import { useIssueStatuses } from "@multica/core/issue-statuses/hooks";
import { statusColumnKeys } from "@multica/core/issues";
import {
  WORKFLOW_HEAD_STATUSES,
  WORKFLOW_TAIL_STATUSES,
  isFixedWorkflowStatus,
  useCreateIssueWorkflow,
  useDeleteIssueWorkflow,
  useIssueWorkflows,
  useUpdateIssueWorkflow,
  workflowMiddleKeys,
} from "@multica/core/issue-workflows";
import { projectListOptions } from "@multica/core/projects/queries";
import type { IssueWorkflow, IssueWorkflowMappingPlan, IssueWorkflowStepInput } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@multica/ui/components/ui/dropdown-menu";
import { Input } from "@multica/ui/components/ui/input";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { cn } from "@multica/ui/lib/utils";
import { StatusIcon } from "../issues/components/status-icon";
import { useStatusLabel } from "../issues/utils/status-label";
import { useT } from "../i18n";
import { WORKFLOW_TEMPLATES, type WorkflowTemplateId } from "./templates";
import { WorkflowMappingDialog } from "./workflow-mapping-dialog";

/** A new workflow starts from the common delivery loop instead of nothing. */
const NEW_WORKFLOW_MIDDLE = ["in_progress", "in_review"];

/** A middle column of the draft: a library status, or one to create on save. */
type DraftColumn = { id: string; status_key: string } | { id: string; new_name: string; category?: "unstarted" | "started" };

interface Draft {
  name: string;
  description: string;
  middle: DraftColumn[];
}

function draftFrom(workflow: Pick<IssueWorkflow, "name" | "description" | "steps">): Draft {
  return {
    name: workflow.name,
    description: workflow.description,
    middle: workflowMiddleKeys(workflow).map((key) => ({ id: key, status_key: key })),
  };
}

function sameDraft(a: Draft, b: Draft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function mappingPlanFrom(err: unknown): IssueWorkflowMappingPlan | null {
  if (!(err instanceof ApiError) || err.status !== 409 || !err.body || typeof err.body !== "object") return null;
  const body = err.body as { code?: unknown; plan?: IssueWorkflowMappingPlan };
  if (body.code !== "workflow_status_mapping_required" || !body.plan) return null;
  return { ...body.plan, unchanged: body.plan.unchanged ?? [] };
}

/**
 * The workflow editor (MUL-7420): a workflow is a board's columns. Every
 * workflow opens with backlog and todo and closes with blocked, done and
 * cancelled; the editor arranges what sits between. Handoffs are not set
 * here — each project sets its own on its board.
 *
 * `workflowId` is null for a new workflow; `seed` pre-fills one (duplicate).
 */
export function WorkflowEditorPage({
  workflowId,
  seed,
  template,
  canEdit,
  onBack,
  onOpen,
}: {
  workflowId: string | null;
  seed: IssueWorkflow | null;
  /** Pre-fills a new workflow from a template. */
  template?: WorkflowTemplateId | null;
  canEdit: boolean;
  onBack: () => void;
  /** Navigates to another workflow's editor (after create, or to a duplicate). */
  onOpen: (target: { id: string } | { duplicateOf: string }) => void;
}) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const catalog = useIssueStatuses(wsId);
  const labelOf = useStatusLabel(wsId);
  const { workflows, isLoaded } = useIssueWorkflows(wsId);
  const { data: projects = [] } = useQuery(projectListOptions(wsId));
  const createWorkflow = useCreateIssueWorkflow();
  const updateWorkflow = useUpdateIssueWorkflow();
  const deleteWorkflow = useDeleteIssueWorkflow();

  const saved = workflowId ? workflows.find((w) => w.id === workflowId) ?? null : null;
  const isDefault = !!saved?.is_default;
  const baseline = useMemo<Draft>(() => {
    if (saved) return draftFrom(saved);
    if (seed) return { ...draftFrom(seed), name: t(($) => $.workflows.editor.copy_name, { name: seed.name }) };
    const tpl = template ? WORKFLOW_TEMPLATES.find((x) => x.id === template) : undefined;
    if (tpl) {
      const statusName = (name: string) =>
        t(($) => ($.workflows.templates[tpl.id].statuses as Record<string, string>)[name] ?? name);
      return {
        name: t(($) => $.workflows.templates[tpl.id].name),
        description: t(($) => $.workflows.templates[tpl.id].summary),
        middle: tpl.columns.map((column): DraftColumn => {
          if ("status" in column) return { id: column.status, status_key: column.status };
          const name = statusName(column.name);
          const existing = catalog.activeStatuses.find((e) => e.name.toLowerCase() === name.toLowerCase());
          return existing
            ? { id: existing.key, status_key: existing.key }
            : { id: `new:${name}`, new_name: name, category: column.category };
        }),
      };
    }
    return {
      name: "",
      description: "",
      middle: NEW_WORKFLOW_MIDDLE.map((key) => ({ id: key, status_key: key })),
    };
    // Re-seed only when the target changes or the saved row is refreshed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved?.updated_at, workflowId, seed?.id, template, catalog.activeStatuses.length]);

  const [draft, setDraft] = useState<Draft>(baseline);
  const [mappingPlan, setMappingPlan] = useState<IssueWorkflowMappingPlan | null>(null);
  const [newName, setNewName] = useState<string | null>(null);
  useEffect(() => setDraft(baseline), [baseline]);

  const dirty = !workflowId || !sameDraft(draft, baseline);
  const pending = createWorkflow.isPending || updateWorkflow.isPending;
  const canSave = canEdit && dirty && draft.name.trim().length > 0 && !pending;
  const usedBy = saved
    ? projects.filter((p) => (saved.is_default ? !p.workflow_id : saved.project_ids.includes(p.id)))
    : [];
  const middleKeys = draft.middle.flatMap((c) => ("status_key" in c ? [c.status_key] : []));
  const addable = statusColumnKeys(catalog).filter((key) => !isFixedWorkflowStatus(key) && !middleKeys.includes(key));
  const ids = draft.middle.map((c) => c.id);
  const targetKeys = [...WORKFLOW_HEAD_STATUSES, ...middleKeys, ...WORKFLOW_TAIL_STATUSES];

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    setDraft((d) => ({ ...d, middle: arrayMove(d.middle, ids.indexOf(String(active.id)), ids.indexOf(String(over.id))) }));
  };

  const addNew = () => {
    const name = newName?.trim();
    if (!name) return;
    setDraft((d) => ({ ...d, middle: [...d.middle, { id: `new:${name}:${Date.now()}`, new_name: name }] }));
    setNewName(null);
  };

  const save = async (mapping?: Record<string, string>) => {
    const steps: IssueWorkflowStepInput[] = draft.middle.map((c) =>
      "status_key" in c
        ? { status_key: c.status_key }
        : { new_status: { name: c.new_name, ...(c.category ? { category: c.category } : {}) } },
    );
    const body = {
      ...(isDefault ? {} : { name: draft.name.trim() }),
      description: draft.description.trim(),
      steps,
      ...(mapping ? { status_mapping: mapping } : {}),
    };
    try {
      if (workflowId) {
        await updateWorkflow.mutateAsync({ id: workflowId, ...body });
        toast.success(t(($) => $.workflows.editor.saved));
      } else {
        const created = await createWorkflow.mutateAsync({ ...body, name: draft.name.trim() });
        toast.success(t(($) => $.workflows.editor.created));
        onOpen({ id: created.id });
      }
      setMappingPlan(null);
    } catch (err) {
      const plan = mappingPlanFrom(err);
      if (plan) {
        setMappingPlan(plan);
        return;
      }
      toast.error(clientErrorMessage(err) ?? t(($) => $.workflows.editor.error));
    }
  };

  const remove = async () => {
    if (!workflowId) return;
    try {
      await deleteWorkflow.mutateAsync(workflowId);
      toast.success(t(($) => $.workflows.settings.deleted));
      onBack();
    } catch (err) {
      toast.error(clientErrorMessage(err) ?? t(($) => $.workflows.settings.delete_error));
    }
  };

  if (workflowId && isLoaded && !saved) {
    return (
      <div className="space-y-4">
        <Breadcrumb onBack={onBack} current="" />
        <p className="text-body text-muted-foreground">{t(($) => $.workflows.editor.not_found)}</p>
      </div>
    );
  }

  const title = draft.name.trim() || t(($) => $.workflows.editor.create_title);
  const fixedGroup = (label: string, keys: string[]) => (
    <li>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-dashed border-surface-border px-2.5 py-2 text-muted-foreground">
        <Lock aria-hidden className="size-3.5 shrink-0" />
        <span className="text-caption">{label}</span>
        {keys.map((key) => (
          <span key={key} className="inline-flex items-center gap-1.5 text-body">
            <StatusIcon
              status={key}
              category={catalog.categoryOf(key)}
              color={catalog.colorOf(key)}
              icon={catalog.iconOf(key)}
              className="h-3.5 w-3.5 shrink-0"
            />
            {labelOf(key)}
          </span>
        ))}
      </div>
    </li>
  );

  return (
    <div className="space-y-6">
      <Breadcrumb onBack={onBack} current={title} />
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="truncate text-title-lg font-semibold tracking-tight">{title}</h2>
          <p className="text-body text-muted-foreground">
            {isDefault
              ? t(($) => $.workflows.editor.default_note)
              : usedBy.length > 0
                ? t(($) => $.workflows.editor.used_by_note, {
                    count: usedBy.length,
                    names: usedBy.map((p) => p.title).join(t(($) => $.workflows.list_separator)),
                  })
                : t(($) => $.workflows.editor.unused_note)}
          </p>
        </div>
        {canEdit && (
          <div className="flex shrink-0 items-center gap-2">
            {dirty && workflowId && (
              <span className="text-caption text-muted-foreground">{t(($) => $.workflows.editor.unsaved)}</span>
            )}
            {workflowId && (
              <Button variant="outline" className="gap-1.5" onClick={() => onOpen({ duplicateOf: workflowId })}>
                <Copy className="size-3.5" />
                {t(($) => $.workflows.editor.duplicate)}
              </Button>
            )}
            <Button onClick={() => void save()} disabled={!canSave} aria-busy={pending}>
              {pending && <Spinner className="size-3.5" />}
              {workflowId ? t(($) => $.workflows.editor.save) : t(($) => $.workflows.editor.create)}
            </Button>
            {workflowId && !isDefault && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button variant="ghost" size="icon" aria-label={t(($) => $.workflows.editor.more)}>
                      <MoreHorizontal className="size-4" />
                    </Button>
                  }
                />
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={usedBy.length > 0 || deleteWorkflow.isPending}
                    onClick={() => void remove()}
                  >
                    <Trash2 className="size-3.5" />
                    {t(($) => $.workflows.settings.delete)}
                  </DropdownMenuItem>
                  {usedBy.length > 0 && (
                    <p className="px-2 pb-1.5 text-caption text-muted-foreground">
                      {t(($) => $.workflows.settings.delete_in_use)}
                    </p>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}
      </div>

      <div className="grid max-w-xl gap-4">
        <div className="space-y-1.5">
          <label htmlFor="workflow-name" className="block text-caption font-medium">
            {t(($) => $.workflows.editor.name)}
          </label>
          <Input
            id="workflow-name"
            value={draft.name}
            maxLength={64}
            readOnly={!canEdit || isDefault}
            placeholder={t(($) => $.workflows.editor.name_placeholder)}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="workflow-description" className="block text-caption font-medium">
            {t(($) => $.workflows.editor.description)}
          </label>
          <Textarea
            id="workflow-description"
            rows={2}
            value={draft.description}
            maxLength={256}
            readOnly={!canEdit}
            placeholder={canEdit ? t(($) => $.workflows.editor.description_placeholder) : ""}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
          />
        </div>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)]">
        <div className="min-w-0">
          <p className="mb-2 text-caption font-medium">{t(($) => $.workflows.editor.columns)}</p>
          <ol className="space-y-1.5">
            {fixedGroup(t(($) => $.workflows.editor.fixed_start), [...WORKFLOW_HEAD_STATUSES])}
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={ids} strategy={verticalListSortingStrategy}>
                {draft.middle.map((column) => (
                  <li key={column.id}>
                    <ColumnRow
                      column={column}
                      draggable={canEdit}
                      onRemove={
                        canEdit ? () => setDraft((d) => ({ ...d, middle: d.middle.filter((c) => c.id !== column.id) })) : undefined
                      }
                    />
                  </li>
                ))}
              </SortableContext>
            </DndContext>
            {fixedGroup(t(($) => $.workflows.editor.fixed_end), [...WORKFLOW_TAIL_STATUSES])}
          </ol>
          {canEdit && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button variant="outline" className="gap-1.5">
                      <Plus className="size-3.5" />
                      {t(($) => $.workflows.editor.add_step)}
                    </Button>
                  }
                />
                <DropdownMenuContent align="start" className="max-h-80 w-56 overflow-y-auto">
                  {addable.map((key) => (
                    <DropdownMenuItem
                      key={key}
                      onClick={() => setDraft((d) => ({ ...d, middle: [...d.middle, { id: key, status_key: key }] }))}
                    >
                      <StatusIcon
                        status={key}
                        category={catalog.categoryOf(key)}
                        color={catalog.colorOf(key)}
                        icon={catalog.iconOf(key)}
                        className="h-3.5 w-3.5"
                      />
                      <span className="truncate">{labelOf(key)}</span>
                    </DropdownMenuItem>
                  ))}
                  {addable.length > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuItem onClick={() => setNewName("")}>
                    <Plus className="size-3.5" />
                    {t(($) => $.workflows.columns.new_status)}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              {newName !== null && (
                <div className="flex items-center gap-1.5">
                  <Input
                    autoFocus
                    maxLength={64}
                    value={newName}
                    className="h-8 w-48"
                    placeholder={t(($) => $.workflows.columns.name_placeholder)}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addNew();
                      if (e.key === "Escape") setNewName(null);
                    }}
                  />
                  <Button size="sm" variant="ghost" onClick={addNew} disabled={!newName.trim()}>
                    {t(($) => $.workflows.columns.add)}
                  </Button>
                </div>
              )}
            </div>
          )}
          <p className="mt-2.5 text-caption text-muted-foreground">{t(($) => $.workflows.editor.steps_hint)}</p>
        </div>

        <div className="min-w-0 space-y-2 rounded-xl border border-surface-border bg-card p-5">
          <p className="text-body font-medium">{t(($) => $.workflows.editor.handoffs_title)}</p>
          <p className="text-caption leading-5 text-muted-foreground">{t(($) => $.workflows.editor.handoffs_hint)}</p>
        </div>
      </div>

      <WorkflowMappingDialog
        open={mappingPlan !== null}
        onOpenChange={(open) => !open && setMappingPlan(null)}
        variant={{ kind: "edit", workflowName: draft.name.trim() }}
        plan={mappingPlan}
        targetKeys={targetKeys}
        pending={pending}
        onConfirm={(mapping) => void save(mapping)}
      />
    </div>
  );
}

function Breadcrumb({ onBack, current }: { onBack: () => void; current: string }) {
  const { t } = useT("issues");
  const workspace = useCurrentWorkspace();
  return (
    <nav className="flex items-center gap-1.5 text-caption text-muted-foreground">
      {workspace?.name && (
        <>
          <span className="truncate">{workspace.name}</span>
          <ChevronRight aria-hidden className="size-3" />
        </>
      )}
      <button type="button" onClick={onBack} className="hover:text-foreground transition-colors">
        {t(($) => $.workflows.settings.title)}
      </button>
      {current && (
        <>
          <ChevronRight aria-hidden className="size-3" />
          <span className="truncate text-foreground">{current}</span>
        </>
      )}
    </nav>
  );
}

function ColumnRow({
  column,
  draggable,
  onRemove,
}: {
  column: DraftColumn;
  draggable: boolean;
  onRemove?: () => void;
}) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const catalog = useIssueStatuses(wsId);
  const labelOf = useStatusLabel(wsId);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: column.id,
    disabled: !draggable,
  });
  const label = "status_key" in column ? labelOf(column.status_key) : column.new_name;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex items-center gap-2 rounded-lg border border-surface-border bg-card px-2.5 py-2",
        isDragging && "z-10 shadow-[var(--surface-shadow)]",
      )}
    >
      {draggable ? (
        <button
          type="button"
          aria-label={t(($) => $.workflows.editor.reorder, { name: label })}
          className="flex size-5 shrink-0 touch-none items-center justify-center rounded-xs cursor-grab text-muted-foreground active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-3.5" />
        </button>
      ) : (
        <span className="size-5 shrink-0" />
      )}
      {"status_key" in column ? (
        <StatusIcon
          status={column.status_key}
          category={catalog.categoryOf(column.status_key)}
          color={catalog.colorOf(column.status_key)}
          icon={catalog.iconOf(column.status_key)}
          className="h-4 w-4 shrink-0"
        />
      ) : (
        <Plus aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1 truncate text-body font-medium">{label}</span>
      {!("status_key" in column) && (
        <span className="shrink-0 rounded-xs bg-muted px-1.5 py-0.5 text-micro text-muted-foreground">
          {t(($) => $.workflows.editor.new_badge)}
        </span>
      )}
      {onRemove && (
        <Button variant="ghost" size="icon-sm" aria-label={t(($) => $.workflows.editor.remove)} onClick={onRemove}>
          <X className="size-3.5" />
        </Button>
      )}
    </div>
  );
}

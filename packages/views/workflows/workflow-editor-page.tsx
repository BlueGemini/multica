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
import { ChevronRight, Copy, GripVertical, MoreHorizontal, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { ApiError, clientErrorMessage } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import { useCurrentWorkspace } from "@multica/core/paths";
import { useIssueStatuses } from "@multica/core/issue-statuses/hooks";
import { statusColumnKeys } from "@multica/core/issues";
import {
  isFixedWorkflowStatus,
  statusAcceptsHandoff,
  useCreateIssueWorkflow,
  useDeleteIssueWorkflow,
  useIssueWorkflows,
  useUpdateIssueWorkflow,
  workflowMiddleKeys,
} from "@multica/core/issue-workflows";
import { projectListOptions } from "@multica/core/projects/queries";
import type {
  IssueWorkflow,
  IssueWorkflowMappingPlan,
  IssueWorkflowStep,
  IssueWorkflowStepInput,
} from "@multica/core/types";
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
import { Switch } from "@multica/ui/components/ui/switch";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { cn } from "@multica/ui/lib/utils";
import { StatusIcon } from "../issues/components/status-icon";
import { useStatusLabel } from "../issues/utils/status-label";
import { ActorAvatar } from "../common/actor-avatar";
import { useT } from "../i18n";
import { BriefPreviewDialog, HandoffFields, savedHandoff } from "./handoff-form";
import { stepHandlerActor, useStepHandlerLabel } from "./step-handler";
import { WORKFLOW_TEMPLATES, type WorkflowTemplateId } from "./templates";
import { WorkflowMappingDialog } from "./workflow-mapping-dialog";

/** A new workflow starts from the common delivery loop instead of nothing. */
const NEW_WORKFLOW_MIDDLE = ["in_progress", "in_review"];

/** A middle column of the draft: a library status, or one to create on save. */
type DraftColumn = { id: string; status_key: string } | { id: string; new_name: string; category?: "unstarted" | "started" };

/** What entering a column does, keyed in the draft by column id. */
type Handoff = Pick<IssueWorkflowStep, "handler" | "instructions" | "next_status_key" | "back_status_key">;

const NO_HANDOFF: Handoff = { handler: { type: "none" }, instructions: "" };

interface Draft {
  name: string;
  description: string;
  backlog: boolean;
  blocked: boolean;
  middle: DraftColumn[];
  handoffs: Record<string, Handoff>;
}

function hasHandoff(h: Handoff | undefined): h is Handoff {
  return !!h && (h.handler.type !== "none" || !!h.next_status_key || !!h.back_status_key);
}

function draftFrom(workflow: Pick<IssueWorkflow, "name" | "description" | "steps">): Draft {
  const keys = workflow.steps.map((s) => s.status_key);
  const handoffs: Record<string, Handoff> = {};
  for (const s of workflow.steps) {
    const h = { handler: s.handler, instructions: s.instructions, next_status_key: s.next_status_key, back_status_key: s.back_status_key };
    if (hasHandoff(h)) handoffs[s.status_key] = h;
  }
  return {
    name: workflow.name,
    description: workflow.description,
    backlog: keys.includes("backlog"),
    blocked: keys.includes("blocked"),
    middle: workflowMiddleKeys(workflow).map((key) => ({ id: key, status_key: key })),
    handoffs,
  };
}

/** Every column of the draft in board order. */
function draftColumns(draft: Draft): DraftColumn[] {
  const fixed = (key: string): DraftColumn => ({ id: key, status_key: key });
  return [
    ...(draft.backlog ? [fixed("backlog")] : []),
    fixed("todo"),
    ...draft.middle,
    ...(draft.blocked ? [fixed("blocked")] : []),
    fixed("done"),
    fixed("cancelled"),
  ];
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
 * The workflow editor (MUL-7420): a workflow is a whole pipeline — its
 * columns and who each one hands an issue to. Todo, done and cancelled are
 * always there; backlog and blocked can be switched off; the editor arranges
 * what sits between. Selecting a column edits its handoff.
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
        backlog: true,
        blocked: true,
        handoffs: {},
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
      backlog: true,
      blocked: true,
      middle: NEW_WORKFLOW_MIDDLE.map((key) => ({ id: key, status_key: key })),
      handoffs: {},
    };
    // Re-seed only when the target changes or the saved row is refreshed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved?.updated_at, workflowId, seed?.id, template, catalog.activeStatuses.length]);

  const [draft, setDraft] = useState<Draft>(baseline);
  const [mappingPlan, setMappingPlan] = useState<IssueWorkflowMappingPlan | null>(null);
  const [newName, setNewName] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  useEffect(() => setDraft(baseline), [baseline]);

  const dirty = !workflowId || !sameDraft(draft, baseline);
  const pending = createWorkflow.isPending || updateWorkflow.isPending;
  const canSave = canEdit && dirty && draft.name.trim().length > 0 && !pending;
  const usedBy = saved
    ? projects.filter((p) => (saved.is_default ? !p.workflow_id : saved.project_ids.includes(p.id)))
    : [];
  const columns = draftColumns(draft);
  const middleKeys = draft.middle.flatMap((c) => ("status_key" in c ? [c.status_key] : []));
  const addable = statusColumnKeys(catalog).filter((key) => !isFixedWorkflowStatus(key) && !middleKeys.includes(key));
  const ids = draft.middle.map((c) => c.id);
  const targetKeys = columns.flatMap((c) => ("status_key" in c ? [c.status_key] : []));
  // Next and back can only name statuses that exist before the save.
  const flow = { steps: targetKeys.map((status_key) => ({ status_key, ...NO_HANDOFF })) };
  const selectedColumn = columns.find((c) => c.id === selected && "status_key" in c && statusAcceptsHandoff(c.status_key));
  const selectedStep: IssueWorkflowStep | null =
    selectedColumn && "status_key" in selectedColumn
      ? { status_key: selectedColumn.status_key, ...(draft.handoffs[selectedColumn.id] ?? NO_HANDOFF) }
      : null;
  const patchHandoff = (id: string, patch: Partial<Handoff>) =>
    setDraft((d) => ({ ...d, handoffs: { ...d.handoffs, [id]: { ...(d.handoffs[id] ?? NO_HANDOFF), ...patch } } }));

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
    const listed = new Set(targetKeys);
    const steps: IssueWorkflowStepInput[] = columns.map((c) => {
      const raw = draft.handoffs[c.id];
      const h = raw && savedHandoff(raw);
      const handoff = hasHandoff(h)
        ? {
            ...(h.handler.type !== "none" ? { handler: h.handler, instructions: h.instructions } : {}),
            ...(h.next_status_key && listed.has(h.next_status_key) ? { next_status_key: h.next_status_key } : {}),
            ...(h.back_status_key && listed.has(h.back_status_key) ? { back_status_key: h.back_status_key } : {}),
          }
        : {};
      return "status_key" in c
        ? { status_key: c.status_key, ...handoff }
        : { new_status: { name: c.new_name, ...(c.category ? { category: c.category } : {}) }, ...handoff };
    });
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
  const fixedRow = (column: DraftColumn, off = false) => {
    if (!("status_key" in column)) return null;
    const key = column.status_key;
    const optional = key === "backlog" || key === "blocked";
    return (
      <li key={column.id}>
        <ColumnRowView
          column={column}
          muted={off}
          handoff={off ? undefined : draft.handoffs[column.id]}
          selected={!off && selected === column.id}
          onSelect={!off && statusAcceptsHandoff(key) ? () => setSelected(column.id) : undefined}
          toggle={
            optional
              ? {
                  checked: !off,
                  disabled: !canEdit,
                  onChange: (on) => setDraft((d) => ({ ...d, [key]: on })),
                }
              : undefined
          }
        />
      </li>
    );
  };

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
            {fixedRow({ id: "backlog", status_key: "backlog" }, !draft.backlog)}
            {fixedRow({ id: "todo", status_key: "todo" })}
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={ids} strategy={verticalListSortingStrategy}>
                {draft.middle.map((column) => (
                  <li key={column.id}>
                    <SortableColumnRow
                      column={column}
                      draggable={canEdit}
                      handoff={draft.handoffs[column.id]}
                      selected={selected === column.id}
                      onSelect={"status_key" in column ? () => setSelected(column.id) : undefined}
                      onRemove={
                        canEdit ? () => setDraft((d) => ({ ...d, middle: d.middle.filter((c) => c.id !== column.id) })) : undefined
                      }
                    />
                  </li>
                ))}
              </SortableContext>
            </DndContext>
            {fixedRow({ id: "blocked", status_key: "blocked" }, !draft.blocked)}
            {fixedRow({ id: "done", status_key: "done" })}
            {fixedRow({ id: "cancelled", status_key: "cancelled" })}
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

        <div className="min-w-0 rounded-xl border border-surface-border bg-card p-5 lg:sticky lg:top-4">
          {selectedStep && selectedColumn ? (
            <div className="space-y-4">
              <div className="space-y-0.5">
                <p className="text-body font-medium">
                  {t(($) => $.workflows.handoff.title, { status: labelOf(selectedStep.status_key) })}
                </p>
                {!isDefault && saved && saved.project_ids.length > 1 && (
                  <p className="text-caption text-muted-foreground">
                    {t(($) => $.workflows.handoff.scope_note, { workflow: draft.name, count: saved.project_ids.length })}
                  </p>
                )}
              </div>
              <HandoffFields
                key={selectedColumn.id}
                step={selectedStep}
                workflow={flow}
                canEdit={canEdit}
                onPatch={(patch) => patchHandoff(selectedColumn.id, patch)}
                onPreview={
                  saved?.steps.some((s) => s.status_key === selectedStep.status_key) ? () => setPreviewOpen(true) : undefined
                }
              />
              {saved && (
                <BriefPreviewDialog open={previewOpen} onOpenChange={setPreviewOpen} workflowId={saved.id} step={selectedStep} />
              )}
            </div>
          ) : (
            <p className="text-caption leading-5 text-muted-foreground">{t(($) => $.workflows.editor.select_step)}</p>
          )}
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

function SortableColumnRow({
  column,
  draggable,
  handoff,
  selected,
  onSelect,
  onRemove,
}: {
  column: DraftColumn;
  draggable: boolean;
  handoff: Handoff | undefined;
  selected: boolean;
  onSelect?: () => void;
  onRemove?: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: column.id,
    disabled: !draggable,
  });
  return (
    <ColumnRowView
      column={column}
      handoff={handoff}
      selected={selected}
      onSelect={onSelect}
      onRemove={onRemove}
      sortable={{
        ref: setNodeRef,
        style: { transform: CSS.Transform.toString(transform), transition },
        dragging: isDragging,
        handle: draggable ? { ...attributes, ...listeners } : undefined,
      }}
    />
  );
}

/**
 * One column of the editor. Middle columns drag and can be removed; backlog
 * and blocked switch on and off; columns that can hand off open their
 * handoff in the side panel.
 */
function ColumnRowView({
  column,
  handoff,
  selected,
  muted,
  onSelect,
  onRemove,
  toggle,
  sortable,
}: {
  column: DraftColumn;
  handoff: Handoff | undefined;
  selected: boolean;
  muted?: boolean;
  onSelect?: () => void;
  onRemove?: () => void;
  toggle?: { checked: boolean; disabled: boolean; onChange: (on: boolean) => void };
  sortable?: {
    ref: (node: HTMLElement | null) => void;
    style: React.CSSProperties;
    dragging: boolean;
    handle?: React.HTMLAttributes<HTMLButtonElement>;
  };
}) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const catalog = useIssueStatuses(wsId);
  const labelOf = useStatusLabel(wsId);
  const handlerLabel = useStepHandlerLabel(null);
  const label = "status_key" in column ? labelOf(column.status_key) : column.new_name;
  const step = handoff && "status_key" in column ? { status_key: column.status_key, ...handoff } : undefined;
  const who = handlerLabel(step);
  const actor = stepHandlerActor(step, null);

  return (
    <div
      ref={sortable?.ref}
      style={sortable?.style}
      className={cn(
        "flex items-center gap-2 rounded-lg border bg-card px-2.5 py-2",
        selected ? "border-brand ring-1 ring-brand/30" : "border-surface-border",
        muted && "border-dashed bg-transparent",
        sortable?.dragging && "z-10 shadow-[var(--surface-shadow)]",
      )}
    >
      {sortable?.handle ? (
        <button
          type="button"
          aria-label={t(($) => $.workflows.editor.reorder, { name: label })}
          className="flex size-5 shrink-0 touch-none items-center justify-center rounded-xs cursor-grab text-muted-foreground active:cursor-grabbing"
          {...sortable.handle}
        >
          <GripVertical className="size-3.5" />
        </button>
      ) : (
        <span className="size-5 shrink-0" />
      )}
      <button
        type="button"
        disabled={!onSelect}
        onClick={onSelect}
        aria-pressed={onSelect ? selected : undefined}
        className={cn("flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default", muted && "opacity-50")}
      >
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
        {who && (
          <span className="flex min-w-0 max-w-40 items-center gap-1 text-caption text-muted-foreground">
            {actor && <ActorAvatar actorType={actor.type} actorId={actor.id} size="xs" profileLink={false} />}
            <span className="truncate">{who}</span>
          </span>
        )}
      </button>
      {toggle && (
        <Switch
          size="sm"
          checked={toggle.checked}
          disabled={toggle.disabled}
          onCheckedChange={toggle.onChange}
          aria-label={t(($) => $.workflows.editor.include_status, { status: label })}
        />
      )}
      {onRemove && (
        <Button variant="ghost" size="icon-sm" aria-label={t(($) => $.workflows.editor.remove)} onClick={onRemove}>
          <X className="size-3.5" />
        </Button>
      )}
    </div>
  );
}

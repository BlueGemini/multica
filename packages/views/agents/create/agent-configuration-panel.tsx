"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, Globe, Lock, Plus, Trash2, Users, X } from "lucide-react";
import {
  AGENT_CONVERSATION_STARTER_LABEL_MAX_LENGTH,
  AGENT_CONVERSATION_STARTER_MAX_LENGTH,
  AGENT_CONVERSATION_STARTERS_MAX,
  AGENT_DESCRIPTION_MAX_LENGTH,
  applyDraftModelChange,
  applyDraftRuntimeChange,
  type AgentDraft,
  type AgentPermissionScope,
} from "@multica/core/agents";
import { useConfigStore } from "@multica/core/config";
import { useWorkspaceId } from "@multica/core/hooks";
import type {
  AgentConversationStarter,
  MemberWithUser,
  RuntimeDevice,
} from "@multica/core/types";
import { skillListOptions } from "@multica/core/workspace/queries";
import { Button } from "@multica/ui/components/ui/button";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import { Input } from "@multica/ui/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@multica/ui/components/ui/popover";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { cn } from "@multica/ui/lib/utils";
import { ActorAvatar } from "../../common/actor-avatar";
import { AvatarUploadControl } from "../../common/avatar-upload-control";
import { useT } from "../../i18n";
import { ServiceTierSettingField } from "../components/inspector/service-tier-setting-field";
import { ThinkingSettingField } from "../components/inspector/thinking-prop-row";
import { ModelDropdown } from "../components/model-dropdown";
import { RuntimePicker } from "../components/runtime-picker";
import { SkillPickerList } from "../components/skill-picker-list";
import { InstructionsDiff } from "./instructions-diff";

const PERMISSION_SCOPES: AgentPermissionScope[] = [
  "private",
  "workspace",
  "members",
];

export type AgentDraftUpdate = (current: AgentDraft) => AgentDraft;

export function AgentConfigurationPanel({
  draft,
  onChange,
  onAutomaticChange = onChange,
  runtimes,
  runtimesLoading,
  members,
  currentUserId,
  nameError,
  onNameChange,
  changedFields,
  previousInstructions = null,
  instructionsFooter,
  runtimeHint,
}: {
  draft: AgentDraft;
  /** Takes an updater, never a whole draft: pickers seed and clear values from
   *  effects, and a copy of `draft` captured then would undo whatever the
   *  parent wrote in the meantime — such as a saved draft hydrating. */
  onChange: (update: AgentDraftUpdate) => void;
  /** Value cleanup without user interaction, such as an unsupported model. */
  onAutomaticChange?: (update: AgentDraftUpdate) => void;
  runtimes: RuntimeDevice[];
  runtimesLoading: boolean;
  members: MemberWithUser[];
  currentUserId: string | null;
  nameError: string | null;
  onNameChange: (name: string) => void;
  /** Config fields the agent's latest revision changed; their rows are
   *  marked. */
  changedFields?: ReadonlySet<string>;
  /** The instructions before that revision, when it changed them. */
  previousInstructions?: string | null;
  instructionsFooter?: ReactNode;
  runtimeHint?: string | null;
}) {
  const { t } = useT("agents");
  const wsId = useWorkspaceId();
  const conversationStartersSupported = useConfigStore(
    (state) => state.agentConversationStartersSupported,
  );
  const { data: workspaceSkills = [], isLoading: skillsLoading } = useQuery(
    skillListOptions(wsId),
  );
  const [editingInstructions, setEditingInstructions] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!nameError) return;
    nameInputRef.current?.focus();
    nameInputRef.current?.select();
  }, [nameError]);

  const selectedRuntime =
    runtimes.find((runtime) => runtime.id === draft.runtimeId) ?? null;
  const set = <K extends keyof AgentDraft>(key: K, value: AgentDraft[K]) =>
    onChange((current) => ({ ...current, [key]: value }));
  const otherMembers = members.filter(
    (member) => member.user_id !== currentUserId,
  );
  const handleRuntimeSelect = (id: string) => {
    const seen = draft.runtimeId;
    if (id === seen) return;
    // The picker also seeds an empty selection on its own, so a change only
    // lands on the runtime it was made against; one that arrived since (a
    // saved draft hydrating) wins. Model is per-runtime; clear it — and the
    // per-model thinking / speed overrides — so the new runtime resolves its
    // own defaults instead of stale values.
    onChange((current) =>
      current.runtimeId === seen ? applyDraftRuntimeChange(current, id) : current,
    );
  };
  const changed = (field: string) => changedFields?.has(field) ?? false;
  const showDiff =
    previousInstructions !== null &&
    previousInstructions !== draft.instructions &&
    !editingInstructions;
  const selectedSkills = workspaceSkills.filter((skill) =>
    draft.skillIds.has(skill.id),
  );

  return (
    <div className="divide-y">
      <FormRow
        label={t(($) => $.drafts.form.identity)}
        required
        changed={changed("name") || changed("description") || changed("avatar_url")}
      >
        <div className="flex items-start gap-3">
          <AvatarUploadControl
            variant="agent"
            value={draft.avatarUrl}
            name={draft.name}
            size={44}
            onUploaded={(url) => set("avatarUrl", url)}
            onEmojiSelected={(value) => set("avatarUrl", value)}
            onClear={() => set("avatarUrl", null)}
          />
          <div className="min-w-0 flex-1 space-y-2">
            <Input
              ref={nameInputRef}
              id="agent-create-name"
              name="agent-name"
              autoComplete="off"
              aria-label={t(($) => $.create_dialog.name_label)}
              aria-invalid={!!nameError}
              aria-describedby={nameError ? "agent-create-name-error" : undefined}
              value={draft.name}
              onChange={(event) => onNameChange(event.target.value)}
              placeholder={t(($) => $.create_dialog.name_placeholder)}
            />
            {nameError ? (
              <p id="agent-create-name-error" className="text-caption text-destructive">
                {nameError}
              </p>
            ) : null}
            <Input
              id="agent-create-description"
              name="agent-description"
              autoComplete="off"
              aria-label={t(($) => $.create_dialog.description_label)}
              value={draft.description}
              onChange={(event) => set("description", event.target.value)}
              placeholder={t(($) => $.drafts.form.description_placeholder)}
              // The create API rejects >255 characters with a 400.
              maxLength={AGENT_DESCRIPTION_MAX_LENGTH}
            />
          </div>
        </div>
      </FormRow>

      <FormRow
        label={t(($) => $.create_dialog.instructions.label)}
        htmlFor={showDiff ? undefined : "agent-create-instructions"}
        changed={changed("instructions")}
      >
        {showDiff ? (
          <div>
            <InstructionsDiff
              before={previousInstructions ?? ""}
              after={draft.instructions}
            />
            <div className="mt-1.5 flex items-center gap-1.5 text-caption text-muted-foreground">
              <FileText aria-hidden="true" className="size-3.5" />
              <span>
                {t(($) => $.drafts.form.instructions_meta, {
                  count: [...draft.instructions].length,
                })}
              </span>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                className="hover:text-foreground"
                onClick={() => setEditingInstructions(true)}
              >
                {t(($) => $.drafts.form.edit_full)}
              </button>
            </div>
          </div>
        ) : (
          <Textarea
            id="agent-create-instructions"
            name="agent-instructions"
            autoComplete="off"
            aria-label={t(($) => $.create_dialog.instructions.label)}
            value={draft.instructions}
            onChange={(event) => set("instructions", event.target.value)}
            placeholder={t(($) => $.create_dialog.instructions.editor_placeholder)}
            rows={5}
            className="min-h-28 resize-y"
          />
        )}
        {instructionsFooter ? <div className="mt-2">{instructionsFooter}</div> : null}
      </FormRow>

      <FormRow
        label={t(($) => $.create_dialog.skills_section.label)}
        changed={changed("skill_ids")}
      >
        <div className="flex flex-wrap items-center gap-1.5">
          {selectedSkills.map((skill) => (
            <span
              key={skill.id}
              className="inline-flex h-6 items-center gap-1 rounded-md border bg-muted/40 pl-2 pr-1 text-caption"
            >
              {skill.name}
              <button
                type="button"
                aria-label={t(($) => $.drafts.form.remove, { name: skill.name })}
                className="rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() =>
                  onChange((current) => {
                    const next = new Set(current.skillIds);
                    next.delete(skill.id);
                    return { ...current, skillIds: next };
                  })
                }
              >
                <X aria-hidden="true" className="size-3" />
              </button>
            </span>
          ))}
          <Popover>
            <PopoverTrigger className={ADD_CHIP_CLASS}>
              <Plus aria-hidden="true" className="size-3" />
              {t(($) => $.drafts.form.add_skill)}
            </PopoverTrigger>
            <PopoverContent align="start" className="w-80 p-2">
              <SkillPickerList
                skills={workspaceSkills}
                selectedIds={draft.skillIds}
                loading={skillsLoading}
                emptyMessage={t(($) => $.create_dialog.skills_section.list_empty_multi)}
                onToggle={(skill) =>
                  onChange((current) => {
                    const next = new Set(current.skillIds);
                    if (next.has(skill.id)) next.delete(skill.id);
                    else next.add(skill.id);
                    return { ...current, skillIds: next };
                  })
                }
              />
            </PopoverContent>
          </Popover>
          {selectedSkills.length === 0 ? (
            <span className="text-caption text-muted-foreground">
              {t(($) => $.drafts.form.optional)}
            </span>
          ) : null}
        </div>
      </FormRow>

      {conversationStartersSupported ? (
        <FormRow
          label={t(($) => $.drafts.form.starters)}
          changed={changed("conversation_starters")}
        >
          <ConversationStarterChips
            value={draft.conversationStarters}
            onChange={(value) => set("conversationStarters", value)}
          />
        </FormRow>
      ) : null}

      <FormRow
        label={t(($) => $.create_dialog.runtime_label)}
        required
        changed={changed("runtime_id") || changed("model")}
      >
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-48 max-w-64 flex-[3_1_0%]">
            <RuntimePicker
              compact
              runtimes={runtimes}
              runtimesLoading={runtimesLoading}
              members={members}
              currentUserId={currentUserId}
              selectedRuntimeId={draft.runtimeId}
              onSelect={handleRuntimeSelect}
            />
          </div>
          <div className="min-w-36 max-w-44 flex-[2_1_0%]">
            <ModelDropdown
              compact
              runtimeId={selectedRuntime?.id ?? null}
              runtimeOnline={selectedRuntime?.status === "online"}
              value={draft.model}
              onChange={(value) =>
                onChange((current) => applyDraftModelChange(current, value))
              }
              onAutomaticChange={(value) => {
                const seen = draft.model;
                onAutomaticChange((current) =>
                  current.model === seen ? applyDraftModelChange(current, value) : current,
                );
              }}
              disabled={!selectedRuntime}
            />
          </div>
        </div>
        {runtimeHint ? (
          <p className="mt-1.5 text-caption text-muted-foreground">{runtimeHint}</p>
        ) : null}
        {/* Both fields fail closed: they render only when the exact selected
            model's live catalog advertises the capability (or a value is
            already set and needs clearing). */}
        <AgentExecutionOverrides
          draft={draft}
          runtime={selectedRuntime}
          onChange={onChange}
        />
      </FormRow>

      <FormRow
        label={t(($) => $.creation_studio.sections.access)}
        changed={changed("permission_scope") || changed("member_ids")}
      >
        <div
          role="radiogroup"
          aria-label={t(($) => $.creation_studio.sections.access)}
          className="inline-flex items-center gap-0.5 rounded-md bg-muted p-0.5"
        >
          {PERMISSION_SCOPES.map((scope) => {
            const Icon = SCOPE_ICONS[scope];
            const active = draft.permissionScope === scope;
            return (
              <button
                key={scope}
                type="button"
                role="radio"
                aria-checked={active}
                title={t(($) => $.creation_studio.access[scope].description)}
                onClick={() => set("permissionScope", scope)}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-caption font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon aria-hidden="true" className="size-3.5" />
                {t(($) => $.creation_studio.access[scope].title)}
              </button>
            );
          })}
        </div>
        {draft.permissionScope === "members" ? (
          <div className="mt-2 max-h-48 overflow-y-auto rounded-md border p-1">
            {otherMembers.map((member) => (
              <label
                key={member.user_id}
                className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-muted"
              >
                <Checkbox
                  checked={draft.memberIds.has(member.user_id)}
                  onCheckedChange={(value) =>
                    onChange((current) => {
                      const next = new Set(current.memberIds);
                      if (value === true) next.add(member.user_id);
                      else next.delete(member.user_id);
                      return { ...current, memberIds: next };
                    })
                  }
                />
                <ActorAvatar actorType="member" actorId={member.user_id} size="sm" />
                <span className="min-w-0 flex-1 truncate text-body">{member.name}</span>
              </label>
            ))}
            {draft.memberIds.size === 0 ? (
              <p className="px-2 py-1 text-caption text-destructive">
                {t(($) => $.creation_studio.access.members.required)}
              </p>
            ) : null}
          </div>
        ) : null}
      </FormRow>
    </div>
  );
}

const ADD_CHIP_CLASS =
  "inline-flex h-6 items-center gap-1 rounded-md border border-dashed px-2 text-caption text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground";

const SCOPE_ICONS: Record<AgentPermissionScope, typeof Lock> = {
  private: Lock,
  workspace: Globe,
  members: Users,
};

/** One labelled row of the draft form; `changed` marks what the agent's latest
 *  revision touched. */
function FormRow({
  label,
  required = false,
  changed = false,
  htmlFor,
  children,
}: {
  label: string;
  required?: boolean;
  changed?: boolean;
  htmlFor?: string;
  children: ReactNode;
}) {
  const { t } = useT("agents");
  const LabelTag = htmlFor ? "label" : "div";
  return (
    <div
      data-changed={changed || undefined}
      className={cn(
        "grid gap-x-4 gap-y-2 px-5 py-3.5 sm:grid-cols-[104px_minmax(0,1fr)]",
        changed && "border-l-2 border-l-info bg-info/[0.04] pl-[18px]",
      )}
    >
      <div className="pt-1.5">
        <LabelTag
          {...(htmlFor ? { htmlFor } : {})}
          className="text-body font-medium"
        >
          {label}
          {required ? <span className="ml-0.5 text-destructive">*</span> : null}
        </LabelTag>
        {changed ? (
          <span className="mt-1 block w-fit rounded-sm bg-info/10 px-1.5 py-px text-micro font-medium text-info">
            {t(($) => $.drafts.form.changed)}
          </span>
        ) : null}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Starters as chips; a chip or "Add" opens a small editor. */
function ConversationStarterChips({
  value,
  onChange,
}: {
  value: AgentConversationStarter[];
  onChange: (value: AgentConversationStarter[]) => void;
}) {
  const { t } = useT("agents");
  const incomplete = value.some((item) => !item.label.trim() || !item.prompt.trim());
  const update = (index: number, next: AgentConversationStarter) =>
    onChange(value.map((item, i) => (i === index ? next : item)));
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        {value.map((item, index) => (
          <Popover key={index}>
            <PopoverTrigger
              className={cn(
                "inline-flex h-6 max-w-56 items-center rounded-md border bg-muted/40 px-2 text-caption hover:bg-muted",
                (!item.label.trim() || !item.prompt.trim()) && "border-destructive/50",
              )}
            >
              <span className="truncate">
                {item.label.trim() || t(($) => $.conversation_starters.label_placeholder)}
              </span>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-80 space-y-2 p-3">
              <StarterEditor
                index={index}
                item={item}
                onChange={(next) => update(index, next)}
                onRemove={() => onChange(value.filter((_, i) => i !== index))}
              />
            </PopoverContent>
          </Popover>
        ))}
        {value.length < AGENT_CONVERSATION_STARTERS_MAX ? (
          <button
            type="button"
            className={ADD_CHIP_CLASS}
            onClick={() => onChange([...value, { label: "", prompt: "" }])}
          >
            <Plus aria-hidden="true" className="size-3" />
            {t(($) => $.drafts.form.add_starter)}
          </button>
        ) : null}
        <span className="text-caption text-muted-foreground">
          {t(($) => $.drafts.form.starters_hint, { count: AGENT_CONVERSATION_STARTERS_MAX })}
        </span>
      </div>
      {incomplete ? (
        <p className="mt-1.5 text-caption text-destructive" role="alert">
          {t(($) => $.conversation_starters.incomplete)}
        </p>
      ) : null}
    </div>
  );
}

function StarterEditor({
  index,
  item,
  onChange,
  onRemove,
}: {
  index: number;
  item: AgentConversationStarter;
  onChange: (item: AgentConversationStarter) => void;
  onRemove: () => void;
}) {
  const { t } = useT("agents");
  return (
    <>
      <Input
        autoFocus
        value={item.label}
        maxLength={AGENT_CONVERSATION_STARTER_LABEL_MAX_LENGTH}
        aria-label={t(($) => $.conversation_starters.item_label, { number: index + 1 })}
        placeholder={t(($) => $.conversation_starters.label_placeholder)}
        onChange={(event) => onChange({ ...item, label: event.target.value })}
      />
      <Textarea
        value={item.prompt}
        maxLength={AGENT_CONVERSATION_STARTER_MAX_LENGTH}
        rows={3}
        className="resize-y"
        aria-label={t(($) => $.conversation_starters.prompt_label, { number: index + 1 })}
        placeholder={t(($) => $.conversation_starters.prompt_placeholder)}
        onChange={(event) => onChange({ ...item, prompt: event.target.value })}
      />
      <div className="flex justify-end">
        <Button type="button" size="sm" variant="ghost" onClick={onRemove}>
          <Trash2 aria-hidden="true" className="size-3.5" />
          {t(($) => $.conversation_starters.remove, { number: index + 1 })}
        </Button>
      </div>
    </>
  );
}

export function AgentNameField({
  name,
  error,
  onChange,
  compact = false,
}: {
  name: string;
  error: string | null;
  onChange: (name: string) => void;
  compact?: boolean;
}) {
  const { t } = useT("agents");
  const errorId = "agent-create-name-error";
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!error) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [error]);

  return (
    <DraftFieldRow
      compact={compact}
      label={t(($) => $.create_dialog.name_label)}
      htmlFor="agent-create-name"
    >
      <div className="space-y-1.5">
        <Input
          ref={inputRef}
          id="agent-create-name"
          name="agent-name"
          autoComplete="off"
          aria-label={t(($) => $.create_dialog.name_label)}
          aria-invalid={!!error}
          aria-describedby={error ? errorId : undefined}
          value={name}
          onChange={(event) => onChange(event.target.value)}
          placeholder={t(($) => $.create_dialog.name_placeholder)}
        />
        {error ? (
          <p id={errorId} className="text-caption text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </DraftFieldRow>
  );
}

/**
 * Per-model execution overrides (thinking level + Codex speed) for the create
 * flow. Capability comes from the exact selected model's live catalog on the
 * selected runtime, so nothing renders while that cannot be resolved — an
 * offline runtime, failed discovery, or an empty "use the runtime default"
 * model. That is the same fail-closed rule the settings page follows, and it is
 * why no value can be sent that the daemon would refuse to honour.
 */
export function AgentExecutionOverrides({
  draft,
  runtime,
  disabled = false,
  onChange,
}: {
  draft: AgentDraft;
  runtime: RuntimeDevice | null;
  disabled?: boolean;
  onChange: (update: AgentDraftUpdate) => void;
}) {
  const { t } = useT("agents");
  const runtimeOnline = runtime?.status === "online";
  return (
    <>
      <ThinkingSettingField
        label={t(($) => $.creation_studio.thinking_label)}
        runtimeId={runtime?.id ?? null}
        runtimeOnline={runtimeOnline}
        provider={runtime?.provider ?? ""}
        model={draft.model}
        value={draft.thinkingLevel}
        canEdit={!disabled}
        onChange={(thinkingLevel) =>
          onChange((current) => ({ ...current, thinkingLevel }))
        }
      />
      <ServiceTierSettingField
        label={t(($) => $.creation_studio.speed_label)}
        runtimeId={runtime?.id ?? null}
        runtimeOnline={runtimeOnline}
        provider={runtime?.provider ?? ""}
        model={draft.model}
        value={draft.serviceTier}
        canEdit={!disabled}
        onChange={(serviceTier) =>
          onChange((current) => ({ ...current, serviceTier }))
        }
      />
    </>
  );
}

function DraftFieldRow({
  label,
  children,
  compact = false,
  align = "center",
  htmlFor,
}: {
  label: string;
  children: ReactNode;
  compact?: boolean;
  align?: "center" | "start";
  htmlFor?: string;
}) {
  return (
    <div
      className={cn(
        "gap-3 px-4 py-4",
        compact
          ? "flex flex-col"
          : "grid sm:grid-cols-[minmax(0,1fr)_minmax(280px,1.2fr)] sm:gap-8",
        !compact && (align === "center" ? "sm:items-center" : "sm:items-start"),
      )}
    >
      {htmlFor ? (
        <label htmlFor={htmlFor} className="text-body font-medium">
          {label}
        </label>
      ) : (
        <div className="text-body font-medium">{label}</div>
      )}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

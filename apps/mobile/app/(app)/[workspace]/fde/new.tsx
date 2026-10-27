import { useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, View } from "react-native";
import { router, Stack } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChatSession } from "@multica/core/types";
import { canAssignAgentToIssue } from "@multica/core/permissions";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import { AutosizeTextArea } from "@/components/ui/autosize-textarea";
import { ActorAvatar } from "@/components/ui/actor-avatar";
import { useWorkspaceStore } from "@/data/workspace-store";
import { useAuthStore } from "@/data/auth-store";
import { agentListOptions } from "@/data/queries/agents";
import { memberListOptions } from "@/data/queries/members";
import { chatKeys } from "@/data/queries/chat";
import { useCreateChatSession } from "@/data/mutations/chat";
import { useChatDraftsStore } from "@/data/stores/chat-drafts-store";
import { useChatSessionPickerStore } from "@/data/stores/chat-session-picker-store";
import { buildFdeBrief, fdeSessionTitle, type FdeBrief } from "@/lib/fde";
import { isAgentRuntimeBound } from "@/lib/is-agent-runtime-bound";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export default function NewFdeRoute() {
  const wsId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const userId = useAuthStore((s) => s.user?.id);
  return <NewFdeForm key={`${userId}:${wsId}`} />;
}

function NewFdeForm() {
  const { t } = useT("fde");
  const wsId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const slug = useWorkspaceStore((s) => s.currentWorkspaceSlug);
  const userId = useAuthStore((s) => s.user?.id);
  const agents = useQuery(agentListOptions(wsId));
  const members = useQuery(memberListOptions(wsId));
  const role = members.data?.find((member) => member.user_id === userId)?.role ?? null;
  const availableAgents = (agents.data ?? []).filter((agent) =>
    !agent.archived_at && isAgentRuntimeBound(agent) &&
    canAssignAgentToIssue(agent, { userId: userId ?? null, role }).allowed,
  );
  const [agentId, setAgentId] = useState<string | null>(null);
  const [brief, setBrief] = useState<FdeBrief>({
    company: "", industry: t("default_industry"), footprint: "", collaboration: t("default_im"), context: "",
  });
  const selectedAgent = availableAgents.find((agent) => agent.id === agentId);
  const createSession = useCreateChatSession();
  const submitting = useRef(false);
  const qc = useQueryClient();
  const loading = agents.isLoading || members.isLoading;
  const loadError = agents.isError || members.isError;

  async function prepareConversation() {
    if (submitting.current || !selectedAgent || !brief.company.trim() || !wsId || !slug || loadError) return;
    submitting.current = true;
    try {
      const session = await createSession.mutateAsync({ agent_id: selectedAgent.id, title: fdeSessionTitle(brief.company) });
      await qc.cancelQueries({ queryKey: chatKeys.sessions(wsId) });
      if (useWorkspaceStore.getState().currentWorkspaceId !== wsId || useAuthStore.getState().user?.id !== userId) return;
      // Seed the authoritative create response before the chat screen resolves its agent.
      qc.setQueryData<ChatSession[]>(chatKeys.sessions(wsId), (previous = []) =>
        [session, ...previous.filter((item) => item.id !== session.id)],
      );
      useChatDraftsStore.getState().setDraft(session.id, buildFdeBrief(t("brief"), brief));
      useChatSessionPickerStore.getState().requestSelect(session.id);
      router.dismissTo({ pathname: "/[workspace]/chat", params: { workspace: slug } });
    } catch {
      Alert.alert(t("create_error"), t("create_retry"));
    } finally {
      submitting.current = false;
    }
  }

  return (
    <View className="flex-1 bg-background">
      <Stack.Screen options={{ gestureEnabled: !createSession.isPending }} />
      <View className="flex-row items-center justify-between px-4 pt-5 pb-3">
        <Text className="text-lg font-semibold">{t("new_title")}</Text>
        <Button variant="ghost" disabled={createSession.isPending} onPress={() => router.back()}><Text>{t("cancel")}</Text></Button>
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" automaticallyAdjustKeyboardInsets
        contentContainerStyle={{ padding: 20, gap: 20, paddingBottom: 40 }}>
        {(["company", "industry", "footprint", "collaboration"] as const).map((field) => (
          <View key={field} className="gap-2">
            <Text className="text-sm font-medium">{t(`fields.${field}`)}</Text>
            <TextField value={brief[field]} accessibilityLabel={t(`fields.${field}`)} maxLength={field === "company" ? 90 : 200}
              editable={!createSession.isPending} placeholder={t(`placeholders.${field}`)}
              onChangeText={(value) => setBrief((previous) => ({ ...previous, [field]: value }))} />
          </View>
        ))}
        <View className="gap-2">
          <Text className="text-sm font-medium">{t("fields.context")}</Text>
          <View className="rounded-md bg-secondary/50 p-3">
            <AutosizeTextArea value={brief.context} accessibilityLabel={t("fields.context")} minHeight={100} maxHeight={240}
              editable={!createSession.isPending} maxLength={6000} placeholder={t("placeholders.context")}
              onChangeText={(context) => setBrief((previous) => ({ ...previous, context }))} />
          </View>
          <Text className="text-sm text-muted-foreground">{t("materials_hint")}</Text>
        </View>
        <View className="gap-2">
          <Text className="text-sm font-medium">{t("agent")}</Text>
          {loading ? <ActivityIndicator accessibilityLabel={t("loading")} /> : null}
          {loadError ? (
            <View className="gap-2">
              <Text className="text-destructive">{t("agents_error")}</Text>
              <Button variant="outline" onPress={() => { void agents.refetch(); void members.refetch(); }}><Text>{t("retry")}</Text></Button>
            </View>
          ) : !loading && availableAgents.length === 0 ? (
            <View className="gap-2">
              <Text className="text-muted-foreground">{t("no_agents")}</Text>
              <Button variant="outline" onPress={() => { void agents.refetch(); void members.refetch(); }}><Text>{t("retry")}</Text></Button>
            </View>
          ) : null}
          {availableAgents.map((agent) => (
            <Pressable key={agent.id} accessibilityRole="radio" accessibilityState={{ checked: agent.id === agentId }}
              accessibilityLabel={agent.name} disabled={createSession.isPending}
              className={cn("flex-row items-center gap-3 rounded-lg border p-3", agent.id === agentId ? "border-primary bg-secondary" : "border-border")}
              onPress={() => setAgentId(agent.id)}>
              <ActorAvatar type="agent" id={agent.id} size={32} showPresence />
              <Text className="flex-1 font-medium">{agent.name}</Text>
              {agent.id === agentId ? <Text className="text-primary">✓</Text> : null}
            </Pressable>
          ))}
        </View>
        <Text className="text-sm text-muted-foreground">{t("prepare_hint")}</Text>
        <Button size="lg" disabled={!brief.company.trim() || !selectedAgent || loading || loadError || createSession.isPending}
          onPress={() => void prepareConversation()}>
          <Text>{createSession.isPending ? t("preparing") : t("prepare")}</Text>
        </Button>
      </ScrollView>
    </View>
  );
}

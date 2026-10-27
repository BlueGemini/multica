import { ActivityIndicator, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { router } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { Header } from "@/components/ui/header";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { ActorAvatar } from "@/components/ui/actor-avatar";
import { useWorkspaceStore } from "@/data/workspace-store";
import { chatSessionsOptions } from "@/data/queries/chat";
import { useChatSessionPickerStore } from "@/data/stores/chat-session-picker-store";
import { recentWorkspaceConversations } from "@/lib/fde";
import { useT } from "@/lib/i18n";

export default function FdeScreen() {
  const { t } = useT("fde");
  const wsId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const slug = useWorkspaceStore((s) => s.currentWorkspaceSlug);
  const query = useQuery(chatSessionsOptions(wsId));
  const sessions = recentWorkspaceConversations(query.data ?? [], wsId ?? "");
  const requestSelect = useChatSessionPickerStore((s) => s.requestSelect);

  return (
    <View className="flex-1 bg-background">
      <Header title={t("title")} subtitle="Multica" />
      <ScrollView
        contentContainerStyle={{ padding: 20, gap: 24, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={query.isRefetching} onRefresh={() => void query.refetch()} />}
      >
        <View className="gap-4 rounded-xl bg-secondary p-5">
          <Text className="text-2xl font-semibold text-foreground">{t("headline")}</Text>
          <Text className="text-base text-muted-foreground">{t("intro")}</Text>
          <Button size="lg" disabled={!slug || !wsId} onPress={() => {
            if (slug) router.push({ pathname: "/[workspace]/fde/new", params: { workspace: slug } });
          }}>
            <Text>{t("start")}</Text>
          </Button>
        </View>

        <View className="gap-3">
          <Text className="text-lg font-semibold">{t("conversations")}</Text>
          {query.isLoading ? <ActivityIndicator accessibilityLabel={t("loading")} /> : null}
          {query.isError ? (
            <View className="gap-2">
              <Text className="text-destructive">{t("load_error")}</Text>
              <Button variant="outline" onPress={() => void query.refetch()}><Text>{t("retry")}</Text></Button>
            </View>
          ) : !query.isLoading && sessions.length === 0 ? (
            <Text className="text-muted-foreground">{t("empty")}</Text>
          ) : null}
          {sessions.map((session) => (
            <Pressable key={session.id} accessibilityRole="button" accessibilityLabel={session.title}
              className="flex-row items-center gap-3 rounded-lg bg-secondary/50 p-4 active:bg-secondary"
              onPress={() => {
                if (!slug) return;
                requestSelect(session.id);
                router.navigate({ pathname: "/[workspace]/chat", params: { workspace: slug } });
              }}>
              <ActorAvatar type="agent" id={session.agent_id} size={36} showPresence />
              <View className="flex-1 gap-1">
                <Text className="font-semibold" numberOfLines={2}>{session.title}</Text>
                <Text className="text-sm text-muted-foreground">{session.has_unread ? t("new_reply") : t("continue")}</Text>
              </View>
              <Text className="text-muted-foreground">›</Text>
            </Pressable>
          ))}
          <Button variant="ghost" disabled={!slug} onPress={() => {
            if (slug) router.navigate({ pathname: "/[workspace]/chat", params: { workspace: slug } });
          }}><Text>{t("all_conversations")}</Text></Button>
        </View>

        <View className="gap-3">
          <Text className="text-lg font-semibold">{t("journey_title")}</Text>
          {(["discover", "design", "operate"] as const).map((step, index) => (
            <View key={step} className="flex-row gap-3">
              <Text className="text-primary font-semibold">0{index + 1}</Text>
              <View className="flex-1 gap-1">
                <Text className="font-medium">{t(`journey.${step}.title`)}</Text>
                <Text className="text-sm text-muted-foreground">{t(`journey.${step}.detail`)}</Text>
              </View>
            </View>
          ))}
          <Text className="text-sm text-muted-foreground">{t("scope")}</Text>
        </View>
      </ScrollView>
    </View>
  );
}

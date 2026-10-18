import type { ReactNode } from "react";
import { Download, Server } from "lucide-react";
import { useT } from "@multica/views/i18n";
import { SettingsExtraTabsProvider } from "@multica/views/settings";
import { DaemonSettingsTab } from "./daemon-settings-tab";
import { UpdatesSettingsTab } from "./updates-settings-tab";

/**
 * The desktop-only device settings. Mounted around the whole shell because
 * both the settings page and the Settings panel beside it list them.
 */
export function DesktopSettingsTabsProvider({ children }: { children: ReactNode }) {
  const { t } = useT("settings");
  return (
    <SettingsExtraTabsProvider
      tabs={[
        {
          value: "daemon",
          label: t(($) => $.desktop.daemon.title),
          icon: Server,
          content: <DaemonSettingsTab />,
        },
        {
          value: "updates",
          label: t(($) => $.desktop.tabs.updates),
          icon: Download,
          content: <UpdatesSettingsTab />,
        },
      ]}
    >
      {children}
    </SettingsExtraTabsProvider>
  );
}

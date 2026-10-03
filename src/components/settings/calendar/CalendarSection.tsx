import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { commands, type CalendarAuthStatus } from "@/bindings";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { ToggleSwitch } from "../../ui/ToggleSwitch";
import { Alert } from "../../ui/Alert";
import { Button } from "../../ui/Button";
import { useSettings } from "@/hooks/useSettings";
import { usePlatformCapabilities } from "@/hooks/usePlatformCapabilities";

/** Deep link to Privacy & Security → Calendars. */
const CALENDAR_PRIVACY_PANE =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars";

export const CalendarSection: React.FC = () => {
  const { t } = useTranslation();
  const { getSetting, refreshSettings } = useSettings();
  const capabilities = usePlatformCapabilities();

  const [status, setStatus] = useState<CalendarAuthStatus | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const enabled = getSetting("calendar_enabled") ?? false;

  const refreshStatus = useCallback(() => {
    commands.getCalendarAuthStatus().then(setStatus).catch(console.error);
  }, []);

  useEffect(() => {
    if (capabilities.calendar) refreshStatus();
  }, [capabilities.calendar, refreshStatus]);

  // Permission is granted in System Settings, outside the app, so re-check on
  // focus rather than making the user find a refresh button.
  useEffect(() => {
    if (!capabilities.calendar) return;
    window.addEventListener("focus", refreshStatus);
    return () => window.removeEventListener("focus", refreshStatus);
  }, [capabilities.calendar, refreshStatus]);

  const handleToggle = async (next: boolean) => {
    setIsBusy(true);
    try {
      // One action: this both records the preference and, when turning on for
      // the first time, shows the system prompt.
      const result = await commands.setCalendarEnabled(next);
      if (result.status === "ok") {
        setStatus(result.data);
      } else {
        console.error("Failed to set calendar access:", result.error);
      }
      await refreshSettings();
    } finally {
      setIsBusy(false);
    }
  };

  if (!capabilities.calendar) return null;

  // Only warn about a permission problem when the user has asked for the
  // feature. Before that, "not determined" is just the normal starting state.
  const problem =
    status && status !== "authorized" && status !== "not_determined"
      ? status
      : null;

  return (
    <SettingsGroup title={t("settings.calendar.title")}>
      <ToggleSwitch
        checked={enabled}
        onChange={handleToggle}
        isUpdating={isBusy}
        label={t("settings.calendar.toggleTitle")}
        description={t("settings.calendar.toggleDescription")}
        descriptionMode="inline"
        grouped
      />
      {problem && (
        <div className="p-4 space-y-2">
          <Alert variant="warning" contained>
            {problem === "restricted"
              ? t("settings.calendar.restricted")
              : problem === "write_only"
                ? t("settings.calendar.writeOnly")
                : t("settings.calendar.denied")}
          </Alert>
          {problem !== "restricted" && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => openUrl(CALENDAR_PRIVACY_PANE)}
            >
              {t("settings.calendar.openSettings")}
            </Button>
          )}
        </div>
      )}
    </SettingsGroup>
  );
};

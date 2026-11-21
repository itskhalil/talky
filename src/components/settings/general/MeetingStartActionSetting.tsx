import React from "react";
import { useTranslation } from "react-i18next";
import { Dropdown } from "../../ui/Dropdown";
import { SettingContainer } from "../../ui/SettingContainer";
import { useSettings } from "@/hooks/useSettings";
import { usePlatformCapabilities } from "@/hooks/usePlatformCapabilities";

const MEETING_START_OPTIONS = [
  {
    value: "disabled",
    labelKey: "settings.recording.meetingStartAction.disabled",
  },
  {
    value: "notify",
    labelKey: "settings.recording.meetingStartAction.notify",
  },
];

const MEETING_START_ALERT_OPTIONS = [
  {
    value: "os_notification",
    labelKey: "settings.recording.meetingStartAction.alert.osNotification",
  },
  {
    value: "focus_window",
    labelKey: "settings.recording.meetingStartAction.alert.focusWindow",
  },
];

export const MeetingStartActionSetting: React.FC = React.memo(() => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating } = useSettings();
  const capabilities = usePlatformCapabilities();

  if (!capabilities.meetingDetection) return null;

  const action = getSetting("meeting_start_action") ?? "disabled";
  const alert = getSetting("meeting_start_alert") ?? "os_notification";

  const toOptions = (opts: { value: string; labelKey: string }[]) =>
    opts.map((option) => ({ value: option.value, label: t(option.labelKey) }));

  return (
    <SettingContainer
      title={t("settings.recording.meetingStartAction.title")}
      description={t("settings.recording.meetingStartAction.description")}
      descriptionMode="tooltip"
      grouped
    >
      <div className="flex items-center gap-2">
        <Dropdown
          options={toOptions(MEETING_START_OPTIONS)}
          selectedValue={action}
          onSelect={(value) => updateSetting("meeting_start_action", value)}
          disabled={isUpdating("meeting_start_action")}
        />
        {/* The alert only matters when we actually prompt. */}
        {action !== "disabled" && (
          <>
            <span className="text-sm text-text-secondary">
              {t("settings.recording.meetingStartAction.and")}
            </span>
            <Dropdown
              options={toOptions(MEETING_START_ALERT_OPTIONS)}
              selectedValue={alert}
              onSelect={(value) => updateSetting("meeting_start_alert", value)}
              disabled={isUpdating("meeting_start_alert")}
            />
          </>
        )}
      </div>
    </SettingContainer>
  );
});

MeetingStartActionSetting.displayName = "MeetingStartActionSetting";

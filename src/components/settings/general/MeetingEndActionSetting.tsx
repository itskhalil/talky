import React from "react";
import { useTranslation } from "react-i18next";
import { Dropdown } from "../../ui/Dropdown";
import { SettingContainer } from "../../ui/SettingContainer";
import { useSettings } from "@/hooks/useSettings";
import { usePlatformCapabilities } from "@/hooks/usePlatformCapabilities";
import { effectiveMeetingEndAlert } from "@/utils/meetingAlert";

const MEETING_END_OPTIONS = [
  {
    value: "stop_recording",
    labelKey: "settings.recording.meetingEndAction.stopRecording",
  },
  {
    value: "notify",
    labelKey: "settings.recording.meetingEndAction.notify",
  },
];

const MEETING_END_ALERT_OPTIONS = [
  {
    value: "os_notification",
    labelKey: "settings.recording.meetingEndAction.alert.osNotification",
  },
  {
    value: "focus_window",
    labelKey: "settings.recording.meetingEndAction.alert.focusWindow",
  },
  {
    value: "none",
    labelKey: "settings.recording.meetingEndAction.alert.none",
  },
];

export const MeetingEndActionSetting: React.FC = React.memo(() => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating } = useSettings();
  const capabilities = usePlatformCapabilities();

  if (!capabilities.meetingDetection) return null;

  const action = getSetting("meeting_end_action") ?? "stop_recording";
  const alert = effectiveMeetingEndAlert(
    action,
    getSetting("meeting_end_alert") ?? "os_notification",
  );

  const actionOptions = MEETING_END_OPTIONS.map((option) => ({
    value: option.value,
    label: t(option.labelKey),
  }));

  const alertOptions = MEETING_END_ALERT_OPTIONS.filter(
    (option) => !(action === "notify" && option.value === "none"),
  ).map((option) => ({
    value: option.value,
    label: t(option.labelKey),
  }));

  return (
    <SettingContainer
      title={t("settings.recording.meetingEndAction.title")}
      description={t("settings.recording.meetingEndAction.description")}
      descriptionMode="tooltip"
      grouped
    >
      <div className="flex items-center gap-2">
        <Dropdown
          options={actionOptions}
          selectedValue={action}
          onSelect={(value) => updateSetting("meeting_end_action", value)}
          disabled={isUpdating("meeting_end_action")}
        />
        <Dropdown
          options={alertOptions}
          selectedValue={alert}
          onSelect={(value) => updateSetting("meeting_end_alert", value)}
          disabled={isUpdating("meeting_end_alert")}
        />
      </div>
    </SettingContainer>
  );
});

MeetingEndActionSetting.displayName = "MeetingEndActionSetting";

import React from "react";
import { useTranslation } from "react-i18next";
import { Dropdown } from "../../ui/Dropdown";
import { SettingContainer } from "../../ui/SettingContainer";
import { useSettings } from "@/hooks/useSettings";
import { usePlatformCapabilities } from "@/hooks/usePlatformCapabilities";

const MEETING_END_ALERT_OPTIONS = [
  {
    value: "os_notification",
    labelKey: "settings.recording.meetingEndAlert.osNotification",
  },
  {
    value: "focus_window",
    labelKey: "settings.recording.meetingEndAlert.focusWindow",
  },
];

export const MeetingEndAlertSetting: React.FC = React.memo(() => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating } = useSettings();
  const capabilities = usePlatformCapabilities();

  if (!capabilities.meetingDetection) return null;

  const currentValue = getSetting("meeting_end_alert") ?? "os_notification";

  const options = MEETING_END_ALERT_OPTIONS.map((option) => ({
    value: option.value,
    label: t(option.labelKey),
  }));

  const handleChange = (value: string) => {
    updateSetting("meeting_end_alert", value);
  };

  return (
    <SettingContainer
      title={t("settings.recording.meetingEndAlert.title")}
      description={t("settings.recording.meetingEndAlert.description")}
      descriptionMode="tooltip"
      grouped
    >
      <Dropdown
        options={options}
        selectedValue={currentValue}
        onSelect={handleChange}
        disabled={isUpdating("meeting_end_alert")}
      />
    </SettingContainer>
  );
});

MeetingEndAlertSetting.displayName = "MeetingEndAlertSetting";

import React from "react";
import { useTranslation } from "react-i18next";
import { Dropdown } from "../../ui/Dropdown";
import { SettingContainer } from "../../ui/SettingContainer";
import { useSettings } from "@/hooks/useSettings";
import { usePlatformCapabilities } from "@/hooks/usePlatformCapabilities";

const MEETING_ALERT_OPTIONS = [
  {
    value: "os_notification",
    labelKey: "settings.recording.meetingAlert.osNotification",
  },
  {
    value: "focus_window",
    labelKey: "settings.recording.meetingAlert.focusWindow",
  },
];

export const MeetingAlertSetting: React.FC = React.memo(() => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating } = useSettings();
  const capabilities = usePlatformCapabilities();

  if (!capabilities.meetingDetection) return null;

  const currentValue = getSetting("meeting_alert") ?? "os_notification";

  const options = MEETING_ALERT_OPTIONS.map((option) => ({
    value: option.value,
    label: t(option.labelKey),
  }));

  const handleChange = (value: string) => {
    updateSetting("meeting_alert", value);
  };

  return (
    <SettingContainer
      title={t("settings.recording.meetingAlert.title")}
      description={t("settings.recording.meetingAlert.description")}
      descriptionMode="tooltip"
      grouped
    >
      <Dropdown
        options={options}
        selectedValue={currentValue}
        onSelect={handleChange}
        disabled={isUpdating("meeting_alert")}
      />
    </SettingContainer>
  );
});

MeetingAlertSetting.displayName = "MeetingAlertSetting";

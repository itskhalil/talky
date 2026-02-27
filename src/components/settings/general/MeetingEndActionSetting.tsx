import React from "react";
import { useTranslation } from "react-i18next";
import { Dropdown } from "../../ui/Dropdown";
import { SettingContainer } from "../../ui/SettingContainer";
import { useSettings } from "@/hooks/useSettings";
import { usePlatformCapabilities } from "@/hooks/usePlatformCapabilities";

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

export const MeetingEndActionSetting: React.FC = React.memo(() => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating } = useSettings();
  const capabilities = usePlatformCapabilities();

  if (!capabilities.meetingDetection) return null;

  const currentValue = getSetting("meeting_end_action") ?? "stop_recording";

  const options = MEETING_END_OPTIONS.map((option) => ({
    value: option.value,
    label: t(option.labelKey),
  }));

  const handleChange = (value: string) => {
    updateSetting("meeting_end_action", value);
  };

  return (
    <SettingContainer
      title={t("settings.recording.meetingEndAction.title")}
      description={t("settings.recording.meetingEndAction.description")}
      descriptionMode="tooltip"
      grouped
    >
      <Dropdown
        options={options}
        selectedValue={currentValue}
        onSelect={handleChange}
        disabled={isUpdating("meeting_end_action")}
      />
    </SettingContainer>
  );
});

MeetingEndActionSetting.displayName = "MeetingEndActionSetting";

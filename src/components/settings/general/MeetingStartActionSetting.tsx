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

export const MeetingStartActionSetting: React.FC = React.memo(() => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating } = useSettings();
  const capabilities = usePlatformCapabilities();

  if (!capabilities.meetingDetection) return null;

  const currentValue = getSetting("meeting_start_action") ?? "disabled";

  const options = MEETING_START_OPTIONS.map((option) => ({
    value: option.value,
    label: t(option.labelKey),
  }));

  const handleChange = (value: string) => {
    updateSetting("meeting_start_action", value);
  };

  return (
    <SettingContainer
      title={t("settings.recording.meetingStartAction.title")}
      description={t("settings.recording.meetingStartAction.description")}
      descriptionMode="tooltip"
      grouped
    >
      <Dropdown
        options={options}
        selectedValue={currentValue}
        onSelect={handleChange}
        disabled={isUpdating("meeting_start_action")}
      />
    </SettingContainer>
  );
});

MeetingStartActionSetting.displayName = "MeetingStartActionSetting";

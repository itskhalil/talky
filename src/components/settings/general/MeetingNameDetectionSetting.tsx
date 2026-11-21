import React from "react";
import { useTranslation } from "react-i18next";
import { ToggleSwitch } from "../../ui/ToggleSwitch";
import { useSettings } from "@/hooks/useSettings";
import { usePlatformCapabilities } from "@/hooks/usePlatformCapabilities";

export const MeetingNameDetectionSetting: React.FC = React.memo(() => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating } = useSettings();
  const capabilities = usePlatformCapabilities();

  if (!capabilities.meetingDetection) return null;

  const enabled = getSetting("meeting_name_detection") ?? false;

  const handleChange = async (value: boolean) => {
    if (value) {
      // Reading other apps' window titles needs the Accessibility permission.
      try {
        const { checkAccessibilityPermission, requestAccessibilityPermission } =
          await import("tauri-plugin-macos-permissions-api");
        if (!(await checkAccessibilityPermission())) {
          await requestAccessibilityPermission();
        }
      } catch (e) {
        console.warn("Failed to request Accessibility permission", e);
      }
    }
    updateSetting("meeting_name_detection", value);
  };

  return (
    <ToggleSwitch
      checked={enabled}
      onChange={(value) => void handleChange(value)}
      isUpdating={isUpdating("meeting_name_detection")}
      label={t("settings.recording.meetingNameDetection.label")}
      description={t("settings.recording.meetingNameDetection.description")}
      descriptionMode="tooltip"
      grouped
    />
  );
});

MeetingNameDetectionSetting.displayName = "MeetingNameDetectionSetting";

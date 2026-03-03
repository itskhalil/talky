import React from "react";
import { useTranslation } from "react-i18next";
import { ToggleSwitch } from "../../ui/ToggleSwitch";
import { useSettings } from "../../../hooks/useSettings";

interface SaveDebugRecordingsToggleProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

export const SaveDebugRecordingsToggle: React.FC<
  SaveDebugRecordingsToggleProps
> = ({ descriptionMode = "tooltip", grouped = false }) => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating } = useSettings();
  const saveDebugRecordings = getSetting("save_debug_recordings") ?? false;

  return (
    <ToggleSwitch
      checked={saveDebugRecordings}
      onChange={(enabled) => updateSetting("save_debug_recordings", enabled)}
      isUpdating={isUpdating("save_debug_recordings")}
      label={t("settings.debug.saveDebugRecordings.label")}
      description={t("settings.debug.saveDebugRecordings.description")}
      descriptionMode={descriptionMode}
      grouped={grouped}
    />
  );
};

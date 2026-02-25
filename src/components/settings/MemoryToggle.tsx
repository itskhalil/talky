import React from "react";
import { useTranslation } from "react-i18next";
import { ToggleSwitch } from "../ui/ToggleSwitch";
import { useSettings } from "../../hooks/useSettings";

interface MemoryToggleProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

export const MemoryToggle: React.FC<MemoryToggleProps> = React.memo(
  ({ descriptionMode = "tooltip", grouped = false }) => {
    const { t } = useTranslation();
    const { getSetting, updateSetting, isUpdating } = useSettings();

    const memoryEnabled = getSetting("memory_enabled") ?? true;

    return (
      <ToggleSwitch
        checked={memoryEnabled}
        onChange={(enabled) => updateSetting("memory_enabled", enabled)}
        isUpdating={isUpdating("memory_enabled")}
        label={t("settings.memory.toggle.label")}
        description={t("settings.memory.toggle.description")}
        descriptionMode={descriptionMode}
        grouped={grouped}
      />
    );
  },
);

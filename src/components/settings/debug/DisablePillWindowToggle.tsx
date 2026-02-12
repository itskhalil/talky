import React from "react";
import { useTranslation } from "react-i18next";
import { ToggleSwitch } from "../../ui/ToggleSwitch";
import { useSettings } from "../../../hooks/useSettings";

interface DisablePillWindowToggleProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

export const DisablePillWindowToggle: React.FC<
  DisablePillWindowToggleProps
> = ({ descriptionMode = "tooltip", grouped = false }) => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating } = useSettings();
  const disabled = getSetting("debug_disable_pill_window") ?? false;

  return (
    <ToggleSwitch
      checked={disabled}
      onChange={(enabled) =>
        updateSetting("debug_disable_pill_window", enabled)
      }
      isUpdating={isUpdating("debug_disable_pill_window")}
      label={t("settings.debug.disablePillWindow.label")}
      description={t("settings.debug.disablePillWindow.description")}
      descriptionMode={descriptionMode}
      grouped={grouped}
    />
  );
};

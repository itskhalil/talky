import React from "react";
import { useTranslation } from "react-i18next";
import { ToggleSwitch } from "../../ui/ToggleSwitch";
import { useSettings } from "../../../hooks/useSettings";

interface CopyAsBulletsToggleProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

export const CopyAsBulletsToggle: React.FC<CopyAsBulletsToggleProps> = ({
  descriptionMode = "tooltip",
  grouped = false,
}) => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating } = useSettings();
  const copyAsBulletsEnabled = getSetting("copy_as_bullets_enabled") ?? false;

  return (
    <ToggleSwitch
      checked={copyAsBulletsEnabled}
      onChange={(enabled) => updateSetting("copy_as_bullets_enabled", enabled)}
      isUpdating={isUpdating("copy_as_bullets_enabled")}
      label={t("settings.debug.copyAsBullets.label")}
      description={t("settings.debug.copyAsBullets.description")}
      descriptionMode={descriptionMode}
      grouped={grouped}
    />
  );
};
